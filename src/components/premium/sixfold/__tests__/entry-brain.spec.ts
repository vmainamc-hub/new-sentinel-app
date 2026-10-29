import { type Contract } from '../bot';
import { ARMS, brainReport, choosePlan, fallbackPlan, Fit, findCell, planFires, planLedger, replayCell } from '../entry-brain';
import { mulberry32 } from '../stats';

const over2: Contract = { side: 'OVER', param: 2 };

const randomDigits = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};

/** Digits where a 4 is always followed (len=1) by a 9 (win for Over 2) and everything else is random. */
const planted = (n: number, seed: number) => {
    const r = mulberry32(seed);
    const out: number[] = [];
    while (out.length < n) {
        const d = Math.floor(r() * 10);
        out.push(d);
        if (d === 4) out.push(9);
    }
    return out.slice(0, n);
};

describe('Entry Brain', () => {
    it('always produces a plan, even with no history at all', () => {
        const rng = mulberry32(1);
        const plan = choosePlan(null, { rng, maxWaitTicks: 40, strict: false });
        expect(plan.label.length).toBeGreaterThan(0);
        expect(plan).toEqual(fallbackPlan(false));
        const strict = choosePlan(null, { rng, maxWaitTicks: 40, strict: true });
        expect(strict.aiLock).toBe(true);
        expect(replayCell('X', [1, 2, 3], over2, 1)).toBeNull();
    });

    it('gives every ready market and contract a plan, including when arms are excluded', () => {
        const cell = replayCell('R', randomDigits(900, 7), over2, 1)!;
        expect(cell).not.toBeNull();
        const rng = mulberry32(3);
        const tried: string[] = [];
        for (let k = 0; k < ARMS.length + 2; k++) {
            const plan = choosePlan(cell, { rng, maxWaitTicks: 40, strict: false, exclude: tried as never[] });
            expect(plan.arm).toBeTruthy();
            tried.push(plan.arm);
        }
    });

    it('is causal: changing ticks after a point never changes what the Brain knew at that point', () => {
        const a = randomDigits(700, 11);
        const b = a.slice();
        for (let i = 600; i < 700; i++) b[i] = (b[i] + 5) % 10; // rewrite the future
        const winA = new Set([3, 4, 5, 6, 7, 8, 9]);
        const fitA = new Fit(winA, 0.7, 1, a.length);
        const fitB = new Fit(winA, 0.7, 1, b.length);
        for (let i = 0; i < 599; i++) {
            fitA.learn(a, i - 1);
            fitA.observe(a, i);
            fitB.learn(b, i - 1);
            fitB.observe(b, i);
            for (const arm of ARMS) expect(fitA.fires(arm.id, a, i)).toBe(fitB.fires(arm.id, b, i));
        }
    });

    it('learns a planted structure: the learned digit set and the AI model both find it', () => {
        const digits = planted(1200, 5);
        const cell = replayCell('P', digits, over2, 1)!;
        expect(cell.learnedDigits).toContain(4);
        const learned = cell.arms.find(a => a.arm === 'LEARNED_DIGITS')!;
        expect(learned.rate!).toBeGreaterThan(cell.theoretical + 0.02);
        expect(cell.aiSkill).not.toBeNull();
        expect(cell.aiSkill!).toBeGreaterThan(0);
        // And the plan the Brain picks when it is being conservative is one that has actually been working.
        const plan = choosePlan(cell, { rng: mulberry32(1), maxWaitTicks: 60, strict: true });
        const chosen = cell.arms.find(a => a.arm === plan.arm)!;
        expect(chosen.post).toBeGreaterThan(cell.theoretical);
        expect(planFires({ ...plan, arm: 'LEARNED_DIGITS' }, cell, [1, 2, 4], over2)).toBe(true);
    });

    it('finds no structure in random digits and says so', () => {
        const r = brainReport({ A: randomDigits(1200, 21), B: randomDigits(1200, 22) }, ['A', 'B'], [over2, { side: 'UNDER', param: 7 }], 1, 0);
        expect(r.cells).toHaveLength(4);
        // Nothing should be called a clear lead out of random data at this sample size, give or take a chance hit.
        expect(r.leaderboard.filter(x => x.evidence === 'LEAD').length).toBeLessThanOrEqual(2);
        if (r.aiSkill !== null) expect(r.aiSkill).toBeLessThan(0.02); // the model cannot beat a coin on random digits
        expect(findCell(r, 'A', over2)).not.toBeNull();
    });

    it('recovery plans carry the AI lock, and the lock only blocks when the model disagrees', () => {
        const digits = planted(1200, 9);
        const cell = replayCell('P', digits, over2, 1)!;
        const strict = choosePlan(cell, { rng: mulberry32(2), maxWaitTicks: 60, strict: true });
        const normal = choosePlan(cell, { rng: mulberry32(2), maxWaitTicks: 60, strict: false });
        expect(strict.aiLock).toBe(true);
        expect(normal.aiLock).toBe(false);
        // A model that is not ready never blocks.
        const blank = new Fit(new Set([3, 4, 5, 6, 7, 8, 9]), 0.7, 1, 10);
        expect(blank.aiAgrees([1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 2, 3, 4], 21)).toBe(true);
    });

    it('rotates the plan when arms are excluded and different seeds sample different plans on flat evidence', () => {
        const cell = replayCell('R', randomDigits(1000, 31), over2, 1)!;
        const seen = new Set<string>();
        for (let s = 1; s <= 40; s++) seen.add(choosePlan(cell, { rng: mulberry32(s), maxWaitTicks: 60, strict: false }).arm);
        expect(seen.size).toBeGreaterThan(2);
    });

    it('ledger compares plan-timed trades with a blind entry on the same markets', () => {
        const none = planLedger([{ plan: 'QUIET_3', baseRate: 0.7, status: 'won' }]);
        expect(none.z).toBeNull();
        const trades = Array.from({ length: 100 }, (_, i) => ({ plan: 'QUIET_3', baseRate: 0.7, status: (i < 90 ? 'won' : 'lost') as 'won' | 'lost' }));
        const good = planLedger(trades);
        expect(good.n).toBe(100);
        expect(good.expected).toBeCloseTo(70, 5);
        expect(good.z!).toBeGreaterThan(1.96);
        const flat = planLedger(trades.map((t, i) => ({ ...t, status: (i < 70 ? 'won' : 'lost') as 'won' | 'lost' })));
        expect(Math.abs(flat.z!)).toBeLessThan(0.1);
        expect(planLedger([{ plan: null, baseRate: 0.7, status: 'won' }]).n).toBe(0);
    });
});
