import { fireEvent, render, screen } from '@testing-library/react';
import BulkTraderView, { type AutoView, type BulkViewProps } from '../BulkTraderView';
import { BULK_MARKETS } from '../../over-under-engine';
import { emptyTally } from '../../bulk-run';
import { DEFAULT_AUTO } from '../../auto-trader';

const form = Object.fromEntries(Object.entries(DEFAULT_AUTO).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)])) as unknown as AutoView['form'];

const radar = (watching: string | null): AutoView['radar'] => ({
    watching,
    markets: BULK_MARKETS.map((m, i) => ({ symbol: m.symbol, best: { score: 40 + i }, eligible: i === 3, significant: i === 3, quarantined: false })),
});

const props = (over: Partial<AutoView> = {}, extra: Partial<BulkViewProps> = {}): BulkViewProps =>
    ({
        live: true, marketsReady: 13, rec: null, watch: null, onLoadRec: jest.fn(), locked: false, canLock: false, onToggleLock: jest.fn(),
        auto: { armed: false, form, runs: 0, pnl: 0, note: 'Off.', maxRuns: 5, maxLoss: 5, targetProfit: 5, account: 'DEMO', mode: 'NORMAL', recovery: false, next: '', rule: '', log: [], entry: null, radar: radar(null), ...over },
        onAutoToggle: jest.fn(), onLogDownload: jest.fn(), onLogClear: jest.fn(), onAutoForm: jest.fn(),
        signalLock: { on: false, openSide: null, note: '', onToggle: jest.fn() }, oneTick: { on: false, onToggle: jest.fn() },
        symbol: 'R_75', onSymbol: jest.fn(), price: '1', digit: 1, digitPct: Array(10).fill(10), recent: [], onForm: () => jest.fn(),
        form: { duration: '5', stake: '1', runs: '5' }, overBarrier: '3', underBarrier: '6', onOverBarrier: jest.fn(), onUnderBarrier: jest.fn(),
        pickSide: null, loadedNote: '', currency: 'USD', running: false, status: '', error: '', tally: emptyTally(), syncNote: '', log: [], onRun: jest.fn(), onStop: jest.fn(),
        ...extra,
    }) as unknown as BulkViewProps;

describe('Bulk Trader Auto Trader scanner', () => {
    it('shows the scanner dial with a Run button that arms the auto trader', () => {
        const p = props();
        const { container } = render(<BulkTraderView {...p} />);
        expect(container.querySelector('svg.sf-radar')).not.toBeNull();
        expect(container.querySelectorAll('svg.sf-radar .mk')).toHaveLength(BULK_MARKETS.length);
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(p.onAutoToggle).toHaveBeenCalledTimes(1);
    });

    it('turns into Stop while armed, highlights the watched market and shows the entry state', () => {
        const p = props({ armed: true, next: 'Over 3 at 1.00 USD', radar: radar('R_75'), entry: { need: 3, want: 'O', symbols: ['O'], waiting: true } });
        const { container } = render(<BulkTraderView {...p} />);
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(p.onAutoToggle).toHaveBeenCalledTimes(1);
        expect(container.querySelectorAll('svg.sf-radar .mk.armed')).toHaveLength(1);
        expect(screen.getByText(/waiting for 3 O ticks/)).toBeTruthy();
    });

    it('keeps every Auto Trader parameter in place and editable when not armed', () => {
        const p = props();
        render(<BulkTraderView {...p} />);
        [
            'Trade on', 'Max auto runs', 'Stop at loss (USD)', 'Target profit (USD)', 'Cooldown (s)', 'Entry rule', 'Digit pressure check',
            'Recovery', 'Recovery Over digit', 'Recovery Under digit', 'Martingale ×', 'Max recovery steps', 'At the limit',
        ].forEach(label => expect(screen.getByLabelText(label)).toBeTruthy());
        expect(screen.getByLabelText(/Base entry ticks/)).toBeTruthy();
        expect(screen.getByLabelText(/Base wait/)).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Max auto runs'), { target: { value: '9' } });
        expect(p.onAutoForm).toHaveBeenCalledWith('maxRuns', '9');
    });

    it('locks the parameters while armed and keeps the manual Trading Deck and signal lock', () => {
        render(<BulkTraderView {...props({ armed: true })} />);
        expect((screen.getByLabelText('Max auto runs') as HTMLInputElement).disabled).toBe(true);
        expect(screen.getByLabelText('Trading Deck')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Lock signal/ })).toBeTruthy();
    });

    it('counts won and lost runs from the run log', () => {
        const row = (id: number, result: string) => ({ id, at: id, market: 'V75', contract: 'Over 3', mode: 'NORMAL', stake: 1, trades: 5, rule: '', pattern: '', digits: '', exits: '', waitedSec: 0, pressure: '', result, pnl: result === 'WIN' ? 1 : -1 });
        render(<BulkTraderView {...props({ log: [row(1, 'WIN'), row(2, 'WIN'), row(3, 'LOSS')] as unknown as AutoView['log'] })} />);
        expect(screen.getByText('2 / 1')).toBeTruthy();
    });
});
