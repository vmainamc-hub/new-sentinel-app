// APEX INTEL market discovery: ask Deriv which Volatility indices exist instead of trusting a fixed list.
// One short request on the public endpoint (active_symbols). Anything that goes wrong returns an empty list and the
// caller keeps Sixfold's fixed ten markets, so discovery can only ADD markets, never remove one.
import { DERIV_WS_URL } from '@/lib/deriv-ws';

export type MarketPair = readonly [string, string];

/** Volatility Indices only: R_10..R_100 and the 1-second 1HZ..V family. Crash/Boom, Jump, Step etc. are not Volatility. */
export const VOLATILITY_SYMBOL = /^(?:R_\d+|1HZ\d+V)$/;

type Raw = { symbol?: unknown; display_name?: unknown; underlying_symbol?: unknown; underlying_symbol_name?: unknown; exchange_is_open?: unknown; is_trading_suspended?: unknown };

/** Pure: keep open, trading Volatility indices, sorted by number then plain before 1-second. */
export function parseVolatilityMarkets(msg: { active_symbols?: Raw[] } | null | undefined): MarketPair[] {
    const list = Array.isArray(msg?.active_symbols) ? (msg as { active_symbols: Raw[] }).active_symbols : [];
    const out = new Map<string, string>();
    for (const r of list) {
        const symbol = String(r.underlying_symbol ?? r.symbol ?? '');
        if (!VOLATILITY_SYMBOL.test(symbol)) continue;
        if (r.is_trading_suspended === 1 || r.is_trading_suspended === true) continue;
        if (r.exchange_is_open === 0 || r.exchange_is_open === false) continue;
        out.set(symbol, String(r.display_name ?? r.underlying_symbol_name ?? symbol));
    }
    const num = (s: string) => Number(/\d+/.exec(s.replace('1HZ', ''))?.[0] ?? 0);
    return [...out].sort((a, b) => num(a[0]) - num(b[0]) || Number(a[0].startsWith('1HZ')) - Number(b[0].startsWith('1HZ')));
}

type SocketLike = {
    send: (data: string) => void;
    close: () => void;
    onopen: (() => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    onerror: (() => void) | null;
    onclose: (() => void) | null;
};

/** Resolves with the discovered markets, or [] after `timeoutMs` or on any error. Never rejects. */
export function discoverVolatilityMarkets(
    makeSocket: (url: string) => SocketLike = url => new WebSocket(url) as unknown as SocketLike,
    timeoutMs = 8000,
    url: string = DERIV_WS_URL
): Promise<MarketPair[]> {
    return new Promise(resolve => {
        let done = false;
        let ws: SocketLike | null = null;
        const finish = (v: MarketPair[]) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
                if (ws) {
                    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
                    ws.close();
                }
            } catch {
                /* already closed */
            }
            resolve(v);
        };
        const timer = setTimeout(() => finish([]), timeoutMs);
        try {
            ws = makeSocket(url);
            ws.onopen = () => ws?.send(JSON.stringify({ active_symbols: 'brief', req_id: 7001 }));
            ws.onmessage = ev => {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.msg_type === 'active_symbols' || msg.active_symbols) finish(msg.error ? [] : parseVolatilityMarkets(msg));
                    else if (msg.error) finish([]);
                } catch {
                    finish([]);
                }
            };
            ws.onerror = () => finish([]);
            ws.onclose = () => finish([]);
        } catch {
            finish([]);
        }
    });
}
