// Pace of a bulk purchase burst. Deriv handles the buys of one connection one after another, so a burst takes roughly
// (number of trades x time per buy). A one-tick contract enters on the first tick printed after Deriv receives its buy; any
// buy that lands after the next tick has printed enters (and settles) one tick late, on a different exit digit. This module
// answers: how many trades fit before the next tick, so the whole burst shares one entry tick and one exit digit.

/** Time per buy assumed until a real burst has been measured. */
export const DEFAULT_BUY_MS = 150;
/** Kept free before the next tick for network jitter and clock rounding. */
export const SAFETY_MS = 250;
const MIN_BUY_MS = 40;
const MAX_BUY_MS = 1000;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Typical gap between ticks of a market (median of the latest gaps, ms), or null when there are too few ticks. */
export const tickIntervalMs = (times: readonly number[]): number | null => {
    if (times.length < 4) return null;
    const recent = times.slice(-21);
    const gaps: number[] = [];
    for (let i = 1; i < recent.length; i += 1) {
        const gap = recent[i] - recent[i - 1];
        if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
    }
    if (gaps.length < 3) return null;
    gaps.sort((a, b) => a - b);
    return clamp(gaps[Math.floor(gaps.length / 2)], 500, 10_000);
};

export type OneTickFit = { fit: number; capped: boolean; budgetMs: number };

/**
 * How many of `requested` trades can be sent so the last one still lands before the next tick. `elapsedMs` is how long ago the
 * decision tick arrived. Always at least 1 (a single trade is never blocked here).
 */
export const fitOnOneTick = (input: { requested: number; intervalMs: number; elapsedMs: number; perBuyMs: number }): OneTickFit => {
    const perBuy = clamp(input.perBuyMs, MIN_BUY_MS, MAX_BUY_MS);
    const budgetMs = input.intervalMs - SAFETY_MS - Math.max(0, input.elapsedMs);
    const fit = clamp(Math.floor(budgetMs / perBuy), 1, Math.max(1, input.requested));
    return { fit, capped: fit < input.requested, budgetMs };
};

/**
 * Updates the time-per-buy estimate from when each purchase was confirmed (ms timestamps). Confirmations arrive one after
 * another at Deriv's pace, so the spread between first and last, divided by the gaps, is the time per buy. Fewer than three
 * confirmations teach nothing, so the estimate is kept.
 */
export const learnPace = (previousMs: number, arrivals: readonly number[]): number => {
    const stamps = arrivals.filter(Number.isFinite);
    if (stamps.length < 3) return previousMs;
    const sample = (Math.max(...stamps) - Math.min(...stamps)) / (stamps.length - 1);
    return clamp(Math.round((previousMs + sample) / 2), MIN_BUY_MS, MAX_BUY_MS);
};
