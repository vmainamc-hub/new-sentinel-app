import {
    AUTO_BOUNDS, DEFAULT_AUTO, armSession, disarmSession, newSession, recordAutoRun, sanitizeAuto, signalKey, stepAuto,
    type AutoConfig, type AutoSession,
} from '../auto-trader';
import type { Recommendation, VerdictAction } from '../over-under-engine';

const rec = (over: Partial<Recommendation> & { action?: VerdictAction } = {}): Recommendation => ({
    id: 'R_50:OVER2:1', engine: 'insight-fusion', symbol: 'R_50', market: 'Volatility 50', proposition: 'OVER2', contract: 'DIGITOVER', barrier: 2,
    side: 0, label: 'Over 2', action: 'EXECUTE', score: 80, danger: 10, independence: 60, confirmed: true, ripe: true, sample: 1000,
    reasons: [], createdAt: 0, refreshedAt: 0, expiresAt: 1e12, ...over,
});
const base = { valid: true, busy: false };
const cfg = (over: Partial<AutoConfig> = {}): AutoConfig => ({ ...DEFAULT_AUTO, ...over });

describe('config limits', () => {
    it('sanitizes every setting into its bounds and defaults to the strict grade', () => {
        expect(sanitizeAuto({})).toEqual(DEFAULT_AUTO);
        expect(sanitizeAuto({ grade: 'whatever' as never }).grade).toBe('EXECUTE');
        expect(sanitizeAuto({ grade: 'ANY' }).grade).toBe('ANY');
        expect(sanitizeAuto({ cooldownSec: 0 }).cooldownSec).toBe(AUTO_BOUNDS.cooldownSec[0]);
        expect(sanitizeAuto({ cooldownSec: 1e6 }).cooldownSec).toBe(AUTO_BOUNDS.cooldownSec[1]);
        expect(sanitizeAuto({ maxRuns: 0 }).maxRuns).toBe(1);
        expect(sanitizeAuto({ maxRuns: 9999 }).maxRuns).toBe(AUTO_BOUNDS.maxRuns[1]);
        expect(sanitizeAuto({ maxLoss: -5 }).maxLoss).toBe(AUTO_BOUNDS.maxLoss[0]);
        expect(sanitizeAuto({ maxLoss: NaN as unknown as number }).maxLoss).toBe(DEFAULT_AUTO.maxLoss);
    });
    it('there is no way to configure unlimited runs or an unlimited loss', () => {
        expect(sanitizeAuto({ maxRuns: Infinity }).maxRuns).toBe(DEFAULT_AUTO.maxRuns);
        expect(sanitizeAuto({ maxLoss: 0 }).maxLoss).toBeGreaterThan(0);
    });
});
describe('arming', () => {
    it('is off by default and never fires while off, whatever the signal', () => {
        const step = stepAuto(newSession(), cfg(), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
    });
    it('arming starts fresh counters', () => {
        expect(armSession()).toEqual({ armed: true, runs: 0, pnl: 0, lastFiredAt: null, seen: null, stopReason: '' });
    });
    it('arming never fires on the signal that was already on screen, only on a new one', () => {
        const onScreen = rec();
        let s = armSession(onScreen, 'EXECUTE');
        const same = stepAuto(s, cfg(), { ...base, target: onScreen, now: 1000 });
        expect(same.fire).toBe(false);
        s = same.session;
        s = stepAuto(s, cfg(), { ...base, target: rec({ action: 'PREPARE' }), now: 2000 }).session;
        expect(stepAuto(s, cfg(), { ...base, target: onScreen, now: 3000 }).fire).toBe(true);
    });
    it('a lower-grade signal on screen at arming does not block a later upgrade', () => {
        const prepare = rec({ action: 'PREPARE' });
        const s = armSession(prepare, 'EXECUTE');
        expect(stepAuto(s, cfg(), { ...base, target: rec({ action: 'EXECUTE' }), now: 1000 }).fire).toBe(true);
    });
});
describe('when it fires', () => {
    it('fires the moment an EXECUTE signal appears, exactly once', () => {
        let s: AutoSession = armSession();
        const first = stepAuto(s, cfg(), { ...base, target: rec(), now: 1000 });
        expect(first.fire).toBe(true);
        expect(first.session.runs).toBe(1);
        s = first.session;
        const again = stepAuto(s, cfg({ cooldownSec: 5 }), { ...base, target: rec(), now: 60_000 });
        expect(again.fire).toBe(false);
    });
    it('does not fire on PREPARE when the grade is EXECUTE, but does when the grade is ANY', () => {
        const prepare = rec({ action: 'PREPARE' });
        expect(stepAuto(armSession(), cfg(), { ...base, target: prepare, now: 1000 }).fire).toBe(false);
        expect(stepAuto(armSession(), cfg({ grade: 'ANY' }), { ...base, target: prepare, now: 1000 }).fire).toBe(true);
    });
    it('never fires on OBSERVE or STAND_DOWN in either grade', () => {
        for (const action of ['OBSERVE', 'STAND_DOWN'] as const) for (const grade of ['EXECUTE', 'ANY'] as const)
            expect(stepAuto(armSession(), cfg({ grade }), { ...base, target: rec({ action }), now: 1000 }).fire).toBe(false);
    });
    it('does nothing without a signal', () => {
        const step = stepAuto(armSession(), cfg(), { ...base, target: null, now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(true);
    });
    it('a PREPARE that upgrades to EXECUTE counts as a new signal', () => {
        let s = armSession();
        s = stepAuto(s, cfg(), { ...base, target: rec({ action: 'PREPARE' }), now: 1000 }).session;
        expect(stepAuto(s, cfg(), { ...base, target: rec({ action: 'EXECUTE' }), now: 2000 }).fire).toBe(true);
    });
    it('a signal that drops away and returns is a new signal, subject to the cooldown', () => {
        let s = armSession();
        const a = stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 0 }); expect(a.fire).toBe(true); s = a.session;
        s = stepAuto(s, cfg(), { ...base, target: rec({ action: 'PREPARE' }), now: 5000 }).session;
        const early = stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 10000 });
        expect(early.fire).toBe(false);
        expect(early.note).toMatch(/Cooling down/);
        s = early.session;
        s = stepAuto(s, cfg(), { ...base, target: rec({ action: 'PREPARE' }), now: 20000 }).session;
        expect(stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 31000 }).fire).toBe(true);
    });
    it('a different signal at the same grade is a new signal', () => {
        let s = armSession();
        s = stepAuto(s, cfg({ cooldownSec: 5 }), { ...base, target: rec(), now: 0 }).session;
        const other = rec({ symbol: 'R_75', proposition: 'UNDER7', contract: 'DIGITUNDER', barrier: 7, label: 'Under 7', side: 1 });
        expect(signalKey(other)).not.toBe(signalKey(rec()));
        expect(stepAuto(s, cfg({ cooldownSec: 5 }), { ...base, target: other, now: 6000 }).fire).toBe(true);
    });
});
describe('what stops it from firing', () => {
    it('never starts a second run while one is active, and the missed signal is not traded later', () => {
        const s = armSession();
        const busy = stepAuto(s, cfg(), { ...base, busy: true, target: rec(), now: 1000 });
        expect(busy.fire).toBe(false);
        const later = stepAuto(busy.session, cfg(), { ...base, busy: false, target: rec(), now: 99000 });
        expect(later.fire).toBe(false);
    });
    it('respects the cooldown and consumes the signal that arrived inside it', () => {
        let s = armSession();
        s = stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 0 }).session;
        s = stepAuto(s, cfg(), { ...base, target: null, now: 1000 }).session;
        const inside = stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 10000 });
        expect(inside.fire).toBe(false);
        expect(stepAuto(inside.session, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 60000 }).fire).toBe(false);
    });
    it('does not fire when the live engine re-check fails', () => {
        expect(stepAuto(armSession(), cfg(), { ...base, valid: false, target: rec(), now: 1000 }).fire).toBe(false);
    });
});
describe('session limits switch it off by themselves', () => {
    it('stops after the maximum number of runs', () => {
        const s: AutoSession = { ...armSession(), runs: 3 };
        const step = stepAuto(s, cfg({ maxRuns: 3 }), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
        expect(step.session.stopReason).toMatch(/reached 3 auto runs/);
    });
    it('stops when realised losses reach the limit, and not before', () => {
        const near: AutoSession = { ...armSession(), pnl: -4.99 };
        expect(stepAuto(near, cfg({ maxLoss: 5 }), { ...base, target: null, now: 1 }).session.armed).toBe(true);
        const hit: AutoSession = { ...armSession(), pnl: -5 };
        const step = stepAuto(hit, cfg({ maxLoss: 5 }), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
        expect(step.session.stopReason).toMatch(/loss limit/);
    });
    it('profit does not extend or shorten the run limit', () => {
        const winning: AutoSession = { ...armSession(), runs: 5, pnl: 100 };
        expect(stepAuto(winning, cfg({ maxRuns: 5 }), { ...base, target: rec(), now: 1 }).session.armed).toBe(false);
    });
    it('once stopped it stays off until armed again', () => {
        const stopped = disarmSession(armSession(), 'Stopped by you.');
        const step = stepAuto(stopped, cfg(), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.note).toBe('Stopped by you.');
    });
});
describe('finishing a run', () => {
    it('adds realised P/L and keeps going after a clean run', () => {
        const done = recordAutoRun(armSession(), { placed: 10, failed: 0, pnl: -1.25 });
        expect(done.armed).toBe(true);
        expect(done.pnl).toBe(-1.25);
        expect(recordAutoRun(done, { placed: 10, failed: 0, pnl: 0.5 }).pnl).toBe(-0.75);
    });
    it('switches off if any purchase failed (fail-safe)', () => {
        const done = recordAutoRun(armSession(), { placed: 7, failed: 3, pnl: 0.4 });
        expect(done.armed).toBe(false);
        expect(done.stopReason).toMatch(/3 purchases failed/);
        expect(done.pnl).toBe(0.4);
    });
    it('switches off if nothing was placed', () => {
        const done = recordAutoRun(armSession(), { placed: 0, failed: 0, pnl: 0 });
        expect(done.armed).toBe(false);
        expect(done.stopReason).toMatch(/placed no trades/);
    });
});
