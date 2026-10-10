// APEX SENTINEL INTELLIGENCE — core data contracts.
// Every field in here is produced by a real quantitative engine from live
// Deriv tick data. Nothing is simulated. When data is missing the state is
// explicitly marked UNAVAILABLE / STALE / THIN instead of being invented.
import type { ThreatReport } from "./threat";
import type { CriticalConflict, CriticalReport } from "./critical";
import type { StatReport, RateEstimate } from "./statistics";
import type { EnsembleResult } from "./ml";
import type { ForwardState } from "./forward";
import type { FakeEdgeCheck, ContractBattle } from "./battle";
import type { DigitIntel } from "./digit-intel";
import type { BarStructure } from "./bars";
import type { ContractAnalysis as LiquidityContractAnalysis, MarketAnalysis as LiquidityMarketAnalysis } from "../liquidity/engine";

export type ApexContractId = "UNDER6" | "UNDER7" | "UNDER8" | "OVER1" | "OVER2" | "OVER3";

export const APEX_CONTRACTS: ApexContractId[] = [
  "UNDER7",
  "OVER2",
  "UNDER6",
  "UNDER8",
  "OVER1",
  "OVER3",
];

/** Contracts the operator prefers, subject to the preference window. */
export const PRIMARY_CONTRACTS: ApexContractId[] = ["UNDER7", "OVER2"];

export type DataState = "OK" | "THIN" | "STALE" | "UNAVAILABLE";

export type SetupPhase = "FORMING" | "FRESH" | "MATURE" | "WEAKENING" | "INVALIDATING";

export type RegimeLabel = "BALANCED" | "SKEWED" | "TRENDING" | "COMPRESSED" | "CHAOTIC";

export type DigitLifecycle =
  "emerging" | "dominant" | "exhausting" | "suppressed" | "recovering" | "neutral";

export interface Evidence {
  engine: string;
  label: string;
  detail: string;
  /** −1 .. +1 — how strongly this supports the contract. */
  weight: number;
  /** Sample size behind the measurement (0 = not sample based). */
  n: number;
}

export interface DigitStatsOut {
  n: number;
  freq: number[]; // counts, length 10
  pct: number[]; // base window share
  midPct: number[];
  recentPct: number[];
  microPct: number[];
  z: number[]; // z-score of base share vs uniform
  lastDigit: number;
  dominant: number;
  suppressed: number;
}

export interface PressureOut {
  /** recentPct − basePct per digit. */
  pressure: number[];
  /** micro vs recent — the fast component. */
  impulse: number[];
  lifecycle: DigitLifecycle[];
  exhaustion: number[]; // 0..1 how exhausted each digit looks
  zoneAShare: number; // digits 0-4 recent share
  zoneBShare: number;
  migration: number; // + = mass moving to high digits
}

export interface TransitionOut {
  n: number;
  /** P(next digit = d | current digit) from the observed chain. */
  nextDist: number[];
  /** Sample count behind nextDist. */
  rowN: number;
  /** Normalised divergence of the chain from an i.i.d. process, 0..1. */
  dependency: number;
}

export interface SequenceOut {
  repeatRate: number;
  alternationRate: number;
  maxRunWinners: number;
  currentRun: number;
  runDigit: number;
}

export interface EntropyOut {
  entropy: number; // 0..1 normalised Shannon
  chi2: number;
  uniformityFail: boolean; // chi2 beyond 5% critical value (16.92, df=9)
}

export interface AnomalyOut {
  score: number; // 0..100
  reasons: string[];
}

export interface VolatilityOut {
  base: number;
  recent: number;
  ratio: number; // recent / base
  label: "calm" | "normal" | "elevated" | "violent";
}

export interface TrendOut {
  slopePctPer100: number;
  greenRate: number; // share of up ticks in recent window
  momentum: number; // −1..1
  label: "up" | "down" | "flat";
}

export interface RegimeOut {
  label: RegimeLabel;
  confidence: number; // 0..100
  detail: string;
}

export interface PersonalityOut {
  /** Mean gap between appearances per digit (uniform expectation = 10). */
  meanGap: number[];
  /** Ticks since the digit last appeared. */
  sinceSeen: number[];
  /** Stickiness: P(d | d) / base P(d). */
  stickiness: number[];
}

export interface HiddenBuildupOut {
  score: number; // 0..100
  digits: number[];
  detail: string;
}

export interface MarketQualityOut {
  score: number; // 0..100
  detail: string;
}

export interface ContractEval {
  id: ApexContractId;
  label: string;
  side: "UNDER" | "OVER";
  barrier: number;
  winners: number[];
  theoretical: number; // 0..1
  empirical: number; // 0..1 base window
  recent: number; // 0..1 recent window
  micro: number; // 0..1 micro window
  n: number;
  edge: number; // empirical − theoretical (fraction)
  edgeLB: number; // Wilson 95% lower bound of edge
  pressureAsymmetry: number; // −1..1
  transitionSupport: number; // −1..1 from Markov chain
  compositeEdge: number; // −100..100
  stability: number; // 0..100
  freshness: number; // 0..100
  quality: number; // 0..100
  danger: number; // 0..100
  confidence: number; // 0..100
  opportunity: number; // 0..100
  phase: SetupPhase;
  supports: Evidence[];
  conflicts: Evidence[];
  contradiction: number; // 0..100
  ageTicks: number;

  // ---- Deep-reasoning refinement layers (null when the engine had no data) ----
  /** Losing-digit threat analysis for this contract's losing side. */
  threat: ThreatReport | null;
  /** Critical digit structures pointing at losing digits. */
  critical: CriticalConflict | null;
  /** Statistical validation of the observed pattern. */
  stats: StatReport | null;
  /** Shrunk, interval-bounded win-rate estimate. */
  rate: RateEstimate | null;
  /** Walk-forward validated model ensemble. */
  ensemble: EnsembleResult | null;
  /** Constrained forward state projection. */
  forward: ForwardState | null;
  /** Terminal-observed historical analogue for the current state. */
  analogue: { n: number; rate: number } | null;
  /** Structured "why this is not a fake edge" interrogation. */
  fakeEdge: FakeEdgeCheck | null;
  /** Whether the current regime supports this contract. */
  regimeCompatible: boolean;
  regimeNote: string;
  /** Penalty applied by the threat + critical layers, 0..100. */
  threatPenalty: number;
  /** Operator-facing alerts raised for this contract. */
  alerts: string[];

  // ---- Losing-side risk layers (attached by the core after evaluation) ----
  /** LOSING_DIGIT_RISK / LOSING_DIGIT_EXPOSURE for this contract's losing digits. */
  exposure?: import("./exposure").ExposureReport | null;
  /** SPECIAL DIGIT RISK (0/1/8/9) scoped to this contract's losing side. */
  specialRisk?: import("./special-digits").SpecialDigitReport | null;
  /** LOSING_SIDE_PRESSURE — bounded aggregate ranking modifier for the losing side. */
  losingSidePressure?: import("@/lib/sentinel/losing-side-pressure").LosingSidePressure | null;
  /** WINNING_SIDE_MOMENTUM — bounded, reward-only ranking modifier for the winning side. */
  winningSideMomentum?: import("@/lib/sentinel/winning-side-momentum").WinningSideMomentum | null;
  /** Canonical danger composition computed once per cycle by ApexCore. */
  dangerComposition?: import("@/lib/sentinel/danger").DangerComposition | null;
  /** DigitPulse liquidity/formation intelligence, computed from the same canonical tick history. */
  liquidity?: LiquidityContractAnalysis | null;
}

export interface MarketIntel {
  symbol: string;
  name: string;
  dataState: DataState;
  ticks: number;
  lastTickAt: number;
  ageMs: number;
  stats: DigitStatsOut | null;
  pressure: PressureOut | null;
  transition: TransitionOut | null;
  sequence: SequenceOut | null;
  entropy: EntropyOut | null;
  anomaly: AnomalyOut | null;
  volatility: VolatilityOut | null;
  trend: TrendOut | null;
  regime: RegimeOut | null;
  personality: PersonalityOut | null;
  buildup: HiddenBuildupOut | null;
  quality: MarketQualityOut | null;
  danger: number;
  contracts: ContractEval[];
  best: ContractEval | null;
  updatedAt: number;

  // ---- Refinement layers ----
  /** Multi-window per-digit intelligence (10 → 5000 ticks). */
  digitIntel: DigitIntel | null;
  /** Green/red bar structure. */
  bars: BarStructure | null;
  /** Critical digit roles for this market. */
  criticalReport: CriticalReport | null;
  /** Head-to-head Over vs Under comparison. */
  battle: ContractBattle | null;
  /** Deep buffer length actually available to the digit engines. */
  deepTicks: number;
  /** Observed Over / Under digit-psychology configuration (hypothesis layer). */
  psychology: import("./psychology").PsychologyReport | null;
  /** Market-level SPECIAL DIGIT RISK for 0/1/8/9. */
  specialDigits: import("./special-digits").SpecialDigitReport | null;
  /** Full DigitPulse liquidity + 1,000-tick psychology analysis on the same feed. */
  liquidity?: LiquidityMarketAnalysis | null;
  /** FLUCTUATION_SCORE / STATE / SIGNAL_FLICKER_RATE for this market. */
  fluctuation: import("./fluctuation").FluctuationReport | null;
}

export interface RankedOpportunity {
  rank: number;
  symbol: string;
  name: string;
  contract: ContractEval;
  intel: MarketIntel;
  score: number;
  preferred: boolean;
  /** Contract-resolved simulator record for this market/contract pair. */
  simulator: import("./simulator").SimPerformance | null;
  simNote: string;
  /** Discovered entry condition evidence for this market/contract pair. */
  entry: import("./entry-conditions").EntryRecommendation | null;
  /** Cross-engine agreement label for the candidate. */
  agreement: "SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG CONFLICT";
  /** Full attribution of the ranking score — every contributing component. */
  factors: RankFactor[];
  /** Conditions that would invalidate this ranking if they occur. */
  invalidation: string[];
  /** Rolling-window record for THIS market/contract. Never a global figure. */
  recent: import("./simulator").SimPerformance | null;
  /** Danger clearance — safety is decided separately from direction. */
  clearance: import("./clearance").ClearanceReport;
  /** Confidence-adjusted classification of the evidence behind this candidate. */
  evidence: import("./evidence-status").EvidenceAssessment;
  /**
   * True when clearance blocks the candidate. It stays in the ranking so a real
   * opportunity is never silently deleted — it is surfaced as BLOCKED instead.
   */
  blocked: boolean;
  /** Unified Veto Resolution (§5) — single canonical verdict across local, observation, and global layers. */
  vetoResolution?: import("@/lib/sentinel/veto-resolver").VetoResolution;
  /** STAGE 1 — direction belief from weighted engine votes. */
  direction: import("../sentinel/direction").DirectionReport;
  /** STAGE 2a — labelled danger composition (never a raw blend). */
  dangerComposition: import("../sentinel/danger").DangerComposition;
  /** STAGE 2 — setup quality: direction discounted by danger and evidence. */
  setup: import("../sentinel/setup").SetupReport;
  /** STAGE 3 — CLEARED / WAIT / BLOCKED verdict with its requirements. */
  entryClearance: import("../sentinel/entry-clearance").EntryClearanceReport;
  /** STAGE 3.5 — market × contract × regime × entry-condition evidence. */
  combination: import("../sentinel/combination-learning").ComboLookup;
  /** RELATIVE EDGE — this candidate measured against the current alternatives. */
  relative: import("../sentinel/relative-edge").RelativeEdgeReport;
  /** SIGNAL PERSISTENCE / EDGE STABILITY across the retained scan history. */
  persistence: import("../sentinel/scan-memory").PersistenceReport;
  /** DYNAMIC ENTRY POINT — which observed digit to enter on, and for how long. */
  entryPoint: import("../sentinel/entry-point").EntryPointReport;
  /**
   * LEVEL 2 — post-entry execution survival for this market × contract × entry
   * digit. Null when no entry digit is validated; INSUFFICIENT when immature.
   */
  survival: import("../sentinel/execution-survival").ExecutionSurvivalReport | null;
  /** Bounded Level-2 influence actually applied to the ranking score. */
  survivalInfluence: import("../sentinel/execution-integration").SurvivalInfluence;
  /**
   * LEVEL 2.5 — ENTRY TRIGGER INTELLIGENCE. Which PRINT of the entry digit the
   * operator should actually trigger on: the first touch after an absence, or a
   * subsequent touch inside a cluster. Null when no entry digit is validated;
   * INSUFFICIENT TRIGGER HISTORY when the cohorts are too small to separate.
   */
  entryTrigger: import("../sentinel/entry-trigger").EntryTriggerReport | null;
  /** UNIFIED SIGNAL STATE — translation of the existing engine states. */
  signal: import("../sentinel/signal-state").SentinelSignal;
  /**
   * CANONICAL DIGIT PSYCHOLOGY — the 1,000-tick digit-frequency reading of this
   * contract's winning / losing / boundary zones. Bounded evidence only.
   */
  digitPsychology: import("../sentinel/digit-psychology").ContractPsychology;
  /** The canonical 1,000-tick digit state the reading above was derived from. */
  digitState: import("../sentinel/digit-psychology").CanonicalDigitState;
  /**
   * LOWER-TIMEFRAME PRESSURE — the 120-tick price-action reading for this
   * contract: which side is gaining, whether the losing side is taking over,
   * and whether the current price action confirms the 1,000-tick structure.
   */
  priceAction: import("../sentinel/price-action-psychology").ContractPriceAction;
  /** The raw 120-tick pressure field the reading above was derived from. */
  priceActionField: import("../sentinel/price-action-psychology").PriceActionField;
  /**
   * OPERATOR SPECIAL-DIGIT ACTION — digit 1 in Over / digit 8 in Under.
   * Bounded internal ranking influence; not surfaced as a primary-card warning.
   */
  operatorSpecial: import("../sentinel/operator-special-digits").OperatorSpecialDigitRead;
  /** MODEL CONVERGENCE across the independent dimensions. Explanatory. */
  convergence: import("../sentinel/convergence").ConvergenceRead;
  /** ENGINE #1 — REGIME / CHANGEPOINT report from Page-Hinkley/CUSUM detector. */
  regimeReport?: import("../sentinel/regime-detector").RegimeReport | null;
  /** ENGINE #2 — CORRELATION-AWARE EVIDENCE FUSION report. */
  evidenceFusion?: import("../sentinel/evidence-fusion").EvidenceFusionReport | null;
  /** ENGINE #3 — CALIBRATION ENGINE empirical win probability. */
  calibration?: import("../sentinel/calibration").CalibrationResult | null;
  /** ENGINE #3.5 — SEQUENTIAL PROBABILITY RATIO TEST (SPRT). */
  sequentialTest?: import("../sentinel/sequential-test").SequentialTestReport | null;
  /** ENGINE #4 — VARIABLE-ORDER MARKOV / CONTEXT ENGINE evaluation. */
  contextMarkov?: import("../sentinel/context-engine").VariableOrderMarkovReport | null;
  /**
   * SENTINEL DECISION SPINE — 1,000-tick structure (direction) →
   * 15/30/60/120 pressure (confirm / reject) → veto engine (permission).
   */
  spine?: import("../sentinel/proposal").SentinelSpineReport | null;
  /** LEVELS 1 & 2 — trader global veto + cross-market pattern risk governance. */
  governance?: import("../sentinel/global-veto").SignalGovernanceResult | null;
  /** Statistical interpretation of the resolved simulated-outcome sequence. */
  stateEvidence?: import("../sentinel/market-state-evidence").EvidenceProfile | null;
  /** 90-Cell Continuous Observation Layer state and dossier. */
  observationDossier?: import("@/lib/sentinel/observation").ObservationDossier | null;
  /** Direct dossier alias for observation layer integration. */
  dossier?: import("@/lib/sentinel/observation").ObservationDossier | null;
  /** 90-Cell Continuous Observation Layer qualification snapshot and live health. */
  observationQualification?: import("@/lib/sentinel/observation").QualifiedOpportunity | null;
  /** §9 Observation Quality Band assessed from dossier evidence. */
  qualityBand?: import("@/lib/sentinel/observation/selectivity").QualityBand;
  /** Reliability state of calibration statistics when present. */
  reliabilityState?: string;
  /** Lower-timeframe losing side pressure index, modifier, and state. */
  losingSidePressure?: import("../sentinel/price-action-psychology").SidePressure | null;
  /** §35 Additive 4-condition Execution Ready boolean for DBot / execution handoff. */
  executionReady?: boolean;
  /** §35 Specific reasons when executionReady is false. */
  executionReadyReasons?: string[];
  /** STAGE 4 — Risk-integrated final decision (Never-Upgrade, Multiple-Testing, Sizing, Exposure). */
  finalDecision?: import("@/types/sentinel").FinalDecision;
  /** STAGE 4 — Recommended fractional-Kelly stake report. */
  recommendedStake?: import("@/types/sentinel").PositionSizeReport;
  /** DIAGNOSTIC — Near-Signal classification explaining strengths and missing execution condition. */
  nearSignal?: import("../sentinel/near-signal").NearSignalAssessment | null;
  /**
   * DIAGNOSTIC — graded empirical Confluence evidence stamped by the single
   * final-rank engine. Display only; it is never a second ranking.
   */
  confluence?: import("./confluence").ConfluenceCore | null;
  /**
   * DIAGNOSTIC — CELL IDENTITY evidence stamped by the single final-rank
   * engine (identity spec §14). Null / absent means UNKNOWN, never a pass.
   */
  identityEvidence?:
    | import("../sentinel/observation/identityIntegrationContract").IdentityRankingEvidence
    | null;
}

/** One transparent, signed contribution to a market's ranking score. */
export interface RankFactor {
  label: string;
  points: number;
  detail: string;
}

export type BestOf90Status =
  | "BEST OF 90 — EXECUTION READY"
  | "BEST OF 90 — WAITING FOR ENTRY"
  | "BEST OF 90 — QUALIFIED"
  | "BEST OF 90 — NEAR-SIGNAL"
  | "BEST OF 90 — BLOCKED"
  | "BEST OF 90 — NOT QUALIFIED";

export interface BestOf90Result {
  rank: 1;
  populationSize: number;
  bestOfPopulation: boolean;
  candidate: RankedOpportunity;
  status: BestOf90Status;
  qualified: boolean;
  blockers: string[];
  executionReady: boolean;
  executionReadyReasons: string[];
  waitForEntry: boolean;
  analyzedAt: number;
  /** STAGE 4 — Final risk-integrated decision for the Best-of-90 candidate. */
  finalDecision?: import("@/types/sentinel").FinalDecision | null;
  /** STAGE 4 — Recommended fractional-Kelly stake for the Best-of-90 candidate. */
  recommendedStake?: import("@/types/sentinel").PositionSizeReport | null;
  /** DIAGNOSTIC — Near-Signal classification for the Best-of-90 candidate. */
  nearSignal?: import("../sentinel/near-signal").NearSignalAssessment | null;
}

export interface ScanResult {
  scannedAt: number;
  marketsOnline: number;
  marketsTotal: number;
  evaluated: number;
  globalDanger: number;
  globalDangerLabel: "CALM" | "ELEVATED" | "HOSTILE";
  top: RankedOpportunity[];
  /**
   * THE single authoritative final ranking of the whole observed population.
   * `finalRank[0]` is the one and only Rank #1 / Scan winner, qualified or not.
   */
  finalRank?: RankedOpportunity[];
  /** Stable surface-vetted subset, preserving finalRank order; never a second ranking. */
  surfaceRank?: RankedOpportunity[];
  /** First surface-vetted candidate in finalRank order, or null when none pass. */
  surfacedOpportunity?: RankedOpportunity | null;
  /** Qualification status per candidate, in exactly the same order as finalRank. */
  rankEntries?: import("./final-rank").FinalRankEntry<RankedOpportunity>[];
  bestOf90?: BestOf90Result | null;
  best?: RankedOpportunity | null;
  rejected: { symbol: string; contract: string; reason: string }[];
  verdict: "OPPORTUNITY" | "MODERATE" | "NONE" | "DATA_UNAVAILABLE";
  message: string;
  /** STAGE 4 — Portfolio exposure report across all 90 evaluated cells. */
  exposureReport?: import("@/types/sentinel").PortfolioExposureReport | null;
  /** STAGE 4 — Active session circuit breaker state. */
  circuitBreaker?: import("@/types/sentinel").CircuitBreakerState | null;
}
