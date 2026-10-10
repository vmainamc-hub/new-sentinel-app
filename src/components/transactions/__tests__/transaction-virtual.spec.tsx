import React from 'react';
import { render, screen } from '@testing-library/react';
import Transaction from '../transaction';

jest.mock('../../market/market-icon', () => ({ MarketIcon: () => <i data-testid='market-icon' /> }));
jest.mock('../../trade-type/trade-type-icon', () => ({ TradeTypeIcon: () => <i data-testid='type-icon' /> }));
jest.mock('@/external/bot-skeleton', () => ({ getContractTypeName: () => 'Digits' }));
jest.mock('@/external/bot-skeleton/utils/workspace', () => ({ isDbotRTL: () => false }));
jest.mock('@/utils/symbol-display-name', () => ({ getSymbolDisplayNameSync: () => 'Volatility 100 Index' }));
jest.mock('../../shared_ui/popover', () => ({ __esModule: true, default: ({ children }: any) => <div>{children}</div> }));

const base = {
    contract_id: 9_000_000_000_001,
    contract_type: 'DIGITOVER',
    currency: 'USD',
    is_completed: true,
    buy_price: 0,
    profit: 0,
    entry_spot: 100.11,
    exit_spot: 100.17,
    transaction_ids: { buy: 9_000_000_000_001 },
    is_virtual_hook: 1,
};

describe('<Transaction /> for Virtual Hook trades', () => {
    it('shows Virtual Win with a zero stake', () => {
        render(<Transaction contract={{ ...base, virtual_result: 'win' } as any} />);
        expect(screen.getByText('Virtual Win')).toBeInTheDocument();
        expect(screen.getByText(/0\.00/)).toBeInTheDocument();
    });

    it('shows Virtual Loss', () => {
        render(<Transaction contract={{ ...base, virtual_result: 'loss' } as any} />);
        expect(screen.getByText('Virtual Loss')).toBeInTheDocument();
    });

    it('still shows a real trade as money', () => {
        render(
            <Transaction
                contract={{ ...base, is_virtual_hook: undefined, buy_price: 3, profit: 0.18, virtual_result: undefined } as any}
            />
        );
        expect(screen.queryByText(/Virtual/)).not.toBeInTheDocument();
        expect(screen.getByText(/0\.18/)).toBeInTheDocument();
    });
});
