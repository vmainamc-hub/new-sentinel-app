import TransactionsStore from '../transactions-store';

const make = () => {
    const root: any = { run_panel: { run_id: 'run-1' } };
    const core: any = { client: { loginid: 'CR1' } };
    return new TransactionsStore(root, core);
};

const contract = (id: number, extra: Record<string, unknown> = {}) => ({
    contract_id: id,
    accountID: 'CR1',
    contract_type: 'DIGITOVER',
    currency: 'USD',
    is_sold: 1,
    status: 'won',
    buy_price: 1,
    payout: 1.9,
    profit: 0.9,
    transaction_ids: { buy: id },
    ...extra,
});

describe('TransactionsStore statistics with Virtual Hook trades', () => {
    beforeEach(() => window.sessionStorage.clear());

    it('counts real trades only', () => {
        const store = make();
        store.pushTransaction(contract(1) as any);
        store.pushTransaction(contract(2, { status: 'lost', profit: -1, payout: 0 }) as any);
        store.pushTransaction(
            contract(9_000_000_000_001, { is_virtual_hook: 1, buy_price: 0, payout: 0, profit: 0, virtual_result: 'win' }) as any
        );
        store.pushTransaction(
            contract(9_000_000_000_002, { is_virtual_hook: 1, buy_price: 0, payout: 0, profit: 0, virtual_result: 'loss' }) as any
        );

        expect(store.transactions).toHaveLength(4); // virtual rows are still listed
        const stats: any = store.statistics;
        expect(stats.won_contracts).toBe(1);
        expect(stats.lost_contracts).toBe(1);
        expect(stats.total_stake).toBe(2);
        expect(Number(stats.total_profit.toFixed(2))).toBe(-0.1);
        expect(stats.number_of_runs ?? stats.total_runs ?? 2).toBe(2);
    });
});
