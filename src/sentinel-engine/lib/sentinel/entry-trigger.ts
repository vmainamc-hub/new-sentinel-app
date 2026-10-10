// APEX SENTINEL — ENTRY TRIGGER INTELLIGENCE (LEVEL 2.5).
//
// LEVEL 1  (apex/simulator.ts)      : "did this contract win?"
// LEVEL 2  (execution-survival.ts)  : "after the entry digit printed and the bot
//                                      ran, how did the SEQUENCE behave?"
// LEVEL 2.5 (this file)             : "WHICH PRINT of the entry digit should the
//                                      operator actually trigger on?"
//
// The operator does not trade every appearance of the entry digit. They watch the
// stream, wait for the digit, and pull the trigger. Historically those prints are
// not equivalent: the FIRST print after the digit has been absent for a while
// behaves differently from the 2nd, 3rd… print inside a cluster where the digit
// keeps repeating. Until this layer existed, Sentinel pooled them, which means
// every conditional number it published was an average over two populations that
// can behave in opposite directions.
//
// Hard rules honoured here:
//   • Nothing is hardcoded. The absence threshold that separates a FIRST touch
//     from a SUBSEQUENT touch is DERIVED from the digit's own measured mean gap
//     on this market. There is no magic "wait 10 ticks" constant.
//   • Absolute isolation: MARKET × CONTRACT × ENTRY DIGIT × TOUCH CLASS. The same
//     entry digit on another market or another contract is a different object.
//   • Causal only. A touch is evaluated using the runs that printed AFTER it, and
//     its touch class is decided using only the ticks BEFORE it. No look-ahead.
//   • It refuses to invent a preference. Two cohorts that are not separated by
//     more than sampling noise are reported as NO MEASURED DIFFERENCE, not as a
//     tie broken in favour of the bigger number.
//   • Bounded influence. This layer may shade ranking by at most ±4 points and
//     can never on its own qualify, block or veto a candidate.

import { wilsonLower } from "./execution-survival";
import {
  classifyPrints,
  digitGapProfile as canonicalDigitGapProfile,
  type TouchClass,
} from "./touch-classification";

export type { TouchClass };

export type EntryTriggerVerdict =
  | "INSUFFICIENT TRIGGER HISTORY"
  | "NO MEASURED DIFFERENCE"
  | "FIRST TOUCH FAVOURED"
  | "SUBSEQUENT TOUCH FAVOURED";

/** One historical print of the entry digit, classified and scored causally. */
export interface EntryTouch {
  /** Index in the causal digit buffer where the entry digit printed. */
  index: number;
  touchClass: TouchClass;
  /** 1-based position of this print inside its cluster (1 = the first print). */
  ordinal: number;
  /** Ticks since the previous print of the entry digit (null for the first ever). */
  gapBefore: number | null;
  /** Did the contract resolve as a win on the run immediately after this print? */
  immediateWin: boolean | null;
  /** Outcomes of the runs following this print, inside the execution window. */
  runs: Array<"WIN" | "LOSS">;
  /** Consecutive wins before the first loss (0 when the first run lost). */
  survivedRuns: number;
}

export interface TouchCohort {
  touchClass: TouchClass;
  /** Number of classified prints with at least one following run. */
  n: number;
  /** Win rate of the run immediately after the trigger. */
  immediateWinRate: number;
  /** Wilson 95% lower bound of the immediate win rate. */
  immediateLower: number;
  /** immediateWinRate − theoretical, in percentage points. */
  edgePp: number;
  /** Win rate across every run observed inside the execution window. */
  windowWinRate: number;
  /** Total runs observed inside the window for this cohort. */
  runsObserved: number;
  /** Mean consecutive wins before the first loss. */
  averageSurvivalRuns: number;
  /** Share of prints where the very first run lost. */
  firstRunLossRate: number;
  /** Units per run at 1:1 risk/reward (2p − 1), on the immediate run. */
  expectancy: number;
  /** 0..100 agreement between the older and newer halves of this cohort. */
  stability: number;
  /** True only when this cohort is large enough to be published at all. */
  sufficient: boolean;
}

export interface EntryTriggerReport {
  symbol: string;
  contract: string;
  contractLabel: string;
  entryDigit: number;
  winners: number[];
  theoretical: number;

  /** Derived absence threshold, in ticks, that defines a FIRST touch here. */
  absenceThreshold: number;
  /** The measured mean gap between prints of the entry digit. */
  meanGap: number;
  /** Ticks since the entry digit last printed, at the end of the causal buffer. */
  sinceSeen: number;

  first: TouchCohort;
  subsequent: TouchCohort;

  verdict: EntryTriggerVerdict;
  /** The touch class the evidence favours, or null when it favours neither. */
  preferredTouch: TouchClass | null;
  /**
   * Separation between the two cohorts on the immediate run, in percentage
   * points. Positive means FIRST touch is ahead.
   */
  separationPp: number;
  /** True when the two cohorts' Wilson bounds do not overlap. */
  separationSignificant: boolean;

  /**
   * Given the live buffer, would the NEXT print of the entry digit be a FIRST
   * touch? This is what turns the evidence into an actionable instruction.
   */
  nextTouchIsFirst: boolean;
  /** True when the next print falls into the cohort the evidence favours. */
  nextTouchAligned: boolean | null;

  /** Bounded ranking contribution, in score points (±4). */
  rankingDelta: number;
  /** The literal instruction the operator should follow. */
  instruction: string;
  summary: string;
  lines: string[];
  invalidation: string[];
  touches: EntryTouch[];
}

export interface EntryTriggerConfig {
  /** How many runs after the trigger are evaluated. */
  windowRuns: number;
  /** Minimum classified prints in a cohort before it may be published. */
  minTouches: number;
  /** Minimum percentage-point separation before a preference may be declared. */
  minSeparationPp: number;
}

export const DEFAULT_ENTRY_TRIGGER_CONFIG: EntryTriggerConfig = {
  windowRuns: 6,
  minTouches: 15,
  minSeparationPp: 4,
};

/** Maximum ranking influence Level-2.5 evidence may ever have. */
export const MAX_ENTRY_TRIGGER_DELTA = 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface EntryTriggerInputs {
  symbol: string;
  contract: string;
  contractLabel?: string;
  /** Causal digit history, oldest → newest. Nothing beyond it is ever read. */
  digits: number[];
  /** The contract's winning (resolution) digits — never the entry digit. */
  winners: number[];
  /** The entry digit the operator waits for before starting the bot. */
  entryDigit: number;
  config?: Partial<EntryTriggerConfig>;
  /** Optional hard causality cut; digits beyond it are treated as non-existent. */
  asOf?: number;
}

/** Re-exported from the canonical touch classifier — one owner for this rule. */
export const digitGapProfile = canonicalDigitGapProfile;

/**
 * Classify every historical print of the entry digit into FIRST / SUBSEQUENT and
 * attach the runs that followed it. Purely causal: the class of a print depends
 * only on earlier ticks, its outcome only on later ones.
 */
export function classifyTouches(input: EntryTriggerInputs): {
  touches: EntryTouch[];
  absenceThreshold: number;
  meanGap: number;
  sinceSeen: number;
} {
  const cfg = { ...DEFAULT_ENTRY_TRIGGER_CONFIG, ...(input.config ?? {}) };
  const cut =
    input.asOf === undefined ? input.digits.length : clamp(input.asOf, 0, input.digits.length);
  const digits = input.digits.slice(0, cut);
  const winners = new Set(input.winners);

  // Canonical classification (touch-classification.ts owns the FIRST/SUBSEQUENT
  // rule, so entry triggers and execution survival can never disagree).
  const { prints, absenceThreshold, meanGap, sinceSeen } = classifyPrints(digits, input.entryDigit);

  const touches: EntryTouch[] = [];
  for (const print of prints) {
    const i = print.index;
    const runs: Array<"WIN" | "LOSS"> = [];
    for (let r = 1; r <= cfg.windowRuns && i + r < digits.length; r++) {
      runs.push(winners.has(digits[i + r]) ? "WIN" : "LOSS");
    }
    if (!runs.length) continue;

    let survived = 0;
    while (survived < runs.length && runs[survived] === "WIN") survived++;

    touches.push({
      index: i,
      touchClass: print.touchClass,
      ordinal: print.ordinal,
      gapBefore: print.gapBefore,
      immediateWin: runs[0] === "WIN",
      runs,
      survivedRuns: survived,
    });
  }

  return { touches, absenceThreshold, meanGap, sinceSeen };
}

function emptyCohort(touchClass: TouchClass): TouchCohort {
  return {
    touchClass,
    n: 0,
    immediateWinRate: 0,
    immediateLower: 0,
    edgePp: 0,
    windowWinRate: 0,
    runsObserved: 0,
    averageSurvivalRuns: 0,
    firstRunLossRate: 0,
    expectancy: 0,
    stability: 0,
    sufficient: false,
  };
}

function buildCohort(
  touchClass: TouchClass,
  touches: EntryTouch[],
  theoretical: number,
  minTouches: number,
): TouchCohort {
  const rows = touches.filter((t) => t.touchClass === touchClass);
  if (!rows.length) return emptyCohort(touchClass);

  const n = rows.length;
  const immediateWins = rows.filter((t) => t.immediateWin).length;
  const immediateWinRate = immediateWins / n;

  let runsObserved = 0;
  let windowWins = 0;
  for (const t of rows) {
    runsObserved += t.runs.length;
    windowWins += t.runs.filter((r) => r === "WIN").length;
  }

  // Stability: agreement between the older and the newer half of this cohort.
  const half = Math.floor(n / 2);
  let stability = 0;
  if (half >= 3) {
    const older = rows.slice(0, half);
    const newer = rows.slice(n - half);
    const a = older.filter((t) => t.immediateWin).length / older.length;
    const b = newer.filter((t) => t.immediateWin).length / newer.length;
    stability = Math.round(clamp(100 - Math.abs(a - b) * 260, 0, 100));
  }

  return {
    touchClass,
    n,
    immediateWinRate,
    immediateLower: wilsonLower(immediateWins, n),
    edgePp: (immediateWinRate - theoretical) * 100,
    windowWinRate: runsObserved ? windowWins / runsObserved : 0,
    runsObserved,
    averageSurvivalRuns: rows.reduce((a, t) => a + t.survivedRuns, 0) / n,
    firstRunLossRate: rows.filter((t) => !t.immediateWin).length / n,
    expectancy: 2 * immediateWinRate - 1,
    stability,
    sufficient: n >= minTouches,
  };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`;

/**
 * LEVEL 2.5 — full entry-trigger report for one market × contract × entry digit.
 * Reports INSUFFICIENT TRIGGER HISTORY and fabricates nothing when either cohort
 * is too small to be separated from noise.
 */
export function computeEntryTrigger(input: EntryTriggerInputs): EntryTriggerReport {
  const cfg = { ...DEFAULT_ENTRY_TRIGGER_CONFIG, ...(input.config ?? {}) };
  const contractLabel = input.contractLabel ?? input.contract;
  const theoretical = input.winners.length / 10;
  const { touches, absenceThreshold, meanGap, sinceSeen } = classifyTouches(input);

  const first = buildCohort("FIRST", touches, theoretical, cfg.minTouches);
  const subsequent = buildCohort("SUBSEQUENT", touches, theoretical, cfg.minTouches);

  const separationPp = (first.immediateWinRate - subsequent.immediateWinRate) * 100;
  const bothSufficient = first.sufficient && subsequent.sufficient;

  // Non-overlapping Wilson bounds — the honest test that the two cohorts are not
  // the same population observed twice.
  const firstUpper = first.n
    ? Math.min(1, first.immediateWinRate + (first.immediateWinRate - first.immediateLower))
    : 1;
  const subUpper = subsequent.n
    ? Math.min(
        1,
        subsequent.immediateWinRate + (subsequent.immediateWinRate - subsequent.immediateLower),
      )
    : 1;
  const separationSignificant =
    bothSufficient && (first.immediateLower > subUpper || subsequent.immediateLower > firstUpper);

  const nextTouchIsFirst = sinceSeen >= absenceThreshold;

  let verdict: EntryTriggerVerdict;
  let preferredTouch: TouchClass | null = null;

  if (!bothSufficient) {
    verdict = "INSUFFICIENT TRIGGER HISTORY";
  } else if (Math.abs(separationPp) < cfg.minSeparationPp || !separationSignificant) {
    verdict = "NO MEASURED DIFFERENCE";
  } else if (separationPp > 0) {
    verdict = "FIRST TOUCH FAVOURED";
    preferredTouch = "FIRST";
  } else {
    verdict = "SUBSEQUENT TOUCH FAVOURED";
    preferredTouch = "SUBSEQUENT";
  }

  const nextTouchAligned = preferredTouch
    ? preferredTouch === (nextTouchIsFirst ? "FIRST" : "SUBSEQUENT")
    : null;

  // ── Bounded ranking contribution ──────────────────────────────────────
  // Unknown is neither punished nor rewarded. Only a measured, significant
  // separation moves the score, and only for the cohort the NEXT print falls in.
  let rankingDelta = 0;
  if (preferredTouch) {
    const live = nextTouchIsFirst ? first : subsequent;
    const edgePart = clamp(live.edgePp * 0.35, -3, 3);
    const alignPart = nextTouchAligned ? 1 : -1;
    const stabilityPart = live.stability >= 60 ? 0.5 : live.stability < 35 ? -0.5 : 0;
    rankingDelta =
      Math.round(
        clamp(
          edgePart + alignPart + stabilityPart,
          -MAX_ENTRY_TRIGGER_DELTA,
          MAX_ENTRY_TRIGGER_DELTA,
        ) * 10,
      ) / 10;
  }

  const digitPhrase = `digit ${input.entryDigit}`;
  const firstDefinition = `a print of ${digitPhrase} after it has been absent for at least ${absenceThreshold} tick${absenceThreshold === 1 ? "" : "s"} (its own measured mean gap is ${meanGap.toFixed(1)})`;

  let instruction: string;
  if (verdict === "INSUFFICIENT TRIGGER HISTORY") {
    instruction = `TRIGGER ON ANY QUALIFYING PRINT OF DIGIT ${input.entryDigit} — first-versus-subsequent touch behaviour is not yet measurable here (${first.n} first / ${subsequent.n} subsequent classified prints, ${cfg.minTouches} needed in each).`;
  } else if (verdict === "NO MEASURED DIFFERENCE") {
    instruction = `TRIGGER ON ANY QUALIFYING PRINT OF DIGIT ${input.entryDigit} — first and subsequent touches are statistically indistinguishable here (${pct(first.immediateWinRate)} vs ${pct(subsequent.immediateWinRate)}, separation ${pp(separationPp)}).`;
  } else if (preferredTouch === "FIRST") {
    instruction = nextTouchIsFirst
      ? `WAIT FOR THE NEXT PRINT OF DIGIT ${input.entryDigit} AND TRIGGER ON IT — digit ${input.entryDigit} has now been absent for ${sinceSeen} tick${sinceSeen === 1 ? "" : "s"}, so the next print qualifies as a FIRST touch, the cohort this market × contract historically favours.`
      : `DO NOT TRIGGER ON THE NEXT PRINT OF DIGIT ${input.entryDigit} — the digit printed ${sinceSeen} tick${sinceSeen === 1 ? "" : "s"} ago, so the next print is a SUBSEQUENT touch. WAIT FOR ${firstDefinition}, then trigger on that print.`;
  } else {
    instruction = nextTouchIsFirst
      ? `HOLD THROUGH THE NEXT PRINT OF DIGIT ${input.entryDigit} — it will be a FIRST touch, and this market × contract historically performs better on the repeat prints that follow it. Trigger on the next print after that, while the digit is still clustering.`
      : `TRIGGER ON THE NEXT PRINT OF DIGIT ${input.entryDigit} — digit ${input.entryDigit} printed ${sinceSeen} tick${sinceSeen === 1 ? "" : "s"} ago, so the next print is a SUBSEQUENT touch, the cohort this market × contract historically favours.`;
  }

  const lines: string[] = [];
  if (first.n)
    lines.push(
      `FIRST touch — ${first.n} print(s), immediate win rate ${pct(first.immediateWinRate)} (lower bound ${pct(first.immediateLower)}) vs theoretical ${pct(theoretical)} → ${pp(first.edgePp)}; average ${first.averageSurvivalRuns.toFixed(2)} run(s) survived; stability ${first.stability}/100${first.sufficient ? "" : " — SAMPLE TOO SMALL TO PUBLISH"}.`,
    );
  if (subsequent.n)
    lines.push(
      `SUBSEQUENT touch — ${subsequent.n} print(s), immediate win rate ${pct(subsequent.immediateWinRate)} (lower bound ${pct(subsequent.immediateLower)}) vs theoretical ${pct(theoretical)} → ${pp(subsequent.edgePp)}; average ${subsequent.averageSurvivalRuns.toFixed(2)} run(s) survived; stability ${subsequent.stability}/100${subsequent.sufficient ? "" : " — SAMPLE TOO SMALL TO PUBLISH"}.`,
    );
  if (!lines.length)
    lines.push(
      `No classified print of digit ${input.entryDigit} has a following run in the causal buffer.`,
    );

  const summary =
    `LEVEL 2.5 — ${input.symbol} · ${contractLabel} · entry ${digitPhrase}: ${verdict}. ` +
    `A FIRST touch here means ${firstDefinition}. ` +
    `${first.n} first / ${subsequent.n} subsequent classified prints, separation ${pp(separationPp)}` +
    (bothSufficient
      ? separationSignificant
        ? " with non-overlapping confidence bounds"
        : " but the confidence bounds overlap, so it is treated as noise"
      : "") +
    `. The digit last printed ${sinceSeen} tick(s) ago, so the next print is a ${nextTouchIsFirst ? "FIRST" : "SUBSEQUENT"} touch. ` +
    `Historical evidence about observed trigger behaviour only — never a prediction, and it never changes a Level-1 contract result.`;

  const invalidation: string[] = [];
  if (preferredTouch)
    invalidation.push(
      `The ${preferredTouch === "FIRST" ? "first" : "subsequent"}-touch advantage on digit ${input.entryDigit} closing to under ${cfg.minSeparationPp}pp`,
    );
  else
    invalidation.push(
      `First-versus-subsequent touch behaviour on digit ${input.entryDigit} remaining unseparated from noise`,
    );
  invalidation.push(
    `The measured mean gap of digit ${input.entryDigit} moving away from ${meanGap.toFixed(1)} ticks, which would redefine what a FIRST touch is here`,
  );

  return {
    symbol: input.symbol,
    contract: input.contract,
    contractLabel,
    entryDigit: input.entryDigit,
    winners: [...input.winners],
    theoretical,
    absenceThreshold,
    meanGap,
    sinceSeen,
    first,
    subsequent,
    verdict,
    preferredTouch,
    separationPp,
    separationSignificant,
    nextTouchIsFirst,
    nextTouchAligned,
    rankingDelta,
    instruction,
    summary,
    lines,
    invalidation,
    touches,
  };
}

/** One-line trigger statement for the handoff, alert and learning views. */
export function entryTriggerHeadline(report: EntryTriggerReport | null): string {
  if (!report) return "ENTRY TRIGGER: NOT APPLICABLE — no validated entry digit.";
  if (report.verdict === "INSUFFICIENT TRIGGER HISTORY")
    return `ENTRY TRIGGER: INSUFFICIENT HISTORY — ${report.first.n} first / ${report.subsequent.n} subsequent prints of digit ${report.entryDigit}.`;
  if (report.verdict === "NO MEASURED DIFFERENCE")
    return `ENTRY TRIGGER: ANY QUALIFYING PRINT of digit ${report.entryDigit} — no measured first-versus-subsequent difference.`;
  return `ENTRY TRIGGER: ${report.preferredTouch} TOUCH of digit ${report.entryDigit} (${pp(report.separationPp)} separation) — next print is a ${report.nextTouchIsFirst ? "FIRST" : "SUBSEQUENT"} touch.`;
}
