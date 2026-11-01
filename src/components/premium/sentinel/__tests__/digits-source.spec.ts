import { DIGIT_PAIRS, rankMarkets } from '../../apex-logic';
import { buildBoard, createSentinelOverlay } from '../overlay';
import { PULSE_CONTRACTS } from '../pulse';
import { readDigitsAnalysis } from '../digits-source';
import { contractsFor, DEFAULT_ENGINE, type EngineSettings, normalizeEngine } from '../settings';

// Deterministic digit streams. `rate` of the ticks win Over 2 (digit 3-9); the rest are 0-2. Under 7 wins on 0-6.
const stream = (n: number, pattern: number[]) => Array.from({ length: n }, (_, i) => pattern[i % pattern.length]);
const HIGH = [9, 8, 7, 9, 8, 7, 9, 8, 7, 1]; // Over 2 wins 90%
const MID = [9, 5, 4, 3, 8, 6, 1, 7, 0, 2]; // Over 2 wins 70% (fair)
const LOW = [0, 1, 2, 0, 1, 2, 0, 1, 2, 9]; // Over 2 wins 10%, so Under 7 wins 90%

const series = {
    A: stream(1000, HIGH),
    B: stream(1000, MID),
    C: stream(1000, LOW),
    D: stream(100, HIGH), // too few ticks: never read
};
const symbols = ['A', 'B', 'C', 'D'];
const engine = (patch: Partial<EngineSettings> = {}): EngineSettings => ({
    ...DEFAULT_ENGINE,
    source: 'digits',
    ...patch,
});

describe('Digits Analysis as the signal source', () => {
    it('ranks the markets exactly like the Digits Analysis page does', () => {
        const snap = readDigitsAnalysis(series, symbols, PULSE_CONTRACTS);
        const pair = DIGIT_PAIRS[1];
        const page = rankMarkets(
            ['A', 'B', 'C'].map(s => ({ symbol: s, name: s, digits: series[s as 'A' | 'B' | 'C'] })),
            'over_under',
            pair,
            1000
        );
        const tiered = snap.reads
            .filter(r => r.tier && [2, 7].includes(r.contract.param))
            .sort(
                (a, b) =>
                    ['strong', 'steady', 'watch'].indexOf(a.tier!) - ['strong', 'steady', 'watch'].indexOf(b.tier!)
            );
        expect(tiered.map(r => r.symbol)).toEqual(page.map(p => p.symbol));
        expect(tiered[0].contract).toEqual({
            side: page[0].trade.side === 'over' ? 'OVER' : 'UNDER',
            param: page[0].trade.barrier,
        });
    });

    it('skips markets with too few ticks', () => {
        const snap = readDigitsAnalysis(series, symbols, PULSE_CONTRACTS);
        expect(snap.markets).toBe(3);
        expect(snap.reads.some(r => r.symbol === 'D')).toBe(false);
    });

    it('gives each pair one #1, one #2 and one #3 at most, on the better side only', () => {
        const snap = readDigitsAnalysis(series, symbols, PULSE_CONTRACTS);
        for (const pair of DIGIT_PAIRS) {
            const reads = snap.reads.filter(r => r.contract.param === pair.over || r.contract.param === pair.under);
            for (const tier of ['strong', 'steady', 'watch'] as const) {
                const same = reads.filter(r => r.tier === tier);
                expect(same.length).toBeLessThanOrEqual(1);
            }
        }
    });

    it('uses only the side that is switched on', () => {
        const overOnly = contractsFor({ propositions: ['OVER:2'] });
        const snap = readDigitsAnalysis(series, symbols, overOnly);
        expect(snap.reads.every(r => r.contract.side === 'OVER' && r.contract.param === 2)).toBe(true);
        expect(snap.reads.find(r => r.tier === 'strong')?.symbol).toBe('A'); // 90% Over 2
    });

    it('the style decides how many ranks may trade', () => {
        const snap = readDigitsAnalysis(series, symbols, PULSE_CONTRACTS);
        const board = (mode: EngineSettings['mode']) => buildBoard(snap, engine({ mode }));
        const careful = board('careful');
        const balanced = board('balanced');
        const active = board('active');
        expect(careful.every(r => r.tier === 'strong')).toBe(true);
        expect(careful.length).toBeGreaterThan(0);
        expect(balanced.length).toBeGreaterThanOrEqual(careful.length);
        expect(active.length).toBeGreaterThanOrEqual(balanced.length);
    });

    it('the overlay backs a #1 market and names Digits Analysis; a market outside the top is refused in careful', () => {
        const eng = engine({ mode: 'careful', propositions: ['OVER:2'] });
        const overlay = createSentinelOverlay({
            getEngine: () => eng,
            read: (syms, e) => readDigitsAnalysis(series, syms, contractsFor(e)),
        });
        overlay.refresh!(1, symbols);
        const cell = (symbol: string) => ({ symbol, contract: { side: 'OVER', param: 2 } }) as never;
        const top = overlay.call(cell('A'), { recovering: false, now: 1 });
        expect(top.allow).toBe(true);
        expect(top.note).toMatch(/Digits Analysis #1/);
        const other = overlay.call(cell('B'), { recovering: false, now: 1 });
        expect(other.allow).toBe(false);
        expect(other.note).toMatch(/Digits Analysis/);
        expect(overlay.funnel()?.source).toBe('digits');
    });

    it('the source setting defaults to Pulse and survives a bad saved value', () => {
        expect(DEFAULT_ENGINE.source).toBe('pulse');
        expect(normalizeEngine({ source: 'digits' }).source).toBe('digits');
        expect(normalizeEngine({ source: 'nonsense' }).source).toBe('pulse');
        expect(normalizeEngine(null).source).toBe('pulse');
    });
});
