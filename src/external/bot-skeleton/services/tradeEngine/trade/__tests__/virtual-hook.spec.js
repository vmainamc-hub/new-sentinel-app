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

import VirtualHook from '../VirtualHook';

const make = (options = {}) => {
    const Engine = VirtualHook(class {});
    const engine = new Engine();
    engine.tradeOptions = { amount: 1, duration: 1, duration_unit: 't', prediction: 2, ...options };
    engine.symbol = 'R_100';
    engine.accountInfo = { currency: 'USD' };
    engine.getPipSize = () => 2;
    engine.store = { dispatch: jest.fn() };
    engine.settled = [];
    engine.handleOpenContract = jest.fn(contract => {
        engine.settled.push(contract);
        engine.vhOnSettled(contract);
    });
    return engine;
};
const tick = (quote, epoch, symbol = 'R_100') => mockTicks.next({ data: { msg_type: 'tick', tick: { symbol, quote, epoch, pip_size: 2 } } });
const real = status => ({ status, profit: status === 'won' ? 0.9 : -1 });
const virtual = status => ({ status, profit: status === 'won' ? 0.9 : -1, is_virtual_hook: 1 });

describe('Virtual Hook state machine', () => {
    it('is off unless enabled', () => {
        const e = make();
        expect(e.vhIsVirtualNext()).toBe(false);
        e.vhOnSettled(real('lost'));
        e.vhOnSettled(real('lost'));
        expect(e.vhIsVirtualNext()).toBe(false);
    });

    it('enters virtual after N real losses and returns after M consecutive virtual wins', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, mode: 'streak', startVirtual: false, enterAfterLosses: 2, returnAfterWins: 2 });
        e.vhOnSettled(real('lost'));
        expect(e.vhIsVirtualNext()).toBe(false);
        e.vhOnSettled(real('won')); // a win resets the real-loss counter
        e.vhOnSettled(real('lost'));
        expect(e.vhIsVirtualNext()).toBe(false);
        e.vhOnSettled(real('lost'));
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        e.vhOnSettled(virtual('lost')); // streak broken, stays virtual
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        expect(e.vhIsVirtualNext()).toBe(false);
    });

    it('can start in virtual mode', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, startVirtual: true, enterAfterLosses: 2, returnAfterWins: 1 });
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        expect(e.vhIsVirtualNext()).toBe(false);
    });

    it('fixed count runs exactly N virtual trades regardless of results', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, mode: 'fixed', enterAfterLosses: 1, fixedCount: 3 });
        e.vhOnSettled(real('lost'));
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        e.vhOnSettled(virtual('lost'));
        expect(e.vhIsVirtualNext()).toBe(true);
        e.vhOnSettled(virtual('won'));
        expect(e.vhIsVirtualNext()).toBe(false);
    });

    it('sanitizes settings', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, enterAfterLosses: -5, returnAfterWins: 'x', fixedCount: 0 });
        expect(e.vh.enterAfterLosses).toBe(1);
        expect(e.vh.returnAfterWins).toBe(1);
        expect(e.vh.fixedCount).toBe(1);
    });
});

describe('virtualPurchase', () => {
    it('settles a digit contract on the tick after entry without touching real totals', async () => {
        const e = make({ prediction: 2 });
        e.setVirtualHook({ enabled: true, startVirtual: true });
        await e.virtualPurchase('DIGITOVER');
        expect(e.store.dispatch).toHaveBeenCalledWith({ type: 'PURCHASE_SUCCESSFUL' });
        tick(100.11, 1); // entry
        expect(e.settled).toHaveLength(0);
        tick(100.17, 2); // exit digit 7 > 2 -> win
        expect(e.settled).toHaveLength(1);
        const c = e.settled[0];
        expect(c.is_virtual_hook).toBe(1);
        expect(c.status).toBe('won');
        expect(c.profit).toBeGreaterThan(0);
        expect(c.contract_id).toBeGreaterThan(9e12);
        expect(e.contractId).toBe(c.contract_id);
    });

    it('loses digit over when the exit digit is not above the barrier', async () => {
        const e = make({ prediction: 5 });
        e.setVirtualHook({ enabled: true, startVirtual: true });
        await e.virtualPurchase('DIGITOVER');
        tick(10.0, 1);
        tick(10.03, 2);
        expect(e.settled[0].status).toBe('lost');
        expect(e.settled[0].profit).toBe(-1);
    });

    it('waits the configured number of ticks and ignores duplicate epochs and other symbols', async () => {
        const e = make({ duration: 3, prediction: 1 });
        e.setVirtualHook({ enabled: true, startVirtual: true });
        await e.virtualPurchase('DIGITUNDER');
        tick(1.5, 1);
        tick(1.0, 1); // duplicate epoch ignored
        tick(9.99, 5, 'R_50'); // other symbol ignored
        tick(1.5, 2);
        tick(1.5, 3);
        expect(e.settled).toHaveLength(0);
        tick(1.50, 4); // 3rd tick after entry, digit 0 < 1 -> win
        expect(e.settled).toHaveLength(1);
        expect(e.settled[0].status).toBe('won');
    });

    it('settles rise/fall by comparing exit with entry', async () => {
        const e = make({ duration: 1 });
        e.setVirtualHook({ enabled: true, startVirtual: true });
        await e.virtualPurchase('CALL');
        tick(100, 1);
        tick(101, 2);
        expect(e.settled[0].status).toBe('won');
        await e.virtualPurchase('PUT');
        tick(101, 3);
        tick(102, 4);
        expect(e.settled[1].status).toBe('lost');
    });

    it('refuses unsupported contracts and non-tick durations instead of trading real money', () => {
        expect(() => make().virtualPurchase('ACCU')).toThrow(/tick-duration/);
        expect(() => make({ duration_unit: 'm' }).virtualPurchase('DIGITOVER')).toThrow(/tick-duration/);
    });
});
