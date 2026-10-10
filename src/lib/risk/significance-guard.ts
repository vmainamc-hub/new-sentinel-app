/**
 * RISK — SIGNIFICANCE GUARD.
 *
 * Every scan tests dozens of market/contract combinations at once. Testing
 * many hypotheses inflates the chance that a purely random combination looks
 * "edgy". This engine applies a Benjamini-Hochberg false-discovery-rate
 * correction across all live combinations plus a Minimum Effect Size (MES)
 * floor, so only edges that survive both gates are treated as real.
 */

import type { SignificanceAssessment } from "@/types/sentinel";

export interface ComboEvidence {
  comboKey: string;
  /** Raw p-value of the measured edge vs the theoretical baseline. */
  pVal: number;
  /** Wilson lower bound of the measured win rate (percentage points). */
  rawWilsonLower: number;
  /** Measured edge over baseline, in percentage points. */
  measuredEdge: number;
  /** Number of observations behind the measurement. */
  sampleSize: number;
}

/** Edges smaller than this are noise regardless of p-value. */
export const MINIMUM_EFFECT_SIZE_PP = 1.5;
/** Below this many observations no combination can be declared significant. */
export const MINIMUM_SAMPLE_SIZE = 60;
/** Target false discovery rate. */
export const FDR_ALPHA = 0.1;

export class SignificanceGuardEngine {
  /**
   * Benjamini-Hochberg across the full candidate set.
   * Returns one assessment per combination, keyed by comboKey.
   */
  public static evaluateAll(evidences: ComboEvidence[]): Map<string, SignificanceAssessment> {
    const out = new Map<string, SignificanceAssessment>();
    const m = evidences.length;
    if (m === 0) return out;

    const sorted = [...evidences].sort((a, b) => a.pVal - b.pVal);

    // Largest rank k whose p-value is <= (k/m) * alpha.
    let cutoffRank = 0;
    sorted.forEach((e, i) => {
      const rank = i + 1;
      if (e.pVal <= (rank / m) * FDR_ALPHA) cutoffRank = rank;
    });
    const fdrAdjustedThreshold =
      cutoffRank > 0 ? (cutoffRank / m) * FDR_ALPHA : (1 / m) * FDR_ALPHA;

    sorted.forEach((e, i) => {
      const rank = i + 1;
      const passesFdr = cutoffRank > 0 && rank <= cutoffRank;
      const passesMes = e.measuredEdge >= MINIMUM_EFFECT_SIZE_PP;
      const passesSample = e.sampleSize >= MINIMUM_SAMPLE_SIZE;
      const passesCorrection = passesFdr && passesMes && passesSample;

      const reasons: string[] = [];
      if (!passesFdr)
        reasons.push(
          `p=${e.pVal.toFixed(4)} above BH threshold ${fdrAdjustedThreshold.toFixed(4)} at rank ${rank}/${m}`,
        );
      if (!passesMes)
        reasons.push(
          `edge ${e.measuredEdge.toFixed(2)}pp below minimum effect size ${MINIMUM_EFFECT_SIZE_PP}pp`,
        );
      if (!passesSample)
        reasons.push(`sample ${e.sampleSize} below minimum ${MINIMUM_SAMPLE_SIZE} observations`);

      out.set(e.comboKey, {
        comboKey: e.comboKey,
        rawWilsonLower: e.rawWilsonLower,
        fdrAdjustedThreshold,
        passesCorrection,
        activeComparisons: m,
        detail: passesCorrection
          ? `Survives Benjamini-Hochberg at rank ${rank}/${m} (p=${e.pVal.toFixed(4)} <= ${fdrAdjustedThreshold.toFixed(4)}) with ${e.measuredEdge.toFixed(2)}pp edge over N=${e.sampleSize}.`
          : `Not confirmed: ${reasons.join("; ")}.`,
      });
    });

    return out;
  }
}
