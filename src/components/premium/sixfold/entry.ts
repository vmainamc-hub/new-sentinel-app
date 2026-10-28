// Sixfold Auto: adaptive entry digits. Pure functions, no I/O.
//
// A fixed entry pattern ("buy after a 7, 8 or 9") is the same trap every time. SMART entry looks at the armed market's own
// recent ticks, measures how the traded contract fared after each entry digit, and waits for the digits that did best
// lately. The set is recomputed while waiting, so it moves with the market, and the digit that just lost on a market is
// left out the next time that market is armed.
//
// Deriv digits are random: this does not create an edge. It varies the entry so a losing pattern is not repeated, and it
// follows whatever local bias the recent ticks show.
import { type Contract, losingDigits, winningDigits } from './bot';

/** Ticks of history looked at. Long enough to be stable, short enough to follow the market. */
export const ENTRY_WINDOW = 500;
/** Weight of the theoretical rate when a digit has few samples (a prior worth this many trades). */
const PRIOR_WEIGHT = 25;
const MIN_SET = 3;
const MAX_SET = 4;

export type EntryChoice = {
    digits: number[];
    /** 'learned' came from the market's ticks; 'fallback' is the fixed setup digits. */
    source: 'learned' | 'fallback';
};

export function smartEntryDigits(
    series: readonly number[],
    contract: Contract,
    duration: number,
    avoid: ReadonlySet<number> = new Set()
): EntryChoice {
    const fallback = () => {
        const base = losingDigits(contract);
        const kept = base.filter(d => !avoid.has(d));
        return { digits: kept.length ? kept : base, source: 'fallback' as const };
    };
    const win = new Set(winningDigits(contract));
    const prior = win.size / 10;
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    const from = Math.max(0, series.length - ENTRY_WINDOW);
    const n = new Array<number>(10).fill(0);
    const w = new Array<number>(10).fill(0);
    for (let i = from; i + len < series.length; i++) {
        const d = series[i];
        if (!(d >= 0 && d <= 9)) continue;
        n[d] += 1;
        if (win.has(series[i + len])) w[d] += 1;
    }
    if (n.reduce((a, b) => a + b, 0) < 100) return fallback();

    const ranked = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        .filter(d => !avoid.has(d))
        .map(d => ({ d, rate: (w[d] + PRIOR_WEIGHT * prior) / (n[d] + PRIOR_WEIGHT) }))
        .sort((a, b) => b.rate - a.rate || a.d - b.d);
    const good = ranked.filter(r => r.rate >= prior).slice(0, MAX_SET);
    if (good.length < MIN_SET) {
        // Not enough digits beat the baseline: take the best few anyway rather than waiting on one digit.
        const top = ranked.slice(0, MIN_SET).map(r => r.d);
        return top.length ? { digits: top.sort((a, b) => a - b), source: 'learned' } : fallback();
    }
    return { digits: good.map(r => r.d).sort((a, b) => a - b), source: 'learned' };
}

// ---------- form gate: wait for a run of wins or losses before a recovery entry ----------

export type RecoveryEntry = 'OFF' | 'MOMENTUM' | 'REVERSION' | 'BOUNCE';

/** Length of the winning run and of the losing run that ends at the latest tick, for `contract`. */
export function trailingRun(series: readonly number[], contract: Contract): { wins: number; losses: number } {
    const win = new Set(winningDigits(contract));
    let wins = 0;
    let losses = 0;
    for (let i = series.length - 1; i >= 0; i--) {
        const w = win.has(series[i]);
        if (w && losses === 0) wins += 1;
        else if (!w && wins === 0) losses += 1;
        else break;
    }
    return { wins, losses };
}

/** Losses in a row that came right before the latest tick, when the latest tick would have won. 0 if it would not. */
export function lossesBeforeWin(series: readonly number[], contract: Contract): number {
    const win = new Set(winningDigits(contract));
    const n = series.length;
    if (n < 2 || !win.has(series[n - 1])) return 0;
    let losses = 0;
    for (let i = n - 2; i >= 0 && !win.has(series[i]); i--) losses += 1;
    return losses;
}

/**
 * MOMENTUM: the last `k` ticks all would have won. REVERSION: the last `k` all would have lost.
 * BOUNCE: `k` or more losses in a row, then a win on the latest tick. OFF always passes.
 */
export function formGateOk(mode: RecoveryEntry, k: number, series: readonly number[], contract: Contract): boolean {
    if (mode === 'OFF') return true;
    if (mode === 'BOUNCE') return lossesBeforeWin(series, contract) >= k;
    const run = trailingRun(series, contract);
    return mode === 'MOMENTUM' ? run.wins >= k : run.losses >= k;
}
