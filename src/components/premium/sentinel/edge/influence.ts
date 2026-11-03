// SENTINEL AI EDGE: the three gates joined into one influence on the signals that come up for execution. Pure apart from the injected
// clocks and storage.
//
// It plugs into the existing Sentinel overlay at the three places the Sixfold runner already asks:
//   refresh  once per scan: reads the whole book (danger), the filtered health of every signal (Kalman), and settles the arbiter
//   call     per cell: veto, a move of the score bar, and a ranking bonus. Anything the gates stop shows in the runner's own
//            "where is the signal blocked" panel as `Engines: <reason>`, so no screen changes
//   guard    on the buy tick: the last look, from fresh ticks, before real money
// A signal the gates stand down is never armed or bought; a signal they like is eased and ranked up. That is the whole influence.
//
// It also keeps the evidence needed to judge them. Every time a gate stands a signal down, the next tick on that market is recorded as
// if the signal had been traded on it, so `report()` can set the vetoed signals' win rate against the fair rate and against the
// trades actually taken. The next tick is a proxy for the contract's own duration; read it as a sanity check, not a backtest.
import { type Contract, winningDigits, winProbability } from '../../sixfold/bot';
import type { OverlayCall, TradeNotice } from '../../sixfold/overlay';
import type { BoardRow } from '../overlay';
import { Arbiter, type ArbiterVerdict, type Candidate, secondOpinion } from './arbiter';
import { assessCrossMarketDanger, type CrossMarketDanger, FrequencyGate } from './danger';
import { type Health, judgeHealth, readHealth } from './kalman';
import type { EdgeSettings } from './settings';

export type Gate = 'kalman' | 'danger' | 'frequency' | 'arbiter';
export const GATES: readonly Gate[] = ['kalman', 'danger', 'frequency', 'arbiter'];

type Part = { gate: Gate; allow: boolean; bump: number; rank: number; note: string };

export type GateStat = { vetoed: number; resolved: number; wouldWin: number; fairSum: number };
export type RealStat = { settled: number; wins: number; fairSum: number };
export type EdgeReport = {
    since: number;
    gates: Record<Gate, GateStat>;
    /** Trades actually settled, split by whether the gates were live or in shadow mode when the trade settled. */
    real: { live: RealStat; shadow: RealStat };
};

const emptyGate = (): GateStat => ({ vetoed: 0, resolved: 0, wouldWin: 0, fairSum: 0 });
const emptyReal = (): RealStat => ({ settled: 0, wins: 0, fairSum: 0 });
const freshReport = (now: number): EdgeReport => ({
    since: now,
    gates: { kalman: emptyGate(), danger: emptyGate(), frequency: emptyGate(), arbiter: emptyGate() },
    real: { live: emptyReal(), shadow: emptyReal() },
});

/** Largest move of the score bar the gates may make together. */
export const MAX_EASE = 8;
export const MAX_RAISE = 10;
/** Raise of the bar while the book is merely elevated. */
export const ELEVATED_BUMP = 3;
/** The same signal on the same gate is only counted this often, ms. */
const COUNT_EVERY_MS = 20_000;
export const SENTINEL_LEDGER_KEY = 'sentinelai.edge.ledger.v1';

const NEUTRAL: OverlayCall = { allow: true, bump: 0, rank: 0, note: '' };
const rowKey = (symbol: string, c: Contract) =>
    `${symbol}|${c.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER'}|${c.param}`;
const contractKeyOf = (c: Contract) => `${c.side}:${c.param}`;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export type EdgeStorage = { load: () => EdgeReport | null; save: (r: EdgeReport) => void };
/** The ledger kept in the browser under `key`. Each engine has its own key, so their evidence never mixes. */
export const browserLedger = (key: string): EdgeStorage => ({
    load: () => {
        try {
            const raw = window.localStorage.getItem(key);
            return raw ? (JSON.parse(raw) as EdgeReport) : null;
        } catch {
            return null;
        }
    },
    save: r => {
        try {
            window.localStorage.setItem(key, JSON.stringify(r));
        } catch {
            /* not remembered */
        }
    },
});

export type RefreshInput = {
    now: number;
    symbols: readonly string[];
    /** The contracts the overlay trades (the propositions switched on). */
    contracts: readonly Contract[];
    /**
     * The board the engine settings let through, and the other source's (any tier) or null when it could not be read.
     * `board: null` means the engine has no board at refresh time and will hand it over later through `arbitrate()` (the runner's
     * own eligible cells, on Sixfold and Vanguard). The arbiter and the hold-through-scans count then wait for that call.
     */
    board: readonly BoardRow[] | null;
    other: readonly BoardRow[] | null;
    /** Hunter: the signal source is a voice, never a gate. */
    hunter: boolean;
};

export type EdgeInfluence = ReturnType<typeof createEdgeInfluence>;

export const createEdgeInfluence = (opts: {
    getSettings: () => EdgeSettings;
    /** The live ticks per market. */
    series: () => Readonly<Record<string, readonly number[]>>;
    now?: () => number;
    storage?: EdgeStorage | null;
}) => {
    const clock = opts.now ?? Date.now;
    const storage = opts.storage === undefined ? browserLedger(SENTINEL_LEDGER_KEY) : opts.storage;
    const arbiter = new Arbiter();
    const freq = new FrequencyGate();
    let report: EdgeReport = storage?.load() ?? freshReport(clock());
    let unsaved = 0;

    // ---- per-scan state ----
    let danger: CrossMarketDanger | null = null;
    let hunter = false;
    let verdicts = new Map<string, ArbiterVerdict>();
    let healthCache = new Map<string, Health>();
    const onBoard = new Set<string>();
    /** Vetoed signals waiting for the next tick on their market. */
    let pending: Array<{ symbol: string; contract: Contract; gate: Gate }> = [];
    const lastCounted = new Map<string, number>();

    const persist = () => {
        unsaved += 1;
        if (unsaved >= 10) {
            unsaved = 0;
            storage?.save(report);
        }
    };

    const healthOf = (symbol: string, c: Contract): Health => {
        const key = `${symbol}|${contractKeyOf(c)}`;
        let h = healthCache.get(key);
        if (!h) {
            h = readHealth(opts.series()[symbol] ?? [], c);
            healthCache.set(key, h);
        }
        return h;
    };

    const count = (gate: Gate, symbol: string, c: Contract, now: number) => {
        const key = `${gate}|${symbol}|${contractKeyOf(c)}`;
        if (now - (lastCounted.get(key) ?? -Infinity) < COUNT_EVERY_MS) return;
        lastCounted.set(key, now);
        report.gates[gate].vetoed += 1;
        pending.push({ symbol, contract: c, gate });
        persist();
    };

    /** Reads the board: the hold counts, and one arbiter verdict per signal. */
    const settle = (board: readonly BoardRow[], other: readonly BoardRow[] | null) => {
        const s = opts.getSettings();
        onBoard.clear();
        for (const r of board) onBoard.add(r.key);
        if (s.frequency) freq.observe(onBoard);
        if (s.arbiter) {
            const cands: Candidate[] = board.map(row => {
                const c: Contract = { side: row.contract === 'DIGITOVER' ? 'OVER' : 'UNDER', param: row.barrier };
                return {
                    row,
                    healthLift: s.kalman ? judgeHealth(healthOf(row.symbol, c), { hunter, recovering: false }).rank : 0,
                    second: secondOpinion(row, other),
                };
            });
            verdicts = arbiter.decide(cands);
        } else {
            verdicts = new Map();
            arbiter.reset();
        }
    };

    return {
        /** Once per scan, after the overlay has built its board. */
        refresh(input: RefreshInput): void {
            const s = opts.getSettings();
            hunter = input.hunter;
            healthCache = new Map();
            danger = s.danger ? assessCrossMarketDanger(opts.series(), input.symbols, input.contracts) : null;
            if (input.board) settle(input.board, input.other);
        },

        /**
         * For an engine whose board only exists after the scan: settles the arbiter and the hold-through-scans count on `board`.
         * Call it once per scan, after `refresh({ board: null })`, even with an empty board (a signal that left loses its hold).
         */
        arbitrate(board: readonly BoardRow[], other: readonly BoardRow[] | null = null): void {
            settle(board, other);
        },

        /** Per cell. `row` is the signal on the board for this cell, if there is one. */
        call(
            cell: { symbol: string; contract: Contract },
            row: BoardRow | undefined,
            ctx: { recovering: boolean; now: number }
        ): OverlayCall {
            const s = opts.getSettings();
            const parts: Part[] = [];

            if (s.danger && danger) {
                if (danger.block && (!hunter || danger.level === 'extreme'))
                    parts.push({
                        gate: 'danger',
                        allow: false,
                        bump: 0,
                        rank: 0,
                        note: `Danger ${danger.level} (${danger.score.toFixed(0)}): ${danger.reasons.join('; ')}`,
                    });
                else if (danger.level === 'elevated' || danger.block)
                    parts.push({
                        gate: 'danger',
                        allow: true,
                        bump: ELEVATED_BUMP,
                        rank: 0,
                        note: `Danger elevated: ${danger.reasons.join('; ')}`,
                    });
            }

            if (s.kalman) {
                const h = judgeHealth(healthOf(cell.symbol, cell.contract), { hunter, recovering: ctx.recovering });
                if (h.note || h.bump || h.rank) parts.push({ gate: 'kalman', ...h });
            }

            if (s.frequency) {
                const key = rowKey(cell.symbol, cell.contract);
                const cfg = row ? s : { ...s, minHoldScans: 0 }; // a cell with no signal has no hold to wait for
                const v = freq.check(cell.symbol, key, ctx.now, cfg, { recovering: ctx.recovering, budget: !hunter });
                if (!v.allow) parts.push({ gate: 'frequency', allow: false, bump: 0, rank: 0, note: v.reason });
            }

            if (s.arbiter && row) {
                const v = verdicts.get(row.key);
                if (v && v.role !== 'pick')
                    parts.push({ gate: 'arbiter', allow: false, bump: 0, rank: 0, note: v.note });
                else if (v && /both sources agree/.test(v.note))
                    parts.push({ gate: 'arbiter', allow: true, bump: -1, rank: 1, note: v.note });
            }

            if (parts.length === 0) return NEUTRAL;
            for (const p of parts) if (!p.allow) count(p.gate, cell.symbol, cell.contract, ctx.now);
            if (s.shadow) return NEUTRAL;

            const allow = parts.every(p => p.allow);
            const notes = (allow ? parts : parts.filter(p => !p.allow)).map(p => p.note).filter(Boolean);
            return {
                allow,
                bump: clamp(
                    parts.reduce((a, p) => a + p.bump, 0),
                    -MAX_EASE,
                    MAX_RAISE
                ),
                rank: parts.reduce((a, p) => a + p.rank, 0),
                note: notes.join('; '),
            };
        },

        /** The last look on the buy tick, from the live ticks. Vetoes only what has plainly gone bad since the scan. */
        guard(symbol: string, traded: Contract, series: readonly number[]): { ok: boolean; note: string } {
            const s = opts.getSettings();
            if (s.shadow) return { ok: true, note: '' };
            if (s.danger && danger?.block && (!hunter || danger.level === 'extreme'))
                return { ok: false, note: `Danger ${danger.level}: ${danger.reasons.join('; ')}` };
            if (s.kalman) {
                // `recovering: true` keeps only the decay veto: the level rule was applied at scan time with the real recovery state.
                const h = readHealth(series, traded);
                const j = judgeHealth(h, { hunter, recovering: true });
                if (!j.allow) {
                    count('kalman', symbol, traded, clock());
                    return { ok: false, note: j.note };
                }
                if (h.ready) return { ok: true, note: `Kalman ${(h.level * 100).toFixed(1)}% ${h.trend}` };
            }
            return { ok: true, note: '' };
        },

        onBought(notice: TradeNotice): void {
            freq.record(notice.symbol, clock());
        },

        onSettled(notice: TradeNotice & { profit: number | null }): void {
            if (notice.profit === null) return;
            const bucket = opts.getSettings().shadow ? report.real.shadow : report.real.live;
            bucket.settled += 1;
            if (notice.profit > 0) bucket.wins += 1;
            bucket.fairSum += winProbability(notice.bought);
            persist();
        },

        /** Every tick: settles the vetoed signals of that market on this tick. */
        onTick(symbol: string, digit: number): void {
            if (pending.length === 0) return;
            const rest: typeof pending = [];
            for (const p of pending) {
                if (p.symbol !== symbol) {
                    rest.push(p);
                    continue;
                }
                const g = report.gates[p.gate];
                g.resolved += 1;
                if (winningDigits(p.contract).includes(digit)) g.wouldWin += 1;
                g.fairSum += winProbability(p.contract);
            }
            pending = rest;
        },

        danger: (): CrossMarketDanger | null => danger,
        report: (): EdgeReport => JSON.parse(JSON.stringify(report)) as EdgeReport,
        save: (): void => storage?.save(report),
        reset(): void {
            report = freshReport(clock());
            pending = [];
            lastCounted.clear();
            freq.reset();
            arbiter.reset();
            storage?.save(report);
        },
    };
};

/** One readable block of the evidence, for the console. Rates are percent; `n` is the sample they come from. */
export const describeReport = (r: EdgeReport): string => {
    const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
    const lines = [`Sentinel edge gates since ${new Date(r.since).toISOString()}`];
    for (const g of GATES) {
        const s = r.gates[g];
        lines.push(
            `  ${g.padEnd(9)} stood down ${s.vetoed}; next tick won ${pct(s.wouldWin, s.resolved)} of ${s.resolved} (fair ${pct(s.fairSum, s.resolved)})`
        );
    }
    lines.push(
        `  trades taken, gates live:   ${pct(r.real.live.wins, r.real.live.settled)} of ${r.real.live.settled} (fair ${pct(r.real.live.fairSum, r.real.live.settled)})`
    );
    lines.push(
        `  trades taken, gates shadow: ${pct(r.real.shadow.wins, r.real.shadow.settled)} of ${r.real.shadow.settled} (fair ${pct(r.real.shadow.fairSum, r.real.shadow.settled)})`
    );
    return lines.join('\n');
};
