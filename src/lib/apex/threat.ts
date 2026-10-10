// APEX SENTINEL — LOSING DIGIT THREAT ENGINE.
// For any contract the digits split into a winning group and a losing group.
// This engine asks the question a raw hit rate can never answer:
// "are the losing digits becoming dangerous right now?"
import type { DigitIntel, DigitProfile } from "./digit-intel";

export type ThreatState = "LOW" | "WATCH" | "ELEVATED" | "HIGH" | "CRITICAL";
export type RecurrenceState = "NONE" | "WATCH" | "ACTIVE" | "SEVERE";

export interface DigitThreat {
  digit: number;
  score: number; // 0..100
  state: ThreatState;
  recurrence: RecurrenceState;
  recentCount: number; // appearances in the last 20 ticks
  consecutive: number;
  clusterDensity: number;
  recurrenceInterval: number;
  frequencyAcceleration: number;
  pressureAcceleration: number;
  percentile: number;
  drivers: string[];
}

export interface GroupPressure {
  /** Summed pressure (fast − baseline) across the group. */
  pressure: number;
  /** Summed pressure velocity across the group. */
  velocity: number;
  /** Summed pressure acceleration across the group. */
  acceleration: number;
  /** Current fast-window share held by the group. */
  share: number;
  /** Long-run baseline share of the group. */
  baseline: number;
}

export interface ThreatReport {
  winners: number[];
  losers: number[];
  winning: GroupPressure;
  losing: GroupPressure;
  /** −1..1 — positive means winner mass is gaining relative to loser mass. */
  asymmetry: number;
  threats: DigitThreat[]; // one per losing digit, worst first
  /** Worst single losing-digit threat, 0..100. */
  maxThreat: number;
  /** Group threat blending the worst digit with breadth of simultaneous rises. */
  groupThreat: number;
  state: ThreatState;
  recurrence: RecurrenceState;
  /** How many losing digits are simultaneously increasing. */
  risingLosers: number[];
  alerts: string[];
}

const clamp01to100 = (x: number) => Math.max(0, Math.min(100, x));

function stateOf(score: number): ThreatState {
  if (score >= 80) return "CRITICAL";
  if (score >= 62) return "HIGH";
  if (score >= 45) return "ELEVATED";
  if (score >= 28) return "WATCH";
  return "LOW";
}

function groupPressure(profiles: DigitProfile[], group: number[]): GroupPressure {
  let pressure = 0;
  let velocity = 0;
  let acceleration = 0;
  let share = 0;
  let baseline = 0;
  for (const d of group) {
    const p = profiles[d];
    pressure += p.pressure;
    velocity += p.pressureVelocity;
    acceleration += p.pressureAcceleration;
    share += p.fast;
    baseline += p.baseline;
  }
  return { pressure, velocity, acceleration, share, baseline };
}

function recurrenceOf(t: {
  recentCount: number;
  consecutive: number;
  clusterDensity: number;
  recurrenceInterval: number;
  frequencyAcceleration: number;
}): RecurrenceState {
  let hits = 0;
  if (t.clusterDensity >= 1.8) hits++;
  if (t.consecutive >= 2) hits++;
  if (t.recurrenceInterval > 0 && t.recurrenceInterval <= 6.5) hits++;
  if (t.frequencyAcceleration > 0.02) hits++;
  if (t.recentCount >= 4) hits++;
  if (hits >= 4) return "SEVERE";
  if (hits === 3) return "ACTIVE";
  if (hits === 2) return "WATCH";
  return "NONE";
}

export function losingDigitThreat(
  intel: DigitIntel,
  digits: number[],
  winners: number[],
  contractLabel: string,
): ThreatReport {
  const winSet = new Set(winners);
  const losers: number[] = [];
  for (let d = 0; d < 10; d++) if (!winSet.has(d)) losers.push(d);

  const last20 = digits.slice(Math.max(0, digits.length - 20));
  const threats: DigitThreat[] = losers.map((d) => {
    const p = intel.profiles[d];
    let recentCount = 0;
    for (const x of last20) if (x === d) recentCount++;

    const drivers: string[] = [];
    let score = 0;

    const freqComponent = clamp01to100(p.pressure * 900);
    if (freqComponent > 8)
      drivers.push(
        `share ${(p.fast * 100).toFixed(1)}% vs baseline ${(p.baseline * 100).toFixed(1)}%`,
      );
    score += freqComponent * 0.24;

    const velComponent = clamp01to100(p.pressureVelocity * 900);
    if (velComponent > 10) drivers.push("pressure rising across windows");
    score += velComponent * 0.16;

    const accComponent = clamp01to100(p.pressureAcceleration * 1100);
    if (accComponent > 10) drivers.push("pressure accelerating");
    score += accComponent * 0.14;

    const clusterComponent = clamp01to100((p.clusterDensity - 1) * 34);
    if (p.clusterDensity >= 1.8) drivers.push(`clustered ${recentCount}× in last 20`);
    score += clusterComponent * 0.14;

    const recurComponent =
      p.recurrenceInterval > 0 ? clamp01to100((10 - p.recurrenceInterval) * 11) : 0;
    if (p.recurrenceInterval > 0 && p.recurrenceInterval < 8)
      drivers.push(`recurring every ${p.recurrenceInterval.toFixed(1)} ticks vs 10 expected`);
    score += recurComponent * 0.12;

    const consecComponent = clamp01to100(p.consecutive * 26);
    if (p.consecutive >= 2) drivers.push(`${p.consecutive} consecutive appearances`);
    score += consecComponent * 0.06;

    const percentileComponent = clamp01to100((p.historicalPercentile - 50) * 2);
    if (p.historicalPercentile > 85)
      drivers.push(
        `concentration in the ${p.historicalPercentile.toFixed(0)}th percentile of its own history`,
      );
    score += percentileComponent * 0.06;

    const transitionComponent =
      p.transitionInflow >= 0 ? clamp01to100((p.transitionInflow - 0.1) * 500) : 0;
    if (transitionComponent > 20) drivers.push("transition chain feeds this digit next");
    score += transitionComponent * 0.05;

    const anomalyComponent = p.anomaly;
    score += anomalyComponent * 0.03;

    // Exhaustion is the one thing that reduces threat.
    score -= p.exhaustion * 14;

    const final = clamp01to100(score);
    const recurrence = recurrenceOf({
      recentCount,
      consecutive: p.consecutive,
      clusterDensity: p.clusterDensity,
      recurrenceInterval: p.recurrenceInterval,
      frequencyAcceleration: p.frequencyAcceleration,
    });

    return {
      digit: d,
      score: final,
      state: stateOf(final),
      recurrence,
      recentCount,
      consecutive: p.consecutive,
      clusterDensity: p.clusterDensity,
      recurrenceInterval: p.recurrenceInterval,
      frequencyAcceleration: p.frequencyAcceleration,
      pressureAcceleration: p.pressureAcceleration,
      percentile: p.historicalPercentile,
      drivers,
    };
  });

  threats.sort((a, b) => b.score - a.score);

  const winning = groupPressure(intel.profiles, winners);
  const losing = groupPressure(intel.profiles, losers);
  const asymmetry = Math.max(-1, Math.min(1, (winning.pressure - losing.pressure) * 12));

  const risingLosers = losers.filter((d) => intel.profiles[d].momentum > 8);
  const maxThreat = threats.length ? threats[0].score : 0;
  const breadth = losers.length ? risingLosers.length / losers.length : 0;
  const meanThreat = threats.length ? threats.reduce((a, t) => a + t.score, 0) / threats.length : 0;
  const groupThreat = clamp01to100(maxThreat * 0.55 + meanThreat * 0.25 + breadth * 100 * 0.2);

  const recurrenceRank: RecurrenceState[] = ["NONE", "WATCH", "ACTIVE", "SEVERE"];
  const recurrence = threats.reduce<RecurrenceState>(
    (worst, t) =>
      recurrenceRank.indexOf(t.recurrence) > recurrenceRank.indexOf(worst) ? t.recurrence : worst,
    "NONE",
  );

  const alerts: string[] = [];
  for (const t of threats) {
    if (t.recurrence === "SEVERE" || t.recurrence === "ACTIVE") {
      alerts.push(
        `Digit ${t.digit} is repeatedly entering the losing side of ${contractLabel} (${t.recentCount} of the last 20 ticks, recurrence ${t.recurrence}).`,
      );
    } else if (t.pressureAcceleration > 0.012) {
      alerts.push(`Digit ${t.digit} pressure is accelerating against ${contractLabel}.`);
    }
  }
  if (risingLosers.length >= 3) {
    alerts.push(
      `${risingLosers.length} losing-side digits (${risingLosers.join(", ")}) are simultaneously increasing.`,
    );
  }
  if (losing.velocity > 0.012 && winning.velocity <= 0) {
    alerts.push(
      "Current contract edge is weakening because losing-side pressure has accelerated while winning-side pressure has not.",
    );
  }

  return {
    winners,
    losers,
    winning,
    losing,
    asymmetry,
    threats,
    maxThreat,
    groupThreat,
    state: stateOf(groupThreat),
    recurrence,
    risingLosers,
    alerts: alerts.slice(0, 5),
  };
}
