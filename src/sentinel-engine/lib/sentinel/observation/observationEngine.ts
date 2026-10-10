import {
  ALL_CELL_IDS,
  MARKET_IDS,
  PROPOSITIONS,
  parseCellId,
  type CellId,
  type MarketId,
  type Proposition,
} from "./constants";
import { ObservationCell } from "./observationCell";
import { RegimeTracker } from "./regimeLayer";
import { QualificationManager } from "./qualification";
import type { EngineEvidenceInput } from "./engineAdapter";
import type {
  CellFeedbackPostMortem,
  MarketThesis,
  ObservationDossier,
  ObservationEngineHealthReport,
  ObservationEvent,
  QualifiedOpportunity,
} from "./types";
import { assessQuality, selectivityCalibrationCheck } from "./selectivity";
import { interpretMomentum } from "./momentumLayer";
import type { ObservationPersistenceAdapter } from "./persistence";
import { LocalObservationPersistenceAdapter } from "./supabasePersistence";

/** PHASE 15D — bounded per-cell identity memory (ticks retained per cell). */
const IDENTITY_MEMORY_PER_CELL = 256;

export interface OverviewEntry {
  dossier: ObservationDossier;
  explanation: string;
  qualification: QualifiedOpportunity | null;
  rank: number;
}

const STATE_WEIGHT: Record<string, number> = {
  RIPE: 6,
  CONFIRMING: 5,
  DEVELOPING: 4,
  INTERESTING: 3,
  UNSTABLE: 2,
  CONFLICT: 1,
  WATCHING: 0,
  DECAYING: 1,
  VETOED: -1,
  REJECTED: -1,
  ABANDONED: -2,
  EXPIRED: -2,
};

/**
 * §22 — the single integration point the rest of Sentinel talks to.
 * Owns the 90 observation cells (§2), shares one evidence stream per market
 * (§16 — no per-cell WebSocket connections), tracks regime transitions to
 * force re-evaluation of waiting opportunities (§5), and runs qualification
 * (§10) whenever a cell reaches RIPE.
 */
export class ObservationEngine {
  private cells = new Map<CellId, ObservationCell>();
  private regimeTracker = new RegimeTracker();
  readonly qualificationManager = new QualificationManager();
  private persistence: ObservationPersistenceAdapter = new LocalObservationPersistenceAdapter();

  // Health and telemetry metrics
  private lastIngestAt = 0;
  private lastTickAt = 0;
  private errorsCount = 0;
  private lastError: string | null = null;
  /** Exactly-once ingestion bookkeeping (per cell source identity). */
  private lastAcceptedTs = new Map<CellId, number>();
  /** PHASE 15D — recently accepted deterministic observation identities per cell. */
  private acceptedIdentities = new Map<CellId, Set<string>>();
  /** Insertion order per cell, so the identity memory stays strictly bounded. */
  private identityOrder = new Map<CellId, string[]>();
  private acceptedCount = 0;
  private duplicateCount = 0;
  private staleCount = 0;
  private weakIdentityCount = 0;



  constructor() {
    for (const id of ALL_CELL_IDS) {
      const { marketId, proposition } = parseCellId(id);
      const cell = new ObservationCell(marketId, proposition);
      this.cells.set(id, cell);
    }
    this.bindCellTransitions();
    // Hydrate existing persisted state before first live ingest
    void this.hydrate();
  }

  private bindCellTransitions(): void {
    for (const [id, cell] of this.cells.entries()) {
      cell.setOnTransition((event) => {
        void this.persistence.appendEvent(id, event);
      });
    }
  }

  /**
   * Hydrates all 90 cells with persisted dossiers and recent event logs (§4.5).
   */
  async hydrate(): Promise<number> {
    let count = 0;
    try {
      const dossiers = await this.persistence.loadAllDossiers();
      for (const [rawId, dossier] of Object.entries(dossiers)) {
        const id = rawId as CellId;
        const cell = this.cells.get(id);
        if (cell && dossier) {
          const events = await this.persistence.loadRecentEvents(id);
          cell.hydrate(dossier, events);
          count += 1;
        }
      }
    } catch (err) {
      this.recordIngestError(err);
    }
    return count;
  }

  setPersistenceAdapter(adapter: ObservationPersistenceAdapter) {
    this.persistence = adapter;
    this.bindCellTransitions();
  }

  getPersistenceAdapter(): ObservationPersistenceAdapter {
    return this.persistence;
  }

  recordIngestError(err: unknown): void {
    this.errorsCount += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  /** Exactly-once ingestion telemetry: accepted vs rejected observations. */
  getIngestStats(): {
    accepted: number;
    duplicates: number;
    stale: number;
    weakIdentity: number;
    lastIngestAt: number;
  } {
    return {
      accepted: this.acceptedCount,
      duplicates: this.duplicateCount,
      stale: this.staleCount,
      weakIdentity: this.weakIdentityCount,
      lastIngestAt: this.lastIngestAt,
    };
  }

  /**
   * PHASE 15D — DETERMINISTIC OBSERVATION IDENTITY.
   *
   * Timestamp alone is NOT a universal identity: two legitimate observations
   * can share a millisecond depending on source precision, reconnect replay,
   * or normalisation. The identity is therefore composed of the real source
   * identifiers available in this pipeline:
   *
   *   marketId | proposition | sourceTickId (Deriv epoch@quote) | analysisVersion
   *
   * FALLBACK: when no Deriv source tick is available (synthetic digit arrays,
   * tests, history-only bootstrap) there is no source identifier to use. The
   * identity then falls back to `ts:<timestamp>#<tickSequence>` and the
   * observation is counted in `weakIdentity`. Limitation: under the fallback,
   * two genuinely distinct observations sharing both a timestamp and a tick
   * count are indistinguishable and the second is treated as a duplicate.
   */
  observationIdentity(input: EngineEvidenceInput): { key: string; weak: boolean } {
    const version = input.analysisVersion ?? "unversioned";
    const base = `${input.marketId}|${input.proposition}|v=${version}`;
    if (input.sourceTickId) return { key: `${base}|tick=${input.sourceTickId}`, weak: false };
    return {
      key: `${base}|ts=${input.timestamp}#n=${input.tickSequence ?? 0}`,
      weak: true,
    };
  }

  /**
   * Test/reset hook — rebuilds every cell from scratch and clears ingest
   * bookkeeping, so isolated suites do not inherit observations from earlier
   * runs. Not used by the live pipeline.
   */
  resetCells(): void {
    this.cells.clear();
    for (const id of ALL_CELL_IDS) {
      const { marketId, proposition } = parseCellId(id);
      this.cells.set(id, new ObservationCell(marketId, proposition));
    }
    this.bindCellTransitions();
    this.qualificationManager.clear();
    this.resetIngestGuards();
  }

  /** Test/reset hook — clears exactly-once bookkeeping only. */
  resetIngestGuards(): void {

    this.lastAcceptedTs.clear();
    this.acceptedIdentities.clear();
    this.identityOrder.clear();
    this.acceptedCount = 0;
    this.duplicateCount = 0;
    this.staleCount = 0;
    this.weakIdentityCount = 0;
  }



  getHealthStatus(): ObservationEngineHealthReport {
    const totalCells = this.cells.size;
    let activeCells = 0;
    let ripeCount = 0;
    let confirmingCount = 0;
    let developingCount = 0;
    let vetoedCount = 0;

    for (const cell of this.cells.values()) {
      const dossier = cell.getDossier();
      if (dossier !== null) {
        activeCells += 1;
        if (dossier.state === "RIPE") {
          ripeCount += 1;
        } else if (dossier.state === "CONFIRMING") {
          confirmingCount += 1;
        } else if (dossier.state === "DEVELOPING") {
          developingCount += 1;
        }
        if (dossier.veto?.active || dossier.state === "VETOED") {
          vetoedCount += 1;
        }
      }
    }

    const now = Date.now();
    const isLiveStreaming = this.lastIngestAt > 0;
    const staleIngest = isLiveStreaming && now - this.lastIngestAt > 25_000;
    const hasFatalErrors =
      isLiveStreaming && this.errorsCount > 25 && now - this.lastIngestAt > 30_000;

    let status: ObservationEngineHealthReport["status"] = "HEALTHY";
    let message = `Operating normally with ${activeCells}/${totalCells} active observation cells.`;

    if (totalCells === 0 || hasFatalErrors) {
      status = "UNHEALTHY";
      message = `Observation engine degraded: ${this.lastError || "Ingestion interrupted"}.`;
    } else if (staleIngest) {
      status = "DEGRADED";
      message = `No tick updates received for ${((now - this.lastIngestAt) / 1000).toFixed(1)}s.`;
    } else if (activeCells > 0 && activeCells < 15) {
      status = "DEGRADED";
      message = `Partial universe coverage (${activeCells}/${totalCells} cells active).`;
    } else if (!isLiveStreaming && activeCells === 0) {
      status = "HEALTHY";
      message = "Observation engine initialized across all 90 cells (awaiting live stream ticks).";
    }

    const lastTickLatencyMs = isLiveStreaming
      ? Math.max(0, Math.min(9999, now - this.lastIngestAt))
      : 0;

    const calibrationCheck = selectivityCalibrationCheck(activeCells, ripeCount);

    return {
      status,
      message,
      lastIngestTimestamp: this.lastIngestAt,
      lastSuccessfulCycle: this.lastTickAt,
      errorCount: Math.round(this.errorsCount),
      lastError: this.lastError,
      healthyCount: activeCells,
      ripeCount,
      activeCellsCount: activeCells,
      cellsObserved: activeCells,
      cellsTotal: totalCells,
      cellsRipe: ripeCount,
      cellsActive: activeCells,
      cellsVetoed: vetoedCount,
      ingestErrors: Math.round(this.errorsCount),
      lastTickLatencyMs,
      calibrationCheck,
    };
  }

  getAllTheses(): MarketThesis[] {
    const theses: MarketThesis[] = [];
    for (const cell of this.cells.values()) {
      const dossier = cell.getDossier();
      if (dossier?.thesis) {
        theses.push(dossier.thesis);
      }
    }
    return theses;
  }

  getThesesByMarket(marketId: MarketId): MarketThesis[] {
    const theses: MarketThesis[] = [];
    for (const prop of PROPOSITIONS) {
      const id = `${marketId}:${prop}` as CellId;
      const cell = this.cells.get(id);
      const dossier = cell?.getDossier();
      if (dossier?.thesis) {
        theses.push(dossier.thesis);
      }
    }
    return theses;
  }

  /**
   * Returns all active observed cells sorted by composite score descending (§7).
   * Unobserved cells (where getDossier() is null) are strictly excluded from the
   * returned list without mutating cell state (no synthetic ingest or state advance).
   * Hard-vetoed / hard-blocked cells are forced to the bottom regardless of score.
   */
  getAllRanked(): ObservationDossier[] {
    const dossiers: ObservationDossier[] = [];
    for (const cell of this.cells.values()) {
      const dossier = cell.getDossier();
      if (!dossier) continue;
      dossiers.push(dossier);
    }

    return dossiers.sort((a, b) => {
      const aBlocked = Boolean(
        a.veto?.hard || a.danger?.isHardBlocked || (a.veto?.active && a.veto?.hard),
      );
      const bBlocked = Boolean(
        b.veto?.hard || b.danger?.isHardBlocked || (b.veto?.active && b.veto?.hard),
      );

      if (aBlocked && !bBlocked) return 1;
      if (!aBlocked && bBlocked) return -1;

      return (b.score ?? 0) - (a.score ?? 0);
    });
  }

  getCellInstance(marketId: MarketId, proposition: Proposition): ObservationCell | undefined {
    return this.cells.get(`${marketId}:${proposition}` as CellId);
  }

  getCellById(id: CellId): ObservationCell | undefined {
    return this.cells.get(id);
  }

  /**
   * §22.9 — Ingests trade outcomes and operator feedback directly into the observation layer.
   * Analyzes what the trade looked like at the time of execution, extracts post-mortem
   * lessons, and immediately informs the corresponding observation cell and qualification manager.
   */
  ingestTradeFeedback(
    trade: {
      id: string;
      outcome: "WIN" | "LOSS" | "CANCELLED" | "PENDING";
      snapshot: {
        symbol: string;
        contract: string;
        contractLabel?: string;
        entryDigit?: number | null;
        danger: number;
        losingSidePressureState?: string | null;
        losingSidePressureIndex?: number | null;
        regime?: string | null;
        agreement?: string | null;
      };
      feedback?: {
        text: string;
        category?: string | null;
      } | null;
    },
    note?: { text: string; category?: string | null } | null,
  ): CellFeedbackPostMortem | null {
    const marketId = trade.snapshot.symbol;
    const rawContract = trade.snapshot.contract;

    // §7: Resolve single exact target proposition. Cross-proposition spreading is strictly forbidden.
    const exactProp = resolveExactProposition(rawContract);
    if (!exactProp) {
      console.warn(
        `[ObservationEngine] Malformed or unresolvable contract '${rawContract}' in trade feedback for ${marketId}. Cross-proposition spreading is strictly forbidden.`,
      );
      return null;
    }

    const matchingProps: Proposition[] = [exactProp];

    const outcome = trade.outcome;
    const category = note?.category ?? trade.feedback?.category ?? null;
    const text =
      note?.text ??
      trade.feedback?.text ??
      (outcome === "LOSS" ? "Trade loss recorded by operator" : "Trade win recorded by operator");

    const actionableDirectives: string[] = [];
    if (outcome === "LOSS" || (category && category !== "STRONG SIGNAL")) {
      if (trade.snapshot.entryDigit !== undefined && trade.snapshot.entryDigit !== null) {
        actionableDirectives.push(
          `Penalize entry digit ${trade.snapshot.entryDigit} on subsequent setups`,
        );
      }
      if (
        trade.snapshot.losingSidePressureState === "INCREASING" ||
        trade.snapshot.losingSidePressureState === "ACCELERATING"
      ) {
        actionableDirectives.push("Require strictly declining losing-side pressure");
      }
      if (trade.snapshot.danger > 25) {
        actionableDirectives.push(
          `Elevate danger scrutiny (execution danger was ${trade.snapshot.danger.toFixed(0)})`,
        );
      }
      if (category) {
        actionableDirectives.push(`Operator noted concern: ${category}`);
      }
    } else {
      actionableDirectives.push("Reinforce setup parameters from confirmed positive execution");
    }

    const summary =
      outcome === "LOSS"
        ? `Loss registered on ${marketId} ${trade.snapshot.contractLabel || rawContract} (Entry digit: ${trade.snapshot.entryDigit ?? "none"}, Danger: ${trade.snapshot.danger.toFixed(0)}${trade.snapshot.losingSidePressureState ? `, Losing pressure: ${trade.snapshot.losingSidePressureState}` : ""}${category ? `, Concern: ${category}` : ""}). Immediate post-mortem caution applied.`
        : `Confirmed WIN on ${marketId} ${trade.snapshot.contractLabel || rawContract} (Entry digit: ${trade.snapshot.entryDigit ?? "none"}).`;

    const postMortem: CellFeedbackPostMortem = {
      sourceId: trade.id,
      timestamp: Date.now(),
      outcome,
      category,
      text,
      executionDanger: trade.snapshot.danger,
      entryDigit: trade.snapshot.entryDigit ?? null,
      losingSidePressureState: trade.snapshot.losingSidePressureState ?? null,
      losingSidePressureIndex: trade.snapshot.losingSidePressureIndex ?? null,
      regime: trade.snapshot.regime ?? null,
      agreement: trade.snapshot.agreement ?? null,
      summary,
      actionableDirectives,
    };

    for (const prop of matchingProps) {
      const id = `${marketId}:${prop}` as CellId;
      const cell = this.cells.get(id);
      if (cell) {
        cell.ingestFeedbackPostMortem(postMortem);
        this.qualificationManager.handleFeedback(id, postMortem);
      }
    }

    return postMortem;
  }

  clearFeedbackState(): void {
    for (const cell of this.cells.values()) {
      cell.clearFeedbackState();
    }
    this.qualificationManager.clear();
  }

  /**
   * §22.3/§22.6 — call once per mapped engine evidence update. One market
   * tick typically produces up to 6 calls (one per proposition on that
   * market) sharing the same underlying data stream.
   */
  ingest(input: EngineEvidenceInput): ObservationDossier {
    const id = `${input.marketId}:${input.proposition}` as CellId;
    const cell = this.cells.get(id);
    if (!cell) throw new Error(`Unknown observation cell: ${id}`);

    // ── Exactly-once ingestion guard (PHASE 15D) ────────────────────────
    // ApexCore is the single authoritative producer. Identity is deterministic
    // (market + proposition + real Deriv source tick + analysis version), NOT
    // timestamp-only: a replayed or re-mapped observation of the same source
    // tick can never advance Sentinel state twice, and a genuinely new
    // analysis version of the same tick is correctly accepted as distinct.
    const ts = input.timestamp || 0;
    const { key: identity, weak } = this.observationIdentity(input);

    let seenIdentities = this.acceptedIdentities.get(id);
    if (!seenIdentities) {
      seenIdentities = new Set<string>();
      this.acceptedIdentities.set(id, seenIdentities);
      this.identityOrder.set(id, []);
    }

    if (seenIdentities.has(identity)) {
      this.duplicateCount += 1;
      return cell.getDossier() ?? cell.ingest(input);
    }

    // Ordering guard: a NEW identity carrying an older timestamp is a
    // late/out-of-order delivery and must not rewind cell state.
    const seenTs = this.lastAcceptedTs.get(id);
    if (seenTs !== undefined && ts < seenTs) {
      this.staleCount += 1;
      return cell.getDossier() ?? cell.ingest(input);
    }

    seenIdentities.add(identity);
    const order = this.identityOrder.get(id)!;
    order.push(identity);
    // Bounded memory: retain only the most recent identities per cell.
    if (order.length > IDENTITY_MEMORY_PER_CELL) {
      const evicted = order.splice(0, order.length - IDENTITY_MEMORY_PER_CELL);
      for (const k of evicted) seenIdentities.delete(k);
    }

    this.lastAcceptedTs.set(id, Math.max(ts, seenTs ?? ts));
    this.acceptedCount += 1;
    if (weak) this.weakIdentityCount += 1;


    this.lastIngestAt = ts || Date.now();
    if (this.errorsCount > 0) {
      this.errorsCount = Math.max(0, this.errorsCount - 0.05);
    }

    const materialRegimeShift = this.regimeTracker.update(
      input.marketId,
      input.regime,
      input.timestamp,
    );
    const dossier = cell.ingest(input);


    if (materialRegimeShift) {
      this.reEvaluateMarket(input.marketId, input.timestamp);
    }

    if (dossier.state === "RIPE") {
      const opp = this.qualificationManager.attemptQualify(dossier, input.timestamp);
      if (opp) {
        void this.persistence.saveQualification(opp.snapshot);
      }
    }
    this.qualificationManager.monitorLiveHealth(id, dossier, input.timestamp);

    // Periodically or on active states save dossier snapshot to persistence
    if (
      dossier.state === "RIPE" ||
      dossier.state === "CONFIRMING" ||
      dossier.state === "DEVELOPING"
    ) {
      void this.persistence.saveDossierSnapshot(dossier);
    }

    return dossier;
  }

  /** §5 — force live-health re-evaluation of any waiting/active opportunity on a market whose regime just shifted materially. */
  private reEvaluateMarket(marketId: MarketId, now: number) {
    for (const prop of PROPOSITIONS) {
      const id = `${marketId}:${prop}` as CellId;
      const dossier = this.cells.get(id)?.getDossier() ?? null;
      this.qualificationManager.monitorLiveHealth(id, dossier, now);
    }
  }

  /** Periodic call (e.g. every second) independent of market data, to expire windows on schedule (§10.3). */
  tick(now: number): CellId[] {
    this.lastTickAt = now;
    return this.qualificationManager.sweepExpired(now);
  }

  getCell(
    marketId: MarketId,
    proposition: (typeof PROPOSITIONS)[number],
  ): {
    dossier: ObservationDossier | null;
    events: ObservationEvent[];
    qualification: QualifiedOpportunity | undefined;
  } {
    const id = `${marketId}:${proposition}` as CellId;
    const cell = this.cells.get(id)!;
    return {
      dossier: cell.getDossier(),
      events: cell.getEvents(),
      qualification: this.qualificationManager.get(id),
    };
  }

  /**
   * §18 — compact 15-market overview: ranks all 90 cells by maturity,
   * persistence, evidence coherence, stability, contradiction, veto state,
   * regime, and quality band — NOT by a single blended score — and returns
   * only the top N worth surfacing.
   */
  getOverview(limit = 12): OverviewEntry[] {
    const entries: OverviewEntry[] = [];

    for (const [id, cell] of this.cells.entries()) {
      const dossier = cell.getDossier();
      if (!dossier) continue;
      entries.push({
        dossier,
        explanation: cell.explainCurrent(),
        qualification: this.qualificationManager.get(id) ?? null,
        rank: 0,
      });
    }

    entries.sort((a, b) => {
      const stateDiff = (STATE_WEIGHT[b.dossier.state] ?? 0) - (STATE_WEIGHT[a.dossier.state] ?? 0);
      if (stateDiff !== 0) return stateDiff;

      const qualityDiff =
        qualityRank(assessQuality(b.dossier, b.dossier.momentumRelation).band) -
        qualityRank(assessQuality(a.dossier, a.dossier.momentumRelation).band);
      if (qualityDiff !== 0) return qualityDiff;

      const contradictionDiff = a.dossier.contradictions - b.dossier.contradictions;
      if (contradictionDiff !== 0) return contradictionDiff;

      return b.dossier.currentStateSince - a.dossier.currentStateSince;
    });

    return entries.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
  }

  getAllQualified(): QualifiedOpportunity[] {
    return this.qualificationManager.getAllActive();
  }
}

function qualityRank(band: "EXCEPTIONAL" | "STRONG" | "MODERATE" | "WEAK"): number {
  return { EXCEPTIONAL: 3, STRONG: 2, MODERATE: 1, WEAK: 0 }[band];
}

/**
 * Normalizes and resolves a raw contract string to a single exact proposition.
 * For example: "OVER2", "OVER_2", "Over 2", "OVER 2" -> "OVER2".
 * Never spreads to multiple propositions.
 */
export function resolveExactProposition(raw: string): Proposition | null {
  if (!raw) return null;
  const upper = raw
    .toUpperCase()
    .trim()
    .replace(/[\s_-]+/g, "");
  if (PROPOSITIONS.includes(upper as Proposition)) {
    return upper as Proposition;
  }
  const match = upper.match(/^(OVER|UNDER)([0-9])$/);
  if (match) {
    const candidate = `${match[1]}${match[2]}` as Proposition;
    if (PROPOSITIONS.includes(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const observationEngine = new ObservationEngine();

export { MARKET_IDS, PROPOSITIONS };
