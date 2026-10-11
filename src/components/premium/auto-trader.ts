// Auto Trader decision logic for the Bulk Trader. Pure and framework-free: it decides WHEN a run should start, WHAT to trade
// (the signal's own contract, or the recovery contract after a loss), at what stake, and when the auto trader must stop itself.
// It never places a trade; the page does that through the same Run path a manual press uses, so every contract restriction,
// exposure cap and live re-check still applies.
//
// The signal is the trigger, the latest ticks are the entry:
//   1. a NEW signal reaches the chosen grade                       -> the auto trader starts WATCHING for an entry
//   2. the last `entryTicks` ticks all show the traded side         -> it fires (O ticks for Over, U ticks for Under)
//   3. no such ticks within `entryWaitSec`, or the signal changes   -> the signal is skipped, never traded late
// After a losing run, recovery (if enabled) trades the NEXT signal at a riskier recovery digit with a martingale stake.
//
// Loss limit: a run is never fired if its worst case (stake x number of bulk trades) could take the session past its loss limit.
import { exposure, sanitizeBulk } from './bulk-run';
import { ALLOWED_BARRIERS, contractLabel, type OverUnderContract, type Recommendation } from './over-under-engine';

export type AutoGrade = 'EXECUTE' | 'ANY';
export type CapAction = 'STOP' | 'RESET';

export type AutoConfig = {
    /** EXECUTE: only the engine's EXECUTE grade. ANY: EXECUTE or PREPARE. */
    grade: AutoGrade;
    /** Minimum seconds between two auto runs. */
    cooldownSec: number;
    /** The auto trader switches itself off after this many runs... */
    maxRuns: number;
    /** ...or when realised losses for the session reach this amount (account currency). */
    maxLoss: number;
    /** ...or when realised profit for the session reaches this amount. */
    targetProfit: number;
    /** Entry: the last N ticks must all show the traded side before it buys. 0 = enter as soon as the signal fires. */
    entryTicks: number;
    /** Entry: how long to wait for those ticks before the signal is skipped. */
    entryWaitSec: number;
    /** Recovery mode after a losing run (also switches martingale on). */
    recovery: boolean;
    /** Recovery digit used when the next signal is an Over signal (must be an allowed Over barrier: 1, 2 or 3). */
    recoveryOver: number;
    /** Recovery digit used when the next signal is an Under signal (must be an allowed Under barrier: 8, 7 or 6). */
    recoveryUnder: number;
    /** Stake multiplier per consecutive losing run, applied during recovery only. 1 = no martingale. */
    martingale: number;
    /** Maximum consecutive recovery trades. */
    maxSteps: number;
    /** What happens when the recovery limit is hit: stop the auto trader, or go back to normal trading at the base stake. */
    onCap: CapAction;
};

export const DEFAULT_AUTO: AutoConfig = {
    grade: 'EXECUTE', cooldownSec: 30, maxRuns: 5, maxLoss: 5, targetProfit: 5, entryTicks: 3, entryWaitSec: 20,
    recovery: false, recoveryOver: 3, recoveryUnder: 6, martingale: 2, maxSteps: 3, onCap: 'STOP',
};
export const AUTO_BOUNDS = {
    cooldownSec: [5, 600], maxRuns: [1, 50], maxLoss: [0.35, 10_000], targetProfit: [0.35, 10_000],
    entryTicks: [0, 10], entryWaitSec: [5, 120], martingale: [1, 5], maxSteps: [1, 6],
} as const;

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

export const sanitizeAuto = (input: Partial<AutoConfig>): AutoConfig => {
    const n = (value: unknown, fallback: number, bounds: readonly [number, number]) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? clamp(parsed, bounds) : fallback;
    };
    // Recovery digits can only ever be digits the Bulk Trader is allowed to trade; anything else falls back to the default.
    const allowed = (value: unknown, list: readonly number[], fallback: number) => (list.includes(Number(value)) ? Number(value) : fallback);
    return {
        grade: input.grade === 'ANY' ? 'ANY' : 'EXECUTE',
        cooldownSec: Math.trunc(n(input.cooldownSec, DEFAULT_AUTO.cooldownSec, AUTO_BOUNDS.cooldownSec)),
        maxRuns: Math.trunc(n(input.maxRuns, DEFAULT_AUTO.maxRuns, AUTO_BOUNDS.maxRuns)),
        maxLoss: round2(n(input.maxLoss, DEFAULT_AUTO.maxLoss, AUTO_BOUNDS.maxLoss)),
        targetProfit: round2(n(input.targetProfit, DEFAULT_AUTO.targetProfit, AUTO_BOUNDS.targetProfit)),
        entryTicks: Math.trunc(n(input.entryTicks, DEFAULT_AUTO.entryTicks, AUTO_BOUNDS.entryTicks)),
        entryWaitSec: Math.trunc(n(input.entryWaitSec, DEFAULT_AUTO.entryWaitSec, AUTO_BOUNDS.entryWaitSec)),
        recovery: input.recovery === true,
        recoveryOver: allowed(input.recoveryOver, ALLOWED_BARRIERS.DIGITOVER, DEFAULT_AUTO.recoveryOver),
        recoveryUnder: allowed(input.recoveryUnder, ALLOWED_BARRIERS.DIGITUNDER, DEFAULT_AUTO.recoveryUnder),
        martingale: round2(n(input.martingale, DEFAULT_AUTO.martingale, AUTO_BOUNDS.martingale)),
        maxSteps: Math.trunc(n(input.maxSteps, DEFAULT_AUTO.maxSteps, AUTO_BOUNDS.maxSteps)),
        onCap: input.onCap === 'RESET' ? 'RESET' : 'STOP',
    };
};

// ---------------------------------------------------------------------------
// Entry: evidence in the latest ticks
// ---------------------------------------------------------------------------

export type TickSymbol = 'O' | 'U' | '=';

/** A digit relative to a barrier: O = above it (an Over win), U = below it (an Under win), = on it (loses both). */
export const tickSymbol = (digit: number, barrier: number): TickSymbol => (digit > barrier ? 'O' : digit < barrier ? 'U' : '=');

export const tickSymbols = (digits: number[], barrier: number, count: number): TickSymbol[] =>
    (count <= 0 ? [] : digits.slice(-count)).map(digit => tickSymbol(digit, barrier));

/** Do the last `n` ticks all show the side the contract needs? n <= 0 means no entry filter. */
export const entrySupports = (digits: number[], contract: OverUnderContract, barrier: number, n: number): boolean => {
    if (n <= 0) return true;
    if (digits.length < n) return false;
    const need: TickSymbol = contract === 'DIGITOVER' ? 'O' : 'U';
    return tickSymbols(digits, barrier, n).every(symbol => symbol === need);
};

// ---------------------------------------------------------------------------
// What to trade: the signal's own contract, or the recovery contract after a loss
// ---------------------------------------------------------------------------

export type TradePlan = {
    contract: OverUnderContract;
    barrier: number;
    side: 0 | 1;
    label: string;
    /** True when this is a recovery trade (recovery digit + martingale stake). */
    recovery: boolean;
    /** Consecutive losses being recovered (0 in normal trading). */
    step: number;
    /** Multiply the base stake by this. 1 outside recovery. */
    stakeMultiplier: number;
};

/**
 * Recovery trades the NEXT signal's side at the recovery digit (Under signal -> Under 6, Over signal -> Over 3 by default),
 * with the stake multiplied by `martingale` for each consecutive loss. Normal trading follows the signal's own digit at the base stake.
 * The step is capped at `maxSteps` here as well, so the martingale can never grow past the configured depth whatever the caller passes.
 */
export const planTrade = (rec: Recommendation, lossStreak: number, config: AutoConfig): TradePlan => {
    const step = config.recovery ? Math.min(Math.max(0, Math.trunc(lossStreak) || 0), config.maxSteps) : 0;
    const inRecovery = step >= 1;
    const contract: OverUnderContract = rec.side === 0 ? 'DIGITOVER' : 'DIGITUNDER';
    const barrier = inRecovery ? (rec.side === 0 ? config.recoveryOver : config.recoveryUnder) : rec.barrier;
    return {
        contract, barrier, side: rec.side, label: contractLabel(contract, barrier), recovery: inRecovery,
        step, stakeMultiplier: inRecovery ? round2(config.martingale ** step) : 1,
    };
};

export const stakeFor = (baseStake: number, plan: TradePlan): number => round2(baseStake * plan.stakeMultiplier);

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------

export type AutoSession = {
    armed: boolean;
    runs: number;
    /** Realised profit/loss of this session's auto runs. */
    pnl: number;
    /** Consecutive losing runs. Drives recovery and martingale. */
    lossStreak: number;
    lastFiredAt: number | null;
    /** The signal seen on the previous step, and whether it already met the grade. Used to detect a NEW signal. */
    seen: { key: string; ready: boolean } | null;
    /** A new signal is waiting for its entry ticks. */
    pending: { key: string; since: number } | null;
    /** Why the last signal was skipped. Stays visible until the next signal arrives, so the reason is never missed. */
    notice: string;
    stopReason: string;
};

export const signalKey = (rec: Recommendation) => `${rec.symbol}:${rec.proposition}`;

const meetsGrade = (rec: Recommendation, grade: AutoGrade) =>
    grade === 'ANY' ? rec.action === 'EXECUTE' || rec.action === 'PREPARE' : rec.action === 'EXECUTE';

export const newSession = (): AutoSession => ({ armed: false, runs: 0, pnl: 0, lossStreak: 0, lastFiredAt: null, seen: null, pending: null, notice: '', stopReason: '' });
/**
 * Arming always starts fresh counters, so a previous session's limits never carry over silently. Pass the signal that is on
 * screen at the moment of arming: it counts as already seen, so arming never fires on a signal that was there before the click.
 */
export const armSession = (onScreen: Recommendation | null = null, grade: AutoGrade = 'EXECUTE'): AutoSession => ({
    ...newSession(), armed: true, seen: onScreen ? { key: signalKey(onScreen), ready: meetsGrade(onScreen, grade) } : null,
});
export const disarmSession = (session: AutoSession, reason: string): AutoSession => ({ ...session, armed: false, pending: null, stopReason: reason });

// ---------------------------------------------------------------------------
// Loss-limit guard: checked BEFORE a run is fired, against the risk of the run itself
// ---------------------------------------------------------------------------

/**
 * Worst-case loss of one run if the plan is traded: stake x number of bulk trades. Uses the same sanitising and `exposure` maths as
 * the execution path, so a stake that would be clamped up to the minimum is counted at the clamped value.
 */
export const planRisk = (baseStake: number, bulkRuns: number, plan: TradePlan): number =>
    exposure(sanitizeBulk({ stake: stakeFor(baseStake, plan), runs: bulkRuns }));

/** What the session can still lose before its loss limit stops it. Realised profit is headroom, realised losses use it up. */
export const lossAllowance = (session: AutoSession, config: AutoConfig): number => round2(config.maxLoss + session.pnl);

/** Null when a run risking `risk` keeps the session inside its loss limit, otherwise the reason it must not be placed. */
export const lossLimitError = (session: AutoSession, config: AutoConfig, risk: number): string | null => {
    const left = lossAllowance(session, config);
    if (!(config.maxLoss > 0) || risk <= left) return null;
    return `Stopped: the next trade risks ${risk.toFixed(2)}, more than the ${Math.max(0, left).toFixed(2)} left before the session loss limit of ${config.maxLoss.toFixed(2)}.`;
};

export type AutoInput = {
    /** The signal the auto trader may trade: the locked signal if one is locked, otherwise the one on screen. */
    target: Recommendation | null;
    /** The target passed the engine's live re-check this moment. */
    valid: boolean;
    /** A run is already in progress. */
    busy: boolean;
    now: number;
    /** The latest digits of the target's market, newest last. Used for the entry check. */
    digits?: number[];
    /** The base stake and the number of bulk trades per run. When both are given, the loss-limit guard is applied before firing. */
    baseStake?: number;
    bulkRuns?: number;
};

export type AutoStep = { session: AutoSession; fire: boolean; plan: TradePlan | null; note: string };

export const waitingNote = (config: AutoConfig) =>
    config.grade === 'ANY' ? 'Armed. Waiting for the next EXECUTE or PREPARE signal.' : 'Armed. Waiting for the next EXECUTE signal.';

const entryNote = (plan: TradePlan, config: AutoConfig, digits: number[]) => {
    const need = plan.contract === 'DIGITOVER' ? 'O' : 'U';
    const now = tickSymbols(digits, plan.barrier, config.entryTicks).join(' ') || '…';
    return `Signal fired. Waiting for entry: the last ${config.entryTicks} ticks must all be ${need} for ${plan.label} (now ${now}).`;
};

type Vetted = { plan: TradePlan; session: AutoSession; notice: string } | { stop: string };

/**
 * Picks the plan for a signal that is about to fire and applies the loss-limit guard to it. If the planned run could take the
 * session past its loss limit it is not fired: with the RESET action a recovery run falls back to normal staking when that is safe,
 * otherwise (STOP, or even the normal stake is too big) the auto trader switches itself off.
 */
const vetPlan = (session: AutoSession, config: AutoConfig, target: Recommendation, input: AutoInput): Vetted => {
    const plan = planTrade(target, session.lossStreak, config);
    const { baseStake, bulkRuns } = input;
    if (baseStake === undefined || bulkRuns === undefined) return { plan, session, notice: '' };
    const riskOf = (candidate: TradePlan) => planRisk(baseStake, bulkRuns, candidate);
    const blocked = lossLimitError(session, config, riskOf(plan));
    if (!blocked) return { plan, session, notice: '' };
    if (plan.recovery && config.onCap === 'RESET') {
        const reset = { ...session, lossStreak: 0 };
        const normal = planTrade(target, 0, config);
        if (!lossLimitError(reset, config, riskOf(normal))) {
            return { plan: normal, session: reset, notice: `The recovery stake of ${stakeFor(baseStake, plan).toFixed(2)} would pass the loss limit. Back to normal trading.` };
        }
    }
    return { stop: blocked };
};

/** Evaluate one moment. Returns the next session state, and the plan to run if a run must start now. */
export const stepAuto = (session: AutoSession, config: AutoConfig, input: AutoInput): AutoStep => {
    const stopWith = (from: AutoSession, reason: string): AutoStep => ({ session: disarmSession(from, reason), fire: false, plan: null, note: reason });
    if (!session.armed) return { session, fire: false, plan: null, note: session.stopReason || 'Off.' };

    if (session.runs >= config.maxRuns) return stopWith(session, `Stopped: reached ${config.maxRuns} auto run${config.maxRuns === 1 ? '' : 's'}.`);
    if (config.maxLoss > 0 && session.pnl <= -config.maxLoss) return stopWith(session, `Stopped: session loss limit of ${config.maxLoss.toFixed(2)} reached.`);
    if (config.targetProfit > 0 && session.pnl >= config.targetProfit) return stopWith(session, `Stopped: target profit of ${config.targetProfit.toFixed(2)} reached.`);

    const { target, now } = input;
    const digits = input.digits ?? [];
    const key = target ? signalKey(target) : null;
    const ready = Boolean(target && meetsGrade(target, config.grade));
    const wasReady = key !== null && session.seen?.key === key ? session.seen.ready : false;
    const seen = key ? { key, ready } : null;
    let next: AutoSession = { ...session, seen };

    // 1) A signal is already waiting for its entry ticks.
    if (next.pending) {
        const pending = next.pending;
        const drop = (notice: string): AutoStep => ({ session: { ...next, pending: null, notice }, fire: false, plan: null, note: notice });
        if (!target || key !== pending.key || !ready) return drop('The signal went away before entry. Skipped.');
        if (!input.valid) return drop('The signal failed the live check before entry. Skipped.');
        if (now - pending.since > config.entryWaitSec * 1000) return drop(`No entry within ${config.entryWaitSec}s. Signal skipped.`);
        if (input.busy) return { session: next, fire: false, plan: null, note: 'A run is in progress. Still waiting for entry.' };
        const vetted = vetPlan(next, config, target, input);
        if ('stop' in vetted) return stopWith(next, vetted.stop);
        next = vetted.session;
        const plan = vetted.plan;
        if (!entrySupports(digits, plan.contract, plan.barrier, config.entryTicks)) {
            return { session: next, fire: false, plan: null, note: `${vetted.notice} ${entryNote(plan, config, digits)}`.trim() };
        }
        return {
            session: { ...next, pending: null, notice: '', runs: next.runs + 1, lastFiredAt: now }, fire: true, plan,
            note: `${vetted.notice} Entry confirmed. Firing ${plan.label} on ${target.market}…`.trim(),
        };
    }

    // 2) Looking for a NEW signal.
    if (!target || !ready) return { session: next, fire: false, plan: null, note: next.notice || waitingNote(config) };
    if (wasReady) return { session: next, fire: false, plan: null, note: next.notice || 'This signal was already seen. Waiting for the next one.' };

    // From here the signal is NEW. If it cannot be acted on right now, that chance is consumed: a stale signal is never traded later.
    const skip = (notice: string): AutoStep => ({ session: { ...next, notice }, fire: false, plan: null, note: notice });
    if (input.busy) return skip('A run is in progress. Signal skipped.');
    if (session.lastFiredAt !== null && now - session.lastFiredAt < config.cooldownSec * 1000) {
        const left = Math.ceil((config.cooldownSec * 1000 - (now - session.lastFiredAt)) / 1000);
        return skip(`Cooling down (${left}s). Signal skipped.`);
    }
    if (!input.valid) return skip('Signal failed the live check. Skipped.');
    next = { ...next, notice: '' };

    const vetted = vetPlan(next, config, target, input);
    if ('stop' in vetted) return stopWith(next, vetted.stop);
    next = vetted.session;
    const plan = vetted.plan;
    if (config.entryTicks > 0 && !entrySupports(digits, plan.contract, plan.barrier, config.entryTicks)) {
        next = { ...next, pending: { key: key as string, since: now } };
        return { session: next, fire: false, plan: null, note: `${vetted.notice} ${entryNote(plan, config, digits)}`.trim() };
    }
    return { session: { ...next, runs: next.runs + 1, lastFiredAt: now }, fire: true, plan, note: `${vetted.notice} Firing ${plan.label} on ${target.market}…`.trim() };
};

/**
 * Fold a finished run into the session: realised P/L, the losing streak that drives recovery and martingale, and the stop rules.
 * A failed or empty run, or one whose contracts did not all report a result, switches the auto trader off (fail-safe). A session
 * that was already switched off while the run was in progress (Stop pressed, loss guard) keeps its own stop reason.
 */
export const recordAutoRun = (
    session: AutoSession,
    result: { placed: number; failed: number; pnl: number; unsettled?: number },
    config: AutoConfig = DEFAULT_AUTO,
): AutoSession => {
    let updated: AutoSession = { ...session, pnl: round2(session.pnl + result.pnl) };
    const off = (reason: string): AutoSession => (session.armed ? disarmSession(updated, reason) : updated);
    const unsettled = result.unsettled ?? 0;
    if (result.placed === 0) return off('Stopped: the run placed no trades. Check the message above.');
    if (result.failed > 0) return off(`Stopped: ${result.failed} purchase${result.failed === 1 ? '' : 's'} failed.`);
    if (unsettled > 0) return off(`Stopped: ${unsettled} contract${unsettled === 1 ? '' : 's'} did not report a result, so the session P/L cannot be trusted. Check your Deriv statement.`);
    if (result.pnl < 0) updated = { ...updated, lossStreak: updated.lossStreak + 1 };
    else if (result.pnl > 0) updated = { ...updated, lossStreak: 0 };
    if (config.recovery && updated.lossStreak > config.maxSteps) {
        if (config.onCap === 'STOP') return off(`Stopped: recovery limit of ${config.maxSteps} step${config.maxSteps === 1 ? '' : 's'} reached.`);
        updated = { ...updated, lossStreak: 0 };
    }
    return updated;
};

/** Plain-English state for the panel. */
export const modeText = (session: AutoSession, config: AutoConfig): string =>
    config.recovery && session.lossStreak >= 1 ? `RECOVERY step ${session.lossStreak} of ${config.maxSteps}` : 'NORMAL';
