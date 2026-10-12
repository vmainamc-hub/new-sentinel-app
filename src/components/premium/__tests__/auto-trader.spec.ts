import {
    AUTO_BOUNDS, DEFAULT_AUTO, armSession, disarmSession, entrySlip, entrySupports, lossAllowance, modeText, newSession, planRisk, planTrade, recordAutoRun, releaseRun,
    sanitizeAuto, signalKey, slipText, stakeFor, stepAuto, tickMoved, tickSymbol, tickSymbols,
    type AutoConfig, type AutoSession,
} from '../auto-trader';
import { ALLOWED_BARRIERS, contractLabel, type Recommendation, type VerdictAction } from '../over-under-engine';

// Jest has no mapping for the `@/lib/*` imports of over-under-engine, so the two modules it pulls in at runtime are stubbed here.
// Neither is used while the module loads, and the REAL over-under-engine is still the one under test: ALLOWED_BARRIERS and
// contractLabel below are the real ones, not copies.
jest.mock('@/lib/fusion/verdict', () => ({ computeCombinedVerdict: jest.fn(), MIN_SAMPLE: 0 }), { virtual: true });
jest.mock('@/lib/propositions', () => ({ PROPOSITIONS: [], propositionSpec: jest.fn() }), { virtual: true });

const over2 = (over: Partial<Recommendation> & { action?: VerdictAction } = {}): Recommendation => ({
    id: 'R_50:OVER2:1', engine: 'insight-fusion', symbol: 'R_50', market: 'Volatility 50', proposition: 'OVER2', contract: 'DIGITOVER', barrier: 2,
    side: 0, label: 'Over 2', action: 'EXECUTE', score: 80, danger: 10, independence: 60, confirmed: true, ripe: true, sample: 1000,
    reasons: [], createdAt: 0, refreshedAt: 0, expiresAt: 1e12, ...over,
});
const under8 = (over: Partial<Recommendation> & { action?: VerdictAction } = {}): Recommendation => ({
    ...over2(), id: 'R_75:UNDER8:1', symbol: 'R_75', market: 'Volatility 75', proposition: 'UNDER8', contract: 'DIGITUNDER', barrier: 8, side: 1, label: 'Under 8', ...over,
});
const rec = over2;
const base = { valid: true, busy: false };
// Most tests below are about WHEN it fires, so they run with the entry filter off; the entry tests switch it on.
const cfg = (over: Partial<AutoConfig> = {}): AutoConfig => ({ ...DEFAULT_AUTO, entryTicks: 0, ...over });

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
    it('there is no way to configure unlimited runs, loss, profit chasing or martingale depth', () => {
        expect(sanitizeAuto({ maxRuns: Infinity }).maxRuns).toBe(DEFAULT_AUTO.maxRuns);
        expect(sanitizeAuto({ maxLoss: 0 }).maxLoss).toBeGreaterThan(0);
        expect(sanitizeAuto({ targetProfit: 0 }).targetProfit).toBeGreaterThan(0);
        expect(sanitizeAuto({ maxSteps: 999 }).maxSteps).toBe(AUTO_BOUNDS.maxSteps[1]);
        expect(sanitizeAuto({ maxSteps: 0 }).maxSteps).toBe(1);
        expect(sanitizeAuto({ martingale: 99 }).martingale).toBe(AUTO_BOUNDS.martingale[1]);
        expect(sanitizeAuto({ martingale: 0.2 }).martingale).toBe(1);
        expect(sanitizeAuto({ martingale: Infinity }).martingale).toBe(DEFAULT_AUTO.martingale);
    });
    it('recovery digits can only be digits the Bulk Trader is allowed to trade', () => {
        for (const bad of [0, 4, 5, 6, 7, 8, 9, 10, -1, 2.5, NaN]) expect(sanitizeAuto({ recoveryOver: bad }).recoveryOver).toBe(DEFAULT_AUTO.recoveryOver);
        for (const bad of [0, 1, 2, 3, 4, 5, 9, 10, 7.5, NaN]) expect(sanitizeAuto({ recoveryUnder: bad }).recoveryUnder).toBe(DEFAULT_AUTO.recoveryUnder);
        for (const ok of [1, 2, 3]) expect(sanitizeAuto({ recoveryOver: ok }).recoveryOver).toBe(ok);
        for (const ok of [8, 7, 6]) expect(sanitizeAuto({ recoveryUnder: ok }).recoveryUnder).toBe(ok);
    });
    it('entry settings stay in range and 0 turns the entry filter off', () => {
        expect(sanitizeAuto({ entryTicks: 0 }).entryTicks).toBe(0);
        expect(sanitizeAuto({ entryTicks: 99 }).entryTicks).toBe(AUTO_BOUNDS.entryTicks[1]);
        expect(sanitizeAuto({ entryTicks: -4 }).entryTicks).toBe(0);
        expect(sanitizeAuto({ entryWaitSec: 0 }).entryWaitSec).toBe(AUTO_BOUNDS.entryWaitSec[0]);
        expect(sanitizeAuto({ onCap: 'RESET' }).onCap).toBe('RESET');
        expect(sanitizeAuto({ onCap: 'x' as never }).onCap).toBe('STOP');
        expect(sanitizeAuto({}).recovery).toBe(false);
        expect(sanitizeAuto({ recovery: true }).recovery).toBe(true);
    });
});

describe('contract with over-under-engine', () => {
    it('only the six contracts the Bulk Trader allows exist, and the auto trader uses exactly those', () => {
        expect([...ALLOWED_BARRIERS.DIGITOVER]).toEqual([1, 2, 3]);
        expect([...ALLOWED_BARRIERS.DIGITUNDER]).toEqual([8, 7, 6]);
        for (let digit = -1; digit <= 10; digit += 1) {
            expect(sanitizeAuto({ recoveryOver: digit }).recoveryOver === digit).toBe(ALLOWED_BARRIERS.DIGITOVER.includes(digit));
            expect(sanitizeAuto({ recoveryUnder: digit }).recoveryUnder === digit).toBe(ALLOWED_BARRIERS.DIGITUNDER.includes(digit));
        }
    });
    it('plans are labelled the way the engine labels its own contracts', () => {
        for (const contract of ['DIGITOVER', 'DIGITUNDER'] as const) {
            for (const barrier of ALLOWED_BARRIERS[contract]) {
                const signal = contract === 'DIGITOVER' ? over2({ barrier }) : under8({ barrier });
                expect(planTrade(signal, 0, cfg()).label).toBe(contractLabel(contract, barrier));
            }
        }
    });
});

describe('entry: evidence in the latest ticks', () => {
    it('classifies a digit against the barrier', () => {
        expect(tickSymbol(5, 2)).toBe('O');
        expect(tickSymbol(1, 2)).toBe('U');
        expect(tickSymbol(2, 2)).toBe('=');
        expect(tickSymbols([9, 0, 7, 7], 7, 3)).toEqual(['U', '=', '=']);
    });
    it('asking for no ticks returns none (never the whole history)', () => {
        expect(tickSymbols([9, 0, 7, 7], 7, 0)).toEqual([]);
    });
    it('Over needs the last N ticks all above the barrier; Under needs them all below', () => {
        expect(entrySupports([1, 5, 6, 9], 'DIGITOVER', 2, 3)).toBe(true);
        expect(entrySupports([5, 1, 6, 9], 'DIGITOVER', 2, 3)).toBe(false);
        expect(entrySupports([9, 1, 0, 3], 'DIGITUNDER', 8, 3)).toBe(true);
        expect(entrySupports([9, 9, 0, 3], 'DIGITUNDER', 8, 3)).toBe(false);
    });
    it('a tick exactly on the barrier is not evidence for either side', () => {
        expect(entrySupports([5, 5, 2], 'DIGITOVER', 2, 3)).toBe(false);
        expect(entrySupports([1, 1, 8], 'DIGITUNDER', 8, 3)).toBe(false);
    });
    it('needs enough ticks, and N = 0 means no filter', () => {
        expect(entrySupports([9, 9], 'DIGITOVER', 2, 3)).toBe(false);
        expect(entrySupports([], 'DIGITOVER', 2, 0)).toBe(true);
        expect(entrySupports([0], 'DIGITOVER', 2, 0)).toBe(true);
    });
});

describe('what to trade: the signal, or the recovery contract', () => {
    it('trades the signal\'s own digit at the base stake in normal trading', () => {
        const plan = planTrade(under8(), 0, cfg({ recovery: true }));
        expect(plan).toEqual({ contract: 'DIGITUNDER', barrier: 8, side: 1, label: 'Under 8', recovery: false, step: 0, stakeMultiplier: 1 });
    });
    it('after a loss, an Under signal trades the recovery Under digit and an Over signal trades the recovery Over digit', () => {
        const c = cfg({ recovery: true, recoveryOver: 3, recoveryUnder: 6 });
        expect(planTrade(under8(), 1, c)).toEqual({ contract: 'DIGITUNDER', barrier: 6, side: 1, label: 'Under 6', recovery: true, step: 1, stakeMultiplier: 2 });
        expect(planTrade(over2(), 1, c)).toEqual({ contract: 'DIGITOVER', barrier: 3, side: 0, label: 'Over 3', recovery: true, step: 1, stakeMultiplier: 2 });
    });
    it('the recovery digits are configurable', () => {
        const c = cfg({ recovery: true, recoveryOver: 2, recoveryUnder: 7 });
        expect(planTrade(over2({ barrier: 1, proposition: 'OVER1' }), 1, c).barrier).toBe(2);
        expect(planTrade(under8(), 1, c).barrier).toBe(7);
    });
    it('the side follows the NEXT signal, not the trade that lost', () => {
        // lost on an Under, next signal is an Over: recover with Over 3
        expect(planTrade(over2(), 2, cfg({ recovery: true })).label).toBe('Over 3');
    });
    it('martingale multiplies the stake per consecutive loss, during recovery only', () => {
        const c = cfg({ recovery: true, martingale: 2 });
        expect([1, 2, 3].map(streak => stakeFor(0.5, planTrade(over2(), streak, c)))).toEqual([1, 2, 4]);
        expect(stakeFor(0.5, planTrade(over2(), 0, c))).toBe(0.5);
        expect(stakeFor(0.5, planTrade(over2(), 2, cfg({ recovery: true, martingale: 1.5 })))).toBe(1.13);
        expect(stakeFor(0.5, planTrade(over2(), 2, cfg({ recovery: true, martingale: 1 })))).toBe(0.5);
    });
    it('the martingale step can never pass the configured maximum, whatever streak is passed in', () => {
        const c = cfg({ recovery: true, martingale: 2, maxSteps: 3 });
        expect(planTrade(over2(), 50, c).step).toBe(3);
        expect(stakeFor(0.5, planTrade(over2(), 50, c))).toBe(4);
        expect(planTrade(over2(), -4, c).recovery).toBe(false);
        expect(planTrade(over2(), NaN, c).recovery).toBe(false);
    });
    it('with recovery off there is never a recovery digit or a martingale stake, however many losses', () => {
        const plan = planTrade(under8(), 5, cfg({ recovery: false }));
        expect(plan.recovery).toBe(false);
        expect(plan.barrier).toBe(8);
        expect(plan.stakeMultiplier).toBe(1);
    });
    it('every planned contract is one of the six allowed contracts', () => {
        const allowed = new Set(['DIGITOVER:1', 'DIGITOVER:2', 'DIGITOVER:3', 'DIGITUNDER:8', 'DIGITUNDER:7', 'DIGITUNDER:6']);
        for (const recovery of [false, true]) for (const streak of [0, 1, 4]) for (const r of [over2(), under8()]) {
            const p = planTrade(r, streak, sanitizeAuto({ recovery, recoveryOver: 99, recoveryUnder: 0 }));
            expect(allowed.has(`${p.contract}:${p.barrier}`)).toBe(true);
        }
    });
});

describe('arming', () => {
    it('is off by default and never fires while off, whatever the signal', () => {
        const step = stepAuto(newSession(), cfg(), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
    });
    it('arming starts fresh counters', () => {
        expect(armSession()).toEqual({ armed: true, runs: 0, pnl: 0, lossStreak: 0, lastFiredAt: null, seen: null, pending: null, notice: '', stopReason: '' });
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
        const s = armSession(rec({ action: 'PREPARE' }), 'EXECUTE');
        expect(stepAuto(s, cfg(), { ...base, target: rec({ action: 'EXECUTE' }), now: 1000 }).fire).toBe(true);
    });
});

describe('when it fires (entry filter off)', () => {
    it('fires the moment an EXECUTE signal appears, exactly once, with its plan', () => {
        const first = stepAuto(armSession(), cfg(), { ...base, target: rec(), now: 1000 });
        expect(first.fire).toBe(true);
        expect(first.plan?.label).toBe('Over 2');
        expect(first.session.runs).toBe(1);
        expect(stepAuto(first.session, cfg({ cooldownSec: 5 }), { ...base, target: rec(), now: 60_000 }).fire).toBe(false);
    });
    it('does not fire on PREPARE when the grade is EXECUTE, but does when the grade is ANY', () => {
        const prepare = rec({ action: 'PREPARE' });
        expect(stepAuto(armSession(), cfg(), { ...base, target: prepare, now: 1000 }).fire).toBe(false);
        expect(stepAuto(armSession(), cfg({ grade: 'ANY' }), { ...base, target: prepare, now: 1000 }).fire).toBe(true);
    });
    it('never fires on OBSERVE or STAND_DOWN in either grade', () => {
        for (const action of ['OBSERVE', 'STAND_DOWN'] as const) for (const grade of ['EXECUTE', 'ANY'] as const) {
            expect(stepAuto(armSession(), cfg({ grade }), { ...base, target: rec({ action }), now: 1000 }).fire).toBe(false);
        }
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
        const early = stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 10_000 });
        expect(early.fire).toBe(false);
        expect(early.note).toMatch(/Cooling down/);
        s = stepAuto(early.session, cfg(), { ...base, target: rec({ action: 'PREPARE' }), now: 20_000 }).session;
        expect(stepAuto(s, cfg({ cooldownSec: 30 }), { ...base, target: rec(), now: 31_000 }).fire).toBe(true);
    });
    it('a different signal at the same grade is a new signal', () => {
        let s = armSession();
        s = stepAuto(s, cfg({ cooldownSec: 5 }), { ...base, target: rec(), now: 0 }).session;
        expect(signalKey(under8())).not.toBe(signalKey(rec()));
        expect(stepAuto(s, cfg({ cooldownSec: 5 }), { ...base, target: under8(), now: 6_000 }).fire).toBe(true);
    });
});

describe('entry: a fired signal waits for the latest ticks', () => {
    const entry = (over: Partial<AutoConfig> = {}) => cfg({ entryTicks: 3, entryWaitSec: 20, ...over });
    it('does not buy on the signal alone: it waits, then buys when the last N ticks support the side', () => {
        const waiting = stepAuto(armSession(), entry(), { ...base, target: rec(), now: 0, digits: [9, 0, 5, 1] });
        expect(waiting.fire).toBe(false);
        expect(waiting.session.pending).not.toBeNull();
        expect(waiting.session.runs).toBe(0);
        expect(waiting.note).toMatch(/Waiting for entry/);
        expect(waiting.note).toMatch(/O/);
        const bought = stepAuto(waiting.session, entry(), { ...base, target: rec(), now: 4_000, digits: [9, 0, 5, 1, 4, 6, 8] });
        expect(bought.fire).toBe(true);
        expect(bought.plan?.label).toBe('Over 2');
        expect(bought.session.runs).toBe(1);
        expect(bought.session.pending).toBeNull();
        expect(bought.session.lastFiredAt).toBe(4_000);
    });
    it('fires on the same step when the ticks already support the side', () => {
        const step = stepAuto(armSession(), entry(), { ...base, target: rec(), now: 0, digits: [1, 5, 6, 7] });
        expect(step.fire).toBe(true);
        expect(step.session.pending).toBeNull();
    });
    it('an Under signal needs U ticks, and opposite ticks do not count', () => {
        const opposite = stepAuto(armSession(), entry(), { ...base, target: under8(), now: 0, digits: [9, 9, 9] });
        expect(opposite.fire).toBe(false);
        const right = stepAuto(opposite.session, entry(), { ...base, target: under8(), now: 2_000, digits: [9, 9, 9, 1, 0, 4] });
        expect(right.fire).toBe(true);
        expect(right.plan?.label).toBe('Under 8');
    });
    it('gives up after the entry wait and never trades that signal late', () => {
        const s = stepAuto(armSession(), entry({ entryWaitSec: 10 }), { ...base, target: rec(), now: 0, digits: [0, 0, 0] }).session;
        const late = stepAuto(s, entry({ entryWaitSec: 10 }), { ...base, target: rec(), now: 10_001, digits: [0, 0, 0] });
        expect(late.fire).toBe(false);
        expect(late.session.pending).toBeNull();
        expect(late.note).toMatch(/No entry within 10s/);
        const after = stepAuto(late.session, entry({ entryWaitSec: 10 }), { ...base, target: rec(), now: 11_000, digits: [9, 9, 9] });
        expect(after.fire).toBe(false);       // the same signal is still "seen": it is not re-armed by good ticks arriving late
    });
    it('drops the wait if the signal goes away, changes, or fails the live check', () => {
        const waiting = stepAuto(armSession(), entry(), { ...base, target: rec(), now: 0, digits: [0, 0, 0] }).session;
        expect(stepAuto(waiting, entry(), { ...base, target: null, now: 1000, digits: [9, 9, 9] }).session.pending).toBeNull();
        const changed = stepAuto(waiting, entry(), { ...base, target: under8(), now: 1000, digits: [1, 1, 1] });
        expect(changed.session.pending).toBeNull();
        expect(changed.fire).toBe(false);
        const invalid = stepAuto(waiting, entry(), { ...base, valid: false, target: rec(), now: 1000, digits: [9, 9, 9] });
        expect(invalid.fire).toBe(false);
        expect(invalid.session.pending).toBeNull();
        const downgraded = stepAuto(waiting, entry({ grade: 'EXECUTE' }), { ...base, target: rec({ action: 'PREPARE' }), now: 1000, digits: [9, 9, 9] });
        expect(downgraded.fire).toBe(false);
    });
    it('never starts a second run while waiting if a run is active', () => {
        const waiting = stepAuto(armSession(), entry(), { ...base, target: rec(), now: 0, digits: [0, 0, 0] }).session;
        const busy = stepAuto(waiting, entry(), { ...base, busy: true, target: rec(), now: 1000, digits: [9, 9, 9] });
        expect(busy.fire).toBe(false);
        expect(busy.session.pending).not.toBeNull();
    });
    it('the entry check uses the contract that will actually be traded (the recovery digit during recovery)', () => {
        const c = entry({ recovery: true, recoveryUnder: 6 });
        const session = { ...armSession(), lossStreak: 1 };
        // 7 is "U" against barrier 8 but "O" against the recovery barrier 6: not evidence for Under 6
        const notYet = stepAuto(session, c, { ...base, target: under8(), now: 0, digits: [7, 7, 7] });
        expect(notYet.fire).toBe(false);
        const ok = stepAuto(notYet.session, c, { ...base, target: under8(), now: 1000, digits: [7, 7, 7, 2, 3, 5] });
        expect(ok.fire).toBe(true);
        expect(ok.plan?.label).toBe('Under 6');
    });
    it('keeps the reason a signal was skipped on screen until the next signal arrives', () => {
        const c = entry({ entryWaitSec: 5 });
        const waiting = stepAuto(armSession(), c, { ...base, target: rec(), now: 0, digits: [0, 9, 0] }).session;
        const skipped = stepAuto(waiting, c, { ...base, target: rec(), now: 6_000, digits: [0, 9, 0] });
        expect(skipped.note).toMatch(/No entry within 5s/);
        const later = stepAuto(skipped.session, c, { ...base, target: rec(), now: 6_200, digits: [0, 9, 0] });
        expect(later.note).toMatch(/No entry within 5s/);          // still explained 200 ms later
        const gone = stepAuto(later.session, c, { ...base, target: null, now: 7_000 });
        expect(gone.note).toMatch(/No entry within 5s/);
        // a new signal clears the old reason
        const fresh = stepAuto(gone.session, c, { ...base, target: under8(), now: 9_000, digits: [0, 9, 0] });
        expect(fresh.note).toMatch(/Waiting for entry/);
        expect(fresh.session.notice).toBe('');
    });
    it('cooldown and a busy run block the signal before any waiting starts', () => {
        let s = armSession();
        s = stepAuto(s, entry({ entryTicks: 0 }), { ...base, target: rec(), now: 0 }).session;
        s = stepAuto(s, entry(), { ...base, target: null, now: 500 }).session;
        const cooling = stepAuto(s, entry({ cooldownSec: 30 }), { ...base, target: rec(), now: 10_000, digits: [0, 0, 0] });
        expect(cooling.session.pending).toBeNull();
        expect(cooling.fire).toBe(false);
        const busy = stepAuto(armSession(), entry(), { ...base, busy: true, target: rec(), now: 0, digits: [0, 0, 0] });
        expect(busy.session.pending).toBeNull();
    });
});

describe('recovery and martingale across runs', () => {
    const rc = (over: Partial<AutoConfig> = {}) => cfg({ recovery: true, recoveryOver: 3, recoveryUnder: 6, martingale: 2, maxSteps: 3, maxRuns: 50, maxLoss: 10_000, targetProfit: 10_000, ...over });
    const lose = (s: AutoSession, c: AutoConfig) => recordAutoRun(s, { placed: 10, failed: 0, pnl: -1 }, c);
    const win = (s: AutoSession, c: AutoConfig) => recordAutoRun(s, { placed: 10, failed: 0, pnl: 0.4 }, c);

    it('a losing run puts the next signal into recovery; a win puts it back to normal', () => {
        const c = rc();
        let s = lose(armSession(), c);
        expect(s.lossStreak).toBe(1);
        expect(modeText(s, c)).toBe('RECOVERY step 1 of 3');
        s = lose(s, c); expect(s.lossStreak).toBe(2);
        s = win(s, c); expect(s.lossStreak).toBe(0);
        expect(modeText(s, c)).toBe('NORMAL');
    });
    it('the full path: loss on Under 8, next Under signal trades Under 6 at 2x, a win returns to Under 8 at the base stake', () => {
        const c = rc();
        const first = stepAuto(armSession(), c, { ...base, target: under8(), now: 0 });
        expect(first.plan?.label).toBe('Under 8');
        expect(stakeFor(0.5, first.plan!)).toBe(0.5);
        let s = lose(first.session, c);
        s = stepAuto(s, c, { ...base, target: null, now: 1000 }).session;
        const second = stepAuto(s, rc({ cooldownSec: 5 }), { ...base, target: under8(), now: 40_000 });
        expect(second.plan?.label).toBe('Under 6');
        expect(second.plan?.recovery).toBe(true);
        expect(stakeFor(0.5, second.plan!)).toBe(1);
        s = win(second.session, c);
        s = stepAuto(s, c, { ...base, target: null, now: 41_000 }).session;
        const third = stepAuto(s, rc({ cooldownSec: 5 }), { ...base, target: under8(), now: 80_000 });
        expect(third.plan?.label).toBe('Under 8');
        expect(stakeFor(0.5, third.plan!)).toBe(0.5);
    });
    it('stops at the recovery limit when told to stop', () => {
        const c = rc({ maxSteps: 2, onCap: 'STOP' });
        let s = armSession();
        s = lose(s, c); s = lose(s, c);
        expect(s.armed).toBe(true);
        s = lose(s, c);
        expect(s.armed).toBe(false);
        expect(s.stopReason).toMatch(/recovery limit of 2 steps/);
    });
    it('resets to normal trading at the recovery limit when told to reset', () => {
        const c = rc({ maxSteps: 2, onCap: 'RESET' });
        let s = armSession();
        s = lose(s, c); s = lose(s, c); s = lose(s, c);
        expect(s.armed).toBe(true);
        expect(s.lossStreak).toBe(0);
    });
    it('with recovery off, losses never change what is traded or the stake and never trigger the recovery limit', () => {
        const c = rc({ recovery: false, maxSteps: 1 });
        let s = armSession();
        for (let i = 0; i < 4; i++) s = lose(s, c);
        expect(s.armed).toBe(true);
        expect(planTrade(under8(), s.lossStreak, c).barrier).toBe(8);
        expect(modeText(s, c)).toBe('NORMAL');
    });
    it('a break-even run leaves the streak unchanged', () => {
        const c = rc();
        const s = recordAutoRun(lose(armSession(), c), { placed: 10, failed: 0, pnl: 0 }, c);
        expect(s.lossStreak).toBe(1);
    });
    it('the martingale never grows past the allowed depth', () => {
        const c = rc({ maxSteps: 3, martingale: 2, onCap: 'STOP' });
        let s = armSession(); const stakes: number[] = [];
        while (s.armed) { s = lose(s, c); if (s.armed) stakes.push(stakeFor(0.5, planTrade(over2(), s.lossStreak, c))); }
        expect(stakes).toEqual([1, 2, 4]);
    });
});

describe('loss-limit guard: checked before a run is fired', () => {
    // maxLoss 5, with a base stake and number of bulk trades supplied so the worst case of the run can be worked out.
    const guarded = (over: Partial<AutoConfig> = {}) => cfg({ maxLoss: 5, ...over });
    const at = (stake: number, runs: number) => ({ baseStake: stake, bulkRuns: runs });

    it('measures the risk of the run itself: stake x number of bulk trades, at the stake that will really be placed', () => {
        expect(planRisk(0.5, 4, planTrade(rec(), 0, cfg()))).toBe(2);
        expect(planRisk(0.5, 4, planTrade(rec(), 2, cfg({ recovery: true, martingale: 2 })))).toBe(8);
        expect(planRisk(0.1, 1, planTrade(rec(), 0, cfg()))).toBe(0.35);      // the minimum stake is applied, as it is at execution
    });
    it('what is left is the loss limit plus realised P/L: losses use it up, profit is headroom', () => {
        expect(lossAllowance({ ...armSession(), pnl: 0 }, guarded())).toBe(5);
        expect(lossAllowance({ ...armSession(), pnl: -3.25 }, guarded())).toBe(1.75);
        expect(lossAllowance({ ...armSession(), pnl: 2 }, guarded())).toBe(7);
    });
    it('does not fire a run whose worst case could pass the loss limit, even though nothing has been lost yet', () => {
        const step = stepAuto(armSession(), guarded(), { ...base, target: rec(), now: 1000, ...at(1, 6) });
        expect(step.fire).toBe(false);
        expect(step.plan).toBeNull();
        expect(step.session.armed).toBe(false);
        expect(step.session.runs).toBe(0);
        expect(step.session.stopReason).toMatch(/risks 6\.00/);
        expect(step.session.stopReason).toMatch(/loss limit of 5\.00/);
    });
    it('fires when the worst case fits exactly inside what is left, and not when it is one trade over', () => {
        const session = { ...armSession(), pnl: -3 };
        expect(stepAuto(session, guarded(), { ...base, target: rec(), now: 1000, ...at(1, 2) }).fire).toBe(true);
        const over = stepAuto(session, guarded(), { ...base, target: rec(), now: 1000, ...at(1, 3) });
        expect(over.fire).toBe(false);
        expect(over.session.armed).toBe(false);
    });
    it('counts realised profit as headroom', () => {
        const session = { ...armSession(), pnl: 2 };
        expect(stepAuto(session, guarded(), { ...base, target: rec(), now: 1000, ...at(1, 6) }).fire).toBe(true);
    });
    it('vets the martingale stake of a recovery run, not just the base stake', () => {
        const c = guarded({ recovery: true, martingale: 2, onCap: 'STOP' });
        const fits = stepAuto({ ...armSession(), pnl: -1, lossStreak: 2 }, c, { ...base, target: rec(), now: 1000, ...at(1, 1) });
        expect(fits.fire).toBe(true);                       // 1 x 2^2 = 4, exactly what is left (5 - 1)
        expect(fits.plan?.recovery).toBe(true);
        const tooBig = stepAuto({ ...armSession(), pnl: -1, lossStreak: 3 }, c, { ...base, target: rec(), now: 1000, ...at(1, 1) });
        expect(tooBig.fire).toBe(false);                    // 1 x 2^3 = 8 > 4
        expect(tooBig.session.armed).toBe(false);
        expect(tooBig.session.stopReason).toMatch(/risks 8\.00/);
    });
    it('RESET drops back to normal staking when the normal stake is safe, and says so', () => {
        const c = guarded({ recovery: true, martingale: 2, onCap: 'RESET' });
        const step = stepAuto({ ...armSession(), pnl: -1, lossStreak: 3 }, c, { ...base, target: rec(), now: 1000, ...at(1, 1) });
        expect(step.fire).toBe(true);
        expect(step.plan?.recovery).toBe(false);
        expect(step.plan?.label).toBe('Over 2');
        expect(stakeFor(1, step.plan!)).toBe(1);
        expect(step.session.lossStreak).toBe(0);
        expect(step.session.armed).toBe(true);
        expect(step.note).toMatch(/Back to normal trading/);
    });
    it('RESET still switches off when even the normal stake would pass the limit', () => {
        const c = guarded({ recovery: true, martingale: 2, onCap: 'RESET' });
        const step = stepAuto({ ...armSession(), pnl: -4, lossStreak: 2 }, c, { ...base, target: rec(), now: 1000, ...at(2, 1) });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
    });
    it('with recovery off, a base-stake run that does not fit switches it off', () => {
        const step = stepAuto({ ...armSession(), pnl: -4.5 }, guarded({ recovery: false }), { ...base, target: rec(), now: 1000, ...at(1, 1) });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
    });
    it('uses the minimum stake that execution will apply, not a smaller number typed in', () => {
        const step = stepAuto({ ...armSession(), pnl: -0.2 }, cfg({ maxLoss: 0.5 }), { ...base, target: rec(), now: 1000, ...at(0.1, 1) });
        expect(step.fire).toBe(false);                      // 0.1 is raised to 0.35, which is more than the 0.30 left
    });
    it('is applied again at the moment the entry is confirmed, before the buy', () => {
        const entry = cfg({ maxLoss: 5, entryTicks: 3, entryWaitSec: 20 });
        const waiting = stepAuto(armSession(), entry, { ...base, target: rec(), now: 0, digits: [0, 0, 0], ...at(1, 1) });
        expect(waiting.session.pending).not.toBeNull();
        const blocked = stepAuto({ ...waiting.session, pnl: -4.5 }, entry, { ...base, target: rec(), now: 1000, digits: [9, 9, 9], ...at(1, 1) });
        expect(blocked.fire).toBe(false);
        expect(blocked.session.armed).toBe(false);
        expect(blocked.session.pending).toBeNull();
    });
    it('a run that is inside the limit is unaffected', () => {
        const step = stepAuto(armSession(), guarded(), { ...base, target: rec(), now: 1000, ...at(0.5, 4) });
        expect(step.fire).toBe(true);
        expect(step.session.armed).toBe(true);
    });
});

describe('what stops it from firing', () => {
    it('never starts a second run while one is active, and the missed signal is not traded later', () => {
        const busy = stepAuto(armSession(), cfg(), { ...base, busy: true, target: rec(), now: 1000 });
        expect(busy.fire).toBe(false);
        expect(stepAuto(busy.session, cfg(), { ...base, busy: false, target: rec(), now: 99_000 }).fire).toBe(false);
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
        expect(stepAuto({ ...armSession(), pnl: -4.99 }, cfg({ maxLoss: 5 }), { ...base, target: null, now: 1 }).session.armed).toBe(true);
        const step = stepAuto({ ...armSession(), pnl: -5 }, cfg({ maxLoss: 5 }), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
        expect(step.session.stopReason).toMatch(/loss limit/);
    });
    it('stops when realised profit reaches the target, and not before', () => {
        expect(stepAuto({ ...armSession(), pnl: 4.99 }, cfg({ targetProfit: 5 }), { ...base, target: null, now: 1 }).session.armed).toBe(true);
        const step = stepAuto({ ...armSession(), pnl: 5 }, cfg({ targetProfit: 5 }), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.session.armed).toBe(false);
        expect(step.session.stopReason).toMatch(/target profit of 5.00 reached/);
    });
    it('the target is checked on realised P/L after each run, so a winning run ends the session', () => {
        const c = cfg({ targetProfit: 0.35 });
        const done = recordAutoRun(armSession(), { placed: 10, failed: 0, pnl: 0.4 }, c);
        const step = stepAuto(done, c, { ...base, target: rec(), now: 5000 });
        expect(step.session.armed).toBe(false);
        expect(step.fire).toBe(false);
    });
    it('profit does not extend the run limit', () => {
        expect(stepAuto({ ...armSession(), runs: 5, pnl: 1 }, cfg({ maxRuns: 5 }), { ...base, target: rec(), now: 1 }).session.armed).toBe(false);
    });
    it('once stopped it stays off until armed again', () => {
        const step = stepAuto(disarmSession(armSession(), 'Stopped by you.'), cfg(), { ...base, target: rec(), now: 1000 });
        expect(step.fire).toBe(false);
        expect(step.note).toBe('Stopped by you.');
    });
    it('disarming cancels any entry wait', () => {
        const waiting = stepAuto(armSession(), cfg({ entryTicks: 3 }), { ...base, target: rec(), now: 0, digits: [0, 0, 0] }).session;
        expect(disarmSession(waiting, 'Off.').pending).toBeNull();
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
    it('switches off if a contract never reported its result, because the session P/L can no longer be trusted', () => {
        const done = recordAutoRun(armSession(), { placed: 10, failed: 0, pnl: -1, unsettled: 2 });
        expect(done.armed).toBe(false);
        expect(done.stopReason).toMatch(/2 contracts did not report a result/);
        expect(done.pnl).toBe(-1);
        expect(recordAutoRun(armSession(), { placed: 10, failed: 0, pnl: 0.4, unsettled: 0 }).armed).toBe(true);
    });
    it('a session switched off during the run (Stop pressed, loss guard) keeps its own reason', () => {
        const stopped = disarmSession(armSession(), 'Stopped by you.');
        const done = recordAutoRun(stopped, { placed: 0, failed: 0, pnl: 0 });
        expect(done.armed).toBe(false);
        expect(done.stopReason).toBe('Stopped by you.');
        const afterRun = recordAutoRun(stopped, { placed: 5, failed: 0, pnl: -0.5 }, cfg({ recovery: true, maxSteps: 1 }));
        expect(afterRun.armed).toBe(false);
        expect(afterRun.stopReason).toBe('Stopped by you.');
        expect(afterRun.pnl).toBe(-0.5);
    });
});

describe('entry timing: a one-tick trade decided on tick 0 must enter and settle on tick 1', () => {
    // Ticks 1 s apart. The decision is made on the tick printed at t = 10 000 ms.
    const times = [8000, 9000, 10000];
    const decided = 10000;

    it('the tick has not moved while the latest tick is still the decision tick', () => {
        expect(tickMoved(times, decided)).toBe(false);
    });
    it('the tick has moved once a newer tick printed, so the buy would enter a tick late', () => {
        expect(tickMoved([...times, 11000], decided)).toBe(true);
    });
    it('an unknown decision time or an empty tick list never blocks a trade', () => {
        expect(tickMoved(times, 0)).toBe(false);
        expect(tickMoved([], decided)).toBe(false);
    });

    it('entry on the very next tick has no slip', () => {
        expect(entrySlip([...times, 11000, 12000], decided, 11)).toBe(0);
    });
    it('entry one tick later is reported as a slip of 1, two later as 2', () => {
        expect(entrySlip([...times, 11000, 12000], decided, 12)).toBe(1);
        expect(entrySlip([...times, 11000, 12000, 13000], decided, 13)).toBe(2);
    });
    it('an entry time that is missing, invalid or not after the decision is unknown, never "on time"', () => {
        expect(entrySlip(times, decided, null)).toBeNull();
        expect(entrySlip(times, decided, 0)).toBeNull();
        expect(entrySlip(times, decided, Number.NaN)).toBeNull();
        expect(entrySlip(times, decided, 10)).toBeNull();
        expect(entrySlip(times, decided, 9)).toBeNull();
    });

    it('slipText says when every trade was on time, when some were late, and nothing when nothing is known', () => {
        expect(slipText([])).toBe('');
        expect(slipText([null, null])).toBe('');
        expect(slipText([0, 0])).toMatch(/all trades entered on the very next tick/);
        expect(slipText([0, 1, 2])).toMatch(/2 of 3 trades entered late \(up to 2 ticks\)/);
        expect(slipText([1])).toMatch(/1 of 1 trade entered late \(up to 1 tick\)/);
        expect(slipText([0, 1, null])).toMatch(/1 of 2 trades entered late/);
    });

    describe('releasing a run whose entry tick moved on', () => {
        const fired = () => {
            const step = stepAuto(armSession(), cfg(), { ...base, target: rec(), now: 1000, digits: [5, 5, 5] });
            expect(step.fire).toBe(true);
            return step.session;
        };

        it('gives the run back, keeps the trader armed, and does not count it or stop it', () => {
            const session = fired();
            expect(session.runs).toBe(1);
            const back = releaseRun(session, signalKey(rec()), 1200, 'moved on');
            expect(back.runs).toBe(0);
            expect(back.armed).toBe(true);
            expect(back.pnl).toBe(0);
            expect(back.lossStreak).toBe(0);
            expect(back.notice).toBe('moved on');
        });
        it('never takes a run count below zero', () => {
            expect(releaseRun(armSession(), 'k', 0, 'x').runs).toBe(0);
        });
        it('puts the signal back to waiting for entry, and it fires again on the newest ticks at once (no cooldown, no lost signal)', () => {
            const back = releaseRun(fired(), signalKey(rec()), 1200, 'moved on');
            expect(back.pending).toEqual({ key: signalKey(rec()), since: 1200 });
            const again = stepAuto(back, cfg({ cooldownSec: 600 }), {
                ...base,
                target: rec(),
                now: 1300,
                digits: [5, 5, 5, 6],
            });
            expect(again.fire).toBe(true);
            expect(again.session.runs).toBe(1);
            expect(again.session.pending).toBeNull();
        });
        it('waits for the entry digits again if the new tick breaks the entry condition', () => {
            const config = cfg({ entryTicks: 2 });
            const back = releaseRun(fired(), signalKey(rec()), 1200, 'moved on');
            const held = stepAuto(back, config, { ...base, target: rec(), now: 1300, digits: [5, 5, 1] });
            expect(held.fire).toBe(false);
            expect(held.session.armed).toBe(true);
            expect(held.session.pending).not.toBeNull();
            const later = stepAuto(held.session, config, {
                ...base,
                target: rec(),
                now: 1400,
                digits: [5, 5, 1, 4, 5],
            });
            expect(later.fire).toBe(true);
        });
        it('still drops the signal if the entry never comes within the wait window', () => {
            const config = cfg({ entryTicks: 2, entryWaitSec: 5 });
            const back = releaseRun(fired(), signalKey(rec()), 1000, 'moved on');
            const late = stepAuto(back, config, { ...base, target: rec(), now: 1000 + 6000, digits: [1, 1, 1] });
            expect(late.fire).toBe(false);
            expect(late.session.pending).toBeNull();
            expect(late.note).toMatch(/No entry within/);
        });
    });
});
