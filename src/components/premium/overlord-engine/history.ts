// Deep tick history for the Overlord engine. One socket, one request per market (matched by req_id), a timeout per market and
// a retry for the markets that did not answer. Digits are taken at the precision Deriv reports for the market (pip_size),
// falling back to the precision Overlord has always assumed, so a trailing zero is never lost.
import type { MarketSeries } from './engine';
import { fallbackDecimals, lastDigit } from './legacy';

/** Deriv's maximum for one ticks_history request. */
export const HISTORY_TICKS = 5000;

export type HistoryStatus = 'success' | 'timeout' | 'error';
export type HistoryResult = { symbol: string; status: HistoryStatus; series: MarketSeries | null };

export type HistoryOptions = {
    count?: number;
    timeoutMs?: number;
    attempts?: number;
    /** Called as each market finishes, so the screen can show progress. */
    onResult?: (result: HistoryResult) => void;
    /** Return true to abandon the fetch (the user pressed stop, or a newer scan started). */
    cancelled?: () => boolean;
    /** Injected for tests. */
    createSocket?: (url: string) => WebSocket;
};

/** Pure: turns a ticks_history response into a series. Null when the response carries no prices. */
export const seriesFromHistory = (
    symbol: string,
    data: { history?: { prices?: unknown }; pip_size?: unknown }
): MarketSeries | null => {
    const raw = data.history?.prices;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const prices = raw.map(Number).filter(Number.isFinite);
    if (prices.length === 0) return null;
    const pip = Number(data.pip_size);
    const decimals = Number.isInteger(pip) && pip >= 0 && pip <= 8 ? pip : fallbackDecimals(symbol);
    return { prices, digits: prices.map(p => lastDigit(p, decimals)), decimals };
};

const fetchRound = (
    url: string,
    symbols: readonly string[],
    opts: Required<Pick<HistoryOptions, 'count' | 'timeoutMs'>> & HistoryOptions
) =>
    new Promise<HistoryResult[]>(resolve => {
        const create = opts.createSocket ?? ((u: string) => new WebSocket(u));
        const ws = create(url);
        const byReq = new Map<number, string>();
        const done = new Map<string, HistoryResult>();
        let finished = false;

        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            clearInterval(watch);
            try {
                ws.close();
            } catch {
                /* already closed */
            }
            resolve(symbols.map(s => done.get(s) ?? { symbol: s, status: 'timeout' as const, series: null }));
        };
        const settle = (r: HistoryResult) => {
            if (done.has(r.symbol)) return;
            done.set(r.symbol, r);
            opts.onResult?.(r);
            if (done.size === symbols.length) finish();
        };

        const timer = setTimeout(finish, opts.timeoutMs);
        const watch = setInterval(() => {
            if (opts.cancelled?.()) finish();
        }, 200);

        ws.onopen = () => {
            symbols.forEach((symbol, i) => {
                const req_id = i + 1;
                byReq.set(req_id, symbol);
                ws.send(
                    JSON.stringify({ ticks_history: symbol, style: 'ticks', count: opts.count, end: 'latest', req_id })
                );
            });
        };
        ws.onmessage = msg => {
            let data: { req_id?: number; error?: unknown; history?: { prices?: unknown }; pip_size?: unknown };
            try {
                data = JSON.parse(String(msg.data));
            } catch {
                return;
            }
            const symbol = data.req_id !== undefined ? byReq.get(data.req_id) : undefined;
            if (!symbol) return;
            if (data.error) return settle({ symbol, status: 'error', series: null });
            const series = seriesFromHistory(symbol, data);
            settle(series ? { symbol, status: 'success', series } : { symbol, status: 'error', series: null });
        };
        ws.onerror = finish;
        ws.onclose = finish;
    });

/** Fetches every market, retrying the ones that failed. Never throws; missing markets come back with their status. */
export async function fetchHistories(
    url: string,
    symbols: readonly string[],
    options: HistoryOptions = {}
): Promise<HistoryResult[]> {
    const count = options.count ?? HISTORY_TICKS;
    const timeoutMs = options.timeoutMs ?? 15000;
    const attempts = Math.max(1, options.attempts ?? 3);
    const final = new Map<string, HistoryResult>();
    let pending = [...symbols];
    for (let attempt = 1; attempt <= attempts && pending.length > 0; attempt += 1) {
        if (options.cancelled?.()) break;
        const round = await fetchRound(url, pending, { ...options, count, timeoutMs });
        for (const r of round) if (r.status === 'success' || !final.has(r.symbol)) final.set(r.symbol, r);
        pending = round.filter(r => r.status !== 'success').map(r => r.symbol);
    }
    return symbols.map(s => final.get(s) ?? { symbol: s, status: 'timeout' as const, series: null });
}
