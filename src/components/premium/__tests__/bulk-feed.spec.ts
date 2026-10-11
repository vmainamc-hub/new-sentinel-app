import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { BulkFeed, LIVE_WITHIN_MS } from '../bulk-feed';
import { BULK_MARKETS } from '../over-under-engine';

const flush = async (ms = 30) => { await new Promise(resolve => setTimeout(resolve, ms)); };

const makeApi = (opts: { failSubscribeFor?: Set<string> } = {}) => {
    const listeners = new Set<(event: any) => void>();
    const streams = new Map<string, string>();
    const sent: any[] = [];
    let seq = 0;
    const api: any = {
        connection: { readyState: 1 },
        sent,
        onMessage: () => ({ subscribe: (fn: any) => { listeners.add(fn); return { unsubscribe: () => listeners.delete(fn) }; } }),
        send: async (payload: any) => {
            sent.push(payload);
            if (payload.ticks_history) {
                const prices = Array.from({ length: 1000 }, (_, i) => Number((1000 + ((i * 37) % 100) / 100 + (i % 10) / 1000).toFixed(2)));
                return { history: { prices, times: prices.map((_, i) => 1000 + i) } };
            }
            if (payload.ticks && payload.subscribe) {
                if (opts.failSubscribeFor?.has(payload.ticks)) { opts.failSubscribeFor.delete(payload.ticks); throw { error: { code: 'RateLimit', message: 'Too many requests' } }; }
                const id = `s${(seq += 1)}`;
                streams.set(payload.ticks, id);
                return { subscription: { id }, tick: { symbol: payload.ticks, quote: 1000.5, epoch: 5000, id } };
            }
            if (payload.forget) return { forget: 1 };
            return {};
        },
        push: (symbol: string, quote: number, epoch: number) =>
            listeners.forEach(fn => fn({ msg_type: 'tick', subscription: { id: streams.get(symbol) }, tick: { symbol, quote, epoch, pip_size: 2 } })),
    };
    return api;
};

describe('Bulk feed (app-level, survives navigation)', () => {
    let feed: BulkFeed | null = null;
    afterEach(() => { feed?.stop(); feed = null; });

    it('loads history and goes live for every market with no page attached', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        feed = new BulkFeed();
        feed.start();
        await flush(200);
        expect(Object.keys(feed.store).length).toBe(BULK_MARKETS.length);
        expect(feed.liveCount()).toBe(BULK_MARKETS.length);
    });

    it('keeps appending live ticks, ignores duplicates, and wakes anyone waiting for the next tick', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        feed = new BulkFeed();
        const symbol = BULK_MARKETS[0].symbol;
        const heard: string[] = [];
        feed.onTick(s => heard.push(s));
        feed.start();
        await flush(200);
        const before = feed.store[symbol].digits.length;
        let woke = false;
        void feed.nextTick(symbol).then(() => { woke = true; });
        api.push(symbol, 1234.57, 6000);
        api.push(symbol, 1234.57, 6000); // duplicate delivery of the same tick
        await flush(5);
        expect(woke).toBe(true);
        expect(feed.store[symbol].digits.length).toBe(Math.min(1000, before + 1));
        expect(feed.store[symbol].digits[feed.store[symbol].digits.length - 1]).toBe(7);
        expect(heard.filter(s => s === symbol).length > 0).toBe(true);
        expect(feed.digitAt(symbol, 6000)).toBe(7);
        expect(feed.digitAt(symbol, 6001)).toBeNull();
    });

    it('rebuilds a market\'s history after missed ticks (a gap)', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        feed = new BulkFeed();
        const symbol = BULK_MARKETS[1].symbol;
        feed.start();
        await flush(200);
        const loadsBefore = api.sent.filter((p: any) => p.ticks_history === symbol).length;
        api.push(symbol, 1000.11, 6000);
        api.push(symbol, 1000.22, 6120); // two minutes of silence in between
        await flush(30);
        expect(api.sent.filter((p: any) => p.ticks_history === symbol).length).toBe(loadsBefore + 1);
    });

    it('retries a market whose subscription failed, instead of leaving it dead', async () => {
        const failing = new Set([BULK_MARKETS[2].symbol]);
        const api = makeApi({ failSubscribeFor: failing });
        (api_base as any).api = api;
        feed = new BulkFeed();
        feed.start();
        await flush(200);
        expect(feed.liveCount()).toBe(BULK_MARKETS.length - 1);
        expect(feed.lastError).toMatch(/Too many requests/);

        (feed as any).superviseLoop(); // the supervisor runs on a timer; run one pass now
        await flush(100);
        expect(feed.liveCount()).toBe(BULK_MARKETS.length);
    });

    it('a market that stops ticking stops counting as live', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        feed = new BulkFeed();
        feed.start();
        await flush(200);
        expect(feed.liveCount()).toBe(BULK_MARKETS.length);
        expect(feed.liveCount(Date.now() + LIVE_WITHIN_MS + 1_000)).toBe(0);
    });

    it('the engine keeps stepping with nothing attached, and a listener failure cannot stop it', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        feed = new BulkFeed();
        feed.start();
        await flush(200);
        let steps = 0;
        const off = feed.onStep(() => { steps += 1; throw new Error('page listener blew up'); });
        feed.step();
        feed.step();
        expect(steps).toBe(2);
        off();
        feed.step(); // no listeners at all: still fine
        expect(steps).toBe(2);
        expect(Object.keys(feed.verdicts).length > 0).toBe(true);
    });
});

