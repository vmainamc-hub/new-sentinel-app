import type { CellId } from "./constants";
import type { ObservationDossier, ObservationEvent, QualificationSnapshot } from "./types";

/**
 * §17 — persistence contract. This package does NOT assume a Supabase
 * client shape or existing table names — inspect the existing data
 * architecture first and implement this interface against it. Only
 * implement genuinely new persistence if nothing suitable already exists;
 * reuse existing tables/rows wherever they already fit.
 *
 * Observation history is distinct from trade/signal/simulation/learning/
 * execution/calibration history — never write into those tables from here.
 */
export interface ObservationPersistenceAdapter {
  saveDossierSnapshot(dossier: ObservationDossier): Promise<void>;
  loadDossier(cellId: CellId): Promise<ObservationDossier | null>;
  loadAllDossiers(): Promise<Record<string, ObservationDossier>>;
  appendEvent(cellId: CellId, event: ObservationEvent): Promise<void>;
  loadRecentEvents(cellId: CellId, limit?: number): Promise<ObservationEvent[]>;
  saveQualification(snapshot: QualificationSnapshot): Promise<void>;
  loadQualification(cellId: CellId): Promise<QualificationSnapshot | null>;
}

/** No-op adapter — safe default while wiring is in progress. Swap for a real adapter before shipping. */
export class NullPersistenceAdapter implements ObservationPersistenceAdapter {
  async saveDossierSnapshot(): Promise<void> {}
  async loadDossier(): Promise<ObservationDossier | null> {
    return null;
  }
  async loadAllDossiers(): Promise<Record<string, ObservationDossier>> {
    return {};
  }
  async appendEvent(): Promise<void> {}
  async loadRecentEvents(): Promise<ObservationEvent[]> {
    return [];
  }
  async saveQualification(): Promise<void> {}
  async loadQualification(): Promise<null> {
    return null;
  }
}
