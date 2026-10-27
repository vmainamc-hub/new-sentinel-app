import { bhAdjust, binomialUpperP, chiSquareSf, normalCdf, quantile } from '../stats';

describe('distribution helpers', () => {
    it('normalCdf matches known values', () => {
        expect(normalCdf(0)).toBeCloseTo(0.5, 6);
        expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
        expect(normalCdf(-1.645)).toBeCloseTo(0.05, 3);
    });
    it('chiSquareSf matches known critical values', () => {
        expect(chiSquareSf(16.919, 9)).toBeCloseTo(0.05, 3);
        expect(chiSquareSf(21.666, 9)).toBeCloseTo(0.01, 3);
        expect(chiSquareSf(0, 9)).toBe(1);
        expect(chiSquareSf(101.879, 80)).toBeCloseTo(0.05, 3);
    });
    it('binomialUpperP is exact on a small case', () => {
        // P(X >= 3) for Binomial(4, 0.5) = 5/16
        expect(binomialUpperP(3, 4, 0.5)).toBeCloseTo(5 / 16, 10);
        expect(binomialUpperP(0, 10, 0.3)).toBe(1);
        expect(binomialUpperP(11, 10, 0.3)).toBe(0);
    });
    it('bhAdjust is monotone, bounded, and skips nulls', () => {
        const q = bhAdjust([0.001, 0.04, null, 0.03, 0.5]);
        expect(q[2]).toBeNull();
        expect(q[0]).toBeCloseTo(0.004, 6);
        expect(q[3]).toBeCloseTo(0.0533333, 4);
        expect(q[1]).toBeCloseTo(0.0533333, 4);
        expect(q[4]).toBeCloseTo(0.5, 6);
        q.forEach(v => v === null || expect(v >= 0 && v <= 1).toBe(true));
    });
    it('quantile interpolates', () => {
        expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
        expect(quantile([0, 10], 0.25)).toBe(2.5);
    });
});
