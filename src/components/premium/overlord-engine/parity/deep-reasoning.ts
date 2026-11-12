// Precision Parity — Deep Reasoning Layer.
//
// This module DOES NOT replace any existing engine. It sits between the
// existing statistical/forecast/analyst-debate pipeline and the final
// verdict, adding cognitive reasoning layers:
//
//   1. Deep Behaviour Engine (latent market behaviour, probabilistic)
//   2. Market Personality Detection
//   3. Historical Fingerprint / Similarity Intelligence
//   4. Case-Based Reasoning (nearest-neighbour outcomes)
//   5. Causal Reasoning (WHY, not just WHAT)
//   6. Meta Reasoning AI (judges the reasoners themselves)
//   7. Sequence Intelligence (long-range motifs & embeddings)
//   8. Dynamic Multi-Component Confidence
//   9. Explicit Uncertainty
//  10. Deep Risk Assessment + Trade Quality Score
//  11. Trade Suppression Intelligence
//  12. Behavioural Explainability
//
// Every existing feature (Bayesian, Kalman, Pattern DNA, Forecast, Analyst
// Debate, Adaptive Learning, Calibration, Structural Analysis, Monte Carlo,
// Confidence Engine) remains intact and untouched.

import type {
  ParityContract,
  MarketRegime,
  HiddenRegime,
  IntelligencePanel,
  HypothesisEvaluation,
  ForecastReport,
  WindowStat,
  TransitionMatrix,
} from "./types";

// ─────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────

export type MarketPersonality =
  | "HIGHLY_PERSISTENT"
  | "BALANCED"
  | "CHAOTIC"
  | "EXHAUSTED"
  | "EXPLOSIVE"
  | "TRANSITIONING"
  | "COMPRESSION"
  | "EXPANSION"
  | "FAKE_TREND"
  | "HIGH_NOISE"
  | "BEHAVIOURALLY_STABLE"
  | "BEHAVIOURALLY_UNSTABLE";

export interface DeepBehaviour {
  trendPersistence: number;       // 0..1
  behaviouralStability: number;   // 0..1
  structuralImbalance: number;    // 0..1
  entropy: number;                // 0..1 (normalised)
  volatilityCompression: number;  // 0..1
  volatilityExpansion: number;    // 0..1
  transitionPressure: number;     // 0..1
  crowdBias: number;              // 0..1 (0 = odd biased, 1 = even biased)
  momentumPersistence: number;    // 0..1
  meanReversionTendency: number;  // 0..1
  behaviouralExhaustion: number;  // 0..1
  reversalPressure: number;       // 0..1
  patternMaturity: number;        // 0..1
  noiseLevel: number;             // 0..1
  randomnessProbability: number;  // 0..1
  manipulationProbability: number;// 0..1
  structuralConfidence: number;   // 0..1
}

export interface Fingerprint {
  evenShare: number;
  entropy: number;
  pEE: number;
  pOO: number;
  runLen: number;
  behaviour: DeepBehaviour;
  personality: MarketPersonality;
  contract: ParityContract;
}

export interface HistoricalMatch {
  matches: number;
  evenWinRate: number;
  oddWinRate: number;
  averageContinuation: number;
  failureRate: number;
  confidenceDispersion: number;
  historicalProfitability: number;
  summary: string;
}

export interface CausalHypothesis {
  cause: string;
  probability: number; // 0..1
}

export type AnalystTag =
  | "STATISTICAL"
  | "BEHAVIOUR"
  | "FORECAST"
  | "PSYCHOLOGY"
  | "STRUCTURAL"
  | "BAYESIAN"
  | "PATTERN_DNA"
  | "REGIME"
  | "HISTORICAL"
  | "ENTROPY";

export interface AnalystOpinion {
  analyst: AnalystTag;
  observation: string;
  evidence: string;
  confidence: number;         // 0..100
  weakness: string;
  alternative: string;
  supports: ParityContract | "NEUTRAL";
}

export interface MetaReasoning {
  independenceScore: number;      // 0..1 (higher = more diverse)
  diversityScore: number;         // 0..1
  overconfidenceFlag: boolean;
  duplicatedReasoningFlag: boolean;
  weakEvidenceFlag: boolean;
  correlationPenalty: number;     // 0..30 (confidence points)
  independentAgreementBonus: number; // 0..10
  reasoningQuality: number;       // 0..100
  critiques: string[];
}

export interface SequenceIntel {
  longRangeDependency: number;    // 0..1
  motifStrength: number;          // 0..1
  cycleDetected: boolean;
  cyclePeriod: number | null;
  embedding: number[];            // compact 8-dim signature
  persistenceSignature: number;   // 0..1
}

export interface DynamicConfidence {
  statistical: number;
  behaviour: number;
  historical: number;
  forecast: number;
  consensus: number;
  risk: number;
  reasoning: number;
  overall: number;
  uncertainty: number;
}

export interface DeepRiskAssessment {
  expectedRewardQuality: number;      // 0..100
  falsePositiveProbability: number;   // 0..1
  historicalFailureProbability: number; // 0..1
  analystDisagreement: number;        // 0..1
  behaviourInstability: number;       // 0..1
  forecastInstability: number;        // 0..1
  entropyRisk: number;                // 0..1
  confidenceFragility: number;        // 0..1
  tradeQualityScore: number;          // 0..100
  concerns: string[];
}

export interface DeepReasoning {
  behaviour: DeepBehaviour;
  personality: MarketPersonality;
  personalityConfidence: number;
  fingerprint: Fingerprint;
  historicalMatch: HistoricalMatch;
  causes: CausalHypothesis[];
  analysts: AnalystOpinion[];
  meta: MetaReasoning;
  sequence: SequenceIntel;
  dynamicConfidence: DynamicConfidence;
  risk: DeepRiskAssessment;
  suppression: {
    triggered: boolean;
    reasons: string[];
  };
  explanation: string[];
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clampPct = (v: number) => Math.max(0, Math.min(100, v));
const safe = (v: number, fallback = 0) => (Number.isFinite(v) ? v : fallback);

function parityOf(d: number): "EVEN" | "ODD" {
  return d % 2 === 0 ? "EVEN" : "ODD";
}

function shannon(pE: number): number {
  const pO = 1 - pE;
  if (pE <= 0 || pO <= 0) return 0;
  return -(pE * Math.log2(pE) + pO * Math.log2(pO));
}

// Cosine-like distance in [0,1] for two normalised vectors.
function fpDistance(a: Fingerprint, b: Fingerprint): number {
  const va = [a.evenShare, a.entropy, a.pEE, a.pOO, a.runLen / 20];
  const vb = [b.evenShare, b.entropy, b.pEE, b.pOO, b.runLen / 20];
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  const denom = Math.sqrt(na * nb) || 1;
  return 1 - dot / denom;
}

// ─────────────────────────────────────────────────────────────────────────
// Behavioural Memory (per market)
// ─────────────────────────────────────────────────────────────────────────

interface StoredFingerprint {
  fp: Fingerprint;
  createdAt: number;
  outcome?: "WIN" | "LOSS";
  continuation?: number;
  confidence?: number;
}

interface BehaviourMemory {
  fingerprints: StoredFingerprint[];
  analystScores: Record<AnalystTag, { wins: number; losses: number; weight: number }>;
  lastEmbedding: number[] | null;
}

const MEMORY = new Map<string, BehaviourMemory>();

function getMemory(market: string): BehaviourMemory {
  const existing = MEMORY.get(market);
  if (existing) return existing;
  const mem: BehaviourMemory = {
    fingerprints: [],
    analystScores: {
      STATISTICAL: { wins: 0, losses: 0, weight: 1 },
      BEHAVIOUR: { wins: 0, losses: 0, weight: 1 },
      FORECAST: { wins: 0, losses: 0, weight: 1 },
      PSYCHOLOGY: { wins: 0, losses: 0, weight: 1 },
      STRUCTURAL: { wins: 0, losses: 0, weight: 1 },
      BAYESIAN: { wins: 0, losses: 0, weight: 1 },
      PATTERN_DNA: { wins: 0, losses: 0, weight: 1 },
      REGIME: { wins: 0, losses: 0, weight: 1 },
      HISTORICAL: { wins: 0, losses: 0, weight: 1 },
      ENTROPY: { wins: 0, losses: 0, weight: 1 },
    },
    lastEmbedding: null,
  };
  MEMORY.set(market, mem);
  return mem;
}

export function resetDeepMemory(market?: string) {
  if (market) MEMORY.delete(market);
  else MEMORY.clear();
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Deep Behaviour Engine
// ─────────────────────────────────────────────────────────────────────────

export function computeDeepBehaviour(input: {
  digits: number[];
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  regime: MarketRegime;
  hidden: HiddenRegime;
  manipulation: number;
  fluctuation: number;
  crowding: number;
}): DeepBehaviour {
  const { digits, windows, transitions, manipulation, fluctuation, crowding } = input;
  const w100 = windows[100] ?? { n: 0, evenPct: 50, oddPct: 50, entropy: 1 };
  const w500 = windows[500] ?? w100;
  const tr = transitions[2] ?? { pEE: 0.5, pEO: 0.5, pOE: 0.5, pOO: 0.5, sample: 0 } as TransitionMatrix;

  const evenShare = w100.evenPct / 100;

  // Run-length of current parity in the tail.
  let run = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (i === digits.length - 1 || parityOf(digits[i]) === parityOf(digits[i + 1])) run++;
    else break;
  }

  const persistence = clamp01((tr.pEE + tr.pOO - 1) * 2 + 0.5);
  const alternation = clamp01((tr.pEO + tr.pOE - 1) * 2 + 0.5);
  const imbalance = Math.abs(evenShare - 0.5) * 2;
  const shortEntropy = shannon(w100.evenPct / 100);
  const longEntropy = shannon(w500.evenPct / 100);

  const volSpread = Math.abs(w100.evenPct - w500.evenPct) / 100;
  const compression = clamp01(1 - volSpread * 4);
  const expansion = clamp01(volSpread * 4);
  const transitionPressure = clamp01(Math.abs(persistence - 0.5) < 0.1 ? 0.8 : Math.abs(alternation - persistence));

  const noiseLevel = clamp01(shortEntropy * 0.6 + fluctuation / 200);
  const randomness = clamp01(0.5 * shortEntropy + 0.5 * (1 - imbalance));

  const patternMaturity = clamp01(Math.min(1, digits.length / 300) * (0.5 + 0.5 * persistence));
  const exhaustion = clamp01((run > 8 ? (run - 8) / 12 : 0) + (persistence > 0.7 && imbalance > 0.4 ? 0.3 : 0));
  const reversalPressure = clamp01(0.35 * exhaustion + 0.35 * (1 - persistence) + 0.3 * imbalance * (run > 6 ? 1 : 0.4));

  const structuralConfidence = clamp01(
    0.35 * persistence +
      0.25 * (1 - shortEntropy) +
      0.2 * (1 - crowding / 100) +
      0.2 * (1 - manipulation / 100),
  );

  return {
    trendPersistence: persistence,
    behaviouralStability: clamp01(1 - Math.abs(shortEntropy - longEntropy)),
    structuralImbalance: imbalance,
    entropy: shortEntropy,
    volatilityCompression: compression,
    volatilityExpansion: expansion,
    transitionPressure,
    crowdBias: evenShare,
    momentumPersistence: persistence,
    meanReversionTendency: alternation,
    behaviouralExhaustion: exhaustion,
    reversalPressure,
    patternMaturity,
    noiseLevel,
    randomnessProbability: randomness,
    manipulationProbability: clamp01(manipulation / 100),
    structuralConfidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Market Personality Detection
// ─────────────────────────────────────────────────────────────────────────

export function detectPersonality(b: DeepBehaviour): { personality: MarketPersonality; confidence: number } {
  // Score every candidate; pick the strongest.
  const scores: Array<[MarketPersonality, number]> = [
    ["HIGHLY_PERSISTENT", b.trendPersistence * (1 - b.entropy) * b.behaviouralStability],
    ["BALANCED", (1 - b.structuralImbalance) * b.behaviouralStability * (1 - b.reversalPressure)],
    ["CHAOTIC", b.entropy * b.noiseLevel * (1 - b.trendPersistence)],
    ["EXHAUSTED", b.behaviouralExhaustion * b.reversalPressure],
    ["EXPLOSIVE", b.volatilityExpansion * b.transitionPressure],
    ["TRANSITIONING", b.transitionPressure * (1 - b.behaviouralStability)],
    ["COMPRESSION", b.volatilityCompression * (1 - b.volatilityExpansion)],
    ["EXPANSION", b.volatilityExpansion * (1 - b.volatilityCompression)],
    ["FAKE_TREND", b.trendPersistence * b.reversalPressure * b.behaviouralExhaustion],
    ["HIGH_NOISE", b.noiseLevel * b.randomnessProbability],
    ["BEHAVIOURALLY_STABLE", b.behaviouralStability * b.structuralConfidence],
    ["BEHAVIOURALLY_UNSTABLE", (1 - b.behaviouralStability) * b.transitionPressure],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  const [best, score] = scores[0];
  const second = scores[1][1];
  const confidence = clamp01(score - second + score * 0.5);
  return { personality: best, confidence };
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Historical Similarity Intelligence
// ─────────────────────────────────────────────────────────────────────────

export function buildFingerprint(input: {
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  runLength: number;
  behaviour: DeepBehaviour;
  personality: MarketPersonality;
  contract: ParityContract;
}): Fingerprint {
  const w = input.windows[100];
  const tr = input.transitions[2];
  return {
    evenShare: safe(w.evenPct) / 100,
    entropy: shannon(safe(w.evenPct) / 100),
    pEE: safe(tr?.pEE, 0.5),
    pOO: safe(tr?.pOO, 0.5),
    runLen: input.runLength,
    behaviour: input.behaviour,
    personality: input.personality,
    contract: input.contract,
  };
}

export function findHistoricalMatches(
  market: string,
  fp: Fingerprint,
  contract: ParityContract,
): HistoricalMatch {
  const mem = getMemory(market);
  const scored = mem.fingerprints
    .map((s) => ({ s, d: fpDistance(s.fp, fp) }))
    .filter((x) => x.d < 0.35)
    .sort((a, b) => a.d - b.d)
    .slice(0, 25);

  if (scored.length === 0) {
    return {
      matches: 0,
      evenWinRate: 0.5,
      oddWinRate: 0.5,
      averageContinuation: 0,
      failureRate: 0.5,
      confidenceDispersion: 0,
      historicalProfitability: 0,
      summary: "No comparable historical fingerprints yet — reasoning from present state only.",
    };
  }

  let evenWins = 0, evenTotal = 0, oddWins = 0, oddTotal = 0;
  let contWins = 0, contTotal = 0;
  let contSum = 0, contCount = 0;
  let confSum = 0, confSq = 0, confN = 0;
  let profit = 0;
  for (const { s } of scored) {
    if (s.outcome == null) continue;
    contTotal++;
    if (s.outcome === "WIN") contWins++;
    if (s.fp.contract === "BUY_EVEN") {
      evenTotal++;
      if (s.outcome === "WIN") evenWins++;
    } else {
      oddTotal++;
      if (s.outcome === "WIN") oddWins++;
    }
    if (s.continuation != null) { contSum += s.continuation; contCount++; }
    if (s.confidence != null) { confSum += s.confidence; confSq += s.confidence * s.confidence; confN++; }
    profit += s.outcome === "WIN" ? 0.95 : -1;
  }

  const evenWR = evenTotal ? evenWins / evenTotal : 0.5;
  const oddWR = oddTotal ? oddWins / oddTotal : 0.5;
  const failureRate = contTotal ? 1 - contWins / contTotal : 0.5;
  const avgCont = contCount ? contSum / contCount : 0;
  const meanC = confN ? confSum / confN : 0;
  const varC = confN ? Math.max(0, confSq / confN - meanC * meanC) : 0;

  const side = contract === "BUY_EVEN" ? evenWR : oddWR;
  return {
    matches: scored.length,
    evenWinRate: evenWR,
    oddWinRate: oddWR,
    averageContinuation: avgCont,
    failureRate,
    confidenceDispersion: Math.sqrt(varC),
    historicalProfitability: profit,
    summary: `${scored.length} similar historical states — ${contract === "BUY_EVEN" ? "EVEN" : "ODD"} succeeded ${(side * 100).toFixed(0)}% of the time (avg continuation ${avgCont.toFixed(1)}).`,
  };
}

export function storeFingerprint(market: string, fp: Fingerprint, confidence: number) {
  const mem = getMemory(market);
  mem.fingerprints.push({ fp, createdAt: Date.now(), confidence });
  if (mem.fingerprints.length > 400) mem.fingerprints.shift();
}

export function recordFingerprintOutcome(
  market: string,
  fp: Fingerprint,
  outcome: "WIN" | "LOSS",
  continuation: number,
) {
  const mem = getMemory(market);
  // Find the closest recent stored fingerprint without outcome and label it.
  let best = -1, bestD = Infinity;
  for (let i = mem.fingerprints.length - 1; i >= 0 && mem.fingerprints.length - i < 20; i--) {
    if (mem.fingerprints[i].outcome != null) continue;
    const d = fpDistance(mem.fingerprints[i].fp, fp);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best >= 0) {
    mem.fingerprints[best].outcome = outcome;
    mem.fingerprints[best].continuation = continuation;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Causal Reasoning
// ─────────────────────────────────────────────────────────────────────────

export function inferCauses(b: DeepBehaviour, personality: MarketPersonality): CausalHypothesis[] {
  const raw: CausalHypothesis[] = [
    { cause: "Momentum", probability: b.momentumPersistence * (1 - b.reversalPressure) },
    { cause: "Statistical persistence", probability: b.trendPersistence * (1 - b.entropy) },
    { cause: "Transition imbalance", probability: b.transitionPressure * b.structuralImbalance },
    { cause: "Entropy collapse", probability: (1 - b.entropy) * b.structuralConfidence },
    { cause: "Volatility compression", probability: b.volatilityCompression * (1 - b.volatilityExpansion) },
    { cause: "Behavioural exhaustion", probability: b.behaviouralExhaustion },
    { cause: "Noise", probability: b.noiseLevel * b.randomnessProbability },
    { cause: "Temporary randomness", probability: b.randomnessProbability * (1 - b.trendPersistence) },
    { cause: "Structural imbalance", probability: b.structuralImbalance * b.structuralConfidence },
    { cause: "Regime transition", probability: personality === "TRANSITIONING" ? 0.85 : b.transitionPressure * 0.5 },
    { cause: "Manipulation footprint", probability: b.manipulationProbability },
  ];
  // Normalise so probabilities are comparable (soft normalisation).
  const total = raw.reduce((s, r) => s + r.probability, 0) || 1;
  return raw
    .map((r) => ({ cause: r.cause, probability: r.probability / total }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 6);
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Analyst Diversity + Opinions
// ─────────────────────────────────────────────────────────────────────────

export function collectAnalystOpinions(input: {
  contract: ParityContract;
  winner: HypothesisEvaluation;
  loser: HypothesisEvaluation;
  behaviour: DeepBehaviour;
  personality: MarketPersonality;
  regime: MarketRegime;
  hidden: HiddenRegime;
  forecast: ForecastReport | undefined;
  panel: IntelligencePanel | undefined;
  historicalMatch: HistoricalMatch;
}): AnalystOpinion[] {
  const { contract, winner, behaviour, personality, regime, hidden, forecast, panel, historicalMatch } = input;
  const side = contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const opposite: ParityContract = contract === "BUY_EVEN" ? "BUY_ODD" : "BUY_EVEN";

  const ops: AnalystOpinion[] = [];

  ops.push({
    analyst: "STATISTICAL",
    observation: `Winner hypothesis confidence ${winner.confidence.toFixed(0)}, contradiction ${winner.contradictionScore.toFixed(0)}.`,
    evidence: `${winner.supports.length} supporting signals vs ${winner.conflicts.length} conflicts.`,
    confidence: clampPct(winner.confidence),
    weakness: winner.contradictionScore > 30 ? "Non-trivial internal contradiction." : "Sample size may be small in early session.",
    alternative: `Statistics could reflect ${opposite === "BUY_EVEN" ? "EVEN" : "ODD"} regression if imbalance is transient.`,
    supports: contract,
  });

  ops.push({
    analyst: "BEHAVIOUR",
    observation: `Trend persistence ${(behaviour.trendPersistence * 100).toFixed(0)}%, reversal pressure ${(behaviour.reversalPressure * 100).toFixed(0)}%.`,
    evidence: `Behavioural stability ${(behaviour.behaviouralStability * 100).toFixed(0)}%, exhaustion ${(behaviour.behaviouralExhaustion * 100).toFixed(0)}%.`,
    confidence: clampPct(behaviour.trendPersistence * 100 - behaviour.reversalPressure * 30),
    weakness: behaviour.behaviouralExhaustion > 0.5 ? "Behavioural exhaustion elevated." : "Stability metric is instantaneous.",
    alternative: behaviour.reversalPressure > 0.55 ? "Reversal pressure supports the opposite side." : "Could flatten into balanced regime.",
    supports: behaviour.trendPersistence > behaviour.meanReversionTendency ? contract : opposite,
  });

  ops.push({
    analyst: "FORECAST",
    observation: forecast ? `Forecast favours ${forecast.ensemble.favoured} at ${forecast.ensemble.confidence.toFixed(0)}%.` : "No forecast available.",
    evidence: forecast ? forecast.narrative : "n/a",
    confidence: forecast ? clampPct(forecast.ensemble.confidence) : 40,
    weakness: forecast && forecast.dbotSurvival.durability === "LOW" ? "DBot survival LOW." : "Forecast horizon limited.",
    alternative: forecast && forecast.ensemble.favoured !== side ? `Forecast disagrees with ${side}.` : "Forecast alignment could flip on next tick.",
    supports: forecast ? (forecast.ensemble.favoured === "EVEN" ? "BUY_EVEN" : "BUY_ODD") : "NEUTRAL",
  });

  ops.push({
    analyst: "PSYCHOLOGY",
    observation: `Crowd bias ${(behaviour.crowdBias * 100).toFixed(0)}% EVEN.`,
    evidence: `Noise ${(behaviour.noiseLevel * 100).toFixed(0)}%, randomness ${(behaviour.randomnessProbability * 100).toFixed(0)}%.`,
    confidence: clampPct(60 - behaviour.noiseLevel * 30),
    weakness: "Psychology proxies from digit frequency, not order flow.",
    alternative: behaviour.crowdBias > 0.6 ? "Crowd may be overextended on EVEN." : behaviour.crowdBias < 0.4 ? "Crowd may be overextended on ODD." : "Crowd balanced — no edge from psychology alone.",
    supports: behaviour.crowdBias > 0.55 ? "BUY_EVEN" : behaviour.crowdBias < 0.45 ? "BUY_ODD" : "NEUTRAL",
  });

  ops.push({
    analyst: "STRUCTURAL",
    observation: `Structural imbalance ${(behaviour.structuralImbalance * 100).toFixed(0)}%, confidence ${(behaviour.structuralConfidence * 100).toFixed(0)}%.`,
    evidence: `Regime=${regime}, hidden=${hidden}.`,
    confidence: clampPct(behaviour.structuralConfidence * 100),
    weakness: behaviour.structuralConfidence < 0.4 ? "Structural read weak." : "Regime labels lag by design.",
    alternative: hidden === "REVERSAL_BUILDING" ? "Hidden reversal building." : "Structural read could invert on regime change.",
    supports: contract,
  });

  ops.push({
    analyst: "BAYESIAN",
    observation: `Prior/posterior alignment on ${side}.`,
    evidence: `Persistence-driven belief updated by observation.`,
    confidence: clampPct(50 + (behaviour.trendPersistence - 0.5) * 80),
    weakness: "Bayesian belief adapts slowly by design; will lag sudden regime flips.",
    alternative: "If regime flips, posterior will trail for many ticks.",
    supports: contract,
  });

  ops.push({
    analyst: "PATTERN_DNA",
    observation: `Pattern maturity ${(behaviour.patternMaturity * 100).toFixed(0)}%.`,
    evidence: `Momentum persistence ${(behaviour.momentumPersistence * 100).toFixed(0)}%.`,
    confidence: clampPct(behaviour.patternMaturity * 100),
    weakness: behaviour.patternMaturity < 0.4 ? "Pattern not yet mature." : "Mature patterns can exhaust quickly.",
    alternative: "Late-stage maturity often precedes reversal.",
    supports: behaviour.patternMaturity > 0.5 ? contract : "NEUTRAL",
  });

  ops.push({
    analyst: "REGIME",
    observation: `Regime ${regime}, personality ${personality}.`,
    evidence: `Compression ${(behaviour.volatilityCompression * 100).toFixed(0)}%, expansion ${(behaviour.volatilityExpansion * 100).toFixed(0)}%.`,
    confidence: clampPct(
      personality === "HIGHLY_PERSISTENT" || personality === "BEHAVIOURALLY_STABLE" ? 78 :
      personality === "CHAOTIC" || personality === "HIGH_NOISE" ? 30 : 55,
    ),
    weakness: personality === "TRANSITIONING" ? "Regime is mid-transition." : "Regime labels can whipsaw.",
    alternative: `Personality ${personality} could shift under expansion.`,
    supports: personality === "HIGHLY_PERSISTENT" ? contract : personality === "EXHAUSTED" ? opposite : contract,
  });

  ops.push({
    analyst: "HISTORICAL",
    observation: historicalMatch.summary,
    evidence: `Matches=${historicalMatch.matches}, failure rate ${(historicalMatch.failureRate * 100).toFixed(0)}%.`,
    confidence: clampPct(
      historicalMatch.matches === 0 ? 40 :
      (contract === "BUY_EVEN" ? historicalMatch.evenWinRate : historicalMatch.oddWinRate) * 100,
    ),
    weakness: historicalMatch.matches < 5 ? "Historical sample small." : historicalMatch.confidenceDispersion > 15 ? "High dispersion across matches." : "Past behaviour is not future behaviour.",
    alternative: historicalMatch.failureRate > 0.5 ? "Similar states historically failed more than half the time." : "Historical edge could still evaporate.",
    supports: historicalMatch.matches === 0 ? "NEUTRAL"
      : (contract === "BUY_EVEN" && historicalMatch.evenWinRate > historicalMatch.oddWinRate) ? "BUY_EVEN"
      : (contract === "BUY_ODD" && historicalMatch.oddWinRate > historicalMatch.evenWinRate) ? "BUY_ODD"
      : "NEUTRAL",
  });

  ops.push({
    analyst: "ENTROPY",
    observation: `Entropy ${(behaviour.entropy * 100).toFixed(0)}%.`,
    evidence: `Randomness probability ${(behaviour.randomnessProbability * 100).toFixed(0)}%.`,
    confidence: clampPct((1 - behaviour.entropy) * 100),
    weakness: behaviour.entropy > 0.85 ? "High entropy signals near-random regime." : "Entropy metric is windowed.",
    alternative: behaviour.entropy > 0.85 ? "No side has an entropy-based edge." : "Entropy may spike suddenly.",
    supports: behaviour.entropy < 0.75 ? contract : "NEUTRAL",
  });

  // Panel-driven consensus adjustment.
  if (panel) {
    const grade = panel.intelligenceGrade;
    const bonus = grade === "A" ? 8 : grade === "B" ? 4 : grade === "C" ? 0 : -8;
    for (const op of ops) op.confidence = clampPct(op.confidence + bonus);
  }

  return ops;
}

// ─────────────────────────────────────────────────────────────────────────
// 6. Meta Reasoning AI
// ─────────────────────────────────────────────────────────────────────────

export function metaReason(ops: AnalystOpinion[], contract: ParityContract): MetaReasoning {
  const critiques: string[] = [];

  // Agreement direction counts.
  const agree = ops.filter((o) => o.supports === contract);
  const disagree = ops.filter((o) => o.supports !== "NEUTRAL" && o.supports !== contract);
  const neutral = ops.filter((o) => o.supports === "NEUTRAL");

  // Independence: unique analyst domains that agree.
  const uniqueDomains = new Set(agree.map((o) => o.analyst));
  const independence = clamp01(uniqueDomains.size / 10);

  // Diversity: variance in confidence across analysts.
  const mean = ops.reduce((s, o) => s + o.confidence, 0) / (ops.length || 1);
  const variance = ops.reduce((s, o) => s + (o.confidence - mean) ** 2, 0) / (ops.length || 1);
  const diversity = clamp01(Math.sqrt(variance) / 40);

  // Overconfidence: many analysts above 85 with weak evidence flags.
  const highConf = ops.filter((o) => o.confidence >= 85);
  const overconfidence = highConf.length >= 5 && highConf.every((o) => o.weakness.length > 0);
  if (overconfidence) critiques.push("Overconfidence detected — most high-confidence analysts also flag weaknesses.");

  // Duplicated reasoning: near-identical evidence strings.
  const seen = new Map<string, number>();
  for (const o of ops) {
    const key = o.evidence.slice(0, 24).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const dup = Array.from(seen.values()).some((n) => n >= 3);
  if (dup) critiques.push("Duplicated reasoning across analysts — evidence may be correlated.");

  // Weak evidence: many supporters below 50.
  const weak = agree.filter((o) => o.confidence < 50).length >= Math.max(2, Math.floor(agree.length / 2));
  if (weak) critiques.push("Weak evidence — many supporting analysts below 50% confidence.");

  const correlationPenalty = (dup ? 12 : 0) + (independence < 0.4 ? 10 : 0) + (overconfidence ? 8 : 0);
  const independentAgreementBonus = uniqueDomains.size >= 6 && !dup ? 8 : uniqueDomains.size >= 4 ? 4 : 0;

  if (disagree.length >= 3) critiques.push(`${disagree.length} analysts disagree — reasoning is not converged.`);
  if (neutral.length >= 5) critiques.push("Many analysts are neutral — evidence base is thin.");

  const reasoningQuality = clampPct(
    50 + independence * 30 + diversity * 20 - correlationPenalty + independentAgreementBonus - disagree.length * 3,
  );

  return {
    independenceScore: independence,
    diversityScore: diversity,
    overconfidenceFlag: overconfidence,
    duplicatedReasoningFlag: dup,
    weakEvidenceFlag: weak,
    correlationPenalty,
    independentAgreementBonus,
    reasoningQuality,
    critiques,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Sequence Intelligence
// ─────────────────────────────────────────────────────────────────────────

export function analyseSequence(digits: number[]): SequenceIntel {
  const n = digits.length;
  if (n < 32) {
    return {
      longRangeDependency: 0,
      motifStrength: 0,
      cycleDetected: false,
      cyclePeriod: null,
      embedding: new Array(8).fill(0),
      persistenceSignature: 0,
    };
  }
  const parities: number[] = digits.map((d) => (d % 2 === 0 ? 1 : 0));

  // Autocorrelation at lags 1..12 → embedding.
  const mean = parities.reduce((s: number, p: number) => s + p, 0) / n;
  const embedding: number[] = [];
  let bestLag = 0, bestAc = 0;
  for (let lag = 1; lag <= 12; lag++) {
    let num = 0, den = 0;
    for (let i = 0; i < n - lag; i++) {
      num += (parities[i] - mean) * (parities[i + lag] - mean);
    }
    for (let i = 0; i < n; i++) den += (parities[i] - mean) ** 2;
    const ac = den ? num / den : 0;
    if (lag <= 8) embedding.push(ac);
    if (Math.abs(ac) > Math.abs(bestAc)) { bestAc = ac; bestLag = lag; }
  }

  // Motif: count of most frequent 4-gram / total 4-grams.
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i <= n - 4; i++) {
    const key = parities.slice(i, i + 4).join("");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
  }
  const maxCount = Math.max(...counts.values(), 1);
  const motifStrength = clamp01((maxCount / total) * 4);

  const longRange = clamp01(Math.abs(bestAc));
  const cycleDetected = Math.abs(bestAc) > 0.25 && bestLag >= 2;

  const persistenceSignature = clamp01(embedding.slice(0, 3).reduce((s, v) => s + Math.abs(v), 0) / 3);

  return {
    longRangeDependency: longRange,
    motifStrength,
    cycleDetected,
    cyclePeriod: cycleDetected ? bestLag : null,
    embedding,
    persistenceSignature,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 8/9/10. Dynamic Confidence + Uncertainty + Risk
// ─────────────────────────────────────────────────────────────────────────

export function computeDynamicConfidence(input: {
  winner: HypothesisEvaluation;
  behaviour: DeepBehaviour;
  historicalMatch: HistoricalMatch;
  forecast: ForecastReport | undefined;
  panel: IntelligencePanel | undefined;
  meta: MetaReasoning;
  risk: DeepRiskAssessment;
  contract: ParityContract;
}): DynamicConfidence {
  const { winner, behaviour, historicalMatch, forecast, panel, meta, risk, contract } = input;
  const statistical = clampPct(winner.confidence);
  const behaviourConf = clampPct(
    50 + (behaviour.trendPersistence - 0.5) * 60 - behaviour.reversalPressure * 40 - behaviour.entropy * 20,
  );
  const historicalConf = clampPct(
    historicalMatch.matches === 0 ? 45 :
    (contract === "BUY_EVEN" ? historicalMatch.evenWinRate : historicalMatch.oddWinRate) * 100 - historicalMatch.confidenceDispersion,
  );
  const forecastConf = clampPct(forecast ? forecast.ensemble.confidence : 45);
  const consensusConf = clampPct(panel ? panel.breakdown.hypothesisStrength : 50);
  const riskConf = clampPct(risk.tradeQualityScore);
  const reasoningConf = clampPct(meta.reasoningQuality);

  // Weighted blend.
  const w = {
    statistical: 0.18,
    behaviour: 0.16,
    historical: 0.12,
    forecast: 0.14,
    consensus: 0.14,
    risk: 0.16,
    reasoning: 0.10,
  };
  const overall = clampPct(
    statistical * w.statistical +
      behaviourConf * w.behaviour +
      historicalConf * w.historical +
      forecastConf * w.forecast +
      consensusConf * w.consensus +
      riskConf * w.risk +
      reasoningConf * w.reasoning,
  );

  // Uncertainty = spread of the seven components + entropy + dispersion.
  const arr = [statistical, behaviourConf, historicalConf, forecastConf, consensusConf, riskConf, reasoningConf];
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const spread = Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
  const uncertainty = clampPct(spread + behaviour.entropy * 30 + historicalMatch.confidenceDispersion);

  return {
    statistical,
    behaviour: behaviourConf,
    historical: historicalConf,
    forecast: forecastConf,
    consensus: consensusConf,
    risk: riskConf,
    reasoning: reasoningConf,
    overall,
    uncertainty,
  };
}

export function computeRisk(input: {
  winner: HypothesisEvaluation;
  loser: HypothesisEvaluation;
  behaviour: DeepBehaviour;
  historicalMatch: HistoricalMatch;
  forecast: ForecastReport | undefined;
  panel: IntelligencePanel | undefined;
  meta: MetaReasoning;
  ops: AnalystOpinion[];
  contract: ParityContract;
}): DeepRiskAssessment {
  const { winner, loser, behaviour, historicalMatch, forecast, panel, meta, ops, contract } = input;
  const concerns: string[] = [];

  const disagreement = clamp01(
    ops.filter((o) => o.supports !== "NEUTRAL" && o.supports !== contract).length / 10,
  );
  const behaviourInstability = clamp01(1 - behaviour.behaviouralStability);
  const forecastInstability = clamp01(forecast ? 1 - forecast.ensemble.confidence / 100 : 0.5);
  const entropyRisk = behaviour.entropy;
  const marginGap = Math.max(0, winner.confidence - loser.confidence);
  const confidenceFragility = clamp01(1 - marginGap / 40 + winner.contradictionScore / 200);
  const falsePositive = clamp01(
    0.35 * disagreement +
      0.15 * behaviourInstability +
      0.15 * forecastInstability +
      0.15 * entropyRisk +
      0.20 * confidenceFragility,
  );
  const histFailure = historicalMatch.matches === 0 ? 0.5 : historicalMatch.failureRate;

  const reward = clampPct(
    100 - falsePositive * 60 - histFailure * 25 - behaviourInstability * 20,
  );
  const tradeQuality = clampPct(
    reward * 0.4 +
      (1 - falsePositive) * 100 * 0.25 +
      (1 - histFailure) * 100 * 0.15 +
      (1 - behaviourInstability) * 100 * 0.10 +
      meta.reasoningQuality * 0.10,
  );

  if (falsePositive > 0.45) concerns.push(`False-positive probability elevated (${(falsePositive * 100).toFixed(0)}%).`);
  if (histFailure > 0.5) concerns.push(`Similar historical setups failed ${(histFailure * 100).toFixed(0)}% of the time.`);
  if (behaviourInstability > 0.5) concerns.push("Behavioural stability is weak.");
  if (forecastInstability > 0.5) concerns.push("Forecast confidence is fragile.");
  if (entropyRisk > 0.85) concerns.push("Entropy is high — near-random regime.");
  if (confidenceFragility > 0.55) concerns.push("Confidence margin over the opposite hypothesis is thin.");
  if (disagreement > 0.35) concerns.push("Analyst disagreement is significant.");
  if (panel && panel.chief.decision === "DEFER") concerns.push("Chief Analyst is deferring.");

  return {
    expectedRewardQuality: reward,
    falsePositiveProbability: falsePositive,
    historicalFailureProbability: histFailure,
    analystDisagreement: disagreement,
    behaviourInstability,
    forecastInstability,
    entropyRisk,
    confidenceFragility,
    tradeQualityScore: tradeQuality,
    concerns,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 11. Trade Suppression Intelligence
// ─────────────────────────────────────────────────────────────────────────

export function evaluateSuppression(
  risk: DeepRiskAssessment,
  meta: MetaReasoning,
  dyn: DynamicConfidence,
  minTradeQuality: number,
): { triggered: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (risk.tradeQualityScore < minTradeQuality) reasons.push(`Trade quality ${risk.tradeQualityScore.toFixed(0)} < threshold ${minTradeQuality}.`);
  if (dyn.uncertainty >= 55 && dyn.overall >= 70) reasons.push(`High confidence (${dyn.overall.toFixed(0)}) paired with high uncertainty (${dyn.uncertainty.toFixed(0)}).`);
  if (meta.overconfidenceFlag) reasons.push("Meta-reasoner flagged overconfidence.");
  if (meta.weakEvidenceFlag && meta.reasoningQuality < 55) reasons.push("Weak evidence + low reasoning quality.");
  if (risk.falsePositiveProbability > 0.55) reasons.push("False-positive probability above safe threshold.");
  return { triggered: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// 12. Behavioural Explainability
// ─────────────────────────────────────────────────────────────────────────

export function buildExplanation(input: {
  contract: ParityContract;
  behaviour: DeepBehaviour;
  personality: MarketPersonality;
  historicalMatch: HistoricalMatch;
  causes: CausalHypothesis[];
  ops: AnalystOpinion[];
  meta: MetaReasoning;
  dyn: DynamicConfidence;
  risk: DeepRiskAssessment;
  sequence: SequenceIntel;
  suppression: { triggered: boolean; reasons: string[] };
}): string[] {
  const { contract, behaviour, personality, historicalMatch, causes, ops, meta, dyn, risk, sequence, suppression } = input;
  const side = contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const opposite = side === "EVEN" ? "ODD" : "EVEN";
  const agree = ops.filter((o) => o.supports === contract).map((o) => o.analyst);
  const disagree = ops.filter((o) => o.supports !== "NEUTRAL" && o.supports !== contract).map((o) => o.analyst);
  const topCauses = causes.slice(0, 3).map((c) => `${c.cause} (${(c.probability * 100).toFixed(0)}%)`).join(", ");

  const lines: string[] = [];
  lines.push(`Deep read: personality=${personality}, trend persistence ${(behaviour.trendPersistence * 100).toFixed(0)}%, reversal pressure ${(behaviour.reversalPressure * 100).toFixed(0)}%.`);
  lines.push(`Likely causes: ${topCauses}.`);
  lines.push(`Analysts agreeing on ${side}: ${agree.join(", ") || "none"}. Disagreeing: ${disagree.join(", ") || "none"}.`);
  lines.push(`Historical memory: ${historicalMatch.summary}`);
  if (sequence.cycleDetected) lines.push(`Sequence intel: cycle detected at period ${sequence.cyclePeriod}, motif strength ${(sequence.motifStrength * 100).toFixed(0)}%.`);
  else lines.push(`Sequence intel: long-range dependency ${(sequence.longRangeDependency * 100).toFixed(0)}%, motif strength ${(sequence.motifStrength * 100).toFixed(0)}%.`);
  lines.push(`Dynamic confidence — statistical ${dyn.statistical.toFixed(0)} · behaviour ${dyn.behaviour.toFixed(0)} · historical ${dyn.historical.toFixed(0)} · forecast ${dyn.forecast.toFixed(0)} · consensus ${dyn.consensus.toFixed(0)} · risk ${dyn.risk.toFixed(0)} · reasoning ${dyn.reasoning.toFixed(0)} → overall ${dyn.overall.toFixed(0)} (uncertainty ${dyn.uncertainty.toFixed(0)}).`);
  lines.push(`Trade quality ${risk.tradeQualityScore.toFixed(0)}, false-positive probability ${(risk.falsePositiveProbability * 100).toFixed(0)}%.`);
  if (meta.critiques.length) lines.push(`Meta-reasoner critiques: ${meta.critiques.join(" ")}`);
  if (risk.concerns.length) lines.push(`Reasons confidence decreased: ${risk.concerns.slice(0, 4).join(" ")}`);
  const strengths: string[] = [];
  if (behaviour.trendPersistence > 0.65) strengths.push("strong persistence");
  if (behaviour.behaviouralStability > 0.7) strengths.push("stable behaviour");
  if (historicalMatch.matches >= 5 && (contract === "BUY_EVEN" ? historicalMatch.evenWinRate : historicalMatch.oddWinRate) > 0.6) strengths.push("historical edge");
  if (dyn.uncertainty < 30) strengths.push("low uncertainty");
  if (strengths.length) lines.push(`Reasons confidence increased: ${strengths.join(", ")}.`);
  const failure: string[] = [];
  if (behaviour.reversalPressure > 0.55) failure.push(`reversal pressure could flip to ${opposite}`);
  if (behaviour.behaviouralExhaustion > 0.5) failure.push("behavioural exhaustion approaching");
  if (personality === "FAKE_TREND" || personality === "CHAOTIC") failure.push(`personality ${personality} historically traps traders`);
  if (failure.length) lines.push(`Ways this trade may fail: ${failure.join("; ")}.`);
  if (suppression.triggered) lines.push(`Trade suppression: ${suppression.reasons.join(" ")}`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────

export interface DeepReasoningInput {
  market: string;
  digits: number[];
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  regime: MarketRegime;
  hidden: HiddenRegime;
  manipulation: number;
  fluctuation: number;
  crowding: number;
  winner: HypothesisEvaluation;
  loser: HypothesisEvaluation;
  forecast: ForecastReport | undefined;
  panel: IntelligencePanel | undefined;
  contract: ParityContract;
  minTradeQuality?: number;
}

export function runDeepReasoning(input: DeepReasoningInput): DeepReasoning {
  const behaviour = computeDeepBehaviour(input);
  const { personality, confidence: personalityConfidence } = detectPersonality(behaviour);

  // Current run length in the tail (parity terms).
  let run = 0;
  for (let i = input.digits.length - 1; i >= 0; i--) {
    if (i === input.digits.length - 1 || parityOf(input.digits[i]) === parityOf(input.digits[i + 1])) run++;
    else break;
  }

  const fingerprint = buildFingerprint({
    windows: input.windows,
    transitions: input.transitions,
    runLength: run,
    behaviour,
    personality,
    contract: input.contract,
  });
  const historicalMatch = findHistoricalMatches(input.market, fingerprint, input.contract);
  const causes = inferCauses(behaviour, personality);
  const ops = collectAnalystOpinions({
    contract: input.contract,
    winner: input.winner,
    loser: input.loser,
    behaviour,
    personality,
    regime: input.regime,
    hidden: input.hidden,
    forecast: input.forecast,
    panel: input.panel,
    historicalMatch,
  });
  const meta = metaReason(ops, input.contract);
  const sequence = analyseSequence(input.digits);

  // Provisional risk (needs meta), then dynamic confidence (needs risk).
  const risk = computeRisk({
    winner: input.winner,
    loser: input.loser,
    behaviour,
    historicalMatch,
    forecast: input.forecast,
    panel: input.panel,
    meta,
    ops,
    contract: input.contract,
  });
  const dynamicConfidence = computeDynamicConfidence({
    winner: input.winner,
    behaviour,
    historicalMatch,
    forecast: input.forecast,
    panel: input.panel,
    meta,
    risk,
    contract: input.contract,
  });

  const suppression = evaluateSuppression(
    risk,
    meta,
    dynamicConfidence,
    input.minTradeQuality ?? 62,
  );

  const explanation = buildExplanation({
    contract: input.contract,
    behaviour,
    personality,
    historicalMatch,
    causes,
    ops,
    meta,
    dyn: dynamicConfidence,
    risk,
    sequence,
    suppression,
  });

  // Persist fingerprint for future similarity queries.
  storeFingerprint(input.market, fingerprint, dynamicConfidence.overall);

  return {
    behaviour,
    personality,
    personalityConfidence,
    fingerprint,
    historicalMatch,
    causes,
    analysts: ops,
    meta,
    sequence,
    dynamicConfidence,
    risk,
    suppression,
    explanation,
  };
}
