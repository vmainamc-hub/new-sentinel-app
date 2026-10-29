import { bestTicks, coverStats, tickEdge, type TickQuote } from '../dtrader-hedge';
import { afterEntry, freshRisk, NO_RISK, recoveryStake } from '../dtrader-risk';

const flat = (high: number, low = high): TickQuote[] => [1, 2, 3, 4, 5].map(() => ({ high, low }));

describe('coverStats', () => {
    it('one pair on an end tick: 55% have a winner, 45% lose both', () => {
        const s = coverStats(1, [5], [5], null)!;
        expect(s.trades).toBe(2);
        expect(s.pLoseAll).toBeCloseTo(1 - 140 / 256, 2);
        expect(s.pAtLeastOne).toBeCloseTo(140 / 256, 2);
        expect(s.expected).toBeNull();
    });
    it('High and Low on both end ticks: 84% have a winner, and chances add up', () => {
        const s = coverStats(1, [1, 5], [1, 5], null)!;
        expect(s.trades).toBe(4);
        expect(s.pAtLeastOne).toBeCloseTo(0.844, 2);
        expect(s.outcomes.reduce((a, o) => a + o.chance, 0)).toBeCloseTo(1, 6);
        expect(s.outcomes.find(o => o.wins === 2)!.chance).toBeCloseTo(0.25, 1);   // the highest and lowest are both at the ends
    });
    it('covering every tick on both sides always has a winner', () => {
        const s = coverStats(1, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], null)!;
        expect(s.pLoseAll).toBeLessThan(0.0005);
        expect(s.note).toMatch(/at least one winning/);
    });
    it('with quotes: average result, chance of profit and whether a single win pays for every stake', () => {
        const s = coverStats(1, [1, 5], [1, 5], flat(4.7))!;
        expect(s.cost).toBe(4);
        expect(s.expected).toBeCloseTo(4 * (70 / 256) * 4.7 - 4, 1);
        expect(s.singleWinCovers).toBe(true);
        expect(s.worstSingleWinNet).toBeCloseTo(0.7, 6);
        expect(s.pProfit).toBeCloseTo(s.pAtLeastOne, 6);
        const poor = coverStats(1, [1, 5], [1, 5], flat(3.5))!;
        expect(poor.singleWinCovers).toBe(false);
        expect(poor.pProfit!).toBeLessThan(poor.pAtLeastOne);   // a lone win is still a loss, only two winners make money
        expect(poor.note).toMatch(/does NOT pay back/);
    });
    it('needs a quote for every ticked pick, and a stake and at least one trade', () => {
        const partial = flat(4.7); partial[0] = { high: null, low: 4.7 };
        expect(coverStats(1, [1], [5], partial)!.expected).toBeNull();
        expect(coverStats(1, [], [], null)).toBeNull();
        expect(coverStats(0, [5], [5], null)).toBeNull();
        expect(coverStats(1, [5, 5, 9, 0], [], null)!.trades).toBe(1);   // duplicates and out-of-range picks are dropped
    });
});

describe('bestTicks', () => {
    it('without quotes the end ticks come first', () => {
        expect(bestTicks('high', 1, 1, null)).toEqual([5]);
        expect(bestTicks('low', 2, 1, null)).toEqual([1, 5]);
        expect(bestTicks('high', 3, 1, null)).toEqual([1, 2, 5]);
    });
    it('with quotes it follows the average result, and skips ticks Deriv did not quote', () => {
        const q = flat(4); q[2] = { high: 20, low: 4 }; q[4] = { high: null, low: 4 };
        expect(bestTicks('high', 1, 1, q)).toEqual([3]);            // 36/256 x 20 beats 70/256 x 4
        expect(bestTicks('high', 2, 1, q)).toEqual([1, 3]);         // tick 5 was not quoted
        expect(bestTicks('low', 1, 1, q)).toEqual([5]);
        expect(tickEdge(5, 4, 1)).toBeCloseTo((70 / 256) * 4 - 1, 6);
    });
});

describe('loss breaker, cool-down and recovery stake', () => {
    it('counts losing entries in a row, and a win clears the streak and pays down the deficit', () => {
        let step = afterEntry(freshRisk(), -2, NO_RISK);
        step = afterEntry(step.state, -2, NO_RISK);
        expect(step.state).toMatchObject({ lossStreak: 2, deficit: 4 });
        step = afterEntry(step.state, 2.7, NO_RISK);
        expect(step.state).toMatchObject({ lossStreak: 0, deficit: 1.3 });
        expect(afterEntry(step.state, 5, NO_RISK).state).toMatchObject({ deficit: 0, steps: 0 });
    });
    it('breaker: stop, pause or reset after N losing entries', () => {
        const base = { ...NO_RISK, breakerAfter: 2 };
        expect(afterEntry(freshRisk(), -1, base).stop).toBeUndefined();   // one losing entry is under the limit
        const stop = afterEntry(afterEntry(freshRisk(), -1, { ...base, breakerAction: 'stop' }).state, -1, { ...base, breakerAction: 'stop' });
        expect(stop.stop).toMatch(/2 losing entries in a row/);
        const pause = afterEntry(afterEntry(freshRisk(), -1, { ...base, breakerAction: 'pause', pauseTicks: 15 }).state, -1, { ...base, breakerAction: 'pause', pauseTicks: 15 });
        expect(pause).toMatchObject({ waitTicks: 15, state: { lossStreak: 0 } });
        const reset = afterEntry(afterEntry(freshRisk(), -1, { ...base, breakerAction: 'reset' }).state, -1, { ...base, breakerAction: 'reset' });
        expect(reset).toMatchObject({ resetStake: true, state: { deficit: 0, lossStreak: 0 } });
    });
    it('cool-down waits after a loss, not after a win', () => {
        const cool = { ...NO_RISK, cooldownTicks: 3 };
        expect(afterEntry(freshRisk(), -1, cool).waitTicks).toBe(3);
        expect(afterEntry(freshRisk(), 1, cool).waitTicks).toBe(0);
    });
    it('a break-even entry changes nothing', () => {
        expect(afterEntry({ lossStreak: 2, deficit: 3, steps: 1 }, 0, NO_RISK).state).toEqual({ lossStreak: 2, deficit: 3, steps: 1 });
    });
    it('recovery stake: what one win needs to pay back the deficit', () => {
        expect(recoveryStake({ base: 1, deficit: 0, target: 0, winNetPerStake: 2.7, steps: 0, maxSteps: 4 })).toBe(1);
        expect(recoveryStake({ base: 1, deficit: 4, target: 0, winNetPerStake: 2.7, steps: 1, maxSteps: 4 })).toBeCloseTo(1.48, 2);
        expect(recoveryStake({ base: 1, deficit: 4, target: 1, winNetPerStake: 2.7, steps: 1, maxSteps: 4 })).toBeCloseTo(1.85, 2);
        expect(recoveryStake({ base: 1, deficit: 0.5, target: 0, winNetPerStake: 2.7, steps: 0, maxSteps: 4 })).toBe(1);   // never below the base
        expect(recoveryStake({ base: 1, deficit: 4, target: 0, winNetPerStake: 2.7, steps: 4, maxSteps: 4 })).toBeNull();  // step limit
        expect(recoveryStake({ base: 1, deficit: 4, target: 0, winNetPerStake: 0, steps: 0, maxSteps: 4 })).toBeNull();    // a win cannot pay for itself
    });
});
