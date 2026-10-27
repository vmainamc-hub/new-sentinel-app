import { DEFAULT_BOT } from '../bot';
import { bestPerMarket, eligibility, pickBest, SCAN_CONTRACTS, scanMarkets } from '../scanner';
import { mulberry32 } from '../stats';

const random = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
const symbols = ['A', 'B', 'C'];
const series = { A: random(1500, 1), B: random(1500, 2), C: random(1500, 3) };

describe('scanner', () => {
    const scan = scanMarkets(series, symbols, DEFAULT_BOT, 0);
    it('scores every contract on every market', () => {
        expect(scan.cells.length).toBe(symbols.length * SCAN_CONTRACTS.length);
        expect(scan.bySymbol.A.length).toBe(SCAN_CONTRACTS.length);
        scan.cells.forEach(c => expect(c.score >= 0 && c.score <= 100).toBe(true));
    });
    it('on random digits almost nothing is significant after multiple-comparison control', () => {
        expect(scan.summary.significant).toBeLessThanOrEqual(2);
        expect(scan.summary.expectedByChance).toBeGreaterThan(0);
    });
    it('flags a planted edge as significant and picks it in strict mode', () => {
        // Market P: Over 2 wins on almost every trade (digits 3-9 appear after every losing entry digit).
        const planted = Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? 1 : 7));
        const s2 = scanMarkets({ ...series, P: planted }, ['A', 'B', 'C', 'P'], DEFAULT_BOT, 0);
        const cell = s2.bySymbol.P.find(c => c.label === 'Over 2')!;
        expect(cell.significant).toBe(true);
        const pick = pickBest(s2, 'strict', { mode: 'SETUP' });
        expect(pick?.cell.symbol).toBe('P');
        expect(pick?.entryDigits.length).toBeGreaterThan(0);
    });
    it('never picks a market or contract that was taken out', () => {
        const planted = Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? 1 : 7));
        const s2 = scanMarkets({ ...series, P: planted }, ['A', 'P'], DEFAULT_BOT, 0);
        const pick = pickBest(s2, 'active', { mode: 'SETUP' }, { symbols: new Set(['P']) });
        expect(pick?.cell.symbol).not.toBe('P');
    });
    it('ANY entry has no setup digits and non-executable cells are never eligible', () => {
        const planted = Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? 1 : 7));
        const s2 = scanMarkets({ P: planted }, ['P'], DEFAULT_BOT, 0);
        expect(pickBest(s2, 'active', { mode: 'ANY' })?.entryDigits).toEqual([]);
        const fake = { ...s2.cells[0], executable: false };
        expect(eligibility(fake, 'active').ok).toBe(false);
    });
    it('handles markets with no ticks', () => {
        const s3 = scanMarkets({}, ['X'], DEFAULT_BOT, 0);
        expect(s3.cells.every(c => c.assessment.state === 'WARMING')).toBe(true);
        expect(pickBest(s3, 'active', { mode: 'SETUP' })).toBeNull();
        expect(bestPerMarket(s3, ['X']).X).toBeDefined();
    });
});
