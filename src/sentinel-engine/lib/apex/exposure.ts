// APEX SENTINEL — LOSING-DIGIT EXPOSURE & BURST RISK.
//
// A favourable aggregate percentage is never sufficient. For every proposed
// contract this engine models the digits that make it LOSE, one by one:
// frequency, pressure, velocity, acceleration, streaks, recent appearances,
// burst behaviour, the longest adverse burst, the sensitive bar role, and what
// THIS market historically did after comparable bursts.
//
// A repeated losing digit is treated as EXPOSURE, never as "due to stop".
import type { BarStructure } from "./bars";
import type { DigitIntel } from "./digit-intel";

export type ExposureState = "LOW" | "MODERATE" | "HIGH" | "SEVERE";

export interface LosingDigitExposure {
  digit: number;
  frequency: number; // fast-window share
  baseline: number;
  pressure: number;
  velocity: number;
  acceleration: number;
  streak: number; // consecutive prints ending now
  recentAppearances: number; // last 20 ticks
  burstCount: number; // appearances in the last 10 ticks
  longestBurst: number; // longest consecutive run ever observed in the buffer
  /** P(the digit prints again within 5 ticks | a burst just like this one), observed. */
  continuationAfterBurst: number;
  continuationN: number;
  /** Mean extra appearances in the 10 ticks after comparable bursts. */
  historicalDamage: number;
  role: "GREEN" | "RED" | "SECOND" | "NONE";
  risk: number; // 0..100
  state: ExposureState;
  drivers: string[];
}

export interface ExposureReport {
  contract: string;
  losers: number[];
  digits: LosingDigitExposure[];
  /** LOSING_DIGIT_RISK — the worst single losing digit, 0..100. */
  losingDigitRisk: number;
  /** LOSING_DIGIT_EXPOSURE — worst digit blended with breadth, 0..100. */
  losingDigitExposure: number;
  state: ExposureState;
  /** Losing digits currently bursting (>= 2 appearances in the last 10 ticks). */
  bursting: number[];
  alerts: string[];
  summary: string;
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));

function stateOf(v: number): ExposureState {
  if (v >= 78) return "SEVERE";
  if (v >= 58) return "HIGH";
  if (v >= 35) return "MODERATE";
  return "LOW";
}

/** Longest consecutive run of `d` inside the buffer. */
function longestRun(digits: number[], d: number): number {
  let best = 0;
  let run = 0;
  for (const x of digits) {
    if (x === d) {
      run++;
      best = Math.max(best, run);
    } else run = 0;
  }
  return best;
}

/**
 * Observed behaviour after comparable bursts in THIS market's own buffer:
 * how often the digit printed again within 5 ticks, and how many extra
 * appearances followed in the next 10 ticks.
 */
function burstBehaviour(digits: number[], d: number, burst: number) {
  if (burst < 2) return { continuation: -1, n: 0, damage: 0 };
  let n = 0;
  let cont = 0;
  let damage = 0;
  for (let i = 10; i < digits.length - 10; i++) {
    let count = 0;
    for (let k = i - 10; k < i; k++) if (digits[k] === d) count++;
    if (count !== burst) continue;
    n++;
    const next5 = digits.slice(i, i + 5);
    if (next5.includes(d)) cont++;
    let after = 0;
    for (let k = i; k < i + 10; k++) if (digits[k] === d) after++;
    damage += after;
  }
  return { continuation: n >= 12 ? cont / n : -1, n, damage: n ? damage / n : 0 };
}

function computeLosingDigitExposure(
  digits: number[],
  winners: number[],
  intel: DigitIntel | null,
  bars: BarStructure | null,
  contractLabel: string,
): ExposureReport {
  const winSet = new Set(winners);
  const losers: number[] = [];
  for (let d = 0; d < 10; d++) if (!winSet.has(d)) losers.push(d);

  const last20 = digits.slice(Math.max(0, digits.length - 20));
  const last10 = digits.slice(Math.max(0, digits.length - 10));
  const cur = bars?.current ?? null;
  const prev = bars?.previous ?? null;
  const second = bars?.secondPrevious ?? null;
  const roleOf = (d: number): LosingDigitExposure["role"] => {
    if (cur && cur.digit === d)
      return cur.color === "GREEN" ? "GREEN" : cur.color === "RED" ? "RED" : "NONE";
    if ((prev && prev.digit === d) || (second && second.digit === d)) return "SECOND";
    return "NONE";
  };

  const rows: LosingDigitExposure[] = losers.map((d) => {
    const p = intel?.profiles?.[d];
    const recentAppearances = last20.filter((x) => x === d).length;
    const burstCount = last10.filter((x) => x === d).length;
    const behaviour = burstBehaviour(digits, d, burstCount);
    const drivers: string[] = [];
    let risk = 0;

    const pressure = p?.pressure ?? 0;
    const velocity = p?.frequencyVelocity ?? 0;
    const acceleration = p?.pressureAcceleration ?? 0;
    const streak = p?.consecutive ?? 0;

    if (pressure > 0.015) {
      risk += Math.min(24, pressure * 650);
      drivers.push(`pressure +${(pressure * 100).toFixed(1)}pp`);
    }
    if (velocity > 0) {
      risk += Math.min(12, velocity * 400);
      drivers.push("frequency rising");
    }
    if (acceleration > 0) {
      risk += Math.min(12, acceleration * 800);
      drivers.push("accelerating");
    }
    if (burstCount >= 2) {
      risk += Math.min(22, burstCount * 8);
      drivers.push(`${burstCount}× in the last 10 ticks`);
    }
    if (recentAppearances >= 4) {
      risk += Math.min(14, (recentAppearances - 3) * 5);
      drivers.push(`${recentAppearances}× in the last 20 ticks`);
    }
    if (streak >= 2) {
      risk += streak * 7;
      drivers.push(`${streak} consecutive prints`);
    }
    if (behaviour.continuation >= 0) {
      const excess = behaviour.continuation - (1 - Math.pow(0.9, 5));
      if (excess > 0) {
        risk += Math.min(16, excess * 90);
        drivers.push(
          `this market historically CONTINUED after comparable bursts (${(behaviour.continuation * 100).toFixed(0)}% within 5 ticks, N=${behaviour.n})`,
        );
      } else {
        risk -= 6;
        drivers.push(
          `this market historically exhausted after comparable bursts (${(behaviour.continuation * 100).toFixed(0)}% within 5 ticks, N=${behaviour.n})`,
        );
      }
    }
    const role = roleOf(d);
    if (role !== "NONE") {
      risk += role === "SECOND" ? 5 : 9;
      drivers.push(`holds the ${role.toLowerCase()} bar role`);
    }
    if ((p?.exhaustion ?? 0) >= 0.65) {
      risk -= 8;
      drivers.push("exhausted");
    }

    risk = clamp(risk);
    return {
      digit: d,
      frequency: p?.fast ?? 0,
      baseline: p?.baseline ?? 0.1,
      pressure,
      velocity,
      acceleration,
      streak,
      recentAppearances,
      burstCount,
      longestBurst: longestRun(digits, d),
      continuationAfterBurst: behaviour.continuation,
      continuationN: behaviour.n,
      historicalDamage: behaviour.damage,
      role,
      risk: Math.round(risk),
      state: stateOf(risk),
      drivers,
    };
  });

  rows.sort((a, b) => b.risk - a.risk);
  const worst = rows[0]?.risk ?? 0;
  const breadth = rows.filter((r) => r.risk >= 50).length;
  const losingDigitExposureScore = Math.round(
    clamp(worst * 0.72 + (rows.length ? (breadth / rows.length) * 100 : 0) * 0.28),
  );
  const bursting = rows.filter((r) => r.burstCount >= 2).map((r) => r.digit);

  const alerts = rows
    .filter((r) => r.risk >= 55)
    .map(
      (r) =>
        `LOSING DIGIT ${r.digit} is ${r.state} for ${contractLabel} — ${r.drivers.slice(0, 3).join(", ")}.`,
    );

  return {
    contract: contractLabel,
    losers,
    digits: rows,
    losingDigitRisk: worst,
    losingDigitExposure: losingDigitExposureScore,
    state: stateOf(losingDigitExposureScore),
    bursting,
    alerts,
    summary: rows.length
      ? `Losing digits ${losers.join("/")} — worst ${rows[0].digit} at ${rows[0].risk}/100, aggregate exposure ${losingDigitExposureScore}/100${bursting.length ? `, bursting: ${bursting.join(", ")}` : ""}.`
      : "No losing digits identified.",
  };
}

// ── Memoised exposure results ────────────────────────────────────────────
// Exposure is recomputed for every contract on every ranking pass. The inputs
// only change when new ticks arrive, so results are cached by a deterministic
// signature of the immutable inputs.
const exposureCache = new Map<
  string,
  { intel: DigitIntel | null; bars: BarStructure | null; value: ExposureReport }
>();
let exposureHits = 0;
let exposureMisses = 0;

function exposureKey(
  digits: number[],
  winners: number[],
  contractLabel: string,
): string {
  const last = digits.length ? digits[digits.length - 1] : -1;
  const prev = digits.length > 1 ? digits[digits.length - 2] : -1;
  return `${contractLabel}|${winners.join("")}|${digits.length}|${last}|${prev}`;
}

export function losingDigitExposure(
  digits: number[],
  winners: number[],
  intel: DigitIntel | null,
  bars: BarStructure | null,
  contractLabel: string,
): ExposureReport {
  const key = exposureKey(digits, winners, contractLabel);
  const hit = exposureCache.get(key);
  if (hit && hit.intel === intel && hit.bars === bars) {
    exposureHits++;
    return hit.value;
  }
  exposureMisses++;
  const value = computeLosingDigitExposure(digits, winners, intel, bars, contractLabel);
  if (exposureCache.size > 512) exposureCache.clear();
  exposureCache.set(key, { intel, bars, value });
  return value;
}

export function exposureCacheStats() {
  return { hits: exposureHits, misses: exposureMisses, entries: exposureCache.size };
}

export function resetExposureCache() {
  exposureCache.clear();
  exposureHits = 0;
  exposureMisses = 0;
}
