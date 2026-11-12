// Precision Parity AI — types.
// Institutional-grade Even/Odd intelligence. Independent of Precision Edge.

export type Parity = "EVEN" | "ODD";
export type ParityContract = "BUY_EVEN" | "BUY_ODD";

export type MarketRegime =
  | "STABLE"
  | "TRENDING"
  | "OSCILLATING"
  | "COMPRESSED"
  | "EXPANDING"
  | "MANIPULATED"
  | "CHAOTIC"
  | "RECOVERY"
  | "NEUTRAL";

export type HiddenRegime =
  | "BALANCED"
  | "EVEN_DOMINANCE"
  | "ODD_DOMINANCE"
  | "ALTERNATING"
  | "REVERSAL_BUILDING"
  | "COMPRESSION"
  | "EXPANSION"
  | "UNCERTAIN";

export type MaturityState =
  | "EMERGING"
  | "BUILDING"
  | "MATURE"
  | "PEAK"
  | "WEAKENING"
  | "EXPIRED";

export interface WindowStat {
  n: number;
  evenPct: number;
  oddPct: number;
  entropy: number;
}

export interface TransitionMatrix {
  window: number;
  eeCount: number;
  eoCount: number;
  oeCount: number;
  ooCount: number;
  pEE: number;
  pEO: number;
  pOE: number;
  pOO: number;
  sample: number;
}

export interface SecondOrderMatrix {
  window: number;
  // last two-parities -> P(next EVEN)
  pEvenAfter: Record<"EE" | "EO" | "OE" | "OO", number>;
  counts: Record<"EE" | "EO" | "OE" | "OO", number>;
}

export interface BarSnapshot {
  digit: number;
  parity: Parity;
  zone: "LOWER" | "UPPER";
  pct: number;         // 0..1 in recent window
  velocity: number;    // recent - baseline (-1..1)
  persistence: number; // ticks since it became green/red bar
}

export interface DigitPsychology {
  hot: number;
  cold: number;
  mostAppearing: number;
  secondMostAppearing: number;
  leastAppearing: number;
  secondLeastAppearing: number;
  rising: number;   // most increasing
  falling: number;  // most decreasing
  rotationSpeed: number; // 0..1
  clustering: number;    // 0..1
  zoneA: number;
  zoneB: number;
}

export interface Evidence {
  engine: string;
  supports: ParityContract | "NEUTRAL";
  strength: number; // 0..1
  detail: string;
}

export interface HypothesisEvaluation {
  contract: ParityContract;
  confidence: number;        // 0..100 Bayesian
  supports: Evidence[];
  conflicts: Evidence[];
  contradictionScore: number; // 0..100
  maturity: MaturityState;
  persistenceTicks: number;
  reasoning: string[];
}

export type AnalystVerdict = "APPROVED" | "REJECTED" | "DEFER";
export type RiskVerdict = "APPROVED" | "CAUTION" | "REJECTED";
export type MarketPhase =
  | "EMERGING"
  | "STABLE_EXPANSION"
  | "MATURE_TREND"
  | "LATE_TREND"
  | "TRANSITION"
  | "CHAOTIC";

export interface AnalystReview {
  verdict: AnalystVerdict;
  keyQuestion: string;
  answer: string;
  supportsRecommendation: string[]; // "What supports EVEN?"
  challengesRecommendation: string[]; // "What contradicts EVEN?"
  supportsOpposite: string[]; // "What supports ODD?"
  challengesOpposite: string[]; // "What contradicts ODD?"
  wouldRiskMoney: boolean;
  summary: string;
}

export interface RiskReview {
  verdict: RiskVerdict;
  concerns: string[];
  tooLate: boolean;
  crowdAlreadyIn: boolean;
  edgeWeakening: boolean;
  waitingImproves: boolean;
  summary: string;
}

export interface EdgeStability {
  score: number; // 0..100
  label: "FRAGILE" | "OK" | "STABLE" | "DURABLE";
  expectedEntries: number; // e.g. 3..7
  expectedDurationSeconds: number;
  reasons: string[];
}

// ── Market Intelligence Analyst panel ──────────────────────────────────────
// A dialectic between two independent analysts, arbitrated by a Chief
// Analyst and stress-tested by a Contrarian. Precision Parity is no longer
// a signal generator; it is a panel of quantitative analysts.

export interface AnalystArgument {
  claim: string;      // one sentence
  evidence: string;   // the numeric / structural backing
  weight: number;     // 0..1
}

export interface BullReview {
  contract: ParityContract;    // the side being defended
  arguments: AnalystArgument[];
  strength: number;            // 0..100 (weighted sum of arguments)
  summary: string;
}

export interface BearReview {
  attacks: AnalystArgument[];  // why the Bull's contract could fail
  destructiveness: number;     // 0..100
  summary: string;
}

export interface DebateExchange {
  side: "BULL" | "BEAR";
  line: string;
}

export interface ChiefVerdict {
  decision: "APPROVE" | "REJECT" | "DEFER";
  contract: ParityContract | "NO_TRADE";
  bullWon: boolean;
  strongestSupport: string;
  strongestOpposition: string;
  whyOppositionRejected: string;
  uncertainty: string;
  reasoning: string; // prose paragraph
  grade: "A" | "B" | "C" | "D";
}

export interface DBotSurvivalProfile {
  survival: number[];        // probability the edge persists after entry k (k=1..5)
  expectedWinRun: number;    // ticks
  expectedLossRun: number;   // ticks
  flipProbability5: number;  // 0..1 — probability the market flips within 5 entries
  durability: "LOW" | "MODERATE" | "HIGH" | "VERY_HIGH";
  recommendedRuns: number;   // 1..5
  cooldownSeconds: number;
}

export interface ContrarianReview {
  verdict: "PASS" | "BLOCK";
  concerns: AnalystArgument[];
  crowded: boolean;
  late: boolean;
  trapRisk: number; // 0..100
  summary: string;
}

export interface ConfidenceBreakdown {
  prediction: number;      // raw hypothesis confidence
  persistence: number;     // ability to survive multi-entry
  stability: number;       // environmental stability
  reversalRisk: number;    // 0..100
  contradiction: number;   // 0..100
  dbotSurvival: number;    // composite dbot-durability score
  expectedValue: number;   // per-trade EV using 0.95 payout
  hypothesisStrength: number;
  reasoningQuality: number; // 0..100
  expectedWinRun: number;
  expectedLossRun: number;
}

export interface IntelligencePanel {
  bull: BullReview;
  bear: BearReview;
  crossExamination: DebateExchange[];
  chief: ChiefVerdict;
  dbotSurvival: DBotSurvivalProfile;
  contrarian: ContrarianReview;
  breakdown: ConfidenceBreakdown;
  intelligenceGrade: "A" | "B" | "C" | "D";
}

export interface ExecutionPlan {
  contract: ParityContract;
  marketPhase: MarketPhase;
  reasoningQuality: "Low" | "Medium" | "High" | "Very High";
  recommendedRuns: number;
  recommendedStake: string;
  maxDelaySeconds: number;
  signalExpirySeconds: number;
  expectedPersistenceTrades: number;
  entryDirective: string;
  recoveryCompatibility:
    | "Not compatible"
    | "Suitable for mild recovery only"
    | "Suitable for full recovery";
  status: "READY" | "HOLD";
}

export interface DBotPlan {
  contract: ParityContract;
  market: string;
  marketName: string;
  entry: "Immediate" | "Wait";
  recommendedRuns: number;
  maxConsecutiveEntries: number;
  cancelConditions: string[];
  status: "READY TO LOAD" | "HOLD";
}

export interface ParityVerdict {
  recommendation: ParityContract | "NO_TRADE";
  state: "READY" | "BUILDING" | "MONITORING" | "REJECTED";
  confidence: number;
  reasons: string[];
  hypotheses: HypothesisEvaluation[];
  analyst?: AnalystReview;
  risk?: RiskReview;
  stability?: EdgeStability;
  plan?: ExecutionPlan;
  dbot?: DBotPlan;
  panel?: IntelligencePanel;
  deep?: import("./deep-reasoning").DeepReasoning;
}

// Re-exported from ./forecast so the report can carry it typed.
export type { ForecastReport } from "./forecast";

export interface MarketParityReport {
  market: string;
  name: string;
  ticks: number;
  regime: MarketRegime;
  hiddenRegime: HiddenRegime;
  windows: Record<number, WindowStat>;
  transitions: TransitionMatrix[];
  secondOrder: SecondOrderMatrix;
  greenBar: BarSnapshot;
  redBar: BarSnapshot;
  digitPsychology: DigitPsychology;
  manipulation: number;    // 0..100
  fluctuation: number;     // 0..100
  crowding: number;        // 0..100
  historicalSimilarity: number; // 0..1
  forecast?: import("./forecast").ForecastReport;
  verdict: ParityVerdict;
}