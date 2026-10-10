import type { MarketId } from "./constants";
import type { RegimeClassification, RegimeEvidence } from "./types";

interface RegimeRecord {
  classification: RegimeClassification;
  confidence: number;
  since: number; // timestamp classification was first observed
  lastUpdated: number;
}

/** Transitions considered material enough to force re-evaluation of a waiting opportunity (§5, §11.9). */
const MATERIAL_TRANSITIONS = new Set<string>([
  "CALM_STABLE>TRENDING_PERSISTENT",
  "TRENDING_PERSISTENT>DISTRIBUTION_EXHAUSTION",
  "TRENDING_PERSISTENT>TRANSITION",
  "TRANSITION>TRENDING_PERSISTENT",
  "ACCUMULATION>DISPLACEMENT_MANIPULATION",
  "DISTRIBUTION_EXHAUSTION>TRANSITION",
  "CALM_STABLE>HIGH_VOLATILITY_UNSTABLE",
  "CHOPPY_OSCILLATING>CALM_STABLE",
]);

/**
 * Tracks the *continuous* regime state per market (§5). This never invents a
 * classification — it only records and interprets what the existing regime
 * engine reports on each tick, including preserving `UNKNOWN` rather than
 * silently defaulting to `CALM_STABLE` (§11.1).
 */
export class RegimeTracker {
  private records = new Map<MarketId, RegimeRecord>();

  /** Returns true if this update represents a *material* regime transition for the market. */
  update(marketId: MarketId, evidence: RegimeEvidence, timestamp: number): boolean {
    const prev = this.records.get(marketId);

    if (!prev) {
      this.records.set(marketId, {
        classification: evidence.classification,
        confidence: evidence.confidence,
        since: timestamp,
        lastUpdated: timestamp,
      });
      return false;
    }

    if (prev.classification === evidence.classification) {
      prev.confidence = evidence.confidence;
      prev.lastUpdated = timestamp;
      return false;
    }

    const key = `${prev.classification}>${evidence.classification}`;
    const material = MATERIAL_TRANSITIONS.has(key) || evidence.transitioning;

    this.records.set(marketId, {
      classification: evidence.classification,
      confidence: evidence.confidence,
      since: timestamp,
      lastUpdated: timestamp,
    });

    return material;
  }

  get(marketId: MarketId): RegimeRecord | undefined {
    return this.records.get(marketId);
  }

  regimeAge(marketId: MarketId, now: number): number {
    const r = this.records.get(marketId);
    return r ? now - r.since : 0;
  }
}
