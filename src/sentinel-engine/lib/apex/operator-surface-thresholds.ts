// APEX SENTINEL — Authoritative Operator Surface Thresholds
// Single Source of Truth for all qualification, safety, quality, freshness, and structural gates.

export interface OperatorSurfaceThresholds {
  /**
   * 1. STRUCTURAL_MIN_TICKS
   * Controls: Minimum ticks required in the canonical market history before structural analysis is eligible.
   * Why: Prevents cold-start artifacts and premature structural conclusions on nascent streams.
   * Boundary: STRUCTURAL boundary.
   */
  readonly minTicks: number;

  /**
   * 2. MAX_DATA_AGE_MS
   * Controls: Maximum allowable elapsed time (in ms) since the last tick before the stream is treated as stale.
   * Why: Real-time Deriv digit analysis becomes misleading if the socket feed is paused or disconnected.
   * Boundary: FRESHNESS boundary.
   */
  readonly maxDataAgeMs: number;

  /**
   * 3. MIN_OPPORTUNITY_SCORE
   * Controls: Minimum holistic composite opportunity score required for operator surface qualification.
   * Why: Separates background radar candidates from actionable high-conviction setups.
   * Boundary: QUALIFICATION boundary.
   */
  readonly minScore: number;

  /**
   * 4. MAX_DANGER
   * Controls: Ceiling on total composite danger score (0-100 scale).
   * Why: Hard risk containment; prevents capital exposure when market entropy or danger factors are elevated.
   * Boundary: SAFETY boundary.
   */
  readonly maxDanger: number;

  /**
   * 5. MAX_CONTRADICTION_PERCENT
   * Controls: Maximum allowable contradiction percentage (0-100%) from opposing engines or signals.
   * Why: Preserves confluence; setups with heavy cross-engine conflict (>40%) suffer degraded empirical expectancy.
   * Boundary: QUALITY boundary.
   */
  readonly maxContradiction: number;

  /**
   * 6. THREAT_VETO_THRESHOLD
   * Controls: Losing group digit threat score ceiling.
   * Why: If losing digits build critical mass (>=65), trade failure risk spikes significantly.
   * Boundary: SAFETY boundary.
   */
  readonly threatVetoThreshold: number;

  /**
   * 7. WATCH_SCORE_FLOOR
   * Controls: Minimum composite score required to elevate a non-qualified setup to "WATCH" status on the radar.
   * Why: Distinguishes developing setups worth observing on the radar from cold/hidden cells.
   * Boundary: QUALIFICATION boundary.
   */
  readonly watchScoreFloor: number;

  /**
   * 8. WATCH_DANGER_CEILING
   * Controls: Maximum danger score permitted for a candidate to maintain "WATCH" status on the radar.
   * Why: Prevents dangerous, toxic market states from cluttering the developing radar view.
   * Boundary: SAFETY boundary.
   */
  readonly watchDangerCeiling: number;

  /**
   * 9. FAKE_EDGE_SUSPICIOUS_SCORE_FLOOR
   * Controls: Minimum score required for a SUSPICIOUS fake-edge classification to remain eligible for consideration.
   * Why: Weak setups with unverified statistical edge are blocked, whereas high-scoring setups undergo strict validation.
   * Boundary: QUALITY boundary.
   */
  readonly fakeEdgeSuspiciousScoreFloor: number;

  /**
   * 10. MULTIPLE_TESTING_N_HYPOTHESES
   * Controls: The number of simultaneous candidate hypotheses evaluated across the 15-market x 6-contract universe.
   * Why: 90 simultaneous tests require statistical penalization to prevent false discoveries from random chance.
   * Boundary: STATISTICAL DISCIPLINE boundary.
   */
  readonly multipleTestingHypotheses: number;

  /**
   * 11. MIN_RESOLVED_COMBINATION_N
   * Controls: Minimum resolved historical sample size required before empirical combination evidence is validated.
   * Why: Small-sample statistical noise must not be mistaken for proven edge.
   * Boundary: STATISTICAL DISCIPLINE boundary.
   */
  readonly minResolvedComboN: number;
}

export const OPERATOR_SURFACE_THRESHOLDS: OperatorSurfaceThresholds = {
  minTicks: 20,
  maxDataAgeMs: 15000,
  minScore: 65,
  maxDanger: 45,
  maxContradiction: 40,
  threatVetoThreshold: 65,
  watchScoreFloor: 50,
  watchDangerCeiling: 60,
  fakeEdgeSuspiciousScoreFloor: 70,
  multipleTestingHypotheses: 90,
  minResolvedComboN: 12,
} as const;
