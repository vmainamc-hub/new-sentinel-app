// APEX SENTINEL — GRADED EMPIRICAL CONFLUENCE.
//
// Encodes one empirically observed high-quality convergence regime as a
// GRADED ranking enhancement, not a qualification gate:
//
//   Cell identity conformance (permanent identity vs. live evidence)
//   + 1,000-tick Digit Psychology >= 64%
//   + 120-tick pressure supports the winning side
//   + winning digits increasing / losing digits decreasing
//   + engine agreement supports the same direction
//   + danger is low
//
// This module computes NOTHING new. Every input is read from the existing,
// already-computed Sentinel/Apex evidence:
//
//   identity         -> the existing per-cell IdentityConformance graded
//                        result (cellIdentity.ts), read via the identity
//                        integration contract (identityIntegrationContract.ts).
//                        Materially participates in the score below and is
//                        not duplicated as a late identity-ranking tier.
//   psychology       -> candidateDigitPsychology() (final-decision.ts) — the
//                        ONE canonical 1,000-tick digit-psychology score.
//   pressure         -> the existing 15/30/60/120 PressureField group
//                        readings for the contract's winners/losers
//                        (observation dossier `pressure.raw.winPressure` /
//                        `losePressure`, computeGroupPressure() output),
//                        falling back to the existing bounded
//                        winningSideMomentum / losingSidePressure modifiers
//                        when the richer telemetry isn't attached.
//   engineAgreement  -> the existing candidate.agreement label
//                        (SUPPORT / NEUTRAL / CONFLICT / STRONG CONFLICT).
//   danger           -> the existing authoritative danger composition.
//
// The output is a normalised 0..100 score plus a transparent, attributable
// breakdown — never a second opinion, never a fabricated number. It is
// consumed by final-rank.ts as an ADDITIONAL discriminator; it never
// replaces candidate.score, never overrides a structural/danger veto, and
// never creates a second ranking (see final-rank.ts for the single
// authoritative ordering this feeds into).

import { candidateDigitPsychology } from "../sentinel/final-decision";
import { getIdentityRankingEvidence } from "../sentinel/observation/identityIntegrationContract";
import type { IdentityConformanceLabel } from "../sentinel/observation/cellIdentity";

export type ConfluenceLevel = "MAXIMUM" | "HIGH" | "STRONG" | "PARTIAL" | "NEGATIVE" | "NONE";

export interface ConfluenceComponent {
  label: string;
  /** Whether this dimension had real evidence to read. */
  measurable: boolean;
  /** 0..100 sub-score for this dimension alone, before weighting. */
  raw: number;
  /** Weight applied to `raw` when composing the overall score (0..1). */
  weight: number;
  /** raw * weight — this dimension's contribution to the 0..100 total. */
  contribution: number;
  detail: string;
}

export interface ConfluenceCore {
  /** True when at least one dimension had real evidence. */
  measurable: boolean;
  /** True only when identity, psychology, pressure, engine agreement, and danger are all measurable. */
  complete: boolean;
  /** 0..100 — how strongly the five empirical dimensions agree. */
  score: number;
  level: ConfluenceLevel;
  identity: ConfluenceComponent;
  psychology: ConfluenceComponent;
  pressure: ConfluenceComponent;
  engineAgreement: ConfluenceComponent;
  danger: ConfluenceComponent;
  reasons: string[];
  summary: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Empirical threshold from the observed high-quality pattern. Preserved exactly. */
export const CONFLUENCE_PSYCHOLOGY_THRESHOLD = 64;

/**
 * Starting conceptual weights (§15 of the empirical-confluence spec),
 * extended with an explicit identity weight (identity spec Fix #2/§14).
 *
 * The original four weights (0.3 / 0.3 / 0.2 / 0.2) are preserved in their
 * original 3:3:2:2 proportion to each other — they are scaled down by the
 * same factor (0.75) to make room for the new identity dimension at 0.25,
 * rather than being replaced or re-derived. Total is still 1.0.
 */
export const CONFLUENCE_WEIGHTS = {
  identity: 0.25,
  psychology: 0.225,
  pressure: 0.225,
  engineAgreement: 0.15,
  danger: 0.15,
} as const;

// ── IDENTITY. GRADED CELL-IDENTITY CONFORMANCE ─────────────────────────────
//
// Reads the already-computed IdentityConformance for this candidate's cell
// (cellIdentity.ts, via the identity integration contract) and folds its
// graded label into the confluence score. No identity math is duplicated
// here — this only maps the existing FAILED..FULL label onto the same 0..100
// sub-scale the other dimensions use, so identity materially participates in
// the strengthened opportunity score rather than acting only as a late
// tie-breaker.
const IDENTITY_RAW: Record<IdentityConformanceLabel, number> = {
  FAILED: 0,
  WEAK: 15,
  PARTIAL: 35,
  DEVELOPING: 55,
  STRONG: 80,
  FULL: 100,
};

function candidateIdentityEvidenceForConfluence(candidate: any) {
  const dossier = candidate?.dossier ?? candidate?.observationDossier ?? null;
  if (!dossier || typeof dossier.cellId !== "string") return null;
  return getIdentityRankingEvidence(dossier);
}

function identityComponent(candidate: any): ConfluenceComponent {
  const ev = candidateIdentityEvidenceForConfluence(candidate);
  const label = ev?.identityConformance?.label ?? null;

  if (!ev || ev.identityIntegrity !== "VALID" || !label) {
    return {
      label: "Cell Identity Conformance",
      measurable: false,
      raw: 0,
      weight: CONFLUENCE_WEIGHTS.identity,
      contribution: 0,
      detail: ev?.identityIntegrity === "MISMATCH"
        ? "Concrete cell identity mismatch — identity confluence is unavailable."
        : ev?.identityIntegrity === "MISSING"
          ? "Permanent cell identity missing — identity confluence is unavailable."
          : "No identity-conformance evidence attached to this candidate.",
    };
  }

  // A hard-blocked / structurally FAILED identity earns zero confluence
  // credit here. The authoritative veto itself is enforced separately, in
  // final-rank.ts tier 2b — this only removes its scoring contribution.
  const raw = ev.hardBlocked ? 0 : IDENTITY_RAW[label];

  return {
    label: "Cell Identity Conformance",
    measurable: true,
    raw,
    weight: CONFLUENCE_WEIGHTS.identity,
    contribution: raw * CONFLUENCE_WEIGHTS.identity,
    detail: ev.hardBlocked
      ? "Identity hard-blocked — no confluence credit."
      : `Identity conformance: ${label} (${ev.positiveSignals.length} conforming / ${ev.negativeSignals.length} conflicting signal(s)).`,
  };
}

// ── A. GRADED 1,000-TICK PSYCHOLOGY ────────────────────────────────────────
//
// Continuous, not boolean. The 64% empirical threshold is preserved as an
// inflection point: everything at or above it lands in the upper half of the
// 0..100 sub-scale (25..100), everything below lands in the lower quarter
// (0..20) so a 63% candidate is never confused with a 65% one, and 64/68/72/76
// are all distinguishable from each other.
function psychologyComponent(candidate: any): ConfluenceComponent {
  const psych = candidateDigitPsychology(candidate);
  const score = typeof psych?.score === "number" ? psych.score : null;

  if (score === null) {
    return {
      label: "1,000-Tick Digit Psychology",
      measurable: false,
      raw: 0,
      weight: CONFLUENCE_WEIGHTS.psychology,
      contribution: 0,
      detail: "No canonical digit-psychology score available.",
    };
  }

  const raw =
    score >= CONFLUENCE_PSYCHOLOGY_THRESHOLD
      ? clamp(25 + ((score - CONFLUENCE_PSYCHOLOGY_THRESHOLD) / (100 - CONFLUENCE_PSYCHOLOGY_THRESHOLD)) * 75, 25, 100)
      : clamp((score / CONFLUENCE_PSYCHOLOGY_THRESHOLD) * 20, 0, 20);

  return {
    label: "1,000-Tick Digit Psychology",
    measurable: true,
    raw,
    weight: CONFLUENCE_WEIGHTS.psychology,
    contribution: raw * CONFLUENCE_WEIGHTS.psychology,
    detail:
      score >= CONFLUENCE_PSYCHOLOGY_THRESHOLD
        ? `${score.toFixed(1)}/100 — at/above the ${CONFLUENCE_PSYCHOLOGY_THRESHOLD}% empirical threshold.`
        : `${score.toFixed(1)}/100 — below the ${CONFLUENCE_PSYCHOLOGY_THRESHOLD}% empirical threshold; no 64+ confluence contribution.`,
  };
}

// ── B. 120-TICK WINNING/LOSING PRESSURE ALIGNMENT ──────────────────────────
//
// Prefers the existing 15/30/60/120 group-pressure telemetry
// (computeGroupPressure over the contract's winners/losers, attached to the
// observation dossier as pressure.raw.winPressure / losePressure). Falls
// back to the existing bounded winningSideMomentum / losingSidePressure
// modifiers when that richer telemetry isn't attached to the candidate.
interface PressureReadingLike {
  measurable?: boolean;
  ratePp?: number;
  persistence?: number;
  monotonicUp?: boolean;
  monotonicDown?: boolean;
  agreement?: string;
  direction?: string;
  movement?: string;
}

/** 0..100 for one side. `wantIncreasing` = true for the winning side, false for losing. */
function sidePressureScore(reading: PressureReadingLike | null | undefined, wantIncreasing: boolean): number | null {
  if (!reading || reading.measurable === false || typeof reading.ratePp !== "number") return null;
  const sign = wantIncreasing ? 1 : -1;
  const signedRatePp = reading.ratePp * sign;

  // 0pp move -> neutral 50; roughly +/-4.2pp saturates the scale.
  let score = 50 + signedRatePp * 12;

  // Persistence (0..1, 0.5 neutral) nudges the score +/-10.
  if (typeof reading.persistence === "number") {
    score += (reading.persistence - 0.5) * 20;
  }

  // A genuinely monotonic move in the wanted direction is the strongest
  // possible reading — not a burst.
  if (wantIncreasing && reading.monotonicUp) score += 8;
  if (!wantIncreasing && reading.monotonicDown) score += 8;

  return clamp(score, 0, 100);
}

function agreementBump(agreement: string | undefined): number {
  switch (agreement) {
    case "4/4":
      return 6;
    case "3/4":
      return 3;
    case "2/4":
      return 0;
    case "1/4":
    case "NONE":
      return -3;
    default:
      return 0;
  }
}

function pressureComponent(candidate: any): ConfluenceComponent {
  const dossier = candidate?.dossier ?? candidate?.observationDossier ?? null;
  const winPressure: PressureReadingLike | null = dossier?.pressure?.raw?.winPressure ?? null;
  const losePressure: PressureReadingLike | null = dossier?.pressure?.raw?.losePressure ?? null;

  const winScore = sidePressureScore(winPressure, true);
  const loseScore = sidePressureScore(losePressure, false);

  if (winScore !== null && loseScore !== null) {
    const combined = clamp(
      winScore * 0.55 + loseScore * 0.45 + agreementBump(winPressure?.agreement),
      0,
      100,
    );
    return {
      label: "120-Tick Pressure Alignment",
      measurable: true,
      raw: combined,
      weight: CONFLUENCE_WEIGHTS.pressure,
      contribution: combined * CONFLUENCE_WEIGHTS.pressure,
      detail:
        `Winning side ${winPressure?.direction ?? "?"}/${winPressure?.movement ?? "?"} ` +
        `(rate ${(winPressure?.ratePp ?? 0) >= 0 ? "+" : ""}${(winPressure?.ratePp ?? 0).toFixed(2)}pp, window agreement ${winPressure?.agreement ?? "?"}); ` +
        `losing side ${losePressure?.direction ?? "?"}/${losePressure?.movement ?? "?"} ` +
        `(rate ${(losePressure?.ratePp ?? 0) >= 0 ? "+" : ""}${(losePressure?.ratePp ?? 0).toFixed(2)}pp).`,
    };
  }

  if (winScore !== null || loseScore !== null) {
    // Only one side measurable — real, but partial, evidence. Regress
    // towards neutral rather than letting one side's noise fully decide.
    const single = winScore ?? loseScore ?? 50;
    const combined = clamp(single * 0.7 + 50 * 0.3, 0, 100);
    return {
      label: "120-Tick Pressure Alignment",
      measurable: true,
      raw: combined,
      weight: CONFLUENCE_WEIGHTS.pressure,
      contribution: combined * CONFLUENCE_WEIGHTS.pressure,
      detail: "Only one side of the 120-tick pressure field was measurable — partial evidence.",
    };
  }

  // Fall back to the existing bounded, contract-level modifiers.
  const wsmIndex = candidate?.contract?.winningSideMomentum?.index;
  const lspIndex = candidate?.losingSidePressure?.index ?? candidate?.contract?.losingSidePressure?.index;
  const fallbackWin = typeof wsmIndex === "number" ? clamp(50 + wsmIndex * 0.5, 0, 100) : null;
  const fallbackLose = typeof lspIndex === "number" ? clamp(100 - lspIndex, 0, 100) : null;

  if (fallbackWin !== null || fallbackLose !== null) {
    const parts = [fallbackWin, fallbackLose].filter((v): v is number => v !== null);
    const combined = clamp(parts.reduce((a, b) => a + b, 0) / parts.length, 0, 100);
    return {
      label: "120-Tick Pressure Alignment",
      measurable: true,
      raw: combined,
      weight: CONFLUENCE_WEIGHTS.pressure,
      contribution: combined * CONFLUENCE_WEIGHTS.pressure,
      detail: "120-tick pressure field unavailable — used the existing bounded winning/losing-side modifiers instead.",
    };
  }

  return {
    label: "120-Tick Pressure Alignment",
    measurable: false,
    raw: 0,
    weight: CONFLUENCE_WEIGHTS.pressure,
    contribution: 0,
    detail: "No pressure telemetry available for this candidate.",
  };
}

// ── C. ENGINE AGREEMENT ─────────────────────────────────────────────────
const AGREEMENT_RAW: Record<string, number> = {
  SUPPORT: 90,
  NEUTRAL: 50,
  CONFLICT: 20,
  "STRONG CONFLICT": 0,
};

function engineAgreementComponent(candidate: any): ConfluenceComponent {
  const agreement = candidate?.agreement;
  const measurable = typeof agreement === "string" && agreement in AGREEMENT_RAW;
  const raw = measurable ? AGREEMENT_RAW[agreement as string] : 0;

  return {
    label: "Engine Agreement",
    measurable,
    raw,
    weight: CONFLUENCE_WEIGHTS.engineAgreement,
    contribution: raw * CONFLUENCE_WEIGHTS.engineAgreement,
    detail: measurable
      ? `Cross-engine agreement: ${agreement}.`
      : "No cross-engine agreement label available.",
  };
}

// ── D. DANGER SAFETY ────────────────────────────────────────────────────
function dangerComponent(candidate: any): ConfluenceComponent {
  const dc = candidate?.dangerComposition ?? candidate?.contract?.dangerComposition ?? null;
  let total: number | null = null;

  if (dc && typeof dc.total === "number") {
    total = dc.total;
  } else if (typeof candidate?.danger === "number") {
    total = candidate.danger;
  } else if (typeof candidate?.contract?.danger === "number") {
    total = candidate.contract.danger;
  }

  if (total === null) {
    return {
      label: "Danger Safety",
      measurable: false,
      raw: 0,
      weight: CONFLUENCE_WEIGHTS.danger,
      contribution: 0,
      detail: "No danger composition available.",
    };
  }

  // A hard-blocked candidate earns zero danger-safety credit here — the
  // authoritative veto itself is enforced elsewhere (final-rank.ts §17).
  const raw = dc?.isHardBlocked ? 0 : clamp(100 - total, 0, 100);

  return {
    label: "Danger Safety",
    measurable: true,
    raw,
    weight: CONFLUENCE_WEIGHTS.danger,
    contribution: raw * CONFLUENCE_WEIGHTS.danger,
    detail: dc?.isHardBlocked
      ? "Danger composition is hard-blocked — no confluence credit."
      : `Danger ${total.toFixed(0)}/100${dc?.level ? ` (${dc.level})` : ""}.`,
  };
}

function levelOf(score: number, measurable: boolean): ConfluenceLevel {
  if (!measurable) return "NONE";
  if (score >= 85) return "MAXIMUM";
  if (score >= 65) return "HIGH";
  if (score >= 45) return "STRONG";
  if (score >= 25) return "PARTIAL";
  return "NEGATIVE";
}

/**
 * Compute the graded, 0..100 empirical Confluence score for one candidate.
 * Pure function of already-computed Sentinel/Apex evidence — no new tick
 * scans, no duplicate telemetry, no fabricated values. Deterministic: same
 * candidate evidence always produces the same score and level.
 */
export function computeConfluenceCore(candidate: any): ConfluenceCore {
  const identity = identityComponent(candidate);
  const psychology = psychologyComponent(candidate);
  const pressure = pressureComponent(candidate);
  const engineAgreement = engineAgreementComponent(candidate);
  const danger = dangerComponent(candidate);

  const components = [identity, psychology, pressure, engineAgreement, danger];
  const measurable = components.some((c) => c.measurable);
  const complete = components.every((c) => c.measurable);

  // MISSING EVIDENCE IS UNKNOWN, NEVER NEGATIVE EVIDENCE (§27).
  //
  // The score is the weighted mean over the dimensions that actually had
  // evidence, so an ABSENT dimension neither adds nor subtracts. Summing raw
  // contributions over the full 1.0 weight mass would silently charge a
  // candidate the full penalty of a dimension it has no evidence for — e.g. a
  // candidate with no identity record would be capped at 75/100 and read as
  // though its identity conformance had FAILED. That is fabricated negative
  // evidence and it is exactly what the identity contract forbids.
  //
  // This does NOT weaken identity: when identity evidence IS present it
  // carries its full 0.25 share of the normalised score (the largest single
  // weight), and a FAILED / hard-blocked identity still drives that share to
  // zero and drags the whole opportunity score down.
  const measuredWeight = components
    .filter((c) => c.measurable)
    .reduce((sum, c) => sum + c.weight, 0);
  const score =
    measurable && measuredWeight > 0
      ? clamp(
          components.reduce((sum, c) => sum + (c.measurable ? c.contribution : 0), 0) / measuredWeight,
          0,
          100,
        )
      : 0;
  const level = levelOf(score, measurable);



  const reasons = [identity, psychology, pressure, engineAgreement, danger]
    .filter((c) => c.measurable)
    .map((c) => `${c.label}: ${c.detail}`);

  const summary = measurable
    ? `CONFLUENCE ${score.toFixed(1)}/100 (${level})${complete ? " — COMPLETE" : " — INCOMPLETE EVIDENCE"} — ${reasons.join(" ")}`
    : "CONFLUENCE not measurable — no supporting evidence attached to this candidate.";

  return {
    measurable,
    complete,
    score,
    level,
    identity,
    psychology,
    pressure,
    engineAgreement,
    danger,
    reasons,
    summary,
  };
}
