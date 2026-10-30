// Win-streak guard: a hard "never buy while losing digits are appearing" rule.
//
// For the contract that would actually be bought, the market's latest `need` digits must ALL be winning digits (for Over 2
// that is WWWWWW), and a market is abandoned as soon as it prints too many losing digits in its last 10. This is a filter on
// WHEN to buy, not a way to raise the win rate: Deriv digits are random, so a streak does not make the next digit likelier
// to win. What it does is stop the bot from buying while a market is visibly running cold.
import { type Contract, winningDigits, winProbability } from './bot';
import { trailingRun } from './entry';

export const STREAK_WINDOW = 10;

export type StreakRead = {
    /** Winning digits in a row ending at the latest tick. */
    run: number;
    /** Losing digits among the last 10 ticks. */
    losses: number;
    /** Losses in the last 10 at which the market is dropped. */
    abortAt: number;
    /** The run is long enough to buy. */
    ok: boolean;
    /** Too many losses lately: leave this market. */
    abort: boolean;
};

/** `extra` is how many losses above the contract's expected count (in 10 ticks) are tolerated before the market is dropped. */
export function streakRead(series: readonly number[], contract: Contract, need: number, extra: number): StreakRead {
    const win = new Set(winningDigits(contract));
    const tail = series.slice(-STREAK_WINDOW);
    const losses = tail.filter(d => !win.has(d)).length;
    const expected = Math.round(STREAK_WINDOW * (1 - winProbability(contract)));
    const abortAt = Math.min(STREAK_WINDOW, Math.max(1, expected + Math.max(0, Math.trunc(extra))));
    const run = trailingRun(series, contract).wins;
    const enough = tail.length >= Math.min(STREAK_WINDOW, Math.max(need, 1));
    return { run, losses, abortAt, ok: enough && run >= need && losses < abortAt, abort: tail.length >= STREAK_WINDOW && losses >= abortAt };
}
