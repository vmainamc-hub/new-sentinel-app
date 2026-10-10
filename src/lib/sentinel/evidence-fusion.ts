// APEX SENTINEL — ENGINE #2: CORRELATION-AWARE EVIDENCE FUSION ENGINE.
//
// Purpose:
// Multiple Sentinel engines (Digit Psychology, Pressure, Price Action, Transition,
// Markov/Context, Simulator) consume the same underlying tick stream.
// 5 agreeing engines do NOT mean 5 independent confirmations.
//
// This engine:
//   1. Normalises evidence vectors across all active engines.
//   2. Estimates the empirical / structural correlation and collinearity between engines.
//   3. Downweights redundant confirmation to prevent false confidence.
//   4. Preserves genuinely orthogonal / distinct evidence.
//   5. Produces an effective independent evidence score and independence ratio.
//   6. Generates full attribution for every individual engine component.
//
// Note: This engine NEVER alters Green/Red digit role assignments; it determines
// how much weight the collective evidence deserves.

export type EngineSource =
  | "DIGIT_PSYCHOLOGY"
  | "PRESSURE"
  | "PRICE_ACTION"
  | "TRANSITION"
  | "CONTEXT_MARKOV"
  | "SIMULATOR_LAB";

export interface EngineEvidenceInput {
  source: EngineSource;
  label: string;
  /** Normalised directional signal: -1.0 (strongly against) to +1.0 (strongly supportive). */
  signal: number;
  /** Engine confidence: 0..100. */
  confidence: number;
  /** Base theoretical weight / priority of this engine (0.5..2.0). */
  baseWeight?: number;
  summary: string;
}

export interface EngineAttribution {
  source: EngineSource;
  label: string;
  rawSignal: number;
  confidence: number;
  rawWeight: number;
  effectiveWeight: number;
  redundancyPenalty: number;
  pointsContributed: number;
  summary: string;
}

export interface EvidenceFusionReport {
  /** 0..100 raw unadjusted agreement across engines. */
  rawAgreement: number;
  /** 0..100 correlation-adjusted effective evidence score. */
  effectiveScore: number;
  /** 0..100 metric of how truly independent the agreeing evidence is. */
  independenceScore: number;
  /** 0..100 estimate of overall evidence redundancy / overlap. */
  redundancyScore: number;
  /** Effective number of independent confirmation sources (e.g. 2.4 out of 5). */
  effectiveDegreesOfFreedom: number;
  totalEngines: number;
  /** Directional consensus: "STRONG_SUPPORT" | "MODERATE_SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG_CONFLICT" */
  consensus: "STRONG_SUPPORT" | "MODERATE_SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG_CONFLICT";
  /** Bounded ranking adjustment in score points (-6..+6). */
  rankingDelta: number;
  attributions: EngineAttribution[];
  rawAgreementVsEffective: string;
  summary: string;
}

// Structural correlation matrix between standard engine pairs consuming tick streams.
// High values denote shared information (e.g. Price Action & Pressure share ~0.70).
const ENGINE_CORRELATION: Record<EngineSource, Record<EngineSource, number>> = {
  DIGIT_PSYCHOLOGY: {
    DIGIT_PSYCHOLOGY: 1.0,
    PRESSURE: 0.45,
    PRICE_ACTION: 0.25,
    TRANSITION: 0.35,
    CONTEXT_MARKOV: 0.3,
    SIMULATOR_LAB: 0.2,
  },
  PRESSURE: {
    DIGIT_PSYCHOLOGY: 0.45,
    PRESSURE: 1.0,
    PRICE_ACTION: 0.68,
    TRANSITION: 0.4,
    CONTEXT_MARKOV: 0.38,
    SIMULATOR_LAB: 0.25,
  },
  PRICE_ACTION: {
    DIGIT_PSYCHOLOGY: 0.25,
    PRESSURE: 0.68,
    PRICE_ACTION: 1.0,
    TRANSITION: 0.3,
    CONTEXT_MARKOV: 0.28,
    SIMULATOR_LAB: 0.22,
  },
  TRANSITION: {
    DIGIT_PSYCHOLOGY: 0.35,
    PRESSURE: 0.4,
    PRICE_ACTION: 0.3,
    TRANSITION: 1.0,
    CONTEXT_MARKOV: 0.72,
    SIMULATOR_LAB: 0.3,
  },
  CONTEXT_MARKOV: {
    DIGIT_PSYCHOLOGY: 0.3,
    PRESSURE: 0.38,
    PRICE_ACTION: 0.28,
    TRANSITION: 0.72,
    CONTEXT_MARKOV: 1.0,
    SIMULATOR_LAB: 0.32,
  },
  SIMULATOR_LAB: {
    DIGIT_PSYCHOLOGY: 0.2,
    PRESSURE: 0.25,
    PRICE_ACTION: 0.22,
    TRANSITION: 0.3,
    CONTEXT_MARKOV: 0.32,
    SIMULATOR_LAB: 1.0,
  },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Fuse evidence from multiple analytical engines with correlation and redundancy adjustment.
 */
export function fuseEvidence(inputs: EngineEvidenceInput[]): EvidenceFusionReport {
  if (!inputs.length) {
    return {
      rawAgreement: 50,
      effectiveScore: 50,
      independenceScore: 100,
      redundancyScore: 0,
      effectiveDegreesOfFreedom: 0,
      totalEngines: 0,
      consensus: "NEUTRAL",
      rankingDelta: 0,
      attributions: [],
      rawAgreementVsEffective: "No active engine inputs supplied.",
      summary: "Evidence fusion neutral (0 engines).",
    };
  }

  const n = inputs.length;
  // Calculate nominal weights based on confidence and base weight
  const nominalWeights = inputs.map((inp) => {
    const base = inp.baseWeight ?? 1.0;
    const confFactor = Math.max(0.2, inp.confidence / 100);
    return base * confFactor;
  });

  const sumNominal = nominalWeights.reduce((a, b) => a + b, 0);

  // Measure cross-engine correlation / redundancy per engine
  const effectiveWeights: number[] = new Array(n).fill(0);
  const redundancyPenalties: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const srcI = inputs[i].source;
    let redundancySum = 0;
    let otherWeightSum = 0;

    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const srcJ = inputs[j].source;
      const r = ENGINE_CORRELATION[srcI]?.[srcJ] ?? 0.3;
      // Weight correlation by the sign agreement (correlated if they agree in same direction)
      const signAlign = Math.max(0, inputs[i].signal * inputs[j].signal);
      const effectiveR = r * (0.5 + 0.5 * signAlign);
      redundancySum += nominalWeights[j] * effectiveR;
      otherWeightSum += nominalWeights[j];
    }

    const avgCollinearity = otherWeightSum > 0 ? redundancySum / otherWeightSum : 0;
    // Downweight redundant signals: reduction factor (1 / (1 + collinearity))
    const penaltyFactor = clamp(avgCollinearity, 0, 0.85);
    redundancyPenalties[i] = Math.round(penaltyFactor * 100);
    effectiveWeights[i] = nominalWeights[i] * (1 - penaltyFactor * 0.65);
  }

  const sumEffective = effectiveWeights.reduce((a, b) => a + b, 0);

  // Raw weighted agreement (0..100)
  let rawWeightedSignal = 0;
  for (let i = 0; i < n; i++) {
    rawWeightedSignal += inputs[i].signal * (nominalWeights[i] / (sumNominal || 1));
  }
  const rawAgreement = Math.round(clamp(50 + rawWeightedSignal * 50, 0, 100));

  // Effective correlation-discounted signal (0..100)
  // Calculate Effective Degrees of Freedom (NeFF)
  // Neff = (sum(w))^2 / (sum_i sum_j w_i w_j R_ij)
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const srcI = inputs[i].source;
      const srcJ = inputs[j].source;
      const r = i === j ? 1.0 : (ENGINE_CORRELATION[srcI]?.[srcJ] ?? 0.3);
      denominator += nominalWeights[i] * nominalWeights[j] * r;
    }
  }

  const neff = denominator > 0 ? clamp((sumNominal * sumNominal) / denominator, 1.0, n) : n;
  const effectiveDegreesOfFreedom = Math.round(neff * 10) / 10;
  const independenceScore = Math.round(clamp((neff / n) * 100, 10, 100));
  const redundancyScore = 100 - independenceScore;

  // Shrink effective score towards 50 if evidence is highly collinear/redundant
  const independenceShrinkage = 0.6 + 0.4 * (neff / n);
  let effectiveWeightedSignal = 0;
  for (let i = 0; i < n; i++) {
    effectiveWeightedSignal += inputs[i].signal * (effectiveWeights[i] / (sumEffective || 1));
  }
  const effectiveScore = Math.round(
    clamp(50 + effectiveWeightedSignal * 50 * independenceShrinkage, 0, 100),
  );

  // Attributions
  const attributions: EngineAttribution[] = inputs.map((inp, idx) => {
    const rawWeight = Math.round((nominalWeights[idx] / (sumNominal || 1)) * 100);
    const effWeight = Math.round((effectiveWeights[idx] / (sumEffective || 1)) * 100);
    const points = Math.round(inp.signal * (effWeight / 100) * 10 * 10) / 10;

    return {
      source: inp.source,
      label: inp.label,
      rawSignal: Math.round(inp.signal * 100) / 100,
      confidence: inp.confidence,
      rawWeight,
      effectiveWeight: effWeight,
      redundancyPenalty: redundancyPenalties[idx],
      pointsContributed: points,
      summary: `${inp.label}: signal ${(inp.signal > 0 ? "+" : "") + inp.signal.toFixed(2)} (raw wt ${rawWeight}%, eff wt ${effWeight}%, redundancy -${redundancyPenalties[idx]}%)`,
    };
  });

  // Consensus classification
  let consensus: EvidenceFusionReport["consensus"] = "NEUTRAL";
  if (effectiveScore >= 75) consensus = "STRONG_SUPPORT";
  else if (effectiveScore >= 60) consensus = "MODERATE_SUPPORT";
  else if (effectiveScore <= 25) consensus = "STRONG_CONFLICT";
  else if (effectiveScore <= 40) consensus = "CONFLICT";

  // Bounded ranking adjustment (-5..+5)
  const rankingDelta =
    Math.round(clamp(((effectiveScore - 50) / 50) * 5 * (independenceScore / 100), -5, 5) * 10) /
    10;

  const rawVsEff = `Raw Agreement: ${rawAgreement}/100 across ${n} engines vs Effective Evidence: ${effectiveScore}/100 (Independence: ${independenceScore}%, Neff: ${effectiveDegreesOfFreedom}/${n})`;

  const summary = `Fused Score: ${effectiveScore}/100 (${consensus}) · Neff: ${effectiveDegreesOfFreedom} sources · Redundancy: ${redundancyScore}%`;

  return {
    rawAgreement,
    effectiveScore,
    independenceScore,
    redundancyScore,
    effectiveDegreesOfFreedom,
    totalEngines: n,
    consensus,
    rankingDelta,
    attributions,
    rawAgreementVsEffective: rawVsEff,
    summary,
  };
}
