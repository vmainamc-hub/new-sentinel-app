/**
 * OBSERVATION LAYER — UNIFIED COMPOSITE SCORING (§7)
 * ===================================================
 * Computes a transparent, single-source composite score (0..100 clamped)
 * directly inside the Observation Layer from all evaluated evidence:
 * psychology, danger, pressure, losing-side pressure, simulation, regime,
 * momentum, triggers, vetoes, SPRT, calibration, and combination learning.
 */

import type { EngineEvidenceInput } from "./engineAdapter";
import type { ObservationDossier } from "./types";
import { checkHardVeto, assessQuality } from "./selectivity";
import { interpretMomentum } from "./momentumLayer";

export interface ScoreAttribution {
  label: string;
  points: number;
  detail: string;
}

export interface ScoreResult {
  score: number;
  isRipe: boolean;
  factors: ScoreAttribution[];
}

/**
 * Checks whether an observation dossier clears all execution qualification gates.
 */
export function isQualificationCleared(dossier: {
  state: string;
  veto: { hard?: boolean; active?: boolean };
  danger?: { isHardBlocked?: boolean };
  statistics?: {
    sequentialTest?: { verdict?: string } | null;
    combination?: { state?: string } | null;
    calibration?: { reliabilityState?: string } | null;
  };
  feedbackLearning?: { cautionActive?: boolean; recentLosses?: number } | null;
  proposition: any;
  momentum: any;
}): boolean {
  if (dossier.state !== "RIPE") return false;
  if (dossier.veto?.hard || dossier.danger?.isHardBlocked) return false;

  const hardVeto = checkHardVeto(dossier as any);
  if (hardVeto.vetoed) return false;

  if (dossier.statistics?.sequentialTest?.verdict === "DISPROVEN") {
    return false;
  }

  const comboState = dossier.statistics?.combination?.state;
  if (comboState === "UNTESTED" || comboState === "FAILING" || comboState === "DETERIORATING") {
    return false;
  }

  if (
    dossier.feedbackLearning?.cautionActive &&
    (dossier.feedbackLearning.recentLosses ?? 0) >= 2
  ) {
    return false;
  }

  const momentumRelation = interpretMomentum(dossier.proposition, dossier.momentum);
  const quality = assessQuality(dossier as any, momentumRelation);
  (dossier as any).qualityAssessment = quality;
  (dossier as any).qualityBand = quality.band;
  if (quality.band === "WEAK") return false;

  if (
    quality.band === "MODERATE" &&
    dossier.statistics?.calibration?.reliabilityState === "INSUFFICIENT CALIBRATION DATA"
  ) {
    return false;
  }

  if (dossier.feedbackLearning?.cautionActive && quality.band === "MODERATE") {
    return false;
  }

  return true;
}

/**
 * Computes the unified composite score (0..100) for an ObservationDossier.
 */
export function computeDossierScore(
  dossier: Partial<ObservationDossier> & {
    marketId: string;
    proposition: string;
    state: string;
  },
  input: EngineEvidenceInput,
): ScoreResult {
  const factors: ScoreAttribution[] = [];
  const isRipe = isQualificationCleared(dossier as any);

  // 1. Statistical Opportunity baseline
  const opportunity = input.contractContext?.opportunity ?? 50;
  factors.push({
    label: "Statistical opportunity",
    points: opportunity,
    detail: `Raw statistical edge and historical frequency baseline (${opportunity.toFixed(0)}/100)`,
  });
  let total = opportunity;

  // 2. Primary Sentinel Contract Preference (Under 7 / Over 2)
  const isPrimary =
    dossier.proposition === "UNDER7" ||
    dossier.proposition === "OVER2" ||
    input.contractContext?.id === "UNDER7" ||
    input.contractContext?.id === "OVER2";
  if (isPrimary) {
    const prefPoints = 4.0;
    factors.push({
      label: "Primary contract preference",
      points: prefPoints,
      detail: "Operator primary preference (+4.0)",
    });
    total += prefPoints;
  }

  // 3. Analogue memory
  const analogue = input.contractContext?.analogue;
  const theoretical =
    input.contractContext?.theoretical ?? (dossier.proposition?.startsWith("OVER") ? 0.8 : 0.7);
  if (analogue && analogue.n >= 30) {
    const analoguePoints = Math.max(-6, Math.min(6, (analogue.rate - theoretical) * 60));
    factors.push({
      label: "Historical analogue memory",
      points: analoguePoints,
      detail: `Analogue win rate ${(analogue.rate * 100).toFixed(1)}% over N=${analogue.n}`,
    });
    total += analoguePoints;
  }

  // 4. Model ensemble
  const ensemble = input.contractContext?.ensemble;
  if (ensemble && ensemble.validated > 0) {
    const ensemblePoints = Math.max(-5, Math.min(5, ensemble.signal * 5));
    factors.push({
      label: "Ensemble model signal",
      points: ensemblePoints,
      detail: `Ensemble signal ${ensemble.signal.toFixed(2)} (${ensemble.validated} models)`,
    });
    total += ensemblePoints;
  }

  // 5. Simulator lifetime delta
  const simDelta =
    input.simulation?.raw?.sim?.delta ??
    (input.simulation?.state === "FAVOURABLE"
      ? 4
      : input.simulation?.state === "LOSING"
        ? -6
        : input.simulation?.state === "RECOVERING"
          ? 2
          : 0);
  if (simDelta !== 0) {
    factors.push({
      label: "Simulator performance delta",
      points: simDelta,
      detail: `Simulator state ${input.simulation.state} (${simDelta >= 0 ? "+" : ""}${simDelta.toFixed(1)} pts)`,
    });
    total += simDelta;
  }

  // 6. Entry Condition Lab
  const entryLabRec = input.trigger?.raw?.entryLabRec ?? input.contractContext?.entry;
  const entryDelta =
    entryLabRec?.rankingDelta ??
    (input.trigger?.state === "FIRED" ? 4 : input.trigger?.state === "VALID" ? 2 : 0);
  if (entryDelta !== 0) {
    factors.push({
      label: "Entry condition lab",
      points: entryDelta,
      detail: `Entry condition trigger ${input.trigger.state} (${entryDelta >= 0 ? "+" : ""}${entryDelta.toFixed(1)} pts)`,
    });
    total += entryDelta;
  }

  // 7. Engine agreement
  const agreementBonus = input.agreementBonus ?? 0;
  if (agreementBonus !== 0) {
    factors.push({
      label: "Engine agreement",
      points: agreementBonus,
      detail:
        agreementBonus > 0
          ? `Multi-engine consensus agreement (+${agreementBonus.toFixed(1)} pts)`
          : `Multi-engine consensus conflict (${agreementBonus.toFixed(1)} pts)`,
    });
    total += agreementBonus;
  }

  // 8. Recent rolling window drift
  const recentPerf = input.simulation?.raw?.recentPerf;
  if (recentPerf && recentPerf.n >= 10) {
    const recentDelta = Math.max(-8, Math.min(6, (recentPerf.winRate - theoretical) * 60));
    factors.push({
      label: "Recent rolling window drift",
      points: recentDelta,
      detail: `Recent win rate ${(recentPerf.winRate * 100).toFixed(1)}% over N=${recentPerf.n}`,
    });
    total += recentDelta;
  }

  // 9. Danger Clearance Penalty
  const clearancePenalty = input.clearance?.penalty ?? 0;
  if (clearancePenalty !== 0) {
    factors.push({
      label: "Danger clearance penalty",
      points: clearancePenalty,
      detail: `Clearance penalty ${clearancePenalty.toFixed(1)} pts`,
    });
    total += clearancePenalty;
  }

  // 10. Danger Hard Block / Environment
  const isHardBlocked = Boolean(
    input.danger?.isHardBlocked || input.veto?.hard || (input.veto?.active && input.veto?.hard),
  );
  if (isHardBlocked) {
    factors.push({
      label: "Danger hard block penalty",
      points: -45,
      detail: input.danger?.summary || input.veto?.reason || "Disqualifying danger condition",
    });
    total -= 45;
  } else {
    const dangerTotal = input.danger?.total ?? 0;
    const dangerPoints =
      dangerTotal <= 22
        ? 4.0
        : dangerTotal <= 32
          ? 2.0
          : dangerTotal <= 45
            ? 0
            : dangerTotal <= 60
              ? -4.0
              : -8.0;
    if (dangerPoints !== 0) {
      factors.push({
        label: "Danger environment",
        points: dangerPoints,
        detail: `Composite danger ${dangerTotal.toFixed(0)}/100 (${input.danger?.level ?? "CALM"})`,
      });
      total += dangerPoints;
    }
  }

  // 11. Evidence confidence
  const sampleSize = input.statistics?.sampleSize ?? 0;
  const confPoints = sampleSize >= 800 ? 4 : sampleSize >= 400 ? 2 : sampleSize >= 200 ? 0 : -4;
  if (confPoints !== 0) {
    factors.push({
      label: "Evidence sample maturity",
      points: confPoints,
      detail: `Sample size ${sampleSize} ticks (${input.statistics.strength})`,
    });
    total += confPoints;
  }

  // 12. Losing-digit exposure penalty
  const exposure = input.contractContext?.exposure;
  if (exposure && exposure.losingDigitExposure > 45) {
    const exposurePenalty = -Math.round((exposure.losingDigitExposure - 45) * 0.22 * 10) / 10;
    factors.push({
      label: "Losing-digit exposure",
      points: exposurePenalty,
      detail: `Losing digit exposure ${exposure.losingDigitExposure.toFixed(1)}%`,
    });
    total += exposurePenalty;
  }

  // 13. Special digit risk (0/1/8/9) penalty
  const specialRisk = input.contractContext?.specialRisk;
  if (specialRisk && specialRisk.exposureRisk > 50) {
    const specialPenalty = -Math.round((specialRisk.exposureRisk - 50) * 0.16 * 10) / 10;
    factors.push({
      label: "Special digit risk (0/1/8/9)",
      points: specialPenalty,
      detail: `Special digit risk ${specialRisk.exposureRisk.toFixed(1)}%`,
    });
    total += specialPenalty;
  }

  // 14. Fluctuation (calm-market preference)
  const fluct = input.marketContext?.fluctuation;
  if (fluct) {
    const fluctPenalty = -Math.round((fluct.score > 25 ? (fluct.score - 25) * 0.18 : -2) * 10) / 10;
    if (fluctPenalty !== 0) {
      factors.push({
        label: "Market fluctuation profile",
        points: fluctPenalty,
        detail: `Fluctuation index ${fluct.score.toFixed(0)} (${fluct.regime ?? "NORMAL"})`,
      });
      total += fluctPenalty;
    }
  }

  // 15. Market manipulation & distribution integrity
  const manipScore = input.manipulationScore;
  if (manipScore) {
    const manipPoints: number =
      manipScore.value <= 15
        ? 3.0
        : manipScore.value <= 25
          ? 1.0
          : manipScore.value <= 35
            ? -2.5
            : -6.0;
    if (manipPoints !== 0) {
      factors.push({
        label: "Market manipulation & distribution",
        points: manipPoints,
        detail: `Distribution deviation index ${manipScore.value.toFixed(1)}`,
      });
      total += manipPoints;
    }
  }

  // 16. Losing-side pressure hostility
  const lspState = input.losingSidePressure?.state;
  const lspSeverity = input.losingSidePressure?.severity;
  let lspPoints = 0;
  if (lspSeverity === "VETO" || lspState === "TAKEOVER") {
    lspPoints = -25;
  } else if (lspSeverity === "REJECT") {
    lspPoints = -15;
  } else if (lspState === "ACCELERATING" || lspState === "INCREASING") {
    lspPoints = -8;
  } else if (lspState === "DECLINING") {
    lspPoints = 3;
  }
  if (lspPoints !== 0) {
    factors.push({
      label: "Losing-side pressure",
      points: lspPoints,
      detail: `Losing-side state ${lspState}, severity ${lspSeverity}`,
    });
    total += lspPoints;
  }

  // 17. Winning-side momentum
  const wsm =
    input.winningSideMomentum ?? input.momentum?.winningSideMomentum ?? input.momentum?.raw?.wsm;
  if (wsm) {
    const wsmPoints =
      wsm.state === "SURGING"
        ? 4.5
        : wsm.state === "BUILDING"
          ? 2.5
          : (wsm.risingCount ?? 0) >= 4
            ? 1.5
            : 0;
    if (wsmPoints !== 0) {
      factors.push({
        label: "Winning-side momentum",
        points: wsmPoints,
        detail: `Momentum state ${wsm.state} (${wsm.risingCount} rising winning digits)`,
      });
      total += wsmPoints;
    }
  }

  // 18. Digit psychology structure & rules fulfillment
  const psychSupport = input.psychology?.support;
  const psychRaw = input.psychology?.raw?.digitPsychology;
  const psychPoints =
    psychRaw?.verdict === "SUPPORT"
      ? psychRaw.weightTotal > 0
        ? Math.round((psychRaw.gained / psychRaw.weightTotal) * 2.5 * 10) / 10
        : 2.0
      : psychRaw?.verdict === "OPPOSE"
        ? -3.0
        : psychSupport === "SUPPORTING"
          ? 2.0
          : psychSupport === "OPPOSING"
            ? -3.0
            : 0;
  if (psychPoints !== 0) {
    factors.push({
      label: "Digit psychology structure",
      points: psychPoints,
      detail: `1,000-tick psychology support ${psychSupport} (${input.psychology.state})`,
    });
    total += psychPoints;
  }

  // 19. Price Action Pressure (120-tick)
  const priceAction = input.priceAction ?? input.contractContext?.priceAction;
  if (priceAction?.rankingDelta) {
    factors.push({
      label: "Price action pressure (120 ticks)",
      points: priceAction.rankingDelta,
      detail: priceAction.summary || "Short-window velocity and decay analysis",
    });
    total += priceAction.rankingDelta;
  }

  // 20. Stage 2 Setup Quality
  const setup = input.setupQuality;
  if (setup && setup.score !== undefined) {
    const setupPoints = Math.round(((setup.score - 55) / 45) * 8 * 10) / 10;
    if (setupPoints !== 0) {
      factors.push({
        label: "Stage 2 setup quality",
        points: setupPoints,
        detail: setup.summary || `Setup readiness score ${setup.score.toFixed(0)}/100`,
      });
      total += setupPoints;
    }
  }

  // 21. Stage 3 Entry Clearance
  const entryClearance = input.entryClearance;
  if (entryClearance) {
    const ecPoints =
      entryClearance.verdict === "CLEARED" ? 4 : entryClearance.verdict === "BLOCKED" ? -20 : -3;
    factors.push({
      label: "Stage 3 entry clearance",
      points: ecPoints,
      detail: entryClearance.summary || `Clearance verdict: ${entryClearance.verdict}`,
    });
    total += ecPoints;
  }

  // 22. Dynamic entry point
  const entryPoint = input.entryDigit?.raw;
  const epPoints = entryPoint?.rankingDelta ?? (input.entryDigit?.state === "VALIDATED" ? 3.0 : 0);
  if (epPoints !== 0) {
    factors.push({
      label: "Dynamic entry point",
      points: epPoints,
      detail:
        entryPoint?.summary ||
        `Digit ${input.entryDigit.digit ?? "N/A"} validated with supporting execution profile`,
    });
    total += epPoints;
  }

  // 23. Operator Special Digit Action
  const opSpecial = input.operatorSpecial;
  if (opSpecial?.rankingDelta) {
    factors.push({
      label: "Operator special-digit action",
      points: opSpecial.rankingDelta,
      detail: opSpecial.summary || "Targeted digit bias override",
    });
    total += opSpecial.rankingDelta;
  }

  // 24. Market-Specific Learning Prior
  const marketLearning = input.marketLearning;
  if (marketLearning && marketLearning.points !== 0) {
    factors.push({
      label: "Market-specific learning",
      points: marketLearning.points,
      detail: marketLearning.detail || "Empirical edge adjustment for this symbol",
    });
    total += marketLearning.points;
  }

  // 25. Combination learning
  const combo = input.statistics?.combination;
  if (combo && combo.rankingDelta !== 0) {
    factors.push({
      label: "Combination learning",
      points: combo.rankingDelta,
      detail: `Market × Contract × Regime combination ${combo.state} (${combo.n} trades)`,
    });
    total += combo.rankingDelta;
  }

  // 26. SPRT (Sequential Probability Ratio Test)
  const sprt = input.statistics?.sequentialTest;
  if (sprt) {
    const sprtPoints = sprt.verdict === "PROVEN" ? 4.0 : sprt.verdict === "DISPROVEN" ? -15.0 : 0;
    if (sprtPoints !== 0) {
      factors.push({
        label: "Sequential probability ratio test",
        points: sprtPoints,
        detail: `SPRT verdict ${sprt.verdict} (LLR ${sprt.llr.toFixed(2)}, N=${sprt.n})`,
      });
      total += sprtPoints;
    }
  }

  // 27. Empirical calibration
  const cal = input.statistics?.calibration;
  if (cal) {
    let calPoints = 0;
    if (cal.reliabilityState === "CALIBRATED") {
      calPoints =
        cal.calibratedProbability >= (cal.theoreticalBaseline ?? 0.5) ? 3.0 : -6.0;
    }
    if (calPoints !== 0) {
      factors.push({
        label: "Empirical calibration",
        points: calPoints,
        detail: `Calibrated win prob ${(cal.calibratedProbability * 100).toFixed(1)}% vs baseline ${((cal.theoreticalBaseline ?? 0.5) * 100).toFixed(1)}%`,
      });
      total += calPoints;
    }
  }

  // 28. Execution Survival (Level 2 post-entry)
  const survInf = input.survivalInfluence;
  if (survInf && survInf.points !== 0) {
    factors.push({
      label: "Execution survival (Level 2)",
      points: survInf.points,
      detail: survInf.detail || "Post-entry path survival assessment",
    });
    total += survInf.points;
  }

  // 29. Entry Trigger Intelligence (Level 2.5)
  const entryTrigger = input.entryTrigger;
  if (entryTrigger?.rankingDelta) {
    factors.push({
      label: "Entry trigger intelligence",
      points: entryTrigger.rankingDelta,
      detail: entryTrigger.summary || "Trigger latency and momentum timing",
    });
    total += entryTrigger.rankingDelta;
  }

  // 30. Model Convergence
  const convergence = input.convergence;
  if (convergence?.rankingDelta) {
    factors.push({
      label: "Model convergence",
      points: convergence.rankingDelta,
      detail: convergence.summary || "Multi-model alignment across dimensions",
    });
    total += convergence.rankingDelta;
  }

  // 31. Evidence Fusion (correlation-discounted)
  const evidenceFusion = input.evidenceFusion;
  if (evidenceFusion?.rankingDelta) {
    factors.push({
      label: "Evidence fusion",
      points: evidenceFusion.rankingDelta,
      detail: evidenceFusion.rawAgreementVsEffective || "Non-redundant orthogonal evidence fusion",
    });
    total += evidenceFusion.rankingDelta;
  }

  // 32. Variable-order Markov context
  const contextMarkov = input.contextMarkov;
  if (contextMarkov) {
    const contextPoints =
      contextMarkov.evaluations?.find((e: any) => e.digit === input.entryDigit?.digit)
        ?.rankingDelta ?? (contextMarkov.preferredDigit !== null ? 1 : 0);
    if (contextPoints !== 0) {
      factors.push({
        label: "Markov sequence context",
        points: contextPoints,
        detail: contextMarkov.summary || "Digit sequence probability modeling",
      });
      total += contextPoints;
    }
  }

  // 33. Decision Spine & Governance
  const spine = input.governedSpine;
  if (spine?.veto?.blocked) {
    factors.push({
      label: "Decision spine veto",
      points: -30,
      detail: spine.lines?.join(" ") || "Spine hard veto active",
    });
    total -= 30;
  } else if (spine?.validation?.verdict === "CONFIRM") {
    factors.push({
      label: "Decision spine validation",
      points: 6,
      detail: "Confirmed alignment through structure, pressure, and risk spine",
    });
    total += 6;
  }

  // 34. Global Risk Governance
  const governance = input.governance;
  if (governance?.vetoed) {
    factors.push({
      label: "Trader global risk veto",
      points: -100,
      detail: governance.reasons?.join(" ") || "Global account risk threshold exceeded",
    });
    total -= 100;
  } else if (governance?.suggestedPenalty) {
    factors.push({
      label: "Global pattern risk",
      points: -governance.suggestedPenalty,
      detail: governance.reasons?.join(" ") || "Pattern-level risk dampener",
    });
    total -= governance.suggestedPenalty;
  }

  // 35. Validated Operator Learning & Guidance
  const opLearning = input.operatorLearning;
  const opPoints =
    typeof opLearning?.rankingAdjustment === "function"
      ? opLearning.rankingAdjustment(input.marketId, input.proposition)
      : (opLearning?.rankingAdjustment ?? 0);
  if (opPoints !== 0) {
    factors.push({
      label: "Operator learning adjustments",
      points: opPoints,
      detail: `Operator historical tuning factor (${opPoints > 0 ? "+" : ""}${opPoints.toFixed(1)})`,
    });
    total += opPoints;
  }

  const guidance = input.guidance;
  const gEffect =
    typeof guidance?.forCandidate === "function"
      ? guidance.forCandidate(input.marketId, input.proposition)
      : (guidance?.forCandidate ?? { active: false, points: 0, detail: "" });
  if (gEffect.active && gEffect.points !== 0) {
    factors.push({
      label: "Operator guidance directive",
      points: gEffect.points,
      detail: gEffect.detail || "Immediate operator execution directive",
    });
    total += gEffect.points;
  }

  // 36. Regime compatibility
  const regComp = input.regime?.compatibility;
  let regPoints = 0;
  if (regComp === "COMPATIBLE") {
    regPoints = 2.0;
  } else if (regComp === "INCOMPATIBLE" || input.regime?.transitioning) {
    regPoints = -4.0;
  }
  if (regPoints !== 0) {
    factors.push({
      label: "Regime compatibility",
      points: regPoints,
      detail: `Regime ${input.regime.classification} (${regComp})`,
    });
    total += regPoints;
  }

  // 37. Feedback Caution
  if (dossier.feedbackLearning?.cautionActive) {
    factors.push({
      label: "Post-mortem operator caution",
      points: -6.0,
      detail: `Active concern: ${dossier.feedbackLearning.activeConcern || "recent losses"}`,
    });
    total -= 6.0;
  }

  // 38. Continuous Observation Stage Promotion
  const obsPoints = isRipe
    ? 15.0
    : dossier.state === "CONFIRMING"
      ? 5.0
      : dossier.state === "DEVELOPING"
        ? 2.0
        : dossier.state === "INTERESTING"
          ? 0.0
          : -10.0;
  factors.push({
    label: "Continuous observation stage",
    points: obsPoints,
    detail: `State machine at ${dossier.state}${isRipe ? " (Execution-Qualified)" : ""}`,
  });
  total += obsPoints;

  // Clamped to 0..100 with 1 decimal precision
  const finalScore = Math.round(Math.max(0, Math.min(100, total)) * 10) / 10;

  return {
    score: finalScore,
    isRipe,
    factors,
  };
}
