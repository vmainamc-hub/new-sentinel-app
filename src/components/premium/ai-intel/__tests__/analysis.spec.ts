import { mulberry32 } from '@/components/premium/sixfold/stats';
import { analyseMarket, classifyRegime, cusumPeak, entryStats, scanRows, uniformity } from '../analysis';
import { OVER_2, UNDER_7 } from '../sim';

const randomDigits = (n: number, seed = 1) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};

describe('analysis', () => {
    it('uniformity is not rejected on pseudo-random digits and is rejected on a skewed stream', () => {
        expect(uniformity(randomDigits(5000)).p).toBeGreaterThan(0.01);
        expect(uniformity(Array.from({ length: 2000 }, (_, i) => (i % 3 === 0 ? 7 : i % 10))).p).toBeLessThan(0.001);
        expect(uniformity([1, 2, 3]).p).toBeNull();
    });

    it('says INSUFFICIENT_DATA below 300 ticks and STABLE on a long fair stream', () => {
        expect(classifyRegime(randomDigits(100), OVER_2).regime).toBe('INSUFFICIENT_DATA');
        expect(classifyRegime(randomDigits(3000, 3), OVER_2).regime).toBe('STABLE');
    });

    it('flags a real shift: a stream that turns heavily to winning digits is CHANGING or UNSTABLE', () => {
        const d = [...randomDigits(900, 5), ...Array.from({ length: 200 }, () => 9)];
        expect(['CHANGING', 'UNSTABLE']).toContain(classifyRegime(d, OVER_2).regime);
        expect(cusumPeak(d, OVER_2)).toBeGreaterThan(8);
    });

    it('measures SETUP trades with a Wilson interval and the exact binomial p, and does not invent an edge on fair digits', () => {
        const s = entryStats(randomDigits(20000, 11), OVER_2, 'SETUP', 1);
        expect(s.enough).toBe(true);
        expect(s.ci!.lo).toBeLessThan(0.7);
        expect(s.ci!.hi).toBeGreaterThan(0.7);
        expect(s.pValue).toBeGreaterThan(0.01);
        expect(s.baseline).toBeCloseTo(0.7);
        expect(entryStats(randomDigits(20, 2), OVER_2, 'SETUP', 1).enough).toBe(false);
    });

    it('finds a planted edge and keeps it significant after false-discovery control; fair markets stay not significant', () => {
        // 1 -> win digit, 0 -> 7 etc: after a setup digit (<=2) the next tick is always a winning digit.
        const planted = Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? 1 : 8));
        const { rows } = scanRows({ PLANTED: planted, FAIR_A: randomDigits(6000, 21), FAIR_B: randomDigits(6000, 22) }, 1);
        const hit = rows.find(r => r.market === 'PLANTED' && r.direction === 'OVER_2' && r.method === 'SETUP')!;
        expect(hit.stats.rate).toBe(1);
        expect(hit.significant).toBe(true);
        expect(rows.filter(r => r.market.startsWith('FAIR') && r.significant)).toHaveLength(0);
    });

    it('produces a report for both directions with rolling windows', () => {
        const r = analyseMarket('R_10', randomDigits(1500, 9), 1);
        expect(r.directions.map(d => d.id)).toEqual(['OVER_2', 'UNDER_7']);
        expect(r.directions[0].rolling.map(x => x.window)).toEqual([100, 300, 1000]);
        expect(r.counts.reduce((a, b) => a + b, 0)).toBe(1500);
        expect(entryStats([], UNDER_7, 'ANY', 1).trades).toBe(0);
    });
});
