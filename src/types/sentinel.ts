export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export type ContractType = "OVER_1" | "OVER_2" | "OVER_3" | "UNDER_8" | "UNDER_7" | "UNDER_6";

export type ContractDirection = "OVER" | "UNDER";

export type SignalState =
  "STRONG" | "VALID" | "VALID_WAIT_ENTRY" | "WATCH" | "EXPLORATORY" | "BLOCKED";

export type EngineAgreementState = "SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG_CONFLICT";

export type LosingPressureLevel =
  "NORMAL" | "WATCH" | "ACTIVE" | "ABNORMAL" | "CALM" | "BUILDING" | "PRESSURED" | "HOSTILE";

export type TouchClass =
  "FIRST_TOUCH" | "SUBSEQUENT_TOUCH" | "NO_MEASURED_DIFFERENCE" | "INSUFFICIENT_HISTORY";

export type EntryTriggerState =
  | "ARMED"
  | "ENTER_NOW"
  | "WAIT_FOR_FIRST_TOUCH"
  | "WAIT_FOR_SUBSEQUENT_TOUCH"
  | "SKIP_NEXT_TOUCH"
  | "INSUFFICIENT_TRIGGER_HISTORY";

/**
 * Canonical Market Regime Categories (8 states as mandated by Sentinel specification)
 */
export type CanonicalMarketRegime =
  | "CALM_STABLE"
  | "TRENDING_PERSISTENT"
  | "CHOPPY_OSCILLATING"
  | "ACCUMULATION"
  | "DISPLACEMENT_MANIPULATION"
  | "DISTRIBUTION_EXHAUSTION"
  | "HIGH_VOLATILITY_UNSTABLE"
  | "UNKNOWN_INSUFFICIENT_DATA";

export type ContinuousRegime = CanonicalMarketRegime;

export type MarketRegime =
  | CanonicalMarketRegime
  | "CALM"
  | "TRENDING"
  | "RANGING"
  | "ACCELERATING"
  | "VOLATILITY_COMPRESSION"
  | "VOLATILITY_EXPANSION"
  | "CHAOTIC"
  | "UNSTABLE";

export type RegimeMaturityState =
  "EMERGING" | "DEVELOPING" | "ESTABLISHED" | "MATURE" | "WEAKENING";

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

export type DigitMomentumSide = "UNDER" | "OVER" | "BALANCED" | "UNKNOWN";

export type DigitMomentumState =
  "ACCELERATING" | "STABLE" | "DECELERATING" | "REVERSING" | "BALANCED" | "UNKNOWN";

export type QualityBand =
  | "WATCH"
  | "DEVELOPING"
  | "STRONG_CANDIDATE"
  | "OPPORTUNITY"
  | "BEST_SETUP"
  | "EXECUTION_QUALIFIED";

export interface QualificationContract {
  structurePassed: boolean;
  entryDigitPassed: boolean;
  pressurePassed: boolean;
  momentumPassed: boolean;
  momentumDirectionAligned: boolean;
  regimePassed: boolean;
  regimeStabilityPassed: boolean;
  transitionRiskPassed: boolean;
  statisticsPassed: boolean;
  sampleSizePassed: boolean;
  triggerPassed: boolean;
  persistencePassed: boolean;
  dangerPassed: boolean;
  contradictionPassed: boolean;
  confidencePassed: boolean;
  vetoPassed: boolean;

  allPassed: boolean;
  failedGates: string[];
  reasons: string[];
  qualityBand: QualityBand;
}

export interface SelectivityMetrics {
  totalObservations: number;
  candidateCount: number;
  strongCandidateCount: number;
  opportunityCount: number;
  bestSetupCount: number;
  executionQualifiedCount: number;
  invalidatedCount: number;
  expiredCount: number;
  opportunityRate: number; // e.g. 0.15 (15%)
  qualificationRate: number; // e.g. 0.05%
  bestSetupRate: number;
  lastUpdatedEpoch: number;
}

export type ExecutionQualificationState =
  | "WATCH"
  | "DEVELOPING"
  | "QUALIFYING"
  | "RIPE"
  | "EXECUTION_QUALIFIED"
  | "EXECUTION_WINDOW_ACTIVE"
  | "AT_RISK"
  | "EXECUTED"
  | "EXPIRED"
  | "INVALIDATED";

export type LiveExecutionStatus =
  "HEALTHY" | "ACTIVE" | "AT_RISK" | "INVALIDATED" | "EXPIRED" | "PENDING_QUALIFICATION";

export interface ExecutionSnapshot {
  id: string;
  market: string;
  marketDisplayName: string;
  contract: ContractType;
  direction: ContractDirection;
  barrier: number;
  entryDigit: Digit | null;
  qualificationDigit?: Digit | null;
  trigger: string;
  qualificationTrigger?: string;
  touchRule: TouchClass;

  scoreAtQualification: number;
  qualificationScore: number;
  confidenceAtQualification: number;
  qualificationConfidence: number;
  dangerAtQualification: number;
  qualificationDanger?: number;

  currentRegimeAtQualification: CanonicalMarketRegime;
  qualificationRegime: CanonicalMarketRegime;
  regimeMaturityAtQualification: RegimeMaturityState;
  regimeConfidenceAtQualification: number;
  qualificationRegimeConfidence: number;
  regimeTransitionAtQualification: RegimeTransitionState;
  qualificationRegimeTransition: RegimeTransitionState;

  momentumSideAtQualification: DigitMomentumSide;
  momentumStateAtQualification: DigitMomentumState;
  momentumStrengthAtQualification: number;
  qualificationMomentum: string;

  qualificationStructure: string;
  qualificationPressure: string;
  qualificationStatistics: string;
  statisticalEvidenceAtQualification: string;

  regimeCompatibilityAtQualification: RegimeCompatibilityVerdict;

  qualifiedAt: number;
  executionWindowStartedAt: number;
  executionWindowExpiresAt: number;
  initialValidityDurationSeconds: number;
}

export interface LiveExecutionHeartbeat {
  status: LiveExecutionStatus;
  qualifiedAt: number;
  expiresAt: number;
  remainingSeconds: number;
  qualificationScore: number;
  liveHealthScore: number;
  liveHealth?: number;
  currentLiveScore: number;
  scoreDrift: number;
  qualificationRegime?: CanonicalMarketRegime;
  currentRegime: CanonicalMarketRegime;
  currentRegimeMaturity: RegimeMaturityState;
  qualificationMomentum?: string;
  currentMomentum?: string;
  currentMomentumSide: DigitMomentumSide;
  currentMomentumState: DigitMomentumState;
  regimeCompatibility?: RegimeCompatibilityVerdict | string;
  currentTransitionState: RegimeTransitionState;
  transitionProbability: number;
  currentRisk?: number;
  isAtRisk: boolean;
  atRiskReason: string | null;
  isHardInvalidated: boolean;
  invalidationReason: string | null;
  explanation: string;
  snapshot: ExecutionSnapshot;
}

export type HypothesisStatus = "OBSERVATION" | "TESTING" | "SUPPORTED" | "VALIDATED" | "DISCOUNTED";

export interface MarketSymbol {
  symbol: string;
  displayName: string;
  category: "Volatility" | "Volatility_1s" | "Jump" | "Step";
  pipSize: number;
  isActive: boolean;
}

export interface TickRecord {
  epoch: number;
  quote: number;
  digit: Digit;
  symbol: string;
}

export interface DigitStat {
  digit: Digit;
  count: number;
  percentage: number;
  deviation: number; // percentage - 10.0
  velocity: number; // change in frequency over short window
  acceleration: number;
  pressure: number; // 0 - 100
  recentCount20: number;
  recentCount50: number;
  recentCount100: number;
  consecutiveCount: number;
  ticksSinceLast: number;
  isGreen: boolean;
  isSecondGreen: boolean;
  isRed: boolean;
  isSecondRed: boolean;
  isMostIncreasing: boolean;
  isMostDecreasing: boolean;
}

export interface CanonicalDigitState {
  greenDigit: Digit;
  secondGreenDigit: Digit;
  redDigit: Digit;
  secondRedDigit: Digit;
  mostIncreasingDigit: Digit;
  mostDecreasingDigit: Digit;
  digitStats: Record<Digit, DigitStat>;
  totalTicks: number;
  lastUpdated: number;
  entropy: number; // 0 - 1 normalized entropy
  evenPercentage: number;
  oddPercentage: number;
}

export interface LosingSideAssessment {
  contract: ContractType;
  losingDigits: Digit[];
  winningDigits: Digit[];
  losingPressureLevel: LosingPressureLevel;
  aggregateLosingScore: number; // 0 - 100 (higher = more dangerous)
  specialRiskDigit: Digit | null; // 1 for Over, 8 for Under
  specialRiskActive: boolean;
  specialRiskNote: string;
  perDigitThreat: Record<
    number,
    {
      digit: Digit;
      threatScore: number; // 0 - 100
      pressureLevel: LosingPressureLevel;
      recentBurst: boolean;
      consecutiveCount: number;
      velocity: number;
    }
  >;
  explanation: string;
  isHardBlocked: boolean;
}

export interface EntryTriggerIntelligence {
  preferredTouch: TouchClass;
  triggerState: EntryTriggerState;
  instruction: string;
  firstTouchWinRate: number;
  firstTouchSample: number;
  subsequentTouchWinRate: number;
  subsequentTouchSample: number;
  measuredMeanGap: number;
  expectancyAdvantage: number;
  wilsonLowerBound: number;
  rankingModifier: number; // Bounded -4 to +4
}

export interface ExecutionSurvivalMetrics {
  market: string;
  contract: ContractType;
  entryDigit: Digit;
  totalSequences: number;
  run1WinRate: number;
  run2WinRate: number;
  run3WinRate: number;
  run4WinRate: number;
  run5WinRate: number;
  firstRunLossRate: number;
  continuationRate: number;
  recoveryRate: number;
  averageSurvivalRuns: number;
  deteriorationPoint: number; // e.g., run 3
  postEntryExpectancy: number;
  postEntryDrawdown: number;
  survivalLabel: "STRONG" | "MODERATE" | "FRAGILE" | "INSUFFICIENT_HISTORY";
  isInsufficient: boolean;
}

export type EntryVerdict = "CLEARED" | "WAIT" | "BLOCKED";

export type FinalVerdict =
  | EntryVerdict // pass-through of Stage 3's own verdicts
  | "HELD_CIRCUIT_BREAKER"
  | "HELD_EXPOSURE_CAP"
  | "HELD_UNCONFIRMED_SIGNIFICANCE";

export interface SetupFactor {
  code: string;
  label: string;
  points: number;
  measuredValue: number | string;
  detail: string;
}

export interface SignificanceAssessment {
  comboKey: string;
  rawWilsonLower: number;
  fdrAdjustedThreshold: number;
  passesCorrection: boolean;
  activeComparisons: number;
  detail: string;
}

export interface PositionSizeReport {
  baseStake: number;
  drawdownAdjustedStake: number;
  kellyFraction: number;
  maxBankrollPct: number;
  maturityFactor: number;
  confidenceFactor: number;
  factors: SetupFactor[];
  summary: string;
}

export interface PortfolioExposureReport {
  totalProposedExposure: number;
  byCorrelationGroup: {
    group: string;
    combinedExposure: number;
    ceiling: number;
    breached: boolean;
    members: string[];
  }[];
  recommendation: "OK" | "TRIM" | "BLOCK_NEW";
  detail: string;
}

export interface CircuitBreakerState {
  tripped: boolean;
  reason: string | null;
  consecutiveLosses: number;
  sessionDrawdownPct: number;
  sustainedGlobalDanger: number;
  cooldownUntil: number | null;
}

export interface FinalDecision {
  verdict: FinalVerdict;
  stage3Verdict: EntryVerdict; // always preserved, untouched
  recommendedStake: PositionSizeReport | null;
  significance: SignificanceAssessment | null;
  exposure: PortfolioExposureReport | null;
  circuitBreaker: CircuitBreakerState;
  factors: SetupFactor[]; // same attributed pattern as setup.ts
  summary: string;
}

export interface OpportunityCandidate {
  id: string;
  market: string;
  marketDisplayName: string;
  contract: ContractType;
  direction: ContractDirection;
  barrier: number;
  opportunityScore: number; // 0 - 100
  confidence: number; // 0 - 100
  absoluteEdge: number; // % edge above baseline
  relativeEdge: number; // % advantage over #2 alternative
  dangerScore: number; // 0 - 100
  persistenceScore: number; // 0 - 100 across scans
  stabilityScore: number; // 0 - 100
  freshnessScore: number; // 0 - 100
  signalState: SignalState;
  engineAgreement: EngineAgreementState;

  // Canonical & Losing Side
  canonicalState: CanonicalDigitState;
  losingSide: LosingSideAssessment;
  pressureField?: import("../lib/precision-edge-v2/pressure-engine").PressureField;
  digitPsychology?: import("../lib/sentinel/digit-psychology").ContractPsychology;

  // Entry & Trigger
  selectedEntryDigit: Digit | null;
  entryConfidence: number;
  entryTrigger: EntryTriggerIntelligence;
  validityWindowSeconds: number;
  validUntil: number;

  // Execution Survival
  survivalMetrics: ExecutionSurvivalMetrics;

  // Risk & Stage 4 Additive Fields
  finalDecision?: FinalDecision;
  recommendedStake?: PositionSizeReport;
  winningMomentum?: import("../lib/sentinel/winning-side-momentum").WinningSideMomentum;
  evidenceProfile?: import("../lib/sentinel/market-state-evidence").EvidenceProfile;
  governance?: import("../lib/sentinel/global-veto").SignalGovernanceResult;
  digitIntel?: import("../lib/apex/digit-intel").DigitIntel;
  observationState?: import("../lib/sentinel/observation-layer").PropositionObservationState;
  dossier?: import("../lib/sentinel/observation-layer").ObservationDossier;
  regimeObservation?: import("../lib/sentinel/continuous-regime").ContinuousRegimeReport;
  executionState?: ExecutionQualificationState;
  executionSnapshot?: ExecutionSnapshot;
  executionHeartbeat?: LiveExecutionHeartbeat;
  qualificationContract?: QualificationContract;
  qualityBand?: QualityBand;

  // Explanations
  whyNumberOne: string[];
  invalidationConditions: string[];
  whyRunnerUpLost?: string;

  // Digit Momentum & Regime Compatibility
  digitMomentum?: import("../lib/sentinel/continuous-regime").DigitMomentumReport;
  regimeCompatibility?: import("../lib/sentinel/continuous-regime").RegimeCompatibilityAssessment;

  timestamp: number;
}

export interface SimulatedTrade {
  id: string;
  clientKey: string;
  market: string;
  contract: ContractType;
  entryEpoch: number;
  entryDigit: Digit;
  exitEpoch: number;
  exitDigit: Digit;
  result: "WIN" | "LOSS";
  stake: number;
  payout: number;
  pnl: number;
  touchClass: TouchClass;
  signalScoreAtEntry: number;
  losingPressureAtEntry: LosingPressureLevel;
  entryTriggerState: EntryTriggerState;
}

export interface MarketSimulatorStats {
  market: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;
  netPnl: number;
  maxDrawdown: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  rolling20m: {
    trades: number;
    wins: number;
    winRate: number;
    expectancy: number;
  };
  byContract: Record<
    ContractType,
    {
      trades: number;
      wins: number;
      winRate: number;
      expectancy: number;
    }
  >;
  recentTrades: SimulatedTrade[];
}

export interface OperatorFeedback {
  id: string;
  timestamp: number;
  market: string;
  contract: ContractType;
  entryDigit: Digit;
  isConfirmedTrade: boolean;
  result?: "WIN" | "LOSS";
  outcomeCategory:
    | "WIN_CLEAN"
    | "WIN_RECOVERY"
    | "LOSS_ENTRY_TIMING"
    | "LOSS_LATER_DETERIORATION"
    | "LOSS_LOSING_DIGIT_SPIKE"
    | "NOT_TRADED_OBSERVATION";
  notes: string;
  frozenSnapshot: {
    score: number;
    touchClass: TouchClass;
    losingPressure: LosingPressureLevel;
  };
}

export interface LearnedHypothesis {
  id: string;
  category: "TOUCH_PREFERENCE" | "SPECIAL_DIGIT" | "LOSING_PRESSURE" | "ENTRY_DIGIT_STABILITY";
  description: string;
  status: HypothesisStatus;
  sampleCount: number;
  winRate: number;
  evidenceScore: number;
  marketSymbol?: string;
  contractType?: ContractType;
  lastTestedEpoch: number;
}

export interface DBotExecutionPlan {
  market: string;
  marketDisplayName: string;
  contractType: string;
  contractCode: "DIGITOVER" | "DIGITUNDER";
  predictionBarrier: number;
  entryDigit: Digit;
  triggerInstruction: string;
  touchRule: TouchClass;
  recommendedStake: number;
  targetProfit: number;
  stopLoss: number;
  validitySeconds: number;
  validUntilTimestamp: number;
  xmlSnippet: string;
  jsonConfig: string;

  // Execution Snapshot & Live Health
  executionStatus: LiveExecutionStatus;
  qualifiedAtTimestamp: number;
  scoreAtQualification: number;
  currentLiveScore: number;
  scoreDrift: number;
  regimeAtQualification: string;
  currentLiveRegime: string;
  momentumAtQualification: string;
  currentLiveMomentum: string;
  dangerScore: number;
  isAtRisk: boolean;
  isInvalidated: boolean;
  invalidationReason: string | null;
  regimeCompatibility: string;
}

export interface ScanMemoryRecord {
  scanEpoch: number;
  rankedCandidates: {
    market: string;
    contract: ContractType;
    score: number;
    rank: number;
  }[];
}
