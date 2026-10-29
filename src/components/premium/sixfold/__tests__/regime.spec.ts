import { mulberry32 } from '../stats';
import { classify, computeRegime, meterTrackRecord, regimeCell, strengthOf, summarize } from '../regime';

const over2 = { side: 'OVER' as const, param: 2 };
const under7 = { side: 'UNDER' as const, param: 7 };
const rnd = (seed: number, n: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
// Over 2 wins on 3-9, loses on 0-2.
const WIN = 6;
const LOSS = 1;

describe('regime states', () => {
    it('classifies cold, turning, hot and normal', () => {
        expect(classify(0, 4, 0, 0)).toBe('COLD');
        expect(classify(-1.6, 0, 1, 0)).toBe('COLD');
        expect(classify(0, 0, 2, 3)).toBe('TURNING');
        expect(classify(1.2, 0, 5, 0)).toBe('HOT');
        expect(classify(0.2, 1, 0, 0)).toBe('NORMAL');
    });
    it('scores strength around 50 and keeps it in 0-100', () => {
        expect(strengthOf(0, 0, 'NORMAL')).toBe(50);
        expect(strengthOf(2, 0, 'HOT')).toBe(74);
        expect(strengthOf(-9, 8, 'COLD')).toBe(0);
        expect(strengthOf(9, 0, 'HOT')).toBe(100);
        expect(strengthOf(0, 0, 'TURNING')).toBe(58);
    });
});

describe('regimeCell', () => {
    it('needs 60 ticks', () => {
        expect(regimeCell('A', [1, 2, 3], over2)).toBeNull();
    });
    it('reads a loss cluster from a run of losing digits', () => {
        const d = [...rnd(3, 100), WIN, LOSS, LOSS, LOSS, LOSS, LOSS];
        const c = regimeCell('A', d, over2)!;
        expect(c.lossRun).toBe(5);
        expect(c.state).toBe('COLD');
        expect(c.strip).toHaveLength(24);
        expect(c.strip.slice(-5)).toEqual([false, false, false, false, false]);
    });
    it('reads TURNING after a loss run followed by wins', () => {
        const d = [...rnd(4, 100).map(() => WIN), LOSS, LOSS, LOSS, WIN, WIN];
        const c = regimeCell('A', d, over2)!;
        expect(c.winRun).toBe(2);
        expect(c.state).toBe('TURNING');
    });
    it('reads HOT from a long run of wins', () => {
        const d = [...rnd(5, 100), ...Array(30).fill(WIN)];
        expect(regimeCell('A', d, over2)!.state).toBe('HOT');
    });
    it('finds clusters of wins and losses, and not in random digits', () => {
        const block: number[] = [];
        for (let b = 0; b < 40; b++) for (let i = 0; i < 20; i++) block.push(b % 2 === 0 ? WIN : LOSS);
        expect(regimeCell('A', block, over2)!.clusterP!).toBeLessThan(0.001);
        const random = rnd(9, 1000);
        expect(regimeCell('A', random, over2)!.clusterP!).toBeGreaterThan(0.01);
    });
});

describe('verdict', () => {
    const series = (f: (i: number) => number, n = 200) => Array.from({ length: n }, (_, i) => f(i));
    it('says LOADING with no cells', () => {
        expect(summarize([], 0).verdict).toBe('LOADING');
        expect(computeRegime({}, ['A'], [over2], 0).verdict).toBe('LOADING');
    });
    it('says AVOID when most markets are in a loss cluster', () => {
        const cold = { A: series(() => LOSS), B: series(() => LOSS), C: series(() => LOSS) };
        const r = computeRegime(cold, ['A', 'B', 'C'], [over2], 0);
        expect(r.counts.COLD).toBe(3);
        expect(r.verdict).toBe('AVOID');
    });
    it('says GO when markets are winning and none are cold', () => {
        const hot = { A: series(() => WIN), B: series(() => WIN), C: series(() => WIN) };
        const r = computeRegime(hot, ['A', 'B', 'C'], [over2], 0);
        expect(r.verdict).toBe('GO');
        expect(r.meter).toBeGreaterThanOrEqual(50);
    });
    it('covers every market and every contract', () => {
        const r = computeRegime({ A: rnd(1, 300), B: rnd(2, 300) }, ['A', 'B'], [over2, under7], 5);
        expect(r.cells).toHaveLength(4);
        expect(r.total).toBe(4);
        expect(['GO', 'WAIT', 'AVOID']).toContain(r.verdict);
    });
});

describe('meterTrackRecord', () => {
    it('finds no lead in random digits', () => {
        const series: Record<string, number[]> = {};
        for (let m = 0; m < 6; m++) series['M' + m] = rnd(100 + m, 5000);
        const t = meterTrackRecord(series, Object.keys(series), [over2, under7], 1);
        expect(t.ticks).toBeGreaterThan(30000);
        expect(Math.abs(t.restVsCold.diffPts!)).toBeLessThan(3);
        expect(t.informative).toBe(false);
    });
    it('finds a planted pattern: loss clusters are followed by more losses', () => {
        // 28 wins then 12 losses, over and over: the overall win rate is normal, but once a loss cluster starts it continues.
        const e: number[] = [];
        for (let i = 0; i < 300; i++) e.push(...Array(28).fill(WIN), ...Array(12).fill(LOSS));
        const u = meterTrackRecord({ A: e }, ['A'], [over2], 1);
        expect(u.states.COLD.rate!).toBeLessThan(0.5);
        expect(u.restVsCold.diffPts!).toBeGreaterThan(20);
        expect(u.informative).toBe(true);
    });
    it('reports too little history instead of guessing', () => {
        const t = meterTrackRecord({ A: rnd(1, 200) }, ['A'], [over2], 1);
        expect(t.restVsCold.p).toBeNull();
        expect(t.informative).toBe(false);
    });
});

import { computeRegimeFromSnapshot } from '../regime';

describe('digits in the strip and per-market updates', () => {
    it('keeps the digits behind each square, oldest first', () => {
        const d = [...rnd(11, 80), 4, 1, 4, 1];
        const c = regimeCell('A', d, over2)!;
        expect(c.digits).toHaveLength(24);
        expect(c.digits.slice(-4)).toEqual([4, 1, 4, 1]);
        expect(c.strip.slice(-4)).toEqual([true, false, true, false]); // Over 2: 4 wins, 1 loses
        const u = regimeCell('A', d, under7)!;
        expect(u.strip.slice(-4)).toEqual([true, true, true, true]); // Under 7: both win
    });
    it('recomputes a market only when that market got new ticks', () => {
        const a = rnd(21, 200);
        const b = rnd(22, 200);
        const first = computeRegimeFromSnapshot({ A: a, B: b }, ['A', 'B'], [over2], 0);
        const again = computeRegimeFromSnapshot({ A: a, B: b }, ['A', 'B'], [over2], 1);
        expect(again.cells[0].strip).toBe(first.cells[0].strip); // same arrays: nothing recomputed
        expect(again.cells[1].strip).toBe(first.cells[1].strip);
        const a2 = [...a, 5]; // only A ticked
        const next = computeRegimeFromSnapshot({ A: a2, B: b }, ['A', 'B'], [over2], 2);
        expect(next.cells[0].strip).not.toBe(first.cells[0].strip);
        expect(next.cells[1].strip).toBe(first.cells[1].strip);
    });
});
