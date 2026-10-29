import { entryLabReport, ruleFiresNow, bestValidatedRule } from '../entry-lab';
import type { Contract } from '../bot';

const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const over2: Contract = { side: 'OVER', param: 2 };
const random = (n: number, seed: number) => {
    const r = rng(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};

describe('entry lab', () => {
    it('validates almost nothing on random digits', () => {
        const series: Record<string, number[]> = {};
        for (let i = 0; i < 10; i++) series[`M${i}`] = random(2000, 100 + i);
        const rep = entryLabReport(series, Object.keys(series), [over2, { side: 'UNDER', param: 7 }], 1);
        expect(rep.tests).toBeGreaterThan(100);
        expect(rep.validated).toBeLessThanOrEqual(1);
    });

    it('validates a rule on a planted edge and applies it', () => {
        // After 3 winning digits (3-9 for Over 2) the next digit wins more often; otherwise random.
        const r = rng(7);
        const d: number[] = [];
        for (let i = 0; i < 2000; i++) {
            const last3 = d.slice(-3);
            const planted = last3.length === 3 && last3.every(x => x > 2);
            d.push(planted && r() < 0.5 ? 3 + Math.floor(r() * 7) : Math.floor(r() * 10));
        }
        const rep = entryLabReport({ A: d }, ['A'], [over2], 1);
        const rule = bestValidatedRule(rep, 'A', over2);
        expect(rule).not.toBeNull();
        expect(ruleFiresNow('QUIET_3', [1, 5, 6, 7], over2)).toBe(true);
        expect(ruleFiresNow('QUIET_3', [5, 6, 7, 1], over2)).toBe(false);
    });

    it('needs enough ticks', () => {
        expect(entryLabReport({ A: random(100, 1) }, ['A'], [over2]).cells).toHaveLength(0);
    });
});
