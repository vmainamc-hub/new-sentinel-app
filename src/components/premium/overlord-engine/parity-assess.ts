// OVERLORD EVEN / ODD ASSESSMENT. Find Market does not answer the instant the history arrives, and for Even / Odd it must not:
// Precision Parity is a live tool. Its persistence, maturity and adaptive weights are built from consecutive scans of ticks
// that keep arriving, so it is run the way it is run on its own page: after the deep history is in, the markets are watched
// LIVE for a few seconds and the whole tool is run again every refresh (its own refresh rate) on the history plus the ticks
// that arrived meanwhile.
//
// Nothing here changes what Parity says. A market can only be picked if Parity says READY on the final scan. The rounds
// are used for one thing: how often each market was READY for its parity. A READY market that held in at least
// PARITY_STEADY_SHARE of the rounds stays STRONG; one that flickered is shown as BEST and ranks behind the steady ones.
//
// Honest limit: this watches for parity structures that hold while they are observed. It cannot predict the next tick.
import { fallbackDecimals, lastDigit } from './legacy';
import {
    compareParity,
    DEFAULT_PARITY_SETTINGS,
    type ParityInput,
    pickFromReads,
    type ParityScan,
    type ParitySeries,
    type ParitySide,
    scanParity,
} from './parity-engine';

/** How long a market is watched before the verdict. The same as Over / Under. */
export const PARITY_ASSESS_MS = 15_000;
/** A READY market must have been READY in at least this share of the rounds to stay STRONG. */
export const PARITY_STEADY_SHARE = 0.6;
/** How many of the best READY markets each round count as "among the leaders". */
const LEADERS = 3;
/** Parity's own window; more would be cut anyway. */
const MAX_TICKS = 5000;

const keyOf = (r: { symbol: string; side: ParitySide }) => `${r.symbol}:${r.side}`;

export class ParityAssessment {
    private n = 0;
    private ready = new Map<string, number>();
    private top = new Map<string, number>();
    private readonly chosen: ParitySide | null;

    constructor(chosen: ParitySide | null) {
        this.chosen = chosen;
    }

    get rounds(): number {
        return this.n;
    }

    /** One round's scan. */
    observe(scan: ParityScan): void {
        if (scan.legacyOnly) return;
        this.n += 1;
        const matching = scan.reads.filter(r => !r.thin && r.ready && (this.chosen === null || r.side === this.chosen));
        for (const r of matching) this.ready.set(keyOf(r), (this.ready.get(keyOf(r)) ?? 0) + 1);
        for (const r of matching.slice(0, LEADERS)) this.top.set(keyOf(r), (this.top.get(keyOf(r)) ?? 0) + 1);
    }

    /** Share of the rounds in which the market was READY for its parity, and in which it was among the leaders. */
    share(r: { symbol: string; side: ParitySide }): { clear: number; top: number } {
        if (this.n === 0) return { clear: 1, top: 0 };
        return { clear: (this.ready.get(keyOf(r)) ?? 0) / this.n, top: (this.top.get(keyOf(r)) ?? 0) / this.n };
    }

    /** Re-ranks the final scan with what was seen during the assessment. Unchanged when fewer than two rounds were seen. */
    finalize(scan: ParityScan): ParityScan {
        if (scan.legacyOnly || this.n < 2) return scan;
        const reads = scan.reads.map(r => {
            // Only READY markets carry a tier from the rounds; Parity's other states are left exactly as Parity gave them.
            if (r.thin || !r.ready) return r;
            const s = this.share(r);
            const tier = s.clear >= PARITY_STEADY_SHARE ? ('STRONG' as const) : ('BEST' as const);
            return { ...r, tier, steady: { rounds: this.n, clearShare: s.clear, topShare: s.top } };
        });
        reads.sort(compareParity);
        return { reads, ...pickFromReads(reads, this.chosen) };
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Live ticks
// ---------------------------------------------------------------------------------------------------------------------

export type LiveParitySeries = { prices: number[]; digits: number[]; decimals?: number };

/** Pure: appends one live tick to a series, keeping at most MAX_TICKS. Returns false when the tick is not a usable quote. */
export const appendLiveTick = (series: LiveParitySeries, symbol: string, quote: unknown, pip?: unknown): boolean => {
    const price = Number(quote);
    if (!Number.isFinite(price)) return false;
    const p = Number(pip);
    const decimals = series.decimals ?? (Number.isInteger(p) && p >= 0 && p <= 8 ? p : fallbackDecimals(symbol));
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

export type ParityAssessProgress = {
    elapsedMs: number;
    assessMs: number;
    /** Live ticks received so far, across all markets. */
    ticks: number;
    rounds: number;
    /** The current leader (the best READY market for the parity), or null before the first round or when none is READY. */
    leader: { symbol: string; label: string; score: number } | null;
    /** Markets Parity vetoed in the latest round. */
    flagged: number;
};

export type ParityAssessOptions = Omit<ParityInput, 'series'> & {
    series: Record<string, ParitySeries>;
    url: string;
    assessMs?: number;
    roundMs?: number;
    cancelled?: () => boolean;
    onProgress?: (p: ParityAssessProgress) => void;
    /** Injected for tests. */
    createSocket?: (url: string) => SocketLike;
    wait?: (ms: number) => Promise<void>;
};

export type ParityAssessed = {
    scan: ParityScan;
    ticks: number;
    rounds: number;
    liveTicks: boolean;
    cancelled: boolean;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function assessParity(opts: ParityAssessOptions): Promise<ParityAssessed> {
    const settings = opts.settings ?? DEFAULT_PARITY_SETTINGS;
    const assessMs = opts.assessMs ?? PARITY_ASSESS_MS;
    // Parity's own refresh rate, with the same floor its page uses.
    const roundMs = Math.max(50, opts.roundMs ?? Math.max(500, settings.refreshMs));
    const wait = opts.wait ?? sleep;
    // The scan works on copies: live ticks are appended to these, the history passed in is left alone.
    const live: Record<string, LiveParitySeries> = {};
    for (const [symbol, s] of Object.entries(opts.series))
        live[symbol] = { prices: [...s.prices], digits: [...s.digits], decimals: s.decimals };
    let ticks = 0;
    const stream = openTickStream(
        opts.url,
        opts.symbols,
        (symbol, quote, pip) => {
            const s = live[symbol];
            if (s && appendLiveTick(s, symbol, quote, pip)) ticks += 1;
        },
        opts.createSocket
    );

    const assessment = new ParityAssessment(opts.side);
    const input = (): ParityInput => ({
        series: live,
        symbols: opts.symbols,
        side: opts.side,
        names: opts.names,
        settings: opts.settings,
    });
    const started = Date.now();
    let cancelled = false;
    let leader: ParityAssessProgress['leader'] = null;
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
            const round = scanParity(input());
            assessment.observe(round);
            const best = round.best && round.best.ready ? round.best : null;
            leader = best ? { symbol: best.symbol, label: best.label, score: best.score } : null;
            flagged = round.reads.filter(r => !r.thin && r.vetoed).length;
            report();
        }
    } finally {
        stream.close();
    }
    if (cancelled) {
        return {
            scan: { reads: [], best: null, watch: null, opposite: null, legacyOnly: false, evaluated: 0 },
            ticks,
            rounds: assessment.rounds,
            liveTicks: ticks > 0,
            cancelled,
        };
    }
    const final = scanParity(input());
    return { scan: assessment.finalize(final), ticks, rounds: assessment.rounds, liveTicks: ticks > 0, cancelled };
}
