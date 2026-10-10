import type { MomentumEvidence, MomentumRelation } from "./types";
import type { Proposition } from "./constants";
import { propositionSide } from "./constants";

/**
 * §6 — interpret existing momentum-engine output against a candidate
 * proposition's side. Does not compute momentum itself; only classifies
 * the relationship between reported momentum and the setup direction.
 *
 * UNDER setup + UNDER-side acceleration = supportive
 * UNDER setup + OVER-side acceleration  = conflicting
 * OVER setup  + OVER-side acceleration  = supportive
 * OVER setup  + UNDER-side acceleration = conflicting
 *
 * Momentum has no separate veto authority outside §9's rules — this
 * function only classifies; §9 (selectivity) decides what to do with it.
 */
export function interpretMomentum(
  proposition: Proposition,
  momentum: MomentumEvidence,
): MomentumRelation {
  const setupSide = propositionSide(proposition);

  if (momentum.side === "UNKNOWN" || momentum.state === "UNKNOWN") return "NEUTRAL";
  if (momentum.state === "BALANCED") return "NEUTRAL";

  const sameSide = momentum.side === setupSide;
  const active = momentum.state === "ACCELERATING" || momentum.state === "STABLE";
  const conflictingActive = momentum.state === "ACCELERATING" || momentum.state === "REVERSING";

  if (sameSide && active) return "SUPPORTIVE";
  if (!sameSide && conflictingActive) return "CONFLICTING";
  if (momentum.state === "DECELERATING") return "NEUTRAL";

  return "NEUTRAL";
}
