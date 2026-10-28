import { complementOf, DEFAULT_BOT, simulateBot, streaks, winningDigits } from '../bot';
import { crowdMap, DEFAULT_CROWD, trapSeries } from '../crowd';
import { buildDossier } from '../dossier';
import { edgeTest } from '../edge';
import { inferDecimals, pipDecimals } from '../feed';
import { breakEvenRate, mulberry32 } from '../stats';
import { assessRun } from '../viability';

describe('DBot-style simulator', () => {
    it('1 4 7 2 4 gives exactly two Over 2 trades', () => {
        const run = simulateBot([1, 4, 7, 2, 4], { side: 'OVER', param: 2 });
        expect(run.trades.map(t => [t.entryDigit, t.exitDigit, t.won])).toEqual([
            [1, 4, true],
            [2, 4, true],
        ]);
    });
    it('does not reuse the exit tick as the next entry', () => {
        expect(simulateBot([0, 0, 0, 0], { side: 'OVER', param: 2 }).trades.length).toBe(2);
    });
    it('keeps an unsettled contract open', () => {
        const run = simulateBot([5, 1], { side: 'OVER', param: 2 });
        expect(run.trades.length).toBe(0);
        expect(run.open?.entryIndex).toBe(1);
    });
    it('complements win on exactly the losing digits', () => {
        const c = { side: 'OVER' as const, param: 2 };
        expect(winningDigits(complementOf(c))).toEqual([0, 1, 2]);
        expect(complementOf(complementOf(c))).toEqual(c);
    });
    it('streaks and break-even', () => {
        expect(
            streaks(simulateBot([1, 9, 1, 9, 1, 0], { side: 'OVER', param: 2 }, DEFAULT_BOT).trades).longestWin
        ).toBe(2);
        expect(breakEvenRate(0.5, 0.05)).toBeCloseTo(0.5263, 3);
    });
});

describe('viability', () => {
    it('warms up with few trades', () => {
        expect(assessRun(simulateBot([1, 4, 7, 2, 4], { side: 'OVER', param: 2 })).state).toBe('WARMING');
    });
    it('flags hostile when the contract keeps losing', () => {
        const d: number[] = [];
        for (let i = 0; i < 200; i += 1) d.push(i % 2 ? 1 : 0);
        expect(assessRun(simulateBot(d, { side: 'OVER', param: 2 })).state).toBe('HOSTILE');
    });
});

describe('crowd', () => {
    const trapped = [
        ...Array(40)
            .fill(0)
            .map((_, i) => 5 + (i % 5)),
        ...Array(20)
            .fill(0)
            .map((_, i) => i % 3),
    ];
    it('detects Over trapped after highs then lows', () => {
        expect(trapSeries(trapped, 'OVER', DEFAULT_CROWD).state[59]).toBe(3);
        const over = crowdMap(trapped).positions.find(p => p.archetype === 'OVER');
        expect(over?.state).toBe('TRAPPED');
        expect(over?.opposite).toEqual({ side: 'UNDER', param: 3 });
    });
    it('is quiet with short history', () => {
        expect(crowdMap([1, 2, 3]).lead).toBeNull();
    });
});

describe('edge test', () => {
    it('reports TOO_FEW on short data and never EDGE on random digits', () => {
        expect(edgeTest([1, 2, 3, 4], 'OVER').verdict).toBe('TOO_FEW');
        const rand = mulberry32(3);
        const d = Array.from({ length: 4000 }, () => Math.floor(rand() * 10));
        expect(edgeTest(d, 'EVEN', undefined, undefined, 50).verdict).not.toBe('EDGE');
    });
});

describe('feed helpers', () => {
    it('handles pip sizes', () => {
        expect(pipDecimals(2)).toBe(2);
        expect(pipDecimals(0.01)).toBe(2);
        expect(pipDecimals(0.0001)).toBe(4);
        expect(pipDecimals(undefined)).toBeNull();
        expect(inferDecimals([100.1, 100.25])).toBe(2);
    });
    it('builds a dossier for a contract', () => {
        const rand = mulberry32(11);
        const digits = Array.from({ length: 800 }, () => Math.floor(rand() * 10));
        const d = buildDossier(digits, { side: 'OVER', param: 2 });
        expect(d.last20.length).toBeLessThanOrEqual(20);
        expect(d.ladder?.length).toBe(9);
    });
});
