/**
 * SENTINEL — NEAR-SIGNAL DIAGNOSTIC ENGINE.
 *
 * Distinguishes ordinary weak/rejected candidates from high-conviction
 * candidates that possess strong, coherent evidence across the Sentinel stack
 * but are missing only a narrow, execution-specific condition (e.g. entry trigger touch,
 * validity window timing).
 *
 * CRITICAL CONTRACT:
 * - NEAR-SIGNAL is strictly diagnostic.
 * - isExecutable is ALWAYS false.
 * - It NEVER bypasses Operator Surface Gate, executionReady, Stage 4, or Veto.
 * - It NEVER promotes a weak setup.
 */

import type { RankedOpportunity } from "../apex/types";
import type { SetupFactor } from "@/types/sentinel";
import { OPERATOR_SURFACE_THRESHOLDS } from "../apex/operator-surface-thresholds";

export interface NearSignalAssessment {
  isNearSignal: boolean;
  verdict: "NEAR_SIGNAL" | "NOT_NEAR_SIGNAL" | "EXECUTABLE";
  isExecutable: false;
  strengths: string[];
  missingConditions: string[];
  factors: SetupFactor[];
  summary: string;
}

export class NearSignalEngine {
  /**
   * Evaluates whether a RankedOpportunity qualifies as a diagnostic NEAR-SIGNAL.
   *
   * Derived purely from authoritative Sentinel evidence and blockers:
   * - Never creates an independent/arbitrary scoring system.
   * - isExecutable is ALWAYS false.
   * - Explicitly details the exact remaining execution gap from Sentinel's real pipeline.
   */
  public static evaluate(candidate: RankedOpportunity): NearSignalAssessment {
    const strengths: string[] = [];
    const missingConditions: string[] = [];
    const factors: SetupFactor[] = [];

    // Check if the candidate is already fully executable and Stage 4 cleared
    const isStage4Cleared = candidate.finalDecision?.verdict === "CLEARED";
    const isExecutionReady = Boolean(candidate.executionReady);
    const danger = candidate.dangerComposition?.total ?? candidate.contract.danger ?? 0;
    const isGateQualified = Boolean(
      (candidate.clearance?.state === "CLEAR" || candidate.entryClearance?.verdict === "CLEARED") &&
      !candidate.blocked &&
      candidate.score >= OPERATOR_SURFACE_THRESHOLDS.minScore &&
      danger <= OPERATOR_SURFACE_THRESHOLDS.maxDanger
    );

    if (isStage4Cleared && isExecutionReady && isGateQualified) {
      return {
        isNearSignal: false,
        verdict: "EXECUTABLE",
        isExecutable: false, // Diagnostic engine never issues execution authority
        strengths: ["All mandatory execution conditions and Stage 4 risk gates satisfied."],
        missingConditions: [],
        factors: [],
        summary: "Candidate is fully executable under current live conditions.",
      };
    }

    // 1. EVALUATE HARD DISQUALIFIERS (Any hard blocker immediately rules out NEAR-SIGNAL)
    const isHardDanger = danger > OPERATOR_SURFACE_THRESHOLDS.maxDanger || candidate.dangerComposition?.isHardBlocked === true;
    const isVetoed = Boolean(
      candidate.blocked ||
      candidate.clearance?.state === "BLOCKED" ||
      candidate.vetoResolution?.isBlocked ||
      candidate.governance?.vetoed === true ||
      candidate.priceAction?.veto
    );
    const sampleSize = candidate.contract.n || candidate.intel?.ticks || 0;
    const isThinSample = sampleSize < OPERATOR_SURFACE_THRESHOLDS.minTicks;
    const hasMajorContradictions = (candidate.contract.contradiction ?? 0) > OPERATOR_SURFACE_THRESHOLDS.maxContradiction || (candidate.contract.conflicts?.length ?? 0) > 2;
    const isBrokenDirection = candidate.direction?.label === "AGAINST";
    const isHostileRegime = candidate.contract.regimeCompatible === false || candidate.contract.fakeEdge?.verdict === "REJECTED";
    const isCircuitBreakerTripped = candidate.finalDecision?.circuitBreaker?.tripped === true;

    if (isHardDanger) {
      missingConditions.push(`Danger ${danger}/100 exceeds maximum safety ceiling (${OPERATOR_SURFACE_THRESHOLDS.maxDanger})`);
    }
    if (isVetoed) {
      missingConditions.push("Active hard veto in place");
    }
    if (isThinSample) {
      missingConditions.push(`Sample size (${sampleSize}) below minimum required observations (${OPERATOR_SURFACE_THRESHOLDS.minTicks})`);
    }
    if (hasMajorContradictions) {
      missingConditions.push(`High contradiction level (${candidate.contract.contradiction}%)`);
    }
    if (isBrokenDirection) {
      missingConditions.push("Structural directional spine is broken or opposed");
    }
    if (isHostileRegime) {
      missingConditions.push("Market regime or edge validation rejected");
    }
    if (isCircuitBreakerTripped) {
      missingConditions.push("Session circuit breaker is tripped");
    }

    // If any hard disqualifier exists, it is strictly NOT a Near-Signal
    if (
      isHardDanger ||
      isVetoed ||
      isThinSample ||
      hasMajorContradictions ||
      isBrokenDirection ||
      isHostileRegime ||
      isCircuitBreakerTripped
    ) {
      return {
        isNearSignal: false,
        verdict: "NOT_NEAR_SIGNAL",
        isExecutable: false,
        strengths: [],
        missingConditions,
        factors: [],
        summary: `Disqualified from Near-Signal: ${missingConditions[0]}`,
      };
    }

    // 2. EVALUATE POSITIVE EVIDENCE CONVICTION FROM AUTHORITATIVE ENGINES
    let hasDirectionConviction = false;
    let hasPsychologyConviction = false;
    let hasPressureConviction = false;
    let hasAgreementConviction = false;
    let hasScoreBaseline = false;

    // A. Structural Direction Alignment
    const contractSide = candidate.contract.side;
    if (candidate.direction && candidate.direction.label !== "AGAINST" && candidate.direction.label !== "WEAK") {
      hasDirectionConviction = true;
      strengths.push(`Direction: ${contractSide} supported by 1,000-tick spine (${candidate.direction?.label ?? "CONFIRMED"})`);
      factors.push({
        code: "NS_DIRECTION",
        label: "Directional Spine Alignment",
        points: Math.round(candidate.direction?.score ?? 20),
        measuredValue: contractSide,
        detail: "1,000-tick structural trend aligned with contract side.",
      });
    }

    // B. Digit Psychology Alignment
    // Must rely on authoritative digit-psychology engine output.
    // Green-bar presence alone or arbitrary flags do NOT establish directional psychology support.
    const psych = candidate.digitPsychology;
    const isPsychSupportive = Boolean(
      psych &&
      !psych.hardBlock &&
      (psych.verdict === "SUPPORT" || (psych.score >= 65 && psych.verdict !== "CONFLICT"))
    );
    if (isPsychSupportive) {
      hasPsychologyConviction = true;
      strengths.push(`Digit Psychology: ${psych.verdict} (${psych.score}/100) on canonical 1,000-tick distribution`);
      factors.push({
        code: "NS_PSYCHOLOGY",
        label: "Digit Psychology",
        points: Math.max(15, Math.round((psych.score ?? 65) * 0.3)),
        measuredValue: `${psych.score}/100`,
        detail: psych.summary || "Canonical digit frequency and zone momentum favorable.",
      });
    }

    // C. Lower-Timeframe Pressure
    const confirmsStructure = candidate.priceAction?.alignment !== "CONTRADICTING" && candidate.priceAction?.alignment !== "TAKEOVER";
    const noPressureThreat = candidate.priceAction?.takeover?.state !== "CONFIRMED TAKEOVER";
    if (confirmsStructure && noPressureThreat) {
      hasPressureConviction = true;
      strengths.push("Pressure: Lower-timeframe (120-tick) pressure confirms structure");
      factors.push({
        code: "NS_PRESSURE",
        label: "Pressure Confirmation",
        points: 20,
        measuredValue: "CONFIRMED",
        detail: "120-tick pressure confirms 1,000-tick structure without losing side threat.",
      });
    }

    // D. Cross-Engine Agreement & Confidence
    const agreement = candidate.agreement ?? "SUPPORT";
    const confidence = candidate.evidence?.confidence ?? candidate.contract.confidence ?? 0;
    if (agreement !== "CONFLICT" && confidence >= 50) {
      hasAgreementConviction = true;
      strengths.push(`Engine Agreement: ${agreement} (Confidence: ${confidence.toFixed(0)}%)`);
      factors.push({
        code: "NS_AGREEMENT",
        label: "Engine Confluence",
        points: Math.round(confidence / 4),
        measuredValue: `${confidence.toFixed(0)}%`,
        detail: `Multi-engine consensus (${agreement}) and statistical confidence.`,
      });
    }

    // E. Opportunity Score Baseline
    if (candidate.score >= OPERATOR_SURFACE_THRESHOLDS.watchScoreFloor) {
      hasScoreBaseline = true;
      strengths.push(`Score: ${candidate.score.toFixed(0)}/100 meets opportunity watch floor`);
    }

    // 3. IDENTIFY SPECIFIC REMAINING EXECUTION GAPS (FROM REAL BLOCKERS)
    if (candidate.finalDecision?.verdict === "HELD_UNCONFIRMED_SIGNIFICANCE") {
      missingConditions.push("Stage 4 multiple-testing FDR significance unconfirmed across candidate population");
    }
    if (candidate.finalDecision?.verdict === "HELD_EXPOSURE_CAP") {
      missingConditions.push("Stage 4 portfolio exposure ceiling reached for correlation group");
    }
    if (candidate.entryPoint?.status === "NOT_READY") {
      missingConditions.push("Entry trigger touch not yet confirmed on preferred digit");
    }
    if (candidate.signal?.waitForEntry) {
      missingConditions.push("Awaiting valid entry timing window");
    }
    if (candidate.entryClearance?.verdict === "WAIT") {
      missingConditions.push("Stage 3 entry clearance awaiting primary trigger sequence");
    }
    if (!candidate.executionReady && candidate.executionReadyReasons?.length) {
      candidate.executionReadyReasons.forEach((r) => {
        if (!missingConditions.includes(r)) missingConditions.push(r);
      });
    }

    // A genuine NEAR-SIGNAL must have strong foundational evidence AND an identifiable remaining execution gap
    const hasStrongFoundationalEvidence =
      hasDirectionConviction &&
      hasPsychologyConviction &&
      hasPressureConviction &&
      hasAgreementConviction &&
      hasScoreBaseline;

    if (hasStrongFoundationalEvidence && missingConditions.length > 0) {
      return {
        isNearSignal: true,
        verdict: "NEAR_SIGNAL",
        isExecutable: false, // Diagnostic only - never executable
        strengths,
        missingConditions,
        factors,
        summary: `NEAR-SIGNAL: Strong foundational evidence across Sentinel engines; awaiting ${missingConditions[0]}.`,
      };
    }

    return {
      isNearSignal: false,
      verdict: "NOT_NEAR_SIGNAL",
      isExecutable: false,
      strengths,
      missingConditions: missingConditions.length > 0 ? missingConditions : ["Insufficient foundational evidence conviction across engines."],
      factors,
      summary: "Candidate lacks sufficient foundational multi-engine strength to qualify as Near-Signal.",
    };
  }
}
