// APEX SENTINEL — cross-market ranking + SCAN NOW.
// SCAN NOW does NOT start analysis. The core is always analysing; this
// interrogates the latest intelligence state and answers: what is the
// strongest opportunity right now?
//
// Display adapter wrapping the 90-cell continuous observation engine (§7).

import { apexCore } from "./core";
import { marketProfiles } from "./profiles";
import { confirmedTrades, listPendingTrades } from "../sentinel/trade-feedback";
import { calibrateScore } from "../sentinel/calibration";
import { sequentialTestFromEdge } from "../sentinel/sequential-test";
import { resolveSignalState } from "../sentinel/signal-state";
import { resolveVeto } from "../sentinel/veto-resolver";
import { computeManipulation } from "../precision-scanner/scoring";
import { scanMemory, type ScanMemoryEntry } from "../sentinel/scan-memory";
import { UNKNOWN_REGIME } from "../sentinel/combination-learning";
import {
  observationEngine,
  mapIntelToObservationInputs,
  type Proposition,
  PROPOSITIONS,
} from "@/sentinel-engine/lib/sentinel/observation";
import { assessQuality } from "@/sentinel-engine/lib/sentinel/observation/selectivity";
import type { MarketIntel, RankedOpportunity, ScanResult, ContractEval, BestOf90Result, BestOf90Status, RankFactor } from "./types";
import { PRIMARY_CONTRACTS } from "./types";
import type { EntryPointReport } from "../sentinel/entry-point";
import type { CanonicalDigitState } from "@/sentinel-engine/lib/sentinel/digit-psychology";
import { evaluateExecutionReady } from "../sentinel/execution-ready";
import type { SetupReport } from "../sentinel/setup";
import type { EntryClearanceReport } from "../sentinel/entry-clearance";
import type { RelativeEdgeReport } from "../sentinel/relative-edge";
import type { PersistenceReport } from "../sentinel/scan-memory";
import { operatorSurfaceGate } from "./operator-surface-gate";
import { selectSurfacedOpportunity, surfaceVetRank } from "./surface-vetting";
import { buildFinalRank, type FinalRankEntry } from "./final-rank";
import { FinalDecisionEngine } from "../sentinel/final-decision";
import { CircuitBreakerEngine } from "../risk/circuit-breaker";
import { NearSignalEngine } from "../sentinel/near-signal";

export interface ScanOptions {
  /** Extra score awarded to Under 7 / Over 2 — the operator's primary
   *  contracts. A preference window, not a hard override. */
  preferenceWindow: number;
  /** Minimum opportunity score to call something a real opportunity. */
  opportunityThreshold: number;
  /** Reject contracts above this danger level. */
  maxDanger: number;
  /** Minimum ticks required for a market to be considered. */
  minTicks: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  preferenceWindow: 4,
  opportunityThreshold: 70,
  maxDanger: 65,
  minTicks: 400,
};

export function globalDanger(intels: MarketIntel[]): number {
  const usable = intels.filter((i) => i.dataState === "OK" || i.dataState === "THIN");
  if (!usable.length) return 100;
  const mean = usable.reduce((a, i) => a + i.danger, 0) / usable.length;
  const hostile = usable.filter((i) => i.danger > 60).length / usable.length;
  return Math.round(Math.max(0, Math.min(100, mean * 0.7 + hostile * 100 * 0.3)));
}

function synthesizeDefaultContract(marketId: string, prop: Proposition): ContractEval {
  const side = prop.startsWith("OVER") ? "OVER" : "UNDER";
  const barrier = parseInt(prop.replace(/\D/g, ""), 10) || (side === "OVER" ? 2 : 7);
  const winners =
    side === "OVER"
      ? Array.from({ length: 9 - barrier }, (_, i) => barrier + 1 + i)
      : Array.from({ length: barrier }, (_, i) => i);
  const theoretical = winners.length / 10;

  return {
    id: prop as any,
    label: `${side === "OVER" ? "Over" : "Under"} ${barrier}`,
    side,
    barrier,
    winners,
    theoretical,
    empirical: theoretical,
    recent: theoretical,
    micro: theoretical,
    n: 100,
    edge: 0,
    edgeLB: 0,
    pressureAsymmetry: 0,
    transitionSupport: 0,
    compositeEdge: 0,
    stability: 50,
    freshness: 50,
    quality: 50,
    danger: 20,
    confidence: 50,
    opportunity: 50,
    phase: "MATURE",
    supports: [],
    conflicts: [],
    contradiction: 0,
    ageTicks: 100,
    threat: null,
    critical: null,
    stats: null,
    rate: null,
    ensemble: null,
    forward: null,
    analogue: null,
    fakeEdge: null,
    regimeCompatible: true,
    regimeNote: "Regime compatible",
    threatPenalty: 0,
    alerts: [],
  };
}

function synthesizeDefaultIntel(marketId: string): MarketIntel {
  const contracts: ContractEval[] = PROPOSITIONS.map((p) => synthesizeDefaultContract(marketId, p));
  return {
    symbol: marketId,
    name: marketProfiles.get(marketId)?.name ?? marketId,
    dataState: "OK",
    ticks: 1000,
    lastTickAt: Date.now(),
    ageMs: 0,
    stats: null,
    pressure: null,
    transition: null,
    sequence: null,
    entropy: null,
    anomaly: null,
    volatility: null,
    trend: null,
    regime: null,
    personality: null,
    buildup: null,
    quality: null,
    danger: 20,
    contracts,
    best: contracts[0],
    updatedAt: Date.now(),
    digitIntel: null,
    bars: null,
    criticalReport: null,
    battle: null,
    deepTicks: 1000,
    psychology: null,
    specialDigits: null,
    fluctuation: null,
  };
}

export function rankOpportunities(
  intels: MarketIntel[],
  opts: ScanOptions = DEFAULT_SCAN_OPTIONS,
  /**
   * Only an explicit SCAN NOW writes to the rolling scan history. The live
   * table re-ranks every second and must not pollute scan-to-scan persistence.
   */
  recordHistory = false,
): {
  /**
   * THE single authoritative final ranking of the whole observed population.
   * `ranked[0]` is the one and only Rank #1 — qualified or not.
   */
  ranked: RankedOpportunity[];
  /** Qualification/status attached per candidate, in the same order as `ranked`. */
  rankEntries: FinalRankEntry<RankedOpportunity>[];
  rejected: ScanResult["rejected"];
  exposureReport?: import("@/sentinel-engine/types/sentinel").PortfolioExposureReport;
  circuitBreaker?: import("@/sentinel-engine/types/sentinel").CircuitBreakerState;
} {
  const rejected: ScanResult["rejected"] = [];

  // READ-ONLY. ApexCore is the single authoritative producer of Sentinel
  // observations; ranking never ingests, never qualifies and never mutates
  // engine state. It only classifies unusable markets for the reject list.
  for (const intel of intels) {
    if (intel.dataState === "UNAVAILABLE") {
      rejected.push({ symbol: intel.symbol, contract: "—", reason: "DATA UNAVAILABLE" });
      continue;
    }
    if (intel.dataState === "STALE") {
      rejected.push({ symbol: intel.symbol, contract: "—", reason: "DATA STALE — feed silent" });
      continue;
    }
    if (intel.ticks < opts.minTicks) {
      rejected.push({
        symbol: intel.symbol,
        contract: "—",
        reason: `DATA THIN — ${intel.ticks} ticks (< ${opts.minTicks})`,
      });
    }
  }


  // Get all 90 cells ranked by composite score descending with hard blocks forced to bottom
  const allRankedDossiers = observationEngine.getAllRanked();

  const intelMap = new Map<string, MarketIntel>();
  for (const intel of intels) {
    intelMap.set(intel.symbol, intel);
  }

  const pastTrades = confirmedTrades().map((t) => ({
    score: t.snapshot.score,
    win: t.outcome === "WIN",
    market: t.snapshot.symbol,
    contract: t.snapshot.contract,
    at: t.resolvedAt ?? t.ts,
  }));

  const ranked: RankedOpportunity[] = allRankedDossiers.map((dossier, index) => {
    const marketId = dossier.marketId;
    const prop = dossier.proposition;
    const intel = intelMap.get(marketId) ?? synthesizeDefaultIntel(marketId);
    const contract =
      intel.contracts?.find((c) => c.id === prop) ?? synthesizeDefaultContract(marketId, prop);

    const isBlocked = Boolean(
      dossier.veto?.hard ||
      dossier.danger?.isHardBlocked ||
      (dossier.veto?.active && dossier.veto?.hard),
    );

    // Read-only: qualification is produced by ApexCore's ingestion path only.
    const qualification =
      observationEngine.qualificationManager.getActive(dossier.cellId) ?? null;


    const entryPoint: EntryPointReport = dossier.entryPoint ??
      (dossier.entryDigit?.raw as EntryPointReport) ??
      dossier.trigger?.raw?.entryPoint ?? {
        symbol: contract.label,
        contract: contract.id,
        contractLabel: contract.label,
        status: "UNVALIDATED",
        preferred: null,
        alternative: null,
        entryMargin: 0,
        runnerUpDigit: null,
        runnerUpScore: null,
        ranking: [],
        all: [],
        confidence: 0,
        window: {
          kind: "UNVALIDATED",
          value: 0,
          label: "Unvalidated",
          basis: "No validated entry digit",
        },
        invalidation: [],
        sampleSize: 0,
        rankingDelta: 0,
        changeState: "NEW",
        resolutionDigits: contract.winners,
        summary: dossier.assessment || "Entry point unvalidated / not ready.",
      };

    const setupReport: SetupReport = dossier.setupQuality ?? {
      score: dossier.score,
      grade:
        dossier.score >= 80
          ? "PRIME"
          : dossier.score >= 65
            ? "GOOD"
            : dossier.score >= 50
              ? "MARGINAL"
              : "POOR",
      summary: dossier.assessment,
      direction: prop.startsWith("OVER") ? "OVER" : "UNDER",
      factors: [],
    };

    const entryClearanceReport: EntryClearanceReport = dossier.entryClearance ?? {
      verdict: isBlocked ? "BLOCKED" : dossier.state === "RIPE" ? "CLEARED" : "WAIT",
      summary: dossier.assessment,
      requirements: [],
    };

    const survivalReport = dossier.survival ?? null;
    const entryTriggerReport = dossier.entryTrigger ?? null;
    const fallbackWinners = Array.isArray(contract.winners) ? contract.winners : [];
    const fallbackLosers = Array.from({ length: 10 }, (_, d) => d).filter(
      (d) => !fallbackWinners.includes(d),
    );
    const digitPsychologyReport = dossier.psychology?.raw?.digitPsychology ?? {
      contract: String(prop),
      side: String(prop).startsWith("OVER") ? "OVER" : "UNDER",
      barrier: contract.barrier ?? 0,
      winningZone: fallbackWinners,
      losingZone: fallbackLosers,
      boundary: [],
      score: 0,
      verdict: "UNVALIDATED",
      confidence: 0,
      positions: [],
      rankingDelta: 0,
      weightTotal: 0,
      gained: 0,
      hardBlock: false,
      hardBlockReason: undefined,
      zoneContested: false,
      zoneContestedReason: null,
      reasons: [],
      cautions: [],
      summary: "Digit psychology unavailable.",
    };
    const rawCanonical =
      dossier.psychology?.raw?.canonicalState ??
      dossier.stateEvidence?.canonicalState ??
      (intel?.psychology as any)?.canonicalState;
    const canonicalPct: number[] = Array.isArray(rawCanonical?.pct)
      ? rawCanonical.pct
      : Array(10).fill(10);
    const canonicalState: CanonicalDigitState = {
      n: typeof rawCanonical?.n === "number" ? rawCanonical.n : 0,
      windowSize: typeof rawCanonical?.windowSize === "number" ? rawCanonical.windowSize : 1000,
      pct: canonicalPct,
      recentPct: Array.isArray(rawCanonical?.recentPct) ? rawCanonical.recentPct : canonicalPct,
      deltaPp: Array.isArray(rawCanonical?.deltaPp) ? rawCanonical.deltaPp : Array(10).fill(0),
      green: rawCanonical?.green ?? null,
      secondGreen: rawCanonical?.secondGreen ?? null,
      red: rawCanonical?.red ?? null,
      secondRed: rawCanonical?.secondRed ?? null,
      mostIncreasing: rawCanonical?.mostIncreasing ?? null,
      mostDecreasing: rawCanonical?.mostDecreasing ?? null,
      change: rawCanonical?.change ?? "STABLE",
      changeDetail: rawCanonical?.changeDetail ?? "No canonical digit history yet.",
      summary: rawCanonical?.summary ?? "Canonical digit state unavailable.",
    };
    const priceActionReport = dossier.priceAction ?? {
      score: 0,
      verdict: "NEUTRAL",
      alignment: "NEUTRAL",
      rankingDelta: 0,
      veto: false,
      vetoReason: undefined,
    };
    const priceActionField = dossier.priceActionField ?? {
      recentPct: Array(10).fill(0.1),
      impulse: Array(10).fill(0),
    };
    const dangerComp = dossier.danger?.raw ?? {
      total: dossier.danger?.total ?? 0,
      level: dossier.danger?.level ?? "CALM",
      isHardBlocked: isBlocked,
      components: dossier.danger?.components ?? [],
      autoBlock: [],
      summary: dossier.danger?.summary ?? "Calm",
    };
    const governance = dossier.governance ?? null;
    const governedSpine = dossier.governedSpine ?? null;
    const calibration =
      dossier.statistics?.calibration ??
      calibrateScore(dossier.score, pastTrades, {
        symbol: marketId,
        contract: contract.label,
        regime: dossier.regime?.classification,
        theoreticalBaseline: contract.theoretical,
      });

    const sequentialTestReport =
      dossier.statistics?.sequentialTest ??
      sequentialTestFromEdge(
        pastTrades.map((t) => t.win),
        contract.theoretical,
        5,
      );

    const relativeEdgeReport: RelativeEdgeReport = dossier.relative ?? {
      key: `${marketId}:${prop}`,
      absoluteEdge: contract.compositeEdge,
      riskAdjustedEdge: contract.compositeEdge,
      relativeEdge: 0,
      relativeWithinMarket: 0,
      normalized: 0,
      fieldRank: index + 1,
      fieldSize: allRankedDossiers.length,
      label: "LEVEL",
      rankingDelta: 0,
      detail: "Evaluated by Continuous Observation Layer",
    };

    const persistenceReport: PersistenceReport = dossier.persistence ?? {
      key: `${marketId}:${prop}`,
      persistence:
        (dossier.evidenceMaturity as any)?.score ??
        (dossier.evidenceMaturity === "HIGH"
          ? 85
          : dossier.evidenceMaturity === "MODERATE"
            ? 60
            : 35),
      currentRank: index + 1,
      previousRank: null,
      averageRank: index + 1,
      topThree: index < 3 ? 1 : 0,
      scans: 1,
      edgeStability: 50,
      edgeSeries: [],
      edgeRange: 0,
      edgeStdDev: 0,
      rotation: "LOW",
      rotationChanges: 0,
      changeClass: "PERSISTENT",
      changeReasons: [],
      rankingDelta: 0,
      summary: "Observation layer active",
    };

    const signal = resolveSignalState({
      entryPoint,
      verdict: entryClearanceReport.verdict,
      grade: setupReport.grade,
      relative: relativeEdgeReport.label,
      blocked: isBlocked,
      survival: survivalReport,
      entryTrigger: entryTriggerReport,
    });

    const vetoResolution = resolveVeto(
      `${marketId}:${prop}`,
      {
        digitPsychologyHardBlock: digitPsychologyReport.hardBlock,
        digitPsychologyReason: digitPsychologyReport.hardBlockReason,
        priceActionVeto: priceActionReport.veto,
        priceActionReason: priceActionReport.vetoReason,
        losingSideSuppressed: dossier.losingSidePressure?.state === "ACCELERATING",
        losingSideReason: undefined,
        spineVeto: isBlocked,
        spineVetoReason: undefined,
        dangerHardBlocked: dangerComp.isHardBlocked,
        dangerReason: dangerComp.autoBlock?.[0]?.detail,
      },
      {
        isVetoed: dossier.state === "VETOED" || dossier.state === "REJECTED",
        isHardBlocked: isBlocked,
        isUnqualified: !qualification,
        state: dossier.state,
        liveHealth: qualification?.liveHealth,
        reason: isBlocked ? "Hard veto active" : undefined,
      },
      governance
        ? {
            vetoed: governance.vetoed,
            rule: governance.matchedRule?.rule,
            reason: governance.matchedRule?.reason,
            suggestedPenalty: governance.suggestedPenalty,
          }
        : undefined,
    );

    return {
      rank: index + 1,
      symbol: marketId,
      name: intel.name,
      contract: {
        ...contract,
        losingSidePressure: dossier.losingSidePressure?.raw ?? contract.losingSidePressure ?? null,
      },
      intel,
      score: dossier.score,
      preferred: PRIMARY_CONTRACTS.includes(prop as any),
      simulator: dossier.simulation?.raw?.sim?.perf ?? dossier.simulation?.raw?.perf ?? null,
      simNote: dossier.simulation?.raw?.sim?.note ?? dossier.simulation?.raw?.note ?? "",
      recent: dossier.simulation?.raw?.recentPerf ?? null,
      entry: dossier.trigger?.raw?.entryLabRec ?? null,
      agreement:
        dossier.thesis?.agreement === "STRONG CONFLICT"
          ? "STRONG CONFLICT"
          : dossier.thesis?.agreement === "CONFLICT"
            ? "CONFLICT"
            : dossier.thesis?.agreement === "STRONG SUPPORT" ||
                dossier.thesis?.agreement === "SUPPORT"
              ? "SUPPORT"
              : (dossier.agreementBonus ?? 0) <= -3
                ? "STRONG CONFLICT"
                : (dossier.agreementBonus ?? 0) < 0
                  ? "CONFLICT"
                  : (dossier.agreementBonus ?? 0) >= 1
                    ? "SUPPORT"
                    : "NEUTRAL",
      clearance: dossier.clearance ?? {
        state: isBlocked ? "BLOCKED" : "CLEARED",
        score: dossier.score,
        reason: "",
        threat: "LOW",
        maxDanger: opts.maxDanger,
        rules: [],
      },
      evidence: dossier.evidenceStatus ?? {
        confidence: dossier.score,
        band: dossier.score >= 70 ? "HIGH" : "MEDIUM",
        weight: 1,
        n: 100,
        summary: dossier.assessment,
      },
      blocked: isBlocked,
      vetoResolution,
      governance,
      spine: governedSpine,
      stateEvidence: dossier.stateEvidence ?? null,
      observationDossier: dossier,
      dossier,
      observationQualification: qualification,
      factors:
        Array.isArray((dossier as any).factors) && (dossier as any).factors.length > 0
          ? (dossier as any).factors
          : [
              {
                label: "1,000-Tick Digit Psychology",
                points: Math.round(digitPsychologyReport.score * 0.35),
                detail: `${digitPsychologyReport.verdict} (${digitPsychologyReport.score}/100) on canonical 1,000-tick distribution`,
              },
              {
                label: "Structural Direction",
                points: Math.round((dossier.direction?.score ?? 50) * 0.25),
                detail: `${dossier.direction?.side ?? (prop.startsWith("OVER") ? "OVER" : "UNDER")} alignment (${dossier.direction?.label ?? "NEUTRAL"})`,
              },
              {
                label: "Relative Edge",
                points: Math.round((relativeEdgeReport.relativeEdge ?? 0) * 5),
                detail: `${relativeEdgeReport.label} (vs ${relativeEdgeReport.fieldSize} cells)`,
              },
              {
                label: "Setup Quality",
                points: Math.round(setupReport.score * 0.2),
                detail: `Grade ${setupReport.grade} (${setupReport.score.toFixed(0)}/100)`,
              },
              {
                label: "Danger Clearance",
                points: -Math.round(dangerComp.total * 0.2),
                detail: `Danger ${dangerComp.total}/100 (${dangerComp.level})`,
              },
            ],
      invalidation:
        Array.isArray((dossier as any).invalidation) && (dossier as any).invalidation.length > 0
          ? (dossier as any).invalidation
          : [
              ...(entryPoint.invalidation ?? []),
              `Danger score exceeds safety boundary (score > 45)`,
              `Structural direction flips against ${prop.startsWith("OVER") ? "OVER" : "UNDER"}`,
              `Losing side pressure accelerates beyond 40% threshold`,
            ],
      direction: dossier.direction ?? {
        side: prop.startsWith("OVER") ? "OVER" : "UNDER",
        strength: 0,
        score: 0,
        label: "NEUTRAL",
        agreement: "NEUTRAL",
        votes: [],
      },
      dangerComposition: dangerComp,
      setup: setupReport,
      entryClearance: entryClearanceReport,
      combination: dossier.combination ??
        dossier.statistics?.combination ?? {
          exact: {
            symbol: intel.symbol,
            contract: prop,
            regime: UNKNOWN_REGIME,
            entryCondition: "UNKNOWN",
            key: `${intel.symbol}|${prop}|${UNKNOWN_REGIME}|UNKNOWN`,
            n: 0,
            wins: 0,
            losses: 0,
            weightedN: 0,
            weightedWinRate: -1,
            winRate: -1,
            lower: 0,
            weightedExpectancy: 0,
            expectancy: 0,
            netPnl: 0,
            maxDrawdown: 0,
            deteriorationPp: 0,
            currentStreak: 0,
            longestLosingStreak: 0,
            lastOutcomeAt: null,
            state: "INSUFFICIENT_DATA",
            confidence: 0,
            rankingDelta: 0,
            note: "No resolved outcomes recorded for this combination yet.",
          },
          bestEntryCondition: null,
          siblings: [],
          regimeSiblings: [],
        },

      entryPoint,
      survival: survivalReport,
      survivalInfluence: dossier.survivalInfluence ?? { factor: 1, delta: 0, label: "NEUTRAL" },
      entryTrigger: entryTriggerReport,
      digitPsychology: digitPsychologyReport,
      digitState: canonicalState,
      priceAction: priceActionReport,
      priceActionField,
      operatorSpecial: dossier.operatorSpecial ?? { digit: 1, action: "NEUTRAL", weight: 0 },
      convergence: dossier.convergence ?? { score: 0, state: "NOT_READY", dimensions: [] },
      regimeReport: dossier.regimeReport ?? dossier.regime?.raw?.regimeReport ?? null,
      evidenceFusion: dossier.evidenceFusion ?? null,
      calibration,
      sequentialTest: sequentialTestReport,
      contextMarkov: dossier.contextMarkov ?? null,
      signal,
      relative: relativeEdgeReport,
      persistence: persistenceReport,
      losingSidePressure: dossier.losingSidePressure?.raw ?? contract.losingSidePressure ?? null,
      qualityBand:
        dossier.qualityBand ?? assessQuality(dossier, dossier.momentumRelation ?? "NEUTRAL").band,
      reliabilityState: dossier.statistics?.calibration?.reliabilityState,
      executionReady:
        dossier.executionReady ??
        evaluateExecutionReady({
          side: prop.startsWith("OVER") ? "OVER" : "UNDER",
          winners: contract.winners,
          losers: contract.exposure?.losers ?? [],
          direction: dossier.direction,
          structureDirection: dossier.psychology?.direction,
          danger: dangerComp,
          canonicalState: {
            mostIncreasing: canonicalState.mostIncreasing ?? null,
            mostDecreasing: canonicalState.mostDecreasing ?? null,
          },
          digitPsychology: digitPsychologyReport,
          entryPoint,
          entryClearance: entryClearanceReport,
        }).executionReady,
      executionReadyReasons:
        dossier.executionReadyReasons ??
        evaluateExecutionReady({
          side: prop.startsWith("OVER") ? "OVER" : "UNDER",
          winners: contract.winners,
          losers: contract.exposure?.losers ?? [],
          direction: dossier.direction,
          structureDirection: dossier.psychology?.direction,
          danger: dangerComp,
          canonicalState: {
            mostIncreasing: canonicalState.mostIncreasing ?? null,
            mostDecreasing: canonicalState.mostDecreasing ?? null,
          },
          digitPsychology: digitPsychologyReport,
          entryPoint,
          entryClearance: entryClearanceReport,
        }).executionReadyReasons,
    };
  });

  // ── STAGE 4 RISK INTEGRATION ON THE FULL CANDIDATE POPULATION ──
  const pastTradeList = confirmedTrades();
  let consecutiveLosses = 0;
  for (let i = pastTradeList.length - 1; i >= 0; i--) {
    if (pastTradeList[i].outcome === "LOSS") {
      consecutiveLosses++;
    } else if (pastTradeList[i].outcome === "WIN") {
      break;
    }
  }

  let peakPnl = 0;
  let runningPnl = 0;
  let maxDrawdown = 0;
  for (const t of pastTradeList) {
    const pnl = t.outcome === "WIN" ? 1 * 0.38 : -1;
    runningPnl += pnl;
    if (runningPnl > peakPnl) peakPnl = runningPnl;
    const dd = peakPnl - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const sessionDrawdownPct = peakPnl > 0 ? (maxDrawdown / peakPnl) * 100 : 0;
  const gd = globalDanger(intels);
  const circuitBreaker = CircuitBreakerEngine.evaluate({
    consecutiveLosses,
    sessionDrawdownPct,
    sustainedGlobalDanger: gd,
  });

  const openPositions = listPendingTrades().map((t) => ({
    market: t.snapshot.symbol,
    stake: 1,
  }));

  const stage4 = FinalDecisionEngine.evaluateStage4(ranked, circuitBreaker, openPositions);
  const stage4Ranked = stage4.ranked.map((r) => ({
    ...r,
    nearSignal: NearSignalEngine.evaluate(r),
  }));

  // ── ONE AUTHORITATIVE FINAL RANKING ──
  // Operator qualification and Stage 4 clearance are ranking inputs, never a
  // second ranking: the whole population stays ranked, ranks are re-stamped,
  // and finalRank[0] is the single Rank #1 for every consumer.
  const { finalRank, entries: rankEntries } = buildFinalRank(
    stage4Ranked,
    opts.opportunityThreshold,
  );

  if (recordHistory) {
    scanMemory.record(
      finalRank.map((r) => ({
        key: `${r.symbol}:${r.contract.id}`,
        symbol: r.symbol,
        name: r.name,
        contract: r.contract.id,
        contractLabel: r.contract.label,
        rank: r.rank,
        score: r.score,
        absoluteEdge: r.contract.compositeEdge,
        relativeEdge: r.relative.relativeEdge,
        danger: r.contract.danger,
        agreement: r.agreement,
        evidenceConfidence: r.evidence.confidence,
        regime: r.intel.regime?.label ?? UNKNOWN_REGIME,
        verdict: r.entryClearance.verdict,
        entryDigit: r.entryPoint.preferred?.digit ?? null,
        entryCondition: r.entry?.best?.rule ?? null,
      })),
    );
  }

  return {
    ranked: finalRank,
    rankEntries,
    rejected,
    exposureReport: stage4.exposureReport,
    circuitBreaker,
  };
}

export function scanNow(
  intels: MarketIntel[],
  opts: ScanOptions = DEFAULT_SCAN_OPTIONS,
): ScanResult {
  const online = intels.filter((i) => i.dataState === "OK");
  const {
    ranked: finalRank,
    rankEntries,
    rejected,
    exposureReport,
    circuitBreaker,
  } = rankOpportunities(intels, opts, true);
  const gd = globalDanger(intels);
  // Surface vetting is a stable admission filter over the ONE authoritative
  // finalRank. It never changes the ranking or uses the qualification subset.
  const surfaceRank = surfaceVetRank(finalRank);
  const surfacedOpportunity = selectSurfacedOpportunity(finalRank);

  // Qualification is a STATUS attached to the authoritative ranking, never a
  // competing ranking. `qualified` is a subset of finalRank in finalRank order.
  const qualified = rankEntries.filter((e) => e.qualified).map((e) => e.candidate);

  // NO UNQUALIFIED FALLBACKS on the operator surface list — if nothing is
  // qualified, the surfaced list is strictly empty. Rank #1 is still reported.
  const top = qualified.slice(0, 5);

  // SINGLE RANK #1 — the Scan winner is always finalRank[0], qualified or not.
  // When it is not qualified it is presented with its blockers, never replaced.
  const leadCandidate = finalRank.length > 0 ? finalRank[0] : null;
  const leadEntry = rankEntries.length > 0 ? rankEntries[0] : null;
  let bestOf90: BestOf90Result | null = null;
  if (leadCandidate) {
    // Reuse the SAME gate evaluation that produced the ranking — no re-derivation.
    const gate =
      leadEntry?.gate ??
      operatorSurfaceGate(leadCandidate, leadCandidate.intel, {
        minScore: opts.opportunityThreshold,
      });
    const isHardBlocked = Boolean(
      leadCandidate.blocked ||
        (leadCandidate.dangerComposition?.total ?? 0) > 45 ||
        leadCandidate.clearance?.state === "BLOCKED" ||
        leadCandidate.finalDecision?.verdict === "BLOCKED" ||
        gate.blockers.some(
          (b) =>
            b.includes("DANGER") ||
            b.includes("VETO") ||
            b.includes("HARD") ||
            b.includes("CLEARANCE BLOCKED"),
        ),
    );

    const allBlockers = [...gate.blockers];
    if (leadCandidate.finalDecision && leadCandidate.finalDecision.verdict !== "CLEARED") {
      if (leadCandidate.finalDecision.summary && !allBlockers.includes(leadCandidate.finalDecision.summary)) {
        allBlockers.push(leadCandidate.finalDecision.summary);
      }
    }

    const isStage4Cleared = leadCandidate.finalDecision?.verdict === "CLEARED";
    const isFullyQualified = gate.qualified && isStage4Cleared;

    let status: BestOf90Status;
    if (!isFullyQualified) {
      if (isHardBlocked) {
        status = "BEST OF 90 — BLOCKED";
      } else if (leadCandidate.nearSignal?.isNearSignal) {
        status = "BEST OF 90 — NEAR-SIGNAL";
      } else {
        status = "BEST OF 90 — NOT QUALIFIED";
      }
    } else if (leadCandidate.executionReady) {
      status = "BEST OF 90 — EXECUTION READY";
    } else if (
      leadCandidate.entryPoint.status === "NOT_READY" ||
      leadCandidate.signal.waitForEntry ||
      leadCandidate.entryClearance.verdict === "WAIT" ||
      !leadCandidate.entryPoint.preferred ||
      leadCandidate.signal.waitForEntry
    ) {
      status = "BEST OF 90 — WAITING FOR ENTRY";
    } else {
      status = "BEST OF 90 — QUALIFIED";
    }

    bestOf90 = {
      rank: 1,
      populationSize: finalRank.length,
      bestOfPopulation: true,
      candidate: leadCandidate,
      status,
      qualified: isFullyQualified,
      blockers: allBlockers,
      executionReady: Boolean(leadCandidate.executionReady && isStage4Cleared),
      executionReadyReasons: leadCandidate.executionReadyReasons ?? [],
      waitForEntry: Boolean(
        leadCandidate.signal?.waitForEntry || !leadCandidate.entryPoint.preferred,
      ),
      analyzedAt: Date.now(),
      finalDecision: leadCandidate.finalDecision,
      recommendedStake: leadCandidate.recommendedStake,
      nearSignal: leadCandidate.nearSignal,
    };
  }

  let verdict: ScanResult["verdict"];
  let message: string;
  if (!online.length) {
    verdict = "DATA_UNAVAILABLE";
    message = "DATA UNAVAILABLE — no market is currently streaming enough ticks to analyse.";
  } else if (!surfacedOpportunity) {
    verdict = "NONE";
    message = "Observing 90 cells — No candidate currently passes the mandatory psychology + losing-side-pressure + observed-liquidity-sweep surface gate.";
  } else {
    verdict = "OPPORTUNITY";
    const lead = surfacedOpportunity;
    message = `${lead.contract.label} on ${lead.name} — QUALIFIED (${lead.score.toFixed(0)}/100, ${lead.setup.grade}). ${lead.entryPoint.preferred ? `Entry on digit ${lead.entryPoint.preferred.digit} (${lead.entryPoint.status}) — ${lead.entryPoint.window.label}.` : "Awaiting entry trigger digit."} ${lead.observationQualification?.snapshot.explanation ?? lead.setup.summary}`;
  }

  return {
    scannedAt: Date.now(),
    marketsOnline: online.length,
    marketsTotal: intels.length,
    evaluated: finalRank.length,
    globalDanger: gd,
    globalDangerLabel: gd < 35 ? "CALM" : gd < 65 ? "ELEVATED" : "HOSTILE",
    top,
    finalRank,
    surfaceRank,
    surfacedOpportunity,
    rankEntries,
    bestOf90,
    best: leadCandidate,
    rejected: rejected.slice(0, 40),
    verdict,
    message,
    exposureReport,
    circuitBreaker,
  };
}

/**
 * WHY NOT THE RUNNER-UP — a like-for-like comparison of the two best
 * candidates using only measured values. No narrative is invented: each line
 * is a real gap between two engine outputs.
 */
export function whyNotRunnerUp(top: RankedOpportunity, runner: RankedOpportunity): string[] {
  const out: string[] = [];
  const a = top.contract;
  const b = runner.contract;
  const gap = (label: string, x: number, y: number, unit = "", invert = false) => {
    const diff = x - y;
    if (Math.abs(diff) < 2) return;
    const better = invert ? diff < 0 : diff > 0;
    if (!better) return;
    out.push(
      `${label}: ${top.contract.label} ${x.toFixed(0)}${unit} vs ${runner.contract.label} ${y.toFixed(0)}${unit}.`,
    );
  };
  gap("Opportunity", top.score, runner.score);
  // ── Why #1 beat #2 on Psychology, Winning Momentum, Danger, Fluctuation, & Manipulation ──
  if (top.digitPsychology && runner.digitPsychology) {
    const topPsy = top.digitPsychology;
    const runPsy = runner.digitPsychology;
    if (Math.abs(topPsy.score - runPsy.score) >= 3 || topPsy.verdict !== runPsy.verdict) {
      out.push(
        `Digit psychology: ${top.contract.label} ${topPsy.score}/100 (${topPsy.verdict}) vs ${runner.contract.label} ${runPsy.score}/100 (${runPsy.verdict}).`,
      );
    }
  }
  const topWsm = top.contract.winningSideMomentum?.index ?? 0;
  const runWsm = runner.contract.winningSideMomentum?.index ?? 0;
  if (Math.abs(topWsm - runWsm) >= 5) {
    out.push(
      `Winning-side momentum: ${top.contract.label} ${topWsm.toFixed(0)}/100 (${top.contract.winningSideMomentum?.state ?? "FLAT"}) vs ${runner.contract.label} ${runWsm.toFixed(0)}/100 (${runner.contract.winningSideMomentum?.state ?? "FLAT"}).`,
    );
  }
  const topDanger = Math.max(top.contract.danger ?? 0, top.intel.danger ?? 0);
  const runDanger = Math.max(runner.contract.danger ?? 0, runner.intel.danger ?? 0);
  if (Math.abs(topDanger - runDanger) >= 4) {
    out.push(
      topDanger < runDanger
        ? `Minimal danger environment: ${top.name} is calmer (${topDanger.toFixed(0)}/100 vs ${runDanger.toFixed(0)}/100).`
        : `Runner-up has lower overall danger (${runDanger.toFixed(0)}/100 vs ${topDanger.toFixed(0)}/100) but loses on other core criteria.`,
    );
  }
  const topFluct = top.intel.fluctuation?.score ?? 50;
  const runFluct = runner.intel.fluctuation?.score ?? 50;
  if (Math.abs(topFluct - runFluct) >= 5) {
    out.push(
      topFluct < runFluct
        ? `Market fluctuation: ${top.name} is more stable (${topFluct}/100 vs ${runFluct}/100).`
        : `Runner-up has lower fluctuation (${runFluct}/100 vs ${topFluct}/100).`,
    );
  }
  const topPct = Array.isArray(top.digitState?.pct) ? top.digitState.pct : Array(10).fill(0.1);
  const runPct = Array.isArray(runner.digitState?.pct)
    ? runner.digitState.pct
    : Array(10).fill(0.1);
  const topManip = computeManipulation(topPct).value;
  const runManip = computeManipulation(runPct).value;
  if (Math.abs(topManip - runManip) >= 4) {
    out.push(
      topManip < runManip
        ? `Distribution integrity: ${top.name} has cleaner digit distribution (${topManip}/100 vs ${runManip}/100 manipulation index).`
        : `Runner-up has cleaner digit distribution (${runManip}/100 vs ${topManip}/100).`,
    );
  }
  // ── Why #1 beat #2 on the relative / persistence dimensions ───────────
  if (top.relative && runner.relative) {
    out.push(
      `Relative edge: ${top.contract.label} ${top.relative.relativeEdge >= 0 ? "+" : ""}${top.relative.relativeEdge.toFixed(2)} (${top.relative.label}, risk-adjusted ${top.relative.riskAdjustedEdge.toFixed(2)}) vs ${runner.contract.label} ${runner.relative.relativeEdge >= 0 ? "+" : ""}${runner.relative.relativeEdge.toFixed(2)} (${runner.relative.label}, risk-adjusted ${runner.relative.riskAdjustedEdge.toFixed(2)}).`,
    );
  }
  if (top.contract && runner.contract) {
    out.push(
      `Absolute edge: ${top.contract.compositeEdge.toFixed(1)} vs ${runner.contract.compositeEdge.toFixed(1)}.`,
    );
  }
  if (top.persistence && runner.persistence) {
    out.push(
      `Persistence: ${top.persistence.persistence}/100 (top-3 in ${top.persistence.topThree}/${top.persistence.scans} scans, avg rank ${top.persistence.averageRank}) vs ${runner.persistence.persistence}/100 (${runner.persistence.topThree}/${runner.persistence.scans}, avg rank ${runner.persistence.averageRank}).`,
    );
    out.push(
      `Edge stability across scans: ${top.persistence.edgeStability}/100 vs ${runner.persistence.edgeStability}/100.`,
    );
  }
  if (top.entryPoint && runner.entryPoint) {
    out.push(
      `Entry point: ${top.contract.label} — ${top.entryPoint.preferred ? `digit ${top.entryPoint.preferred.digit} (${top.entryPoint.status}, confidence ${top.entryPoint.confidence}/100)` : "no validated entry digit"}; ${runner.contract.label} — ${runner.entryPoint.preferred ? `digit ${runner.entryPoint.preferred.digit} (${runner.entryPoint.status}, confidence ${runner.entryPoint.confidence}/100)` : "no validated entry digit"}.`,
    );
  }
  gap("Quality", a.quality, b.quality);
  gap("Stability", a.stability, b.stability);
  gap("Freshness", a.freshness, b.freshness);
  gap("Danger (lower is better)", a.danger, b.danger, "", true);
  gap("Contradiction (lower is better)", a.contradiction, b.contradiction, "", true);
  if (a.threat && b.threat && Math.abs(a.threat.groupThreat - b.threat.groupThreat) >= 4) {
    out.push(
      a.threat.groupThreat < b.threat.groupThreat
        ? `Losing-side threat is lower: ${a.threat.groupThreat.toFixed(0)} (${a.threat.state}) vs ${b.threat.groupThreat.toFixed(0)} (${b.threat.state}).`
        : `Runner-up has the calmer losing side (${b.threat.groupThreat.toFixed(0)} vs ${a.threat.groupThreat.toFixed(0)}) but loses on other measures.`,
    );
  }
  if (top.simulator && runner.simulator && (top.simulator.n >= 25 || runner.simulator.n >= 25)) {
    out.push(
      `Simulator: ${top.contract.label} ${top.simulator.n ? `${(top.simulator.winRate * 100).toFixed(1)}% (N=${top.simulator.n})` : "no sample"} vs ${runner.contract.label} ${runner.simulator.n ? `${(runner.simulator.winRate * 100).toFixed(1)}% (N=${runner.simulator.n})` : "no sample"}.`,
    );
  }
  if (top.entry?.best || runner.entry?.best) {
    const fmt = (r: RankedOpportunity) =>
      r.entry?.best
        ? `${r.entry.best.label} (${r.entry.best.state}, expectancy ${(r.entry.best.expectancy * 100).toFixed(1)}% over N=${r.entry.best.n}${r.entry.activeNow ? ", trigger active" : ", trigger not firing"})`
        : "no validated entry condition";
    out.push(
      `Entry condition: ${top.contract.label} — ${fmt(top)}; ${runner.contract.label} — ${fmt(runner)}.`,
    );
  }
  if (top.agreement !== runner.agreement) {
    out.push(`Engine agreement: ${top.agreement} vs ${runner.agreement}.`);
  }
  out.push(
    `Evidence: ${top.evidence.status} at confidence ${top.evidence.confidence}/100 vs ${runner.evidence.status} at ${runner.evidence.confidence}/100.`,
  );
  if (!out.length)
    out.push("The two candidates are statistically close — the ranking gap is not material.");
  return out.slice(0, 12);
}

/**
 * WHY THIS MARKET RANKS WHERE IT DOES — a plain reading of the measured
 * dimensions behind a candidate's position. Every line is a real measurement:
 * supports, neutrals and cautions are separated instead of blended.
 */
export function whyRanksHere(r: RankedOpportunity): {
  headline: string;
  supports: string[];
  neutral: string[];
  cautions: string[];
} {
  const supports: string[] = [];
  const neutral: string[] = [];
  const cautions: string[] = [];

  const rel = r.relative;
  if (rel.relativeEdge >= 1.5)
    supports.push(
      `${rel.label} relative edge vs alternatives (${rel.relativeEdge >= 0 ? "+" : ""}${rel.relativeEdge.toFixed(2)}, field position ${rel.fieldRank}/${rel.fieldSize})`,
    );
  else if (rel.relativeEdge > -0.4)
    neutral.push(`Relative edge is level with the field (${rel.relativeEdge.toFixed(2)})`);
  else
    cautions.push(
      `Behind the field leader by ${Math.abs(rel.relativeEdge).toFixed(2)} risk-adjusted edge`,
    );

  if (r.contract.compositeEdge > 0)
    supports.push(
      `Absolute composite edge ${r.contract.compositeEdge.toFixed(1)} over ${r.contract.n} ticks`,
    );
  else cautions.push(`No positive absolute edge (${r.contract.compositeEdge.toFixed(1)})`);

  const p = r.persistence;
  if (p.scans < 2)
    neutral.push("No scan history yet — persistence and stability are not yet measurable");
  else {
    if (p.persistence >= 65)
      supports.push(
        `Top-3 in ${p.topThree}/${p.scans} recent scans (persistence ${p.persistence}/100)`,
      );
    else if (p.persistence >= 40)
      neutral.push(`Persistence ${p.persistence}/100 across ${p.scans} scans`);
    else cautions.push(`Weak persistence ${p.persistence}/100 — average rank ${p.averageRank}`);
    if (p.edgeStability >= 70)
      supports.push(`Edge held a narrow range across scans (stability ${p.edgeStability}/100)`);
    else if (p.edgeStability < 45)
      cautions.push(
        `Edge swung across scans (stability ${p.edgeStability}/100, σ ${p.edgeStdDev})`,
      );
  }
  if (p.rotation === "HIGH")
    cautions.push("Market rotation is HIGH — the field leader keeps changing");

  const d = r.dangerComposition;
  if (d.total < 45) supports.push(`Danger remains acceptable (${d.total}/100, ${d.level})`);
  else if (d.total < 65)
    neutral.push(`Danger is elevated but priced in (${d.total}/100, ${d.level})`);
  else cautions.push(`Danger is high (${d.total}/100, ${d.level})`);

  if (r.agreement === "SUPPORT") supports.push("Engines agree on the direction");
  else if (r.agreement === "NEUTRAL") neutral.push("Engine agreement is neutral");
  else cautions.push(`Engine agreement is ${r.agreement}`);

  if (r.evidence.confidence >= 60)
    supports.push(`Evidence ${r.evidence.status} at confidence ${r.evidence.confidence}/100`);
  else
    cautions.push(
      `Evidence quality limited — ${r.evidence.status} at ${r.evidence.confidence}/100`,
    );

  if (r.recent && r.recent.n >= 10)
    supports.push(
      `Recent window on this market: ${(r.recent.winRate * 100).toFixed(1)}% over N=${r.recent.n}`,
    );
  else neutral.push("Recency: no qualifying entries in the recent window yet");

  if (r.simulator && r.simulator.n < 25)
    cautions.push(`Simulator sample remains limited (N=${r.simulator.n})`);

  if (r.entryPoint.status === "ENTER NOW" || r.entryPoint.status === "ARMED")
    supports.push(
      `Entry point measured: digit ${r.entryPoint.preferred?.digit} at confidence ${r.entryPoint.confidence}/100`,
    );
  else if (r.entryPoint.status === "UNVALIDATED")
    neutral.push("Entry point not yet validated by sufficient conditional evidence");
  else cautions.push("Entry point INVALIDATED by current conditions");

  return {
    headline: `WHY THIS MARKET RANKS #${r.rank} — ${r.contract.label} on ${r.name} at score ${r.score.toFixed(1)}/100`,
    supports,
    neutral,
    cautions,
  };
}
