// SENTINEL AI: the Pulse overlay for the Sixfold runner. Pure apart from the injected `read`.
//
// Each scan, Pulse (pulse.ts) reads every market and contract once. Every scanner cell then gets a verdict: vetoed when Pulse has no
// signal at the strength the mode asks for, an easier bar for a strong signal, a higher bar for a watch signal, and an ordering
// bonus by Pulse score. The scanner, Meter, loss shield and money rules are Sixfold's. Pulse decides when to look, it cannot create
// an edge on random digits, and the app says so.
import { discoverEntry, type EntryPick, SCAN_SPECS } from '../bulk-scan';
import type { EntryTrigger, RunnerOverlay } from '../sixfold/overlay';
import type { EdgeInfluence } from './edge/influence';
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

/**
 * How long a market's entry digit is kept before it is worked out again from the newest ticks. The digit is found by replaying the
 * market's own history (the Bulk Trader's engine, see bulk-scan.ts `discoverEntry`); a minute keeps it steady while it is waited
 * for, and the replay still follows the market.
 */
export const ENTRY_DIGIT_TTL_MS = 60_000;

/** The entry digit of one contract on one market, from the Bulk Trader's replay. Null when the history is too short or the contract is not one of the six. */
export const entryTriggerOf = (series: readonly number[], side: string, param: number, duration: number): { trigger: EntryTrigger; pick: EntryPick } | null => {
    if (side !== 'OVER' && side !== 'UNDER') return null; // the replay reads the six Over / Under contracts only
    const spec = SCAN_SPECS.find(s => s.contract === (side === 'OVER' ? 'DIGITOVER' : 'DIGITUNDER') && s.barrier === param);
    if (!spec) return null;
    const pick = discoverEntry(series, spec, duration);
    if (!pick) return null;
    return { trigger: { digit: pick.digit, strength: pick.strength, note: pick.note }, pick };
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
    /** The Kalman / danger / frequency / arbiter gates (see ./edge). Without it the overlay behaves exactly as before. */
    edge?: EdgeInfluence;
    /** The signal source that is NOT selected, read the same way. The arbiter uses it as a second opinion. */
    readOther?: (symbols: readonly string[], engine: EngineSettings) => PulseSnapshot;
}): RunnerOverlay & { board: () => BoardRow[]; funnel: () => EngineFunnel | null } => {
    let board: BoardRow[] = [];
    let funnel: EngineFunnel | null = null;
    const index = new Map<string, BoardRow>();
    const clock = opts.now ?? Date.now;
    let lastActivity = clock();
    // Each market's entry digit per contract, kept for ENTRY_DIGIT_TTL_MS so the digit being waited for does not change every scan.
    const entryCache = new Map<string, { at: number; trigger: EntryTrigger | null }>();

    const baseCall: RunnerOverlay['call'] = (cell, ctx) => {
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
    };

    return {
        moduleId: 'sentinel-ai',
        name: 'Sentinel AI',
        contracts: () => contractsFor(opts.getEngine()),
        onStart: now => {
            lastActivity = now;
            entryCache.clear(); // a new session works the digits out afresh from the newest ticks
        },
        entryTrigger: (symbol, traded, series, ctx) => {
            const key = `${symbol}|${traded.side}:${traded.param}|${ctx.duration}`;
            const hit = entryCache.get(key);
            if (hit && ctx.now - hit.at < ENTRY_DIGIT_TTL_MS && (hit.trigger || ctx.now - hit.at < 5_000)) return hit.trigger;
            let trigger: EntryTrigger | null = null;
            try {
                trigger = entryTriggerOf(series, traded.side, traded.param, ctx.duration)?.trigger ?? null;
            } catch {
                trigger = null; // an entry digit that cannot be worked out leaves the usual entry in force
            }
            entryCache.set(key, { at: ctx.now, trigger });
            return trigger;
        },
        onBought: notice => {
            lastActivity = clock();
            try {
                opts.edge?.onBought(notice);
            } catch {
                /* a gate failure must never disturb a live trade */
            }
        },
        onSettled: notice => {
            lastActivity = clock();
            try {
                opts.edge?.onSettled(notice);
            } catch {
                /* a gate failure must never disturb a live session */
            }
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
            if (opts.edge) {
                try {
                    let other: BoardRow[] | null = null;
                    try {
                        const snap = opts.readOther?.(symbols, engine);
                        other = snap ? buildBoard(snap, { ...engine, mode: 'active' }) : null;
                    } catch {
                        other = null; // no second opinion is not a reason to stop
                    }
                    opts.edge.refresh({
                        now,
                        symbols,
                        contracts: contractsFor(engine),
                        board,
                        other,
                        hunter: engine.mode === 'hunter',
                    });
                } catch {
                    /* the gates stay on their last read; the engine's own verdicts are unaffected */
                }
            }
        },
        board: () => board,
        funnel: () => funnel,
        guard: (symbol, traded, series) => {
            const read = readSpecialDigits(series, traded.side);
            if (!read.ok || !opts.edge) return { ok: read.ok, note: read.note };
            try {
                const edge = opts.edge.guard(symbol, traded, series);
                return { ok: edge.ok, note: [read.note, edge.note].filter(Boolean).join('; ') };
            } catch {
                return { ok: true, note: read.note }; // the gates are an extra look; the mandatory rule has already passed
            }
        },
        call: (cell, ctx) => {
            const base = baseCall(cell, ctx);
            // A signal the engine already stood down has nothing left for the gates to judge.
            if (!opts.edge || !base.allow) return base;
            try {
                const row = index.get(keyOf(cell.symbol, cell.contract.side, cell.contract.param));
                const extra = opts.edge.call(cell, row, { recovering: ctx.recovering, now: ctx.now });
                return {
                    allow: extra.allow,
                    bump: base.bump + extra.bump,
                    rank: base.rank + extra.rank,
                    note: [base.note, extra.note].filter(Boolean).join('; '),
                };
            } catch {
                return base;
            }
        },
    };
};
