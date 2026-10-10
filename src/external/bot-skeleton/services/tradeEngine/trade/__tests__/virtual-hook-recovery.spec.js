const mockBroadcast = jest.fn();
jest.mock('../../../api/api-base', () => ({
    api_base: { account_info: { loginid: 'CR1' }, api: { onMessage: () => ({ subscribe: jest.fn() }) }, pushSubscription: jest.fn() },
}));
jest.mock('../../utils/broadcast', () => ({
    contract: (...args) => mockBroadcast(...args),
    contractStatus: jest.fn(),
    notify: jest.fn(),
}));
jest.mock('../state/actions', () => ({
    sell: () => ({ type: 'SELL' }),
    openContractReceived: () => ({ type: 'OPEN' }),
    purchaseSuccessful: () => ({ type: 'PURCHASE_SUCCESSFUL' }),
}));
jest.mock('@/components/shared', () => ({ getRoundedNumber: n => n }));

import OpenContract from '../OpenContract';
import VirtualHook from '../VirtualHook';

const make = () => {
    const Engine = VirtualHook(OpenContract(class {}));
    const engine = new Engine();
    engine.expectedContractId = () => true;
    engine.setContractFlags = contract => {
        engine.isSold = Boolean(contract.is_sold);
    };
    engine.forgetOpenContractSubscription = jest.fn();
    engine.updateTotals = jest.fn();
    engine.store = { dispatch: jest.fn() };
    engine.data = { contract: undefined };
    engine.contractId = 1;
    return engine;
};

const real = (id, status) => ({
    contract_id: id,
    is_sold: 1,
    status,
    buy_price: 3,
    sell_price: status === 'won' ? 5.7 : 0,
    profit: status === 'won' ? 2.7 : -3,
    transaction_ids: { buy: id, sell: id },
});
const virtual = (id, status) => ({
    contract_id: id,
    is_sold: 1,
    status,
    buy_price: 3,
    sell_price: status === 'won' ? 5.7 : 0,
    profit: status === 'won' ? 2.7 : -3,
    is_virtual_hook: 1,
    transaction_ids: { buy: id, sell: id },
});

describe('Virtual Hook is invisible to the strategy', () => {
    beforeEach(() => mockBroadcast.mockClear());

    it('keeps data.contract on the last REAL trade and flags the result as virtual', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, mode: 'streak', startVirtual: false, enterAfterLosses: 1, returnAfterWins: 1 });

        e.handleOpenContract(real(1, 'lost'));
        expect(e.data.contract.contract_id).toBe(1);
        expect(e.vhIsVirtualResult()).toBe(false);
        expect(e.vhIsVirtualNext()).toBe(true); // entered virtual after the real loss
        expect(e.updateTotals).toHaveBeenCalledTimes(1);

        e.handleOpenContract(virtual(9_000_000_000_001, 'won'));
        expect(e.data.contract.contract_id).toBe(1); // still the real loss: recovery state is preserved
        expect(e.data.contract.status).toBe('lost');
        expect(e.vhIsVirtualResult()).toBe(true);
        expect(e.updateTotals).toHaveBeenCalledTimes(1); // no totals for virtual trades
        expect(e.vhIsVirtualNext()).toBe(false); // virtual win returns to real trading

        e.handleOpenContract(real(2, 'lost'));
        expect(e.data.contract.contract_id).toBe(2);
        expect(e.vhIsVirtualResult()).toBe(false);
    });

    it('broadcasts virtual trades with zero stake and profit so the list shows Virtual Win/Loss', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, startVirtual: true, enterAfterLosses: 2, returnAfterWins: 1 });
        e.handleOpenContract(virtual(9_000_000_000_002, 'lost'));
        const shown = mockBroadcast.mock.calls[0][0];
        expect(shown).toMatchObject({ is_virtual_hook: 1, buy_price: 0, profit: 0, payout: 0, virtual_result: 'loss' });
    });

    it('stays virtual through virtual losses and never touches the real data in between', () => {
        const e = make();
        e.setVirtualHook({ enabled: true, startVirtual: false, enterAfterLosses: 2, returnAfterWins: 1 });
        e.handleOpenContract(real(1, 'lost'));
        e.handleOpenContract(real(2, 'lost'));
        expect(e.vhIsVirtualNext()).toBe(true);
        e.handleOpenContract(virtual(9_000_000_000_003, 'lost'));
        e.handleOpenContract(virtual(9_000_000_000_004, 'lost'));
        expect(e.vhIsVirtualNext()).toBe(true);
        expect(e.data.contract.contract_id).toBe(2);
        e.handleOpenContract(virtual(9_000_000_000_005, 'won'));
        expect(e.vhIsVirtualNext()).toBe(false);
        expect(e.data.contract.contract_id).toBe(2);
    });

    it('does nothing special when the Virtual Hook block is not used', () => {
        const e = make();
        expect(e.vhIsVirtualResult()).toBe(false);
        e.handleOpenContract(real(1, 'won'));
        expect(e.vhIsVirtualResult()).toBe(false);
        expect(e.data.contract.contract_id).toBe(1);
    });
});
