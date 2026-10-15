import { Subject } from 'rxjs';

const mockTicks = new Subject();
jest.mock('../../../api/api-base', () => ({
    api_base: {
        api: { onMessage: () => mockTicks },
        pushSubscription: jest.fn(),
    },
}));
jest.mock('../../utils/broadcast', () => ({ contractStatus: jest.fn(), notify: jest.fn() }));
jest.mock('../state/actions', () => ({ purchaseSuccessful: () => ({ type: 'PURCHASE_SUCCESSFUL' }) }));

// A scriptable stand-in for the Sentinel tick bus.
const mockBus = {
    digits: {},
    ages: {},
    released: [],
    subscribe: jest.fn(symbols => {
        symbols.forEach(s => {
            mockBus.digits[s] = mockBus.digits[s] ?? [1, 2, 3];
            mockBus.ages[s] = mockBus.ages[s] ?? 0;
        });
        return () => mockBus.released.push(symbols);
    }),
    getDigitCount: s => (mockBus.digits[s] || []).length,
    getAgeMs: s => (s in mockBus.ages ? mockBus.ages[s] : Number.POSITIVE_INFINITY),
    getDigits: s => [...(mockBus.digits[s] || [])],
    countDigits: (s, window, skip, wanted) => {
        const d = mockBus.digits[s];
        if (!d || d.length < window + skip) return NaN;
        return d.slice(d.length - skip - window, d.length - skip).filter(x => wanted.includes(x)).length;
    },
};
jest.mock('@/sentinel-engine/lib/deriv/tick-bus', () => ({ derivBus: mockBus }), { virtual: true });

import MultiMarket, { normalizeMarkets } from '../MultiMarket';
import VirtualHook from '../VirtualHook';

const make = (options = {}) => {
    const Engine = MultiMarket(class {});
    const engine = new Engine();
    engine.options = { symbol: '1HZ100V' };
    engine.tradeOptions = { amount: 1, duration: 1, duration_unit: 't', prediction: 6, symbol: '1HZ100V', ...options };
    return engine;
};

beforeEach(() => {
    mockBus.digits = {};
    mockBus.ages = {};
    mockBus.released = [];
    mockBus.subscribe.mockClear();
});

describe('normalizeMarkets', () => {
    it('trims, de-duplicates and drops empty entries', () => {
        expect(normalizeMarkets([' R_50 ', 'R_50', '', '1HZ10V', null])).toEqual(['R_50', '1HZ10V']);
    });
    it('rejects anything that is not a plain market symbol', () => {
        expect(() => normalizeMarkets(['R_50', "R_50'; alert(1)"])).toThrow(/not a valid market symbol/);
    });
    it('caps the number of markets', () => {
        const many = Array.from({ length: 21 }, (_, i) => `M_${i + 10}`);
        expect(() => normalizeMarkets(many)).toThrow(/more than 20/);
    });
});

describe('watching and reading markets', () => {
    it('subscribes once, reports how many are ready and releases on request', async () => {
        const e = make();
        const ready = await e.watchMarkets(['R_50', 'JD25']);
        expect(ready).toBe(2);
        expect(mockBus.subscribe).toHaveBeenCalledWith(['R_50', 'JD25']);
        e.releaseMarkets();
        expect(mockBus.released).toEqual([['R_50', 'JD25']]);
        // released markets can no longer be read
        expect(e.getMarketTickCount('R_50')).toBe(0);
    });

    it('re-watching replaces the previous subscription instead of leaking it', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        await e.watchMarkets(['R_75']);
        expect(mockBus.released).toEqual([['R_50']]);
    });

    it('only reads markets that were watched', async () => {
        const e = make();
        mockBus.digits.R_100 = [0, 2, 4, 5];
        await e.watchMarkets(['R_50']);
        expect(e.getMarketTickCount('R_100')).toBe(0);
        expect(e.getMarketDigitCount('R_100', 2, 0, [0])).toBeNaN();
        expect(e.getMarketDigits('R_100')).toEqual([]);
    });

    it('treats a market whose feed went quiet as having no data', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        mockBus.digits.R_50 = [1, 2, 3, 4, 5, 6];
        expect(e.getMarketTickCount('R_50')).toBe(6);
        mockBus.ages.R_50 = 12000;
        expect(e.getMarketTickCount('R_50')).toBe(0);
        expect(e.getMarketDigitCount('R_50', 3, 0, [1])).toBeNaN();
    });

    it('counts digits in equal, shifted windows and returns NaN until both samples exist', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        // oldest -> newest: previous 4 ticks [0,2,9,9], latest 4 ticks [0,2,4,5]
        mockBus.digits.R_50 = [0, 2, 9, 9, 0, 2, 4, 5];
        expect(e.getMarketDigitCount('R_50', 4, 0, [0, 2, 4])).toBe(3);
        expect(e.getMarketDigitCount('R_50', 4, 4, [0, 2, 4])).toBe(2);
        expect(e.getMarketDigitCount('R_50', 5, 4, [0, 2, 4])).toBeNaN();
    });
});

describe('setTradeMarket', () => {
    it('changes only the purchase market of this trade', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        expect(e.setTradeMarket('R_50')).toBe('R_50');
        expect(e.tradeOptions.symbol).toBe('R_50');
        expect(e.options.symbol).toBe('1HZ100V'); // the base market is untouched, so the next trade restarts on it
        expect(e.tradeOptions.prediction).toBe(6);
    });

    it('always allows the base market', () => {
        const e = make();
        expect(e.setTradeMarket('1HZ100V')).toBe('1HZ100V');
    });

    it('refuses a market that is not being watched', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        expect(() => e.setTradeMarket('R_75')).toThrow(/not being watched/);
        expect(e.tradeOptions.symbol).toBe('1HZ100V');
    });

    it('refuses invalid symbols', () => {
        expect(() => make().setTradeMarket('')).toThrow(/not a valid market symbol/);
        expect(() => make().setTradeMarket('R 50!')).toThrow(/not a valid market symbol/);
    });

    it('refuses when prices are pre-requested for the base market only (payout basis / payout blocks)', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        e.is_proposal_subscription_required = true;
        expect(() => e.setTradeMarket('R_50')).toThrow(/Stake basis/);
    });

    it('needs a started trade', async () => {
        const e = make();
        await e.watchMarkets(['R_50']);
        e.tradeOptions = undefined;
        expect(() => e.setTradeMarket('R_50')).toThrow(/after the trade has started/);
    });
});

describe('Virtual Hook with a switched market', () => {
    it('settles a virtual trade on the market it was placed on, not on the watched base market', () => {
        const Engine = MultiMarket(VirtualHook(class {}));
        const e = new Engine();
        e.options = { symbol: '1HZ100V' };
        e.symbol = '1HZ100V';
        e.tradeOptions = { amount: 1, duration: 1, duration_unit: 't', prediction: 6, symbol: '1HZ100V' };
        e.multi_market_symbols = new Set(['R_50']);
        e.accountInfo = { currency: 'USD' };
        e.getPipSize = () => 2;
        e.store = { dispatch: jest.fn() };
        e.settled = [];
        e.handleOpenContract = jest.fn(c => c.is_sold && e.settled.push(c));
        e.setTradeMarket('R_50');

        e.virtualPurchase('DIGITUNDER');
        const tick = (symbol, quote, epoch) =>
            mockTicks.next({ data: { msg_type: 'tick', tick: { symbol, quote, epoch, pip_size: 2 } } });

        tick('1HZ100V', 100.01, 1000); // base market tick: must be ignored
        expect(e.settled).toHaveLength(0);
        tick('R_50', 100.03, 1001); // last digit 3 < 6: the Under 6 contract wins
        expect(e.settled).toHaveLength(1);
        expect(e.settled[0].status).toBe('won');
        expect(e.settled[0].exit_digit).toBe(3);
    });
});
