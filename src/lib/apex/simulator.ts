// APEX SENTINEL — CONTINUOUS PER-MARKET CONTRACT SIMULATOR (paper trading only).
//
// Every market in the validated Sentinel universe owns its own simulator state.
// The state is alive for as long as Sentinel is running — it is NOT created when
// a market becomes the #1 candidate and NOT destroyed when a React component
// unmounts (this module is a singleton; the ledger is persisted).
//
// The simulator is a CONTRACT simulator, not a digit-frequency counter:
//   • an entry is opened only on information that existed at that tick,
//   • the entry state is frozen and never rewritten,
//   • resolution happens on the ACTUAL expiry digit under the real contract rule
//     (Under 7 → expiry 0-6 WIN / 7-9 LOSS, Over 2 → expiry 3-9 WIN / 0-2 LOSS),
//   • intermediate ticks never settle a position, so 7 → 0 and 0 → 7 are
//     different events.
//
// When there is no valid setup the simulator records WAIT / BLOCKED — it never
// invents a trade, and never fabricates wins or losses.
import type { ApexContractId, ContractEval, MarketIntel } from "./types";
import { entryLab, type EntryRuleId } from "./entry-conditions";
import { safeStorage, safeJsonParse } from "@/lib/storage-fallback";

export type SimResult = "OPEN" | "WIN" | "LOSS";

/** Lifecycle state of one market's simulator. */
export type SimStatus =
  "INSUFFICIENT DATA" | "STALE FEED" | "WAITING" | "BLOCKED" | "READY" | "OPEN" | "COOLDOWN";

/** Sample maturity tiers — thin samples are never allowed to look validated. */
export type SimTier = "NONE" | "THIN" | "EARLY" | "USABLE" | "MATURE" | "HIGH";

/** Evidence-level verdict on a market/contract's simulated record. */
export type SimHealth =
  "NO SAMPLE" | "INSUFFICIENT SAMPLE" | "DEVELOPING" | "VALIDATED" | "UNDERPERFORMING";

/** Why a market is (or is not) actionable right now. */
export type SimReadiness =
  | "READY"
  | "WAITING FOR ENTRY"
  | "DEVELOPING"
  | "INSUFFICIENT SAMPLE"
  | "CONTRADICTED"
  | "DANGEROUS"
  | "UNDERPERFORMING"
  | "BLOCKED";

/** Per-market opportunity accounting for the rolling window. */
export interface SimCounters {
  opportunities: number;
  rejected: number;
  simulated: number;
  insufficientEvidence: number;
}

export interface SimEntryState {
  opportunity: number;
  confidence: number;
  edge: number;
  quality: number;
  stability: number;
  freshness: number;
  danger: number;
  dangerClearance: boolean;
  regime: string;
  threatState: string;
  losingThreat: number;
  sensitiveConflict: boolean;
  criticalDetail: string;
  barState: string;
  mostIncreasing: number | null;
  forwardState: string;
  agreement: string;
  modelState: string;
  reason: string;
  /** Simulated record for this market/contract BEFORE the entry was taken. */
  simBefore: { n: number; winRate: number };
  /** Rolling-window record for this market/contract BEFORE the entry. */
  simRecentBefore: { n: number; winRate: number };
  /**
   * Which engines voted for this entry, and how strongly. This is what makes
   * per-engine effectiveness measurable against contract-resolved outcomes.
   */
  engineVotes?: { engine: string; weight: number }[];
}

export interface SimTrade {
  id: string;
  openedAt: number;
  resolvedAt: number | null;
  symbol: string;
  market: string;
  contract: ApexContractId;
  contractLabel: string;
  side: "UNDER" | "OVER";
  barrier: number;
  winners: number[];
  entryDigit: number;
  entryQuote: number;
  durationTicks: number;
  ticksElapsed: number;
  expiryAt: number | null;
  expiryDigit: number | null;
  result: SimResult;
  stake: number;
  payout: number; // net profit multiple on a win
  pnl: number;
  /** Entry condition that authorised this entry. */
  entryCondition: string;
  entryRule: EntryRuleId | null;
  invalidationReason: string | null;
  state: SimEntryState;
}

export interface SimPerformance {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  theoretical: number;
  edgePp: number;
  /** Wilson 95% lower bound on the observed contract win rate. */
  lower: number;
  upper: number;
  expectancy: number; // payout-adjusted P/L per stake unit
  netPnl: number;
  maxDrawdown: number;
  longestLosingStreak: number;
  longestWinningStreak: number;
  currentStreak: number; // + wins, − losses
  /** Win rate of the most recent 30 resolutions (−1 when unavailable). */
  rollingWinRate: number;
  /** rollingWinRate − winRate, in percentage points. Negative = deteriorating. */
  deteriorationPp: number;
  /** Most recent results, newest last. */
  recentResults: ("WIN" | "LOSS")[];
  tier: SimTier;
  health: SimHealth;
}

export interface SimBucket {
  key: string;
  n: number;
  wins: number;
  winRate: number;
  netPnl: number;
}

export interface SimBreakdown {
  regime: SimBucket[];
  scoreBand: SimBucket[];
  threat: SimBucket[];
  freshness: SimBucket[];
  stability: SimBucket[];
  agreement: SimBucket[];
  entryCondition: SimBucket[];
}

export interface SimGate {
  label: string;
  ok: boolean;
  detail: string;
}

/** One bucketed record inside a market snapshot. */
export interface SnapshotBucket {
  key: string;
  n: number;
  winRate: number;
  expectancy: number;
}

/** Everything Sentinel needs to reason about ONE market at signal time. */
export interface MarketSnapshot {
  symbol: string;
  marketName: string;
  contract: ApexContractId | null;
  contractLabel: string | null;
  windowMs: number;
  recent: SimPerformance;
  lifetime: SimPerformance;
  recentSequence: ("WIN" | "LOSS")[];
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: number;
  bestContract: SnapshotBucket | null;
  worstContract: SnapshotBucket | null;
  bestEntryCondition: SnapshotBucket | null;
  worstEntryCondition: SnapshotBucket | null;
  entryConditionSatisfied: boolean;
  dangerClearance: boolean;
  readiness: SimReadiness;
  counters: SimCounters;
}

/** Continuously maintained state of ONE market's simulator. */
export interface MarketSimulationState {
  symbol: string;
  marketName: string;
  status: SimStatus;
  readiness: SimReadiness;
  /** Human reasons the simulator is not entering right now. */
  blockedBy: string[];
  gates: SimGate[];
  currentCandidate: string | null; // contract label under evaluation
  currentContract: ApexContractId | null;
  currentEntryCondition: string | null;
  entryConditionSatisfied: boolean;
  dangerClearance: boolean;
  openTrade: SimTrade | null;
  entryDigit: number | null;
  entryTimestamp: number | null;
  expiryTimestamp: number | null;
  durationTicks: number;
  cooldownTicks: number;
  lastResult: "WIN" | "LOSS" | null;
  lastEntryAt: number | null;
  lastExpiryAt: number | null;
  resolvedTrades: number;
  /** Aggregate performance across every contract traded on this market. */
  perf: SimPerformance;
  /** Rolling-window performance for this market only. */
  recent: SimPerformance;
  counters: SimCounters;
  /** Per-contract performance for this market. */
  byContract: { contract: ApexContractId; label: string; perf: SimPerformance }[];
  updatedAt: number;
}

export interface SimConfig {
  /** Contract duration in ticks — the expiry tick is the one that resolves it. */
  durationTicks: number;
  stake: number;
  /** Minimum opportunity score before the simulator will open a paper trade. */
  minScore: number;
  maxDanger: number;
  /** Losing-side group threat above which no entry is allowed. */
  maxLosingThreat: number;
  /** Ticks the market/contract must wait after a resolution. */
  cooldownTicks: number;
  /** House margin used to derive a realistic payout from the fair odds. */
  houseMargin: number;
  /** Rolling operational window — the current state of a market. */
  recentWindowMs: number;
  /** Sample thresholds governing how much authority a record has. */
  thinN: number; // below this: informational only
  earlyN: number;
  usableN: number;
  matureN: number;
  highN: number;
  /** Resolutions required before poor performance may block a candidate. */
  blockAfterN: number;
}

export const DEFAULT_SIM_CONFIG: SimConfig = {
  durationTicks: 1,
  stake: 1,
  minScore: 62,
  maxDanger: 62,
  maxLosingThreat: 72,
  cooldownTicks: 6,
  houseMargin: 0.05,
  recentWindowMs: 20 * 60_000,
  thinN: 25,
  earlyN: 60,
  usableN: 120,
  matureN: 250,
  highN: 250,
  blockAfterN: 60,
};

const LEDGER_CAP = 1200;
const STORE_KEY = "apex.simulator.v2";
const STALE_MS = 15_000;

function wilson(w: number, n: number): { lower: number; upper: number } {
  if (!n) return { lower: 0, upper: 0 };
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lower: Math.max(0, (c - m) / d), upper: Math.min(1, (c + m) / d) };
}

function band(v: number, edges: number[], labels: string[]): string {
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

export function tierFor(n: number, cfg: SimConfig): SimTier {
  if (n <= 0) return "NONE";
  if (n < cfg.thinN) return "THIN";
  if (n < cfg.earlyN) return "EARLY";
  if (n < cfg.usableN) return "USABLE";
  if (n < cfg.highN) return "MATURE";
  return "HIGH";
}

/** Fraction of ranking authority a record of this tier is allowed. */
function tierWeight(tier: SimTier): number {
  switch (tier) {
    case "NONE":
    case "THIN":
      return 0;
    case "EARLY":
      return 0.18;
    case "USABLE":
      return 0.35;
    case "MATURE":
      return 0.5;
    case "HIGH":
      return 0.62;
  }
}

function healthFor(p: Omit<SimPerformance, "health">, cfg: SimConfig): SimHealth {
  if (!p.n) return "NO SAMPLE";
  if (p.tier === "THIN") return "INSUFFICIENT SAMPLE";
  if (p.n >= cfg.blockAfterN && (p.winRate < p.theoretical - 0.04 || p.expectancy < 0))
    return "UNDERPERFORMING";
  if (p.tier === "MATURE" || p.tier === "HIGH") {
    if (p.lower >= p.theoretical && p.expectancy > 0) return "VALIDATED";
    if (p.winRate < p.theoretical - 0.02) return "UNDERPERFORMING";
  }
  return "DEVELOPING";
}

function summarise(trades: SimTrade[], theoretical: number, cfg: SimConfig): SimPerformance {
  const closed = trades.filter((t) => t.result !== "OPEN");
  const n = closed.length;
  const wins = closed.filter((t) => t.result === "WIN").length;
  const winRate = n ? wins / n : 0;
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let losingStreak = 0;
  let longest = 0;
  let netPnl = 0;
  for (const t of closed) {
    netPnl += t.pnl;
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (t.result === "LOSS") {
      losingStreak++;
      longest = Math.max(longest, losingStreak);
    } else losingStreak = 0;
  }
  let currentStreak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const win = closed[i].result === "WIN";
    if (i === closed.length - 1) currentStreak = win ? 1 : -1;
    else if (win && currentStreak > 0) currentStreak++;
    else if (!win && currentStreak < 0) currentStreak--;
    else break;
  }
  const recent = closed.slice(Math.max(0, closed.length - 30));
  const rollingWinRate =
    recent.length >= 10 ? recent.filter((t) => t.result === "WIN").length / recent.length : -1;
  const { lower, upper } = wilson(wins, n);
  const base: Omit<SimPerformance, "health"> = {
    n,
    wins,
    losses: n - wins,
    winRate,
    theoretical,
    edgePp: (winRate - theoretical) * 100,
    lower,
    upper,
    expectancy: n ? netPnl / n : 0,
    netPnl,
    maxDrawdown,
    longestLosingStreak: longest,
    longestWinningStreak: longestWins(closed),
    currentStreak,
    rollingWinRate,
    deteriorationPp: rollingWinRate < 0 ? 0 : (rollingWinRate - winRate) * 100,
    recentResults: closed
      .slice(Math.max(0, closed.length - 20))
      .map((t) => (t.result === "WIN" ? "WIN" : "LOSS")),
    tier: tierFor(n, cfg),
  };
  return { ...base, health: healthFor(base, cfg) };
}

function bucketise(trades: SimTrade[], pick: (t: SimTrade) => string): SimBucket[] {
  const map = new Map<string, SimBucket>();
  for (const t of trades) {
    if (t.result === "OPEN") continue;
    const key = pick(t);
    const b = map.get(key) ?? { key, n: 0, wins: 0, winRate: 0, netPnl: 0 };
    b.n++;
    if (t.result === "WIN") b.wins++;
    b.netPnl += t.pnl;
    map.set(key, b);
  }
  return [...map.values()]
    .map((b) => ({ ...b, winRate: b.n ? b.wins / b.n : 0 }))
    .sort((a, b) => b.n - a.n);
}

/** Longest winning streak inside a chronological list of resolutions. */
function longestWins(trades: SimTrade[]): number {
  let run = 0;
  let best = 0;
  for (const t of trades) {
    if (t.result === "WIN") {
      run++;
      best = Math.max(best, run);
    } else if (t.result === "LOSS") run = 0;
  }
  return best;
}

class ApexSimulator {
  private config: SimConfig = { ...DEFAULT_SIM_CONFIG };
  /**
   * ONE COMPLETELY ISOLATED LEDGER PER MARKET. There is no shared array: a
   * trade is written into exactly one book, keyed by its own symbol, and no
   * statistic can be produced without naming the market it belongs to.
   */
  private books = new Map<string, SimTrade[]>();
  private open = new Map<string, SimTrade>(); // `${symbol}:${contract}`
  private cooldown = new Map<string, number>(); // remaining ticks
  private states = new Map<string, MarketSimulationState>();
  private listeners = new Set<() => void>();
  /** Notified once per contract-resolved trade (used by durable persistence). */
  private resolvedListeners = new Set<(t: SimTrade) => void>();
  private seq = 0;
  private restored = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  getConfig(): SimConfig {
    return { ...this.config };
  }

  setConfig(patch: Partial<SimConfig>) {
    this.config = { ...this.config, ...patch };
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe to contract RESOLUTIONS. Each callback receives the resolved
   * trade, already tagged with the only market it belongs to, so a durable
   * store can append evidence without ever merging markets.
   */
  onResolved(fn: (t: SimTrade) => void): () => void {
    this.resolvedListeners.add(fn);
    return () => this.resolvedListeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  // ── Per-market books ────────────────────────────────────────────────
  /** The isolated ledger of ONE market. Never merged with another market. */
  private book(symbol: string): SimTrade[] {
    let b = this.books.get(symbol);
    if (!b) {
      b = [];
      this.books.set(symbol, b);
    }
    return b;
  }

  /** Write a trade into exactly one market ledger. */
  private record(trade: SimTrade) {
    const b = this.book(trade.symbol);
    b.push(trade);
    if (b.length > LEDGER_CAP) b.splice(0, b.length - LEDGER_CAP);
  }

  /** Flattened view for the ALL-MARKET OVERVIEW only. */
  private allTrades(): SimTrade[] {
    return [...this.books.values()].flat().sort((a, b) => a.openedAt - b.openedAt);
  }

  // ── Persistence ─────────────────────────────────────────────────────
  /** Restore the resolved ledgers so a UI remount cannot erase the record. */
  restore() {
    if (this.restored) return;
    this.restored = true;
    try {
      const raw = safeStorage.getItem(STORE_KEY);
      if (!raw) return;
      const parsed = safeJsonParse<{ books?: Record<string, SimTrade[]>; trades?: SimTrade[] } | null>(
        raw,
        null,
      );
      if (!parsed) return;
      this.books.clear();
      // v3 shape: already partitioned per market.
      for (const [sym, trades] of Object.entries(parsed.books ?? {})) {
        this.books.set(
          sym,
          (trades ?? [])
            .filter((t) => t && t.result !== "OPEN" && t.symbol === sym)
            .slice(-LEDGER_CAP),
        );
      }
      // v2 shape: a single array — re-partition it by its own market ids.
      for (const t of parsed.trades ?? []) {
        if (!t || t.result === "OPEN" || !t.symbol) continue;
        this.book(t.symbol).push(t);
      }
      this.emit();
    } catch {
      /* corrupt store — start clean rather than trusting bad data */
    }
  }

  private persist() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const books: Record<string, SimTrade[]> = {};
        for (const [sym, trades] of this.books)
          books[sym] = trades.filter((t) => t.result !== "OPEN").slice(-LEDGER_CAP);
        safeStorage.setItem(STORE_KEY, JSON.stringify({ books }));
      } catch {
        /* quota — the in-memory record remains authoritative */
      }
    }, 2500);
  }

  /**
   * Serialise the resolved ledgers, ONE ENTRY PER MARKET. The returned shape is
   * keyed by symbol so a durable store writes one isolated row per market and
   * can never blend two markets' evidence.
   */
  exportBooks(): Record<string, SimTrade[]> {
    const out: Record<string, SimTrade[]> = {};
    for (const [sym, trades] of this.books) {
      const resolved = trades.filter((t) => t.result !== "OPEN" && t.symbol === sym);
      if (resolved.length) out[sym] = resolved.slice(-LEDGER_CAP);
    }
    return out;
  }

  /** Resolved ledger of ONE market, for durable per-market persistence. */
  exportMarket(symbol: string): SimTrade[] {
    return this.book(symbol)
      .filter((t) => t.result !== "OPEN" && t.symbol === symbol)
      .slice(-LEDGER_CAP);
  }

  /**
   * Merge durable evidence back in. Every trade is filed under ITS OWN symbol:
   * a payload that claims to be V100 but contains a V75 trade cannot pollute
   * V100, the mismatched record is discarded. Duplicate ids are ignored so
   * reloading twice cannot inflate a market's statistics.
   */
  importBooks(books: Record<string, SimTrade[]>) {
    let added = 0;
    for (const [sym, trades] of Object.entries(books ?? {})) {
      if (!sym || !Array.isArray(trades)) continue;
      const book = this.book(sym);
      const seen = new Set(book.map((t) => t.id));
      for (const t of trades) {
        if (!t || t.symbol !== sym || t.result === "OPEN") continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        book.push(t);
        added++;
      }
      book.sort((a, b) => a.openedAt - b.openedAt);
      if (book.length > LEDGER_CAP) book.splice(0, book.length - LEDGER_CAP);
    }
    if (added) {
      this.restored = true;
      this.emit();
    }
    return added;
  }

  // ── Universe registration ───────────────────────────────────────────
  /**
   * Every valid market gets a live simulator state immediately, before any
   * ticks arrive, so the command centre can show it as monitoring rather than
   * hiding it until it becomes a candidate.
   */
  registerUniverse(markets: { symbol: string; name: string }[]) {
    for (const m of markets) this.ensure(m.symbol, m.name);
    // Drop anything no longer in the validated universe (e.g. excluded markets).
    const allowed = new Set(markets.map((m) => m.symbol));
    for (const sym of [...this.states.keys()]) if (!allowed.has(sym)) this.states.delete(sym);
    for (const sym of [...this.books.keys()]) if (!allowed.has(sym)) this.books.delete(sym);
    this.emit();
  }

  private ensure(symbol: string, name: string): MarketSimulationState {
    const existing = this.states.get(symbol);
    if (existing) {
      existing.marketName = name || existing.marketName;
      return existing;
    }
    const empty = summarise([], 0.7, this.config);
    const state: MarketSimulationState = {
      symbol,
      marketName: name,
      status: "INSUFFICIENT DATA",
      readiness: "INSUFFICIENT SAMPLE",
      blockedBy: [],
      gates: [],
      currentCandidate: null,
      currentContract: null,
      currentEntryCondition: null,
      entryConditionSatisfied: false,
      dangerClearance: false,
      openTrade: null,
      entryDigit: null,
      entryTimestamp: null,
      expiryTimestamp: null,
      durationTicks: this.config.durationTicks,
      cooldownTicks: 0,
      lastResult: null,
      lastEntryAt: null,
      lastExpiryAt: null,
      resolvedTrades: 0,
      perf: empty,
      recent: empty,
      counters: { opportunities: 0, rejected: 0, simulated: 0, insufficientEvidence: 0 },
      byContract: [],
      updatedAt: Date.now(),
    };
    this.states.set(symbol, state);
    return state;
  }

  getStates(): MarketSimulationState[] {
    return [...this.states.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  getState(symbol: string): MarketSimulationState | undefined {
    return this.states.get(symbol);
  }

  /** ALL-MARKET OVERVIEW ledger — never evidence for an individual market. */
  getLedger(limit = 60): SimTrade[] {
    return this.allTrades().slice(-limit).reverse();
  }

  /** Chronological ledger for one market, newest first. */
  getMarketLedger(symbol: string, limit = 100): SimTrade[] {
    return this.book(symbol).slice(-limit).reverse();
  }

  /** Resolutions of ONE market inside the rolling window, oldest first. */
  getRecentMarketLedger(symbol: string, windowMs = this.config.recentWindowMs): SimTrade[] {
    const cutoff = Date.now() - windowMs;
    return this.book(symbol).filter((t) => t.result !== "OPEN" && (t.resolvedAt ?? 0) >= cutoff);
  }

  getOpen(): SimTrade[] {
    return [...this.open.values()];
  }

  /** Payout multiple derived from fair odds minus the configured house margin. */
  payoutFor(theoretical: number): number {
    if (theoretical <= 0) return 0;
    return Math.max(0, (1 / theoretical) * (1 - this.config.houseMargin) - 1);
  }

  /**
   * Called once per observed tick, AFTER the digit is known. Only positions
   * opened strictly before this tick can be resolved by it — this is where
   * causal integrity is enforced.
   */
  onTick(symbol: string, digit: number, at: number) {
    const state = this.states.get(symbol);
    const resolvedNow: SimTrade[] = [];
    for (const [key, trade] of this.open) {
      if (trade.symbol !== symbol) continue;
      trade.ticksElapsed++;
      if (trade.ticksElapsed < trade.durationTicks) continue;
      trade.expiryDigit = digit;
      trade.expiryAt = at;
      const won = trade.winners.includes(digit);
      trade.result = won ? "WIN" : "LOSS";
      trade.pnl = won ? trade.stake * trade.payout : -trade.stake;
      trade.resolvedAt = at;
      this.open.delete(key);
      this.cooldown.set(key, this.config.cooldownTicks);
      if (state) {
        state.lastResult = trade.result;
        state.lastExpiryAt = at;
        state.openTrade = null;
        state.status = "COOLDOWN";
        state.cooldownTicks = this.config.cooldownTicks;
        state.resolvedTrades++;
      }
      this.persist();
      resolvedNow.push(trade);
    }
    // Notify durable persistence AFTER the ledger write, so a listener can
    // never observe a half-resolved trade.
    if (resolvedNow.length)
      for (const t of resolvedNow) this.resolvedListeners.forEach((fn) => fn({ ...t }));
    for (const [key, left] of this.cooldown) {
      if (!key.startsWith(`${symbol}:`)) continue;
      if (left <= 1) this.cooldown.delete(key);
      else this.cooldown.set(key, left - 1);
    }
    if (state) {
      state.cooldownTicks = Math.max(
        0,
        ...[...this.cooldown.entries()]
          .filter(([k]) => k.startsWith(`${symbol}:`))
          .map(([, v]) => v),
        0,
      );
      state.updatedAt = Date.now();
    }
    this.emit();
  }

  /**
   * Offer the current intelligence state to this market's simulator. This runs
   * for EVERY market on every analysis cycle: it either opens a locked paper
   * position, or records exactly why it is waiting.
   */
  consider(intel: MarketIntel, agreementOf: (c: ContractEval) => string) {
    const state = this.ensure(intel.symbol, intel.name);
    state.updatedAt = Date.now();
    state.durationTicks = this.config.durationTicks;

    const openTrade = [...this.open.values()].find((t) => t.symbol === intel.symbol) ?? null;
    state.openTrade = openTrade;

    if (openTrade) {
      state.status = "OPEN";
      state.readiness = "READY";
      state.blockedBy = [];
      state.currentCandidate = openTrade.contractLabel;
      state.currentContract = openTrade.contract;
      state.currentEntryCondition = openTrade.entryCondition;
      state.entryDigit = openTrade.entryDigit;
      state.entryTimestamp = openTrade.openedAt;
      state.expiryTimestamp = null;
      this.refreshPerf(state, intel);
      return;
    }

    if (intel.dataState === "UNAVAILABLE" || intel.dataState === "THIN") {
      state.status = "INSUFFICIENT DATA";
      state.readiness = "INSUFFICIENT SAMPLE";
      state.counters.insufficientEvidence++;
      state.blockedBy = [`Only ${intel.ticks} ticks buffered — insufficient data to evaluate.`];
      state.gates = [];
      state.currentCandidate = null;
      state.currentContract = null;
      this.refreshPerf(state, intel);
      return;
    }
    if (intel.dataState === "STALE" || intel.ageMs > STALE_MS) {
      state.status = "STALE FEED";
      state.readiness = "BLOCKED";
      state.blockedBy = ["Feed silent — no fresh tick, evaluation suspended."];
      state.gates = [];
      this.refreshPerf(state, intel);
      return;
    }

    // Candidate = the market's own best contract by opportunity. The simulator
    // tests Sentinel's ACTUAL recommendation, not a random contract.
    const candidate = [...intel.contracts].sort((a, b) => b.opportunity - a.opportunity)[0] ?? null;
    state.currentCandidate = candidate?.label ?? null;
    state.currentContract = candidate?.id ?? null;
    if (!candidate) {
      state.status = "WAITING";
      state.readiness = "DEVELOPING";
      state.blockedBy = ["No contract evaluated for this market yet."];
      state.gates = [];
      this.refreshPerf(state, intel);
      return;
    }

    const key = `${intel.symbol}:${candidate.id}`;
    const cooling = this.cooldown.get(key) ?? 0;
    // EVIDENCE FOR THIS MARKET ONLY — the book is addressed by symbol.
    const perfBefore = this.performance(intel.symbol, candidate.id, candidate.theoretical);
    const recentBefore = this.recentPerformance(intel.symbol, candidate.id, candidate.theoretical);
    const agreement = agreementOf(candidate);
    const cfg = this.config;

    // The discovered entry condition for THIS market/contract, if any.
    const entry = entryLab.recommend(intel.symbol, candidate.id, candidate.theoretical);
    state.currentEntryCondition = entry.best?.label ?? null;
    state.entryConditionSatisfied = entry.best ? entry.activeNow : true;

    const dangerClear =
      candidate.danger <= cfg.maxDanger &&
      (!candidate.threat || candidate.threat.groupThreat < cfg.maxLosingThreat) &&
      !(candidate.critical && candidate.critical.conflicts.length >= 2);
    state.dangerClearance = dangerClear;

    const gates: SimGate[] = [
      {
        label: "Data state",
        ok: intel.dataState === "OK",
        detail: `${intel.dataState} · ${intel.ticks} ticks · ${(intel.ageMs / 1000).toFixed(1)}s old`,
      },
      {
        label: "Opportunity ≥ threshold",
        ok: candidate.opportunity >= cfg.minScore,
        detail: `${candidate.opportunity.toFixed(0)} vs ${cfg.minScore} required`,
      },
      {
        label: "Danger below limit",
        ok: candidate.danger <= cfg.maxDanger,
        detail: `${candidate.danger.toFixed(0)} vs ${cfg.maxDanger} allowed`,
      },
      {
        label: "Composite edge positive",
        ok: candidate.compositeEdge > 0,
        detail: candidate.compositeEdge.toFixed(1),
      },
      {
        label: "Losing-side threat contained",
        ok: !candidate.threat || candidate.threat.groupThreat < cfg.maxLosingThreat,
        detail: candidate.threat
          ? `${candidate.threat.groupThreat.toFixed(0)} (${candidate.threat.state}) vs ${cfg.maxLosingThreat} limit`
          : "no threat report",
      },
      {
        label: "Sensitive-digit conflict not severe",
        ok: !candidate.critical || candidate.critical.conflicts.length < 2,
        detail: candidate.critical?.detail ?? "no critical structure on the losing side",
      },
      {
        label: "Fake-edge interrogation passed",
        ok: !candidate.fakeEdge || candidate.fakeEdge.verdict !== "REJECTED",
        detail: candidate.fakeEdge
          ? `${candidate.fakeEdge.verdict} (${candidate.fakeEdge.failures} failed checks)`
          : "not evaluated",
      },
      {
        label: "Engines not in strong conflict",
        ok: agreement !== "STRONG CONFLICT",
        detail: agreement,
      },
      {
        label: "Setup not invalidating",
        ok: candidate.phase !== "INVALIDATING",
        detail: candidate.phase,
      },
      {
        label: "Forward state not deteriorating",
        ok: !candidate.forward || candidate.forward.direction !== "DETERIORATING",
        detail: candidate.forward?.direction ?? "no projection",
      },
      {
        label: "Discovered entry condition satisfied",
        ok: state.entryConditionSatisfied,
        detail: entry.best
          ? `${entry.best.label} — ${entry.currentTrigger}`
          : "no validated entry condition on this market/contract yet — entering immediately",
      },
      {
        label: "Simulator record not failing (this market)",
        ok: !(perfBefore.n >= cfg.blockAfterN && perfBefore.health === "UNDERPERFORMING"),
        detail: perfBefore.n
          ? `${(perfBefore.winRate * 100).toFixed(1)}% · N=${perfBefore.n} · ${perfBefore.health}`
          : "no resolved sample yet",
      },
      {
        label: "No open position / cooldown clear",
        ok: cooling === 0,
        detail: cooling ? `${cooling} tick(s) of cooldown remaining` : "clear",
      },
    ];

    const failed = gates.filter((g) => !g.ok);
    state.gates = gates;
    state.blockedBy = failed.map((g) => `${g.label}: ${g.detail}`);
    state.counters.opportunities++;

    if (failed.length) {
      state.counters.rejected++;
      state.status =
        cooling > 0 && failed.length === 1
          ? "COOLDOWN"
          : failed.length >= 2
            ? "BLOCKED"
            : "WAITING";
      state.readiness = !dangerClear
        ? "DANGEROUS"
        : agreement === "STRONG CONFLICT"
          ? "CONTRADICTED"
          : perfBefore.health === "UNDERPERFORMING"
            ? "UNDERPERFORMING"
            : failed.length === 1 && !state.entryConditionSatisfied
              ? "WAITING FOR ENTRY"
              : failed.length >= 3
                ? "BLOCKED"
                : "DEVELOPING";
      state.cooldownTicks = cooling;
      this.refreshPerf(state, intel);
      return;
    }

    // ── Entry: freeze the state and lock the position ─────────────────
    const lastDigit = intel.stats?.lastDigit ?? -1;
    if (lastDigit < 0) {
      state.status = "WAITING";
      state.readiness = "WAITING FOR ENTRY";
      state.blockedBy = ["Entry digit unavailable on this tick."];
      this.refreshPerf(state, intel);
      return;
    }

    const openedAt = intel.lastTickAt || Date.now();
    const trade: SimTrade = {
      id: `${intel.symbol}-${candidate.id}-${++this.seq}-${Date.now()}`,
      openedAt,
      resolvedAt: null,
      symbol: intel.symbol,
      market: intel.name,
      contract: candidate.id,
      contractLabel: candidate.label,
      side: candidate.side,
      barrier: candidate.barrier,
      winners: [...(candidate.winners ?? [])],
      entryDigit: lastDigit,
      entryQuote: 0,
      durationTicks: cfg.durationTicks,
      ticksElapsed: 0,
      expiryAt: null,
      expiryDigit: null,
      result: "OPEN",
      stake: cfg.stake,
      payout: this.payoutFor(candidate.theoretical),
      pnl: 0,
      entryCondition: entry.best?.label ?? "IMMEDIATE (no validated condition yet)",
      entryRule: entry.best?.rule ?? null,
      invalidationReason: null,
      state: {
        opportunity: Math.round(candidate.opportunity),
        confidence: Math.round(candidate.confidence),
        edge: Math.round(candidate.compositeEdge * 10) / 10,
        quality: Math.round(candidate.quality),
        stability: Math.round(candidate.stability),
        freshness: Math.round(candidate.freshness),
        danger: Math.round(candidate.danger),
        dangerClearance: dangerClear,
        regime: intel.regime?.label ?? "UNKNOWN",
        threatState: candidate.threat?.state ?? "UNKNOWN",
        losingThreat: Math.round(candidate.threat?.groupThreat ?? 0),
        sensitiveConflict: Boolean(candidate.critical && candidate.critical.conflicts.length > 0),
        criticalDetail: candidate.critical?.detail ?? "—",
        barState: intel.bars?.current
          ? `${intel.bars.consecutive}× ${intel.bars.current.color}`
          : "—",
        mostIncreasing: intel.digitIntel?.increasing[0] ?? null,
        forwardState: candidate.forward?.direction ?? "—",
        agreement,
        modelState: candidate.ensemble
          ? candidate.ensemble.validated > 0
            ? "VALIDATED"
            : "NOT VALIDATED"
          : "INSUFFICIENT DATA",
        reason: candidate.supports[0]?.label ?? "composite opportunity threshold met",
        simBefore: { n: perfBefore.n, winRate: perfBefore.winRate },
        simRecentBefore: { n: recentBefore.n, winRate: recentBefore.winRate },
        // Engine attribution: every engine that supported (or opposed) this
        // exact entry is recorded so its effectiveness can later be measured
        // against the contract-resolved outcome.
        engineVotes: [
          ...candidate.supports.map((e) => ({ engine: e.engine, weight: Math.abs(e.weight) })),
          ...candidate.conflicts.map((e) => ({ engine: e.engine, weight: -Math.abs(e.weight) })),
        ],
      },
    };
    this.open.set(key, trade);
    this.record(trade); // exactly ONE market ledger receives this trade
    state.counters.simulated++;

    state.status = "OPEN";
    state.readiness = "READY";
    state.openTrade = trade;
    state.entryDigit = trade.entryDigit;
    state.entryTimestamp = trade.openedAt;
    state.lastEntryAt = trade.openedAt;
    state.blockedBy = [];
    this.refreshPerf(state, intel);
    this.emit();
  }

  private refreshPerf(state: MarketSimulationState, intel: MarketIntel) {
    const trades = this.book(state.symbol);
    const closed = trades.filter((t) => t.result !== "OPEN");
    const theo = closed.length
      ? closed.reduce((a, t) => a + t.winners.length / 10, 0) / closed.length
      : 0.7;
    state.perf = summarise(trades, theo, this.config);
    state.recent = summarise(this.getRecentMarketLedger(state.symbol), theo, this.config);
    state.resolvedTrades = state.perf.n;
    const ids = new Map<ApexContractId, { label: string; trades: SimTrade[] }>();
    for (const t of trades) {
      const e = ids.get(t.contract) ?? { label: t.contractLabel, trades: [] };
      e.trades.push(t);
      ids.set(t.contract, e);
    }
    state.byContract = [...ids.entries()]
      .map(([contract, e]) => ({
        contract,
        label: e.label,
        perf: summarise(
          e.trades,
          intel.contracts.find((c) => c.id === contract)?.theoretical ??
            e.trades[0].winners.length / 10,
          this.config,
        ),
      }))
      .sort((a, b) => b.perf.n - a.perf.n);
  }

  /** Lifetime contract-resolved performance for ONE market/contract pair. */
  performance(symbol: string, contract: ApexContractId, theoretical: number): SimPerformance {
    return summarise(
      this.book(symbol).filter((t) => t.contract === contract),
      theoretical,
      this.config,
    );
  }

  /**
   * ROLLING RECENT PERFORMANCE for one market (optionally one contract).
   * This is the current state of the market — never a lifetime aggregate and
   * never mixed with any other market.
   */
  recentPerformance(
    symbol: string,
    contract: ApexContractId | null,
    theoretical: number,
    windowMs = this.config.recentWindowMs,
  ): SimPerformance {
    const scoped = this.getRecentMarketLedger(symbol, windowMs).filter(
      (t) => !contract || t.contract === contract,
    );
    return summarise(scoped, theoretical, this.config);
  }

  /**
   * Everything Sentinel needs to reason about ONE market at signal time.
   * Every number in here is produced from that market's own ledger.
   */
  snapshot(
    symbol: string,
    contract: ApexContractId | null = null,
    theoretical = 0.7,
    windowMs = this.config.recentWindowMs,
  ): MarketSnapshot {
    const state = this.states.get(symbol);
    const recentTrades = this.getRecentMarketLedger(symbol, windowMs).filter(
      (t) => !contract || t.contract === contract,
    );
    const lifetimeTrades = this.book(symbol).filter((t) => !contract || t.contract === contract);
    const recent = summarise(recentTrades, theoretical, this.config);
    const lifetime = summarise(lifetimeTrades, theoretical, this.config);

    const byKey = (
      list: SimTrade[],
      pick: (t: SimTrade) => string,
    ): { key: string; n: number; winRate: number; expectancy: number }[] => {
      const map = new Map<string, { key: string; n: number; wins: number; pnl: number }>();
      for (const t of list) {
        if (t.result === "OPEN") continue;
        const k = pick(t);
        const e = map.get(k) ?? { key: k, n: 0, wins: 0, pnl: 0 };
        e.n++;
        if (t.result === "WIN") e.wins++;
        e.pnl += t.pnl;
        map.set(k, e);
      }
      return [...map.values()]
        .map((e) => ({ key: e.key, n: e.n, winRate: e.wins / e.n, expectancy: e.pnl / e.n }))
        .sort((a, b) => b.expectancy - a.expectancy);
    };

    const contracts = byKey(recentTrades, (t) => t.contractLabel);
    const conditions = byKey(recentTrades, (t) => t.entryCondition);

    return {
      symbol,
      marketName: state?.marketName ?? symbol,
      contract,
      contractLabel: contract ? (lifetimeTrades[0]?.contractLabel ?? contract) : null,
      windowMs,
      recent,
      lifetime,
      recentSequence: recent.recentResults,
      longestWinStreak: longestWins(recentTrades),
      longestLossStreak: recent.longestLosingStreak,
      currentStreak: recent.currentStreak,
      bestContract: contracts[0] ?? null,
      worstContract: contracts.length > 1 ? contracts[contracts.length - 1] : null,
      bestEntryCondition: conditions[0] ?? null,
      worstEntryCondition: conditions.length > 1 ? conditions[conditions.length - 1] : null,
      entryConditionSatisfied: state?.entryConditionSatisfied ?? false,
      dangerClearance: state?.dangerClearance ?? false,
      readiness: state?.readiness ?? "INSUFFICIENT SAMPLE",
      counters: state?.counters ?? {
        opportunities: 0,
        rejected: 0,
        simulated: 0,
        insufficientEvidence: 0,
      },
    };
  }

  /** Portfolio-level ALL-MARKET OVERVIEW. Never evidence for one market. */
  overall(): SimPerformance {
    const all = this.allTrades();
    const closed = all.filter((t) => t.result !== "OPEN");
    const theo = closed.length
      ? closed.reduce((a, t) => a + t.winners.length / 10, 0) / closed.length
      : 0.7;
    return summarise(all, theo, this.config);
  }

  breakdown(symbol?: string): SimBreakdown {
    const t = symbol ? this.book(symbol) : this.allTrades();
    return {
      regime: bucketise(t, (x) => x.state.regime),
      scoreBand: bucketise(t, (x) =>
        band(x.state.opportunity, [65, 75, 85], ["<65", "65-74", "75-84", "85+"]),
      ),
      threat: bucketise(t, (x) =>
        x.state.sensitiveConflict
          ? `${x.state.threatState} + sensitive conflict`
          : x.state.threatState,
      ),
      freshness: bucketise(t, (x) =>
        band(x.state.freshness, [40, 70], ["stale", "moderate", "fresh"]),
      ),
      stability: bucketise(t, (x) =>
        band(x.state.stability, [40, 70], ["unstable", "moderate", "stable"]),
      ),
      agreement: bucketise(t, (x) => x.state.agreement),
      entryCondition: bucketise(t, (x) => x.entryCondition),
    };
  }

  byMarket(): { symbol: string; market: string; contract: string; perf: SimPerformance }[] {
    const rows: { symbol: string; market: string; contract: string; perf: SimPerformance }[] = [];
    for (const [symbol, trades] of this.books) {
      const keys = new Map<string, SimTrade[]>();
      for (const t of trades) {
        const arr = keys.get(t.contract) ?? [];
        arr.push(t);
        keys.set(t.contract, arr);
      }
      for (const list of keys.values()) {
        const perf = summarise(list, list[0].winners.length / 10, this.config);
        if (!perf.n) continue;
        rows.push({ symbol, market: list[0].market, contract: list[0].contractLabel, perf });
      }
    }
    return rows.sort((a, b) => b.perf.n - a.perf.n);
  }

  reset() {
    this.books.clear();
    this.open.clear();
    this.cooldown.clear();
    const empty = summarise([], 0.7, this.config);
    for (const s of this.states.values()) {
      s.status = "WAITING";
      s.readiness = "INSUFFICIENT SAMPLE";
      s.openTrade = null;
      s.lastResult = null;
      s.resolvedTrades = 0;
      s.byContract = [];
      s.perf = empty;
      s.recent = empty;
      s.counters = { opportunities: 0, rejected: 0, simulated: 0, insufficientEvidence: 0 };
    }
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORE_KEY);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }
}

export const apexSimulator = new ApexSimulator();

/**
 * How much the chronological simulator is allowed to move a candidate's rank.
 * Thin samples move nothing — a good-looking frequency cannot borrow authority
 * from ten paper trades. Upside uses the Wilson LOWER bound (a lucky run cannot
 * promote), downside uses the observed rate (a real losing record must bite).
 */
export function simulatorAdjustment(
  symbol: string,
  contract: ApexContractId,
  theoretical: number,
): { delta: number; note: string; perf: SimPerformance } {
  const cfg = apexSimulator.getConfig();
  const perf = apexSimulator.performance(symbol, contract, theoretical);
  const weight = tierWeight(perf.tier);
  if (weight === 0) {
    return {
      delta: 0,
      note: perf.n
        ? `SIMULATOR THIN — ${(perf.winRate * 100).toFixed(1)}% over N=${perf.n} contract resolutions carries no ranking weight (needs N≥${cfg.thinN}).`
        : "No simulated contract outcomes yet — simulator carries no ranking weight.",
      perf,
    };
  }

  const upside = (perf.lower - theoretical) * 100;
  const downside = (perf.winRate - theoretical) * 100;
  const raw = downside < 0 ? downside : upside;
  let delta = raw * weight;
  // Deterioration inside an otherwise acceptable record still costs the setup.
  if (perf.deteriorationPp < -6) delta -= Math.min(6, Math.abs(perf.deteriorationPp) * 0.3);
  if (perf.expectancy < 0 && perf.n >= cfg.blockAfterN) delta -= 4;
  delta = Math.max(-18, Math.min(10, delta));

  const head = `SIMULATOR ${perf.health} · ${(perf.winRate * 100).toFixed(1)}% over N=${perf.n} (${perf.tier})`;
  const note =
    delta >= 0
      ? `${head} — lower bound ${(perf.lower * 100).toFixed(1)}% vs ${(theoretical * 100).toFixed(0)}% baseline, expectancy ${perf.expectancy.toFixed(3)}.`
      : `${head} — below the ${(theoretical * 100).toFixed(0)}% contract baseline (expectancy ${perf.expectancy.toFixed(3)}); candidate downgraded ${delta.toFixed(1)}.`;
  return { delta, note, perf };
}

/** Engine-agreement label derived from the contract's own evidence stack. */
export function engineAgreement(
  c: ContractEval,
): "SUPPORT" | "NEUTRAL" | "CONFLICT" | "STRONG CONFLICT" {
  if (!c || typeof c !== "object") return "NEUTRAL";
  const supports = Array.isArray(c.supports) ? c.supports.length : 0;
  const conflicts = Array.isArray(c.conflicts) ? c.conflicts.length : 0;
  const severe =
    (c.threat && (c.threat.state === "HIGH" || c.threat.state === "CRITICAL")) ||
    (c.critical && Array.isArray(c.critical.conflicts) && c.critical.conflicts.length >= 2) ||
    (c.contradiction ?? 0) >= 60;
  if (severe) return "STRONG CONFLICT";
  if (conflicts > supports) return "CONFLICT";
  if (supports >= conflicts + 2 && (c.contradiction ?? 0) < 35) return "SUPPORT";
  return "NEUTRAL";
}
