import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { PremiumDerivApiService, TICK_STALE_MS } from '../premium-deriv-api.service';

type Listener = (event: any) => void;

/** A fake Deriv socket that behaves like the real one: ONE tick stream per symbol, duplicate subscribes are refused. */
const makeApi = () => {
    const listeners = new Set<Listener>();
    const streams = new Map<string, string>(); // symbol -> stream id
    const sent: any[] = [];
    let seq = 0;
    const api: any = {
        connection: { readyState: 1 },
        sent,
        streams,
        onMessage: () => ({ subscribe: (fn: Listener) => { listeners.add(fn); return { unsubscribe: () => listeners.delete(fn) }; } }),
        send: async (payload: any) => {
            sent.push(payload);
            if (payload.ticks && payload.subscribe) {
                if (streams.has(payload.ticks)) throw { error: { code: 'AlreadySubscribed', message: `You are already subscribed to ${payload.ticks}.` } };
                const id = `stream-${(seq += 1)}`;
                streams.set(payload.ticks, id);
                return { msg_type: 'tick', subscription: { id }, tick: { symbol: payload.ticks, quote: 100, epoch: 1, id } };
            }
            if (payload.forget) {
                for (const [symbol, id] of streams) if (id === payload.forget) streams.delete(symbol);
                return { forget: 1 };
            }
            return {};
        },
        push: (symbol: string, quote: number, epoch: number) => {
            const id = streams.get(symbol);
            if (!id) return; // a forgotten stream delivers nothing
            listeners.forEach(fn => fn({ msg_type: 'tick', subscription: { id }, tick: { symbol, quote, epoch, id } }));
        },
    };
    return api;
};

describe('shared tick hub', () => {
    it('opens ONE Deriv stream per market no matter how many listeners', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        const a: number[] = [];
        const b: number[] = [];
        const offA = await PremiumDerivApiService.subscribeTicks('R_100', t => a.push(t.quote));
        const offB = await PremiumDerivApiService.subscribeTicks('R_100', t => b.push(t.quote));
        expect(api.sent.filter((p: any) => p.ticks).length).toBe(1);
        api.push('R_100', 101, 2);
        expect(a.join(',')).toBe('100,101');
        expect(b.join(',')).toBe('100,101'); // the late joiner is handed the latest tick immediately
        offA();
        offB();
    });

    it('forgets the stream only when the LAST listener leaves', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        const seen: number[] = [];
        const offA = await PremiumDerivApiService.subscribeTicks('R_50', () => undefined);
        const offB = await PremiumDerivApiService.subscribeTicks('R_50', t => seen.push(t.quote));
        offA(); // one page leaving must not stop the other's feed
        expect(api.streams.has('R_50')).toBe(true);
        api.push('R_50', 55, 5);
        expect(seen.includes(55)).toBe(true);
        offB();
        await new Promise(r => setTimeout(r, 5));
        expect(api.streams.has('R_50')).toBe(false);
    });

    it('treats "already subscribed" as shared, never as a failure, and never forgets a stream it does not own', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        api.streams.set('R_25', 'someone-elses'); // another part of the app owns the stream
        const seen: number[] = [];
        const off = await PremiumDerivApiService.subscribeTicks('R_25', t => seen.push(t.quote));
        api.push('R_25', 25, 9);
        expect(seen.join(',')).toBe('25');
        off();
        await new Promise(r => setTimeout(r, 5));
        expect(api.streams.get('R_25')).toBe('someone-elses');
        expect(api.sent.filter((p: any) => p.forget).length).toBe(0);
    });

    it('re-establishes a stream that went silent (forgotten elsewhere, e.g. forget_all)', async () => {
        const api = makeApi();
        (api_base as any).api = api;
        const seen: number[] = [];
        const off = await PremiumDerivApiService.subscribeTicks('R_75', tick => seen.push(tick.quote));
        api.streams.delete('R_75'); // simulate another part of the app forgetting this stream
        expect(PremiumDerivApiService.sweepTickHubs(Date.now() + TICK_STALE_MS + 1)).toContain('R_75');
        await new Promise(resolve => setTimeout(resolve, 10)); // the watchdog refresh is intentionally fire-and-forget
        expect(api.streams.has('R_75')).toBe(true);
        api.push('R_75', 75, 10);
        expect(seen.includes(75)).toBe(true);
        off();
    });
});
