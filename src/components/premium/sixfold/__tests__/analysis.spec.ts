import { bankrollSim, calibrateLabels, contractRuns, runsTest, structureTable, transitionTest, uniformityTest } from '../analysis';
import { DEFAULT_SETTINGS } from '../money';
import { mulberry32 } from '../stats';

const random = (n: number, seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(r() * 10));
};

describe('uniformity', () => {
    it('does not reject fair digits and rejects heavily biased ones', () => {
        expect(uniformityTest(random(2000, 5)).p!).toBeGreaterThan(0.01);
        const biased = random(2000, 6).map((d, i) => (i % 3 === 0 ? 7 : d));
        const u = uniformityTest(biased);
        expect(u.p!).toBeLessThan(1e-6);
        expect(u.worst?.digit).toBe(7);
    });
    it('needs a minimum sample', () => {
        expect(uniformityTest([1, 2, 3]).p).toBeNull();
    });
});

describe('runs test', () => {
    it('flags perfectly alternating and perfectly streaky sequences', () => {
        const alt = Array.from({ length: 100 }, (_, i) => i % 2 === 0);
        expect(runsTest(alt).p!).toBeLessThan(0.001);
        const streaky = Array.from({ length: 100 }, (_, i) => i < 50);
        expect(runsTest(streaky).p!).toBeLessThan(0.001);
    });
    it('is unremarkable on random bits', () => {
        const r = mulberry32(3);
        const bits = Array.from({ length: 800 }, () => r() < 0.5);
        expect(runsTest(bits).p!).toBeGreaterThan(0.01);
        expect(contractRuns(random(1200, 9), { side: 'EVEN', param: 0 }).p).not.toBeNull();
    });
});

describe('transition test', () => {
    it('finds no dependence in random digits but detects a planted rule', () => {
        const fair = transitionTest(random(2000, 11));
        expect(fair.p!).toBeGreaterThan(0.01);
        // After a 3 the next digit is always 8.
        const rig = random(2000, 12);
        for (let i = 1; i < rig.length; i++) if (rig[i - 1] === 3) rig[i] = 8;
        const t = transitionTest(rig);
        expect(t.p!).toBeLessThan(1e-6);
        expect(t.hottest?.from).toBe(3);
        expect(t.hottest?.to).toBe(8);
    });
    it('structureTable adjusts across markets', () => {
        const rows = structureTable({ A: random(1500, 1), B: random(1500, 2) }, ['A', 'B']);
        expect(rows).toHaveLength(2);
        rows.forEach(r => expect(r.uniformityQ).not.toBeNull());
    });
});

describe('calibration of labels', () => {
    it('on random digits a VIABLE label does not lift the forward win rate meaningfully', () => {
        const rows = calibrateLabels(random(2000, 21), { side: 'OVER', param: 2 });
        const viable = rows.find(r => r.state === 'VIABLE');
        expect(rows.length).toBeGreaterThan(0);
        if (viable && viable.trades > 200) expect(Math.abs(viable.liftPts!)).toBeLessThan(8);
    });
    it('uses only past trades to label a checkpoint (planted pattern shows a lift)', () => {
        // First half random, second half all wins for Over 2 -> forward win rate after VIABLE labels is high.
        const half = random(700, 4);
        const digits = [...half, ...Array.from({ length: 1300 }, (_, i) => (i % 2 === 0 ? 1 : 7))];
        const rows = calibrateLabels(digits, { side: 'OVER', param: 2 });
        const viable = rows.find(r => r.state === 'VIABLE')!;
        expect(viable.rate!).toBeGreaterThan(0.8);
    });
});

describe('bankroll simulation', () => {
    it('shows a negative expectation per unit staked at the payout margin', () => {
        const r = bankrollSim({ side: 'OVER', param: 2 }, DEFAULT_SETTINGS, 400);
        expect(r.evPerUnit).toBeLessThan(0);
        expect(r.hitTakeProfit + r.hitStopLoss + r.hitLossStreak + r.hitTradeCap).toBeCloseTo(1, 6);
    });
    it('martingale raises the worst stake and is deterministic for a seed', () => {
        const flat = bankrollSim({ side: 'UNDER', param: 7 }, DEFAULT_SETTINGS, 300);
        const mg = bankrollSim({ side: 'UNDER', param: 7 }, { ...DEFAULT_SETTINGS, martingale: true }, 300);
        expect(mg.worstStake).toBeGreaterThan(flat.worstStake);
        expect(bankrollSim({ side: 'UNDER', param: 7 }, DEFAULT_SETTINGS, 300).meanPnl).toBe(flat.meanPnl);
    });
});
