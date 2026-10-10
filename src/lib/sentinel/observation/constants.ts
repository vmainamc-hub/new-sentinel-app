/**
 * §2 — THE OBSERVATION UNIVERSE
 * Every Sentinel market x 6 propositions = one independent observation cell.
 * These lists are the single source of truth for cell identity and are derived
 * from the canonical Sentinel universe / contract specs so the Observation
 * Layer can never drift from the rest of the app.
 */
import { APEX_UNIVERSE_SYMBOLS } from "@/lib/apex/universe";
import type { ApexContractId } from "@/lib/apex/types";

export const MARKET_IDS: readonly string[] = APEX_UNIVERSE_SYMBOLS;

export type MarketId = string;

export const PROPOSITIONS = [
  "OVER1",
  "OVER2",
  "OVER3",
  "UNDER8",
  "UNDER7",
  "UNDER6",
] as const satisfies readonly ApexContractId[];

export type Proposition = ApexContractId;

/** Which side of the barrier a proposition belongs to — used by the momentum layer (§6). */
export function propositionSide(p: Proposition): "OVER" | "UNDER" {
  return p.startsWith("OVER") ? "OVER" : "UNDER";
}

/**
 * Stable cell identity: `${marketId}:${proposition}`.
 * This key MUST be used everywhere a cell is looked up, stored, or persisted.
 */
export type CellId = string;

export function cellId(marketId: MarketId, proposition: Proposition): CellId {
  return `${marketId}:${proposition}`;
}

export function parseCellId(id: CellId): { marketId: MarketId; proposition: Proposition } {
  const [marketId, proposition] = id.split(":") as [MarketId, Proposition];
  return { marketId, proposition };
}

/** All cell identities, generated once, in stable order. */
export const ALL_CELL_IDS: CellId[] = MARKET_IDS.flatMap((m) =>
  PROPOSITIONS.map((p) => cellId(m, p)),
);

// ---------------------------------------------------------------------------
// Tunable thresholds (§7.2 & §8). Nothing here recomputes engine math — these only
// govern how the Observation Layer interprets persistence/stability of the
// evidence it is handed.
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  /** Minimum Observation samples a directional read must hold before it can leave WATCHING. */
  MIN_OBSERVATION_SAMPLES_FOR_INTERESTING: 20,
  /** Minimum elapsed wall-clock milliseconds required before INTERESTING. */
  MIN_ELAPSED_MS_FOR_INTERESTING: 15_000,

  /** Minimum Observation samples of coherent evidence before DEVELOPING -> CONFIRMING. */
  MIN_OBSERVATION_SAMPLES_FOR_CONFIRMING: 60,
  /** Minimum elapsed wall-clock milliseconds before CONFIRMING. */
  MIN_ELAPSED_MS_FOR_CONFIRMING: 45_000,

  /** Minimum Observation samples of confirmed, veto-free evidence before CONFIRMING -> RIPE. */
  MIN_OBSERVATION_SAMPLES_FOR_RIPE: 90,
  /** Minimum elapsed wall-clock milliseconds before RIPE. */
  MIN_ELAPSED_MS_FOR_RIPE: 60_000,

  /** History sample window kept per cell for trend-vs-fluctuation analysis. */
  HISTORY_SAMPLE_WINDOW: 150,

  /** Consecutive contradictory sample reads required to force CONFLICT. */
  CONTRADICTION_SAMPLE_STREAK_FOR_CONFLICT: 3,

  /** Consecutive veto ticks required before early-stage cells (WATCHING/INTERESTING/DEVELOPING) transition to REJECTED. Advanced cells (RIPE/CONFIRMING) veto instantly. */
  VETO_SAMPLE_STREAK_FOR_REJECTION: 3,

  /** Consecutive clean sample reads required to recover out of CONFLICT/UNSTABLE. */
  RECOVERY_SAMPLE_STREAK: 5,

  /** Observation sample count of no supporting evidence before an unqualified RIPE decays. */
  DECAY_SAMPLES: 30,

  /** Samples fully idle before EXPIRED from DECAYING. */
  EXPIRE_SAMPLES: 90,
  /** Alias for sample expiration in observation cells (§8). */
  EXPIRE_OBSERVATION_SAMPLES: 90,

  /** Fixed execution window duration per §10. Do not make this configurable per-cell. */
  EXECUTION_WINDOW_MS: 90_000,

  /** Rolling window length for independent tick confirmation engine (§7.5). */
  TICK_CONFIRMATION_WINDOW: 20,
  /** Minimum sample floor before tick confirmation ratio is considered statistically valid. */
  TICK_CONFIRMATION_MIN_SAMPLES: 15,
  /** Ratio threshold required for high-conviction CONFIRMED status. */
  TICK_CONFIRMATION_RATIO_CONFIRMED: 0.85,
  /** Ratio threshold required for active CONFIRMING status. */
  TICK_CONFIRMATION_RATIO_CONFIRMING: 0.65,

  // Aliases preserved for backward compatibility
  MIN_TICKS_FOR_INTERESTING: 20,
  MIN_TICKS_FOR_CONFIRMING: 60,
  MIN_TICKS_FOR_RIPE: 90,
  HISTORY_WINDOW: 150,
  CONTRADICTION_STREAK_FOR_CONFLICT: 3,
  RECOVERY_STREAK: 5,
  DECAY_TICKS: 30,
  EXPIRE_TICKS: 90,
} as const;

/**
 * PHASE 15D — ANALYSIS VERSION.
 *
 * Part of the deterministic Sentinel observation identity. Bump this whenever
 * the analytical meaning of an evidence payload changes, so a re-analysis of
 * the SAME source tick under new mathematics is treated as a legitimately
 * distinct observation rather than a duplicate.
 */
export const ANALYSIS_VERSION = "phase-13-16.1";
