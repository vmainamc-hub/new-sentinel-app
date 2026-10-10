/**
 * SENTINEL — EXECUTION-READY (DBOT) GATE (§35)
 * ============================================
 * Additive 4-condition boolean gate for execution readiness.
 * Does not replace observation state (WATCHING, RIPE, VETOED, etc.).
 *
 * All 4 conditions must hold simultaneously:
 * 1. Structural direction settled (not CONFLICT/UNKNOWN), matches contract side,
 *    and contract direction score computed with spine wired in (not AGAINST).
 * 2. Danger is low (CALM or LOW) and isHardBlocked is false.
 * 3. Digit trend confirms side (MOST INCREASING in winning zone; MOST DECREASING is contextual evidence).
 * 4. Entry is armed (status is ARMED or ENTER NOW, confidence >= 60, zero unmet clearance requirements,
 *    verdict !== "BLOCKED").
 */

export interface ExecutionReadyInput {
  side: "OVER" | "UNDER";
  winners: number[];
  losers: number[];
  direction?: {
    label?: string;
    score?: number;
    spine?: {
      structuralDirection?: string;
      aligned?: boolean | null;
    } | null;
  } | null;
  structureDirection?: "OVER" | "UNDER" | "CONFLICT" | "UNKNOWN" | "NONE" | string | null;
  danger?: {
    level?: string;
    total?: number;
    isHardBlocked?: boolean;
    summary?: string;
  } | null;
  digitPsychology?: {
    mostIncreasing?: number | null;
    mostDecreasing?: number | null;
    canonicalState?: {
      mostIncreasing?: number | null;
      mostDecreasing?: number | null;
    } | null;
  } | null;
  canonicalState?: {
    mostIncreasing?: number | null;
    mostDecreasing?: number | null;
  } | null;
  entryPoint?: {
    status?: string;
    confidence?: number;
  } | null;
  entryClearance?: {
    verdict?: string;
    requirements?: Array<{ met: boolean; code?: string; label?: string; detail?: string }>;
  } | null;
}

export interface ExecutionReadyResult {
  executionReady: boolean;
  executionReadyReasons: string[];
  conditions: {
    structuralDirectionSettled: boolean;
    dangerLow: boolean;
    digitTrendConfirmed: boolean;
    entryArmed: boolean;
  };
}

export function evaluateExecutionReady(input: ExecutionReadyInput): ExecutionReadyResult {
  const reasons: string[] = [];

  // 1. Structural Direction Settled
  const structDir = input.structureDirection || input.direction?.spine?.structuralDirection || null;
  const isSettled = structDir === "OVER" || structDir === "UNDER";
  const matchesSide = structDir === input.side;
  const notAgainst = input.direction?.label !== "AGAINST" && (input.direction?.score ?? 1) > 0;

  const structuralDirectionSettled = Boolean(isSettled && matchesSide && notAgainst);
  if (!structuralDirectionSettled) {
    if (!isSettled) {
      reasons.push(`Structural direction not settled (${structDir || "UNKNOWN"}).`);
    } else if (!matchesSide) {
      reasons.push(
        `Contract side (${input.side}) conflicts with structural direction (${structDir}).`,
      );
    } else if (!notAgainst) {
      reasons.push(
        `Direction evaluation opposes contract (${input.direction?.label || "AGAINST"}).`,
      );
    }
  }

  // 2. Danger is Low
  const danger = input.danger;
  const dangerLevel = danger?.level ?? "CALM";
  const dangerHardBlocked = Boolean(danger?.isHardBlocked);
  const dangerLow = !dangerHardBlocked && (dangerLevel === "CALM" || dangerLevel === "LOW");

  if (!dangerLow) {
    if (dangerHardBlocked) {
      reasons.push(`Danger hard-blocked: ${danger?.summary || "critical risk active"}.`);
    } else {
      reasons.push(
        `Danger level elevated (${dangerLevel}, total score ${danger?.total ?? 0}/100).`,
      );
    }
  }

  // 3. Digit Trend Confirms the Side
  // Most-increasing digit gaining inside the winning zone confirms the directional trend.
  // The most-decreasing digit is contextual evidence (evaluating share decay across 0-9)
  // and is NOT a hard positional requirement to sit in the losing zone.
  const mostIncreasing =
    input.canonicalState?.mostIncreasing ??
    input.digitPsychology?.mostIncreasing ??
    input.digitPsychology?.canonicalState?.mostIncreasing ??
    null;

  const incInWinners = mostIncreasing !== null && input.winners.includes(mostIncreasing);
  const digitTrendConfirmed = Boolean(incInWinners);

  if (!digitTrendConfirmed) {
    if (mostIncreasing === null || !incInWinners) {
      reasons.push(
        `Digit trend unconfirmed: most increasing digit (${mostIncreasing ?? "none"}) is not in winning zone [${input.winners.join(", ")}].`,
      );
    }
  }

  // 4. Entry is Armed
  const entryPoint = input.entryPoint;
  const entryStatus = entryPoint?.status;
  const isArmedStatus = entryStatus === "ARMED" || entryStatus === "ENTER NOW";
  const entryConfidence = entryPoint?.confidence ?? 0;
  const isConfidenceOk = entryConfidence >= 60;

  const entryClearance = input.entryClearance;
  const isClearanceNotBlocked = entryClearance?.verdict !== "BLOCKED";
  const unmetReqs = input.entryClearance?.requirements?.filter((r) => !r.met) ?? [];
  const noUnmetReqs = unmetReqs.length === 0;

  const entryArmed = Boolean(
    isArmedStatus && isConfidenceOk && isClearanceNotBlocked && noUnmetReqs,
  );

  if (!entryArmed) {
    if (!isArmedStatus) {
      reasons.push(`Entry point not armed (status: ${entryStatus || "NOT_READY"}).`);
    }
    if (!isConfidenceOk) {
      reasons.push(`Entry confidence below threshold (${entryConfidence}/100 < 60).`);
    }
    if (!isClearanceNotBlocked || !noUnmetReqs) {
      const unmetDetail = unmetReqs
        .map((r) => r.label || r.code || r.detail || "unmet requirement")
        .join("; ");
      reasons.push(
        `Entry clearance not satisfied (${entryClearance?.verdict || "WAIT"}: ${unmetDetail || "blocked"}).`,
      );
    }
  }

  const executionReady = Boolean(
    structuralDirectionSettled && dangerLow && digitTrendConfirmed && entryArmed,
  );

  return {
    executionReady,
    executionReadyReasons: executionReady ? [] : reasons,
    conditions: {
      structuralDirectionSettled,
      dangerLow,
      digitTrendConfirmed,
      entryArmed,
    },
  };
}
