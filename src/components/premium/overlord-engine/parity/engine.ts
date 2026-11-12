// Precision Parity AI — reasoning engine.
// Multiple specialist engines cooperate; the Decision Engine gates output.
// No engine may fire recommendations alone. NO_TRADE is a valid outcome.

import { lastDigit, type Tick } from "@/lib/analytics";
import type {
  AnalystReview,
  BarSnapshot,
  DBotPlan,
  DigitPsychology,
  EdgeStability,
  Evidence,
  ExecutionPlan,
  HiddenRegime,
  HypothesisEvaluation,
  MarketParityReport,
  MarketPhase,
  MarketRegime,
  MaturityState,
  ParityContract,
  RiskReview,
  SecondOrderMatrix,
  TransitionMatrix,
  WindowStat,
} from "./types";
import { analyseStructural, resetStructuralMemory, type StructuralReport } from "./structural";
import { runIntelligencePanel } from "./analysts";
import type { IntelligencePanel } from "./types";
import {
  runForecastEngine,
  recordAnalogueOutcome,
  resetForecastMemory,
  type ForecastReport,
  type MarketState,
} from "./forecast";
import { runDeepReasoning, recordFingerprintOutcome, type DeepReasoning } from "./deep-reasoning";


const WINDOWS = [20, 50, 100, 200, 500, 1000] as const;
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const parityOf = (d: number): "EVEN" | "ODD" => (d % 2 === 0 ? "EVEN" : "ODD");

// Per-market session memory (parity history + prior recommendations).
interface SessionMemory {
  ticksSeen: number;
  priorRegimes: MarketRegime[];
  priorHidden: HiddenRegime[];
  snapshots: Array<{
    evenPct: number;
    entropy: number;
    pEE: number;
    pOO: number;
    regime: MarketRegime;
    contract: ParityContract;
  }>;
  currentContract: ParityContract | null;
  currentPersistence: number;
  currentMaturity: MaturityState;
  createdAt: number;
  // Adaptive learning: per-engine weight (0.2..1.8) that evolves with realized outcomes.
  // Each engine emits evidence; when the next tick's parity confirms/denies the winning
  // hypothesis, the engines that supported the correct side are strengthened and those
  // that supported the wrong side are weakened. Green/Red bar are engines just like the
  // rest — they are NOT hard-coded to a parity.
  engineWeights: Record<string, number>;
  lastPrediction: {
    contract: ParityContract;
    supports: Array<{ engine: string; contract: ParityContract | "NEUTRAL" }>;
    conflicts: Array<{ engine: string; contract: ParityContract | "NEUTRAL" }>;
  } | null;
  // Rolling realized win-rate of Precision Parity's own recommendations (self-audit).
  realized: { wins: number; losses: number };
}

// Additional adaptive state — kept off SessionMemory's original shape via
// a parallel WeakMap-style record so we don't break existing callers.
interface AdaptiveState {
  // Persistent Bayesian belief that the NEXT tick is EVEN (0..1).
  // Updated tick-by-tick from live likelihoods; never hard-reset.
  bayesEven: number;
  // Kalman-filtered estimate of even-share (smoothed evenPct).
  kalmanMean: number;
  kalmanVar: number;
  // Pattern DNA: n-gram (length 4) of parities → outcome tallies.
  //   key = "EEOE" -> { even: count-of-times-next-was-EVEN, odd: ... }
  patterns: Map<string, { even: number; odd: number }>;
  // Rolling co-occurrence of the current green/red bar's parity with the
  // NEXT tick's parity. Used to learn whether the green bar predicts its own
  // parity, its opposite, or nothing — instead of hard-coding an assumption.
  greenCorr: { same: number; opp: number };
  redCorr:   { same: number; opp: number };
  // The bar-parity that was in force when we recorded the last prediction.
  lastGreenParity: "EVEN" | "ODD" | null;
  lastRedParity:   "EVEN" | "ODD" | null;
  lastNgram: string | null;
}
const ADAPT = new Map<string, AdaptiveState>();
function getAdapt(market: string): AdaptiveState {
  const e = ADAPT.get(market);
  if (e) return e;
  const a: AdaptiveState = {
    bayesEven: 0.5,
    kalmanMean: 0.5,
    kalmanVar: 0.01,
    patterns: new Map(),
    greenCorr: { same: 0, opp: 0 },
    redCorr:   { same: 0, opp: 0 },
    lastGreenParity: null,
    lastRedParity: null,
    lastNgram: null,
  };
  ADAPT.set(market, a);
  return a;
}


const MEMORY = new Map<string, SessionMemory>();

// ──────────────────────────────────────────────────────────────────────────
// Case-study priors — real observed DBot outcomes we teach the analyst up-front.
// These bias per-market engine weights and rolling win/loss counters so the
// panel starts with lived experience rather than a blank slate.
//   • 1HZ25V (Volatility 25 (1s)) — BUY ODD signal (ODD bias + Markov 58%,
//     Green d1 ODD, Red d0 EVEN, hot digit 1 ODD, entropy HIGH) delivered
//     5 consecutive wins. Reinforce those engines on that market.
//   • R_100 (Volatility 100 Index) — BUY EVEN signal (Green d6 EVEN, Red d2
//     EVEN, hot 6 EVEN, rolling posterior 84%, filtered 61% EVEN, entropy
//     VERY_HIGH) delivered 6 consecutive losses. Weaken those engines on
//     that market and remember that VERY_HIGH entropy has historically
//     invalidated bar-driven EVEN conviction here.
// ──────────────────────────────────────────────────────────────────────────
const CASE_STUDY_PRIORS: Record<string, {
  wins: number;
  losses: number;
  reinforce: Record<string, number>;
}> = {
  "1HZ25V": {
    wins: 5,
    losses: 0,
    reinforce: {
      Statistics: +0.35,
      Markov: +0.30,
      "Higher-Order Markov": +0.15,
      "Green Bar": +0.25,
      "Red Bar": +0.20,
      "Digit Psychology": +0.25,
      Bayesian: +0.15,
    },
  },
  R_100: {
    wins: 0,
    losses: 6,
    reinforce: {
      "Green Bar": -0.40,
      "Red Bar": -0.35,
      "Digit Psychology": -0.30,
      Bayesian: -0.35,
      "Kalman Trend": -0.30,
      Statistics: -0.20,
      Entropy: +0.45, // trust the entropy veto more here
    },
  },
};

function seedFromCaseStudy(mem: SessionMemory, market: string) {
  const prior = CASE_STUDY_PRIORS[market];
  if (!prior) return;
  mem.realized.wins = prior.wins;
  mem.realized.losses = prior.losses;
  for (const [engine, delta] of Object.entries(prior.reinforce)) {
    const cur = mem.engineWeights[engine] ?? 1;
    mem.engineWeights[engine] = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, cur + delta));
  }
}

function getMemory(market: string): SessionMemory {
  const existing = MEMORY.get(market);
  if (existing) return existing;
  const m: SessionMemory = {
    ticksSeen: 0,
    priorRegimes: [],
    priorHidden: [],
    snapshots: [],
    currentContract: null,
    currentPersistence: 0,
    currentMaturity: "EMERGING",
    createdAt: Date.now(),
    engineWeights: {},
    lastPrediction: null,
    realized: { wins: 0, losses: 0 },
  };
  seedFromCaseStudy(m, market);
  MEMORY.set(market, m);
  return m;
}

// Default weight when an engine is first observed. Kept in a narrow band so a
// single lucky/unlucky sample cannot dominate the ensemble.
const WEIGHT_FLOOR = 0.2;
const WEIGHT_CEIL = 1.8;
const LEARN_RATE = 0.06;
function weightOf(mem: SessionMemory, engine: string): number {
  return mem.engineWeights[engine] ?? 1;
}
function nudgeWeight(mem: SessionMemory, engine: string, delta: number) {
  const cur = weightOf(mem, engine);
  const next = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEIL, cur + delta));
  mem.engineWeights[engine] = next;
}


export function resetParityMemory(market?: string) {
  if (market) { MEMORY.delete(market); ADAPT.delete(market); resetStructuralMemory(market); resetForecastMemory(market); FORECAST_LAST.delete(market); }
  else { MEMORY.clear(); ADAPT.clear(); resetStructuralMemory(); resetForecastMemory(); FORECAST_LAST.clear(); }
}

// Cache of the previous scan's encoded state per market — used to teach
// the Historical Analogue engine what actually followed a state we saw.
const FORECAST_LAST = new Map<string, { state: MarketState; runLength: number }>();

// ─────────────────────────────────────────────────────────────────────────
// Engine 2 — Even/Odd statistics
// ─────────────────────────────────────────────────────────────────────────
function windowStats(digits: number[], n: number): WindowStat {
  const slice = digits.slice(-n);
  const total = slice.length || 1;
  const even = slice.filter((d) => d % 2 === 0).length;
  const evenPct = even / total;
  const oddPct = 1 - evenPct;
  const entropy =
    -(evenPct > 0 ? evenPct * Math.log2(evenPct) : 0) -
    (oddPct > 0 ? oddPct * Math.log2(oddPct) : 0);
  return { n: slice.length, evenPct, oddPct, entropy };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 3 — First-order Markov across every rolling window
// ─────────────────────────────────────────────────────────────────────────
function transitionMatrix(digits: number[], window: number): TransitionMatrix {
  const slice = digits.slice(-window);
  let ee = 0, eo = 0, oe = 0, oo = 0;
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1] % 2, b = slice[i] % 2;
    if (a === 0 && b === 0) ee++;
    else if (a === 0 && b === 1) eo++;
    else if (a === 1 && b === 0) oe++;
    else oo++;
  }
  const fromE = Math.max(1, ee + eo);
  const fromO = Math.max(1, oe + oo);
  return {
    window,
    eeCount: ee, eoCount: eo, oeCount: oe, ooCount: oo,
    pEE: ee / fromE, pEO: eo / fromE, pOE: oe / fromO, pOO: oo / fromO,
    sample: slice.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 4 — Second-order Markov (EE/EO/OE/OO -> next parity)
// ─────────────────────────────────────────────────────────────────────────
function secondOrder(digits: number[], window = 500): SecondOrderMatrix {
  const slice = digits.slice(-window);
  const parities = slice.map((d) => (d % 2 === 0 ? "E" : "O"));
  type K = "EE" | "EO" | "OE" | "OO";
  const nextEven: Record<K, number> = { EE: 0, EO: 0, OE: 0, OO: 0 };
  const total: Record<K, number> = { EE: 0, EO: 0, OE: 0, OO: 0 };
  for (let i = 2; i < parities.length; i++) {
    const key = (parities[i - 2] + parities[i - 1]) as K;
    total[key]++;
    if (parities[i] === "E") nextEven[key]++;
  }
  const pEvenAfter: Record<K, number> = {
    EE: total.EE ? nextEven.EE / total.EE : 0.5,
    EO: total.EO ? nextEven.EO / total.EO : 0.5,
    OE: total.OE ? nextEven.OE / total.OE : 0.5,
    OO: total.OO ? nextEven.OO / total.OO : 0.5,
  };
  return { window, pEvenAfter, counts: total };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 5 — Hidden regime (heuristic HMM-style classifier)
// ─────────────────────────────────────────────────────────────────────────
function hiddenRegime(w100: WindowStat, w500: WindowStat, tr: TransitionMatrix): HiddenRegime {
  const evenBias = w100.evenPct - 0.5;
  const longBias = w500.evenPct - 0.5;
  const flip = (tr.pEO + tr.pOE) / 2; // higher = alternating
  const stick = (tr.pEE + tr.pOO) / 2;
  if (flip > 0.62) return "ALTERNATING";
  if (Math.abs(evenBias) < 0.03 && Math.abs(longBias) < 0.03) return "BALANCED";
  if (evenBias > 0.06 && longBias > 0.03) return "EVEN_DOMINANCE";
  if (evenBias < -0.06 && longBias < -0.03) return "ODD_DOMINANCE";
  if (Math.sign(evenBias) !== Math.sign(longBias) && Math.abs(evenBias) > 0.04)
    return "REVERSAL_BUILDING";
  if (stick > 0.62) return "EXPANSION";
  if (w100.entropy < 0.85) return "COMPRESSION";
  return "UNCERTAIN";
}

// ─────────────────────────────────────────────────────────────────────────
// Market Structure engine — regime label
// ─────────────────────────────────────────────────────────────────────────
function marketRegime(
  digits: number[],
  w100: WindowStat,
  w500: WindowStat,
  manipulation: number,
  fluctuation: number,
): MarketRegime {
  if (manipulation > 55) return "MANIPULATED";
  if (fluctuation > 70) return "CHAOTIC";
  const drift = Math.abs(w100.evenPct - w500.evenPct);
  if (drift > 0.08) return "TRENDING";
  if (w100.entropy > 0.985 && drift < 0.02) return "STABLE";
  if (w100.entropy < 0.9) return "COMPRESSED";
  if (w100.entropy > 0.995) return "EXPANDING";
  const recent = digits.slice(-40).map((d) => d % 2);
  let flips = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i] !== recent[i - 1]) flips++;
  if (flips / Math.max(1, recent.length - 1) > 0.65) return "OSCILLATING";
  if (drift < 0.04 && w100.entropy > 0.95) return "RECOVERY";
  return "NEUTRAL";
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 8/9 — Green/Red bar intelligence
// ─────────────────────────────────────────────────────────────────────────
function digitFreq(digits: number[]): number[] {
  const f = new Array(10).fill(0);
  digits.forEach((d) => f[d]++);
  return f;
}

function barSnapshot(digits: number[], select: "max" | "min"): BarSnapshot {
  const recent = digits.slice(-100);
  const baseline = digits.slice(-500);
  const rTot = Math.max(1, recent.length);
  const bTot = Math.max(1, baseline.length);
  const rF = digitFreq(recent).map((f) => f / rTot);
  const bF = digitFreq(baseline).map((f) => f / bTot);
  let idx = 0;
  for (let d = 1; d < 10; d++) {
    if (select === "max" ? rF[d] > rF[idx] : rF[d] < rF[idx]) idx = d;
  }
  // Persistence: how many recent ticks the bar digit has held the position.
  let persistence = 0;
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 30); i--) {
    const slice = recent.slice(0, i + 1);
    const f = digitFreq(slice);
    let leader = 0;
    for (let d = 1; d < 10; d++) {
      if (select === "max" ? f[d] > f[leader] : f[d] < f[leader]) leader = d;
    }
    if (leader === idx) persistence++;
    else break;
  }
  return {
    digit: idx,
    parity: parityOf(idx),
    zone: idx <= 4 ? "LOWER" : "UPPER",
    pct: rF[idx],
    velocity: rF[idx] - bF[idx],
    persistence,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 10 — Digit psychology
// ─────────────────────────────────────────────────────────────────────────
function digitPsychology(digits: number[]): DigitPsychology {
  const recent = digits.slice(-100);
  const baseline = digits.slice(-500);
  const rTot = Math.max(1, recent.length);
  const bTot = Math.max(1, baseline.length);
  const rF = digitFreq(recent).map((f) => f / rTot);
  const bF = digitFreq(baseline).map((f) => f / bTot);
  const idxSort = (arr: number[]) => [...arr.keys()].sort((a, b) => arr[b] - arr[a]);
  const desc = idxSort(rF);
  const asc = [...desc].reverse();
  const delta = rF.map((v, d) => v - bF[d]);
  const rising = delta.indexOf(Math.max(...delta));
  const falling = delta.indexOf(Math.min(...delta));
  const rotationSpeed = clamp01(delta.reduce((a, v) => a + Math.abs(v), 0) / 2);
  const clustering = clamp01(Math.max(...rF) - 0.1);
  const zoneA = rF.slice(0, 5).reduce((a, b) => a + b, 0);
  return {
    hot: desc[0],
    cold: asc[0],
    mostAppearing: desc[0],
    secondMostAppearing: desc[1],
    leastAppearing: asc[0],
    secondLeastAppearing: asc[1],
    rising,
    falling,
    rotationSpeed,
    clustering,
    zoneA,
    zoneB: 1 - zoneA,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 12 — Manipulation & fluctuation
// ─────────────────────────────────────────────────────────────────────────
function manipulationScore(digits: number[]): { manipulation: number; fluctuation: number; crowding: number } {
  const recent = digits.slice(-200);
  const total = Math.max(1, recent.length);
  const freq = digitFreq(recent).map((f) => f / total);
  const tvd = 0.5 * freq.reduce((a, p) => a + Math.abs(p - 0.1), 0);
  const manipulation = clamp(tvd * 220);
  const crowding = clamp((Math.max(...freq) - 0.1) * 500);
  // Fluctuation: variance of rolling parity mean across chunks.
  const chunkSize = 20;
  const means: number[] = [];
  for (let i = 0; i + chunkSize <= recent.length; i += chunkSize) {
    const c = recent.slice(i, i + chunkSize);
    means.push(c.filter((d) => d % 2 === 0).length / c.length);
  }
  const mu = means.reduce((a, b) => a + b, 0) / Math.max(1, means.length);
  const variance = means.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, means.length);
  const fluctuation = clamp(variance * 900);
  return { manipulation, fluctuation, crowding };
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 7 — Historical similarity against session snapshots
// ─────────────────────────────────────────────────────────────────────────
function historicalSimilarity(
  mem: SessionMemory,
  evenPct: number,
  entropy: number,
  pEE: number,
  pOO: number,
  contract: ParityContract,
): number {
  if (mem.snapshots.length < 3) return 0.5;
  const relevant = mem.snapshots.filter((s) => s.contract === contract);
  if (relevant.length === 0) return 0.4;
  // 1 - average normalised distance in feature space.
  const dist = relevant.map((s) => {
    return (
      Math.abs(s.evenPct - evenPct) +
      Math.abs(s.entropy - entropy) * 0.5 +
      Math.abs(s.pEE - pEE) +
      Math.abs(s.pOO - pOO)
    ) / 3.5;
  });
  const avg = dist.reduce((a, b) => a + b, 0) / dist.length;
  return clamp01(1 - avg);
}

// ─────────────────────────────────────────────────────────────────────────
// Engine 15 — Decision Engine (hypothesis competition)
// ─────────────────────────────────────────────────────────────────────────
export interface ParitySettings {
  autoScan: boolean;
  refreshMs: number;
  minTicks: number;
  minConfidence: number;      // 0..100
  minEdge: number;            // minimum required margin between winning and losing hypothesis (points)
  maxManipulation: number;    // 0..100
  maxContradiction: number;   // 0..100
  minPersistenceTicks: number;
  minHoldSeconds: number;
  requireMature: boolean;
  // V3 — Future Forecast intelligence gates.
  streakLossTolerance: number;   // 0..1 — reject if composite streak-loss risk exceeds
  minForecastConfidence: number; // 0..100 — reject if ensemble forecast confidence below
  requireForecastAgreement: boolean; // require ensemble forecast to agree with hypothesis
}

export const DEFAULT_PARITY_SETTINGS: ParitySettings = {
  autoScan: true,
  refreshMs: 2000,
  minTicks: 200,
  // V6: Committee-of-experts settings — lower barriers, richer signalling.
  // The Chief Analyst weighs evidence rather than counting hard gates, so
  // the raw thresholds only need to guard against genuinely thin setups.
  minConfidence: 62,
  minEdge: 3,
  maxManipulation: 40,
  maxContradiction: 55,
  minPersistenceTicks: 3,
  minHoldSeconds: 15,
  requireMature: false,
  streakLossTolerance: 0.65,
  minForecastConfidence: 55,
  requireForecastAgreement: false,
};

function evaluateHypothesis(
  contract: ParityContract,
  args: {
    windows: Record<number, WindowStat>;
    transitions: TransitionMatrix[];
    secondOrder: SecondOrderMatrix;
    hiddenRegime: HiddenRegime;
    regime: MarketRegime;
    green: BarSnapshot;
    red: BarSnapshot;
    psy: DigitPsychology;
    manipulation: number;
    fluctuation: number;
    similarity: number;
    lastParity: "EVEN" | "ODD";
    prevParity: "EVEN" | "ODD";
    mem: SessionMemory;
    adapt: AdaptiveState;
    ngram: string;
    structural: StructuralReport;
    forecast?: ForecastReport;
    digits: number[];
  },
): HypothesisEvaluation {
  const target: "EVEN" | "ODD" = contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const supports: Evidence[] = [];
  const conflicts: Evidence[] = [];

  // 1. Multi-window dominance
  const bias = (w: WindowStat) => (target === "EVEN" ? w.evenPct - 0.5 : w.oddPct - 0.5);
  const dominance = [args.windows[100], args.windows[200], args.windows[500]]
    .map(bias)
    .reduce((a, b) => a + b, 0) / 3;
  if (dominance > 0.02) {
    supports.push({
      engine: "Statistics",
      supports: contract,
      strength: clamp01(dominance * 8),
      detail: `${target} bias +${(dominance * 100).toFixed(1)}% across 100/200/500 tick windows`,
    });
  } else if (dominance < -0.02) {
    conflicts.push({
      engine: "Statistics",
      supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
      strength: clamp01(-dominance * 8),
      detail: `${target} share is ${(dominance * 100).toFixed(1)}% below fair across rolling windows`,
    });
  }

  // 2. Markov transition continuation
  const mkContinuation = args.transitions.map((t) =>
    target === "EVEN"
      ? (args.lastParity === "EVEN" ? t.pEE : t.pOE)
      : (args.lastParity === "EVEN" ? t.pEO : t.pOO),
  );
  const avgCont = mkContinuation.reduce((a, b) => a + b, 0) / mkContinuation.length;
  if (avgCont > 0.53) {
    supports.push({
      engine: "Markov",
      supports: contract,
      strength: clamp01((avgCont - 0.5) * 10),
      detail: `Transition models show P(next=${target}) ≈ ${(avgCont * 100).toFixed(1)}% across ${args.transitions.length} horizons`,
    });
  } else if (avgCont < 0.47) {
    conflicts.push({
      engine: "Markov",
      supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
      strength: clamp01((0.5 - avgCont) * 10),
      detail: `Transition models disagree with ${target} continuation (${(avgCont * 100).toFixed(1)}%)`,
    });
  }

  // 3. Second-order Markov
  const key = (args.prevParity[0] + args.lastParity[0]) as "EE" | "EO" | "OE" | "OO";
  const soEven = args.secondOrder.pEvenAfter[key];
  const soTarget = target === "EVEN" ? soEven : 1 - soEven;
  if (soTarget > 0.55) {
    supports.push({
      engine: "Higher-Order Markov",
      supports: contract,
      strength: clamp01((soTarget - 0.5) * 6),
      detail: `Sequence ${key} historically resolves to ${target} ${(soTarget * 100).toFixed(0)}% of the time`,
    });
  } else if (soTarget < 0.45) {
    conflicts.push({
      engine: "Higher-Order Markov",
      supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
      strength: clamp01((0.5 - soTarget) * 6),
      detail: `Sequence ${key} favours the opposite parity (${((1 - soTarget) * 100).toFixed(0)}%)`,
    });
  }

  // 4. Hidden regime alignment
  const hr = args.hiddenRegime;
  const regSupport =
    (hr === "EVEN_DOMINANCE" && target === "EVEN") ||
    (hr === "ODD_DOMINANCE" && target === "ODD");
  const regConflict =
    (hr === "EVEN_DOMINANCE" && target === "ODD") ||
    (hr === "ODD_DOMINANCE" && target === "EVEN");
  if (regSupport) supports.push({ engine: "Hidden Regime", supports: contract, strength: 0.75, detail: `Hidden regime = ${hr}` });
  else if (regConflict) conflicts.push({ engine: "Hidden Regime", supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN", strength: 0.7, detail: `Hidden regime = ${hr}` });
  else if (hr === "ALTERNATING" || hr === "REVERSAL_BUILDING")
    conflicts.push({ engine: "Hidden Regime", supports: "NEUTRAL", strength: 0.5, detail: `Hidden regime = ${hr} — direction unstable` });

  // 5. Green/Red bar — treated as HYPOTHESES, not rules. The engine measures
  //    how often the green/red bar's parity has actually predicted the next
  //    tick in THIS market. If evidence is thin, the bar contributes nothing.
  const barEvidence = (
    name: "Green Bar" | "Red Bar",
    bar: BarSnapshot,
    corr: { same: number; opp: number },
  ) => {
    const n = corr.same + corr.opp;
    if (n < 15) return; // not enough learned history — stay silent
    const pSame = corr.same / n;              // P(next parity == bar parity)
    const supportsBarParity = pSame >= 0.5;
    const predictedParity: "EVEN" | "ODD" =
      supportsBarParity ? bar.parity : (bar.parity === "EVEN" ? "ODD" : "EVEN");
    const edge = Math.abs(pSame - 0.5) * 2;   // 0..1
    if (edge < 0.06) return;                  // no learned signal
    const evi: Evidence = {
      engine: name,
      supports: predictedParity === "EVEN" ? "BUY_EVEN" : "BUY_ODD",
      strength: clamp01(edge * 1.4 + Math.max(0, bar.velocity) * 2),
      detail: `${name} d${bar.digit} (${bar.parity}) → learned P(next=${predictedParity}) ${(supportsBarParity ? pSame : 1 - pSame).toFixed(2)} over ${n} samples`,
    };
    if (predictedParity === target) supports.push(evi);
    else conflicts.push(evi);
  };
  barEvidence("Green Bar", args.green, args.adapt.greenCorr);
  barEvidence("Red Bar",   args.red,   args.adapt.redCorr);

  // 5b. Hidden Accumulation — scan ALL ten digits, not just the visible
  //     Green/Red bar. Reads which digits are quietly BUILDING (rising
  //     share vs baseline) and which are LOSING, grouped by parity. This
  //     surfaces hidden market developments beneath the prima facie leader
  //     bars, as directed by the V6 psychology retraining.
  {
    const recent = args.digits.slice(-100);
    const baseline = args.digits.slice(-500);
    const rF = digitFreq(recent).map((f) => f / Math.max(1, recent.length));
    const bF = digitFreq(baseline).map((f) => f / Math.max(1, baseline.length));
    let evenBuild = 0, oddBuild = 0, evenLose = 0, oddLose = 0;
    let buildersEven = 0, buildersOdd = 0, losersEven = 0, losersOdd = 0;
    const buildingList: number[] = [];
    const losingList: number[] = [];
    for (let d = 0; d < 10; d++) {
      const delta = rF[d] - bF[d];
      const isEven = d % 2 === 0;
      if (delta > 0.005) {
        buildingList.push(d);
        if (isEven) { evenBuild += delta; buildersEven++; } else { oddBuild += delta; buildersOdd++; }
      } else if (delta < -0.005) {
        losingList.push(d);
        if (isEven) { evenLose += -delta; losersEven++; } else { oddLose += -delta; losersOdd++; }
      }
    }
    const evenNet = (evenBuild + oddLose) - (oddBuild + evenLose);
    const hiddenTarget: "EVEN" | "ODD" = evenNet > 0 ? "EVEN" : "ODD";
    const magnitude = Math.abs(evenNet);
    if (magnitude > 0.015) {
      const hiddenContract: ParityContract = hiddenTarget === "EVEN" ? "BUY_EVEN" : "BUY_ODD";
      const detail =
        `Hidden accumulation → ${hiddenTarget}: ${hiddenTarget === "EVEN" ? buildersEven : buildersOdd}/5 ${hiddenTarget.toLowerCase()} digits building (${buildingList.join(",")}), ${hiddenTarget === "EVEN" ? losersOdd : losersEven}/5 opposite-parity losing (${losingList.join(",")})`;
      const evi: Evidence = {
        engine: "Hidden Accumulation",
        supports: hiddenContract,
        strength: clamp01(magnitude * 12),
        detail,
      };
      if (hiddenContract === contract) supports.push(evi);
      else conflicts.push(evi);
    }

    // Digit-Rotation Pressure — publish a narrative even when magnitude
    // is small, so the analyst can reason about what lies beneath the bars.
    const buildersForTarget = target === "EVEN" ? buildersEven : buildersOdd;
    const losersForOpp = target === "EVEN" ? losersOdd : losersEven;
    if (buildersForTarget >= 3 && losersForOpp >= 2) {
      supports.push({
        engine: "Digit Rotation",
        supports: contract,
        strength: 0.5,
        detail: `${buildersForTarget} ${target.toLowerCase()} digits accumulating while ${losersForOpp} opposite-parity digits fade — hidden ${target} pressure beneath surface bars`,
      });
    }
  }

  // 6. Digit psychology
  const hotP = parityOf(args.psy.hot);
  const risingP = parityOf(args.psy.rising);
  if (hotP === target) supports.push({ engine: "Digit Psychology", supports: contract, strength: 0.4, detail: `Hot digit ${args.psy.hot} is ${target}` });
  else conflicts.push({ engine: "Digit Psychology", supports: hotP === "EVEN" ? "BUY_EVEN" : "BUY_ODD", strength: 0.3, detail: `Hot digit ${args.psy.hot} is ${hotP}` });
  if (risingP === target) supports.push({ engine: "Digit Psychology", supports: contract, strength: 0.4, detail: `Fastest-rising digit ${args.psy.rising} is ${target}` });

  // 7. Manipulation & fluctuation as blockers, not signals
  if (args.manipulation > 40) conflicts.push({ engine: "Manipulation", supports: "NEUTRAL", strength: clamp01(args.manipulation / 100), detail: `Distribution distorted (${args.manipulation.toFixed(0)}%)` });
  if (args.fluctuation > 55) conflicts.push({ engine: "Fluctuation", supports: "NEUTRAL", strength: clamp01(args.fluctuation / 100), detail: `Rolling parity variance high (${args.fluctuation.toFixed(0)}%)` });

  // 7b. Entropy — V6 retraining: elevated entropy is a NOTE, not a veto.
  // The screenshots show high-confidence signals published while entropy
  // was HIGH; the engine must look BENEATH the disorder for hidden edges
  // instead of treating disorder as an automatic block.
  const H100 = args.windows[100]?.entropy ?? 0;
  if (H100 >= 0.998) {
    conflicts.push({
      engine: "Entropy",
      supports: "NEUTRAL",
      strength: 0.35,
      detail: `Market entropy VERY_HIGH (H=${H100.toFixed(3)}/1.0) — disorder elevated but hidden accumulation still readable`,
    });
  } else if (H100 >= 0.985) {
    conflicts.push({
      engine: "Entropy",
      supports: "NEUTRAL",
      strength: 0.2,
      detail: `Market entropy HIGH (H=${H100.toFixed(3)}/1.0) — disorder elevated`,
    });
  }

  // 8. Historical similarity as supporting evidence, capped
  if (args.similarity > 0.6) supports.push({ engine: "Historical Similarity", supports: contract, strength: Math.min(0.4, args.similarity - 0.3), detail: `Similar past states resolved as ${target} (${(args.similarity * 100).toFixed(0)}% match)` });

  // 9. Bayesian belief (persistent tick-by-tick posterior)
  const bayesTarget = target === "EVEN" ? args.adapt.bayesEven : 1 - args.adapt.bayesEven;
  if (bayesTarget > 0.54) {
    supports.push({
      engine: "Bayesian",
      supports: contract,
      strength: clamp01((bayesTarget - 0.5) * 6),
      detail: `Rolling posterior P(next=${target}) = ${(bayesTarget * 100).toFixed(0)}% (updated every tick)`,
    });
  } else if (bayesTarget < 0.46) {
    conflicts.push({
      engine: "Bayesian",
      supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
      strength: clamp01((0.5 - bayesTarget) * 6),
      detail: `Rolling posterior gives ${target} only ${(bayesTarget * 100).toFixed(0)}%`,
    });
  }

  // 10. Kalman-filtered even-share — the underlying drift, noise removed
  const kmT = target === "EVEN" ? args.adapt.kalmanMean : 1 - args.adapt.kalmanMean;
  if (kmT > 0.53) {
    supports.push({
      engine: "Kalman Trend",
      supports: contract,
      strength: clamp01((kmT - 0.5) * 5),
      detail: `Filtered ${target} share holding at ${(kmT * 100).toFixed(1)}% after noise removal`,
    });
  }

  // 11. Pattern DNA — has this exact recent sequence resolved this way before?
  const pat = args.adapt.patterns.get(args.ngram);
  if (pat && (pat.even + pat.odd) >= 8) {
    const totalPat = pat.even + pat.odd;
    const pEvenPat = pat.even / totalPat;
    const pTargetPat = target === "EVEN" ? pEvenPat : 1 - pEvenPat;
    if (pTargetPat > 0.6) {
      supports.push({
        engine: "Pattern DNA",
        supports: contract,
        strength: clamp01((pTargetPat - 0.5) * 4),
        detail: `Sequence ${args.ngram} previously resolved to ${target} ${(pTargetPat * 100).toFixed(0)}% (${totalPat} samples)`,
      });
    } else if (pTargetPat < 0.4) {
      conflicts.push({
        engine: "Pattern DNA",
        supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
        strength: clamp01((0.5 - pTargetPat) * 4),
        detail: `Sequence ${args.ngram} historically resolves to the OPPOSITE parity`,
      });
    }
  }

  // 12. Structural Digit Psychology (Precision Parity V4) — reasoning about the
  // five structural digits (Green/Red/Yellow/LightRed/Purple), crowd
  // positioning, entropy, volatility, reversal probability, and the resulting
  // market hypothesis. All contributions enter as ordinary evidence and are
  // subject to the adaptive weighting below.
  for (const e of args.structural.evidence) {
    if (e.supports === contract) supports.push({ ...e });
    else if (e.supports === "NEUTRAL") conflicts.push({ ...e });
    else conflicts.push({ ...e });
  }

  // 13. Future Forecast Intelligence — ensemble of specialist predictors
  //     forecasts P(next tick = EVEN) plus persistence and reversal risk.
  //     The forecast feeds hypothesis evaluation as first-class evidence.
  if (args.forecast) {
    const fc = args.forecast.ensemble;
    const pTarget = target === "EVEN" ? fc.pEvenNext : fc.pOddNext;
    if (pTarget > 0.54) {
      supports.push({
        engine: "Ensemble Forecast",
        supports: contract,
        strength: clamp01((pTarget - 0.5) * 4 + fc.stability * 0.3),
        detail: `Ensemble forecasts P(next=${target}) = ${(pTarget * 100).toFixed(0)}% over ${fc.persistenceWindow}t (agreement ${(fc.stability * 100).toFixed(0)}%)`,
      });
    } else if (pTarget < 0.46) {
      conflicts.push({
        engine: "Ensemble Forecast",
        supports: contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN",
        strength: clamp01((0.5 - pTarget) * 4 + fc.stability * 0.3),
        detail: `Ensemble forecast points opposite: P(next=${target}) only ${(pTarget * 100).toFixed(0)}%`,
      });
    }
    if (fc.edgeReverses > 0.5) {
      conflicts.push({
        engine: "Edge Persistence",
        supports: "NEUTRAL",
        strength: clamp01(fc.edgeReverses),
        detail: `Forecast reversal risk ${(fc.edgeReverses * 100).toFixed(0)}% — edge unlikely to persist`,
      });
    }
    // Historical analogue evidence
    const an = args.forecast.analogue;
    if (an.matches >= 5 && an.reversalRate < 0.35) {
      supports.push({
        engine: "Historical Analogue",
        supports: contract,
        strength: clamp01((1 - an.reversalRate) * 0.5),
        detail: `${an.matches} analogues @ ${(an.similarity * 100).toFixed(0)}% similarity — ${(100 - an.reversalRate * 100).toFixed(0)}% persisted, avg ${an.avgPersistTicks.toFixed(1)}t`,
      });
    } else if (an.matches >= 5 && an.reversalRate > 0.6) {
      conflicts.push({
        engine: "Historical Analogue",
        supports: "NEUTRAL",
        strength: clamp01(an.reversalRate * 0.6),
        detail: `${an.matches} analogues at this state reversed ${(an.reversalRate * 100).toFixed(0)}% of the time`,
      });
    }
  }


  // ── Adaptive weighting: every engine's contribution is scaled by a learned weight
  //    that has been reinforced/weakened by past realized outcomes. Green/Red bar are
  //    NOT hard-coded to any parity; they enter this Bayesian fusion as evidence and
  //    are re-weighted continuously by how often their signals were correct.
  for (const e of supports) e.strength *= weightOf(args.mem, e.engine);
  for (const e of conflicts) e.strength *= weightOf(args.mem, e.engine);

  // ── Bayesian confidence: prior 50 nudged by aligned/conflicting evidence
  const supStrength = supports.reduce((a, e) => a + e.strength, 0);
  const conStrength = conflicts.reduce((a, e) => a + e.strength, 0);
  const net = supStrength - conStrength;
  const confidence = clamp(50 + net * 12);
  const contradictionScore = clamp(conStrength * 20);

  const reasoning: string[] = [];
  supports.slice(0, 6).forEach((e) => reasoning.push(`+ ${e.detail}`));
  conflicts.slice(0, 3).forEach((e) => reasoning.push(`− ${e.detail}`));

  return {
    contract,
    confidence,
    supports,
    conflicts,
    contradictionScore,
    maturity: "EMERGING",
    persistenceTicks: 0,
    reasoning,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Trade Maturity Engine — lifecycle across evaluations
// ─────────────────────────────────────────────────────────────────────────
function updateMaturity(mem: SessionMemory, chosen: ParityContract | null, confidence: number): { maturity: MaturityState; persistence: number } {
  if (!chosen) {
    mem.currentContract = null;
    mem.currentPersistence = 0;
    mem.currentMaturity = "EXPIRED";
    return { maturity: "EXPIRED", persistence: 0 };
  }
  if (mem.currentContract !== chosen) {
    mem.currentContract = chosen;
    mem.currentPersistence = 1;
    mem.currentMaturity = "EMERGING";
  } else {
    mem.currentPersistence++;
  }
  let m: MaturityState = "EMERGING";
  if (mem.currentPersistence >= 12 && confidence >= 78) m = "PEAK";
  else if (mem.currentPersistence >= 6 && confidence >= 68) m = "MATURE";
  else if (mem.currentPersistence >= 3) m = "BUILDING";
  else m = "EMERGING";
  if (confidence < 55) m = "WEAKENING";
  mem.currentMaturity = m;
  return { maturity: m, persistence: mem.currentPersistence };
}

// ─────────────────────────────────────────────────────────────────────────
// Adaptive learning — reinforce engines that were right, weaken those wrong
// ─────────────────────────────────────────────────────────────────────────
function applyOutcomeLearning(mem: SessionMemory, realizedParity: "EVEN" | "ODD") {
  const pred = mem.lastPrediction;
  if (!pred) return;
  const realizedContract: ParityContract = realizedParity === "EVEN" ? "BUY_EVEN" : "BUY_ODD";
  const predictedRight = pred.contract === realizedContract;
  if (predictedRight) mem.realized.wins++; else mem.realized.losses++;
  // Every engine that supported the WINNING side (whatever it turned out to be) gets
  // reinforced; every engine that supported the LOSING side is weakened. Neutral
  // conflicts (Manipulation/Fluctuation) are ignored — they only gate, they don't pick.
  for (const s of pred.supports) {
    if (s.contract === "NEUTRAL") continue;
    const wasRight = s.contract === realizedContract;
    nudgeWeight(mem, s.engine, wasRight ? +LEARN_RATE : -LEARN_RATE);
  }
  for (const c of pred.conflicts) {
    if (c.contract === "NEUTRAL") continue;
    const wasRight = c.contract === realizedContract;
    nudgeWeight(mem, c.engine, wasRight ? +LEARN_RATE * 0.5 : -LEARN_RATE * 0.5);
  }
  mem.lastPrediction = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Monte Carlo Virtual Trading — simulate the next N ticks under a Markov
// model derived from live history and estimate win-rate + drawdown before
// the recommendation is allowed to reach the user.
// ─────────────────────────────────────────────────────────────────────────
interface VirtualTradeResult {
  runs: number;
  winRate: number;      // 0..1
  expectedValue: number; // per-trade EV using 0.95 payout
  maxDrawdown: number;   // worst equity trough over runs
  worstStreak: number;   // worst losing streak observed
  stable: boolean;       // std-dev of win-rate across sub-batches is low
}
function monteCarloValidate(
  contract: ParityContract,
  digits: number[],
  tr: TransitionMatrix,
  runs = 400,
): VirtualTradeResult {
  const target: "EVEN" | "ODD" = contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const lastP = digits.length ? parityOf(digits[digits.length - 1]) : "EVEN";
  let wins = 0;
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  let curStreak = 0;
  let worstStreak = 0;
  const batchWins: number[] = [];
  const batchSize = 50;
  let batchAcc = 0;
  for (let i = 0; i < runs; i++) {
    // Sample next parity from live transition matrix.
    const p = lastP === "EVEN"
      ? (Math.random() < tr.pEE ? "EVEN" : "ODD")
      : (Math.random() < tr.pOE ? "EVEN" : "ODD");
    const win = p === target;
    if (win) { wins++; batchAcc++; equity += 0.95; curStreak = 0; }
    else { equity -= 1; curStreak++; if (curStreak > worstStreak) worstStreak = curStreak; }
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if ((i + 1) % batchSize === 0) { batchWins.push(batchAcc / batchSize); batchAcc = 0; }
  }
  const winRate = wins / runs;
  const mu = batchWins.reduce((a, b) => a + b, 0) / Math.max(1, batchWins.length);
  const variance = batchWins.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, batchWins.length);
  const std = Math.sqrt(variance);
  return {
    runs,
    winRate,
    expectedValue: winRate * 0.95 - (1 - winRate),
    maxDrawdown: maxDD,
    worstStreak,
    stable: std < 0.09,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Self-critique — enumerate the strongest reasons this could still fail.
// ─────────────────────────────────────────────────────────────────────────
function selfCritique(
  winner: HypothesisEvaluation,
  regime: MarketRegime,
  hidden: HiddenRegime,
  manipulation: number,
  fluctuation: number,
  vt: VirtualTradeResult,
): string[] {
  const notes: string[] = [];
  if (regime === "CHAOTIC" || regime === "MANIPULATED") notes.push(`Regime is ${regime} — direction is unreliable`);
  if (hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING") notes.push(`Hidden state = ${hidden} — reversal risk elevated`);
  if (manipulation > 30) notes.push(`Manipulation still ${manipulation.toFixed(0)}% — distribution not clean`);
  if (fluctuation > 45) notes.push(`Fluctuation ${fluctuation.toFixed(0)}% — noise band wide`);
  if (winner.conflicts.length >= 3) notes.push(`${winner.conflicts.length} engines still push the opposite side`);
  if (!vt.stable) notes.push(`Virtual trades not stable across batches`);
  if (vt.winRate < 0.55) notes.push(`Simulated win-rate ${(vt.winRate * 100).toFixed(0)}% below 55% floor`);
  if (vt.worstStreak >= 6) notes.push(`Worst simulated losing streak = ${vt.worstStreak}`);
  return notes;
}


// ─────────────────────────────────────────────────────────────────────────
// Edge Stability Analyzer
// Estimates how many consecutive DBot entries the current edge should
// realistically survive. Combines persistence, virtual win-rate stability,
// contradiction pressure, hidden regime and manipulation.
// ─────────────────────────────────────────────────────────────────────────
function analyseEdgeStability(
  winner: HypothesisEvaluation,
  persistence: number,
  vt: VirtualTradeResult,
  regime: MarketRegime,
  hidden: HiddenRegime,
  manipulation: number,
  fluctuation: number,
  contradictionScore: number,
): EdgeStability {
  const reasons: string[] = [];
  let score = 50;
  // Persistence — a mature setup has already survived several ticks.
  if (persistence >= 10) { score += 18; reasons.push(`Persistence ${persistence}t — setup already survived multiple ticks`); }
  else if (persistence >= 6) { score += 10; reasons.push(`Persistence ${persistence}t — mid-life setup`); }
  else if (persistence >= 3) { score += 4; }
  else { score -= 8; reasons.push(`Only ${persistence}t of persistence — young setup`); }

  // Confidence altitude.
  if (winner.confidence >= 78) { score += 12; reasons.push(`Confidence ${winner.confidence.toFixed(0)} — well above threshold`); }
  else if (winner.confidence >= 68) { score += 4; }

  // Monte Carlo shape.
  if (vt.stable && vt.winRate >= 0.6) { score += 14; reasons.push(`Sim win-rate ${(vt.winRate * 100).toFixed(0)}% is stable across batches`); }
  else if (vt.stable) { score += 6; }
  else { score -= 8; reasons.push(`Simulated win-rate is unstable batch-to-batch`); }
  if (vt.worstStreak >= 6) { score -= 8; reasons.push(`Worst simulated streak ${vt.worstStreak} — drawdown risk`); }

  // Environment.
  if (regime === "STABLE" || regime === "TRENDING" || regime === "EXPANDING") { score += 8; reasons.push(`Regime ${regime} favours edge persistence`); }
  if (regime === "CHAOTIC" || regime === "MANIPULATED") { score -= 20; reasons.push(`Regime ${regime} — edge unlikely to survive`); }
  if (hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING") { score -= 12; reasons.push(`Hidden state ${hidden} — reversal risk`); }
  if (hidden === "EVEN_DOMINANCE" || hidden === "ODD_DOMINANCE") { score += 6; reasons.push(`Hidden state ${hidden} aligned with hypothesis`); }

  // Distortions.
  if (manipulation > 30) { score -= (manipulation - 30) * 0.6; reasons.push(`Manipulation ${manipulation.toFixed(0)}% eating into edge`); }
  if (fluctuation > 40) { score -= (fluctuation - 40) * 0.4; }
  if (contradictionScore > 25) { score -= (contradictionScore - 25) * 0.4; reasons.push(`Contradiction ${contradictionScore.toFixed(0)}% weighs on durability`); }

  score = clamp(score);
  let label: EdgeStability["label"] = "OK";
  if (score >= 80) label = "DURABLE";
  else if (score >= 65) label = "STABLE";
  else if (score >= 45) label = "OK";
  else label = "FRAGILE";

  // Expected number of DBot entries the edge should support.
  let expectedEntries = 3;
  if (score >= 80) expectedEntries = 7;
  else if (score >= 70) expectedEntries = 6;
  else if (score >= 60) expectedEntries = 5;
  else if (score >= 50) expectedEntries = 4;
  else if (score >= 40) expectedEntries = 3;
  else expectedEntries = 2;

  const expectedDurationSeconds = expectedEntries * 6; // digit contracts land in ~5-6s
  return { score, label, expectedEntries, expectedDurationSeconds, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// Evidence Analyst — independent challenger. Does NOT emit predictions.
// It cross-examines the winning hypothesis: what supports it, what contradicts
// it, what supports the opposite, and whether the setup would survive its
// own scrutiny. If it cannot confidently defend the trade it defers.
// ─────────────────────────────────────────────────────────────────────────
function analystReview(
  winner: HypothesisEvaluation,
  loser: HypothesisEvaluation,
  regime: MarketRegime,
  hidden: HiddenRegime,
  stability: EdgeStability,
  manipulation: number,
  fluctuation: number,
): AnalystReview {
  const target = winner.contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const opp = target === "EVEN" ? "ODD" : "EVEN";

  const dedupe = (arr: string[]) => Array.from(new Set(arr)).slice(0, 6);
  const supportsRecommendation = dedupe(winner.supports.map((e) => `${e.engine}: ${e.detail}`));
  const challengesRecommendation = dedupe(
    winner.conflicts.filter((e) => e.supports !== "NEUTRAL").map((e) => `${e.engine}: ${e.detail}`),
  );
  const supportsOpposite = dedupe(
    loser.supports.filter((e) => e.supports === loser.contract).map((e) => `${e.engine}: ${e.detail}`),
  );
  const challengesOpposite = dedupe(loser.conflicts.map((e) => `${e.engine}: ${e.detail}`));

  const marginTight = winner.confidence - loser.confidence < 8;
  const transitional = hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING";
  const chaotic = regime === "CHAOTIC" || regime === "MANIPULATED";
  const shakyStability = stability.label === "FRAGILE";
  const heavyContradiction = winner.contradictionScore > 40;

  const risks: string[] = [];
  if (marginTight) risks.push(`Margin over ${opp} is only ${(winner.confidence - loser.confidence).toFixed(0)} pts`);
  if (transitional) risks.push(`Market is in transition (${hidden})`);
  if (chaotic) risks.push(`Regime is ${regime}`);
  if (shakyStability) risks.push(`Edge stability rated FRAGILE (${stability.score.toFixed(0)})`);
  if (heavyContradiction) risks.push(`Contradiction pressure ${winner.contradictionScore.toFixed(0)}%`);
  if (manipulation > 30) risks.push(`Manipulation ${manipulation.toFixed(0)}%`);
  if (fluctuation > 50) risks.push(`Fluctuation ${fluctuation.toFixed(0)}%`);

  const wouldRiskMoney = risks.length <= 1
    && winner.confidence >= 70
    && !chaotic
    && stability.label !== "FRAGILE";

  let verdict: AnalystReview["verdict"] = "APPROVED";
  if (chaotic || shakyStability || heavyContradiction) verdict = "REJECTED";
  else if (marginTight || transitional || risks.length >= 3) verdict = "DEFER";

  const keyQuestion = `Would I personally risk money on ${target} on this market right now?`;
  const answer = wouldRiskMoney
    ? `Yes — evidence is decisive, environment is orderly, edge is expected to hold for ~${stability.expectedEntries} entries.`
    : `No — ${risks[0] ?? "the setup does not defend itself under cross-examination"}.`;

  const summary = verdict === "APPROVED"
    ? `Analyst approves ${target}. ${supportsRecommendation.length} independent engines back the call, opposition is limited to ${challengesRecommendation.length} minor points.`
    : verdict === "DEFER"
      ? `Analyst defers ${target}. Setup is plausible but not clean — waiting improves decision quality.`
      : `Analyst rejects ${target}. ${risks.join("; ")}.`;

  return {
    verdict,
    keyQuestion,
    answer,
    supportsRecommendation,
    challengesRecommendation,
    supportsOpposite,
    challengesOpposite,
    wouldRiskMoney,
    summary,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Risk Reviewer — asks "is this late? has the crowd entered? is the edge
// fading?" and vetoes trades where the risk-adjusted return has collapsed.
// ─────────────────────────────────────────────────────────────────────────
function riskReview(
  winner: HypothesisEvaluation,
  stability: EdgeStability,
  persistence: number,
  regime: MarketRegime,
  hidden: HiddenRegime,
  manipulation: number,
  fluctuation: number,
  crowding: number,
): RiskReview {
  const concerns: string[] = [];
  const tooLate = persistence >= 18 && winner.confidence < 78;
  const crowdAlreadyIn = crowding > 55;
  const edgeWeakening = winner.maturity === "WEAKENING"
    || (persistence >= 12 && winner.confidence < 68)
    || stability.score < 45;
  const waitingImproves = hidden === "ALTERNATING"
    || hidden === "REVERSAL_BUILDING"
    || regime === "CHAOTIC";

  if (tooLate) concerns.push(`Setup has aged ${persistence} ticks — likely late in its lifecycle`);
  if (crowdAlreadyIn) concerns.push(`Crowding ${crowding.toFixed(0)}% — retail attention already on this bias`);
  if (edgeWeakening) concerns.push(`Edge is weakening (stability ${stability.score.toFixed(0)}, maturity ${winner.maturity})`);
  if (waitingImproves) concerns.push(`Waiting improves expectancy — market is unsettled (${hidden}/${regime})`);
  if (manipulation > 35) concerns.push(`Manipulation ${manipulation.toFixed(0)}% is elevated`);
  if (fluctuation > 55) concerns.push(`Fluctuation ${fluctuation.toFixed(0)}% is elevated`);

  let verdict: RiskReview["verdict"] = "APPROVED";
  if (concerns.length >= 3 || regime === "CHAOTIC" || edgeWeakening) verdict = "REJECTED";
  else if (concerns.length >= 1) verdict = "CAUTION";

  const summary = verdict === "APPROVED"
    ? `Risk profile is clean — no material objections.`
    : verdict === "CAUTION"
      ? `Risk manageable but flagged — ${concerns[0]}.`
      : `Risk reviewer rejects — ${concerns.slice(0, 2).join("; ")}.`;

  return {
    verdict,
    concerns,
    tooLate,
    crowdAlreadyIn,
    edgeWeakening,
    waitingImproves,
    summary,
  };
}

function marketPhase(
  regime: MarketRegime,
  hidden: HiddenRegime,
  maturity: MaturityState,
  stability: EdgeStability,
): MarketPhase {
  if (regime === "CHAOTIC" || regime === "MANIPULATED") return "CHAOTIC";
  if (hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING") return "TRANSITION";
  if (maturity === "PEAK") return "LATE_TREND";
  if (maturity === "MATURE") return "MATURE_TREND";
  if (stability.label === "DURABLE" || stability.label === "STABLE") return "STABLE_EXPANSION";
  return "EMERGING";
}

function buildExecutionPlan(
  winner: HypothesisEvaluation,
  stability: EdgeStability,
  phase: MarketPhase,
  vt: VirtualTradeResult,
): ExecutionPlan {
  let reasoningQuality: ExecutionPlan["reasoningQuality"] = "Medium";
  if (winner.confidence >= 85 && stability.score >= 75) reasoningQuality = "Very High";
  else if (winner.confidence >= 75 && stability.score >= 60) reasoningQuality = "High";
  else if (winner.confidence >= 65) reasoningQuality = "Medium";
  else reasoningQuality = "Low";

  const recommendedRuns = Math.max(2, Math.min(7, stability.expectedEntries));
  const recoveryCompatibility: ExecutionPlan["recoveryCompatibility"] =
    stability.label === "DURABLE" ? "Suitable for full recovery"
      : stability.label === "STABLE" ? "Suitable for mild recovery only"
        : "Not compatible";

  const entryDirective = phase === "STABLE_EXPANSION" || phase === "MATURE_TREND"
    ? "Enter immediately while edge remains stable."
    : phase === "EMERGING"
      ? "Enter within 10s — setup is fresh, don't hesitate."
      : "Enter cautiously — environment is not ideal.";

  return {
    contract: winner.contract,
    marketPhase: phase,
    reasoningQuality,
    recommendedRuns,
    recommendedStake: "User defined",
    maxDelaySeconds: 10,
    signalExpirySeconds: Math.max(20, Math.min(60, stability.expectedDurationSeconds)),
    expectedPersistenceTrades: stability.expectedEntries,
    entryDirective,
    recoveryCompatibility,
    status: vt.expectedValue > 0 ? "READY" : "HOLD",
  };
}

function buildDBotPlan(
  market: string,
  marketName: string,
  plan: ExecutionPlan,
  analyst: AnalystReview,
  risk: RiskReview,
): DBotPlan {
  const cancelConditions = [
    "Confidence falls below threshold",
    "Analyst withdraws approval",
    "Edge stability drops below OK",
    "Manipulation increases past cap",
    "Entropy spikes / fluctuation surges",
    "New contradiction outweighs current supports",
    "Signal age exceeds expiry window",
    "Risk reviewer switches to Reject",
  ];
  const status: DBotPlan["status"] =
    plan.status === "READY" && analyst.verdict === "APPROVED" && risk.verdict !== "REJECTED"
      ? "READY TO LOAD"
      : "HOLD";
  return {
    contract: plan.contract,
    market,
    marketName,
    entry: plan.status === "READY" ? "Immediate" : "Wait",
    recommendedRuns: plan.recommendedRuns,
    maxConsecutiveEntries: plan.recommendedRuns,
    cancelConditions,
    status,
  };
}






// ─────────────────────────────────────────────────────────────────────────
// Public: analyseMarketParity
// ─────────────────────────────────────────────────────────────────────────
export function analyseMarketParity(
  market: string,
  name: string,
  ticks: Tick[],
  settings: ParitySettings = DEFAULT_PARITY_SETTINGS,
): MarketParityReport {
  const mem = getMemory(market);
  const adapt = getAdapt(market);
  mem.ticksSeen = Math.max(mem.ticksSeen, ticks.length);
  const digits = ticks.map((t) => lastDigit(t.price));

  const windows: Record<number, WindowStat> = {};
  for (const w of WINDOWS) windows[w] = windowStats(digits, w);

  const transitions = WINDOWS.map((w) => transitionMatrix(digits, w));
  const so = secondOrder(digits, 500);
  const { manipulation, fluctuation, crowding } = manipulationScore(digits);
  const regime = marketRegime(digits, windows[100], windows[500], manipulation, fluctuation);
  const hidden = hiddenRegime(windows[100], windows[500], transitions[2]);
  const green = barSnapshot(digits, "max");
  const red = barSnapshot(digits, "min");
  const psy = digitPsychology(digits);

  // Structural Digit Psychology (V4) — computed once per evaluation and shared
  // between both hypotheses. Evidence entries carry their own contract targets.
  const structural = analyseStructural(market, digits);

  mem.priorRegimes.push(regime); if (mem.priorRegimes.length > 200) mem.priorRegimes.shift();
  mem.priorHidden.push(hidden); if (mem.priorHidden.length > 200) mem.priorHidden.shift();

  const last = digits[digits.length - 1] ?? 0;
  const prev = digits[digits.length - 2] ?? last;
  const lastP = parityOf(last) as "EVEN" | "ODD";
  const prevP = parityOf(prev) as "EVEN" | "ODD";

  // ── Learn from the tick that just landed BEFORE we build new evidence ──
  //    • Bayesian belief nudged toward observed parity.
  //    • Kalman filter update with fresh even-share observation.
  //    • Green/Red bar correlation counters: did the previous bar-parity
  //      predict the parity that actually arrived?
  //    • N-gram pattern outcome tally.
  {
    const observedEven = lastP === "EVEN" ? 1 : 0;
    // Bayesian: light exponential smoothing (equivalent to sequential Bayes
    // update against a moving prior — resists whipsaw yet keeps drifting).
    adapt.bayesEven = adapt.bayesEven * 0.94 + observedEven * 0.06;

    // Kalman: 1-D constant-mean model, observation = windowed even share.
    const zw = windowStats(digits, 50).evenPct;
    const Q = 0.0004, R = 0.02;
    adapt.kalmanVar += Q;
    const K = adapt.kalmanVar / (adapt.kalmanVar + R);
    adapt.kalmanMean = adapt.kalmanMean + K * (zw - adapt.kalmanMean);
    adapt.kalmanVar = (1 - K) * adapt.kalmanVar;

    if (adapt.lastGreenParity) {
      if (adapt.lastGreenParity === lastP) adapt.greenCorr.same++;
      else adapt.greenCorr.opp++;
      const nG = adapt.greenCorr.same + adapt.greenCorr.opp;
      if (nG > 400) { adapt.greenCorr.same *= 0.85; adapt.greenCorr.opp *= 0.85; }
    }
    if (adapt.lastRedParity) {
      if (adapt.lastRedParity === lastP) adapt.redCorr.same++;
      else adapt.redCorr.opp++;
      const nR = adapt.redCorr.same + adapt.redCorr.opp;
      if (nR > 400) { adapt.redCorr.same *= 0.85; adapt.redCorr.opp *= 0.85; }
    }
    if (adapt.lastNgram) {
      const rec = adapt.patterns.get(adapt.lastNgram) ?? { even: 0, odd: 0 };
      if (lastP === "EVEN") rec.even++; else rec.odd++;
      adapt.patterns.set(adapt.lastNgram, rec);
      // Cap library size to stop unbounded growth in long sessions.
      if (adapt.patterns.size > 2048) {
        const firstKey = adapt.patterns.keys().next().value;
        if (firstKey) adapt.patterns.delete(firstKey);
      }
    }
  }

  // Build the current n-gram we'll teach on the NEXT tick.
  const NGRAM = 4;
  const parityTail = digits.slice(-NGRAM).map((d) => (d % 2 === 0 ? "E" : "O")).join("");
  const currentNgram = parityTail.length === NGRAM ? parityTail : "";

  // Historical similarity per hypothesis
  const simEven = historicalSimilarity(mem, windows[100].evenPct, windows[100].entropy, transitions[2].pEE, transitions[2].pOO, "BUY_EVEN");
  const simOdd = historicalSimilarity(mem, windows[100].evenPct, windows[100].entropy, transitions[2].pEE, transitions[2].pOO, "BUY_ODD");

  // ── Future Forecast Intelligence Engine (V3) ──
  // Runs BEFORE hypothesis evaluation so its ensemble forecast becomes
  // first-class evidence in every specialist analyst's reasoning.
  const forecast: ForecastReport = runForecastEngine({
    market,
    digits,
    windows,
    transitions,
    secondOrder: so,
    regime,
    hidden,
    green,
    red,
    psy,
    manipulation,
    fluctuation,
    crowding,
    bayesEven: adapt.bayesEven,
    kalmanEven: adapt.kalmanMean,
    streakTolerance: settings.streakLossTolerance,
  });

  // Teach the analogue library what happened after our previous state.
  const prevSnapshot = FORECAST_LAST.get(market) ?? null;
  recordAnalogueOutcome(
    market,
    prevSnapshot?.state ?? null,
    lastP,
    prevSnapshot ? (prevSnapshot.state.runParity === lastP ? prevSnapshot.runLength + 1 : 1) : 1,
  );
  FORECAST_LAST.set(market, { state: forecast.state, runLength: forecast.state.runLength });

  const common = {
    windows,
    transitions,
    secondOrder: so,
    hiddenRegime: hidden,
    regime,
    green,
    red,
    psy,
    manipulation,
    fluctuation,
    lastParity: lastP,
    prevParity: prevP,
    mem,
    adapt,
    ngram: currentNgram,
    structural,
    forecast,
    digits,
  };

  // Learn from the previous prediction now that the next tick has landed.
  applyOutcomeLearning(mem, lastP);

  const hEven = evaluateHypothesis("BUY_EVEN", { ...common, similarity: simEven });
  const hOdd = evaluateHypothesis("BUY_ODD", { ...common, similarity: simOdd });

  // Pick stronger hypothesis
  const enough = ticks.length >= settings.minTicks;
  const winner = hEven.confidence >= hOdd.confidence ? hEven : hOdd;
  const loser = winner === hEven ? hOdd : hEven;
  const margin = winner.confidence - loser.confidence;

  const chosenContract = winner.contract;
  const { maturity, persistence } = updateMaturity(
    mem,
    winner.confidence >= settings.minConfidence ? chosenContract : null,
    winner.confidence,
  );
  winner.maturity = maturity;
  winner.persistenceTicks = persistence;

  // Decision gates
  const reasons: string[] = [];
  let state: "READY" | "BUILDING" | "MONITORING" | "REJECTED" = "MONITORING";
  let recommendation: ParityContract | "NO_TRADE" = "NO_TRADE";
  let analyst: AnalystReview | undefined;
  let risk: RiskReview | undefined;
  let stability: EdgeStability | undefined;
  let plan: ExecutionPlan | undefined;
  let dbot: DBotPlan | undefined;
  let panel: IntelligencePanel | undefined;
  let deep: DeepReasoning | undefined;




  if (!enough) {
    reasons.push(`Observing — ${ticks.length}/${settings.minTicks} ticks gathered so far`);
    state = "MONITORING";
  } else if (manipulation > Math.max(settings.maxManipulation, 55)) {
    // V4 Chief Analyst: only CRITICAL manipulation (>=55%) hard-vetoes.
    reasons.push(`Critical manipulation ${manipulation.toFixed(0)}% — market feed integrity compromised`);
    state = "REJECTED";
  } else {
    // Every remaining condition contributes to reasoning, not rejection.
    // Compute virtual trades, self-critique, analyst / risk / stability panel
    // ONCE so the report always carries the full analyst stack.
    const vt = monteCarloValidate(chosenContract, digits, transitions[2]);
    const critique = selfCritique(winner, regime, hidden, manipulation, fluctuation, vt);
    const virtualOK = vt.winRate >= 0.55 && vt.stable && vt.expectedValue > 0 && vt.worstStreak < 8;

    // Unanimity — evidence, not veto.
    const uniqueVoters = new Set<string>();
    let forWinner = 0, forLoser = 0;
    for (const e of winner.supports) if (e.supports === chosenContract) { uniqueVoters.add(e.engine); forWinner++; }
    for (const e of winner.conflicts) if (e.supports !== "NEUTRAL" && e.supports !== chosenContract) { uniqueVoters.add(e.engine); forLoser++; }
    const distinctAgree = uniqueVoters.size;
    const unanimous = forWinner >= 4 && forLoser <= 1;

    stability = analyseEdgeStability(winner, persistence, vt, regime, hidden, manipulation, fluctuation, winner.contradictionScore);
    analyst = analystReview(winner, loser, regime, hidden, stability, manipulation, fluctuation);
    risk = riskReview(winner, stability, persistence, regime, hidden, manipulation, fluctuation, crowding);
    const phase = marketPhase(regime, hidden, maturity, stability);
    plan = buildExecutionPlan(winner, stability, phase, vt);
    dbot = buildDBotPlan(market, name, plan, analyst, risk);

    panel = runIntelligencePanel({
      winner,
      loser,
      margin,
      persistence,
      regime,
      hidden,
      manipulation,
      fluctuation,
      crowding,
      transition: transitions[2],
      virtual: vt,
      stability,
    });

    // ── Deep Reasoning Layer (non-destructive; sits between panel and gate) ──
    deep = runDeepReasoning({
      market,
      digits,
      windows,
      transitions,
      regime,
      hidden,
      manipulation,
      fluctuation,
      crowding,
      winner,
      loser,
      forecast,
      panel,
      contract: chosenContract,
      minTradeQuality: 62,
    });
    // Teach the deep-memory what happened after the previous fingerprint.
    recordFingerprintOutcome(
      market,
      deep.fingerprint,
      lastP === (chosenContract === "BUY_EVEN" ? "EVEN" : "ODD") ? "WIN" : "LOSS",
      persistence,
    );
    // Feed dynamic confidence back to winner (bounded blend so we never
    // increase confidence beyond the meta-reasoner + calibration allowed).
    winner.confidence = Math.min(winner.confidence, deep.dynamicConfidence.overall);


    // ── V4 Chief Analyst: aggregate advisory findings into a maturity ladder.
    // Advisers reduce confidence; only truly-critical failures block publish.
    const advisories: string[] = [];
    let confidencePenalty = 0;

    // Basic maturity checks — all soft.
    if (margin < settings.minEdge) {
      advisories.push(`thin margin ${margin.toFixed(1)} vs ${settings.minEdge.toFixed(1)} required`);
      confidencePenalty += 8;
    }
    if (winner.contradictionScore > settings.maxContradiction) {
      advisories.push(`internal contradiction ${winner.contradictionScore.toFixed(0)}%`);
      confidencePenalty += 6;
    }
    if (persistence < settings.minPersistenceTicks) {
      advisories.push(`persistence still building (${persistence}/${settings.minPersistenceTicks})`);
      confidencePenalty += 5;
    }
    if (settings.requireMature && (maturity === "EMERGING" || maturity === "BUILDING")) {
      advisories.push(`setup ${maturity.toLowerCase()}`);
      confidencePenalty += 4;
    }
    if (!unanimous) {
      advisories.push(`consensus incomplete (${forWinner} for / ${forLoser} against)`);
      confidencePenalty += 6;
    }
    if (critique.length >= 3) {
      advisories.push(`${critique.length} self-critique concerns`);
      confidencePenalty += 5;
    }
    if (analyst.verdict === "DEFER") {
      advisories.push(`analyst defers`);
      confidencePenalty += 5;
    }
    if (stability.label === "FRAGILE") {
      advisories.push(`edge stability fragile`);
      confidencePenalty += 6;
    }
    if (panel.chief.decision === "DEFER") {
      advisories.push(`chief defers`);
      confidencePenalty += 5;
    }
    if (forecast.ensemble.confidence < settings.minForecastConfidence) {
      advisories.push(`forecast confidence ${forecast.ensemble.confidence.toFixed(0)} < ${settings.minForecastConfidence}`);
      confidencePenalty += 4;
    }
    if (settings.requireForecastAgreement && (forecast.ensemble.favoured === "EVEN" ? "BUY_EVEN" : "BUY_ODD") !== chosenContract) {
      advisories.push(`forecast favours ${forecast.ensemble.favoured}`);
      confidencePenalty += 8;
    }
    if (forecast.dbotSurvival.durability === "LOW") {
      advisories.push(`DBot survival forecast LOW`);
      confidencePenalty += 6;
    }
    if (!virtualOK) {
      advisories.push(`virtual trades: win-rate ${(vt.winRate * 100).toFixed(0)}%, EV ${vt.expectedValue.toFixed(2)}, worst streak ${vt.worstStreak}`);
      confidencePenalty += 8;
    }

    // Adjust confidence based on aggregated advisories.
    winner.confidence = Math.max(0, winner.confidence - confidencePenalty);

    // ── Critical vetos (streak-loss protection is a core V4 directive) ──
    if (forecast.streakProtection.block) {
      reasons.push(`Streak Protection BLOCKS — ${forecast.streakProtection.reason}`);
      state = "REJECTED";
    } else if (panel.contrarian.verdict === "BLOCK" && panel.chief.decision !== "APPROVE") {
      // Contrarian only blocks if the chief isn't already convinced.
      reasons.push(`Contrarian BLOCKS — ${panel.contrarian.summary}`);
      state = "REJECTED";
    } else if (analyst.verdict === "REJECTED" && stability.label === "FRAGILE") {
      // Only reject when BOTH structural analyst AND stability agree.
      reasons.push(`Structural rejection — ${analyst.summary}`);
      state = "REJECTED";
    } else if (panel.chief.decision === "REJECT" && confidencePenalty >= 20) {
      // Chief rejection with heavy advisory weight.
      reasons.push(`Chief Analyst rejects — ${panel.chief.reasoning}`);
      state = "REJECTED";
    } else if (
      // READY: confidence still strong after all advisory penalties AND
      // core conviction present (margin + persistence + chief not opposed) AND
      // Deep Reasoning trade suppression did not fire.
      winner.confidence >= settings.minConfidence &&
      panel.chief.decision !== "REJECT" &&
      analyst.verdict !== "REJECTED" &&
      confidencePenalty <= 18 &&
      !deep.suppression.triggered
    ) {
      recommendation = chosenContract;
      state = "READY";
      reasons.push(...winner.reasoning);
      reasons.push(
        `Virtual trades: ${(vt.winRate * 100).toFixed(0)}% win-rate over ${vt.runs} sims, EV ${vt.expectedValue.toFixed(2)}, worst streak ${vt.worstStreak}`,
      );
      reasons.push(
        `Consensus: ${distinctAgree} independent engines aligned; opposite hypothesis (${chosenContract === "BUY_EVEN" ? "ODD" : "EVEN"}) rejected at confidence ${loser.confidence.toFixed(0)}.`,
      );
      reasons.push(`Analyst: ${analyst.summary}`);
      reasons.push(`Risk: ${risk.summary}`);
      reasons.push(`Edge stability ${stability.label} (${stability.score.toFixed(0)}) — expected to hold for ~${stability.expectedEntries} entries.`);
      reasons.push(`Chief Analyst: ${panel.chief.reasoning}`);
      reasons.push(`DBot survival: ${panel.dbotSurvival.durability} (${panel.dbotSurvival.recommendedRuns} recommended runs, ${(panel.dbotSurvival.flipProbability5 * 100).toFixed(0)}% flip risk over 5).`);
      reasons.push(`Intelligence grade: ${panel.intelligenceGrade}.`);
      reasons.push(`Future Forecast: ${forecast.narrative}`);
      reasons.push(...deep.explanation);
      if (advisories.length) reasons.push(`Advisories noted (non-blocking): ${advisories.slice(0, 3).join("; ")}`);
      if (critique.length) critique.forEach((c) => reasons.push(`? ${c}`));
      mem.snapshots.push({
        evenPct: windows[100].evenPct,
        entropy: windows[100].entropy,
        pEE: transitions[2].pEE,
        pOO: transitions[2].pOO,
        regime,
        contract: chosenContract,
      });
      if (mem.snapshots.length > 100) mem.snapshots.shift();
    } else if (winner.confidence >= settings.minConfidence - 6 || deep.suppression.triggered) {
      // V4: developing / mature opportunity worth surfacing but not entering.
      // Deep suppression also downgrades an otherwise-READY signal to BUILDING.
      state = "BUILDING";
      reasons.push(
        `Developing ${chosenContract === "BUY_EVEN" ? "EVEN" : "ODD"} thesis — confidence ${winner.confidence.toFixed(0)} (${advisories.length} advisories: ${advisories.slice(0, 2).join("; ")})`,
      );
      reasons.push(`Chief Analyst: ${panel.chief.reasoning}`);
      if (deep.suppression.triggered) reasons.push(`Deep suppression: ${deep.suppression.reasons.join(" ")}`);
      reasons.push(...deep.explanation.slice(0, 4));
    } else {
      state = "MONITORING";
      reasons.push(
        `Observing ${chosenContract === "BUY_EVEN" ? "EVEN" : "ODD"} lean — confidence ${winner.confidence.toFixed(0)}, waiting for evidence to converge`,
      );
      if (advisories.length) reasons.push(`Advisories: ${advisories.slice(0, 3).join("; ")}`);
      reasons.push(...deep.explanation.slice(0, 3));
    }
  }


  // Record this cycle's prediction so the NEXT tick can teach the ensemble.
  mem.lastPrediction = {
    contract: winner.contract,
    supports: winner.supports.map((s) => ({ engine: s.engine, contract: s.supports })),
    conflicts: winner.conflicts.map((c) => ({ engine: c.engine, contract: c.supports })),
  };
  adapt.lastGreenParity = green.parity;
  adapt.lastRedParity = red.parity;
  adapt.lastNgram = currentNgram || null;

  return {
    market,
    name,
    ticks: ticks.length,
    regime,
    hiddenRegime: hidden,
    windows,
    transitions,
    secondOrder: so,
    greenBar: green,
    redBar: red,
    digitPsychology: psy,
    manipulation,
    fluctuation,
    crowding,
    historicalSimilarity: Math.max(simEven, simOdd),
    forecast,
    verdict: {
      recommendation,
      state,
      confidence: winner.confidence,
      reasons,
      hypotheses: [hEven, hOdd],
      analyst,
      risk,
      stability,
      plan,
      dbot,
      panel,
      deep: typeof deep !== "undefined" ? deep : undefined,
    },
  };
}
