// ═══════════════════════════════════════════════════════════════════════════
// DIGIT PRESSURE / SCARCITY ENGINE — canonical, single source of truth.
//
// This module is now the PRIMARY reasoning substrate for Precision Edge.
// Every digit 0-9 is continuously classified into a live state:
//
//   dominant    — over fair share and STILL climbing   (pressure building)
//   exhausting  — over fair share but rolling over     (pressure exhausted)
//   fair        — at fair share, flat                  (no information)
//   suppressed  — under fair share and still fading    (scarcity deepening)
//   recovering  — under fair share but climbing back   (scarcity unwinding)
//
// The tradeable event is ASYMMETRY: one side of a contract building pressure
// faster while the opposing side looks exhausted. That asymmetry — not a
// checklist of legacy gates — is what Precision Edge now trades.
//
// Perf: everything is computed from a plain `number[]` of last-digits in a
// single pass over three sub-windows. No tick objects, no array cloning, no
// repeated `lastDigit()` work. Callers pass the digit array they already have.
// ═══════════════════════════════════════════════════════════════════════════

export type PressureState = "dominant" | "exhausting" | "fair" | "suppressed" | "recovering";

export const PRESSURE_META: Record<
  PressureState,
  { label: string; color: string; blurb: string; bias: number }
> = {
  dominant: {
    label: "Dominant",
    color: "var(--bull)",
    blurb: "over-represented, still climbing",
    bias: 1,
  },
  exhausting: {
    label: "Exhausting",
    color: "var(--warn)",
    blurb: "over-represented, rolling over",
    bias: -0.6,
  },
  fair: {
    label: "Fair",
    color: "var(--neon)",
    blurb: "near expected share, flat",
    bias: 0,
  },
  suppressed: {
    label: "Suppressed",
    color: "var(--bear)",
    blurb: "under-represented, still fading",
    bias: -1,
  },
  recovering: {
    label: "Recovering",
    color: "var(--accent)",
    blurb: "under-represented, climbing back",
    bias: 0.7,
  },
};

/** States that mean "this digit is gaining probability right now". */
export const BUILDING_STATES: PressureState[] = ["dominant", "recovering"];
/** States that mean "this digit is losing probability right now". */
export const FADING_STATES: PressureState[] = ["exhausting", "suppressed"];

export interface DigitPressure {
  d: number;
  /** Share of the full window, 0..1. */
  share: number;
  /** recent sub-window share − full-window share (probability migration). */
  momentum: number;
  /** newest-half momentum − older-half momentum: is the move *accelerating*? */
  accel: number;
  state: PressureState;
  /** -1..+1 — how strongly this digit is currently favoured. */
  score: number;
  detail: string;
}

export interface PressureField {
  digits: DigitPressure[]; // length 10, index === digit
  window: number;
  sub: number;
  /** Total-variation distance from uniform, 0..1 — distribution distortion. */
  distortion: number;
  /** Sum of |momentum| — how much probability is in motion right now. */
  flow: number;
}

export interface GroupPressure {
  digits: number[];
  share: number;
  fairShare: number;
  momentum: number;
  accel: number;
  /** Mean directional score of the group, -1..+1. */
  score: number;
  building: number; // count in dominant/recovering
  fading: number; // count in exhausting/suppressed
  states: PressureState[];
}

export interface PressureVerdict {
  winners: GroupPressure;
  losers: GroupPressure;
  /**
   * The headline number. > 0 means the winning side is building pressure
   * faster than the losing side, which is simultaneously exhausting.
   * Roughly -1..+1 in practice.
   */
  asymmetry: number;
  /** How much of the asymmetry comes from *acceleration* rather than level. */
  accelAsymmetry: number;
  /** 0..100 — conviction that the pressure field favours this contract. */
  conviction: number;
  /** True when the classic textbook setup is live. */
  qualified: boolean;
  bias: "FOR" | "AGAINST" | "NEUTRAL";
  headline: string;
  detail: string[];
}

const FAIR = 0.1;
const NEAR_FAIR = 0.005; // ±0.5pt around fair share counts as "at fair"
const MOMENTUM_FLAT = 0.003; // |momentum| below this counts as flat

export const PRESSURE_WINDOW = 1000;
/**
 * Sub-window used to calculate per-digit probability migration and acceleration (150 ticks).
 * Deliberately faster than RECENCY_WINDOW (200 ticks) so per-digit velocity reacts to immediate order flow
 * while canonical distribution changes retain structural stability.
 */
export const PRESSURE_SUB = 150;

function classify(share: number, momentum: number): PressureState {
  const above = share - FAIR;
  if (Math.abs(above) < NEAR_FAIR && Math.abs(momentum) < MOMENTUM_FLAT) return "fair";
  if (above >= 0 && momentum >= 0) return "dominant";
  if (above >= 0 && momentum < 0) return "exhausting";
  if (above < 0 && momentum <= 0) return "suppressed";
  return "recovering";
}

/**
 * Build the full pressure field from a last-digit array.
 *
 * Single pass per sub-window, integer histograms only — this is the hot path
 * that runs for ~20 markets per scan, so it must stay allocation-light.
 */
export function computePressureField(
  digits: number[],
  window = PRESSURE_WINDOW,
  sub = PRESSURE_SUB,
): PressureField {
  const n = digits.length;
  const start = Math.max(0, n - window);
  const winLen = n - start || 1;

  const full = new Int32Array(10);
  for (let i = start; i < n; i++) full[digits[i]]++;

  // recent sub-window, and its two halves (for acceleration)
  const recentStart = Math.max(start, n - sub);
  const recent = new Int32Array(10);
  for (let i = recentStart; i < n; i++) recent[digits[i]]++;
  const recentLen = n - recentStart || 1;

  const half = Math.max(1, Math.floor(sub / 2));
  const newStart = Math.max(start, n - half);
  const newer = new Int32Array(10);
  for (let i = newStart; i < n; i++) newer[digits[i]]++;
  const newerLen = n - newStart || 1;

  const olderStart = Math.max(start, n - half * 2);
  const older = new Int32Array(10);
  for (let i = olderStart; i < newStart; i++) older[digits[i]]++;
  const olderLen = newStart - olderStart || 1;

  const out: DigitPressure[] = new Array(10);
  let distortion = 0;
  let flow = 0;

  for (let d = 0; d < 10; d++) {
    const share = full[d] / winLen;
    const momentum = recent[d] / recentLen - share;
    const accel = newer[d] / newerLen - older[d] / olderLen;
    const state = classify(share, momentum);
    const meta = PRESSURE_META[state];

    // Directional score: state bias, amplified by how far from fair share the
    // digit sits and how hard it is currently moving.
    const magnitude = Math.min(
      1,
      Math.abs(share - FAIR) * 14 + Math.abs(momentum) * 18 + Math.abs(accel) * 8,
    );
    const score = Math.max(-1, Math.min(1, meta.bias * (0.45 + 0.55 * magnitude)));

    distortion += Math.abs(share - FAIR);
    flow += Math.abs(momentum);

    out[d] = {
      d,
      share,
      momentum,
      accel,
      state,
      score,
      detail: `${(share * 100).toFixed(1)}% · ${momentum >= 0 ? "+" : ""}${(momentum * 100).toFixed(
        1,
      )}pt ${meta.blurb}`,
    };
  }

  return { digits: out, window: winLen, sub: recentLen, distortion: distortion / 2, flow };
}

/** Aggregate the pressure field across an arbitrary set of digits. */
export function groupPressure(field: PressureField, group: number[]): GroupPressure {
  const len = group.length || 1;
  let share = 0;
  let momentum = 0;
  let accel = 0;
  let score = 0;
  let building = 0;
  let fading = 0;
  const states: PressureState[] = [];
  for (const d of group) {
    const p = field.digits[d];
    share += p.share;
    momentum += p.momentum;
    accel += p.accel;
    score += p.score;
    states.push(p.state);
    if (p.state === "dominant" || p.state === "recovering") building++;
    if (p.state === "exhausting" || p.state === "suppressed") fading++;
  }
  return {
    digits: group,
    share,
    fairShare: len * FAIR,
    momentum,
    accel,
    score: score / len,
    building,
    fading,
    states,
  };
}

export interface EdgeGroupRapidPressureResult {
  side: "OVER" | "UNDER";
  digits: number[];
  allUnder10Pct: boolean;
  allIncreasingRapidly: boolean;
  avgMomentum: number;
  avgAccel: number;
  buildingCount: number;
  states: PressureState[];
  pass: boolean;
  summary: string;
}

/**
 * Validates digit psychology edge groups via the Pressure Engine:
 * - OVER: Digits 7, 8, 9 must be < 10% share and increasing rapidly (positive momentum/accel/building states).
 * - UNDER: Digits 0, 1, 2 must be < 10% share and increasing rapidly.
 */
export function evaluateEdgeGroupRapidPressure(
  field: PressureField,
  side: "OVER" | "UNDER",
): EdgeGroupRapidPressureResult {
  const edgeDigits = side === "OVER" ? [7, 8, 9] : [0, 1, 2];
  let allUnder10Pct = true;
  let allIncreasingRapidly = true;
  let sumMom = 0;
  let sumAccel = 0;
  let buildingCount = 0;
  const states: PressureState[] = [];

  for (const d of edgeDigits) {
    const p = field.digits[d];
    if (!p) continue;
    states.push(p.state);
    sumMom += p.momentum;
    sumAccel += p.accel;
    if (p.share >= 0.1) {
      allUnder10Pct = false;
    }
    const isRapid =
      p.state === "dominant" ||
      p.state === "recovering" ||
      p.momentum > 0.003 ||
      (p.momentum >= 0 && p.accel > 0);
    if (!isRapid) {
      allIncreasingRapidly = false;
    } else {
      buildingCount++;
    }
  }

  const avgMomentum = sumMom / (edgeDigits.length || 1);
  const avgAccel = sumAccel / (edgeDigits.length || 1);
  const pass = allUnder10Pct && allIncreasingRapidly;
  const summary = `${side} edge group [${edgeDigits.join(",")}]: ${
    allUnder10Pct ? "all < 10%" : "exceeds 10% cap"
  }, ${
    allIncreasingRapidly ? "increasing rapidly" : `${buildingCount}/${edgeDigits.length} building`
  } (avg mom ${(avgMomentum * 100).toFixed(2)}pt, avg accel ${(avgAccel * 100).toFixed(2)}pt)`;

  return {
    side,
    digits: edgeDigits,
    allUnder10Pct,
    allIncreasingRapidly,
    avgMomentum,
    avgAccel,
    buildingCount,
    states,
    pass,
    summary,
  };
}

/**
 * The core Precision Edge judgement.
 *
 * Reads the pressure field for one contract (its winning digits vs the rest)
 * and answers the only question that matters: is one side building pressure
 * faster while the other looks exhausted?
 */
export function readPressure(field: PressureField, winners: number[]): PressureVerdict {
  const loserDigits: number[] = [];
  const winnerSet = new Set(winners);
  for (let d = 0; d < 10; d++) if (!winnerSet.has(d)) loserDigits.push(d);

  const w = groupPressure(field, winners);
  const l = groupPressure(field, loserDigits);

  // Per-digit momentum so group sizes don't bias the comparison.
  const wRate = w.momentum / (winners.length || 1);
  const lRate = l.momentum / (loserDigits.length || 1);
  const wAccel = w.accel / (winners.length || 1);
  const lAccel = l.accel / (loserDigits.length || 1);

  // Asymmetry blends three independent readings:
  //   1. who is gaining probability faster (momentum differential)
  //   2. who the state machine says is building vs exhausted
  //   3. raw directional score differential
  const momentumTerm = (wRate - lRate) * 26; // ~±1 for a 4pt/digit swing
  const stateTerm =
    (w.building / (winners.length || 1) - w.fading / (winners.length || 1)) * 0.5 +
    (l.fading / (loserDigits.length || 1) - l.building / (loserDigits.length || 1)) * 0.5;
  const scoreTerm = (w.score - l.score) * 0.5;

  const asymmetry = Math.max(
    -1.5,
    Math.min(1.5, momentumTerm * 0.45 + stateTerm * 0.35 + scoreTerm * 0.2),
  );
  const accelAsymmetry = Math.max(-1.5, Math.min(1.5, (wAccel - lAccel) * 26));

  // Textbook qualification: the winning side is genuinely building (at least
  // one third dominant/recovering, net momentum positive) AND the losing side
  // is genuinely tiring (majority exhausting/suppressed, net momentum ≤ 0).
  const winnersBuilding = w.building >= Math.max(1, Math.ceil(winners.length * 0.34)) && wRate > 0;
  const losersExhausted =
    l.fading >= Math.max(1, Math.ceil(loserDigits.length * 0.5)) && lRate <= 0.0005;
  const qualified = winnersBuilding && losersExhausted && asymmetry >= 0.12;

  // Conviction 0..100, centred at 50 for a perfectly balanced field.
  let conviction = 50 + asymmetry * 34 + accelAsymmetry * 10;
  if (winnersBuilding) conviction += 5;
  if (losersExhausted) conviction += 5;
  // A distorted-but-motionless field is noise, not opportunity.
  if (field.flow < 0.05) conviction -= 8;
  conviction = Math.max(0, Math.min(100, conviction));

  const bias: PressureVerdict["bias"] =
    asymmetry >= 0.1 ? "FOR" : asymmetry <= -0.1 ? "AGAINST" : "NEUTRAL";

  const topWinner = [...winners].sort(
    (a, b) => field.digits[b].momentum - field.digits[a].momentum,
  )[0];
  const topLoser = [...loserDigits].sort(
    (a, b) => field.digits[a].momentum - field.digits[b].momentum,
  )[0];

  const headline =
    bias === "FOR"
      ? `Winning digits building ${(wRate * 100).toFixed(2)}pt/digit while losing digits ${
          lRate <= 0 ? "drain" : "lag"
        } ${(lRate * 100).toFixed(2)}pt/digit`
      : bias === "AGAINST"
        ? `Pressure is flowing to the losing digits (${(lRate * 100).toFixed(2)}pt/digit)`
        : `Pressure field balanced — no side is winning the flow`;

  const detail: string[] = [
    `Winners ${winners.join(",")}: ${w.building} building / ${w.fading} fading · share ${(
      w.share * 100
    ).toFixed(1)}% vs ${(w.fairShare * 100).toFixed(0)}% fair`,
    `Losers ${loserDigits.join(",")}: ${l.fading} fading / ${l.building} building · share ${(
      l.share * 100
    ).toFixed(1)}% vs ${(l.fairShare * 100).toFixed(0)}% fair`,
  ];
  if (topWinner !== undefined) {
    const p = field.digits[topWinner];
    detail.push(`Lead winner d${topWinner} ${PRESSURE_META[p.state].label} — ${p.detail}`);
  }
  if (topLoser !== undefined) {
    const p = field.digits[topLoser];
    detail.push(`Weakest loser d${topLoser} ${PRESSURE_META[p.state].label} — ${p.detail}`);
  }
  if (accelAsymmetry >= 0.15)
    detail.push(`Divergence is accelerating (${accelAsymmetry.toFixed(2)})`);
  else if (accelAsymmetry <= -0.15)
    detail.push(`Divergence is decelerating (${accelAsymmetry.toFixed(2)})`);

  return {
    winners: w,
    losers: l,
    asymmetry,
    accelAsymmetry,
    conviction,
    qualified,
    bias,
    headline,
    detail,
  };
}
