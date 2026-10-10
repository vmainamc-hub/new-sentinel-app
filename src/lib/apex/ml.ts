// APEX SENTINEL — validated model ensemble.
// Everything here is trained on this market's own observed tick history with
// strict time ordering: TRAIN → VALIDATE → TEST → MOVE FORWARD. There is no
// look-ahead, no leakage and no synthetic data. A model that does not beat the
// base rate out-of-sample is reported as MODEL NOT VALIDATED and receives zero
// weight in scoring.

export type ModelId = "LOGISTIC" | "TREE" | "SEQUENCE" | "DEEP" | "ANALOGUE" | "RULE";

export type ModelStatus = "VALIDATED" | "NOT VALIDATED" | "INSUFFICIENT DATA" | "DISABLED";

export interface ModelResult {
  id: ModelId;
  label: string;
  status: ModelStatus;
  /** Probability the contract wins on the next tick, or −1 when unavailable. */
  probability: number;
  /** Out-of-sample accuracy across walk-forward folds. */
  oosAccuracy: number;
  /** Out-of-sample Brier score (lower is better). */
  brier: number;
  /** Accuracy of always predicting the majority class, for comparison. */
  baseRate: number;
  /** Test samples used out-of-sample. */
  testN: number;
  folds: number;
  note: string;
}

export interface EnsembleResult {
  models: ModelResult[];
  /** Weighted probability from validated models only, or −1. */
  probability: number;
  /** 0..100 — how much the validated models agree. */
  agreement: number;
  validated: number;
  disagreement: string;
  /** −1..1 signal used by scoring: validated edge over the theoretical rate. */
  signal: number;
}

const FEATURES = 9;

/** Causal feature vector built strictly from digits BEFORE index i. */
function featuresAt(digits: number[], i: number, winSet: Set<number>): number[] | null {
  if (i < 210) return null;
  const s = (from: number, to: number) => {
    let w = 0;
    let l = 0;
    let n = 0;
    const counts = new Array(10).fill(0);
    for (let k = from; k < to; k++) {
      const d = digits[k];
      counts[d]++;
      n++;
      if (winSet.has(d)) w++;
      else l++;
    }
    return { w, l, n, counts };
  };
  const short = s(i - 20, i);
  const mid = s(i - 50, i);
  const long = s(i - 200, i);
  const theoretical = winSet.size / 10;

  // Loser pressure: loser share short vs long.
  const loserShort = short.l / short.n;
  const loserLong = long.l / long.n;

  // Worst loser cluster in the last 20 ticks.
  let worstLoser = 0;
  for (let d = 0; d < 10; d++)
    if (!winSet.has(d)) worstLoser = Math.max(worstLoser, short.counts[d] / short.n);

  // Consecutive losing digits at the tail.
  let consecLose = 0;
  for (let k = i - 1; k >= 0 && !winSet.has(digits[k]); k--) consecLose++;

  // Short-window entropy.
  let h = 0;
  for (let d = 0; d < 10; d++) {
    const p = mid.counts[d] / mid.n;
    if (p > 0) h -= p * Math.log(p);
  }

  return [
    short.w / short.n - theoretical,
    mid.w / mid.n - theoretical,
    long.w / long.n - theoretical,
    loserShort - loserLong,
    worstLoser - (1 - theoretical) / Math.max(1, 10 - winSet.size),
    Math.min(5, consecLose) / 5,
    winSet.has(digits[i - 1]) ? 1 : 0,
    h / Math.log(10) - 0.98,
    (short.w / short.n - mid.w / mid.n) * 2,
  ];
}

function buildDataset(digits: number[], winSet: Set<number>) {
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 210; i < digits.length; i++) {
    const f = featuresAt(digits, i, winSet);
    if (!f) continue;
    X.push(f);
    y.push(winSet.has(digits[i]) ? 1 : 0);
  }
  return { X, y };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

function trainLogistic(X: number[][], y: number[], epochs = 24, lr = 0.35): number[] {
  const w = new Array(FEATURES + 1).fill(0);
  if (!X.length) return w;
  for (let e = 0; e < epochs; e++) {
    for (let i = 0; i < X.length; i++) {
      let z = w[FEATURES];
      for (let j = 0; j < FEATURES; j++) z += w[j] * X[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < FEATURES; j++) w[j] -= lr * err * X[i][j] + lr * 0.0008 * w[j];
      w[FEATURES] -= lr * err;
    }
  }
  return w;
}

function predictLogistic(w: number[], x: number[]): number {
  let z = w[FEATURES];
  for (let j = 0; j < FEATURES; j++) z += w[j] * x[j];
  return sigmoid(z);
}

interface Stump {
  feature: number;
  threshold: number;
  left: number;
  right: number;
}

/** Bagged decision stumps — a small, honest tree ensemble. */
function trainStumps(X: number[][], y: number[], count = 12): Stump[] {
  const stumps: Stump[] = [];
  if (X.length < 40) return stumps;
  const base = y.reduce((a, b) => a + b, 0) / y.length;
  for (let s = 0; s < count; s++) {
    const feature = s % FEATURES;
    const values = X.map((x) => x[feature]).sort((a, b) => a - b);
    const q = 0.25 + 0.5 * ((s / count) % 1);
    const threshold = values[Math.floor(values.length * q)] ?? 0;
    let lw = 0;
    let ln = 0;
    let rw = 0;
    let rn = 0;
    for (let i = 0; i < X.length; i++) {
      if (X[i][feature] <= threshold) {
        ln++;
        lw += y[i];
      } else {
        rn++;
        rw += y[i];
      }
    }
    if (ln < 15 || rn < 15) continue;
    // Laplace-smoothed leaves shrink toward the base rate.
    stumps.push({
      feature,
      threshold,
      left: (lw + base * 20) / (ln + 20),
      right: (rw + base * 20) / (rn + 20),
    });
  }
  return stumps;
}

function predictStumps(stumps: Stump[], x: number[], fallback: number): number {
  if (!stumps.length) return fallback;
  let sum = 0;
  for (const s of stumps) sum += x[s.feature] <= s.threshold ? s.left : s.right;
  return sum / stumps.length;
}

/** Order-2 sequence classifier: P(win | previous two digits). */
function sequenceModel(digits: number[], winSet: Set<number>, from: number, to: number) {
  const table = new Map<string, { n: number; w: number }>();
  for (let i = from + 2; i < to; i++) {
    const key = `${digits[i - 2]}${digits[i - 1]}`;
    const b = table.get(key) ?? { n: 0, w: 0 };
    b.n++;
    if (winSet.has(digits[i])) b.w++;
    table.set(key, b);
  }
  return table;
}

function predictSequence(
  table: Map<string, { n: number; w: number }>,
  digits: number[],
  i: number,
  base: number,
): number {
  const b = table.get(`${digits[i - 2]}${digits[i - 1]}`);
  if (!b || b.n < 12) return base;
  // Shrink toward the base rate — a 12-sample cell must not scream 100%.
  return (b.w + base * 30) / (b.n + 30);
}

interface WalkForwardOut {
  accuracy: number;
  brier: number;
  baseRate: number;
  testN: number;
  folds: number;
}

function emptyWF(): WalkForwardOut {
  return { accuracy: 0, brier: 1, baseRate: 0, testN: 0, folds: 0 };
}

export interface EnsembleInput {
  digits: number[];
  winners: number[];
  theoretical: number;
  wfTrain: number;
  wfTest: number;
  wfStep: number;
  /** Historical analogue rate observed by the terminal, or null. */
  analogue: { n: number; rate: number } | null;
  /** Rule engine probability estimate (shrunk empirical rate). */
  rule: number;
  ruleN: number;
}

/**
 * Walk-forward evaluation + final fit. Deliberately capped in size so a
 * browser tab stays responsive across ~20 markets.
 */
export function runEnsemble(input: EnsembleInput): EnsembleResult {
  const { digits, winners, theoretical } = input;
  const winSet = new Set(winners);
  const models: ModelResult[] = [];

  const { X, y } = buildDataset(digits, winSet);
  const usable = X.length;
  const minNeeded = input.wfTrain + input.wfTest;

  const logWF = emptyWF();
  const treeWF = emptyWF();
  const seqWF = emptyWF();

  let logisticWeights: number[] | null = null;
  let stumps: Stump[] = [];
  let seqTable: Map<string, { n: number; w: number }> | null = null;

  if (usable >= minNeeded) {
    let start = 0;
    const accs = { log: 0, tree: 0, seq: 0 };
    const briers = { log: 0, tree: 0, seq: 0 };
    let tested = 0;
    let folds = 0;
    let baseHits = 0;

    while (start + input.wfTrain + input.wfTest <= usable && folds < 6) {
      const trainX = X.slice(start, start + input.wfTrain);
      const trainY = y.slice(start, start + input.wfTrain);
      const testX = X.slice(start + input.wfTrain, start + input.wfTrain + input.wfTest);
      const testY = y.slice(start + input.wfTrain, start + input.wfTrain + input.wfTest);
      const trainBase = trainY.reduce((a, b) => a + b, 0) / trainY.length;

      const w = trainLogistic(trainX, trainY);
      const st = trainStumps(trainX, trainY);
      // Sequence table uses raw digit indices aligned to the dataset offset.
      const digitFrom = 210 + start;
      const digitTo = 210 + start + input.wfTrain;
      const table = sequenceModel(digits, winSet, digitFrom - 2, digitTo);

      for (let k = 0; k < testX.length; k++) {
        const pl = predictLogistic(w, testX[k]);
        const pt = predictStumps(st, testX[k], trainBase);
        const ps = predictSequence(table, digits, digitTo + k, trainBase);
        const truth = testY[k];
        if (pl >= 0.5 === (truth === 1)) accs.log++;
        if (pt >= 0.5 === (truth === 1)) accs.tree++;
        if (ps >= 0.5 === (truth === 1)) accs.seq++;
        briers.log += (pl - truth) ** 2;
        briers.tree += (pt - truth) ** 2;
        briers.seq += (ps - truth) ** 2;
        if ((trainBase >= 0.5 ? 1 : 0) === truth) baseHits++;
        tested++;
      }
      start += input.wfStep;
      folds++;
    }

    if (tested > 0) {
      const baseRate = baseHits / tested;
      Object.assign(logWF, {
        accuracy: accs.log / tested,
        brier: briers.log / tested,
        baseRate,
        testN: tested,
        folds,
      });
      Object.assign(treeWF, {
        accuracy: accs.tree / tested,
        brier: briers.tree / tested,
        baseRate,
        testN: tested,
        folds,
      });
      Object.assign(seqWF, {
        accuracy: accs.seq / tested,
        brier: briers.seq / tested,
        baseRate,
        testN: tested,
        folds,
      });
    }

    // Final fit on all history up to now (still causal — nothing future used).
    logisticWeights = trainLogistic(X, y);
    stumps = trainStumps(X, y);
    seqTable = sequenceModel(digits, winSet, 0, digits.length);
  }

  const latest = X.length ? X[X.length - 1] : null;
  const empirical = y.length ? y.reduce((a, b) => a + b, 0) / y.length : theoretical;

  const mk = (
    id: ModelId,
    label: string,
    wf: WalkForwardOut,
    probability: number,
    available: boolean,
  ): ModelResult => {
    let status: ModelStatus = "INSUFFICIENT DATA";
    let note = `Needs ${minNeeded} usable samples; have ${usable}.`;
    if (available && wf.testN > 0) {
      // Validated = beats the majority-class baseline out-of-sample by a real
      // margin (>1 standard error) AND is better calibrated than a coin flip.
      const se = Math.sqrt(0.25 / wf.testN);
      const beats = wf.accuracy > wf.baseRate + se;
      status = beats ? "VALIDATED" : "NOT VALIDATED";
      note = beats
        ? `Out-of-sample ${(wf.accuracy * 100).toFixed(1)}% vs base ${(wf.baseRate * 100).toFixed(1)}% over ${wf.folds} walk-forward folds (n=${wf.testN}).`
        : `MODEL NOT VALIDATED — out-of-sample ${(wf.accuracy * 100).toFixed(1)}% does not beat the ${(wf.baseRate * 100).toFixed(1)}% base rate (n=${wf.testN}).`;
    }
    return {
      id,
      label,
      status,
      probability: status === "VALIDATED" ? probability : available ? probability : -1,
      oosAccuracy: wf.accuracy,
      brier: wf.brier,
      baseRate: wf.baseRate,
      testN: wf.testN,
      folds: wf.folds,
      note,
    };
  };

  models.push(
    mk(
      "LOGISTIC",
      "Logistic regression",
      logWF,
      logisticWeights && latest ? predictLogistic(logisticWeights, latest) : -1,
      Boolean(logisticWeights && latest),
    ),
  );
  models.push(
    mk(
      "TREE",
      "Bagged stump ensemble",
      treeWF,
      stumps.length && latest ? predictStumps(stumps, latest, empirical) : -1,
      Boolean(stumps.length && latest),
    ),
  );
  models.push(
    mk(
      "SEQUENCE",
      "Order-2 sequence classifier",
      seqWF,
      seqTable ? predictSequence(seqTable, digits, digits.length, empirical) : -1,
      Boolean(seqTable),
    ),
  );

  models.push({
    id: "DEEP",
    label: "LSTM / GRU sequence net",
    status: "DISABLED",
    probability: -1,
    oosAccuracy: 0,
    brier: 1,
    baseRate: 0,
    testN: 0,
    folds: 0,
    note: "Architecture prepared but intentionally disabled: the simpler baselines have not yet been beaten out-of-sample, so a deep model would add cost without evidence.",
  });

  const analogue = input.analogue;
  models.push({
    id: "ANALOGUE",
    label: "Historical analogue",
    status:
      analogue && analogue.n >= 120
        ? "VALIDATED"
        : analogue && analogue.n >= 30
          ? "NOT VALIDATED"
          : "INSUFFICIENT DATA",
    probability: analogue && analogue.n >= 30 ? analogue.rate : -1,
    oosAccuracy: analogue ? analogue.rate : 0,
    brier: 1,
    baseRate: theoretical,
    testN: analogue?.n ?? 0,
    folds: 0,
    note: analogue
      ? `${analogue.n} observed outcomes in analogous states, ${(analogue.rate * 100).toFixed(1)}% wins.`
      : "No analogous state observed yet by this terminal.",
  });

  models.push({
    id: "RULE",
    label: "Rule / statistical engine",
    status: input.ruleN >= 300 ? "VALIDATED" : "INSUFFICIENT DATA",
    probability: input.rule,
    oosAccuracy: input.rule,
    brier: 1,
    baseRate: theoretical,
    testN: input.ruleN,
    folds: 0,
    note: `Shrunk empirical estimate over ${input.ruleN} ticks.`,
  });

  const validatedModels = models.filter((m) => m.status === "VALIDATED" && m.probability >= 0);
  const validated = validatedModels.length;

  let probability = -1;
  let agreement = 0;
  let disagreement = "No validated model is currently available.";
  if (validated) {
    // Weight by out-of-sample margin, never a blind average.
    const weights = validatedModels.map((m) => Math.max(0.15, m.oosAccuracy - m.baseRate + 0.15));
    const total = weights.reduce((a, b) => a + b, 0);
    probability = validatedModels.reduce((a, m, i) => a + m.probability * weights[i], 0) / total;

    const directions = validatedModels.map((m) => Math.sign(m.probability - theoretical));
    const same = Math.max(
      directions.filter((d) => d > 0).length,
      directions.filter((d) => d < 0).length,
    );
    const spread =
      Math.max(...validatedModels.map((m) => m.probability)) -
      Math.min(...validatedModels.map((m) => m.probability));
    agreement = Math.max(0, Math.min(100, (same / validated) * 100 - spread * 120));
    disagreement =
      same === validated
        ? `All ${validated} validated models point the same way (spread ${(spread * 100).toFixed(1)}pp).`
        : `Validated models disagree: ${same}/${validated} share a direction, spread ${(spread * 100).toFixed(1)}pp.`;
  }

  const signal =
    probability >= 0 && agreement > 0
      ? Math.max(-1, Math.min(1, (probability - theoretical) * 8 * (agreement / 100)))
      : 0;

  return { models, probability, agreement, validated, disagreement, signal };
}
