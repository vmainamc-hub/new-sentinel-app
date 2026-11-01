// SENTINEL AI: the Pulse overlay for the Sixfold runner. Pure apart from the injected `read`.
//
// Each scan, Pulse (pulse.ts) reads every market and contract once. Every scanner cell then gets a verdict: vetoed when Pulse has no
// signal at the strength the mode asks for, an easier bar for a strong signal, a higher bar for a watch signal, and an ordering
// bonus by Pulse score. The scanner, Meter, loss shield and money rules are Sixfold's. Pulse decides when to look, it cannot create
// an edge on random digits, and the app says so.
import type { RunnerOverlay } from '../sixfold/overlay';
import type { PulseRead, PulseSnapshot, PulseTier } from './pulse';
import { contractsFor, type EngineSettings } from './settings';
import { readSpecialDigits } from './special-digits';

export type BoardRow = {
    key: string;
    symbol: string;
    contract: 'DIGITOVER' | 'DIGITUNDER';
    barrier: number;
    label: string;
    tier: PulseTier;
    score: number;
    /** Windows (of 4) above the fair rate. */
    agree: number;
};

/** What Pulse did on the latest read: each number is how many contracts survived that step. */
export type EngineFunnel = {
    at: number;
    mode: EngineSettings['mode'];
    /** Which engine produced the signals (absent on older readings: Pulse). */
    source?: EngineSettings['source'];
    /** Markets with enough ticks, and contracts read. */
    markets: number;
    reads: number;
    /** Contracts per tier (before the mode picks). */
    strong: number;
    steady: number;
    watch: number;
    none: number;
    /** Contracts the mode lets onto the board. */
    board: number;
    error: string | null;
};

export const keyOf = (symbol: string, side: string, param: number) =>
    `${symbol}|${side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER'}|${param}`;

/** Tiers each mode accepts. */
export const ACCEPTED: Record<EngineSettings['mode'], readonly PulseTier[]> = {
    hunter: ['strong', 'steady', 'watch'],
    careful: ['strong'],
    balanced: ['strong', 'steady'],
    active: ['strong', 'steady', 'watch'],
};

/** The Hunter never goes quiet: with no trade for a while, the score a contract needs comes down in steps (see huntEase). */
export const HUNT_GRACE_MS = 15_000;
export const HUNT_STEP_MS = 5_000;
export const HUNT_STEP_POINTS = 3;
export const HUNT_MAX_EASE = 30;
export const huntEase = (idleMs: number): number =>
    idleMs <= HUNT_GRACE_MS
        ? 0
        : Math.min(HUNT_MAX_EASE, (Math.floor((idleMs - HUNT_GRACE_MS) / HUNT_STEP_MS) + 1) * HUNT_STEP_POINTS);

const TIER_BUMP: Record<PulseTier, number> = { strong: -6, steady: 0, watch: 4 };
const TIER_RANK: Record<PulseTier, number> = { strong: 3, steady: 2, watch: 1 };
const TIER_RANK_NUMBER: Record<PulseTier, number> = { strong: 1, steady: 2, watch: 3 };

export const toRow = (r: PulseRead): BoardRow => ({
    key: keyOf(r.symbol, r.contract.side, r.contract.param),
    symbol: r.symbol,
    contract: r.contract.side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER',
    barrier: r.contract.param,
    label: `${r.contract.side === 'OVER' ? 'Over' : 'Under'} ${r.contract.param}`,
    tier: r.tier as PulseTier,
    score: r.score,
    agree: r.agree,
});

/** The contracts the mode lets through, restricted to the propositions switched on. Strongest first. */
export const buildBoard = (snap: PulseSnapshot, engine: EngineSettings): BoardRow[] => {
    const on = new Set(engine.propositions);
    const ok = new Set<PulseTier>(ACCEPTED[engine.mode]);
    return snap.reads
        .filter(r => r.tier && ok.has(r.tier) && on.has(`${r.contract.side}:${r.contract.param}`))
        .map(toRow)
        .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.score - a.score);
};

export const funnelOf = (snap: PulseSnapshot, board: BoardRow[], engine: EngineSettings, now: number): EngineFunnel => {
    const count = (t: PulseTier) => snap.reads.filter(r => r.tier === t).length;
    return {
        at: now,
        mode: engine.mode,
        source: engine.source,
        markets: snap.markets,
        reads: snap.reads.length,
        strong: count('strong'),
        steady: count('steady'),
        watch: count('watch'),
        none: snap.reads.filter(r => r.tier === null).length,
        board: board.length,
        error: null,
    };
};

export const createSentinelOverlay = (opts: {
    getEngine: () => EngineSettings;
    read: (symbols: readonly string[], engine: EngineSettings) => PulseSnapshot;
    /** The live ticks per market. The special-digit rule reads them; without it the rule cannot run, so production always passes it. */
    series?: () => Readonly<Record<string, readonly number[]>>;
    /** The clock used for the Hunter's idle time. Default: Date.now. */
    now?: () => number;
}): RunnerOverlay & { board: () => BoardRow[]; funnel: () => EngineFunnel | null } => {
    let board: BoardRow[] = [];
    let funnel: EngineFunnel | null = null;
    const index = new Map<string, BoardRow>();
    const clock = opts.now ?? Date.now;
    let lastActivity = clock();

    return {
        moduleId: 'sentinel-ai',
        name: 'Sentinel AI',
        contracts: () => contractsFor(opts.getEngine()),
        onStart: now => {
            lastActivity = now;
        },
        onBought: () => {
            lastActivity = clock();
        },
        onSettled: () => {
            lastActivity = clock();
        },
        refresh: (now, symbols) => {
            const engine = opts.getEngine();
            try {
                const snap = opts.read(symbols, engine);
                board = buildBoard(snap, engine);
                funnel = funnelOf(snap, board, engine, now);
            } catch (error) {
                board = []; // a failed read backs nothing, so nothing trades on a guess
                funnel = {
                    at: now,
                    mode: engine.mode,
                    source: engine.source,
                    markets: 0,
                    reads: 0,
                    strong: 0,
                    steady: 0,
                    watch: 0,
                    none: 0,
                    board: 0,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
            index.clear();
            for (const row of board) index.set(row.key, row);
        },
        board: () => board,
        funnel: () => funnel,
        guard: (symbol, traded, series) => {
            const read = readSpecialDigits(series, traded.side);
            return { ok: read.ok, note: read.note };
        },
        call: (cell, ctx) => {
            // MANDATORY special-digit rule (digit 1 for Over, digit 8 for Under): applies in every mode, the Hunter included.
            if (opts.series) {
                const special = readSpecialDigits(opts.series()[cell.symbol], cell.contract.side);
                if (!special.ok) return { allow: false, bump: 0, rank: 0, note: special.note };
            }
            const { mode, source } = opts.getEngine();
            const who = source === 'digits' ? 'Digits Analysis' : 'Pulse';
            const row = index.get(keyOf(cell.symbol, cell.contract.side, cell.contract.param));
            if (mode === 'hunter') {
                // The signal source is a voice, not a gate: a signal eases the bar by its strength, no signal raises it a little, and
                // the idle clock eases it step by step so something always comes up. The scanner, Meter guide, win-streak guard,
                // loss shield and limits stay.
                const idle = Math.max(0, ctx.now - lastActivity);
                const ease = huntEase(idle);
                const notes = [
                    row
                        ? source === 'digits'
                            ? `Digits Analysis #${TIER_RANK_NUMBER[row.tier]} for its pair`
                            : `Pulse ${row.tier} (${row.agree} of 4 windows)`
                        : `no ${who} signal`,
                    ease > 0 ? `no trade for ${Math.round(idle / 1000)}s: bar eased by ${ease}` : '',
                ].filter(Boolean);
                return {
                    allow: true,
                    bump: (row ? TIER_BUMP[row.tier] : 4) - ease,
                    rank: row ? Math.min(10, row.score / 10) + TIER_RANK[row.tier] : 0,
                    note: notes.join('; '),
                };
            }
            if (!row) {
                if (mode === 'active') return { allow: true, bump: 6, rank: 0, note: `no ${who} signal: higher bar` };
                return {
                    allow: false,
                    bump: 0,
                    rank: 0,
                    note:
                        source === 'digits'
                            ? `not in Digits Analysis's top ${mode === 'careful' ? '1' : '2'} for its pair`
                            : `no ${mode === 'careful' ? 'strong' : 'strong or steady'} Pulse signal`,
                };
            }
            return {
                allow: true,
                bump: TIER_BUMP[row.tier],
                rank: Math.min(10, row.score / 10) + TIER_RANK[row.tier],
                note:
                    source === 'digits'
                        ? `Digits Analysis #${TIER_RANK_NUMBER[row.tier]} for its pair`
                        : `Pulse ${row.tier} (${row.agree} of 4 windows)`,
            };
        },
    };
};
