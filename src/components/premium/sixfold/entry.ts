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
