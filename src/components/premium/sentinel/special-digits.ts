// SENTINEL AI: the special-digit rule. MANDATORY: it has no switch and applies in every mode, to every contract, at scan time and again
// on the tick a trade would be bought.
//
// Operator rule: digit 1 and digit 8 are special, and a market is traded only when BOTH are behaving the right way.
//   OVER  contract: digit 1 loses it, so digit 1 must be dormant or falling. Digit 8 wins it, so digit 8 must be increasing,
//                   including quiet, hidden rises, at a faster rate.
//   UNDER contract: digit 8 loses it, so digit 8 must be dormant or falling. Digit 1 wins it, so digit 1 must be increasing.
// "Increasing" means the number of times the digit appears in a window, compared with the window before it.
//
// Honest limit: Deriv digits are generated randomly, so a digit that has been building is not more likely to print next. This rule
// makes the bot sit out the moments the operator has found costly; it cannot create an edge.
import type { Contract } from '../sixfold/bot';

/** Fewest ticks the rule can read. With fewer the contract is held back (a mandatory rule cannot pass on no data). */
export const SPECIAL_MIN_TICKS = 120;
/** Counts rising by this many between two neighbouring windows is a build on its own. */
export const BUILD_STEP = 2;
/** Switch for the second check (the winning special digit must be increasing). The first check (the losing digit) is never optional. */
export const CHECK_WINNER_RISING = true;

export type SpecialDigits = {
    /** The digit that loses this contract and must be dormant or falling: 1 for Over, 8 for Under. */
    watched: number;
    /** The other special digit. It wins this contract and must be increasing: 8 for Over, 1 for Under. */
    mirror: number;
};

type WindowCounts = { c30: number; b30: number; a30: number; f15: number; p15: number };

export type SpecialRead = {
    /** True when the contract may be taken as far as this rule is concerned. */
    ok: boolean;
    watched: number;
    mirror: number;
    /** Prints of the watched digit in the last 30 / the 30 before / the 30 before that, and the last 15 / the 15 before. */
    /** Prints of each digit in the last 30 / the 30 before / the 30 before that, and the last 15 / the 15 before. */
    counts: { watched: WindowCounts; mirror: WindowCounts } | null;
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

const windows = (series: readonly number[], digit: number): WindowCounts => ({
    c30: countIn(series, digit, 30, 0),
    b30: countIn(series, digit, 60, 30),
    a30: countIn(series, digit, 90, 60),
    f15: countIn(series, digit, 15, 0),
    p15: countIn(series, digit, 30, 15),
});

/** Why a digit counts as building, or null when it is dormant or falling. */
const buildReason = (digit: number, w: WindowCounts): string | null => {
    if (w.c30 > w.b30 && w.f15 > w.p15) return `${w.c30} prints in the last 30 ticks against ${w.b30} before, ${w.f15} in the last 15 against ${w.p15}`;
    if (w.c30 - w.b30 >= BUILD_STEP) return `${w.b30} to ${w.c30} prints between the last two 30-tick windows`;
    if (w.f15 - w.p15 >= BUILD_STEP) return `${w.p15} to ${w.f15} prints between the last two 15-tick windows`;
    if (w.c30 > w.b30 && w.b30 > w.a30) return `up in every 30-tick window (${w.a30}, ${w.b30}, ${w.c30})`;
    return null;
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
            reasons: [`only ${have} ticks, ${SPECIAL_MIN_TICKS} needed to judge digits ${watched} and ${mirror}`],
            note: `digit ${watched}/${mirror} rule: not enough ticks (${have} of ${SPECIAL_MIN_TICKS})`,
        };
    }

    const w = windows(series, watched);
    const m = windows(series, mirror);
    const reasons: string[] = [];

    const building = buildReason(watched, w);
    if (building) reasons.push(`digit ${watched} loses this contract and is building: ${building}`);

    if (CHECK_WINNER_RISING && !buildReason(mirror, m)) {
        reasons.push(`digit ${mirror} wins this contract but is not increasing (${m.a30}, ${m.b30}, ${m.c30} per 30 ticks)`);
    }

    return {
        ok: reasons.length === 0,
        watched,
        mirror,
        counts: { watched: w, mirror: m },
        reasons,
        note:
            reasons.length === 0
                ? `digit ${watched} dormant or falling (${w.a30}, ${w.b30}, ${w.c30}) and digit ${mirror} increasing (${m.a30}, ${m.b30}, ${m.c30})`
                : `digit ${watched}/${mirror} rule: ${reasons[0]}`,
    };
};
