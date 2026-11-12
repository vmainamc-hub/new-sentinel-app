// Precision Parity — Future Forecast Intelligence Engine (V3).
//
// This engine is ADDITIVE. It does not replace or remove any existing
// analyst, hypothesis evaluator, intelligence panel or DBot survival
// module. It sits AFTER adaptive learning and BEFORE hypothesis
// evaluation, and its job is to forecast probable market behaviour over
// the next 1 / 3 / 5 / 10 ticks — including persistence, flip and
// streak-loss risk — so the rest of the pipeline can reason from a
// forward view instead of a purely current-state view.
//
// Everything is pure and deterministic given inputs, so the engine can
// run cheaply on every scan and its outputs are safe to serialise into
// the report for the UI to explain.
//
// Nothing here directly emits a BUY_EVEN / BUY_ODD recommendation — the
// forecasters describe expected future PARITY BEHAVIOUR, and the
// downstream hypothesis + panel + risk stack decides whether to trade.

import type {
  BarSnapshot,
  DigitPsychology,
  HiddenRegime,
  MarketRegime,
  ParityContract,
  SecondOrderMatrix,
  TransitionMatrix,
  WindowStat,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type Parity01 = "EVEN" | "ODD";

export interface MarketState {
  // Transition behaviour
  pEE: number; pEO: number; pOE: number; pOO: number;
  // Entropy (0..1 normalised)
  entropy: number;
  // Momentum: signed short-term even bias vs long-term (–1..+1)
  momentum: number;
  // Acceleration: change in momentum over recent window
  acceleration: number;
  // Compression (low entropy) / expansion (high entropy)
  compression: number; expansion: number;
  // Oscillation / alternation rate
  oscillation: number; alternation: number;
  // Persistence of last parity run
  persistence: number; runLength: number; runParity: Parity01;
  // Digit clustering (0..1)
  clustering: number;
  // Regimes
  regime: MarketRegime;
  hidden: HiddenRegime;
  // Pattern DNA: last-4 parity n-gram
  dna: string;
  // Structural psychology signals
  crowding: number;
  manipulation: number;
  fluctuation: number;
  // Similarity vs recent past (self-similarity of last 20 vs prior 100)
  historicalSimilarity: number;
}

export interface SpecialistForecast {
  name: string;
  pEvenNext: number;      // forecast P(next=EVEN)
  confidence: number;     // 0..1
  expectedDuration: number; // ticks the specialist expects its edge to persist
  reversalProbability: number; // 0..1
  supporting: string;
  conflicts?: string;
}

export interface HorizonForecast {
  horizon: 1 | 3 | 5 | 10;
  pEven: number;
  pOdd: number;
  expectedEven: number;
  expectedOdd: number;
}

export interface HistoricalAnalogue {
  matches: number;
  similarity: number;      // 0..1 (mean similarity of accepted analogues)
  avgEvenRun: number;
  avgOddRun: number;
  avgPersistTicks: number;
  reversalRate: number;    // 0..1
  narrative: string;
}

export interface DBotSurvivalForecast {
  pWin1: number;
  pRecoveryRequired: number;
  pRecoverySucceeds: number;
  expectedWinsBeforeFlip: number;
  expectedLossesBeforeRecovery: number;
  survival: Record<1 | 3 | 5 | 8, number>;
  durability: "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
}

export interface StreakProtection {
  streakLossProbability: number;   // P(3+ consecutive losses within next 8 entries)
  transitionRisk: number;          // 0..1
  edgeExpiryRisk: number;          // 0..1
  latenessRisk: number;            // 0..1
  noiseTrapRisk: number;           // 0..1
  block: boolean;                  // true → reject signal outright
  reason: string;
}

export interface EnsembleForecast {
  pEvenNext: number;              // ensemble P(next=EVEN)
  pOddNext: number;
  favoured: Parity01;
  confidence: number;             // 0..100
  persistenceWindow: number;      // ticks the ensemble expects the edge to last
  edgeSurvives: number;           // P(current edge survives next 3 ticks)
  edgeWeakens: number;
  edgeReverses: number;
  stability: number;              // 0..1 — cross-specialist agreement
  horizons: HorizonForecast[];
}

export interface ForecastReport {
  state: MarketState;
  specialists: SpecialistForecast[];
  ensemble: EnsembleForecast;
  analogue: HistoricalAnalogue;
  dbotSurvival: DBotSurvivalForecast;
  streakProtection: StreakProtection;
  narrative: string;
}

// Per-market rolling memory of encoded states → observed outcomes.
// Used by the Historical Analogue engine to answer:
// "when the market looked like THIS before, what actually happened next?"
interface AnalogueMemoryRow {
  fingerprint: number[];      // fixed-length numeric vector for cosine similarity
  nextEven: boolean;
  runContinuedTicks: number;
  reversed: boolean;
}
const ANALOGUE_MEMORY = new Map<string, AnalogueMemoryRow[]>();
const ANALOGUE_CAP = 400;

export function resetForecastMemory(market?: string) {
  if (market) ANALOGUE_MEMORY.delete(market);
  else ANALOGUE_MEMORY.clear();
}

// ─────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const parityOf = (d: number): Parity01 => (d % 2 === 0 ? "EVEN" : "ODD");

function alternationRate(digits: number[], n = 40): number {
  const s = digits.slice(-n);
  if (s.length < 2) return 0.5;
  let flips = 0;
  for (let i = 1; i < s.length; i++) if (s[i] % 2 !== s[i - 1] % 2) flips++;
  return flips / (s.length - 1);
}

function runInfo(digits: number[]): { length: number; parity: Parity01 } {
  if (!digits.length) return { length: 0, parity: "EVEN" };
  const last = parityOf(digits[digits.length - 1]);
  let len = 1;
  for (let i = digits.length - 2; i >= 0; i--) {
    if (parityOf(digits[i]) === last) len++;
    else break;
  }
  return { length: len, parity: last };
}

function selfSimilarity(digits: number[]): number {
  const tail = digits.slice(-20);
  const prior = digits.slice(-120, -20);
  if (tail.length < 20 || prior.length < 40) return 0.5;
  const evenTail = tail.filter((d) => d % 2 === 0).length / tail.length;
  const evenPrior = prior.filter((d) => d % 2 === 0).length / prior.length;
  return 1 - Math.min(1, Math.abs(evenTail - evenPrior) * 2.5);
}

// ─────────────────────────────────────────────────────────────────────
// Market State Encoder
// ─────────────────────────────────────────────────────────────────────
export function encodeMarketState(args: {
  digits: number[];
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  regime: MarketRegime;
  hidden: HiddenRegime;
  psy: DigitPsychology;
  manipulation: number;
  fluctuation: number;
  crowding: number;
}): MarketState {
  const { digits, windows, transitions, regime, hidden, psy } = args;
  const tr = transitions[Math.min(2, transitions.length - 1)];

  const w50 = windows[50] ?? windows[100];
  const w100 = windows[100] ?? w50;
  const w500 = windows[500] ?? w100;

  const momentum = ((w50?.evenPct ?? 0.5) - (w500?.evenPct ?? 0.5)) * 2; // -1..1
  const older = digits.slice(-200, -100);
  const olderEven = older.length ? older.filter((d) => d % 2 === 0).length / older.length : 0.5;
  const acceleration = ((w100?.evenPct ?? 0.5) - olderEven) * 2;
  const entropy = w100?.entropy ?? 1;
  const alt = alternationRate(digits, 40);
  const run = runInfo(digits);
  const dna = digits.slice(-4).map((d) => (d % 2 === 0 ? "E" : "O")).join("");

  return {
    pEE: tr.pEE, pEO: tr.pEO, pOE: tr.pOE, pOO: tr.pOO,
    entropy,
    momentum: Math.max(-1, Math.min(1, momentum)),
    acceleration: Math.max(-1, Math.min(1, acceleration)),
    compression: clamp01(1 - entropy),
    expansion: clamp01((entropy - 0.9) * 10),
    oscillation: alt,
    alternation: alt,
    persistence: run.length,
    runLength: run.length,
    runParity: run.parity,
    clustering: psy.clustering,
    regime,
    hidden,
    dna,
    crowding: args.crowding,
    manipulation: args.manipulation,
    fluctuation: args.fluctuation,
    historicalSimilarity: selfSimilarity(digits),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Specialist Forecasters (each forecasts P(next=EVEN))
// ─────────────────────────────────────────────────────────────────────
type Ctx = {
  state: MarketState;
  digits: number[];
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  secondOrder: SecondOrderMatrix;
  green: BarSnapshot;
  red: BarSnapshot;
  psy: DigitPsychology;
  lastParity: Parity01;
  prevParity: Parity01;
  bayesEven: number;
  kalmanEven: number;
};

function fcTrend(c: Ctx): SpecialistForecast {
  const p = 0.5 + c.state.momentum * 0.15 + c.state.acceleration * 0.05;
  const pE = clamp01(p);
  return {
    name: "Trend Forecaster",
    pEvenNext: pE,
    confidence: Math.min(1, Math.abs(c.state.momentum) * 1.5 + 0.1),
    expectedDuration: Math.round(3 + Math.abs(c.state.momentum) * 6),
    reversalProbability: clamp01(0.35 - Math.abs(c.state.momentum) * 0.4),
    supporting: `Even-share drift ${(c.state.momentum * 100).toFixed(1)}% short vs long window`,
  };
}

function fcCycle(c: Ctx): SpecialistForecast {
  // Alternating cycles → expect opposite of last parity
  const flipProne = c.state.alternation;
  const pEIfFlip = c.lastParity === "ODD" ? 0.5 + (flipProne - 0.5) : 0.5 - (flipProne - 0.5);
  return {
    name: "Cycle Forecaster",
    pEvenNext: clamp01(pEIfFlip),
    confidence: Math.abs(flipProne - 0.5) * 2,
    expectedDuration: flipProne > 0.6 ? 2 : 4,
    reversalProbability: flipProne,
    supporting: `Alternation rate ${(flipProne * 100).toFixed(0)}%`,
  };
}

function fcEntropy(c: Ctx): SpecialistForecast {
  // High entropy → forecast reverts to 50/50, low confidence, quick reversal
  const distanceFromNeutral = 0.5 - c.state.entropy / 2; // entropy near 1 → 0
  return {
    name: "Entropy Forecaster",
    pEvenNext: 0.5,
    confidence: clamp01(distanceFromNeutral * 4),
    expectedDuration: c.state.entropy >= 0.99 ? 1 : 3,
    reversalProbability: c.state.entropy >= 0.99 ? 0.55 : 0.35,
    supporting: `H=${c.state.entropy.toFixed(3)} — ${c.state.entropy >= 0.995 ? "chaotic" : c.state.entropy >= 0.98 ? "high disorder" : "ordered"}`,
  };
}

function fcTransition(c: Ctx): SpecialistForecast {
  const pE = c.lastParity === "EVEN" ? c.state.pEE : c.state.pOE;
  return {
    name: "Transition Predictor",
    pEvenNext: pE,
    confidence: Math.min(1, Math.abs(pE - 0.5) * 4),
    expectedDuration: 3,
    reversalProbability: clamp01(1 - Math.max(c.state.pEE, c.state.pOO)),
    supporting: `From ${c.lastParity}: P(next=EVEN)=${(pE * 100).toFixed(0)}%`,
  };
}

function fcPatternDNA(c: Ctx): SpecialistForecast {
  const key = (c.prevParity[0] + c.lastParity[0]) as "EE" | "EO" | "OE" | "OO";
  const pE = c.secondOrder.pEvenAfter[key];
  return {
    name: "Pattern DNA Predictor",
    pEvenNext: pE,
    confidence: Math.min(1, Math.abs(pE - 0.5) * 3.5),
    expectedDuration: 2,
    reversalProbability: clamp01(1 - Math.abs(pE - 0.5) * 2),
    supporting: `Sequence ${key} → P(next=EVEN)=${(pE * 100).toFixed(0)}%`,
  };
}

function fcBayesian(c: Ctx): SpecialistForecast {
  return {
    name: "Bayesian Predictor",
    pEvenNext: c.bayesEven,
    confidence: Math.min(1, Math.abs(c.bayesEven - 0.5) * 5),
    expectedDuration: 4,
    reversalProbability: clamp01(0.4 - Math.abs(c.bayesEven - 0.5) * 0.4),
    supporting: `Rolling posterior P(EVEN)=${(c.bayesEven * 100).toFixed(0)}%`,
  };
}

function fcKalman(c: Ctx): SpecialistForecast {
  return {
    name: "Kalman Predictor",
    pEvenNext: c.kalmanEven,
    confidence: Math.min(1, Math.abs(c.kalmanEven - 0.5) * 4.5),
    expectedDuration: 5,
    reversalProbability: clamp01(0.35 - Math.abs(c.kalmanEven - 0.5) * 0.4),
    supporting: `Filtered EVEN share ${(c.kalmanEven * 100).toFixed(1)}%`,
  };
}

function fcMomentum(c: Ctx): SpecialistForecast {
  const p = 0.5 + c.state.momentum * 0.12 + c.state.acceleration * 0.08;
  return {
    name: "Momentum Predictor",
    pEvenNext: clamp01(p),
    confidence: Math.min(1, Math.abs(c.state.acceleration) * 2.2),
    expectedDuration: 3,
    reversalProbability: clamp01(0.4 - Math.abs(c.state.momentum) * 0.3),
    supporting: `Momentum ${(c.state.momentum * 100).toFixed(0)}% / accel ${(c.state.acceleration * 100).toFixed(0)}%`,
  };
}

function fcPsychology(c: Ctx): SpecialistForecast {
  const hotEven = c.psy.hot % 2 === 0;
  const risingEven = c.psy.rising % 2 === 0;
  const votes = (hotEven ? 1 : -1) + (risingEven ? 1 : -1);
  const p = 0.5 + votes * 0.07;
  return {
    name: "Psychology Predictor",
    pEvenNext: clamp01(p),
    confidence: Math.abs(votes) / 2 * 0.6,
    expectedDuration: 3,
    reversalProbability: 0.35,
    supporting: `Hot d${c.psy.hot} (${hotEven ? "EVEN" : "ODD"}), rising d${c.psy.rising} (${risingEven ? "EVEN" : "ODD"})`,
  };
}

function fcManipulation(c: Ctx): SpecialistForecast {
  // High manipulation → forecast noisy 50/50; damp any bias
  const damp = clamp01(1 - c.state.manipulation / 100);
  const p = 0.5 + (c.bayesEven - 0.5) * damp;
  return {
    name: "Manipulation Predictor",
    pEvenNext: clamp01(p),
    confidence: clamp01(c.state.manipulation / 100),
    expectedDuration: 2,
    reversalProbability: clamp01(c.state.manipulation / 130 + 0.2),
    supporting: `Manipulation ${c.state.manipulation.toFixed(0)}% — dampening any directional bias`,
  };
}

function fcRecovery(c: Ctx): SpecialistForecast {
  // After a long run, forecast slight mean-reversion
  const meanRevBias = c.state.runLength >= 4 ? 0.08 * (c.state.runLength - 3) : 0;
  const pE = c.state.runParity === "EVEN"
    ? clamp01(0.5 - meanRevBias)
    : clamp01(0.5 + meanRevBias);
  return {
    name: "Recovery Predictor",
    pEvenNext: pE,
    confidence: c.state.runLength >= 5 ? Math.min(1, (c.state.runLength - 4) * 0.2) : 0.1,
    expectedDuration: 2,
    reversalProbability: c.state.runLength >= 5 ? 0.55 : 0.35,
    supporting: `Run of ${c.state.runLength} ${c.state.runParity} → mild reversion pressure`,
  };
}

function fcPersistence(c: Ctx): SpecialistForecast {
  // If parity has persisted, forecast continuation but with declining confidence
  const stickP = c.state.runParity === "EVEN"
    ? Math.max(c.state.pEE, 0.5)
    : Math.max(c.state.pOO, 0.5);
  const pE = c.state.runParity === "EVEN" ? stickP : 1 - stickP;
  return {
    name: "Persistence Predictor",
    pEvenNext: pE,
    confidence: Math.min(1, c.state.runLength / 8),
    expectedDuration: Math.max(1, 6 - c.state.runLength),
    reversalProbability: clamp01(c.state.runLength / 10),
    supporting: `${c.state.runParity} run length ${c.state.runLength}, self-P=${(stickP * 100).toFixed(0)}%`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Historical Analogue Engine
// ─────────────────────────────────────────────────────────────────────
function stateFingerprint(s: MarketState): number[] {
  return [
    s.pEE, s.pEO, s.pOE, s.pOO,
    s.entropy,
    (s.momentum + 1) / 2,
    (s.acceleration + 1) / 2,
    s.alternation,
    Math.min(1, s.runLength / 8),
    s.runParity === "EVEN" ? 1 : 0,
    clamp01(s.manipulation / 100),
    clamp01(s.fluctuation / 100),
    clamp01(s.crowding / 100),
    s.clustering,
  ];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function historicalAnalogue(market: string, state: MarketState): HistoricalAnalogue {
  const rows = ANALOGUE_MEMORY.get(market) ?? [];
  const fp = stateFingerprint(state);
  const scored = rows
    .map((r) => ({ r, sim: cosine(fp, r.fingerprint) }))
    .filter((x) => x.sim >= 0.94)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, 40);
  if (scored.length < 3) {
    return {
      matches: scored.length,
      similarity: scored.length ? scored[0].sim : 0,
      avgEvenRun: 0,
      avgOddRun: 0,
      avgPersistTicks: 0,
      reversalRate: 0.5,
      narrative: `Only ${scored.length} historical analogues collected — insufficient for confident replay analysis`,
    };
  }
  const evenRuns = scored.filter((s) => s.r.nextEven).map((s) => s.r.runContinuedTicks);
  const oddRuns = scored.filter((s) => !s.r.nextEven).map((s) => s.r.runContinuedTicks);
  const reversalRate = scored.filter((s) => s.r.reversed).length / scored.length;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const avgSim = avg(scored.map((s) => s.sim));
  return {
    matches: scored.length,
    similarity: avgSim,
    avgEvenRun: avg(evenRuns),
    avgOddRun: avg(oddRuns),
    avgPersistTicks: avg(scored.map((s) => s.r.runContinuedTicks)),
    reversalRate,
    narrative: `Market resembles ${scored.length} historical situations at ${(avgSim * 100).toFixed(0)}% similarity — average edge persisted ${avg(scored.map((s) => s.r.runContinuedTicks)).toFixed(1)} ticks, ${(reversalRate * 100).toFixed(0)}% reversed`,
  };
}

// Called each scan to grow the analogue library with the outcome that
// followed the PREVIOUS encoded state. Small, bounded, per-market.
export function recordAnalogueOutcome(
  market: string,
  prevState: MarketState | null,
  observedParity: Parity01,
  observedRunLength: number,
) {
  if (!prevState) return;
  const rows = ANALOGUE_MEMORY.get(market) ?? [];
  rows.push({
    fingerprint: stateFingerprint(prevState),
    nextEven: observedParity === "EVEN",
    runContinuedTicks: observedRunLength,
    reversed: prevState.runParity !== observedParity,
  });
  if (rows.length > ANALOGUE_CAP) rows.splice(0, rows.length - ANALOGUE_CAP);
  ANALOGUE_MEMORY.set(market, rows);
}

// ─────────────────────────────────────────────────────────────────────
// Ensemble
// ─────────────────────────────────────────────────────────────────────
function ensemble(specialists: SpecialistForecast[], analogue: HistoricalAnalogue): EnsembleForecast {
  // Weight = confidence * regime suitability. Analogue engine boosts
  // stability but never overrides direction alone.
  let num = 0, den = 0;
  for (const s of specialists) {
    const w = 0.15 + s.confidence * 0.85;
    num += s.pEvenNext * w;
    den += w;
  }
  const pE = den > 0 ? num / den : 0.5;
  const pO = 1 - pE;

  // Stability = 1 - variance of specialist forecasts
  const mean = specialists.reduce((a, s) => a + s.pEvenNext, 0) / specialists.length;
  const variance = specialists.reduce((a, s) => a + (s.pEvenNext - mean) ** 2, 0) / specialists.length;
  const stability = clamp01(1 - variance * 6);

  const favoured: Parity01 = pE >= 0.5 ? "EVEN" : "ODD";
  const spread = Math.abs(pE - 0.5) * 2; // 0..1
  const confidence = clamp(50 + spread * 40 + stability * 15, 0, 100);

  // Persistence = weighted expected duration, tempered by analogue evidence
  const persistWeighted = specialists.reduce((a, s) => a + s.expectedDuration * (0.2 + s.confidence), 0) /
    specialists.reduce((a, s) => a + (0.2 + s.confidence), 0);
  const persistenceWindow = Math.max(1, Math.round(
    persistWeighted * 0.7 + (analogue.avgPersistTicks || persistWeighted) * 0.3,
  ));

  const edgeReverses = clamp01(
    specialists.reduce((a, s) => a + s.reversalProbability * s.confidence, 0) /
      Math.max(1e-6, specialists.reduce((a, s) => a + s.confidence, 0)),
  );
  const edgeSurvives = clamp01(1 - edgeReverses * 0.9);
  const edgeWeakens = clamp01(1 - edgeSurvives - edgeReverses * 0.4);

  // Horizon extrapolation: compound single-tick probability toward
  // a bounded expectation. This is a heuristic, not a hard Markov roll.
  const horizons: HorizonForecast[] = ([1, 3, 5, 10] as const).map((h) => {
    // Decay toward 0.5 with reversal probability
    const decay = Math.pow(1 - edgeReverses * 0.35, h - 1);
    const pEH = 0.5 + (pE - 0.5) * decay;
    return {
      horizon: h,
      pEven: clamp01(pEH),
      pOdd: clamp01(1 - pEH),
      expectedEven: +(pEH * h).toFixed(2),
      expectedOdd: +((1 - pEH) * h).toFixed(2),
    };
  });

  return {
    pEvenNext: pE,
    pOddNext: pO,
    favoured,
    confidence,
    persistenceWindow,
    edgeSurvives,
    edgeWeakens,
    edgeReverses,
    stability,
    horizons,
  };
}

// ─────────────────────────────────────────────────────────────────────
// DBot Survival Forecast
// ─────────────────────────────────────────────────────────────────────
function dbotSurvival(ens: EnsembleForecast, state: MarketState): DBotSurvivalForecast {
  const pWin = Math.max(ens.pEvenNext, ens.pOddNext);
  // per-entry win prob decays as edge is consumed
  const decay = 0.02 + (1 - ens.stability) * 0.03 + clamp01(state.manipulation / 100) * 0.03;
  const perEntry = (k: number) => Math.max(0.5, pWin - decay * (k - 1));
  const survival = {
    1: perEntry(1),
    3: perEntry(1) * perEntry(2) * perEntry(3),
    5: [1, 2, 3, 4, 5].reduce((a, k) => a * perEntry(k), 1),
    8: [1, 2, 3, 4, 5, 6, 7, 8].reduce((a, k) => a * perEntry(k), 1),
  } as const;
  const durability: DBotSurvivalForecast["durability"] =
    survival[5] >= 0.8 ? "VERY_HIGH" :
      survival[5] >= 0.65 ? "HIGH" :
        survival[5] >= 0.45 ? "MODERATE" : "LOW";
  return {
    pWin1: survival[1],
    pRecoveryRequired: clamp01(1 - survival[1]),
    pRecoverySucceeds: clamp01(perEntry(2) * perEntry(3)),
    expectedWinsBeforeFlip: Math.max(1, Math.round(ens.persistenceWindow * pWin)),
    expectedLossesBeforeRecovery: Math.round(1 / Math.max(0.5, perEntry(2))),
    survival: { 1: survival[1], 3: survival[3], 5: survival[5], 8: survival[8] },
    durability,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Streak Protection
// ─────────────────────────────────────────────────────────────────────
function streakProtection(
  ens: EnsembleForecast,
  state: MarketState,
  survival: DBotSurvivalForecast,
  tolerance: number,
): StreakProtection {
  const p1 = Math.max(0.5, Math.min(0.95, survival.pWin1));
  const pLoss = 1 - p1;
  // P(3 consecutive losses somewhere in next 8 entries) — approximated
  // via 1 - (1 - pLoss^3)^6 (independent-ish sliding windows).
  const streakLossProbability = clamp01(1 - Math.pow(1 - Math.pow(pLoss, 3), 6));

  const transitionRisk = state.hidden === "ALTERNATING" || state.hidden === "REVERSAL_BUILDING" ? 0.7 : 0.2;
  const edgeExpiryRisk = clamp01(ens.edgeReverses * 0.6 + (1 - ens.stability) * 0.4);
  const latenessRisk = clamp01(state.runLength >= 6 ? 0.6 : state.runLength / 12);
  const noiseTrapRisk = clamp01(state.entropy >= 0.99 ? 0.7 : state.fluctuation / 120);

  const composite = Math.max(
    streakLossProbability,
    transitionRisk * 0.9,
    edgeExpiryRisk * 0.85,
    noiseTrapRisk * 0.85,
  );

  const block = composite > tolerance;
  const reason = block
    ? `Streak-loss risk composite ${(composite * 100).toFixed(0)}% > tolerance ${(tolerance * 100).toFixed(0)}% — refusing signal`
    : `Streak-loss risk composite ${(composite * 100).toFixed(0)}% within tolerance ${(tolerance * 100).toFixed(0)}%`;

  return {
    streakLossProbability,
    transitionRisk,
    edgeExpiryRisk,
    latenessRisk,
    noiseTrapRisk,
    block,
    reason,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Public entry: runForecastEngine
// ─────────────────────────────────────────────────────────────────────
export function runForecastEngine(args: {
  market: string;
  digits: number[];
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  secondOrder: SecondOrderMatrix;
  regime: MarketRegime;
  hidden: HiddenRegime;
  green: BarSnapshot;
  red: BarSnapshot;
  psy: DigitPsychology;
  manipulation: number;
  fluctuation: number;
  crowding: number;
  bayesEven: number;
  kalmanEven: number;
  streakTolerance?: number; // default 0.55
}): ForecastReport {
  const state = encodeMarketState(args);
  const last = args.digits[args.digits.length - 1] ?? 0;
  const prev = args.digits[args.digits.length - 2] ?? last;
  const ctx: Ctx = {
    state,
    digits: args.digits,
    windows: args.windows,
    transitions: args.transitions,
    secondOrder: args.secondOrder,
    green: args.green,
    red: args.red,
    psy: args.psy,
    lastParity: parityOf(last),
    prevParity: parityOf(prev),
    bayesEven: args.bayesEven,
    kalmanEven: args.kalmanEven,
  };

  const specialists: SpecialistForecast[] = [
    fcTrend(ctx),
    fcCycle(ctx),
    fcEntropy(ctx),
    fcTransition(ctx),
    fcPatternDNA(ctx),
    fcBayesian(ctx),
    fcKalman(ctx),
    fcMomentum(ctx),
    fcPsychology(ctx),
    fcManipulation(ctx),
    fcRecovery(ctx),
    fcPersistence(ctx),
  ];

  const analogue = historicalAnalogue(args.market, state);
  const ens = ensemble(specialists, analogue);
  const survival = dbotSurvival(ens, state);
  const protection = streakProtection(ens, state, survival, args.streakTolerance ?? 0.55);

  const narrative = [
    `Forecast favours ${ens.favoured} at ${(ens.pEvenNext * 100).toFixed(0)}%/${(ens.pOddNext * 100).toFixed(0)}% for the next tick.`,
    `Expected persistence window ${ens.persistenceWindow}t; edge-reversal probability ${(ens.edgeReverses * 100).toFixed(0)}%.`,
    `Specialist agreement ${(ens.stability * 100).toFixed(0)}%; DBot durability ${survival.durability} (P5 = ${(survival.survival[5] * 100).toFixed(0)}%).`,
    analogue.narrative,
    protection.reason,
  ].join(" ");

  return {
    state,
    specialists,
    ensemble: ens,
    analogue,
    dbotSurvival: survival,
    streakProtection: protection,
    narrative,
  };
}

// Convenience: map an ensemble forecast to a preferred parity contract.
export function ensembleContract(ens: EnsembleForecast): ParityContract {
  return ens.favoured === "EVEN" ? "BUY_EVEN" : "BUY_ODD";
}
