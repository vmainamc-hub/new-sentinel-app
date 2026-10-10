// APEX SENTINEL — SINGLE AUTHORITATIVE FINAL RANKING
//
// There is exactly ONE final ordering of the 90-cell universe, and exactly ONE
// Rank #1. Qualification (operator surface gate) and Stage 4 risk clearance are
// STATUS/EXECUTION annotations — they are never a second, competing ranking,
// and they never remove or promote a candidate. `finalRank[0]` is therefore
// always the Scan winner, qualified or not; when it is not qualified the UI
// shows it with honest blockers instead of substituting a different candidate.
//
// Ranking hierarchy (highest authority first):
//   1. Mandatory RED structure integrity (structurally-failed never outranks valid)
//   2. CELL IDENTITY structural failure — a cell whose permanent identity is
//      currently FAILED/hard-blocked never outranks an identity-coherent cell.
//   2b. CELL IDENTITY INTEGRITY — a concrete candidate with a missing or
//      mismatched permanent identity never outranks a candidate carrying its
//      verified permanent identity. This is data-integrity protection, not a
//      second ranking.
//   3. COMPLETE OPPORTUNITY EVIDENCE — candidates carrying all five required
//      dimensions (identity, psychology, pressure, engine agreement, danger)
//      outrank incomplete candidates.
//   4. GRADED EMPIRICAL CONFLUENCE — the ONE strengthened opportunity score
//      blending those five dimensions. No qualification score participates.
//   5. Raw digit-psychology score, then raw opportunity score, then a stable
//      deterministic key tiebreaker.
//
// No existing Sentinel mathematics is altered here: every input is read, never
// recomputed.

import type { MarketIntel, RankedOpportunity } from "./types";
import { operatorSurfaceGate, type OperatorSurfaceGateResult } from "./operator-surface-gate";
import { candidateDigitPsychology } from "../sentinel/final-decision";
import { computeConfluenceCore, type ConfluenceCore } from "./confluence";
import {
  getIdentityRankingEvidence,
  type IdentityRankingEvidence,
} from "../sentinel/observation/identityIntegrationContract";

// ── CELL IDENTITY AS A RANKING INPUT ────────────────────────────────────────
//
// Identity is NOT a second ranking and NOT qualification. It enters the ONE
// authoritative ordering through hard structural/integrity protections and as
// the largest single component (25%) of the graded confluence score. There is
// deliberately no late identity-strength tie-break.
//
// Missing identity evidence is UNKNOWN, not a positive identity state. A real
// production 90-cell candidate without valid identity evidence is incomplete
// and therefore cannot outrank a candidate with the complete five-part
// identity/psychology/pressure/engine-agreement/danger opportunity state.

/** Reads the identity evidence already attached to the observation dossier. */
export function candidateIdentityEvidence(candidate: unknown): IdentityRankingEvidence | null {
  const dossier =
    (candidate as any)?.dossier ?? (candidate as any)?.observationDossier ?? null;
  if (!dossier || typeof dossier.cellId !== "string") return null;
  return getIdentityRankingEvidence(dossier);
}

/** True only when the identity layer explicitly reports a broken identity. */
function identityStructurallyFailed(ev: IdentityRankingEvidence | null): boolean {
  if (!ev || !ev.identityConformance) return false; // UNKNOWN — never a failure, never a pass
  return ev.hardBlocked || ev.identityConformance.label === "FAILED";
}


export interface FinalRankEntry<T> {
  candidate: T;
  gate: OperatorSurfaceGateResult;
  /** Passed the operator surface gate AND Stage 4 returned CLEARED. */
  qualified: boolean;
  blockers: string[];
}

export function candidateKey(c: any): string {
  return `${c?.symbol ?? c?.market ?? "?"}:${c?.contract?.id ?? c?.contractId ?? c?.id ?? "?"}`;
}

/** Operator qualification + Stage 4 clearance for a single candidate. */
export function evaluateQualification<T extends RankedOpportunity>(
  candidate: T,
  minScore?: number,
): FinalRankEntry<T> {
  const gate = operatorSurfaceGate(candidate, (candidate as any).intel as MarketIntel, {
    ...(minScore !== undefined ? { minScore } : {}),
  });
  const decision = (candidate as any).finalDecision;
  const stage4Cleared = decision?.verdict === "CLEARED";
  const blockers = [...gate.blockers];
  if (decision && !stage4Cleared && decision.summary && !blockers.includes(decision.summary)) {
    blockers.push(decision.summary);
  }
  return {
    candidate,
    gate,
    qualified: gate.qualified && stage4Cleared,
    blockers,
  };
}

/**
 * Produces the single authoritative ranking. Every input candidate appears
 * exactly once in the output, ranks are re-stamped 1..N, and the order is
 * deterministic for identical inputs.
 */
export function buildFinalRank<T extends RankedOpportunity>(
  candidates: T[],
  minScore?: number,
): { finalRank: T[]; entries: FinalRankEntry<T>[] } {
  const entries = candidates.map((c) => evaluateQualification(c, minScore));

  // GRADED EMPIRICAL CONFLUENCE computed once per candidate, up front, so the
  // comparator and the diagnostic stamp below always agree and nothing is
  // recomputed mid-sort. Keyed by the same stable candidateKey() used
  // elsewhere in this file.
  const confluenceByKey = new Map<string, ConfluenceCore>();
  for (const e of entries) {
    confluenceByKey.set(candidateKey(e.candidate), computeConfluenceCore(e.candidate));
  }
  const getConfluence = (candidate: unknown): ConfluenceCore =>
    confluenceByKey.get(candidateKey(candidate)) ?? computeConfluenceCore(candidate);

  // CELL IDENTITY evidence, read once per candidate from the dossier via the
  // supplied integration contract. Nothing is recomputed and nothing is
  // re-ranked here — this only exposes the evidence to the comparator below.
  const identityByKey = new Map<string, IdentityRankingEvidence | null>();
  for (const e of entries) {
    identityByKey.set(candidateKey(e.candidate), candidateIdentityEvidence(e.candidate));
  }
  const getIdentity = (candidate: unknown): IdentityRankingEvidence | null =>
    identityByKey.get(candidateKey(candidate)) ?? candidateIdentityEvidence(candidate);

  entries.sort((a, b) => {
    const psychA = candidateDigitPsychology(a.candidate);
    const psychB = candidateDigitPsychology(b.candidate);

    // TIER 1 — AUTHORITATIVE HARD STRUCTURAL VETOES.
    // These are genuine contradictions/unsafe states, not ordinary
    // qualification failures. They remain at the bottom of the single
    // ranking and can never be rescued by a high raw score.
    const redFailedA = Boolean(psychA?.redSemantics?.mandatoryRedStructureFailed);
    const redFailedB = Boolean(psychB?.redSemantics?.mandatoryRedStructureFailed);
    if (redFailedA !== redFailedB) return redFailedA ? 1 : -1;

    const idA = getIdentity(a.candidate);
    const idB = getIdentity(b.candidate);
    const idFailedA = identityStructurallyFailed(idA);
    const idFailedB = identityStructurallyFailed(idB);
    if (idFailedA !== idFailedB) return idFailedA ? 1 : -1;

    // TIER 2b — CONCRETE IDENTITY INTEGRITY.
    // Every real 90-cell candidate is expected to carry its own permanent
    // identity. A missing/mismatched identity is an integration/data-integrity
    // defect, not negative market evidence and not a second ranking. Such a
    // candidate cannot outrank one whose permanent identity is verified.
    const integrityA = idA?.identityIntegrity ?? "MISSING";
    const integrityB = idB?.identityIntegrity ?? "MISSING";
    const integrityRank: Record<IdentityRankingEvidence["identityIntegrity"], number> = {
      VALID: 2,
      MISSING: 1,
      MISMATCH: 0,
    };
    if (integrityRank[integrityA] !== integrityRank[integrityB]) {
      return integrityRank[integrityB] - integrityRank[integrityA];
    }

    // TIER 3 — COMPLETENESS OF THE ONE OPPORTUNITY STATE.
    // Rank #1 must be the strongest COMPLETE identity + psychology + pressure
    // + engine-agreement + danger state. A partial candidate can remain in the
    // 90-cell ranking, but it cannot outrank a candidate whose full five-part
    // opportunity state is actually measurable.
    const confA = getConfluence(a.candidate);
    const confB = getConfluence(b.candidate);
    if (confA.complete !== confB.complete) return confA.complete ? -1 : 1;

    // TIER 4 — THE ONE GRADED CONFLUENCE SCORE.
    // Identity is already the largest single component (25%) of this same
    // score. Psychology, 120-tick pressure, engine agreement and danger are
    // the remaining components. Qualification and Stage 4 are NOT ranking
    // dimensions; they are execution/status annotations on the ranked cell.
    if (confA.measurable && confB.measurable && confA.score !== confB.score) {
      return confB.score - confA.score;
    }

    // TIER 5 — RAW 1,000-TICK PSYCHOLOGY.
    const sA = psychA?.score ?? (a.candidate as any).psychologyScore ?? null;
    const sB = psychB?.score ?? (b.candidate as any).psychologyScore ?? null;
    if (sA !== null && sB !== null && sA !== sB) return sB - sA;

    // TIER 6 — RAW OPPORTUNITY SCORE.
    const rawA = (a.candidate as any).score ?? (a.candidate as any).opportunityScore ?? 0;
    const rawB = (b.candidate as any).score ?? (b.candidate as any).opportunityScore ?? 0;
    if (rawA !== rawB) return rawB - rawA;

    return candidateKey(a.candidate).localeCompare(candidateKey(b.candidate));
  });

  const finalRank = entries.map((e, index) => {
    const stamped = {
      ...(e.candidate as any),
      rank: index + 1,
      // Diagnostic transparency (§25 of the empirical-confluence spec): the
      // graded Confluence evidence rides along on the ranked candidate so the
      // UI can show it without recomputing anything.
      confluence: getConfluence(e.candidate),
      // Identity evidence rides along for the same reason (identity spec §14).
      // It is diagnostic output of the ONE ranking, not a second ranking.
      identityEvidence: getIdentity(e.candidate),
    } as T;
    e.candidate = stamped;
    return stamped;
  });


  return { finalRank, entries };
}
