// §107 Forecast Calibration — reliability-curve consumer.
//
// Extends the parity forecast pipeline (without editing forecast.ts) with a
// per-horizon reliability curve that re-scales pEven when the journal contains
// ≥ 30 decided outcomes.

import { listParityJournal, type ParityJournalEntry } from "./journal";

export interface ReliabilityBin {
  /** Bin lower bound (inclusive), upper bound (exclusive). */
  lo: number;
  hi: number;
  /** Mid-point of the bin. */
  mid: number;
  /** Count of decided samples in this bin. */
  n: number;
  /** Realised hit-rate within the bin. */
  hitRate: number;
}

export interface ReliabilityCurve {
  horizon: number;
  bins: ReliabilityBin[];
  /** Total decided samples that fed the curve. */
  n: number;
  /** True when we have ≥ MIN samples and should rescale. */
  active: boolean;
}

const MIN = 30;
const BIN_EDGES = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0001];

export function buildReliabilityCurve(
  horizon: number,
  entries: ParityJournalEntry[] = listParityJournal(),
): ReliabilityCurve {
  const decided = entries.filter(
    (e) => e.horizon === horizon && (e.outcome === "win" || e.outcome === "loss"),
  );
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const lo = BIN_EDGES[i];
    const hi = BIN_EDGES[i + 1];
    const bucket = decided.filter((e) => e.pModel >= lo && e.pModel < hi);
    const wins = bucket.filter((e) => e.outcome === "win").length;
    bins.push({
      lo,
      hi,
      mid: (lo + hi) / 2,
      n: bucket.length,
      hitRate: bucket.length ? wins / bucket.length : (lo + hi) / 2,
    });
  }
  return {
    horizon,
    bins,
    n: decided.length,
    active: decided.length >= MIN,
  };
}

/**
 * Re-scale a raw pEven forecast for the given horizon using the reliability
 * curve. When the curve is inactive (too few samples), returns the raw value.
 */
export function rescalePEven(
  pRaw: number,
  horizon: number,
  entries?: ParityJournalEntry[],
): { p: number; source: "raw" | "reliability"; curve: ReliabilityCurve } {
  const curve = buildReliabilityCurve(horizon, entries);
  if (!curve.active) return { p: clamp01(pRaw), source: "raw", curve };
  // Find the two bins around pRaw and linearly interpolate their hit-rates.
  const clamped = clamp01(pRaw);
  const bins = curve.bins;
  const idx = bins.findIndex((b) => clamped >= b.lo && clamped < b.hi);
  if (idx < 0) return { p: clamped, source: "raw", curve };
  const left = bins[idx];
  const right = bins[idx + 1] ?? left;
  if (right === left) return { p: left.hitRate, source: "reliability", curve };
  const t = (clamped - left.mid) / Math.max(1e-6, right.mid - left.mid);
  const p = clamp01(left.hitRate + Math.max(0, Math.min(1, t)) * (right.hitRate - left.hitRate));
  return { p, source: "reliability", curve };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
