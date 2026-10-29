// Protection against runs of losing entries. Pure logic, no React, no network.
//
// These settings do not change the odds of any entry. They decide what a streak of losing entries is allowed to cost: stop or pause
// or restart the stakes after N losing entries in a row, size the next stake so one win pays back what the streak lost (instead
// of a fixed multiplier), and wait a few ticks after a loss before entering again.

import { clampStake, round2 } from './dtrader-engine';

export type BreakerAction = 'stop' | 'pause' | 'reset';

export type RiskSettings = {
    /** Losing entries in a row that trigger the breaker. 0 = off. */
    breakerAfter: number;
    breakerAction: BreakerAction;
    /** Ticks to wait when the breaker pauses. */
    pauseTicks: number;
    /** Size the next stake from the payout so one win recovers the streak's losses. Replaces the fixed multiplier. */
    recovery: boolean;
    /** Profit wanted on top of recovering the losses, in account currency. */
    recoveryTarget: number;
    /** Most consecutive raised stakes before the stake restarts at the base (the loss is accepted). */
    recoverySteps: number;
    /** Ticks to wait after a losing entry before the next one. 0 = off. */
    cooldownTicks: number;
};

export const NO_RISK: RiskSettings = { breakerAfter: 0, breakerAction: 'stop', pauseTicks: 20, recovery: false, recoveryTarget: 0, recoverySteps: 4, cooldownTicks: 0 };

export type RiskState = { lossStreak: number; deficit: number; steps: number };
export const freshRisk = (): RiskState => ({ lossStreak: 0, deficit: 0, steps: 0 });

export type RiskStep = {
    state: RiskState;
    /** Why the run must stop (breaker set to stop). */
    stop?: string;
    /** Ticks to wait before the next entry (cool-down or breaker pause). */
    waitTicks: number;
    /** Restart the stake at the base (breaker set to reset). */
    resetStake: boolean;
    note: string;
};

/** Updates the streak after one finished entry (`profit` is that entry's total result). */
export const afterEntry = (state: RiskState, profit: number, s: RiskSettings): RiskStep => {
    let { lossStreak, deficit, steps } = state;
    let waitTicks = 0;
    let resetStake = false;
    let note = '';
    if (profit > 0) {
        deficit = Math.max(0, round2(deficit - profit));
        lossStreak = 0;
        if (deficit === 0) steps = 0;
        return { state: { lossStreak, deficit, steps }, waitTicks, resetStake, note };
    }
    if (profit < 0) {
        lossStreak += 1;
        deficit = round2(deficit - profit);
        if (s.cooldownTicks > 0) { waitTicks = Math.trunc(s.cooldownTicks); note = `Cooling down for ${waitTicks} tick${waitTicks === 1 ? '' : 's'} after a loss.`; }
        if (s.breakerAfter > 0 && lossStreak >= s.breakerAfter) {
            if (s.breakerAction === 'stop') {
                return { state: { lossStreak, deficit, steps }, stop: `Loss breaker: ${lossStreak} losing entries in a row. Stopped.`, waitTicks: 0, resetStake: false, note };
            }
            if (s.breakerAction === 'pause') {
                waitTicks = Math.max(waitTicks, Math.trunc(s.pauseTicks));
                note = `Loss breaker: ${lossStreak} losing entries in a row. Pausing ${waitTicks} ticks.`;
                lossStreak = 0;
            } else {
                note = `Loss breaker: ${lossStreak} losing entries in a row. The stake restarts at the base; the ${deficit.toFixed(2)} lost is not chased.`;
                lossStreak = 0; deficit = 0; steps = 0; resetStake = true;
            }
        }
    }
    return { state: { lossStreak, deficit, steps }, waitTicks, resetStake, note };
};

/**
 * Stake that, if the next entry wins the way a winning entry pays, recovers the streak's losses plus the target.
 * `winNetPerStake` is the result of a winning entry per 1 staked per trade (payout ratio x winning trades - trades sent).
 * Null when it cannot be done (a win would not even pay for itself) or the step limit is reached.
 */
export const recoveryStake = (input: { base: number; deficit: number; target: number; winNetPerStake: number; steps: number; maxSteps: number }): number | null => {
    if (!(input.deficit > 0)) return clampStake(input.base);
    if (!(input.winNetPerStake > 0.05) || input.steps >= Math.max(1, input.maxSteps)) return null;
    return clampStake(Math.max(input.base, (input.deficit + Math.max(0, input.target)) / input.winNetPerStake));
};
