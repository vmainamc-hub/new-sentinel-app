// EDGE GATES for the Sixfold runner: the three gates built for Sentinel AI (Kalman health, cross-market danger + frequency, arbiter)
// as an overlay for runners that have no Pulse of their own (Sixfold, Vanguard).
//
// It is the same machinery Sentinel AI uses (../sentinel/edge) behind the same runner hooks:
//   refresh     once per scan: the whole-book danger read and a fresh Kalman cache
//   arbitrate   the cells the runner itself would trade (its own bars, Meter and guards applied) go to the arbiter, one pick per market
//   call        per cell: veto, a move of the score bar and a ranking bonus, shown in the runner's own "Engines:" reason
//   guard       the last look on the buy tick, from fresh ticks, before real money
//   onBought / onSettled   cooldown and hourly budget, and the evidence ledger
// The gates only veto, ease or rank. They never create a signal, change an entry plan, a contract, a stake or a recovery step.
// Defaults match Sentinel AI. There is no Hunter here, so the Kalman level rule and the hourly budget apply the way they do in
// Sentinel's Careful / Balanced / Active modes. Everything is switchable from the console (see `createEngineGates`).
import type { Contract } from '../sixfold/bot';
import type { SixfoldSettings } from '../sixfold/money';
import type { RunnerOverlay } from '../sixfold/overlay';
import { type EdgeInfluence, browserLedger, createEdgeInfluence, describeReport } from '../sentinel/edge/influence';
import { type EdgeSettings, loadEdge, normalizeEdge, saveEdge } from '../sentinel/edge/settings';
import { keyOf } from '../sentinel/overlay';
import type { BoardRow } from '../sentinel/overlay';
import { readSpecialDigits } from '../sentinel/special-digits';
import { cellToRow } from './cell-row';

export const createGateOverlay = (opts: {
    moduleId: string;
    name: string;
    /** The contracts the runner scans: the same list the runner would use without an overlay. */
    contracts: (settings: SixfoldSettings) => Contract[];
    edge: EdgeInfluence;
    /**
     * The live ticks per market. With it, Sentinel AI's MANDATORY special-digit rule (digit 1 and digit 8, see
     * ../sentinel/special-digits.ts) applies to every contract at scan time and again on the buy tick, ahead of the gates. It has no
     * switch. Without it the overlay behaves as before (tests only; production always passes it through `createEngineGates`).
     */
    series?: () => Readonly<Record<string, readonly number[]>>;
}): RunnerOverlay => {
    let contracts: Contract[] = [];
    const rows = new Map<string, BoardRow>();

    return {
        moduleId: opts.moduleId,
        name: opts.name,
        guardLabel: 'Gate check',
        contracts: settings => {
            contracts = opts.contracts(settings);
            return contracts;
        },
        refresh: (now, symbols) => {
            try {
                opts.edge.refresh({ now, symbols, contracts, board: null, other: null, hunter: false });
            } catch {
                /* the gates stay on their last read; the runner's own checks are unaffected */
            }
        },
        arbitrate: eligible => {
            try {
                const list = eligible.map(cellToRow);
                rows.clear();
                for (const r of list) rows.set(r.key, r);
                opts.edge.arbitrate(list, null);
            } catch {
                rows.clear();
            }
        },
        call: (cell, ctx) => {
            // MANDATORY special-digit rule (digit 1 for Over, digit 8 for Under): a veto here is final, whatever the gates say.
            let special: ReturnType<typeof readSpecialDigits> | null = null;
            if (opts.series) {
                special = readSpecialDigits(opts.series()[cell.symbol], cell.contract.side);
                if (!special.ok) return { allow: false, bump: 0, rank: 0, note: special.note };
            }
            try {
                const row = rows.get(keyOf(cell.symbol, cell.contract.side, cell.contract.param));
                const extra = opts.edge.call(cell, row, ctx);
                return special ? { ...extra, note: [special.note, extra.note].filter(Boolean).join('; ') } : extra;
            } catch {
                return { allow: true, bump: 0, rank: 0, note: special?.note ?? '' }; // an extra look: a failure never stops the runner
            }
        },
        guard: (symbol, traded, series) => {
            // The same rule on the tick a trade would be bought, from the fresh ticks and for the contract that WOULD be bought.
            const read = opts.series ? readSpecialDigits(series, traded.side) : null;
            if (read && !read.ok) return { ok: false, note: read.note };
            try {
                const edge = opts.edge.guard(symbol, traded, series);
                return { ok: edge.ok, note: [read?.note, edge.note].filter(Boolean).join('; ') };
            } catch {
                return { ok: true, note: read?.note ?? '' }; // the gates are an extra look; the mandatory rule has already passed
            }
        },
        onBought: notice => {
            try {
                opts.edge.onBought(notice);
            } catch {
                /* never disturbs a live trade */
            }
        },
        onSettled: notice => {
            try {
                opts.edge.onSettled(notice);
            } catch {
                /* never disturbs a live session */
            }
        },
    };
};

export type EngineGatesOptions = {
    moduleId: string;
    name: string;
    contracts: (settings: SixfoldSettings) => Contract[];
    /** The live ticks per market the gates read. */
    series: () => Readonly<Record<string, readonly number[]>>;
    /** Storage keys, one pair per engine so their settings and evidence never mix. */
    settingsKey: string;
    ledgerKey: string;
    /** Console name, e.g. `window.sixfoldEdge`. */
    handle: string;
    /** The clock for trade times and the evidence ledger. Default: Date.now. */
    now?: () => number;
    /**
     * Apply Sentinel AI's mandatory digit 1 / digit 8 rule (default: true). It is not a user setting and is not on the console
     * handle; this only lets a test exercise the gates on their own.
     */
    specialDigits?: boolean;
};

/**
 * Everything an engine needs to run the gates: the overlay for its runner, the influence (feed it ticks with `onTick`), and a console
 * handle with the same shape as Sentinel AI's `sentinelEdge`: `set({ shadow: true })` measures without acting,
 * `set({ kalman: false })` switches one gate off, `report()` / `print()` show the evidence, `reset()` clears it.
 */
export const createEngineGates = (o: EngineGatesOptions) => {
    let settings: EdgeSettings = loadEdge(o.settingsKey);
    const influence = createEdgeInfluence({
        getSettings: () => settings,
        series: o.series,
        storage: browserLedger(o.ledgerKey),
        now: o.now,
    });
    const overlay = createGateOverlay({
        moduleId: o.moduleId,
        name: o.name,
        contracts: o.contracts,
        edge: influence,
        series: o.specialDigits === false ? undefined : o.series,
    });
    const controls = {
        get: (): EdgeSettings => ({ ...settings }),
        set: (patch: Partial<EdgeSettings>): EdgeSettings => {
            settings = normalizeEdge({ ...settings, ...patch });
            saveEdge(settings, o.settingsKey);
            return { ...settings };
        },
        report: () => influence.report(),
        print: (): string => describeReport(influence.report()).replace('Sentinel edge gates', `${o.name} edge gates`),
        reset: () => influence.reset(),
    };
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>)[o.handle] = controls;
    /** Feed every live tick of the engine's feed here: it settles what a stood-down signal would have done. */
    const onTick = (symbol: string, digit: number) => {
        try {
            influence.onTick(symbol, digit);
        } catch {
            /* the gates' record never gets in the way of a tick */
        }
    };
    return { overlay, influence, controls, onTick };
};
