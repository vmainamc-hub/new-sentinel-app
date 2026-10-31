import { mulberry32 } from '@/components/premium/sixfold/stats';
import { compileRule, describeRule, normalizeRule, ruleKey } from '../rules';
import { LabRunner, normalizeLab } from '../lab';

const fair = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};
/** After a 4 the next tick is always 9 (a win for OVER 2) when the 4 follows two winning digits; otherwise random. A real, learnable pattern. */
const patterned = (n: number, seed: number) => {
    const r = mulberry32(seed);
    const out: number[] = [];
    while (out.length < n) {
        const d = Math.floor(r() * 10);
        out.push(d);
        if (d === 4 && out.length >= 3 && out[out.length - 2] > 2 && out[out.length - 3] > 2) out.push(9);
        else if (d === 4) out.push(Math.floor(r() * 10));
    }
    return out.slice(0, n);
};
const runSync = (lab: LabRunner, cfg: any) => {
    lab.start(cfg);
    for (let i = 0; i < 200 && lab.getSnapshot().state === 'running'; i++) lab.step();
    return lab.getSnapshot();
};

describe('rules', () => {
    it('fires on the current digit and checks only earlier ticks', () => {
        const over2 = { side: 'OVER' as const, param: 2 };
        const r = compileRule({ digits: [4], prev: { kind: 'ALL_WIN', k: 2 } }, over2);
        expect(r([5, 6, 4])).toBe(true);
        expect(r([1, 6, 4])).toBe(false); // one earlier digit loses
        expect(r([5, 6, 7])).toBe(false); // current digit not in set
        expect(r([6, 4])).toBe(false); // not enough history
        const lose = compileRule({ digits: [4], prev: { kind: 'ALL_LOSE', k: 1 } }, over2);
        expect(lose([1, 4])).toBe(true);
        expect(lose([5, 4])).toBe(false);
        expect(compileRule({ digits: [4], prev: { kind: 'ANY', k: 0 } }, over2)([4])).toBe(true);
    });
    it('normalises, keys and describes rules', () => {
        const a = normalizeRule({ digits: [4, 4, 2, 11], prev: { kind: 'ALL_WIN', k: 99 } });
        expect(a).toEqual({ digits: [2, 4], prev: { kind: 'ALL_WIN', k: 5 } });
        expect(ruleKey(a)).toBe('24|ALL_WIN5');
        expect(describeRule(a, 'OVER_2')).toContain('Over 2');
    });
});

describe('LabRunner', () => {
    const base = { population: 40, generations: 8, seed: 3, keep: 6 };

    it('uses a time-ordered train/validation split fixed at start (no leakage from later ticks)', () => {
        const series: Record<string, number[]> = { A: fair(2000, 1) };
        const lab = new LabRunner(() => series);
        lab.start(base);
        expect(lab.getSnapshot().ticks).toEqual({ train: 1200, validation: 800 });
        series.A.push(...fair(500, 9)); // ticks arriving later must not enter the run
        for (let i = 0; i < 50 && lab.getSnapshot().state === 'running'; i++) lab.step();
        expect(lab.getSnapshot().ticks).toEqual({ train: 1200, validation: 800 });
    });

    it('on fair random digits nothing passes validation, and the lab says so', () => {
        const series = { A: fair(2500, 21), B: fair(2500, 22), C: fair(2500, 23) };
        const snap = runSync(new LabRunner(() => series), { ...base, seed: 5 });
        expect(snap.state).toBe('done');
        expect(snap.results.length).toBeGreaterThan(0);
        expect(snap.results.filter(r => r.passed)).toHaveLength(0);
        expect(snap.note).toMatch(/None of the/);
    });

    it('finds a real planted pattern and it holds up on the unseen part', () => {
        const series = { A: patterned(6000, 31), B: patterned(6000, 32), C: patterned(6000, 33) };
        const snap = runSync(new LabRunner(() => series), { ...base, direction: 'OVER_2', population: 80, generations: 14, seed: 7, keep: 8 });
        const winners = snap.results.filter(r => r.passed);
        expect(winners.length).toBeGreaterThan(0);
        expect(winners[0].validation.rate!).toBeGreaterThan(0.9);
        expect(winners[0].rule.digits).toContain(4); // triggers on the 4; the next tick is the planted 9
    });

    it('is deterministic for a seed, and honours pause/resume/stop', () => {
        const series = { A: fair(2000, 41), B: fair(2000, 42) };
        const a = runSync(new LabRunner(() => series), { ...base, seed: 11 });
        const b = runSync(new LabRunner(() => series), { ...base, seed: 11 });
        expect(a.results.map(r => r.description)).toEqual(b.results.map(r => r.description));
        const lab = new LabRunner(() => series);
        lab.start(base);
        lab.pause();
        expect(lab.getSnapshot().state).toBe('paused');
        lab.step(); // paused: step is a no-op
        expect(lab.getSnapshot().generation).toBe(0);
        lab.resume();
        expect(lab.getSnapshot().state).toBe('running');
        lab.stop();
        expect(lab.getSnapshot().state).toBe('stopped');
        expect(lab.getSnapshot().results).toHaveLength(0);
    });

    it('reports when there is not enough data and clamps config', () => {
        const lab = new LabRunner(() => ({ A: fair(50, 1) }));
        lab.start({});
        expect(lab.getSnapshot().state).toBe('stopped');
        expect(lab.getSnapshot().note).toMatch(/200\+ ticks/);
        expect(normalizeLab({ population: 99999, generations: -3, trainFraction: 0.99 })).toMatchObject({ population: 400, generations: 1, trainFraction: 0.8 });
    });

    it('calls onFinished once with the results', () => {
        const got: any[] = [];
        const lab = new LabRunner(() => ({ A: fair(2000, 51) }), r => got.push(r));
        runSync(lab, base);
        expect(got).toHaveLength(1);
        expect(got[0].length).toBeGreaterThan(0);
    });
});
