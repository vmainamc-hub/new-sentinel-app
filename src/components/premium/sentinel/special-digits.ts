// SENTINEL AI: the special-digit rule. MANDATORY: it has no switch and applies in every mode, to every contract, at scan time and again
// on the tick a trade would be bought.
//
// Operator rule: digit 1 and digit 8 are treated as special.
//   OVER  contract: digit 1 loses it, so digit 1 must be dormant or falling in the windows before the trade (never building).
//                   Digit 8 is also watched for a sudden, hidden surge in its share.
//   UNDER contract: digit 8 loses it, so digit 8 must be dormant or falling. Digit 1 is also watched for a sudden, hidden surge.
// "Increasing" means the number of times the digit appears in a window, compared with the window before it.
//
// Honest limit: Deriv digits are generated randomly, so a digit that has been building is not more likely to print next. This rule
// makes the bot sit out the moments the operator has found costly; it cannot create an edge.
import type { Contract } from '../sixfold/bot';

/** Fewest ticks the rule can read. With fewer the contract is held back (a mandatory rule cannot pass on no data). */
export const SPECIAL_MIN_TICKS = 120;
/** Counts rising by this many between two neighbouring windows is a build on its own. */
export const BUILD_STEP = 2;
/** Surge of the other special digit: share of the last 20 ticks above its share of the 100 before, in percentage points. */
export const SURGE_PP = 10;
/** Surge: prints in the last 20 ticks needed before a surge can be called. */
export const SURGE_MIN_PRINTS = 4;
/** Fast surge: prints in the last 10 ticks, and how many more than the 10 before. */
export const FAST_PRINTS = 4;
export const FAST_STEP = 2;
/** Switch for the second check (the other special digit's surge). The first check (the losing special digit) is never optional. */
export const CHECK_MIRROR_SURGE = true;

export type SpecialDigits = {
    /** The digit that loses this contract and must not be building: 1 for Over, 8 for Under. */
    watched: number;
    /** The other special digit, checked for a sudden surge: 8 for Over, 1 for Under. */
    mirror: number;
};

export type SpecialRead = {
    /** True when the contract may be taken as far as this rule is concerned. */
    ok: boolean;
    watched: number;
    mirror: number;
    /** Prints of the watched digit in the last 30 / the 30 before / the 30 before that, and the last 15 / the 15 before. */
    counts: { c30: number; b30: number; a30: number; f15: number; p15: number } | null;
    /** What stopped it, in plain words (empty when ok). */
    reasons: string[];
    /** A short line for the queue and the log. */
    note: string;
};

export const specialDigitsFor = (side: Contract['side']): SpecialDigits =>
    side === 'OVER' ? { watched: 1, mirror: 8 } : { watched: 8, mirror: 1 };

const countIn = (series: readonly number[], digit: number, from: number, to: number): number => {
    let n = 0;
    const end = series.length - to;
    for (let i = series.length - from; i < end; i += 1) if (series[i] === digit) n += 1;
    return n;
};

export const readSpecialDigits = (series: readonly number[] | undefined, side: Contract['side']): SpecialRead => {
    const { watched, mirror } = specialDigitsFor(side);
    if (!series || series.length < SPECIAL_MIN_TICKS) {
        const have = series?.length ?? 0;
        return {
            ok: false,
            watched,
            mirror,
            counts: null,
            reasons: [`only ${have} ticks, ${SPECIAL_MIN_TICKS} needed to judge digit ${watched}`],
            note: `digit ${watched} rule: not enough ticks (${have} of ${SPECIAL_MIN_TICKS})`,
        };
    }

    const c30 = countIn(series, watched, 30, 0);
    const b30 = countIn(series, watched, 60, 30);
    const a30 = countIn(series, watched, 90, 60);
    const f15 = countIn(series, watched, 15, 0);
    const p15 = countIn(series, watched, 30, 15);
    const reasons: string[] = [];

    if (c30 > b30 && f15 > p15) {
        reasons.push(`digit ${watched} is building: ${c30} prints in the last 30 ticks against ${b30} before, ${f15} in the last 15 against ${p15}`);
    } else if (c30 - b30 >= BUILD_STEP) {
        reasons.push(`digit ${watched} jumped from ${b30} to ${c30} prints between the last two 30-tick windows`);
    } else if (f15 - p15 >= BUILD_STEP) {
        reasons.push(`digit ${watched} jumped from ${p15} to ${f15} prints between the last two 15-tick windows`);
    } else if (c30 > b30 && b30 > a30) {
        reasons.push(`digit ${watched} has risen in every 30-tick window (${a30}, ${b30}, ${c30})`);
    }

    if (CHECK_MIRROR_SURGE) {
        const m20 = countIn(series, mirror, 20, 0);
        const base = countIn(series, mirror, 120, 20) / 100;
        const m10 = countIn(series, mirror, 10, 0);
        const q10 = countIn(series, mirror, 20, 10);
        const gain = (m20 / 20 - base) * 100;
        if (m20 >= SURGE_MIN_PRINTS && gain >= SURGE_PP && m10 >= q10) {
            reasons.push(`digit ${mirror} is surging: ${m20} prints in the last 20 ticks (${(m20 * 5).toFixed(0)}%) against ${(base * 100).toFixed(0)}% before`);
        } else if (m10 >= FAST_PRINTS && m10 - q10 >= FAST_STEP) {
            reasons.push(`digit ${mirror} is accelerating: ${m10} prints in the last 10 ticks against ${q10} in the 10 before`);
        }
    }

    const counts = { c30, b30, a30, f15, p15 };
    return {
        ok: reasons.length === 0,
        watched,
        mirror,
        counts,
        reasons,
        note:
            reasons.length === 0
                ? `digit ${watched} rule: dormant or falling (${a30}, ${b30}, ${c30} per 30 ticks)`
                : `digit ${watched}/${mirror} rule: ${reasons[0]}`,
    };
};
