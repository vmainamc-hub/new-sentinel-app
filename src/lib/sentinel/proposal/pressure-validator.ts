// ═══════════════════════════════════════════════════════════════════════════
// VALIDATOR — ENGINE B JUDGES ENGINE A
//
// Engine A (1,000 ticks) has already DECIDED the direction. The validator
// never re-decides it and never casts a "direction vote". It answers exactly
// one question:
//
//     Does current 15/30/60/120 pressure CONFIRM or CONTRADICT that
//     structural direction right now?
//
//   CONFIRM  — winning-side pressure is building, losing side is not.
//   NEUTRAL  — no meaningful pressure either way.
//   MIXED    — windows disagree, or both sides are building (transition).
//   REJECT   — pressure is materially building on the LOSING side of the
//              structural direction (and/or collapsing on the winning side).
//
// Green / 2nd Green / Red / 2nd Red never appear here. The only structural
// input is the direction label itself, which selects which digits count as
// winning and which as losing.
// ═══════════════════════════════════════════════════════════════════════════
import {
  computeGroupPressure,
  type PressureField,
  type PressureReading,
  type WindowAgreement,
} from "./pressure-windows";
import { directionGroups } from "./structural-direction";
import { clamp, type Side } from "./types";

export type PressureVerdict = "CONFIRM" | "NEUTRAL" | "MIXED" | "REJECT";

/** Consensus label for the whole pressure field relative to the direction. */
export type PressureConsensus =
  | "STRONGLY_SUPPORTING"
  | "SUPPORTING"
  | "NEUTRAL"
  | "OPPOSING"
  | "STRONGLY_OPPOSING"
  | "ROTATING"
  | "CONFLICTING";

/** pp of group movement below which nothing is happening. */
export const GROUP_FLAT_PP = 0.6;
/** pp of losing-group gain that is treated as a real hostile build. */
export const LOSING_BUILD_PP = 1.5;
/** pp of losing-group gain that is treated as a takeover attempt. */
export const LOSING_TAKEOVER_PP = 3.0;

export interface DigitPressureNote {
  digit: number;
  pressure: number;
  ratePp: number;
  agreement: WindowAgreement;
  movement: string;
  note: string;
}

export interface PressureValidation {
  /** The direction being validated. Never changed by this layer. */
  direction: Side;
  verdict: PressureVerdict;
  consensus: PressureConsensus;
  /** −100..+100 — signed support for `direction` from movement only. */
  support: number;
  /** 0..100 — how much of the pressure field was measurable. */
  confidence: number;
  /** Multiplier a caller may apply to a direction/opportunity score. */
  modifier: number;
  /** Aggregate pressure of the digits that WIN the direction. */
  winningSide: PressureReading;
  /** Aggregate pressure of the digits that LOSE the direction. */
  losingSide: PressureReading;
  /** Cross-window agreement of the deciding side. */
  agreement: WindowAgreement;
  /** True when both sides are building at once — a regime transition. */
  rotating: boolean;
  /** Losing digits gaining across every transition (steady, not a burst). */
  losingClimbers: DigitPressureNote[];
  /** Winning digits gaining across every transition. */
  winningClimbers: DigitPressureNote[];
  reasons: string[];
  summary: string;
}

const MODIFIER_BY_VERDICT: Record<PressureVerdict, number> = {
  CONFIRM: 1.12,
  NEUTRAL: 1,
  MIXED: 0.9,
  REJECT: 0.74,
};

function noteOf(r: PressureReading): DigitPressureNote {
  return {
    digit: r.digit as number,
    pressure: r.pressure,
    ratePp: Math.round(r.ratePp * 100) / 100,
    agreement: r.agreement,
    movement: r.movement,
    note: r.note,
  };
}

function consensusOf(
  support: number,
  rotating: boolean,
  agreement: WindowAgreement,
): PressureConsensus {
  if (rotating) return "ROTATING";
  if (agreement === "2/4" || agreement === "1/4" || agreement === "NONE") {
    if (Math.abs(support) < 25) return "CONFLICTING";
  }
  if (support >= 45) return "STRONGLY_SUPPORTING";
  if (support >= 15) return "SUPPORTING";
  if (support <= -45) return "STRONGLY_OPPOSING";
  if (support <= -15) return "OPPOSING";
  return "NEUTRAL";
}

/**
 * Validate a structural direction against the 15/30/60/120 pressure field.
 *
 * @param digits    tick stream, oldest → newest (only the last 120 are used)
 * @param direction Engine A's decision (call only when it is OVER or UNDER)
 * @param field     optional pre-built field, so callers can reuse one build
 */
export function validateDirectionWithPressure(
  digits: readonly number[],
  direction: Side,
  field?: PressureField,
): PressureValidation {
  const { supports, opposes } = directionGroups(direction);
  const winningSide = computeGroupPressure(digits, supports, `${direction} winning digits`);
  const losingSide = computeGroupPressure(digits, opposes, `${direction} losing digits`);
  const reasons: string[] = [];

  const measurable = winningSide.measurable && losingSide.measurable;
  const winRate = winningSide.ratePp;
  const loseRate = losingSide.ratePp;

  // ── Signed support: movement only. Winning-side gain minus losing-side gain,
  //    scaled by persistence and cross-window agreement so a single 15-tick
  //    burst cannot outvote three longer windows. ─────────────────────────
  const netPp = winRate - loseRate;
  const decidingSide = Math.abs(winRate) >= Math.abs(loseRate) ? winningSide : losingSide;
  const persistenceFactor = 0.55 + 0.45 * decidingSide.persistence;
  const agreementFactor =
    decidingSide.agreement === "4/4"
      ? 1
      : decidingSide.agreement === "3/4"
        ? 0.85
        : decidingSide.agreement === "2/4"
          ? 0.6
          : 0.35;

  let support = measurable
    ? Math.round(clamp(netPp * 9 * persistenceFactor * agreementFactor, -100, 100))
    : 0;

  // Acceleration on the losing side is more dangerous than the same
  // acceleration on the winning side is helpful.
  if (measurable) {
    if (losingSide.accelerationPp > 0.8)
      support -= Math.round(clamp(losingSide.accelerationPp * 4, 0, 18));
    if (winningSide.accelerationPp > 0.8)
      support += Math.round(clamp(winningSide.accelerationPp * 2.5, 0, 12));
    support = Math.round(clamp(support, -100, 100));
  }

  const rotating =
    measurable &&
    winRate > GROUP_FLAT_PP &&
    loseRate > GROUP_FLAT_PP &&
    Math.abs(netPp) < GROUP_FLAT_PP;

  const losingClimbers = field
    ? field.digits.filter((r) => opposes.includes(r.digit as number) && r.monotonicUp).map(noteOf)
    : [];
  const winningClimbers = field
    ? field.digits.filter((r) => supports.includes(r.digit as number) && r.monotonicUp).map(noteOf)
    : [];

  // ── Verdict ────────────────────────────────────────────────────────────
  let verdict: PressureVerdict = "NEUTRAL";
  if (!measurable) {
    reasons.push(`Pressure not measurable yet (${losingSide.slices[0]?.n ?? 0} of 120 ticks).`);
  } else if (rotating) {
    verdict = "MIXED";
    reasons.push(
      `Both sides are gaining at once (winning ${winRate.toFixed(2)}pp, losing ${loseRate.toFixed(2)}pp) — regime rotation, not confirmation.`,
    );
  } else if (loseRate >= LOSING_TAKEOVER_PP && losingSide.persistence >= 0.66) {
    verdict = "REJECT";
    reasons.push(
      `Losing side of ${direction} is taking over: ${loseRate.toFixed(2)}pp across 120→15 with ${losingSide.agreement} window agreement (${losingSide.movement}).`,
    );
  } else if (loseRate >= LOSING_BUILD_PP && loseRate > winRate) {
    verdict = "REJECT";
    reasons.push(
      `Pressure is building against ${direction}: losing side ${loseRate.toFixed(2)}pp vs winning ${winRate.toFixed(2)}pp (${losingSide.agreement}).`,
    );
  } else if (
    winRate >= LOSING_BUILD_PP &&
    winningSide.persistence >= 0.66 &&
    (winningSide.agreement === "4/4" || winningSide.agreement === "3/4")
  ) {
    verdict = "CONFIRM";
    reasons.push(
      `Pressure supports ${direction}: winning side ${winRate.toFixed(2)}pp, ${winningSide.agreement} windows agree, ${winningSide.movement}.`,
    );
  } else if (Math.abs(netPp) < GROUP_FLAT_PP) {
    verdict = "NEUTRAL";
    reasons.push(
      `Pressure is flat relative to ${direction} (net ${netPp.toFixed(2)}pp) — structure stands unaided.`,
    );
  } else if (netPp > 0) {
    verdict =
      winningSide.agreement === "1/4" || winningSide.agreement === "NONE" ? "MIXED" : "CONFIRM";
    reasons.push(
      `Net ${netPp.toFixed(2)}pp toward ${direction} with ${winningSide.agreement} window agreement.`,
    );
  } else {
    verdict = "MIXED";
    reasons.push(
      `Net ${netPp.toFixed(2)}pp against ${direction}, below the hostile-build threshold of ${LOSING_BUILD_PP}pp.`,
    );
  }

  if (verdict === "CONFIRM" && (winningSide.agreement === "2/4" || support < 15)) {
    verdict = "MIXED";
    reasons.push("Downgraded to MIXED — only a short-horizon burst supports the direction.");
  }
  if (losingClimbers.length >= 2 && verdict !== "REJECT") {
    verdict = verdict === "CONFIRM" ? "MIXED" : "REJECT";
    reasons.push(
      `${losingClimbers.length} losing digits (${losingClimbers.map((c) => c.digit).join(", ")}) are climbing across every window — the losing side is building before it becomes structurally visible.`,
    );
  }

  const agreement = decidingSide.agreement;
  const consensus = consensusOf(support, rotating, agreement);
  const confidence = measurable
    ? Math.round(
        clamp(
          clamp(((losingSide.slices[0]?.n ?? 0) / 120) * 70, 0, 70) +
            (agreement === "4/4" ? 30 : agreement === "3/4" ? 22 : agreement === "2/4" ? 12 : 5),
          0,
          100,
        ),
      )
    : 0;

  return {
    direction,
    verdict,
    consensus,
    support,
    confidence,
    modifier: MODIFIER_BY_VERDICT[verdict],
    winningSide,
    losingSide,
    agreement,
    rotating,
    losingClimbers,
    winningClimbers,
    reasons,
    summary:
      `PRESSURE ${verdict} on ${direction} — ${consensus}, support ${support >= 0 ? "+" : ""}${support}/100, ${agreement} window agreement. ${reasons[0] ?? ""}`.trim(),
  };
}
