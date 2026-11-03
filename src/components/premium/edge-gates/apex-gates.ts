// EDGE GATES for Apex Intel: the three gates built for Sentinel AI (Kalman health, cross-market danger + frequency, arbiter), added
// on top of Apex Intel's own AI guard (`ai-intel/guard.ts`). The guard runs first and keeps every rule it has; a signal it lets
// through then meets the gates. Like the guard, the gates can only BLOCK: they never create a signal, change a contract, a stake or
// a recovery step.
//
// Where each gate reads:
//   board refresh  `onBoard`: the whole ranked book (every market x direction, before the one-per-market cut) goes to the arbiter,
//                  so it can stand down a weaker direction and abstain where Over and Under are about equal; danger is read from
//                  all markets; the hold-through-scans count sees which signals are on the board
//   signal         `review`: danger, Kalman health, frequency (cooldown, hold, hourly budget) and the arbiter verdict
//   buy tick       `review` also takes the last look from the live ticks (`guard`), the same tick the entry fires on
//   trades         `onBought` / `onSettled`: cooldown and budget, and the evidence ledger (live vs shadow)
// Recovery signals (Over 3 / Under 6 after a loss) are never delayed by cooldown, hold or budget, and have no arbiter row: only the
// danger read and Kalman's decay veto apply to them, as in the other engines.
// Apex Intel has no score bar to ease or ranking to nudge at this point, so the gates are veto-only here.
// If the AI guard is OFF, Apex Intel runs no checks at all, and that includes these.
import type { Contract } from '../sixfold/bot';
import { type EdgeInfluence, browserLedger, createEdgeInfluence, describeReport } from '../sentinel/edge/influence';
import { type EdgeSettings, loadEdge, normalizeEdge, saveEdge } from '../sentinel/edge/settings';
import { keyOf } from '../sentinel/overlay';
import type { BoardRow } from '../sentinel/overlay';
import type { PulseTier } from '../sentinel/pulse';
import type { GuardRequest, GuardVerdict } from '../ai-intel/guard';
import { contractOf, OVER_3, type Pick as RankedPick, type RecoveryPick, UNDER_6 } from '../ai-intel/picker';
import { OVER_2, UNDER_7 } from '../ai-intel/sim';

/** The picker's score (lower win-rate bound minus chance, a fraction) on the 0-100 scale the arbiter reads. 0 = at chance = 50. */
export const scoreOfPick = (score: number): number => Math.min(100, Math.max(0, Math.round(50 + score * 400)));
/** Proven after false-discovery control = strong; a lower bound above chance = steady; anything else = watch. */
export const tierOfPick = (p: RankedPick): PulseTier => (p.significant ? 'strong' : p.score > 0 ? 'steady' : 'watch');

export const pickToRow = (p: RankedPick): BoardRow => {
    const c = contractOf(p.direction);
    return {
        key: keyOf(p.market, c.side, c.param),
        symbol: p.market,
        contract: c.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
        barrier: c.param,
        label: p.label,
        tier: tierOfPick(p),
        score: scoreOfPick(p.score),
        agree: 0,
    };
};

/** One row per market x contract: the picker lists the same direction once per entry kind, and the best (listed first) stands for it. */
export const rowsOf = (ranked: readonly RankedPick[]): BoardRow[] => {
    const seen = new Map<string, BoardRow>();
    for (const p of ranked) {
        const row = pickToRow(p);
        if (!seen.has(row.key)) seen.set(row.key, row);
    }
    return [...seen.values()];
};

export type ApexGatesOptions = {
    series: () => Readonly<Record<string, readonly number[]>>;
    settingsKey?: string;
    ledgerKey?: string;
    handle?: string;
    now?: () => number;
};

export const createApexGates = (o: ApexGatesOptions) => {
    const settingsKey = o.settingsKey ?? 'apexintel.edge.settings.v1';
    let settings: EdgeSettings = loadEdge(settingsKey);
    const clock = o.now ?? Date.now;
    const influence: EdgeInfluence = createEdgeInfluence({
        getSettings: () => settings,
        series: o.series,
        storage: browserLedger(o.ledgerKey ?? 'apexintel.edge.ledger.v1'),
        now: o.now,
    });
    const rows = new Map<string, BoardRow>();
    const contracts: Contract[] = [OVER_2, UNDER_7, OVER_3, UNDER_6];

    const onBoard = (ranked: readonly RankedPick[], _recovery: readonly RecoveryPick[], now: number) => {
        try {
            influence.refresh({
                now,
                symbols: Object.keys(o.series()),
                contracts,
                board: null,
                other: null,
                hunter: false,
            });
            const list = rowsOf(ranked);
            rows.clear();
            for (const r of list) rows.set(r.key, r);
            influence.arbitrate(list, null);
        } catch {
            rows.clear(); // the gates stay on their last read; the AI guard is unaffected
        }
    };

    /** Add-on to the AI guard: call it only for a signal the guard already allowed. */
    const review = (
        req: Pick<GuardRequest, 'market' | 'contract' | 'recovery'> & { series?: readonly number[] }
    ): GuardVerdict => {
        try {
            const row = req.recovery ? undefined : rows.get(keyOf(req.market, req.contract.side, req.contract.param));
            const call = influence.call({ symbol: req.market, contract: req.contract }, row, {
                recovering: req.recovery,
                now: clock(),
            });
            if (!call.allow) return { allow: false, reason: `edge gates: ${call.note}` };
            const last = influence.guard(req.market, req.contract, req.series ?? o.series()[req.market] ?? []);
            if (!last.ok) return { allow: false, reason: `edge gates: ${last.note}` };
            return { allow: true, reason: '' };
        } catch {
            return { allow: true, reason: '' }; // an extra look: a failure never stops the engine, the guard has already passed it
        }
    };

    const controls = {
        get: (): EdgeSettings => ({ ...settings }),
        set: (patch: Partial<EdgeSettings>): EdgeSettings => {
            settings = normalizeEdge({ ...settings, ...patch });
            saveEdge(settings, settingsKey);
            return { ...settings };
        },
        report: () => influence.report(),
        print: (): string => describeReport(influence.report()).replace('Sentinel edge gates', 'Apex Intel edge gates'),
        reset: () => influence.reset(),
    };
    if (typeof window !== 'undefined')
        (window as unknown as Record<string, unknown>)[o.handle ?? 'apexIntelEdge'] = controls;

    const onTick = (symbol: string, digit: number) => {
        try {
            influence.onTick(symbol, digit);
        } catch {
            /* the gates' record never gets in the way of a tick */
        }
    };
    const onBought = (n: {
        contractId: number;
        market: string;
        contract: Contract;
        recovery: boolean;
        stake: number;
    }) => {
        try {
            influence.onBought({
                contractId: n.contractId,
                symbol: n.market,
                armed: n.contract,
                bought: n.contract,
                recovery: n.recovery,
                stake: n.stake,
                entryDigit: null,
            });
        } catch {
            /* never disturbs a live trade */
        }
    };
    const onSettled = (n: {
        contractId: number;
        market: string;
        contract: Contract;
        recovery: boolean;
        stake: number;
        profit: number | null;
    }) => {
        try {
            influence.onSettled({
                contractId: n.contractId,
                symbol: n.market,
                armed: n.contract,
                bought: n.contract,
                recovery: n.recovery,
                stake: n.stake,
                entryDigit: null,
                profit: n.profit,
            });
        } catch {
            /* never disturbs a live session */
        }
    };
    return { influence, controls, onBoard, review, onTick, onBought, onSettled };
};
