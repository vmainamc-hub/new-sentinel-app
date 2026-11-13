// APEX INTEL x OVERLORD: which market and which contract get executed, chosen with Overlord's over/under engines.
//
// Overlord's engines (overlord-engine/: its own condition, Oracle's layers, the Apex Sentinel engines, the live steadiness check)
// are used as they are. Nothing in them is copied or changed. This file only decides how their reading takes part in Apex Intel's
// choice of market and contract. It has two parts:
//
//   createOverlordReader   reads every fresh market for the contracts Apex Intel trades, a few markets per call so the page never
//                          stalls, and remembers how each contract held up over the last rounds (Overlord's "assessment").
//   selectByOverlord       takes the candidates Apex Intel's own picker already produced and re-ranks / filters them.
//
// Three selection modes:
//   STANDARD  Apex Intel exactly as it was. The list is returned untouched (same array).
//   OVERLORD  Overlord's reading chooses among the picker's candidates: a contract Overlord vetoes, cannot read, has not watched
//             long enough or finds unsteady is dropped, and the rest are ranked by Overlord's tier and score.
//   COMBINED  All of OVERLORD, and the picker's own evidence as well: the candidate's 95% win-rate lower bound must beat chance.
//             Both engines have to say yes.
//
// What this can never do (the "no dilution" rule, enforced by tests):
//   - add a candidate the picker did not offer, change its entry, its contract kind, its stake or a recovery step;
//   - skip, soften or reorder any later check. The AI guard, the edge gates, the digit 1 / 8 rule and every limit run on whatever
//     is chosen here exactly as before. This step only REMOVES and RE-ORDERS candidates.
// A reading that is missing fails closed: no read means no trade on that market in OVERLORD / COMBINED, never a guess.
//
// Honest limit: Deriv digits are random. Overlord ranks how healthy a contract has been and avoids the moments its engines flag as
// costly. It cannot create an edge and no tier is a prediction.
import type { Contract } from '@/components/premium/sixfold/bot';
import { APEX_MIN_TICKS, type ApexMarket, buildApexMarket } from '../overlord-engine/apex-read';
import { STEADY_SHARE } from '../overlord-engine/assess';
import { assessContract, type MarketSeries, type OverlordRead, type OverlordTier } from '../overlord-engine/engine';
import type { OuSide } from '../overlord-engine/legacy';
import type { FluctuationReport } from '../overlord-engine/apex/fluctuation';
import { replayFluctuation } from '../overlord-engine/apex-stages';

export type SelectionMode = 'STANDARD' | 'OVERLORD' | 'COMBINED';
export const SELECTION_MODES: readonly SelectionMode[] = ['STANDARD', 'OVERLORD', 'COMBINED'];
export const normalizeSelection = (v: unknown): SelectionMode => (v === 'OVERLORD' || v === 'COMBINED' ? v : 'STANDARD');

/** A contract must have been watched for this many reads before Overlord's reading is allowed to choose it. */
export const MIN_ROUNDS = 3;
/** How many of the latest reads are kept per contract for the steadiness share. */
export const ROUND_WINDOW = 6;
/** OVERLORD mode: how many least-bad contracts are returned when none clears every Overlord check. */
export const LEAST_BAD_COUNT = 3;

const TIER_RANK: Record<OverlordTier, number> = { STRONG: 3, BEST: 2, CAUTION: 1, LEGACY: 0 };

/** One contract on one market as Overlord reads it, with how steadily it has been clear of every veto. */
export type OverlordView = {
    read: OverlordRead;
    /** Reads taken so far (at most ROUND_WINDOW kept). */
    rounds: number;
    /** Share of those reads in which no Overlord layer vetoed the contract. */
    clearShare: number;
    /** When the newest read was taken. */
    at: number;
};

export type BlockReason = 'no-read' | 'thin' | 'veto' | 'watching' | 'unsteady' | 'edge';
export type Blocked = { key: string; market: string; label: string; reason: BlockReason; text: string };

export type Selection<T> = {
    items: T[];
    blocked: Blocked[];
    /** True when no contract cleared Overlord and the items are the least-bad few it returned instead (labelled, never hidden). */
    leastBad: boolean;
    /** With `leastBad`: why each returned item did not clear. */
    caution: Blocked[];
};

export type SelectOptions<T> = {
    mode: SelectionMode;
    contractOf: (item: T) => Contract;
    viewOf: (market: string, contract: Contract) => OverlordView | null;
    /** The candidate's own evidence: true when the picker's lower bound beats chance. COMBINED needs it. */
    hasEdge: (item: T) => boolean;
    /** Optional: the item as it should be shown once chosen (for example with Overlord's tier in its reason). Must not change what it trades. */
    annotate?: (item: T, view: OverlordView, leastBad: boolean) => T;
    /**
     * OVERLORD mode: when no contract clears Overlord, return this many of the least-bad ones instead of nothing, the way Overlord Pro's
     * own Find Market always returns its best (labelled CAUTION when every contract was vetoed). 0 / absent = strict: nothing clears,
     * nothing is returned (COMBINED). A contract with no reading at all is never returned: there is nothing to rank it by.
     */
    fallback?: number;
};

const keyOf = (market: string, c: Contract) => `${market}:${c.side}:${c.param}`;
const labelOf = (c: Contract) => `${c.side === 'OVER' ? 'Over' : c.side === 'UNDER' ? 'Under' : String(c.side)} ${c.param}`;

/**
 * Re-ranks and filters candidates with Overlord's reading. STANDARD returns the very same array. In the other modes the result
 * only ever contains items from the input, never new ones.
 */
export function selectByOverlord<T extends { market: string; label: string }>(items: readonly T[], o: SelectOptions<T>): Selection<T> {
    if (o.mode === 'STANDARD') return { items: items as T[], blocked: [], leastBad: false, caution: [] };
    const blocked: Blocked[] = [];
    const clear: { item: T; view: OverlordView; index: number }[] = [];
    const unclear: { item: T; view: OverlordView; index: number; why: Blocked }[] = [];
    items.forEach((item, index) => {
        const c = o.contractOf(item);
        const key = keyOf(item.market, c);
        const why = (reason: BlockReason, text: string): Blocked => ({ key, market: item.market, label: item.label, reason, text });
        const view = o.viewOf(item.market, c);
        if (!view) return void blocked.push(why('no-read', `Overlord has no reading of ${item.market} yet (it needs quotes and ${APEX_MIN_TICKS}+ ticks)`));
        let fail: Blocked | null = null;
        if (view.read.thin) fail = why('thin', `${item.market}: too little history for Overlord's deeper engines`);
        else if (view.read.vetoed) fail = why('veto', view.read.vetoReason || 'an Overlord layer vetoed it');
        else if (view.rounds < MIN_ROUNDS) fail = why('watching', `Overlord is still watching ${item.market} (${view.rounds} of ${MIN_ROUNDS} reads)`);
        else if (view.clearShare < STEADY_SHARE)
            fail = why('unsteady', `${labelOf(c)} on ${item.market} was clear of every Overlord veto in only ${Math.round(view.clearShare * 100)}% of its reads (needs ${Math.round(STEADY_SHARE * 100)}%)`);
        else if (o.mode === 'COMBINED' && !o.hasEdge(item)) fail = why('edge', `${item.label} on ${item.market}: its own win-rate lower bound does not beat chance (COMBINED needs both engines)`);
        if (fail) unclear.push({ item, view, index, why: fail });
        else clear.push({ item, view, index });
    });
    const byRead = (a: { view: OverlordView; index: number }, b: { view: OverlordView; index: number }) =>
        TIER_RANK[b.view.read.tier] - TIER_RANK[a.view.read.tier] || b.view.read.score - a.view.read.score || a.index - b.index;
    clear.sort(byRead);
    const show = (k: { item: T; view: OverlordView }, leastBad: boolean) => (o.annotate ? o.annotate(k.item, k.view, leastBad) : k.item);
    if (clear.length > 0 || !(o.fallback && o.fallback > 0) || unclear.length === 0) {
        for (const u of unclear) blocked.push(u.why);
        return { items: clear.map(k => show(k, false)), blocked, leastBad: false, caution: [] };
    }
    // Nothing cleared. Overlord still names its least-bad contracts, best tier and score first, and says so.
    unclear.sort(byRead);
    const picked = unclear.slice(0, o.fallback);
    for (const u of unclear.slice(o.fallback)) blocked.push(u.why);
    return { items: picked.map(k => show(k, true)), blocked, leastBad: true, caution: picked.map(k => k.why) };
}

/** Counts of blocks by reason, for one short log line. */
export const summariseBlocked = (blocked: readonly Blocked[]): string => {
    if (!blocked.length) return '';
    const by = new Map<BlockReason, number>();
    for (const b of blocked) by.set(b.reason, (by.get(b.reason) ?? 0) + 1);
    const names: Record<BlockReason, string> = {
        'no-read': 'no reading',
        thin: 'too little history',
        veto: 'vetoed',
        watching: 'still watching',
        unsteady: 'unsteady',
        edge: 'no edge of its own',
    };
    return [...by.entries()].map(([r, n]) => `${n} ${names[r]}`).join(', ');
};

// ---------------------------------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------------------------------

type AssessFn = typeof assessContract;
type BuildFn = (prices: readonly number[], digits: readonly number[]) => ApexMarket | null;
type FluctFn = (prices: readonly number[], digits: readonly number[]) => FluctuationReport | null;

export type OverlordReaderOptions = {
    /** Last digits per market (the app's shared feed). */
    series: () => Readonly<Record<string, readonly number[]>>;
    /** Quotes per market, one per digit (the same feed). A market whose quotes do not line up with its digits is not read. */
    prices: () => Readonly<Record<string, readonly number[]>>;
    /** The contracts to read on every market. Default: Over 2, Under 7 and the recovery pair Over 3, Under 6. */
    contracts?: readonly Contract[];
    /** A market is read again once its last read is this old. */
    everyMs?: number;
    /**
     * Time budget of one `refresh` call. Markets are read, oldest reading first, until the budget is spent (always at least one), so a
     * board tick never stalls the page yet every market keeps getting read. Measured on a desktop: about 137 ms per market with every
     * engine on (2000 ticks, 4 contracts), 95 ms without the fluctuation replay, 25 ms with neither the model ensemble nor the replay.
     */
    budgetMs?: number;
    /** Hard cap on markets read per call (default 6). */
    batch?: number;
    /** A read older than this is treated as missing. Must comfortably exceed one full cycle over every market (default 2 minutes). */
    maxAgeMs?: number;
    /** Clock for the time budget (test seam). */
    clock?: () => number;
    /** Give the walk-forward model ensemble (the slow engine) to every read. Overlord's own Find Market does this for the contract on screen. */
    ensemble?: boolean;
    /** Replay the market for Apex's fluctuation engine on each read (slow, about a third of a full read). Default on. */
    fluctuation?: boolean;
    // Test seams.
    assess?: AssessFn;
    build?: BuildFn;
    fluct?: FluctFn;
};

export const DEFAULT_READ_CONTRACTS: readonly Contract[] = [
    { side: 'OVER', param: 2 },
    { side: 'UNDER', param: 7 },
    { side: 'OVER', param: 3 },
    { side: 'UNDER', param: 6 },
];

export type OverlordReader = {
    /**
     * Reads the markets whose reading is oldest first (never-read ones before any re-read), within the time budget. `priority` (the
     * markets the picker is considering right now) only breaks ties between equally old readings: it must never starve the others, or
     * their readings expire. Returns how many markets were read.
     */
    refresh: (now: number, priority?: readonly string[]) => number;
    /** The newest reading of one contract on one market, or null when there is none or it is too old. */
    get: (market: string, contract: Contract, now: number) => OverlordView | null;
    /** Forget everything (a new run starts watching from zero). */
    reset: () => void;
    /** For the page: how many markets have a reading, and when the newest was taken. */
    status: (now: number) => { markets: number; newestAt: number | null };
};

export function createOverlordReader(opts: OverlordReaderOptions): OverlordReader {
    const contracts = opts.contracts ?? DEFAULT_READ_CONTRACTS;
    const everyMs = opts.everyMs ?? 4_000;
    const batch = Math.max(1, opts.batch ?? 6);
    const budgetMs = opts.budgetMs ?? 250;
    const clock = opts.clock ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const maxAgeMs = opts.maxAgeMs ?? 120_000;
    const assess = opts.assess ?? assessContract;
    const build: BuildFn = opts.build ?? buildApexMarket;
    const fluct: FluctFn = opts.fluct ?? ((p, d) => replayFluctuation(p as number[], d as number[]));
    const views = new Map<string, OverlordView>();
    /** Per contract: was each of the latest reads clear of every veto? */
    const history = new Map<string, boolean[]>();
    const readAt = new Map<string, number>();

    const sideOf = (c: Contract): OuSide | null => (c.side === 'OVER' || c.side === 'UNDER' ? c.side : null);

    const readMarket = (symbol: string, digits: readonly number[], prices: readonly number[], now: number) => {
        const series: MarketSeries = { prices, digits };
        const market = digits.length >= APEX_MIN_TICKS ? build(prices, digits) : null;
        let fl: FluctuationReport | null = null;
        if ((opts.fluctuation ?? true) && market) {
            try {
                fl = fluct(prices, digits);
            } catch {
                fl = null;
            }
        }
        for (const c of contracts) {
            const side = sideOf(c);
            if (!side) continue;
            let read: OverlordRead;
            try {
                read = assess(symbol, series, side, c.param, market, opts.ensemble ?? true, fl);
            } catch {
                continue; // a reading that failed is a missing reading, never a made-up one
            }
            const key = keyOf(symbol, c);
            const h = [...(history.get(key) ?? []), !read.vetoed && !read.thin].slice(-ROUND_WINDOW);
            history.set(key, h);
            views.set(key, { read, rounds: h.length, clearShare: h.filter(Boolean).length / h.length, at: now });
        }
        readAt.set(symbol, now);
    };

    return {
        refresh(now, priority = []) {
            let digitsBy: Readonly<Record<string, readonly number[]>>;
            let pricesBy: Readonly<Record<string, readonly number[]>>;
            try {
                digitsBy = opts.series();
                pricesBy = opts.prices();
            } catch {
                return 0;
            }
            const due = Object.keys(digitsBy)
                .filter(s => {
                    const d = digitsBy[s];
                    const p = pricesBy[s];
                    return d && p && d.length >= APEX_MIN_TICKS && p.length === d.length && now - (readAt.get(s) ?? -Infinity) >= everyMs;
                })
                .sort(
                    (a, b) =>
                        (readAt.get(a) ?? -Infinity) - (readAt.get(b) ?? -Infinity) ||
                        Number(!priority.includes(a)) - Number(!priority.includes(b))
                );
            const started = clock();
            let done = 0;
            for (const s of due) {
                if (done >= batch || (done > 0 && clock() - started >= budgetMs)) break;
                readMarket(s, digitsBy[s], pricesBy[s], now);
                done += 1;
            }
            return done;
        },
        get(market, contract, now) {
            const v = views.get(keyOf(market, contract));
            return v && now - v.at <= maxAgeMs ? v : null;
        },
        reset() {
            views.clear();
            history.clear();
            readAt.clear();
        },
        status(now) {
            let newest: number | null = null;
            const live = new Set<string>();
            for (const [k, v] of views) {
                if (now - v.at > maxAgeMs) continue;
                live.add(k.split(':')[0]);
                if (newest === null || v.at > newest) newest = v.at;
            }
            return { markets: live.size, newestAt: newest };
        },
    };
}
