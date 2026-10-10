import type { ObservationDossier, MomentumRelation } from "./types";

export interface HardVetoResult {
  vetoed: boolean;
  reason?: string;
}

/**
 * §9 — Hard Veto Audit:
 * Hard vetoes are reserved for genuinely disqualifying conditions ONLY.
 * Evidence -> Severity -> Persistence/Confirmation -> Governance.
 *
 * Condition breakdown:
 * 1. Explicit canonical hard veto (d.veto.active && d.veto.hard): Contract/Market hard VETO.
 * 2. Danger composition auto-block (d.danger.isHardBlocked || d.danger.total >= 85): Hard VETO.
 * 3. Structural psychology collapse (d.psychology.state === "INVALIDATING"): Market hard VETO.
 * 4. Confirmed hostile losing takeover (d.losingSidePressure.severity === "VETO"): Contract hard VETO.
 * 5. Confirmed directional reversal against setup (d.psychology.state === "REVERSING" && d.psychology.support === "OPPOSING"): Contract hard VETO.
 * 6. Material contradiction after sustained conflict (d.contradictions >= 3 && d.state === "CONFLICT"): Observation hard VETO.
 *
 * Soft conditions (regime transitions, non-fired triggers in early stages, danger < 85, soft losing pressure)
 * feed quality assessment, stability, or suppression instead of terminal first-tick rejection.
 */
export function checkHardVeto(d: ObservationDossier): HardVetoResult {
  if (d.veto.active && d.veto.hard) {
    return { vetoed: true, reason: d.veto.reason ?? "Active hard veto." };
  }
  if (
    d.danger &&
    (d.danger.isHardBlocked || d.danger.level === "CRITICAL" || d.danger.total >= 85)
  ) {
    const autoBlock = d.danger.components.find((c) => c.isAutoBlock);
    return {
      vetoed: true,
      reason:
        autoBlock?.detail || `Danger level critical (${d.danger.total}/100): ${d.danger.summary}`,
    };
  }
  if (d.psychology.state === "INVALIDATING") {
    return { vetoed: true, reason: "Structural psychology has invalidated." };
  }
  if (d.losingSidePressure.severity === "VETO" || d.losingSidePressure.severity === "REJECT") {
    return { vetoed: true, reason: "Losing-side pressure has reached a confirmed takeover level." };
  }
  if (d.psychology.state === "REVERSING" && d.psychology.support === "OPPOSING") {
    return { vetoed: true, reason: "Confirmed directional reversal opposing contract side." };
  }
  if (d.contradictions >= 3 && d.state === "CONFLICT") {
    return {
      vetoed: true,
      reason: "Material contradiction across evidence streams in conflict state.",
    };
  }
  return { vetoed: false };
}

export type QualityBand = "EXCEPTIONAL" | "STRONG" | "MODERATE" | "WEAK";

export interface QualityAssessment {
  band: QualityBand;
  supportingCount: number;
  opposingCount: number;
  momentumRelation: MomentumRelation;
  regimeContribution: "POSITIVE" | "NEUTRAL" | "REQUIRES_MORE_ELSEWHERE";
  statisticsContribution: "POSITIVE" | "NEUTRAL" | "NONE";
  dangerContribution: "POSITIVE" | "NEUTRAL" | "HIGH_DANGER";
  notes: string[];
}

/**
 * §9 — combines momentum, regime, statistics, danger, entry digit, trigger,
 * pressure, and persistence into one balanced quality read WITHOUT
 * requiring every dimension to be simultaneously perfect, and WITHOUT
 * collapsing into a single fabricated numeric score (§18: prefer readable
 * states over invented numbers). Used for ranking and for the
 * self-check in §9's calibration target.
 */
export function assessQuality(
  d: ObservationDossier,
  momentumRelation: MomentumRelation,
): QualityAssessment {
  const notes: string[] = [];

  const regimeContribution =
    d.regime.compatibility === "COMPATIBLE"
      ? "POSITIVE"
      : d.regime.compatibility === "NEUTRAL_UNCERTAIN"
        ? "REQUIRES_MORE_ELSEWHERE"
        : "REQUIRES_MORE_ELSEWHERE";

  const statisticsContribution =
    d.statistics.strength === "STRONG" || d.statistics.strength === "MODERATE"
      ? "POSITIVE"
      : d.statistics.strength === "WEAK"
        ? "NEUTRAL"
        : "NONE";

  const dangerContribution =
    !d.danger || d.danger.level === "CALM" || d.danger.total <= 15
      ? "POSITIVE"
      : d.danger.level === "LOW" || d.danger.total <= 35
        ? "NEUTRAL"
        : "HIGH_DANGER";

  if (momentumRelation === "CONFLICTING")
    notes.push("Momentum is currently conflicting with setup direction.");
  if (regimeContribution === "REQUIRES_MORE_ELSEWHERE") {
    notes.push(
      `Regime is ${d.regime.compatibility === "NEUTRAL_UNCERTAIN" ? "uncertain" : "not clearly compatible"} — needs stronger confirmation elsewhere.`,
    );
  }
  if (statisticsContribution === "NONE") notes.push("Statistical evidence is insufficient.");
  if (dangerContribution === "HIGH_DANGER") {
    notes.push(
      `Danger elevated (${d.danger?.total ?? 50}/100): ${d.danger?.summary ?? "Multiple risk components active."}`,
    );
  }

  const supportingCount = d.supportingEvidence?.length ?? 0;
  const opposingCount = d.opposingEvidence?.length ?? 0;

  // Graduated multi-engine evaluation: every engine contributes strength or weakness
  let strengthScore = 0;
  let weaknessScore = 0;

  // 1. Psychology Engine
  if (d.psychology.support === "SUPPORTING") strengthScore += 1;
  else if (d.psychology.support === "OPPOSING") weaknessScore += 1;

  // 2. Entry Digit Engine
  if (d.entryDigit.state === "VALIDATED") {
    strengthScore += 1;
    if (d.entryDigit.dangerousCompetitor) weaknessScore += 1;
  }

  // 3. Pressure Windows Engine
  const supportingWindows = Object.values(d.pressure.byWindow).filter(
    (v) => v === "SUPPORTING",
  ).length;
  const opposingWindows = Object.values(d.pressure.byWindow).filter((v) => v === "OPPOSING").length;
  if (supportingWindows >= 3) strengthScore += 1;
  if (opposingWindows >= 2) weaknessScore += 1;

  // 4. Losing Side Pressure Engine
  if (d.losingSidePressure.state === "DECLINING" || d.losingSidePressure.state === "STABLE")
    strengthScore += 1;
  else if (
    d.losingSidePressure.state === "INCREASING" ||
    d.losingSidePressure.state === "ACCELERATING"
  ) {
    weaknessScore += 1;
  }

  // 5. Danger Analysis Engine
  if (dangerContribution === "POSITIVE") strengthScore += 1;
  else if (dangerContribution === "HIGH_DANGER") weaknessScore += 1;

  // 6. Momentum Engine
  if (momentumRelation === "SUPPORTIVE") strengthScore += 1;
  else if (momentumRelation === "CONFLICTING") weaknessScore += 1;

  // 7. Regime Engine
  if (regimeContribution === "POSITIVE") strengthScore += 1;
  else if (d.regime.compatibility === "INCOMPATIBLE") weaknessScore += 1;

  // 8. Simulation Engine
  if (d.simulation.state === "FAVOURABLE" || d.simulation.state === "RECOVERING")
    strengthScore += 1;
  else if (d.simulation.state === "LOSING" || d.simulation.state === "UNFAVOURABLE")
    weaknessScore += 1;

  // 9. Statistics Engine
  if (statisticsContribution === "POSITIVE") strengthScore += 1;

  // 10. Trigger Engine
  if (d.trigger.state === "VALID" || d.trigger.state === "FIRED") strengthScore += 1;

  // 11. Stability & Noise Level
  if (d.stability === "STABLE" || d.stability === "CALM") strengthScore += 1;
  else if (
    d.stability === "FLUCTUATING" ||
    d.stability === "CHOPPY" ||
    d.stability === "HIGHLY_UNSTABLE"
  ) {
    weaknessScore += 1;
  }

  // 12. Winning-Side Momentum Engine (reward-only confluence input)
  const wsm = d.momentum?.winningSideMomentum;
  if (wsm && (wsm.state === "SURGING" || wsm.state === "BUILDING")) {
    strengthScore += 1;
  }

  let band: QualityBand;
  if (strengthScore >= 8 && weaknessScore === 0) band = "EXCEPTIONAL";
  else if (strengthScore >= 6 && weaknessScore <= 1) band = "STRONG";
  else if (strengthScore >= 4 && weaknessScore <= 2) band = "MODERATE";
  else band = "WEAK";

  return {
    band,
    supportingCount,
    opposingCount,
    momentumRelation,
    regimeContribution,
    statisticsContribution,
    dangerContribution,
    notes,
  };
}

/**
 * §9 self-check: run against a batch of dossiers from representative normal
 * market data (not edge cases) to confirm the implementation is neither a
 * lockout (zero opportunities) nor a firehose (nearly everything qualifies).
 */
export function selectivityCalibrationCheck(
  totalCandidates: number,
  totalOpportunities: number,
): {
  status: "TOO_STRICT" | "TOO_LOOSE" | "BALANCED";
  ratio: number;
} {
  if (totalCandidates === 0) return { status: "BALANCED", ratio: 0 };
  const ratio = totalOpportunities / totalCandidates;
  if (totalOpportunities === 0) return { status: "TOO_STRICT", ratio };
  if (ratio > 0.9) return { status: "TOO_LOOSE", ratio };
  return { status: "BALANCED", ratio };
}
