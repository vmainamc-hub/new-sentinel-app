// APEX SENTINEL — OPERATOR FEEDBACK → VALIDATED LEARNING → FUTURE INFLUENCE.
//
// NON-DESTRUCTIVE additive layer on top of the existing trade-feedback store.
// It never writes feedback, never creates trades, never turns an ignored signal
// into a win or a loss, and never rewrites a historical snapshot (no
// look-ahead: only trades that happened AFTER an observation may validate it).
//
// Pipeline:
//   operator observation → grouped by market + contract + entry digit + category
//   → compared with SUBSEQUENT confirmed trade outcomes → bounded confidence
//   → status (OBSERVATION → EMERGING → SUPPORTED → VALIDATED | DISCOUNTED)
//   → SMALL bounded adjustment offered to the existing engines.
import {
  confirmedTrades,
  feedbackHistory,
  type FeedbackCategory,
  type FeedbackHistoryEntry,
  type TradeRecord,
} from "./trade-feedback";

export type OperatorPatternStatus =
  "OBSERVATION" | "EMERGING" | "SUPPORTED" | "VALIDATED" | "DISCOUNTED";

export type OperatorPolarity = "NEGATIVE" | "POSITIVE" | "NEUTRAL";

/** Half-life of an operator observation's influence. Nothing is ever deleted. */
export const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on how much operator learning may move an entry-digit score. */
export const MAX_ENTRY_ADJUSTMENT = 6;
/** Hard cap on how much operator learning may move a market/contract ranking. */
export const MAX_RANKING_ADJUSTMENT = 2.5;

/** Which direction a category claims about the condition it describes. */
const POLARITY: Record<FeedbackCategory, OperatorPolarity> = {
  "ENTRY QUALITY": "NEUTRAL",
  "ENTRY TOO LATE": "NEGATIVE",
  "ENTRY DIGIT": "NEUTRAL",
  "PRESSURE REVERSAL": "NEGATIVE",
  DANGER: "NEGATIVE",
  "MARKET ROTATION": "NEGATIVE",
  "SIGNAL STABILITY": "NEUTRAL",
  "ENGINE AGREEMENT": "NEUTRAL",
  "STRONG SIGNAL": "POSITIVE",
  "WEAK SIGNAL": "NEGATIVE",
  SIMULATOR: "NEUTRAL",
  OTHER: "NEUTRAL",
};

export interface OperatorPattern {
  key: string;
  symbol: string;
  contract: string;
  contractLabel: string;
  /** null = the pattern is not tied to a specific entry digit. */
  entryDigit: number | null;
  category: FeedbackCategory | null;
  polarity: OperatorPolarity;
  /** Raw number of written operator notes in this exact bucket. */
  observations: number;
  /** Recency-weighted observation count (older notes weigh less). */
  weightedObservations: number;
  /** Confirmed trades in the SAME bucket that happened after the first note. */
  relatedTrades: number;
  wins: number;
  losses: number;
  /** Loss rate of the related confirmed trades, 0..1. */
  lossRate: number;
  /** Loss rate of the rest of the market/contract, for comparison. */
  baselineLossRate: number;
  status: OperatorPatternStatus;
  /** 0..100, bounded, sample-size and recency aware. */
  feedbackConfidence: number;
  /** Bounded score points offered to the entry-digit ranking. */
  entryAdjustment: number;
  /** Bounded score points offered to the market/contract ranking. */
  rankingAdjustment: number;
  outcomeRelationship: "NEGATIVE" | "POSITIVE" | "NEUTRAL" | "UNTESTED";
  influence: "NONE" | "MINIMAL" | "MODERATE CAUTION" | "STRONG CAUTION" | "SUPPORTIVE";
  lastObservedAt: number;
  summary: string;
  reason: string;
  samples: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function decay(ts: number, now: number): number {
  const age = Math.max(0, now - ts);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

function bucketKey(e: {
  symbol: string;
  contract: string;
  entryDigit: number | null;
  category: FeedbackCategory | null;
}) {
  return `${e.symbol}|${e.contract}|${e.entryDigit ?? "any"}|${e.category ?? "FREE TEXT"}`;
}

export interface OperatorLearningInputs {
  notes: FeedbackHistoryEntry[];
  trades: TradeRecord[];
  now?: number;
}

/**
 * Pure derivation — no storage access, so it is fully testable and cannot be
 * confused with the primary scoring engines.
 */
export function computeOperatorPatterns({
  notes,
  trades,
  now = Date.now(),
}: OperatorLearningInputs): OperatorPattern[] {
  const groups = new Map<string, FeedbackHistoryEntry[]>();
  for (const n of notes) {
    const k = bucketKey(n);
    const arr = groups.get(k);
    if (arr) arr.push(n);
    else groups.set(k, [n]);
  }

  const patterns: OperatorPattern[] = [];

  for (const [key, list] of groups) {
    const first = list[0];
    const sorted = [...list].sort((a, b) => a.ts - b.ts);
    const firstTs = sorted[0].ts;
    const lastObservedAt = sorted[sorted.length - 1].ts;
    const polarity = first.category ? POLARITY[first.category] : "NEUTRAL";

    const weightedObservations =
      Math.round(sorted.reduce((a, n) => a + decay(n.ts, now), 0) * 100) / 100;

    // NO LOOK-AHEAD: only trades confirmed AFTER the first observation can test
    // the hypothesis. A trade that produced the feedback never validates it.
    const marketTrades = trades.filter(
      (t) => t.snapshot.symbol === first.symbol && t.snapshot.contract === first.contract,
    );
    const related = marketTrades.filter(
      (t) =>
        (t.resolvedAt ?? t.ts) > firstTs &&
        (first.entryDigit === null || t.snapshot.entryDigit === first.entryDigit),
    );
    const wins = related.filter((t) => t.outcome === "WIN").length;
    const losses = related.filter((t) => t.outcome === "LOSS").length;
    const relatedTrades = wins + losses;
    const lossRate = relatedTrades ? losses / relatedTrades : 0;

    const others = marketTrades.filter((t) => !related.includes(t));
    const otherLosses = others.filter((t) => t.outcome === "LOSS").length;
    const baselineLossRate = others.length ? otherLosses / others.length : 0.5;

    // Does the evidence agree with what the operator claimed?
    let agreement = 0; // −1 contradicts … +1 supports
    let outcomeRelationship: OperatorPattern["outcomeRelationship"] = "UNTESTED";
    if (relatedTrades >= 3) {
      const delta = lossRate - baselineLossRate;
      if (polarity === "POSITIVE") {
        agreement = clamp(-delta * 2.5, -1, 1);
        outcomeRelationship = delta < -0.05 ? "POSITIVE" : delta > 0.05 ? "NEGATIVE" : "NEUTRAL";
      } else {
        // NEGATIVE and NEUTRAL claims are both tested as "this condition is worse".
        agreement = clamp(delta * 2.5, -1, 1);
        outcomeRelationship = delta > 0.05 ? "NEGATIVE" : delta < -0.05 ? "POSITIVE" : "NEUTRAL";
      }
    }

    // ── Bounded confidence ───────────────────────────────────────────────
    // Small samples can never produce a large number: each term saturates.
    const obsTerm = Math.min(30, weightedObservations * 6); // 5 fresh notes → 30
    const tradeTerm = Math.min(30, relatedTrades * 2.5); // 12 trades → 30
    const consistency = relatedTrades >= 3 ? Math.min(25, Math.abs(agreement) * 25) : 0;
    const recency = Math.min(15, decay(lastObservedAt, now) * 15);
    const raw = obsTerm + tradeTerm + consistency + recency;
    // A hypothesis that the outcomes contradict is actively discounted.
    const feedbackConfidence = Math.round(clamp(agreement < -0.2 ? raw * 0.35 : raw, 0, 100));

    let status: OperatorPatternStatus;
    if (agreement < -0.2 && relatedTrades >= 6) status = "DISCOUNTED";
    else if (weightedObservations < 2.5) status = "OBSERVATION";
    else if (relatedTrades >= 12 && agreement >= 0.35 && feedbackConfidence >= 70)
      status = "VALIDATED";
    else if (relatedTrades >= 6 && agreement >= 0.2 && feedbackConfidence >= 55)
      status = "SUPPORTED";
    else status = "EMERGING";

    // ── Bounded influence ────────────────────────────────────────────────
    const statusWeight =
      status === "VALIDATED" ? 1 : status === "SUPPORTED" ? 0.5 : status === "EMERGING" ? 0.15 : 0;
    const direction = polarity === "POSITIVE" ? 1 : -1;
    const magnitude =
      MAX_ENTRY_ADJUSTMENT * statusWeight * (feedbackConfidence / 100) * Math.abs(agreement || 0);
    const entryAdjustment =
      Math.round(clamp(direction * magnitude, -MAX_ENTRY_ADJUSTMENT, MAX_ENTRY_ADJUSTMENT) * 10) /
        10 +
      0;
    const rankingAdjustment =
      Math.round(
        clamp(entryAdjustment * 0.4, -MAX_RANKING_ADJUSTMENT, MAX_RANKING_ADJUSTMENT) * 10,
      ) / 10;

    const abs = Math.abs(entryAdjustment);
    const influence: OperatorPattern["influence"] =
      abs < 0.5
        ? "NONE"
        : entryAdjustment > 0
          ? "SUPPORTIVE"
          : abs < 2
            ? "MINIMAL"
            : abs < 4
              ? "MODERATE CAUTION"
              : "STRONG CAUTION";

    const where = `${first.symbol} · ${first.contractLabel}${
      first.entryDigit !== null ? ` · Entry ${first.entryDigit}` : ""
    }`;
    const label = first.category ?? "free-text operator feedback";

    patterns.push({
      key,
      symbol: first.symbol,
      contract: first.contract,
      contractLabel: first.contractLabel,
      entryDigit: first.entryDigit,
      category: first.category,
      polarity,
      observations: sorted.length,
      weightedObservations,
      relatedTrades,
      wins,
      losses,
      lossRate,
      baselineLossRate,
      status,
      feedbackConfidence,
      entryAdjustment,
      rankingAdjustment,
      outcomeRelationship,
      influence,
      lastObservedAt,
      summary: `${where} — ${label}: ${sorted.length} observation${sorted.length === 1 ? "" : "s"}, ${relatedTrades} related confirmed trade${relatedTrades === 1 ? "" : "s"} (${wins}W/${losses}L), status ${status}, confidence ${feedbackConfidence}/100.`,
      reason:
        relatedTrades < 3
          ? "Not enough subsequent confirmed trades to test this operator hypothesis yet — recorded as an observation only."
          : outcomeRelationship === "NEGATIVE"
            ? `Subsequent confirmed outcomes here lose ${(lossRate * 100).toFixed(0)}% vs ${(baselineLossRate * 100).toFixed(0)}% elsewhere on this market × contract, which is consistent with the operator's report.`
            : outcomeRelationship === "POSITIVE"
              ? `Subsequent confirmed outcomes here lose ${(lossRate * 100).toFixed(0)}% vs ${(baselineLossRate * 100).toFixed(0)}% elsewhere on this market × contract.`
              : "Subsequent confirmed outcomes are indistinguishable from the rest of this market × contract.",
      samples: sorted
        .slice(-3)
        .reverse()
        .map((n) => n.text),
    });
  }

  return patterns.sort((a, b) => b.feedbackConfidence - a.feedbackConfidence);
}

/** Read-only immutable view handed to the engines. Market/contract isolated. */
export interface OperatorLearningLookup {
  patterns: OperatorPattern[];
  /** Patterns that materially affect a specific entry digit. */
  forDigit(symbol: string, contract: string, digit: number): OperatorPattern[];
  /** Digit-agnostic patterns for the market × contract. */
  forMarket(symbol: string, contract: string): OperatorPattern[];
  /** Bounded, summed adjustment for one entry digit. */
  entryAdjustment(symbol: string, contract: string, digit: number): number;
  /** Bounded, summed adjustment for the market/contract ranking. */
  rankingAdjustment(symbol: string, contract: string): number;
}

export function makeOperatorLookup(patterns: OperatorPattern[]): OperatorLearningLookup {
  const material = patterns.filter((p) => Math.abs(p.entryAdjustment) >= 0.5);
  const forDigit = (symbol: string, contract: string, digit: number) =>
    material.filter(
      (p) =>
        p.symbol === symbol &&
        p.contract === contract &&
        (p.entryDigit === digit || p.entryDigit === null),
    );
  const forMarket = (symbol: string, contract: string) =>
    material.filter((p) => p.symbol === symbol && p.contract === contract && p.entryDigit === null);
  return {
    patterns,
    forDigit,
    forMarket,
    entryAdjustment: (symbol, contract, digit) =>
      Math.round(
        clamp(
          forDigit(symbol, contract, digit).reduce((a, p) => a + p.entryAdjustment, 0),
          -MAX_ENTRY_ADJUSTMENT,
          MAX_ENTRY_ADJUSTMENT,
        ) * 10,
      ) / 10,
    rankingAdjustment: (symbol, contract) =>
      Math.round(
        clamp(
          forMarket(symbol, contract).reduce((a, p) => a + p.rankingAdjustment, 0),
          -MAX_RANKING_ADJUSTMENT,
          MAX_RANKING_ADJUSTMENT,
        ) * 10,
      ) / 10,
  };
}

/** Derived from the EXISTING persisted feedback store — survives reloads. */
export function operatorPatterns(now = Date.now()): OperatorPattern[] {
  return computeOperatorPatterns({
    notes: feedbackHistory(),
    trades: confirmedTrades(),
    now,
  });
}

export function operatorLearningLookup(now = Date.now()): OperatorLearningLookup {
  return makeOperatorLookup(operatorPatterns(now));
}

/** Patterns worth SHOWING (never show a bucket with insufficient evidence). */
export function reportablePatterns(now = Date.now()): OperatorPattern[] {
  return operatorPatterns(now).filter(
    (p) => p.status !== "OBSERVATION" || p.weightedObservations >= 2,
  );
}
