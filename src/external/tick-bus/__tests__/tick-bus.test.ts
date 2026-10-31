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
    const emitTick = (symbol: string, epoch: number, quote = 100, pip = 2) =>
        listener?.({ msg_type: 'tick', tick: { symbol, epoch, quote, pip_size: pip } });
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

describe('derivBus digit statistics', () => {
    beforeEach(() => {
        jest.resetModules();
        apiBase = require('@/external/bot-skeleton').api_base;
        derivBus = require('../tick-bus').derivBus;
    });

    afterEach(() => {
        jest.useRealTimers();
        setApi(null);
    });

    const historyApi = (history: { prices: number[]; times: number[] }, pipSize?: number) =>
        makeApi(request => {
            if (request.ticks_history) return { history, ...(pipSize === undefined ? {} : { pip_size: pipSize }) };
            if (request.ticks) return { subscription: { id: `stream-${request.ticks}` } };
            return {};
        });

    it('digitises history with the market pip size from the history response (3 decimals), not a default of 2', async () => {
        setApi(historyApi({ prices: [1234.567, 1234.568, 1234.569], times: [1, 2, 3] }, 3));
        const release = derivBus.subscribe(['PIP3']);
        await flush();
        expect(derivBus.getDigits('PIP3')).toEqual([7, 8, 9]);
        release();
    });

    it('accepts a pip value (0.0001) as well as a number of decimals', async () => {
        setApi(historyApi({ prices: [10.1234, 10.1235], times: [1, 2] }, 0.0001));
        const release = derivBus.subscribe(['PIPVAL']);
        await flush();
        expect(derivBus.getDigits('PIPVAL')).toEqual([4, 5]);
        release();
    });

    it('falls back to the active-symbols pip sizes when the response has none', async () => {
        (apiBase as any).pip_sizes = { PIPFALL: 4 };
        setApi(historyApi({ prices: [5.1231, 5.1232], times: [1, 2] }));
        const release = derivBus.subscribe(['PIPFALL']);
        await flush();
        expect(derivBus.getDigits('PIPFALL')).toEqual([1, 2]);
        release();
    });

    it('recomputes the buffered digits when a live tick reveals a different pip size', async () => {
        const api = historyApi({ prices: [100.123, 100.124], times: [1, 2] });
        setApi(api);
        const release = derivBus.subscribe(['LATEPIP']);
        await flush();
        expect(derivBus.getDigits('LATEPIP')).toEqual([2, 2]); // history was read with the default of 2 decimals
        api.emitTick('LATEPIP', 3, 100.125, 3);
        expect(derivBus.getDigits('LATEPIP')).toEqual([3, 4, 5]);
        release();
    });

    it('counts digits in equal windows, shifted back in time, and returns NaN when there is not enough data', async () => {
        // oldest -> newest digits: 0 2 9 9 | 0 2 4 5
        setApi(historyApi({ prices: [1.0, 1.2, 1.9, 1.9, 1.0, 1.2, 1.4, 1.5], times: [1, 2, 3, 4, 5, 6, 7, 8] }, 1));
        const release = derivBus.subscribe(['COUNTS']);
        await flush();
        expect(derivBus.getDigitCount('COUNTS')).toBe(8);
        expect(derivBus.countDigits('COUNTS', 4, 0, [0, 2, 4])).toBe(3);
        expect(derivBus.countDigits('COUNTS', 4, 4, [0, 2, 4])).toBe(2);
        expect(derivBus.countDigits('COUNTS', 4, 0, [5, 7, 9])).toBe(1);
        expect(derivBus.countDigits('COUNTS', 4, 4, [5, 7, 9])).toBe(2);
        expect(derivBus.countDigits('COUNTS', 5, 4, [0])).toBeNaN();
        expect(derivBus.countDigits('NOPE', 1, 0, [0])).toBeNaN();
        expect(derivBus.countDigits('COUNTS', 0, 0, [0])).toBeNaN();
        release();
    });

    it('reports how long a market has been quiet', async () => {
        jest.useFakeTimers();
        const api = historyApi({ prices: [1.1], times: [1] }, 1);
        setApi(api);
        const release = derivBus.subscribe(['AGE']);
        await flush();
        expect(derivBus.getAgeMs('AGE')).toBeLessThan(50);
        await jest.advanceTimersByTimeAsync(3_000);
        expect(derivBus.getAgeMs('AGE')).toBeGreaterThanOrEqual(3_000);
        api.emitTick('AGE', 50, 1.3, 1);
        expect(derivBus.getAgeMs('AGE')).toBeLessThan(50);
        expect(derivBus.getAgeMs('UNKNOWN')).toBe(Number.POSITIVE_INFINITY);
        release();
    });
});
