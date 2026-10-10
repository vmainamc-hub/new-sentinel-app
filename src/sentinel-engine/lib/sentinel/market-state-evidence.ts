// APEX SENTINEL — MARKET-STATE EVIDENCE ENGINE.
//
// CORE PRINCIPLE: A SEQUENCE OF SIMULATED OUTCOMES IS NOT ITSELF A FORECAST.
//
// The old shape of reasoning this module replaces:
//   "The last 20 simulations were 14 wins → therefore trade."
// That is unsafe: a loss streak can occur inside a good regime and a winning
// streak can occur inside a deteriorating one. Raw win/loss tallies cannot
// tell the difference.
//
// What this module answers instead, at any moment:
//   "What does the history of simulated outcomes tell us about the CURRENT
//    market state?" — never "did the last simulation win?"
//
// This module is a pure statistical layer. It does not decide whether to
// trade. It produces an EVIDENCE PROFILE that a decision/ranking engine can
// consume alongside psychology, pressure and danger evidence. Nothing here
// invents outcomes, deletes history, or claims Deriv is "manipulating" —
// ACCUMULATION / TRANSITION / DISTRIBUTION below are statistical analogues
// over the resolved-contract sequence, not claims about broker intent.
//
// Architectural separation this module exists to enforce:
//   RAW SIMULATION (apex/simulator.ts)
//         ↓
//   STATISTICAL INTERPRETATION  ← this module
//         ↓
//   REGIME / STATE DETECTION    ← this module
//         ↓
//   (existing) psychology / pressure / entry / danger engines
//         ↓
//   FINAL SIGNAL (existing ranking + decision layer)
//
// Nothing in this file touches localStorage, the simulator ledger, or any
// other module. Callers pass in the resolved WIN/LOSS sequence they already
// have (e.g. `SimPerformance.recentResults` / a market's full ledger mapped
// to results) and get back a self-contained, auditable evidence profile.

export type SimOutcome = "WIN" | "LOSS";

/** Statistical analogue labels — never a claim about broker/market intent. */
export type MarketStateRegime =
  | "INSUFFICIENT_SAMPLE"
  | "ACCUMULATION" // stable/building, expectancy improving, no regime break
  | "TRANSITION" // sudden reversal, rising variance, distribution shift
  | "DISTRIBUTION" // pressure resolved, consistent direction, stable behaviour
  | "CHOPPY"; // alternating outcomes with no persistent structure

export type StreakTransition =
  | "NONE" // not enough resolved history to say anything
  | "LOSS_RECOVERING" // recent run of losses ending in a run of wins
  | "WIN_DETERIORATING" // recent run of wins ending in a run of losses
  | "CHOPPY_ALTERNATING" // outcomes flipping with little persistence
  | "STRUCTURED_MIXED" // mixed but with some run structure (not pure noise)
  | "STABLE_STREAK"; // one uninterrupted direction throughout the sample

export type StabilityLabel = "STABLE" | "TRENDING" | "CHOPPY" | "VOLATILE";

export type EvidenceVerdict =
  | "INSUFFICIENT_SAMPLE"
  | "STAND_DOWN" // deteriorating / regime breaking — do not treat as edge
  | "WATCH" // interesting but not yet corroborated
  | "DEVELOPING_EDGE" // recovering / improving, not yet a confirmed regime
  | "CONFIRMED_EDGE"; // stable/distribution-like, aligned, no change point

export interface RollingWindowStat {
  window: number;
  /** Actual sample used — never larger than the available history. */
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Longest same-direction run inside this window. */
  longestStreak: number;
  /** + for a winning streak in progress, − for a losing streak in progress. */
  currentStreak: number;
}

export interface ChangePointResult {
  detected: boolean;
  /** Two-sample proportion z-statistic between the older and recent slices. */
  statistic: number;
  /** Rough two-sided confidence 0..100 that the shift is real, not noise. */
  confidence: number;
  earlierWinRate: number;
  recentWinRate: number;
  earlierN: number;
  recentN: number;
  note: string;
}

export interface StreakTransitionResult {
  transition: StreakTransition;
  /** The exact recent window inspected, oldest first, e.g. "LLLLWWWWW". */
  pattern: string;
  note: string;
}

export interface StabilityResult {
  label: StabilityLabel;
  /** 0..1 fraction of adjacent results that differ (flip rate). */
  alternationRate: number;
  /** Spread of win rate across the configured rolling windows, in pp. */
  windowSpreadPp: number;
  note: string;
}

export interface EvidenceProfile {
  regime: MarketStateRegime;
  verdict: EvidenceVerdict;
  confidence: number; // 0..100, bounded by sample size
  windows: RollingWindowStat[];
  streakTransition: StreakTransitionResult;
  stability: StabilityResult;
  changePoint: ChangePointResult;
  expectancy: number | null; // payout-adjusted, only when payout info supplied
  reasons: string[];
  summary: string;
}

export interface EvidenceEngineOptions {
  /** Rolling windows evaluated, e.g. [20, 50, 100, 200]. */
  windows?: number[];
  /** How many most-recent results the streak-transition detector inspects. */
  transitionLookback?: number;
  /** Net payout multiple on a win, used only to report expectancy (optional). */
  payoutOnWin?: number;
  /** Minimum resolved sample before any verdict beyond INSUFFICIENT_SAMPLE. */
  minSample?: number;
}

const DEFAULT_WINDOWS = [20, 50, 100, 200];
const DEFAULT_TRANSITION_LOOKBACK = 9;
const DEFAULT_MIN_SAMPLE = 12;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Longest run of the same outcome, and the signed streak still in progress. */
function streaksOf(results: SimOutcome[]): { longest: number; current: number } {
  if (!results.length) return { longest: 0, current: 0 };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < results.length; i++) {
    if (results[i] === results[i - 1]) {
      run++;
    } else {
      longest = Math.max(longest, run);
      run = 1;
    }
  }
  longest = Math.max(longest, run);

  // Current streak: trailing run at the end of the sequence, signed.
  let currentRun = 1;
  for (let i = results.length - 1; i > 0; i--) {
    if (results[i] === results[i - 1]) currentRun++;
    else break;
  }
  const sign = results[results.length - 1] === "WIN" ? 1 : -1;
  return { longest, current: currentRun * sign };
}

/**
 * ROLLING OUTCOME STATISTICS over multiple windows.
 * Lets the caller distinguish short-term movement (n=20) from the longer
 * baseline (n=200) instead of pooling everything into one number.
 */
export function rollingWindowStats(
  results: SimOutcome[],
  windows: number[] = DEFAULT_WINDOWS,
): RollingWindowStat[] {
  return windows.map((window) => {
    const slice = results.slice(-window);
    const n = slice.length;
    const wins = slice.filter((r) => r === "WIN").length;
    const { longest, current } = streaksOf(slice);
    return {
      window,
      n,
      wins,
      losses: n - wins,
      winRate: n ? wins / n : 0,
      longestStreak: longest,
      currentStreak: current,
    };
  });
}

/**
 * STREAK-TRANSITION DETECTOR.
 *
 * A streak is never a prediction — it is state information. This inspects
 * the most recent `lookback` results and classifies the SHAPE of movement,
 * not just its sign: "L L L L W W W W W" is a recovering regime, not simply
 * "5 wins → bullish", and "W W W W W L L L" is a deteriorating one, not
 * simply "3 losses → unlucky".
 */
export function detectStreakTransition(
  results: SimOutcome[],
  lookback: number = DEFAULT_TRANSITION_LOOKBACK,
): StreakTransitionResult {
  const slice = results.slice(-lookback);
  const pattern = slice.map((r) => (r === "WIN" ? "W" : "L")).join("");

  if (slice.length < 6) {
    return {
      transition: "NONE",
      pattern,
      note: "Too few resolved outcomes to classify a streak transition.",
    };
  }

  const half = Math.floor(slice.length / 2);
  const early = slice.slice(0, half);
  const late = slice.slice(half);
  const earlyWinRate = early.filter((r) => r === "WIN").length / early.length;
  const lateWinRate = late.filter((r) => r === "WIN").length / late.length;

  let alternations = 0;
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] !== slice[i - 1]) alternations++;
  }
  const alternationRate = alternations / (slice.length - 1);

  const allSame = slice.every((r) => r === slice[0]);
  if (allSame) {
    return {
      transition: "STABLE_STREAK",
      pattern,
      note: `Uninterrupted ${slice[0]} run across the last ${slice.length} resolutions — a single direction, not yet corroborated by a transition.`,
    };
  }

  if (alternationRate >= 0.6) {
    return {
      transition: "CHOPPY_ALTERNATING",
      pattern,
      note: `Outcomes flipping ${(alternationRate * 100).toFixed(0)}% of the time over the last ${slice.length} resolutions — no persistent direction.`,
    };
  }

  const delta = lateWinRate - earlyWinRate;
  if (delta >= 0.34) {
    return {
      transition: "LOSS_RECOVERING",
      pattern,
      note: `Loss-leaning window (${(earlyWinRate * 100).toFixed(0)}%) followed by a recovering window (${(lateWinRate * 100).toFixed(0)}%) — possible transition from unstable to improving.`,
    };
  }
  if (delta <= -0.34) {
    return {
      transition: "WIN_DETERIORATING",
      pattern,
      note: `Win-leaning window (${(earlyWinRate * 100).toFixed(0)}%) followed by a deteriorating window (${(lateWinRate * 100).toFixed(0)}%) — previously favourable behaviour may be breaking down.`,
    };
  }

  return {
    transition: "STRUCTURED_MIXED",
    pattern,
    note: `Mixed outcomes with partial run structure (alternation rate ${(alternationRate * 100).toFixed(0)}%) — not pure noise, not yet a clear transition.`,
  };
}

/**
 * CHOPPINESS / STABILITY ENGINE.
 *
 * Two sequences can share the same overall win rate and mean completely
 * different things: "W L W L W L W L" (choppy) vs "W W W W L W W W" (stable
 * with one dropped trade). This measures the flip rate plus how much the
 * rolling win rate disagrees across window sizes.
 */
export function classifyStability(
  results: SimOutcome[],
  windows: RollingWindowStat[],
): StabilityResult {
  const recent = results.slice(-Math.max(20, Math.min(results.length, 40)));
  let alternations = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] !== recent[i - 1]) alternations++;
  }
  const alternationRate = recent.length > 1 ? alternations / (recent.length - 1) : 0;

  const usable = windows.filter((w) => w.n >= 5);
  const rates = usable.map((w) => w.winRate);
  const spreadPp = rates.length ? (Math.max(...rates) - Math.min(...rates)) * 100 : 0;

  let label: StabilityLabel;
  let note: string;
  if (alternationRate >= 0.62) {
    label = "CHOPPY";
    note = `Recent outcomes alternate ${(alternationRate * 100).toFixed(0)}% of the time — low persistence, treat any single streak with caution.`;
  } else if (spreadPp >= 22) {
    label = "VOLATILE";
    note = `Win rate disagrees sharply across windows (spread ${spreadPp.toFixed(1)}pp) — short and long horizons are telling different stories.`;
  } else if (alternationRate <= 0.35 && spreadPp < 12) {
    label = "STABLE";
    note = `Outcomes are internally consistent across windows (spread ${spreadPp.toFixed(1)}pp, alternation ${(alternationRate * 100).toFixed(0)}%).`;
  } else {
    label = "TRENDING";
    note = `Outcomes show directional persistence without excessive noise (alternation ${(alternationRate * 100).toFixed(0)}%, spread ${spreadPp.toFixed(1)}pp).`;
  }

  return { label, alternationRate, windowSpreadPp: spreadPp, note };
}

/**
 * CHANGE-POINT DETECTION.
 *
 * Prevents Sentinel from pooling everything into one lifetime number after
 * something has actually changed (e.g. 68% lifetime, but the last 10 runs
 * look nothing like it). Two-sample proportion z-test between an "earlier"
 * slice and the most recent `recentN` results.
 */
export function detectChangePoint(
  results: SimOutcome[],
  recentN = 20,
  earlierN = 40,
): ChangePointResult {
  const recent = results.slice(-recentN);
  const earlierPool = results.slice(-(recentN + earlierN), -recentN);

  if (recent.length < 10 || earlierPool.length < 10) {
    return {
      detected: false,
      statistic: 0,
      confidence: 0,
      earlierWinRate: earlierPool.length
        ? earlierPool.filter((r) => r === "WIN").length / earlierPool.length
        : 0,
      recentWinRate: recent.length ? recent.filter((r) => r === "WIN").length / recent.length : 0,
      earlierN: earlierPool.length,
      recentN: recent.length,
      note: "Insufficient history on one or both sides to test for a change point.",
    };
  }

  const p1 = earlierPool.filter((r) => r === "WIN").length / earlierPool.length;
  const p2 = recent.filter((r) => r === "WIN").length / recent.length;
  const n1 = earlierPool.length;
  const n2 = recent.length;
  const pPooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));
  const z = se > 0 ? (p2 - p1) / se : 0;
  const absZ = Math.abs(z);

  // Rough two-sided confidence mapping (not a formal p-value table, just a
  // bounded, monotonic honesty signal): z≈1.64→~85, z≈1.96→~90, z≈2.58→~97.
  const confidence = clamp(Math.round(absZ * 33), 0, 99);
  const detected = absZ >= 1.96;

  return {
    detected,
    statistic: Math.round(z * 100) / 100,
    confidence,
    earlierWinRate: p1,
    recentWinRate: p2,
    earlierN: n1,
    recentN: n2,
    note: detected
      ? `Something changed: recent win rate ${(p2 * 100).toFixed(1)}% over N=${n2} differs from the prior ${(p1 * 100).toFixed(1)}% over N=${n1} (z=${z.toFixed(2)}). Treat the older pool as a separate regime rather than pooling it in.`
      : `No statistically confirmed change point yet (z=${z.toFixed(2)}); recent and prior win rates are not distinguishable at this sample size.`,
  };
}

/**
 * Build the full, auditable EVIDENCE PROFILE for one market/contract's
 * resolved-outcome history. This is the object the signal/decision engine
 * should read — never the raw sequence directly.
 */
export function buildEvidenceProfile(
  results: SimOutcome[],
  options: EvidenceEngineOptions = {},
): EvidenceProfile {
  const windows = options.windows ?? DEFAULT_WINDOWS;
  const minSample = options.minSample ?? DEFAULT_MIN_SAMPLE;
  const n = results.length;

  const windowStats = rollingWindowStats(results, windows);
  const streakTransition = detectStreakTransition(results, options.transitionLookback);
  const stability = classifyStability(results, windowStats);
  const changePoint = detectChangePoint(results);

  const shortWindow = windowStats[0] ?? { n: 0, winRate: 0 };
  const longWindow = windowStats[windowStats.length - 1] ?? { n: 0, winRate: 0 };
  const wins = results.filter((r) => r === "WIN").length;
  const lifetimeWinRate = n ? wins / n : 0;
  const expectancy =
    options.payoutOnWin && n
      ? (wins * options.payoutOnWin - (n - wins)) / n
      : options.payoutOnWin
        ? null
        : null;

  const reasons: string[] = [];
  let regime: MarketStateRegime = "INSUFFICIENT_SAMPLE";
  let verdict: EvidenceVerdict = "INSUFFICIENT_SAMPLE";
  let confidence = 0;

  if (n < minSample) {
    reasons.push(
      `Only ${n} resolved outcomes available (need ≥${minSample}) — evidence profile is not yet meaningful.`,
    );
  } else {
    reasons.push(streakTransition.note);
    reasons.push(stability.note);
    reasons.push(changePoint.note);

    // Statistical regime analogue — deliberately conservative labels.
    if (changePoint.detected && changePoint.recentWinRate < changePoint.earlierWinRate) {
      regime = "TRANSITION";
    } else if (stability.label === "CHOPPY") {
      regime = "CHOPPY";
    } else if (
      streakTransition.transition === "LOSS_RECOVERING" &&
      (stability.label === "STABLE" || stability.label === "TRENDING")
    ) {
      regime = "ACCUMULATION";
    } else if (
      streakTransition.transition === "WIN_DETERIORATING" ||
      (changePoint.detected && changePoint.recentWinRate < changePoint.earlierWinRate)
    ) {
      regime = "TRANSITION";
    } else if (
      (stability.label === "STABLE" || stability.label === "TRENDING") &&
      streakTransition.transition !== "CHOPPY_ALTERNATING" &&
      shortWindow.winRate >= longWindow.winRate - 0.05
    ) {
      regime = "DISTRIBUTION";
    } else if (stability.label === "VOLATILE") {
      regime = "TRANSITION";
    } else {
      regime = "ACCUMULATION";
    }

    // Verdict — the decision engine should treat this as advisory evidence,
    // never as the entry trigger itself.
    if (regime === "TRANSITION" || regime === "CHOPPY") {
      verdict = "STAND_DOWN";
      reasons.push("Regime evidence favours reduced confidence, not automatic entry.");
    } else if (streakTransition.transition === "LOSS_RECOVERING") {
      verdict = shortWindow.n >= minSample ? "DEVELOPING_EDGE" : "WATCH";
    } else if (streakTransition.transition === "STABLE_STREAK" && regime === "DISTRIBUTION") {
      verdict =
        longWindow.n >= minSample * 2 && !changePoint.detected
          ? "CONFIRMED_EDGE"
          : "DEVELOPING_EDGE";
    } else if (regime === "DISTRIBUTION" && !changePoint.detected) {
      verdict = longWindow.n >= minSample * 2 ? "CONFIRMED_EDGE" : "DEVELOPING_EDGE";
    } else {
      verdict = "WATCH";
    }

    // Confidence is bounded by sample size — a good-looking short window can
    // never claim high confidence on its own.
    const sampleConfidence = clamp(Math.round((Math.min(n, 200) / 200) * 70), 10, 70);
    const stabilityBonus =
      stability.label === "STABLE" ? 15 : stability.label === "TRENDING" ? 8 : 0;
    const changePenalty = changePoint.detected ? 20 : 0;
    confidence = clamp(sampleConfidence + stabilityBonus - changePenalty, 5, 95);
  }

  const summary =
    n < minSample
      ? `Evidence engine INSUFFICIENT_SAMPLE (N=${n}/${minSample}).`
      : `Regime ${regime} · Verdict ${verdict} · ${(shortWindow.winRate * 100).toFixed(1)}% over N=${shortWindow.n} vs ${(longWindow.winRate * 100).toFixed(1)}% over N=${longWindow.n} · lifetime ${(lifetimeWinRate * 100).toFixed(1)}% (N=${n}) · confidence ${confidence}/100.`;

  return {
    regime,
    verdict,
    confidence,
    windows: windowStats,
    streakTransition,
    stability,
    changePoint,
    expectancy,
    reasons,
    summary,
  };
}

// ── CONDITIONAL SIMULATION STATISTICS ───────────────────────────────────
//
// "How did this particular setup perform under this particular market
// state?" is far more valuable than the raw global simulator win rate.
// Callers own the historical records (e.g. mapped from apex/simulator's
// SimTrade[]) and only need to supply, per record, the outcome and a
// context signature describing the conditions at entry time (contract,
// psychology alignment, pressure direction, regime label, entry rule…).
// This module stays pure and storage-free: it does not persist anything.

export interface ConditionalRecord {
  result: SimOutcome;
  /** Stable signature describing the conditions present at entry time, e.g.
   *  "UNDER|GREEN:ODD|RED:EVEN|PRESSURE:UP:ODD|LOSING_SIDE:DECLINING|ENTRY:SUBSEQUENT_TOUCH|REGIME:STABLE" */
  contextKey: string;
}

export interface ConditionalStats {
  contextKey: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Wilson 95% lower bound — a small lucky sample cannot claim a strong edge. */
  lowerBound: number;
  tier: "NONE" | "THIN" | "DEVELOPING" | "USABLE";
  note: string;
}

function wilsonLowerBound(wins: number, n: number): number {
  if (!n) return 0;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

/**
 * Ask the historical simulation database: "when conditions looked like
 * THIS, what happened?" — scoped to an exact context signature.
 */
export function conditionalStats(
  records: ConditionalRecord[],
  contextKey: string,
): ConditionalStats {
  const matched = records.filter((r) => r.contextKey === contextKey);
  const n = matched.length;
  const wins = matched.filter((r) => r.result === "WIN").length;
  const winRate = n ? wins / n : 0;
  const lowerBound = wilsonLowerBound(wins, n);

  let tier: ConditionalStats["tier"] = "NONE";
  if (n >= 30) tier = "USABLE";
  else if (n >= 10) tier = "DEVELOPING";
  else if (n > 0) tier = "THIN";

  const note =
    n === 0
      ? `No historical record for this exact configuration ("${contextKey}").`
      : `Under this configuration, ${(winRate * 100).toFixed(1)}% over N=${n} (lower bound ${(lowerBound * 100).toFixed(1)}%) — ${tier}.`;

  return { contextKey, n, wins, losses: n - wins, winRate, lowerBound, tier, note };
}

/** Every distinct configuration observed so far, ranked by lower-bound edge. */
export function rankConditionalStats(records: ConditionalRecord[]): ConditionalStats[] {
  const keys = new Set(records.map((r) => r.contextKey));
  return [...keys]
    .map((k) => conditionalStats(records, k))
    .sort((a, b) => b.lowerBound - a.lowerBound || b.n - a.n);
}
