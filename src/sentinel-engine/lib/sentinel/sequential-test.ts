// APEX SENTINEL — SEQUENTIAL TEST / EARLY-STOP ENGINE.
//
// Purpose:
// `combination-learning.ts` currently proves or disproves a combination
// against STATIC sample-size thresholds (`DEFAULT_MIN_WEIGHTED_N`, etc). That
// means a combination that is obviously working (or obviously failing) after
// 14 trades still waits for the same fixed N as a combination sitting right
// on the fence. This engine formalises the adaptive alternative: Wald's
// Sequential Probability Ratio Test (SPRT), which can declare PROVEN or
// DISPROVEN as soon as the accumulated evidence crosses a likelihood-ratio
// boundary — often well before, and sometimes well after, a fixed N would.
//
// This module does NOT replace combination-learning.ts's state machine. It is
// an additive, read-only lens over the same win/loss observations, exposed so
// entry-clearance.ts and the UI can show "why" a combination's sample size
// requirement is (or isn't) actually settled yet, instead of just "N so far".
//
// Core principles, matching the rest of Sentinel:
//   • Pure functions only — no hidden state, nothing mutated.
//   • Conservative by construction: with too little data the verdict is
//     CONTINUE, never PROVEN/DISPROVEN by default.
//   • Every output states the exact hypotheses being tested, so nobody can
//     read a PROVEN verdict as "guaranteed", only "distinguishable at this
//     error-rate budget from the null we specified".

export type SequentialVerdict = "CONTINUE" | "PROVEN" | "DISPROVEN";

export interface SequentialTestOptions {
  /**
   * Null hypothesis win rate — usually the contract's theoretical/expected
   * win rate. The test asks "is the observed rate distinguishable from p0?".
   */
  p0: number;
  /**
   * Alternative hypothesis win rate the combination would need to reach to
   * be worth trading — e.g. p0 + a minimum edge. Must be > p0 for a PROVEN
   * (edge) test, or < p0 for a DISPROVEN-only degenerate test.
   */
  p1: number;
  /** Type I error budget — false-PROVEN rate. Default 0.05. */
  alpha?: number;
  /** Type II error budget — false-DISPROVEN (missed edge) rate. Default 0.10. */
  beta?: number;
  /** Hard cap on samples considered — SPRT can in theory run forever on a
   * knife-edge sequence; Sentinel never lets a decision hang indefinitely. */
  maxN?: number;
}

export interface SequentialTestReport {
  verdict: SequentialVerdict;
  /** Cumulative log-likelihood ratio statistic. */
  llr: number;
  /** Upper boundary — llr >= this crossing declares PROVEN. */
  upperBound: number;
  /** Lower boundary — llr <= this crossing declares DISPROVEN. */
  lowerBound: number;
  n: number;
  wins: number;
  observedRate: number;
  p0: number;
  p1: number;
  alpha: number;
  beta: number;
  /** How far (0..1) the llr has travelled toward whichever boundary it is
   * closer to — a "how close to a decision" gauge for CONTINUE verdicts. */
  progress: number;
  /** True once n has hit maxN without crossing either boundary. */
  inconclusiveAtCap: boolean;
  summary: string;
}

const DEFAULT_ALPHA = 0.05;
const DEFAULT_BETA = 0.1;
const DEFAULT_MAX_N = 500;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Wald SPRT over a sequence of Bernoulli outcomes (win = true/false), tested
 * against H0: p = p0 vs H1: p = p1.
 *
 * outcomes must already be in chronological order (oldest first) — this is a
 * SEQUENTIAL test, order matters for the "when did it cross" semantics even
 * though the final llr for a fixed set of outcomes is order-independent.
 */
export function runSequentialTest(
  outcomes: boolean[],
  options: SequentialTestOptions,
): SequentialTestReport {
  const { p0, p1, alpha = DEFAULT_ALPHA, beta = DEFAULT_BETA, maxN = DEFAULT_MAX_N } = options;

  const safeP0 = clamp(p0, 0.001, 0.999);
  const safeP1 = clamp(p1, 0.001, 0.999);

  // Standard Wald boundaries in log-space:
  //   upper = ln((1-beta)/alpha)   — crossing declares H1 (PROVEN)
  //   lower = ln(beta/(1-alpha))   — crossing declares H0 (DISPROVEN)
  const upperBound = Math.log((1 - beta) / alpha);
  const lowerBound = Math.log(beta / (1 - alpha));

  const capped = outcomes.slice(0, maxN);
  let llr = 0;
  let wins = 0;
  let verdict: SequentialVerdict = "CONTINUE";
  let crossedAt = -1;

  for (let i = 0; i < capped.length; i++) {
    const win = capped[i];
    if (win) wins++;
    // Per-observation log-likelihood-ratio contribution for a Bernoulli trial.
    llr += win ? Math.log(safeP1 / safeP0) : Math.log((1 - safeP1) / (1 - safeP0));

    if (llr >= upperBound) {
      verdict = "PROVEN";
      crossedAt = i + 1;
      break;
    }
    if (llr <= lowerBound) {
      verdict = "DISPROVEN";
      crossedAt = i + 1;
      break;
    }
  }

  const n = crossedAt > 0 ? crossedAt : capped.length;
  const observedRate = n > 0 ? wins / n : 0;
  const inconclusiveAtCap = verdict === "CONTINUE" && capped.length >= maxN;

  // Progress toward a decision: how far llr sits between 0 and whichever
  // boundary it's nearer to, purely descriptive — never used to force a verdict.
  const progress =
    verdict !== "CONTINUE"
      ? 1
      : llr >= 0
        ? clamp(llr / upperBound, 0, 1)
        : clamp(llr / lowerBound, 0, 1);

  const summary =
    verdict === "PROVEN"
      ? `PROVEN after N=${n}: observed rate ${(observedRate * 100).toFixed(1)}% is distinguishable from the null p0=${(safeP0 * 100).toFixed(1)}% in favour of p1=${(safeP1 * 100).toFixed(1)}% at α=${alpha}, β=${beta}.`
      : verdict === "DISPROVEN"
        ? `DISPROVEN after N=${n}: observed rate ${(observedRate * 100).toFixed(1)}% is not distinguishable from p1=${(safeP1 * 100).toFixed(1)}% — evidence favours the null p0=${(safeP0 * 100).toFixed(1)}%.`
        : inconclusiveAtCap
          ? `INCONCLUSIVE at N cap (${maxN}): ${(observedRate * 100).toFixed(1)}% observed over N=${n}, neither boundary crossed — treat as CONTINUE, not as evidence either way.`
          : `CONTINUE — N=${n} so far (${(observedRate * 100).toFixed(1)}% observed), ${(progress * 100).toFixed(0)}% of the way to a decision boundary.`;

  return {
    verdict,
    llr,
    upperBound,
    lowerBound,
    n,
    wins,
    observedRate,
    p0: safeP0,
    p1: safeP1,
    alpha,
    beta,
    progress,
    inconclusiveAtCap,
    summary,
  };
}

/**
 * Convenience wrapper for combination-learning.ts's ComboObservation-shaped
 * data: builds H1 from p0 + a minimum required edge in percentage points,
 * so callers don't need to hand-pick p1 themselves.
 */
export function sequentialTestFromEdge(
  outcomes: boolean[],
  theoretical: number,
  minEdgePp: number = 5,
  overrides: Partial<Omit<SequentialTestOptions, "p0" | "p1">> = {},
): SequentialTestReport {
  return runSequentialTest(outcomes, {
    p0: theoretical,
    p1: clamp(theoretical + minEdgePp / 100, 0.001, 0.999),
    ...overrides,
  });
}
