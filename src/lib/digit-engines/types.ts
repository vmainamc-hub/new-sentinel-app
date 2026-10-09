export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export type ParityContract = "DIGITEVEN" | "DIGITODD";
export type DigitContract = "DIGITMATCH" | "DIGITDIFF";
export type DigitContractType = ParityContract | DigitContract;
export type EngineName = "even-odd" | "matches" | "differs";
export interface DigitTick { quote: string | number; pipSize: number; epoch?: number; }
export interface QuoteEconomics { stake: number; /** Total return if won, including returned stake. */ totalPayout: number; }
export interface ValidationReport { observations: number; modelBrier: number; baselineBrier: number; }
export interface EngineInput {
  ticks: DigitTick[];
  symbol?: string;
  minSampleSize?: number;
  quotes?: Record<string, QuoteEconomics>;
  validation?: Record<string, ValidationReport>;
}
export type QualificationStatus = "QUALIFIED" | "UNQUALIFIED";
export interface Candidate {
  engine: EngineName; symbol?: string; contractType: DigitContractType; barrier: string | null; label: string;
  /** Ranking score only; it is not a win probability. */
  candidateScore: number; estimatedWinProbability: number; empiricalLowerBound: number; sampleSize: number;
  breakEvenProbability: number | null; expectedValuePerTrade: number | null;
  qualification: QualificationStatus; canTrade: boolean; reasons: string[];
}
export interface EngineResult {
  engine: EngineName; symbol?: string; sampleSize: number; currentDigit: Digit | null; candidates: Candidate[];
  bestCandidate: Candidate | null; status: "READY" | "INSUFFICIENT_DATA" | "NO_CANDIDATE"; note: string;
}
export interface FrequencyWindow { size: number; sampleSize: number; counts: number[]; rates: number[]; }
export interface DigitDistribution {
  digits: Digit[];
  windows: { short: FrequencyWindow; medium: FrequencyWindow; long: FrequencyWindow };
  entropy: number;
}
