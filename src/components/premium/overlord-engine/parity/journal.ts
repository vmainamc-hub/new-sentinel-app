// §43 Learning Loop — Precision Parity journal.
//
// Mirrors src/lib/precision-edge-v2/journal.ts but for Parity verdicts.
// Persists per-market verdict → realised-outcome pairs, and exposes summary
// stats (Brier score, hit-rate) bucketed by quality band.
//
// Pure client-side (localStorage). No mutation of the underlying engine.

export type ParityOutcome = "pending" | "win" | "loss" | "skipped" | "invalidated";
export type ParityQualityBand = "premium" | "standard" | "developing" | "unknown";

export interface ParityJournalEntry {
  id: string;
  ts: number;
  market: string;
  side: "EVEN" | "ODD";
  /** Model's win-probability estimate at publish time, 0..1. */
  pModel: number;
  /** Quality band assigned by the engine. */
  quality: ParityQualityBand;
  /** Horizon (ticks) forecast was for. */
  horizon: number;
  /** Realised outcome for that horizon. */
  outcome: ParityOutcome;
}

const KEY = "pp:journal";
const MAX = 500;

function isBrowser(): boolean {
  return typeof localStorage !== "undefined";
}
function load(): ParityJournalEntry[] {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ParityJournalEntry[]) : [];
  } catch {
    return [];
  }
}
function persist(list: ParityJournalEntry[]) {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* ignore */
  }
}

let cache: ParityJournalEntry[] | null = null;
const listeners = new Set<() => void>();

function all(): ParityJournalEntry[] {
  if (!cache) cache = load();
  return cache;
}
function notify() {
  listeners.forEach((fn) => fn());
}

export function subscribeParityJournal(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function listParityJournal(): ParityJournalEntry[] {
  return [...all()].reverse();
}

export function recordParityVerdict(
  e: Omit<ParityJournalEntry, "id" | "ts" | "outcome">,
): ParityJournalEntry {
  const list = all();
  const recent = list[list.length - 1];
  if (
    recent &&
    recent.market === e.market &&
    recent.side === e.side &&
    Date.now() - recent.ts < 90_000
  ) {
    return recent;
  }
  const entry: ParityJournalEntry = {
    ...e,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    outcome: "pending",
  };
  list.push(entry);
  cache = list;
  persist(list);
  notify();
  return entry;
}

export function markParityOutcome(id: string, outcome: ParityOutcome) {
  const list = all();
  const idx = list.findIndex((e) => e.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], outcome };
  cache = list;
  persist(list);
  notify();
}

export interface ParityJournalStats {
  market: string | "*";
  total: number;
  decided: number;
  wins: number;
  hitRate: number;
  brier: number;
  byBand: Record<ParityQualityBand, { total: number; decided: number; hitRate: number; brier: number }>;
}

/**
 * Per-market Brier score + hit-rate summary. `market === "*"` aggregates all.
 */
export function parityJournalStats(market: string | "*" = "*"): ParityJournalStats {
  const list = all().filter((e) => (market === "*" ? true : e.market === market));
  const decided = list.filter((e) => e.outcome === "win" || e.outcome === "loss");
  const wins = decided.filter((e) => e.outcome === "win").length;
  const hitRate = decided.length ? wins / decided.length : 0;
  const brier = decided.length
    ? decided.reduce((acc, e) => {
        const y = e.outcome === "win" ? 1 : 0;
        return acc + (e.pModel - y) ** 2;
      }, 0) / decided.length
    : 0;
  const bands: ParityQualityBand[] = ["premium", "standard", "developing", "unknown"];
  const byBand = Object.fromEntries(
    bands.map((b) => {
      const bucket = list.filter((e) => e.quality === b);
      const bDecided = bucket.filter((e) => e.outcome === "win" || e.outcome === "loss");
      const bWins = bDecided.filter((e) => e.outcome === "win").length;
      const bHit = bDecided.length ? bWins / bDecided.length : 0;
      const bBrier = bDecided.length
        ? bDecided.reduce((acc, e) => acc + (e.pModel - (e.outcome === "win" ? 1 : 0)) ** 2, 0) /
          bDecided.length
        : 0;
      return [b, { total: bucket.length, decided: bDecided.length, hitRate: bHit, brier: bBrier }];
    }),
  ) as ParityJournalStats["byBand"];
  return {
    market,
    total: list.length,
    decided: decided.length,
    wins,
    hitRate,
    brier,
    byBand,
  };
}

/** Test/reset hook (not exposed in UI). */
export function _resetParityJournalForTests() {
  cache = [];
  if (isBrowser()) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
}
