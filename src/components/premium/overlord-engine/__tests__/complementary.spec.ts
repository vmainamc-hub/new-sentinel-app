import { compareReads, type OverlordRead } from '../engine';
import { readComplementary } from '../complementary';

/** 1000 digits with the given per-digit counts, older half and newer half laid out so the edge digit can fall or rise. */
const build = (older: number[], newer: number[]): number[] => {
    const make = (counts: number[]) => counts.flatMap((n, d) => Array(n).fill(d));
    return [...make(older), ...make(newer)];
};
// digit 0 falls from 12% to 10%, 9 stays under 10%, green 4 (even), red 5 (odd, not 1)
const OVER_OLD = [60, 50, 50, 50, 70, 30, 50, 50, 45, 45];
const OVER_NEW = [50, 50, 50, 50, 70, 30, 50, 50, 55, 45];

describe('complementary Over rules', () => {
    it('passes when 0 is above 10.1% and falling, 9 is under 10%, green is even and red odd (not 1)', () => {
        const r = readComplementary(build(OVER_OLD, OVER_NEW), 'OVER');
        expect(r?.checks.map(c => c.ok)).toEqual([true, true, true, true, true]);
    });
    it('fails when the red bar is digit 1', () => {
        const old = [60, 20, 50, 50, 70, 50, 50, 50, 45, 55];
        const r = readComplementary(build(old, old), 'OVER');
        expect(r?.checks[4].ok).toBe(false);
    });
    it('needs enough digits', () => {
        expect(readComplementary([1, 2, 3], 'OVER')).toBeNull();
    });
});

describe('complementary Under rules', () => {
    it('needs green odd, red even and not 8, digit 9 above 10.1% and falling, digit 0 under 10%', () => {
        const old = [45, 50, 50, 50, 30, 70, 50, 50, 50, 105];
        const nw = [45, 50, 50, 50, 30, 70, 50, 50, 50, 95];
        const r = readComplementary(build(old, nw), 'UNDER');
        expect(r?.pass).toBe(true);
        const greenEven = readComplementary(build([40, 50, 50, 50, 120, 30, 50, 50, 50, 100], [40, 50, 50, 50, 120, 30, 50, 50, 50, 90]), 'UNDER');
        expect(greenEven?.checks[3].ok).toBe(false);
    });
    it('rejects red bar on digit 8', () => {
        const d = [45, 50, 50, 50, 50, 70, 50, 50, 30, 105];
        expect(readComplementary(build(d, d), 'UNDER')?.checks[4].ok).toBe(false);
    });
});

describe('ranking', () => {
    const read = (pass: boolean, score: number, tier: OverlordRead['tier'] = 'BEST') =>
        ({ tier, score, legacyPct: 50, complementary: { pass, passed: 0, total: 5, checks: [] } }) as unknown as OverlordRead;
    it('puts a passing market first inside a tier but never above a better tier', () => {
        expect([read(false, 90), read(true, 60)].sort(compareReads).map(r => r.score)).toEqual([60, 90]);
        expect([read(true, 60, 'BEST'), read(false, 50, 'STRONG')].sort(compareReads).map(r => r.score)).toEqual([50, 60]);
    });
});
