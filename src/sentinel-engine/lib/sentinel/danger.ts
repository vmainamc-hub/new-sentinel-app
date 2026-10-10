// SENTINEL — DANGER COMPOSITION ENGINE.
//
// Danger is an aggregate composed of clearly identified, individually bounded
// risk components — not an opaque score. Every point of danger has a named
// source, an audited reason, and a specific severity.
//
// AUTO_BLOCK components flag the candidate down regardless of its opportunity
// score, for objective, safety-critical faults (e.g. latency breach,
// extreme sample shortage, structural regime collapse, hostile takeover).

import type { DigitIntel } from "../apex/digit-intel";
import type {
  MarketSymbol,
  ContractType,
  CanonicalDigitState,
  MarketRegime,
} from "../../types/sentinel";
import type { LosingSidePressure } from "./losing-side-pressure";
import type { DirectionalMomentum } from "./winning-side-momentum";
import type { PercentageCompetition } from "./price-action-psychology";
import type { RedSemantics } from "./red-semantics";

export type DangerSeverity = "MILD" | "MODERATE" | "HIGH" | "SEVERE" | "AUTO_BLOCK";

export interface DangerComponent {
  code: string;
  label: string;
  severity: DangerSeverity;
  /** Points contributed to the danger score (0..100). */
  points: number;
  /** Concrete measured value (e.g. "1,840ms", "N=12", "0.78pp/100"). */
  value: string;
  detail: string;
  isAutoBlock: boolean;
  measuredValue: string | number;
}

export interface DangerComposition {
  total: number;
  level: "CALM" | "LOW" | "ELEVATED" | "HIGH" | "CRITICAL";
  components: DangerComponent[];
  autoBlock: DangerComponent[];
  severe: DangerComponent[];
  summary: string;
  overallDangerScore: number;
  isHardBlocked: boolean;
  dangerFactor: number;
}

export interface ContractShape {
  label: string;
  side: "OVER" | "UNDER";
  barrier: number;
  winners: number[];
  losers?: number[];
}

export interface DangerInputs {
  intel?: (DigitIntel & { regime?: any; specialDigits?: any; [key: string]: any }) | any | null;
  contract: ContractShape;
  lifetimeTicks?: number;
  recentLatencyMs?: number;
  losingSideHostile?: boolean;
  consecutiveLosses?: number;
  regimeBreak?: boolean;

  // Extended engine integration parameters
  losingSidePressure?: LosingSidePressure | any;
  pressure?: any;
  psychology?: any;
  entryPoint?: any;
  simulation?: any;
  regime?: any;
  specialRisk?: any;
  buildup?: any;
  lifetime?: any;
  recent?: any;
  timeframeConflict?: boolean;

  // ── PHASE 13/14/15 INTEGRATION ────────────────────────────────────────
  /**
   * PHASE 13 — directional momentum (winning/losing/relative/reversal).
   * Adverse momentum RAISES danger. Favourable momentum contributes ZERO
   * points: momentum is supporting evidence and can never lower danger or
   * cancel a structural veto.
   */
  momentum?: DirectionalMomentum | null;
  /**
   * PHASE 14 — quantified winning-vs-losing percentage competition.
   * Contributes graded points; a CRITICAL contest is safety-critical.
   */
  competition?: PercentageCompetition | null;
  /**
   * PHASE 15A — RED / 2ND RED classification. FATAL is handled by the
   * psychology hard block; STRUCTURAL_CONFLICT lands here as graded danger.
   */
  redSemantics?: RedSemantics | null;
  /**
   * PHASE 15B — pre-composition contract risk scalar (exposure, threat and
   * special-digit risk already measured upstream in apex/contracts.ts and
   * apex/core.ts). Folded in as a NAMED component so the composition is the
   * single authoritative danger value and no upstream evidence is discarded.
   */
  contractRiskScalar?: number | null;
}

const SENSITIVE_DIGITS = [0, 1, 8, 9];

function levelOf(total: number, autoBlock: boolean): DangerComposition["level"] {
  if (autoBlock || total >= 70) return "CRITICAL";
  if (total >= 50) return "HIGH";
  if (total >= 30) return "ELEVATED";
  if (total >= 15) return "LOW";
  return "CALM";
}

export function composeDanger(
  first: DangerInputs | MarketSymbol | string,
  second?: ContractType | ContractShape | any,
  third?: CanonicalDigitState | any,
  fourth?: LosingSidePressure | any,
  fifth?: MarketRegime | string,
  sixth?: number,
  seventh?: number,
): DangerComposition {
  // Check if called with legacy positional signature
  if (typeof first === "string" && second && third) {
    const contract = second as ContractType;
    const canonicalState = third as CanonicalDigitState;
    const losingSide = fourth;
    const regime = fifth;
    const recentConsecutiveLosses = sixth ?? 0;
    const latencyMs = seventh ?? 150;

    const isOver = contract.startsWith("OVER");
    const barrier = parseInt(contract.split("_")[1] || "2", 10);
    const winners = isOver
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d > barrier)
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d < barrier);

    const input: DangerInputs = {
      intel: null,
      contract: {
        label: contract,
        side: isOver ? "OVER" : "UNDER",
        barrier,
        winners,
      },
      lifetimeTicks: (canonicalState as any)?.totalTicks ?? (canonicalState as any)?.n ?? 1000,
      recentLatencyMs: latencyMs,
      losingSideHostile: losingSide?.state === "HOSTILE" || losingSide?.pressureLevel === "HOSTILE",
      losingSidePressure: losingSide,
      consecutiveLosses: recentConsecutiveLosses,
      regimeBreak: regime === "CHAOTIC" || regime === "UNSTABLE",
    };
    return evaluateDanger(input);
  }

  return evaluateDanger(first as DangerInputs);
}

function evaluateDanger(input: DangerInputs): DangerComposition {
  const components: DangerComponent[] = [];

  const addComp = (
    c: Omit<DangerComponent, "isAutoBlock" | "measuredValue"> & {
      isAutoBlock?: boolean;
      measuredValue?: string | number;
    },
  ) => {
    components.push({
      ...c,
      isAutoBlock: c.isAutoBlock ?? c.severity === "AUTO_BLOCK",
      measuredValue: c.measuredValue ?? c.value,
    });
  };

  const ticks =
    input.lifetimeTicks ??
    (input.intel as any)?.ticks ??
    (input.intel as any)?.lifetimeTicks ??
    (input.intel as any)?.totalTicks ??
    1000;

  // 1. Data maturity — sample size verification
  if (ticks < 150) {
    addComp({
      code: "INSUFFICIENT_SAMPLE",
      label: "Insufficient sample size",
      severity: ticks < 60 ? "AUTO_BLOCK" : "HIGH",
      points: ticks < 60 ? 35 : 18,
      value: `N=${ticks}`,
      detail:
        ticks < 60
          ? `Sample (${ticks} ticks) is below the hard safety floor (60 ticks).`
          : `Sample is young (${ticks} ticks, < 150 recommended).`,
    });
  } else if (ticks < 500) {
    addComp({
      code: "MODERATE_SAMPLE",
      label: "Young observation sample",
      severity: "MILD",
      points: 6,
      value: `N=${ticks}`,
      detail: `Sample (${ticks} ticks) is developing towards canonical 1,000-tick window.`,
    });
  }

  // 2. Latency breach
  const latency =
    input.recentLatencyMs ??
    (input.intel as any)?.latencyMs ??
    (input.intel as any)?.recentLatencyMs;

  if (latency !== undefined && latency > 600) {
    const severe = latency > 1200;
    addComp({
      code: "LATENCY_BREACH",
      label: "Execution latency degraded",
      severity: severe ? "AUTO_BLOCK" : "HIGH",
      points: severe ? 30 : 15,
      value: `${latency}ms`,
      detail: `Feed latency (${latency}ms) exceeds the ${severe ? "1200ms auto-block threshold" : "600ms safety margin"}.`,
    });
  }

  // 3. Sensitive digit velocity against contract
  if (input.intel) {
    const winners = new Set(input.contract.winners);
    const profiles =
      (input.intel as any)?.digitIntel?.profiles ?? (input.intel as any)?.profiles ?? null;
    if (profiles) {
      for (const d of SENSITIVE_DIGITS) {
        if (winners.has(d)) continue; // only dangerous if this sensitive digit makes us LOSE
        const prof = profiles[d];
        if (!prof) continue;
        if (prof.velocity > 0.45 && prof.momentum > 4) {
          addComp({
            code: `SENSITIVE_LOSER_VELOCITY_${d}`,
            label: `Sensitive losing digit ${d} accelerating`,
            severity: prof.velocity > 0.75 ? "SEVERE" : "MODERATE",
            points: prof.velocity > 0.75 ? 16 : 8,
            value: `+${(prof.velocity * 100).toFixed(1)}pp/100`,
            detail: `Sensitive edge digit ${d} is losing for this contract but gaining velocity rapidly.`,
          });
        }
      }
    }
  }

  // 4. Losing side hostility & pressure engine
  const lsp = input.losingSidePressure;
  const isHostile =
    input.losingSideHostile || lsp?.state === "HOSTILE" || lsp?.pressureLevel === "HOSTILE";
  if (isHostile) {
    addComp({
      code: "LOSING_SIDE_HOSTILE",
      label: "Losing side hostility elevated",
      severity: lsp?.verdict === "SUPPRESS" ? "AUTO_BLOCK" : "SEVERE",
      points: lsp?.verdict === "SUPPRESS" ? 30 : lsp ? 20 : 12,
      value: "HOSTILE",
      detail: "Aggregated losing-side digits are in a hostile expanding state.",
    });
  } else if (lsp?.state === "PRESSURED" || (lsp?.risingCount && lsp.risingCount >= 2)) {
    addComp({
      code: "LOSING_SIDE_PRESSURED",
      label: "Losing side pressure building",
      severity: "MODERATE",
      points: 12,
      value: `${lsp.risingCount ?? 2} rising digits`,
      detail: "Multiple losing-side digits are rising simultaneously.",
    });
  }

  // 5. Consecutive simulated loss run
  const consecutiveLosses = input.consecutiveLosses ?? input.recent?.consecutiveLosses ?? 0;
  if (consecutiveLosses >= 2) {
    const auto = consecutiveLosses >= 4;
    addComp({
      code: "CONSECUTIVE_LOSSES",
      label: "Recent simulated loss streak",
      severity: auto ? "AUTO_BLOCK" : "SEVERE",
      points: auto ? 28 : consecutiveLosses * 7,
      value: `${consecutiveLosses} losses`,
      detail: `${consecutiveLosses} consecutive simulated losses on this contract recently.`,
    });
  }

  // 6. Regime break & compatibility
  const regimeReport = input.regime?.regimeReport ?? input.regime?.raw?.regimeReport;
  const regimeObj = input.regime?.regime ?? input.regime?.raw?.regime ?? input.intel?.regime;
  const regimeBreak =
    input.regimeBreak ||
    regimeReport?.isChanging ||
    regimeReport?.cusumDetected ||
    regimeReport?.phDetected;

  if (regimeBreak) {
    addComp({
      code: "REGIME_BREAK",
      label: "Statistical regime break detected",
      severity: "SEVERE",
      points: 20,
      value: "BREAK",
      detail: "A change-point was detected in the underlying digit distribution.",
    });
  }

  if (regimeObj?.label === "VOLATILE" || regimeObj?.label === "CHAOTIC") {
    addComp({
      code: "REGIME_VOLATILITY",
      label: "High market volatility regime",
      severity: "MODERATE",
      points: 14,
      value: regimeObj.label,
      detail: `Current market regime is ${regimeObj.label}, which degrades setup persistence.`,
    });
  }

  // 7. Timeframe & Multi-Window Pressure Conflict
  const pressure = input.pressure;
  if (pressure?.byWindow) {
    const windows = Object.values(pressure.byWindow);
    const opposingCount = windows.filter((w) => w === "OPPOSING").length;
    if (opposingCount >= 2) {
      addComp({
        code: "PRESSURE_TIMEFRAME_CONFLICT",
        label: "Multiple pressure windows opposing",
        severity: opposingCount >= 3 ? "SEVERE" : "HIGH",
        points: opposingCount >= 3 ? 22 : 14,
        value: `${opposingCount} windows opposing`,
        detail: `Shorter-term pressure windows actively contradict the structural direction.`,
      });
    }
  }

  // 8. Digit Psychology structural risks
  const psych =
    input.psychology?.raw?.digitPsychology ?? input.psychology?.digitPsychology ?? input.psychology;
  if (psych?.zoneContested) {
    addComp({
      code: "PSYCHOLOGY_ZONE_CONTESTED",
      label: "Green and 2nd Green zone contest",
      severity: "HIGH",
      points: 15,
      value: psych.zoneContestedReason || "CONTESTED",
      detail:
        psych.zoneContestedReason ||
        "Green and Second Green bars are tied across opposite sides of the barrier.",
    });
  }

  if (psych?.hardBlock) {
    addComp({
      code: "PSYCHOLOGY_STRUCTURAL_BLOCK",
      label: "Digit psychology structural violation",
      severity: "AUTO_BLOCK",
      points: 35,
      value: "STRUCTURAL_FAULT",
      detail: psych.hardBlockReason || "Contract violates fundamental digit psychology rules.",
    });
  }

  // 9. Competitor digits & entry point risks
  const entry = input.entryPoint?.raw ?? input.entryPoint;
  if (entry?.competingDigits?.some((d: any) => d.danger >= 60)) {
    addComp({
      code: "DANGEROUS_COMPETITOR_DIGIT",
      label: "High-velocity losing competitor building",
      severity: "HIGH",
      points: 16,
      value: "COMPETITOR >= 60",
      detail: "A competing losing digit is accelerating rapidly and threatening entry.",
    });
  }

  // 10. Special market risk & anomaly buildup
  const specialRisk = input.specialRisk ?? input.intel?.specialDigits?.marketRisk;
  if (
    specialRisk &&
    (typeof specialRisk === "number" ? specialRisk >= 50 : specialRisk.extremeRisk)
  ) {
    addComp({
      code: "SPECIAL_DIGIT_RISK",
      label: "Special digit volatility elevated",
      severity: "MODERATE",
      points: 12,
      value: "ELEVATED",
      detail: "Extreme market risk detected in outer edge digits (0/1/8/9).",
    });
  }

  // ── 11. PHASE 13 — DIRECTIONAL MOMENTUM (adverse only) ─────────────────
  const momentum = input.momentum;
  if (momentum && momentum.measurable && momentum.severity > 0) {
    const sev: DangerSeverity = momentum.takeoverRisk
      ? "SEVERE"
      : momentum.severity >= 45
        ? "HIGH"
        : momentum.severity >= 22
          ? "MODERATE"
          : "MILD";
    addComp({
      code: "ADVERSE_DIRECTIONAL_MOMENTUM",
      label:
        momentum.state === "TAKEOVER_RISK"
          ? "Losing side taking over on momentum"
          : momentum.state === "LOSING_SIDE_RISING"
            ? "Losing-side momentum rising"
            : momentum.state === "REVERSING"
              ? "Winning-side momentum reversing"
              : "Winning-side momentum weakening",
      // Bounded: at most 26 points, so momentum can escalate danger but can
      // never single-handedly hard-block a structurally clean setup.
      severity: sev,
      points: Math.round(Math.min(26, momentum.severity * 0.26)),
      value: `${momentum.state} ${momentum.severity}/100`,
      detail: momentum.evidence[0] ?? momentum.summary,
    });
  }
  if (momentum?.reversal) {
    addComp({
      code: "MOMENTUM_REVERSAL",
      label: "Winning-side percentage reversal",
      severity: "HIGH",
      points: 12,
      value: `accel ${momentum.winning.accelerationPp.toFixed(2)}pp`,
      detail: `The winning side changed direction inside the observation window (velocity ${momentum.winning.velocityPp.toFixed(2)}pp, acceleration ${momentum.winning.accelerationPp.toFixed(2)}pp).`,
    });
  }

  // ── 12. PHASE 14 — QUANTIFIED PERCENTAGE COMPETITION ───────────────────
  const competition = input.competition;
  if (competition && competition.measurable && competition.state !== "LOW") {
    // An UNRESOLVED takeover (the losing structure has overtaken the winning
    // structure and is still gaining) is safety-critical and AUTO_BLOCKs.
    const unresolvedTakeover = competition.state === "CRITICAL" && competition.overtaken;
    addComp({
      code: unresolvedTakeover ? "UNRESOLVED_PERCENTAGE_TAKEOVER" : "PERCENTAGE_COMPETITION",
      label: unresolvedTakeover
        ? "Losing structure has overtaken the winning structure"
        : `Percentage competition ${competition.state}`,
      severity: unresolvedTakeover
        ? "AUTO_BLOCK"
        : competition.state === "CRITICAL"
          ? "SEVERE"
          : competition.state === "HIGH"
            ? "HIGH"
            : "MODERATE",
      points: unresolvedTakeover
        ? 35
        : competition.state === "CRITICAL"
          ? 24
          : competition.state === "HIGH"
            ? 16
            : 8,
      value: `gap ${competition.gapPp.toFixed(2)}pp → ${competition.gapFastPp.toFixed(2)}pp (sev ${competition.severity}/100)`,
      detail: competition.evidence[0] ?? competition.summary,
    });
  }

  // ── 13. PHASE 15A — RED / 2ND RED STRUCTURAL CONFLICT ──────────────────
  // FATAL RED violations arrive as psych.hardBlock above. Non-fatal conflicts
  // are graded danger here, never a veto (see red-semantics.ts).
  const red = input.redSemantics ?? psych?.redSemantics;
  if (red && !red.fatal && red.conflictSeverity > 0) {
    addComp({
      code: "RED_STRUCTURAL_CONFLICT",
      label: red.risingOnLosingSide
        ? "Losing-side RED rising"
        : "RED / 2ND RED structural conflict",
      severity: red.conflictSeverity >= 55 ? "HIGH" : red.conflictSeverity >= 28 ? "MODERATE" : "MILD",
      points: Math.round(Math.min(20, red.conflictSeverity * 0.2)),
      value: `${red.violations.length} violation(s), severity ${red.conflictSeverity}/100`,
      detail: red.violations[0]?.note ?? red.summary,
    });
  }

  // ── 14. PHASE 15B — UPSTREAM CONTRACT RISK SCALAR ──────────────────────
  // Preserves exposure / threat / special-digit risk already measured by
  // apex/contracts.ts + apex/core.ts so that this composition can be the ONE
  // authoritative danger value without losing upstream evidence.
  const scalar = input.contractRiskScalar;
  if (typeof scalar === "number" && scalar > 0) {
    const alreadyCounted = components.reduce((sum, c) => sum + c.points, 0);
    const residual = Math.max(0, Math.round(Math.min(100, scalar)) - alreadyCounted);
    if (residual > 0) {
      addComp({
        code: "CONTRACT_RISK_SCALAR",
        label: "Upstream contract risk (exposure, threat, special digits)",
        severity: scalar >= 70 ? "SEVERE" : scalar >= 45 ? "HIGH" : scalar >= 25 ? "MODERATE" : "MILD",
        points: residual,
        value: `${Math.round(scalar)}/100 upstream (residual ${residual})`,
        detail:
          "Exposure, threat and special-digit risk measured upstream per contract. Only the portion not already explained by a named component above is added, so no risk is double-counted.",
      });
    }
  }

  // Aggregate
  const total = Math.min(
    100,
    components.reduce((sum, c) => sum + c.points, 0),
  );
  const autoBlock = components.filter((c) => c.severity === "AUTO_BLOCK");
  const severe = components.filter((c) => c.severity === "SEVERE" || c.severity === "HIGH");
  const level = levelOf(total, autoBlock.length > 0);

  // Normalize isAutoBlock and measuredValue
  components.forEach((c) => {
    c.isAutoBlock = c.severity === "AUTO_BLOCK";
    c.measuredValue = c.value;
  });

  const summary =
    autoBlock.length > 0
      ? `AUTO_BLOCK triggered by: ${autoBlock.map((c) => c.label).join("; ")}.`
      : components.length === 0
        ? "No active danger components — environment calm."
        : `Danger ${total}/100 (${level}) from ${components.length} component(s): ${components.map((c) => c.label).join(", ")}.`;

  return {
    total,
    level,
    components,
    autoBlock,
    severe,
    summary,
    overallDangerScore: total,
    isHardBlocked: autoBlock.length > 0 || total >= 70,
    dangerFactor: Math.min(1.0, total / 100),
  };
}
