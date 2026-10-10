// ═══════════════════════════════════════════════════════════════════════════
// ENGINE B — PRICE-ACTION PRESSURE (15 / 30 / 60 / 120 TICKS)
//
// THIS ENGINE KNOWS NOTHING ABOUT GREEN, 2ND GREEN, RED OR 2ND RED.
// It does not know which digit leads the 1,000-tick distribution, and the
// 1,000-tick percentages NEVER enter its arithmetic. (The existing
// price-action-psychology.ts adds `clamp(pct - structural, -8, 8) * 1.2` into
// the pressure formula — that term is deliberately removed here, so the two
// layers cannot contaminate each other. Structural share may be attached for
// DISPLAY only, via `structuralPctForDisplay`.)
//
// PRESSURE IS CHANGE, NOT LEVEL.
//
// Four nested windows, longest → shortest:
//     120 ticks → current short-term structure
//      60 ticks → short-term pressure
//      30 ticks → very recent pressure
//      15 ticks → immediate pressure
//
// Three transitions are measured between them:
//     short     = pct60  − pct120
//     near      = pct30  − pct60
//     immediate = pct15  − pct30
//
//   rate         = pct15 − pct120                 (total movement)
//   acceleration = immediate − short              (is movement speeding up?)
//   persistence  = agreeing transitions / 3       (steady climb vs one burst)
//   agreement    = how many of the 4 windows line up with the net direction
// ═══════════════════════════════════════════════════════════════════════════
import { clamp, shareOf } from "./types";

export const PRESSURE_WINDOWS = [15, 30, 60, 120] as const;
export type PressureWindow = (typeof PRESSURE_WINDOWS)[number];

export const W_IMMEDIATE: PressureWindow = 15;
export const W_RECENT: PressureWindow = 30;
export const W_SHORT: PressureWindow = 60;
export const W_STRUCTURE: PressureWindow = 120;

/** Minimum ticks before pressure is trusted at all. */
export const PRESSURE_MIN_TICKS = 60;
/** |pp| below which a transition counts as flat. */
export const FLAT_PP = 0.2;

export interface PressureWindowConfig {
  immediate: number;
  recent: number;
  short: number;
  structure: number;
}

export const DEFAULT_PRESSURE_CONFIG: PressureWindowConfig = {
  immediate: W_IMMEDIATE,
  recent: W_RECENT,
  short: W_SHORT,
  structure: W_STRUCTURE,
};

export type PressureDirection =
  | "STRONGLY_INCREASING"
  | "INCREASING"
  | "NEUTRAL"
  | "DECREASING"
  | "STRONGLY_DECREASING"
  | "REVERSING"
  | "CONFLICTING";

export type DigitMovement =
  | "TAKING OVER"
  | "ACCELERATING"
  | "STRENGTHENING"
  | "STABLE"
  | "DECELERATING"
  | "REVERSING"
  | "WEAKENING"
  | "LOSING GROUND"
  | "EXHAUSTING";

/** Window agreement label — prevents a noisy 15-tick burst outvoting 3 windows. */
export type WindowAgreement = "4/4" | "3/4" | "2/4" | "1/4" | "NONE";

export interface WindowSlice {
  window: number;
  n: number;
  /** Share of the subject (digit or group) inside this window, %. */
  pct: number;
}

export interface PressureTransitions {
  /** pct60 − pct120 */
  shortPp: number;
  /** pct30 − pct60 */
  nearPp: number;
  /** pct15 − pct30 */
  immediatePp: number;
}

export interface PressureReading {
  /** Digit index, or null for group readings. */
  digit: number | null;
  label: string;
  measurable: boolean;
  /** Ordered longest → shortest: 120, 60, 30, 15. */
  slices: WindowSlice[];
  pct120: number;
  pct60: number;
  pct30: number;
  pct15: number;
  transitions: PressureTransitions;
  /** pct15 − pct120, pp. Total movement across the nest. */
  ratePp: number;
  /** immediate − short, pp. */
  accelerationPp: number;
  /** 0..1 — share of transitions agreeing with the net direction. */
  persistence: number;
  /** How many of the four windows agree with the net direction. */
  agreement: WindowAgreement;
  agreeingWindows: number;
  /** Prints inside the immediate window. */
  recentActivity: number;
  /** Ticks since last print inside the 120-tick window (Infinity if absent). */
  sinceSeen: number;
  /** True when every transition gained. */
  monotonicUp: boolean;
  /** True when every transition lost. */
  monotonicDown: boolean;
  /** −100..+100. Movement only: rate, acceleration, persistence. */
  pressure: number;
  direction: PressureDirection;
  movement: DigitMovement;
  /** Structural 1,000-tick share, attached for DISPLAY only. Never scored. */
  structuralPctForDisplay: number | null;
  note: string;
}

export interface PressureField {
  config: PressureWindowConfig;
  /** Ticks available in the longest (120) window. */
  n: number;
  measurable: boolean;
  /** Index === digit. */
  digits: PressureReading[];
  /** Digits with the strongest positive pressure, strongest first. */
  rising: number[];
  /** Digits with the strongest negative pressure, strongest first. */
  falling: number[];
  /** Digits gaining across every transition (steady climbers, not bursts). */
  steadyClimbers: number[];
  summary: string;
}

function agreementLabel(count: number): WindowAgreement {
  if (count >= 4) return "4/4";
  if (count === 3) return "3/4";
  if (count === 2) return "2/4";
  if (count === 1) return "1/4";
  return "NONE";
}

function classifyDirection(r: {
  ratePp: number;
  accelerationPp: number;
  persistence: number;
  transitions: PressureTransitions;
  measurable: boolean;
}): PressureDirection {
  if (!r.measurable) return "NEUTRAL";
  const { shortPp, nearPp, immediatePp } = r.transitions;
  const signs = [shortPp, nearPp, immediatePp].map((v) =>
    v > FLAT_PP ? 1 : v < -FLAT_PP ? -1 : 0,
  );
  const ups = signs.filter((s) => s > 0).length;
  const downs = signs.filter((s) => s < 0).length;

  // A late flip against an established move is a reversal, not a trend.
  if (ups && downs) {
    const early = signs[0] || signs[1];
    const late = signs[2] || signs[1];
    if (early && late && early !== late && Math.abs(immediatePp) >= 1.0) return "REVERSING";
    if (Math.abs(r.ratePp) < 0.8) return "CONFLICTING";
  }
  if (r.ratePp >= 1.8 && r.persistence >= 0.66) return "STRONGLY_INCREASING";
  if (r.ratePp >= 0.8) return "INCREASING";
  if (r.ratePp <= -1.8 && r.persistence >= 0.66) return "STRONGLY_DECREASING";
  if (r.ratePp <= -0.8) return "DECREASING";
  return "NEUTRAL";
}

function classifyMovement(r: {
  ratePp: number;
  accelerationPp: number;
  persistence: number;
  monotonicUp: boolean;
  monotonicDown: boolean;
  direction: PressureDirection;
  measurable: boolean;
}): DigitMovement {
  if (!r.measurable) return "STABLE";
  if (r.direction === "REVERSING") return "REVERSING";
  if (r.monotonicUp && r.ratePp >= 2.0 && r.accelerationPp >= 0.6) return "TAKING OVER";
  if (r.ratePp >= 1.0 && r.accelerationPp >= 0.8) return "ACCELERATING";
  if (r.ratePp >= 0.8) return "STRENGTHENING";
  if (r.monotonicDown && r.ratePp <= -2.0) return "LOSING GROUND";
  if (r.ratePp <= -0.8 && r.accelerationPp <= -0.8) return "EXHAUSTING";
  if (r.ratePp <= -0.8) return "WEAKENING";
  if (
    Math.abs(r.ratePp) >= 0.4 &&
    r.accelerationPp * r.ratePp < 0 &&
    Math.abs(r.accelerationPp) >= 0.6
  )
    return "DECELERATING";
  return "STABLE";
}

/** Build one reading from four window shares. Shared by digit and group paths. */
function buildReading(args: {
  digit: number | null;
  label: string;
  measurable: boolean;
  cfg: PressureWindowConfig;
  counts: { n120: number; n60: number; n30: number; n15: number };
  pcts: { pct120: number; pct60: number; pct30: number; pct15: number };
  recentActivity: number;
  sinceSeen: number;
  structuralPctForDisplay: number | null;
}): PressureReading {
  const { pct120, pct60, pct30, pct15 } = args.pcts;
  const transitions: PressureTransitions = {
    shortPp: pct60 - pct120,
    nearPp: pct30 - pct60,
    immediatePp: pct15 - pct30,
  };
  const ratePp = pct15 - pct120;
  const accelerationPp = transitions.immediatePp - transitions.shortPp;

  const steps = [transitions.shortPp, transitions.nearPp, transitions.immediatePp];
  const netSign = ratePp > FLAT_PP ? 1 : ratePp < -FLAT_PP ? -1 : 0;
  const agreeingSteps = netSign
    ? steps.filter((s) => Math.sign(s) === netSign && Math.abs(s) > FLAT_PP).length
    : 0;
  const persistence = args.measurable ? agreeingSteps / steps.length : 0;
  const monotonicUp = steps.every((s) => s > FLAT_PP);
  const monotonicDown = steps.every((s) => s < -FLAT_PP);

  // Window agreement: count windows whose share sits on the correct side of
  // the 120-tick baseline for the net direction (120 itself always counts).
  const shorter = [pct60, pct30, pct15];
  const agreeingWindows = netSign
    ? 1 + shorter.filter((p) => Math.sign(p - pct120) === netSign).length
    : 0;

  // ── PRESSURE — movement only. No structural term, by design. ──────────
  const pressureRaw = args.measurable
    ? ratePp * 7 +
      accelerationPp * 4 +
      (agreeingSteps - (3 - agreeingSteps)) * 4 +
      (monotonicUp ? 6 : monotonicDown ? -6 : 0)
    : 0;
  const pressure = Math.round(clamp(pressureRaw, -100, 100));

  const direction = classifyDirection({
    ratePp,
    accelerationPp,
    persistence,
    transitions,
    measurable: args.measurable,
  });
  const movement = classifyMovement({
    ratePp,
    accelerationPp,
    persistence,
    monotonicUp,
    monotonicDown,
    direction,
    measurable: args.measurable,
  });

  const slices: WindowSlice[] = [
    { window: args.cfg.structure, n: args.counts.n120, pct: pct120 },
    { window: args.cfg.short, n: args.counts.n60, pct: pct60 },
    { window: args.cfg.recent, n: args.counts.n30, pct: pct30 },
    { window: args.cfg.immediate, n: args.counts.n15, pct: pct15 },
  ];

  const note = args.measurable
    ? `${args.label}: ${args.cfg.structure}t ${pct120.toFixed(1)}% → ${args.cfg.short}t ${pct60.toFixed(1)}% → ${args.cfg.recent}t ${pct30.toFixed(1)}% → ${args.cfg.immediate}t ${pct15.toFixed(1)}% ` +
      `(rate ${ratePp >= 0 ? "+" : ""}${ratePp.toFixed(2)}pp, accel ${accelerationPp >= 0 ? "+" : ""}${accelerationPp.toFixed(2)}pp, ` +
      `agreement ${agreementLabel(agreeingWindows)}) — ${direction} / ${movement}, pressure ${pressure}.`
    : `${args.label}: pressure not measurable yet (${args.counts.n120} ticks).`;

  return {
    digit: args.digit,
    label: args.label,
    measurable: args.measurable,
    slices,
    pct120,
    pct60,
    pct30,
    pct15,
    transitions,
    ratePp,
    accelerationPp,
    persistence,
    agreement: agreementLabel(agreeingWindows),
    agreeingWindows,
    recentActivity: args.recentActivity,
    sinceSeen: args.sinceSeen,
    monotonicUp,
    monotonicDown,
    pressure,
    direction,
    movement,
    structuralPctForDisplay: args.structuralPctForDisplay,
    note,
  };
}

/**
 * Build the 15/30/60/120 pressure field. Pure.
 *
 * @param digits                 digit stream, oldest → newest
 * @param structuralPctForDisplay optional 1,000-tick shares — DISPLAY ONLY,
 *                               never used in any pressure calculation.
 */
export function computePressureField(
  digits: readonly number[],
  structuralPctForDisplay?: readonly number[] | null,
  config: Partial<PressureWindowConfig> = {},
): PressureField {
  const cfg: PressureWindowConfig = { ...DEFAULT_PRESSURE_CONFIG, ...config };
  const w120 = digits.slice(-cfg.structure);
  const w60 = digits.slice(-cfg.short);
  const w30 = digits.slice(-cfg.recent);
  const w15 = digits.slice(-cfg.immediate);
  const n = w120.length;
  const measurable = n >= Math.min(PRESSURE_MIN_TICKS, cfg.structure);

  const readings: PressureReading[] = [];
  for (let d = 0; d < 10; d++) {
    let recentActivity = 0;
    for (const x of w15) if (x === d) recentActivity++;
    let sinceSeen = Number.POSITIVE_INFINITY;
    for (let i = w120.length - 1; i >= 0; i--) {
      if (w120[i] === d) {
        sinceSeen = w120.length - 1 - i;
        break;
      }
    }
    readings.push(
      buildReading({
        digit: d,
        label: `Digit ${d}`,
        measurable,
        cfg,
        counts: { n120: w120.length, n60: w60.length, n30: w30.length, n15: w15.length },
        pcts: {
          pct120: shareOf(w120, d),
          pct60: shareOf(w60, d),
          pct30: shareOf(w30, d),
          pct15: shareOf(w15, d),
        },
        recentActivity,
        sinceSeen,
        structuralPctForDisplay: structuralPctForDisplay?.[d] ?? null,
      }),
    );
  }

  const byPressure = [...readings].sort((a, b) => b.pressure - a.pressure);
  const rising = byPressure
    .filter((r) => r.pressure > 6)
    .slice(0, 3)
    .map((r) => r.digit as number);
  const falling = [...byPressure]
    .reverse()
    .filter((r) => r.pressure < -6)
    .slice(0, 3)
    .map((r) => r.digit as number);
  const steadyClimbers = readings.filter((r) => r.monotonicUp).map((r) => r.digit as number);

  return {
    config: cfg,
    n,
    measurable,
    digits: readings,
    rising,
    falling,
    steadyClimbers,
    summary: measurable
      ? `PRESSURE ${cfg.immediate}/${cfg.recent}/${cfg.short}/${cfg.structure} — rising ${rising.join(", ") || "—"} · falling ${falling.join(", ") || "—"} · steady climbers ${steadyClimbers.join(", ") || "—"} (${n} ticks).`
      : `Pressure unavailable — ${n} tick(s) of ${cfg.structure}.`,
  };
}

/**
 * Aggregate pressure for a GROUP of digits (e.g. every odd digit, or a
 * contract's losing digits). Group shares are summed per window, then the same
 * movement arithmetic is applied — so the group has its own rate, acceleration,
 * persistence and window agreement rather than an average of digit scores.
 */
export function computeGroupPressure(
  digits: readonly number[],
  group: readonly number[],
  label: string,
  config: Partial<PressureWindowConfig> = {},
): PressureReading {
  const cfg: PressureWindowConfig = { ...DEFAULT_PRESSURE_CONFIG, ...config };
  const w120 = digits.slice(-cfg.structure);
  const w60 = digits.slice(-cfg.short);
  const w30 = digits.slice(-cfg.recent);
  const w15 = digits.slice(-cfg.immediate);
  const measurable = w120.length >= Math.min(PRESSURE_MIN_TICKS, cfg.structure);
  const sum = (seg: readonly number[]) => group.reduce((a, d) => a + shareOf(seg, d), 0);

  let recentActivity = 0;
  for (const x of w15) if (group.includes(x)) recentActivity++;
  let sinceSeen = Number.POSITIVE_INFINITY;
  for (let i = w120.length - 1; i >= 0; i--) {
    if (group.includes(w120[i] as number)) {
      sinceSeen = w120.length - 1 - i;
      break;
    }
  }

  return buildReading({
    digit: null,
    label,
    measurable,
    cfg,
    counts: { n120: w120.length, n60: w60.length, n30: w30.length, n15: w15.length },
    pcts: { pct120: sum(w120), pct60: sum(w60), pct30: sum(w30), pct15: sum(w15) },
    recentActivity,
    sinceSeen,
    structuralPctForDisplay: null,
  });
}

/** Convenience: the reading for one digit out of a built field. */
export function digitPressure(field: PressureField, d: number): PressureReading | null {
  return field.digits[d] ?? null;
}
