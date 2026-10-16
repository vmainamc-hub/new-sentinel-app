// Sixfold feed: reads the last ticks of the markets over Deriv's public WebSocket (read-only, no login, no trading),
// or serves demo digits / pasted digits. It never places a trade.
import { useCallback, useEffect, useRef, useState } from 'react';
import { DERIV_WS_URL } from '@/lib/deriv-ws';
import { digitFromQuote, parseDigitsText } from './engine';
import { mulberry32 } from './stats';

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

export type FeedMode = 'live' | 'demo' | 'import';
export type FeedStatus = 'offline' | 'connecting' | 'live' | 'error';
export type Series = Record<string, number[]>;

export function demoSeries(markets: readonly string[], n = 1500, seed = 11): Series {
    const out: Series = {};
    markets.forEach((market, k) => {
        const rand = mulberry32(seed + k * 101);
        out[market] = Array.from({ length: n }, () => Math.floor(rand() * 10));
    });
    return out;
}

const SYMBOLS = MARKETS.map(m => m[0]);

export function useFeed() {
    const [mode, setMode] = useState<FeedMode>('demo');
    const [status, setStatus] = useState<FeedStatus>('offline');
    const [error, setError] = useState('');
    const [series, setSeries] = useState<Series>(() => demoSeries(SYMBOLS));
    const socket = useRef<WebSocket | null>(null);
    const decimals = useRef<Record<string, number>>({});
    const generation = useRef(0);

    const stop = useCallback(() => {
        generation.current += 1;
        if (socket.current) {
            try {
                socket.current.close();
            } catch {
                /* already closed */
            }
            socket.current = null;
        }
        setStatus('offline');
    }, []);

    const connect = useCallback(() => {
        stop();
        const mine = ++generation.current;
        setMode('live');
        setStatus('connecting');
        setError('');
        setSeries({});
        const urls = [DERIV_WS_URL, LEGACY_ENDPOINT];
        const attempt = (index: number) => {
            if (mine !== generation.current) return;
            if (index >= urls.length) {
                setStatus('error');
                setError('Could not reach Deriv. Check your connection, or use demo data.');
                return;
            }
            let opened = false;
            const ws = new WebSocket(urls[index]);
            socket.current = ws;
            ws.onopen = () => {
                opened = true;
                setStatus('live');
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
            ws.onmessage = event => {
                let msg: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
                try {
                    msg = JSON.parse(event.data);
                } catch {
                    return;
                }
                if (msg.error) {
                    setError(msg.error.message ?? 'Deriv returned an error.');
                    return;
                }
                if (msg.msg_type === 'history' && msg.history?.prices) {
                    const symbol: string | undefined = msg.echo_req?.ticks_history;
                    if (!symbol) return;
                    const prices: number[] = msg.history.prices.map(Number);
                    const places = pipDecimals(msg.pip_size) ?? inferDecimals(prices);
                    decimals.current[symbol] = places;
                    setSeries(s => ({ ...s, [symbol]: prices.map(q => digitFromQuote(q, places)).slice(-MAX_TICKS) }));
                }
                if (msg.msg_type === 'tick' && msg.tick?.symbol) {
                    const symbol: string = msg.tick.symbol;
                    const places = pipDecimals(msg.tick.pip_size) ?? decimals.current[symbol] ?? 2;
                    decimals.current[symbol] = places;
                    const digit = digitFromQuote(Number(msg.tick.quote), places);
                    setSeries(s => ({ ...s, [symbol]: [...(s[symbol] ?? []), digit].slice(-MAX_TICKS) }));
                }
            };
            ws.onerror = () => {
                if (!opened && mine === generation.current) {
                    try {
                        ws.close();
                    } catch {
                        /* ignore */
                    }
                    attempt(index + 1);
                }
            };
            ws.onclose = () => {
                if (mine === generation.current && opened) setStatus('offline');
            };
        };
        attempt(0);
    }, [stop]);

    const useDemo = useCallback(() => {
        stop();
        setMode('demo');
        setError('');
        setSeries(demoSeries(SYMBOLS));
    }, [stop]);

    const importDigits = useCallback(
        (market: string, text: string) => {
            try {
                const digits = parseDigitsText(text);
                stop();
                setError('');
                setSeries(s => ({ ...(mode === 'import' ? s : {}), [market]: digits.slice(-MAX_TICKS) }));
                setMode('import');
            } catch (e) {
                setError((e as Error).message);
            }
        },
        [stop, mode]
    );

    useEffect(
        () => () => {
            generation.current += 1;
            socket.current?.close();
        },
        []
    );
    return { mode, status, error, series, connect, stop, useDemo, importDigits };
}
