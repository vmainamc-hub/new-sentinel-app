// ── Bot ground truth ────────────────────────────────────────────────────────
// Extracted verbatim from the DBot XML
// `Precision_Percentage_Bot_V6_CONTINUOUS_SAFE_FIXED_v4`.
// This file is the single source of truth for the bot's rules. No other module
// may invent a barrier, a threshold or a martingale factor.

export type BotDirection = "OVER" | "UNDER" | "WAIT";
export type BotLeg = "fresh" | "recovery";
export type BotBarrier = 2 | 3 | 6 | 7;
export type EquilibriumBand = "PERFECT" | "PRIME" | "ACCEPTABLE" | "DRIFTING" | "BROKEN";
export type BotVerdict = "BOT_ON" | "BOT_STANDBY" | "BOT_OFF";

export const BOT_SPEC = {
  /** Symbol the bot is configured for. */
  symbol: "R_100",
  /** The bot inspects only the last N digits. */
  ticksAnalyzed: 6,
  /** High Digit % threshold that triggers OVER. */
  highPctThreshold: 60,
  /** Low Digit % threshold that triggers UNDER. */
  lowPctThreshold: 60,
  /** Stake multiplier applied on every consecutive loss. */
  martingaleFactor: 1.5,
  /** Cool-down ticks between contracts. */
  waitTicks: 2,
  /** Barrier map — fresh entries (CountLoss === 0). */
  fresh: { OVER: 2 as BotBarrier, UNDER: 7 as BotBarrier },
  /** Barrier map — recovery entries (CountLoss >= 1). */
  recovery: { OVER: 3 as BotBarrier, UNDER: 6 as BotBarrier },
  /** Theoretical win probability of each barrier the bot can trade. */
  theory: { 2: 0.7, 3: 0.6, 6: 0.6, 7: 0.7 } as Record<BotBarrier, number>,
  /** Approximate profit fraction of stake per barrier (Deriv digit payouts). */
  payout: { 2: 0.36, 3: 0.6, 6: 0.6, 7: 0.36 } as Record<BotBarrier, number>,
} as const;

/** Which leg the bot is in for a given consecutive-loss count. */
export function legFor(countLoss: number): BotLeg {
  return countLoss <= 0 ? "fresh" : "recovery";
}

/**
 * The bot's barrier map — the ONLY place a barrier may come from.
 * fresh: OVER 2 / UNDER 7 · recovery: OVER 3 / UNDER 6.
 */
export function barrierFor(direction: "OVER" | "UNDER", leg: BotLeg): BotBarrier {
  return leg === "fresh" ? BOT_SPEC.fresh[direction] : BOT_SPEC.recovery[direction];
}

/** Does a digit win the given contract? Deriv semantics: strict over / strict under. */
export function digitWins(
  digit: number,
  direction: "OVER" | "UNDER",
  barrier: BotBarrier,
): boolean {
  return direction === "OVER" ? digit > barrier : digit < barrier;
}

/** Replays the bot's own 6-tick trigger over a digit window. Pure. */
export function botTrigger(
  digits: number[],
  ticksAnalyzed: number = BOT_SPEC.ticksAnalyzed,
): {
  direction: BotDirection;
  highPct: number;
  lowPct: number;
  highCount: number;
  samples: number;
} {
  const win = digits.slice(-ticksAnalyzed);
  const samples = win.length;
  if (samples === 0) return { direction: "WAIT", highPct: 0, lowPct: 0, highCount: 0, samples: 0 };
  const highCount = win.filter((d) => d >= 5).length;
  const highPct = (highCount / samples) * 100;
  const lowPct = 100 - highPct;
  const direction: BotDirection =
    highPct >= BOT_SPEC.highPctThreshold
      ? "OVER"
      : lowPct >= BOT_SPEC.lowPctThreshold
        ? "UNDER"
        : "WAIT";
  return { direction, highPct, lowPct, highCount, samples };
}
