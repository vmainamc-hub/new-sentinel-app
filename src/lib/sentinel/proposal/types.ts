// ═══════════════════════════════════════════════════════════════════════════
// SENTINEL PROPOSAL — SHARED TYPES (LAYER CONTRACTS)
//
// This directory is a SELF-CONTAINED PROPOSAL. It compiles on its own and has
// zero imports from the existing Sentinel tree, so it can be dropped into the
// repository and wired incrementally (see WIRING.md).
//
// ARCHITECTURE BEING PROPOSED
//
//   ENGINE A — STRUCTURAL DIGIT PSYCHOLOGY (1,000 ticks)
//     Owns: 0-9 distribution, GREEN / 2ND GREEN / RED / 2ND RED /
//           MOST INCREASING / MOST DECREASING, positional psychology.
//     Answers ONE question: is the structural direction OVER or UNDER?
//
//   ENGINE B — PRICE-ACTION PRESSURE (15 / 30 / 60 / 120 ticks)
//     Owns: movement only — rate, acceleration, persistence, reversal,
//           takeover, exhaustion, cross-window agreement.
//     Knows NOTHING about GREEN / 2ND GREEN / RED / 2ND RED, and the
//           1,000-tick distribution NEVER enters its arithmetic.
//
//   VALIDATOR — Engine B judges Engine A's direction:
//           CONFIRM / NEUTRAL / MIXED / REJECT
//
//   VETO ENGINE — can stop the signal regardless of any score.
//
// Flow:  1,000t structure → direction → 15/30/60/120 pressure → confirm or
//        reject → veto engine → existing entry / trigger / ranking layers.
// ═══════════════════════════════════════════════════════════════════════════

/** Contract side. Unchanged from the existing Sentinel vocabulary. */
export type Side = "OVER" | "UNDER";

/**
 * Structurally compatible with the existing `CanonicalDigitState` in
 * `src/lib/sentinel/digit-psychology.ts`. Declared locally (not imported) so
 * this proposal has no build-order dependency; at wiring time you can either
 * pass the real object straight in (it satisfies this shape) or replace this
 * declaration with `import type { CanonicalDigitState } from "../digit-psychology"`.
 */
export type { CanonicalDigitState as CanonicalStateLike } from "../digit-psychology";
export type { ContractShape as ContractShapeLike } from "../digit-psychology";

export const ALL_DIGITS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
export const EVEN_DIGITS: readonly number[] = [0, 2, 4, 6, 8];
export const ODD_DIGITS: readonly number[] = [1, 3, 5, 7, 9];

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const round1 = (v: number) => Math.round(v * 10) / 10;
export const isEven = (d: number) => d % 2 === 0;
export const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`;

/** Share of digit `d` inside a segment, in percent. */
export function shareOf(seg: readonly number[], d: number): number {
  if (!seg.length) return 0;
  let c = 0;
  for (const x of seg) if (x === d) c++;
  return (c / seg.length) * 100;
}
