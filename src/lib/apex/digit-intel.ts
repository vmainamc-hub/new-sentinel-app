// APEX SENTINEL — per-digit intelligence.
// Reasoning starts at the individual digit, never at a contract percentage.
// Every metric here is computed from observed ticks only; sample sizes are
// carried through so the layers above can refuse to act on thin data.

export const MULTI_WINDOWS = [10, 20, 50, 100, 150, 200, 250, 500, 1000, 5000] as const;
export type MultiWindow = (typeof MULTI_WINDOWS)[number];

export type DigitTrendState = "STABLE" | "ACCELERATING" | "EXHAUSTING" | "ANOMALOUS" | "REVERSING";

export interface DigitProfile {
  digit: number;
  /** Share of ticks in each multi-window (0..1). Index-aligned to MULTI_WINDOWS. */
  windowShare: number[];
  /** Sample size actually available for each window. */
  windowN: number[];
  /** Long-horizon baseline share (largest window with usable sample). */
  baseline: number;
  /** Share over the fast window (50). */
  fast: number;
  /** Share over the medium window (200). */
  medium: number;
  frequencyVelocity: number; // fast − medium (share per tick-window)
  frequencyAcceleration: number;
  pressure: number; // fast − baseline
  pressureVelocity: number;
  pressureAcceleration: number;
  consecutive: number; // consecutive appearances ending at the last tick
  clusterDensity: number; // observed / expected count in the last 20 ticks
  recurrenceInterval: number; // mean gap between appearances (recent 250)
  expectedInterval: number; // 10 for a uniform digit
  sinceSeen: number;
  /** Percentile of the current fast share against its own rolling history. */
  historicalPercentile: number;
  /** P(next = d | last digit) from the observed first-order chain, or −1. */
  transitionInflow: number;
  exhaustion: number; // 0..1
  recovery: number; // 0..1
  anomaly: number; // 0..100, |z| of the fast share against baseline
  state: DigitTrendState;
  /** Composite "rising" score used for the increasing / decreasing rankings. */
  momentum: number; // −100..100
}

export interface DigitIntel {
  n: number;
  profiles: DigitProfile[];
  increasing: number[]; // digits ordered by momentum, strongest first
  decreasing: number[];
  lastDigit: number;
}

function tailArr(a: number[], n: number): number[] {
  return a.length <= n ? a : a.slice(a.length - n);
}

/** Slice a window that ends `offset` ticks before the newest tick. */
function segment(digits: number[], offset: number, length: number): number[] {
  const end = digits.length - offset;
  const start = Math.max(0, end - length);
  return end <= 0 ? [] : digits.slice(start, end);
}

function shareOf(seg: number[], d: number): number {
  if (!seg.length) return 0;
  let c = 0;
  for (const x of seg) if (x === d) c++;
  return c / seg.length;
}

function percentileOf(values: number[], v: number): number {
  if (!values.length) return 50;
  let below = 0;
  for (const x of values) if (x <= v) below++;
  return (below / values.length) * 100;
}

export function digitIntelligence(digits: number[], nextDist?: number[]): DigitIntel {
  const n = digits.length;
  const profiles: DigitProfile[] = [];

  // Rolling 50-tick shares sampled across the long buffer — the empirical
  // distribution a digit's current concentration is compared against.
  const rollingSamples: number[][] = Array.from({ length: 10 }, () => []);
  const step = 25;
  for (let end = 50; end <= n; end += step) {
    const seg = digits.slice(end - 50, end);
    for (let d = 0; d < 10; d++) rollingSamples[d].push(shareOf(seg, d));
  }

  const fastSeg = tailArr(digits, 50);
  const medSeg = tailArr(digits, 200);
  const prevFast = segment(digits, 50, 50);
  const prevFast2 = segment(digits, 100, 50);
  const prevMed = segment(digits, 200, 200);
  const last20 = tailArr(digits, 20);
  const gapSeg = tailArr(digits, 250);
  const baseSeg = tailArr(digits, 5000);

  for (let d = 0; d < 10; d++) {
    const windowShare: number[] = [];
    const windowN: number[] = [];
    for (const w of MULTI_WINDOWS) {
      const seg = tailArr(digits, w);
      windowShare.push(shareOf(seg, d));
      windowN.push(seg.length);
    }

    const baseline = shareOf(baseSeg, d);
    const fast = shareOf(fastSeg, d);
    const medium = shareOf(medSeg, d);
    const fastPrev = shareOf(prevFast, d);
    const fastPrev2 = shareOf(prevFast2, d);
    const mediumPrev = shareOf(prevMed, d);

    const frequencyVelocity = fast - medium;
    const frequencyAcceleration = fast - fastPrev - (fastPrev - fastPrev2);

    const pressure = fast - baseline;
    const pressurePrev = fastPrev - baseline;
    const pressurePrev2 = fastPrev2 - baseline;
    const pressureVelocity = pressure - pressurePrev;
    const pressureAcceleration = pressureVelocity - (pressurePrev - pressurePrev2);

    let consecutive = 0;
    for (let i = digits.length - 1; i >= 0 && digits[i] === d; i--) consecutive++;

    let c20 = 0;
    for (const x of last20) if (x === d) c20++;
    const clusterDensity = last20.length ? c20 / (last20.length * 0.1) : 0;

    // Recurrence: mean gap between appearances in the recent window.
    let lastIdx = -1;
    let gapSum = 0;
    let gapCnt = 0;
    for (let i = 0; i < gapSeg.length; i++) {
      if (gapSeg[i] !== d) continue;
      if (lastIdx >= 0) {
        gapSum += i - lastIdx;
        gapCnt++;
      }
      lastIdx = i;
    }
    const recurrenceInterval = gapCnt ? gapSum / gapCnt : gapSeg.length || 0;
    let sinceSeen = 0;
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === d) break;
      sinceSeen++;
    }

    const historicalPercentile = percentileOf(rollingSamples[d], fast);

    // Anomaly: z of the fast-window share against the long-run baseline.
    const p0 = baseline > 0 ? baseline : 0.1;
    const se = Math.sqrt((p0 * (1 - p0)) / Math.max(1, fastSeg.length));
    const z = se > 0 ? (fast - p0) / se : 0;
    const anomaly = Math.min(100, Math.abs(z) * 26);

    const exhaustion = Math.max(0, Math.min(1, (mediumPrev - baseline) * 8 + (medium - fast) * 6));
    const recovery = Math.max(0, Math.min(1, (baseline - mediumPrev) * 8 + (fast - medium) * 6));

    const momentum = Math.max(
      -100,
      Math.min(
        100,
        frequencyVelocity * 380 +
          pressureVelocity * 260 +
          pressureAcceleration * 160 +
          (clusterDensity - 1) * 9 +
          (recurrenceInterval > 0 ? (10 - recurrenceInterval) * 2.2 : 0),
      ),
    );

    let state: DigitTrendState = "STABLE";
    if (anomaly > 70) state = "ANOMALOUS";
    else if (pressure > 0.015 && pressureAcceleration > 0.004) state = "ACCELERATING";
    else if (mediumPrev - baseline > 0.012 && frequencyVelocity < -0.008) state = "EXHAUSTING";
    else if (
      Math.sign(frequencyVelocity) !== 0 &&
      Math.sign(frequencyVelocity) !== Math.sign(pressurePrev) &&
      Math.abs(frequencyVelocity) > 0.012
    )
      state = "REVERSING";

    profiles.push({
      digit: d,
      windowShare,
      windowN,
      baseline,
      fast,
      medium,
      frequencyVelocity,
      frequencyAcceleration,
      pressure,
      pressureVelocity,
      pressureAcceleration,
      consecutive,
      clusterDensity,
      recurrenceInterval,
      expectedInterval: 10,
      sinceSeen,
      historicalPercentile,
      transitionInflow: nextDist ? nextDist[d] : -1,
      exhaustion,
      recovery,
      anomaly,
      state,
      momentum,
    });
  }

  const byMomentum = [...profiles].sort((a, b) => b.momentum - a.momentum);
  return {
    n,
    profiles,
    increasing: byMomentum.filter((p) => p.momentum > 4).map((p) => p.digit),
    decreasing: [...byMomentum]
      .reverse()
      .filter((p) => p.momentum < -4)
      .map((p) => p.digit),
    lastDigit: n ? digits[n - 1] : -1,
  };
}
