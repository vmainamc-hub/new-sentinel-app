import {
    autoSide, describeEntry, digitStats, digitWins, entryError, type EntryRule,
exposureError, legsFor, matchEntry, nextStake, offsetError, parseSequence, planBurst,
    predictionError, stopReason, toCandles, } from '../dtrader-engine';

describe('parseSequence', () => {
    it('reads spaced, comma and compact digits', () => {
        expect(parseSequence('1 2 5')).toEqual([1, 2, 5]);
        expect(parseSequence('1,2,5')).toEqual([1, 2, 5]);
        expect(parseSequence('1 → 2 → 5')).toEqual([1, 2, 5]);
        expect(parseSequence('125')).toEqual([1, 2, 5]);
    });
    it('rejects anything that is not a single digit', () => {
        expect(parseSequence('')).toBeNull();
        expect(parseSequence('1 22 5')).toBeNull();
        expect(parseSequence('a b')).toBeNull();
        expect(parseSequence('1 2 3 4 5 6 7 8 9 0 1 2 3')).toBeNull();
    });
});

describe('matchEntry', () => {
    const seq = (digits: number[], fireAfter = digits.length): EntryRule => ({ mode: 'pattern', pattern: { kind: 'sequence', digits, fireAfter } });
    it('instant fires as soon as there is a tick', () => {
        expect(matchEntry([], { mode: 'instant' })).toBe(false);
        expect(matchEntry([4], { mode: 'instant' })).toBe(true);
    });
    it('digit mode compares the newest digit', () => {
        expect(matchEntry([3, 8], { mode: 'digit', op: '=', digit: 8 })).toBe(true);
        expect(matchEntry([3, 8], { mode: 'digit', op: '<', digit: 8 })).toBe(false);
        expect(matchEntry([3, 8], { mode: 'digit', op: 'even', digit: 0 })).toBe(true);
    });
    it('"last N" needs every one of the last N digits to pass', () => {
        const rule = (count: number): EntryRule => ({ mode: 'pattern', pattern: { kind: 'last', count, op: '>=', digit: 5 } });
        expect(matchEntry([1, 5, 9], rule(2))).toBe(true);
        expect(matchEntry([9, 4, 9], rule(2))).toBe(false);
        expect(matchEntry([9], rule(2))).toBe(false);
    });
    it('"same" means the last N digits are all equal to each other', () => {
        const rule: EntryRule = { mode: 'pattern', pattern: { kind: 'last', count: 3, op: 'same', digit: 0 } };
        expect(matchEntry([1, 7, 7, 7], rule)).toBe(true);
        expect(matchEntry([7, 7, 3], rule)).toBe(false);
    });
    it('a sequence fires only when the digits printed in that order', () => {
        expect(matchEntry([9, 1, 2, 5], seq([1, 2, 5]))).toBe(true);
        expect(matchEntry([9, 1, 2], seq([1, 2, 5]))).toBe(false);
        expect(matchEntry([9, 2, 1, 5], seq([1, 2, 5]))).toBe(false);
    });
    it('a sequence can fire after an earlier step (fireAfter)', () => {
        expect(matchEntry([9, 1, 2], seq([1, 2, 5], 2))).toBe(true);
        expect(matchEntry([9, 2, 1], seq([1, 2, 5], 2))).toBe(false);
        expect(matchEntry([1], seq([1, 2, 5], 1))).toBe(true);
    });
});

describe('entry rule text and validation', () => {
    it('describes rules in plain words', () => {
        expect(describeEntry({ mode: 'instant' })).toMatch(/Instant/);
        expect(describeEntry({ mode: 'pattern', pattern: { kind: 'sequence', digits: [1, 2, 5], fireAfter: 2 } })).toBe('Pattern: digits 1 → 2 → 5, buy after the 2nd');
        expect(describeEntry({ mode: 'pattern', pattern: { kind: 'last', count: 2, op: '>=', digit: 9 } })).toMatch(/last 2 digits all ≥ 9/);
    });
    it('flags impossible rules', () => {
        expect(entryError({ mode: 'digit', op: '=', digit: 12 })).toMatch(/0 to 9/);
        expect(entryError({ mode: 'pattern', pattern: { kind: 'sequence', digits: [], fireAfter: 0 } })).toMatch(/digits/);
        expect(entryError({ mode: 'pattern', pattern: { kind: 'last', count: 0, op: 'same', digit: 0 } })).toMatch(/length/);
        expect(entryError({ mode: 'instant' })).toBeNull();
    });
});

describe('contracts', () => {
    it('Over takes 0-8, Under takes 1-9, both sides need both to be valid', () => {
        expect(predictionError('overunder', 'first', 9)).toMatch(/0 to 8/);
        expect(predictionError('overunder', 'second', 0)).toMatch(/1 to 9/);
        expect(predictionError('overunder', 'second', 9)).toBeNull();
        expect(predictionError('overunder', 'both', 9)).not.toBeNull();
        expect(predictionError('overunder', 'both', 5)).toBeNull();
        expect(predictionError('evenodd', 'first', 99)).toBeNull();
    });
    it('builds the legs one entry buys', () => {
        expect(legsFor('overunder', 'second', 8)).toEqual([{ contract: 'DIGITUNDER', barrier: '8', label: 'Under 8', sideIndex: 1 }]);
        expect(legsFor('overunder', 'both', 4).map(l => l.contract)).toEqual(['DIGITOVER', 'DIGITUNDER']);
        expect(legsFor('evenodd', 'first', 0)[0]).toEqual({ contract: 'DIGITEVEN', label: 'Even', sideIndex: 0 });
        expect(legsFor('risefall', 'second', 0)[0].contract).toBe('PUT');
    });
    it('builds Higher/Lower and Ends Between/Outside with offsets from the entry spot', () => {
        expect(legsFor('highlow', 'first', 0, 0.5)[0]).toMatchObject({ contract: 'CALL', barrier: '+0.5', label: 'Higher ±0.5' });
        expect(legsFor('highlow', 'second', 0, 0.5)[0]).toMatchObject({ contract: 'PUT', barrier: '-0.5' });
        expect(legsFor('range', 'first', 0, 2)[0]).toMatchObject({ contract: 'EXPIRYRANGE', barrier: '+2', barrier2: '-2' });
        expect(legsFor('range', 'second', 0, 2)[0]).toMatchObject({ contract: 'EXPIRYMISS', barrier: '+2', barrier2: '-2' });
        expect(offsetError('highlow', 0)).not.toBeNull();
        expect(offsetError('highlow', 0.5)).toBeNull();
        expect(offsetError('overunder', 0)).toBeNull();
    });
    it('knows which final digits win', () => {
        expect(digitWins('overunder', 0, 3, 4)).toBe(true);
        expect(digitWins('overunder', 1, 3, 3)).toBe(false);
        expect(digitWins('matchesdiffers', 1, 3, 3)).toBe(false);
        expect(digitWins('evenodd', 1, 0, 7)).toBe(true);
    });
    it('auto picks the side that has been hitting more often (a description of the past only)', () => {
        const mostlyLow = [0, 1, 2, 3, 1, 0, 2, 9];
        expect(autoSide('overunder', mostlyLow, 4)).toBe('second');
        expect(autoSide('overunder', [9, 8, 9, 7], 4)).toBe('first');
        expect(autoSide('risefall', [1, 2], 0)).toBe('first');
    });
});

describe('planBurst (the same-tick guard)', () => {
    it('sends everything when it all fits before the next tick', () => {
        const plan = planBurst({ legs: 1, perLeg: 5, intervalMs: 2000, elapsedMs: 0, perBuyMs: 100, guard: true });
        expect(plan).toMatchObject({ perLeg: 5, total: 5, capped: false });
    });
    it('trims a burst that cannot reach Deriv in time, and says so', () => {
        const plan = planBurst({ legs: 1, perLeg: 20, intervalMs: 1000, elapsedMs: 0, perBuyMs: 150, guard: true });
        expect(plan.capped).toBe(true);
        expect(plan.total).toBeLessThan(20);
        expect(plan.note).toMatch(/share one entry tick and one exit tick/);
    });
    it('keeps both sides equal when it trims a two-sided entry', () => {
        const plan = planBurst({ legs: 2, perLeg: 20, intervalMs: 1000, elapsedMs: 0, perBuyMs: 150, guard: true });
        expect(plan.total % 2).toBe(0);
        expect(plan.perLeg * 2).toBe(plan.total);
    });
    it('with the guard off, sends exactly what was asked', () => {
        expect(planBurst({ legs: 1, perLeg: 20, intervalMs: 1000, elapsedMs: 0, perBuyMs: 150, guard: false })).toMatchObject({ total: 20, capped: false });
    });
    it('never sends fewer than one trade per leg', () => {
        expect(planBurst({ legs: 2, perLeg: 10, intervalMs: 1000, elapsedMs: 900, perBuyMs: 150, guard: true }).perLeg).toBe(1);
    });
});

describe('stake and stops', () => {
    it('multiplies after a losing entry and resets after a win', () => {
        expect(nextStake(1, 1, -1, 2)).toBe(2);
        expect(nextStake(1, 2, -2, 2)).toBe(4);
        expect(nextStake(1, 4, 3, 2)).toBe(1);
        expect(nextStake(1, 3, -1, 1)).toBe(3);
    });
    it('stops on take profit or stop loss, and 0 means off', () => {
        expect(stopReason(20, 20, 100)).toMatch(/Take profit/);
        expect(stopReason(-100, 20, 100)).toMatch(/Stop loss/);
        expect(stopReason(500, 0, 0)).toBeNull();
        expect(stopReason(5, 20, 100)).toBeNull();
    });
    it('refuses an entry whose total stake passes the exposure limit', () => {
        expect(exposureError(100, 30)).toMatch(/limit/);
        expect(exposureError(10, 20)).toBeNull();
    });
});

describe('chart helpers', () => {
    it('counts digit percentages over a window', () => {
        const stats = digitStats([1, 1, 2, 3], 4);
        expect(stats.pct[1]).toBe(50);
        expect(stats.most).toBe(1);
        expect(stats.total).toBe(4);
        expect(digitStats([], 10).total).toBe(0);
    });
    it('groups ticks into candles anchored on the newest tick', () => {
        const prices = [1, 2, 3, 4, 5, 6, 7];
        const times = prices.map(p => p * 1000);
        const candles = toCandles(prices, times, 3);
        expect(candles.map(c => [c.open, c.close])).toEqual([[1, 1], [2, 4], [5, 7]]);
        expect(candles[2]).toMatchObject({ high: 7, low: 5 });
    });
});
