import { SixfoldFeed, marketName } from '@/components/premium/sixfold/feed';
import { discoverVolatilityMarkets, parseVolatilityMarkets } from '../discovery';

const sample = {
    active_symbols: [
        { underlying_symbol: 'R_100', display_name: 'Volatility 100 Index', exchange_is_open: 1, is_trading_suspended: 0 },
        { underlying_symbol: '1HZ150V', display_name: 'Volatility 150 (1s) Index', exchange_is_open: 1, is_trading_suspended: 0 },
        { underlying_symbol: 'R_10', display_name: 'Volatility 10 Index', exchange_is_open: 1, is_trading_suspended: 0 },
        { underlying_symbol: '1HZ10V', display_name: 'Volatility 10 (1s) Index', exchange_is_open: 1, is_trading_suspended: 0 },
        { underlying_symbol: 'CRASH500', display_name: 'Crash 500 Index', exchange_is_open: 1 },
        { underlying_symbol: 'JD10', display_name: 'Jump 10 Index', exchange_is_open: 1 },
        { underlying_symbol: 'R_75', display_name: 'Volatility 75 Index', exchange_is_open: 1, is_trading_suspended: 1 },
        { underlying_symbol: 'R_50', display_name: 'Volatility 50 Index', exchange_is_open: 0 },
    ],
};

const fakeSocket = (reply: (sent: any) => any) => {
    const ws: any = { sent: [] as string[], closed: false, onopen: null, onmessage: null, onerror: null, onclose: null };
    ws.send = (d: string) => {
        ws.sent.push(d);
        const r = reply(JSON.parse(d));
        if (r !== undefined) setTimeout(() => ws.onmessage?.({ data: JSON.stringify(r) }), 0);
    };
    ws.close = () => (ws.closed = true);
    setTimeout(() => ws.onopen?.(), 0);
    return ws;
};

describe('market discovery', () => {
    it('keeps only open, trading Volatility indices and sorts them', () => {
        expect(parseVolatilityMarkets(sample).map(m => m[0])).toEqual(['R_10', '1HZ10V', 'R_100', '1HZ150V']);
        expect(parseVolatilityMarkets(null)).toEqual([]);
        expect(parseVolatilityMarkets({ active_symbols: 'x' as any })).toEqual([]);
    });

    it('asks Deriv for active_symbols once and returns the parsed list', async () => {
        let ws: any;
        const found = await discoverVolatilityMarkets(() => (ws = fakeSocket(() => ({ msg_type: 'active_symbols', ...sample }))), 1000);
        expect(found.map(m => m[0])).toContain('1HZ150V');
        expect(JSON.parse(ws.sent[0])).toMatchObject({ active_symbols: 'brief' });
        expect(ws.closed).toBe(true);
    });

    it('returns [] on an API error, a timeout and a socket error, never rejecting', async () => {
        expect(await discoverVolatilityMarkets(() => fakeSocket(() => ({ msg_type: 'active_symbols', error: { message: 'no' } })), 1000)).toEqual([]);
        expect(await discoverVolatilityMarkets(() => fakeSocket(() => undefined), 30)).toEqual([]);
        expect(
            await discoverVolatilityMarkets(() => {
                throw new Error('blocked');
            }, 1000)
        ).toEqual([]);
    });
});

describe('feed.addMarkets', () => {
    const mk = () => {
        const sockets: any[] = [];
        const feed = new SixfoldFeed(url => {
            const ws: any = { sent: [] as string[], onopen: null, onmessage: null, onerror: null, onclose: null, send: (d: string) => ws.sent.push(d), close() {} };
            sockets.push(ws);
            return ws;
        });
        return { feed, sockets };
    };

    it('subscribes a new market on the same live socket, once, and tracks its ticks', () => {
        const { feed, sockets } = mk();
        const ticks: Array<[string, number]> = [];
        feed.onTick((s, d) => ticks.push([s, d]));
        feed.connect();
        sockets[0].onopen();
        const before = sockets[0].sent.length;
        expect(feed.addMarkets([['1HZ150V', 'Volatility 150 (1s) Index'], ['R_10', 'dup']])).toEqual(['1HZ150V']);
        expect(sockets[0].sent).toHaveLength(before + 1);
        expect(JSON.parse(sockets[0].sent[before])).toMatchObject({ ticks_history: '1HZ150V', subscribe: 1 });
        expect(feed.addMarkets([['1HZ150V', 'again']])).toEqual([]);
        expect(sockets).toHaveLength(1);
        sockets[0].onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: '1HZ150V', epoch: 100, quote: 1234.56, pip_size: 2 } }) });
        expect(ticks).toEqual([['1HZ150V', 6]]);
        expect(marketName('1HZ150V')).toBe('Volatility 150 (1s)'); // already named upstream
        feed.addMarkets([['R_999', 'Volatility 999 Index']]);
        expect(marketName('R_999')).toBe('Volatility 999 Index');
        expect(feed.getSymbols()).toContain('1HZ150V');
    });

    it('markets added before connecting are subscribed on open; unknown symbols are still ignored', () => {
        const { feed, sockets } = mk();
        feed.addMarkets([['R_150', 'V150']]);
        feed.connect();
        sockets[0].onopen();
        expect(sockets[0].sent.map((s: string) => JSON.parse(s).ticks_history)).toContain('R_150');
        sockets[0].onmessage({ data: JSON.stringify({ msg_type: 'tick', tick: { symbol: 'WAT', epoch: 1, quote: 1.11, pip_size: 2 } }) });
        expect(feed.getTelemetry().every(t => t.symbol !== 'WAT')).toBe(true);
    });
});
