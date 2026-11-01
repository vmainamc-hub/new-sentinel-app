import { createSentinelOverlay } from '../overlay';
import { DEFAULT_ENGINE, type EngineSettings, PROPOSITION_KEYS } from '../settings';
import { readSpecialDigits, specialDigitsFor } from '../special-digits';

// Builds 150 ticks where each digit appears at the given positions counted back from the newest tick (0 = newest); filler is 5.
const put = (spec: Record<number, number[]>): number[] => {
    const s = Array(150).fill(5);
    for (const [digit, backs] of Object.entries(spec)) for (const p of backs) s[149 - p] = Number(digit);
    return s;
};
// A digit that is clearly building: 4 prints in the last 15 ticks, 1 in the 15 before, 1 in the 30 before that.
const BUILDING = [1, 3, 6, 9, 20, 40];
// The same shape on different ticks, for when two digits build at once.
const BUILDING_B = [0, 2, 5, 8, 21, 41];
// A digit that is falling: 3 prints in the last 30 ticks, 4 in the 30 before, 5 before that.
const FALLING = [3, 20, 28, 35, 40, 50, 55, 62, 66, 70, 75, 80];

describe('special digits', () => {
    it('Over: digit 1 loses it and must be dormant or falling, digit 8 wins it and must be increasing', () => {
        expect(specialDigitsFor('OVER')).toEqual({ watched: 1, mirror: 8 });
        expect(specialDigitsFor('UNDER')).toEqual({ watched: 8, mirror: 1 });
    });

    it('holds a contract back when there are too few ticks to judge', () => {
        const r = readSpecialDigits(Array(60).fill(5), 'OVER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/ticks/);
        expect(readSpecialDigits(undefined, 'UNDER').ok).toBe(false);
    });

    it('Over passes when digit 1 is dormant and digit 8 is increasing', () => {
        expect(readSpecialDigits(put({ 8: BUILDING }), 'OVER').ok).toBe(true);
    });

    it('Over passes when digit 1 is falling and digit 8 is increasing', () => {
        const r = readSpecialDigits(put({ 1: FALLING, 8: BUILDING_B }), 'OVER');
        expect(r.counts && r.counts.watched.c30 <= r.counts.watched.b30).toBe(true);
        expect(r.ok).toBe(true);
    });

    it('Over is held back when digit 1 is building, even with digit 8 increasing', () => {
        const r = readSpecialDigits(put({ 1: BUILDING, 8: BUILDING_B }), 'OVER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/digit 1 loses this contract and is building/);
    });

    it('Over is held back when digit 8 is not increasing, even with digit 1 dormant', () => {
        const r = readSpecialDigits(put({}), 'OVER');
        expect(r.ok).toBe(false);
        expect(r.reasons[0]).toMatch(/digit 8 wins this contract but is not increasing/);
        expect(readSpecialDigits(put({ 8: FALLING }), 'OVER').ok).toBe(false);
    });

    it('catches a quiet rise of digit 8: up in each of the last three 30-tick windows', () => {
        const r = readSpecialDigits(put({ 8: [5, 18, 25, 36, 50, 75] }), 'OVER');
        expect(r.counts?.mirror).toMatchObject({ c30: 3, b30: 2, a30: 1 });
        expect(r.ok).toBe(true);
    });

    it('Under mirrors it: digit 8 dormant or falling, digit 1 increasing', () => {
        expect(readSpecialDigits(put({ 1: BUILDING }), 'UNDER').ok).toBe(true);
        expect(readSpecialDigits(put({ 8: FALLING, 1: BUILDING_B }), 'UNDER').ok).toBe(true);
        expect(readSpecialDigits(put({ 8: BUILDING, 1: BUILDING_B }), 'UNDER').ok).toBe(false);
        expect(readSpecialDigits(put({ 8: FALLING }), 'UNDER').ok).toBe(false);
    });
});

describe('the overlay applies the rule in every mode', () => {
    const cell = (side: 'OVER' | 'UNDER', param: number) => ({ symbol: 'A', contract: { side, param } }) as never;
    const build = (series: number[], m: EngineSettings['mode']) =>
        createSentinelOverlay({
            getEngine: () => ({ ...DEFAULT_ENGINE, mode: m, propositions: [...PROPOSITION_KEYS] }),
            read: () => ({ markets: 1, reads: [] }),
            series: () => ({ A: series }),
            now: () => 0,
        });
    const good = put({ 8: BUILDING });
    const bad = put({ 1: BUILDING });

    it('vetoes a building digit 1 for Over even in the Hunter', () => {
        for (const m of ['hunter', 'careful', 'balanced', 'active'] as const) {
            const o = build(bad, m);
            o.refresh?.(0, ['A']);
            expect(o.call(cell('OVER', 2), { recovering: false, now: 0 }).allow).toBe(false);
        }
    });

    it('lets a market with digit 1 dormant and digit 8 increasing through the Hunter', () => {
        const o = build(good, 'hunter');
        o.refresh?.(0, ['A']);
        expect(o.call(cell('OVER', 2), { recovering: false, now: 0 }).allow).toBe(true);
    });

    it('exposes the same rule as the buy-time guard, using the contract that would be bought', () => {
        const o = build(good, 'hunter');
        expect(o.guard?.('A', { side: 'OVER', param: 2 }, good).ok).toBe(true);
        expect(o.guard?.('A', { side: 'OVER', param: 2 }, bad).ok).toBe(false);
        expect(o.guard?.('A', { side: 'UNDER', param: 7 }, good).ok).toBe(false);
    });
});
