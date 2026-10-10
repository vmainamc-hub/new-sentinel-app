// SENTINEL AI — stake, martingale and recovery logic. Pure functions (no I/O) so they are unit-testable.
import { MIN_STAKE, type SentinelAiSettings, type SessionStats } from './sentinel-ai-types';

export type StakeState = Pick<SessionStats, 'currentStake' | 'consecutiveLosses' | 'martingaleStep'>;

// EPSILON nudge keeps half-cent values (e.g. 1.005) rounding up despite binary floating point.
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const clampStake = (stake: number, settings: SentinelAiSettings) => {
    let next = Math.max(MIN_STAKE, round2(stake));
    if (settings.maxStake > 0) next = Math.min(next, Math.max(MIN_STAKE, settings.maxStake));
    return next;
};

export const initialStakeState = (settings: SentinelAiSettings): StakeState => ({
    currentStake: clampStake(settings.stake, settings),
    consecutiveLosses: 0,
    martingaleStep: 0,
});

const martingaleEngages = (consecutiveLosses: number, settings: SentinelAiSettings) => {
    switch (settings.martingaleMode) {
        case 'after_1':
            return consecutiveLosses >= 1;
        case 'after_2':
            return consecutiveLosses >= 2;
        case 'custom':
            return consecutiveLosses >= settings.martingaleCustomLosses;
        default:
            return false;
    }
};

/**
 * Next stake state after a settled trade. A trade with profit < 0 is a loss; anything else is a win
 * (same convention as Auto Trades).
 */
export const nextStakeState = (
    prev: StakeState,
    profit: number,
    sessionPnlAfterTrade: number,
    settings: SentinelAiSettings
): StakeState => {
    const base = clampStake(settings.stake, settings);

    if (!(profit < 0)) {
        // Win. Optionally keep the recovery stake until the session is back above zero.
        if (settings.recoverToBreakeven && prev.consecutiveLosses > 0 && sessionPnlAfterTrade <= 0) {
            return {
                currentStake: prev.currentStake > 0 ? clampStake(prev.currentStake, settings) : base,
                consecutiveLosses: Math.max(1, prev.consecutiveLosses),
                martingaleStep: prev.martingaleStep,
            };
        }
        return { currentStake: base, consecutiveLosses: 0, martingaleStep: 0 };
    }

    const consecutiveLosses = prev.consecutiveLosses + 1;
    if (!martingaleEngages(consecutiveLosses, settings)) {
        return { currentStake: base, consecutiveLosses, martingaleStep: 0 };
    }

    const step = prev.martingaleStep + 1;
    if (settings.martingaleMaxSteps > 0 && step > settings.martingaleMaxSteps) {
        // Ladder exhausted: fall back to the base stake rather than escalating further.
        return { currentStake: base, consecutiveLosses, martingaleStep: 0 };
    }

    return {
        currentStake: clampStake(prev.currentStake * settings.martingaleMultiplier, settings),
        consecutiveLosses,
        martingaleStep: step,
    };
};

/** The digit the next trade must enter on: the recovery digit while recovering, else the signal's own. */
export const requiredEntryDigit = (
    signalDigit: number | null,
    consecutiveLosses: number,
    settings: SentinelAiSettings
): number | null =>
    settings.recoveryDigitEnabled && consecutiveLosses > 0 ? settings.recoveryDigit : signalDigit;

/** Returns a human-readable reason when the session must stop, otherwise null. */
export const sessionStopReason = (session: SessionStats, settings: SentinelAiSettings): string | null => {
    if (settings.takeProfit > 0 && session.pnl >= settings.takeProfit) {
        return `Take profit reached (+${session.pnl.toFixed(2)})`;
    }
    if (settings.stopLoss > 0 && session.pnl <= -settings.stopLoss) {
        return `Stop loss reached (${session.pnl.toFixed(2)})`;
    }
    if (settings.maxTrades > 0 && session.trades >= settings.maxTrades) {
        return `Max trades reached (${session.trades})`;
    }
    if (settings.maxConsecutiveLosses > 0 && session.consecutiveLosses >= settings.maxConsecutiveLosses) {
        return `Max consecutive losses reached (${session.consecutiveLosses})`;
    }
    return null;
};
