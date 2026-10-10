// SENTINEL — WINNING-SIDE DIGIT MOMENTUM.
//
// The symmetric counterpart to LOSING_SIDE_PRESSURE. Every digit that can
// make a contract WIN is watched for rising momentum (reusing
// DigitProfile.momentum, which already existed but wasn't consumed this
// way). The whole winning side is aggregated into ONE named, bounded
// ranking modifier: WINNING_SIDE_MOMENTUM.
//
// Unlike the losing-side module, this one is reward-only by design: it can
// never penalize a contract, only confirm it when the winning digits are
// themselves gaining ground. "When winning digits are gaining, we go that
// direction" — there is no SUPPRESS-style verdict here, because a quiet or
// even declining winning side is not itself a danger signal (that's what
// LOSING_SIDE_PRESSURE is for).
import type { DigitIntel } from "@/lib/apex/digit-intel";

export type WinningSideMomentumState = "FLAT" | "BUILDING" | "SURGING";

export interface WinningSideContributor {
  digit: number;
  /** −100..100 raw momentum from DigitProfile.momentum. */
  momentum: number;
  rising: boolean;
}

export interface WinningSideMomentum {
  /** 0..100 aggregate winning-side momentum (positive contributions only). */
  index: number;
  state: WinningSideMomentumState;
  /** Bounded, reward-only ranking modifier: 1..MAX_MODIFIER. Never < 1. */
  modifier: number;
  /** Points added to a 0..100 opportunity score by this modifier. */
  bonusPoints: number;
  /** How many winning digits are simultaneously gaining. */
  risingCount: number;
  /** Winning digits ordered strongest-momentum-first. */
  contributors: WinningSideContributor[];
  reason: string;
}

/** Hard bound — reward-only, so the floor is always exactly 1. */
export const WINNING_SIDE_MAX_MODIFIER = 1.06;

/** Momentum threshold above which a digit counts as "rising" — matches the
 *  threshold digitIntelligence() itself uses for its `increasing` ranking. */
const RISING_MOMENTUM_THRESHOLD = 4;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function stateOf(index: number): WinningSideMomentumState {
  if (index >= 55) return "SURGING";
  if (index >= 25) return "BUILDING";
  return "FLAT";
}

/**
 * Aggregate the whole winning side into a single bounded, reward-only
 * modifier. Pure function of already-computed digit intelligence.
 */
export function winningSideMomentum(
  intel: DigitIntel | null,
  winners: number[],
): WinningSideMomentum {
  const profiles = intel?.profiles ?? (intel as any)?.digitIntel?.profiles ?? null;
  if (!profiles || winners.length === 0) {
    return {
      index: 0,
      state: "FLAT",
      modifier: 1,
      bonusPoints: 0,
      risingCount: 0,
      contributors: [],
      reason: "No winning-side telemetry available — modifier neutral.",
    };
  }

  const contributors: WinningSideContributor[] = winners
    .map((d) => profiles[d])
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      digit: p.digit,
      momentum: p.momentum,
      rising: p.momentum > RISING_MOMENTUM_THRESHOLD,
    }))
    .sort((a, b) => b.momentum - a.momentum);

  const risingCount = contributors.filter((c) => c.rising).length;

  // Only positive momentum can ever contribute — a winning side that is
  // losing momentum should not be rewarded, but it must not be penalized
  // here either (that would just be LOSING_SIDE_PRESSURE by another name).
  const positive = contributors.map((c) => Math.max(0, c.momentum));
  const best = positive[0] ?? 0;
  const mean = positive.length ? positive.reduce((a, b) => a + b, 0) / positive.length : 0;
  const breadth = (risingCount / Math.max(1, winners.length)) * 100;

  const index = clamp(best * 0.45 + mean * 0.35 + breadth * 0.2, 0, 100);

  const modifier = clamp(
    1 + (index / 100) * (WINNING_SIDE_MAX_MODIFIER - 1),
    1,
    WINNING_SIDE_MAX_MODIFIER,
  );

  const state = stateOf(index);
  const top = contributors
    .slice(0, 3)
    .map((c) => `${c.digit} (${c.momentum.toFixed(0)}${c.rising ? "↑" : ""})`);
  const reason =
    `WINNING_SIDE_MOMENTUM ${index.toFixed(0)}/100 (${state}) — ` +
    `${risingCount}/${winners.length} winning digits rising, ` +
    `best ${top.join(", ") || "none"}. Ranking modifier ×${modifier.toFixed(3)} ` +
    `(reward-only, capped ${WINNING_SIDE_MAX_MODIFIER}).`;

  return {
    index,
    state,
    modifier,
    bonusPoints: 0,
    risingCount,
    contributors,
    reason,
  };
}

/** Apply the bounded, reward-only modifier to an opportunity score. */
export function applyWinningSideMomentum(
  opportunity: number,
  momentum: WinningSideMomentum,
): { opportunity: number; momentum: WinningSideMomentum } {
  const next = clamp(opportunity * momentum.modifier, 0, 100);
  return {
    opportunity: next,
    momentum: { ...momentum, bonusPoints: Number((next - opportunity).toFixed(2)) },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 13 — DIRECTIONAL MOMENTUM ENGINE (authoritative).
//
// This file is the ONE authoritative momentum implementation in Sentinel.
// `winningSideMomentum()` above is PRESERVED byte-for-byte in behaviour: it
// remains the bounded, reward-only RANKING modifier (telemetry).
//
// What was missing (forensic finding): momentum only ever rewarded a currently
// strong winning digit. It was winning-side only, capped at ×1.06, had no
// losing-side momentum, no relative momentum, no reversal/takeover logic, and
// never reached danger.ts.
//
// `directionalMomentum()` below repairs that. It measures MOVEMENT of digit
// percentages over the three canonical subwindows that the shared
// PriceActionField already computes once per market:
//
//     percentage(T0 = window) → percentage(T1 = mid) → percentage(T2 = fast)
//        → velocity → acceleration → persistence → reversal / takeover
//
// It is a PURE function of the already-computed shared snapshot: no new tick
// scans, no per-cell recomputation, no second momentum engine.
//
// Momentum is SUPPORTING EVIDENCE ONLY. It can raise danger; it can never
// erase a structural veto and it can never lower danger (see danger.ts —
// every momentum contribution has non-negative points).
// ═══════════════════════════════════════════════════════════════════════════

import type { DigitPressureReading, PriceActionField } from "./price-action-psychology";

/** Momentum state of a single side (winning or losing), in isolation. */
export type SideMomentumState =
  | "STABLE"
  | "INCREASING"
  | "ACCELERATING"
  | "WEAKENING"
  | "REVERSING";

/** Combined directional momentum state for the contract as a whole. */
export type DirectionalMomentumState =
  | "STABLE"
  | "INCREASING"
  | "ACCELERATING"
  | "WEAKENING"
  | "REVERSING"
  | "LOSING_SIDE_RISING"
  | "TAKEOVER_RISK";

/**
 * Named momentum thresholds. All values are in percentage points (pp) of
 * group share measured across the shared 120/60/30 subwindows.
 *
 * DERIVATION — these are deliberately aligned with the pre-existing
 * per-digit movement thresholds already used by computePriceActionField()
 * (rate ≥ 0.8 = STRENGTHENING, ≥ 1.0 with accel ≥ 0.8 = ACCELERATING,
 * ≥ 1.5 with accel ≥ 1.0 = TAKING OVER, ≤ −0.8 = WEAKENING). Group-level
 * movement aggregates several digits, so the group thresholds are scaled up
 * by 1.5× to keep a single digit's noise from moving the whole side.
 * They are NOT tuned to increase or decrease signal frequency.
 */
export const MOMENTUM_THRESHOLDS = {
  /** Group velocity (pp) above which a side counts as INCREASING. */
  SIDE_INCREASING_PP: 1.2,
  /** Group velocity (pp) + acceleration above which a side is ACCELERATING. */
  SIDE_ACCELERATING_PP: 1.5,
  SIDE_ACCELERATION_PP: 1.2,
  /** Group velocity (pp) below which a side counts as WEAKENING. */
  SIDE_WEAKENING_PP: -1.2,
  /** Acceleration magnitude (pp) required to call a direction change a REVERSAL. */
  REVERSAL_ACCELERATION_PP: 1.8,
  /** Relative velocity advantage (pp) the losing side needs before it is "rising". */
  LOSING_RISING_PP: 1.2,
  /** Relative (losing − winning) velocity (pp) that makes takeover risk real. */
  TAKEOVER_RELATIVE_PP: 2.0,
  /** Severity (0..100) at or above which momentum is treated as takeover risk. */
  TAKEOVER_SEVERITY: 62,
} as const;

export interface SideMomentum {
  side: "WINNING" | "LOSING";
  digits: number[];
  /** Group share, %, over the full window (T0). */
  pctWindow: number;
  /** Group share, %, over the mid subwindow (T1). */
  pctMid: number;
  /** Group share, %, over the fast subwindow (T2). */
  pctFast: number;
  /** Movement: pctFast − pctWindow, pp. Positive = the side is gaining. */
  velocityPp: number;
  /** Acceleration: (fast − mid) − (mid − window), pp. */
  accelerationPp: number;
  /** 0..1 — how consistently the side moved in one direction across T0→T1→T2. */
  persistence: number;
  state: SideMomentumState;
  /** Strongest-moving members of the side, fastest first. */
  leaders: DigitPressureReading[];
  summary: string;
}

export interface RelativeMomentum {
  /** Winning velocity − losing velocity, pp. Negative = losing side is faster. */
  velocityDeltaPp: number;
  /** Winning acceleration − losing acceleration, pp. */
  accelerationDeltaPp: number;
  /** Winning group share − losing group share at T0, pp. */
  gapPp: number;
  /** Winning group share − losing group share at T2, pp. */
  gapFastPp: number;
  /** gapFastPp − gapPp. Negative = the gap is closing. */
  gapVelocityPp: number;
  /** True when the losing side is closing the gap. */
  closing: boolean;
  summary: string;
}

export interface DirectionalMomentum {
  measurable: boolean;
  winning: SideMomentum;
  losing: SideMomentum;
  relative: RelativeMomentum;
  state: DirectionalMomentumState;
  /** 0..100 ADVERSE severity. 0 = momentum is favourable or absent. */
  severity: number;
  /** The winning side changed direction inside the window. */
  reversal: boolean;
  /** The losing side is materially overtaking the winning side. */
  takeoverRisk: boolean;
  evidence: string[];
  summary: string;
}

function sideMomentum(
  field: PriceActionField,
  digits: number[],
  side: "WINNING" | "LOSING",
): SideMomentum {
  const readings = digits.map((d) => field.digits[d]).filter(Boolean) as DigitPressureReading[];
  const sum = (pick: (r: DigitPressureReading) => number) =>
    readings.reduce((a, r) => a + pick(r), 0);

  const pctWindow = sum((r) => r.pct);
  const pctMid = sum((r) => r.pctMid);
  const pctFast = sum((r) => r.pctFast);
  const velocityPp = pctFast - pctWindow;
  const accelerationPp = pctFast - pctMid - (pctMid - pctWindow);

  const steps = [pctMid - pctWindow, pctFast - pctMid];
  const up = steps.filter((s) => s > 0.2).length;
  const down = steps.filter((s) => s < -0.2).length;
  const persistence = field.measurable ? Math.max(up, down) / steps.length : 0;

  const T = MOMENTUM_THRESHOLDS;
  let state: SideMomentumState = "STABLE";
  if (!field.measurable) {
    state = "STABLE";
  } else if (
    Math.sign(steps[0]) !== 0 &&
    Math.sign(steps[1]) === -Math.sign(steps[0]) &&
    Math.abs(accelerationPp) >= T.REVERSAL_ACCELERATION_PP
  ) {
    state = "REVERSING";
  } else if (velocityPp >= T.SIDE_ACCELERATING_PP && accelerationPp >= T.SIDE_ACCELERATION_PP) {
    state = "ACCELERATING";
  } else if (velocityPp >= T.SIDE_INCREASING_PP) {
    state = "INCREASING";
  } else if (velocityPp <= T.SIDE_WEAKENING_PP) {
    state = "WEAKENING";
  }

  const leaders = [...readings].sort((a, b) => b.rateOfChangePp - a.rateOfChangePp);

  return {
    side,
    digits,
    pctWindow,
    pctMid,
    pctFast,
    velocityPp,
    accelerationPp,
    persistence,
    state,
    leaders,
    summary: field.measurable
      ? `${side} side ${digits.join("/") || "—"} — ${pctWindow.toFixed(1)}% (${field.window}t) → ${pctMid.toFixed(1)}% (${field.config.mid}t) → ${pctFast.toFixed(1)}% (${field.config.fast}t): velocity ${velocityPp >= 0 ? "+" : ""}${velocityPp.toFixed(2)}pp, acceleration ${accelerationPp >= 0 ? "+" : ""}${accelerationPp.toFixed(2)}pp, persistence ${(persistence * 100).toFixed(0)}% — ${state}.`
      : `${side} side momentum not measurable (${field.n}/${field.window} ticks).`,
  };
}

/**
 * DIRECTIONAL MOMENTUM — winning-side, losing-side, relative, reversal and
 * takeover-risk movement of digit percentages over time. Pure.
 *
 * @param field    the shared per-market PriceActionField (already computed once)
 * @param winners  digits that make this contract WIN
 * @param losers   digits that make this contract LOSE (defaults to the complement)
 */
export function directionalMomentum(
  field: PriceActionField,
  winners: number[],
  losers?: number[],
): DirectionalMomentum {
  const all = Array.from({ length: 10 }, (_, d) => d);
  const losingDigits = losers ?? all.filter((d) => !winners.includes(d));

  const winning = sideMomentum(field, winners, "WINNING");
  const losing = sideMomentum(field, losingDigits, "LOSING");

  const gapPp = winning.pctWindow - losing.pctWindow;
  const gapFastPp = winning.pctFast - losing.pctFast;
  const relative: RelativeMomentum = {
    velocityDeltaPp: winning.velocityPp - losing.velocityPp,
    accelerationDeltaPp: winning.accelerationPp - losing.accelerationPp,
    gapPp,
    gapFastPp,
    gapVelocityPp: gapFastPp - gapPp,
    closing: gapFastPp < gapPp - 0.4,
    summary: "",
  };
  relative.summary = field.measurable
    ? `RELATIVE MOMENTUM — winning ${winning.velocityPp >= 0 ? "+" : ""}${winning.velocityPp.toFixed(2)}pp vs losing ${losing.velocityPp >= 0 ? "+" : ""}${losing.velocityPp.toFixed(2)}pp (Δ ${relative.velocityDeltaPp >= 0 ? "+" : ""}${relative.velocityDeltaPp.toFixed(2)}pp); gap ${gapPp.toFixed(1)}pp → ${gapFastPp.toFixed(1)}pp (${relative.gapVelocityPp >= 0 ? "+" : ""}${relative.gapVelocityPp.toFixed(2)}pp, ${relative.closing ? "CLOSING" : "holding"}).`
    : "Relative momentum not measurable.";

  const T = MOMENTUM_THRESHOLDS;
  const evidence: string[] = [];
  let severity = 0;

  if (field.measurable) {
    // 1. Winning side losing percentage support.
    if (winning.state === "WEAKENING" || winning.state === "REVERSING") {
      severity += clamp(Math.abs(winning.velocityPp) * 5, 0, 22);
      evidence.push(
        `Winning side is ${winning.state === "REVERSING" ? "reversing" : "losing"} ${Math.abs(winning.velocityPp).toFixed(2)}pp of share across ${field.window}t → ${field.config.fast}t.`,
      );
    }
    // 2. Losing side gaining percentage.
    if (losing.state === "INCREASING" || losing.state === "ACCELERATING") {
      severity += clamp(losing.velocityPp * 6, 0, 26);
      evidence.push(
        `Losing side is gaining ${losing.velocityPp.toFixed(2)}pp of share (${losing.state}).`,
      );
    }
    // 3. Losing side accelerating specifically.
    if (losing.accelerationPp >= T.SIDE_ACCELERATION_PP) {
      severity += clamp(losing.accelerationPp * 5, 0, 18);
      evidence.push(`Losing side is accelerating (+${losing.accelerationPp.toFixed(2)}pp).`);
    }
    // 4. RELATIVE momentum — the losing side outrunning the winning side even
    //    while the winning side is still positive. This is the case the old
    //    reward-only engine could not see at all.
    if (relative.velocityDeltaPp <= -T.LOSING_RISING_PP) {
      severity += clamp(Math.abs(relative.velocityDeltaPp) * 6, 0, 24);
      evidence.push(
        `Losing side is moving ${Math.abs(relative.velocityDeltaPp).toFixed(2)}pp/window faster than the winning side — the gap is closing even though the winning side is ${winning.state.toLowerCase()}.`,
      );
    }
    // 5. Gap actually narrowing.
    if (relative.closing) {
      severity += clamp(Math.abs(relative.gapVelocityPp) * 3, 0, 14);
      evidence.push(
        `Winning/losing share gap narrowed from ${gapPp.toFixed(1)}pp to ${gapFastPp.toFixed(1)}pp.`,
      );
    }
    // 6. Persistence — a steady, repeated move is worse than a single burst.
    if (losing.persistence >= 1 && losing.velocityPp > 0) {
      severity += 8;
      evidence.push(
        `Losing side gained across every subwindow (${field.window}/${field.config.mid}/${field.config.fast}) — sustained, not a burst.`,
      );
    }
  }

  severity = Math.round(clamp(severity, 0, 100));

  const reversal = field.measurable && winning.state === "REVERSING";
  const takeoverRisk =
    field.measurable &&
    (severity >= T.TAKEOVER_SEVERITY ||
      (relative.velocityDeltaPp <= -T.TAKEOVER_RELATIVE_PP && relative.closing));

  let state: DirectionalMomentumState = "STABLE";
  if (!field.measurable) {
    state = "STABLE";
  } else if (takeoverRisk) {
    state = "TAKEOVER_RISK";
  } else if (reversal) {
    state = "REVERSING";
  } else if (
    relative.velocityDeltaPp <= -T.LOSING_RISING_PP ||
    losing.state === "ACCELERATING" ||
    (losing.state === "INCREASING" && relative.closing)
  ) {
    state = "LOSING_SIDE_RISING";
  } else if (winning.state === "ACCELERATING") {
    state = "ACCELERATING";
  } else if (winning.state === "INCREASING") {
    state = "INCREASING";
  } else if (winning.state === "WEAKENING") {
    state = "WEAKENING";
  }

  return {
    measurable: field.measurable,
    winning,
    losing,
    relative,
    state,
    severity,
    reversal,
    takeoverRisk,
    evidence,
    summary: field.measurable
      ? `DIRECTIONAL MOMENTUM — ${state} (adverse severity ${severity}/100). ${winning.summary} ${losing.summary} ${relative.summary}`
      : `Directional momentum not measurable (${field.n}/${field.window} ticks) — no momentum influence.`,
  };
}
