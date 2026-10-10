// APEX SENTINEL — OPERATOR SURFACE VETTING.
//
// This module is deliberately NOT a ranking engine. It preserves the existing
// authoritative finalRank order and only admits the first candidate that has
// earned access to the operator surface.
//
// Mandatory surface rules:
//   1) canonical 1,000-tick digit psychology = SUPPORT (65+)
//   2) zero losing-side digits are gaining
//   3) losing-side group threat < 10 (10 is not accepted)
//
// Missing evidence fails closed. No fallback score, re-sort, or qualification
// subset is permitted here.
import type { RankedOpportunity } from "./types";

export const SURFACE_PSYCHOLOGY_MIN = 65;
export const SURFACE_GROUP_THREAT_MAX_EXCLUSIVE = 10;

export interface SurfaceVettingResult {
  pass: boolean;
  reasons: string[];
  psychologySupport: boolean;
  losingDigitsRising: number;
  groupThreat: number | null;
  sweepConfirmed: boolean;
  sweepState: string | null;
}

function psychologySupport(candidate: RankedOpportunity): boolean {
  const p = candidate.digitPsychology;
  if (!p) return false;
  return p.verdict === "SUPPORT" && p.score >= SURFACE_PSYCHOLOGY_MIN;
}

function losingRisingCount(candidate: RankedOpportunity): number | null {
  const lsp = (candidate.losingSidePressure ?? candidate.contract.losingSidePressure ?? null) as
    | { risingCount?: number }
    | null;
  if (lsp && typeof lsp.risingCount === "number") return lsp.risingCount;
  // The threat engine is the canonical fallback for this already-computed
  // losing-side movement. It is still existing evidence, never a new engine.
  if (candidate.contract.threat && Array.isArray(candidate.contract.threat.risingLosers)) {
    return candidate.contract.threat.risingLosers.length;
  }
  return null;
}

function groupThreat(candidate: RankedOpportunity): number | null {
  const threat =
    candidate.contract.threat ??
    ((candidate as { threat?: { groupThreat: number } | null }).threat ?? null);
  return threat && Number.isFinite(threat.groupThreat) ? threat.groupThreat : null;
}

export function evaluateSurfaceVetting(candidate: RankedOpportunity): SurfaceVettingResult {
  const reasons: string[] = [];
  const psych = psychologySupport(candidate);
  const rising = losingRisingCount(candidate);
  const threat = groupThreat(candidate);
  const sweep = candidate.observationDossier?.liquiditySweep ?? null;

  if (!candidate.digitPsychology) reasons.push("1,000-tick digit psychology unavailable");
  else if (!psych)
    reasons.push(
      `Digit psychology ${candidate.digitPsychology.score}/100 (${candidate.digitPsychology.verdict}) — SUPPORT requires ${SURFACE_PSYCHOLOGY_MIN}+`,
    );

  if (rising === null) reasons.push("Losing-side rising-count evidence unavailable");
  else if (rising !== 0) reasons.push(`${rising} losing-side digit(s) are gaining`);

  if (threat === null) reasons.push("Losing-side group threat unavailable");
  else if (!(threat < SURFACE_GROUP_THREAT_MAX_EXCLUSIVE))
    reasons.push(
      `Losing-side group threat ${threat.toFixed(2)} — must be < ${SURFACE_GROUP_THREAT_MAX_EXCLUSIVE}`,
    );

  if (!sweep) reasons.push("Observed liquidity sweep evidence unavailable");
  else if (!sweep.confirmed) reasons.push(`Liquidity sweep ${sweep.state} — required state is CONFIRMED`);

  return {
    pass:
      psych &&
      rising === 0 &&
      threat !== null &&
      threat < SURFACE_GROUP_THREAT_MAX_EXCLUSIVE &&
      Boolean(sweep?.confirmed),
    reasons,
    psychologySupport: psych,
    losingDigitsRising: rising ?? -1,
    groupThreat: threat,
    sweepConfirmed: Boolean(sweep?.confirmed),
    sweepState: sweep?.state ?? null,
  };
}

/** Stable filter: preserves finalRank ordering and never mutates the input. */
export function surfaceVetRank(
  finalRank: readonly RankedOpportunity[],
): RankedOpportunity[] {
  return finalRank.filter((candidate) => evaluateSurfaceVetting(candidate).pass);
}

/** First survivor in authoritative rank order. */
export function selectSurfacedOpportunity(
  finalRank: readonly RankedOpportunity[],
): RankedOpportunity | null {
  return surfaceVetRank(finalRank)[0] ?? null;
}
