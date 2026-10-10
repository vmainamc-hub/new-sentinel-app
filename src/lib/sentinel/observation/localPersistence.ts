/**
 * Local (browser) persistence for the 90-cell observation layer.
 *
 * The upstream Sentinel build mirrored high-value dossiers to a cloud table.
 * This unified build keeps the intelligence engine self-contained: dossiers,
 * events and qualification snapshots persist to bounded local storage only.
 * No network call is made, so a persistence outage can never stall the engine.
 */
import type { CellId } from "./constants";
import type { ObservationDossier, ObservationEvent, QualificationSnapshot } from "./types";
import type { ObservationPersistenceAdapter } from "./persistence";
import { safeStorage, safeJsonParse } from "@/lib/storage-fallback";

const LOCAL_STORAGE_KEY = "sentinel.observation.persistence.v1";
const MAX_STORED_EVENTS_PER_CELL = 20;
const MAX_TOTAL_EVENTS = 300;
const MAX_QUALIFICATIONS = 50;
const DEBOUNCE_SAVE_MS = 2000;

interface LocalStore {
  dossiers: Record<string, ObservationDossier>;
  events: Record<string, ObservationEvent[]>;
  qualifications: Record<string, QualificationSnapshot>;
  updatedAt: number;
}

/**
 * Compacts an ObservationDossier for persistence: keeps every field needed for
 * hydration, scoring and rendering while stripping heavy nested engine payloads.
 */
function compactDossierForStorage(dossier: ObservationDossier): ObservationDossier {
  return {
    cellId: dossier.cellId,
    marketId: dossier.marketId,
    proposition: dossier.proposition,
    state: dossier.state,
    score: dossier.score,
    isRipe: dossier.isRipe,
    factors: dossier.factors?.slice(0, 5),
    observationAge: dossier.observationAge,
    currentStateSince: dossier.currentStateSince,
    stability: dossier.stability,
    psychology: dossier.psychology,
    entryDigit: dossier.entryDigit,
    pressure: dossier.pressure,
    losingSidePressure: dossier.losingSidePressure,
    liquiditySweep: dossier.liquiditySweep,
    danger: dossier.danger,
    simulation: dossier.simulation,
    regime: dossier.regime,
    momentum: dossier.momentum,
    momentumRelation: dossier.momentumRelation,
    trigger: dossier.trigger,
    veto: dossier.veto,
    statistics: dossier.statistics,
    hiddenBehavior: dossier.hiddenBehavior,
    contradictions: dossier.contradictions,
    supportingEvidence: dossier.supportingEvidence?.slice(0, 5) ?? [],
    opposingEvidence: dossier.opposingEvidence?.slice(0, 5) ?? [],
    formationVelocity: dossier.formationVelocity,
    evidenceMaturity: dossier.evidenceMaturity,
    tickConfirmation: dossier.tickConfirmation,
    assessment: dossier.assessment,
    thesis: dossier.thesis ? { ...dossier.thesis } : undefined,
    validityWindow: dossier.validityWindow,
    qualityBand: dossier.qualityBand,
    executionReady: dossier.executionReady,
    executionReadyReasons: dossier.executionReadyReasons?.slice(0, 3),
    feedbackLearning: dossier.feedbackLearning
      ? {
          ...dossier.feedbackLearning,
          history: dossier.feedbackLearning.history?.slice(0, 5) ?? [],
        }
      : undefined,
  };
}

export class LocalObservationPersistenceAdapter implements ObservationPersistenceAdapter {
  private memoryStore: LocalStore = {
    dossiers: {},
    events: {},
    qualifications: {},
    updatedAt: Date.now(),
  };
  private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadFromLocalStorage();
  }

  private loadFromLocalStorage() {
    try {
      const raw = safeStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) return;
      const parsed = safeJsonParse<LocalStore | null>(raw, null);
      if (parsed && typeof parsed === "object") {
        this.memoryStore = {
          dossiers: parsed.dossiers ?? {},
          events: parsed.events ?? {},
          qualifications: parsed.qualifications ?? {},
          updatedAt: parsed.updatedAt ?? Date.now(),
        };
      }
    } catch {
      // Clean fallback — an unreadable cache is simply ignored.
    }
  }

  private scheduleLocalSave() {
    if (this.saveDebounceTimer) return;
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = null;
      try {
        safeStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(this.memoryStore));
      } catch {
        // Handled gracefully by safeStorage.
      }
    }, DEBOUNCE_SAVE_MS);
  }

  async saveDossierSnapshot(dossier: ObservationDossier): Promise<void> {
    this.memoryStore.dossiers[dossier.cellId] = compactDossierForStorage(dossier);
    this.memoryStore.updatedAt = Date.now();
    this.scheduleLocalSave();
  }

  async loadDossier(cellId: CellId): Promise<ObservationDossier | null> {
    return this.memoryStore.dossiers[cellId] ?? null;
  }

  async loadAllDossiers(): Promise<Record<string, ObservationDossier>> {
    return { ...this.memoryStore.dossiers };
  }

  async appendEvent(cellId: CellId, event: ObservationEvent): Promise<void> {
    if (!this.memoryStore.events[cellId]) this.memoryStore.events[cellId] = [];
    const list = this.memoryStore.events[cellId];
    list.push(event);
    if (list.length > MAX_STORED_EVENTS_PER_CELL) {
      list.splice(0, list.length - MAX_STORED_EVENTS_PER_CELL);
    }

    let totalEvents = 0;
    for (const key in this.memoryStore.events) totalEvents += this.memoryStore.events[key].length;
    if (totalEvents > MAX_TOTAL_EVENTS) {
      for (const key in this.memoryStore.events) {
        const bucket = this.memoryStore.events[key];
        if (bucket.length > 5) bucket.splice(0, bucket.length - 5);
      }
    }

    this.memoryStore.updatedAt = Date.now();
    this.scheduleLocalSave();
  }

  async loadRecentEvents(cellId: CellId, limit = 20): Promise<ObservationEvent[]> {
    return (this.memoryStore.events[cellId] ?? []).slice(-limit);
  }

  async saveQualification(snapshot: QualificationSnapshot): Promise<void> {
    this.memoryStore.qualifications[snapshot.cellId] = snapshot;
    const qualKeys = Object.keys(this.memoryStore.qualifications);
    if (qualKeys.length > MAX_QUALIFICATIONS) {
      for (let i = 0; i < qualKeys.length - MAX_QUALIFICATIONS; i++) {
        delete this.memoryStore.qualifications[qualKeys[i]];
      }
    }
    this.memoryStore.updatedAt = Date.now();
    this.scheduleLocalSave();
  }

  async loadQualification(cellId: CellId): Promise<QualificationSnapshot | null> {
    return this.memoryStore.qualifications[cellId] ?? null;
  }
}
