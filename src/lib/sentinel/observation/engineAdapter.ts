/**
 * ENGINE ADAPTER — THE INTEGRATION BOUNDARY
 * =========================================
 * This file defines the ONE shape that existing Sentinel engine output must
 * be mapped onto before it reaches the Observation Layer. Nothing downstream
 * of this file recalculates psychology, pressure, regime, momentum,
 * simulation, entry-trigger, or veto logic — it only interprets the
 * evidence handed to it (§4, §22.2).
 *
 * INTEGRATION STEPS FOR WHOEVER WIRES THIS INTO THE REPO (§22):
 *   1. Find where existing engines currently produce their per-market,
 *      per-proposition output (psychology, pressure, entry-digit, losing-
 *      side pressure, simulation, regime, momentum, trigger, veto).
 *   2. Write ONE mapping function per market tick/scan that fills in
 *      `EngineEvidenceInput` below by reading those existing outputs —
 *      do not reimplement any of the math, just translate the shape.
 *   3. Call `observationEngine.ingest(input)` with that mapped object.
 *   4. Everything else in this package (state machine, regime/momentum
 *      interpretation, selectivity, qualification, explanation) runs off
 *      of that single call.
 *
 * If a field genuinely cannot be sourced from an existing engine yet, set
 * the corresponding state to its "unknown/insufficient" value (e.g.
 * `regime.classification = 'UNKNOWN'`, `simulation.state = 'INSUFFICIENT'`)
 * rather than fabricating a value — see §5 and §9.1.
 */

import type { MarketId, Proposition } from "./constants";
import { ANALYSIS_VERSION } from "./constants";

import type {
  PsychologyEvidence,
  EntryDigitEvidence,
  PressureEvidence,
  LosingSidePressureEvidence,
  DangerEvidence,
  SimulationEvidence,
  RegimeEvidence,
  MomentumEvidence,
  TriggerEvidence,
  VetoEvidence,
  StatisticsEvidence,
  HiddenBehaviorEvidence,
} from "./types";
import { ALL_DIGITS } from "@/lib/sentinel/proposal/types";
import { canonicalDigitState, contractPsychology } from "@/lib/sentinel/digit-psychology";
import { composeDanger } from "@/lib/sentinel/danger";
import {
  computePressureField,
  computeGroupPressure,
} from "@/lib/sentinel/proposal/pressure-windows";
import { validateDirectionWithPressure } from "@/lib/sentinel/proposal/pressure-validator";
import {
  DEFAULT_MIN_CONVICTION,
  evaluateSentinelSpine,
  runVetoEngine,
  type SentinelSpineReport,
} from "@/lib/sentinel/proposal";
import { losingSidePressure } from "@/lib/sentinel/losing-side-pressure";
import {
  computePriceActionField,
  evaluateContractPriceAction,
} from "@/lib/sentinel/price-action-psychology";
import { detectRegimeChange } from "@/lib/sentinel/regime-detector";
import { simulatorAdjustment, apexSimulator, engineAgreement } from "@/lib/apex/simulator";
import { entryLab } from "@/lib/apex/entry-conditions";
import { computeEntryPoint } from "@/lib/sentinel/entry-point";
import { resolveVeto } from "@/lib/sentinel/veto-resolver";
import { derivBus } from "@/lib/deriv/tick-bus";
import { operatorLearningLookup } from "@/lib/sentinel/operator-learning";
import { immediateGuidanceLookup } from "@/lib/sentinel/immediate-guidance";
import { evaluateVariableOrderMarkov } from "@/lib/sentinel/context-engine";
import {
  calibrateScore,
  type HistoricalOutcome,
  type CalibrationResult,
} from "@/lib/sentinel/calibration";
import { sequentialTestFromEdge, type SequentialTestReport } from "@/lib/sentinel/sequential-test";
import { comboLearning, type ComboEvidence } from "@/lib/sentinel/combination-learning";
import {
  winningSideMomentum,
  directionalMomentum,
  type WinningSideMomentum,
} from "@/lib/sentinel/winning-side-momentum";

import { computeSetup } from "@/lib/sentinel/setup";
import { assessEntryClearance } from "@/lib/sentinel/entry-clearance";
import {
  evaluateExecutionSurvival,
  survivalInfluence,
  evaluateEntryTrigger,
} from "@/lib/sentinel/execution-integration";
import { computeConvergence } from "@/lib/sentinel/convergence";
import {
  fuseEvidence,
  type EngineEvidenceInput as FusionInput,
} from "@/lib/sentinel/evidence-fusion";
import { evaluateSignalGovernance } from "@/lib/sentinel/global-veto";
import { buildPatternTags } from "@/lib/sentinel/pattern-tags";
import { operatorSpecialDigitAction } from "@/lib/sentinel/operator-special-digits";
import { marketProfiles } from "@/lib/apex/profiles";
import { computeManipulation } from "@/lib/precision-scanner/scoring";
import { assessClearance } from "@/lib/apex/clearance";
import { classifyEvidence } from "@/lib/apex/evidence-status";
import { computeDirection } from "@/lib/sentinel/direction";
import { hasValidatedEntryDigit } from "@/lib/sentinel/signal-state";
import { observeLiquiditySweep, type LiquiditySweepObservation } from "@/lib/sentinel/liquidity-sweep";

export interface EngineEvidenceInput {
  marketId: MarketId;
  proposition: Proposition;
  /** Tick or scan timestamp (ms epoch, or monotonic tick counter — must be strictly increasing per market). */
  timestamp: number;

  // ── PHASE 15D — DETERMINISTIC SOURCE IDENTITY ────────────────────────
  /**
   * Identity of the DERIV SOURCE OBSERVATION this evidence was derived from.
   * Built from the real Deriv tick (`epoch` seconds + quote) — never
   * fabricated. Absent only when no source tick is available (e.g. a purely
   * synthetic digit array in a test); the engine then falls back to
   * timestamp + tick sequence and records the weaker identity.
   */
  sourceTickId?: string | null;
  /** Number of source ticks observed for this market at analysis time. */
  tickSequence?: number;
  /** Analytical version the evidence was produced under. */
  analysisVersion?: string;


  psychology: PsychologyEvidence;
  entryDigit: EntryDigitEvidence;
  pressure: PressureEvidence;
  losingSidePressure: LosingSidePressureEvidence;
  liquiditySweep?: LiquiditySweepObservation;
  danger: DangerEvidence;
  simulation: SimulationEvidence;
  regime: RegimeEvidence;
  momentum: MomentumEvidence;
  trigger: TriggerEvidence;
  veto: VetoEvidence;
  statistics: StatisticsEvidence;
  hiddenBehavior: HiddenBehaviorEvidence;

  // Fully populated and consumed contextual evidence inputs for full-spectrum scoring
  contractContext?: any;
  marketContext?: any;
  governance?: any;
  governedSpine?: any;
  operatorLearning?: any;
  guidance?: any;
  survival?: any;
  survivalInfluence?: any;
  entryTrigger?: any;
  contextMarkov?: any;
  convergence?: any;
  evidenceFusion?: any;
  setupQuality?: any;
  entryClearance?: any;
  operatorSpecial?: any;
  marketLearning?: any;
  clearance?: any;
  evidenceStatus?: any;
  direction?: any;
  agreementBonus?: number;
  manipulationScore?: any;
  winningSideMomentum?: any;
  priceAction?: any;
  priceActionField?: any;
  entryPoint?: any;
  stateEvidence?: any;
  relative?: any;
  persistence?: any;
  combination?: any;
  regimeReport?: any;
}

/**
 * Convenience builder for integrators: fills every field with a safe
 * "insufficient/unknown" default so a partial mapping never crashes the
 * Observation Layer while the real wiring is still being built out.
 * Overwrite fields as each existing engine's output is actually mapped in.
 */
export function emptyEvidenceInput(
  marketId: MarketId,
  proposition: Proposition,
  timestamp: number,
): EngineEvidenceInput {
  return {
    marketId,
    proposition,
    timestamp,
    psychology: { direction: "NONE", state: "FORMING", support: "UNKNOWN" },
    entryDigit: { digit: null, state: "WAITING", support: "UNKNOWN", dangerousCompetitor: false },
    pressure: {
      byWindow: { 15: "UNKNOWN", 30: "UNKNOWN", 60: "UNKNOWN", 120: "UNKNOWN" },
      candidateDigitTrend: "UNKNOWN",
    },
    losingSidePressure: { state: "STABLE", severity: "NONE" },
    liquiditySweep: observeLiquiditySweep([], proposition.startsWith("OVER") ? "OVER" : "UNDER", Number(proposition.replace(/\D/g, "")) || (proposition.startsWith("OVER") ? 2 : 7)),
    danger: {
      total: 0,
      level: "CALM",
      isHardBlocked: false,
      components: [],
      summary: "No active danger components — environment calm.",
    },
    simulation: { state: "INSUFFICIENT", sampleSize: 0, conditionedOnRegime: false },
    regime: {
      classification: "UNKNOWN",
      confidence: 0,
      transitioning: false,
      compatibility: "NEUTRAL_UNCERTAIN",
    },
    momentum: { side: "UNKNOWN", state: "UNKNOWN", strength: 0 },
    trigger: { state: "INVALID" },
    veto: { active: false, hard: false },
    statistics: { strength: "INSUFFICIENT", sampleSize: 0 },
    hiddenBehavior: { state: "NONE" },
  };
}

/**
 * Immutable per-market snapshot cache.
 *
 * The mapping below is a heavyweight analytical boundary (spine, regime,
 * pressure, price action, exposure, EntryLab). It is deterministic for a given
 * source identity — market + analysis timestamp + tick count — so the result is
 * memoised and shared. Any caller that re-requests the same snapshot receives
 * the exact same frozen array instead of re-running the engines.
 */
interface SnapshotEntry {
  key: string;
  inputs: EngineEvidenceInput[];
}
const snapshotCache = new Map<string, SnapshotEntry>();

export interface AdapterCacheStats {
  markets: number;
  hits: number;
  misses: number;
}
let adapterHits = 0;
let adapterMisses = 0;

export function adapterCacheStats(): AdapterCacheStats {
  return { markets: snapshotCache.size, hits: adapterHits, misses: adapterMisses };
}

export function resetAdapterCache(): void {
  snapshotCache.clear();
  adapterHits = 0;
  adapterMisses = 0;
}

/**
 * Cached, read-safe entry point. Produces (or reuses) the canonical immutable
 * observation snapshot for one market.
 */
export function mapIntelToObservationInputs(
  intel: any,
  rawDigits?: readonly number[],
): EngineEvidenceInput[] {
  if (!intel || !intel.symbol || !intel.contracts) return [];
  const symbol = String(intel.symbol);
  const key = `${intel.updatedAt ?? 0}:${rawDigits?.length ?? 0}:${intel.contracts.length}`;
  const cached = snapshotCache.get(symbol);
  if (cached && cached.key === key) {
    adapterHits += 1;
    return cached.inputs;
  }
  adapterMisses += 1;
  const inputs = computeIntelObservationInputs(intel, rawDigits);
  snapshotCache.set(symbol, { key, inputs });
  return inputs;
}

/**
 * Maps live MarketIntel from ApexCore to an array of EngineEvidenceInputs
 * (one per contract/proposition) by faithfully consuming genuine engine outputs:
 * 1,000-tick structural psychology, 15/30/60/120 pressure windows, losing-side
 * pressure, entry-digit lab, regime detector, momentum, and veto engine.
 */
export function computeIntelObservationInputs(
  intel: any,
  rawDigits?: readonly number[],
): EngineEvidenceInput[] {

  if (!intel || !intel.symbol || !intel.contracts) return [];

  const marketId = intel.symbol as MarketId;
  const timestamp = intel.updatedAt ?? Date.now();

  // PHASE 15D — deterministic source identity taken from the REAL last Deriv
  // tick for this market (epoch ms + quote). No fabricated tick ids: when the
  // bus has no tick (synthetic/test digit arrays) this stays null and the
  // engine falls back to timestamp + tick sequence, which it records.
  const busTicks = derivBus.getTicks(String(intel.symbol)) ?? [];
  const lastTick = busTicks.length > 0 ? busTicks[busTicks.length - 1] : null;
  const sourceTickId = lastTick ? `${lastTick.t}@${lastTick.price}` : null;



  const digits: readonly number[] =
    rawDigits && rawDigits.length >= 50
      ? rawDigits
      : (derivBus.getDigits(intel.symbol) as number[]) || (intel.digits as number[]) || [];

  const canonicalState = canonicalDigitState(
    digits.slice(-1000) as number[],
    intel.digitIntel ?? null,
  );
  const pressureField = computePressureField(digits.slice(-120), canonicalState.pct);
  const paField = computePriceActionField(digits.slice(-120), canonicalState.pct);
  const spineReport = evaluateSentinelSpine({
    canonical: canonicalState,
    digits: digits.slice(-120),
  });
  const regimeReport = detectRegimeChange(digits as number[], { symbol: intel.symbol });

  return intel.contracts.map((c: any): EngineEvidenceInput => {
    const prop = c.id as Proposition;
    const side = (c.side ?? (prop.startsWith("OVER") ? "OVER" : "UNDER")) as "OVER" | "UNDER";
    const isOver = side === "OVER";
    const winners: number[] =
      c.winners ??
      (isOver
        ? ALL_DIGITS.filter((d) => d > Number(prop.replace("OVER", "")))
        : ALL_DIGITS.filter((d) => d < Number(prop.replace("UNDER", ""))));
    const losers = ALL_DIGITS.filter((d) => !winners.includes(d));

    // 1. Structural Psychology (1,000-tick)
    const barrier =
      typeof c.barrier === "number"
        ? c.barrier
        : isOver
          ? Number(prop.replace("OVER", ""))
          : Number(prop.replace("UNDER", ""));
    const digitPsychology = contractPsychology(
      canonicalState,
      {
        label: c.label || `${side} ${barrier}`,
        side,
        barrier,
        winners,
      },
    );
    const structure = spineReport.structure;
    const psychDirection: "OVER" | "UNDER" | "NONE" =
      structure.direction === "OVER" ? "OVER" : structure.direction === "UNDER" ? "UNDER" : "NONE";

    let psychState: PsychologyEvidence["state"] = "FORMING";
    if (structure.unusable) {
      psychState = "INVALIDATING";
    } else if (structure.change === "STRENGTHENING") {
      psychState = "STRENGTHENING";
    } else if (structure.change === "ROTATING") {
      psychState = "REVERSING";
    } else if (structure.direction === "CONFLICT") {
      psychState = "CONFLICTING";
    } else if (structure.change === "WEAKENING") {
      psychState = "WEAKENING";
    } else if (structure.change === "STABLE" && structure.conviction >= 45) {
      psychState = "COHERENT";
    } else {
      psychState = "FORMING";
    }

    let psychSupport: PsychologyEvidence["support"] = "UNKNOWN";
    if (digitPsychology.hardBlock) {
      psychSupport = "OPPOSING";
    } else if (structure.direction === side) {
      psychSupport = structure.conviction >= 30 ? "SUPPORTING" : "MIXED";
    } else if (structure.direction === "CONFLICT") {
      psychSupport = "MIXED";
    } else if (structure.direction !== "UNKNOWN") {
      psychSupport = "OPPOSING";
    } else {
      psychSupport = "UNKNOWN";
    }

    // 2. Price Action, Validation and Spine
    const validation = validateDirectionWithPressure(digits.slice(-120), side, pressureField);
    const contractSpine = evaluateSentinelSpine({
      canonical: canonicalState,
      digits: digits.slice(-120),
      contract: { label: c.label, side, barrier, winners },
    });
    const lsp = losingSidePressure(c.threat ?? null, validation, pressureField);
    const liquiditySweep = observeLiquiditySweep(digits.slice(-120), side, barrier);
    const paContract = evaluateContractPriceAction({
      field: paField,
      shape: {
        label: c.label,
        side,
        winners,
        barrier,
      },
      structural: canonicalState,
    });

    // 3. Group Pressure across windows (15, 30, 60, 120)
    const winPressure = computeGroupPressure(
      digits.slice(-120),
      winners,
      `${c.label} winning digits`,
    );
    const losePressure = computeGroupPressure(
      digits.slice(-120),
      losers,
      `${c.label} losing digits`,
    );

    const theoreticalWinPct = (c.theoretical ?? 0.5) * 100;
    const theoreticalLosePct = 100 - theoreticalWinPct;

    const pressureByWindow: Record<
      15 | 30 | 60 | 120,
      "SUPPORTING" | "MIXED" | "OPPOSING" | "UNKNOWN"
    > = {
      15: "UNKNOWN",
      30: "UNKNOWN",
      60: "UNKNOWN",
      120: "UNKNOWN",
    };

    const windows: Array<15 | 30 | 60 | 120> = [15, 30, 60, 120];
    for (const w of windows) {
      const winSlice = winPressure.slices[w];
      const loseSlice = losePressure.slices[w];
      if (!winSlice || !loseSlice) {
        pressureByWindow[w] = "UNKNOWN";
        continue;
      }
      const winPp = winSlice.pct - theoreticalWinPct;
      const losePp = loseSlice.pct - theoreticalLosePct;

      if (winPp >= 1.5 && losePp <= -1.0) {
        pressureByWindow[w] = "SUPPORTING";
      } else if (losePp >= 1.5 && winPp <= -1.0) {
        pressureByWindow[w] = "OPPOSING";
      } else if (winSlice.pct > 100 - loseSlice.pct && winPp > 0) {
        pressureByWindow[w] = "SUPPORTING";
      } else if (loseSlice.pct > 100 - winSlice.pct && losePp > 0) {
        pressureByWindow[w] = "OPPOSING";
      } else {
        pressureByWindow[w] = "MIXED";
      }
    }

    // 4. Simulator Adjustment & Performance
    const sim = simulatorAdjustment(intel.symbol, c.id, c.theoretical);
    const recentPerf = apexSimulator.recentPerformance(intel.symbol, c.id, c.theoretical);

    // 5. AUTHORITATIVE DANGER COMPOSITION (§6, Phase 15B)
    // This is the ONE authoritative danger value for this cell. ApexCore no
    // longer composes a second, weaker danger object; it reads this one back
    // (see apex/core.ts). Momentum (Phase 13), percentage competition
    // (Phase 14), RED/2ND RED semantics (Phase 15A) and the upstream contract
    // risk scalar (exposure/threat/special digits) all flow in here so no
    // consumer can see a different number.
    const dirMomentum = directionalMomentum(paField, winners, losers);
    const dangerComposition = composeDanger({
      intel,
      contract: {
        label: c.label,
        side,
        barrier: c.barrier,
        winners,
        losers,
      },
      lifetimeTicks: intel.ticks ?? 1000,
      recentLatencyMs: intel.latencyMs,
      losingSideHostile: lsp.state === "HOSTILE",
      losingSidePressure: lsp,
      pressure: { winPressure, losePressure, pressureField, byWindow: pressureByWindow },
      psychology: { structure, digitPsychology },
      entryPoint: null,
      simulation: { sim, recentPerf },
      regime: { regime: intel.regime, regimeReport },
      specialRisk: c.specialRisk,
      buildup: intel.buildup,
      timeframeConflict: Object.values(pressureByWindow).some((w) => w === "OPPOSING"),
      momentum: dirMomentum,
      competition: paContract.competition,
      redSemantics: digitPsychology.redSemantics,
      contractRiskScalar: typeof c.danger === "number" ? c.danger : null,
    });


    const entryRec = entryLab.recommend(intel.symbol, c.id, c.theoretical);
    const operatorLearning = operatorLearningLookup();
    const guidance = immediateGuidanceLookup();

    const losingStrengtheningDigits = losers.filter(
      (d) =>
        d === canonicalState.mostIncreasing ||
        d === canonicalState.red ||
        d === canonicalState.secondRed ||
        d === canonicalState.secondGreen ||
        (pressureField.digits[d]?.ratePp ?? 0) > 1.8 ||
        (pressureField.digits[d]?.accelerationPp ?? 0) > 2.5,
    );

    const contextMarkov = evaluateVariableOrderMarkov(
      digits as number[],
      winners,
      c.theoretical ?? (isOver ? 0.8 : 0.7),
      {
        symbol: intel.symbol,
        contractLabel: c.label,
        losingStrengtheningDigits,
      },
    );

    const clearanceBlocked = Boolean(
      dangerComposition.isHardBlocked ||
      digitPsychology.hardBlock ||
      (contractSpine.veto.verdict === "VETO" && Boolean((contractSpine.veto as any).isHard)),
    );

    let entryPoint: any = null;
    try {
      entryPoint = computeEntryPoint({
        intel,
        contract: c,
        digits: digits as number[],
        danger: dangerComposition,
        entry: entryRec,
        clearanceBlocked,
        operator: operatorLearning,
        guidance,
        canonicalPsychology: { state: canonicalState, contract: digitPsychology },
        contextMarkov,
        regimeReport,
      });
    } catch {
      entryPoint = null;
    }

    // ENTRY-POINT PROVENANCE INVARIANT:
    // The recommended digit comes only from EntryPoint.preferred. The new
    // session-ranked path is intentionally allowed to publish a best digit
    // even when evidence is immature; execution state remains separate and is
    // controlled by the session grade / EntryPoint status. Legacy
    // recommendedDigit / activeDigit fallbacks remain forbidden.
    const recommendedDigit =
      (entryPoint?.selectionSource === "SESSION_RANKED" ||
        entryPoint?.selectionSource === "SIX_STAGE_DBOT_VALIDATED") &&
      entryPoint?.preferred?.entryDigitTouchBlocked !== true
        ? entryPoint.preferred.digit
        : null;
    const isEntryValidated =
      !!entryPoint?.preferred &&
      (entryPoint?.preferred?.sessionGrade === "A" || entryPoint?.preferred?.sessionGrade === "B") &&
      (entryPoint?.status === "ENTER NOW" || entryPoint?.status === "ARMED") &&
      !Boolean(entryPoint?.validated === false);
    const entryDigitState: "WAITING" | "FORMING" | "VALIDATED" = isEntryValidated
      ? "VALIDATED"
      : recommendedDigit !== null
        ? "FORMING"
        : "WAITING";

    let entrySupport: "SUPPORTING" | "MIXED" | "OPPOSING" | "UNKNOWN" = "UNKNOWN";
    if (recommendedDigit !== null && winners.includes(recommendedDigit)) {
      if (entryPoint?.status === "INVALIDATED") {
        entrySupport = "OPPOSING";
      } else if ((entryPoint?.confidence ?? 0) >= 45 || isEntryValidated) {
        entrySupport = "SUPPORTING";
      } else {
        entrySupport = "MIXED";
      }
    } else if (recommendedDigit !== null && losers.includes(recommendedDigit)) {
      entrySupport = "OPPOSING";
    }

    const dangerousCompetitor = Boolean(
      entryPoint?.competingDigits?.some((d: any) => d.danger >= 55) ||
      (c.threat?.groupThreat ?? 0) >= 45 ||
      c.specialRisk?.extremeRisk ||
      (intel.specialDigits?.marketRisk ?? 0) >= 50,
    );

    // 5. Candidate Digit Trend
    let candidateDigitTrend: "TREND" | "FLUCTUATION" | "UNKNOWN" = "UNKNOWN";
    if (recommendedDigit !== null) {
      const reading = pressureField.digits.find((r) => r.digit === recommendedDigit);
      if (
        reading &&
        (reading.movement === "TAKING OVER" ||
          reading.movement === "ACCELERATING" ||
          reading.movement === "STRENGTHENING")
      ) {
        candidateDigitTrend = "TREND";
      } else if (
        reading &&
        (reading.direction === "REVERSING" ||
          reading.movement === "DECELERATING" ||
          reading.movement === "WEAKENING")
      ) {
        candidateDigitTrend = "FLUCTUATION";
      }
    } else if (
      winPressure.movement === "ACCELERATING" ||
      winPressure.movement === "STRENGTHENING" ||
      winPressure.movement === "TAKING OVER"
    ) {
      candidateDigitTrend = "TREND";
    } else if (
      winPressure.movement === "DECELERATING" ||
      winPressure.movement === "WEAKENING" ||
      winPressure.movement === "EXHAUSTING"
    ) {
      candidateDigitTrend = "FLUCTUATION";
    }

    // 6. Losing-Side Pressure
    let lspState: LosingSidePressureEvidence["state"] = "STABLE";
    if (lsp.state === "HOSTILE" && losePressure.movement === "TAKING OVER") {
      lspState = "TAKEOVER";
    } else if (lsp.state === "HOSTILE" || losePressure.accelerationPp > 0.8) {
      lspState = "ACCELERATING";
    } else if (lsp.state === "PRESSURED" || lsp.risingCount >= 2) {
      lspState = "INCREASING";
    } else if (lsp.state === "BUILDING") {
      lspState = "STABLE";
    } else if (lsp.state === "CALM") {
      lspState = "DECLINING";
    }

    let lspSeverity: LosingSidePressureEvidence["severity"] = "NONE";
    if (lspState === "TAKEOVER" && lsp.verdict === "SUPPRESS") {
      lspSeverity = "VETO";
    } else if (lsp.verdict === "SUPPRESS") {
      lspSeverity = "DOWNGRADE";
    } else if (lsp.state === "HOSTILE") {
      lspSeverity = "CAUTION";
    } else if (lsp.state === "PRESSURED") {
      lspSeverity = "DOWNGRADE";
    } else if (lsp.state === "BUILDING") {
      lspSeverity = "CAUTION";
    }

    let simState: SimulationEvidence["state"] = "STABLE";
    if (sim.perf.n < 5) {
      simState = "INSUFFICIENT";
    } else if (recentPerf.winRate >= c.theoretical + 0.04 && sim.perf.winRate >= c.theoretical) {
      simState = "FAVOURABLE";
    } else if (recentPerf.winRate >= c.theoretical && sim.perf.winRate < c.theoretical) {
      simState = "RECOVERING";
    } else if (
      recentPerf.winRate < c.theoretical - 0.08 ||
      sim.perf.winRate < c.theoretical - 0.08
    ) {
      simState = "LOSING";
    } else if (recentPerf.winRate < c.theoretical) {
      simState = "UNFAVOURABLE";
    }

    // 8. Regime Evidence
    let regimeClassification: RegimeEvidence["classification"] = "CALM_STABLE";
    if (regimeReport.state === "TRANSITION" || regimeReport.state === "REGIME_CHANGE" || regimeReport.state === "UNSTABLE") {
      regimeClassification = "TRANSITION";
    } else if (intel.regime?.label === "TRENDING") {
      regimeClassification = "TRENDING_PERSISTENT";
    } else if (intel.regime?.label === "CHOPPY") {
      regimeClassification = "CHOPPY_OSCILLATING";
    } else if (intel.regime?.label === "VOLATILE") {
      regimeClassification = "HIGH_VOLATILITY_UNSTABLE";
    } else if (intel.regime?.label === "CALM") {
      regimeClassification = "CALM_STABLE";
    }

    const regimeTransitioning = Boolean(
      regimeReport.state === "TRANSITION" ||
        regimeReport.state === "REGIME_CHANGE" ||
        intel.regime?.transitioning,
    );
    let regimeCompatibility: RegimeEvidence["compatibility"] = "NEUTRAL_UNCERTAIN";
    if (intel.regime?.label === "VOLATILE" && (c.stability ?? 50) < 30) {
      regimeCompatibility = "INCOMPATIBLE";
    } else if (regimeReport.state === "TRANSITION" || intel.regime?.label === "CHOPPY") {
      regimeCompatibility = "NEUTRAL_UNCERTAIN";
    } else if (
      (c.quality ?? 50) >= 50 &&
      (intel.regime?.label === "TRENDING" || intel.regime?.label === "CALM")
    ) {
      regimeCompatibility = "COMPATIBLE";
    }

    // 9. Momentum Evidence
    let momentumSide: MomentumEvidence["side"] = "BALANCED";
    if (pressureField.rising.some((d) => d >= 5) && pressureField.falling.some((d) => d <= 4)) {
      momentumSide = "OVER";
    } else if (
      pressureField.rising.some((d) => d <= 4) &&
      pressureField.falling.some((d) => d >= 5)
    ) {
      momentumSide = "UNDER";
    } else if (spineReport.direction === "OVER") {
      momentumSide = "OVER";
    } else if (spineReport.direction === "UNDER") {
      momentumSide = "UNDER";
    }

    let momentumState: MomentumEvidence["state"] = "STABLE";
    if (
      paContract.alignment === "CONFIRMING" ||
      paContract.winningSide.direction === "INCREASING" ||
      validation?.verdict === "CONFIRM"
    ) {
      momentumState = "ACCELERATING";
    } else if (
      lspState === "TAKEOVER" ||
      paContract.alignment === "CONTRADICTING" ||
      validation?.verdict === "REJECT"
    ) {
      momentumState = "REVERSING";
    } else if (
      paContract.winningSide.direction === "DECREASING" ||
      validation?.verdict === "MIXED"
    ) {
      momentumState = "DECELERATING";
    } else {
      momentumState = "STABLE";
    }

    // 10. Trigger Evidence
    const entryLabRec = entryLab.recommend(intel.symbol, c.id, c.theoretical);
    let triggerState: TriggerEvidence["state"] = "INVALID";
    if (entryLabRec?.activeNow) {
      triggerState = "FIRED";
    } else if (
      entryLabRec?.best &&
      entryLabRec.best.winRate >= c.theoretical + 0.04 &&
      (c.opportunity ?? 50) >= 55 &&
      (c.danger ?? 50) < 60
    ) {
      triggerState = "VALID";
    } else if (entryLabRec?.best && (c.opportunity ?? 50) >= 40) {
      triggerState = "ARMING";
    } else if ((c.danger ?? 0) >= 75 || (c.threat?.groupThreat ?? 0) >= 70) {
      triggerState = "FAILED";
    }

    // 11. Danger Evidence (using canonical Danger Composition §6)
    // dangerComposition already evaluated once in section 5

    // 12. Unified Veto Hierarchy (§5)
    const vetoRes = resolveVeto(
      `${marketId}:${prop}`,
      {
        digitPsychologyHardBlock: digitPsychology.hardBlock,
        digitPsychologyReason: digitPsychology.hardBlockReason,
        priceActionVeto: paContract.veto,
        priceActionReason: paContract.vetoReason,
        losingSideSuppressed: lsp.verdict === "SUPPRESS",
        losingSideVeto: lspState === "TAKEOVER" && lsp.verdict === "SUPPRESS",
        losingSideReason: lsp.reason,
        spineVeto: contractSpine.veto.verdict === "VETO",
        spineVetoVerdict: contractSpine.veto.verdict,
        spineVetoReason: contractSpine.veto.summary,
        dangerHardBlocked: dangerComposition.isHardBlocked,
        dangerReason: dangerComposition.autoBlock[0]?.detail,
      },
      null,
      null,
    );

    const vetoHard = Boolean(
      vetoRes.governanceVerdict === "VETO" ||
      digitPsychology.hardBlock ||
      dangerComposition.isHardBlocked ||
      contractSpine.veto.verdict === "VETO" ||
      paContract.veto,
    );
    const vetoActive = Boolean(
      vetoHard ||
      vetoRes.governanceVerdict === "SUPPRESS" ||
      contractSpine.veto.verdict === "SUPPRESS" ||
      contractSpine.veto.verdict === "CAUTION" ||
      lsp.verdict === "SUPPRESS" ||
      lsp.state === "PRESSURED",
    );
    const vetoReason =
      vetoRes.reason ||
      (contractSpine.veto.verdict !== "ALLOW" ? contractSpine.veto.summary : undefined) ||
      undefined;

    // 13. Winning-Side Momentum Engine (#12)
    const wsm = winningSideMomentum(intel.digitIntel ?? null, winners);

    // 14. Combination Learning (Stage 3.5)
    const comboLookup = comboLearning.lookup({
      symbol: intel.symbol,
      contract: c.id,
      regime: intel.regime?.label || "UNKNOWN",
      entryCondition: "IMMEDIATE",
    });
    const comboEvidence: ComboEvidence = comboLookup.exact;

    // 15. Realized Performance & Empirical Calibration
    const simTrades = (apexSimulator.exportMarket(intel.symbol) ?? []).filter(
      (t) => t.contract === c.id && (t.result === "WIN" || t.result === "LOSS"),
    );
    const historicalOutcomes: HistoricalOutcome[] = simTrades.map((t) => ({
      score: t.state?.opportunity ?? c.opportunity ?? 50,
      win: t.result === "WIN",
      market: t.symbol,
      contract: t.contract,
      regime: t.state?.regime ?? intel.regime?.label,
      at: t.resolvedAt ?? t.openedAt,
    }));

    const calibrationResult: CalibrationResult = calibrateScore(
      c.opportunity ?? 50,
      historicalOutcomes,
      {
        symbol: intel.symbol,
        contract: c.label ?? c.id,
        regime: intel.regime?.label ?? null,
        theoreticalBaseline: c.theoretical ?? 0.5,
      },
    );

    // 16. Sequential Probability Ratio Test (SPRT)
    const outcomeBools = simTrades.map((t) => t.result === "WIN");
    const sequentialTestResult: SequentialTestReport = sequentialTestFromEdge(
      outcomeBools,
      c.theoretical ?? 0.5,
      5,
    );

    // 17. Full Contextual Sub-Engines
    const contractWithEdge = {
      ...c,
      winners,
      losers,
      edge: (c.empirical ?? c.winRate ?? c.theoretical ?? 0.5) - (c.theoretical ?? 0.5),
      edgeLB: (c.ciLower ?? c.empirical ?? c.theoretical ?? 0.5) - (c.theoretical ?? 0.5),
      n: c.n ?? c.sample ?? 1000,
    };
    const setupQuality = computeSetup({
      intel,
      contract: contractWithEdge,
      lifetime: sim.perf ?? null,
      recent: recentPerf ?? null,
      danger: dangerComposition,
    });
    const comboResult = comboLearning.lookup({
      symbol: intel.symbol,
      contract: c.id,
      regime: intel.regime?.label ?? "UNKNOWN",
      entryCondition: entryLabRec?.currentTrigger ?? "IMMEDIATE",
    });
    const entryClearance = assessEntryClearance({
      setup: setupQuality,
      danger: dangerComposition,
      combo: comboResult,
      triggerActive: Boolean(entryLabRec?.activeNow),
      losingSidePressure: lsp,
    });
    const survival = evaluateExecutionSurvival({
      symbol: intel.symbol,
      contract: c.id,
      contractLabel: c.label || c.id,
      digits: digits as number[],
      winners,
      entryDigit:
        recommendedDigit,
    });
    const survInfluence = survivalInfluence(survival);
    const entryTrigger = evaluateEntryTrigger({
      symbol: intel.symbol,
      contract: c.id,
      contractLabel: c.label || c.id,
      digits: digits as number[],
      winners,
      entryDigit:
        recommendedDigit,
    });
    const convergence = computeConvergence({
      distributionChange: canonicalState.change,
      psychologyVerdict: digitPsychology.verdict,
      priceActionAgrees:
        paContract.alignment === "CONFIRMING"
          ? true
          : paContract.alignment === "CONTRADICTING" || paContract.alignment === "TAKEOVER"
            ? false
            : null,
      entryValidated: hasValidatedEntryDigit(entryPoint),
      stability: survival?.sufficient ? survival.postEntryStability : null,
      survivalAligned: survival?.sufficient ? survival.deteriorationPoint === null : null,
    });
    const evidenceFusion = fuseEvidence([
      {
        source: "DIGIT_PSYCHOLOGY",
        label: `${c.label} digit psychology`,
        signal: (digitPsychology.score - 50) / 50,
        confidence: digitPsychology.confidence ?? 50,
        summary: digitPsychology.summary ?? "Digit psychology reading.",
      },
      {
        source: "PRESSURE",
        label: `${c.label} group pressure`,
        signal: Math.max(-1, Math.min(1, (winPressure.ratePp - losePressure.ratePp) / 10)),
        confidence: pressureField.measurable ? 70 : 35,
        summary: `Winning-side share ${Math.round(winPressure.pct15)}% vs losing-side ${Math.round(losePressure.pct15)}%.`,
      },
      {
        source: "PRICE_ACTION",
        label: `${c.label} price action`,
        signal:
          paContract.alignment === "CONFIRMING"
            ? 0.7
            : paContract.alignment === "CONTRADICTING" || paContract.alignment === "TAKEOVER"
              ? -0.7
              : 0,
        confidence: paContract.measurable ? 65 : 30,
        summary: `Price-action alignment ${paContract.alignment}.`,
      },
      {
        source: "CONTEXT_MARKOV",
        label: `${c.label} context markov`,
        signal: 0,
        confidence: 40,
        summary: "Context Markov contribution.",
      },
    ]);
    const patternTags = buildPatternTags({
      contractId: c.id,
      side,
      entryDigit: recommendedDigit,
      regime: regimeReport.state,
      psychologyVerdict: digitPsychology.verdict,
      losingSideState: lsp.state,
      alignment: paContract.alignment,
    });
    const governance = evaluateSignalGovernance({
      market: intel.symbol,
      contract: c.label,
      entryDigit: recommendedDigit,
      dangerTotal: dangerComposition.total,
      hasDangerAutoBlock: dangerComposition.isHardBlocked,
      lspState: lsp.state,
      lspVerdict: lsp.verdict,
      regimeState: regimeReport.state,
      patternTags,
      hasValidatedEntry: hasValidatedEntryDigit(entryPoint),
    });
    const operatorSpecial = operatorSpecialDigitAction(side, winners, intel);
    const governedSpine = runVetoEngine({
      structure: contractSpine.structure,
      validation,
      field: pressureField,
    });
    const marketLearning = marketProfiles.prior(
      intel.symbol,
      c.label,
      c.theoretical ?? (isOver ? 0.8 : 0.7),
    );
    const clearance = assessClearance({
      intel,
      contract: contractWithEdge,
      recent: recentPerf ?? null,
      lifetime: sim.perf ?? null,
      maxDanger: 60,
      maxLosingThreat: 70,
    });
    const evidenceStatus = classifyEvidence({
      lifetime: sim.perf ?? null,
      recent: recentPerf ?? null,
      theoretical: c.theoretical ?? (isOver ? 0.8 : 0.7),
      clearance,
      entry: entryRec ?? null,
    });
    const direction = computeDirection(intel, contractWithEdge, contractSpine);

    // Comprehensive multi-engine consensus and agreement evaluation
    const simWinOk = (sim.perf?.winRate ?? 0) >= (c.theoretical ?? 0.7);
    const recentWinOk = (recentPerf?.winRate ?? 0) >= (c.theoretical ?? 0.7);
    const dangerCalm = !dangerComposition.isHardBlocked && dangerComposition.total <= 35;
    const dangerCritical = dangerComposition.isHardBlocked || dangerComposition.total >= 60;
    const baseAgreement = engineAgreement(contractWithEdge);

    const directionStrong = direction.label === "STRONG" && direction.disagreement <= 20;
    const directionModerate = direction.label === "MODERATE" && direction.disagreement <= 35;
    const directionOppose = direction.label === "AGAINST" || direction.disagreement >= 50;

    const fusionStrong = evidenceFusion.consensus === "STRONG_SUPPORT";
    const fusionModerate = evidenceFusion.consensus === "MODERATE_SUPPORT";
    const fusionConflict =
      evidenceFusion.consensus === "CONFLICT" || evidenceFusion.consensus === "STRONG_CONFLICT";

    let agreementBonus = 0;
    if (
      fusionConflict ||
      directionOppose ||
      baseAgreement === "STRONG CONFLICT" ||
      dangerCritical
    ) {
      agreementBonus =
        (fusionConflict && directionOppose) || baseAgreement === "STRONG CONFLICT" ? -5 : -3;
    } else if (baseAgreement === "CONFLICT" || direction.disagreement >= 40) {
      agreementBonus = -1.5;
    } else if (fusionStrong && directionStrong && simWinOk && dangerCalm) {
      agreementBonus = 5;
    } else if ((fusionStrong || directionStrong) && (simWinOk || recentWinOk) && dangerCalm) {
      agreementBonus = 3.5;
    } else if ((fusionModerate || directionModerate) && (baseAgreement === "SUPPORT" || simWinOk)) {
      agreementBonus = 2;
    } else if (simWinOk && recentWinOk && dangerCalm && !directionOppose) {
      agreementBonus = 1;
    } else {
      agreementBonus = 0;
    }
    const manipulationScore = computeManipulation(canonicalState.pct);

    return {
      marketId,
      proposition: prop,
      timestamp,
      sourceTickId,
      tickSequence: digits.length,
      analysisVersion: ANALYSIS_VERSION,

      psychology: {
        direction: psychDirection,
        state: psychState,
        support: psychSupport,
        raw: { structure, digitPsychology, canonicalState },
      },
      entryDigit: {
        digit: recommendedDigit,
        state: entryDigitState,
        support: entrySupport,
        dangerousCompetitor,
        raw: entryPoint,
      },
      pressure: {
        byWindow: pressureByWindow,
        candidateDigitTrend,
        raw: { winPressure, losePressure, pressureField },
      },
      losingSidePressure: {
        state: lspState,
        severity: lspSeverity,
        raw: lsp,
      },
      liquiditySweep,
      danger: {
        total: dangerComposition.total,
        level: dangerComposition.level,
        isHardBlocked: dangerComposition.isHardBlocked,
        components: dangerComposition.components,
        summary: dangerComposition.summary,
        raw: dangerComposition,
      },
      simulation: {
        state: simState,
        sampleSize: sim.perf.n,
        conditionedOnRegime: true,
        raw: { sim, recentPerf },
      },
      regime: {
        classification: regimeClassification,
        confidence: intel.regime?.strength ?? regimeReport.confidence ?? 0.4,
        transitioning: regimeTransitioning,
        compatibility: regimeCompatibility,
        raw: { regime: intel.regime, regimeReport },
      },
      momentum: {
        side: momentumSide,
        state: momentumState,
        strength: Math.min(1, Math.max(0, Math.abs(winPressure.ratePp) / 10)),
        winningSideMomentum: wsm,
        // PHASE 13 — the authoritative directional momentum reading that also
        // fed the danger composition above. Exposed so the observation layer,
        // ranking and the UI all read the SAME momentum object.
        directional: dirMomentum,
        raw: { spinePressure: winPressure, wsm, directional: dirMomentum },
      },

      trigger: {
        state: triggerState,
        raw: { entryLabRec },
      },
      veto: {
        active: vetoActive,
        hard: vetoHard,
        reason: vetoReason,
        raw: { spineVeto: contractSpine.veto, lsp, paContract, digitPsychology, dangerComposition },
      },
      statistics: {
        strength:
          (intel.ticks ?? 0) >= 800
            ? "STRONG"
            : (intel.ticks ?? 0) >= 400
              ? "MODERATE"
              : (intel.ticks ?? 0) >= 200
                ? "WEAK"
                : "INSUFFICIENT",
        sampleSize: intel.ticks ?? 0,
        calibration: calibrationResult,
        sequentialTest: sequentialTestResult,
        combination: comboEvidence,
        raw: { stats: intel.stats, historicalOutcomes, comboLookup },
      },
      hiddenBehavior: {
        state: intel.buildup?.detected ? "EMERGING" : "NONE",
        description: intel.buildup?.reason,
      },
      contractContext: c,
      marketContext: intel,
      governance,
      governedSpine,
      operatorLearning,
      guidance,
      survival,
      survivalInfluence: survInfluence,
      entryTrigger,
      contextMarkov,
      convergence,
      evidenceFusion,
      setupQuality,
      entryClearance,
      operatorSpecial,
      marketLearning,
      clearance,
      evidenceStatus,
      direction,
      agreementBonus,
      manipulationScore,
      priceAction: paContract,
      priceActionField: paField,
      entryPoint,
      combination: comboEvidence,
      regimeReport,
    };
  });
}
