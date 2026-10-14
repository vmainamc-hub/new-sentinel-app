jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: null } }));

type Sent = Record<string, any>;

const makeApi = (handler: (request: Sent) => any) => {
    const messageUnsubscribe = jest.fn();
    // Failures reject asynchronously, like the real socket (a synchronous throw would race subscribe()'s own status).
    const send = jest.fn(async (request: Sent) => handler(request));
    let listener: ((message: unknown) => void) | null = null;
    const onMessage = jest.fn(() => ({
        subscribe: jest.fn((callback: (message: unknown) => void) => {
            listener = callback;
            return { unsubscribe: messageUnsubscribe };
        }),
    }));
    // Delivers a live tick message exactly like the socket would.
    const emitTick = (symbol: string, epoch: number, quote = 100) =>
        listener?.({ msg_type: 'tick', tick: { symbol, epoch, quote, pip_size: 2 } });
    return { send, onMessage, messageUnsubscribe, emitTick };
};

// The bus is a singleton, so every test loads a fresh copy of it (and of the mocked socket holder).
let derivBus: typeof import('../tick-bus').derivBus;
let apiBase: { api: unknown };

const setApi = (api: unknown) => {
    apiBase.api = api;
};

const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('derivBus self-healing', () => {
    beforeEach(() => {
        jest.resetModules();
        apiBase = require('@/external/bot-skeleton').api_base;
        derivBus = require('../tick-bus').derivBus;
    });

    afterEach(() => {
        jest.useRealTimers();
        setApi(null);
    });

    it('retries a failed seed with back-off while the market is still subscribed', async () => {
        jest.useFakeTimers();
        let historyCalls = 0;
        const api = makeApi(request => {
            if (request.ticks_history) {
                historyCalls += 1;
                if (historyCalls === 1) throw new Error('socket not ready');
                return { history: { prices: [1.23, 1.24], times: [1, 2] } };
            }
            return { subscription: { id: 'sub-1' } };
        });
        setApi(api);

        const release = derivBus.subscribe(['RETRY_MKT']);
        await flush();
        expect(historyCalls).toBe(1);
        expect(derivBus.getStatus()).toBe('error');

        await jest.advanceTimersByTimeAsync(1_600);
        await flush();
        expect(historyCalls).toBe(2);
        expect(derivBus.getTicks('RETRY_MKT').length).toBe(2);

        release();
    });

    it('stops retrying once nobody is subscribed to the market any more', async () => {
        jest.useFakeTimers();
        let historyCalls = 0;
        setApi(
            makeApi(request => {
                if (request.ticks_history) {
                    historyCalls += 1;
                    throw new Error('down');
                }
                return {};
            })
        );

        const release = derivBus.subscribe(['GONE_MKT']);
        await flush();
        release();
        await jest.advanceTimersByTimeAsync(40_000);
        await flush();
        expect(historyCalls).toBe(1);
    });

    it('resync forgets the old streams on the current socket and re-seeds every live market', async () => {
        const api = makeApi(request => {
            if (request.ticks_history) return { history: { prices: [5.1], times: [10] } };
            if (request.ticks) return { subscription: { id: `stream-${request.ticks}` } };
            return {};
        });
        setApi(api);

        const release = derivBus.subscribe(['SYNC_A', 'SYNC_B']);
        await flush();
        const seededBefore = api.send.mock.calls.filter(([r]) => r.ticks_history).length;
        expect(seededBefore).toBe(2);

        await derivBus.resync();
        await flush();

        const forgotten = api.send.mock.calls.filter(([r]) => r.forget).map(([r]) => r.forget);
        expect(forgotten.sort()).toEqual(['stream-SYNC_A', 'stream-SYNC_B']);
        expect(api.send.mock.calls.filter(([r]) => r.ticks_history).length).toBe(seededBefore + 2);
        expect(api.messageUnsubscribe).toHaveBeenCalled();

        release();
    });

    it('resync does nothing without a socket', async () => {
        setApi(null);
        await expect(derivBus.resync()).resolves.toBeUndefined();
    });

    const healthyApi = () =>
        makeApi(request => {
            if (request.ticks_history) return { history: { prices: [5.1], times: [10] } };
            if (request.ticks) return { subscription: { id: `stream-${request.ticks}` } };
            return {};
        });

    it('goes back to live after a re-sync instead of staying on connecting', async () => {
        setApi(healthyApi());
        const release = derivBus.subscribe(['LIVE_A', 'LIVE_B']);
        await flush();
        await derivBus.resync();
        await flush();
        expect(derivBus.getStatus()).toBe('live');
        release();
    });

    it('does not mark the whole bus as broken when only a minority of markets fail', async () => {
        setApi(
            makeApi(request => {
                if (request.ticks_history === 'BAD_MKT') throw new Error('no data');
                if (request.ticks_history) return { history: { prices: [5.1], times: [10] } };
                return { subscription: { id: `stream-${request.ticks}` } };
            })
        );
        const release = derivBus.subscribe(['OK_1', 'OK_2', 'BAD_MKT']);
        await flush();
        expect(derivBus.getStatus()).toBe('live');
        release();
    });

    it('keeps retrying a market for as long as it is subscribed (no give-up after a few attempts)', async () => {
        jest.useFakeTimers();
        let historyCalls = 0;
        setApi(
            makeApi(request => {
                if (request.ticks_history) {
                    historyCalls += 1;
                    throw new Error('down');
                }
                return {};
            })
        );
        const release = derivBus.subscribe(['STUBBORN']);
        await flush();
        for (let i = 0; i < 40; i += 1) {
            await jest.advanceTimersByTimeAsync(31_000);
            await flush();
        }
        expect(historyCalls).toBeGreaterThan(10);
        release();
    });

    it('re-opens only the market whose stream went silent, without refetching its history', async () => {
        jest.useFakeTimers();
        const api = healthyApi();
        setApi(api);
        const release = derivBus.subscribe(['TALK_A', 'QUIET_B']);
        await flush();
        const historyBefore = api.send.mock.calls.filter(([r]) => r.ticks_history).length;

        // A keeps ticking every 2 s; B goes quiet (e.g. DBot forgot all tick streams when a bot stopped).
        let epoch = 100;
        for (let i = 0; i < 8; i += 1) {
            await jest.advanceTimersByTimeAsync(2_000);
            epoch += 2;
            api.emitTick('TALK_A', epoch);
        }
        await jest.advanceTimersByTimeAsync(2_000);
        await flush();

        const forgotten = api.send.mock.calls.filter(([r]) => r.forget).map(([r]) => r.forget);
        expect(forgotten).toEqual(['stream-QUIET_B']);
        const resubscribed = api.send.mock.calls.filter(([r]) => r.ticks === 'QUIET_B' && r.subscribe).length;
        expect(resubscribed).toBe(2); // the first subscription plus the revive
        expect(api.send.mock.calls.filter(([r]) => r.ticks === 'TALK_A' && r.subscribe).length).toBe(1);
        expect(api.send.mock.calls.filter(([r]) => r.ticks_history).length).toBe(historyBefore);
        expect(derivBus.getStatus()).toBe('live');
        release();
    });

    it('re-syncs everything when the Deriv socket instance was replaced', async () => {
        jest.useFakeTimers();
        const first = healthyApi();
        setApi(first);
        const release = derivBus.subscribe(['SWAP_A']);
        await flush();
        const second = healthyApi();
        setApi(second);
        await jest.advanceTimersByTimeAsync(5_000);
        await flush();
        expect(first.messageUnsubscribe).toHaveBeenCalled();
        expect(second.send.mock.calls.some(([r]) => r.ticks_history === 'SWAP_A')).toBe(true);
        release();
    });
});
