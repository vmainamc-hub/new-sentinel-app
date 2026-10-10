/**
 * Identity integration contract.
 *
 * This module deliberately DOES NOT rank candidates. It exposes the canonical
 * identity evidence that the repository's existing single final-rank engine
 * consumes. It carries concrete identity integrity plus graded conformance into
 * the ONE opportunity score; it must never create a second ranking here.
 */
import type { ObservationDossier } from "./types";

export interface IdentityRankingEvidence {
  cellId: string;
  /** Concrete identity integrity. VALID means the dossier identity exactly matches its cell identity. */
  identityIntegrity: "VALID" | "MISSING" | "MISMATCH";
  identityConformance: NonNullable<ObservationDossier["identityConformance"]> | null;
  /** True only when the identity layer has an explicit hard block. */
  hardBlocked: boolean;
  /** Ordered identity signal names for deterministic diagnostics/tie-breaking. */
  positiveSignals: readonly string[];
  negativeSignals: readonly string[];
}

export function getIdentityRankingEvidence(dossier: ObservationDossier): IdentityRankingEvidence {
  const identity = dossier.identity ?? null;
  const identityIntegrity: IdentityRankingEvidence["identityIntegrity"] = !identity
    ? "MISSING"
    : identity.cellId !== dossier.cellId || identity.marketId !== dossier.marketId || identity.proposition !== dossier.proposition
      ? "MISMATCH"
      : "VALID";
  const c = dossier.identityConformance ?? null;
  if (identityIntegrity !== "VALID" || !c) {
    return {
      cellId: dossier.cellId,
      identityIntegrity,
      identityConformance: null,
      hardBlocked: false,
      positiveSignals: [],
      negativeSignals: [identityIntegrity === "MISSING" ? "permanent cell identity missing" : identityIntegrity === "MISMATCH" ? "permanent cell identity does not match concrete cell" : "identity conformance evidence unavailable"],
    };
  }

  const positiveSignals: string[] = [];
  const negativeSignals: string[] = [];
  const add = (ok: boolean | null, positive: string, negative: string) => {
    if (ok === true) positiveSignals.push(positive);
    else if (ok === false) negativeSignals.push(negative);
  };

  add(c.greenPass, "GREEN identity-conforming", "GREEN identity conflict");
  add(c.secondGreenPass, "2ND GREEN identity-conforming", "2ND GREEN identity conflict");
  add(c.redPass, "RED identity-conforming", "RED identity conflict");
  add(c.secondRedPass, "2ND RED identity-conforming", "2ND RED identity conflict");
  add(c.mostIncreasingSupportsIdentity, "most-increasing digit supports winning side", "most-increasing digit conflicts with winning side");
  add(c.mostDecreasingSupportsIdentity, "most-decreasing digit supports losing-side release", "most-decreasing digit does not support losing-side release");
  add(c.edgeGroupPass, "edge-group suppression/rise pattern satisfied", "edge-group suppression/rise pattern failed");
  add(c.paceGroupPass, "pace-group momentum supports identity", "pace-group momentum conflicts with identity");
  add(c.greenDecayPass, "GREEN decay rule satisfied", "GREEN decay rule failed");
  add(c.extremeDigitDecayPass, "extreme-digit exhaustion pattern satisfied", "extreme-digit exhaustion pattern not satisfied");
  add(c.stabilityWatch === "STABLE" ? true : c.stabilityWatch === "UNKNOWN" ? null : false, "stability-watch digit stable", `stability-watch digit ${c.stabilityWatch.toLowerCase()}`);

  if (c.edgeGroupAvgPct !== null) {
    positiveSignals.push(`edge-group average ${c.edgeGroupAvgPct.toFixed(2)}%`);
  }

  return {
    cellId: dossier.cellId,
    identityIntegrity,
    identityConformance: c,
    hardBlocked: c.hardBlocked,
    positiveSignals,
    negativeSignals,
  };
}
