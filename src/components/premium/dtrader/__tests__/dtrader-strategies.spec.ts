import {
    backtest, backtestText, defaultStrategyId, ema, getStrategy, paramDefaults, resolveParams, rsi, sigmaOffset, STRATEGIES, strategiesFor, type StrategyContext,
tickSigma,
    zScore, } from '../dtrader-strategies';

/** Deterministic pseudo-random digits so the tests never flake. */
const lcg = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const uniformDigits = (n: number, seed = 7) => { const r = lcg(seed); return Array.from({ length: n }, () => Math.floor(r() * 10)); };
const walk = (n: number, step = 0.1, seed = 3) => { const r = lcg(seed); let p = 1000; return Array.from({ length: n }, () => (p += (r() - 0.5) * step * 2)); };

const ctx = (patch: Partial<StrategyContext> & { id: string }): StrategyContext & { run: () => ReturnType<NonNullable<ReturnType<typeof getStrategy>>['decide']> } => {
    const strategy = getStrategy(patch.id)!;
    const full: StrategyContext = {
        family: 'overunder', digits: [], prices: [], prediction: 4, offset: 0.5, ticks: 1, decimals: 2, params: paramDefaults(strategy), ...patch,
    };
    return { ...full, run: () => strategy.decide(full) };
};

describe('statistics', () => {
    it('z-scores hits against chance', () => {
        expect(zScore(50, 100, 0.5)).toBe(0);
        expect(zScore(60, 100, 0.5)).toBeCloseTo(2, 5);
        expect(zScore(5, 10, 1)).toBe(0);
    });
    it('measures movement and averages', () => {
        expect(tickSigma([1, 2, 3, 4, 5], 10)).toBe(0);
        expect(tickSigma([1, 3, 2, 4, 3], 10)).toBeGreaterThan(0);
        expect(ema([1, 1, 1, 1], 3)).toBe(1);
        expect(ema([1, 2, 3, 4, 5, 6, 7, 8], 3)).toBeGreaterThan(ema([1, 2, 3, 4, 5, 6, 7, 8], 8));
        expect(rsi(Array.from({ length: 60 }, (_, i) => 100 + i), 14)).toBe(100);
        expect(rsi(Array.from({ length: 60 }, (_, i) => 100 - i), 14)).toBe(0);
        expect(rsi([1, 2, 3], 14)).toBeNull();
    });
    it('sizes a barrier from movement, never below one price step', () => {
        expect(sigmaOffset([5, 5, 5, 5], 1, 1, 2)).toBe(0.01);
        expect(sigmaOffset(walk(300, 1), 4, 1, 2)).toBeGreaterThan(sigmaOffset(walk(300, 1), 1, 1, 2));
    });
});

describe('registry', () => {
    it('every family has at least one strategy and a default that exists', () => {
        (['overunder', 'matchesdiffers', 'evenodd', 'risefall', 'highlow', 'range'] as const).forEach(family => {
            expect(strategiesFor(family).length).toBeGreaterThan(0);
            expect(strategiesFor(family).some(s => s.id === defaultStrategyId(family))).toBe(true);
        });
    });
    it('strategy ids are unique and every parameter default sits in its own range', () => {
        expect(new Set(STRATEGIES.map(s => s.id)).size).toBe(STRATEGIES.length);
        STRATEGIES.forEach(s => s.params.forEach(p => { expect(p.default).toBeGreaterThanOrEqual(p.min); expect(p.default).toBeLessThanOrEqual(p.max); }));
    });
    it('clamps saved values and drops unknown keys', () => {
        const s = getStrategy('edge-scanner')!;
        expect(resolveParams(s, { minZ: 99, window: -5, bogus: 1 })).toEqual({ window: 50, minZ: 5, lock: 1 });
        expect(resolveParams(s)).toEqual(paramDefaults(s));
    });
});

describe('digit strategies', () => {
    it('recent-stats picks the side that won more over the window, and always answers', () => {
        const high = ctx({ id: 'recent-stats', digits: [9, 8, 7, 9, 8, 9, 7, 8], prediction: 4 }).run();
        expect(high?.side).toBe(0);                                          // Over 4 has won every time
        const low = ctx({ id: 'recent-stats', digits: [0, 1, 2, 3, 1, 0], prediction: 4 }).run();
        expect(low?.side).toBe(1);
        expect(ctx({ id: 'recent-stats', digits: [] }).run()).not.toBeNull();
    });
    it('edge-scanner trades a clearly skewed market and waits on a uniform one', () => {
        const skewed = Array.from({ length: 300 }, (_, i) => (i % 10 < 8 ? 9 : 1));   // digits are almost always above 4
        const hit = ctx({ id: 'edge-scanner', digits: skewed, prediction: 4 }).run();
        expect(hit?.side).toBe(0);
        expect(hit?.reason).toMatch(/σ/);
        const calm = ctx({ id: 'edge-scanner', digits: uniformDigits(300), prediction: 4 }).run();
        expect(calm).toBeNull();
    });
    it('edge-scanner keeps your digit unless told it may move it', () => {
        const skewed = Array.from({ length: 300 }, () => 7);
        expect(ctx({ id: 'edge-scanner', digits: skewed, prediction: 4 }).run()?.prediction).toBeUndefined();
        const free = ctx({ id: 'edge-scanner', digits: skewed, prediction: 4, params: { ...paramDefaults(getStrategy('edge-scanner')!), lock: 0 } }).run();
        expect(free?.prediction).toBeDefined();
    });
    it('edge-scanner never proposes Over 9 or Under 0', () => {
        const lows = Array.from({ length: 300 }, () => 3);
        const d = ctx({ id: 'edge-scanner', digits: lows, prediction: 9 }).run();
        expect(d?.side).toBe(1);                                             // only Under 9 is a legal bet for digit 9
        expect(ctx({ id: 'edge-scanner', digits: Array.from({ length: 300 }, () => 9), prediction: 9 }).run()).toBeNull();   // Under 9 loses every time
    });
    it('sequence-model needs enough matches and a real follow-up pattern', () => {
        // After a 3 the next digit is always 8 (high); everything else is uniform noise.
        const r = lcg(11);
        const digits: number[] = [];
        for (let i = 0; i < 600; i += 1) { digits.push(Math.floor(r() * 10)); if (digits[digits.length - 1] === 3) digits.push(8); }
        digits.push(3);
        const d = ctx({ id: 'sequence-model', digits, prediction: 4, params: { ...paramDefaults(getStrategy('sequence-model')!), minSamples: 20 } }).run();
        expect(d?.side).toBe(0);
        expect(d?.reason).toMatch(/after 3/);
        expect(ctx({ id: 'sequence-model', digits: [...uniformDigits(400), 3], prediction: 4 }).run()).toBeNull();
        expect(ctx({ id: 'sequence-model', digits: [1, 2, 3], prediction: 4 }).run()).toBeNull();
    });
    it('streak fades or follows a run and ignores mixed ticks', () => {
        expect(ctx({ id: 'streak', digits: [1, 9, 9, 8, 7, 9], prediction: 4 }).run()?.side).toBe(1);   // fade the high run with Under
        const follow = { ...paramDefaults(getStrategy('streak')!), follow: 1 };
        expect(ctx({ id: 'streak', digits: [1, 9, 9, 8, 7, 9], prediction: 4, params: follow }).run()?.side).toBe(0);
        expect(ctx({ id: 'streak', digits: [9, 1, 9, 1], prediction: 4 }).run()).toBeNull();
    });
    it('overdue-digit waits for the gap, then matches', () => {
        expect(ctx({ id: 'overdue-digit', family: 'matchesdiffers', digits: Array.from({ length: 30 }, () => 1), prediction: 5 }).run()).toMatchObject({ side: 0 });
        expect(ctx({ id: 'overdue-digit', family: 'matchesdiffers', digits: [...Array.from({ length: 30 }, () => 1), 5, 1], prediction: 5 }).run()).toBeNull();
    });
    it('differs-last moves the digit to the one that just printed', () => {
        expect(ctx({ id: 'differs-last', family: 'matchesdiffers', digits: [2, 3, 6] }).run()).toMatchObject({ side: 1, prediction: 6 });
    });
});

describe('price strategies', () => {
    const rising = Array.from({ length: 80 }, (_, i) => 1000 + i * 0.2);
    const falling = Array.from({ length: 80 }, (_, i) => 1000 - i * 0.2);
    it('tick-momentum follows or fades a run', () => {
        expect(ctx({ id: 'tick-momentum', family: 'risefall', prices: rising }).run()?.side).toBe(0);
        expect(ctx({ id: 'tick-momentum', family: 'risefall', prices: falling }).run()?.side).toBe(1);
        const fade = { ...paramDefaults(getStrategy('tick-momentum')!), follow: 0 };
        expect(ctx({ id: 'tick-momentum', family: 'risefall', prices: rising, params: fade }).run()?.side).toBe(1);
        expect(ctx({ id: 'tick-momentum', family: 'risefall', prices: [1, 2, 1, 2, 1, 2] }).run()).toBeNull();
    });
    it('ema-trend trades with the trend only when the averages are apart', () => {
        const trend = [...walk(120, 0.05), ...Array.from({ length: 60 }, (_, i) => 1000 + i * 0.3)];
        expect(ctx({ id: 'ema-trend', family: 'risefall', prices: trend }).run()?.side).toBe(0);
        expect(ctx({ id: 'ema-trend', family: 'risefall', prices: [1, 1, 1] }).run()).toBeNull();
    });
    it('rsi-extreme fades stretched moves', () => {
        expect(ctx({ id: 'rsi-extreme', family: 'risefall', prices: rising }).run()?.side).toBe(1);
        expect(ctx({ id: 'rsi-extreme', family: 'risefall', prices: falling }).run()?.side).toBe(0);
    });
    it('Higher/Lower strategies can size the barrier from movement but never below the panel distance', () => {
        const p = { ...paramDefaults(getStrategy('tick-momentum')!), sigmaK: 2 };
        const d = ctx({ id: 'tick-momentum', family: 'highlow', prices: rising, params: p, offset: 0.01 }).run();
        expect(d?.offset).toBeGreaterThanOrEqual(0.01);
        const big = ctx({ id: 'tick-momentum', family: 'highlow', prices: rising, params: p, offset: 50 }).run();
        expect(big?.offset).toBe(50);
        expect(ctx({ id: 'tick-momentum', family: 'highlow', prices: rising }).run()?.offset).toBeUndefined();
    });
    it('sigma-band picks Ends Between when movement shrinks, Ends Outside / a pair when it grows', () => {
        const calmAfterWild = [...walk(300, 1.5), ...walk(30, 0.02, 9)];
        const wildAfterCalm = [...walk(300, 0.05), ...walk(30, 2, 9)];
        expect(ctx({ id: 'sigma-band', family: 'range', prices: calmAfterWild, ticks: 5 }).run()).toMatchObject({ side: 0 });
        expect(ctx({ id: 'sigma-band', family: 'range', prices: wildAfterCalm, ticks: 5 }).run()).toMatchObject({ side: 1 });
        expect(ctx({ id: 'sigma-band', family: 'highlow', prices: wildAfterCalm, ticks: 5 }).run()).toMatchObject({ side: 'both' });
        expect(ctx({ id: 'sigma-band', family: 'highlow', prices: calmAfterWild, ticks: 5 }).run()).toBeNull();
        expect(ctx({ id: 'sigma-band', family: 'range', prices: wildAfterCalm, ticks: 5 }).run()?.offset).toBeGreaterThan(0);
    });
});

describe('backtest', () => {
    const base = { family: 'overunder' as const, prediction: 4, offset: 0.5, ticks: 1, decimals: 2 };
    it('an always-trading strategy on random digits scores near chance, not near a profit', () => {
        const digits = uniformDigits(1000, 21);
        const prices = walk(1000);
        const r = backtest(getStrategy('recent-stats')!, base, digits, prices, paramDefaults(getStrategy('recent-stats')!), { payoutRatio: 0.95 });
        expect(r.signals).toBeGreaterThan(500);
        expect(Math.abs(r.z ?? 99)).toBeLessThan(3.5);                         // within chance
        expect(r.breakEven).toBeCloseTo(1 / 1.95, 5);
    });
    it('a strategy that waits is reported as waiting', () => {
        const digits = uniformDigits(500, 5);
        const r = backtest(getStrategy('edge-scanner')!, base, digits, walk(500), paramDefaults(getStrategy('edge-scanner')!));
        expect(r.waitedShare).toBeGreaterThan(0.8);
        expect(backtestText(r)).toMatch(/Scored on the last/);
    });
    it('a scanner on a rigged market wins and says so', () => {
        const digits = Array.from({ length: 600 }, (_, i) => (i % 10 === 0 ? 1 : 8));
        const r = backtest(getStrategy('edge-scanner')!, base, digits, walk(600), paramDefaults(getStrategy('edge-scanner')!));
        expect(r.signals).toBeGreaterThan(0);
        expect(r.hitRate).toBeGreaterThan(0.8);
        expect(r.z).toBeGreaterThan(3);
        expect(backtestText(r)).toMatch(/by chance/);
    });
    it('scores price strategies against what the price did after the entry tick', () => {
        const rising = Array.from({ length: 400 }, (_, i) => 1000 + i * 0.2);
        const r = backtest(getStrategy('tick-momentum')!, { ...base, family: 'risefall' }, rising.map(() => 0), rising, paramDefaults(getStrategy('tick-momentum')!));
        expect(r.hitRate).toBe(1);
        expect(r.chanceRate).toBeNull();
    });
    it('reports no signals plainly', () => {
        const r = backtest(getStrategy('edge-scanner')!, base, uniformDigits(100), walk(100), { window: 50, minZ: 5, lock: 1 });
        expect(r.signals).toBe(0);
        expect(backtestText(r)).toMatch(/no signals/);
    });
});
