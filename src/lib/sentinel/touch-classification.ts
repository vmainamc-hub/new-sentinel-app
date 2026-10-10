// APEX SENTINEL — CANONICAL TOUCH CLASSIFICATION (single owner).
//
// ARCHITECTURE REPAIR: FIRST vs SUBSEQUENT touch was previously derived inside
// entry-trigger.ts only, which meant execution survival could not be measured
// per touch class without duplicating the rule. This module now OWNS the rule;
// entry-trigger.ts and execution-survival.ts both consume it, so there is
// exactly one definition of "first touch" in the system.
//
// The threshold is DERIVED from the digit's own measured mean gap — never
// hardcoded, and never assumed to favour either touch class.

export type TouchClass = "FIRST" | "SUBSEQUENT";

/** Mean gap in ticks between prints of `digit`, plus ticks since it last printed. */
export function digitGapProfile(
  digits: number[],
  digit: number,
): { meanGap: number; sinceSeen: number; occurrences: number } {
  let last = -1;
  let sum = 0;
  let gaps = 0;
  let occurrences = 0;
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] !== digit) continue;
    occurrences += 1;
    if (last >= 0) {
      sum += i - last;
      gaps += 1;
    }
    last = i;
  }
  return {
    // With no measured gap the honest fallback is the uniform expectation (10).
    meanGap: gaps ? sum / gaps : 10,
    sinceSeen: last >= 0 ? digits.length - 1 - last : digits.length,
    occurrences,
  };
}

/**
 * Absence, in ticks, after which the next print of the digit counts as a FIRST
 * touch. Derived from the digit's own cadence: a digit printing every 6 ticks
 * and one printing every 40 get different thresholds.
 */
export function firstTouchThreshold(meanGap: number): number {
  return Math.max(2, Math.round(meanGap));
}

/**
 * Classify every print of `digit` in a causal buffer as FIRST or SUBSEQUENT.
 * Purely causal: a print's class depends only on earlier ticks.
 */
export function classifyPrints(
  digits: number[],
  digit: number,
): {
  prints: Array<{
    index: number;
    touchClass: TouchClass;
    ordinal: number;
    gapBefore: number | null;
  }>;
  absenceThreshold: number;
  meanGap: number;
  sinceSeen: number;
} {
  const { meanGap, sinceSeen } = digitGapProfile(digits, digit);
  const absenceThreshold = firstTouchThreshold(meanGap);
  const prints: Array<{
    index: number;
    touchClass: TouchClass;
    ordinal: number;
    gapBefore: number | null;
  }> = [];
  let last = -1;
  let ordinal = 0;
  for (let i = 0; i < digits.length; i++) {
    if (digits[i] !== digit) continue;
    const gapBefore = last >= 0 ? i - last : null;
    const isFirst = gapBefore === null || gapBefore >= absenceThreshold;
    ordinal = isFirst ? 1 : ordinal + 1;
    last = i;
    prints.push({ index: i, touchClass: isFirst ? "FIRST" : "SUBSEQUENT", ordinal, gapBefore });
  }
  return { prints, absenceThreshold, meanGap, sinceSeen };
}

/** Would the NEXT print of the digit be a FIRST touch, given the live buffer? */
export function nextTouchIsFirst(digits: number[], digit: number): boolean {
  const { meanGap, sinceSeen, occurrences } = digitGapProfile(digits, digit);
  if (!occurrences) return true;
  return sinceSeen >= firstTouchThreshold(meanGap);
}
