import type { CellId, MarketId, Proposition } from "./constants";
import { THRESHOLDS, cellId } from "./constants";
import type { EngineEvidenceInput } from "./engineAdapter";
import { createCellIdentity, deriveIdentityConformance, type CellIdentity } from "./cellIdentity";
import type {
  CellFeedbackLearning,
  CellFeedbackPostMortem,
  ConfirmationRead,
  ExecutionValidityWindow,
  MarketThesis,
  ObservationDossier,
  ObservationEvent,
  ObservationState,
  StabilityState,
} from "./types";
import { interpretMomentum } from "./momentumLayer";
import { TickConfirmationEngine } from "./tickConfirmationEngine";
import { checkHardVeto, assessQuality } from "./selectivity";
import { explainWaiting } from "./explain";
import { computeDossierScore } from "./scoring";
import { evaluateExecutionReady } from "../execution-ready";
import { observeLiquiditySweep, type LiquiditySweepObservation } from "../liquidity-sweep";

/** Evidence input after the cell guarantees a liquidity-sweep observation is present. */
type NormalizedEvidenceInput = EngineEvidenceInput & { liquiditySweep: LiquiditySweepObservation };

interface HistoryEntry {
  timestamp: number;
  input: EngineEvidenceInput;
}

/**
 * One of the 90 independent observation cells (§2, §7, §8).
 * Owns its own state, history, dossier, and event log. Never reads or is
 * read by any other cell's data — see §14.
 */
export class ObservationCell {
  readonly marketId: MarketId;
  readonly proposition: Proposition;
  readonly id: CellId;
  /**
   * The cell's permanent psychological identity (§5/§6 of the identity spec).
   * Set once here, from the proposition only, and never reassigned anywhere
   * else in this class — no tick, veto, danger reading, ranking outcome, or
   * qualification result may ever rewrite this reference. Every concrete cell receives its own frozen identity record; shared proposition
   * rules come from the immutable canonical template.
   */
  readonly identity: CellIdentity;

  state: ObservationState = "WATCHING";
  private createdAtTick = 0;
  private createdAtTimestamp = 0;
  private tickCounter = 0;
  private currentStateSinceTick = 0;
  private stateEnteredTimestamp = 0;
  private history: HistoryEntry[] = [];
  private events: ObservationEvent[] = [];
  private transitionsCount = 0;
  private contradictionStreak = 0;
  private cleanStreak = 0;
  private supportingStreak = 0;
  private vetoStreak = 0;
  private lastVetoReason: string | null = null;
  private tickConfirmationEngine = new TickConfirmationEngine();
  private lastInput: NormalizedEvidenceInput | null = null;
  private lastMeaningfulEvidenceTick = 0;
  private previousThesis: MarketThesis | null = null;

  // Feedback post-mortem learning
  private postMortems: CellFeedbackPostMortem[] = [];
  private cautionUntilTimestamp: number | null = null;
  private lastOutcome: "WIN" | "LOSS" | "CANCELLED" | "PENDING" | null = null;
  private lastOutcomeAt: number | null = null;
  private recentLosses = 0;
  private recentWins = 0;
  private activeConcern: string | null = null;
  private activeCategory: string | null = null;
  private activeDirectiveType: string | null = null;
  private postMortemAdvice: string | null = null;
  private onTransitionCallback: ((event: ObservationEvent) => void) | null = null;

  constructor(marketId: MarketId, proposition: Proposition) {
    this.marketId = marketId;
    this.proposition = proposition;
    this.id = cellId(marketId, proposition);
    this.identity = createCellIdentity(marketId, proposition, this.id);
    this.createdAtTimestamp = Date.now();
    this.stateEnteredTimestamp = this.createdAtTimestamp;
  }

  setOnTransition(callback: ((event: ObservationEvent) => void) | null): void {
    this.onTransitionCallback = callback;
  }

  /**
   * Restore cell state from a persisted snapshot or dossier.
   */
  hydrate(dossier: ObservationDossier, events?: ObservationEvent[]): void {
    this.state = dossier.state;
    this.tickCounter = dossier.observationAge ?? this.tickCounter;
    this.currentStateSinceTick = Math.max(0, this.tickCounter - (dossier.currentStateSince ?? 0));
    if (events && events.length) {
      this.events = [...events];
    }
    if (dossier.thesis) {
      this.previousThesis = { ...dossier.thesis };
    }
    if (dossier.feedbackLearning) {
      this.lastOutcome = dossier.feedbackLearning.lastOutcome;
      this.lastOutcomeAt = dossier.feedbackLearning.lastOutcomeAt;
      this.recentLosses = dossier.feedbackLearning.recentLosses;
      this.recentWins = dossier.feedbackLearning.recentWins;
      this.activeConcern = dossier.feedbackLearning.activeConcern;
      this.activeCategory = dossier.feedbackLearning.activeCategory;
      this.postMortemAdvice = dossier.feedbackLearning.postMortemAdvice;
      this.cautionUntilTimestamp = dossier.feedbackLearning.cautionUntil;
      this.postMortems = dossier.feedbackLearning.history ?? [];
    }
    if (dossier.tickConfirmation) {
      const count = Math.round(
        dossier.tickConfirmation.sampleSize * dossier.tickConfirmation.ratio,
      );
      const falses = dossier.tickConfirmation.sampleSize - count;
      const buffer = [...Array(count).fill(true), ...Array(Math.max(0, falses)).fill(false)];
      this.tickConfirmationEngine.hydrate(buffer);
    }
  }

  /**
   * §22.7 — Immediate Feedback & Post-Mortem absorption.
   * Directly informs the observation cell about trade outcome (WIN / LOSS) or operator concern,
   * triggering immediate diagnostic state adjustments without waiting for subsequent ticks.
   */
  ingestFeedbackPostMortem(postMortem: CellFeedbackPostMortem): void {
    this.postMortems.push(postMortem);
    if (this.postMortems.length > 20) this.postMortems.shift();

    this.lastOutcome = postMortem.outcome;
    this.lastOutcomeAt = postMortem.timestamp;
    this.activeConcern = postMortem.text;
    this.activeCategory = postMortem.category;
    this.postMortemAdvice = postMortem.actionableDirectives.join(" · ") || postMortem.summary;

    if (
      postMortem.outcome === "LOSS" ||
      (postMortem.category && postMortem.category !== "STRONG SIGNAL")
    ) {
      if (postMortem.outcome === "LOSS") {
        this.recentLosses += 1;
      }
      // 20-minute caution cooldown
      this.cautionUntilTimestamp = postMortem.timestamp + 20 * 60 * 1000;
      this.contradictionStreak += 1;
      this.supportingStreak = 0;

      // Immediate state reaction on loss / adverse concern: downshift if ripe or confirming
      const prevState = this.state;
      if (this.state === "RIPE" || this.state === "CONFIRMING") {
        this.state = "UNSTABLE";
        this.transitionsCount += 1;
        const transitionEvent: ObservationEvent = {
          timestamp: postMortem.timestamp,
          from: prevState,
          to: "UNSTABLE",
          reason: `FEEDBACK LOSS / CONCERN POST-MORTEM: ${postMortem.summary}`,
        };
        this.events.push(transitionEvent);
        this.onTransitionCallback?.(transitionEvent);
      } else {
        this.events.push({
          timestamp: postMortem.timestamp,
          from: this.state,
          to: this.state,
          reason: `OPERATOR FEEDBACK RECORDED: ${postMortem.summary}`,
        });
      }
    } else if (postMortem.outcome === "WIN" || postMortem.category === "STRONG SIGNAL") {
      this.recentWins += 1;
      this.cautionUntilTimestamp = null;
      this.events.push({
        timestamp: postMortem.timestamp,
        from: this.state,
        to: this.state,
        reason: `FEEDBACK WIN CONFIRMATION: ${postMortem.summary}`,
      });
    }
  }

  clearFeedbackState(): void {
    this.postMortems = [];
    this.cautionUntilTimestamp = null;
    this.lastOutcome = null;
    this.lastOutcomeAt = null;
    this.recentLosses = 0;
    this.recentWins = 0;
    this.activeConcern = null;
    this.activeCategory = null;
    this.activeDirectiveType = null;
    this.postMortemAdvice = null;
  }

  /** §22.3/§22.6 integration point: call once per tick/scan with mapped engine evidence. */
  ingest(input: EngineEvidenceInput): ObservationDossier {
    this.tickCounter += 1;
    const sweep = input.liquiditySweep ?? observeLiquiditySweep(
      [],
      this.proposition.startsWith("OVER") ? "OVER" : "UNDER",
      parseInt(this.proposition.replace(/\D/g, ""), 10) || (this.proposition.startsWith("OVER") ? 2 : 7),
    );
    const normalizedInput: NormalizedEvidenceInput = { ...input, liquiditySweep: sweep };
    if (this.createdAtTimestamp === 0) {
      this.createdAtTimestamp = normalizedInput.timestamp;
      this.stateEnteredTimestamp = normalizedInput.timestamp;
    }
    this.history.push({ timestamp: normalizedInput.timestamp, input: normalizedInput });
    if (this.history.length > THRESHOLDS.HISTORY_WINDOW) this.history.shift();

    const momentumRelation = interpretMomentum(this.proposition, normalizedInput.momentum);
    const stability = this.assessStability(normalizedInput);
    const contradictions = this.countContradictions(normalizedInput, momentumRelation);
    const confirmationRead = this.tickConfirmationEngine.record(normalizedInput);

    const hardVeto = checkHardVeto(
      this.buildRawDossier(normalizedInput, stability, contradictions, momentumRelation, confirmationRead),
    );

    this.updateStreaks(normalizedInput, contradictions, momentumRelation, hardVeto.vetoed, hardVeto.reason);
    const nextState = this.computeNextState(
      normalizedInput,
      stability,
      contradictions,
      hardVeto.vetoed,
      hardVeto.reason,
      confirmationRead,
    );

    if (nextState !== this.state) {
      this.transitionsCount += 1;
      const transitionEvent: ObservationEvent = {
        timestamp: normalizedInput.timestamp,
        from: this.state,
        to: nextState,
        reason: this.transitionReason(
          this.state,
          nextState,
          normalizedInput,
          stability,
          contradictions,
          hardVeto,
        ),
      };
      this.events.push(transitionEvent);
      this.state = nextState;
      this.currentStateSinceTick = this.tickCounter;
      this.stateEnteredTimestamp = normalizedInput.timestamp;
      this.onTransitionCallback?.(transitionEvent);
    }

    this.lastInput = normalizedInput;
    return this.buildDossier(normalizedInput, stability, contradictions, momentumRelation, confirmationRead);
  }

  getDossier(): ObservationDossier | null {
    if (!this.lastInput) return null;
    const stability = this.assessStability(this.lastInput);
    const contradictions = this.countContradictions(
      this.lastInput,
      interpretMomentum(this.proposition, this.lastInput.momentum),
    );
    const momentumRelation = interpretMomentum(this.proposition, this.lastInput.momentum);
    const confirmationRead = this.tickConfirmationEngine.getRead();
    return this.buildDossier(
      this.lastInput,
      stability,
      contradictions,
      momentumRelation,
      confirmationRead,
    );
  }

  getEvents(): ObservationEvent[] {
    return [...this.events];
  }

  getTickCounter(): number {
    return this.tickCounter;
  }

  getTransitionsCount(): number {
    return this.transitionsCount;
  }

  getHistoryLength(): number {
    return this.history.length;
  }

  getLastInput(): EngineEvidenceInput | null {
    return this.lastInput;
  }

  getVetoStreak(): number {
    return this.vetoStreak;
  }

  getLastVetoReason(): string | null {
    return this.lastVetoReason;
  }

  // -- internal ---------------------------------------------------------

  private buildRawDossier(
    input: NormalizedEvidenceInput,
    stability: StabilityState,
    contradictions: number,
    momentumRelation: ReturnType<typeof interpretMomentum>,
    confirmationRead: ConfirmationRead,
  ): ObservationDossier {
    return this.buildDossier(input, stability, contradictions, momentumRelation, confirmationRead);
  }

  private assessStability(input: EngineEvidenceInput): StabilityState {
    if (this.history.length < 5) return "DEVELOPING";

    const recent = this.history.slice(-10);
    const supportValues = recent.map((h) => h.input.psychology.support);
    const flips = supportValues.slice(1).filter((v, i) => v !== supportValues[i]).length;

    if (input.regime.transitioning) return "TRANSITIONING";
    if (flips >= 6) return "HIGHLY_UNSTABLE";
    if (flips >= 4) return "CHOPPY";
    if (flips >= 2) return "FLUCTUATING";
    if (
      this.currentStateSinceTick > 0 &&
      this.tickCounter - this.currentStateSinceTick >
        THRESHOLDS.MIN_OBSERVATION_SAMPLES_FOR_CONFIRMING
    )
      return "CALM";
    return "STABLE";
  }

  /** §7.3 — contradictions are explicit signals, never blended away. */
  private countContradictions(
    input: EngineEvidenceInput,
    momentumRelation: ReturnType<typeof interpretMomentum>,
  ): number {
    let n = 0;
    if (
      input.psychology.support === "SUPPORTING" &&
      (input.losingSidePressure.state === "INCREASING" ||
        input.losingSidePressure.state === "ACCELERATING" ||
        input.losingSidePressure.state === "HOSTILE" ||
        input.losingSidePressure.state === "TAKEOVER")
    )
      n += 1;
    if (input.entryDigit.state === "VALIDATED" && input.entryDigit.dangerousCompetitor) n += 1;
    if (momentumRelation === "CONFLICTING" && input.psychology.support === "SUPPORTING") n += 1;
    if (input.regime.compatibility === "INCOMPATIBLE" && input.psychology.support === "SUPPORTING")
      n += 1;
    if (
      (input.danger?.level === "HIGH" ||
        input.danger?.level === "CRITICAL" ||
        input.danger?.isHardBlocked) &&
      input.psychology.support === "SUPPORTING"
    )
      n += 1;
    const windows = Object.values(input.pressure.byWindow);
    if (windows.includes("SUPPORTING") && windows.includes("OPPOSING")) n += 1;
    return n;
  }

  private updateStreaks(
    input: EngineEvidenceInput,
    contradictions: number,
    momentumRelation: ReturnType<typeof interpretMomentum>,
    vetoed: boolean,
    vetoReason?: string,
  ) {
    if (vetoed) {
      this.vetoStreak += 1;
      this.lastVetoReason = vetoReason ?? null;
    } else {
      this.vetoStreak = 0;
      this.lastVetoReason = null;
    }

    if (contradictions >= 2) {
      this.contradictionStreak += 1;
      this.cleanStreak = 0;
    } else {
      this.contradictionStreak = 0;
      this.cleanStreak += 1;
    }

    const supporting =
      input.psychology.support === "SUPPORTING" &&
      input.entryDigit.state !== "WAITING" &&
      (input.losingSidePressure.state === "DECLINING" ||
        input.losingSidePressure.state === "STABLE");

    this.supportingStreak = supporting ? this.supportingStreak + 1 : 0;
    if (supporting || contradictions > 0) this.lastMeaningfulEvidenceTick = this.tickCounter;
  }

  /**
   * §8.1 state machine. Deliberately conservative: forward progress requires
   * persistence (never a single-tick burst — §7.4), and any hard veto or
   * material contradiction can move state backward regardless of how far
   * forward it had progressed.
   */
  private computeNextState(
    input: EngineEvidenceInput,
    stability: StabilityState,
    contradictions: number,
    vetoed: boolean,
    vetoReason: string | undefined,
    confirmationRead: ConfirmationRead,
  ): ObservationState {
    const s = this.state;

    if (vetoed) {
      if (s === "REJECTED" || s === "VETOED" || s === "CONFLICT") return s;
      // Advanced stages (RIPE, CONFIRMING, DECAYING): instant veto (no persistence delay)
      if (s === "RIPE" || s === "CONFIRMING" || s === "DECAYING") return "VETOED";
      // Early stages (WATCHING, INTERESTING, DEVELOPING, UNSTABLE): require consecutive persistence
      if (this.vetoStreak >= THRESHOLDS.VETO_SAMPLE_STREAK_FOR_REJECTION) {
        return "REJECTED";
      }
      return s;
    }
    if (input.veto.active && !input.veto.hard) {
      // soft veto: hold, do not advance, do not force backward
      if (s === "WATCHING" || s === "INTERESTING") return s;
    }

    if (this.contradictionStreak >= THRESHOLDS.CONTRADICTION_STREAK_FOR_CONFLICT) {
      return s === "RIPE" || s === "CONFIRMING" ? "CONFLICT" : s === "DEVELOPING" ? "CONFLICT" : s;
    }

    if (stability === "HIGHLY_UNSTABLE" && (s === "RIPE" || s === "CONFIRMING")) {
      return "UNSTABLE";
    }

    switch (s) {
      case "WATCHING": {
        const emerging =
          input.psychology.direction !== "NONE" && input.psychology.support !== "OPPOSING";
        return emerging &&
          this.tickCounter - this.createdAtTick >=
            THRESHOLDS.MIN_OBSERVATION_SAMPLES_FOR_INTERESTING / 4
          ? "INTERESTING"
          : "WATCHING";
      }
      case "INTERESTING": {
        const coherent =
          input.psychology.support === "SUPPORTING" &&
          Object.values(input.pressure.byWindow).filter((v) => v === "SUPPORTING").length >= 2;
        if (
          coherent &&
          this.tickCounter - this.currentStateSinceTick >=
            THRESHOLDS.MIN_OBSERVATION_SAMPLES_FOR_INTERESTING
        ) {
          return "DEVELOPING";
        }
        if (input.psychology.support === "OPPOSING") return "WATCHING";
        return "INTERESTING";
      }
      case "DEVELOPING": {
        if (contradictions >= 2) return "CONFLICT";
        const confirming =
          (confirmationRead.state === "CONFIRMING" || confirmationRead.state === "CONFIRMED") &&
          input.entryDigit.state !== "WAITING" &&
          (stability === "STABLE" || stability === "CALM" || stability === "DEVELOPING");
        if (confirming) return "CONFIRMING";
        if (input.psychology.support === "OPPOSING") return "WATCHING";
        if (
          this.tickCounter - this.lastMeaningfulEvidenceTick >=
          THRESHOLDS.EXPIRE_OBSERVATION_SAMPLES
        ) {
          return "WATCHING";
        }
        return "DEVELOPING";
      }
      case "CONFIRMING": {
        const ripe =
          confirmationRead.state === "CONFIRMED" &&
          input.entryDigit.state === "VALIDATED" &&
          input.trigger.state === "VALID" &&
          (input.regime.compatibility === "COMPATIBLE" ||
            input.regime.compatibility === "NEUTRAL_UNCERTAIN") &&
          !vetoed &&
          !(input.danger?.isHardBlocked ?? false);
        if (ripe) return "RIPE";
        if (
          confirmationRead.state === "BUILDING" ||
          confirmationRead.state === "INSUFFICIENT_SAMPLES"
        ) {
          return "DECAYING";
        }
        if (input.psychology.support === "OPPOSING") return "DEVELOPING";
        return "CONFIRMING";
      }
      case "RIPE": {
        if (
          confirmationRead.state === "BUILDING" ||
          confirmationRead.state === "INSUFFICIENT_SAMPLES"
        ) {
          return "DECAYING";
        }
        if (input.psychology.support !== "SUPPORTING") return "CONFIRMING";
        if (input.regime.compatibility === "INCOMPATIBLE") return "UNSTABLE";
        if (
          input.losingSidePressure.state === "HOSTILE" ||
          input.losingSidePressure.state === "TAKEOVER"
        ) {
          return "CONFLICT";
        }
        return "RIPE";
      }
      case "DECAYING": {
        if (confirmationRead.state === "CONFIRMING" || confirmationRead.state === "CONFIRMED") {
          return "CONFIRMING";
        }
        if (
          this.tickCounter - this.lastMeaningfulEvidenceTick >=
          THRESHOLDS.EXPIRE_OBSERVATION_SAMPLES
        ) {
          return "EXPIRED";
        }
        return "DECAYING";
      }
      case "CONFLICT": {
        if (this.cleanStreak >= THRESHOLDS.RECOVERY_STREAK) return "DEVELOPING";
        if (
          this.tickCounter - this.lastMeaningfulEvidenceTick >=
          THRESHOLDS.EXPIRE_OBSERVATION_SAMPLES
        ) {
          return "ABANDONED";
        }
        return "CONFLICT";
      }
      case "UNSTABLE": {
        if (stability === "STABLE" || stability === "CALM") return "CONFIRMING";
        if (
          this.tickCounter - this.lastMeaningfulEvidenceTick >=
          THRESHOLDS.EXPIRE_OBSERVATION_SAMPLES
        ) {
          return "ABANDONED";
        }
        return "UNSTABLE";
      }
      case "VETOED":
      case "REJECTED": {
        // Recoverable only once the disqualifying condition genuinely clears.
        if (
          !input.veto.active &&
          input.psychology.support !== "OPPOSING" &&
          input.regime.compatibility !== "INCOMPATIBLE" &&
          !(input.danger?.isHardBlocked ?? false)
        ) {
          return "DEVELOPING";
        }
        return s;
      }
      case "ABANDONED":
      case "EXPIRED": {
        const reemerging =
          input.psychology.direction !== "NONE" && input.psychology.support === "SUPPORTING";
        return reemerging ? "INTERESTING" : s;
      }
      default:
        return s;
    }
  }

  private transitionReason(
    from: ObservationState,
    to: ObservationState,
    input: EngineEvidenceInput,
    stability: StabilityState,
    contradictions: number,
    hardVeto: { vetoed: boolean; reason?: string },
  ): string {
    if (hardVeto.vetoed) return hardVeto.reason ?? "Hard veto active.";
    if (to === "CONFLICT") return "Contradictory evidence streams persisted.";
    if (to === "UNSTABLE") return `Underlying behavior became ${stability.toLowerCase()}.`;
    if (to === "RIPE") return "All required gates and vetoes cleared with sufficient persistence.";
    if (to === "DEVELOPING" && from === "CONFLICT") return "Contradictory pressure subsided.";
    if (to === "DEVELOPING" && from === "INTERESTING")
      return "Directional evidence became coherent across pressure windows.";
    if (to === "DECAYING") return "Supporting evidence stopped renewing.";
    if (to === "EXPIRED" || to === "ABANDONED")
      return "No meaningful evidence for an extended period.";
    if (to === "CONFIRMING" && from === "DEVELOPING")
      return "Evidence streams aligned with sufficient persistence.";
    return `${from} -> ${to}.`;
  }

  private buildThesis(
    input: EngineEvidenceInput,
    stability: StabilityState,
    contradictions: number,
  ): MarketThesis {
    const supCount = Object.values(input.pressure.byWindow).filter(
      (v) => v === "SUPPORTING",
    ).length;
    const oppCount = Object.values(input.pressure.byWindow).filter((v) => v === "OPPOSING").length;

    let currentPressure: MarketThesis["currentPressure"] = "UNKNOWN";
    if (supCount >= 3) {
      currentPressure = "SUPPORTIVE";
    } else if (oppCount >= 2 || (supCount >= 1 && oppCount >= 1)) {
      currentPressure = "CONTRADICTORY";
    } else if (supCount >= 1) {
      currentPressure = "MIXED";
    }

    const structuralDirection: MarketThesis["structuralDirection"] =
      input.psychology.direction === "OVER" || input.psychology.direction === "UNDER"
        ? input.psychology.direction
        : input.psychology.direction === "NONE"
          ? "NONE"
          : "UNKNOWN";

    const structuralConfidence: MarketThesis["structuralConfidence"] =
      input.psychology.support === "SUPPORTING" && stability === "STABLE"
        ? "HIGH"
        : input.psychology.support === "SUPPORTING" || input.psychology.support === "MIXED"
          ? "MEDIUM"
          : "LOW";

    const regimeSuitability: MarketThesis["regime"]["suitability"] =
      input.regime.compatibility === "COMPATIBLE"
        ? "HIGH"
        : input.regime.compatibility === "NEUTRAL_UNCERTAIN"
          ? "MEDIUM"
          : "LOW";

    const simState: MarketThesis["simulation"]["state"] =
      input.simulation.state === "FAVOURABLE" || input.simulation.state === "RECOVERING"
        ? "SUPPORTIVE"
        : input.simulation.state === "INSUFFICIENT"
          ? "INSUFFICIENT"
          : "UNSUPPORTIVE";

    const entryDigitConf: MarketThesis["entryDigit"]["confidence"] =
      input.entryDigit.state === "VALIDATED"
        ? "HIGH"
        : input.entryDigit.state === "FORMING"
          ? "MEDIUM"
          : input.entryDigit.state === "WAITING"
            ? "LOW"
            : "UNKNOWN";

    const losingSideThreat: MarketThesis["losingSideThreat"] =
      input.losingSidePressure.state === "HOSTILE" ||
      input.losingSidePressure.state === "TAKEOVER" ||
      input.losingSidePressure.severity === "VETO" ||
      input.losingSidePressure.severity === "REJECT"
        ? "HIGH"
        : input.losingSidePressure.state === "INCREASING" ||
            input.losingSidePressure.state === "ACCELERATING" ||
            input.losingSidePressure.severity === "DOWNGRADE"
          ? "MEDIUM"
          : "LOW";

    const veto: MarketThesis["veto"] =
      input.veto.active || (input.danger?.isHardBlocked ?? false) ? "BLOCKED" : "CLEAR";

    // Detect changed field from previous thesis
    let lastChangedField: string | undefined = undefined;
    if (this.previousThesis) {
      if (this.previousThesis.observationState !== this.state) {
        lastChangedField = "observationState";
      } else if (this.previousThesis.currentPressure !== currentPressure) {
        lastChangedField = "currentPressure";
      } else if (this.previousThesis.structuralDirection !== structuralDirection) {
        lastChangedField = "structuralDirection";
      } else if (this.previousThesis.veto !== veto) {
        lastChangedField = "veto";
      } else if (this.previousThesis.losingSideThreat !== losingSideThreat) {
        lastChangedField = "losingSideThreat";
      } else if (this.previousThesis.entryDigit.digit !== input.entryDigit.digit) {
        lastChangedField = "entryDigit";
      } else if (this.previousThesis.regime.classification !== input.regime.classification) {
        lastChangedField = "regime";
      }
    }

    const structuralFactors: string[] = [];
    const counterEvidence: string[] = [];

    if (input.psychology.support === "SUPPORTING") {
      structuralFactors.push(
        `${structuralDirection} psychology supporting (${input.psychology.state})`,
      );
    } else if (input.psychology.support === "OPPOSING") {
      counterEvidence.push(`${input.psychology.direction} psychology opposes ${this.proposition}`);
    }

    if (input.regime.compatibility === "COMPATIBLE") {
      structuralFactors.push(`Regime ${input.regime.classification} compatible`);
    } else if (input.regime.compatibility === "INCOMPATIBLE") {
      counterEvidence.push(`Regime ${input.regime.classification} incompatible`);
    }

    if (input.entryDigit.state === "VALIDATED") {
      structuralFactors.push(`Entry digit ${input.entryDigit.digit ?? ""} validated`);
    } else if (input.entryDigit.dangerousCompetitor) {
      counterEvidence.push("Dangerous competing digit building");
    }

    if (supCount >= 2) {
      structuralFactors.push(`${supCount}/4 pressure windows supporting`);
    }
    if (oppCount >= 2) {
      counterEvidence.push(`${oppCount}/4 pressure windows opposing`);
    }

    if (
      input.losingSidePressure.state === "DECLINING" ||
      input.losingSidePressure.state === "CALM"
    ) {
      structuralFactors.push("Losing-side pressure calm/declining");
    } else if (
      input.losingSidePressure.state === "INCREASING" ||
      input.losingSidePressure.state === "ACCELERATING" ||
      input.losingSidePressure.state === "HOSTILE"
    ) {
      counterEvidence.push(`Losing-side pressure ${input.losingSidePressure.state.toLowerCase()}`);
    }

    if ((input.danger?.total ?? 0) <= 30 && !input.danger?.isHardBlocked) {
      structuralFactors.push("Danger profile clear");
    } else if ((input.danger?.total ?? 0) >= 50 || input.danger?.isHardBlocked) {
      counterEvidence.push(`Danger elevated (${input.danger?.total ?? 0}/100)`);
    }

    // Agreement calculation
    let agreementStr = "NEUTRAL";
    if (counterEvidence.length >= 2 || (input.agreementBonus ?? 0) < 0) {
      agreementStr = counterEvidence.length >= 3 ? "STRONG CONFLICT" : "CONFLICT";
    } else if (structuralFactors.length >= 4 && (input.agreementBonus ?? 0) >= 3) {
      agreementStr = "STRONG SUPPORT";
    } else if (structuralFactors.length >= 2 && (input.agreementBonus ?? 0) > 0) {
      agreementStr = "SUPPORT";
    }

    // Numeric confidence calculation (0.0 to 1.0)
    let confNum = 0.5;
    if (structuralConfidence === "HIGH") confNum += 0.2;
    else if (structuralConfidence === "LOW") confNum -= 0.15;

    if (currentPressure === "SUPPORTIVE") confNum += 0.15;
    else if (currentPressure === "CONTRADICTORY") confNum -= 0.2;

    if (regimeSuitability === "HIGH") confNum += 0.1;
    else if (regimeSuitability === "LOW") confNum -= 0.15;

    if (entryDigitConf === "HIGH") confNum += 0.1;
    if (losingSideThreat === "HIGH") confNum -= 0.2;
    if (veto === "BLOCKED") confNum -= 0.3;

    confNum = Math.max(0.1, Math.min(0.98, confNum));

    const thesis: MarketThesis = {
      market: this.marketId,
      contract: this.proposition,
      structuralDirection,
      direction: structuralDirection,
      structuralConfidence,
      confidence: confNum,
      currentPressure,
      pressureAgreement: `${supCount}/4`,
      agreement: agreementStr,
      structuralFactors,
      counterEvidence,
      regime: {
        classification: input.regime.classification,
        suitability: regimeSuitability,
      },
      simulation: {
        state: simState,
        sampleSize: this.history.length,
      },
      entryDigit: {
        digit: input.entryDigit.digit,
        confidence: entryDigitConf,
      },
      losingSideThreat,
      veto,
      observationState: this.state,
      lastChangedField,
    };

    this.previousThesis = { ...thesis };
    return thesis;
  }

  private buildValidityWindow(
    input: EngineEvidenceInput,
    stability: StabilityState,
    contradictions: number,
  ): ExecutionValidityWindow {
    const isLive = this.state === "RIPE" || this.state === "CONFIRMING";
    const stateTicks = Math.max(0, this.tickCounter - this.currentStateSinceTick);
    const currentAgeSeconds = Math.max(0, Math.floor(stateTicks * 2));
    const maxValiditySeconds =
      stability === "STABLE" || stability === "CALM" ? 90 : stability === "DEVELOPING" ? 60 : 45;
    const remainingValiditySeconds = Math.max(0, maxValiditySeconds - currentAgeSeconds);

    let validityState: ExecutionValidityWindow["validityState"] = "VALID";
    if (this.state === "EXPIRED" || remainingValiditySeconds <= 0) {
      validityState = "EXPIRED";
    } else if (
      this.state === "VETOED" ||
      this.state === "REJECTED" ||
      this.state === "ABANDONED" ||
      input.veto.active ||
      (input.danger?.isHardBlocked ?? false)
    ) {
      validityState = "INVALIDATED";
    } else if (
      this.state === "UNSTABLE" ||
      this.state === "CONFLICT" ||
      this.state === "DECAYING"
    ) {
      validityState = "DECAYING";
    } else if (remainingValiditySeconds <= 15) {
      validityState = "EXPIRING_SOON";
    } else if (
      input.losingSidePressure.state === "INCREASING" ||
      input.losingSidePressure.state === "ACCELERATING" ||
      input.losingSidePressure.state === "HOSTILE"
    ) {
      validityState = "DECAYING";
    } else {
      validityState = "VALID";
    }

    const invalidationConditions: string[] = [];
    if (input.entryDigit.digit !== null) {
      invalidationConditions.push(
        `Shift or displacement of entry digit ${input.entryDigit.digit}.`,
      );
    }
    if (
      input.losingSidePressure.state !== "CALM" &&
      input.losingSidePressure.state !== "DECLINING"
    ) {
      invalidationConditions.push(
        `Losing-side pressure state (${input.losingSidePressure.state}).`,
      );
    }
    if ((input.danger?.total ?? 0) > 35) {
      invalidationConditions.push(
        `Danger level above calm threshold (${input.danger?.total ?? 0}/100).`,
      );
    }
    if (input.regime.compatibility === "INCOMPATIBLE") {
      invalidationConditions.push(`Adverse regime transition (${input.regime.classification}).`);
    }
    if (contradictions > 0) {
      invalidationConditions.push(`${contradictions} contradictory evidence stream(s) active.`);
    }

    return {
      createdAt: this.createdAtTick * 2000,
      currentAgeSeconds,
      currentAgeTicks: stateTicks,
      validityState,
      remainingValiditySeconds,
      maxValiditySeconds,
      invalidationConditions: invalidationConditions.length
        ? invalidationConditions
        : [
            "Spike in losing-side pressure level above CALM.",
            "Shift or displacement of validated entry digit.",
            "Canonical 1,000-tick psychology reversal or zone contest.",
            "Composite danger score rising above 35/100.",
          ],
    };
  }

  private buildDossier(
    input: NormalizedEvidenceInput,
    stability: StabilityState,
    contradictions: number,
    momentumRelation: ReturnType<typeof interpretMomentum>,
    confirmationRead: ConfirmationRead,
  ): ObservationDossier {
    const supportingEvidence: string[] = [];
    const opposingEvidence: string[] = [];

    if (input.psychology.support === "SUPPORTING")
      supportingEvidence.push(`${input.psychology.direction} psychology supporting`);
    if (input.psychology.support === "OPPOSING")
      opposingEvidence.push(`${input.psychology.direction} psychology opposing`);
    if (input.entryDigit.state === "VALIDATED") supportingEvidence.push("entry digit validated");
    if (input.entryDigit.dangerousCompetitor)
      opposingEvidence.push("dangerous competing digit building");
    Object.entries(input.pressure.byWindow).forEach(([w, v]) => {
      if (v === "SUPPORTING") supportingEvidence.push(`${w}-tick pressure supporting`);
      if (v === "OPPOSING") opposingEvidence.push(`${w}-tick pressure opposing`);
    });
    if (input.losingSidePressure.state === "DECLINING")
      supportingEvidence.push("losing-side pressure declining");
    if (
      input.losingSidePressure.state === "INCREASING" ||
      input.losingSidePressure.state === "ACCELERATING"
    ) {
      opposingEvidence.push(`losing-side pressure ${input.losingSidePressure.state.toLowerCase()}`);
    }
    if (input.liquiditySweep.confirmed)
      supportingEvidence.push("observed opposing-digit concentration sweep confirmed");
    else if (input.liquiditySweep.state !== "INSUFFICIENT")
      opposingEvidence.push(`liquidity sweep ${input.liquiditySweep.state.toLowerCase()} — not confirmed`);
    if (input.regime.compatibility === "COMPATIBLE") supportingEvidence.push("regime compatible");
    if (input.regime.compatibility === "INCOMPATIBLE") opposingEvidence.push("regime incompatible");
    if (momentumRelation === "SUPPORTIVE") supportingEvidence.push("momentum supportive");
    if (momentumRelation === "CONFLICTING") opposingEvidence.push("momentum conflicting");
    if (input.trigger.state === "VALID" || input.trigger.state === "FIRED")
      supportingEvidence.push("trigger valid");
    if (input.trigger.state === "FAILED") opposingEvidence.push("trigger failed");
    if (input.danger?.level === "CALM" || input.danger?.level === "LOW")
      supportingEvidence.push("danger profile calm");
    if (
      input.danger?.level === "HIGH" ||
      input.danger?.level === "CRITICAL" ||
      input.danger?.isHardBlocked
    )
      opposingEvidence.push(`danger elevated (${input.danger.summary || input.danger.level})`);

    const cautionActive = Boolean(
      this.cautionUntilTimestamp && input.timestamp < this.cautionUntilTimestamp,
    );
    if (cautionActive && this.activeConcern) {
      opposingEvidence.push(
        `operator post-mortem caution active: ${this.activeConcern}${this.activeCategory ? ` (${this.activeCategory})` : ""}`,
      );
    }

    const feedbackLearning: CellFeedbackLearning = {
      lastOutcome: this.lastOutcome,
      lastOutcomeAt: this.lastOutcomeAt,
      recentLosses: this.recentLosses,
      recentWins: this.recentWins,
      activeConcern: this.activeConcern,
      activeCategory: this.activeCategory,
      activeDirectiveType: this.activeDirectiveType,
      postMortemAdvice: this.postMortemAdvice,
      cautionActive,
      cautionUntil: this.cautionUntilTimestamp,
      history: this.postMortems.slice(-10),
    };

    const evidenceMaturity: ObservationDossier["evidenceMaturity"] =
      confirmationRead.state === "CONFIRMED"
        ? "HIGH"
        : confirmationRead.state === "CONFIRMING"
          ? "MODERATE"
          : "LOW";

    const formationVelocity: ObservationDossier["formationVelocity"] =
      this.contradictionStreak > 0
        ? "DETERIORATING"
        : confirmationRead.state === "CONFIRMED" && this.transitionsCount <= 4
          ? "RAPID"
          : confirmationRead.ratio >= 0.5
            ? "NORMAL"
            : "SLOW";

    const thesis = this.buildThesis(input, stability, contradictions);
    const validityWindow = this.buildValidityWindow(input, stability, contradictions);

    // §34 — identity conformance: "are you currently behaving like your own
    // name?" Purely interpretive of evidence already computed upstream
    // (contractPsychology + canonicalDigitState, handed through via
    // psychology.raw). Never recomputed from raw ticks here, and never fed
    // back into scoring/ranking (§35) — this rides alongside the dossier for
    // audit/explanation and the single confluence/ranking calculation; it is
    // never a separate ranking or qualification selector.
    const psychRaw = (input.psychology as any)?.raw;
    const identityConformance =
      psychRaw?.digitPsychology && psychRaw?.canonicalState
        ? deriveIdentityConformance(this.identity, psychRaw.digitPsychology, psychRaw.canonicalState)
        : null;

    const partialDossier = {
      marketId: this.marketId,
      proposition: this.proposition,
      cellId: this.id,
      state: this.state,
      stability,
      psychology: input.psychology,
      entryDigit: input.entryDigit,
      pressure: input.pressure,
      losingSidePressure: input.losingSidePressure,
      liquiditySweep: input.liquiditySweep,
      danger: input.danger,
      simulation: input.simulation,
      regime: input.regime,
      momentum: input.momentum,
      momentumRelation,
      trigger: input.trigger,
      veto: input.veto,
      statistics: input.statistics,
      hiddenBehavior: input.hiddenBehavior,
      supportingEvidence,
      opposingEvidence,
      formationVelocity,
      evidenceMaturity,
      tickConfirmation: confirmationRead,
      contradictions,
      feedbackLearning,
      identity: this.identity,
      identityConformance,
    };
    const scoreResult = computeDossierScore(partialDossier as any, input);
    const qualityAssessment =
      (partialDossier as any).qualityAssessment ??
      assessQuality(partialDossier as any, momentumRelation);

    const side = this.proposition.startsWith("OVER") ? "OVER" : "UNDER";
    const barrier = parseInt(this.proposition.replace(/\D/g, ""), 10) || (side === "OVER" ? 2 : 7);
    const winners =
      side === "OVER"
        ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d > barrier)
        : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d < barrier);
    const losers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !winners.includes(d));

    const readyEval = evaluateExecutionReady({
      side,
      winners,
      losers,
      direction: input.direction,
      structureDirection: input.psychology?.direction,
      danger: input.danger,
      canonicalState: (input.psychology?.raw as any)?.canonicalState,
      entryPoint: input.entryPoint ?? (input.entryDigit?.raw as any),
      entryClearance: input.entryClearance,
    });

    const dossier: ObservationDossier = {
      marketId: this.marketId,
      proposition: this.proposition,
      cellId: this.id,
      identity: this.identity,
      identityConformance,
      state: this.state,
      score: scoreResult.score,
      isRipe: scoreResult.isRipe,
      factors: scoreResult.factors,
      qualityBand: qualityAssessment.band,
      qualityAssessment,
      executionReady: readyEval.executionReady,
      executionReadyReasons: readyEval.executionReadyReasons,
      observationAge: this.tickCounter - this.createdAtTick,
      currentStateSince: this.tickCounter - this.currentStateSinceTick,
      stability,
      psychology: input.psychology,
      entryDigit: input.entryDigit,
      pressure: input.pressure,
      losingSidePressure: input.losingSidePressure,
      liquiditySweep: input.liquiditySweep,
      danger: input.danger ?? {
        total: 0,
        level: "CALM",
        isHardBlocked: false,
        components: [],
        summary: "No active danger components — environment calm.",
      },
      simulation: input.simulation,
      regime: input.regime,
      momentum: input.momentum,
      momentumRelation,
      trigger: input.trigger,
      veto: input.veto,
      statistics: input.statistics,
      hiddenBehavior: input.hiddenBehavior,
      contradictions,
      supportingEvidence,
      opposingEvidence,
      formationVelocity,
      evidenceMaturity,
      tickConfirmation: confirmationRead,
      assessment: this.state === "RIPE" ? "RIPE" : this.state,
      thesis,
      validityWindow,
      feedbackLearning,
      contractContext: input.contractContext,
      marketContext: input.marketContext,
      governance: input.governance ?? null,
      governedSpine: input.governedSpine ?? null,
      operatorLearning: input.operatorLearning ?? null,
      guidance: input.guidance ?? null,
      survival: input.survival ?? null,
      survivalInfluence: input.survivalInfluence ?? null,
      entryTrigger: input.entryTrigger ?? null,
      contextMarkov: input.contextMarkov ?? null,
      convergence: input.convergence ?? null,
      evidenceFusion: input.evidenceFusion ?? null,
      setupQuality: input.setupQuality ?? null,
      entryClearance: input.entryClearance ?? null,
      operatorSpecial: input.operatorSpecial ?? null,
      marketLearning: input.marketLearning ?? null,
      clearance: input.clearance ?? null,
      evidenceStatus: input.evidenceStatus ?? null,
      direction: input.direction ?? null,
      agreementBonus: input.agreementBonus ?? 0,
      manipulationScore: input.manipulationScore ?? null,
      priceAction: input.priceAction ?? null,
      priceActionField: input.priceActionField ?? null,
      entryPoint: input.entryPoint ?? input.entryDigit?.raw ?? null,
      stateEvidence: input.stateEvidence ?? null,
      relative: input.relative ?? null,
      persistence: input.persistence ?? null,
      combination: input.combination ?? input.statistics?.combination ?? null,
      regimeReport: input.regimeReport ?? input.regime?.raw?.regimeReport ?? null,
    };

    return dossier;
  }

  explainCurrent(): string {
    const d = this.getDossier();
    if (!d) return "No evidence observed yet.";
    if (d.state === "RIPE") return "Opportunity is currently RIPE.";
    return explainWaiting(d, d.momentumRelation);
  }
}
