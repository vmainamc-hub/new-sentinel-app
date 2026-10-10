// APEX SENTINEL — LEVEL-2 EXECUTION SURVIVAL ↔ DECISION INTEGRATION.
//
// execution-survival.ts already measures how a market × contract × entry digit
// has historically behaved over the runs FOLLOWING the entry digit. Until now
// that engine was not connected to ranking, qualification, the validity window
// or the alert layer. This module is that connection — and nothing else.
//
// Hard rules honoured here:
//   • Level 2 never rewrites a Level-1 (contract resolution) result. It is a
//     separate evidence dimension that only adjusts CONFIDENCE and RANKING.
//   • Its influence is bounded (±6 ranking points, never a veto by itself).
//   • Insufficient sample means INSUFFICIENT HISTORY — never "probably fine".
//   • Isolation is absolute: market × contract × entry digit.
import {
  computeExecutionSurvival,
  type ExecutionSurvivalConfig,
  type ExecutionSurvivalReport,
} from "./execution-survival";
import type { EntryWindow } from "./entry-point";

/** Maximum ranking influence Level-2 evidence may ever have, in score points. */
export const MAX_SURVIVAL_RANKING_DELTA = 6;

export interface SurvivalEvaluationInput {
  symbol: string;
  contract: string;
  contractLabel: string;
  digits: number[];
  winners: number[];
  entryDigit: number | null;
  config?: Partial<ExecutionSurvivalConfig>;
}

// Recomputing the full sequence scan on every 1s re-rank is wasteful, so the
// report is memoised on (market × contract × entry digit). A length-only
// freshness test is UNSAFE for a rolling buffer whose length is capped: the
// content changes every tick while the length stays constant, so the key is a
// content fingerprint instead.
export function fingerprintBuffer(digits: number[], winners: number[]): string {
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum = (sum * 31 + digits[i]) % 2147483647;
  return `${n}:${digits.slice(0, 8).join("")}:${digits.slice(-8).join("")}:${sum}:${winners.join("")}`;
}

interface CacheRow {
  fingerprint: string;
  report: ExecutionSurvivalReport;
}
const cache = new Map<string, CacheRow>();

export function resetExecutionSurvivalCache(): void {
  cache.clear();
}

/**
 * Level-2 report for one candidate, or null when there is no validated entry
 * digit (survival is only defined relative to an entry digit) or the causal
 * buffer is too short to measure anything honestly.
 */
export function evaluateExecutionSurvival(
  input: SurvivalEvaluationInput,
): ExecutionSurvivalReport | null {
  if (input.entryDigit === null || input.entryDigit < 0) return null;
  if (input.digits.length < 20) return null;
  const key = `${input.symbol}|${input.contract}|${input.entryDigit}`;
  const fingerprint = fingerprintBuffer(input.digits, input.winners);
  const hit = cache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.report;
  const report = computeExecutionSurvival({
    symbol: input.symbol,
    contract: input.contract,
    contractLabel: input.contractLabel,
    digits: input.digits,
    winners: input.winners,
    entryDigit: input.entryDigit,
    config: input.config,
  });
  cache.set(key, { fingerprint, report });

  return report;
}

export interface SurvivalInfluence {
  /** Bounded ranking contribution, in score points. */
  points: number;
  /** Presentation label — always honest about an immature sample. */
  label: ExecutionSurvivalReport["label"] | "NOT APPLICABLE";
  /** Short attributed reason for the contribution. */
  detail: string;
  /** True when the sample is mature enough to be used at all. */
  sufficient: boolean;
  /** True when the measured post-entry behaviour argues against execution. */
  fragile: boolean;
}

/**
 * Convert Level-2 evidence into a BOUNDED ranking contribution.
 *
 * A market with a good edge but no execution history keeps its score exactly —
 * unknown is not punished and not rewarded. Only measured evidence moves it.
 */
export function survivalInfluence(report: ExecutionSurvivalReport | null): SurvivalInfluence {
  if (!report)
    return {
      points: 0,
      label: "NOT APPLICABLE",
      detail:
        "No validated entry digit yet, so post-entry survival is undefined for this candidate. Level-2 evidence has no influence.",
      sufficient: false,
      fragile: false,
    };

  if (!report.sufficient)
    return {
      points: 0,
      label: "INSUFFICIENT EXECUTION HISTORY",
      detail: report.summary,
      sufficient: false,
      fragile: false,
    };

  // Two measured quantities drive the contribution, both bounded:
  //   • the post-entry edge over the contract's theoretical rate;
  //   • how far the setup historically survived before its first loss.
  const edgePp = (report.postEntryWinRate - report.theoretical) * 100;
  const edgePart = Math.max(-4, Math.min(4, edgePp * 0.5));
  const survivalPart = Math.max(-2, Math.min(2, (report.averageSurvivalRuns - 1.2) * 1.2));
  const stabilityPart =
    report.postEntryStability >= 60 ? 0.5 : report.postEntryStability < 35 ? -1 : 0;
  const earlyDeterioration =
    report.deteriorationPoint !== null && report.deteriorationPoint <= 2 ? -1.5 : 0;

  const raw = edgePart + survivalPart + stabilityPart + earlyDeterioration;
  const points =
    Math.round(
      Math.max(-MAX_SURVIVAL_RANKING_DELTA, Math.min(MAX_SURVIVAL_RANKING_DELTA, raw)) * 10,
    ) / 10;

  const fragile = report.label === "FRAGILE" || report.lossOnFirstRunRate > 0.5;

  return {
    points,
    label: report.label,
    sufficient: true,
    fragile,
    detail:
      `LEVEL 2 — ${report.sequences} post-entry sequence(s) on ${report.symbol} · ${report.contract} · entry digit ${report.entryDigit}: ` +
      `post-entry win rate ${(report.postEntryWinRate * 100).toFixed(0)}% vs theoretical ${(report.theoretical * 100).toFixed(0)}% ` +
      `(${edgePp >= 0 ? "+" : ""}${edgePp.toFixed(1)}pp), average ${report.averageSurvivalRuns.toFixed(2)} run(s) survived, ` +
      `first-run loss rate ${(report.lossOnFirstRunRate * 100).toFixed(0)}%, stability ${report.postEntryStability}/100` +
      (report.deteriorationPoint
        ? `, deterioration from run ${report.deteriorationPoint}`
        : ", no deterioration point inside the window") +
      `. Survival label ${report.label}. Historical evidence only — it never changes a Level-1 contract result.`,
  };
}

/**
 * §21 — the Entry-Point Engine derives its validity window from conditional
 * digit stability. Where Level-2 evidence exists and shows the post-entry edge
 * decaying early, the presented horizon must not be longer than the measured
 * decay. The window can only be SHORTENED here, never extended.
 */
export function applySurvivalToWindow(
  window: EntryWindow,
  report: ExecutionSurvivalReport | null,
): EntryWindow {
  if (!report || !report.sufficient) return window;
  if (window.kind !== "OCCURRENCES") return window;
  const decayCap =
    report.deteriorationPoint !== null
      ? Math.max(1, report.deteriorationPoint - 1)
      : Math.max(1, Math.floor(report.averageSurvivalRuns));
  if (decayCap >= window.value) return window;
  return {
    kind: "OCCURRENCES",
    value: decayCap,
    label: `VALID FOR THE NEXT ${decayCap} QUALIFYING OCCURRENCE${decayCap > 1 ? "S" : ""} OF DIGIT ${report.entryDigit}`,
    basis:
      `${window.basis} Shortened from ${window.value} by LEVEL-2 execution evidence: ` +
      (report.deteriorationPoint !== null
        ? `observed deterioration begins around run ${report.deteriorationPoint} over ${report.sequences} sequence(s).`
        : `average observed survival is ${report.averageSurvivalRuns.toFixed(2)} run(s) over ${report.sequences} sequence(s).`),
  };
}

/** One-line execution statement for the handoff, alert and learning views. */
export function survivalHeadline(report: ExecutionSurvivalReport | null): string {
  if (!report) return "EXECUTION SURVIVAL: NOT APPLICABLE — no validated entry digit.";
  if (!report.sufficient)
    return `EXECUTION SURVIVAL: INSUFFICIENT HISTORY — ${report.sequences} observed sequence(s).`;
  return `EXECUTION SURVIVAL: ${report.label} — ${report.sequences} sequences, post-entry ${(report.postEntryWinRate * 100).toFixed(0)}% vs theoretical ${(report.theoretical * 100).toFixed(0)}%.`;
}

// ── LEVEL 2.5 — ENTRY TRIGGER INTELLIGENCE ────────────────────────────────
// Which PRINT of the entry digit the operator should actually trigger on. Same
// contract as Level 2: memoised per market × contract × entry digit × buffer
// CONTENT (never length alone), bounded influence, and honest about an immature
// sample. Immediate operator guidance can change what the operator should be
// told, so the live guidance revision participates in the key as well.

import {
  computeEntryTrigger,
  type EntryTriggerConfig,
  type EntryTriggerReport,
} from "./entry-trigger";
import { guidanceRevision } from "./immediate-guidance";

interface TriggerCacheRow {
  fingerprint: string;
  report: EntryTriggerReport;
}
const triggerCache = new Map<string, TriggerCacheRow>();

export function resetEntryTriggerCache(): void {
  triggerCache.clear();
}

export interface EntryTriggerEvaluationInput {
  symbol: string;
  contract: string;
  contractLabel: string;
  digits: number[];
  winners: number[];
  entryDigit: number | null;
  config?: Partial<EntryTriggerConfig>;
}

/**
 * Level-2.5 report for one candidate, or null when there is no validated entry
 * digit (trigger selection is only defined relative to an entry digit) or the
 * causal buffer is too short to classify touches honestly.
 */
export function evaluateEntryTrigger(
  input: EntryTriggerEvaluationInput,
): EntryTriggerReport | null {
  if (input.entryDigit === null || input.entryDigit < 0) return null;
  if (input.digits.length < 20) return null;
  const key = `${input.symbol}|${input.contract}|${input.entryDigit}`;
  const fingerprint = `${fingerprintBuffer(input.digits, input.winners)}|g${guidanceRevision()}`;
  const hit = triggerCache.get(key);
  if (hit && hit.fingerprint === fingerprint) return hit.report;
  const report = computeEntryTrigger({
    symbol: input.symbol,
    contract: input.contract,
    contractLabel: input.contractLabel,
    digits: input.digits,
    winners: input.winners,
    entryDigit: input.entryDigit,
    config: input.config,
  });
  triggerCache.set(key, { fingerprint, report });
  return report;
}
