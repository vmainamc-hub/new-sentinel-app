// SENTINEL — PROPOSITION-AWARE DIGIT LIQUIDITY SWEEP / EXHAUSTION OBSERVER.
//
// Deriv digit markets do not expose a conventional order book to Sentinel, so
// this engine does NOT claim to observe literal resting liquidity. It observes
// the measurable analogue available in the tick stream: concentration in the
// contract's losing/contrary digit zone, its peak, its exhaustion/release, and
// the subsequent transition toward the winning zone.
//
// A sweep is CONFIRMED only after the transition has actually appeared in the
// observed tick history. A high losing-side concentration by itself is never a
// sweep. This is deliberately proposition-aware: UNDER 7 and OVER 6 inspect
// opposite zones and their own boundary digits.

export type LiquiditySweepState =
  | "INSUFFICIENT"
  | "BUILDING"
  | "EXHAUSTION"
  | "TRANSITION"
  | "CONFIRMED";

export interface LiquiditySweepObservation {
  state: LiquiditySweepState;
  confirmed: boolean;
  side: "OVER" | "UNDER";
  barrier: number;
  opposingDigits: number[];
  boundaryDigit: number;
  winningDigits: number[];
  observedTicks: number;
  buildConcentration: number;
  peakConcentration: number;
  postConcentration: number;
  concentrationReleasePp: number;
  boundaryPeakPct: number;
  boundaryPostPct: number;
  boundaryReleasePp: number;
  winningPeakPct: number;
  winningPostPct: number;
  winningAdvancePp: number;
  peakOffset: number | null;
  peakWindowSize: number;
  releaseWindowSize: number;
  observedBuild: boolean;
  observedExhaustion: boolean;
  observedRelease: boolean;
  observedBoundaryWeakening: boolean;
  observedWinningTransition: boolean;
  score: number;
  summary: string;
  reason: string;
}

const MIN_TICKS = 60;
const BUILD_WINDOW = 30;
const PEAK_WINDOW = 15;
const RELEASE_WINDOW = 15;
const MIN_BUILD_DELTA_PP = 1.5;
const MIN_RELEASE_PP = 2.0;
const MIN_BOUNDARY_RELEASE_PP = 0.5;
const MIN_WINNING_ADVANCE_PP = 1.0;

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));

function pctIn(digits: readonly number[], set: readonly number[]): number {
  if (!digits.length) return 0;
  const wanted = new Set(set);
  return (digits.filter((d) => wanted.has(d)).length / digits.length) * 100;
}

function sideDigits(side: "OVER" | "UNDER", barrier: number) {
  const all = Array.from({ length: 10 }, (_, d) => d);
  const winningDigits = side === "OVER" ? all.filter((d) => d > barrier) : all.filter((d) => d < barrier);
  const opposingDigits = all.filter((d) => !winningDigits.includes(d));
  return {
    winningDigits,
    opposingDigits,
    boundaryDigit: barrier,
  };
}

/**
 * Observe whether a real concentration → peak → exhaustion → release →
 * directional transition has occurred in the supplied causal tick history.
 */
export function observeLiquiditySweep(
  digits: readonly number[],
  side: "OVER" | "UNDER",
  barrier: number,
): LiquiditySweepObservation {
  const { winningDigits, opposingDigits, boundaryDigit } = sideDigits(side, barrier);
  const usable = digits.filter((d) => Number.isInteger(d) && d >= 0 && d <= 9).slice(-120);
  const base = {
    state: "INSUFFICIENT" as LiquiditySweepState,
    confirmed: false,
    side,
    barrier,
    opposingDigits,
    boundaryDigit,
    winningDigits,
    observedTicks: usable.length,
    buildConcentration: 0,
    peakConcentration: 0,
    postConcentration: 0,
    concentrationReleasePp: 0,
    boundaryPeakPct: 0,
    boundaryPostPct: 0,
    boundaryReleasePp: 0,
    winningPeakPct: 0,
    winningPostPct: 0,
    winningAdvancePp: 0,
    peakOffset: null as number | null,
    peakWindowSize: PEAK_WINDOW,
    releaseWindowSize: RELEASE_WINDOW,
    observedBuild: false,
    observedExhaustion: false,
    observedRelease: false,
    observedBoundaryWeakening: false,
    observedWinningTransition: false,
    score: 0,
    summary: "",
    reason: "",
  };

  if (usable.length < MIN_TICKS) {
    return {
      ...base,
      summary: `Liquidity transition insufficient — ${usable.length}/${MIN_TICKS} ticks observed.`,
      reason: "Not enough causal tick history to observe build → exhaustion → release → transition.",
    };
  }

  // The final RELEASE window is fixed to the most recent ticks. We search the
  // preceding history for the strongest opposing concentration peak that was
  // preceded by a build window. This makes CONFIRMED a historical observation,
  // not a forward prediction.
  const releaseStart = usable.length - RELEASE_WINDOW;
  const release = usable.slice(releaseStart);
  let best: {
    peakStart: number;
    buildStart: number;
    build: number;
    peak: number;
    boundaryPeak: number;
    winningPeak: number;
  } | null = null;

  const earliestPeak = BUILD_WINDOW;
  const latestPeak = releaseStart - PEAK_WINDOW;
  for (let peakStart = earliestPeak; peakStart <= latestPeak; peakStart += 1) {
    const buildSlice = usable.slice(peakStart - BUILD_WINDOW, peakStart);
    const peakSlice = usable.slice(peakStart, peakStart + PEAK_WINDOW);
    const build = pctIn(buildSlice, opposingDigits);
    const peak = pctIn(peakSlice, opposingDigits);
    if (peak < build + MIN_BUILD_DELTA_PP) continue;
    if (!best || peak > best.peak) {
      best = {
        peakStart,
        buildStart: peakStart - BUILD_WINDOW,
        build,
        peak,
        boundaryPeak: pctIn(peakSlice, [boundaryDigit]),
        winningPeak: pctIn(peakSlice, winningDigits),
      };
    }
  }

  if (!best) {
    const recentOpposing = pctIn(usable.slice(-PEAK_WINDOW), opposingDigits);
    const priorOpposing = pctIn(usable.slice(-PEAK_WINDOW * 2, -PEAK_WINDOW), opposingDigits);
    const building = recentOpposing > priorOpposing + 0.5;
    return {
      ...base,
      state: building ? "BUILDING" : "EXHAUSTION",
      buildConcentration: priorOpposing,
      peakConcentration: recentOpposing,
      postConcentration: recentOpposing,
      observedBuild: building,
      score: building ? 25 : 35,
      summary: building
        ? `Opposing concentration is still building (${recentOpposing.toFixed(1)}% vs ${priorOpposing.toFixed(1)}%). No sweep observed.`
        : `No qualifying opposing-side concentration peak followed by release was observed in the retained history.`,
      reason: "A sweep requires a measurable opposing concentration peak before the release window.",
    };
  }

  const postConcentration = pctIn(release, opposingDigits);
  const boundaryPostPct = pctIn(release, [boundaryDigit]);
  const winningPostPct = pctIn(release, winningDigits);
  const concentrationReleasePp = best.peak - postConcentration;
  const boundaryReleasePp = best.boundaryPeak - boundaryPostPct;
  const winningAdvancePp = winningPostPct - best.winningPeak;

  const observedBuild = best.peak >= best.build + MIN_BUILD_DELTA_PP;
  const observedExhaustion = best.peak > postConcentration;
  const observedRelease = concentrationReleasePp >= MIN_RELEASE_PP;
  const observedBoundaryWeakening = boundaryReleasePp >= MIN_BOUNDARY_RELEASE_PP;
  const observedWinningTransition = winningAdvancePp >= MIN_WINNING_ADVANCE_PP;

  const confirmations = [
    observedBuild,
    observedExhaustion,
    observedRelease,
    observedBoundaryWeakening,
    observedWinningTransition,
  ].filter(Boolean).length;

  const score = Math.round(
    (observedBuild ? 20 : 0) +
      Math.min(25, Math.max(0, concentrationReleasePp) * 5) +
      Math.min(20, Math.max(0, boundaryReleasePp) * 10) +
      Math.min(25, Math.max(0, winningAdvancePp) * 5) +
      (observedExhaustion ? 10 : 0),
  );

  const confirmed =
    observedBuild &&
    observedExhaustion &&
    observedRelease &&
    observedBoundaryWeakening &&
    observedWinningTransition;

  const state: LiquiditySweepState = confirmed
    ? "CONFIRMED"
    : observedRelease && (observedBoundaryWeakening || observedWinningTransition)
      ? "TRANSITION"
      : observedExhaustion
        ? "EXHAUSTION"
        : "BUILDING";

  const summary = confirmed
    ? `${side} ${barrier}: CONFIRMED sweep — opposing concentration peaked at ${best.peak.toFixed(1)}%, released ${concentrationReleasePp.toFixed(1)}pp, boundary weakened ${boundaryReleasePp.toFixed(1)}pp, winning zone advanced ${winningAdvancePp.toFixed(1)}pp.`
    : `${side} ${barrier}: ${state} — ${confirmations}/5 sweep observations confirmed; opposing concentration ${best.peak.toFixed(1)}% → ${postConcentration.toFixed(1)}%.`;

  return {
    ...base,
    state,
    confirmed,
    buildConcentration: best.build,
    peakConcentration: best.peak,
    postConcentration,
    concentrationReleasePp,
    boundaryPeakPct: best.boundaryPeak,
    boundaryPostPct,
    boundaryReleasePp,
    winningPeakPct: best.winningPeak,
    winningPostPct,
    winningAdvancePp,
    peakOffset: best.peakStart,
    observedBuild,
    observedExhaustion,
    observedRelease,
    observedBoundaryWeakening,
    observedWinningTransition,
    score: clamp(score),
    summary,
    reason: confirmed
      ? "The retained tick history contains the required concentration → peak → exhaustion → release → winning-zone transition."
      : "The required historical transition is incomplete; this candidate must not pass the sweep hard veto.",
  };
}
