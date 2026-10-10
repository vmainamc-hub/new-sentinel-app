import type { RankedOpportunity } from '@/sentinel-engine/lib/apex/types';
import { digitFromQuote, signalKeyOf, toSentinelAiSignal } from '../sentinel-ai-signal';

const opportunity = (over: Record<string, any> = {}): RankedOpportunity =>
    ({
        symbol: 'R_100',
        name: 'Volatility 100 Index',
        score: 71.6,
        contract: { id: 'UNDER7', label: 'Under 7', side: 'UNDER', barrier: 7, confidence: 64.4 },
        entryPoint: {
            status: 'READY',
            preferred: { digit: 4, pWin: 0.8123 },
            window: { label: 'last 300 ticks' },
        },
        signal: { label: 'ENTER NOW', state: 'QUALIFIED', reason: 'Edge confirmed' },
        ...over,
    }) as unknown as RankedOpportunity;

describe('Sentinel AI signal mapper', () => {
    it('maps an Under signal with its entry digit', () => {
        const signal = toSentinelAiSignal(opportunity(), 1000);
        expect(signal.id).toBe('R_100|UNDER7@1000');
        expect(signal.key).toBe('R_100|UNDER7');
        expect(signal.contractType).toBe('DIGITUNDER');
        expect(signal.barrier).toBe(7);
        expect(signal.entryDigit).toBe(4);
        expect(signal.entryWinRate).toBeCloseTo(81.2, 1);
        expect(signal.entryWindow).toBe('last 300 ticks');
        expect(signal.score).toBe(72);
        expect(signal.confidence).toBe(64);
        expect(signal.status).toBe('ENTER NOW');
    });

    it('maps an Over signal', () => {
        const signal = toSentinelAiSignal(
            opportunity({ contract: { id: 'OVER2', label: 'Over 2', side: 'OVER', barrier: 2, confidence: 50 } }),
            5
        );
        expect(signal.contractType).toBe('DIGITOVER');
        expect(signal.barrier).toBe(2);
    });

    it('never invents an entry digit when the engine has none', () => {
        const signal = toSentinelAiSignal(
            opportunity({ entryPoint: { status: 'NO ENTRY', preferred: null, window: { label: '' } } }),
            1
        );
        expect(signal.entryDigit).toBeNull();
        expect(signal.entryWinRate).toBeNull();
    });

    it('keeps the same key for the same market and contract', () => {
        expect(signalKeyOf(opportunity())).toBe('R_100|UNDER7');
    });
});

describe('Sentinel AI digit helper', () => {
    it('reads the last digit at the market pip size', () => {
        expect(digitFromQuote(1234.56, 2)).toBe(6);
        expect(digitFromQuote(1234.5, 1)).toBe(5);
        expect(digitFromQuote(99.9999, 4)).toBe(9);
        expect(digitFromQuote(1000.0, 2)).toBe(0);
    });
});
