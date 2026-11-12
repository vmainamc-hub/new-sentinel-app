// PORTED from the Apex Sentinel tool (precisionapex6) apex/simulator.ts. Only the performance TYPES: Overlord has no live paper-trade ledger, so the engines that read it are given null.
export type SimTier = "NONE" | "THIN" | "EARLY" | "USABLE" | "MATURE" | "HIGH";

export type SimHealth =
  | "NO SAMPLE"
  | "INSUFFICIENT SAMPLE"
  | "DEVELOPING"
  | "VALIDATED"
  | "UNDERPERFORMING";

export interface SimPerformance {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  theoretical: number;
  edgePp: number;
  /** Wilson 95% lower bound on the observed contract win rate. */
  lower: number;
  upper: number;
  expectancy: number; // payout-adjusted P/L per stake unit
  netPnl: number;
  maxDrawdown: number;
  longestLosingStreak: number;
  longestWinningStreak: number;
  currentStreak: number; // + wins, − losses
  /** Win rate of the most recent 30 resolutions (−1 when unavailable). */
  rollingWinRate: number;
  /** rollingWinRate − winRate, in percentage points. Negative = deteriorating. */
  deteriorationPp: number;
  /** Most recent results, newest last. */
  recentResults: ("WIN" | "LOSS")[];
  tier: SimTier;
  health: SimHealth;
}
