// Rise / Fall assessment run. One socket asks for the last 1-minute candles of every market and stays subscribed, so the
// candle that is still forming keeps updating with the live ticks. The candles are read at once, then every few seconds
// while they are watched, and the market that holds its side and agreement through the watch is the one presented.
import { type Candle, type Direction, RiseFallAssessment, type RiseFallScan, scanRiseFall, MIN_CANDLES } from './rise-fall';

export const RF_CANDLES = 200;
export const RF_GRANULARITY = 60;
export const RF_ASSESS_MS = 15_000;
export const RF_ROUND_MS = 3_000;

type SocketLike = Pick<WebSocket, 'send' | 'close'> & {
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onclose?: ((ev: unknown) => void) | null;
};

export type RiseFallProgress = {
    elapsedMs: number;
    assessMs: number;
    loaded: number;
    total: number;
    rounds: number;
    leader: { symbol: string; label: string; agree: number } | null;
};

export type RiseFallOptions = {
    symbols: readonly string[];
    url: string;
    side?: Direction | null;
    names?: Record<string, string>;
    assessMs?: number;
    roundMs?: number;
    cancelled?: () => boolean;
    onProgress?: (p: RiseFallProgress) => void;
    createSocket?: (url: string) => SocketLike;
    wait?: (ms: number) => Promise<void>;
};

export type RiseFallAssessed = { scan: RiseFallScan; rounds: number; loaded: number; cancelled: boolean };

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const toCandle = (c: Record<string, unknown>, time: unknown): Candle | null => {
    const out = { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), time: Number(time) };
    return Object.values(out).every(Number.isFinite) ? out : null;
};

/** Pure: applies one live ohlc update to a market's candles (replaces the forming candle or starts the next one). */
export const applyOhlc = (candles: Candle[], ohlc: Record<string, unknown>): void => {
    const c = toCandle(ohlc, ohlc.open_time);
    if (!c) return;
    const lastCandle = candles[candles.length - 1];
    if (lastCandle && lastCandle.time === c.time) candles[candles.length - 1] = c;
    else if (!lastCandle || c.time > lastCandle.time) candles.push(c);
    if (candles.length > RF_CANDLES + 5) candles.shift();
};

export async function assessRiseFall(opts: RiseFallOptions): Promise<RiseFallAssessed> {
    const assessMs = opts.assessMs ?? RF_ASSESS_MS;
    const roundMs = Math.max(50, opts.roundMs ?? RF_ROUND_MS);
    const wait = opts.wait ?? sleep;
    const candles: Record<string, Candle[]> = {};
    const byReq = new Map<number, string>();
    let ws: SocketLike | null = null;
    try {
        ws = opts.createSocket ? opts.createSocket(opts.url) : (new WebSocket(opts.url) as unknown as SocketLike);
    } catch {
        ws = null;
    }
    if (ws) {
        ws.onopen = () => {
            opts.symbols.forEach((symbol, i) => {
                byReq.set(i + 1, symbol);
                ws?.send(
                    JSON.stringify({
                        ticks_history: symbol,
                        style: 'candles',
                        granularity: RF_GRANULARITY,
                        count: RF_CANDLES,
                        end: 'latest',
                        subscribe: 1,
                        req_id: i + 1,
                    })
                );
            });
        };
        ws.onmessage = ev => {
            let msg: { req_id?: number; candles?: Record<string, unknown>[]; ohlc?: Record<string, unknown> };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (Array.isArray(msg.candles) && msg.req_id !== undefined) {
                const symbol = byReq.get(msg.req_id);
                if (!symbol) return;
                candles[symbol] = msg.candles
                    .map(c => toCandle(c, c.epoch))
                    .filter((c): c is Candle => c !== null);
            } else if (msg.ohlc && typeof msg.ohlc.symbol === 'string') {
                const list = candles[msg.ohlc.symbol];
                if (list) applyOhlc(list, msg.ohlc);
            }
        };
    }

    const assessment = new RiseFallAssessment();
    const started = Date.now();
    let cancelled = false;
    let leader: RiseFallProgress['leader'] = null;
    const loaded = () => Object.values(candles).filter(c => c.length >= MIN_CANDLES).length;
    const read = () => scanRiseFall({ candles, names: opts.names, side: opts.side ?? null });
    const report = () =>
        opts.onProgress?.({
            elapsedMs: Math.min(assessMs, Date.now() - started),
            assessMs,
            loaded: loaded(),
            total: opts.symbols.length,
            rounds: assessment.rounds,
            leader,
        });
    try {
        report();
        while (Date.now() - started < assessMs) {
            const next = Date.now() + roundMs;
            while (Date.now() < next && Date.now() - started < assessMs) {
                await wait(Math.min(250, Math.max(10, next - Date.now())));
                if (opts.cancelled?.()) {
                    cancelled = true;
                    break;
                }
                report();
            }
            if (cancelled) break;
            // Nothing loaded after a third of the window: the connection is not delivering, so stop waiting.
            if (loaded() === 0 && Date.now() - started >= assessMs / 3) break;
            const round = read();
            assessment.observe(round);
            const best = round.best;
            leader = best ? { symbol: best.symbol, label: best.label, agree: best.agree } : null;
            report();
        }
    } finally {
        try {
            ws?.close();
        } catch {
            /* already closed */
        }
    }
    if (cancelled) return { scan: { reads: [], best: null, evaluated: 0 }, rounds: assessment.rounds, loaded: loaded(), cancelled };
    return { scan: assessment.finalize(read()), rounds: assessment.rounds, loaded: loaded(), cancelled };
}
