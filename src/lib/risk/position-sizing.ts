/**
 * RISK — POSITION SIZING.
 *
 * Turns a scored opportunity into a concrete stake using a fractional-Kelly
 * base, damped by evidence maturity and confidence, then further reduced
 * whenever the circuit breaker reports drawdown or a losing streak.
 */

import type { CircuitBreakerState, PositionSizeReport, SetupFactor } from "@/types/sentinel";

/** Assumed session bankroll when the caller does not provide one. */
export const DEFAULT_BANKROLL = 1000;
/** Never risk more than this share of bankroll on a single position. */
export const MAX_BANKROLL_PCT = 2;
/** Fraction of full Kelly actually deployed. */
export const KELLY_FRACTION_CAP = 0.25;
/** Absolute floor so a cleared trade is never sized to nothing. */
export const MIN_STAKE = 0.35;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class PositionSizingEngine {
  /**
   * Fractional-Kelly base stake.
   *
   * @param opportunityScore 0-100 composite score
   * @param confidence       0-100 confidence in the measurement
   * @param empiricalWinRate 0-100 measured win rate
   * @param payout           gross payout multiplier (e.g. 1.38)
   * @param sampleTicks      ticks of evidence behind the measurement
   * @param bankroll         session bankroll
   */
  public static calculateBaseStake(
    opportunityScore: number,
    confidence: number,
    empiricalWinRate: number,
    payout: number,
    sampleTicks: number,
    bankroll: number = DEFAULT_BANKROLL,
  ): PositionSizeReport {
    const factors: SetupFactor[] = [];

    const p = clamp(empiricalWinRate / 100, 0.01, 0.99);
    const b = Math.max(0.05, payout - 1);
    const rawKelly = clamp((p * b - (1 - p)) / b, 0, 1);
    const kellyFraction = rawKelly * KELLY_FRACTION_CAP;

    factors.push({
      code: "KELLY_BASE",
      label: "Fractional Kelly",
      points: Math.round(kellyFraction * 100),
      measuredValue: `${(kellyFraction * 100).toFixed(2)}%`,
      detail: `Win rate ${(p * 100).toFixed(1)}% at payout ${payout.toFixed(2)} gives full Kelly ${(rawKelly * 100).toFixed(2)}%, deployed at ${KELLY_FRACTION_CAP * 100}% of full.`,
    });

    // Evidence maturity: thin samples get sized down hard.
    const maturityFactor = clamp(Math.sqrt(Math.max(0, sampleTicks) / 1000), 0.2, 1);
    factors.push({
      code: "EVIDENCE_MATURITY",
      label: "Evidence maturity",
      points: Math.round(maturityFactor * 100),
      measuredValue: sampleTicks,
      detail: `${sampleTicks} ticks of evidence scales the stake by ${(maturityFactor * 100).toFixed(0)}%.`,
    });

    // Confidence and score blend.
    const confidenceFactor = clamp(
      (0.6 * clamp(confidence, 0, 100) + 0.4 * clamp(opportunityScore, 0, 100)) / 100,
      0.2,
      1,
    );
    factors.push({
      code: "CONFIDENCE_BLEND",
      label: "Confidence & score",
      points: Math.round(confidenceFactor * 100),
      measuredValue: `${confidence.toFixed(0)} / ${opportunityScore.toFixed(0)}`,
      detail: `Confidence ${confidence.toFixed(0)} and opportunity score ${opportunityScore.toFixed(0)} scale the stake by ${(confidenceFactor * 100).toFixed(0)}%.`,
    });

    const pct = clamp(kellyFraction * maturityFactor * confidenceFactor * 100, 0, MAX_BANKROLL_PCT);
    const baseStake = Math.max(MIN_STAKE, Math.round(bankroll * (pct / 100) * 100) / 100);

    return {
      baseStake,
      drawdownAdjustedStake: baseStake,
      kellyFraction,
      maxBankrollPct: MAX_BANKROLL_PCT,
      maturityFactor,
      confidenceFactor,
      factors,
      summary: `Base stake $${baseStake.toFixed(2)} (${pct.toFixed(2)}% of $${bankroll.toFixed(0)} bankroll).`,
    };
  }

  /** Reduce a base stake in line with current drawdown / streak state. */
  public static applyDrawdownAdjustment(
    base: PositionSizeReport,
    cb: CircuitBreakerState,
  ): PositionSizeReport {
    let multiplier = 1;
    const notes: string[] = [];

    if (cb.consecutiveLosses >= 2) {
      const m = Math.max(0.35, 1 - 0.2 * (cb.consecutiveLosses - 1));
      multiplier *= m;
      notes.push(`${cb.consecutiveLosses} consecutive losses (x${m.toFixed(2)})`);
    }
    if (cb.sessionDrawdownPct > 0) {
      const m = Math.max(0.3, 1 - cb.sessionDrawdownPct / 25);
      multiplier *= m;
      notes.push(`session drawdown ${cb.sessionDrawdownPct.toFixed(1)}% (x${m.toFixed(2)})`);
    }
    if (cb.sustainedGlobalDanger >= 60) {
      multiplier *= 0.6;
      notes.push(`sustained danger ${cb.sustainedGlobalDanger.toFixed(0)}/100 (x0.60)`);
    }
    if (cb.tripped) {
      multiplier = 0;
      notes.push("circuit breaker tripped (x0.00)");
    }

    const adjusted =
      multiplier === 0
        ? 0
        : Math.max(MIN_STAKE, Math.round(base.baseStake * multiplier * 100) / 100);

    return {
      ...base,
      drawdownAdjustedStake: adjusted,
      factors: [
        ...base.factors,
        {
          code: "DRAWDOWN_ADJUSTMENT",
          label: "Drawdown adjustment",
          points: Math.round(multiplier * 100),
          measuredValue: `x${multiplier.toFixed(2)}`,
          detail: notes.length
            ? `Stake scaled by ${notes.join(", ")}.`
            : "No drawdown, streak, or danger penalty active.",
        },
      ],
      summary: `${base.summary} Adjusted stake $${adjusted.toFixed(2)}${notes.length ? ` after ${notes.join(", ")}` : " (no risk penalties)"}.`,
    };
  }
}
