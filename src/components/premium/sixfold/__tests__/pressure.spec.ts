import { compareGuard } from '../entry-lab';
import {
    DEFAULT_PRESSURE_MAX,
    losingSidePressure,
    multiWindowGate,
    multiWindowHealth,
    pressureGate,
    winningSideGate,
    winningSidePressure,
} from '../pressure';
import { mulberry32 } from '../stats';

const over2 = { side: 'OVER' as const, param: 2 };
const over3 = { side: 'OVER' as const, param: 3 };
const under7 = { side: 'UNDER' as const, param: 7 };

const randomDigits = (n: number, seed: number) => {
    const rand = mulberry32(seed);
    return Array.from({ length: n }, () => Math.floor(rand() * 10));
};

describe('losingSidePressure', () => {
    it('is not measurable and passes while there are too few ticks', () => {
        const p = losingSidePressure([1, 2, 3], over2);
        expect(p.measurable).toBe(false);
        expect(pressureGate(p).ok).toBe(true);
    });

    it('reads the losing digits of the contract it is given: 0-2 for Over 2, 0-3 for Over 3, 7-9 for Under 7', () => {
        const s = randomDigits(300, 1);
        expect(losingSidePressure(s, over2).digits.map(d => d.digit).sort()).toEqual([0, 1, 2]);
        expect(losingSidePressure(s, over3).digits.map(d => d.digit).sort()).toEqual([0, 1, 2, 3]);
        expect(losingSidePressure(s, under7).digits.map(d => d.digit).sort()).toEqual([7, 8, 9]);
    });

    it('stays calm on a fair stream most of the time', () => {
        const s = randomDigits(20000, 2);
        let blocked = 0;
        let n = 0;
        for (let i = 600; i < s.length; i += 11) {
            n += 1;
            if (!pressureGate(losingSidePressure(s.slice(i - 600, i), over3)).ok) blocked += 1;
        }
        expect(blocked / n).toBeLessThan(0.2);
    });

    it('flags a losing side that is crowding in and climbing', () => {
        // 120 fair ticks, then the last 60 are dominated by losing digits 0-3 and the last 15 are all losers.
        const fair = randomDigits(120, 3);
        const hostile = Array.from({ length: 60 }, (_, i) => (i % 5 === 4 ? 7 : i % 4));
        const s = [...fair, ...hostile, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2];
        const p = losingSidePressure(s, over3);
        expect(p.measurable).toBe(true);
        expect(p.index).toBeGreaterThan(DEFAULT_PRESSURE_MAX);
        expect(pressureGate(p).ok).toBe(false);
    });

    it('does not mind the winning digits piling up', () => {
        const s = Array.from({ length: 200 }, (_, i) => 4 + (i % 6)); // only winning digits for Over 3
        const p = losingSidePressure(s, over3);
        expect(p.index).toBeLessThan(10);
        expect(pressureGate(p).ok).toBe(true);
    });
});

describe('multiWindowHealth', () => {
    it('is loading until there are 480 ticks, and then passes the gate', () => {
        const h = multiWindowHealth(randomDigits(300, 4), over3);
        expect(h.verdict).toBe('LOADING');
        expect(multiWindowGate(h).ok).toBe(true);
    });

    it('calls a recent-only surge a THRUST and refuses it', () => {
        // 420 ticks that win Over 3 only 45% of the time, then 60 ticks that win 85%.
        const older = Array.from({ length: 420 }, (_, i) => (i % 20 < 9 ? 7 : 1));
        const recent = Array.from({ length: 60 }, (_, i) => (i % 20 < 17 ? 7 : 1));
        const h = multiWindowHealth([...older, ...recent], over3);
        expect(h.verdict).toBe('THRUST');
        expect(multiWindowGate(h).ok).toBe(false);
    });

    it('passes a contract that is at or above normal in every window', () => {
        const s = Array.from({ length: 600 }, (_, i) => (i % 10 < 7 ? 5 + (i % 5) : i % 4)); // wins 70% of the time on Over 3
        const h = multiWindowHealth(s, over3);
        expect(h.verdict).toBe('CONSISTENT');
        expect(multiWindowGate(h).ok).toBe(true);
    });

    it('calls a contract that has turned down in the latest window FADING', () => {
        const older = Array.from({ length: 420 }, (_, i) => (i % 10 < 7 ? 5 + (i % 5) : i % 4));
        const recent = Array.from({ length: 60 }, (_, i) => (i % 10 < 3 ? 5 + (i % 5) : i % 4)); // wins 30%
        expect(multiWindowHealth([...older, ...recent], over3).verdict).toBe('FADING');
    });
});

describe('the gates in the Entry Lab', () => {
    const guard = (seen: readonly number[]) =>
        pressureGate(losingSidePressure(seen, over3)).ok && multiWindowGate(multiWindowHealth(seen, over3)).ok;

    it('change nothing on a fair stream, and never claim to beat the payout', () => {
        const r = compareGuard(randomDigits(40000, 5150), over3, guard, { warmup: 600 });
        expect(['NO_DIFFERENCE', 'LEANS_BETTER', 'LESS_BAD', 'WORSE']).toContain(r.verdict);
        expect(r.verdict).not.toBe('BETTER');
        expect(Math.abs((r.diffPts ?? 0))).toBeLessThan(2);
    });

    it('steer away from hostile stretches in a market that really has them', () => {
        const rand = mulberry32(77);
        const s: number[] = [];
        let hostile = false;
        for (let i = 0; i < 60000; i++) {
            if (i % 400 === 0) hostile = rand() < 0.5;
            s.push(hostile && rand() < 0.18 ? Math.floor(rand() * 4) : Math.floor(rand() * 10));
        }
        const r = compareGuard(s, over3, guard, { warmup: 600 });
        expect(r.diffPts ?? 0).toBeGreaterThan(2);
        expect(r.verdict).toBe('LESS_BAD'); // better than not guarding, still under break-even
    });
});
describe('winningSidePressure', () => {
    // Over 2 wins on 3-9. Build a stream whose winning share climbs window by window: older ticks mixed, newest all winners.
    const base = randomDigits(200, 4);
    const climbing = [...base, ...[1, 7, 0, 8, 2, 9, 1, 7, 8, 7, 3, 9, 8, 7, 9, 4, 8, 7, 5, 9, 6, 8, 7, 9, 7, 8, 9, 7, 6, 8, 7, 9, 5, 8, 9, 7, 8, 6, 9, 7, 8, 9, 7, 9, 8, 7, 9]];
    const falling = [...base.map(() => 8), ...[1, 0, 2, 0, 1, 7, 0, 1, 2, 0, 1, 2, 0, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 1, 2, 0, 1, 0, 2, 0, 1, 2, 0, 1, 0, 2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 0]];

    it('is not measurable on a short history and then passes the gate', () => {
        const p = winningSidePressure([7, 8, 9], over2);
        expect(p.measurable).toBe(false);
        expect(winningSideGate(p).ok).toBe(true);
    });

    it('calls a winning side that gains share across the windows RISING and lets it through', () => {
        const p = winningSidePressure(climbing, over2);
        expect(p.state).toBe('RISING');
        expect(p.ratePp).toBeGreaterThan(2);
        expect(p.groupPct[3]).toBeGreaterThanOrEqual(p.fairPct);
        expect(winningSideGate(p).ok).toBe(true);
    });

    it('blocks a falling winning side and says so', () => {
        const p = winningSidePressure(falling, over2);
        expect(p.state).toBe('FALLING');
        const g = winningSideGate(p);
        expect(g.ok).toBe(false);
        expect(g.reason).toMatch(/falling/);
    });

    it('blocks a dormant winning side: flat at its normal rate is not building', () => {
        const flat = Array.from({ length: 300 }, (_, i) => [7, 1, 8, 9, 3, 7, 0, 8, 9, 5][i % 10]); // 80% winners in every window
        const p = winningSidePressure(flat, over2);
        expect(p.state).toBe('DORMANT');
        const g = winningSideGate(p);
        expect(g.ok).toBe(false);
        expect(g.reason).toMatch(/dormant/);
    });

    it('reads the contract that will be bought: a bigger minimum gain is stricter', () => {
        const loose = winningSidePressure(climbing, over2, 1).state;
        const strict = winningSidePressure(climbing, over2, 60).state;
        expect(loose).toBe('RISING');
        expect(strict).not.toBe('RISING');
    });
});
