// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL 1,000-TICK DIGIT DISTRIBUTION — ONE AUTHORITATIVE SOURCE.
//
//   DERIV LIVE TICKS
//         ↓
//   CANONICAL DIGIT STREAM  (derivBus.getDigits — pip-size aware)
//         ↓
//   CANONICAL 1,000-TICK DISTRIBUTION   ← this module
//         ↓
//    ┌────────────┬────────────┐
//    ▼            ▼            ▼
//  DASHBOARD   SENTINEL     DIAGNOSTICS
//              PSYCHOLOGY
//
// Nothing else in the app may recompute a competing 0–9 distribution from raw
// prices: the last digit of a Deriv quote depends on the symbol's pip size, so
// a naive `Math.round(price * 100) % 10` produces a DIFFERENT digit stream for
// symbols like 1HZ250V. That was the root cause of dashboard/Sentinel
// distribution discrepancies. Everything now reads the same digit buffer.
// ═══════════════════════════════════════════════════════════════════════════
import { derivBus } from "./tick-bus";
import type { Tick } from "@/lib/analytics";

/** The canonical structural window length, in ticks. */
export const CANONICAL_TICK_WINDOW = 1000;

export interface CanonicalDistribution {
  /** Market symbol the distribution belongs to. */
  symbol: string;
  /** Requested window length (ticks). */
  window: number;
  /** Ticks actually used (may be < window while history fills). */
  n: number;
  /** Raw occurrence counts, index === digit. */
  counts: number[];
  /** Percentage share per digit (0..100, unrounded), index === digit. */
  pct: number[];
  /** Digit of the newest tick in the window, or null. */
  newestDigit: number | null;
  /** Digit of the oldest tick in the window, or null. */
  oldestDigit: number | null;
  /** Epoch (ms) of the newest tick in the window, or null when unknown. */
  newestTickAt: number | null;
  /** Epoch (ms) of the oldest tick in the window, or null when unknown. */
  oldestTickAt: number | null;
  /** Price of the newest tick, or null. */
  newestPrice: number | null;
  /** Symbol pip size used to derive the digits. */
  pipSize: number;
  /** Which module produced this reading (for alignment diagnostics). */
  source: string;
  /** Stable identity of the exact window + counts. Equality ⇒ identical state. */
  fingerprint: string;
}

function emptyCounts(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export interface DistributionOptions {
  symbol?: string;
  window?: number;
  source?: string;
  pipSize?: number;
  /** Tick metadata aligned 1:1 with `digits` (same length, same order). */
  ticks?: Tick[] | null;
}

/**
 * Pure distribution builder. Given an oldest→newest digit stream, produce the
 * canonical reading of its last `window` entries.
 */
export function distributionFromDigits(
  digits: number[],
  opts: DistributionOptions = {},
): CanonicalDistribution {
  const window = opts.window ?? CANONICAL_TICK_WINDOW;
  const symbol = opts.symbol ?? "—";
  const slice = digits.slice(-window);
  const n = slice.length;
  const counts = emptyCounts();
  for (const d of slice) {
    if (d >= 0 && d <= 9) counts[d] += 1;
  }
  const pct = counts.map((c) => (n ? (c / n) * 100 : 0));

  const tickSlice = opts.ticks ? opts.ticks.slice(-window) : null;
  const aligned = tickSlice && tickSlice.length === n ? tickSlice : null;

  const newestTickAt = aligned && n ? aligned[n - 1].t : null;
  const oldestTickAt = aligned && n ? aligned[0].t : null;
  const newestPrice = aligned && n ? aligned[n - 1].price : null;

  const fingerprint = [
    symbol,
    window,
    n,
    newestTickAt ?? "?",
    oldestTickAt ?? "?",
    counts.join("."),
  ].join(":");

  return {
    symbol,
    window,
    n,
    counts,
    pct,
    newestDigit: n ? slice[n - 1] : null,
    oldestDigit: n ? slice[0] : null,
    newestTickAt,
    oldestTickAt,
    newestPrice,
    pipSize: opts.pipSize ?? 2,
    source: opts.source ?? "digits",
    fingerprint,
  };
}

/**
 * THE authoritative live reading for a market. Both the dashboard and the
 * Sentinel psychology engines must obtain their distribution through this
 * function (or through `distributionFromDigits` on the same digit stream).
 */
export function canonicalDistribution(
  symbol: string,
  window: number = CANONICAL_TICK_WINDOW,
  source = "canonical-distribution",
): CanonicalDistribution {
  return distributionFromDigits(derivBus.getDigits(symbol), {
    symbol,
    window,
    source,
    pipSize: derivBus.getPipSize(symbol),
    ticks: derivBus.getTicks(symbol),
  });
}

/** Convenience: the canonical digit stream for a market (oldest → newest). */
export function canonicalDigits(symbol: string): number[] {
  return derivBus.getDigits(symbol);
}
