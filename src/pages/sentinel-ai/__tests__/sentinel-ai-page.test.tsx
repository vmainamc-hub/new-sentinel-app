// Render smoke test: the merged page draws the scanner, the board and the new settings from a real runner.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import type { EngineSample, SentinelAiEngine, SignalExclusion, VettedCandidate } from '../sentinel-ai-engine-types';
import type { FusionRead, FusionSource } from '../sentinel-ai-fusion';
import { SentinelAiRunner } from '../sentinel-ai-runner';
import { DEFAULT_SETTINGS } from '../sentinel-ai-types';

const vetted = (symbol: string, id: string, score: number): VettedCandidate => {
    const isOver = id.startsWith('OVER');
    const barrier = Number(id.replace(/\D/g, ''));
    return {
        blocked: false,
        momentum: { pass: true, measurable: true, score: 50, blockers: [] },
        opportunity: {
            symbol,
            name: `Market ${symbol}`,
            score,
            blocked: false,
            dangerComposition: { total: 20, isHardBlocked: false },
            contract: {
                id,
                label: `${isOver ? 'Over' : 'Under'} ${barrier}`,
                side: isOver ? 'OVER' : 'UNDER',
                barrier,
                confidence: 60,
            },
            entryPoint: { status: 'ARMED', preferred: { digit: 4, pWin: 0.8 }, window: { label: 'last 300 ticks' } },
            signal: { label: 'ENTER NOW', state: 'QUALIFIED', reason: 'because' },
        } as unknown as RankedOpportunity,
    };
};

const candidates: VettedCandidate[] = [vetted('R_10', 'UNDER7', 90), vetted('R_25', 'OVER2', 86)];

const engine: SentinelAiEngine = {
    retain: () => () => undefined,
    sample: (exclude?: SignalExclusion): EngineSample => ({
        info: { status: 'live', online: 20, total: 20, degraded: false, failsafes: [], dangerLabel: 'CALM' },
        surfaced: candidates[0].opportunity,
        vetted: candidates.filter(
            c => !exclude?.(c.opportunity.symbol, String(c.opportunity.contract.id), c.opportunity)
        ),
    }),
    onTick: () => () => undefined,
    getLastDigit: () => 3,
    markets: () => [
        { symbol: 'R_10', name: 'Volatility 10' },
        { symbol: 'R_25', name: 'Volatility 25' },
        { symbol: 'R_50', name: 'Volatility 50' },
    ],
};

const fusion: FusionSource = {
    retain: () => () => undefined,
    read: (): FusionRead => ({
        candidates: [
            {
                symbol: 'R_25',
                market: 'Market R_25',
                contract: 'DIGITOVER',
                barrier: 2,
                label: 'Over 2',
                action: 'EXECUTE',
                score: 81,
                danger: 10,
                confirmed: true,
                ripe: true,
                generatedAt: 0,
            },
        ],
        standDown: new Set(),
        ready: 7,
        total: 13,
    }),
};

const runner = new SentinelAiRunner({
    engine,
    fusion,
    buy: jest.fn(),
    settle: jest.fn(),
    isAuthorized: () => true,
    currency: () => 'USD',
    afterStop: jest.fn(),
    alert: jest.fn(),
    now: () => 1_000_000,
    loadSettings: () => ({ ...DEFAULT_SETTINGS }),
    saveSettings: jest.fn(),
});

jest.mock('../sentinel-ai-runner-instance', () => ({
    get sentinelAiRunner() {
        return runner;
    },
}));
jest.mock('@/hooks/useStore', () => ({ useStore: () => ({ client: { currency: 'USD' } }) }));
jest.mock('@/hooks/useApiBase', () => ({ useApiBase: () => ({ isAuthorized: true }) }));
jest.mock('@/components/shared_ui/themed-scrollbars', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../sentinel-ai-outcome-panel', () => ({ __esModule: true, default: () => <div>outcome panel</div> }));
jest.mock('../sentinel-ai-alerts', () => ({
    getNotificationPermission: () => 'default',
    requestNotificationPermission: jest.fn(),
}));

// eslint-disable-next-line import/first
import SentinelAi from '../sentinel-ai';

describe('Sentinel AI page', () => {
    afterAll(() => runner.dispose());

    it('shows the scanner, the board with the Fusion verdicts, and the merged settings', () => {
        render(<SentinelAi />);

        // Scanner status and radar
        expect(screen.getByLabelText('Scanner')).toBeTruthy();
        expect(screen.getByLabelText('Markets').querySelectorAll('li')).toHaveLength(3);
        expect(screen.getByText(/Insight Fusion is reading 7 of 13 markets/)).toBeTruthy();

        // Board: both setups, Fusion agreeing on Over 2 so it ranks first
        const board = screen.getByText('Scanner board').closest('section') as HTMLElement;
        const rows = board.querySelectorAll('li');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('Over 2');
        expect(rows[0].textContent).toContain('Fusion: Agrees');
        expect(rows[0].textContent).toContain('Both engines agree');
        expect(rows[1].textContent).toContain('Under 7');
        expect(rows[1].textContent).toContain('Fusion: No read');

        // Engines selector and the merged settings
        expect(screen.getByRole('radiogroup', { name: 'Which engines decide' })).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'Both engines' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByLabelText(/Rest a market after a loss/)).toBeTruthy();
        expect(screen.getByText('Advanced settings')).toBeTruthy();
    });

    it('changes the engine mode from the page and keeps it in the settings', () => {
        render(<SentinelAi />);
        act(() => {
            fireEvent.click(screen.getByRole('radio', { name: 'Only when both agree' }));
        });
        expect(runner.getSnapshot().settings.engines).toBe('require');
        expect(screen.getByRole('radio', { name: 'Only when both agree' }).getAttribute('aria-checked')).toBe('true');
        // In require mode the Under 7 setup (Fusion has no read) is held back, with the reason on the board.
        const board = screen.getByText('Scanner board').closest('section') as HTMLElement;
        expect(board.textContent).toContain('Needs both engines');
    });
});
