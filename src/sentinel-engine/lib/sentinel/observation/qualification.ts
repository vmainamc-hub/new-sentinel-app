import { THRESHOLDS, type CellId } from "./constants";
import type {
  CellFeedbackPostMortem,
  ObservationDossier,
  QualificationSnapshot,
  QualifiedOpportunity,
  LiveHealth,
} from "./types";
import { checkHardVeto, assessQuality, type QualityBand } from "./selectivity";
import { interpretMomentum } from "./momentumLayer";
import { explainRipe } from "./explain";

/**
 * §10/§11 — manages the qualification snapshot and the fixed 90-second
 * execution window per cell. The snapshot is immutable once created;
 * live health is tracked completely separately and never mutates it.
 */
export class QualificationManager {
  private active = new Map<CellId, QualifiedOpportunity>();

  /**
   * Returns the active qualified opportunity for the given cellId, if present.
   */
  getActive(cellId: CellId): QualifiedOpportunity | null {
    return this.active.get(cellId) ?? null;
  }

  /**
   * Call when a cell is RIPE. Only actually qualifies if hard-veto-free and
   * quality clears the minimum bar (§9 — MODERATE or better; WEAK setups
   * remain observed but are not promoted, per the "selective but alive"
   * calibration target).
   */
  attemptQualify(dossier: ObservationDossier, now: number): QualifiedOpportunity | null {
    if (dossier.state !== "RIPE") return null;
    if (this.active.has(dossier.cellId)) return this.active.get(dossier.cellId)!;

    // Mandatory RED structure gate — checked first, and never compensable.
    // RED on the losing side, 2ND RED on the losing side, or the winning
    // side not gaining must block qualification outright, regardless of
    // PsychologyScore, statistics, or any other engine's reading. See
    // red-semantics.ts (classifyRedSemantics) for how this is computed.
    const redSemantics = dossier.psychology?.raw?.digitPsychology?.redSemantics;
    if (redSemantics?.mandatoryRedStructureFailed) return null;

    const veto = checkHardVeto(dossier);
    if (veto.vetoed) return null;

    // Sequential test gate (§SPRT): disproven edge candidate cannot qualify
    if (dossier.statistics.sequentialTest?.verdict === "DISPROVEN") {
      return null;
    }

    // Combination learning gate (Stage 3.5): untested, failing, or deteriorating combination cannot qualify
    const comboState = dossier.statistics.combination?.state;
    if (comboState === "UNTESTED" || comboState === "FAILING" || comboState === "DETERIORATING") {
      return null;
    }

    // Operator feedback caution handling: if caution is active, require elevated selectivity
    if (dossier.feedbackLearning?.cautionActive) {
      if (dossier.feedbackLearning.recentLosses >= 2) {
        return null;
      }
    }

    const momentumRelation = interpretMomentum(dossier.proposition, dossier.momentum);
    const quality = assessQuality(dossier, momentumRelation);
    if (quality.band === "WEAK") return null;

    // Calibration gate: require sufficient calibration data before promoting MODERATE candidates
    if (
      quality.band === "MODERATE" &&
      dossier.statistics.calibration?.reliabilityState === "INSUFFICIENT CALIBRATION DATA"
    ) {
      return null;
    }

    // When under recent post-mortem caution, only qualify on STRONG or EXCEPTIONAL setups
    if (dossier.feedbackLearning?.cautionActive && quality.band === "MODERATE") {
      return null;
    }

    const snapshot: QualificationSnapshot = {
      cellId: dossier.cellId,
      marketId: dossier.marketId,
      proposition: dossier.proposition,
      qualifiedAt: now,
      qualificationConfidence: dossier.statistics.strength,
      qualificationRegime: dossier.regime.classification,
      qualificationRegimeConfidence: dossier.regime.confidence,
      qualificationRegimeTransition: dossier.regime.transitioning,
      qualificationMomentum: momentumRelation,
      qualificationDigit: dossier.entryDigit.digit,
      qualificationStructure: dossier.psychology,
      qualificationPressure: dossier.pressure,
      qualificationDanger: dossier.danger,
      qualificationStatistics: dossier.statistics,
      qualificationTrigger: dossier.trigger,
      executionWindowStartedAt: now,
      executionWindowExpiresAt: now + THRESHOLDS.EXECUTION_WINDOW_MS, // fixed — never rolls forward (§10.3)
      explanation: explainRipe(dossier, momentumRelation),
    };

    const opportunity: QualifiedOpportunity = {
      snapshot,
      stage: "EXECUTION_WINDOW_ACTIVE",
      liveHealth: "HEALTHY",
      liveHealthReason: "Just qualified.",
    };

    this.active.set(dossier.cellId, opportunity);
    return opportunity;
  }

  /**
   * §10.2/§11.8 — updates live health from the CURRENT dossier without ever
   * touching the frozen snapshot. Minor fluctuation stays HEALTHY; material
   * deterioration is INVALIDATED immediately regardless of remaining window
   * time; otherwise AT_RISK is a genuine distinct intermediate state.
   */
  monitorLiveHealth(
    cellId: CellId,
    currentDossier: ObservationDossier | null,
    now: number,
  ): QualifiedOpportunity | null {
    const opp = this.active.get(cellId);
    if (!opp) return null;

    if (now >= opp.snapshot.executionWindowExpiresAt) {
      opp.liveHealth = "EXPIRED";
      opp.liveHealthReason = "Execution window elapsed.";
      this.active.delete(cellId);
      return opp;
    }

    if (!currentDossier) {
      opp.liveHealth = "AT_RISK";
      opp.liveHealthReason = "No current evidence available.";
      return opp;
    }

    const veto = checkHardVeto(currentDossier);
    if (veto.vetoed || currentDossier.state === "VETOED" || currentDossier.state === "REJECTED") {
      opp.liveHealth = "INVALIDATED";
      opp.liveHealthReason = veto.reason ?? "Material invalidating condition.";
      this.active.delete(cellId);
      return opp;
    }

    const regimeMaterialShift =
      currentDossier.regime.classification !== opp.snapshot.qualificationRegime &&
      currentDossier.regime.compatibility === "INCOMPATIBLE";
    if (regimeMaterialShift) {
      opp.liveHealth = "INVALIDATED";
      opp.liveHealthReason = "Regime shifted materially and is no longer compatible.";
      this.active.delete(cellId);
      return opp;
    }

    if (currentDossier.trigger.state === "FAILED") {
      opp.liveHealth = "INVALIDATED";
      opp.liveHealthReason = "Entry trigger failed.";
      this.active.delete(cellId);
      return opp;
    }

    if (
      currentDossier.danger &&
      (currentDossier.danger.isHardBlocked || currentDossier.danger.level === "CRITICAL")
    ) {
      opp.liveHealth = "INVALIDATED";
      opp.liveHealthReason = `Danger spiked to critical (${currentDossier.danger.total}/100): ${currentDossier.danger.summary}`;
      this.active.delete(cellId);
      return opp;
    }

    // Graduated risk, not immediate invalidation, for softer deterioration.
    const atRisk =
      currentDossier.psychology.support !== "SUPPORTING" ||
      currentDossier.losingSidePressure.state === "INCREASING" ||
      currentDossier.losingSidePressure.state === "ACCELERATING" ||
      currentDossier.stability === "HIGHLY_UNSTABLE" ||
      currentDossier.contradictions >= 2 ||
      (currentDossier.danger &&
        (currentDossier.danger.level === "HIGH" || currentDossier.danger.total >= 45));

    opp.liveHealth = atRisk ? "AT_RISK" : "HEALTHY";
    opp.liveHealthReason = atRisk
      ? currentDossier.danger && currentDossier.danger.total >= 45
        ? `Danger elevated (${currentDossier.danger.total}/100) since qualification.`
        : "Underlying evidence has softened since qualification."
      : "Setup remains healthy.";
    return opp;
  }

  get(cellId: CellId): QualifiedOpportunity | undefined {
    return this.active.get(cellId);
  }

  getAllActive(): QualifiedOpportunity[] {
    return [...this.active.values()];
  }

  /**
   * §22.8 — Immediate Feedback Reaction in Qualification Manager.
   * Immediately invalidates any active qualification for a cell when an adverse outcome
   * or operator concern is registered, preventing stale signals from persisting.
   */
  handleFeedback(cellId: CellId, postMortem: CellFeedbackPostMortem): QualifiedOpportunity | null {
    const opp = this.active.get(cellId);
    if (!opp) return null;

    if (
      postMortem.outcome === "LOSS" ||
      (postMortem.category && postMortem.category !== "STRONG SIGNAL")
    ) {
      opp.liveHealth = "INVALIDATED";
      opp.liveHealthReason = `Operator feedback: Loss / concern registered (${postMortem.summary}). Window invalidated.`;
      this.active.delete(cellId);
      return opp;
    }
    return opp;
  }

  clear(): void {
    this.active.clear();
  }

  /** Periodic sweep — call regularly (e.g. every second) to expire windows even without new market data. */
  sweepExpired(now: number): CellId[] {
    const expired: CellId[] = [];
    for (const [id, opp] of this.active.entries()) {
      if (now >= opp.snapshot.executionWindowExpiresAt) {
        opp.liveHealth = "EXPIRED";
        opp.liveHealthReason = "Execution window elapsed.";
        expired.push(id);
        this.active.delete(id);
      }
    }
    return expired;
  }
}
