// SENTINEL AI — stake, martingale and recovery logic. Pure functions (no I/O) so they are unit-testable.
import { MIN_STAKE, type EntrySource, type SentinelAiSettings, type SessionStats } from './sentinel-ai-types';

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

export type EntryRequirement = { digits: number[]; source: EntrySource };

/**
 * The digit(s) the next trade enters on; the first one to print triggers it: the signal's own entry digit from the
 * engine, or, when the engine gave none, the default digits of the signal's side (Over 2/4, Under 5/7 unless changed).
 * Recovery never changes the entry digit; it changes the contract barrier (see tradeBarrier).
 */
export const requiredEntry = (
    signal: { entryDigit: number | null; contractType: 'DIGITOVER' | 'DIGITUNDER' },
    settings: SentinelAiSettings
): EntryRequirement => {
    if (signal.entryDigit !== null) return { digits: [signal.entryDigit], source: 'engine' };
    const isOver = signal.contractType === 'DIGITOVER';
    return { digits: [...(isOver ? settings.defaultOverDigits : settings.defaultUnderDigits)], source: 'default' };
};

export type TradeBarrier = { barrier: number; label: string; recovery: boolean };

/**
 * The contract the next trade buys. Normally the signal's own barrier. While recovering from a loss (and recovery is
 * on) it is the recovery barrier of the signal's side - an Over signal recovers on Over <recoveryOverBarrier>, an Under
 * signal on Under <recoveryUnderBarrier> - and the signal's own barrier is back after a win.
 */
export const tradeBarrier = (
    signal: { barrier: number; label: string; contractType: 'DIGITOVER' | 'DIGITUNDER' },
    consecutiveLosses: number,
    settings: SentinelAiSettings
): TradeBarrier => {
    if (!settings.recoveryBarrierEnabled || consecutiveLosses <= 0) {
        return { barrier: signal.barrier, label: signal.label, recovery: false };
    }
    const isOver = signal.contractType === 'DIGITOVER';
    const barrier = isOver ? settings.recoveryOverBarrier : settings.recoveryUnderBarrier;
    return { barrier, label: `${isOver ? 'Over' : 'Under'} ${barrier}`, recovery: true };
};

/** Returns a human-readable reason when the session must stop, otherwise null. */
export const sessionStopReason = (session: SessionStats, settings: SentinelAiSettings): string | null => {
    if (settings.takeProfit > 0 && session.pnl >= settings.takeProfit) {
        return `Take profit reached (+${session.pnl.toFixed(2)})`;
    }
    if (settings.stopLoss > 0 && session.pnl <= -settings.stopLoss) {
        return `Stop loss reached (${session.pnl.toFixed(2)})`;
    }
    // Touch-once has its own stop conditions (target profit, stop loss, max losses in a row, Stop): a trade count does not end it.
    if (settings.executionMode !== 'touch_once' && settings.maxTrades > 0 && session.trades >= settings.maxTrades) {
        return `Max trades reached (${session.trades})`;
    }
    if (settings.maxConsecutiveLosses > 0 && session.consecutiveLosses >= settings.maxConsecutiveLosses) {
        return `Max consecutive losses reached (${session.consecutiveLosses})`;
    }
    return null;
};
