import {
  ContractType,
  ContractDirection,
  Digit,
  CanonicalDigitState,
  MarketRegime,
} from "../../types/sentinel";
import type { ThreatReport } from "../apex/threat";
import type { DigitIntel } from "../apex/digit-intel";
import type { EvidenceProfile } from "./market-state-evidence";
import type { LosingSideAssessment } from "../../types/sentinel";
import type { MultiWindowPressureInterpretation } from "./observation-layer";

/**
 * Continuous Regime Categories as mandated by Sentinel specification
 */
export type ContinuousRegime =
  | "CALM_STABLE"
  | "TRENDING_PERSISTENT"
  | "CHOPPY_OSCILLATING"
  | "ACCUMULATION"
  | "DISPLACEMENT_MANIPULATION"
  | "DISTRIBUTION_EXHAUSTION"
  | "HIGH_VOLATILITY_UNSTABLE"
  | "UNKNOWN_INSUFFICIENT_DATA";

/**
 * Independent Regime Maturity States
 */
export type RegimeMaturityState =
  "EMERGING" | "DEVELOPING" | "ESTABLISHED" | "MATURE" | "WEAKENING";

/**
 * Independent Regime Transition States
 */
export type RegimeTransitionState = "NONE" | "EMERGING" | "DEVELOPING" | "CONFIRMED" | "COMPLETED";

export type RegimeTransitionType =
  | "STABLE_TO_TRENDING"
  | "TRENDING_TO_EXHAUSTION"
  | "TRENDING_TO_CHOPPY"
  | "TRENDING_TO_TRANSITION"
  | "TRANSITION_TO_NEW_TREND"
  | "ACCUMULATION_TO_BREAKOUT"
  | "DISTRIBUTION_TO_REVERSAL"
  | "CALM_TO_UNSTABLE"
  | "CHOPPY_TO_STABLE"
  | "STABLE_IN_REGIME";

export type RegimeStabilityLevel = "HIGH" | "MODERATE" | "FRAGILE" | "UNSTABLE";

export type RegimeCompatibilityVerdict =
  | "COMPATIBLE"
  | "PARTIALLY_COMPATIBLE"
  | "CONFLICTING"
  | "TRANSITIONING"
  | "UNKNOWN"
  | "HIGHLY_FAVORABLE"
  | "SUB_OPTIMAL"
  | "INCOMPATIBLE"
  | "REGIME_BREAK";

/**
 * Digit Momentum Model (0-4 UNDER vs 5-9 OVER)
 */
export type DigitMomentumSide = "UNDER" | "OVER" | "BALANCED" | "UNKNOWN";

export type DigitMomentumState =
  "ACCELERATING" | "STABLE" | "DECELERATING" | "REVERSING" | "BALANCED" | "UNKNOWN";

export interface DigitMomentumReport {
  momentum_side: DigitMomentumSide;
  momentum_state: DigitMomentumState;
  momentum_strength: number; // 0.0 - 1.0
  momentum_acceleration: number; // -1.0 to +1.0 (signed)
  momentum_confidence: number; // 0.0 - 1.0
  under_momentum_score: number; // 0.0 - 1.0 (share of 0-4 velocity/pressure/freq)
  over_momentum_score: number; // 0.0 - 1.0 (share of 5-9 velocity/pressure/freq)
  regime_momentum_alignment: string; // Regime-specific momentum interpretation
  // camelCase aliases
  momentumSide: DigitMomentumSide;
  momentumState: DigitMomentumState;
  momentumStrength: number;
  momentumAcceleration: number;
  momentumConfidence: number;
  underMomentumScore: number;
  overMomentumScore: number;
  regimeMomentumAlignment: string;
}

export interface RegimeCompatibilityAssessment {
  isCompatible: boolean;
  compatibilityScore: number; // 0 - 100
  verdict: RegimeCompatibilityVerdict;
  reason: string;
  staleEvidenceDiscount: number; // 0.0 (no discount) to 0.7 (heavy discount on previous regime evidence)
}

export interface RegimeConditionedStats {
  comboKey: string; // e.g. "1HZ10V::UNDER_7::UNDER::DIGIT_4::CALM_STABLE"
  regime: ContinuousRegime;
  sampleSize: number;
  effectiveSampleSize: number;
  winRate: number;
  wilsonLowerBound: number;
  isSufficientSample: boolean;
  discountedWinRate: number;
  freshness: number; // 0.0 - 1.0
  fallbackLevel: "EXACT_COMBO" | "REGIME_DIRECTION" | "POOLED_BASELINE";
  summary: string;
}

export interface ContinuousRegimeReport {
  currentRegime: ContinuousRegime;
  current_regime: ContinuousRegime;
  previousRegime: ContinuousRegime | null;
  previous_regime: ContinuousRegime | null;
  displayName: string;
  display_name: string;
  legacyRegime: MarketRegime;
  confidence: number; // 0 - 100
  regime_confidence: number; // 0 - 100
  regimeAgeTicks: number;
  regime_age: number;
  regimeAgeMs: number;
  regime_age_ms: number;
  stability: RegimeStabilityLevel;
  stabilityScore: number; // 0 - 100
  regime_stability: number; // 0.0 - 1.0
  maturity: RegimeMaturityState;
  regime_maturity: RegimeMaturityState;

  // Transition
  transition_state: RegimeTransitionState;
  transitionState: RegimeTransitionState;
  transition_from: ContinuousRegime | null;
  transitionFrom: ContinuousRegime | null;
  transition_to: ContinuousRegime | null;
  transitionTo: ContinuousRegime | null;
  transitionProbability: number; // 0 - 100%
  transition_probability: number;
  transitionConfidence: number; // 0 - 100%
  transition_confidence: number;
  transitionAge: number; // ticks
  transition_age: number;
  activeTransition: RegimeTransitionType;
  transitionDisplayName: string;
  transition_display_name: string;
  isTransitioning: boolean;
  is_transitioning: boolean;

  // Candidate Probabilities
  candidate_probabilities: Record<ContinuousRegime, number>;
  candidateProbabilities: Record<ContinuousRegime, number>;

  // Digit Momentum
  momentum: DigitMomentumReport;
  momentum_side: DigitMomentumSide;
  momentum_state: DigitMomentumState;
  momentum_strength: number;
  momentum_acceleration: number;
  momentum_confidence: number;

  // Evidence
  evidence: string[];
  supporting_evidence: string[];
  supportingEvidence: string[];
  conflicting_evidence: string[];
  conflictingEvidence: string[];
  regime_specific_evidence: string[];
  regimeSpecificEvidence: string[];
  evidence_freshness: number; // 0.0 - 1.0
  evidenceFreshness: number;
  last_regime_change: number; // epoch
  lastRegimeChange: number;

  // Compatibility & Stats
  compatibility: RegimeCompatibilityAssessment;
  regimeSpecificStats: RegimeConditionedStats;
  regime_specific_stats: RegimeConditionedStats;
  lastUpdatedEpoch: number;
}

export interface RegimeObserverInput {
  market: string;
  contract: ContractType;
  direction: ContractDirection;
  entryDigit: Digit | null;
  canonicalState: CanonicalDigitState;
  recentQuoteTicks: number[];
  pressure?: MultiWindowPressureInterpretation;
  losingSide?: LosingSideAssessment;
  dangerScore: number;
  dangerTrend?: "DECREASING" | "STABLE" | "INCREASING";
  evidenceProfile?: EvidenceProfile;
  digitIntel?: DigitIntel | null;
  threatReport?: ThreatReport | null;
  historyLength?: number;
}

export const REGIME_DISPLAY_NAMES: Record<ContinuousRegime, string> = {
  CALM_STABLE: "CALM/STABLE",
  TRENDING_PERSISTENT: "TRENDING/PERSISTENT",
  CHOPPY_OSCILLATING: "CHOPPY/OSCILLATING",
  ACCUMULATION: "ACCUMULATION",
  DISPLACEMENT_MANIPULATION: "DISPLACEMENT/MANIPULATION",
  DISTRIBUTION_EXHAUSTION: "DISTRIBUTION/EXHAUSTION",
  HIGH_VOLATILITY_UNSTABLE: "HIGH-VOLATILITY/UNSTABLE",
  UNKNOWN_INSUFFICIENT_DATA: "UNKNOWN/INSUFFICIENT DATA",
};

export const TRANSITION_DISPLAY_NAMES: Record<RegimeTransitionType, string> = {
  STABLE_TO_TRENDING: "STABLE → TRENDING",
  TRENDING_TO_EXHAUSTION: "TRENDING → EXHAUSTION",
  TRENDING_TO_CHOPPY: "TRENDING → CHOPPY",
  TRENDING_TO_TRANSITION: "TRENDING → TRANSITION",
  TRANSITION_TO_NEW_TREND: "TRANSITION → NEW TREND",
  ACCUMULATION_TO_BREAKOUT: "ACCUMULATION → BREAKOUT/DISPLACEMENT",
  DISTRIBUTION_TO_REVERSAL: "DISTRIBUTION → REVERSAL",
  CALM_TO_UNSTABLE: "CALM → UNSTABLE",
  CHOPPY_TO_STABLE: "CHOPPY → STABLE",
  STABLE_IN_REGIME: "STABLE IN REGIME",
};

/**
 * Stateful Continuous Regime & Digit Momentum Observer
 * Maintains persistent contextual surveillance for every independent MARKET × CONTRACT
 */
export class ContinuousRegimeObserver {
  private regimeHistory: Map<
    string,
    {
      currentRegime: ContinuousRegime;
      previousRegime: ContinuousRegime | null;
      regimeEnteredEpoch: number;
      ticksInRegime: number;
      prevRegimes: ContinuousRegime[];
      lastTransition: RegimeTransitionType;
      transitionState: RegimeTransitionState;
      transitionFrom: ContinuousRegime | null;
      transitionTo: ContinuousRegime | null;
      transitionAgeTicks: number;
      transitionDetectedEpoch: number;
      previousProbabilities: Record<ContinuousRegime, number>;
      previousUnderScore: number;
      previousOverScore: number;
      previousMomentumSide: DigitMomentumSide;
      momentumHistory: { under: number; over: number; side: DigitMomentumSide }[];
      lastRegimeChangeEpoch: number;
    }
  > = new Map();

  // Regime-Conditioned Memory: MARKET::CONTRACT::DIRECTION::DIGIT::REGIME
  private conditionedRecords: Map<
    string,
    {
      wins: number;
      trades: number;
      lastUpdatedEpoch: number;
    }
  > = new Map();

  private getContextKey(market: string, contract: ContractType): string {
    return `${market}::${contract}`;
  }

  public getConditionedKey(
    market: string,
    contract: ContractType,
    direction: ContractDirection,
    digit: Digit | null,
    regime: ContinuousRegime,
  ): string {
    const digitKey = digit !== null ? `DIGIT_${digit}` : "ANY_DIGIT";
    return `${market}::${contract}::${direction}::${digitKey}::${regime}`;
  }

  /**
   * Records a resolved trade outcome into the regime-conditioned store
   */
  public recordTradeOutcome(
    market: string,
    contract: ContractType,
    direction: ContractDirection,
    digit: Digit | null,
    regime: ContinuousRegime,
    isWin: boolean,
  ): void {
    const key = this.getConditionedKey(market, contract, direction, digit, regime);
    const existing = this.conditionedRecords.get(key) || {
      wins: 0,
      trades: 0,
      lastUpdatedEpoch: Date.now(),
    };
    existing.trades += 1;
    if (isWin) existing.wins += 1;
    existing.lastUpdatedEpoch = Date.now();
    this.conditionedRecords.set(key, existing);
  }

  /**
   * Reset context (useful for testing)
   */
  public resetContext(market?: string, contract?: ContractType): void {
    if (market && contract) {
      this.regimeHistory.delete(this.getContextKey(market, contract));
    } else {
      this.regimeHistory.clear();
      this.conditionedRecords.clear();
    }
  }

  /**
   * Continuously observe the current market regime & digit momentum for this specific context
   */
  public observe(input: RegimeObserverInput): ContinuousRegimeReport {
    const {
      market,
      contract,
      direction,
      entryDigit,
      canonicalState,
      recentQuoteTicks,
      pressure,
      losingSide,
      dangerScore,
      dangerTrend = "STABLE",
      evidenceProfile,
      historyLength = canonicalState.totalTicks,
    } = input;

    const contextKey = this.getContextKey(market, contract);
    const historyState = this.regimeHistory.get(contextKey) || {
      currentRegime: "UNKNOWN_INSUFFICIENT_DATA",
      previousRegime: null,
      regimeEnteredEpoch: Date.now(),
      ticksInRegime: 0,
      prevRegimes: [],
      lastTransition: "STABLE_IN_REGIME",
      transitionState: "NONE",
      transitionFrom: null,
      transitionTo: null,
      transitionAgeTicks: 0,
      transitionDetectedEpoch: 0,
      previousProbabilities: this.getInitialProbabilities(),
      previousUnderScore: 0.5,
      previousOverScore: 0.5,
      previousMomentumSide: "BALANCED",
      momentumHistory: [],
      lastRegimeChangeEpoch: Date.now(),
    };

    // 1. Check for Insufficient Data
    if ((canonicalState.totalTicks && canonicalState.totalTicks < 15) || historyLength < 1) {
      const defaultProbs = this.getInitialProbabilities();
      defaultProbs.UNKNOWN_INSUFFICIENT_DATA = 1.0;
      defaultProbs.CALM_STABLE = 0.0;

      const unkMomentum = this.buildUnknownMomentum();
      const unkReport: ContinuousRegimeReport = {
        currentRegime: "UNKNOWN_INSUFFICIENT_DATA",
        current_regime: "UNKNOWN_INSUFFICIENT_DATA",
        previousRegime: historyState.previousRegime,
        previous_regime: historyState.previousRegime,
        displayName: REGIME_DISPLAY_NAMES.UNKNOWN_INSUFFICIENT_DATA,
        display_name: REGIME_DISPLAY_NAMES.UNKNOWN_INSUFFICIENT_DATA,
        legacyRegime: "CALM",
        confidence: 20,
        regime_confidence: 20,
        regimeAgeTicks: 0,
        regime_age: 0,
        regimeAgeMs: 0,
        regime_age_ms: 0,
        stability: "UNSTABLE",
        stabilityScore: 20,
        regime_stability: 0.2,
        maturity: "EMERGING",
        regime_maturity: "EMERGING",
        transition_state: "NONE",
        transitionState: "NONE",
        transition_from: null,
        transitionFrom: null,
        transition_to: null,
        transitionTo: null,
        transitionProbability: 0,
        transition_probability: 0,
        transitionConfidence: 0,
        transition_confidence: 0,
        transitionAge: 0,
        transition_age: 0,
        activeTransition: "STABLE_IN_REGIME",
        transitionDisplayName: TRANSITION_DISPLAY_NAMES.STABLE_IN_REGIME,
        transition_display_name: TRANSITION_DISPLAY_NAMES.STABLE_IN_REGIME,
        isTransitioning: false,
        is_transitioning: false,
        candidate_probabilities: defaultProbs,
        candidateProbabilities: defaultProbs,
        momentum: unkMomentum,
        momentum_side: "UNKNOWN",
        momentum_state: "UNKNOWN",
        momentum_strength: 0,
        momentum_acceleration: 0,
        momentum_confidence: 0,
        evidence: ["Sample size below minimum statistical threshold (<30 ticks)"],
        supporting_evidence: [],
        supportingEvidence: [],
        conflicting_evidence: ["Insufficient tick data to classify regime reliably"],
        conflictingEvidence: ["Insufficient tick data to classify regime reliably"],
        regime_specific_evidence: ["Awaiting 30+ tick historical stabilization"],
        regimeSpecificEvidence: ["Awaiting 30+ tick historical stabilization"],
        evidence_freshness: 0.1,
        evidenceFreshness: 0.1,
        last_regime_change: historyState.lastRegimeChangeEpoch,
        lastRegimeChange: historyState.lastRegimeChangeEpoch,
        compatibility: {
          isCompatible: false,
          compatibilityScore: 25,
          verdict: "UNKNOWN",
          reason: "Insufficient tick data to classify regime reliably.",
          staleEvidenceDiscount: 0.5,
        },
        regimeSpecificStats: {
          comboKey: this.getConditionedKey(
            market,
            contract,
            direction,
            entryDigit,
            "UNKNOWN_INSUFFICIENT_DATA",
          ),
          regime: "UNKNOWN_INSUFFICIENT_DATA",
          sampleSize: 0,
          effectiveSampleSize: 0,
          winRate: 0,
          wilsonLowerBound: 0,
          isSufficientSample: false,
          discountedWinRate: 0,
          freshness: 0.1,
          fallbackLevel: "POOLED_BASELINE",
          summary: "Insufficient data for regime-conditioned statistics.",
        },
        regime_specific_stats: {
          comboKey: this.getConditionedKey(
            market,
            contract,
            direction,
            entryDigit,
            "UNKNOWN_INSUFFICIENT_DATA",
          ),
          regime: "UNKNOWN_INSUFFICIENT_DATA",
          sampleSize: 0,
          effectiveSampleSize: 0,
          winRate: 0,
          wilsonLowerBound: 0,
          isSufficientSample: false,
          discountedWinRate: 0,
          freshness: 0.1,
          fallbackLevel: "POOLED_BASELINE",
          summary: "Insufficient data for regime-conditioned statistics.",
        },
        lastUpdatedEpoch: Date.now(),
      };
      return unkReport;
    }

    // 2. DIGIT MOMENTUM EVALUATION (0-4 UNDER vs 5-9 OVER)
    const momentum = this.evaluateDigitMomentum(canonicalState, historyState);

    // 3. CANDIDATE REGIME PROBABILITY ESTIMATION
    const entropy = canonicalState.entropy ?? 0.95;
    const quoteStdDev = this.computeQuoteStdDev(recentQuoteTicks);
    const quoteDrift = this.computeQuoteDrift(recentQuoteTicks);
    const alternationRate = evidenceProfile?.stability?.alternationRate ?? 0.45;
    const changePointDetected = evidenceProfile?.changePoint?.detected ?? false;
    const changePointConfidence = evidenceProfile?.changePoint?.confidence ?? 0;
    const losingScore = losingSide?.aggregateLosingScore ?? 25;
    const losingLevel = losingSide?.losingPressureLevel ?? "NORMAL";
    const isUnder = direction === "UNDER";

    const candidateProbs = this.computeCandidateRegimeProbabilities({
      entropy,
      quoteStdDev,
      quoteDrift,
      alternationRate,
      changePointDetected,
      changePointConfidence,
      dangerScore,
      dangerTrend,
      losingScore,
      losingLevel,
      canonicalState,
      momentum,
      isUnder,
      evidenceProfile,
      pressure,
    });

    // 4. REGIME SELECTION & AMBIGUITY HANDLING
    const sortedRegimes = (Object.keys(candidateProbs) as ContinuousRegime[]).sort(
      (a, b) => candidateProbs[b] - candidateProbs[a],
    );
    const topRegime = sortedRegimes[0];
    const topProb = candidateProbs[topRegime];
    const runnerUpRegime = sortedRegimes[1];
    const runnerUpProb = candidateProbs[runnerUpRegime];

    // Determine detected regime (never force certainty if data is insufficient or top probability is below statistical floor)
    let detectedRegime: ContinuousRegime = topRegime;
    if (
      (canonicalState.totalTicks && canonicalState.totalTicks < 15) ||
      (topProb < 0.24 && topProb - runnerUpProb < 0.04)
    ) {
      detectedRegime = "UNKNOWN_INSUFFICIENT_DATA";
    }

    // 5. REGIME MATURITY MODELING
    const maturity = this.evaluateRegimeMaturity(
      detectedRegime,
      historyState.currentRegime,
      historyState.ticksInRegime,
      topProb,
      runnerUpProb,
      momentum,
    );

    // 6. REGIME TRANSITION DETECTION
    const transitionReport = this.evaluateRegimeTransition({
      currentRegime: detectedRegime,
      previousRegime: historyState.currentRegime,
      currentProb: topProb,
      runnerUpRegime,
      runnerUpProb,
      previousProbs: historyState.previousProbabilities,
      historyState,
      momentum,
      changePointDetected,
      changePointConfidence,
    });

    // 7. BEHAVIORAL EVIDENCE ARRAYS (Supporting vs Conflicting)
    const { supportingEvidence, conflictingEvidence, regimeSpecificEvidence } =
      this.extractEvidenceArrays({
        regime: detectedRegime,
        maturity,
        transition: transitionReport,
        momentum,
        entropy,
        quoteStdDev,
        quoteDrift,
        alternationRate,
        dangerScore,
        dangerTrend,
        losingLevel,
        losingScore,
        canonicalState,
        pressure,
      });

    // 8. UPDATE TEMPORAL PERSISTENCE
    const isNewRegime =
      historyState.currentRegime !== "UNKNOWN_INSUFFICIENT_DATA" &&
      detectedRegime !== historyState.currentRegime;
    const lastRegimeChange = isNewRegime
      ? Date.now()
      : historyState.lastRegimeChangeEpoch || Date.now();

    if (isNewRegime) {
      historyState.prevRegimes.push(historyState.currentRegime);
      if (historyState.prevRegimes.length > 10) historyState.prevRegimes.shift();
      historyState.previousRegime = historyState.currentRegime;
      historyState.currentRegime = detectedRegime;
      historyState.regimeEnteredEpoch = Date.now();
      historyState.ticksInRegime = 1;
      historyState.lastRegimeChangeEpoch = Date.now();
    } else {
      historyState.ticksInRegime += 1;
    }

    historyState.previousProbabilities = { ...candidateProbs };
    historyState.lastTransition = transitionReport.activeTransition;
    historyState.transitionState = transitionReport.transitionState;
    historyState.transitionFrom = transitionReport.transitionFrom;
    historyState.transitionTo = transitionReport.transitionTo;
    historyState.transitionAgeTicks = transitionReport.isTransitioning
      ? historyState.transitionAgeTicks + 1
      : 0;
    this.regimeHistory.set(contextKey, historyState);

    // 9. REGIME COMPATIBILITY EVALUATION (Setup vs Regime)
    const compatibility = this.evaluateCompatibility(
      contract,
      direction,
      detectedRegime,
      transitionReport.activeTransition,
      transitionReport.isTransitioning,
      momentum,
    );

    // 10. REGIME-SPECIFIC STATISTICAL EVIDENCE
    const regimeSpecificStats = this.computeConditionedStats(
      market,
      contract,
      direction,
      entryDigit,
      detectedRegime,
      compatibility.staleEvidenceDiscount,
    );

    // Compute stability
    const stabilityScore = Math.round(
      Math.max(
        10,
        Math.min(
          100,
          topProb * 100 -
            (transitionReport.isTransitioning ? 25 : 0) -
            conflictingEvidence.length * 5,
        ),
      ),
    );
    const stabilityLevel: RegimeStabilityLevel =
      stabilityScore >= 75
        ? "HIGH"
        : stabilityScore >= 50
          ? "MODERATE"
          : stabilityScore >= 30
            ? "FRAGILE"
            : "UNSTABLE";

    const legacyRegime = this.mapToLegacyRegime(detectedRegime);
    const confidence = Math.round(Math.min(98, Math.max(20, topProb * 100)));
    const freshness = Math.max(
      0.1,
      Number((1.0 - (Date.now() - lastRegimeChange) / 3600000).toFixed(2)),
    );

    const fullReport: ContinuousRegimeReport = {
      currentRegime: detectedRegime,
      current_regime: detectedRegime,
      previousRegime: historyState.previousRegime,
      previous_regime: historyState.previousRegime,
      displayName: REGIME_DISPLAY_NAMES[detectedRegime],
      display_name: REGIME_DISPLAY_NAMES[detectedRegime],
      legacyRegime,
      confidence,
      regime_confidence: confidence,
      regimeAgeTicks: historyState.ticksInRegime,
      regime_age: historyState.ticksInRegime,
      regimeAgeMs: Date.now() - historyState.regimeEnteredEpoch,
      regime_age_ms: Date.now() - historyState.regimeEnteredEpoch,
      stability: stabilityLevel,
      stabilityScore,
      regime_stability: Number((stabilityScore / 100).toFixed(2)),
      maturity,
      regime_maturity: maturity,
      transition_state: transitionReport.transitionState,
      transitionState: transitionReport.transitionState,
      transition_from: transitionReport.transitionFrom,
      transitionFrom: transitionReport.transitionFrom,
      transition_to: transitionReport.transitionTo,
      transitionTo: transitionReport.transitionTo,
      transitionProbability: transitionReport.transitionProbability,
      transition_probability: transitionReport.transitionProbability,
      transitionConfidence: transitionReport.transitionConfidence,
      transition_confidence: transitionReport.transitionConfidence,
      transitionAge: historyState.transitionAgeTicks,
      transition_age: historyState.transitionAgeTicks,
      activeTransition: transitionReport.activeTransition,
      transitionDisplayName:
        TRANSITION_DISPLAY_NAMES[transitionReport.activeTransition] || "STABLE IN REGIME",
      transition_display_name:
        TRANSITION_DISPLAY_NAMES[transitionReport.activeTransition] || "STABLE IN REGIME",
      isTransitioning: transitionReport.isTransitioning,
      is_transitioning: transitionReport.isTransitioning,
      candidate_probabilities: candidateProbs,
      candidateProbabilities: candidateProbs,
      momentum,
      momentum_side: momentum.momentum_side,
      momentum_state: momentum.momentum_state,
      momentum_strength: momentum.momentum_strength,
      momentum_acceleration: momentum.momentum_acceleration,
      momentum_confidence: momentum.momentum_confidence,
      evidence: [...supportingEvidence, ...conflictingEvidence],
      supporting_evidence: supportingEvidence,
      supportingEvidence,
      conflicting_evidence: conflictingEvidence,
      conflictingEvidence,
      regime_specific_evidence: regimeSpecificEvidence,
      regimeSpecificEvidence,
      evidence_freshness: freshness,
      evidenceFreshness: freshness,
      last_regime_change: lastRegimeChange,
      lastRegimeChange,
      compatibility,
      regimeSpecificStats,
      regime_specific_stats: regimeSpecificStats,
      lastUpdatedEpoch: Date.now(),
    };

    return fullReport;
  }

  /**
   * First-Class Digit Momentum Observer (0-4 UNDER vs 5-9 OVER)
   */
  private evaluateDigitMomentum(
    canonical: CanonicalDigitState,
    historyState: any,
  ): DigitMomentumReport {
    const stats = canonical.digitStats || {};

    let underFreq = 0;
    let overFreq = 0;
    let underVel = 0;
    let overVel = 0;
    let underPressure = 0;
    let overPressure = 0;
    let underRecent20 = 0;
    let overRecent20 = 0;

    for (let d = 0; d <= 4; d++) {
      const s = stats[d as Digit];
      if (s) {
        underFreq += s.percentage || 10;
        underVel += Math.max(0, s.velocity || 0);
        underPressure += s.pressure || 50;
        underRecent20 += s.recentCount20 || 2;
      } else {
        underFreq += 10;
        underPressure += 50;
        underRecent20 += 2;
      }
    }

    for (let d = 5; d <= 9; d++) {
      const s = stats[d as Digit];
      if (s) {
        overFreq += s.percentage || 10;
        overVel += Math.max(0, s.velocity || 0);
        overPressure += s.pressure || 50;
        overRecent20 += s.recentCount20 || 2;
      } else {
        overFreq += 10;
        overPressure += 50;
        overRecent20 += 2;
      }
    }

    // Normalized relative scores (0.0 to 1.0)
    const totFreq = underFreq + overFreq || 100;
    const totVel = underVel + overVel || 0.1;
    const totPress = underPressure + overPressure || 100;
    const totRecent = underRecent20 + overRecent20 || 20;

    const underScore = Number(
      (
        (underFreq / totFreq) * 0.35 +
        (underVel / totVel) * 0.25 +
        (underPressure / totPress) * 0.25 +
        (underRecent20 / totRecent) * 0.15
      ).toFixed(3),
    );

    const overScore = Number(
      (
        (overFreq / totFreq) * 0.35 +
        (overVel / totVel) * 0.25 +
        (overPressure / totPress) * 0.25 +
        (overRecent20 / totRecent) * 0.15
      ).toFixed(3),
    );

    // Determine current side
    const diff = underScore - overScore;
    let side: DigitMomentumSide = "BALANCED";
    if (diff > 0.06) {
      side = "UNDER";
    } else if (diff < -0.06) {
      side = "OVER";
    } else {
      side = "BALANCED";
    }

    const strength = Number((Math.abs(diff) / Math.max(0.01, underScore + overScore)).toFixed(2));

    // Calculate momentum change & acceleration over time
    const prevUnder = historyState.previousUnderScore ?? 0.5;
    const prevOver = historyState.previousOverScore ?? 0.5;
    const prevSide = historyState.previousMomentumSide ?? "BALANCED";

    const underDelta = underScore - prevUnder;
    const overDelta = overScore - prevOver;

    // Signed acceleration towards current dominant side
    let acceleration = 0;
    if (side === "UNDER") {
      acceleration = Number(Math.max(-1.0, Math.min(1.0, underDelta * 5)).toFixed(2));
    } else if (side === "OVER") {
      acceleration = Number(Math.max(-1.0, Math.min(1.0, overDelta * 5)).toFixed(2));
    } else {
      acceleration = 0;
    }

    // Determine momentum state
    let momentumState: DigitMomentumState = "STABLE";
    if (prevSide !== "BALANCED" && side !== "BALANCED" && prevSide !== side && strength >= 0.12) {
      momentumState = "REVERSING";
    } else if (side === "BALANCED" || strength <= 0.08) {
      momentumState = "BALANCED";
    } else if (acceleration > 0.08) {
      momentumState = "ACCELERATING";
    } else if (acceleration < -0.08) {
      momentumState = "DECELERATING";
    } else {
      momentumState = "STABLE";
    }

    const confidence = Number(
      Math.min(
        1.0,
        Math.max(0.2, 0.4 + strength * 0.4 + (canonical.totalTicks >= 50 ? 0.2 : 0.05)),
      ).toFixed(2),
    );

    // Update history
    historyState.previousUnderScore = underScore;
    historyState.previousOverScore = overScore;
    historyState.previousMomentumSide = side;
    historyState.momentumHistory.push({ under: underScore, over: overScore, side });
    if (historyState.momentumHistory.length > 20) historyState.momentumHistory.shift();

    const regimeAlignment = `${side} momentum ${momentumState} (Str: ${(strength * 100).toFixed(0)}%, Acc: ${acceleration > 0 ? "+" : ""}${acceleration})`;

    return {
      momentum_side: side,
      momentum_state: momentumState,
      momentum_strength: strength,
      momentum_acceleration: acceleration,
      momentum_confidence: confidence,
      under_momentum_score: underScore,
      over_momentum_score: overScore,
      regime_momentum_alignment: regimeAlignment,
      // camelCase
      momentumSide: side,
      momentumState: momentumState,
      momentumStrength: strength,
      momentumAcceleration: acceleration,
      momentumConfidence: confidence,
      underMomentumScore: underScore,
      overMomentumScore: overScore,
      regimeMomentumAlignment: regimeAlignment,
    };
  }

  /**
   * Evaluates probability distribution across candidate regimes
   */
  private computeCandidateRegimeProbabilities(params: {
    entropy: number;
    quoteStdDev: number;
    quoteDrift: number;
    alternationRate: number;
    changePointDetected: boolean;
    changePointConfidence: number;
    dangerScore: number;
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING";
    losingScore: number;
    losingLevel: string;
    canonicalState: CanonicalDigitState;
    momentum: DigitMomentumReport;
    isUnder: boolean;
    evidenceProfile?: EvidenceProfile;
    pressure?: MultiWindowPressureInterpretation;
  }): Record<ContinuousRegime, number> {
    const rawScores: Record<ContinuousRegime, number> = {
      CALM_STABLE: 10,
      TRENDING_PERSISTENT: 10,
      CHOPPY_OSCILLATING: 10,
      ACCUMULATION: 10,
      DISPLACEMENT_MANIPULATION: 5,
      DISTRIBUTION_EXHAUSTION: 5,
      HIGH_VOLATILITY_UNSTABLE: 5,
      UNKNOWN_INSUFFICIENT_DATA: 2,
    };

    const {
      entropy,
      quoteStdDev,
      quoteDrift,
      alternationRate,
      changePointDetected,
      changePointConfidence,
      dangerScore,
      dangerTrend,
      losingScore,
      losingLevel,
      canonicalState,
      momentum,
      isUnder,
      evidenceProfile,
      pressure,
    } = params;

    // 1. HIGH_VOLATILITY_UNSTABLE Fingerprint
    if (
      dangerScore >= 45 ||
      quoteStdDev > 3.0 ||
      (dangerTrend === "INCREASING" && dangerScore >= 35)
    ) {
      rawScores.HIGH_VOLATILITY_UNSTABLE += 45 + dangerScore * 0.4;
    }

    // 2. DISPLACEMENT_MANIPULATION Fingerprint
    if (
      (momentum.momentum_state === "ACCELERATING" &&
        momentum.momentum_strength >= 0.35 &&
        quoteStdDev > 2.5) ||
      (isUnder &&
        canonicalState.mostIncreasingDigit >= 7 &&
        (canonicalState.digitStats[canonicalState.mostIncreasingDigit]?.velocity ?? 0) > 0.45) ||
      (!isUnder &&
        canonicalState.mostIncreasingDigit <= 2 &&
        (canonicalState.digitStats[canonicalState.mostIncreasingDigit]?.velocity ?? 0) > 0.45) ||
      (losingLevel === "HOSTILE" && losingScore >= 65)
    ) {
      rawScores.DISPLACEMENT_MANIPULATION += 40 + momentum.momentum_strength * 30;
    }

    // 3. DISTRIBUTION_EXHAUSTION Fingerprint
    if (
      (momentum.momentum_state === "DECELERATING" && losingScore >= 35) ||
      momentum.momentum_state === "REVERSING" ||
      (dangerTrend === "INCREASING" && losingScore >= 40) ||
      evidenceProfile?.regime === "DISTRIBUTION"
    ) {
      rawScores.DISTRIBUTION_EXHAUSTION += 35 + losingScore * 0.4;
    }

    // 4. ACCUMULATION Fingerprint (Pressure/momentum building with low displacement)
    if (
      (entropy < 0.88 &&
        momentum.momentum_strength >= 0.15 &&
        Math.abs(quoteDrift) < 0.8 &&
        dangerScore <= 25) ||
      evidenceProfile?.regime === "ACCUMULATION"
    ) {
      rawScores.ACCUMULATION += 38 + (1.0 - entropy) * 40;
    }

    // 5. CHOPPY_OSCILLATING Fingerprint (High alternation, frequent reversals, low directional efficiency)
    if (
      alternationRate >= 0.6 ||
      (momentum.momentum_state === "REVERSING" && alternationRate >= 0.52) ||
      evidenceProfile?.regime === "CHOPPY" ||
      evidenceProfile?.streakTransition?.transition === "CHOPPY_ALTERNATING"
    ) {
      rawScores.CHOPPY_OSCILLATING += 35 + alternationRate * 45;
    }

    // 6. TRENDING_PERSISTENT Fingerprint (Directional drift, same-side momentum persistence, low reversals)
    if (
      (Math.abs(quoteDrift) > 1.2 &&
        momentum.momentum_strength >= 0.2 &&
        (momentum.momentum_state === "ACCELERATING" || momentum.momentum_state === "STABLE")) ||
      (isUnder && momentum.momentum_side === "UNDER" && canonicalState.greenDigit <= 3) ||
      (!isUnder && momentum.momentum_side === "OVER" && canonicalState.greenDigit >= 6) ||
      evidenceProfile?.stability?.label === "TRENDING"
    ) {
      rawScores.TRENDING_PERSISTENT += 40 + momentum.momentum_strength * 35;
    }

    // 7. CALM_STABLE Fingerprint (Low danger, contained stdDev, balanced entropy)
    if (
      dangerScore <= 32 &&
      quoteStdDev <= 2.2 &&
      entropy >= 0.85 &&
      losingScore <= 32 &&
      alternationRate <= 0.52
    ) {
      rawScores.CALM_STABLE += 45 + (100 - dangerScore) * 0.35;
    }

    // Normalize probabilities to sum to 1.0
    const totalScore = Object.values(rawScores).reduce((a, b) => a + b, 0);
    const probabilities: Record<ContinuousRegime, number> = {} as any;
    for (const key of Object.keys(rawScores) as ContinuousRegime[]) {
      probabilities[key] = Number((rawScores[key] / totalScore).toFixed(3));
    }

    return probabilities;
  }

  /**
   * Independent Regime Maturity Assessment
   */
  private evaluateRegimeMaturity(
    currentRegime: ContinuousRegime,
    previousRegime: ContinuousRegime | null,
    ticksInRegime: number,
    topProb: number,
    runnerUpProb: number,
    momentum: DigitMomentumReport,
  ): RegimeMaturityState {
    if (currentRegime === "UNKNOWN_INSUFFICIENT_DATA") {
      return "EMERGING";
    }

    // Check for weakening: probability dropping significantly or runner-up overtaking, or momentum reversing
    if (
      ticksInRegime > 10 &&
      (topProb < 0.3 || topProb - runnerUpProb < 0.05 || momentum.momentum_state === "REVERSING")
    ) {
      return "WEAKENING";
    }

    if (ticksInRegime <= 8) {
      return "EMERGING";
    } else if (ticksInRegime <= 20) {
      return "DEVELOPING";
    } else if (ticksInRegime <= 60) {
      return "ESTABLISHED";
    } else {
      return "MATURE";
    }
  }

  /**
   * Independent Regime Transition Assessment
   */
  private evaluateRegimeTransition(params: {
    currentRegime: ContinuousRegime;
    previousRegime: ContinuousRegime | null;
    currentProb: number;
    runnerUpRegime: ContinuousRegime;
    runnerUpProb: number;
    previousProbs: Record<ContinuousRegime, number>;
    historyState: any;
    momentum: DigitMomentumReport;
    changePointDetected: boolean;
    changePointConfidence: number;
  }): {
    activeTransition: RegimeTransitionType;
    transitionState: RegimeTransitionState;
    transitionFrom: ContinuousRegime | null;
    transitionTo: ContinuousRegime | null;
    transitionProbability: number;
    transitionConfidence: number;
    isTransitioning: boolean;
  } {
    const {
      currentRegime,
      previousRegime,
      currentProb,
      runnerUpRegime,
      runnerUpProb,
      previousProbs,
      momentum,
      changePointDetected,
      changePointConfidence,
    } = params;

    let activeTransition: RegimeTransitionType = "STABLE_IN_REGIME";
    let transitionState: RegimeTransitionState = "NONE";
    let transitionFrom: ContinuousRegime | null = null;
    let transitionTo: ContinuousRegime | null = null;
    let transitionProbability = 0;
    let transitionConfidence = 0;
    let isTransitioning = false;

    const prevProbOfCurrent = previousProbs[currentRegime] || 0.5;
    const probDelta = currentProb - prevProbOfCurrent;

    // Condition 1: Direct switch in top classification
    if (
      previousRegime &&
      previousRegime !== "UNKNOWN_INSUFFICIENT_DATA" &&
      previousRegime !== currentRegime
    ) {
      isTransitioning = true;
      transitionState = "CONFIRMED";
      transitionFrom = previousRegime;
      transitionTo = currentRegime;
      transitionProbability = Math.round(Math.min(95, currentProb * 100 + 15));
      transitionConfidence = 85;

      activeTransition = this.mapTransitionPair(previousRegime, currentRegime);
    }
    // Condition 2: Competing regime gaining material statistical support (e.g. Current = 0.48, RunnerUp = 0.41)
    else if (currentProb < 0.55 && runnerUpProb >= 0.32 && currentProb - runnerUpProb <= 0.15) {
      isTransitioning = true;
      transitionState = "DEVELOPING";
      transitionFrom = currentRegime;
      transitionTo = runnerUpRegime;
      transitionProbability = Math.round(
        Math.min(90, (runnerUpProb / (currentProb + runnerUpProb)) * 100 + 10),
      );
      transitionConfidence = 70;

      activeTransition = this.mapTransitionPair(currentRegime, runnerUpRegime);
    }
    // Condition 3: Change point or momentum reversal indicating emerging transition
    else if (
      changePointDetected ||
      changePointConfidence >= 65 ||
      momentum.momentum_state === "REVERSING"
    ) {
      isTransitioning = true;
      transitionState = "EMERGING";
      transitionFrom = currentRegime;
      transitionTo = runnerUpRegime;
      transitionProbability = Math.round(Math.max(50, changePointConfidence || 60));
      transitionConfidence = 65;

      activeTransition = this.mapTransitionPair(currentRegime, runnerUpRegime);
    }

    return {
      activeTransition,
      transitionState,
      transitionFrom,
      transitionTo,
      transitionProbability,
      transitionConfidence,
      isTransitioning,
    };
  }

  private mapTransitionPair(from: ContinuousRegime, to: ContinuousRegime): RegimeTransitionType {
    if (from === "CALM_STABLE" && to === "TRENDING_PERSISTENT") return "STABLE_TO_TRENDING";
    if (from === "TRENDING_PERSISTENT" && to === "DISTRIBUTION_EXHAUSTION")
      return "TRENDING_TO_EXHAUSTION";
    if (from === "TRENDING_PERSISTENT" && to === "CHOPPY_OSCILLATING") return "TRENDING_TO_CHOPPY";
    if (from === "TRENDING_PERSISTENT" && to === "HIGH_VOLATILITY_UNSTABLE")
      return "CALM_TO_UNSTABLE";
    if (
      from === "ACCUMULATION" &&
      (to === "TRENDING_PERSISTENT" || to === "DISPLACEMENT_MANIPULATION")
    )
      return "ACCUMULATION_TO_BREAKOUT";
    if (
      from === "DISTRIBUTION_EXHAUSTION" &&
      (to === "DISPLACEMENT_MANIPULATION" ||
        to === "HIGH_VOLATILITY_UNSTABLE" ||
        to === "CHOPPY_OSCILLATING")
    )
      return "DISTRIBUTION_TO_REVERSAL";
    if ((from === "CALM_STABLE" || from === "ACCUMULATION") && to === "HIGH_VOLATILITY_UNSTABLE")
      return "CALM_TO_UNSTABLE";
    if (from === "CHOPPY_OSCILLATING" && (to === "CALM_STABLE" || to === "ACCUMULATION"))
      return "CHOPPY_TO_STABLE";
    return "TRENDING_TO_TRANSITION";
  }

  /**
   * Evidence Array Extraction (Supporting, Conflicting, Regime-Specific)
   */
  private extractEvidenceArrays(params: {
    regime: ContinuousRegime;
    maturity: RegimeMaturityState;
    transition: any;
    momentum: DigitMomentumReport;
    entropy: number;
    quoteStdDev: number;
    quoteDrift: number;
    alternationRate: number;
    dangerScore: number;
    dangerTrend: string;
    losingLevel: string;
    losingScore: number;
    canonicalState: CanonicalDigitState;
    pressure?: MultiWindowPressureInterpretation;
  }): {
    supportingEvidence: string[];
    conflictingEvidence: string[];
    regimeSpecificEvidence: string[];
  } {
    const supporting: string[] = [];
    const conflicting: string[] = [];
    const regimeSpecific: string[] = [];

    const {
      regime,
      maturity,
      transition,
      momentum,
      entropy,
      quoteStdDev,
      quoteDrift,
      alternationRate,
      dangerScore,
      dangerTrend,
      losingLevel,
      losingScore,
      canonicalState,
      pressure,
    } = params;

    // Regime specific evidence
    regimeSpecific.push(`Regime State: ${REGIME_DISPLAY_NAMES[regime]} [${maturity}]`);
    regimeSpecific.push(momentum.regime_momentum_alignment);

    if (regime === "CALM_STABLE") {
      supporting.push(
        `Contained volatility profile (StdDev: ${quoteStdDev.toFixed(2)}, Danger: ${dangerScore}/100)`,
      );
      supporting.push(`Balanced digit entropy (${entropy.toFixed(2)})`);
      if (momentum.momentum_state === "ACCELERATING") {
        regimeSpecific.push(
          `Early directional momentum developing (${momentum.momentum_side} accelerating)`,
        );
      }
    } else if (regime === "TRENDING_PERSISTENT") {
      supporting.push(
        `Persistent directional drift (drift: ${quoteDrift > 0 ? "+" : ""}${quoteDrift.toFixed(2)})`,
      );
      if (momentum.momentum_state === "ACCELERATING" || momentum.momentum_state === "STABLE") {
        supporting.push(
          `Same-side momentum ${momentum.momentum_state} (${momentum.momentum_side} strength: ${(momentum.momentum_strength * 100).toFixed(0)}%)`,
        );
      } else if (momentum.momentum_state === "DECELERATING") {
        conflicting.push("Trend momentum decelerating — maturity reaching upper boundary");
      }
    } else if (regime === "CHOPPY_OSCILLATING") {
      regimeSpecific.push(
        `High outcome flip rate (${Math.round(alternationRate * 100)}% alternation)`,
      );
      if (momentum.momentum_state === "BALANCED" || momentum.momentum_state === "REVERSING") {
        regimeSpecific.push("Alternating UNDER/OVER momentum confirms oscillation");
      }
    } else if (regime === "ACCUMULATION") {
      supporting.push(
        `Structural accumulation with low displacement (entropy: ${entropy.toFixed(2)})`,
      );
      if (momentum.momentum_state === "ACCELERATING") {
        supporting.push("Momentum building without upper-level displacement (compression)");
      }
    } else if (regime === "DISPLACEMENT_MANIPULATION") {
      conflicting.push(
        `Abnormal digit displacement / volatility burst (Hostile level: ${losingLevel})`,
      );
    } else if (regime === "DISTRIBUTION_EXHAUSTION") {
      conflicting.push("Winning streak momentum decaying as opposing pressure begins rising");
      if (momentum.momentum_state === "DECELERATING" || momentum.momentum_state === "REVERSING") {
        conflicting.push(
          `Established momentum ${momentum.momentum_state} with rising opposing pressure`,
        );
      }
    } else if (regime === "HIGH_VOLATILITY_UNSTABLE") {
      conflicting.push(
        `Elevated market danger (${dangerScore}/100) with rapid volatility acceleration`,
      );
    }

    if (transition.isTransitioning) {
      conflicting.push(
        `Active regime transition: ${TRANSITION_DISPLAY_NAMES[transition.activeTransition as RegimeTransitionType]} (${transition.transitionProbability}% probability)`,
      );
    }

    if (dangerTrend === "INCREASING") {
      conflicting.push(`Market danger trajectory is INCREASING (+${dangerScore})`);
    }

    return {
      supportingEvidence: supporting,
      conflictingEvidence: conflicting,
      regimeSpecificEvidence: regimeSpecific,
    };
  }

  /**
   * Evaluates Setup vs Regime Compatibility ("Is this market setup appropriate for the CURRENT regime?")
   */
  private evaluateCompatibility(
    contract: ContractType,
    direction: ContractDirection,
    regime: ContinuousRegime,
    transition: RegimeTransitionType,
    isTransitioning: boolean,
    momentum: DigitMomentumReport,
  ): RegimeCompatibilityAssessment {
    const isUnder = direction === "UNDER";
    let isCompatible = false;
    let score = 50;
    let verdict: RegimeCompatibilityVerdict = "COMPATIBLE";
    let reason = "";
    let staleDiscount = isTransitioning ? 0.35 : 0.0;

    // Hard ineligibility under hostile or breaking regimes
    if (regime === "HIGH_VOLATILITY_UNSTABLE") {
      return {
        isCompatible: false,
        compatibilityScore: 15,
        verdict: "CONFLICTING",
        reason: "Market is in HIGH-VOLATILITY/UNSTABLE regime — all contract setups suspended.",
        staleEvidenceDiscount: 0.6,
      };
    }

    if (regime === "DISPLACEMENT_MANIPULATION") {
      return {
        isCompatible: false,
        compatibilityScore: 20,
        verdict: "CONFLICTING",
        reason:
          "Market is undergoing sharp displacement/manipulation contrary to structural stability.",
        staleEvidenceDiscount: 0.5,
      };
    }

    if (transition === "CALM_TO_UNSTABLE" || transition === "DISTRIBUTION_TO_REVERSAL") {
      return {
        isCompatible: false,
        compatibilityScore: 22,
        verdict: "TRANSITIONING",
        reason: `Adverse regime transition active (${TRANSITION_DISPLAY_NAMES[transition]}).`,
        staleEvidenceDiscount: 0.55,
      };
    }

    if (regime === "UNKNOWN_INSUFFICIENT_DATA") {
      return {
        isCompatible: false,
        compatibilityScore: 25,
        verdict: "UNKNOWN",
        reason: "Insufficient statistical evidence to establish regime compatibility.",
        staleEvidenceDiscount: 0.5,
      };
    }

    // Direction-Specific Matrix
    if (isUnder) {
      switch (regime) {
        case "CALM_STABLE":
          isCompatible = true;
          score = 92;
          verdict = "COMPATIBLE";
          reason = "CALM/STABLE regime minimizes sudden upper-tail barrier breaches.";
          break;
        case "TRENDING_PERSISTENT":
          if (momentum.momentum_side === "OVER" && momentum.momentum_state === "ACCELERATING") {
            isCompatible = false;
            score = 35;
            verdict = "CONFLICTING";
            reason =
              "TRENDING regime is moving in opposing OVER direction with accelerating 5-9 momentum.";
          } else {
            isCompatible = true;
            score = 88;
            verdict = "COMPATIBLE";
            reason =
              "TRENDING regime with low-digit clustering directly supports UNDER trajectory.";
          }
          break;
        case "ACCUMULATION":
          isCompatible = true;
          score = 86;
          verdict = "COMPATIBLE";
          reason = "ACCUMULATION regime provides compressed variance favorable to UNDER structure.";
          break;
        case "CHOPPY_OSCILLATING":
          isCompatible = false;
          score = 42;
          verdict = "CONFLICTING";
          reason =
            "CHOPPY/OSCILLATING regime produces unpredictable digit alternations threatening UNDER barrier.";
          staleDiscount = 0.25;
          break;
        case "DISTRIBUTION_EXHAUSTION":
          isCompatible = false;
          score = 30;
          verdict = "CONFLICTING";
          reason = "DISTRIBUTION/EXHAUSTION regime signals imminent upward mean-reversion spikes.";
          staleDiscount = 0.4;
          break;
        default:
          isCompatible = false;
          score = 30;
          verdict = "UNKNOWN";
          reason = "Unclassified or unstable regime.";
      }
    } else {
      // OVER Contracts
      switch (regime) {
        case "TRENDING_PERSISTENT":
          if (momentum.momentum_side === "UNDER" && momentum.momentum_state === "ACCELERATING") {
            isCompatible = false;
            score = 35;
            verdict = "CONFLICTING";
            reason = "TRENDING regime is moving downward with accelerating 0-4 UNDER momentum.";
          } else {
            isCompatible = true;
            score = 90;
            verdict = "COMPATIBLE";
            reason =
              "TRENDING regime with upper-digit persistence strongly supports OVER execution.";
          }
          break;
        case "ACCUMULATION":
          isCompatible = true;
          score = 84;
          verdict = "COMPATIBLE";
          reason = "ACCUMULATION preparing breakout aligns with OVER upside expansion.";
          break;
        case "CALM_STABLE":
          isCompatible = true;
          score = 75;
          verdict = "COMPATIBLE";
          reason = "CALM/STABLE regime is compatible with baseline OVER theoretical edge.";
          break;
        case "CHOPPY_OSCILLATING":
          isCompatible = false;
          score = 38;
          verdict = "CONFLICTING";
          reason = "CHOPPY/OSCILLATING regime produces frequent zero/low digit drops.";
          staleDiscount = 0.25;
          break;
        case "DISTRIBUTION_EXHAUSTION":
          isCompatible = false;
          score = 25;
          verdict = "CONFLICTING";
          reason = "DISTRIBUTION/EXHAUSTION regime signals exhaustion of upward momentum.";
          staleDiscount = 0.45;
          break;
        default:
          isCompatible = false;
          score = 30;
          verdict = "UNKNOWN";
          reason = "Unclassified or unstable regime.";
      }
    }

    if (transition === "TRENDING_TO_EXHAUSTION" && isCompatible) {
      isCompatible = false;
      verdict = "TRANSITIONING";
      score = Math.max(35, score - 35);
      reason += " Warning: Transition to EXHAUSTION in progress.";
      staleDiscount = Math.max(staleDiscount, 0.4);
    } else if (transition === "TRENDING_TO_CHOPPY" && isCompatible) {
      isCompatible = false;
      verdict = "TRANSITIONING";
      score = Math.max(38, score - 30);
      reason += " Warning: Market transitioning from TRENDING to CHOPPY.";
      staleDiscount = Math.max(staleDiscount, 0.35);
    }

    return {
      isCompatible,
      compatibilityScore: score,
      verdict,
      reason,
      staleEvidenceDiscount: staleDiscount,
    };
  }

  /**
   * Conditions statistical win rates on exact MARKET × CONTRACT × DIRECTION × ENTRY DIGIT × REGIME
   */
  private computeConditionedStats(
    market: string,
    contract: ContractType,
    direction: ContractDirection,
    digit: Digit | null,
    regime: ContinuousRegime,
    staleDiscount: number,
  ): RegimeConditionedStats {
    const comboKey = this.getConditionedKey(market, contract, direction, digit, regime);
    const record = this.conditionedRecords.get(comboKey);

    const isOver = direction === "OVER";
    const barrier = parseInt(contract.split("_")[1] || "5", 10);
    const baselineWinRate = isOver ? (10 - barrier - 1) * 10 : barrier * 10;

    if (!record || record.trades < 6) {
      return {
        comboKey,
        regime,
        sampleSize: record?.trades ?? 0,
        effectiveSampleSize: Math.round((record?.trades ?? 0) * (1 - staleDiscount)),
        winRate:
          record && record.trades > 0
            ? Number(((record.wins / record.trades) * 100).toFixed(1))
            : baselineWinRate,
        wilsonLowerBound: Number((baselineWinRate * 0.88).toFixed(1)),
        isSufficientSample: false,
        discountedWinRate: Number((baselineWinRate * (1 - staleDiscount * 0.15)).toFixed(1)),
        freshness: 0.5,
        fallbackLevel: "POOLED_BASELINE",
        summary: `Regime sample building (N=${record?.trades ?? 0}/6 min for exact ${REGIME_DISPLAY_NAMES[regime]}).`,
      };
    }

    const rawWinRate = (record.wins / record.trades) * 100;
    const z = 1.96;
    const n = record.trades;
    const p = record.wins / n;
    const denom = 1 + (z * z) / n;
    const center = p + (z * z) / (2 * n);
    const rad = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
    const wilsonLower = Math.max(0, (center - rad) / denom) * 100;

    // Apply stale discount if regime is shifting
    const discountedWinRate = rawWinRate * (1 - staleDiscount * 0.2);
    const effectiveN = Math.round(n * (1 - staleDiscount));

    return {
      comboKey,
      regime,
      sampleSize: n,
      effectiveSampleSize: effectiveN,
      winRate: Number(rawWinRate.toFixed(1)),
      wilsonLowerBound: Number(wilsonLower.toFixed(1)),
      isSufficientSample: true,
      discountedWinRate: Number(discountedWinRate.toFixed(1)),
      freshness: 0.9,
      fallbackLevel: "EXACT_COMBO",
      summary: `Regime Combo [${market} × ${contract} × ${REGIME_DISPLAY_NAMES[regime]}]: N=${n}, Win Rate=${rawWinRate.toFixed(1)}% (Wilson: ${wilsonLower.toFixed(1)}%).`,
    };
  }

  private computeQuoteStdDev(quotes: number[]): number {
    if (!quotes || quotes.length < 5) return 1.0;
    const mean = quotes.reduce((acc, q) => acc + q, 0) / quotes.length;
    const variance = quotes.reduce((acc, q) => acc + Math.pow(q - mean, 2), 0) / quotes.length;
    return Math.sqrt(variance);
  }

  private computeQuoteDrift(quotes: number[]): number {
    if (!quotes || quotes.length < 10) return 0;
    const firstHalf = quotes.slice(0, Math.floor(quotes.length / 2));
    const secondHalf = quotes.slice(Math.floor(quotes.length / 2));
    const mean1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const mean2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    return mean2 - mean1;
  }

  private getInitialProbabilities(): Record<ContinuousRegime, number> {
    return {
      CALM_STABLE: 0.3,
      TRENDING_PERSISTENT: 0.15,
      CHOPPY_OSCILLATING: 0.15,
      ACCUMULATION: 0.15,
      DISPLACEMENT_MANIPULATION: 0.05,
      DISTRIBUTION_EXHAUSTION: 0.05,
      HIGH_VOLATILITY_UNSTABLE: 0.05,
      UNKNOWN_INSUFFICIENT_DATA: 0.1,
    };
  }

  private buildUnknownMomentum(): DigitMomentumReport {
    return {
      momentum_side: "UNKNOWN",
      momentum_state: "UNKNOWN",
      momentum_strength: 0,
      momentum_acceleration: 0,
      momentum_confidence: 0,
      under_momentum_score: 0.5,
      over_momentum_score: 0.5,
      regime_momentum_alignment: "Insufficient data for digit momentum observation",
      momentumSide: "UNKNOWN",
      momentumState: "UNKNOWN",
      momentumStrength: 0,
      momentumAcceleration: 0,
      momentumConfidence: 0,
      underMomentumScore: 0.5,
      overMomentumScore: 0.5,
      regimeMomentumAlignment: "Insufficient data for digit momentum observation",
    };
  }

  private mapToLegacyRegime(regime: ContinuousRegime): MarketRegime {
    switch (regime) {
      case "CALM_STABLE":
        return "CALM";
      case "TRENDING_PERSISTENT":
        return "TRENDING";
      case "CHOPPY_OSCILLATING":
        return "CHAOTIC";
      case "ACCUMULATION":
        return "VOLATILITY_COMPRESSION";
      case "DISPLACEMENT_MANIPULATION":
        return "ACCELERATING";
      case "DISTRIBUTION_EXHAUSTION":
        return "RANGING";
      case "HIGH_VOLATILITY_UNSTABLE":
        return "UNSTABLE";
      default:
        return "CALM";
    }
  }
}

export function createDefaultContinuousRegimeReport(
  market: string = "R_100",
  contract: ContractType = "OVER_1",
): ContinuousRegimeReport {
  const candidateProbs: Record<ContinuousRegime, number> = {
    CALM_STABLE: 0.3,
    TRENDING_PERSISTENT: 0.15,
    CHOPPY_OSCILLATING: 0.15,
    ACCUMULATION: 0.15,
    DISPLACEMENT_MANIPULATION: 0.05,
    DISTRIBUTION_EXHAUSTION: 0.05,
    HIGH_VOLATILITY_UNSTABLE: 0.05,
    UNKNOWN_INSUFFICIENT_DATA: 0.1,
  };

  const momentum: DigitMomentumReport = {
    momentum_side: "UNKNOWN",
    momentum_state: "UNKNOWN",
    momentum_strength: 0,
    momentum_acceleration: 0,
    momentum_confidence: 0,
    under_momentum_score: 0.5,
    over_momentum_score: 0.5,
    regime_momentum_alignment: "Insufficient data for digit momentum observation",
    momentumSide: "UNKNOWN",
    momentumState: "UNKNOWN",
    momentumStrength: 0,
    momentumAcceleration: 0,
    momentumConfidence: 0,
    underMomentumScore: 0.5,
    overMomentumScore: 0.5,
    regimeMomentumAlignment: "Insufficient data for digit momentum observation",
  };

  const compatibility: RegimeCompatibilityAssessment = {
    isCompatible: true,
    compatibilityScore: 80,
    verdict: "COMPATIBLE",
    reason: "Baseline calm environment.",
    staleEvidenceDiscount: 0,
  };

  const regimeSpecificStats: RegimeConditionedStats = {
    comboKey: `${market}::${contract}::CALM_STABLE`,
    regime: "CALM_STABLE",
    sampleSize: 0,
    effectiveSampleSize: 0,
    winRate: 75,
    wilsonLowerBound: 65,
    discountedWinRate: 75,
    freshness: 1.0,
    fallbackLevel: "POOLED_BASELINE",
    summary: "Baseline initial stats.",
    isSufficientSample: false,
  };

  return {
    currentRegime: "CALM_STABLE",
    current_regime: "CALM_STABLE",
    previousRegime: null,
    previous_regime: null,
    displayName: "CALM/STABLE",
    display_name: "CALM/STABLE",
    legacyRegime: "CALM",
    confidence: 60,
    regime_confidence: 60,
    regimeAgeTicks: 0,
    regime_age: 0,
    regimeAgeMs: 0,
    regime_age_ms: 0,
    stability: "HIGH",
    stabilityScore: 85,
    regime_stability: 0.85,
    maturity: "ESTABLISHED",
    regime_maturity: "ESTABLISHED",
    transition_state: "NONE",
    transitionState: "NONE",
    transition_from: null,
    transitionFrom: null,
    transition_to: null,
    transitionTo: null,
    transitionProbability: 0,
    transition_probability: 0,
    transitionConfidence: 0,
    transition_confidence: 0,
    transitionAge: 0,
    transition_age: 0,
    activeTransition: "STABLE_IN_REGIME",
    transitionDisplayName: "STABLE IN REGIME",
    transition_display_name: "STABLE IN REGIME",
    isTransitioning: false,
    is_transitioning: false,
    candidate_probabilities: candidateProbs,
    candidateProbabilities: candidateProbs,
    momentum,
    momentum_side: momentum.momentum_side,
    momentum_state: momentum.momentum_state,
    momentum_strength: momentum.momentum_strength,
    momentum_acceleration: momentum.momentum_acceleration,
    momentum_confidence: momentum.momentum_confidence,
    evidence: ["Initial observation bootstrap."],
    supporting_evidence: ["Initial observation bootstrap."],
    supportingEvidence: ["Initial observation bootstrap."],
    conflicting_evidence: [],
    conflictingEvidence: [],
    regime_specific_evidence: ["Baseline calm environment."],
    regimeSpecificEvidence: ["Baseline calm environment."],
    evidence_freshness: 1.0,
    evidenceFreshness: 1.0,
    last_regime_change: Date.now(),
    lastRegimeChange: Date.now(),
    compatibility,
    regimeSpecificStats,
    regime_specific_stats: regimeSpecificStats,
    lastUpdatedEpoch: Date.now(),
  };
}

export const continuousRegimeObserver = new ContinuousRegimeObserver();
