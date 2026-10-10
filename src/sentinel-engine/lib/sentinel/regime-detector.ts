// APEX SENTINEL — ENGINE #1: REGIME / CHANGEPOINT ENGINE.
//
// Purpose:
// Detect when current digit behaviour has materially changed from the previous
// regime using a statistical changepoint approach (CUSUM + Page-Hinkley test
// on digit frequencies and distribution divergence).
//
// Non-destructive:
// Does NOT erase historical learning. Instead:
//   • Assigns a unique, stable regimeId to each detected regime epoch.
//   • Computes discount factors so stale evidence from old regimes does not
//     dominate the new regime.
//   • Preserves historical evidence for multi-regime analysis.

export type RegimeChangeState = "STABLE" | "WATCH" | "TRANSITION" | "REGIME_CHANGE" | "UNSTABLE";

export interface RegimeDetectorOptions {
  symbol?: string;
  /** Reference window for baseline distribution (default 500). */
  baselineWindow?: number;
  /** Test window for current behaviour (default 100). */
  testWindow?: number;
  /** CUSUM threshold delta (magnitude of change to detect, default 0.04). */
  cusumDelta?: number;
  /** CUSUM decision threshold h for changepoint (default 5.0). */
  cusumThreshold?: number;
  /** Page-Hinkley threshold lambda (default 15.0). */
  pageHinkleyThreshold?: number;
}

export interface RegimeReport {
  symbol: string;
  /** Unique regime epoch identifier: e.g. "R_100:epoch-3:BALANCED" */
  regimeId: string;
  /** Epoch sequence index (increments on confirmed regime change). */
  epoch: number;
  state: RegimeChangeState;
  /** CUSUM / Page-Hinkley change score (0..100). */
  changeScore: number;
  /** Raw Page-Hinkley / CUSUM statistic. */
  testStatistic: number;
  detectedAtTick: number;
  /** Digits exhibiting the strongest statistical shift. */
  affectedDigits: number[];
  previousRegime: string | null;
  currentRegime: string;
  confidence: number;
  /** 0..1 weight to apply to evidence from previous regimes. */
  discountFactor: number;
  /** True when a confirmed regime shift mandates discounting old evidence. */
  shouldDiscountOldEvidence: boolean;
  reasons: string[];
  summary: string;
}

interface SymbolCusumState {
  epoch: number;
  regimeId: string;
  previousRegime: string | null;
  currentRegime: string;
  lastChangepointTick: number;
  cusumPos: number[];
  cusumNeg: number[];
  phSum: number;
  phMin: number;
  lastTickCount: number;
}

const symbolStateMap = new Map<string, SymbolCusumState>();

export function resetRegimeDetectorMemory(): void {
  symbolStateMap.clear();
}

export function resetRegimeState(symbol?: string): void {
  if (symbol) {
    symbolStateMap.delete(symbol);
  } else {
    symbolStateMap.clear();
  }
}

/**
 * Compute digit frequencies (0..1) for a slice.
 */
function digitDist(digits: number[]): number[] {
  const dist = new Array(10).fill(0);
  if (!digits.length) return dist.map(() => 0.1);
  for (const d of digits) {
    if (d >= 0 && d <= 9) dist[d]++;
  }
  return dist.map((c) => c / digits.length);
}

/**
 * Total Variation Distance between two distributions (0..1).
 */
function totalVariation(p: number[], q: number[]): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Math.abs(p[i] - q[i]);
  }
  return sum / 2;
}

/**
 * Detect regime and statistical changepoint on the causal digit buffer.
 */
export function detectRegimeChange(
  digits: number[],
  options: RegimeDetectorOptions = {},
): RegimeReport {
  const symbol = options.symbol ?? "GLOBAL";
  const baselineWindow = options.baselineWindow ?? 500;
  const testWindow = options.testWindow ?? 100;
  const cusumDelta = options.cusumDelta ?? 0.035;
  const cusumThreshold = options.cusumThreshold ?? 4.0;
  const phThreshold = options.pageHinkleyThreshold ?? 12.0;

  const n = digits.length;
  if (n < 60) {
    return {
      symbol,
      regimeId: `${symbol}:epoch-0:INITIALISING`,
      epoch: 0,
      state: "STABLE",
      changeScore: 0,
      testStatistic: 0,
      detectedAtTick: n,
      affectedDigits: [],
      previousRegime: null,
      currentRegime: "INITIALISING",
      confidence: 30,
      discountFactor: 1.0,
      shouldDiscountOldEvidence: false,
      reasons: ["Insufficient tick history to compute changepoints."],
      summary: "Regime detector initialising (insufficient history).",
    };
  }

  // Baseline window vs Recent test window
  const baseSlice = digits.slice(-Math.min(n, baselineWindow), -Math.min(n, testWindow));
  const recentSlice = digits.slice(-Math.min(n, testWindow));

  const baseFreq = baseSlice.length ? digitDist(baseSlice) : new Array(10).fill(0.1);
  const recentFreq = digitDist(recentSlice);

  // Measure per-digit shift
  const shifts: { digit: number; diff: number; absDiff: number }[] = [];
  for (let d = 0; d < 10; d++) {
    const diff = recentFreq[d] - baseFreq[d];
    shifts.push({ digit: d, diff, absDiff: Math.abs(diff) });
  }
  shifts.sort((a, b) => b.absDiff - a.absDiff);

  const affectedDigits = shifts.filter((s) => s.absDiff >= 0.03).map((s) => s.digit);
  const tv = totalVariation(baseFreq, recentFreq);

  // Retrieve or initialise per-symbol tracking state
  let state = symbolStateMap.get(symbol);
  if (!state) {
    state = {
      epoch: 1,
      regimeId: `${symbol}:epoch-1:BALANCED`,
      previousRegime: null,
      currentRegime: "BALANCED",
      lastChangepointTick: 0,
      cusumPos: new Array(10).fill(0),
      cusumNeg: new Array(10).fill(0),
      phSum: 0,
      phMin: 0,
      lastTickCount: n,
    };
    symbolStateMap.set(symbol, state);
  }

  // Update CUSUM and Page-Hinkley statistics on recent shifts
  let maxCusum = 0;
  for (let d = 0; d < 10; d++) {
    const diff = recentFreq[d] - baseFreq[d];
    state.cusumPos[d] = Math.max(0, state.cusumPos[d] + diff - cusumDelta);
    state.cusumNeg[d] = Math.max(0, state.cusumNeg[d] - diff - cusumDelta);
    maxCusum = Math.max(maxCusum, state.cusumPos[d], state.cusumNeg[d]);
  }

  // Page-Hinkley update on total variation
  const meanTv = 0.06;
  const phSample = tv - meanTv;
  state.phSum += phSample;
  if (state.phSum < state.phMin) {
    state.phMin = state.phSum;
  }
  const phStat = state.phSum - state.phMin;

  const combinedStat = maxCusum * 1.5 + phStat;
  const changeScore = Math.min(100, Math.round((combinedStat / phThreshold) * 60 + tv * 200));

  // Determine structural regime label from distribution characteristics
  const maxFreq = Math.max(...recentFreq);
  const minFreq = Math.min(...recentFreq);
  const freqSpread = maxFreq - minFreq;

  let label = "BALANCED";
  if (freqSpread > 0.12) {
    label = "SKEWED";
  } else if (tv > 0.14) {
    label = "TRANSITIONING";
  } else if (maxFreq < 0.13 && minFreq > 0.07) {
    label = "COMPRESSED";
  } else if (combinedStat > phThreshold * 1.5) {
    label = "CHAOTIC";
  }

  // State classification
  let regimeState: RegimeChangeState = "STABLE";
  const reasons: string[] = [];

  const isConfirmedChangepoint =
    combinedStat >= phThreshold || maxCusum >= cusumThreshold || tv >= 0.18;
  const isTransitioning = combinedStat >= phThreshold * 0.65 || tv >= 0.12;
  const isWatch = combinedStat >= phThreshold * 0.4 || tv >= 0.08;

  if (isConfirmedChangepoint) {
    if (label !== state.currentRegime || n - state.lastChangepointTick > 150) {
      state.epoch += 1;
      state.previousRegime = state.currentRegime;
      state.currentRegime = label;
      state.regimeId = `${symbol}:epoch-${state.epoch}:${label}`;
      state.lastChangepointTick = n;
      // Reset detectors post changepoint
      state.cusumPos.fill(0);
      state.cusumNeg.fill(0);
      state.phSum = 0;
      state.phMin = 0;
      regimeState = "REGIME_CHANGE";
      reasons.push(
        `Changepoint confirmed (statistic ${combinedStat.toFixed(2)} ≥ threshold ${phThreshold}). Shifted from ${state.previousRegime} to ${state.currentRegime}.`,
      );
    } else {
      regimeState = "UNSTABLE";
      reasons.push(`High distribution variance sustained in ${label} regime.`);
    }
  } else if (isTransitioning) {
    regimeState = "TRANSITION";
    reasons.push(
      `Distribution undergoing active transition (TV distance ${(tv * 100).toFixed(1)}%).`,
    );
  } else if (isWatch) {
    regimeState = "WATCH";
    reasons.push(`Distribution drift under observation (change score ${changeScore}/100).`);
  } else {
    regimeState = "STABLE";
    reasons.push(
      `Distribution stable in ${state.currentRegime} regime (TV distance ${(tv * 100).toFixed(1)}%).`,
    );
  }

  if (affectedDigits.length) {
    reasons.push(`Top shifting digits: ${affectedDigits.join(", ")}.`);
  }

  // Compute evidence discount factor:
  // When in a confirmed REGIME_CHANGE or UNSTABLE state, old regime evidence is discounted.
  let discountFactor = 1.0;
  let shouldDiscountOldEvidence = false;

  if (regimeState === "REGIME_CHANGE") {
    discountFactor = 0.25;
    shouldDiscountOldEvidence = true;
  } else if (regimeState === "TRANSITION" || regimeState === "UNSTABLE") {
    discountFactor = 0.55;
    shouldDiscountOldEvidence = true;
  } else if (regimeState === "WATCH") {
    discountFactor = 0.85;
    shouldDiscountOldEvidence = false;
  } else {
    discountFactor = 1.0;
    shouldDiscountOldEvidence = false;
  }

  const confidence = Math.min(
    100,
    Math.max(30, Math.round(100 - (changeScore > 50 ? (changeScore - 50) * 1.2 : 0))),
  );

  const summary = `Regime ${state.currentRegime} (epoch ${state.epoch}) · State: ${regimeState} · Change Score: ${changeScore}/100 · Discount: ${(discountFactor * 100).toFixed(0)}%`;

  return {
    symbol,
    regimeId: state.regimeId,
    epoch: state.epoch,
    state: regimeState,
    changeScore,
    testStatistic: Math.round(combinedStat * 100) / 100,
    detectedAtTick: n,
    affectedDigits,
    previousRegime: state.previousRegime,
    currentRegime: state.currentRegime,
    confidence,
    discountFactor,
    shouldDiscountOldEvidence,
    reasons,
    summary,
  };
}

/**
 * Calculates discounting weight for historical evidence given the evidence's regime ID
 * and the currently active regime ID.
 */
export function computeRegimeDiscount(
  evidenceRegimeId: string | null | undefined,
  currentRegimeId: string,
  baseDiscount: number = 0.4,
): number {
  if (!evidenceRegimeId || evidenceRegimeId === "UNKNOWN") return 0.8;
  if (evidenceRegimeId === currentRegimeId) return 1.0;
  return Math.max(0.1, Math.min(1.0, baseDiscount));
}
