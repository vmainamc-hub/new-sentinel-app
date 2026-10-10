// APEX SENTINEL — refinement settings.
// Every threshold that governs the refined intelligence is configurable and
// documented here. Nothing is hidden inside an engine.
export interface ApexRefinementSettings {
  /** Minimum ticks before an empirical rate is allowed any score weight. */
  minSample: number;
  /** Beta-binomial prior strength used to shrink small-sample rates. */
  shrinkageStrength: number;
  /** Losing-digit threat score at which a candidate is penalised hard. */
  threatThreshold: number;
  /** Losing-digit threat score at which a candidate is rejected outright. */
  threatVeto: number;
  /** Penalty applied when a critical digit structure points at a losing digit. */
  criticalPenalty: number;
  /** Weight of pressure asymmetry inside the composite edge. */
  pressureWeight: number;
  /** Weight of the validated model ensemble inside the composite edge. */
  modelWeight: number;
  /** p-value below which a statistical test counts as significant. */
  significanceAlpha: number;
  /** Walk-forward: ticks used for training in each fold. */
  wfTrain: number;
  /** Walk-forward: ticks used for out-of-sample testing in each fold. */
  wfTest: number;
  /** Walk-forward: how far each fold advances. */
  wfStep: number;
  /** Forward projection horizon in ticks. */
  forecastHorizon: number;
  /** Opportunity score required to call something a real opportunity. */
  opportunityThreshold: number;
  /** Danger score above which a candidate is rejected. */
  dangerThreshold: number;
  /** Score bonus for Under 7 (operator preference window, not an override). */
  under7Preference: number;
  /** Score bonus for Over 2. */
  over2Preference: number;
  /** Minimum seconds between AI analyst chains (cost control). */
  aiMinIntervalSec: number;
  /** Materiality: contract score change that justifies a fresh AI call. */
  aiMaterialDelta: number;
  /** Backtest replay length in ticks. */
  backtestTicks: number;
}

export const DEFAULT_REFINEMENT: ApexRefinementSettings = {
  minSample: 300,
  shrinkageStrength: 120,
  threatThreshold: 55,
  threatVeto: 82,
  criticalPenalty: 18,
  pressureWeight: 16,
  modelWeight: 14,
  significanceAlpha: 0.05,
  wfTrain: 600,
  wfTest: 200,
  wfStep: 200,
  forecastHorizon: 25,
  opportunityThreshold: 70,
  dangerThreshold: 65,
  under7Preference: 3,
  over2Preference: 3,
  aiMinIntervalSec: 25,
  aiMaterialDelta: 6,
  backtestTicks: 4000,
};

const KEY = "apex.refinement.v1";

let cache: ApexRefinementSettings | null = null;

export function loadRefinement(): ApexRefinementSettings {
  if (cache) return cache;
  if (typeof window === "undefined") return DEFAULT_REFINEMENT;
  try {
    const raw = window.localStorage.getItem(KEY);
    cache = raw
      ? { ...DEFAULT_REFINEMENT, ...(JSON.parse(raw) as Partial<ApexRefinementSettings>) }
      : DEFAULT_REFINEMENT;
  } catch {
    cache = DEFAULT_REFINEMENT;
  }
  return cache;
}

const listeners = new Set<(s: ApexRefinementSettings) => void>();

export function saveRefinement(s: ApexRefinementSettings) {
  cache = s;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* quota — settings stay in memory for this session */
    }
  }
  listeners.forEach((l) => l(s));
}

export function subscribeRefinement(fn: (s: ApexRefinementSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
