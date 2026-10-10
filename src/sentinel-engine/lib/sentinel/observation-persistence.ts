/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ContractType } from "../../types/sentinel";
import { safeStorage, safeJsonParse } from "@/sentinel-engine/lib/storage-fallback";

/**
 * Persisted live observation state (Table: `observation_state`)
 * Exactly 1 row per cell (90 rows across the 15 markets x 6 propositions).
 */
export interface PersistedObservationState {
  id: string; // `${market}__${contract}`
  market: string;
  contract: ContractType;
  current_state: string; // 'WATCHING' | 'INTERESTING' | 'DEVELOPING' | 'CONFIRMING' | 'RIPE' | 'UNSTABLE' | 'CONFLICT' | 'REJECTED'
  stability: string; // 'CALM' | 'STABLE' | 'DEVELOPING' | 'FLUCTUATING' | 'CHOPPY' | 'HIGHLY_UNSTABLE' | 'TRANSITIONING'
  observation_age_ticks: number;
  current_state_duration_ticks: number;
  score: number;
  danger_score: number;
  evidence_summary: string;
  contradiction_count: number;
  supporting_count: number;
  opposing_count: number;
  is_ripe: boolean;
  is_vetoed: boolean;
  hidden_behavior_summary: string;
  simulation_state: string;
  last_updated_epoch: number;
}

/**
 * Persisted transition event log (Table: `observation_event`)
 * Append-only log of longitudinal state changes.
 */
export interface PersistedObservationEvent {
  id: string;
  timestamp: number;
  market: string;
  contract: ContractType;
  from_state: string;
  to_state: string;
  reason: string;
  trigger_category: string;
  score_at_transition: number;
  danger_at_transition: number;
}

const STATE_STORAGE_KEY = "apex_sentinel_observation_state_v1";
const EVENT_STORAGE_KEY = "apex_sentinel_observation_event_v1";
const MAX_STORED_EVENTS = 100;
const DEBOUNCE_MS = 1500;

/**
 * ObservationPersistenceAdapter
 *
 * Manages the two dedicated observation tables (`observation_state` and `observation_event`)
 * ensuring clean separation from trade, feedback, and simulation databases.
 */
class ObservationPersistenceAdapter {
  private stateCache: Map<string, PersistedObservationState> = new Map();
  private eventLog: PersistedObservationEvent[] = [];
  private isLoaded = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private eventSaveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const stateRaw = safeStorage.getItem(STATE_STORAGE_KEY);
      if (stateRaw) {
        const list = safeJsonParse<PersistedObservationState[]>(stateRaw, []);
        if (Array.isArray(list)) {
          list.forEach((row) => {
            if (row && row.id) this.stateCache.set(row.id, row);
          });
        }
      }

      const eventRaw = safeStorage.getItem(EVENT_STORAGE_KEY);
      if (eventRaw) {
        const parsedEvents = safeJsonParse<PersistedObservationEvent[]>(eventRaw, []);
        if (Array.isArray(parsedEvents)) {
          this.eventLog = parsedEvents.slice(0, MAX_STORED_EVENTS);
        }
      }
      this.isLoaded = true;
    } catch {
      // Fallback silently
    }
  }

  /**
   * Upsert an observation_state row for a given market & proposition
   */
  public upsertState(state: PersistedObservationState): void {
    this.stateCache.set(state.id, { ...state, last_updated_epoch: Date.now() });
    this.persistStateDebounced();
  }

  /**
   * Append an observation_event row
   */
  public logEvent(event: Omit<PersistedObservationEvent, "id">): PersistedObservationEvent {
    const fullEvent: PersistedObservationEvent = {
      ...event,
      id: `obs_evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    };

    this.eventLog.unshift(fullEvent);
    if (this.eventLog.length > MAX_STORED_EVENTS) {
      this.eventLog.length = MAX_STORED_EVENTS;
    }

    this.persistEventsDebounced();
    return fullEvent;
  }

  /**
   * Get all live observation states
   */
  public getAllStates(): PersistedObservationState[] {
    return Array.from(this.stateCache.values());
  }

  /**
   * Get observation state for a specific cell
   */
  public getState(market: string, contract: ContractType): PersistedObservationState | null {
    const id = `${market}__${contract}`;
    return this.stateCache.get(id) || null;
  }

  /**
   * Get transition events for a specific cell or market
   */
  public getEvents(
    market?: string,
    contract?: ContractType,
    limit: number = 30,
  ): PersistedObservationEvent[] {
    return this.eventLog
      .filter((e) => (!market || e.market === market) && (!contract || e.contract === contract))
      .slice(0, limit);
  }

  private persistStateDebounced(): void {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      try {
        const list = Array.from(this.stateCache.values());
        safeStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(list));
      } catch {}
    }, DEBOUNCE_MS);
  }

  private persistEventsDebounced(): void {
    if (this.eventSaveTimeout) return;
    this.eventSaveTimeout = setTimeout(() => {
      this.eventSaveTimeout = null;
      try {
        safeStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(this.eventLog.slice(0, MAX_STORED_EVENTS)));
      } catch {}
    }, DEBOUNCE_MS);
  }
}

export const observationPersistence = new ObservationPersistenceAdapter();

