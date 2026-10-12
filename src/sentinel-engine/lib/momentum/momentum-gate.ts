// APEX SENTINEL — MOMENTUM GATE (selection only).
//
// Sits AFTER the engine's own surface vetting. It takes the list already produced by surfaceVetRank(...) and picks which
// candidate may be TRADED. It never re-sorts, never removes anything from the list it was given, and never mutates its
// input: the first candidate, in the SAME rank order, that passes momentum is the tradable one. With the switch off the
// tradable candidate is simply the first one, which is exactly what selectSurfacedOpportunity returns today.
//
// Missing or unmeasurable momentum evidence fails closed while the switch is on.
import type { RankedOpportunity } from "../apex/types";
import { evaluateMomentumSeparation, type MomentumSeparationReport } from "./momentum-separation";

export interface MomentumGateSetting {
  requireMomentum: boolean;
}

export interface MomentumCandidateReport {
  /** The very same object that was passed in (never a copy). */
  candidate: RankedOpportunity;
  momentum: MomentumSeparationReport;
  /** True only when the switch is on and momentum failed. Always false when the switch is off. */
  blocked: boolean;
}

export interface MomentumGateResult {
  /** First candidate in the given order that may be traded, or null. */
  tradable: RankedOpportunity | null;
  /** One entry per input candidate, in the input order. */
  reports: MomentumCandidateReport[];
  blockedCount: number;
}

/** Momentum report for one candidate. Any evidence problem or unexpected shape is a failed (not a thrown) report. */
export function evaluateCandidateMomentum(candidate: RankedOpportunity): MomentumSeparationReport {
  try {
    return evaluateMomentumSeparation(candidate.priceAction ?? null, candidate.priceActionField?.n ?? 0);
  } catch {
    const failed = evaluateMomentumSeparation(null, 0);
    return { ...failed, blockers: ["Two-sided momentum could not be evaluated for this candidate"] };
  }
}

export function selectTradable(
  vetted: readonly RankedOpportunity[],
  setting: MomentumGateSetting,
): MomentumGateResult {
  const reports: MomentumCandidateReport[] = vetted.map((candidate) => {
    const momentum = evaluateCandidateMomentum(candidate);
    return { candidate, momentum, blocked: setting.requireMomentum && !momentum.pass };
  });
  const firstOpen = reports.find((report) => !report.blocked);
  return {
    tradable: firstOpen ? firstOpen.candidate : null,
    reports,
    blockedCount: reports.filter((report) => report.blocked).length,
  };
}
