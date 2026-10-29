import { type Contract } from '../bot';
import { brainReport, choosePlan, entryDigitsOf, fallbackPlan, findCell, planFires, planLedger, replayCell, TRIGGER_COUNT, WINDOWS } from '../entry-brain';
import { mulberry32 } from '../stats';

const over2: Contract = { side: 'OVER', param: 2 };
const under7: Contract = { side: 'UNDER', param: 7 };
const over3: Contract = { side: 'OVER', param: 3 };
const under6: Contract = { side: 'UNDER', param: 6 };

const randomDigits = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};

/** After a 4 the next digit is always 9 (a win for Over 2) for the whole history; everything else is random. */
const plantedAlways = (n: number, seed: number) => {
    const r = mulberry32(seed);
    const out: number[] = [];
    while (out.length < n) {
        const d = Math.floor(r() * 10);
        out.push(d);
        if (d === 4) out.push(9);
    }
    return out.slice(0, n);
};

/** The same pattern, but only in the OLD part of the history: it stopped working in the recent windows. */
const plantedThenGone = (n: number, seed: number) => {
    const r = mulberry32(seed);
    const out: number[] = [];
    while (out.length < n) {
        const d = Math.floor(r() * 10);
        out.push(d);
        if (d === 4 && out.length < n * 0.55) out.push(9);
        else if (d === 4) out.push(r() < 0.5 ? 0 : 1); // after the pattern is gone a 4 is followed by a loser
    }
    return out.slice(0, n);
};

describe('Entry Lab: trigger digits per market', () => {
    it('studies every contract the bot trades and gives each market entry digits', () => {
        const contracts = [over2, under7, over3, under6];
        const r = brainReport({ A: randomDigits(1000, 21), B: randomDigits(1000, 22) }, ['A', 'B'], contracts, 1, 0);
        expect(r.cells).toHaveLength(8);
        r.cells.forEach(c => {
            expect(c.triggers).toHaveLength(TRIGGER_COUNT);
            expect(c.triggers[0].windows).toHaveLength(WINDOWS);
        });
        expect(findCell(r, 'A', under6)).not.toBeNull();
    });

    it('does not study a market with too few ticks and never invents an entry for it', () => {
        expect(replayCell('X', [1, 2, 3], over2, 1)).toBeNull();
        const plan = fallbackPlan(false);
        expect(plan.digits).toEqual([]);
        expect(planFires(plan, null, [1, 2, 3, 4], over2)).toBe(false);
    });

    it('finds the digit that has been followed by wins in every window, and enters on it', () => {
        const cell = replayCell('P', plantedAlways(1000, 5), over2, 1)!;
        const four = cell.triggers.find(t => t.digit === 4)!;
        expect(four).toBeDefined();
        expect(four.evidence).toBe('PROVEN');
        expect(four.passed).toBe(WINDOWS);
        expect(four.rate!).toBeGreaterThan(0.95);
        expect(cell.triggers[0].digit).toBe(4);
        const plan = choosePlan(cell, { strict: false });
        expect(plan.digits).toContain(4);
        expect(planFires(plan, cell, [1, 2, 4], over2)).toBe(true);
    });

    it('a digit that only worked in the old windows is not proven', () => {
        const cell = replayCell('G', plantedThenGone(1000, 8), over2, 1)!;
        const four = cell.all.find(t => t.digit === 4)!;
        expect(four.evidence).toBe('BEST');
        expect(four.recentOk).toBe(false);
    });

    it('fires on the entry digits and on no other digit', () => {
        const cell = replayCell('R', randomDigits(1000, 31), under6, 1)!;
        const plan = choosePlan(cell, { strict: false });
        for (let d = 0; d <= 9; d++) expect(planFires(plan, cell, [3, 3, d], under6)).toBe(plan.digits.includes(d));
    });

    it('recovery uses proven digits only when any exist, otherwise the best available', () => {
        const planted = replayCell('P', plantedAlways(1000, 9), over2, 1)!;
        const strict = entryDigitsOf(planted, true);
        expect(strict.every(t => t.evidence === 'PROVEN')).toBe(true);
        const random = replayCell('R', randomDigits(1000, 3), over3, 1)!;
        expect(entryDigitsOf(random, true).length).toBeGreaterThan(0);
        expect(choosePlan(planted, { strict: true }).strict).toBe(true);
    });

    it('is causal: ticks that have not printed yet never change the study of earlier ticks', () => {
        const a = randomDigits(1000, 11);
        const b = a.slice();
        b[999] = (b[999] + 5) % 10; // the newest tick has no printed outcome for a len=1 contract
        const ca = replayCell('A', a, over2, 1)!;
        const cb = replayCell('A', b, over2, 1)!;
        expect(cb.triggers.map(t => [t.digit, t.wins])).toEqual(ca.triggers.map(t => [t.digit, t.wins]));
    });

    it('ledger compares trigger-digit trades with a blind entry on the same markets', () => {
        const none = planLedger([{ plan: 'TRIGGER_DIGITS', baseRate: 0.7, status: 'won' }]);
        expect(none.z).toBeNull();
        const trades = Array.from({ length: 100 }, (_, i) => ({ plan: 'TRIGGER_DIGITS', baseRate: 0.7, status: (i < 90 ? 'won' : 'lost') as 'won' | 'lost' }));
        const good = planLedger(trades);
        expect(good.n).toBe(100);
        expect(good.expected).toBeCloseTo(70, 5);
        expect(good.z!).toBeGreaterThan(1.96);
        const flat = planLedger(trades.map((t, i) => ({ ...t, status: (i < 70 ? 'won' : 'lost') as 'won' | 'lost' })));
        expect(Math.abs(flat.z!)).toBeLessThan(0.1);
        expect(planLedger([{ plan: null, baseRate: 0.7, status: 'won' }]).n).toBe(0);
    });
});
