// APEX SENTINEL — DIGIT PSYCHOLOGY ENGINE.
//
// The operator observes recurring digit configurations that tend to precede
// strong Over / Under behaviour. Those observations are NOT treated as proven
// facts and are NOT described as literal human traders. They are modelled here
// as competing contract/digit PRESSURE GROUPS (Over, Under, Even, Odd, Matches,
// Differs) plus two explicit, testable feature families:
//
//   OVER_PSYCHOLOGY_*   — the observed Over setup
//   UNDER_PSYCHOLOGY_*  — the observed Under setup
//
// Every condition is evaluated from live observed ticks only. Each pattern
// reports supporting evidence AND contradictions, and carries a confidence that
// scales with the sample actually available. The simulator and market-specific
// learning decide how much weight these hypotheses eventually deserve —
// this module never claims certainty.
import type { BarStructure } from "./bars";
import type { DigitIntel } from "./digit-intel";
import type { DigitStatsOut, PressureOut } from "./types";

export type PsychologySide = "OVER" | "UNDER";

/** One evaluated condition of an observed psychology pattern. */
export interface PsychologyCondition {
  id: string;
  label: string;
  weight: number;
  /** true = satisfied, false = contradicted, null = not evaluable right now. */
  state: boolean | null;
  detail: string;
}

export interface PsychologyPattern {
  side: PsychologySide;
  /** 0..100 — share of evaluable weight that is satisfied. */
  score: number;
  /** 0..100 — how much of the pattern could actually be measured, and on how much data. */
  confidence: number;
  supporting: string[];
  contradictions: string[];
  conditions: PsychologyCondition[];
  /** True when the pattern is both well formed and measurable. */
  aligned: boolean;
  note: string;
}

/** Competing contract/digit pressure groups — never literal traders. */
export interface GroupState {
  group: "OVER" | "UNDER" | "EVEN" | "ODD" | "MATCHES" | "DIFFERS";
  digits: number[];
  /** Fast-window share held by the group. */
  share: number;
  /** Long baseline share of the group. */
  baseline: number;
  /** share − baseline. */
  pressure: number;
  rising: boolean;
}

export interface PsychologyReport {
  n: number;
  over: PsychologyPattern;
  under: PsychologyPattern;
  /** Which observed pattern is currently better formed (NONE when neither is). */
  dominant: PsychologySide | "NONE";
  groups: GroupState[];
  /** Bar digits currently holding the sensitive green / red / second-bar roles. */
  greenDigit: number | null;
  redDigit: number | null;
  secondBarDigit: number | null;
  secondBarColor: "GREEN" | "RED" | "FLAT" | null;
  summary: string;
}

const EVEN = [0, 2, 4, 6, 8];
const ODD = [1, 3, 5, 7, 9];
const UNIFORM = 0.1;
/** The elevated threshold the operator watches on digit 0 / digit 9. */
export const ELEVATED_SHARE = 0.103;

function pctShare(list: number[], pct: number[]): number {
  return list.reduce((a, d) => a + (pct[d] ?? 0), 0) / 100;
}

function fracShare(list: number[], share: number[]): number {
  return list.reduce((a, d) => a + (share[d] ?? 0), 0);
}

function decreasing(intel: DigitIntel | null, d: number): boolean {
  const p = intel?.profiles?.[d];
  if (!p) return false;
  return p.pressure < 0 || p.frequencyVelocity < 0 || p.exhaustion >= 0.5;
}

function rising(intel: DigitIntel | null, d: number): boolean {
  const p = intel?.profiles?.[d];
  if (!p) return false;
  return p.pressure > 0.004 && p.frequencyVelocity > 0;
}

function quiet(intel: DigitIntel | null, d: number, pct: number[]): boolean {
  const p = intel?.profiles?.[d];
  const near = Math.abs((pct[d] ?? 10) / 100 - UNIFORM) <= 0.02;
  if (!p) return near;
  return near && Math.abs(p.pressure) <= 0.02 && p.anomaly < 55 && p.consecutive < 2;
}

function buildPattern(
  side: PsychologySide,
  conditions: PsychologyCondition[],
  n: number,
  measurable: number,
): PsychologyPattern {
  const evaluable = conditions.filter((c) => c.state !== null);
  const totalWeight = evaluable.reduce((a, c) => a + c.weight, 0);
  const satisfied = evaluable.filter((c) => c.state === true);
  const gained = satisfied.reduce((a, c) => a + c.weight, 0);
  const score = totalWeight > 0 ? Math.round((gained / totalWeight) * 100) : 0;

  // Confidence: how much of the pattern was measurable × how much data exists.
  const coverage = totalWeight / conditions.reduce((a, c) => a + c.weight, 0);
  const dataFactor = Math.min(1, n / 1200);
  const confidence = Math.round(
    Math.max(0, Math.min(100, coverage * 55 + dataFactor * 35 + measurable * 10)),
  );

  const supporting = satisfied.map((c) => `${c.label}: ${c.detail}`);
  const contradictions = evaluable
    .filter((c) => c.state === false)
    .map((c) => `${c.label}: ${c.detail}`);

  const aligned = score >= 70 && confidence >= 45 && contradictions.length <= 1;
  const note = aligned
    ? `${side} psychology configuration is well formed (${score}/100, confidence ${confidence}/100) — a hypothesis, still subject to simulator validation.`
    : totalWeight === 0
      ? `${side} psychology could not be evaluated — bar / digit structure unavailable.`
      : `${side} psychology is only partially formed (${score}/100, ${contradictions.length} contradiction(s)).`;

  return { side, score, confidence, supporting, contradictions, conditions, aligned, note };
}

/**
 * Evaluate the observed Over and Under psychology configurations plus the
 * competing contract-group pressure map.
 */
export function psychologyEngine(
  stats: DigitStatsOut | null,
  pressure: PressureOut | null,
  bars: BarStructure | null,
  intel: DigitIntel | null,
): PsychologyReport {
  const pct = stats?.pct ?? new Array(10).fill(10);
  const recent = stats?.recentPct ?? pct;
  const n = stats?.n ?? 0;

  // ── Sensitive bar roles (green / red / second bar) ──────────────────
  const cur = bars?.current ?? null;
  const prev = bars?.previous ?? null;
  const second = bars?.secondPrevious ?? null;
  const chain = [cur, prev, second].filter(Boolean) as NonNullable<typeof cur>[];
  const greenBar = chain.find((b) => b.color === "GREEN") ?? null;
  const redBar = chain.find((b) => b.color === "RED") ?? null;
  const greenDigit = greenBar && greenBar.digit >= 0 ? greenBar.digit : null;
  const redDigit = redBar && redBar.digit >= 0 ? redBar.digit : null;
  const secondBarDigit = prev && prev.digit >= 0 ? prev.digit : null;
  const secondBarColor = prev ? prev.color : null;
  const measurable =
    greenDigit !== null && redDigit !== null
      ? 1
      : greenDigit !== null || redDigit !== null
        ? 0.5
        : 0;

  // ── OVER psychology ─────────────────────────────────────────────────
  const overConds: PsychologyCondition[] = [];

  overConds.push({
    id: "OVER_GREEN_EVEN",
    label: "Green bar on an even digit",
    weight: 25,
    state: greenDigit === null ? null : EVEN.includes(greenDigit),
    detail:
      greenDigit === null
        ? "No green bar in the sensitive window."
        : `Green bar printed digit ${greenDigit} (${EVEN.includes(greenDigit) ? "even — supports Over" : "odd — contradicts the observed Over setup"}).`,
  });

  overConds.push({
    id: "OVER_GREEN_ZERO_EXHAUSTED",
    label: "Green bar 0 must be exhausted / decreasing",
    weight: 12,
    state: greenDigit === 0 ? decreasing(intel, 0) : null,
    detail:
      greenDigit === 0
        ? decreasing(intel, 0)
          ? "Green bar sits on 0 and digit 0 pressure is falling — acceptable."
          : "Green bar sits on 0 while digit 0 is still building — the observed setup prefers an exhausted 0."
        : "Green bar is not on 0 — condition not applicable.",
  });

  overConds.push({
    id: "OVER_RED_ODD",
    label: "Red bar on an odd digit (3,5,7,9)",
    weight: 20,
    state: redDigit === null ? null : [3, 5, 7, 9].includes(redDigit),
    detail:
      redDigit === null
        ? "No red bar in the sensitive window."
        : `Red bar printed digit ${redDigit}${[3, 5, 7, 9].includes(redDigit) ? " — inside the preferred odd set." : " — outside the preferred 3/5/7/9 set."}`,
  });

  overConds.push({
    id: "OVER_RED_NOT_ONE",
    label: "Red bar must not be on 1",
    weight: 10,
    state: redDigit === null ? null : redDigit !== 1,
    detail:
      redDigit === 1
        ? "Red bar is on digit 1 — the observed Over setup explicitly excludes this."
        : "Red bar is not on digit 1.",
  });

  const zeroShare = (pct[0] ?? 10) / 100;
  overConds.push({
    id: "OVER_ZERO_ELEVATED_DECAYING",
    label: "Digit 0 elevated but decreasing",
    weight: 15,
    state: n < 200 ? null : zeroShare > ELEVATED_SHARE && decreasing(intel, 0),
    detail:
      n < 200
        ? "Not enough ticks to judge digit 0."
        : `Digit 0 at ${(zeroShare * 100).toFixed(2)}% (${zeroShare > ELEVATED_SHARE ? "above" : "at/below"} ${(ELEVATED_SHARE * 100).toFixed(1)}%) and ${decreasing(intel, 0) ? "decreasing" : "not decreasing"}.`,
  });

  const highSuppressed = [5, 6, 7, 8, 9].filter((d) => (pct[d] ?? 10) / 100 < UNIFORM);
  const highRising = [5, 6, 7, 8, 9].filter((d) => rising(intel, d));
  overConds.push({
    id: "OVER_HIGH_RECOVERY",
    label: "Digits 5–9 recovering from suppression with pressure",
    weight: 18,
    state: n < 200 ? null : highRising.length >= 2 && highSuppressed.length >= 1,
    detail:
      n < 200
        ? "Not enough ticks to judge the 5–9 group."
        : `Suppressed high digits: ${highSuppressed.join(", ") || "none"}. Rising with pressure: ${highRising.join(", ") || "none"}.`,
  });

  overConds.push({
    id: "OVER_ONE_CALM",
    label: "Digit 1 quiet and outside the critical roles",
    weight: 10,
    state:
      n < 200
        ? null
        : quiet(intel, 1, pct) && greenDigit !== 1 && redDigit !== 1 && secondBarDigit !== 1,
    detail:
      n < 200
        ? "Not enough ticks to judge digit 1."
        : `Digit 1 at ${(pct[1] ?? 10).toFixed(2)}%${greenDigit === 1 || redDigit === 1 || secondBarDigit === 1 ? " and currently occupies a sensitive bar role" : " and holds no sensitive bar role"}.`,
  });

  // ── UNDER psychology (mirror of the observed Over setup) ────────────
  const underConds: PsychologyCondition[] = [];

  underConds.push({
    id: "UNDER_GREEN_ODD",
    label: "Green bar on an odd digit (9,7,5,3,1)",
    weight: 25,
    state: greenDigit === null ? null : ODD.includes(greenDigit),
    detail:
      greenDigit === null
        ? "No green bar in the sensitive window."
        : `Green bar printed digit ${greenDigit} (${ODD.includes(greenDigit) ? "odd — supports Under" : "even — contradicts the observed Under setup"}).`,
  });

  underConds.push({
    id: "UNDER_GREEN_NINE_EXHAUSTED",
    label: "Green bar 9 must be exhausted / decreasing",
    weight: 12,
    state: greenDigit === 9 ? decreasing(intel, 9) : null,
    detail:
      greenDigit === 9
        ? decreasing(intel, 9)
          ? "Green bar sits on 9 and digit 9 pressure is falling — acceptable."
          : "Green bar sits on 9 while digit 9 is still building — the observed setup prefers an exhausted 9."
        : "Green bar is not on 9 — condition not applicable.",
  });

  underConds.push({
    id: "UNDER_RED_EVEN",
    label: "Red bar on an even digit (0,2,4,6)",
    weight: 20,
    state: redDigit === null ? null : [0, 2, 4, 6].includes(redDigit),
    detail:
      redDigit === null
        ? "No red bar in the sensitive window."
        : `Red bar printed digit ${redDigit}${[0, 2, 4, 6].includes(redDigit) ? " — inside the preferred even set." : " — outside the preferred 0/2/4/6 set."}`,
  });

  underConds.push({
    id: "UNDER_RED_NOT_EIGHT",
    label: "Red bar must not be on 8",
    weight: 10,
    state: redDigit === null ? null : redDigit !== 8,
    detail:
      redDigit === 8
        ? "Red bar is on digit 8 — the observed Under setup explicitly excludes this."
        : "Red bar is not on digit 8.",
  });

  const nineShare = (pct[9] ?? 10) / 100;
  underConds.push({
    id: "UNDER_NINE_ELEVATED_DECAYING",
    label: "Digit 9 elevated but decreasing",
    weight: 15,
    state: n < 200 ? null : nineShare > ELEVATED_SHARE && decreasing(intel, 9),
    detail:
      n < 200
        ? "Not enough ticks to judge digit 9."
        : `Digit 9 at ${(nineShare * 100).toFixed(2)}% (${nineShare > ELEVATED_SHARE ? "above" : "at/below"} ${(ELEVATED_SHARE * 100).toFixed(1)}%) and ${decreasing(intel, 9) ? "decreasing" : "not decreasing"}.`,
  });

  const lowSuppressed = [0, 1, 2, 3, 4].filter((d) => (pct[d] ?? 10) / 100 < UNIFORM);
  const lowRising = [0, 1, 2, 3, 4].filter((d) => rising(intel, d));
  underConds.push({
    id: "UNDER_LOW_RECOVERY",
    label: "Digits 0–4 recovering from suppression with pressure",
    weight: 18,
    state: n < 200 ? null : lowRising.length >= 2 && lowSuppressed.length >= 1,
    detail:
      n < 200
        ? "Not enough ticks to judge the 0–4 group."
        : `Suppressed low digits: ${lowSuppressed.join(", ") || "none"}. Rising with pressure: ${lowRising.join(", ") || "none"}.`,
  });

  underConds.push({
    id: "UNDER_EIGHT_SETTLED",
    label: "Digit 8 settled and outside the critical roles",
    weight: 10,
    state:
      n < 200
        ? null
        : quiet(intel, 8, pct) && greenDigit !== 8 && redDigit !== 8 && secondBarDigit !== 8,
    detail:
      n < 200
        ? "Not enough ticks to judge digit 8."
        : `Digit 8 at ${(pct[8] ?? 10).toFixed(2)}%${greenDigit === 8 || redDigit === 8 || secondBarDigit === 8 ? " and currently occupies a sensitive bar role" : " and holds no sensitive bar role"}.`,
  });

  const over = buildPattern("OVER", overConds, n, measurable);
  const under = buildPattern("UNDER", underConds, n, measurable);

  // ── Competing contract-group pressure map ───────────────────────────
  const fast = pressure ? recent.map((p) => p / 100) : pct.map((p) => p / 100);
  const groupsSpec: { group: GroupState["group"]; digits: number[] }[] = [
    { group: "OVER", digits: [3, 4, 5, 6, 7, 8, 9] },
    { group: "UNDER", digits: [0, 1, 2, 3, 4, 5, 6] },
    { group: "EVEN", digits: EVEN },
    { group: "ODD", digits: ODD },
    { group: "MATCHES", digits: stats ? [stats.lastDigit] : [0] },
    {
      group: "DIFFERS",
      digits: stats
        ? Array.from({ length: 10 }, (_, d) => d).filter((d) => d !== stats.lastDigit)
        : [],
    },
  ];
  const groups: GroupState[] = groupsSpec.map(({ group, digits }) => {
    const share = fracShare(digits, fast);
    const baseline = pctShare(digits, pct);
    const groupRising = digits.filter((d) => rising(intel, d)).length;
    return {
      group,
      digits,
      share,
      baseline,
      pressure: share - baseline,
      rising: groupRising >= Math.max(1, Math.ceil(digits.length / 3)),
    };
  });

  const dominant: PsychologySide | "NONE" =
    over.aligned && !under.aligned
      ? "OVER"
      : under.aligned && !over.aligned
        ? "UNDER"
        : over.aligned && under.aligned
          ? over.score >= under.score
            ? "OVER"
            : "UNDER"
          : "NONE";

  const summary =
    dominant === "NONE"
      ? "No coherent digit-psychology configuration right now — neither the observed Over nor Under structure is well formed."
      : `${dominant} psychology configuration is currently the better formed hypothesis (score ${dominant === "OVER" ? over.score : under.score}/100).`;

  return {
    n,
    over,
    under,
    dominant,
    groups,
    greenDigit,
    redDigit,
    secondBarDigit,
    secondBarColor,
    summary,
  };
}

/** Compact, stable label used for market-specific psychology learning buckets. */
export function psychologyKey(report: PsychologyReport | null): string {
  if (!report) return "PSY:NONE";
  const band = (s: number) => (s >= 80 ? "HIGH" : s >= 60 ? "MID" : "LOW");
  return `PSY:${report.dominant}:O${band(report.over.score)}:U${band(report.under.score)}`;
}
