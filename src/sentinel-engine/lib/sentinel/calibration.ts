// APEX SENTINEL — ENGINE #3: CALIBRATION ENGINE.
//
// Purpose:
// Convert Sentinel's raw score into an empirically meaningful estimated win
// probability using realized trade outcomes and Isotonic Regression (PAVA).
//
// Core principles:
//   • Never assume Score 80 = 80% Win Probability.
//   • Isotonic Regression ensures monotonicity (higher score => non-decreasing win rate)
//     without imposing rigid parametric shapes.
//   • Conservative fallback when sample size is insufficient.
//   • Tracks Brier score and Expected Calibration Error (ECE).
//   • Downstream of analytical engines — never distorts underlying statistics.

export type CalibrationMethod = "ISOTONIC" | "PLATT" | "CONSERVATIVE_FALLBACK";

export type ReliabilityState = "CALIBRATED" | "PROVISIONAL" | "INSUFFICIENT CALIBRATION DATA";

export interface CalibrationBin {
  binRange: [number, number];
  label: string;
  count: number;
  meanPredicted: number;
  realizedWinRate: number;
  brierContribution: number;
}

export interface CalibrationResult {
  rawScore: number;
  /** Estimated empirical win probability (0..1). */
  calibratedProbability: number;
  theoreticalBaseline: number;
  sampleSize: number;
  method: CalibrationMethod;
  reliabilityState: ReliabilityState;
  market: string;
  contract: string;
  regime: string | null;
  /** Brier score: lower is better (0 is perfect calibration and sharpness). */
  brierScore: number | null;
  /** Expected Calibration Error across score bins (0..1). */
  calibrationError: number | null;
  reliabilityBins: CalibrationBin[];
  summary: string;
}

export interface HistoricalOutcome {
  score: number;
  win: boolean;
  market?: string;
  contract?: string;
  regime?: string;
  at?: number;
}

const MIN_CALIBRATION_SAMPLES = 25;
const PROVISIONAL_SAMPLES = 10;

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * Pool Adjacent Violators Algorithm (PAVA) for isotonic regression.
 * Fits a non-decreasing step function mapping score -> empirical probability.
 */
export function fitIsotonicRegression(data: { x: number; y: number; weight?: number }[]): {
  thresholds: number[];
  probabilities: number[];
} {
  if (!data.length) return { thresholds: [], probabilities: [] };

  // Sort by x ascending
  const sorted = [...data].sort((a, b) => a.x - b.x);

  interface Block {
    xMin: number;
    xMax: number;
    sumY: number;
    sumW: number;
    mean: number;
  }

  const blocks: Block[] = [];

  for (const pt of sorted) {
    const w = pt.weight ?? 1;
    let curr: Block = {
      xMin: pt.x,
      xMax: pt.x,
      sumY: pt.y * w,
      sumW: w,
      mean: pt.y,
    };

    while (blocks.length > 0) {
      const prev = blocks[blocks.length - 1];
      if (prev.mean <= curr.mean) {
        break;
      }
      // Pool violators
      blocks.pop();
      curr = {
        xMin: prev.xMin,
        xMax: curr.xMax,
        sumY: prev.sumY + curr.sumY,
        sumW: prev.sumW + curr.sumW,
        mean: (prev.sumY + curr.sumY) / (prev.sumW + curr.sumW),
      };
    }
    blocks.push(curr);
  }

  const thresholds = blocks.map((b) => b.xMax);
  const probabilities = blocks.map((b) => clamp(b.mean, 0.01, 0.99));

  return { thresholds, probabilities };
}

/**
 * Compute Expected Calibration Error and Brier score.
 */
export function computeCalibrationMetrics(
  outcomes: HistoricalOutcome[],
  theoretical: number = 0.5,
): {
  brierScore: number | null;
  ece: number | null;
  bins: CalibrationBin[];
} {
  if (outcomes.length < 5) {
    return { brierScore: null, ece: null, bins: [] };
  }

  // 5 score bins: 0-40, 40-55, 55-70, 70-85, 85-100
  const binDefs: [number, number][] = [
    [0, 40],
    [40, 55],
    [55, 70],
    [70, 85],
    [85, 100],
  ];

  let totalBrier = 0;
  let weightedEce = 0;
  const bins: CalibrationBin[] = [];

  for (const [lo, hi] of binDefs) {
    const inBin = outcomes.filter(
      (o) => o.score >= lo && (hi === 100 ? o.score <= hi : o.score < hi),
    );
    const count = inBin.length;
    if (count === 0) {
      bins.push({
        binRange: [lo, hi],
        label: `${lo}–${hi}`,
        count: 0,
        meanPredicted: (lo + hi) / 200,
        realizedWinRate: theoretical,
        brierContribution: 0,
      });
      continue;
    }

    const wins = inBin.filter((o) => o.win).length;
    const realized = wins / count;
    const meanPred = inBin.reduce((a, b) => a + b.score / 100, 0) / count;
    const diff = Math.abs(meanPred - realized);

    weightedEce += diff * (count / outcomes.length);

    let binBrier = 0;
    for (const o of inBin) {
      const pred = o.score / 100;
      const actual = o.win ? 1 : 0;
      const term = (pred - actual) * (pred - actual);
      binBrier += term;
      totalBrier += term;
    }

    bins.push({
      binRange: [lo, hi],
      label: `${lo}–${hi}`,
      count,
      meanPredicted: Math.round(meanPred * 100) / 100,
      realizedWinRate: Math.round(realized * 100) / 100,
      brierContribution: Math.round((binBrier / count) * 1000) / 1000,
    });
  }

  return {
    brierScore: Math.round((totalBrier / outcomes.length) * 1000) / 1000,
    ece: Math.round(weightedEce * 1000) / 1000,
    bins,
  };
}

/**
 * Calibrate a raw Sentinel opportunity score into an empirical win probability.
 */
export function calibrateScore(
  rawScore: number,
  historicalOutcomes: HistoricalOutcome[],
  context: {
    symbol?: string;
    contract?: string;
    regime?: string | null;
    theoreticalBaseline?: number;
  } = {},
): CalibrationResult {
  const symbol = context.symbol ?? "GLOBAL";
  const contract = context.contract ?? "CONTRACT";
  const regime = context.regime ?? null;
  const theoretical = context.theoreticalBaseline ?? 0.5;

  const n = historicalOutcomes.length;

  if (n < PROVISIONAL_SAMPLES) {
    // Insufficient sample: Conservative smooth mapping to contract baseline
    // Blend score gently around theoretical without false precision
    const conservativeProb = clamp(
      theoretical + ((rawScore - 50) / 50) * 0.15,
      Math.max(0.05, theoretical - 0.2),
      Math.min(0.95, theoretical + 0.2),
    );

    return {
      rawScore,
      calibratedProbability: Math.round(conservativeProb * 1000) / 1000,
      theoreticalBaseline: theoretical,
      sampleSize: n,
      method: "CONSERVATIVE_FALLBACK",
      reliabilityState: "INSUFFICIENT CALIBRATION DATA",
      market: symbol,
      contract,
      regime,
      brierScore: null,
      calibrationError: null,
      reliabilityBins: [],
      summary: `Score ${rawScore} calibrated as ${(conservativeProb * 100).toFixed(1)}% (INSUFFICIENT CALIBRATION DATA, N=${n} < ${PROVISIONAL_SAMPLES})`,
    };
  }

  // Filter or weight outcomes matching market/contract/regime if available
  const matching = historicalOutcomes.filter((o) => {
    let match = true;
    if (context.symbol && o.market && o.market !== context.symbol) match = false;
    if (context.contract && o.contract && o.contract !== context.contract) match = false;
    return match;
  });

  const dataset = matching.length >= PROVISIONAL_SAMPLES ? matching : historicalOutcomes;
  const metrics = computeCalibrationMetrics(dataset, theoretical);

  const pavaData = dataset.map((o) => ({
    x: o.score,
    y: o.win ? 1.0 : 0.0,
  }));

  const { thresholds, probabilities } = fitIsotonicRegression(pavaData);

  // Evaluate rawScore on the fitted step function
  let calibratedProb = theoretical;
  if (thresholds.length > 0) {
    let found = false;
    for (let i = 0; i < thresholds.length; i++) {
      if (rawScore <= thresholds[i]) {
        calibratedProb = probabilities[i];
        found = true;
        break;
      }
    }
    if (!found) {
      calibratedProb = probabilities[probabilities.length - 1];
    }
  }

  // Shrinkage towards theoretical for smaller sample sizes
  const shrinkageFactor = Math.min(1.0, dataset.length / 80);
  const finalProb =
    Math.round((calibratedProb * shrinkageFactor + theoretical * (1 - shrinkageFactor)) * 1000) /
    1000;

  const reliabilityState: ReliabilityState =
    dataset.length >= MIN_CALIBRATION_SAMPLES ? "CALIBRATED" : "PROVISIONAL";
  const method: CalibrationMethod = "ISOTONIC";

  return {
    rawScore,
    calibratedProbability: finalProb,
    theoreticalBaseline: theoretical,
    sampleSize: dataset.length,
    method,
    reliabilityState,
    market: symbol,
    contract,
    regime,
    brierScore: metrics.brierScore,
    calibrationError: metrics.ece,
    reliabilityBins: metrics.bins,
    summary: `Score ${rawScore} -> Calibrated Win Prob: ${(finalProb * 100).toFixed(1)}% (${reliabilityState}, N=${dataset.length}, ECE=${metrics.ece !== null ? (metrics.ece * 100).toFixed(1) + "%" : "N/A"})`,
  };
}
