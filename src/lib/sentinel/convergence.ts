// MODEL CONVERGENCE — an internal, explanatory view of whether the
// independent dimensions of Sentinel are pointing the same way.
//
// It is NOT a blocker and it introduces no new evidence: every dimension is a
// transformation of a reading another engine already produced. Its ranking
// influence is deliberately tiny (±2) so it cannot dominate the architecture.
import type { PsychologyChange, PsychologyVerdict } from "./digit-psychology";

export type ConvergenceState = "HIGH CONVERGENCE" | "MODERATE CONVERGENCE" | "FRAGILE" | "LOW";

export interface ConvergenceDimension {
  label: string;
  /** −1 against, 0 neutral/unmeasured, +1 aligned. */
  vote: -1 | 0 | 1;
  detail: string;
}

export interface ConvergenceRead {
  state: ConvergenceState;
  /** 0..100 — share of measurable dimensions that agree. */
  score: number;
  aligned: number;
  against: number;
  unmeasured: number;
  dimensions: ConvergenceDimension[];
  /** Bounded ranking contribution, −2 .. +2. */
  rankingDelta: number;
  summary: string;
}

export interface ConvergenceInputs {
  /** Canonical 1,000-tick distribution change classification. */
  distributionChange: PsychologyChange;
  /** Contract psychology verdict from the canonical layer. */
  psychologyVerdict: PsychologyVerdict;
  /** Price-action / transition direction agreement with the contract side. */
  priceActionAgrees: boolean | null;
  /** True when the entry engine has a validated entry digit (not WAIT). */
  entryValidated: boolean;
  /** Persistence / stability reading, 0..100, or null when unmeasured. */
  stability: number | null;
  /** Execution survival: true aligned, false deteriorating, null insufficient. */
  survivalAligned: boolean | null;
}

export function computeConvergence(i: ConvergenceInputs): ConvergenceRead {
  const dimensions: ConvergenceDimension[] = [];

  const distVote: -1 | 0 | 1 =
    i.distributionChange === "INVALIDATED"
      ? -1
      : i.distributionChange === "STABLE" || i.distributionChange === "STRENGTHENING"
        ? 1
        : 0;
  dimensions.push({
    label: "Digit distribution",
    vote: distVote,
    detail: `Canonical 1,000-tick state is ${i.distributionChange}.`,
  });

  dimensions.push({
    label: "Digit price action",
    vote: i.priceActionAgrees === null ? 0 : i.priceActionAgrees ? 1 : -1,
    detail:
      i.priceActionAgrees === null
        ? "Directional read unavailable."
        : i.priceActionAgrees
          ? "Measured direction points with the contract."
          : "Measured direction points against the contract.",
  });

  dimensions.push({
    label: "Contract psychology",
    vote: i.psychologyVerdict === "SUPPORT" ? 1 : i.psychologyVerdict === "CONFLICT" ? -1 : 0,
    detail: `Canonical contract psychology says ${i.psychologyVerdict}.`,
  });

  dimensions.push({
    label: "Entry digit",
    vote: i.entryValidated ? 1 : 0,
    detail: i.entryValidated
      ? "A validated entry digit is available."
      : "No validated entry digit — the operator is told to WAIT.",
  });

  dimensions.push({
    label: "Persistence / stability",
    vote: i.stability === null ? 0 : i.stability >= 60 ? 1 : i.stability < 40 ? -1 : 0,
    detail:
      i.stability === null
        ? "Stability not measurable yet."
        : `Stability reading ${Math.round(i.stability)}/100.`,
  });

  dimensions.push({
    label: "Execution survival",
    vote: i.survivalAligned === null ? 0 : i.survivalAligned ? 1 : -1,
    detail:
      i.survivalAligned === null
        ? "Post-entry sample still insufficient."
        : i.survivalAligned
          ? "Post-entry behaviour holds up across the execution sequence."
          : "Post-entry behaviour deteriorates across the execution sequence.",
  });

  const aligned = dimensions.filter((d) => d.vote === 1).length;
  const against = dimensions.filter((d) => d.vote === -1).length;
  const unmeasured = dimensions.filter((d) => d.vote === 0).length;
  const measurable = aligned + against;
  const score = measurable ? Math.round((aligned / measurable) * 100) : 0;

  let state: ConvergenceState;
  if (aligned >= 4 && against === 0) state = "HIGH CONVERGENCE";
  else if (aligned >= 3 && against <= 1) state = "MODERATE CONVERGENCE";
  else if (against >= 2) state = "LOW";
  else state = "FRAGILE";

  const rankingDelta =
    state === "HIGH CONVERGENCE"
      ? 2
      : state === "MODERATE CONVERGENCE"
        ? 1
        : state === "LOW"
          ? -2
          : 0;

  return {
    state,
    score,
    aligned,
    against,
    unmeasured,
    dimensions,
    rankingDelta,
    summary: `${state} — ${aligned} of ${dimensions.length} dimensions aligned, ${against} against, ${unmeasured} unmeasured. Explanatory only; it can shade the ranking by at most ${rankingDelta >= 0 ? "+" : ""}${rankingDelta}.`,
  };
}
