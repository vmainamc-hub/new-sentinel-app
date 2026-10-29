import { hedgeStats, PICK_ODDS, pickTable, recentPickOdds } from '../dtrader-hedge';

describe('High Tick / Low Tick odds', () => {
    it('the highest of 5 ticks is far likelier at the ends: 70, 40, 36, 40, 70 out of 256', () => {
        expect(PICK_ODDS.map(p => Math.round(p * 256))).toEqual([70, 40, 36, 40, 70]);
        expect(PICK_ODDS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    });
});

describe('hedgeStats (a High Tick + Low Tick pair)', () => {
    const base = { stake: 1, highPick: 5, lowPick: 5, highPayout: 4.7, lowPayout: 4.7 };
    it('on the same tick the trades never both win: one wins or both lose', () => {
        const s = hedgeStats(base)!;
        expect(s.pBothWin).toBe(0);
        expect(s.pExactlyOne).toBeCloseTo(140 / 256, 6);
        expect(s.pNeither).toBeCloseTo(1 - 140 / 256, 6);
        expect(s.pExactlyOne + s.pNeither).toBeCloseTo(1, 6);
        expect(s.note).toMatch(/cannot both win/);
    });
    it('shows the money of each outcome: a single win pays back both stakes, a miss loses both', () => {
        const s = hedgeStats(base)!;
        expect(s.cost).toBe(2);
        expect(s.netHighOnly).toBe(2.7);
        expect(s.netNeither).toBe(-2);
        expect(s.oneWinCoversBoth).toBe(true);
    });
    it('the average is just the sum of the two trades, so a middle tick at the same payout is a loss', () => {
        const end = hedgeStats(base)!;
        const middle = hedgeStats({ ...base, highPick: 3, lowPick: 3 })!;
        expect(end.expected).toBeCloseTo(2 * (70 / 256) * 4.7 - 2, 1);
        expect(middle.expected).toBeLessThan(0);
        expect(middle.pNeither).toBeGreaterThan(0.7);
    });
    it('a fair payout leaves the average at zero; below it the average is negative', () => {
        const fair = hedgeStats({ ...base, highPayout: 256 / 70, lowPayout: 256 / 70 })!;
        expect(Math.abs(fair.expected)).toBeLessThan(0.01);
        expect(hedgeStats({ ...base, highPayout: 3.5, lowPayout: 3.5 })!.expected).toBeLessThan(0);
        expect(hedgeStats(base)!.breakEvenHigh).toBeCloseTo(256 / 70, 2);
    });
    it('different ticks can both win, and the chances add up', () => {
        const s = hedgeStats({ ...base, highPick: 1, lowPick: 5 })!;
        expect(s.pBothWin).toBeCloseTo(0.125, 2);
        expect(s.pExactlyOne + s.pBothWin + s.pNeither).toBeCloseTo(1, 3);
        expect(s.netBoth).toBeCloseTo(4.7 + 4.7 - 2, 6);
        expect(s.note).toMatch(/can both win/);
    });
    it('warns when one win would not pay back both stakes', () => {
        expect(hedgeStats({ ...base, highPayout: 1.9, lowPayout: 1.9 })!.oneWinCoversBoth).toBe(false);
    });
    it('returns nothing for bad input', () => {
        expect(hedgeStats({ ...base, highPick: 6 })).toBeNull();
        expect(hedgeStats({ ...base, stake: 0 })).toBeNull();
        expect(hedgeStats({ ...base, highPayout: NaN })).toBeNull();
    });
});

describe('pickTable and recentPickOdds', () => {
    it('turns quotes into the average result per 1 staked for each tick', () => {
        const rows = pickTable(1, [{ high: 4, low: 4 }, { high: 4, low: null }, { high: 4, low: 4 }, { high: 4, low: 4 }, { high: 4, low: 4 }]);
        expect(rows[0].highEdge).toBeCloseTo((70 / 256) * 4 - 1, 3);   // positive at the ends if the payout were this high
        expect(rows[2].highEdge).toBeLessThan(0);
        expect(rows[1].lowPayout).toBeNull();
        expect(rows[1].lowEdge).toBeNull();
        expect(rows[0].recentOdds).toBeNull();
    });
    it('measures how often each tick of a 5-tick stretch was the strict high or low', () => {
        const rising = Array.from({ length: 200 }, (_, i) => i);   // always highest at tick 5, lowest at tick 1
        const r = recentPickOdds(rising);
        expect(r.windows).toBe(196);
        expect(r.high[4]).toBe(1);
        expect(r.low[0]).toBe(1);
        expect(recentPickOdds([5, 5, 5, 5, 5, 5]).high.every(x => x === 0)).toBe(true);   // ties are not wins
        expect(recentPickOdds([1, 2]).windows).toBe(0);
    });
    it('on a random walk the ends win about 27%, as the model says', () => {
        let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
        let p = 0; const walk = Array.from({ length: 6000 }, () => (p += rnd() - 0.5));
        const r = recentPickOdds(walk, 5000);
        expect(r.high[0]).toBeGreaterThan(0.22); expect(r.high[0]).toBeLessThan(0.33);
        expect(r.high[2]).toBeLessThan(0.2);
    });
});
