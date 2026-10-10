// APEX SENTINEL — OPERATOR EXECUTION MODEL / SIGNAL SURVIVAL ENGINE (LEVEL 2).
//
// NON-DESTRUCTIVE EXTENSION. This module adds nothing to, and removes nothing
// from, the existing contract-resolution simulator (LEVEL 1, src/lib/apex/
// simulator.ts). It sits ABOVE it and answers a different question:
//
//   LEVEL 1 : "did this contract win?"
//   LEVEL 2 : "if the operator had transferred this signal to DBot, waited for
//              the specified entry digit, started the bot and allowed it to run,
//              how did the SEQUENCE behave before the edge deteriorated?"
//
// Isolation is absolute: MARKET × CONTRACT × ENTRY DIGIT. The same entry digit
// on another market or another contract is a different object and is never
// pooled with this one.
//
// CAUSALITY: every number here is measured on digits that had already printed.
// A sequence is only counted from an entry occurrence that lies in the past,
// and per-run statistics only use sequences that actually REACHED that run, so
// a later tick can never influence an earlier measurement. Nothing in this file
// reads "the future" of the tick buffer it is handed.
//
// Nothing here is a prediction or a guarantee. It is historical evidence about
// observed post-entry behaviour, and it refuses to invent numbers when the
// sample is too small.

import { classifyPrints, type TouchClass } from "./touch-classification";

export type RunOutcome = "WIN" | "LOSS";

/** Which prints of the entry digit a survival measurement is built from. */
export type SurvivalTouchFilter = "ALL" | TouchClass;

export interface ExecutionSequence {
  /** Index in the supplied causal digit buffer where the entry digit printed. */
  entryIndex: number;
  /** FIRST or SUBSEQUENT touch, from the canonical touch classifier. */
  touchClass: TouchClass;
  /** Outcomes of the runs that followed the entry, in order. */
  runs: RunOutcome[];
  /** Consecutive wins before the first loss (0 when run 1 lost). */
  survivedRuns: number;
  /** True when the window ran out before a loss occurred (right-censored). */
  censored: boolean;
  /** Sequence P/L at 1 unit risk : 1 unit reward. */
  units: number;
}

export interface RunStat {
  /** 1-based run number after the entry digit. */
  run: number;
  n: number;
  wins: number;
  winRate: number;
  /** Wilson 95% lower bound of the run win rate. */
  wilsonLower: number;
}

export type SurvivalLabel =
  "INSUFFICIENT EXECUTION HISTORY" | "FRAGILE" | "LOW" | "MODERATE" | "STRONG";

export interface ExecutionSurvivalReport {
  symbol: string;
  contract: string;
  entryDigit: number;
  /** Which touch cohort this report was measured on. */
  touchClass: SurvivalTouchFilter;
  /** The contract's resolution (winning) digits — never the entry digit. */
  winners: number[];
  /** Theoretical per-run win rate of the contract, for comparison only. */
  theoretical: number;

  /** Number of complete post-entry sequences observed. */
  sequences: number;
  /** Total post-entry runs observed across all sequences. */
  runsObserved: number;
  /** Configured execution window (max runs evaluated per entry). */
  windowRuns: number;

  /** True only when the sample meets the evidence requirement. */
  sufficient: boolean;

  perRun: RunStat[];

  averageSurvivalRuns: number;
  medianSurvivalRuns: number;
  bestObservedRunLength: number;
  lossOnFirstRunRate: number;
  recoveryRate: number;
  continuationRate: number;
  /** First run number where the measured edge deteriorates, null when none. */
  deteriorationPoint: number | null;

  postEntryWinRate: number;
  /** Units per run at 1:1 risk/reward (2p − 1). */
  postEntryExpectancy: number;
  /** Worst cumulative unit drawdown observed inside a single sequence. */
  postEntryDrawdown: number;
  /** 0..100 — agreement between the older and newer halves of the evidence. */
  postEntryStability: number;

  label: SurvivalLabel;
  /** Plain-language evidence statement. Never a promise. */
  summary: string;
  /** Per-run lines for the handoff card, empty when evidence is insufficient. */
  lines: string[];
  sequencesDetail: ExecutionSequence[];
}

export interface ExecutionSurvivalConfig {
  /** How many runs after the entry the operator typically allows. */
  windowRuns: number;
  /** Minimum complete sequences before ANY survival metric may be presented. */
  minSequences: number;
  /** Minimum samples on a run before that run's rate may be presented. */
  minRunSamples: number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionSurvivalConfig = {
  windowRuns: 6,
  minSequences: 12,
  minRunSamples: 8,
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function wilsonLower(wins: number, n: number): number {
  if (!n) return 0;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface ExecutionSurvivalInputs {
  symbol: string;
  contract: string;
  contractLabel?: string;
  /** Causal digit history, oldest → newest. Nothing beyond it is ever read. */
  digits: number[];
  /** The contract's winning digits (LEVEL 1 resolution rule, reused as-is). */
  winners: number[];
  /** The entry digit the operator waits for before starting the bot. */
  entryDigit: number;
  config?: Partial<ExecutionSurvivalConfig>;
  /**
   * TOUCH-AWARE SURVIVAL. "ALL" (the default) preserves the original pooled
   * measurement; "FIRST"/"SUBSEQUENT" measure only that touch cohort, so a
   * market where the first touch is weak and later touches are strong is not
   * averaged into one misleading statistic.
   */
  touchClass?: SurvivalTouchFilter;
  /**
   * Optional hard causality cut. Only digits[0 .. asOf−1] are considered; the
   * remainder of the buffer is treated as non-existent. Used by the scanner to
   * evaluate a signal exactly as it stood at the moment it was generated.
   */
  asOf?: number;
}

/**
 * LEVEL 2 — build every historical post-entry run sequence for one
 * market × contract × entry digit combination.
 */
export function buildExecutionSequences(input: ExecutionSurvivalInputs): {
  sequences: ExecutionSequence[];
  windowRuns: number;
} {
  const cfg = { ...DEFAULT_EXECUTION_CONFIG, ...(input.config ?? {}) };
  const cut =
    input.asOf === undefined ? input.digits.length : clamp(input.asOf, 0, input.digits.length);
  const digits = input.digits.slice(0, cut);
  const winners = new Set(input.winners);
  const sequences: ExecutionSequence[] = [];
  const filter: SurvivalTouchFilter = input.touchClass ?? "ALL";
  // ONE definition of first/subsequent touch, owned by touch-classification.ts.
  const { prints } = classifyPrints(digits, input.entryDigit);
  const touchOf = new Map(prints.map((p) => [p.index, p.touchClass]));

  for (let i = 0; i < digits.length - 1; i++) {
    if (digits[i] !== input.entryDigit) continue;
    const touchClass = touchOf.get(i) ?? "FIRST";
    if (filter !== "ALL" && touchClass !== filter) continue;
    const runs: RunOutcome[] = [];
    for (let r = 1; r <= cfg.windowRuns && i + r < digits.length; r++) {
      runs.push(winners.has(digits[i + r]) ? "WIN" : "LOSS");
    }
    if (!runs.length) continue;
    let survived = 0;
    while (survived < runs.length && runs[survived] === "WIN") survived++;
    const censored = survived === runs.length;
    const units = runs.reduce((a, r) => a + (r === "WIN" ? 1 : -1), 0);
    sequences.push({ entryIndex: i, touchClass, runs, survivedRuns: survived, censored, units });
  }

  return { sequences, windowRuns: cfg.windowRuns };
}

/**
 * Full survival report. When the sample is too small it reports
 * INSUFFICIENT EXECUTION HISTORY and fabricates nothing.
 */
export function computeExecutionSurvival(input: ExecutionSurvivalInputs): ExecutionSurvivalReport {
  const cfg = { ...DEFAULT_EXECUTION_CONFIG, ...(input.config ?? {}) };
  const { sequences } = buildExecutionSequences(input);
  const theoretical = input.winners.length / 10;
  const label = input.contractLabel ?? input.contract;

  const base: ExecutionSurvivalReport = {
    symbol: input.symbol,
    contract: input.contract,
    entryDigit: input.entryDigit,
    touchClass: input.touchClass ?? "ALL",
    winners: [...input.winners],
    theoretical,
    sequences: sequences.length,
    runsObserved: sequences.reduce((a, s) => a + s.runs.length, 0),
    windowRuns: cfg.windowRuns,
    sufficient: false,
    perRun: [],
    averageSurvivalRuns: 0,
    medianSurvivalRuns: 0,
    bestObservedRunLength: 0,
    lossOnFirstRunRate: 0,
    recoveryRate: 0,
    continuationRate: 0,
    deteriorationPoint: null,
    postEntryWinRate: 0,
    postEntryExpectancy: 0,
    postEntryDrawdown: 0,
    postEntryStability: 0,
    label: "INSUFFICIENT EXECUTION HISTORY",
    summary: `INSUFFICIENT EXECUTION HISTORY — only ${sequences.length} observed post-entry sequence${sequences.length === 1 ? "" : "s"} for ${input.symbol} · ${label} · entry digit ${input.entryDigit} (needs ${cfg.minSequences}). No expected run length, recovery or continuation is being estimated.`,
    lines: [],
    sequencesDetail: sequences,
  };

  if (sequences.length < cfg.minSequences) return base;

  // ── Per-run statistics ────────────────────────────────────────────────
  // Only sequences that actually REACHED run k contribute to run k, so a
  // truncated (still-open) sequence never depresses a later run.
  const perRun: RunStat[] = [];
  for (let r = 1; r <= cfg.windowRuns; r++) {
    const reached = sequences.filter((s) => s.runs.length >= r);
    if (!reached.length) continue;
    const wins = reached.filter((s) => s.runs[r - 1] === "WIN").length;
    perRun.push({
      run: r,
      n: reached.length,
      wins,
      winRate: wins / reached.length,
      wilsonLower: wilsonLower(wins, reached.length),
    });
  }

  const survivalRuns = sequences.map((s) => s.survivedRuns);
  const averageSurvivalRuns = survivalRuns.reduce((a, v) => a + v, 0) / sequences.length;
  const medianSurvivalRuns = median(survivalRuns);
  const bestObservedRunLength = survivalRuns.reduce((a, v) => Math.max(a, v), 0);
  const lossOnFirstRunRate =
    sequences.filter((s) => s.runs[0] === "LOSS").length / sequences.length;

  // Recovery: after a loss, and given another run existed, did the next win?
  let recoveryChances = 0;
  let recoveries = 0;
  // Continuation: after a win, and given another run existed, did the next win?
  let continuationChances = 0;
  let continuations = 0;
  let totalWins = 0;
  let totalRuns = 0;
  let drawdown = 0;
  for (const s of sequences) {
    let cum = 0;
    let peak = 0;
    for (let i = 0; i < s.runs.length; i++) {
      totalRuns++;
      if (s.runs[i] === "WIN") totalWins++;
      cum += s.runs[i] === "WIN" ? 1 : -1;
      peak = Math.max(peak, cum);
      drawdown = Math.max(drawdown, peak - cum);
      if (i + 1 < s.runs.length) {
        if (s.runs[i] === "LOSS") {
          recoveryChances++;
          if (s.runs[i + 1] === "WIN") recoveries++;
        } else {
          continuationChances++;
          if (s.runs[i + 1] === "WIN") continuations++;
        }
      }
    }
  }

  const postEntryWinRate = totalRuns ? totalWins / totalRuns : 0;
  const postEntryExpectancy = 2 * postEntryWinRate - 1;

  // ── Deterioration point ───────────────────────────────────────────────
  // The first run whose measured rate has dropped materially (≥5pp) below the
  // first run AND sits at or below the contract's theoretical rate. Reported
  // only where the run itself carries enough samples.
  let deteriorationPoint: number | null = null;
  const firstRun = perRun[0];
  if (firstRun && firstRun.n >= cfg.minRunSamples) {
    for (const r of perRun) {
      if (r.run === 1 || r.n < cfg.minRunSamples) continue;
      if (firstRun.winRate - r.winRate >= 0.05 && r.winRate <= theoretical) {
        deteriorationPoint = r.run;
        break;
      }
    }
  }

  // ── Stability: older half vs newer half of the observed sequences ─────
  const half = Math.floor(sequences.length / 2);
  const rateOf = (list: ExecutionSequence[]) => {
    let w = 0;
    let n = 0;
    for (const s of list)
      for (const r of s.runs) {
        n++;
        if (r === "WIN") w++;
      }
    return n ? w / n : 0;
  };
  const older = rateOf(sequences.slice(0, half));
  const newer = rateOf(sequences.slice(half));
  const postEntryStability = Math.round(clamp(100 - Math.abs(newer - older) * 400, 0, 100));

  // ── Label ─────────────────────────────────────────────────────────────
  const edgePp = (postEntryWinRate - theoretical) * 100;
  let survivalLabel: SurvivalLabel;
  if (edgePp <= 0 || lossOnFirstRunRate > 0.5) survivalLabel = "FRAGILE";
  else if (averageSurvivalRuns >= 2.5 && edgePp >= 4 && postEntryStability >= 55)
    survivalLabel = "STRONG";
  else if (averageSurvivalRuns >= 1.5 && edgePp >= 2) survivalLabel = "MODERATE";
  else survivalLabel = "LOW";

  const lines = perRun
    .filter((r) => r.n >= cfg.minRunSamples)
    .map(
      (r) =>
        `Run ${r.run}: ${(r.winRate * 100).toFixed(0)}% win rate (95% LB ${(r.wilsonLower * 100).toFixed(0)}%, N=${r.n})`,
    );

  return {
    ...base,
    sufficient: true,
    perRun,
    averageSurvivalRuns: Math.round(averageSurvivalRuns * 100) / 100,
    medianSurvivalRuns,
    bestObservedRunLength,
    lossOnFirstRunRate: Math.round(lossOnFirstRunRate * 1000) / 1000,
    recoveryRate: recoveryChances ? Math.round((recoveries / recoveryChances) * 1000) / 1000 : 0,
    continuationRate: continuationChances
      ? Math.round((continuations / continuationChances) * 1000) / 1000
      : 0,
    deteriorationPoint,
    postEntryWinRate: Math.round(postEntryWinRate * 1000) / 1000,
    postEntryExpectancy: Math.round(postEntryExpectancy * 1000) / 1000,
    postEntryDrawdown: drawdown,
    postEntryStability,
    label: survivalLabel,
    summary:
      `${input.symbol} · ${label} · entry digit ${input.entryDigit}: ${sequences.length} observed post-entry sequences. ` +
      `Historical post-entry win rate ${(postEntryWinRate * 100).toFixed(0)}% vs theoretical ${(theoretical * 100).toFixed(0)}%, ` +
      `average ${(Math.round(averageSurvivalRuns * 100) / 100).toFixed(2)} successful runs before the first loss` +
      (deteriorationPoint
        ? `, observed deterioration begins around run ${deteriorationPoint}.`
        : `, no clear deterioration point inside a ${cfg.windowRuns}-run window.`) +
      " Historical behaviour only — it does not guarantee future results.",
    lines,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// QUESTION 3 OF THE FINAL SIGNAL PHILOSOPHY
//
// 1. IS THERE AN EDGE?                    → relative-edge / setup engines
// 2. WHERE SHOULD I ENTER?                → entry-point engine
// 3. HOW HAS IT BEHAVED AFTER ENTRY?      → this engine
//
// The three are never collapsed into one score. This classifier only states
// which of the three questions currently have an affirmative answer.
// ─────────────────────────────────────────────────────────────────────────
export type SignalCompleteness =
  | "GOOD MARKET"
  | "GOOD MARKET + GOOD ENTRY"
  | "GOOD MARKET + GOOD ENTRY + GOOD MULTI-RUN SURVIVAL"
  | "NOT QUALIFIED";

export function classifySignalPackage(input: {
  marketQualifies: boolean;
  entryValidated: boolean;
  survival: ExecutionSurvivalReport | null;
}): { level: SignalCompleteness; explanation: string } {
  if (!input.marketQualifies)
    return {
      level: "NOT QUALIFIED",
      explanation:
        "The market/contract edge itself does not qualify — entry and survival are not considered.",
    };
  if (!input.entryValidated)
    return {
      level: "GOOD MARKET",
      explanation:
        "There is a measured market/contract edge, but no entry digit has been validated. A strong market with an uncertain entry point is NOT the same signal package as a validated entry.",
    };
  const s = input.survival;
  if (!s || !s.sufficient)
    return {
      level: "GOOD MARKET + GOOD ENTRY",
      explanation:
        "Market edge and entry digit both qualify. Multi-run survival is unknown — INSUFFICIENT EXECUTION HISTORY, so no execution expectation is offered.",
    };
  if (s.label === "STRONG" || s.label === "MODERATE")
    return {
      level: "GOOD MARKET + GOOD ENTRY + GOOD MULTI-RUN SURVIVAL",
      explanation: `Market edge, validated entry digit and ${s.label.toLowerCase()} historical post-entry survival (${s.averageSurvivalRuns.toFixed(2)} average successful runs over ${s.sequences} sequences).`,
    };
  return {
    level: "GOOD MARKET + GOOD ENTRY",
    explanation: `Market edge and entry digit qualify, but observed post-entry survival is ${s.label} — the edge has not historically survived far beyond the first run here.`,
  };
}
