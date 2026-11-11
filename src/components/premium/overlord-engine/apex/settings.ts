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

/** The Overlord engine is pure: it always runs on the documented defaults, never on browser storage. */
export function loadRefinement(): ApexRefinementSettings {
    return DEFAULT_REFINEMENT;
}
