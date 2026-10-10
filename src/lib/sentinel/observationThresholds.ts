/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OBSERVATION_THRESHOLDS
 *
 * Single named configuration object for all numeric thresholds governing
 * the Sentinel Observation Layer. Every threshold has an explicit comment
 * stating what it controls and why that value was chosen.
 */
export const OBSERVATION_THRESHOLDS = {
  // --- PERSISTENCE & TIMING THRESHOLDS ---

  /**
   * Minimum number of ticks observed before a proposition moves from WATCHING to INTERESTING.
   * Why: Prevents initial noisy cold-start ticks from triggering false interest.
   */
  MIN_TICKS_INTERESTING: 8,

  /**
   * Minimum number of ticks observed before a proposition can be considered DEVELOPING.
   * Why: Requires sufficient observation history to establish directional coherence.
   */
  MIN_TICKS_DEVELOPING: 15,

  /**
   * Number of consecutive supporting/qualified evaluation cycles required to reach CONFIRMING.
   * Why: Filters out transient single-tick spikes and requires sustained alignment across time.
   */
  REQUIRED_CONFIRMATION_TICKS: 3,

  /**
   * Minimum total observation age (in ticks) required before a proposition can transition to RIPE.
   * Why: RIPE requires proven temporal persistence; brief bursts must not immediately mature.
   */
  MIN_OBSERVATION_AGE_FOR_RIPE: 25,

  /**
   * Number of consecutive unqualified or deteriorating ticks that trigger state regression.
   * Why: Allows state to decay backwards cleanly when market conditions deteriorate.
   */
  TICKS_FOR_STATE_REGRESSION: 2,

  /**
   * Maximum history of state transitions preserved per observation cell.
   * Why: Keeps memory lightweight while preserving full recent causal context.
   */
  MAX_TRANSITION_HISTORY: 20,

  /**
   * Rolling snapshot window capacity for calculating longitudinal statistics.
   * Why: 30 snapshots capture ~30-60 seconds of tick progression for velocity & variance.
   */
  SNAPSHOT_WINDOW_CAPACITY: 30,

  // --- STABILITY & FLUCTUATION THRESHOLDS ---

  /**
   * Maximum standard deviation in scores to classify proposition stability as CALM.
   * Why: Scores fluctuating less than 3.0 points represent steady, calm market conditions.
   */
  MAX_STD_DEV_CALM: 3.0,

  /**
   * Maximum standard deviation in scores to classify proposition stability as STABLE.
   * Why: Scores fluctuating between 3.0 and 6.5 points represent normal, stable market noise.
   */
  MAX_STD_DEV_STABLE: 6.5,

  /**
   * Score standard deviation above which behaviour is classified as FLUCTUATING.
   * Why: Variations between 6.5 and 11.0 indicate oscillating short-term dynamics.
   */
  STD_DEV_FLUCTUATING_THRESHOLD: 6.5,

  /**
   * Score standard deviation above which behaviour is classified as CHOPPY or HIGHLY_UNSTABLE.
   * Why: Variations exceeding 11.0 indicate severe chop where edges cannot be trusted.
   */
  STD_DEV_UNSTABLE_THRESHOLD: 11.0,

  /**
   * Minimum positive score velocity (points per 10 observations) to classify as a DEVELOPING TREND.
   * Why: +1.5 points / 10 ticks confirms consistent upward momentum rather than flat noise.
   */
  MIN_POSITIVE_VELOCITY_TREND: 1.5,

  /**
   * Negative score velocity (points per 10 observations) indicating deteriorating trend.
   * Why: -2.0 points / 10 ticks indicates decaying pressure and requires caution.
   */
  NEGATIVE_VELOCITY_DETERIORATION: -2.0,

  // --- SCORE & DANGER GATES FOR STAGES ---

  /**
   * Minimum Sentinel final/opportunity score required to reach INTERESTING.
   * Why: 48 is slightly above baseline random expectation, indicating notable evidence.
   */
  MIN_SCORE_INTERESTING: 48,

  /**
   * Minimum Sentinel final/opportunity score required to reach DEVELOPING.
   * Why: 58 represents statistically positive directional agreement across multiple engines.
   */
  MIN_SCORE_DEVELOPING: 58,

  /**
   * Minimum Sentinel final/opportunity score required to reach CONFIRMING.
   * Why: 66 represents strong multi-engine agreement with confirmed edge.
   */
  MIN_SCORE_CONFIRMING: 66,

  /**
   * Minimum Sentinel final/opportunity score required to reach RIPE.
   * Why: 72 represents high-conviction maturity passing all core gates.
   */
  MIN_SCORE_RIPE: 72,

  /**
   * Maximum overall danger score tolerated to enter or maintain CONFIRMING.
   * Why: Danger scores >= 42 indicate elevated tail-risk, parity threats, or losing-side spikes.
   */
  MAX_DANGER_CONFIRMING: 42,

  /**
   * Maximum overall danger score tolerated for RIPE opportunity presentation.
   * Why: Danger >= 35 precludes presenting an opportunity to protect capital.
   */
  MAX_DANGER_RIPE: 35,

  /**
   * Danger score that immediately triggers UNSTABLE or STAND_DOWN regression.
   * Why: 55 represents severe market danger or rapid hostility.
   */
  DANGER_UNSTABLE_TRIGGER: 55,

  // --- CONTRADICTION & COHERENCE THRESHOLDS ---

  /**
   * Maximum number of material opposing factors permitted before state becomes CONFLICT.
   * Why: If 2 or more major engine outputs contradict the proposition, it cannot be trusted.
   */
  MAX_CONTRADICTIONS_FOR_DEVELOPING: 1,

  /**
   * Maximum material opposing factors tolerated for RIPE.
   * Why: RIPE requires zero material contradictions (all major streams aligned).
   */
  MAX_CONTRADICTIONS_FOR_RIPE: 0,

  // --- HIDDEN & ABNORMAL BEHAVIOR THRESHOLDS ---

  /**
   * Number of ticks since last appearance of an edge digit (0/9 for Under/Over) to flag as SUPPRESSED.
   * Why: In 1,000-tick uniform distributions, missing an edge digit for > 35 ticks is anomalous.
   */
  TICKS_EDGE_DIGIT_SUPPRESSED: 35,

  /**
   * Recent 20-tick frequency percentage for a low-baseline digit to flag as EMERGING_BURST.
   * Why: A digit with baseline < 8% appearing >= 25% of the last 20 ticks is a significant burst.
   */
  EMERGING_BURST_RECENT_PCT: 25.0,

  /**
   * Divergence in percentage points between 20-tick short window and 1,000-tick canonical baseline.
   * Why: > 7.5% divergence indicates short-term regime shift away from structural baseline.
   */
  SHORT_VS_LONG_DIVERGENCE_PCT: 7.5,

  // --- SIMULATION EVIDENCE THRESHOLDS ---

  /**
   * Minimum simulation sample size (trades) required before simulation is considered FAVOURABLE.
   * Why: Below 8 trades, win/loss counts are statistically thin and insufficient.
   */
  MIN_SIMULATION_SAMPLE_FOR_EVIDENCE: 8,

  /**
   * Win rate in recent simulation trades to classify simulation evidence as FAVOURABLE.
   * Why: >= 75% win rate over valid sample indicates active strategy edge in current regime.
   */
  SIMULATION_FAVOURABLE_WIN_RATE: 75.0,

  /**
   * Win rate in recent simulation trades to classify simulation as UNFAVOURABLE.
   * Why: <= 55% win rate indicates current regime is adverse to this proposition setup.
   */
  SIMULATION_UNFAVOURABLE_WIN_RATE: 55.0,
} as const;

export type ObservationThresholds = typeof OBSERVATION_THRESHOLDS;
