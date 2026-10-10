// APEX SENTINEL — Operator Surface Gate
// Ruthlessly qualifies candidates before allowing them to be surfaced to the operator.
// 90 cells remain continuously observed in the internal universe, but the operator surface requires all 9 gates.

import type { MarketIntel, RankedOpportunity } from "./types";
import type { AlertSnapshot } from "../sentinel/opportunity-alert";
import { OPERATOR_SURFACE_THRESHOLDS, type OperatorSurfaceThresholds } from "./operator-surface-thresholds";

export const STRUCTURAL_MIN_TICKS = OPERATOR_SURFACE_THRESHOLDS.minTicks;

export interface OperatorSurfaceGateOptions {
  minTicks?: number;
  maxDataAgeMs?: number;
  minScore?: number;
  maxDanger?: number;
  maxContradiction?: number;
  threatVetoThreshold?: number;
}

export interface OperatorSurfaceGateResult {
  qualified: boolean;
  surfaceState: "SURFACED" | "WATCH" | "HIDDEN";
  gateResults: {
    structuralMinTicks: boolean;
    dataFreshness: boolean;
    executionReady: boolean;
    fakeEdge: boolean;
    clearance: boolean;
    dangerThreshold: boolean;
    contradictionThreshold: boolean;
    opportunityScore: boolean;
    threatVetoStreak: boolean;
  };
  reasons: string[];
  blockers: string[];
}

export function operatorSurfaceGate(
  candidate: RankedOpportunity | AlertSnapshot | any,
  intel?: MarketIntel | any,
  options?: OperatorSurfaceGateOptions,
): OperatorSurfaceGateResult {
  if (!candidate) {
    return {
      qualified: false,
      surfaceState: "HIDDEN",
      gateResults: {
        structuralMinTicks: false,
        dataFreshness: false,
        executionReady: false,
        fakeEdge: false,
        clearance: false,
        dangerThreshold: false,
        contradictionThreshold: false,
        opportunityScore: false,
        threatVetoStreak: false,
      },
      reasons: [],
      blockers: ["NO_CANDIDATE_PROVIDED"],
    };
  }

  const minTicks = options?.minTicks ?? OPERATOR_SURFACE_THRESHOLDS.minTicks;
  const maxDataAgeMs = options?.maxDataAgeMs ?? OPERATOR_SURFACE_THRESHOLDS.maxDataAgeMs;
  const minScore = options?.minScore ?? OPERATOR_SURFACE_THRESHOLDS.minScore;
  const maxDanger = options?.maxDanger ?? OPERATOR_SURFACE_THRESHOLDS.maxDanger;
  const maxContradiction = options?.maxContradiction ?? OPERATOR_SURFACE_THRESHOLDS.maxContradiction;
  const threatVetoLimit = options?.threatVetoThreshold ?? OPERATOR_SURFACE_THRESHOLDS.threatVetoThreshold;

  const resolvedIntel = intel ?? candidate?.intel ?? null;
  const contract = candidate?.contract ?? null;
  const score =
    typeof candidate?.score === "number"
      ? candidate.score
      : typeof candidate?.opportunityScore === "number"
        ? candidate.opportunityScore
        : 0;

  // 1. Structural Minimum Ticks (>= 20)
  const getTickCount = (val: any) => (Array.isArray(val) ? val.length : typeof val === "number" ? val : 0);
  const ticksCount =
    getTickCount(resolvedIntel?.ticks) ||
    getTickCount(resolvedIntel?.digits) ||
    getTickCount(candidate?.intel?.ticks) ||
    getTickCount(candidate?.intel?.deepTicks) ||
    getTickCount(contract?.n) ||
    (typeof resolvedIntel?.ticks === "number" ? resolvedIntel.ticks : 0);
  const structuralMinTicks = ticksCount >= minTicks;

  // 2. Data Freshness (age <= 15000ms and not UNAVAILABLE/STALE)
  const dataAgeMs =
    resolvedIntel?.ageMs ??
    resolvedIntel?.lastTickAgeMs ??
    (resolvedIntel?.lastTickAt ? Math.max(0, Date.now() - resolvedIntel.lastTickAt) : (candidate?.dataAgeMs ?? 0));
  const dataState = resolvedIntel?.dataState ?? "OK";
  const dataFreshness = (dataState === "OK" || dataState === "ROBUST") && dataAgeMs <= maxDataAgeMs;

  // 3. Execution-Ready Gate
  const execReadyObj =
    candidate?.executionReady ??
    resolvedIntel?.entryClearance?.executionReady ??
    candidate?.entryClearance?.executionReady;
  const execReady =
    typeof execReadyObj === "boolean"
      ? execReadyObj
      : typeof execReadyObj?.ready === "boolean"
        ? execReadyObj.ready
        : false;

  // 4. Fake-Edge Interrogation (VALIDATED, or SUSPICIOUS if score >= 70, and never REJECTED)
  const fakeEdgeVerdict =
    contract?.fakeEdge?.verdict ?? candidate?.fakeEdgeVerdict ?? "VALIDATED";
  const fakeEdge =
    fakeEdgeVerdict !== "REJECTED" &&
    (fakeEdgeVerdict === "VALIDATED" ||
      (fakeEdgeVerdict === "SUSPICIOUS" && score >= OPERATOR_SURFACE_THRESHOLDS.fakeEdgeSuspiciousScoreFloor));

  // 5. Entry Clearance (CLEARED / EXECUTE / cleared === true)
  const clearanceObj =
    candidate?.entryClearance ??
    resolvedIntel?.entryClearance ??
    candidate?.clearance ??
    resolvedIntel?.clearance;
  const clearanceVerdict = clearanceObj?.verdict ?? "CLEARED";
  const clearanceCleared =
    clearanceObj?.cleared ??
    (clearanceVerdict === "CLEARED" || clearanceVerdict === "EXECUTE");
  const clearance = (clearanceVerdict === "CLEARED" || clearanceVerdict === "EXECUTE") && clearanceCleared === true;

  // 6. Danger Threshold (<= 45 and not hard blocked)
  const dangerVal =
    typeof candidate?.danger === "number"
      ? candidate.danger
      : typeof candidate?.dangerScore === "number"
        ? candidate.dangerScore
        : typeof candidate?.danger?.total === "number"
          ? candidate.danger.total
          : typeof contract?.danger === "number"
            ? contract.danger
            : 0;
  const dangerHardBlocked = Boolean(
    candidate?.danger?.isHardBlocked || candidate?.dangerComposition?.isHardBlocked,
  );
  const dangerThreshold = dangerVal <= maxDanger && !dangerHardBlocked;

  // 7. Contradiction Threshold (<= 40%)
  const contradictionVal =
    typeof candidate?.contradiction === "number"
      ? candidate.contradiction
      : typeof candidate?.contradictionScore === "number"
        ? candidate.contradictionScore
        : typeof candidate?.contradiction?.total === "number"
          ? candidate.contradiction.total
          : typeof contract?.contradiction === "number"
            ? contract.contradiction
            : 0;
  const contradictionThreshold = contradictionVal <= maxContradiction;

  // 8. Opportunity Score (>= 65)
  const opportunityScore = score >= minScore;

  // 9. Active Threat Veto Streak
  const groupThreat =
    contract?.threat?.groupThreat ?? candidate?.threat?.groupThreat ?? 0;
  const threatVetoThreshold = contract?.threatVeto ?? threatVetoLimit;
  const isHardVetoed = Boolean(
    candidate?.blocked ||
      candidate?.veto?.hard ||
      candidate?.vetoResolution?.isHardBlocked ||
      candidate?.vetoResolution?.isVetoed,
  );
  const threatVetoStreak = groupThreat < threatVetoThreshold && !isHardVetoed;

  const gateResults = {
    structuralMinTicks,
    dataFreshness,
    executionReady: execReady,
    fakeEdge,
    clearance,
    dangerThreshold,
    contradictionThreshold,
    opportunityScore,
    threatVetoStreak,
  };

  const blockers: string[] = [];
  const reasons: string[] = [];

  if (!structuralMinTicks) {
    blockers.push(`STRUCTURAL_MIN_TICKS_NOT_MET (${ticksCount}/${minTicks} ticks)`);
  } else {
    reasons.push(`Structural ticks satisfied (${ticksCount} ticks)`);
  }

  if (!dataFreshness) {
    blockers.push(`DATA_FRESHNESS_FAILED (State: ${dataState}, Age: ${dataAgeMs}ms)`);
  } else {
    reasons.push(`Data feed live & fresh (${dataAgeMs}ms)`);
  }

  if (!execReady) {
    const detail =
      Array.isArray(candidate?.executionReadyReasons) &&
      candidate.executionReadyReasons.length > 0
        ? candidate.executionReadyReasons.join("; ")
        : "Execution-ready gate conditions unfulfilled";
    blockers.push(`EXECUTION_READY_FAILED (${detail})`);
  } else {
    reasons.push("Execution ready gate passed");
  }

  if (!fakeEdge) {
    blockers.push(`FAKE_EDGE_REJECTED (${fakeEdgeVerdict})`);
  } else {
    reasons.push(`Fake-edge interrogation passed (${fakeEdgeVerdict})`);
  }

  if (!clearance) {
    blockers.push(`CLEARANCE_BLOCKED (${clearanceVerdict})`);
  } else {
    reasons.push("Entry clearance granted");
  }

  if (!dangerThreshold) {
    blockers.push(`DANGER_EXCEEDED (Danger: ${dangerVal.toFixed(0)}, Limit: ${maxDanger})`);
  } else {
    reasons.push(`Danger within tolerance (${dangerVal.toFixed(0)} <= ${maxDanger})`);
  }

  if (!contradictionThreshold) {
    blockers.push(`CONTRADICTION_EXCEEDED (${contradictionVal.toFixed(0)}% > ${maxContradiction}%)`);
  } else {
    reasons.push(`Contradiction acceptable (${contradictionVal.toFixed(0)}%)`);
  }

  // Setup grade check if explicitly specified on candidate
  if (candidate?.setup?.grade === "POOR" || candidate?.setupQuality === "POOR") {
    blockers.push("POOR SETUP GRADE (Setup quality unusable)");
  }

  // Structural direction check if explicitly conflicting
  if (
    candidate?.direction &&
    candidate?.structuralDirection &&
    candidate.direction !== candidate.structuralDirection
  ) {
    blockers.push(`STRUCTURAL_DIRECTION_CONFLICT (${candidate.direction} vs structural ${candidate.structuralDirection})`);
  }

  if (!opportunityScore) {
    blockers.push(`OPPORTUNITY_SCORE_TOO_LOW (${score.toFixed(1)} < ${minScore})`);
  } else {
    reasons.push(`Opportunity score qualified (${score.toFixed(1)})`);
  }

  if (!threatVetoStreak) {
    blockers.push(
      `THREAT_VETO_ACTIVE (Losing group threat: ${groupThreat.toFixed(0)}${isHardVetoed ? ", Hard veto active" : ""})`,
    );
  } else {
    reasons.push("Threat veto clear");
  }

  const qualified = Object.values(gateResults).every(Boolean);

  let surfaceState: "SURFACED" | "WATCH" | "HIDDEN" = "HIDDEN";
  if (qualified) {
    surfaceState = "SURFACED";
  } else if (
    score >= OPERATOR_SURFACE_THRESHOLDS.watchScoreFloor &&
    !isHardVetoed &&
    fakeEdgeVerdict !== "REJECTED" &&
    dangerVal <= OPERATOR_SURFACE_THRESHOLDS.watchDangerCeiling
  ) {
    surfaceState = "WATCH";
  }

  return {
    qualified,
    surfaceState,
    gateResults,
    reasons,
    blockers,
  };
}

export const evaluateOperatorSurfaceGate = operatorSurfaceGate;
