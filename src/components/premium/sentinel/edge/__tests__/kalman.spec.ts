import { mulberry32 } from '../../../sixfold/stats';
import { BLOCK, initKalman, judgeHealth, MIN_BLOCKS, readHealth, stepKalman } from '../kalman';

const UNDER7 = { side: 'UNDER', param: 7 } as const; // wins on 0-6, fair 0.7
/** A series whose win share follows `p(i)`, i in 0..1 across the series. */
const shaped = (n: number, p: (i: number) => number, seed = 1): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, (_, i) => (rnd() < p(i / n) ? Math.floor(rnd() * 7) : 7 + Math.floor(rnd() * 3)));
};
const fairSeries = (n: number, seed = 7): number[] => {
    const rnd = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rnd() * 10));
};

describe('stepKalman', () => {
    it('moves toward the observation and shrinks its uncertainty', () => {
        let s = initKalman(0.7);
        const before = s.cov[0];
        for (let i = 0; i < 10; i += 1) s = stepKalman(s, 0.9, 0.0084);
        expect(s.p).toBeGreaterThan(0.8);
        expect(s.cov[0]).toBeLessThan(before);
        expect(s.n).toBe(10);
    });
    it('does not mutate the state it is given', () => {
        const s = initKalman(0.5);
        const copy = JSON.stringify(s);
        stepKalman(s, 0.9, 0.01);
        expect(JSON.stringify(s)).toBe(copy);
    });
    it('keeps the share inside 0..1', () => {
        let s = initKalman(0.99);
        for (let i = 0; i < 20; i += 1) s = stepKalman(s, 1, 0.001);
        expect(s.p).toBeLessThanOrEqual(1);
        expect(s.p).toBeGreaterThanOrEqual(0);
    });
});

describe('readHealth', () => {
    it('is not ready, and never vetoes, with fewer than the minimum blocks', () => {
        const h = readHealth(
            shaped(BLOCK * (MIN_BLOCKS - 1), () => 0.3),
            UNDER7
        );
        expect(h.ready).toBe(false);
        expect(judgeHealth(h, { hunter: false, recovering: false })).toMatchObject({ allow: true, bump: 0, rank: 0 });
    });
    it('reads the level of a series that wins more than its fair share, with a lower bound above fair', () => {
        const h = readHealth(
            shaped(600, () => 0.85),
            UNDER7
        );
        expect(h.ready).toBe(true);
        expect(h.level).toBeGreaterThan(0.78);
        expect(h.lowerBound).toBeGreaterThan(h.fair);
    });
    it('is not confident about a fair series: its lower bound sits at or below fair almost always', () => {
        let confident = 0;
        for (let seed = 1; seed <= 300; seed += 1) {
            const h = readHealth(fairSeries(700, seed), UNDER7);
            if (h.lowerBound > h.fair) confident += 1;
        }
        expect(confident / 300).toBeLessThan(0.08);
    });
    it('flags a strongly decaying series as falling', () => {
        const h = readHealth(
            shaped(600, i => 0.9 - 0.6 * i),
            UNDER7
        );
        expect(h.trend).toBe('falling');
        expect(h.velocity).toBeLessThan(0);
    });
    it('rarely calls a fair series a trend', () => {
        let trending = 0;
        for (let seed = 1; seed <= 300; seed += 1)
            if (readHealth(fairSeries(700, seed), UNDER7).trend !== 'steady') trending += 1;
        expect(trending / 300).toBeLessThan(0.05);
    });
    it('only reports a life estimate when the level is above fair and falling', () => {
        const falling = readHealth(
            shaped(600, i => 0.95 - 0.2 * i, 3),
            UNDER7
        );
        if (falling.level > falling.fair && falling.velocity < 0) expect(falling.lifeTicks).not.toBeNull();
        expect(
            readHealth(
                shaped(600, () => 0.3),
                UNDER7
            ).lifeTicks
        ).toBeNull();
    });
});

describe('judgeHealth', () => {
    const decayed = readHealth(
        shaped(600, i => 0.85 - 0.5 * i),
        UNDER7
    );
    const strong = readHealth(
        shaped(600, () => 0.88),
        UNDER7
    );

    it('vetoes a signal whose filtered win rate is not above fair', () => {
        const call = judgeHealth(decayed, { hunter: false, recovering: false });
        expect(call.allow).toBe(false);
        expect(call.note).toMatch(/Kalman/);
    });
    it('eases the bar and ranks higher for a confident signal', () => {
        const call = judgeHealth(strong, { hunter: false, recovering: false });
        expect(call.allow).toBe(true);
        expect(call.bump).toBeLessThan(0);
        expect(call.rank).toBeGreaterThan(0);
    });
    it('never vetoes in the Hunter on level alone (the signal source is a voice there): it only raises the bar', () => {
        const call = judgeHealth(decayed, { hunter: true, recovering: false });
        expect(call.allow).toBe(true);
        expect(call.bump).toBeGreaterThan(0);
    });
    it('does not refuse a recovery trade for a weak level (the martingale step has to be taken somewhere)', () => {
        expect(judgeHealth(decayed, { hunter: false, recovering: true }).allow).toBe(true);
    });
    it('vetoes a signal about to expire, in recovery as well', () => {
        const dying = { ...strong, trend: 'falling' as const, lifeTicks: 5 };
        expect(judgeHealth(dying, { hunter: false, recovering: true }).allow).toBe(false);
        expect(judgeHealth(dying, { hunter: false, recovering: false }).note).toMatch(/decaying/);
    });
    it('is deterministic', () => {
        expect(judgeHealth(strong, { hunter: false, recovering: false })).toEqual(
            judgeHealth(strong, { hunter: false, recovering: false })
        );
    });
});
