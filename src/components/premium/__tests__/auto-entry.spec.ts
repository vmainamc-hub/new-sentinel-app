import {
    DYNAMIC_TICKS, MIN_ENTRY_WINDOW_SEC, PRESSURE_WINDOW, entryRule, entryWindowSec, expectedLosingShare, pressureReading, requiredTicks, ruleText, tooHostile,
} from '../auto-entry';
import type { Recommendation } from '../over-under-engine';

const rec = (over: Partial<Recommendation> = {}): Recommendation => ({
    id: 'R_50:OVER2:1', engine: 'insight-fusion', symbol: 'R_50', market: 'Volatility 50', proposition: 'OVER2', contract: 'DIGITOVER', barrier: 2,
    side: 0, label: 'Over 2', action: 'EXECUTE', score: 78, danger: 30, independence: 60, confirmed: true, ripe: true, sample: 1000,
    reasons: [], createdAt: 0, refreshedAt: 0, expiresAt: 1e12, ...over,
});
const cfg = (over = {}) => ({ entryMode: 'DYNAMIC' as const, entryTicks: 3, entryWaitSec: 20, ...over });

describe('adaptive strictness (option 1)', () => {
    it('keeps the base for an ordinary signal in an ordinary market', () => {
        expect(requiredTicks(3, rec(), 0)).toEqual({ ticks: 3, reasons: [] });
    });
    it('relaxes by one for a strong, calm signal, never below the minimum', () => {
        expect(requiredTicks(3, rec({ score: 90, danger: 10 }), 0).ticks).toBe(2);
        expect(requiredTicks(2, rec({ score: 90, danger: 10 }), 0).ticks).toBe(DYNAMIC_TICKS.min);
    });
    it('tightens with danger', () => {
        expect(requiredTicks(3, rec({ danger: 55 }), 0).ticks).toBe(4);
        expect(requiredTicks(3, rec({ danger: 75 }), 0).ticks).toBe(5);
    });
    it('a strong score does not relax the entry while danger is high', () => {
        expect(requiredTicks(3, rec({ score: 95, danger: 60 }), 0).ticks).toBe(4);
    });
    it('never goes above the maximum, and 0 (filter off) stays 0', () => {
        expect(requiredTicks(5, rec({ danger: 90 }), 4).ticks).toBe(DYNAMIC_TICKS.max);
        expect(requiredTicks(0, rec({ danger: 90 }), 4).ticks).toBe(0);
    });
});

describe('risk-aware entry (option 3)', () => {
    it('is stricter after a loss, stricter still after two, and back to normal after a win', () => {
        expect(requiredTicks(3, rec(), 0).ticks).toBe(3);
        expect(requiredTicks(3, rec(), 1).ticks).toBe(4);
        expect(requiredTicks(3, rec(), 2).ticks).toBe(5);
        expect(requiredTicks(3, rec(), 3).ticks).toBe(5);
        expect(requiredTicks(3, rec(), 0).ticks).toBe(3);
    });
    it('says why', () => {
        expect(requiredTicks(3, rec(), 1).reasons).toEqual(['after a loss +1']);
        expect(requiredTicks(3, rec(), 2).reasons[0]).toMatch(/2 losses in a row/);
    });
});

describe('time-based window (option 2)', () => {
    it('gives a strong signal longer, an ordinary one the base, and a weak one shorter', () => {
        expect(entryWindowSec(20, rec({ score: 90 }), 0).sec).toBe(30);
        expect(entryWindowSec(20, rec({ score: 78 }), 0).sec).toBe(20);
        expect(entryWindowSec(20, rec({ score: 60 }), 0).sec).toBe(12);
    });
    it('never waits past the signal\'s own remaining life', () => {
        const old = rec({ score: 90, expiresAt: 14_000 });
        expect(entryWindowSec(20, old, 0).sec).toBe(12);           // 14s life minus a 2s margin
        expect(entryWindowSec(20, old, 0).reasons.join(' ')).toMatch(/remaining life/);
    });
    it('skips a signal that is too old to be worth entering', () => {
        expect(entryWindowSec(20, rec({ expiresAt: 6_000 }), 0).sec).toBe(0);
        expect(MIN_ENTRY_WINDOW_SEC).toBeGreaterThan(0);
    });
    it('a locked signal (no expiry) is not limited by life', () => {
        expect(entryWindowSec(20, rec({ expiresAt: Infinity }), 123).sec).toBe(20);
    });
});

describe('entryRule', () => {
    it('FIXED is exactly the configured numbers whatever the signal or session', () => {
        const rule = entryRule(cfg({ entryMode: 'FIXED' }), rec({ danger: 90, score: 40 }), 3, 0);
        expect(rule).toMatchObject({ mode: 'FIXED', ticks: 3, windowSec: 20, reasons: [] });
    });
    it('DYNAMIC combines ticks and window and keeps the base visible', () => {
        const rule = entryRule(cfg(), rec({ score: 90, danger: 10 }), 1, 0);
        expect(rule).toMatchObject({ mode: 'DYNAMIC', ticks: 3, windowSec: 30, baseTicks: 3, baseWaitSec: 20 });   // -1 strong, +1 loss
        expect(ruleText(rule)).toMatch(/need 3 ticks, 30s window \(base 3:/);
        expect(ruleText(entryRule(cfg({ entryTicks: 0 }), rec(), 0, 0))).toBe('no entry filter');
    });
});

describe('digit pressure (option 4)', () => {
    const mix = (losing: number, total = PRESSURE_WINDOW, losingDigit = 1, winningDigit = 6) =>
        Array.from({ length: total }, (_, i) => (i < losing ? losingDigit : winningDigit));
    it('expected losing share follows the barrier actually traded', () => {
        expect(expectedLosingShare('DIGITOVER', 2)).toBeCloseTo(0.3);      // 0,1,2
        expect(expectedLosingShare('DIGITOVER', 3)).toBeCloseTo(0.4);      // recovery barrier: 0,1,2,3
        expect(expectedLosingShare('DIGITUNDER', 8)).toBeCloseTo(0.2);     // 8,9
        expect(expectedLosingShare('DIGITUNDER', 6)).toBeCloseTo(0.4);     // 6,7,8,9
    });
    it('passes a normal spell and blocks a cluster of losing digits', () => {
        expect(pressureReading(mix(12), 'DIGITOVER', 2).ok).toBe(true);    // 30%
        expect(pressureReading(mix(16), 'DIGITOVER', 2).ok).toBe(true);    // 40% <= 40.5%
        expect(pressureReading(mix(20), 'DIGITOVER', 2).ok).toBe(false);   // 50%
    });
    it('the barrier digit itself counts as losing for both sides', () => {
        expect(pressureReading(mix(20, 40, 2, 7), 'DIGITOVER', 2).ok).toBe(false);
        expect(pressureReading(mix(20, 40, 8, 1), 'DIGITUNDER', 8).ok).toBe(false);
    });
    it('uses the recovery barrier: the same digits can pass at one barrier and fail at another', () => {
        const digits = mix(24, 40, 3, 8);                                  // twenty-four 3s, sixteen 8s
        expect(pressureReading(digits, 'DIGITOVER', 2).ok).toBe(true);     // 3 wins Over 2
        expect(pressureReading(digits, 'DIGITOVER', 3).ok).toBe(false);    // 3 loses Over 3
    });
    it('passes when there is not enough data to judge', () => {
        expect(pressureReading([1, 1, 1], 'DIGITOVER', 2).ok).toBe(true);
    });
});

describe('danger ceiling (option 5)', () => {
    it('skips at or above the ceiling and is off at 0', () => {
        expect(tooHostile(rec({ danger: 80 }), 80)).toBe(true);
        expect(tooHostile(rec({ danger: 79 }), 80)).toBe(false);
        expect(tooHostile(rec({ danger: 100 }), 0)).toBe(false);
    });
});
