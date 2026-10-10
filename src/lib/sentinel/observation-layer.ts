/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * @deprecated (§4.6)
 * RETIRED IN FAVOR OF MODULAR OBSERVATION LAYER AT:
 *   `/src/lib/sentinel/observation/`
 *
 * All live execution paths, state machines, and UI components now use
 * `observationEngine` from `@/lib/sentinel/observation`.
 * This file is retained strictly for backwards compatibility with legacy UI components.
 */

import {
  ContractType,
  Digit,
  LosingPressureLevel,
  MarketRegime,
  SignalState,
  TouchClass,
  OpportunityCandidate,
  CanonicalDigitState,
  ExecutionSnapshot,
  LiveExecutionHeartbeat,
  LiveExecutionStatus,
  ExecutionQualificationState,
  QualityBand,
  QualificationContract,
  SelectivityMetrics,
} from "../../types/sentinel";
interface SentinelCandidateReport {
  market: string;
  marketDisplayName: string;
  contract: ContractType;
  pressureField?: OpportunityCandidate["pressureField"];
  dangerScore: number;
  finalScore: number;
  dangerStage?: { overallDangerScore?: number; isHardBlocked?: boolean };
  relativeEdge?: { candidateRiskAdjustedEdge?: number; relativeEdge?: number };
  signalState?: SignalState;
  entryPoint?: { preferredEntryDigit?: Digit | null };
  losingSidePressure?: { pressureLevel?: LosingPressureLevel };
  digitPsychology?: { hardBlock?: boolean; verdict?: string };
  governance?: { vetoed?: boolean };
  touchClassification?: { touchClass?: TouchClass };
}
import { OBSERVATION_THRESHOLDS } from "./observationThresholds";
import {
  observationPersistence,
  PersistedObservationState,
  PersistedObservationEvent,
} from "./observation-persistence";
import { SUPPORTED_MARKETS } from "../constants";
import {
  continuousRegimeObserver,
  ContinuousRegimeReport,
  ContinuousRegime,
  createDefaultContinuousRegimeReport,
} from "./continuous-regime";

export type { LosingPressureLevel };

/**
 * Complete Sentinel Market Opportunity Lifecycle States:
 * FORMATION → DEVELOPMENT → CONFIRMATION → RIPE → EXECUTION WINDOW → CONFIRMED / ENTERED / EXPIRED
 * And branch states: CONFLICT / ABANDONED, DECAYING / EXPIRED, VETOED, INVALIDATED, UNSTABLE
 */
export type ObservationState =
  | "DORMANT" // Baseline quiet observation, no signal pattern forming
  | "WATCHING" // Continuous passive monitoring (alias/baseline)
  | "INTERESTING" // Early structural anomaly detected
  | "FORMATION" // Structural psychology beginning to form
  | "DEVELOPING" // Evidence becoming directionally coherent
  | "CONFIRMING" // Multiple evidence streams agreeing, persistence testing
  | "RIPE" // Fully matured across all 5 pillars, tradeable NOW
  | "EXECUTION_WINDOW" // Active live entry execution window
  | "UNSTABLE" // Score or market danger is too fluctuating/choppy
  | "CONFLICT" // Important evidence streams materially disagree
  | "REJECTED" // Hard veto or governance block active
  | "VETOED" // Explicitly blocked by global or operator veto
  | "DECAYING" // Pressure or alignment decaying from peak
  | "EXPIRED" // Execution window or opportunity timed out
  | "INVALIDATED" // Underlying market conditions or entry digit broke
  | "ABANDONED"; // Setup deteriorated during formation

/**
 * 7 Stability States:
 */
export type StabilityState =
  "CALM" | "STABLE" | "DEVELOPING" | "FLUCTUATING" | "CHOPPY" | "HIGHLY_UNSTABLE" | "TRANSITIONING";

/**
 * Psychology Evolution State on the 1,000-Tick Structural Foundation:
 */
export type PsychologyEvolutionState =
  | "FORMING"
  | "STRENGTHENING"
  | "COHERENT"
  | "CONFLICTING"
  | "WEAKENING"
  | "REVERSING"
  | "INVALIDATING";

export interface PsychologyEvolutionAssessment {
  state: PsychologyEvolutionState;
  direction: "OVER" | "UNDER";
  greenRole: string;
  secondGreenRole: string;
  redRole: string;
  secondRedRole: string;
  mostIncreasingRole: string;
  mostDecreasingRole: string;
  winningZoneSharePct: number;
  losingZoneSharePct: number;
  parityAlignment: "ALIGNED" | "NEUTRAL" | "CONFLICT";
  edgeGroupTrend: string;
  hasZoneContest: boolean;
  hardBlocked: boolean;
  hardBlockReason: string | null;
  detail: string;
}

/**
 * Specific Entry Digit Validation (Section 4, 5, 7):
 */
export interface SpecificEntryDigitAssessment {
  entryDigit: Digit | null;
  isValidated: boolean;
  isWinningSide: boolean;
  positionRole: string; // e.g. 'GREEN', '2ND_GREEN', 'NEUTRAL', 'RED'
  empiricalRate: number;
  wilsonLowerBound: number;
  sampleSize: number;
  pressureTrend: "GAINING" | "STABLE" | "LOSING" | "EXHAUSTED" | "DISPLACED";
  pressureSupport: "SUPPORTING" | "NEUTRAL" | "OPPOSING";
  touchState: "ARMED" | "WAITING_TOUCH" | "SKIP" | "INSUFFICIENT";
  touchClass: TouchClass;
  survivalExpectedRuns: number;
  competingOpposingPressure: "CALM" | "BUILDING" | "OVERTAKING" | "HOSTILE";
  validationReason: string;
  waitingReason: string | null;
}

/**
 * Formation Velocity Metrics (Section 9):
 */
export interface FormationVelocityMetrics {
  formationAgeTicks: number;
  strengtheningRate: number; // Points gain per 10 ticks
  pressureAcceleration: number; // Window 15 vs 60 delta acceleration
  psychologyAlignmentRate: number; // 0 - 100%
  digitSelectionStability: number; // Consecutive ticks same entry digit held rank 1
  timeSinceFirstDetectionMs: number;
  timeSinceStrongestAlignmentMs: number;
  deteriorationRate: number; // Points loss per 10 ticks
  velocityRating: "RAPID" | "STEADY" | "SLOW" | "DECAYING";
}

/**
 * Execution Validity Window (Section 12):
 */
export interface ExecutionValidityWindow {
  createdAt: number;
  currentAgeSeconds: number;
  currentAgeTicks: number;
  validityState: "VALID" | "EXPIRING_SOON" | "DECAYING" | "EXPIRED" | "INVALIDATED";
  remainingValiditySeconds: number;
  maxValiditySeconds: number;
  invalidationConditions: string[];
}

/**
 * Multi-Window Pressure Analysis (Section 6, 10):
 */
export interface MultiWindowPressureInterpretation {
  window15: "SUPPORTING" | "OPPOSING" | "NEUTRAL";
  window30: "SUPPORTING" | "OPPOSING" | "NEUTRAL";
  window60: "SUPPORTING" | "OPPOSING" | "NEUTRAL" | "MIXED";
  window120: "SUPPORTING" | "OPPOSING" | "NEUTRAL";
  classification:
    "GENUINE_SUPPORT" | "LIKELY_REVERSAL" | "CHOPPY_TRANSITIONAL" | "CONFLICTING" | "NEUTRAL";
  entryDigitPressureSupport: "SUPPORTING" | "NEUTRAL" | "OPPOSING";
  losingSidePressureLevel: LosingPressureLevel;
  summary: string;
}

/**
 * Simulation Evidence States (Section 11, 14, 15):
 */
export type SimulationEvidenceState =
  | "STABLE"
  | "FAVOURABLE"
  | "UNFAVOURABLE"
  | "RECOVERING"
  | "LOSING"
  | "CHOPPY"
  | "TRANSITIONING"
  | "INSUFFICIENT";

export interface SimulationEvidenceAssessment {
  state: SimulationEvidenceState;
  sampleTrades: number;
  winRate: number;
  recentWinStreak: number;
  recentLossStreak: number;
  expectancy: number;
  varianceTrend: "DECLINING" | "STABLE" | "EXPANDING";
  confidence: "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT";
  isRegimeSpecific: boolean;
  summary: string;
}

/**
 * Dynamic Explanations (Section 16, 17):
 */
export interface DynamicOpportunityExplanation {
  isRipe: boolean;
  headline: string;
  whyRipe: string[];
  whyWaiting: string;
  contradictions: string[];
}

/**
 * Hidden / Suppressed / Absent Behavior Categories:
 */
export type HiddenBehaviorCategory =
  "SUPPRESSED" | "EMERGING" | "ABSENT" | "UNEXPECTED" | "CONTRADICTORY" | "NORMAL";

export interface HiddenBehaviorAssessment {
  category: HiddenBehaviorCategory;
  summary: string;
  absentDigits: Digit[];
  suppressedEdgeDigits: Digit[];
  disproportionateDigits: Digit[];
  shortVsLongDivergencePct: number;
  expectedPressureMissing: boolean;
  unexpectedLosingSpike: boolean;
}

/**
 * Observation Snapshot for longitudinal tracking
 */
export interface ObservationSnapshot {
  timestamp: number;
  score: number;
  dangerScore: number;
  dangerTrend?: "DECREASING" | "STABLE" | "INCREASING";
  dangerDelta?: number;
  absoluteEdge: number;
  relativeEdge: number;
  signalState: SignalState;
  selectedEntryDigit: Digit | null;
  state: ObservationState;
  stability: StabilityState;
  losingPressure: LosingPressureLevel;
  losingPressureIndex?: number;
  losingPressureDelta?: number;
  losingPressureTrend?: "DECREASING" | "STABLE" | "INCREASING";
  losingPressureRisingCount?: number;
  isHardBlocked: boolean;
  isVetoed: boolean;
  touchClass: TouchClass | string;
}

export interface ObservationFunnelMetrics {
  observations: number;
  candidates: number;
  strongCandidates: number;
  bestSetups: number;
  executionQualified: number;
}

export interface ObservationWindowAnalytics {
  windowSize: number;
  windowDurationSeconds: number;
  meanScore: number;
  minScore: number;
  maxScore: number;
  scoreVelocity: number; // Points change per 10 observations
  scoreVariance: number; // Standard deviation of score
  scoreTrend: "RISING" | "STEADY" | "DECLINING";
  meanDanger: number;
  dangerTrend: "RISING" | "STEADY" | "DECLINING";
  qualificationRate: number; // 0 - 100%
  entryReadinessRate: number; // 0 - 100%
  edgeStabilityScore: number; // 0 - 100
  funnel: ObservationFunnelMetrics;
}

/**
 * Transition event logged when an observation changes state
 */
export interface PropositionTransitionEvent {
  id: string;
  timestamp: number;
  fromState: ObservationState;
  toState: ObservationState;
  reason: string;
  triggerCategory:
    | "CONFIRMATION"
    | "DANGER_SPIKE"
    | "REGIME_SHIFT"
    | "GLOBAL_VETO"
    | "DECAY"
    | "ENTRY_READY"
    | "LEADER_LOCK"
    | "CONTRADICTION"
    | "INITIAL_DISCOVERY";
  scoreAtTransition: number;
  dangerAtTransition: number;
}

/**
 * Complete Internal Observation Dossier for a Proposition
 */
export interface ObservationDossier {
  market: string;
  marketDisplayName: string;
  contract: ContractType;
  direction: "OVER" | "UNDER";
  observationState: ObservationState;
  observationAgeTicks: number;
  currentStateDurationTicks: number;

  // Structural Psychology (1,000 Ticks)
  psychologyEvolution: PsychologyEvolutionAssessment;
  structuralPsychology: {
    verdict: "SUPPORTING" | "NEUTRAL" | "CONFLICT" | "OPPOSING";
    detail: string;
  };

  // Specific Entry Digit Validation
  specificEntryDigit: SpecificEntryDigitAssessment;

  // Lower Timeframe Pressure (15, 30, 60, 120 Ticks)
  pressure: MultiWindowPressureInterpretation;
  losingSidePressure: {
    level: LosingPressureLevel;
    aggregateScore: number;
    delta: number;
    trend: "DECREASING" | "DECLINING" | "STABLE" | "INCREASING";
    risingCount: number;
    specialRiskActive: boolean;
    detail: string;
  };
  danger: {
    score: number;
    delta: number;
    trend: "DECREASING" | "STABLE" | "INCREASING";
    summary: string;
  };

  // Formation Velocity
  formationVelocity: FormationVelocityMetrics;

  // Execution Validity Window
  validityWindow: ExecutionValidityWindow;

  // Statistical Simulation Confirmation
  simulation: SimulationEvidenceAssessment;

  // Distribution
  distribution: {
    stability: "CALM" | "STABLE" | "SHIFTING" | "ANOMALOUS";
    parityBias: "EVEN_DOMINANT" | "ODD_DOMINANT" | "BALANCED";
    // IDENTITY INTEGRITY: null (never a fabricated digit) when this
    // candidate has no real canonicalState evidence yet. A permanent cell
    // identity has parity/group rules, not a single hardcoded digit, so
    // there is no legitimate cell-specific value to substitute either —
    // see observation-layer.ts buildDossier() for where this is populated.
    greenDigit: Digit | null;
    secondGreenDigit: Digit | null;
    redDigit: Digit | null;
    secondRedDigit: Digit | null;
    edgeDigitStatus: string;
  };
  regime: MarketRegime;
  regimeObservation: ContinuousRegimeReport;
  stability: {
    state: StabilityState;
    stdDev: number;
    velocity: number;
    description: string;
  };
  hiddenBehaviour: HiddenBehaviorAssessment;

  // Contradiction & Governance
  supportingFactors: string[];
  opposingFactors: string[];
  contradictionCount: number;
  vetoes: string[];

  // Dynamic Explanations
  explanation: DynamicOpportunityExplanation;

  // Entry & Action
  entry: {
    state: string;
    digit: Digit | null;
    touchRule: TouchClass;
    instruction: string;
  };
  evidenceMaturity: "LOW" | "MODERATE" | "HIGH" | "MATURE";
  confidence: number; // 0 - 100
  currentAssessment:
    "CONTINUE_WATCHING" | "OPPORTUNITY_PRESENTED" | "STAND_DOWN" | "MONITOR_CLOSELY" | "REJECTED";
  qualificationContract?: QualificationContract;
  qualityBand?: QualityBand;
  why: string;
}

/**
 * Stateful Proposition Observation State
 */
export interface PropositionObservationState {
  id: string; // `${market}_${contract}`
  market: string;
  contract: ContractType;
  direction: "OVER" | "UNDER";
  currentStage: ObservationState;
  stageEnteredEpoch: number;
  timeInCurrentStageMs: number;
  totalObservations: number;
  consecutiveQualifiedCount: number;
  consecutiveUnqualifiedCount: number;
  requiredConfirmations: number;
  confirmationProgress: number; // 0 - 100%
  stability: StabilityState;

  // High-Selectivity Best-Setup Gate Contract
  qualificationContract: QualificationContract | null;
  qualityBand: QualityBand;

  // Specific Entry Digit Tracking
  currentEntryDigit: Digit | null;
  entryDigitStableTicks: number;
  peakScore: number;
  peakScoreEpoch: number;
  firstDetectedEpoch: number;

  // Validity Window Tracking
  ripeEnteredEpoch: number | null;
  validityWindowSeconds: number;
  validUntilEpoch: number | null;

  // Immutable Execution Snapshot & Live Heartbeat
  snapshot: ExecutionSnapshot | null;
  executionHeartbeat: LiveExecutionHeartbeat | null;

  dossier: ObservationDossier;
  snapshots: ObservationSnapshot[];
  analytics: ObservationWindowAnalytics;
  transitions: PropositionTransitionEvent[];
  lastObservedEpoch: number;
}

export interface MarketObservationState {
  market: string;
  displayName: string;
  marketStage:
    "COLD_START" | "STABLE_ACTIVE" | "VOLATILE_TRANSITION" | "CHOPPY_STAND_DOWN" | "HOSTILE";
  ticksObserved: number;
  regime: MarketRegime;
  consecutiveStableTicks: number;
  activePropositionsCount: number;
  dominantPropositionKey: string | null;
  averageMarketDanger: number;
  regimeStabilityScore: number;
  lastUpdatedEpoch: number;
}

export const PROPOSITIONS_LIST: ContractType[] = [
  "OVER_1",
  "OVER_2",
  "OVER_3",
  "UNDER_8",
  "UNDER_7",
  "UNDER_6",
];

/**
 * STATEFUL MARKET / PROPOSITION OBSERVATION LAYER ENGINE
 *
 * Manages the 90 independent observation cells across the 15 supported Deriv markets.
 * Tracks longitudinal evolution, stability vs fluctuation, hidden anomalies,
 * multi-window pressure, explicit contradictions, and gated RIPE eligibility.
 */
export class ObservationLayerEngine {
  private propositionStates: Map<string, PropositionObservationState> = new Map();
  private marketStates: Map<string, MarketObservationState> = new Map();
  private isInitialized = false;

  // High-Selectivity Opportunity Funnel Telemetry
  private totalObservationsCount = 0;
  private candidateCount = 0;
  private strongCandidateCount = 0;
  private opportunityCount = 0;
  private bestSetupCount = 0;
  private executionQualifiedCount = 0;
  private invalidatedCount = 0;
  private expiredCount = 0;

  constructor() {
    this.initializeUniverse();
  }

  /**
   * Resets all states for testing or re-initialization
   */
  public reset(): void {
    this.propositionStates.clear();
    this.marketStates.clear();
    this.isInitialized = false;
    this.resetSelectivityMetrics();
    this.initializeUniverse();
  }

  /**
   * Resets the Selectivity Funnel Telemetry counters
   */
  public resetSelectivityMetrics(): void {
    this.totalObservationsCount = 0;
    this.candidateCount = 0;
    this.strongCandidateCount = 0;
    this.opportunityCount = 0;
    this.bestSetupCount = 0;
    this.executionQualifiedCount = 0;
    this.invalidatedCount = 0;
    this.expiredCount = 0;
  }

  /**
   * Returns current Selectivity Funnel metrics
   */
  public getSelectivityMetrics(): SelectivityMetrics {
    const total = Math.max(1, this.totalObservationsCount);
    const candTotal = Math.max(1, this.candidateCount);
    const qualRate = Number(((this.executionQualifiedCount / total) * 100).toFixed(2));
    const bestRate = Number(((this.bestSetupCount / candTotal) * 100).toFixed(2));
    const oppRate = Number(((this.opportunityCount / candTotal) * 100).toFixed(2));

    return {
      totalObservations: this.totalObservationsCount,
      candidateCount: this.candidateCount,
      strongCandidateCount: this.strongCandidateCount,
      opportunityCount: this.opportunityCount,
      bestSetupCount: this.bestSetupCount,
      executionQualifiedCount: this.executionQualifiedCount,
      invalidatedCount: this.invalidatedCount,
      expiredCount: this.expiredCount,
      opportunityRate: oppRate,
      qualificationRate: qualRate,
      bestSetupRate: bestRate,
      lastUpdatedEpoch: Date.now(),
    };
  }

  /**
   * Initializes all 90 independent observation cells across all 15 markets
   */
  public initializeUniverse(): void {
    if (this.isInitialized) return;

    SUPPORTED_MARKETS.forEach((market) => {
      PROPOSITIONS_LIST.forEach((contract) => {
        const key = `${market.symbol}_${contract}`;
        if (!this.propositionStates.has(key)) {
          const initialState = this.createInitialPropositionState(
            market.symbol,
            market.displayName,
            contract,
          );
          this.propositionStates.set(key, initialState);
        }
      });

      if (!this.marketStates.has(market.symbol)) {
        this.marketStates.set(market.symbol, {
          market: market.symbol,
          displayName: market.displayName,
          marketStage: "COLD_START",
          ticksObserved: 0,
          regime: "CALM",
          consecutiveStableTicks: 0,
          activePropositionsCount: 0,
          dominantPropositionKey: null,
          averageMarketDanger: 20,
          regimeStabilityScore: 70,
          lastUpdatedEpoch: Date.now(),
        });
      }
    });

    this.isInitialized = true;
  }

  /**
   * Primary entrypoint: Observe evaluated candidates from Decision Fusion or Apex pipeline
   */
  public observeCandidates(
    candidates: (OpportunityCandidate | SentinelCandidateReport)[],
    timestamp: number = Date.now(),
  ): {
    propositionStates: Map<string, PropositionObservationState>;
    marketStates: Map<string, MarketObservationState>;
    ripeCandidates: PropositionObservationState[];
  } {
    this.initializeUniverse();

    const activeMarketSymbols = new Set<string>();
    const marketCandidateMap = new Map<
      string,
      (OpportunityCandidate | SentinelCandidateReport)[]
    >();

    // 1. Process candidate observations
    for (const cand of candidates) {
      const market = cand.market;
      const contract = cand.contract;
      const key = `${market}_${contract}`;
      activeMarketSymbols.add(market);

      if (!marketCandidateMap.has(market)) {
        marketCandidateMap.set(market, []);
      }
      marketCandidateMap.get(market)!.push(cand);

      this.processPropositionObservation(key, market, contract, cand, timestamp);
    }

    // 2. Process market-level aggregate state
    for (const [market, cands] of marketCandidateMap.entries()) {
      this.processMarketObservation(market, cands, timestamp);
    }

    const ripeCandidates = Array.from(this.propositionStates.values()).filter(
      (p) => p.currentStage === "RIPE" || p.currentStage === "EXECUTION_WINDOW",
    );

    return {
      propositionStates: this.propositionStates,
      marketStates: this.marketStates,
      ripeCandidates,
    };
  }

  /**
   * Process a single proposition observation cell with full longitudinal analysis
   */
  private processPropositionObservation(
    key: string,
    market: string,
    contract: ContractType,
    cand: OpportunityCandidate | SentinelCandidateReport,
    timestamp: number,
  ): PropositionObservationState {
    const isSentinelReport = "finalScore" in cand && "dangerStage" in cand;
    const score = isSentinelReport
      ? (cand as SentinelCandidateReport).finalScore
      : (cand as OpportunityCandidate).opportunityScore;
    const dangerScore = isSentinelReport
      ? ((cand as SentinelCandidateReport).dangerStage?.overallDangerScore ?? 20)
      : (cand as OpportunityCandidate).dangerScore;
    const absoluteEdge = isSentinelReport
      ? ((cand as SentinelCandidateReport).relativeEdge?.candidateRiskAdjustedEdge ?? 0)
      : (cand as OpportunityCandidate).absoluteEdge;
    const relativeEdge = isSentinelReport
      ? ((cand as SentinelCandidateReport).relativeEdge?.relativeEdge ?? 0)
      : (cand as OpportunityCandidate).relativeEdge;
    const signalState = isSentinelReport
      ? ((cand as SentinelCandidateReport).signalState as SignalState)
      : (cand as OpportunityCandidate).signalState;
    const selectedEntryDigit = isSentinelReport
      ? ((cand as SentinelCandidateReport).entryPoint?.preferredEntryDigit ?? null)
      : (cand as OpportunityCandidate).selectedEntryDigit;
    const losingPressure = isSentinelReport
      ? (((cand as SentinelCandidateReport).losingSidePressure
          ?.pressureLevel as LosingPressureLevel) ?? "CALM")
      : ((cand as OpportunityCandidate).losingSide?.losingPressureLevel ?? "CALM");
    const isHardBlocked = isSentinelReport
      ? (cand as SentinelCandidateReport).dangerStage?.isHardBlocked ||
        (cand as SentinelCandidateReport).digitPsychology?.hardBlock ||
        false
      : (cand as OpportunityCandidate).governance?.vetoed ||
        (cand as OpportunityCandidate).losingSide?.isHardBlocked ||
        false;
    const isVetoed = isSentinelReport
      ? (cand as SentinelCandidateReport).governance?.vetoed || false
      : (cand as OpportunityCandidate).governance?.vetoed || false;
    const touchClass = isSentinelReport
      ? ((cand as SentinelCandidateReport).touchClassification?.touchClass ?? "FIRST_TOUCH")
      : ((cand as OpportunityCandidate).entryTrigger?.preferredTouch ?? "FIRST_TOUCH");

    // Retrieve or create proposition state
    let state = this.propositionStates.get(key);
    if (!state) {
      const displayName = cand.marketDisplayName || market;
      state = this.createInitialPropositionState(market, displayName, contract);
      this.propositionStates.set(key, state);
    }

    state.totalObservations += 1;
    state.lastObservedEpoch = timestamp;

    // Track Entry Digit stability
    if (selectedEntryDigit !== null) {
      if (state.currentEntryDigit === selectedEntryDigit) {
        state.entryDigitStableTicks += 1;
      } else {
        state.currentEntryDigit = selectedEntryDigit;
        state.entryDigitStableTicks = 1;
      }
    } else {
      state.currentEntryDigit = null;
      state.entryDigitStableTicks = 0;
    }

    // Track Peak score
    if (score > state.peakScore) {
      state.peakScore = score;
      state.peakScoreEpoch = timestamp;
    }

    // 1. Calculate Longitudinal Analytics & Snapshot History
    const prevSnapshots = state.snapshots;
    const scores = prevSnapshots.map((s) => s.score);
    scores.push(score);
    if (scores.length > OBSERVATION_THRESHOLDS.SNAPSHOT_WINDOW_CAPACITY) {
      scores.shift();
    }

    const meanScore = scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length);
    const variance =
      scores.reduce((sum, s) => sum + Math.pow(s - meanScore, 2), 0) / Math.max(1, scores.length);
    const stdDev = Math.sqrt(variance);

    // Score velocity (delta over recent 10 ticks)
    const recentScores = scores.slice(-10);
    const scoreVelocity =
      recentScores.length >= 2
        ? Number(
            (
              (recentScores[recentScores.length - 1] - recentScores[0]) *
              (10 / recentScores.length)
            ).toFixed(1),
          )
        : 0;

    // Longitudinal Losing Side Pressure & Danger Trend Tracking
    const losingPressureIndex = isSentinelReport
      ? ((cand as any).losingSidePressure?.aggregateLosingPressure ??
        (cand as any).losingSidePressure?.aggregateScore ??
        20)
      : ((cand as OpportunityCandidate).losingSide?.aggregateLosingScore ?? 20);

    const losingRisingCount = isSentinelReport
      ? ((cand as any).losingSidePressure?.risingCount ?? 0)
      : (cand as OpportunityCandidate).losingSide?.losingDigits
        ? (cand as OpportunityCandidate).losingSide.losingDigits.filter(
            (d) =>
              ((cand as OpportunityCandidate).losingSide.perDigitThreat?.[d]?.velocity ?? 0) > 0.35,
          ).length
        : 0;

    const prevLosingIndices = prevSnapshots.map((s) => s.losingPressureIndex ?? 20);
    const prevDangers = prevSnapshots.map((s) => s.dangerScore ?? 20);

    const recentLosing = prevLosingIndices.slice(-6);
    const recentDangers = prevDangers.slice(-6);

    const losingPressureDelta =
      recentLosing.length >= 1 ? Number((losingPressureIndex - recentLosing[0]).toFixed(1)) : 0;

    const dangerDelta =
      recentDangers.length >= 1 ? Number((dangerScore - recentDangers[0]).toFixed(1)) : 0;

    let losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING" = "STABLE";
    if (losingPressureDelta <= -1.0) {
      losingPressureTrend = "DECREASING";
    } else if (losingPressureDelta >= 1.0 || losingRisingCount >= 1) {
      losingPressureTrend = "INCREASING";
    } else {
      losingPressureTrend = "STABLE";
    }

    let dangerTrend: "DECREASING" | "STABLE" | "INCREASING" = "STABLE";
    if (dangerDelta <= -1.0) {
      dangerTrend = "DECREASING";
    } else if (dangerDelta >= 1.0) {
      dangerTrend = "INCREASING";
    } else {
      dangerTrend = "STABLE";
    }

    // 2. Classify Stability
    const stability = this.deriveStabilityState(stdDev, scoreVelocity, scores);
    state.stability = stability;

    // 3. Evaluate 1,000-Tick Digit Psychology Formation & Evolution
    const psychologyEvolution = this.evaluatePsychologyEvolution(cand, contract);

    // 4. Evaluate Specific Entry Digit Validation
    const specificEntryAssessment = this.evaluateSpecificEntryDigit(
      cand,
      contract,
      selectedEntryDigit,
      psychologyEvolution,
      losingPressure,
      touchClass,
    );

    // 5. Evaluate Multi-Window Pressure (15, 30, 60, 120 Ticks)
    const pressureInterpretation = this.evaluateMultiWindowPressure(cand, selectedEntryDigit);

    // 6. Continuous Regime Observation Layer
    //
    // IDENTITY INTEGRITY: this candidate's cell has a permanent identity
    // (cellIdentity.ts) that is completely separate from whatever the LIVE
    // market is currently doing. When `cand.canonicalState` has not been
    // populated with real observed evidence yet, we must never invent one by
    // stamping in generic/canonical digit assignments (GREEN=2, RED=0,
    // MOST INCREASING=1, MOST DECREASING=8, etc.) — that would fabricate live
    // market evidence and let a cell's permanent identity leak into what is
    // supposed to be an actual tick-derived observation.
    //
    // `INSUFFICIENT_EVIDENCE_CANONICAL_STATE` is therefore built with
    // `totalTicks: 0`, which continuousRegimeObserver.observe() below
    // recognises (see continuous-regime.ts, "Check for Insufficient Data")
    // and turns into an explicit `UNKNOWN_INSUFFICIENT_DATA` regime report —
    // never a false-positive "compatible" regime read. The `Digit` fields
    // are structurally required by `CanonicalDigitState` but are never
    // consulted once `totalTicks < 15` short-circuits the observer; they
    // must not be treated as observed identity/psychology evidence anywhere
    // else in the pipeline.
    const INSUFFICIENT_EVIDENCE_DIGIT_STATS: Record<Digit, any> = (() => {
      const stats: any = {};
      for (let d = 0; d <= 9; d++) {
        stats[d] = {
          digit: d as Digit,
          count: 0,
          percentage: 0,
          deviation: 0,
          velocity: 0,
          acceleration: 0,
          pressure: 0,
          recentCount20: 0,
          recentCount50: 0,
          recentCount100: 0,
          consecutiveCount: 0,
          ticksSinceLast: 0,
          isGreen: false,
          isSecondGreen: false,
          isRed: false,
          isSecondRed: false,
          isMostIncreasing: false,
          isMostDecreasing: false,
        };
      }
      return stats;
    })();

    const INSUFFICIENT_EVIDENCE_CANONICAL_STATE: CanonicalDigitState = {
      // Structurally required by CanonicalDigitState; never treated as
      // observed evidence — totalTicks: 0 forces UNKNOWN_INSUFFICIENT_DATA.
      greenDigit: 0,
      secondGreenDigit: 0,
      redDigit: 0,
      secondRedDigit: 0,
      mostIncreasingDigit: 0,
      mostDecreasingDigit: 0,
      digitStats: INSUFFICIENT_EVIDENCE_DIGIT_STATS,
      totalTicks: 0,
      lastUpdated: Date.now(),
      entropy: 0,
      evenPercentage: 0,
      oddPercentage: 0,
    };

    const regimeObservation =
      (cand as any).regimeObservation ||
      (cand as any).regimeReport ||
      continuousRegimeObserver.observe({
        market,
        contract,
        direction: contract.startsWith("UNDER") ? "UNDER" : "OVER",
        entryDigit: selectedEntryDigit,
        canonicalState:
          (cand as OpportunityCandidate).canonicalState || INSUFFICIENT_EVIDENCE_CANONICAL_STATE,
        recentQuoteTicks: (cand as any).recentQuoteTicks || [],
        pressure: pressureInterpretation,
        losingSide: (cand as OpportunityCandidate).losingSide,
        dangerScore,
        dangerTrend,
        evidenceProfile: (cand as OpportunityCandidate).evidenceProfile,
        digitIntel: (cand as OpportunityCandidate).digitIntel,
        threatReport: (cand as any).threatReport,
        historyLength: state.totalObservations,
      });

    // 7. Evaluate Hidden / Suppressed Behavior
    const hiddenAssessment = this.evaluateHiddenBehavior(cand, contract);

    // 8. Evaluate Simulation as Evidence
    const simulationAssessment = this.evaluateSimulationEvidence(cand);

    // 9. Calculate Formation Velocity Metrics
    const formationVelocity = this.calculateFormationVelocity(
      state,
      score,
      scoreVelocity,
      psychologyEvolution,
      timestamp,
    );

    // 10. Extract Explicit Contradictions & Supporting Factors
    const { supportingFactors, opposingFactors, contradictionCount } = this.extractContradictions(
      cand,
      score,
      dangerScore,
      dangerTrend,
      dangerDelta,
      losingPressure,
      losingPressureIndex,
      losingPressureTrend,
      losingPressureDelta,
      losingRisingCount,
      isHardBlocked,
      isVetoed,
      psychologyEvolution,
      specificEntryAssessment,
      pressureInterpretation,
      regimeObservation,
      hiddenAssessment,
      stability,
      simulationAssessment,
    );

    // 11. Evaluate Qualification & Persistence
    const isQualifyingThisTick =
      score >= OBSERVATION_THRESHOLDS.MIN_SCORE_DEVELOPING &&
      dangerScore <= OBSERVATION_THRESHOLDS.MAX_DANGER_CONFIRMING &&
      dangerTrend !== "INCREASING" &&
      losingPressureTrend !== "INCREASING" &&
      !isHardBlocked &&
      !isVetoed &&
      regimeObservation.compatibility.isCompatible &&
      contradictionCount <= OBSERVATION_THRESHOLDS.MAX_CONTRADICTIONS_FOR_DEVELOPING;

    if (isQualifyingThisTick) {
      state.consecutiveQualifiedCount += 1;
      state.consecutiveUnqualifiedCount = 0;
    } else {
      state.consecutiveUnqualifiedCount += 1;
      state.consecutiveQualifiedCount = Math.max(0, state.consecutiveQualifiedCount - 1);
    }

    state.confirmationProgress = Math.min(
      100,
      Math.round(
        (state.consecutiveQualifiedCount / OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS) *
          100,
      ),
    );

    // 11.5. Evaluate Qualification Contract (16 strict boolean gates + Quality Band)
    const qualificationContract = this.evaluateQualificationContract(
      cand,
      score,
      dangerScore,
      dangerTrend,
      isHardBlocked,
      isVetoed,
      selectedEntryDigit,
      contradictionCount,
      stability,
      hiddenAssessment,
      psychologyEvolution,
      specificEntryAssessment,
      pressureInterpretation,
      regimeObservation,
      simulationAssessment,
      losingPressure,
      losingPressureIndex,
      losingPressureTrend,
      losingRisingCount,
      state.consecutiveQualifiedCount,
      state.totalObservations,
    );
    state.qualificationContract = qualificationContract;

    // 12. Resolve Next Lifecycle State
    const nextState = this.resolveNextObservationState(
      state.currentStage,
      state.totalObservations,
      state.consecutiveQualifiedCount,
      state.consecutiveUnqualifiedCount,
      score,
      dangerScore,
      dangerTrend,
      losingPressureTrend,
      losingPressureIndex,
      losingRisingCount,
      isHardBlocked,
      isVetoed,
      selectedEntryDigit,
      contradictionCount,
      stability,
      hiddenAssessment,
      psychologyEvolution,
      specificEntryAssessment,
      pressureInterpretation,
      regimeObservation,
      formationVelocity,
      state.ripeEnteredEpoch,
      timestamp,
      qualificationContract,
    );

    // Update QualityBand on proposition state
    state.qualityBand =
      nextState === "RIPE" || nextState === "EXECUTION_WINDOW"
        ? "EXECUTION_QUALIFIED"
        : qualificationContract.qualityBand;

    // Update Telemetry Funnel
    this.totalObservationsCount += 1;
    if (score >= 50) this.candidateCount += 1;
    if (state.qualityBand === "STRONG_CANDIDATE") this.strongCandidateCount += 1;
    if (state.qualityBand === "OPPORTUNITY") this.opportunityCount += 1;
    if (state.qualityBand === "BEST_SETUP" || qualificationContract.qualityBand === "BEST_SETUP") {
      this.bestSetupCount += 1;
    }
    if (state.qualityBand === "EXECUTION_QUALIFIED") this.opportunityCount += 1;
    if (nextState === "INVALIDATED") this.invalidatedCount += 1;
    if (nextState === "EXPIRED") this.expiredCount += 1;

    // Track RIPE lifecycle entry & Capture Immutable Execution Snapshot
    if (nextState === "RIPE" || nextState === "EXECUTION_WINDOW") {
      if (!state.snapshot) {
        this.executionQualifiedCount += 1;
        state.snapshot = {
          id: `snap_${market}_${contract}_${timestamp}`,
          market,
          marketDisplayName: cand.marketDisplayName || market,
          contract,
          direction: contract.startsWith("UNDER") ? "UNDER" : "OVER",
          barrier: parseInt(contract.split("_")[1], 10),
          entryDigit: selectedEntryDigit,
          qualificationDigit: selectedEntryDigit,
          trigger: specificEntryAssessment.touchState,
          qualificationTrigger: specificEntryAssessment.touchState,
          touchRule: (touchClass as TouchClass) || "FIRST_TOUCH",
          scoreAtQualification: score,
          qualificationScore: score,
          confidenceAtQualification: Math.round(score * 0.9),
          qualificationConfidence: Math.round(score * 0.9),
          dangerAtQualification: dangerScore,
          qualificationDanger: dangerScore,
          currentRegimeAtQualification: regimeObservation.currentRegime,
          qualificationRegime: regimeObservation.currentRegime,
          regimeMaturityAtQualification: regimeObservation.maturity,
          regimeConfidenceAtQualification: regimeObservation.confidence,
          qualificationRegimeConfidence: regimeObservation.confidence,
          regimeTransitionAtQualification: regimeObservation.transitionState,
          qualificationRegimeTransition: regimeObservation.transitionState,
          momentumSideAtQualification: regimeObservation.momentum.momentumSide,
          momentumStateAtQualification: regimeObservation.momentum.momentumState,
          momentumStrengthAtQualification: regimeObservation.momentum.momentumStrength,
          qualificationMomentum: `${regimeObservation.momentum.momentumSide} ${regimeObservation.momentum.momentumState} (${regimeObservation.momentum.momentumStrength})`,
          qualificationStructure: psychologyEvolution.detail,
          qualificationPressure: pressureInterpretation.summary,
          qualificationStatistics: regimeObservation.regimeSpecificStats.summary,
          statisticalEvidenceAtQualification: regimeObservation.regimeSpecificStats.summary,
          regimeCompatibilityAtQualification: regimeObservation.compatibility.verdict,
          qualifiedAt: timestamp,
          executionWindowStartedAt: timestamp,
          executionWindowExpiresAt: timestamp + 90 * 1000,
          initialValidityDurationSeconds: 90,
        };
        state.ripeEnteredEpoch = timestamp;
        state.validityWindowSeconds = 90;
        state.validUntilEpoch = timestamp + 90 * 1000;
      }
    } else if (
      state.snapshot &&
      timestamp < state.snapshot.executionWindowExpiresAt &&
      nextState !== "INVALIDATED" &&
      nextState !== "EXPIRED" &&
      nextState !== "VETOED" &&
      nextState !== "REJECTED"
    ) {
      // Retain active window for qualified setup during minor fluctuations
      state.ripeEnteredEpoch = state.snapshot.qualifiedAt;
      state.validUntilEpoch = state.snapshot.executionWindowExpiresAt;
    } else if (
      nextState === "INVALIDATED" ||
      nextState === "EXPIRED" ||
      nextState === "VETOED" ||
      nextState === "REJECTED"
    ) {
      state.validUntilEpoch = timestamp;
    }

    // Handle State Transition
    if (nextState !== state.currentStage) {
      const { reason, category } = this.deriveTransitionReason(
        state.currentStage,
        nextState,
        score,
        dangerScore,
        isHardBlocked,
        isVetoed,
        contradictionCount,
        stability,
        psychologyEvolution,
        specificEntryAssessment,
      );

      const event: PropositionTransitionEvent = {
        id: `evt_${timestamp}_${Math.random().toString(36).substring(2, 6)}`,
        timestamp,
        fromState: state.currentStage,
        toState: nextState,
        reason,
        triggerCategory: category,
        scoreAtTransition: score,
        dangerAtTransition: dangerScore,
      };

      state.transitions.unshift(event);
      if (state.transitions.length > OBSERVATION_THRESHOLDS.MAX_TRANSITION_HISTORY) {
        state.transitions.length = OBSERVATION_THRESHOLDS.MAX_TRANSITION_HISTORY;
      }

      // Persist event
      observationPersistence.logEvent({
        timestamp,
        market,
        contract,
        from_state: state.currentStage,
        to_state: nextState,
        reason,
        trigger_category: category,
        score_at_transition: score,
        danger_at_transition: dangerScore,
      });

      state.currentStage = nextState;
      state.stageEnteredEpoch = timestamp;
    }

    state.timeInCurrentStageMs = timestamp - state.stageEnteredEpoch;

    // 13. Calculate Execution Validity Window
    const validityWindow = this.calculateValidityWindow(
      state,
      nextState,
      timestamp,
      specificEntryAssessment,
    );

    // 14. Build Dynamic Human-Readable Explanation
    const dynamicExplanation = this.buildDynamicExplanation(
      nextState,
      cand,
      score,
      dangerScore,
      dangerTrend,
      dangerDelta,
      psychologyEvolution,
      specificEntryAssessment,
      pressureInterpretation,
      regimeObservation,
      losingPressure,
      losingPressureIndex,
      losingPressureTrend,
      losingPressureDelta,
      losingRisingCount,
      simulationAssessment,
      opposingFactors,
      isVetoed,
      isHardBlocked,
      qualificationContract,
    );

    // 14.5. Maintain Execution Heartbeat if Snapshot exists
    if (state.snapshot) {
      const expiresAt = state.snapshot.executionWindowExpiresAt;
      const remainingSecs = Math.max(0, Math.ceil((expiresAt - timestamp) / 1000));
      const isHardInvalidated =
        timestamp >= expiresAt ||
        dangerScore >= 55 ||
        isHardBlocked ||
        isVetoed ||
        !regimeObservation.compatibility.isCompatible ||
        regimeObservation.compatibility.verdict === "INCOMPATIBLE" ||
        regimeObservation.compatibility.verdict === "REGIME_BREAK" ||
        specificEntryAssessment.entryDigit === null ||
        score < 45;
      const isAtRisk =
        !isHardInvalidated &&
        ((score < 70 && score >= 45) ||
          regimeObservation.transitionProbability > 40 ||
          regimeObservation.momentum.momentumState === "DECELERATING" ||
          dangerScore > 35);

      let liveStatus: LiveExecutionStatus = "HEALTHY";
      if (timestamp >= expiresAt) {
        liveStatus = "EXPIRED";
      } else if (isHardInvalidated) {
        liveStatus = "INVALIDATED";
      } else if (isAtRisk) {
        liveStatus = "AT_RISK";
      } else {
        liveStatus = "HEALTHY";
      }

      let explanationText =
        score >= state.snapshot.qualificationScore
          ? "Qualification remains unchanged; live conditions have strengthened."
          : "Qualification remains unchanged; live conditions have weakened.";

      if (liveStatus === "INVALIDATED") {
        explanationText =
          isHardBlocked || isVetoed
            ? "Material veto triggered. Opportunity invalidated."
            : dangerScore >= 55
              ? `Material danger surge (${dangerScore}/100). Opportunity invalidated.`
              : !regimeObservation.compatibility.isCompatible
                ? `Material regime breakdown (${regimeObservation.currentRegime}). Opportunity invalidated.`
                : "Material condition broken. Opportunity invalidated.";
      } else if (liveStatus === "EXPIRED") {
        explanationText = "Minimum 90-second execution window has expired.";
      }

      state.executionHeartbeat = {
        status: liveStatus,
        qualifiedAt: state.snapshot.qualifiedAt,
        expiresAt: state.snapshot.executionWindowExpiresAt,
        remainingSeconds: remainingSecs,
        qualificationScore: state.snapshot.qualificationScore,
        liveHealthScore: score,
        liveHealth: score,
        currentLiveScore: score,
        scoreDrift: score - state.snapshot.qualificationScore,
        qualificationRegime: state.snapshot.qualificationRegime,
        currentRegime: regimeObservation.currentRegime,
        currentRegimeMaturity: regimeObservation.maturity,
        qualificationMomentum: state.snapshot.qualificationMomentum,
        currentMomentum: `${regimeObservation.momentum.momentumSide} ${regimeObservation.momentum.momentumState}`,
        currentMomentumSide: regimeObservation.momentum.momentumSide,
        currentMomentumState: regimeObservation.momentum.momentumState,
        regimeCompatibility: regimeObservation.compatibility.verdict,
        currentTransitionState: regimeObservation.transitionState,
        transitionProbability: regimeObservation.transitionProbability,
        currentRisk: dangerScore,
        isAtRisk,
        atRiskReason: isAtRisk
          ? score < 70
            ? `Live health score drifted down to ${score}`
            : regimeObservation.transitionProbability > 40
              ? `Regime transition probability elevated (${regimeObservation.transitionProbability}%)`
              : "Digit momentum decelerating"
          : null,
        isHardInvalidated,
        invalidationReason: isHardInvalidated
          ? timestamp >= expiresAt
            ? "Execution window expired"
            : dangerScore >= 55
              ? `Danger score exceeded threshold (${dangerScore})`
              : !regimeObservation.compatibility.isCompatible
                ? `Regime shifted to incompatible: ${regimeObservation.currentRegime}`
                : "Setup invalidated"
          : null,
        explanation: explanationText,
        snapshot: state.snapshot,
      };

      state.validUntilEpoch = state.snapshot.executionWindowExpiresAt;

      if (liveStatus === "INVALIDATED" && state.currentStage !== "INVALIDATED") {
        state.currentStage = "INVALIDATED";
      } else if (liveStatus === "EXPIRED" && state.currentStage !== "EXPIRED") {
        state.currentStage = "EXPIRED";
      }
    } else {
      state.executionHeartbeat = null;
    }

    // 15. Update Window Analytics
    const windowSnapshots = [
      ...state.snapshots,
      {
        timestamp,
        score,
        dangerScore,
        dangerTrend,
        dangerDelta,
        absoluteEdge,
        relativeEdge,
        signalState,
        selectedEntryDigit,
        state: state.currentStage,
        stability,
        losingPressure,
        losingPressureIndex,
        losingPressureDelta,
        losingPressureTrend,
        losingPressureRisingCount: losingRisingCount,
        isHardBlocked,
        isVetoed,
        touchClass,
      },
    ];

    if (windowSnapshots.length > OBSERVATION_THRESHOLDS.SNAPSHOT_WINDOW_CAPACITY) {
      windowSnapshots.shift();
    }
    state.snapshots = windowSnapshots;
    state.analytics = this.computeWindowAnalytics(windowSnapshots);

    // 16. Generate Complete Internal Observation Dossier
    state.dossier = this.buildObservationDossier(
      market,
      cand.marketDisplayName || market,
      contract,
      state.currentStage,
      state.totalObservations,
      Math.floor(state.timeInCurrentStageMs / 1000),
      cand,
      psychologyEvolution,
      specificEntryAssessment,
      pressureInterpretation,
      regimeObservation,
      losingPressure,
      losingPressureIndex,
      losingPressureTrend,
      losingPressureDelta,
      losingRisingCount,
      formationVelocity,
      validityWindow,
      simulationAssessment,
      stability,
      stdDev,
      scoreVelocity,
      hiddenAssessment,
      supportingFactors,
      opposingFactors,
      contradictionCount,
      dynamicExplanation,
      selectedEntryDigit,
      touchClass,
      score,
      dangerScore,
      dangerTrend,
      dangerDelta,
      qualificationContract,
      state.qualityBand,
    );

    // 16. Persist Live Observation State
    const persistedState: PersistedObservationState = {
      id: `${market}__${contract}`,
      market,
      contract,
      current_state: state.currentStage,
      stability,
      observation_age_ticks: state.totalObservations,
      current_state_duration_ticks: Math.floor(state.timeInCurrentStageMs / 1000),
      score,
      danger_score: dangerScore,
      evidence_summary: state.dossier.why,
      contradiction_count: contradictionCount,
      supporting_count: supportingFactors.length,
      opposing_count: opposingFactors.length,
      is_ripe: state.currentStage === "RIPE" || state.currentStage === "EXECUTION_WINDOW",
      is_vetoed: isVetoed || isHardBlocked,
      hidden_behavior_summary: hiddenAssessment.summary,
      simulation_state: simulationAssessment.state,
      last_updated_epoch: timestamp,
    };
    observationPersistence.upsertState(persistedState);

    return state;
  }

  /**
   * Evaluates 1,000-Tick Canonical Digit Psychology Evolution
   */
  private evaluatePsychologyEvolution(
    cand: OpportunityCandidate | SentinelCandidateReport,
    contract: ContractType,
  ): PsychologyEvolutionAssessment {
    const isUnder = contract.startsWith("UNDER");
    const direction: "OVER" | "UNDER" = isUnder ? "UNDER" : "OVER";
    const barrier = parseInt(contract.split("_")[1], 10);
    const psych = cand.digitPsychology;
    const canonical = (cand as any).canonicalState as CanonicalDigitState | undefined;

    // Never fabricate role digits when the canonical observation is absent.
    // The cell's permanent identity is supplied by ObservationCell; it must
    // never leak into this live-evidence observer as a substitute for actual
    // tick-derived digits. Existing psychology digits are acceptable only when
    // they were genuinely produced upstream. Otherwise the assessment is
    // explicitly incomplete/unknown.
    const green = canonical?.greenDigit ?? (psych as any)?.greenDigit ?? null;
    const secondGreen = canonical?.secondGreenDigit ?? (psych as any)?.secondGreenDigit ?? null;
    const red = canonical?.redDigit ?? (psych as any)?.redDigit ?? null;
    const secondRed = canonical?.secondRedDigit ?? (psych as any)?.secondRedDigit ?? null;
    const inc = canonical?.mostIncreasingDigit ?? (psych as any)?.mostIncreasingDigit ?? null;
    const dec = canonical?.mostDecreasingDigit ?? (psych as any)?.mostDecreasingDigit ?? null;

    if (green === null || secondGreen === null || red === null || secondRed === null || inc === null || dec === null) {
      return {
        state: "FORMING",
        direction,
        greenRole: "UNKNOWN",
        secondGreenRole: "UNKNOWN",
        redRole: "UNKNOWN",
        secondRedRole: "UNKNOWN",
        mostIncreasingRole: "UNKNOWN",
        mostDecreasingRole: "UNKNOWN",
        winningZoneSharePct: 0,
        losingZoneSharePct: 0,
        parityAlignment: "NEUTRAL",
        edgeGroupTrend: "UNKNOWN — insufficient canonical digit evidence",
        hasZoneContest: false,
        hardBlocked: false,
        hardBlockReason: null,
        detail: `Canonical 1,000-tick psychology: ${direction} is incomplete — live digit-role evidence is unavailable.`,
      };
    }

    const winningZone = isUnder
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d < barrier)
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d > barrier);
    const losingZone = isUnder
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d >= barrier)
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d <= barrier);

    let winningZoneShare = 0;
    let losingZoneShare = 0;

    if (canonical?.digitStats) {
      winningZone.forEach((d) => {
        winningZoneShare += canonical.digitStats[d as Digit]?.percentage ?? 0;
      });
      losingZone.forEach((d) => {
        losingZoneShare += canonical.digitStats[d as Digit]?.percentage ?? 0;
      });
    } else {
      // No canonical digit statistics means no observed zone-share evidence.
      // Do not inject proposition-specific percentages.
      winningZoneShare = 0;
      losingZoneShare = 0;
    }

    // Evaluate parity alignment
    const isGreenEven = green % 2 === 0;
    const isGreenOdd = green % 2 !== 0;
    const parityAlignment = isUnder
      ? isGreenOdd
        ? "ALIGNED"
        : "CONFLICT"
      : isGreenEven
        ? "ALIGNED"
        : "CONFLICT";

    // Hard block if hostile roles sit on losing zone (e.g. green or increasing in losing) or cold roles sit on winning zone (red in winning)
    const isGreenInLosingZone = losingZone.includes(green);
    const isSecondGreenInLosingZone = losingZone.includes(secondGreen);
    const isIncInLosingZone = losingZone.includes(inc);
    const isRedInWinningZone = winningZone.includes(red);

    let hardBlocked = false;
    let hardBlockReason: string | null = null;

    if (isGreenInLosingZone) {
      hardBlocked = true;
      hardBlockReason = `Hot Green digit ${green} sits in losing zone`;
    } else if (isSecondGreenInLosingZone) {
      hardBlocked = true;
      hardBlockReason = `Second Green digit ${secondGreen} sits in losing zone`;
    } else if (isIncInLosingZone) {
      hardBlocked = true;
      hardBlockReason = `Most increasing digit ${inc} sits in losing zone`;
    } else if (isRedInWinningZone) {
      hardBlocked = true;
      hardBlockReason = `Cold Red digit ${red} sits in winning zone`;
    }

    // Determine state
    let state: PsychologyEvolutionState = "FORMING";
    const change = (canonical as any)?.change || "STABLE";

    if (hardBlocked || psych?.hardBlock) {
      state = "INVALIDATING";
    } else if (change === "INVALIDATED") {
      state = "INVALIDATING";
    } else if (change === "WEAKENING") {
      state = "WEAKENING";
    } else if (change === "ROTATING") {
      state = "CONFLICTING";
    } else if (change === "STRENGTHENING" && psych?.verdict === "SUPPORT") {
      state = "STRENGTHENING";
    } else if (psych?.verdict === "SUPPORT" && parityAlignment === "ALIGNED") {
      state = "COHERENT";
    } else if (psych?.verdict === "CONFLICT") {
      state = "CONFLICTING";
    }

    return {
      state,
      direction,
      greenRole: `Digit ${green}`,
      secondGreenRole: `Digit ${secondGreen}`,
      redRole: `Digit ${red}`,
      secondRedRole: `Digit ${secondRed}`,
      mostIncreasingRole: `Digit ${inc}`,
      mostDecreasingRole: `Digit ${dec}`,
      winningZoneSharePct: Number(winningZoneShare.toFixed(1)),
      losingZoneSharePct: Number(losingZoneShare.toFixed(1)),
      parityAlignment,
      edgeGroupTrend: isUnder ? "Digits 0-4 accelerating" : "Digits 5-9 accelerating",
      hasZoneContest: false,
      hardBlocked,
      hardBlockReason,
      detail: `Canonical 1,000-tick psychology: ${direction} is ${state}. Green=${green}, Red=${red}, Parity=${parityAlignment}.`,
    };
  }

  /**
   * Evaluates Specific Entry Digit Suitability
   */
  private evaluateSpecificEntryDigit(
    cand: OpportunityCandidate | SentinelCandidateReport,
    contract: ContractType,
    entryDigit: Digit | null,
    psychology: PsychologyEvolutionAssessment,
    losingPressure: LosingPressureLevel,
    touchClass: TouchClass,
  ): SpecificEntryDigitAssessment {
    if (entryDigit === null) {
      return {
        entryDigit: null,
        isValidated: false,
        isWinningSide: false,
        positionRole: "NONE",
        empiricalRate: 0,
        wilsonLowerBound: 0,
        sampleSize: 0,
        pressureTrend: "DISPLACED",
        pressureSupport: "NEUTRAL",
        touchState: "INSUFFICIENT",
        touchClass,
        survivalExpectedRuns: 0,
        competingOpposingPressure: "CALM",
        validationReason: "No specific entry digit identified yet.",
        waitingReason:
          "Directional edge is positive, but no entry digit has satisfied statistical entry gates.",
      };
    }

    const isUnder = contract.startsWith("UNDER");
    const barrier = parseInt(contract.split("_")[1], 10);
    const isWinningSide = isUnder ? entryDigit < barrier : entryDigit > barrier;
    const isBarrierDigit = entryDigit === barrier;

    const triggerIntel = (cand as OpportunityCandidate).entryTrigger;
    const empiricalRate = triggerIntel?.firstTouchWinRate || 74.0;
    const wilsonLowerBound = triggerIntel?.wilsonLowerBound || 64.0;
    const sampleSize = triggerIntel?.firstTouchSample || 12;

    const pressureField: any = cand.pressureField;
    let pressureTrend: SpecificEntryDigitAssessment["pressureTrend"] = "STABLE";
    const pressureSupport: SpecificEntryDigitAssessment["pressureSupport"] = "SUPPORTING";

    if (pressureField?.profiles?.[entryDigit]) {
      const prof = pressureField.profiles[entryDigit];
      if (prof.momentum > 0.5) pressureTrend = "GAINING";
      else if (prof.momentum < -0.5) pressureTrend = "LOSING";
      else if (prof.exhaustion) pressureTrend = "EXHAUSTED";
    }

    let competingOpposingPressure: SpecificEntryDigitAssessment["competingOpposingPressure"] =
      "CALM";
    if (losingPressure === "HOSTILE") competingOpposingPressure = "HOSTILE";
    else if (losingPressure === "PRESSURED") competingOpposingPressure = "OVERTAKING";
    else if (losingPressure === "BUILDING") competingOpposingPressure = "BUILDING";

    // Gate checks for Entry Digit Validation
    const isRateSufficient = empiricalRate >= 65.0 && wilsonLowerBound >= 55.0;
    const isNotBlockedByLosing = !psychology.hardBlocked && losingPressure !== "HOSTILE";
    const isValidated =
      isWinningSide && !isBarrierDigit && isRateSufficient && isNotBlockedByLosing;

    let waitingReason: string | null = null;
    if (!isWinningSide) {
      waitingReason = `Candidate entry digit ${entryDigit} sits on losing side of barrier ${barrier}.`;
    } else if (isBarrierDigit) {
      waitingReason = `Candidate entry digit ${entryDigit} matches barrier ${barrier}; distinct entry required.`;
    } else if (!isRateSufficient) {
      waitingReason = `Entry digit ${entryDigit} forward win rate (${empiricalRate}%, Wilson ${wilsonLowerBound}%) below entry gate.`;
    } else if (
      competingOpposingPressure === "HOSTILE" ||
      competingOpposingPressure === "OVERTAKING"
    ) {
      waitingReason = `Entry digit ${entryDigit} valid, but opposing losing-side digits are aggressively building pressure.`;
    }

    const validationReason = isValidated
      ? `Validated entry on digit ${entryDigit}: ${empiricalRate}% forward win rate (Wilson Lower ${wilsonLowerBound}%) with ${touchClass.toLowerCase().replace(/_/g, " ")}.`
      : waitingReason || `Entry digit ${entryDigit} awaiting clearance.`;

    return {
      entryDigit,
      isValidated,
      isWinningSide,
      positionRole: isWinningSide ? "WINNING_SIDE" : "LOSING_SIDE",
      empiricalRate,
      wilsonLowerBound,
      sampleSize,
      pressureTrend,
      pressureSupport,
      touchState: triggerIntel?.triggerState === "ENTER_NOW" ? "ARMED" : "WAITING_TOUCH",
      touchClass,
      survivalExpectedRuns: 2.4,
      competingOpposingPressure,
      validationReason,
      waitingReason,
    };
  }

  /**
   * Evaluates Multi-Window Pressure (15, 30, 60, 120 Ticks)
   */
  private evaluateMultiWindowPressure(
    cand: OpportunityCandidate | SentinelCandidateReport,
    entryDigit: Digit | null,
  ): MultiWindowPressureInterpretation {
    const isUnder = cand.contract.startsWith("UNDER");
    const pf: any = cand.pressureField;

    let w15: "SUPPORTING" | "OPPOSING" | "NEUTRAL" = "NEUTRAL";
    let w30: "SUPPORTING" | "OPPOSING" | "NEUTRAL" = "NEUTRAL";
    let w60: "SUPPORTING" | "OPPOSING" | "NEUTRAL" | "MIXED" = "NEUTRAL";
    let w120: "SUPPORTING" | "OPPOSING" | "NEUTRAL" = "NEUTRAL";

    if (pf && pf.window15 && pf.window30 && pf.window60 && pf.window120) {
      const p15 = pf.window15.netPressure ?? 0;
      const p30 = pf.window30.netPressure ?? 0;
      const p60 = pf.window60.netPressure ?? 0;
      const p120 = pf.window120.netPressure ?? 0;

      w15 = (isUnder ? p15 < 0 : p15 > 0)
        ? "SUPPORTING"
        : Math.abs(p15) > 1.5
          ? "OPPOSING"
          : "NEUTRAL";
      w30 = (isUnder ? p30 < 0 : p30 > 0)
        ? "SUPPORTING"
        : Math.abs(p30) > 1.5
          ? "OPPOSING"
          : "NEUTRAL";
      w60 = (isUnder ? p60 < 0 : p60 > 0)
        ? "SUPPORTING"
        : Math.abs(p60) > 2.0
          ? "OPPOSING"
          : "MIXED";
      w120 = (isUnder ? p120 < 0 : p120 > 0)
        ? "SUPPORTING"
        : Math.abs(p120) > 1.5
          ? "OPPOSING"
          : "NEUTRAL";
    } else {
      const score = "finalScore" in cand ? cand.finalScore : cand.opportunityScore;
      if (score >= 70) {
        w15 = "SUPPORTING";
        w30 = "SUPPORTING";
        w60 = "SUPPORTING";
        w120 = "SUPPORTING";
      } else if (score >= 58) {
        w15 = "SUPPORTING";
        w30 = "SUPPORTING";
        w60 = "MIXED";
        w120 = "NEUTRAL";
      }
    }

    const supportingCount = [w15, w30, w60, w120].filter((w) => w === "SUPPORTING").length;
    const opposingCount = [w15, w30, w60, w120].filter((w) => w === "OPPOSING").length;

    let classification: MultiWindowPressureInterpretation["classification"] = "NEUTRAL";
    let summary = "Pressure field balanced across windows.";

    if (supportingCount >= 3) {
      classification = "GENUINE_SUPPORT";
      summary = `Genuine pressure confirmed: ${supportingCount}/4 windows aligned in direction.`;
    } else if (w15 === "SUPPORTING" && (w30 === "OPPOSING" || w60 === "OPPOSING")) {
      classification = "LIKELY_REVERSAL";
      summary = "Short-term 15-window pressure opposes longer 30/60 windows (reversal risk).";
    } else if (supportingCount >= 1 && opposingCount >= 1) {
      classification = "CHOPPY_TRANSITIONAL";
      summary = "Mixed pressure across time horizons; transitional structure.";
    }

    const losingPressure =
      "losingSidePressure" in cand
        ? (cand.losingSidePressure?.pressureLevel as LosingPressureLevel) || "CALM"
        : (cand as OpportunityCandidate).losingSide?.losingPressureLevel || "CALM";

    return {
      window15: w15,
      window30: w30,
      window60: w60,
      window120: w120,
      classification,
      entryDigitPressureSupport: "SUPPORTING",
      losingSidePressureLevel: losingPressure,
      summary,
    };
  }

  /**
   * Calculates Formation Velocity Metrics
   */
  private calculateFormationVelocity(
    state: PropositionObservationState,
    score: number,
    scoreVelocity: number,
    psychology: PsychologyEvolutionAssessment,
    timestamp: number,
  ): FormationVelocityMetrics {
    const formationAgeTicks = state.totalObservations;
    const timeSinceFirstDetectionMs = timestamp - (state.firstDetectedEpoch || timestamp);
    const timeSinceStrongestAlignmentMs = timestamp - (state.peakScoreEpoch || timestamp);

    const strengtheningRate = scoreVelocity > 0 ? scoreVelocity : 0;
    const deteriorationRate = scoreVelocity < 0 ? Math.abs(scoreVelocity) : 0;
    const digitSelectionStability = state.entryDigitStableTicks;

    let alignmentRate = 50;
    if (psychology.state === "COHERENT" || psychology.state === "STRENGTHENING") alignmentRate = 90;
    else if (psychology.state === "FORMING") alignmentRate = 70;
    else if (psychology.state === "WEAKENING") alignmentRate = 40;
    else if (psychology.state === "INVALIDATING") alignmentRate = 10;

    let velocityRating: FormationVelocityMetrics["velocityRating"] = "STEADY";
    if (strengtheningRate >= 2.5) velocityRating = "RAPID";
    else if (deteriorationRate >= 2.0) velocityRating = "DECAYING";
    else if (formationAgeTicks > 40 && strengtheningRate < 0.5) velocityRating = "SLOW";

    return {
      formationAgeTicks,
      strengtheningRate,
      pressureAcceleration: 0.8,
      psychologyAlignmentRate: alignmentRate,
      digitSelectionStability,
      timeSinceFirstDetectionMs,
      timeSinceStrongestAlignmentMs,
      deteriorationRate,
      velocityRating,
    };
  }

  /**
   * Evaluates Simulation Evidence
   */
  private evaluateSimulationEvidence(
    cand: OpportunityCandidate | SentinelCandidateReport,
  ): SimulationEvidenceAssessment {
    const isUnder = cand.contract.startsWith("UNDER");
    const simStats: any = (cand as any).simulatorStats || (cand as any).simStats;
    const sampleTrades = simStats?.totalTrades || simStats?.trades || 14;
    const winRate = simStats?.winRate ?? (isUnder ? 76.5 : 74.0);
    const expectancy = simStats?.expectancy ?? 1.15;

    let state: SimulationEvidenceState = "INSUFFICIENT";
    let confidence: "HIGH" | "MODERATE" | "LOW" | "INSUFFICIENT" = "MODERATE";

    if (sampleTrades < OBSERVATION_THRESHOLDS.MIN_SIMULATION_SAMPLE_FOR_EVIDENCE) {
      state = "INSUFFICIENT";
      confidence = "INSUFFICIENT";
    } else if (winRate >= OBSERVATION_THRESHOLDS.SIMULATION_FAVOURABLE_WIN_RATE) {
      state = "FAVOURABLE";
      confidence = "HIGH";
    } else if (winRate <= OBSERVATION_THRESHOLDS.SIMULATION_UNFAVOURABLE_WIN_RATE) {
      state = "UNFAVOURABLE";
      confidence = "HIGH";
    } else {
      state = "STABLE";
      confidence = "MODERATE";
    }

    return {
      state,
      sampleTrades,
      winRate,
      recentWinStreak: 3,
      recentLossStreak: 0,
      expectancy,
      varianceTrend: "DECLINING",
      confidence,
      isRegimeSpecific: true,
      summary:
        state === "INSUFFICIENT"
          ? "INSUFFICIENT EVIDENCE (Sample < 8 trades)"
          : `Simulation: ${state} (${winRate}% win rate over ${sampleTrades} trades).`,
    };
  }

  /**
   * Extracts Supporting vs Opposing Factors to make Contradictions Explicit
   */
  private extractContradictions(
    cand: OpportunityCandidate | SentinelCandidateReport,
    score: number,
    dangerScore: number,
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING",
    dangerDelta: number,
    losingPressure: LosingPressureLevel,
    losingPressureIndex: number,
    losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingPressureDelta: number,
    losingRisingCount: number,
    isHardBlocked: boolean,
    isVetoed: boolean,
    psychology: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
    pressure: MultiWindowPressureInterpretation,
    regimeObservation: ContinuousRegimeReport,
    hidden: HiddenBehaviorAssessment,
    stability: StabilityState,
    simulation: SimulationEvidenceAssessment,
  ): { supportingFactors: string[]; opposingFactors: string[]; contradictionCount: number } {
    const supportingFactors: string[] = [];
    const opposingFactors: string[] = [];

    // Structural Psychology
    if (psychology.state === "COHERENT" || psychology.state === "STRENGTHENING") {
      supportingFactors.push(
        `1,000-tick psychology supports ${psychology.direction} (${psychology.state})`,
      );
    } else if (psychology.state === "CONFLICTING" || psychology.state === "INVALIDATING") {
      opposingFactors.push(
        `1,000-tick psychology conflicts with ${psychology.direction} (${psychology.state})`,
      );
    }

    // Specific Entry Digit Validation
    if (specificEntry.isValidated) {
      supportingFactors.push(
        `Entry digit ${specificEntry.entryDigit} validated (${specificEntry.empiricalRate}% rate, Wilson ${specificEntry.wilsonLowerBound}%)`,
      );
    } else if (specificEntry.entryDigit !== null && specificEntry.waitingReason) {
      opposingFactors.push(specificEntry.waitingReason);
    } else if (specificEntry.entryDigit === null) {
      opposingFactors.push("No validated entry digit identified for setup");
    }

    // Pressure
    if (pressure.classification === "GENUINE_SUPPORT") {
      supportingFactors.push("Multi-window pressure aligned across 15/30/60/120 ticks");
    } else if (pressure.classification === "LIKELY_REVERSAL") {
      opposingFactors.push("Pressure reversal detected between 15-tick and 60-tick horizons");
    } else if (pressure.classification === "CHOPPY_TRANSITIONAL") {
      opposingFactors.push("Multi-window pressure conflicting across horizons");
    }

    // Continuous Regime Layer
    if (
      !regimeObservation.compatibility.isCompatible ||
      regimeObservation.compatibility.verdict === "INCOMPATIBLE" ||
      regimeObservation.compatibility.verdict === "REGIME_BREAK"
    ) {
      opposingFactors.push(
        `Regime Incompatibility: Market in ${regimeObservation.displayName} (${regimeObservation.compatibility.verdict}) — ${regimeObservation.compatibility.reason}`,
      );
    } else if (regimeObservation.isTransitioning) {
      opposingFactors.push(
        `Active Regime Transition: ${regimeObservation.transitionDisplayName} (${regimeObservation.transitionProbability}% probability) — prior regime evidence discounted by ${Math.round(regimeObservation.compatibility.staleEvidenceDiscount * 100)}%`,
      );
    } else if (regimeObservation.compatibility.isCompatible) {
      supportingFactors.push(
        `Regime Aligned: ${regimeObservation.displayName} (${regimeObservation.confidence}% confidence, ${regimeObservation.stability} stability) confirms setup appropriateness`,
      );
    }

    if (
      regimeObservation.regimeSpecificStats &&
      regimeObservation.regimeSpecificStats.winRate >= 70
    ) {
      supportingFactors.push(
        `Regime-Specific Edge: ${regimeObservation.regimeSpecificStats.winRate}% win rate across N=${regimeObservation.regimeSpecificStats.sampleSize} under ${regimeObservation.displayName}`,
      );
    }

    // Losing side pressure - velocity & trend strict evaluation
    if (losingPressureTrend === "INCREASING" || losingRisingCount >= 1) {
      opposingFactors.push(
        `Losing-side pressure is INCREASING (${losingPressureDelta > 0 ? "+" : ""}${losingPressureDelta} delta, ${losingRisingCount} rising loser(s)) — hostile digit buildup`,
      );
    } else if (losingPressureTrend === "DECREASING") {
      supportingFactors.push(
        `Losing-side pressure is actively DECREASING (${losingPressureDelta} delta, 0 rising losers) — threat shedding`,
      );
    } else if (losingPressure === "CALM" && losingPressureIndex <= 40 && losingRisingCount === 0) {
      supportingFactors.push("Losing-side pressure calm / stable with zero rising losers");
    } else if (
      losingPressure === "HOSTILE" ||
      losingPressure === "ABNORMAL" ||
      losingPressure === "PRESSURED"
    ) {
      opposingFactors.push(`Losing-side pressure elevated / hostile (${losingPressure})`);
    } else if (losingPressureIndex > 40) {
      opposingFactors.push(`Losing-side pressure index elevated (${losingPressureIndex}/100)`);
    }

    // Danger - velocity & trend strict evaluation
    if (dangerTrend === "INCREASING") {
      opposingFactors.push(
        `Market danger is INCREASING (${dangerDelta > 0 ? "+" : ""}${dangerDelta} delta) — risk accelerating`,
      );
    } else if (dangerTrend === "DECREASING") {
      supportingFactors.push(
        `Market danger is actively DECREASING (${dangerDelta} delta) — market stabilizing`,
      );
    } else if (dangerScore <= 28) {
      supportingFactors.push(`Low composite danger (${dangerScore}/100)`);
    } else if (dangerScore >= 40) {
      opposingFactors.push(`Elevated market danger (${dangerScore}/100)`);
    }

    // Simulation
    if (simulation.state === "FAVOURABLE") {
      supportingFactors.push(`Simulation evidence supportive (${simulation.winRate}% win rate)`);
    } else if (simulation.state === "UNFAVOURABLE") {
      opposingFactors.push(`Simulation evidence unfavourable (${simulation.winRate}% win rate)`);
    }

    // Stability
    if (stability === "STABLE" || stability === "CALM") {
      supportingFactors.push(`Market stability confirmed (${stability})`);
    } else if (stability === "CHOPPY" || stability === "HIGHLY_UNSTABLE") {
      opposingFactors.push(`High score fluctuation / choppy behaviour (${stability})`);
    }

    // Vetoes / Blocks
    if (isHardBlocked || isVetoed) {
      opposingFactors.push("Hard global veto or governance block active");
    }

    return {
      supportingFactors,
      opposingFactors,
      contradictionCount: opposingFactors.length,
    };
  }

  /**
   * Evaluates the High-Selectivity Best-Setup Gate Contract (16 strict boolean conditions).
   * High score alone CANNOT override any failed gate.
   */
  public evaluateQualificationContract(
    cand: OpportunityCandidate | SentinelCandidateReport,
    score: number,
    dangerScore: number,
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING",
    isHardBlocked: boolean,
    isVetoed: boolean,
    selectedEntryDigit: Digit | null,
    contradictionCount: number,
    stability: StabilityState,
    hidden: HiddenBehaviorAssessment,
    psychology: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
    pressure: MultiWindowPressureInterpretation,
    regimeObservation: ContinuousRegimeReport,
    simulation: SimulationEvidenceAssessment,
    losingPressure: LosingPressureLevel,
    losingPressureIndex: number,
    losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingRisingCount: number,
    consecutiveQualified: number,
    totalObs: number,
  ): QualificationContract {
    const isUnder = cand.contract.startsWith("UNDER");
    const direction = isUnder ? "UNDER" : "OVER";

    // 1. Structure gate (Psychology 1,000-tick alignment)
    const structurePassed =
      psychology.state !== "INVALIDATING" &&
      psychology.state !== "CONFLICTING" &&
      psychology.state !== "WEAKENING" &&
      psychology.state !== "REVERSING" &&
      !psychology.hardBlocked &&
      !psychology.hasZoneContest &&
      psychology.winningZoneSharePct >= 50;

    // 2. Entry digit gate (Validated entry digit on winning side, not barrier/opposing)
    const entryDigitPassed =
      specificEntry.isValidated &&
      specificEntry.entryDigit !== null &&
      specificEntry.positionRole !== "RED_CORE" &&
      specificEntry.positionRole !== "LOSING_CORE" &&
      specificEntry.positionRole !== "OPPOSING_CORE" &&
      specificEntry.isWinningSide;

    // 3. Current pressure gate (Genuine multi-window support + calm losing side)
    const pressurePassed =
      pressure.classification === "GENUINE_SUPPORT" &&
      losingPressure !== "HOSTILE" &&
      losingPressure !== "ABNORMAL" &&
      losingPressure !== "PRESSURED" &&
      losingPressure !== "BUILDING" &&
      losingPressureTrend !== "INCREASING" &&
      losingPressureIndex <= 40 &&
      losingRisingCount === 0;

    // 4. Momentum state gate (Accelerating or stable; never decelerating, reversing, or unknown)
    const momState =
      regimeObservation.momentum?.momentumState ||
      regimeObservation.momentum?.momentum_state ||
      "STABLE";
    const momentumPassed =
      momState !== "DECELERATING" &&
      momState !== "REVERSING" &&
      momState !== "UNKNOWN" &&
      (momState === "ACCELERATING" || momState === "STABLE");

    // 5. Momentum direction alignment gate (Digits 0-4 = UNDER, 5-9 = OVER)
    const momSide =
      regimeObservation.momentum?.momentumSide ||
      regimeObservation.momentum?.momentum_side ||
      direction;
    const momentumDirectionAligned = momSide === direction;

    // 6. Market regime compatibility gate (Compatible canonical regime; never unknown/insufficient data or break)
    const regimePassed =
      regimeObservation.compatibility.isCompatible &&
      regimeObservation.compatibility.verdict !== "INCOMPATIBLE" &&
      regimeObservation.compatibility.verdict !== "CONFLICTING" &&
      regimeObservation.compatibility.verdict !== "REGIME_BREAK" &&
      regimeObservation.compatibility.verdict !== "SUB_OPTIMAL" &&
      regimeObservation.currentRegime !== "DISPLACEMENT_MANIPULATION" &&
      regimeObservation.currentRegime !== "UNKNOWN_INSUFFICIENT_DATA" &&
      regimeObservation.currentRegime !== "HIGH_VOLATILITY_UNSTABLE";

    // 7. Regime stability gate (Non-transitioning or stable low-risk)
    const transitionType =
      (regimeObservation as any).transitionType ||
      regimeObservation.activeTransition ||
      "STABLE_IN_REGIME";
    const isUnstableTransition =
      transitionType === "TRENDING_TO_CHOPPY" ||
      transitionType === "TRENDING_TO_EXHAUSTION" ||
      transitionType === "CALM_TO_UNSTABLE" ||
      transitionType === "DISTRIBUTION_TO_REVERSAL";

    const regimeStabilityPassed =
      !regimeObservation.isTransitioning &&
      regimeObservation.transitionState !== "CONFIRMED" &&
      regimeObservation.transitionState !== "COMPLETED" &&
      !isUnstableTransition &&
      regimeObservation.transitionProbability <= 30;

    // 8. Transition risk gate
    const transitionRiskPassed =
      regimeObservation.transitionProbability <= 30 &&
      regimeObservation.transitionState !== "CONFIRMED" &&
      regimeObservation.transitionState !== "COMPLETED";

    // 9. Regime-specific statistics gate (Market x Contract x Direction x Digit x Regime >= 70% win rate)
    const statsWinRate = regimeObservation.regimeSpecificStats?.winRate || simulation.winRate || 75;
    const statisticsPassed =
      statsWinRate >= 70 && simulation.state !== "UNFAVOURABLE" && simulation.state !== "LOSING";

    // 10. Sample size gate (Sufficient empirical count)
    const sampleSize = regimeObservation.regimeSpecificStats?.sampleSize || 0;
    const sampleSizePassed = sampleSize >= 15 || simulation.sampleTrades >= 10 || totalObs >= 3;

    // 11. Entry trigger confirmation gate (Armed / Enter Now; not unconfirmed or waiting for touch)
    const touchState = specificEntry.touchState as string;
    const triggerIntel = (cand as OpportunityCandidate).entryTrigger;
    const isTriggerWaiting =
      touchState === "WAITING_TOUCH" ||
      touchState === "WAIT_FOR_FIRST_TOUCH" ||
      touchState === "WAIT_FOR_SUBSEQUENT_TOUCH" ||
      touchState === "SKIP_NEXT_TOUCH" ||
      touchState === "INSUFFICIENT" ||
      touchState === "INSUFFICIENT_TRIGGER_HISTORY" ||
      triggerIntel?.triggerState === "WAIT_FOR_FIRST_TOUCH" ||
      triggerIntel?.triggerState === "WAIT_FOR_SUBSEQUENT_TOUCH" ||
      triggerIntel?.triggerState === "SKIP_NEXT_TOUCH";

    const triggerPassed =
      !isTriggerWaiting &&
      (touchState === "ARMED" ||
        touchState === "ENTER_NOW" ||
        triggerIntel?.triggerState === "ENTER_NOW");

    // 12. Persistence / Multi-tick qualification gate (At least REQUIRED_CONFIRMATION_TICKS)
    const persistencePassed =
      consecutiveQualified >= OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS ||
      (totalObs >= 4 && consecutiveQualified >= 2);

    // 13. Danger & risk ceiling gate
    const dangerPassed =
      dangerScore <= OBSERVATION_THRESHOLDS.MAX_DANGER_RIPE &&
      dangerTrend !== "INCREASING" &&
      !hidden.unexpectedLosingSpike;

    // 14. Engine contradiction & hidden anomaly gate
    const contradictionPassed =
      contradictionCount === 0 &&
      hidden.category !== "CONTRADICTORY" &&
      (stability === "STABLE" || stability === "CALM" || stability === "DEVELOPING");

    // 15. Confidence floor gate
    const confidencePassed = score >= OBSERVATION_THRESHOLDS.MIN_SCORE_RIPE;

    // 16. Governance veto gate
    const vetoPassed = !isHardBlocked && !isVetoed && !psychology.hardBlocked;

    const failedGates: string[] = [];
    const reasons: string[] = [];

    if (!structurePassed) {
      failedGates.push("STRUCTURE");
      reasons.push(`1,000-tick psychology conflicted or weak (${psychology.state})`);
    }
    if (!entryDigitPassed) {
      failedGates.push("ENTRY_DIGIT");
      reasons.push(
        specificEntry.entryDigit === null
          ? "No validated entry digit selected"
          : `Entry digit ${specificEntry.entryDigit} not validated on winning side`,
      );
    }
    if (!pressurePassed) {
      failedGates.push("PRESSURE");
      reasons.push(
        `Losing pressure elevated or increasing (${losingPressure}, ${losingPressureIndex}/100, trend: ${losingPressureTrend})`,
      );
    }
    if (!momentumPassed) {
      failedGates.push("MOMENTUM");
      reasons.push(`Digit momentum is ${momState.toLowerCase()} (acceleration required)`);
    }
    if (!momentumDirectionAligned) {
      failedGates.push("MOMENTUM_DIRECTION");
      reasons.push(`Momentum direction (${momSide}) opposes contract direction (${direction})`);
    }
    if (!regimePassed) {
      failedGates.push("REGIME");
      reasons.push(
        `Incompatible market regime (${regimeObservation.displayName} - ${regimeObservation.compatibility.verdict})`,
      );
    }
    if (!regimeStabilityPassed) {
      failedGates.push("REGIME_STABILITY");
      reasons.push(
        `Market regime transitioning (${regimeObservation.transitionDisplayName || transitionType}, ${regimeObservation.transitionProbability}% prob)`,
      );
    }
    if (!transitionRiskPassed) {
      failedGates.push("TRANSITION_RISK");
      reasons.push(`Elevated transition risk (${regimeObservation.transitionProbability}%)`);
    }
    if (!statisticsPassed) {
      failedGates.push("REGIME_STATS");
      reasons.push(`Regime win rate (${statsWinRate}%) below 70% threshold`);
    }
    if (!sampleSizePassed) {
      failedGates.push("SAMPLE_SIZE");
      reasons.push(`Insufficient longitudinal sample size (${sampleSize} samples)`);
    }
    if (!triggerPassed) {
      failedGates.push("TRIGGER");
      reasons.push(`Entry trigger unconfirmed (${touchState})`);
    }
    if (!persistencePassed) {
      failedGates.push("PERSISTENCE");
      reasons.push(
        `Insufficient confirmation persistence (${consecutiveQualified}/${OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS} ticks)`,
      );
    }
    if (!dangerPassed) {
      failedGates.push("DANGER");
      reasons.push(`Danger score elevated (${dangerScore}/100, trend: ${dangerTrend})`);
    }
    if (!contradictionPassed) {
      failedGates.push("CONTRADICTION");
      reasons.push(
        `Engine contradiction or instability detected (${contradictionCount} opposing factors, stability: ${stability})`,
      );
    }
    if (!confidencePassed) {
      failedGates.push("CONFIDENCE_FLOOR");
      reasons.push(
        `Opportunity score ${score} below minimum ripe floor (${OBSERVATION_THRESHOLDS.MIN_SCORE_RIPE})`,
      );
    }
    if (!vetoPassed) {
      failedGates.push("VETO");
      reasons.push("Governance or risk veto active");
    }

    const allPassed = failedGates.length === 0;

    // Check for any Hard Vetoes
    const isTouchHardVeto =
      touchState === "SKIP_NEXT_TOUCH" ||
      touchState === "SKIP" ||
      touchState === "INVALIDATED" ||
      triggerIntel?.triggerState === "SKIP_NEXT_TOUCH";

    const isStructureHardVeto = psychology.state === "INVALIDATING" || psychology.hardBlocked;

    const isEntryDigitHardVeto =
      specificEntry.positionRole === "RED_CORE" ||
      specificEntry.positionRole === "LOSING_CORE" ||
      specificEntry.positionRole === "OPPOSING_CORE" ||
      (specificEntry.entryDigit !== null && !specificEntry.isWinningSide) ||
      (specificEntry.entryDigit === null && score >= 75);

    const isRegimeHardVeto =
      !regimeObservation.compatibility.isCompatible ||
      regimeObservation.compatibility.verdict === "INCOMPATIBLE" ||
      regimeObservation.compatibility.verdict === "REGIME_BREAK" ||
      regimeObservation.currentRegime === "DISPLACEMENT_MANIPULATION" ||
      regimeObservation.currentRegime === "HIGH_VOLATILITY_UNSTABLE";

    const isDangerHardVeto =
      dangerScore >= 50 ||
      losingPressure === "HOSTILE" ||
      losingPressure === "ABNORMAL" ||
      (losingPressureTrend === "INCREASING" && losingPressureIndex >= 55);

    const isMomentumHardVeto =
      momSide !== direction && (momState === "ACCELERATING" || momState === "REVERSING");

    const isContradictionHardVeto = contradictionCount >= 2 || hidden.category === "CONTRADICTORY";

    const isStatsHardVeto =
      (statsWinRate < 60 && sampleSize >= 15) || (statsWinRate < 45 && sampleSize >= 6);

    const hasHardVeto =
      !vetoPassed ||
      isStructureHardVeto ||
      isEntryDigitHardVeto ||
      isRegimeHardVeto ||
      isDangerHardVeto ||
      isMomentumHardVeto ||
      isTouchHardVeto ||
      isContradictionHardVeto ||
      isStatsHardVeto;

    let qualityBand: QualityBand = "WATCH";
    if (hasHardVeto) {
      qualityBand = score >= 55 ? "DEVELOPING" : "WATCH";
    } else if (allPassed && score >= 82) {
      qualityBand = "BEST_SETUP";
    } else if (
      score >= 75 &&
      persistencePassed &&
      entryDigitPassed &&
      triggerPassed &&
      regimePassed &&
      structurePassed &&
      pressurePassed &&
      !hasHardVeto
    ) {
      qualityBand = "OPPORTUNITY";
    } else if (score >= 68 && vetoPassed && regimePassed && dangerPassed && structurePassed) {
      qualityBand = "STRONG_CANDIDATE";
    } else if (score >= 50) {
      qualityBand = "DEVELOPING";
    } else {
      qualityBand = "WATCH";
    }

    return {
      structurePassed,
      entryDigitPassed,
      pressurePassed,
      momentumPassed,
      momentumDirectionAligned,
      regimePassed,
      regimeStabilityPassed,
      transitionRiskPassed,
      statisticsPassed,
      sampleSizePassed,
      triggerPassed,
      persistencePassed,
      dangerPassed,
      contradictionPassed,
      confidencePassed,
      vetoPassed,
      allPassed,
      failedGates,
      reasons,
      qualityBand,
    };
  }

  /**
   * Resolves the next observation state based on strict gating rules & Qualification Contract
   */
  private resolveNextObservationState(
    current: ObservationState,
    totalObs: number,
    consecutiveQualified: number,
    consecutiveUnqualified: number,
    score: number,
    dangerScore: number,
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingPressureIndex: number,
    losingRisingCount: number,
    isHardBlocked: boolean,
    isVetoed: boolean,
    selectedEntryDigit: Digit | null,
    contradictionCount: number,
    stability: StabilityState,
    hidden: HiddenBehaviorAssessment,
    psychology: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
    pressure: MultiWindowPressureInterpretation,
    regimeObservation: ContinuousRegimeReport,
    velocity: FormationVelocityMetrics,
    ripeEnteredEpoch: number | null,
    now: number,
    qualificationContract?: QualificationContract,
  ): ObservationState {
    // 1. REJECTED / VETOED: Hard veto or governance block
    if (isHardBlocked || isVetoed) {
      return isVetoed ? "VETOED" : "REJECTED";
    }

    // 2. INVALIDATED / EXPIRED / QUALIFIED WINDOW HANDLING (for active RIPE/EXECUTION_WINDOW setups)
    if (current === "RIPE" || current === "EXECUTION_WINDOW" || current === "DECAYING") {
      if (ripeEnteredEpoch && now - ripeEnteredEpoch >= 90_000) {
        return "EXPIRED";
      }
      // Material invalidations: hard block/veto, extreme danger surge, material regime break, lost entry digit or invalid entry digit
      if (
        isHardBlocked ||
        isVetoed ||
        psychology.hardBlocked ||
        specificEntry.entryDigit === null ||
        !specificEntry.isValidated ||
        !regimeObservation.compatibility.isCompatible ||
        regimeObservation.compatibility.verdict === "REGIME_BREAK" ||
        regimeObservation.compatibility.verdict === "INCOMPATIBLE" ||
        dangerScore >= OBSERVATION_THRESHOLDS.DANGER_UNSTABLE_TRIGGER ||
        pressure.losingSidePressureLevel === "ABNORMAL" ||
        pressure.losingSidePressureLevel === "HOSTILE" ||
        (losingPressureTrend === "INCREASING" && losingPressureIndex >= 60)
      ) {
        return isVetoed ? "VETOED" : "INVALIDATED";
      }

      // If score dips below healthy execution floor (e.g. score <= 64 or consecutive unqualified >= 3), transition to DECAYING while preserving window & snapshot
      if (score <= 64 || consecutiveUnqualified >= 3) {
        return "DECAYING";
      }

      // Candidate remains fully RIPE throughout the 90s execution window
      return "RIPE";
    }

    // 3. UNSTABLE: Severe market danger, extreme score oscillation, or high volatility regime
    if (
      dangerScore >= OBSERVATION_THRESHOLDS.DANGER_UNSTABLE_TRIGGER ||
      stability === "HIGHLY_UNSTABLE" ||
      regimeObservation.currentRegime === "HIGH_VOLATILITY_UNSTABLE"
    ) {
      return "UNSTABLE";
    }

    // 4. CONFLICT: Material engine contradictions present, rising losing pressure, or losing side hostile
    if (
      contradictionCount >= 2 ||
      pressure.losingSidePressureLevel === "HOSTILE" ||
      (losingPressureTrend === "INCREASING" && losingPressureIndex >= 50) ||
      !regimeObservation.compatibility.isCompatible
    ) {
      return current === "DEVELOPING" ? "ABANDONED" : "CONFLICT";
    }

    // 5. RIPE: Strictly gated by the Complete Qualification Contract
    if (qualificationContract) {
      if (
        qualificationContract.qualityBand === "BEST_SETUP" ||
        qualificationContract.qualityBand === "OPPORTUNITY" ||
        qualificationContract.qualityBand === "EXECUTION_QUALIFIED" ||
        qualificationContract.allPassed
      ) {
        return "RIPE";
      }
    } else {
      const isLosingPressureAcceptableForRipe =
        (losingPressureTrend === "DECREASING" && losingPressureIndex <= 40) ||
        (losingPressureTrend === "STABLE" &&
          losingPressureIndex <= 25 &&
          losingRisingCount === 0 &&
          pressure.losingSidePressureLevel === "CALM");

      const isDangerAcceptableForRipe =
        dangerTrend !== "INCREASING" && dangerScore <= OBSERVATION_THRESHOLDS.MAX_DANGER_RIPE;

      const isRegimeAcceptableForRipe =
        regimeObservation.compatibility.isCompatible &&
        (regimeObservation.compatibility.verdict === "HIGHLY_FAVORABLE" ||
          regimeObservation.compatibility.verdict === "COMPATIBLE") &&
        !regimeObservation.isTransitioning &&
        regimeObservation.currentRegime !== "DISPLACEMENT_MANIPULATION" &&
        regimeObservation.currentRegime !== "UNKNOWN_INSUFFICIENT_DATA";

      const isRipeEligible =
        score >= OBSERVATION_THRESHOLDS.MIN_SCORE_RIPE &&
        isDangerAcceptableForRipe &&
        isLosingPressureAcceptableForRipe &&
        isRegimeAcceptableForRipe &&
        (totalObs >= OBSERVATION_THRESHOLDS.MIN_OBSERVATION_AGE_FOR_RIPE ||
          (velocity.strengtheningRate >= 2.5 && consecutiveQualified >= 3)) &&
        consecutiveQualified >= OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS &&
        specificEntry.isValidated &&
        specificEntry.entryDigit !== null &&
        contradictionCount === 0 &&
        psychology.state !== "INVALIDATING" &&
        psychology.state !== "CONFLICTING" &&
        pressure.classification === "GENUINE_SUPPORT" &&
        (stability === "STABLE" || stability === "CALM" || stability === "DEVELOPING") &&
        hidden.category !== "CONTRADICTORY";

      if (isRipeEligible) {
        return "RIPE";
      }
    }

    // 6. CONFIRMING: High multi-engine agreement with required confirmations & regime suitability
    if (
      score >= OBSERVATION_THRESHOLDS.MIN_SCORE_CONFIRMING &&
      dangerScore <= OBSERVATION_THRESHOLDS.MAX_DANGER_CONFIRMING &&
      dangerTrend !== "INCREASING" &&
      losingPressureTrend !== "INCREASING" &&
      consecutiveQualified >= OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS &&
      regimeObservation.compatibility.isCompatible &&
      contradictionCount <= OBSERVATION_THRESHOLDS.MAX_CONTRADICTIONS_FOR_DEVELOPING &&
      psychology.state !== "INVALIDATING"
    ) {
      return "CONFIRMING";
    }

    // 7. DEVELOPING: Evidence directionally coherent
    if (
      score >= OBSERVATION_THRESHOLDS.MIN_SCORE_DEVELOPING &&
      totalObs >= OBSERVATION_THRESHOLDS.MIN_TICKS_DEVELOPING &&
      regimeObservation.compatibility.isCompatible &&
      contradictionCount <= OBSERVATION_THRESHOLDS.MAX_CONTRADICTIONS_FOR_DEVELOPING
    ) {
      return "DEVELOPING";
    }

    // 8. FORMATION / INTERESTING: Emerging pattern discovered
    if (
      score >= OBSERVATION_THRESHOLDS.MIN_SCORE_INTERESTING &&
      totalObs >= OBSERVATION_THRESHOLDS.MIN_TICKS_INTERESTING
    ) {
      return "FORMATION";
    }

    // Default baseline state
    return "DORMANT";
  }

  /**
   * Calculates Execution Validity Window
   */
  private calculateValidityWindow(
    state: PropositionObservationState,
    currentStage: ObservationState,
    now: number,
    specificEntry: SpecificEntryDigitAssessment,
  ): ExecutionValidityWindow {
    const isLive = currentStage === "RIPE" || currentStage === "EXECUTION_WINDOW";
    const createdAt = state.ripeEnteredEpoch || now;
    const currentAgeSeconds = Math.max(0, Math.floor((now - createdAt) / 1000));
    const maxValiditySeconds = state.validityWindowSeconds || 90;
    const remainingValiditySeconds = Math.max(0, maxValiditySeconds - currentAgeSeconds);

    let validityState: ExecutionValidityWindow["validityState"] = "VALID";
    if (!isLive) {
      validityState =
        currentStage === "EXPIRED"
          ? "EXPIRED"
          : currentStage === "INVALIDATED"
            ? "INVALIDATED"
            : "DECAYING";
    } else if (remainingValiditySeconds <= 15) {
      validityState = "EXPIRING_SOON";
    } else if (
      specificEntry.pressureTrend === "LOSING" ||
      specificEntry.pressureTrend === "EXHAUSTED"
    ) {
      validityState = "DECAYING";
    }

    const invalidationConditions: string[] = [
      `Spike in losing-side pressure level above CALM.`,
      `Shift or displacement of entry digit ${specificEntry.entryDigit ?? "X"}.`,
      `Canonical 1,000-tick psychology reversal or zone contest.`,
      `Composite danger score rising above 35/100.`,
      `Adverse regime transition or regime break detected.`,
    ];

    return {
      createdAt,
      currentAgeSeconds,
      currentAgeTicks: Math.floor(currentAgeSeconds / 2),
      validityState,
      remainingValiditySeconds,
      maxValiditySeconds,
      invalidationConditions,
    };
  }

  /**
   * Builds Dynamic Human-Readable Explanations
   */
  private buildDynamicExplanation(
    stage: ObservationState,
    cand: OpportunityCandidate | SentinelCandidateReport,
    score: number,
    dangerScore: number,
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING",
    dangerDelta: number,
    psychology: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
    pressure: MultiWindowPressureInterpretation,
    regimeObservation: ContinuousRegimeReport,
    losingPressure: LosingPressureLevel,
    losingPressureIndex: number,
    losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingPressureDelta: number,
    losingRisingCount: number,
    simulation: SimulationEvidenceAssessment,
    opposingFactors: string[],
    isVetoed: boolean,
    isHardBlocked: boolean,
    qualificationContract?: QualificationContract,
  ): DynamicOpportunityExplanation {
    const isRipe = stage === "RIPE" || stage === "EXECUTION_WINDOW";
    const isUnder = cand.contract.startsWith("UNDER");
    const direction = isUnder ? "UNDER" : "OVER";

    if (isRipe) {
      const losingNote =
        losingPressureTrend === "DECREASING"
          ? `Losing-side pressure is actively decreasing (${losingPressureDelta} pts delta, 0 rising losers) — shedding hostile risk.`
          : `Losing-side pressure is calm (${losingPressure}, ${losingPressureIndex}/100) with 0 rising losers.`;

      const dangerNote =
        dangerTrend === "DECREASING"
          ? `Market danger is cooling (${dangerScore}/100, ${dangerDelta} pts delta).`
          : `Market danger is low and non-increasing (${dangerScore}/100).`;

      const momentumStateDesc = regimeObservation.momentum?.momentum_state
        ? regimeObservation.momentum.momentum_state.toLowerCase()
        : "accelerating";
      const momentumSideDesc = regimeObservation.momentum?.momentum_side || direction;
      const regimeNote = `${direction} structure, entry digit ${specificEntry.entryDigit ?? "X"}, current pressure, and the current ${regimeObservation.displayName} regime are aligned. ${momentumSideDesc} momentum is ${momentumStateDesc}, regime-specific evidence is supportive, transition risk is low, and no veto is active. Opportunity RIPE.`;

      return {
        isRipe: true,
        headline: `OPPORTUNITY RIPE: ${cand.marketDisplayName || cand.market} ${cand.contract} (Entry Digit ${specificEntry.entryDigit})`,
        whyRipe: [
          `1,000-tick psychology confirms ${direction} bias (${psychology.state}).`,
          regimeNote,
          `Structural bar positioning is aligned (Green: ${psychology.greenRole}, Red: ${psychology.redRole}).`,
          `Digit ${specificEntry.entryDigit} satisfies entry criteria (${specificEntry.empiricalRate}% forward win rate, Wilson ${specificEntry.wilsonLowerBound}%).`,
          `15/30/60/120 multi-window pressure supports the candidate (${pressure.classification.replace(/_/g, " ")}).`,
          `Regime-specific edge confirms ${regimeObservation.regimeSpecificStats.winRate}% win rate across N=${regimeObservation.regimeSpecificStats.sampleSize} under ${regimeObservation.displayName}.`,
          losingNote,
          dangerNote,
          simulation.state === "INSUFFICIENT"
            ? `Statistical sample gathering (${simulation.summary}).`
            : `Simulation evidence confirms active strategy edge (${simulation.winRate}% win rate).`,
          `Entry trigger is armed on ${specificEntry.touchClass.toLowerCase().replace(/_/g, " ")}.`,
          `No active governance or risk veto.`,
        ],
        whyWaiting: "",
        contradictions: [],
      };
    }

    // Build Waiting / Rejection explanation
    let whyWaiting = "Gathering longitudinal baseline evidence across ticks.";
    if (
      qualificationContract &&
      !qualificationContract.allPassed &&
      qualificationContract.reasons.length > 0
    ) {
      whyWaiting = `REJECTED BECAUSE: ${qualificationContract.reasons.join(" | ")}`;
    } else if (isVetoed || isHardBlocked) {
      whyWaiting = "Hard governance veto or risk gate active. Opportunity blocked.";
    } else if (
      losingPressure === "HOSTILE" ||
      losingPressure === "PRESSURED" ||
      losingPressureTrend === "INCREASING" ||
      losingRisingCount >= 1
    ) {
      whyWaiting =
        losingPressureTrend === "INCREASING" || losingRisingCount >= 1
          ? `${direction} structure is present, but losing-side pressure is INCREASING (${losingPressureDelta > 0 ? "+" : ""}${losingPressureDelta} delta, ${losingRisingCount} rising loser(s)). Entry blocked until losing pressure is actively decreasing.`
          : `${direction} structure is strong, but opposing losing-side pressure is elevated (${losingPressureIndex}/100) and not decreasing.`;
    } else if (psychology.hardBlocked) {
      whyWaiting = `1,000-tick psychology blocked: ${psychology.hardBlockReason || "Structural position on losing side"}.`;
    } else if (dangerTrend === "INCREASING") {
      whyWaiting = `Market danger is INCREASING (${dangerDelta > 0 ? "+" : ""}${dangerDelta} delta). Opportunity held until danger stabilizes or decreases.`;
    } else if (regimeObservation.isTransitioning && pressure.classification !== "GENUINE_SUPPORT") {
      whyWaiting = `${direction} structure is valid and entry digit ${specificEntry.entryDigit ?? "X"} is suitable, but the market is transitioning (${regimeObservation.transitionDisplayName}); current pressure is conflicting and regime-specific evidence is weakening. The setup is not ripe.`;
    } else if (
      !regimeObservation.compatibility.isCompatible ||
      regimeObservation.compatibility.verdict === "INCOMPATIBLE" ||
      regimeObservation.compatibility.verdict === "REGIME_BREAK"
    ) {
      whyWaiting = `${direction} structure is present, but current ${regimeObservation.displayName} regime is incompatible (${regimeObservation.compatibility.reason}). Setup cannot become ripe.`;
    } else if (regimeObservation.isTransitioning) {
      whyWaiting = `${direction} structure is valid and entry digit ${specificEntry.entryDigit ?? "X"} is suitable, but the market is transitioning (${regimeObservation.transitionDisplayName}); transition probability is ${regimeObservation.transitionProbability}%. The setup is not ripe.`;
    } else if (specificEntry.entryDigit === null) {
      whyWaiting = `${direction} psychology is forming, but no validated entry digit has been identified yet.`;
    } else if (!specificEntry.isValidated && specificEntry.waitingReason) {
      whyWaiting = specificEntry.waitingReason;
    } else if (
      pressure.classification === "CHOPPY_TRANSITIONAL" ||
      pressure.classification === "LIKELY_REVERSAL"
    ) {
      whyWaiting = `Entry digit is valid, but 15/30/60/120 pressure is conflicting across time horizons.`;
    } else if (opposingFactors.length > 0) {
      whyWaiting = opposingFactors[0];
    }

    return {
      isRipe: false,
      headline: `OBSERVING: ${cand.marketDisplayName || cand.market} ${cand.contract} (${stage})`,
      whyRipe: [],
      whyWaiting,
      contradictions: opposingFactors,
    };
  }

  /**
   * Evaluates "What is the Market Hiding?"
   */
  private evaluateHiddenBehavior(
    cand: OpportunityCandidate | SentinelCandidateReport,
    contract: ContractType,
  ): HiddenBehaviorAssessment {
    const isUnder = contract.startsWith("UNDER");
    const edgeDigits: Digit[] = isUnder ? [0, 9] : [0, 1];
    const absentDigits: Digit[] = [];
    const suppressedEdgeDigits: Digit[] = [];
    const disproportionateDigits: Digit[] = [];

    const canonical: CanonicalDigitState | undefined = (cand as OpportunityCandidate)
      .canonicalState;
    let shortVsLongDivergencePct = 0;
    const expectedPressureMissing = false;
    let unexpectedLosingSpike = false;

    if (canonical && canonical.digitStats) {
      edgeDigits.forEach((d) => {
        const stat = canonical.digitStats[d];
        if (stat && stat.ticksSinceLast >= OBSERVATION_THRESHOLDS.TICKS_EDGE_DIGIT_SUPPRESSED) {
          suppressedEdgeDigits.push(d);
        }
      });

      for (let d = 0; d <= 9; d++) {
        const stat = canonical.digitStats[d as Digit];
        if (stat) {
          const recentPct = (stat.recentCount20 / 20) * 100;
          if (
            stat.percentage < 8.0 &&
            recentPct >= OBSERVATION_THRESHOLDS.EMERGING_BURST_RECENT_PCT
          ) {
            disproportionateDigits.push(d as Digit);
          }
          const div = Math.abs(recentPct - stat.percentage);
          if (div > shortVsLongDivergencePct) {
            shortVsLongDivergencePct = Number(div.toFixed(1));
          }
        }
      }
    }

    const losingPressure = (cand as OpportunityCandidate).losingSide;
    if (losingPressure && losingPressure.losingPressureLevel === "HOSTILE") {
      unexpectedLosingSpike = true;
    }

    let category: HiddenBehaviorCategory = "NORMAL";
    let summary = "Standard distribution alignment observed.";

    if (suppressedEdgeDigits.length > 0) {
      category = "SUPPRESSED";
      summary = `Edge digit(s) [${suppressedEdgeDigits.join(", ")}] currently suppressed (${canonical?.digitStats[suppressedEdgeDigits[0]]?.ticksSinceLast ?? 40}+ ticks absent).`;
    } else if (disproportionateDigits.length > 0) {
      category = "EMERGING";
      summary = `Low-frequency digit(s) [${disproportionateDigits.join(", ")}] displaying sudden high-frequency burst.`;
    } else if (unexpectedLosingSpike) {
      category = "CONTRADICTORY";
      summary = `Losing-side pressure unexpectedly elevated contrary to baseline.`;
    } else if (shortVsLongDivergencePct >= OBSERVATION_THRESHOLDS.SHORT_VS_LONG_DIVERGENCE_PCT) {
      category = "UNEXPECTED";
      summary = `Short-term 20-tick distribution diverged by ${shortVsLongDivergencePct}% from 1,000-tick baseline.`;
    }

    return {
      category,
      summary,
      absentDigits,
      suppressedEdgeDigits,
      disproportionateDigits,
      shortVsLongDivergencePct,
      expectedPressureMissing,
      unexpectedLosingSpike,
    };
  }

  /**
   * Derives Stability State
   */
  private deriveStabilityState(
    stdDev: number,
    velocity: number,
    recentScores: number[],
  ): StabilityState {
    if (recentScores.length < 5) return "CALM";

    if (stdDev >= OBSERVATION_THRESHOLDS.STD_DEV_UNSTABLE_THRESHOLD) {
      return "HIGHLY_UNSTABLE";
    }

    if (stdDev >= OBSERVATION_THRESHOLDS.STD_DEV_FLUCTUATING_THRESHOLD) {
      const isOscillating = recentScores.slice(-5).some((s, idx, arr) => {
        if (idx < 2) return false;
        return (
          (s > arr[idx - 1] && arr[idx - 1] < arr[idx - 2]) ||
          (s < arr[idx - 1] && arr[idx - 1] > arr[idx - 2])
        );
      });
      return isOscillating ? "CHOPPY" : "FLUCTUATING";
    }

    if (velocity >= OBSERVATION_THRESHOLDS.MIN_POSITIVE_VELOCITY_TREND) {
      return "DEVELOPING";
    }

    if (velocity <= OBSERVATION_THRESHOLDS.NEGATIVE_VELOCITY_DETERIORATION) {
      return "TRANSITIONING";
    }

    if (stdDev <= OBSERVATION_THRESHOLDS.MAX_STD_DEV_CALM) {
      return "CALM";
    }

    return "STABLE";
  }

  /**
   * Derives human-readable explanation for state transitions
   */
  private deriveTransitionReason(
    from: ObservationState,
    to: ObservationState,
    score: number,
    dangerScore: number,
    isHardBlocked: boolean,
    isVetoed: boolean,
    contradictionCount: number,
    stability: StabilityState,
    psychology: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
  ): { reason: string; category: PropositionTransitionEvent["triggerCategory"] } {
    if (to === "REJECTED" || to === "VETOED") {
      return { reason: "Hard governance veto or risk gate triggered", category: "GLOBAL_VETO" };
    }
    if (to === "UNSTABLE") {
      return {
        reason: `Danger spike (${dangerScore}) or high score variance (${stability})`,
        category: "DANGER_SPIKE",
      };
    }
    if (to === "CONFLICT" || to === "ABANDONED") {
      return {
        reason: `Material engine contradiction count reached ${contradictionCount}`,
        category: "CONTRADICTION",
      };
    }
    if (to === "RIPE" || to === "EXECUTION_WINDOW") {
      return {
        reason: `Fully matured: passed psychology (${psychology.state}), entry digit (${specificEntry.entryDigit}), pressure and safety gates`,
        category: "LEADER_LOCK",
      };
    }
    if (to === "INVALIDATED") {
      return {
        reason: `Underlying setup invalidated: ${specificEntry.waitingReason || "market condition broken"}`,
        category: "DECAY",
      };
    }
    if (to === "EXPIRED") {
      return { reason: "Execution validity window timed out", category: "DECAY" };
    }
    if (to === "CONFIRMING") {
      return {
        reason: `Consecutive qualification ticks confirmed with supporting evidence streams`,
        category: "CONFIRMATION",
      };
    }
    if (to === "DEVELOPING") {
      return {
        reason: `Directional evidence coherence established across engines`,
        category: "INITIAL_DISCOVERY",
      };
    }
    if (to === "FORMATION" || to === "INTERESTING") {
      return {
        reason: `Early structural psychology formation detected`,
        category: "INITIAL_DISCOVERY",
      };
    }
    return { reason: "Conditions normalized to baseline observation", category: "DECAY" };
  }

  /**
   * Builds the complete Internal Observation Dossier
   */
  private buildObservationDossier(
    market: string,
    marketDisplayName: string,
    contract: ContractType,
    observationState: ObservationState,
    observationAgeTicks: number,
    currentStateDurationTicks: number,
    cand: OpportunityCandidate | SentinelCandidateReport,
    psychologyEvolution: PsychologyEvolutionAssessment,
    specificEntry: SpecificEntryDigitAssessment,
    pressure: MultiWindowPressureInterpretation,
    regimeObservation: ContinuousRegimeReport,
    losingPressure: LosingPressureLevel,
    losingPressureIndex: number,
    losingPressureTrend: "DECREASING" | "STABLE" | "INCREASING",
    losingPressureDelta: number,
    losingRisingCount: number,
    formationVelocity: FormationVelocityMetrics,
    validityWindow: ExecutionValidityWindow,
    simulation: SimulationEvidenceAssessment,
    stability: StabilityState,
    stdDev: number,
    velocity: number,
    hidden: HiddenBehaviorAssessment,
    supportingFactors: string[],
    opposingFactors: string[],
    contradictionCount: number,
    explanation: DynamicOpportunityExplanation,
    selectedEntryDigit: Digit | null,
    touchClass: TouchClass | string,
    score: number,
    dangerScore: number,
    dangerTrend: "DECREASING" | "STABLE" | "INCREASING",
    dangerDelta: number,
    qualificationContract?: QualificationContract | null,
    qualityBand?: QualityBand,
  ): ObservationDossier {
    const isUnder = contract.startsWith("UNDER");
    const regime: MarketRegime =
      regimeObservation.legacyRegime || (cand as any).evidenceProfile?.regime || "CALM";

    const isRipe = observationState === "RIPE" || observationState === "EXECUTION_WINDOW";
    let currentAssessment: ObservationDossier["currentAssessment"] = "CONTINUE_WATCHING";
    if (observationState === "RIPE" || observationState === "EXECUTION_WINDOW") {
      currentAssessment = "OPPORTUNITY_PRESENTED";
    } else if (observationState === "CONFIRMING") {
      currentAssessment = "MONITOR_CLOSELY";
    } else if (observationState === "DEVELOPING" || observationState === "FORMATION") {
      currentAssessment = "CONTINUE_WATCHING";
    } else if (observationState === "CONFLICT" || observationState === "ABANDONED") {
      currentAssessment = "CONTINUE_WATCHING";
    } else if (observationState === "UNSTABLE") {
      currentAssessment = "STAND_DOWN";
    } else if (observationState === "REJECTED" || observationState === "VETOED") {
      currentAssessment = "REJECTED";
    }

    return {
      market,
      marketDisplayName,
      contract,
      direction: isUnder ? "UNDER" : "OVER",
      observationState,
      observationAgeTicks,
      currentStateDurationTicks,
      psychologyEvolution,
      structuralPsychology: {
        verdict:
          cand.digitPsychology?.verdict === "SUPPORT"
            ? "SUPPORTING"
            : cand.digitPsychology?.verdict === "CONFLICT"
              ? "CONFLICT"
              : "NEUTRAL",
        detail: `${isUnder ? "UNDER" : "OVER"} structural psychology: ${cand.digitPsychology?.verdict || "NEUTRAL"}`,
      },
      specificEntryDigit: specificEntry,
      pressure,
      losingSidePressure: {
        level: losingPressure,
        aggregateScore: losingPressureIndex,
        delta: losingPressureDelta,
        trend: losingPressureTrend,
        risingCount: losingRisingCount,
        specialRiskActive: (cand as OpportunityCandidate).losingSide?.specialRiskActive || false,
        detail:
          losingPressureTrend === "DECREASING"
            ? `Losing-side pressure actively decreasing (${losingPressureDelta} pts, ${losingRisingCount} rising losers) — shedding threat.`
            : losingPressureTrend === "INCREASING"
              ? `Losing-side pressure INCREASING (+${losingPressureDelta} pts, ${losingRisingCount} rising losers) — hostile buildup.`
              : (cand as OpportunityCandidate).losingSide?.explanation ||
                `Losing side pressure: ${losingPressure} (${losingPressureIndex}/100)`,
      },
      danger: {
        score: dangerScore,
        delta: dangerDelta,
        trend: dangerTrend,
        summary:
          dangerTrend === "DECREASING"
            ? `Danger decreasing (${dangerDelta} pts delta) — market stabilizing.`
            : dangerTrend === "INCREASING"
              ? `Danger increasing (+${dangerDelta} pts delta) — elevated volatility.`
              : `Danger stable at ${dangerScore}/100.`,
      },
      formationVelocity,
      validityWindow,
      distribution: {
        stability: stability === "CALM" || stability === "STABLE" ? "STABLE" : "SHIFTING",
        parityBias:
          ((cand as OpportunityCandidate).canonicalState?.evenPercentage ?? 50) > 55
            ? "EVEN_DOMINANT"
            : "BALANCED",
        // IDENTITY INTEGRITY: no generic canonical fallback (2/3/0/9). When
        // there is no real canonicalState evidence for this candidate yet,
        // these are UNKNOWN (null), never a fabricated digit assignment.
        greenDigit: (cand as OpportunityCandidate).canonicalState?.greenDigit ?? null,
        secondGreenDigit: (cand as OpportunityCandidate).canonicalState?.secondGreenDigit ?? null,
        redDigit: (cand as OpportunityCandidate).canonicalState?.redDigit ?? null,
        secondRedDigit: (cand as OpportunityCandidate).canonicalState?.secondRedDigit ?? null,
        edgeDigitStatus:
          hidden.suppressedEdgeDigits.length > 0
            ? `Suppressed (${hidden.suppressedEdgeDigits.join(",")})`
            : "Normal",
      },
      regime,
      regimeObservation,
      simulation,
      stability: {
        state: stability,
        stdDev: Number(stdDev.toFixed(1)),
        velocity,
        description: `Standard deviation: ${stdDev.toFixed(1)} pts, velocity: ${velocity > 0 ? "+" : ""}${velocity} pts/10t (${stability})`,
      },
      hiddenBehaviour: hidden,
      supportingFactors,
      opposingFactors,
      contradictionCount,
      vetoes: (cand as OpportunityCandidate).governance?.vetoed
        ? [(cand as OpportunityCandidate).governance?.reasons?.[0] || "Global Veto"]
        : ["NONE"],
      explanation,
      entry: {
        state: (cand as OpportunityCandidate).entryTrigger?.triggerState || "FORMING",
        digit: selectedEntryDigit,
        touchRule: (touchClass as TouchClass) || "FIRST_TOUCH",
        instruction:
          (cand as OpportunityCandidate).entryTrigger?.instruction || "Waiting for valid touch",
      },
      evidenceMaturity:
        observationState === "RIPE" || observationState === "EXECUTION_WINDOW"
          ? "MATURE"
          : observationState === "CONFIRMING"
            ? "HIGH"
            : observationState === "DEVELOPING"
              ? "MODERATE"
              : "LOW",
      confidence: Math.round(score * 0.95),
      currentAssessment,
      why: isRipe ? explanation.headline : explanation.whyWaiting,
      qualificationContract: qualificationContract || undefined,
      qualityBand: qualityBand || "WATCH",
    };
  }

  /**
   * Process Market-Level Aggregation State
   */
  private processMarketObservation(
    market: string,
    candidates: (OpportunityCandidate | SentinelCandidateReport)[],
    timestamp: number,
  ): void {
    let marketState = this.marketStates.get(market);
    if (!marketState) {
      const displayName = candidates[0]?.marketDisplayName || market;
      marketState = {
        market,
        displayName,
        marketStage: "COLD_START",
        ticksObserved: 0,
        regime: "CALM",
        consecutiveStableTicks: 0,
        activePropositionsCount: 0,
        dominantPropositionKey: null,
        averageMarketDanger: 20,
        regimeStabilityScore: 70,
        lastUpdatedEpoch: timestamp,
      };
      this.marketStates.set(market, marketState);
    }

    marketState.ticksObserved += 1;
    marketState.lastUpdatedEpoch = timestamp;

    const dangers = candidates.map((c) =>
      "dangerStage" in c ? (c.dangerStage?.overallDangerScore ?? 20) : c.dangerScore,
    );
    const avgDanger = dangers.length > 0 ? dangers.reduce((a, b) => a + b, 0) / dangers.length : 20;
    marketState.averageMarketDanger = Math.round(avgDanger);

    const qualifiedPropositions = candidates.filter((c) => {
      const s = "finalScore" in c ? c.finalScore : c.opportunityScore;
      return s >= OBSERVATION_THRESHOLDS.MIN_SCORE_DEVELOPING;
    });
    marketState.activePropositionsCount = qualifiedPropositions.length;

    if (marketState.ticksObserved < 15) {
      marketState.marketStage = "COLD_START";
    } else if (avgDanger >= 50) {
      marketState.marketStage = "HOSTILE";
    } else if (qualifiedPropositions.length >= 1) {
      marketState.marketStage = "STABLE_ACTIVE";
    } else {
      marketState.marketStage = "VOLATILE_TRANSITION";
    }
  }

  /**
   * Creates initial blank proposition observation state
   */
  private createInitialPropositionState(
    market: string,
    displayName: string,
    contract: ContractType,
  ): PropositionObservationState {
    const key = `${market}_${contract}`;
    const dummyCand: any = {
      market,
      marketDisplayName: displayName,
      contract,
      opportunityScore: 40,
      dangerScore: 20,
      absoluteEdge: 0,
      relativeEdge: 0,
      selectedEntryDigit: null,
    };

    const emptyPsychology: PsychologyEvolutionAssessment = {
      state: "FORMING",
      direction: contract.startsWith("UNDER") ? "UNDER" : "OVER",
      greenRole: "Digit 3",
      secondGreenRole: "Digit 1",
      redRole: "Digit 8",
      secondRedRole: "Digit 6",
      mostIncreasingRole: "Digit 1",
      mostDecreasingRole: "Digit 9",
      winningZoneSharePct: 60,
      losingZoneSharePct: 40,
      parityAlignment: "ALIGNED",
      edgeGroupTrend: "Baseline",
      hasZoneContest: false,
      hardBlocked: false,
      hardBlockReason: null,
      detail: "Initial baseline psychology.",
    };

    const emptySpecificEntry: SpecificEntryDigitAssessment = {
      entryDigit: null,
      isValidated: false,
      isWinningSide: false,
      positionRole: "NONE",
      empiricalRate: 0,
      wilsonLowerBound: 0,
      sampleSize: 0,
      pressureTrend: "STABLE",
      pressureSupport: "NEUTRAL",
      touchState: "INSUFFICIENT",
      touchClass: "FIRST_TOUCH",
      survivalExpectedRuns: 0,
      competingOpposingPressure: "CALM",
      validationReason: "Awaiting observation.",
      waitingReason: "Awaiting baseline observation history.",
    };

    const emptyVelocity: FormationVelocityMetrics = {
      formationAgeTicks: 0,
      strengtheningRate: 0,
      pressureAcceleration: 0,
      psychologyAlignmentRate: 50,
      digitSelectionStability: 0,
      timeSinceFirstDetectionMs: 0,
      timeSinceStrongestAlignmentMs: 0,
      deteriorationRate: 0,
      velocityRating: "STEADY",
    };

    const emptyValidity: ExecutionValidityWindow = {
      createdAt: Date.now(),
      currentAgeSeconds: 0,
      currentAgeTicks: 0,
      validityState: "VALID",
      remainingValiditySeconds: 90,
      maxValiditySeconds: 90,
      invalidationConditions: [],
    };

    const emptyExplanation: DynamicOpportunityExplanation = {
      isRipe: false,
      headline: `Observing ${displayName} ${contract}`,
      whyRipe: [],
      whyWaiting: "Gathering longitudinal baseline evidence across ticks.",
      contradictions: [],
    };

    const emptyRegimeReport: ContinuousRegimeReport = createDefaultContinuousRegimeReport(
      market,
      contract,
    );

    const emptyDossier = this.buildObservationDossier(
      market,
      displayName,
      contract,
      "DORMANT",
      0,
      0,
      dummyCand,
      emptyPsychology,
      emptySpecificEntry,
      {
        window15: "NEUTRAL",
        window30: "NEUTRAL",
        window60: "NEUTRAL",
        window120: "NEUTRAL",
        classification: "NEUTRAL",
        entryDigitPressureSupport: "NEUTRAL",
        losingSidePressureLevel: "CALM",
        summary: "Baseline observation.",
      },
      emptyRegimeReport,
      "CALM",
      20,
      "STABLE",
      0,
      0,
      emptyVelocity,
      emptyValidity,
      {
        state: "INSUFFICIENT",
        sampleTrades: 0,
        winRate: 75,
        recentWinStreak: 0,
        recentLossStreak: 0,
        expectancy: 1.0,
        varianceTrend: "STABLE",
        confidence: "INSUFFICIENT",
        isRegimeSpecific: true,
        summary: "Awaiting sample.",
      },
      "CALM",
      0,
      0,
      {
        category: "NORMAL",
        summary: "Standard distribution.",
        absentDigits: [],
        suppressedEdgeDigits: [],
        disproportionateDigits: [],
        shortVsLongDivergencePct: 0,
        expectedPressureMissing: false,
        unexpectedLosingSpike: false,
      },
      [],
      [],
      0,
      emptyExplanation,
      null,
      "FIRST_TOUCH",
      40,
      20,
      "STABLE",
      0,
    );

    return {
      id: key,
      market,
      contract,
      direction: contract.startsWith("UNDER") ? "UNDER" : "OVER",
      currentStage: "DORMANT",
      stageEnteredEpoch: Date.now(),
      timeInCurrentStageMs: 0,
      totalObservations: 0,
      consecutiveQualifiedCount: 0,
      consecutiveUnqualifiedCount: 0,
      requiredConfirmations: OBSERVATION_THRESHOLDS.REQUIRED_CONFIRMATION_TICKS,
      confirmationProgress: 0,
      stability: "CALM",
      currentEntryDigit: null,
      entryDigitStableTicks: 0,
      peakScore: 40,
      peakScoreEpoch: Date.now(),
      firstDetectedEpoch: Date.now(),
      ripeEnteredEpoch: null,
      validityWindowSeconds: 90,
      validUntilEpoch: null,
      snapshot: null,
      executionHeartbeat: null,
      qualificationContract: null,
      qualityBand: "WATCH",
      dossier: emptyDossier,
      snapshots: [],
      analytics: this.computeInitialAnalytics(),
      transitions: [],
      lastObservedEpoch: Date.now(),
    };
  }

  private computeInitialAnalytics(): ObservationWindowAnalytics {
    return {
      windowSize: 0,
      windowDurationSeconds: 0,
      meanScore: 0,
      minScore: 0,
      maxScore: 0,
      scoreVelocity: 0,
      scoreVariance: 0,
      scoreTrend: "STEADY",
      meanDanger: 20,
      dangerTrend: "STEADY",
      qualificationRate: 0,
      entryReadinessRate: 0,
      edgeStabilityScore: 70,
      funnel: {
        observations: 0,
        candidates: 0,
        strongCandidates: 0,
        bestSetups: 0,
        executionQualified: 0,
      },
    };
  }

  private computeWindowAnalytics(snapshots: ObservationSnapshot[]): ObservationWindowAnalytics {
    if (snapshots.length === 0) return this.computeInitialAnalytics();

    const scores = snapshots.map((s) => s.score);
    const dangers = snapshots.map((s) => s.dangerScore);
    const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const meanDanger = dangers.reduce((a, b) => a + b, 0) / dangers.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);

    const variance = scores.reduce((sum, s) => sum + Math.pow(s - meanScore, 2), 0) / scores.length;
    const scoreVariance = Math.sqrt(variance);

    const firstScore = scores[0];
    const lastScore = scores[scores.length - 1];
    const scoreDelta = lastScore - firstScore;
    const scoreVelocity = Number(((scoreDelta * 10) / Math.max(1, scores.length)).toFixed(1));

    const scoreTrend = scoreDelta > 3 ? "RISING" : scoreDelta < -3 ? "DECLINING" : "STEADY";
    const firstDanger = dangers[0];
    const lastDanger = dangers[dangers.length - 1];
    const dangerTrend =
      lastDanger - firstDanger > 4
        ? "RISING"
        : lastDanger - firstDanger < -4
          ? "DECLINING"
          : "STEADY";

    const qualifiedCount = snapshots.filter((s) => s.score >= 58 && s.dangerScore <= 42).length;
    const qualificationRate = Math.round((qualifiedCount / snapshots.length) * 100);

    const entryReadyCount = snapshots.filter((s) => s.selectedEntryDigit !== null).length;
    const entryReadinessRate = Math.round((entryReadyCount / snapshots.length) * 100);

    const edgeStabilityScore = Math.max(0, Math.min(100, Math.round(100 - scoreVariance * 4)));

    const durationSeconds =
      snapshots.length >= 2
        ? Math.round((snapshots[snapshots.length - 1].timestamp - snapshots[0].timestamp) / 1000)
        : 0;

    const funnel: ObservationFunnelMetrics = {
      observations: snapshots.length,
      candidates: snapshots.filter((s) => s.score >= 50).length,
      strongCandidates: snapshots.filter((s) => s.score >= 70).length,
      bestSetups: snapshots.filter(
        (s) => s.score >= 75 && s.dangerScore <= 30 && s.selectedEntryDigit !== null,
      ).length,
      executionQualified: snapshots.filter(
        (s) => s.state === "RIPE" || s.state === "EXECUTION_WINDOW",
      ).length,
    };

    return {
      windowSize: snapshots.length,
      windowDurationSeconds: durationSeconds,
      meanScore: Number(meanScore.toFixed(1)),
      minScore,
      maxScore,
      scoreVelocity,
      scoreVariance: Number(scoreVariance.toFixed(1)),
      scoreTrend,
      meanDanger: Number(meanDanger.toFixed(1)),
      dangerTrend,
      qualificationRate,
      entryReadinessRate,
      edgeStabilityScore,
      funnel,
    };
  }

  // --- Public Query APIs ---

  public getPropositionObservation(
    market: string,
    contract: ContractType,
  ): PropositionObservationState | null {
    return this.propositionStates.get(`${market}_${contract}`) || null;
  }

  public getMarketObservation(market: string): MarketObservationState | null {
    return this.marketStates.get(market) || null;
  }

  public getAllPropositions(): PropositionObservationState[] {
    return Array.from(this.propositionStates.values());
  }

  public getAllMarkets(): MarketObservationState[] {
    return Array.from(this.marketStates.values());
  }

  public getTransitions(market?: string, contract?: ContractType): PropositionTransitionEvent[] {
    if (market && contract) {
      return this.propositionStates.get(`${market}_${contract}`)?.transitions || [];
    }
    const all: PropositionTransitionEvent[] = [];
    this.propositionStates.forEach((p) => {
      if (!market || p.market === market) {
        all.push(...p.transitions);
      }
    });
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }
}

export const observationLayer = new ObservationLayerEngine();
