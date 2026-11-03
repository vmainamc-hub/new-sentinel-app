import { fireEvent, render, screen } from '@testing-library/react';
import BulkTraderView, { type AutoView, type BulkViewProps } from '../BulkTraderView';
import { emptyTally } from '../../bulk-run';
import { DEFAULT_AUTO } from '../../auto-trader';

const form = Object.fromEntries(Object.entries(DEFAULT_AUTO).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)])) as unknown as AutoView['form'];

const props = (over: Partial<AutoView> = {}, extra: Partial<BulkViewProps> = {}): BulkViewProps =>
    ({
        live: true, marketsReady: 13, rec: null, watch: null, onLoadRec: jest.fn(), locked: false, canLock: false, onToggleLock: jest.fn(),
        auto: { armed: false, form, runs: 0, pnl: 0, note: 'Off.', maxRuns: 5, maxLoss: 5, targetProfit: 5, account: 'DEMO', mode: 'NORMAL', recovery: false, next: '', rule: '', log: [], entry: null, ...over },
        onAutoToggle: jest.fn(), onLogDownload: jest.fn(), onLogClear: jest.fn(), onAutoForm: jest.fn(),
        signalLock: { on: false, openSide: null, note: '', onToggle: jest.fn() }, oneTick: { on: false, onToggle: jest.fn() },
        symbol: 'R_75', onSymbol: jest.fn(), price: '1', digit: 1, digitPct: Array(10).fill(10), recent: [], onForm: () => jest.fn(),
        form: { duration: '5', stake: '1', runs: '5' }, overBarrier: '3', underBarrier: '6', onOverBarrier: jest.fn(), onUnderBarrier: jest.fn(),
        pickSide: null, loadedNote: '', currency: 'USD', running: false, status: '', error: '', tally: emptyTally(), syncNote: '', log: [], onRun: jest.fn(), onStop: jest.fn(),
        scan: { phase: 'idle', progress: 0, secondsLeft: 0, marketsRead: 0, ticksChecked: 0, outcome: null, settings: { seconds: 20, autoLoad: false, autoLoadEntry: true, entryMode: 'INSTANT', entryDigit: '', waitSec: 90, fusionRules: true }, loadedKey: '' },
        onScan: jest.fn(), onScanCancel: jest.fn(), onScanLoad: jest.fn(), onScanSettings: jest.fn(),
        entry: { mode: 'INSTANT', digit: '', waitSec: 90, waiting: null }, onEntryDigit: jest.fn(), onEntryMode: jest.fn(), onWaitCancel: jest.fn(),
        ...extra,
    }) as unknown as BulkViewProps;

describe('Bulk Trader Auto Trader scanner', () => {
    it('has no scanner dial and a Run button that arms the auto trader', () => {
        const p = props();
        const { container } = render(<BulkTraderView {...p} />);
        expect(container.querySelector('svg.sf-radar')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Run' }));
        expect(p.onAutoToggle).toHaveBeenCalledTimes(1);
    });

    it('turns into Stop while armed and shows the entry state', () => {
        const p = props({ armed: true, next: 'Over 3 at 1.00 USD', entry: { need: 3, want: 'O', symbols: ['O'], waiting: true } });
        render(<BulkTraderView {...p} />);
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(p.onAutoToggle).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/waiting for 3 O ticks/)).toBeTruthy();
    });

    it('always keeps the live distribution and the Over / Under buttons, whatever the view', () => {
        const { container } = render(<BulkTraderView {...props()} />);
        fireEvent.click(screen.getByRole('checkbox', { name: 'Fusion signal' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Auto trader' }));
        fireEvent.click(screen.getByRole('checkbox', { name: 'Run results' }));
        expect(container.querySelectorAll('.apex-bt__ring')).toHaveLength(10);
        expect(screen.getByRole('button', { name: /Over 3/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Under 6/ })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
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

describe('digit colour roles', () => {
    const { digitRoles } = jest.requireActual('../BulkTraderView');
    it('marks most, 2nd most, least, 2nd least and the fastest riser', () => {
        const pct = [8, 12, 9, 11, 10, 7, 14, 9.5, 10.5, 9];
        const trend = [0, 0, 0, 0, 0, 0, 0, 2, 0, 0];
        const roles = digitRoles(pct, trend);
        expect(roles[6]).toBe('most');
        expect(roles[1]).toBe('second-most');
        expect(roles[5]).toBe('least');
        expect(roles[0]).toBe('second-least');
        expect(roles[7]).toBe('rising');
    });
    it('gives the riser slot to the next digit when the riser is already most or least', () => {
        const roles = digitRoles([8, 12, 9, 11, 10, 7, 14, 9.5, 10.5, 9], [0, 0, 0, 0, 0, 0, 5, 1, 0, 0]);
        expect(roles[6]).toBe('most');
        expect(roles[7]).toBe('rising');
    });
});


describe('market scanner and entry digit', () => {
    const pick = (over: Record<string, unknown> = {}) => ({
        symbol: 'R_75', market: 'Volatility 75', contract: 'DIGITOVER', barrier: 2, side: 0, label: 'Over 2', score: 71, persistence: 0.8, samples: 20, passing: true,
        gates: [{ key: 'edge', label: 'Distribution edge', pass: true, note: '' }], blockedBy: [], rank: 62,
        entry: { digit: 4, strength: 'confirmed', train: { digit: 4, n: 90, wins: 70, rate: 0.78, z: 3 }, holdout: { n: 40, wins: 30, rate: 0.75 }, fair: 0.7, note: 'after a 4 the contract won 78%' }, ...over,
    });
    const done = (over: Record<string, unknown> = {}) => ({
        phase: 'done', progress: 1, secondsLeft: 0, marketsRead: 13, ticksChecked: 40, loadedKey: '',
        settings: { seconds: 20, autoLoad: false, autoLoadEntry: true, entryMode: 'INSTANT', entryDigit: '', waitSec: 90, fusionRules: true },
        outcome: { seconds: 20, finishedAt: 1, marketsRead: 13, best: pick(), closest: null, top: [pick()], note: 'Over 2 on Volatility 75: passed 80%.' }, ...over,
    });

    it('starts a scan and shows the 5-30 second choices', () => {
        const p = props();
        render(<BulkTraderView {...p} />);
        fireEvent.click(screen.getByRole('button', { name: 'Scan markets' }));
        expect(p.onScan).toHaveBeenCalledTimes(1);
        const options = Array.from((screen.getByLabelText('Scan for') as HTMLSelectElement).options).map(o => Number(o.value));
        expect(Math.min(...options)).toBe(5);
        expect(Math.max(...options)).toBe(30);
    });

    it('shows the pick with its entry digit and loads it, or just its digit', () => {
        const p = props({}, { scan: done() as never });
        render(<BulkTraderView {...p} />);
        expect(screen.getByText('SCAN PICK')).toBeTruthy();
        expect(screen.getByText(/Wait for digit 4/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Load to Trading Deck' }));
        expect(p.onScanLoad).toHaveBeenCalledWith(expect.objectContaining({ label: 'Over 2' }), 'all');
        fireEvent.click(screen.getByRole('button', { name: 'Use digit 4 only' }));
        expect(p.onScanLoad).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Over 2' }), 'entry');
    });

    it('marks a closest result as not passing every check', () => {
        const closest = pick({ passing: false, blockedBy: ['Winners building'] });
        const p = props({}, { scan: done({ outcome: { seconds: 20, finishedAt: 1, marketsRead: 13, best: null, closest, top: [closest], note: 'Nothing held up' } }) as never });
        render(<BulkTraderView {...p} />);
        expect(screen.getByText(/CLOSEST/)).toBeTruthy();
    });

    it('lets you type an entry digit, click a digit ring, and choose Wait for digit', () => {
        const p = props();
        const { container } = render(<BulkTraderView {...p} />);
        fireEvent.change(screen.getByLabelText('Entry digit'), { target: { value: '7' } });
        expect(p.onEntryDigit).toHaveBeenCalledWith('7');
        fireEvent.click(container.querySelectorAll('.apex-bt__ring')[3]);
        expect(p.onEntryDigit).toHaveBeenLastCalledWith('3');
        fireEvent.click(screen.getByRole('button', { name: 'Wait for digit' }));
        expect(p.onEntryMode).toHaveBeenCalledWith('WAIT');
    });

    it('marks the entry digit on its ring and says what Over / Under will do', () => {
        const p = props({}, { entry: { mode: 'WAIT', digit: '4', waitSec: 90, waiting: null } as never });
        const { container } = render(<BulkTraderView {...p} />);
        expect(container.querySelector('.apex-bt__ring.is-entry')?.textContent).toMatch(/4/);
        expect(screen.getByText(/waits for 4, then run/)).toBeTruthy();
    });

    it('while waiting, shows the wait, locks the deck and can cancel', () => {
        const p = props({}, { entry: { mode: 'WAIT', digit: '4', waitSec: 90, waiting: { digit: 4, side: 0, secondsLeft: 41 } } as never });
        render(<BulkTraderView {...p} />);
        expect(screen.getByText(/Waiting for digit 4/)).toBeTruthy();
        expect((screen.getByRole('button', { name: /Over 3/ }) as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel wait' }));
        expect(p.onWaitCancel).toHaveBeenCalledTimes(1);
    });
});
