/**
 * RISK — CIRCUIT BREAKER.
 *
 * Session-level kill switch. It watches consecutive losses, session drawdown,
 * and sustained global danger; when any threshold trips it holds every new
 * candidate and starts a cooldown.
 */

import type { CircuitBreakerState } from "@/types/sentinel";

export const MAX_CONSECUTIVE_LOSSES = 4;
export const MAX_SESSION_DRAWDOWN_PCT = 12;
export const MAX_SUSTAINED_DANGER = 80;
export const COOLDOWN_MS = 15 * 60 * 1000;

export interface CircuitBreakerInputs {
  consecutiveLosses?: number;
  sessionDrawdownPct?: number;
  sustainedGlobalDanger?: number;
  now?: number;
  /** Existing cooldown deadline, if a previous evaluation tripped. */
  cooldownUntil?: number | null;
}

export function idleCircuitBreaker(): CircuitBreakerState {
  return {
    tripped: false,
    reason: null,
    consecutiveLosses: 0,
    sessionDrawdownPct: 0,
    sustainedGlobalDanger: 0,
    cooldownUntil: null,
  };
}

export class CircuitBreakerEngine {
  public static evaluate(input: CircuitBreakerInputs = {}): CircuitBreakerState {
    const now = input.now ?? Date.now();
    const consecutiveLosses = Math.max(0, input.consecutiveLosses ?? 0);
    const sessionDrawdownPct = Math.max(0, input.sessionDrawdownPct ?? 0);
    const sustainedGlobalDanger = Math.max(0, input.sustainedGlobalDanger ?? 0);

    const reasons: string[] = [];
    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES)
      reasons.push(
        `${consecutiveLosses} consecutive losses (limit ${MAX_CONSECUTIVE_LOSSES})`,
      );
    if (sessionDrawdownPct >= MAX_SESSION_DRAWDOWN_PCT)
      reasons.push(
        `session drawdown ${sessionDrawdownPct.toFixed(1)}% (limit ${MAX_SESSION_DRAWDOWN_PCT}%)`,
      );
    if (sustainedGlobalDanger >= MAX_SUSTAINED_DANGER)
      reasons.push(
        `sustained global danger ${sustainedGlobalDanger.toFixed(0)}/100 (limit ${MAX_SUSTAINED_DANGER})`,
      );

    const inExistingCooldown = !!input.cooldownUntil && input.cooldownUntil > now;
    const tripped = reasons.length > 0 || inExistingCooldown;

    return {
      tripped,
      reason: reasons.length
        ? `Trading halted: ${reasons.join("; ")}.`
        : inExistingCooldown
          ? `Cooldown active until ${new Date(input.cooldownUntil!).toLocaleTimeString()}.`
          : null,
      consecutiveLosses,
      sessionDrawdownPct,
      sustainedGlobalDanger,
      cooldownUntil: reasons.length
        ? now + COOLDOWN_MS
        : inExistingCooldown
          ? input.cooldownUntil!
          : null,
    };
  }
}
