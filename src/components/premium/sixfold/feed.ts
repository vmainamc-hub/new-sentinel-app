// Sixfold feed: reads the last ticks of the markets over Deriv's public WebSocket (read-only, no login, no trading),
// or serves digits you paste in. There is no demo or simulated data. It never places a trade. One app-wide instance (`sixfoldFeed`) feeds both the
// page and the Auto runner, so scanning continues on any tab.
import { DERIV_WS_URL } from '@/lib/deriv-ws';
import { digitFromQuote, parseDigitsText } from './engine';

export const MARKETS: ReadonlyArray<readonly [string, string]> = [
    ['1HZ10V', 'Volatility 10 (1s)'],
    ['1HZ25V', 'Volatility 25 (1s)'],
    ['1HZ50V', 'Volatility 50 (1s)'],
    ['1HZ75V', 'Volatility 75 (1s)'],
    ['1HZ100V', 'Volatility 100 (1s)'],
    ['R_10', 'Volatility 10'],
    ['R_25', 'Volatility 25'],
    ['R_50', 'Volatility 50'],
    ['R_75', 'Volatility 75'],
    ['R_100', 'Volatility 100'],
];
export const marketName = (symbol: string) => MARKETS.find(m => m[0] === symbol)?.[1] ?? symbol;

export const MAX_TICKS = 2000;

/** Seconds between ticks that Deriv documents for a market: 1 for the 1s indices, 2 for the plain volatility indices. */
export const expectedTickSeconds = (symbol: string): number => (symbol.startsWith('1HZ') ? 1 : 2);

export type FeedTelemetry = {
    symbol: string;
    expected: number;
    /** Median seconds between the last ticks, read from Deriv's own tick clock (null until 3 ticks). */
    measured: number | null;
    /** Ticks that arrived in the last 60 seconds. */
    lastMinute: number;
    /** Seconds since the last tick arrived. */
    ageSeconds: number | null;
    /** Live ticks accepted since connecting. */
    accepted: number;
    /** Ticks dropped because their Deriv timestamp was not newer than the last one (a repeat or out-of-order delivery). */
    dropped: number;
    /** Ticks for a market that is not one of the ten Sixfold tracks. */
    foreign: number;
};

const TELEMETRY_KEEP = 40;
type Tel = { epochs: number[]; arrivals: number[]; accepted: number; dropped: number };
export const LEGACY_ENDPOINT = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

/** Deriv reports either a decimal count (2) or a pip value (0.01). Returns decimals, or null if unusable. */
export function pipDecimals(value: unknown): number | null {
    const x = Number(value);
    if (!Number.isFinite(x) || x <= 0) return null;
    if (x >= 1) return Math.min(10, Math.trunc(x));
    return Math.min(10, Math.round(-Math.log10(x)));
}

/** Fallback when no pip size arrives: the most decimals any quote in the batch uses. */
export function inferDecimals(quotes: number[]): number {
    let most = 0;
    for (const quote of quotes) {
        const text = String(quote);
        const dot = text.indexOf('.');
        if (dot >= 0) most = Math.max(most, text.length - dot - 1);
    }
    return Math.min(10, most);
}

export type FeedMode = 'live' | 'import';
export type FeedStatus = 'offline' | 'connecting' | 'live' | 'error';
export type Series = Record<string, number[]>;
export type FeedSnapshot = { mode: FeedMode; status: FeedStatus; error: string; series: Series; version: number };

export const SYMBOLS = MARKETS.map(m => m[0]);

/** Short label for the radar and the heat grid: "V10", "V25 1s" ... */
export const shortName = (symbol: string): string => {
    const m = /^(?:1HZ|R_)?(\d+)V?$/.exec(symbol);
    const n = m?.[1] ?? symbol;
    return symbol.startsWith('1HZ') ? `V${n}·1s` : `V${n}`;
};

const PUBLISH_MS = 400;
const STALE_MS = 15_000;
const WATCHDOG_MS = 5_000;

type SocketLike = {
    send: (data: string) => void;
    close: () => void;
    onopen: ((ev?: unknown) => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: ((ev?: unknown) => void) | null;
    onclose: ((ev?: unknown) => void) | null;
};

export class SixfoldFeed {
    private mode: FeedMode = 'live';
    private status: FeedStatus = 'offline';
    private error = '';
    private buf: Series = {};
    private dirty = new Set<string>();
    private decimals: Record<string, number> = {};
    private lastTick: Record<string, number> = {};
    private tel: Record<string, Tel> = {};
    private foreign = 0;
    private socket: SocketLike | null = null;
    private generation = 0;
    private attempts = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private watchdog: ReturnType<typeof setInterval> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private listeners = new Set<() => void>();
    private tickListeners = new Set<(symbol: string, digit: number) => void>();
    private snap: FeedSnapshot;

    constructor(
        private makeSocket: (url: string) => SocketLike = url => new WebSocket(url) as unknown as SocketLike,
        private now: () => number = () => Date.now()
    ) {
        this.snap = { mode: this.mode, status: this.status, error: '', series: this.copyAll(), version: 0 };
    }

    // ---- reading ----
    getSnapshot = (): FeedSnapshot => this.snap;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    /** The live arrays, for synchronous read-only use (scans). Never keep or mutate them. */
    getLiveSeries = (): Series => this.buf;
    getLastDigit = (symbol: string): number | null => this.buf[symbol]?.at(-1) ?? null;
    getLastTickAt = (symbol: string): number | null => this.lastTick[symbol] ?? null;
    /** How each market's ticks are actually arriving: measured rate against Deriv's documented rate. */
    getTelemetry = (): FeedTelemetry[] => {
        const now = this.now();
        return SYMBOLS.map(symbol => {
            const t = this.tel[symbol];
            const gaps: number[] = [];
            if (t) for (let i = 1; i < t.epochs.length; i++) gaps.push(t.epochs[i] - t.epochs[i - 1]);
            const sorted = gaps.slice().sort((a, b) => a - b);
            const measured = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : null;
            const last = this.lastTick[symbol];
            return {
                symbol,
                expected: expectedTickSeconds(symbol),
                measured,
                lastMinute: t ? t.arrivals.filter(a => now - a <= 60_000).length : 0,
                ageSeconds: last === undefined ? null : Math.max(0, (now - last) / 1000),
                accepted: t?.accepted ?? 0,
                dropped: t?.dropped ?? 0,
                foreign: this.foreign,
            };
        });
    };
    isLive = () => this.mode === 'live' && this.status === 'live';
    getMode = () => this.mode;
    getStatus = () => this.status;
    onTick = (cb: (symbol: string, digit: number) => void) => {
        this.tickListeners.add(cb);
        return () => {
            this.tickListeners.delete(cb);
        };
    };

    // ---- controls ----
    stop = () => {
        this.generation += 1;
        this.clearTimers();
        this.closeSocket();
        this.setStatus('offline');
    };

    connect = () => {
        this.stop();
        const mine = this.generation;
        this.mode = 'live';
        this.error = '';
        this.tel = {};
        this.foreign = 0;
        this.replaceAll({});
        this.attempts = 0;
        this.setStatus('connecting');
        this.publish();
        this.watchdog = setInterval(() => this.checkStale(mine), WATCHDOG_MS);
        this.attempt(mine, 0);
    };

    importDigits = (market: string, text: string) => {
        try {
            const digits = parseDigitsText(text);
            const keep = this.mode === 'import' ? this.buf : {};
            this.stop();
            this.error = '';
            this.replaceAll({ ...keep, [market]: digits.slice(-MAX_TICKS) });
            this.mode = 'import';
            this.publish();
        } catch (e) {
            this.error = (e as Error).message;
            this.publish();
        }
    };

    // ---- internals ----
    private copyAll(): Series {
        const out: Series = {};
        for (const k of Object.keys(this.buf)) out[k] = this.buf[k].slice();
        return out;
    }

    private publish() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        // Reuse the previously published array for any market that did not change, so React memo checks stay cheap.
        const series: Series = {};
        for (const k of Object.keys(this.buf)) {
            const before = this.snap.series[k];
            series[k] = this.dirty.has(k) || !before ? this.buf[k].slice() : before;
        }
        this.dirty.clear();
        this.snap = { mode: this.mode, status: this.status, error: this.error, series, version: this.snap.version + 1 };
        this.listeners.forEach(l => l());
    }

    private replaceAll(next: Series) {
        this.buf = next;
        this.dirty = new Set(Object.keys(next));
    }

    private schedulePublish() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.publish();
        }, PUBLISH_MS);
    }

    private setStatus(status: FeedStatus) {
        this.status = status;
        this.publish();
    }

    private clearTimers() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.watchdog) clearInterval(this.watchdog);
        this.reconnectTimer = null;
        this.watchdog = null;
    }

    private closeSocket() {
        const ws = this.socket;
        this.socket = null;
        if (!ws) return;
        ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
        try {
            ws.close();
        } catch {
            /* already closed */
        }
    }

    /** No tick on any market for a long time: the stream is dead even though the socket looks open. Reconnect. */
    private checkStale(mine: number) {
        if (mine !== this.generation || this.mode !== 'live' || this.status !== 'live') return;
        const newest = Math.max(0, ...Object.values(this.lastTick));
        if (newest && this.now() - newest > STALE_MS) this.reconnect(mine, 'Market feed went quiet. Reconnecting.');
    }

    private reconnect(mine: number, why: string) {
        if (mine !== this.generation || this.mode !== 'live') return;
        this.closeSocket();
        this.error = why;
        this.attempts += 1;
        this.setStatus('connecting');
        const delay = Math.min(15_000, 1_000 * 2 ** Math.min(4, this.attempts));
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.attempt(mine, 0), delay);
    }

    private attempt(mine: number, index: number) {
        if (mine !== this.generation) return;
        const urls = [DERIV_WS_URL, LEGACY_ENDPOINT];
        if (index >= urls.length) {
            if (Object.keys(this.buf).length) return this.reconnect(mine, 'Lost the market feed. Reconnecting.');
            this.error = 'Could not reach Deriv. Check your connection and try again.';
            this.setStatus('error');
            return;
        }
        let opened = false;
        const ws = this.makeSocket(urls[index]);
        this.socket = ws;
        ws.onopen = () => {
            opened = true;
            this.attempts = 0;
            this.error = '';
            this.setStatus('live');
            SYMBOLS.forEach((symbol, i) =>
                ws.send(
                    JSON.stringify({
                        ticks_history: symbol,
                        end: 'latest',
                        count: MAX_TICKS,
                        style: 'ticks',
                        subscribe: 1,
                        req_id: i + 1,
                    })
                )
            );
        };
        ws.onmessage = event => this.onMessage(mine, event.data);
        ws.onerror = () => {
            if (!opened && mine === this.generation) {
                this.closeSocket();
                this.attempt(mine, index + 1);
            }
        };
        ws.onclose = () => {
            if (mine === this.generation && opened) this.reconnect(mine, 'Market feed closed. Reconnecting.');
        };
    }

    private onMessage(mine: number, raw: string) {
        if (mine !== this.generation) return;
        let msg: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (msg.error) {
            this.error = msg.error.message ?? 'Deriv returned an error.';
            this.publish();
            return;
        }
        if (msg.msg_type === 'history' && msg.history?.prices) {
            const symbol: string | undefined = msg.echo_req?.ticks_history;
            if (!symbol || !SYMBOLS.includes(symbol)) return;
            const prices: number[] = msg.history.prices.map(Number);
            const places = pipDecimals(msg.pip_size) ?? inferDecimals(prices);
            this.decimals[symbol] = places;
            this.buf[symbol] = prices.map(q => digitFromQuote(q, places)).slice(-MAX_TICKS);
            // Deriv's own tick times: they show the market's real rate straight away and let repeats be recognised.
            const times: number[] = Array.isArray(msg.history.times) ? msg.history.times.map(Number).filter(Number.isFinite) : [];
            this.tel[symbol] = { epochs: times.slice(-TELEMETRY_KEEP), arrivals: [], accepted: 0, dropped: 0 };
            this.lastTick[symbol] = this.now();
            this.dirty.add(symbol);
            this.schedulePublish();
        }
        if (msg.msg_type === 'tick' && msg.tick?.symbol) {
            const symbol: string = msg.tick.symbol;
            // Each tick belongs to exactly the market it names. Anything else is ignored rather than guessed at.
            if (!SYMBOLS.includes(symbol)) {
                this.foreign += 1;
                return;
            }
            const t = (this.tel[symbol] ??= { epochs: [], arrivals: [], accepted: 0, dropped: 0 });
            const epoch = Number(msg.tick.epoch);
            const lastEpoch = t.epochs.at(-1);
            if (Number.isFinite(epoch) && lastEpoch !== undefined && epoch <= lastEpoch) {
                t.dropped += 1; // a repeat or out-of-order delivery: never counted as a new tick
                return;
            }
            if (Number.isFinite(epoch)) {
                t.epochs.push(epoch);
                if (t.epochs.length > TELEMETRY_KEEP) t.epochs.splice(0, t.epochs.length - TELEMETRY_KEEP);
            }
            t.arrivals.push(this.now());
            if (t.arrivals.length > 150) t.arrivals.splice(0, t.arrivals.length - 150);
            t.accepted += 1;
            const places = pipDecimals(msg.tick.pip_size) ?? this.decimals[symbol] ?? 2;
            this.decimals[symbol] = places;
            const digit = digitFromQuote(Number(msg.tick.quote), places);
            const arr = (this.buf[symbol] ??= []);
            arr.push(digit);
            if (arr.length > MAX_TICKS + 100) arr.splice(0, arr.length - MAX_TICKS);
            this.lastTick[symbol] = this.now();
            this.dirty.add(symbol);
            this.schedulePublish();
            this.tickListeners.forEach(cb => {
                try {
                    cb(symbol, digit);
                } catch {
                    /* a failing listener must not break the feed */
                }
            });
        }
    }
}

/** The one app-wide feed. */
export const sixfoldFeed = new SixfoldFeed();
