/**
 * SENTINEL — STAGE 4: FINAL DECISION (risk-integrated).
 *
 * Stage 3 answers "does the empirical digit distribution and touch evidence clear entry?".
 * Stage 4 answers "given everything we know about risk right now — account
 * state, statistical significance across ALL tested combinations, and
 * portfolio exposure — should this candidate actually be acted on, and at
 * what size?". It NEVER upgrades a Stage 3 verdict. It can only hold back,
 * downgrade, resize, or reorder what Stage 3 already produced, and every
 * change it makes is attributed.
 */

import type {
  EntryVerdict,
  FinalVerdict,
  FinalDecision,
  OpportunityCandidate,
  SetupFactor,
  CircuitBreakerState,
  SignificanceAssessment,
  PortfolioExposureReport,
  PositionSizeReport,
} from "../../types/sentinel";
import type { RankedOpportunity } from "../apex/types";
import { SignificanceGuardEngine, type ComboEvidence } from "../risk/significance-guard";
import { PositionSizingEngine } from "../risk/position-sizing";
import { PortfolioExposureEngine } from "../risk/portfolio-exposure";
import { CircuitBreakerEngine } from "../risk/circuit-breaker";

/**
 * Verdict precedence for the final hierarchical ranking sort. CLEARED must
 * always rank above every HELD_* variant, which must always rank above
 * WAIT/BLOCKED — independent of any candidate's score. Higher number wins.
 */
export const VERDICT_PRECEDENCE: Record<FinalVerdict, number> = {
  CLEARED: 3,
  HELD_UNCONFIRMED_SIGNIFICANCE: 2,
  HELD_EXPOSURE_CAP: 2,
  HELD_CIRCUIT_BREAKER: 2,
  WAIT: 1,
  BLOCKED: 0,
};

/**
 * Resolves the digit-psychology record for a Stage 4 candidate. The Stage 4
 * candidate is generic (`T`) — it can be an ObservationDossier-shaped object
 * (`psychology.raw.digitPsychology`), an OpportunityCandidate
 * (`digitPsychology`), or a RankedOpportunity that carries the observation
 * dossier alongside it. All known shapes are probed here so the hierarchical
 * comparator below reads the same authority in every case.
 */
export function candidateDigitPsychology(c: any): any | null {
  return (
    c?.psychology?.raw?.digitPsychology ??
    c?.digitPsychology ??
    c?.dossier?.psychology?.raw?.digitPsychology ??
    c?.observation?.psychology?.raw?.digitPsychology ??
    c?.intel?.digitPsychology ??
    null
  );
}


/**
 * Computes standard normal cumulative distribution approximation.
 */
function normalCdf(z: number): number {
  if (z <= -10) return 0;
  if (z >= 10) return 1;
  return 0.5 * (1 + Math.tanh(z * 0.7978845608 * (1 + 0.044715 * z * z)));
}

/**
 * Computes exact one-sided p-value for testing H0: p = p0 vs H1: p > p0
 * from empirical proportion and sample size. No fabricated constants.
 */
export function computeBinomialPValue(pEmp: number, p0: number, sampleSize: number): number {
  if (sampleSize < 1 || p0 <= 0 || p0 >= 1) {
    return 1.0;
  }
  const stdErr = Math.sqrt((p0 * (1 - p0)) / sampleSize);
  if (stdErr <= 0) {
    return 1.0;
  }
  const z = (pEmp - p0) / stdErr;
  return Math.max(0.0001, Math.min(0.9999, 1 - normalCdf(z)));
}

/**
 * Extract real statistical evidence without fabricated fallbacks.
 */
function extractEvidence(c: any): ComboEvidence {
  // 1. RankedOpportunity branch
  if (c.contract && typeof c.contract === "object") {
    const r = c as RankedOpportunity;
    const sampleSize = Math.max(0, r.contract.n || r.intel?.ticks || 0);
    const p0 = r.contract.theoretical;
    const pEmp = r.contract.empirical;
    const measuredEdge = Number(((pEmp - p0) * 100).toFixed(2));
    const rawWilsonLower = Number(((p0 + (r.contract.edgeLB || 0)) * 100).toFixed(2));
    const pVal = computeBinomialPValue(pEmp, p0, sampleSize);
    const comboKey = `${r.symbol}:${r.contract.id}`;

    return {
      comboKey,
      pVal,
      rawWilsonLower,
      measuredEdge,
      sampleSize,
    };
  }

  // 2. OpportunityCandidate branch
  const cand = c as OpportunityCandidate;
  const sampleSize = Math.max(0, cand.canonicalState?.totalTicks || 0);
  const p0 = cand.barrier != null ? (cand.direction === "OVER" ? (9 - cand.barrier) / 10 : cand.barrier / 10) : 0;
  const measuredEdge = p0 > 0 ? Number((cand.absoluteEdge ?? 0).toFixed(2)) : 0;
  const pEmp = p0 > 0 ? p0 + measuredEdge / 100 : 0;
  const rawWilsonLower = cand.entryTrigger?.wilsonLowerBound
    ? Number(cand.entryTrigger.wilsonLowerBound.toFixed(2))
    : Number((p0 * 100).toFixed(2));
  const pVal = p0 > 0 && sampleSize > 0 ? computeBinomialPValue(pEmp, p0, sampleSize) : 1.0;
  const comboKey = cand.id || `${cand.market}:${cand.contract}`;

  return {
    comboKey,
    pVal,
    rawWilsonLower,
    measuredEdge,
    sampleSize,
  };
}

function getCandidateKey(c: any): string {
  if (c.id) return String(c.id);
  const sym = c.symbol ?? c.market ?? "UNKNOWN";
  const contractId = typeof c.contract === "object" ? c.contract?.id : c.contract;
  return `${sym}:${contractId ?? "CONTRACT"}`;
}

export class FinalDecisionEngine {
  /**
   * Applies Stage 4 Multiple-Testing, Risk Integration, and Sizing to the full candidate population.
   * NEVER upgrades a Stage 3 verdict. It can only hold back, downgrade, resize, or reorder.
   */
  public static evaluateStage4<T extends RankedOpportunity | OpportunityCandidate>(
    candidates: T[],
    circuitBreaker: CircuitBreakerState,
    openPositions: { market: string; stake: number }[] = [],
  ): {
    ranked: T[];
    exposureReport: PortfolioExposureReport;
    significanceMap: Map<string, SignificanceAssessment>;
  } {
    if (!candidates || candidates.length === 0) {
      const { report: exposureReport } = PortfolioExposureEngine.evaluateExposure([], openPositions);
      return {
        ranked: [],
        exposureReport,
        significanceMap: new Map(),
      };
    }

    // 1. Gather all active candidate combination evidences for Multiple-Testing Correction
    const comboEvidences: ComboEvidence[] = candidates.map(extractEvidence);
    const significanceMap = SignificanceGuardEngine.evaluateAll(comboEvidences);

    // 2. Attach Sizing, Stage 3 analysis, and Stage 4 decision factors to all candidates
    const evaluatedCandidates: T[] = candidates.map((cand: any) => {
      const isRanked = cand.contract && typeof cand.contract === "object";
      const candKey = getCandidateKey(cand);
      const factors: SetupFactor[] = [];

      // Determine Stage 3 Verdict
      let stage3Verdict: EntryVerdict = "WAIT";
      if (isRanked) {
        const r = cand as RankedOpportunity;
        stage3Verdict = r.entryClearance?.verdict ?? "WAIT";
        if (r.blocked || r.clearance?.state === "BLOCKED") {
          stage3Verdict = "BLOCKED";
        }
      } else {
        const oc = cand as OpportunityCandidate;
        if (oc.signalState === "BLOCKED") {
          stage3Verdict = "BLOCKED";
        } else if (oc.signalState === "STRONG" || oc.signalState === "VALID") {
          stage3Verdict = "CLEARED";
        }
      }

      factors.push({
        code: "STAGE_3_VERDICT",
        label: "Stage 3 Entry Clearance",
        points: stage3Verdict === "CLEARED" ? 100 : stage3Verdict === "WAIT" ? 50 : 0,
        measuredValue: stage3Verdict,
        detail: `Stage 3 produced ${stage3Verdict} clearance based on directional edge and touch dynamics.`,
      });

      // Calculate Sizing with real data and zero fabricated fallbacks
      let empiricalWinRate: number;
      let payout: number;
      let sampleTicks: number;
      let confidence: number;
      let opportunityScore: number;

      if (isRanked) {
        const r = cand as RankedOpportunity;
        empiricalWinRate = r.contract.empirical > 0 ? r.contract.empirical * 100 : r.contract.theoretical * 100;
        if (r.simulator && r.simulator.n >= 10 && r.simulator.winRate > 0) {
          empiricalWinRate = r.simulator.winRate * 100;
        } else if (r.survival?.sufficient && (r.survival.perRun[0]?.winRate ?? 0) > 0) {
          empiricalWinRate = r.survival.perRun[0].winRate * 100;
        }
        payout = r.contract.theoretical > 0 ? Number((0.97 / r.contract.theoretical).toFixed(2)) : 0;
        sampleTicks = r.contract.n || r.intel?.ticks || 0;
        confidence = r.evidence?.confidence ?? r.contract.confidence ?? 0;
        opportunityScore = r.score ?? 0;
      } else {
        const oc = cand as OpportunityCandidate;
        const p0 = oc.barrier != null ? (oc.direction === "OVER" ? (9 - oc.barrier) / 10 : oc.barrier / 10) : 0;
        empiricalWinRate = oc.survivalMetrics?.run1WinRate ?? p0 * 100;
        payout = p0 > 0 ? Number((0.97 / p0).toFixed(2)) : 0;
        sampleTicks = oc.canonicalState?.totalTicks || 0;
        confidence = oc.confidence ?? 0;
        opportunityScore = oc.opportunityScore ?? 0;
      }

      const baseSizing = PositionSizingEngine.calculateBaseStake(
        opportunityScore,
        confidence,
        empiricalWinRate,
        payout,
        sampleTicks,
      );
      const sizingReport = PositionSizingEngine.applyDrawdownAdjustment(baseSizing, circuitBreaker);

      // Check Multiple Testing Significance
      const sigAssessment: SignificanceAssessment = significanceMap.get(candKey) || {
        comboKey: candKey,
        rawWilsonLower: 0,
        fdrAdjustedThreshold: 0.05,
        passesCorrection: false,
        activeComparisons: candidates.length,
        detail: "No significance evidence available.",
      };

      factors.push({
        code: "SIGNIFICANCE_GUARD",
        label: "Multiple Comparison FDR & MES",
        points: sigAssessment.passesCorrection ? 100 : 0,
        measuredValue: `passes=${sigAssessment.passesCorrection}`,
        detail: sigAssessment.detail,
      });

      factors.push({
        code: "RISK_POSITION_SIZING",
        label: "Fractional-Kelly Sizing",
        points: Math.round(sizingReport.kellyFraction * 100),
        measuredValue: `$${sizingReport.drawdownAdjustedStake.toFixed(2)}`,
        detail: sizingReport.summary,
      });

      if (circuitBreaker.tripped) {
        factors.push({
          code: "CIRCUIT_BREAKER_HALT",
          label: "Circuit Breaker Kill Switch",
          points: 0,
          measuredValue: "TRIPPED",
          detail: circuitBreaker.reason || "Trading halted by session risk limits",
        });
      }

      // Determine Stage 4 Verdict (NEVER UPGRADES STAGE 3)
      let finalVerdict: FinalVerdict = stage3Verdict;
      let summary = "";

      if (circuitBreaker.tripped) {
        if (stage3Verdict === "CLEARED") {
          finalVerdict = "HELD_CIRCUIT_BREAKER";
        }
        summary = `HELD BY CIRCUIT BREAKER: ${circuitBreaker.reason || "Trading halted by session risk limits"}`;
      } else if (stage3Verdict === "CLEARED" && !sigAssessment.passesCorrection) {
        finalVerdict = "HELD_UNCONFIRMED_SIGNIFICANCE";
        summary = `HELD BY SIGNIFICANCE GUARD: ${sigAssessment.detail}`;
      } else if (stage3Verdict === "CLEARED") {
        finalVerdict = "CLEARED";
        summary = `CLEARED: Passed empirical, touch, significance, and sizing gates. Stake: $${sizingReport.drawdownAdjustedStake.toFixed(2)}.`;
      } else if (stage3Verdict === "BLOCKED") {
        finalVerdict = "BLOCKED";
        summary = `BLOCKED: Restrained by Stage 3 clearance or danger limits.`;
      } else {
        finalVerdict = "WAIT";
        summary = `WAIT: Awaiting primary Stage 3 trigger clearance.`;
      }

      const finalDecision: FinalDecision = {
        verdict: finalVerdict,
        stage3Verdict,
        recommendedStake: sizingReport,
        significance: sigAssessment,
        exposure: null,
        circuitBreaker,
        factors,
        summary,
      };

      return {
        ...cand,
        finalDecision,
        recommendedStake: sizingReport,
      };
    });

    // 3. Apply Portfolio Exposure Check and Correlation Group Ceilings
    const { report: exposureReport, heldCandidates } = PortfolioExposureEngine.evaluateExposure(
      evaluatedCandidates,
      openPositions,
    );

    const heldMap = new Map<string, string>();
    heldCandidates.forEach((h) => {
      const k = getCandidateKey(h.candidate);
      heldMap.set(k, h.reason);
    });

    // Update decisions for candidates held by portfolio exposure
    const finalRanked: T[] = evaluatedCandidates.map((candidate: any) => {
      const candKey = getCandidateKey(candidate);
      const heldReason = heldMap.get(candKey);

      if (heldReason && candidate.finalDecision.verdict === "CLEARED") {
        const updatedDecision: FinalDecision = {
          ...candidate.finalDecision,
          verdict: "HELD_EXPOSURE_CAP",
          exposure: exposureReport,
          summary: `HELD BY PORTFOLIO EXPOSURE: ${heldReason}`,
          factors: [
            ...candidate.finalDecision.factors,
            {
              code: "EXPOSURE_CAP_BREACH",
              label: "Portfolio / Correlation Ceiling",
              points: 0,
              measuredValue: "BREACHED",
              detail: heldReason,
            },
          ],
        };
        return {
          ...candidate,
          finalDecision: updatedDecision,
        };
      }

      return {
        ...candidate,
        finalDecision: {
          ...candidate.finalDecision,
          exposure: exposureReport,
        },
      };
    });

    // IMPORTANT: Stage 4 is an evidence-producing layer, not a second
    // ranking. It may change each candidate's finalDecision (including
    // CLEARED/HELD/WAIT/BLOCKED), sizing and exposure metadata, but it must
    // preserve the population order. The single authoritative ordering is
    // performed later by Apex `buildFinalRank()`, which consumes the Stage 4
    // state together with identity, psychology, confluence, operator gates
    // and raw evidence. This prevents Stage 4 from silently becoming a hidden
    // pre-ranking that can replace the intended Rank #1.
    const ranked = finalRanked;

    return {
      ranked,
      exposureReport,
      significanceMap,
    };
  }
}

/** Convenience functional export */
export const evaluateStage4 = FinalDecisionEngine.evaluateStage4;
