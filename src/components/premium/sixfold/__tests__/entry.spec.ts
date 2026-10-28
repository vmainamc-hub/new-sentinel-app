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

import { formGateOk, lossesBeforeWin, trailingRun } from '../entry';
import { entryTest } from '../analysis';

describe('form gate and entry test', () => {
    const o2 = { side: 'OVER' as const, param: 2 };
    it('measures the winning and losing run that ends at the latest tick', () => {
        expect(trailingRun([0, 5, 6, 7], o2)).toEqual({ wins: 3, losses: 0 });
        expect(trailingRun([9, 9, 1, 0], o2)).toEqual({ wins: 0, losses: 2 });
        expect(trailingRun([], o2)).toEqual({ wins: 0, losses: 0 });
    });
    it('passes OFF always, MOMENTUM after k wins, REVERSION after k losses', () => {
        expect(formGateOk('OFF', 3, [0], o2)).toBe(true);
        expect(formGateOk('MOMENTUM', 3, [1, 5, 6, 7], o2)).toBe(true);
        expect(formGateOk('MOMENTUM', 3, [1, 1, 6, 7], o2)).toBe(false);
        expect(formGateOk('REVERSION', 2, [9, 1, 0], o2)).toBe(true);
        expect(formGateOk('REVERSION', 2, [9, 9, 0], o2)).toBe(false);
    });
    it('finds no lead in random digits, and finds a planted one', () => {
        let a = 12345;
        const rnd = () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10);
        const random = Array.from({ length: 20000 }, rnd);
        const r = entryTest({ A: random }, o2, 3);
        expect(r.baseline.rate!).toBeGreaterThan(0.65);
        expect(Math.abs(r.afterWins.edgePts!)).toBeLessThan(3);
        // Planted: after three losing digits the next one always wins.
        const planted: number[] = [];
        for (let i = 0; i < 4000; i++) planted.push(0, 1, 0, 9, 5);
        const t = entryTest({ A: planted }, o2, 3);
        expect(t.afterLosses.rate!).toBe(1);
        expect(t.afterLosses.p!).toBeLessThan(0.001);
    });
});

describe('loss run then win (BOUNCE)', () => {
    const o2 = { side: 'OVER' as const, param: 2 };
    it('counts the losses right before a winning latest tick', () => {
        expect(lossesBeforeWin([5, 0, 1, 0, 7], o2)).toBe(3);
        expect(lossesBeforeWin([5, 0, 1, 0], o2)).toBe(0); // latest tick lost
        expect(lossesBeforeWin([0, 0, 6, 7], o2)).toBe(0); // a second win in a row: the bounce has passed
        expect(lossesBeforeWin([7], o2)).toBe(0);
    });
    it('gates on k or more losses then a win', () => {
        expect(formGateOk('BOUNCE', 3, [9, 0, 1, 2, 5], o2)).toBe(true);
        expect(formGateOk('BOUNCE', 4, [9, 0, 1, 2, 5], o2)).toBe(false);
        expect(formGateOk('BOUNCE', 2, [9, 9, 0, 5], o2)).toBe(false);
    });
    it('is measured in the entry test, with a planted lead and no lead in random digits', () => {
        let a = 99;
        const rnd = () => ((a = (a * 1103515245 + 12345) & 0x7fffffff), (a >> 8) % 10);
        const random = Array.from({ length: 30000 }, rnd);
        const r = entryTest({ A: random }, o2, 2);
        expect(r.afterBounce.n).toBeGreaterThan(100);
        expect(Math.abs(r.afterBounce.edgePts!)).toBeLessThan(6);
        // Planted: 0,1,5 = two losses then a win, and the next tick always wins (9); then 0 again.
        const planted: number[] = [];
        for (let i = 0; i < 3000; i++) planted.push(0, 1, 5, 9, 4);
        const t = entryTest({ A: planted }, o2, 2);
        expect(t.afterBounce.rate!).toBe(1);
        expect(t.afterBounce.p!).toBeLessThan(0.001);
    });
});
