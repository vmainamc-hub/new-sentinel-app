// APEX SENTINEL — EVIDENCE STATUS CLASSIFICATION.
//
// The ranking engine must not use one rigid threshold. A small sample with a
// 100% win rate must not outrank a mature sample with slightly lower but real
// performance — and a new opportunity must not be discarded merely for being
// new. Instead, every candidate is CLASSIFIED, and the class carries how much
// authority its numbers are allowed.
import type { ClearanceReport } from "./clearance";
import type { EntryRecommendation } from "./entry-conditions";
import type { SimPerformance } from "./simulator";

export type EvidenceStatus =
  | "INSUFFICIENT SAMPLE"
  | "EXPLORATORY"
  | "DEVELOPING"
  | "PROMISING"
  | "VALIDATED"
  | "STRONG"
  | "UNDERPERFORMING"
  | "BLOCKED";

export interface EvidenceAssessment {
  status: EvidenceStatus;
  /** 0..100 — confidence in the *evidence*, not in the direction. */
  confidence: number;
  /** 0..100 — how uncertain the estimate still is (sample + interval width). */
  uncertainty: number;
  /** How much this evidence may move the ranking, 0..1. */
  authority: number;
  /** Machine-readable reason codes for the bot-ready output. */
  codes: string[];
  note: string;
}

export interface EvidenceInputs {
  lifetime: SimPerformance | null;
  recent: SimPerformance | null;
  theoretical: number;
  clearance: ClearanceReport;
  entry: EntryRecommendation | null;
}

/** Confidence-adjusted classification of one market/contract's evidence. */
export function classifyEvidence(input: EvidenceInputs): EvidenceAssessment {
  const { lifetime, recent, theoretical, clearance, entry } = input;
  const codes: string[] = [];
  const n = lifetime?.n ?? 0;
  const rn = recent?.n ?? 0;

  if (clearance.state === "BLOCKED") {
    return {
      status: "BLOCKED",
      confidence: 0,
      uncertainty: 100,
      authority: 0,
      codes: ["CLEARANCE_BLOCKED", ...clearance.blockers.map((b) => b.code)],
      note: clearance.summary,
    };
  }

  // Interval width is the honest uncertainty measure: it shrinks with sample.
  const width = lifetime && lifetime.n ? lifetime.upper - lifetime.lower : 1;
  const uncertainty = Math.round(Math.max(0, Math.min(100, width * 100)));

  const edgeLB = lifetime && lifetime.n ? lifetime.lower - theoretical : 0;
  const edgeObs = lifetime && lifetime.n ? lifetime.winRate - theoretical : 0;
  const recentEdge = recent && recent.n ? recent.winRate - theoretical : 0;

  let status: EvidenceStatus;
  if (n === 0) {
    status = "INSUFFICIENT SAMPLE";
    codes.push("NO_RESOLVED_SAMPLE");
  } else if (n < 25) {
    status = "EXPLORATORY";
    codes.push("SAMPLE_EXPLORATORY");
  } else if (lifetime && lifetime.expectancy < 0 && n >= 60) {
    status = "UNDERPERFORMING";
    codes.push("NEGATIVE_EXPECTANCY");
  } else if (edgeObs < -0.05 && n >= 40) {
    status = "UNDERPERFORMING";
    codes.push("BELOW_BASELINE");
  } else if (n < 60) {
    status = "DEVELOPING";
    codes.push("SAMPLE_DEVELOPING");
  } else if (edgeLB > 0.02 && n >= 250) {
    status = "STRONG";
    codes.push("LOWER_BOUND_ABOVE_BASELINE", "SAMPLE_MATURE");
  } else if (edgeLB > 0 && n >= 120) {
    status = "VALIDATED";
    codes.push("LOWER_BOUND_ABOVE_BASELINE");
  } else if (edgeObs > 0) {
    status = "PROMISING";
    codes.push("OBSERVED_ABOVE_BASELINE");
  } else {
    status = "DEVELOPING";
    codes.push("NO_MEASURED_EDGE_YET");
  }

  if (clearance.state === "UNSTABLE") codes.push("MARKET_UNSTABLE");
  if (clearance.state === "CAUTION") codes.push("CLEARANCE_CAUTION");
  if (recent && rn >= 10 && recentEdge < -0.06) codes.push("RECENT_DEGRADATION");
  if (lifetime && lifetime.deteriorationPp < -6) codes.push("DETERIORATING");
  if (entry?.best) codes.push(`ENTRY_${entry.best.rule}_${entry.best.state}`);

  const sampleConfidence = Math.min(100, Math.round((n / 250) * 100));
  const intervalConfidence = 100 - uncertainty;
  const clearancePenalty =
    clearance.state === "CLEAR"
      ? 0
      : clearance.state === "CAUTION"
        ? 10
        : clearance.state === "UNSTABLE"
          ? 22
          : 35;
  const confidence = Math.max(
    0,
    Math.min(
      100,
      Math.round(sampleConfidence * 0.45 + intervalConfidence * 0.55 - clearancePenalty),
    ),
  );

  const authority =
    status === "STRONG"
      ? 1
      : status === "VALIDATED"
        ? 0.8
        : status === "PROMISING"
          ? 0.5
          : status === "DEVELOPING"
            ? 0.3
            : status === "EXPLORATORY"
              ? 0.12
              : status === "UNDERPERFORMING"
                ? 0.85 // a bad record keeps most of its authority — downside must bite
                : 0;

  const note =
    n === 0
      ? "No contract-resolved outcomes yet on this market/contract — surfaced as an unproven opportunity, not as validated evidence."
      : `${status} — ${(lifetime!.winRate * 100).toFixed(1)}% over N=${n} (95% CI ${(lifetime!.lower * 100).toFixed(1)}–${(lifetime!.upper * 100).toFixed(1)}%) vs ${(theoretical * 100).toFixed(0)}% baseline; recent window N=${rn}${
          rn ? ` at ${(recent!.winRate * 100).toFixed(1)}%` : ""
        }.`;

  return { status, confidence, uncertainty, authority, codes, note };
}
