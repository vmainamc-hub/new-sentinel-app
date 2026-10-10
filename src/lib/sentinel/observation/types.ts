import type { CellId, MarketId, Proposition } from "./constants";
import type { CalibrationResult } from "@/lib/sentinel/calibration";
import type { SequentialTestReport } from "@/lib/sentinel/sequential-test";
import type { ComboEvidence } from "@/lib/sentinel/combination-learning";
import type {
  WinningSideMomentum,
  DirectionalMomentum,
} from "@/lib/sentinel/winning-side-momentum";
import type { LiquiditySweepObservation } from "@/lib/sentinel/liquidity-sweep";


// ---------------------------------------------------------------------------
// §8.1 — Observation states
// ---------------------------------------------------------------------------

export type ObservationState =
  | "WATCHING"
  | "INTERESTING"
  | "DEVELOPING"
  | "CONFIRMING"
  | "RIPE"
  | "UNSTABLE"
  | "CONFLICT"
  | "ABANDONED"
  | "DECAYING"
  | "EXPIRED"
  | "VETOED"
  | "REJECTED";

// ---------------------------------------------------------------------------
// §8.2 / §10 — Qualification & execution states
// (kept as genuinely distinct states, never synonyms — §11.4)
// ---------------------------------------------------------------------------

export type QualificationStage =
  | "CANDIDATE"
  | "STRONG_CANDIDATE"
  | "OPPORTUNITY"
  | "BEST_SETUP"
  | "EXECUTION_QUALIFIED"
  | "EXECUTION_WINDOW_ACTIVE";

export type LiveHealth = "HEALTHY" | "AT_RISK" | "INVALIDATED" | "EXPIRED";

// ---------------------------------------------------------------------------
// §7 — Evidence vocabulary. These are the *only* things the Observation Layer
// is allowed to reason over — they describe evidence already produced by
// existing Sentinel engines, never a re-derivation of it.
// ---------------------------------------------------------------------------

export type SupportLevel = "SUPPORTING" | "MIXED" | "OPPOSING" | "UNKNOWN";

export type StabilityState =
  "CALM" | "STABLE" | "DEVELOPING" | "FLUCTUATING" | "CHOPPY" | "HIGHLY_UNSTABLE" | "TRANSITIONING";

export type HiddenBehaviorState =
  "SUPPRESSED" | "EMERGING" | "ABSENT" | "UNEXPECTED" | "CONTRADICTORY" | "NONE";

export type EntryDigitState = "WAITING" | "FORMING" | "VALIDATED";

export type ConfirmationState = "INSUFFICIENT_SAMPLES" | "BUILDING" | "CONFIRMING" | "CONFIRMED";

export interface ConfirmationRead {
  state: ConfirmationState;
  ratio: number;
  sampleSize: number;
  windowSize: number;
}

export type SimulationState =
  | "STABLE"
  | "FAVOURABLE"
  | "UNFAVOURABLE"
  | "RECOVERING"
  | "LOSING"
  | "CHOPPY"
  | "TRANSITIONING"
  | "INSUFFICIENT";

export type RegimeClassification =
  | "CALM_STABLE"
  | "TRENDING_PERSISTENT"
  | "CHOPPY_OSCILLATING"
  | "TRANSITION"
  | "ACCUMULATION"
  | "DISPLACEMENT_MANIPULATION"
  | "DISTRIBUTION_EXHAUSTION"
  | "HIGH_VOLATILITY_UNSTABLE"
  | "UNKNOWN";

export type RegimeCompatibility = "COMPATIBLE" | "NEUTRAL_UNCERTAIN" | "INCOMPATIBLE";

export type MomentumSide = "OVER" | "UNDER" | "BALANCED" | "UNKNOWN";
export type MomentumState =
  "ACCELERATING" | "STABLE" | "DECELERATING" | "REVERSING" | "BALANCED" | "UNKNOWN";
export type MomentumRelation = "SUPPORTIVE" | "NEUTRAL" | "CONFLICTING";

export type StatisticsStrength = "STRONG" | "MODERATE" | "WEAK" | "INSUFFICIENT";

export type TriggerState = "INVALID" | "ARMING" | "VALID" | "FIRED" | "FAILED";

export type PressureWindow = 15 | 30 | 60 | 120;

// ---------------------------------------------------------------------------
// §4 — Evidence groups, as normalized shapes the adapter maps existing
// engine output onto. `raw` always carries the untouched original engine
// output through, so nothing is ever lost or duplicated in translation.
// ---------------------------------------------------------------------------

export interface PsychologyEvidence {
  direction: "OVER" | "UNDER" | "NONE";
  state:
    | "FORMING"
    | "STRENGTHENING"
    | "COHERENT"
    | "CONFLICTING"
    | "WEAKENING"
    | "REVERSING"
    | "INVALIDATING";
  support: SupportLevel;
  /** Existing Sentinel Green/2nd Green/Red/2nd Red/parity/edge result, untouched. */
  raw?: any;
}

export interface EntryDigitEvidence {
  digit: number | null;
  state: EntryDigitState;
  support: SupportLevel;
  dangerousCompetitor: boolean;
  raw?: any;
}

export interface PressureEvidence {
  byWindow: Record<PressureWindow, SupportLevel>;
  candidateDigitTrend: "TREND" | "FLUCTUATION" | "UNKNOWN";
  raw?: any;
}

export interface LosingSidePressureEvidence {
  state:
    | "CALM"
    | "DECLINING"
    | "STABLE"
    | "BUILDING"
    | "INCREASING"
    | "PRESSURED"
    | "ACCELERATING"
    | "HOSTILE"
    | "TAKEOVER";
  severity: "NONE" | "CAUTION" | "DOWNGRADE" | "REJECT" | "VETO";
  raw?: any;
}

export interface SimulationEvidence {
  state: SimulationState;
  sampleSize: number;
  conditionedOnRegime: boolean;
  raw?: any;
}

export interface RegimeEvidence {
  classification: RegimeClassification;
  confidence: number; // 0..1, as reported by the existing regime engine
  transitioning: boolean;
  compatibility: RegimeCompatibility;
  raw?: any;
}

export interface MomentumEvidence {
  side: MomentumSide;
  state: MomentumState;
  strength: number; // 0..1, as reported by the existing momentum engine
  winningSideMomentum?: WinningSideMomentum | null;
  /**
   * PHASE 13 — the authoritative directional momentum reading (winning-side,
   * losing-side, relative, reversal, takeover). Same object that fed the
   * authoritative danger composition for this cell.
   */
  directional?: DirectionalMomentum | null;
  raw?: any;
}


export interface TriggerEvidence {
  state: TriggerState;
  raw?: any;
}

export interface VetoEvidence {
  active: boolean;
  reason?: string;
  hard: boolean; // hard veto (§9) vs. soft/advisory
  raw?: any;
}

export interface StatisticsEvidence {
  strength: StatisticsStrength;
  sampleSize: number;
  calibration?: CalibrationResult | null;
  sequentialTest?: SequentialTestReport | null;
  combination?: ComboEvidence | null;
  raw?: any;
}

export interface DangerEvidence {
  total: number;
  level: "CALM" | "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";
  isHardBlocked: boolean;
  components: Array<{
    code: string;
    label: string;
    severity: "MILD" | "MODERATE" | "HIGH" | "SEVERE" | "AUTO_BLOCK";
    points: number;
    value: string;
    detail: string;
    isAutoBlock: boolean;
  }>;
  summary: string;
  raw?: any;
}

export interface HiddenBehaviorEvidence {
  state: HiddenBehaviorState;
  description?: string;
}

export interface CellFeedbackPostMortem {
  sourceId: string;
  timestamp: number;
  outcome: "WIN" | "LOSS" | "CANCELLED" | "PENDING";
  category: string | null;
  text: string;
  executionDanger: number;
  entryDigit: number | null;
  losingSidePressureState?: string | null;
  losingSidePressureIndex?: number | null;
  regime?: string | null;
  agreement?: string | null;
  summary: string;
  actionableDirectives: string[];
}

export interface CellFeedbackLearning {
  lastOutcome: "WIN" | "LOSS" | "CANCELLED" | "PENDING" | null;
  lastOutcomeAt: number | null;
  recentLosses: number;
  recentWins: number;
  activeConcern: string | null;
  activeCategory: string | null;
  activeDirectiveType: string | null;
  postMortemAdvice: string | null;
  cautionActive: boolean;
  cautionUntil: number | null;
  history: CellFeedbackPostMortem[];
}

// ---------------------------------------------------------------------------
// §6 — The Market Thesis object
// ---------------------------------------------------------------------------

export interface ExecutionValidityWindow {
  createdAt: number;
  currentAgeSeconds: number;
  currentAgeTicks: number;
  validityState: "VALID" | "EXPIRING_SOON" | "DECAYING" | "EXPIRED" | "INVALIDATED";
  remainingValiditySeconds: number;
  maxValiditySeconds: number;
  invalidationConditions: string[];
}

export interface MarketThesis {
  market: string;
  contract: Proposition;
  structuralDirection: "OVER" | "UNDER" | "NONE" | "UNKNOWN";
  direction?: string;
  structuralConfidence: "HIGH" | "MEDIUM" | "LOW";
  confidence?: number;
  currentPressure: "SUPPORTIVE" | "CONTRADICTORY" | "MIXED" | "UNKNOWN";
  pressureAgreement: string; // e.g. "4/4"
  agreement?: string;
  structuralFactors?: string[];
  counterEvidence?: string[];
  regime: { classification: string; suitability: "HIGH" | "MEDIUM" | "LOW" };
  simulation: { state: "SUPPORTIVE" | "UNSUPPORTIVE" | "INSUFFICIENT"; sampleSize: number };
  entryDigit: { digit: number | null; confidence: "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN" };
  losingSideThreat: "LOW" | "MEDIUM" | "HIGH";
  veto: "CLEAR" | "BLOCKED";
  observationState: ObservationState;
  lastChangedField?: string; // which input changed most recently, for debugging
}

// ---------------------------------------------------------------------------
// §4.1 — Observation Engine Health
// ---------------------------------------------------------------------------

export type ObservationEngineHealthState = "HEALTHY" | "DEGRADED" | "UNHEALTHY" | "STALE" | "ERROR";

export interface ObservationEngineHealthReport {
  status: ObservationEngineHealthState;
  lastIngestTimestamp: number;
  lastSuccessfulCycle: number;
  errorCount: number;
  lastError: string | null;
  message: string;
  healthyCount: number;
  ripeCount: number;
  activeCellsCount: number;
  cellsObserved: number;
  cellsTotal: number;
  cellsRipe: number;
  cellsActive: number;
  cellsVetoed: number;
  ingestErrors: number;
  lastTickLatencyMs: number;
  calibrationCheck: {
    status: "TOO_STRICT" | "TOO_LOOSE" | "BALANCED";
    ratio: number;
  };
}

// ---------------------------------------------------------------------------
// §7 — The observation dossier
// ---------------------------------------------------------------------------

export interface ObservationDossier {
  marketId: MarketId;
  proposition: Proposition;
  cellId: CellId;
  /**
   * The cell's permanent identity (§5/§33/§53 of the identity spec) —
   * optional only so existing dossier fixtures/tests that predate this
   * field keep compiling; every dossier produced by `ObservationCell.ingest`
   * always sets it. See `cellIdentity.ts`. Never mutated per tick.
   */
  identity?: import("./cellIdentity").CellIdentity;
  /**
   * How well the current market state is fulfilling `identity` right now
   * (§34) — explicitly distinct from `score` and from qualification (§39).
   * Null only when upstream evidence hasn't supplied enough to evaluate
   * (never a fabricated pass — §51).
   */
  identityConformance?: import("./cellIdentity").IdentityConformance | null;
  state: ObservationState;
  score: number; // Unified composite ranking score (0..100)
  isRipe: boolean; // True when state is RIPE and cleared qualification gates
  factors?: Array<{ label: string; points: number; detail: string }>;
  observationAge: number; // ticks/samples since first created
  currentStateSince: number; // ticks/samples since entering current state
  stability: StabilityState;
  psychology: PsychologyEvidence;
  entryDigit: EntryDigitEvidence;
  pressure: PressureEvidence;
  losingSidePressure: LosingSidePressureEvidence;
  /** Proposition-aware observed opposing-digit concentration → exhaustion → transition. */
  liquiditySweep: LiquiditySweepObservation;
  danger: DangerEvidence;
  simulation: SimulationEvidence;
  regime: RegimeEvidence;
  momentum: MomentumEvidence;
  momentumRelation: MomentumRelation;
  trigger: TriggerEvidence;
  veto: VetoEvidence;
  statistics: StatisticsEvidence;
  hiddenBehavior: HiddenBehaviorEvidence;
  contradictions: number;
  supportingEvidence: string[];
  opposingEvidence: string[];
  formationVelocity: "RAPID" | "NORMAL" | "SLOW" | "DETERIORATING";
  evidenceMaturity: "LOW" | "MODERATE" | "HIGH";
  tickConfirmation?: ConfirmationRead;
  assessment: string; // short current-status phrase
  thesis?: MarketThesis;
  validityWindow?: ExecutionValidityWindow;
  feedbackLearning?: CellFeedbackLearning | null;

  // Fully populated and consumed contextual engine outputs
  contractContext?: any;
  marketContext?: any;
  governance?: any;
  governedSpine?: any;
  operatorLearning?: any;
  guidance?: any;
  survival?: any;
  survivalInfluence?: any;
  entryTrigger?: any;
  contextMarkov?: any;
  convergence?: any;
  evidenceFusion?: any;
  setupQuality?: any;
  entryClearance?: any;
  operatorSpecial?: any;
  marketLearning?: any;
  clearance?: any;
  evidenceStatus?: any;
  direction?: any;
  agreementBonus?: number;
  manipulationScore?: any;
  priceAction?: any;
  priceActionField?: any;
  entryPoint?: any;
  stateEvidence?: any;
  relative?: any;
  persistence?: any;
  combination?: any;
  regimeReport?: any;
  qualityBand?: import("./selectivity").QualityBand;
  qualityAssessment?: import("./selectivity").QualityAssessment;
  executionReady?: boolean;
  executionReadyReasons?: string[];
}

export interface ObservationEvent {
  timestamp: number;
  from: ObservationState;
  to: ObservationState;
  reason: string;
}

// ---------------------------------------------------------------------------
// §10 — Immutable qualification snapshot
// ---------------------------------------------------------------------------

export interface QualificationSnapshot {
  cellId: CellId;
  marketId: MarketId;
  proposition: Proposition;
  qualifiedAt: number;
  qualificationConfidence: StatisticsStrength;
  qualificationRegime: RegimeClassification;
  qualificationRegimeConfidence: number;
  qualificationRegimeTransition: boolean;
  qualificationMomentum: MomentumRelation;
  qualificationDigit: number | null;
  qualificationStructure: PsychologyEvidence;
  qualificationPressure: PressureEvidence;
  qualificationDanger?: DangerEvidence;
  qualificationStatistics: StatisticsEvidence;
  qualificationTrigger: TriggerEvidence;
  executionWindowStartedAt: number;
  executionWindowExpiresAt: number; // fixed at qualifiedAt + 90s, never rolls forward (§10.3)
  explanation: string[]; // §12 "why RIPE", frozen at qualification time
}

export interface QualifiedOpportunity {
  snapshot: QualificationSnapshot;
  stage: "EXECUTION_QUALIFIED" | "EXECUTION_WINDOW_ACTIVE";
  liveHealth: LiveHealth;
  liveHealthReason: string;
}
