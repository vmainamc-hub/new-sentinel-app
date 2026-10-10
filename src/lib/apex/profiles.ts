// APEX SENTINEL — MARKET-SPECIFIC LEARNING PROFILES.
//
// Every market develops its OWN profile. Nothing is shared implicitly: V75 may
// learn that a configuration works while V50 learns the opposite. Global
// learning exists only as a secondary prior, computed by aggregating the
// per-market records — never by mixing them inside a market's own statistics.
//
// Learning is strictly causal: the state that existed at ENTRY time is stored
// first, and only the later resolution of that exact paper trade updates the
// buckets. A future outcome can never alter a historical decision.
//
// The profile is persisted, so accumulated learning survives a restart.
import { apexSimulator, type SimTrade } from "./simulator";
import type { ApexContractId } from "./types";
import { safeStorage, safeJsonParse } from "@/lib/storage-fallback";

const KEY = "apex.profiles.v1";
const SAVE_DEBOUNCE = 4000;
const MAX_INGESTED_SET = 1000;
const MAX_PENDING_MAP = 500;

export interface Bucket {
  key: string;
  n: number;
  wins: number;
  pnl: number;
}

export interface MarketProfile {
  symbol: string;
  name: string;
  trades: number;
  wins: number;
  losses: number;
  netPnl: number;
  contracts: Record<string, Bucket>;
  entryConditions: Record<string, Bucket>;
  regimes: Record<string, Bucket>;
  psychology: Record<string, Bucket>;
  scoreBands: Record<string, Bucket>;
  /** Digit -> number of losses this market resolved ON that digit. */
  dangerousDigits: Record<string, number>;
  /** Engine label -> support/outcome record. */
  engines: Record<string, Bucket>;
  firstSeen: number;
  updatedAt: number;
}

interface Store {
  markets: Record<string, MarketProfile>;
  updatedAt: number;
}

/** State captured at ENTRY time, before the outcome exists. */
export interface EntryContext {
  symbol: string;
  name: string;
  contract: ApexContractId;
  contractLabel: string;
  entryCondition: string;
  regime: string;
  psychology: string;
  scoreBand: string;
  engines: string[];
  at: number;
}

let store: Store = { markets: {}, updatedAt: 0 };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<string, EntryContext>(); // trade id -> entry state
const ingested = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = safeStorage.getItem(KEY);
    if (raw) {
      const parsed = safeJsonParse<Store | null>(raw, null);
      if (parsed && parsed.markets) store = parsed;
    }
  } catch {
    /* corrupt storage is ignored — learning restarts rather than lying */
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      store.updatedAt = Date.now();
      safeStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* quota — keep learning in memory */
    }
  }, SAVE_DEBOUNCE);
}

function blankProfile(symbol: string, name: string): MarketProfile {
  return {
    symbol,
    name,
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    contracts: {},
    entryConditions: {},
    regimes: {},
    psychology: {},
    scoreBands: {},
    dangerousDigits: {},
    engines: {},
    firstSeen: Date.now(),
    updatedAt: Date.now(),
  };
}

function bump(map: Record<string, Bucket>, key: string, win: boolean, pnl: number) {
  const b = map[key] ?? { key, n: 0, wins: 0, pnl: 0 };
  b.n++;
  if (win) b.wins++;
  b.pnl += pnl;
  map[key] = b;
}

export function scoreBandOf(score: number): string {
  if (score >= 85) return "85+";
  if (score >= 75) return "75-84";
  if (score >= 65) return "65-74";
  if (score >= 55) return "55-64";
  return "<55";
}

class ProfileStore {
  /** Record the state that existed when a paper trade was opened. */
  captureEntry(tradeId: string, ctx: EntryContext) {
    if (pending.has(tradeId) || ingested.has(tradeId)) return;
    if (pending.size > MAX_PENDING_MAP) {
      const firstKey = pending.keys().next().value;
      if (firstKey) pending.delete(firstKey);
    }
    pending.set(tradeId, ctx);
  }

  /** Ingest every resolved trade whose entry state was captured. */
  sync(ledger: SimTrade[] = apexSimulator.getLedger(400)) {
    load();
    let changed = false;
    for (const t of ledger) {
      if (t.result === "OPEN") continue;
      if (ingested.has(t.id)) continue;
      const ctx = pending.get(t.id);
      ingested.add(t.id);
      if (ingested.size > MAX_INGESTED_SET) {
        const firstKey = ingested.keys().next().value;
        if (firstKey) ingested.delete(firstKey);
      }
      pending.delete(t.id);
      const symbol = t.symbol;
      const p = store.markets[symbol] ?? blankProfile(symbol, t.market);
      const win = t.result === "WIN";
      p.trades++;
      if (win) p.wins++;
      else p.losses++;
      p.netPnl += t.pnl;
      bump(p.contracts, t.contractLabel, win, t.pnl);
      bump(p.entryConditions, ctx?.entryCondition ?? t.entryCondition ?? "unspecified", win, t.pnl);
      if (ctx) {
        bump(p.regimes, ctx.regime, win, t.pnl);
        bump(p.psychology, ctx.psychology, win, t.pnl);
        bump(p.scoreBands, ctx.scoreBand, win, t.pnl);
        for (const e of ctx.engines ?? []) bump(p.engines, e, win, t.pnl);
      }
      if (!win && t.expiryDigit !== null && t.expiryDigit >= 0) {
        p.dangerousDigits[String(t.expiryDigit)] =
          (p.dangerousDigits[String(t.expiryDigit)] ?? 0) + 1;
      }
      p.updatedAt = Date.now();
      store.markets[symbol] = p;
      changed = true;
    }
    if (changed) {
      save();
      emit();
    }
    return changed;
  }

  get(symbol: string): MarketProfile | null {
    load();
    return store.markets[symbol] ?? null;
  }

  all(): MarketProfile[] {
    load();
    return Object.values(store.markets).sort((a, b) => b.trades - a.trades);
  }

  /**
   * GLOBAL learning — a secondary prior only. It is derived by aggregating the
   * per-market records; no market's own statistics are ever contaminated.
   */
  global(): MarketProfile {
    load();
    const g = blankProfile("GLOBAL", "All markets (secondary prior)");
    for (const p of Object.values(store.markets)) {
      g.trades += p.trades;
      g.wins += p.wins;
      g.losses += p.losses;
      g.netPnl += p.netPnl;
      const merge = (from: Record<string, Bucket>, to: Record<string, Bucket>) => {
        for (const b of Object.values(from)) {
          const cur = to[b.key] ?? { key: b.key, n: 0, wins: 0, pnl: 0 };
          cur.n += b.n;
          cur.wins += b.wins;
          cur.pnl += b.pnl;
          to[b.key] = cur;
        }
      };
      merge(p.contracts ?? {}, g.contracts);
      merge(p.entryConditions ?? {}, g.entryConditions);
      merge(p.regimes ?? {}, g.regimes);
      merge(p.psychology ?? {}, g.psychology);
      merge(p.scoreBands ?? {}, g.scoreBands);
      merge(p.engines ?? {}, g.engines);
      for (const [d, c] of Object.entries(p.dangerousDigits ?? {})) {
        g.dangerousDigits[d] = (g.dangerousDigits[d] ?? 0) + c;
      }
    }
    return g;
  }

  /** Best buckets of a category with a minimum sample size. */
  best(map: Record<string, Bucket>, minN = 12, limit = 3): Bucket[] {
    return Object.values(map ?? {})
      .filter((b) => b.n >= minN)
      .sort((a, b) => b.wins / b.n - a.wins / a.n)
      .slice(0, limit);
  }

  worst(map: Record<string, Bucket>, minN = 12, limit = 3): Bucket[] {
    return Object.values(map ?? {})
      .filter((b) => b.n >= minN)
      .sort((a, b) => a.wins / a.n - b.wins / b.n)
      .slice(0, limit);
  }

  /**
   * Market-specific ranking prior for a contract, in ranking points.
   * Capped and sample-gated so a short lucky streak cannot dominate.
   */
  prior(
    symbol: string,
    contractLabel: string,
    theoretical: number,
  ): { points: number; detail: string } {
    const p = this.get(symbol);
    const b = p?.contracts[contractLabel];
    if (!p || !b || b.n < 20) {
      return {
        points: 0,
        detail: `No market-specific learning for ${contractLabel} on ${symbol} yet (${b?.n ?? 0} resolved) — no influence.`,
      };
    }
    const rate = b.wins / b.n;
    const authority = Math.min(1, b.n / 120);
    const points = Math.max(-6, Math.min(6, (rate - theoretical) * 45 * authority));
    return {
      points: Math.round(points * 10) / 10,
      detail: `${symbol} has learned ${contractLabel} at ${(rate * 100).toFixed(1)}% over ${b.n} own resolutions (authority ×${authority.toFixed(2)}); theoretical ${(theoretical * 100).toFixed(1)}%.`,
    };
  }

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  reset(symbol?: string) {
    load();
    if (symbol) delete store.markets[symbol];
    else store = { markets: {}, updatedAt: Date.now() };
    save();
    emit();
  }
}

export const marketProfiles = new ProfileStore();
