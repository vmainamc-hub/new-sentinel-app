// OVERLORD ASSESSMENT. Find Market does not answer the instant the history arrives.
//
// After the deep history is in, the markets are watched LIVE for a few seconds. Every few seconds the whole scan is run
// again on the history plus the ticks that arrived meanwhile, and every contract is scored on how it behaved across those
// rounds: how often it was vetoed (a losing digit starting to flood, a signal dying), and how often it was among the best.
// A contract that is great on one reading and vetoed on the next is not the one to trade. The verdict blends the final full
// scan (60%) with how often the contract was among the leaders (25%) and how often it was clear of every veto (15%).
// STRONG is only kept when the contract was clear in at least STEADY_SHARE of the rounds.
//
// Honest limit: this watches for contracts whose health holds while it is observed. It cannot predict the next tick.
import { compareReads, type MarketSeries, type OverlordInput, type OverlordRead, type OverlordScan, scanOverlord } from './engine';
import { fallbackDecimals, lastDigit } from './legacy';

/** How long a market is watched before the verdict, and how often the scan is repeated meanwhile. */
export const ASSESS_MS = 15_000;
export const ROUND_MS = 3_000;
/** A contract must have been clear of every veto in at least this share of the rounds to stay STRONG. */
export const STEADY_SHARE = 0.6;
/** How many of the best contracts each round count as "among the leaders". */
const LEADERS = 3;
const MAX_TICKS = 5000;

const round1 = (x: number) => Math.round(x * 10) / 10;
const keyOf = (r: Pick<OverlordRead, 'symbol' | 'side' | 'barrier'>) => `${r.symbol}:${r.side}:${r.barrier}`;

export class OverlordAssessment {
    private n = 0;
    private clear = new Map<string, number>();
    private top = new Map<string, number>();

    get rounds(): number {
        return this.n;
    }

    /** One round's scan. */
    observe(scan: OverlordScan): void {
        if (scan.legacyOnly) return;
        this.n += 1;
        for (const r of scan.reads) {
            if (r.thin) continue;
            if (!r.vetoed) this.clear.set(keyOf(r), (this.clear.get(keyOf(r)) ?? 0) + 1);
        }
        for (const r of scan.reads.filter(x => !x.thin && !x.vetoed).slice(0, LEADERS))
            this.top.set(keyOf(r), (this.top.get(keyOf(r)) ?? 0) + 1);
    }

    share(r: OverlordRead): { clear: number; top: number } {
        if (this.n === 0) return { clear: r.vetoed ? 0 : 1, top: 0 };
        return { clear: (this.clear.get(keyOf(r)) ?? 0) / this.n, top: (this.top.get(keyOf(r)) ?? 0) / this.n };
    }

    /**
     * Re-ranks the final scan with what was seen during the assessment: the rounds, and the live ticks themselves
     * (`live` = the digits that arrived per market during the window). Unchanged when there was nothing to learn from.
     */
    finalize(scan: OverlordScan, live: Readonly<Record<string, readonly number[]>> = {}): OverlordScan {
        const anyLive = Object.values(live).some(d => d.length > 0);
        if (scan.legacyOnly || (this.n < 2 && !anyLive)) return scan;
        const reads = scan.reads.map(r => {
            if (r.thin) return r;
            const s = this.n >= 2 ? this.share(r) : { clear: r.vetoed ? 0 : 1, top: 0 };
            const ev = liveEvidence(live[r.symbol] ?? [], r.side, r.barrier);
            // Live ticks count once there are enough of them to say anything; before that the weights are the original ones.
            const score = round1(
                ev.n >= MIN_LIVE_TICKS
                    ? 0.5 * r.score + 0.2 * s.top * 100 + 0.1 * s.clear * 100 + 0.2 * liveScore(ev)
                    : 0.6 * r.score + 0.25 * s.top * 100 + 0.15 * s.clear * 100
            );
            const against = ev.n >= MIN_LIVE_TICKS && ev.z <= LIVE_AGAINST_Z;
            let tier = r.tier === 'STRONG' && (s.clear < STEADY_SHARE || ev.z < 0) ? ('BEST' as const) : r.tier;
            let vetoed = r.vetoed;
            let vetoReason = r.vetoReason;
            if (against && !r.vetoed) {
                vetoed = true;
                tier = 'CAUTION';
                vetoReason = `Live ticks: only ${ev.wins} of ${ev.n} won, expected about ${ev.expected.toFixed(1)}`;
            }
            return {
                ...r,
                score,
                tier,
                vetoed,
                vetoReason,
                live: ev.n > 0 ? ev : undefined,
                steady: { rounds: this.n, clearShare: s.clear, topShare: s.top },
            };
        });
        reads.sort(compareReads);
        const deep = reads.filter(r => !r.thin);
        return { ...scan, reads, best: deep[0] ?? scan.best };
    }
}

/** Fewer live ticks than this say nothing, so they carry no weight. */
export const MIN_LIVE_TICKS = 5;
/** Live ticks this far below what the contract needs (in standard deviations) flag the contract as going against us. */
export const LIVE_AGAINST_Z = -1.8;

export type LiveEvidence = { n: number; wins: number; expected: number; z: number };

/** What the ticks that arrived during the assessment say about one contract: wins against what chance alone gives. */
export const liveEvidence = (digits: readonly number[], side: 'OVER' | 'UNDER', barrier: number): LiveEvidence => {
    const fair = side === 'OVER' ? (9 - barrier) / 10 : barrier / 10;
    const n = digits.length;
    const wins = digits.filter(d => (side === 'OVER' ? d > barrier : d < barrier)).length;
    const sd = Math.sqrt(Math.max(1e-9, n * fair * (1 - fair)));
    return { n, wins, expected: n * fair, z: n > 0 ? (wins - n * fair) / sd : 0 };
};

/** 0-100: 50 when the live ticks won as often as chance gives, more when they won more, less when they lost more. */
const liveScore = (ev: LiveEvidence) => Math.max(0, Math.min(100, 50 + 15 * ev.z));

// ---------------------------------------------------------------------------------------------------------------------
// Live ticks
// ---------------------------------------------------------------------------------------------------------------------

export type LiveSeries = { prices: number[]; digits: number[]; decimals?: number };

/** Pure: appends one live tick to a series, keeping at most MAX_TICKS. Returns false when the tick is not a usable quote. */
export const appendTick = (series: LiveSeries, symbol: string, quote: unknown, pip?: unknown): boolean => {
    const price = Number(quote);
    if (!Number.isFinite(price)) return false;
    const p = Number(pip);
    const decimals =
        series.decimals ?? (Number.isInteger(p) && p >= 0 && p <= 8 ? p : fallbackDecimals(symbol));
    series.prices.push(price);
    series.digits.push(lastDigit(price, decimals));
    if (series.prices.length > MAX_TICKS) {
        series.prices.shift();
        series.digits.shift();
    }
    return true;
};

type SocketLike = Pick<WebSocket, 'send' | 'close'> & {
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
};

const openTickStream = (
    url: string,
    symbols: readonly string[],
    onTick: (symbol: string, quote: unknown, pip: unknown) => void,
    create?: (url: string) => SocketLike
) => {
    let ws: SocketLike | null = null;
    try {
        ws = create ? create(url) : (new WebSocket(url) as unknown as SocketLike);
    } catch {
        return { close: () => undefined };
    }
    ws.onopen = () => {
        for (const symbol of symbols) ws?.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
    };
    ws.onmessage = ev => {
        try {
            const msg = JSON.parse(String(ev.data));
            if (msg?.tick?.symbol) onTick(msg.tick.symbol, msg.tick.quote, msg.tick.pip_size);
        } catch {
            /* ignore malformed frames */
        }
    };
    return {
        close: () => {
            try {
                ws?.close();
            } catch {
                /* already closed */
            }
        },
    };
};

// ---------------------------------------------------------------------------------------------------------------------
// The assessment run
// ---------------------------------------------------------------------------------------------------------------------

export type AssessProgress = {
    elapsedMs: number;
    assessMs: number;
    /** Live ticks received so far, across all markets. */
    ticks: number;
    rounds: number;
    /** The current leader, or null before the first round. */
    leader: { symbol: string; label: string; score: number } | null;
    /** Contracts vetoed in the latest round (losing digits flooding, a dying signal...). */
    flagged: number;
};

export type AssessOptions = Omit<OverlordInput, 'series'> & {
    series: Record<string, MarketSeries>;
    url: string;
    assessMs?: number;
    roundMs?: number;
    cancelled?: () => boolean;
    onProgress?: (p: AssessProgress) => void;
    /** Injected for tests. */
    createSocket?: (url: string) => SocketLike;
    wait?: (ms: number) => Promise<void>;
};

export type Assessed = { scan: OverlordScan; ticks: number; rounds: number; liveTicks: boolean; cancelled: boolean };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function assessOverlord(opts: AssessOptions): Promise<Assessed> {
    const assessMs = opts.assessMs ?? ASSESS_MS;
    const roundMs = Math.max(50, opts.roundMs ?? ROUND_MS);
    const wait = opts.wait ?? sleep;
    // The scan works on copies: live ticks are appended to these, the history passed in is left alone.
    const live: Record<string, LiveSeries> = {};
    for (const [symbol, s] of Object.entries(opts.series))
        live[symbol] = { prices: [...s.prices], digits: [...s.digits], decimals: s.decimals };
    let ticks = 0;
    const liveCount: Record<string, number> = {};
    const stream = openTickStream(
        opts.url,
        opts.symbols,
        (symbol, quote, pip) => {
            const s = live[symbol];
            if (s && appendTick(s, symbol, quote, pip)) {
                ticks += 1;
                liveCount[symbol] = (liveCount[symbol] ?? 0) + 1;
            }
        },
        opts.createSocket
    );

    const assessment = new OverlordAssessment();
    // Rounds are quick: the slow walk-forward models and the fluctuation replay are left for the final scan.
    const quick: OverlordInput = { ...opts, series: live, ensembleTop: 0, fluctuationTop: 0 };
    const started = Date.now();
    let cancelled = false;
    let leader: AssessProgress['leader'] = null;
    let flagged = 0;
    const report = () =>
        opts.onProgress?.({
            elapsedMs: Math.min(assessMs, Date.now() - started),
            assessMs,
            ticks,
            rounds: assessment.rounds,
            leader,
            flagged,
        });
    try {
        report();
        while (Date.now() - started < assessMs) {
            // Wait in short slices so the progress moves and a stop is noticed quickly.
            const nextRound = Date.now() + roundMs;
            while (Date.now() < nextRound && Date.now() - started < assessMs) {
                await wait(Math.min(250, Math.max(10, nextRound - Date.now())));
                if (opts.cancelled?.()) {
                    cancelled = true;
                    break;
                }
                report();
            }
            if (cancelled) break;
            // No live ticks after a third of the window: nothing is changing, so waiting longer would add nothing.
            if (ticks === 0 && Date.now() - started >= assessMs / 3) break;
            const round = scanOverlord(quick);
            assessment.observe(round);
            const best = round.reads.find(r => !r.thin && !r.vetoed);
            leader = best ? { symbol: best.symbol, label: best.label, score: best.score } : null;
            flagged = round.reads.filter(r => !r.thin && r.vetoed).length;
            report();
        }
    } finally {
        stream.close();
    }
    if (cancelled) {
        return { scan: { reads: [], best: null, legacyOnly: false, evaluated: 0 }, ticks, rounds: assessment.rounds, liveTicks: ticks > 0, cancelled };
    }
    const final = scanOverlord({ ...opts, series: live });
    const liveDigits: Record<string, number[]> = {};
    for (const [symbol, n] of Object.entries(liveCount)) liveDigits[symbol] = live[symbol].digits.slice(-n);
    return { scan: assessment.finalize(final, liveDigits), ticks, rounds: assessment.rounds, liveTicks: ticks > 0, cancelled };
}
