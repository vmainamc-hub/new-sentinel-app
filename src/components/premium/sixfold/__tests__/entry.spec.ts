import { smartEntryDigits } from '../entry';

const over2 = { side: 'OVER' as const, param: 2 };

describe('smartEntryDigits', () => {
    it('falls back to the fixed setup digits without enough history', () => {
        const r = smartEntryDigits([1, 2, 3], over2, 1);
        expect(r.source).toBe('fallback');
        expect(r.digits).toEqual([0, 1, 2]); // the digits that lose Over 2
    });

    it('learns the digits that were followed by a win and puts them in the set', () => {
        // After a 4 the next digit is always 9 (a win); after anything else it is 0 (a loss).
        const s: number[] = [];
        for (let i = 0; i < 80; i++) s.push(4, 9, 1, 0, 6, 0, 2, 0);
        const r = smartEntryDigits(s, over2, 1);
        expect(r.source).toBe('learned');
        expect(r.digits).toContain(4);
        expect(r.digits.length).toBeGreaterThanOrEqual(3);
        expect(r.digits.length).toBeLessThanOrEqual(4);
    });

    it('leaves out the digit that just lost, and changes with the market', () => {
        const s: number[] = [];
        for (let i = 0; i < 80; i++) s.push(4, 9, 1, 0, 6, 0, 2, 0);
        const a = smartEntryDigits(s, over2, 1);
        const b = smartEntryDigits(s, over2, 1, new Set([4]));
        expect(b.digits).not.toContain(4);
        expect(b.digits).not.toEqual(a.digits);
        const flipped: number[] = [];
        for (let i = 0; i < 80; i++) flipped.push(6, 9, 1, 0, 4, 0, 2, 0);
        expect(smartEntryDigits(flipped, over2, 1).digits).toContain(6);
    });

    it('never returns an empty set, even when every digit is avoided', () => {
        const all = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(smartEntryDigits([], over2, 1, all).digits.length).toBeGreaterThan(0);
        const s = Array.from({ length: 300 }, (_, i) => i % 10);
        expect(smartEntryDigits(s, over2, 1, all).digits.length).toBeGreaterThan(0);
    });
});
