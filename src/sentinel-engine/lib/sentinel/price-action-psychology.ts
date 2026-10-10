// ═══════════════════════════════════════════════════════════════════════════
// SENTINEL — 120-TICK PRICE ACTION PSYCHOLOGY (LOWER-TIMEFRAME PRESSURE).
//
// NON-NEGOTIABLE SEPARATION OF LAYERS:
//
//   1,000 TICKS = STRUCTURAL DIGIT PSYCHOLOGY — what the market HAS BUILT.
//     (src/lib/sentinel/digit-psychology.ts, fed by the canonical distribution)
//
//     120 TICKS = CURRENT PRICE ACTION / PRESSURE — what is HAPPENING NOW.
//     (this module)
//
// PRESSURE IS CHANGE, NOT LEVEL. A 1,000-tick percentage is accumulated state;
// it is never treated as pressure here. Everything below is measured as
// movement over the lower window and its subwindows (120 → 60 → 30), so that a
// losing digit at only 7% that is climbing 5.0 → 5.6 → 6.2 → 6.9 → 7.5 is
// recognised as a TAKEOVER THREAT long before it ever becomes GREEN.
//
// This engine SUPPORTS the structural layer. It never redefines GREEN / RED.
// The two layers are allowed — and expected — to disagree; that disagreement is
// itself the signal (TRANSITION / CONFLICT / TAKEOVER).
//
// Every output is bounded, attributed evidence handed to the EXISTING ranking,
// entry and explanation layers.
// ═══════════════════════════════════════════════════════════════════════════
import type { CanonicalDigitState } from "./digit-psychology";
import type { ContractShape } from "./digit-psychology";

/** Default lower-timeframe window. Configurable per call. */
export const PRICE_ACTION_WINDOW = 120;
/** Mid subwindow — "the last minute or so". */
export const PRICE_ACTION_MID = 60;
/** Fast subwindow — "right now". */
export const PRICE_ACTION_FAST = 30;
/** Minimum ticks before the lower timeframe is considered measurable. */
export const PRICE_ACTION_MIN_TICKS = 60;
/** Fair share of any one digit, in percent. */
const FAIR = 10;

export interface PriceActionConfig {
  window: number;
  mid: number;
  fast: number;
}

export const DEFAULT_PRICE_ACTION_CONFIG: PriceActionConfig = {
  window: PRICE_ACTION_WINDOW,
  mid: PRICE_ACTION_MID,
  fast: PRICE_ACTION_FAST,
};

export type DigitMovement =
  | "STRENGTHENING"
  | "WEAKENING"
  | "ACCELERATING"
  | "DECELERATING"
  | "STABLE"
  | "REVERSING"
  | "TAKING OVER"
  | "LOSING GROUND";

export interface DigitPressureReading {
  digit: number;
  /** Share over the full lower window, %. */
  pct: number;
  /** Share over the mid subwindow, %. */
  pctMid: number;
  /** Share over the fast subwindow, %. */
  pctFast: number;
  /** Structural (1,000-tick) share, %, for reference only — never pressure. */
  structuralPct: number;
  /** Lower-window share − structural share, in pp. */
  vsStructuralPp: number;
  /** Rate of change: fast share − window share, pp (movement). */
  rateOfChangePp: number;
  /** Acceleration: (fast − mid) − (mid − window), pp. */
  accelerationPp: number;
  /** Prints inside the fast subwindow. */
  recentActivity: number;
  /** 0..1 — how consistently the digit gained across the three subwindows. */
  persistence: number;
  /** True when the digit is taking share from the rest of the board. */
  gainingShare: boolean;
  /** Ticks since this digit last printed (Infinity when never in the window). */
  sinceSeen: number;
  movement: DigitMovement;
  /** −100..+100 — signed lower-timeframe pressure. Positive = building. */
  pressure: number;
  note: string;
}

export interface PriceActionField {
  /** Window actually configured. */
  window: number;
  config: PriceActionConfig;
  /** Ticks available in the lower window. */
  n: number;
  /** True when the window holds enough ticks to be trusted. */
  measurable: boolean;
  /** Index === digit. */
  digits: DigitPressureReading[];
  /** Digits with the strongest positive pressure, strongest first. */
  strongestIncreasing: number[];
  /** Digits with the strongest negative pressure, strongest first. */
  strongestDecreasing: number[];
  summary: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function shareOf(seg: number[], d: number): number {
  if (!seg.length) return 0;
  let c = 0;
  for (const x of seg) if (x === d) c++;
  return (c / seg.length) * 100;
}

/**
 * Build the lower-timeframe pressure field. Pure.
 *
 * @param digits           canonical digit stream, oldest → newest
 * @param structuralPct    the canonical 1,000-tick percentages (reference only)
 */
export function computePriceActionField(
  digits: number[],
  structuralPct?: number[] | null,
  config: Partial<PriceActionConfig> = {},
): PriceActionField {
  const cfg: PriceActionConfig = { ...DEFAULT_PRICE_ACTION_CONFIG, ...config };
  const window = digits.slice(-cfg.window);
  const mid = digits.slice(-cfg.mid);
  const fast = digits.slice(-cfg.fast);
  const n = window.length;
  const measurable = n >= Math.min(PRICE_ACTION_MIN_TICKS, cfg.window);

  const readings: DigitPressureReading[] = [];
  for (let d = 0; d < 10; d++) {
    const pct = shareOf(window, d);
    const pctMid = shareOf(mid, d);
    const pctFast = shareOf(fast, d);
    const structural = structuralPct?.[d] ?? FAIR;
    const rate = pctFast - pct;
    const accel = pctFast - pctMid - (pctMid - pct);
    let recentActivity = 0;
    for (const x of fast) if (x === d) recentActivity++;
    let sinceSeen = Number.POSITIVE_INFINITY;
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i] === d) {
        sinceSeen = window.length - 1 - i;
        break;
      }
    }

    // Persistence: how many of the monotone steps window → mid → fast gained.
    const steps = [pctMid - pct, pctFast - pctMid];
    const up = steps.filter((s) => s > 0.2).length;
    const down = steps.filter((s) => s < -0.2).length;
    const persistence = measurable ? Math.max(up, down) / steps.length : 0;

    // PRESSURE — a change measure, deliberately dominated by movement.
    // Rate of change carries the weight; acceleration and persistence refine
    // it; the structural gap contributes only a small contextual nudge.
    const pressureRaw = measurable
      ? rate * 7 + accel * 4 + (up - down) * 6 + clamp(pct - structural, -8, 8) * 1.2
      : 0;
    const pressure = Math.round(clamp(pressureRaw, -100, 100));

    let movement: DigitMovement = "STABLE";
    if (!measurable) {
      movement = "STABLE";
    } else if (rate >= 1.5 && accel >= 1.0 && pctFast > structural) {
      movement = "TAKING OVER";
    } else if (rate >= 1.0 && accel >= 0.8) {
      movement = "ACCELERATING";
    } else if (rate >= 0.8) {
      movement = "STRENGTHENING";
    } else if (rate <= -1.5 && accel <= -1.0) {
      movement = "LOSING GROUND";
    } else if (rate <= -0.8) {
      movement = "WEAKENING";
    } else if (
      Math.sign(pctMid - pct) !== 0 &&
      Math.sign(pctFast - pctMid) === -Math.sign(pctMid - pct) &&
      Math.abs(accel) >= 1.2
    ) {
      movement = "REVERSING";
    } else if (Math.abs(rate) >= 0.4 && Math.abs(accel) >= 0.8 && accel * rate < 0) {
      movement = "DECELERATING";
    }

    readings.push({
      digit: d,
      pct,
      pctMid,
      pctFast,
      structuralPct: structural,
      vsStructuralPp: pct - structural,
      rateOfChangePp: rate,
      accelerationPp: accel,
      recentActivity,
      persistence,
      gainingShare: rate > 0.2,
      sinceSeen,
      movement,
      pressure,
      note: measurable
        ? `${cfg.window}t ${pct.toFixed(1)}% → ${cfg.mid}t ${pctMid.toFixed(1)}% → ${cfg.fast}t ${pctFast.toFixed(1)}% (Δ ${rate >= 0 ? "+" : ""}${rate.toFixed(2)}pp, accel ${accel >= 0 ? "+" : ""}${accel.toFixed(2)}pp, structural ${structural.toFixed(1)}%) — ${movement}`
        : `Lower timeframe not measurable yet (${n}/${cfg.window} ticks).`,
    });
  }

  const byPressure = [...readings].sort((a, b) => b.pressure - a.pressure);
  const strongestIncreasing = byPressure
    .filter((r) => r.pressure > 6)
    .slice(0, 3)
    .map((r) => r.digit);
  const strongestDecreasing = [...byPressure]
    .reverse()
    .filter((r) => r.pressure < -6)
    .slice(0, 3)
    .map((r) => r.digit);

  const summary = measurable
    ? `${cfg.window}-TICK PRICE ACTION — increasing ${strongestIncreasing.join(", ") || "—"} · decreasing ${strongestDecreasing.join(", ") || "—"} (${n} ticks, subwindows ${cfg.window}/${cfg.mid}/${cfg.fast}).`
    : `${cfg.window}-tick price action unavailable — ${n} tick(s).`;

  return {
    window: cfg.window,
    config: cfg,
    n,
    measurable,
    digits: readings,
    strongestIncreasing,
    strongestDecreasing,
    summary,
  };
}

// ──────────────────────────────────────────────────────────────────────
// SIDE PRESSURE + LOSING-SIDE TAKEOVER
// ──────────────────────────────────────────────────────────────────────

export type SideDirection = "INCREASING" | "DECREASING" | "STABLE";

export interface SidePressure {
  side: "WINNING" | "LOSING";
  digits: number[];
  /** Group share over the lower window, %. */
  sharePct: number;
  /** Group share over the fast subwindow, %. */
  sharePctFast: number;
  /** Group rate of change, pp. */
  rateOfChangePp: number;
  /** Group acceleration, pp. */
  accelerationPp: number;
  direction: SideDirection;
  /** −100..+100 aggregate pressure of the side. */
  pressure: number;
  /** Individual readings, strongest pressure first. */
  leaders: DigitPressureReading[];
  summary: string;
}

export type TakeoverState =
  "NO TAKEOVER" | "WATCH" | "EMERGING TAKEOVER" | "CONFIRMED TAKEOVER" | "REVERSING" | "EXHAUSTED";

export interface TakeoverAssessment {
  state: TakeoverState;
  /** The single most dangerous losing digit, when there is one. */
  digit: number | null;
  /** 0..100 severity of the takeover. */
  severity: number;
  evidence: string[];
  summary: string;
}

export type PriceActionAlignment =
  "CONFIRMING" | "NEUTRAL" | "TRANSITIONING" | "CONTRADICTING" | "TAKEOVER";

export interface ContractPriceAction {
  contract: string;
  side: "OVER" | "UNDER";
  window: number;
  measurable: boolean;
  winners: number[];
  losers: number[];
  /** Parity contract psychology: UNDER prefers ODD, OVER prefers EVEN. */
  preferredParity: "ODD" | "EVEN";
  winningSide: SidePressure;
  losingSide: SidePressure;
  /** Parity-side pressure (the operator's contract psychology layer). */
  parityWinning: SidePressure;
  parityLosing: SidePressure;
  takeover: TakeoverAssessment;
  /** PHASE 14 — quantified winning-vs-losing percentage contest. */
  competition: PercentageCompetition;
  alignment: PriceActionAlignment;
  /** Preserved special risk: UNDER → digit 8, OVER → digit 1. */
  specialRisk: {
    digit: number;
    reading: DigitPressureReading | null;
    elevated: boolean;
    note: string;
  };
  /** RED / 2ND RED behaviour on the losing side. */
  redControl: { redRising: boolean; secondRedRising: boolean; note: string };
  /** GREEN sitting on the losing side. */
  greenLosingSide: { present: boolean; strengthening: boolean; note: string };
  /** Bounded ranking contribution, in score points (−9 … +4). */
  rankingDelta: number;
  /** True when the lower timeframe is hostile enough to veto the contract. */
  veto: boolean;
  vetoReason: string | null;
  reasons: string[];
  cautions: string[];
  summary: string;
}

function sidePressure(
  field: PriceActionField,
  digits: number[],
  side: "WINNING" | "LOSING",
): SidePressure {
  const readings = digits.map((d) => field.digits[d]).filter(Boolean);
  const sum = (pick: (r: DigitPressureReading) => number) =>
    readings.reduce((a, r) => a + pick(r), 0);
  const sharePct = sum((r) => r.pct);
  const sharePctFast = sum((r) => r.pctFast);
  const rate = sharePctFast - sharePct;
  const accel = sum((r) => r.accelerationPp);
  const pressure = Math.round(
    clamp(readings.length ? sum((r) => r.pressure) / readings.length + rate * 1.5 : 0, -100, 100),
  );
  const direction: SideDirection =
    !field.measurable || Math.abs(rate) < 1.5 ? "STABLE" : rate > 0 ? "INCREASING" : "DECREASING";
  const leaders = [...readings].sort((a, b) => b.pressure - a.pressure);
  return {
    side,
    digits,
    sharePct,
    sharePctFast,
    rateOfChangePp: rate,
    accelerationPp: accel,
    direction,
    pressure,
    leaders,
    summary: `${side} side ${digits.join("/") || "—"} — ${sharePct.toFixed(1)}% over ${field.window}t → ${sharePctFast.toFixed(1)}% over ${field.config.fast}t (${rate >= 0 ? "+" : ""}${rate.toFixed(2)}pp, ${direction}, pressure ${pressure}).`,
  };
}

/**
 * Losing-side takeover detection. Evidence-driven: rising recent share,
 * acceleration, persistence across subwindows, sustained activity, and
 * displacement of the winning side. Never fixed digit assumptions.
 */
export function assessLosingSideTakeover(
  field: PriceActionField,
  winning: SidePressure,
  losing: SidePressure,
  structural?: CanonicalDigitState | null,
): TakeoverAssessment {
  if (!field.measurable) {
    return {
      state: "NO TAKEOVER",
      digit: null,
      severity: 0,
      evidence: [],
      summary: `Lower timeframe not measurable (${field.n}/${field.window} ticks) — takeover undetermined.`,
    };
  }

  const worst = losing.leaders[0] ?? null;
  const evidence: string[] = [];
  let severity = 0;

  if (losing.direction === "INCREASING") {
    severity += clamp(losing.rateOfChangePp * 2.6, 0, 26);
    evidence.push(
      `Losing side is gaining ${losing.rateOfChangePp.toFixed(2)}pp of share over the last ${field.config.fast} ticks.`,
    );
  }
  if (worst && worst.rateOfChangePp > 0.8) {
    severity += clamp(worst.rateOfChangePp * 3.2, 0, 24);
    evidence.push(
      `Losing digit ${worst.digit} rising ${worst.rateOfChangePp.toFixed(2)}pp (${worst.pct.toFixed(1)}% → ${worst.pctFast.toFixed(1)}%).`,
    );
  }
  if (worst && worst.accelerationPp > 0.8) {
    severity += clamp(worst.accelerationPp * 3, 0, 18);
    evidence.push(
      `Losing digit ${worst.digit} is accelerating (+${worst.accelerationPp.toFixed(2)}pp).`,
    );
  }
  if (worst && worst.persistence >= 1) {
    severity += 10;
    evidence.push(
      `Losing digit ${worst.digit} gained across every subwindow (${field.window}/${field.config.mid}/${field.config.fast}) — a steady increase, not a burst.`,
    );
  } else if (worst && worst.persistence > 0 && worst.rateOfChangePp > 1.5) {
    severity += 4;
    evidence.push(
      `Losing digit ${worst.digit} spiked in the fast subwindow — burst rather than sustained.`,
    );
  }
  if (winning.direction === "DECREASING") {
    severity += clamp(Math.abs(winning.rateOfChangePp) * 2.2, 0, 20);
    evidence.push(
      `Winning side is losing ${Math.abs(winning.rateOfChangePp).toFixed(2)}pp — the losing side is displacing it.`,
    );
  }
  // Movement toward GREEN / 2ND GREEN is itself information — we do not wait
  // for the role to actually change.
  if (structural && worst) {
    const struct = structural.pct[worst.digit] ?? 0;
    const greenPct = structural.green !== null ? structural.pct[structural.green] : null;
    const secondGreenPct =
      structural.secondGreen !== null ? structural.pct[structural.secondGreen] : null;
    if (greenPct !== null && worst.pctFast >= greenPct) {
      severity += 12;
      evidence.push(
        `Losing digit ${worst.digit} already leads the fast window (${worst.pctFast.toFixed(1)}%) despite only ${struct.toFixed(1)}% structurally — it is moving toward GREEN.`,
      );
    } else if (secondGreenPct !== null && worst.pctFast >= secondGreenPct) {
      severity += 7;
      evidence.push(
        `Losing digit ${worst.digit} has climbed past the structural 2ND GREEN share in the fast window.`,
      );
    }
  }
  if (worst && worst.recentActivity >= Math.max(4, Math.round(field.config.fast * 0.18))) {
    severity += 6;
    evidence.push(
      `Losing digit ${worst.digit} printed ${worst.recentActivity}× in the last ${field.config.fast} ticks — sustained activity.`,
    );
  }

  severity = Math.round(clamp(severity, 0, 100));

  let state: TakeoverState = "NO TAKEOVER";
  if (worst && worst.movement === "REVERSING" && severity < 55) {
    state = "REVERSING";
  } else if (
    worst &&
    (worst.movement === "LOSING GROUND" || worst.movement === "WEAKENING") &&
    worst.pct > worst.structuralPct + 1 &&
    severity < 40
  ) {
    state = "EXHAUSTED";
  } else if (severity >= 62) {
    state = "CONFIRMED TAKEOVER";
  } else if (severity >= 38) {
    state = "EMERGING TAKEOVER";
  } else if (severity >= 18) {
    state = "WATCH";
  }

  return {
    state,
    digit: worst?.digit ?? null,
    severity,
    evidence,
    summary: `LOSING-SIDE PRESSURE: ${state}${worst ? ` (worst digit ${worst.digit})` : ""} — severity ${severity}/100. ${evidence[0] ?? "No losing-side pressure evidence."}`,
  };
}

// ──────────────────────────────────────────────────────────────────────
// PHASE 14 — QUANTIFIED PERCENTAGE COMPETITION.
//
// Forensic finding: competition/takeover existed here but reached danger only
// through two booleans (`veto` and `redControl`), so the DANGER system could
// not understand HOW SERIOUS the contest was.
//
// This section quantifies the contest for a percentage region between the
// leading WINNING digit and the leading LOSING digit. It preserves the
// existing takeover mathematics above (assessLosingSideTakeover is unchanged)
// and adds the missing severity dimension on top of it.
//
// Percentage gap alone is NOT used. Momentum alone is NOT used. The state is
// decided by their INTERACTION: absolute gap, gap velocity, relative movement,
// direction, persistence, pressure and structural role.
// ──────────────────────────────────────────────────────────────────────

export type CompetitionState = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

/**
 * Named competition thresholds, in percentage points of single-digit share.
 *
 * DERIVATION — a digit's fair share is 10%. The existing engine already
 * treats ±0.8pp of single-digit movement as material (STRENGTHENING /
 * WEAKENING) and ±1.5pp as a takeover-grade move. The gap bands below are
 * anchored to that same scale: 1.5pp ≈ one takeover-grade move away from
 * being overtaken, 3.0pp ≈ two such moves, 5.0pp ≈ clear dominance.
 * They exist to CLASSIFY an already-measured contest, never to change how
 * often a signal is produced.
 */
export const COMPETITION_THRESHOLDS = {
  /** Gap (pp) at or below which the structures are materially close. */
  GAP_CRITICAL_PP: 1.5,
  GAP_HIGH_PP: 3.0,
  GAP_MODERATE_PP: 5.0,
  /** Gap velocity (pp) at or below which the gap counts as narrowing. */
  NARROWING_PP: -0.5,
  /** Losing-digit velocity (pp) that counts as rapid gain. */
  RAPID_GAIN_PP: 0.8,
  /** Losing-digit acceleration (pp) that counts as accelerating. */
  ACCELERATING_PP: 0.8,
} as const;

export interface PercentageCompetition {
  measurable: boolean;
  /** Leading winning digit for the contested percentage region. */
  winningDigit: number | null;
  /** Leading losing digit contesting it. */
  losingDigit: number | null;
  /** Leading winning digit share over the window, %. */
  winningPct: number;
  /** Leading losing digit share over the window, %. */
  losingPct: number;
  /** winningPct − losingPct at T0, pp. */
  gapPp: number;
  /** Same gap measured on the fast subwindow (T2), pp. */
  gapFastPp: number;
  /** gapFastPp − gapPp. Negative = the losing digit is closing in. */
  gapVelocityPp: number;
  /** Losing digit velocity − winning digit velocity, pp. */
  relativeVelocityPp: number;
  /** True when the losing digit is at or above the winning digit on T2. */
  overtaken: boolean;
  state: CompetitionState;
  /** 0..100 severity of the contest. */
  severity: number;
  evidence: string[];
  summary: string;
}

/**
 * Quantify the contest between the strongest winning digit and the strongest
 * losing digit for the same percentage region. Pure function of the shared
 * price-action field plus (optionally) the canonical structural state.
 */
export function assessPercentageCompetition(
  field: PriceActionField,
  winners: number[],
  losers: number[],
  structural?: CanonicalDigitState | null,
): PercentageCompetition {
  const pick = (digits: number[]) =>
    digits
      .map((d) => field.digits[d])
      .filter(Boolean)
      .sort((a, b) => b.pct - a.pct)[0] ?? null;

  const win = pick(winners);
  const lose = pick(losers);

  if (!field.measurable || !win || !lose) {
    return {
      measurable: false,
      winningDigit: win?.digit ?? null,
      losingDigit: lose?.digit ?? null,
      winningPct: win?.pct ?? 0,
      losingPct: lose?.pct ?? 0,
      gapPp: 0,
      gapFastPp: 0,
      gapVelocityPp: 0,
      relativeVelocityPp: 0,
      overtaken: false,
      state: "LOW",
      severity: 0,
      evidence: [],
      summary: `Percentage competition not measurable (${field.n}/${field.window} ticks).`,
    };
  }

  const gapPp = win.pct - lose.pct;
  const gapFastPp = win.pctFast - lose.pctFast;
  const gapVelocityPp = gapFastPp - gapPp;
  const relativeVelocityPp = lose.rateOfChangePp - win.rateOfChangePp;
  const overtaken = lose.pctFast >= win.pctFast;
  const C = COMPETITION_THRESHOLDS;

  const evidence: string[] = [];
  let severity = 0;

  // 1. Absolute gap — proximity of the two structures.
  if (gapPp <= C.GAP_CRITICAL_PP) {
    severity += 30;
    evidence.push(
      `Winning digit ${win.digit} (${win.pct.toFixed(1)}%) and losing digit ${lose.digit} (${lose.pct.toFixed(1)}%) are only ${gapPp.toFixed(2)}pp apart — materially contesting the same percentage region.`,
    );
  } else if (gapPp <= C.GAP_HIGH_PP) {
    severity += 18;
    evidence.push(
      `Losing digit ${lose.digit} is approaching winning digit ${win.digit} (${gapPp.toFixed(2)}pp apart).`,
    );
  } else if (gapPp <= C.GAP_MODERATE_PP) {
    severity += 8;
    evidence.push(
      `Losing digit ${lose.digit} sits ${gapPp.toFixed(2)}pp below winning digit ${win.digit}.`,
    );
  } else {
    evidence.push(
      `Winning digit ${win.digit} clearly dominates losing digit ${lose.digit} (${gapPp.toFixed(2)}pp).`,
    );
  }

  // 2. Gap velocity — is the contest tightening RIGHT NOW?
  if (gapVelocityPp <= C.NARROWING_PP) {
    severity += clamp(Math.abs(gapVelocityPp) * 6, 0, 22);
    evidence.push(
      `The gap is narrowing: ${gapPp.toFixed(2)}pp over ${field.window}t → ${gapFastPp.toFixed(2)}pp over ${field.config.fast}t (${gapVelocityPp.toFixed(2)}pp).`,
    );
  }

  // 3. Relative movement — the losing digit outrunning the winning digit.
  if (relativeVelocityPp >= C.RAPID_GAIN_PP) {
    severity += clamp(relativeVelocityPp * 7, 0, 24);
    evidence.push(
      `Losing digit ${lose.digit} is gaining ${relativeVelocityPp.toFixed(2)}pp/window faster than winning digit ${win.digit}.`,
    );
  }

  // 4. Direction + persistence of the challenger (not a single burst).
  if (lose.rateOfChangePp >= C.RAPID_GAIN_PP && lose.persistence >= 1) {
    severity += 12;
    evidence.push(
      `Losing digit ${lose.digit} gained across every subwindow — a sustained challenge, not a burst.`,
    );
  }
  if (lose.accelerationPp >= C.ACCELERATING_PP) {
    severity += clamp(lose.accelerationPp * 5, 0, 16);
    evidence.push(`Losing digit ${lose.digit} is accelerating (+${lose.accelerationPp.toFixed(2)}pp).`);
  }

  // 5. Pressure and structural role.
  if (lose.pressure >= 25 && win.pressure <= 0) {
    severity += 10;
    evidence.push(
      `Lower-timeframe pressure favours the losing digit (${lose.pressure} vs ${win.pressure}).`,
    );
  }
  if (structural) {
    const greenPct = structural.green !== null ? structural.pct[structural.green] : null;
    if (greenPct !== null && lose.pctFast >= greenPct) {
      severity += 12;
      evidence.push(
        `Losing digit ${lose.digit} has already climbed to the structural GREEN share (${greenPct.toFixed(1)}%) on the fast window.`,
      );
    }
  }

  // 6. Actual overtake.
  if (overtaken) {
    severity += 20;
    evidence.push(
      `Losing digit ${lose.digit} has OVERTAKEN winning digit ${win.digit} on the ${field.config.fast}-tick window (${lose.pctFast.toFixed(1)}% vs ${win.pctFast.toFixed(1)}%).`,
    );
  }

  severity = Math.round(clamp(severity, 0, 100));

  // Interaction-based state — never gap alone, never momentum alone.
  const closing = gapVelocityPp <= C.NARROWING_PP || relativeVelocityPp >= C.RAPID_GAIN_PP;
  let state: CompetitionState = "LOW";
  if (overtaken && closing) {
    state = "CRITICAL";
  } else if (gapPp <= C.GAP_CRITICAL_PP && closing) {
    state = "CRITICAL";
  } else if (severity >= 62) {
    state = "CRITICAL";
  } else if (gapPp <= C.GAP_HIGH_PP && closing) {
    state = "HIGH";
  } else if (severity >= 38) {
    state = "HIGH";
  } else if (gapPp <= C.GAP_MODERATE_PP || closing || severity >= 18) {
    state = "MODERATE";
  }

  return {
    measurable: true,
    winningDigit: win.digit,
    losingDigit: lose.digit,
    winningPct: win.pct,
    losingPct: lose.pct,
    gapPp,
    gapFastPp,
    gapVelocityPp,
    relativeVelocityPp,
    overtaken,
    state,
    severity,
    evidence,
    summary: `PERCENTAGE COMPETITION — ${state} (severity ${severity}/100): winning digit ${win.digit} ${win.pct.toFixed(1)}% vs losing digit ${lose.digit} ${lose.pct.toFixed(1)}% (gap ${gapPp.toFixed(2)}pp → ${gapFastPp.toFixed(2)}pp). ${evidence[0] ?? ""}`,
  };
}


export interface ContractPriceActionInputs {
  field: PriceActionField;
  shape: ContractShape;
  /** Canonical 1,000-tick structural psychology (never redefined here). */
  structural?: CanonicalDigitState | null;
}

/**
 * Evaluate one contract against the lower-timeframe pressure field.
 * Produces a bounded ranking contribution, an alignment verdict and, only for
 * a confirmed hostile takeover, a veto.
 */
export function evaluateContractPriceAction({
  field,
  shape,
  structural,
}: ContractPriceActionInputs): ContractPriceAction {
  const winners = shape.winners;
  const all = Array.from({ length: 10 }, (_, d) => d);
  const losers = all.filter((d) => !winners.includes(d));
  const preferredParity: "ODD" | "EVEN" = shape.side === "UNDER" ? "ODD" : "EVEN";
  const parityWinners = all.filter((d) => (preferredParity === "ODD" ? d % 2 === 1 : d % 2 === 0));
  const parityLosers = all.filter((d) => !parityWinners.includes(d));

  const winningSide = sidePressure(field, winners, "WINNING");
  const losingSide = sidePressure(field, losers, "LOSING");
  const parityWinning = sidePressure(field, parityWinners, "WINNING");
  const parityLosing = sidePressure(field, parityLosers, "LOSING");

  const takeover = assessLosingSideTakeover(field, winningSide, losingSide, structural ?? null);
  const competition = assessPercentageCompetition(field, winners, losers, structural ?? null);

  const reasons: string[] = [];
  const cautions: string[] = [];

  // ── ALIGNMENT: does the lower timeframe confirm the structure? ─────────
  let alignment: PriceActionAlignment = "NEUTRAL";
  if (!field.measurable) {
    alignment = "NEUTRAL";
  } else if (takeover.state === "CONFIRMED TAKEOVER") {
    alignment = "TAKEOVER";
  } else if (takeover.state === "EMERGING TAKEOVER") {
    alignment = "CONTRADICTING";
  } else if (winningSide.direction === "INCREASING" && losingSide.direction !== "INCREASING") {
    alignment = "CONFIRMING";
  } else if (winningSide.direction === "DECREASING" && losingSide.direction === "INCREASING") {
    alignment = "CONTRADICTING";
  } else if (
    structural &&
    structural.green !== null &&
    field.digits[structural.green] &&
    field.digits[structural.green].pressure < -8 &&
    field.strongestIncreasing.length > 0
  ) {
    alignment = "TRANSITIONING";
  } else if (takeover.state === "WATCH") {
    alignment = "TRANSITIONING";
  }

  if (alignment === "CONFIRMING") {
    reasons.push(
      `Winning side is gaining ${winningSide.rateOfChangePp.toFixed(2)}pp while the losing side is ${losingSide.direction.toLowerCase()} — the ${field.window}-tick pressure confirms the structural psychology.`,
    );
  }

  // ── PARITY / CONTRACT PSYCHOLOGY on the lower timeframe ────────────────
  if (field.measurable) {
    if (parityWinning.direction === "INCREASING") {
      reasons.push(
        `${preferredParity} digits (the ${shape.side} preferred side) are gaining ${parityWinning.rateOfChangePp.toFixed(2)}pp on the ${field.window}-tick window.`,
      );
    } else if (
      parityLosing.direction === "INCREASING" &&
      parityWinning.direction === "DECREASING"
    ) {
      cautions.push(
        `${preferredParity === "ODD" ? "EVEN" : "ODD"} digits are taking over the lower timeframe (${parityLosing.rateOfChangePp.toFixed(2)}pp) against ${shape.side} contract psychology.`,
      );
    }
  }

  // ── PRESERVED SPECIAL RISK — UNDER: 8, OVER: 1 ─────────────────────────
  const specialDigit = shape.side === "UNDER" ? 8 : 1;
  const specialReading = field.digits[specialDigit] ?? null;
  const specialElevated = Boolean(
    field.measurable &&
    specialReading &&
    losers.includes(specialDigit) &&
    (specialReading.rateOfChangePp > 0.8 || specialReading.pressure > 12),
  );
  if (specialElevated && specialReading) {
    cautions.push(
      `SPECIAL RISK — ${shape.side} digit ${specialDigit} is building on the losing side (${specialReading.note}).`,
    );
  }

  // ── RED / 2ND RED LOSING-SIDE CONTROL ──────────────────────────────────
  const risingOnLosingSide = (d: number | null | undefined) =>
    d !== null &&
    d !== undefined &&
    losers.includes(d) &&
    field.measurable &&
    (field.digits[d]?.rateOfChangePp ?? 0) > 0.6;
  const redRising = risingOnLosingSide(structural?.red);
  const secondRedRising = risingOnLosingSide(structural?.secondRed);
  if (redRising) {
    cautions.push(
      `RED digit ${structural!.red} is strengthening on the losing side (${field.digits[structural!.red!].note}).`,
    );
  }
  if (secondRedRising) {
    cautions.push(
      `2ND RED digit ${structural!.secondRed} is strengthening on the losing side (${field.digits[structural!.secondRed!].note}).`,
    );
  }
  const bothRedRising = redRising && secondRedRising;
  if (bothRedRising) {
    cautions.push(
      "MAJOR PSYCHOLOGY CONFLICT — both RED and 2ND RED are gaining pressure on the losing side.",
    );
  }

  // ── GREEN ON THE LOSING SIDE ───────────────────────────────────────────
  const greenDigit = structural?.green ?? null;
  const greenOnLosing = greenDigit !== null && losers.includes(greenDigit);
  const greenReading = greenDigit !== null ? (field.digits[greenDigit] ?? null) : null;
  const greenStrengthening = Boolean(
    greenOnLosing && greenReading && field.measurable && greenReading.rateOfChangePp > 0.4,
  );
  if (greenOnLosing) {
    if (greenStrengthening) {
      cautions.push(
        `GREEN digit ${greenDigit} sits on the losing side and is STRENGTHENING on the lower timeframe (${greenReading!.note}).`,
      );
    } else if (greenReading && greenReading.pressure < -6) {
      reasons.push(
        `GREEN digit ${greenDigit} sits on the losing side but is fading on the lower timeframe (${greenReading.note}) — acceptable while a winning-side digit takes over.`,
      );
    }
  }

  // ── BOUNDED RANKING CONTRIBUTION ───────────────────────────────────────
  let delta = 0;
  if (field.measurable) {
    // 1. Takeover severity — the dominant, bounded penalty.
    if (takeover.state === "CONFIRMED TAKEOVER") delta -= 6;
    else if (takeover.state === "EMERGING TAKEOVER") delta -= 3.5;
    else if (takeover.state === "WATCH") delta -= 1;
    else if (takeover.state === "EXHAUSTED") delta += 1;

    // 2. Positive confirmation (winning up + losing down) — bounded reward.
    if (winningSide.direction === "INCREASING" && losingSide.direction === "DECREASING") delta += 3;
    else if (winningSide.direction === "INCREASING" && losingSide.direction === "STABLE")
      delta += 1.5;
    else if (winningSide.direction === "DECREASING" && losingSide.direction === "INCREASING")
      delta -= 2; // explicit PSYCHOLOGY CONFLICT

    // 3. RED / 2ND RED control on the losing side — a separate dimension from
    //    aggregate takeover severity, so it is deliberately small.
    if (bothRedRising) delta -= 2;
    else if (redRising || secondRedRising) delta -= 1;

    // 4. GREEN strengthening on the losing side.
    if (greenStrengthening) delta -= 1.5;

    // 5. Preserved special-digit risk.
    if (specialElevated) delta -= 1;

    // 6. PHASE 14 — percentage competition. Bounded and penalty-only: a
    //    contested percentage region can never make a contract look better.
    if (competition.state === "CRITICAL") delta -= 3;
    else if (competition.state === "HIGH") delta -= 1.5;
    else if (competition.state === "MODERATE") delta -= 0.5;
  }
  const rankingDelta = Math.round(clamp(delta, -9, 4) * 10) / 10;

  // A confirmed hostile takeover vetoes. PHASE 14 additionally vetoes when the
  // losing structure has actually OVERTAKEN the winning structure while still
  // gaining — an unresolved takeover must never silently pass.
  const competitionVeto =
    field.measurable && competition.state === "CRITICAL" && competition.overtaken;
  const takeoverVeto =
    field.measurable && takeover.state === "CONFIRMED TAKEOVER" && takeover.severity >= 75;
  const veto = takeoverVeto || competitionVeto;
  const vetoReason = takeoverVeto
    ? `LOSING-SIDE CONFIRMED TAKEOVER (severity ${takeover.severity}/100) on the ${field.window}-tick window — ${takeover.evidence[0] ?? "losing side in control"}`
    : competitionVeto
      ? `PERCENTAGE COMPETITION CRITICAL — losing digit ${competition.losingDigit} has overtaken winning digit ${competition.winningDigit} while still gaining (${competition.gapPp.toFixed(2)}pp → ${competition.gapFastPp.toFixed(2)}pp).`
      : null;

  if (field.measurable && (competition.state === "HIGH" || competition.state === "CRITICAL")) {
    cautions.push(competition.summary);
  }

  const summary = field.measurable
    ? `${field.window}-TICK PRICE ACTION — ${alignment}. Winning side ${winningSide.direction} (${winningSide.rateOfChangePp >= 0 ? "+" : ""}${winningSide.rateOfChangePp.toFixed(2)}pp), losing side ${losingSide.direction} (${losingSide.rateOfChangePp >= 0 ? "+" : ""}${losingSide.rateOfChangePp.toFixed(2)}pp). ${takeover.summary} Ranking ${rankingDelta >= 0 ? "+" : ""}${rankingDelta.toFixed(1)}.`
    : `${field.window}-tick price action unavailable (${field.n} ticks) — no lower-timeframe influence.`;

  return {
    contract: shape.label,
    side: shape.side,
    window: field.window,
    measurable: field.measurable,
    winners,
    losers,
    preferredParity,
    winningSide,
    losingSide,
    parityWinning,
    parityLosing,
    takeover,
    competition,
    alignment,
    specialRisk: {
      digit: specialDigit,
      reading: specialReading,
      elevated: specialElevated,
      note: specialReading
        ? `${shape.side} special digit ${specialDigit}: ${specialReading.note}`
        : `${shape.side} special digit ${specialDigit} not measurable.`,
    },
    redControl: {
      redRising,
      secondRedRising,
      note: bothRedRising
        ? "RED and 2ND RED are both strengthening on the losing side."
        : redRising || secondRedRising
          ? "A starved digit is strengthening on the losing side."
          : "RED / 2ND RED are not gaining on the losing side.",
    },
    greenLosingSide: {
      present: greenOnLosing,
      strengthening: greenStrengthening,
      note: greenOnLosing
        ? greenStrengthening
          ? `GREEN ${greenDigit} is on the losing side AND strengthening — dangerous.`
          : `GREEN ${greenDigit} is on the losing side but not strengthening.`
        : "GREEN is not on the losing side.",
    },
    rankingDelta,
    veto,
    vetoReason,
    reasons,
    cautions,
    summary,
  };
}
