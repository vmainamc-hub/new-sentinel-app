jest.mock('@/external/bot-skeleton', () => ({ api_base: { api: null } }));

type Sent = Record<string, any>;

const makeApi = (handler: (request: Sent) => any) => {
    const messageUnsubscribe = jest.fn();
    // Failures reject asynchronously, like the real socket (a synchronous throw would race subscribe()'s own status).
    const send = jest.fn(async (request: Sent) => handler(request));
    const onMessage = jest.fn(() => ({ subscribe: jest.fn(() => ({ unsubscribe: messageUnsubscribe })) }));
    return { send, onMessage, messageUnsubscribe };
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
});
