// APEX SENTINEL — STAGE 3.5: COMBINATION LEARNING.
//
// Nothing in Sentinel is learned globally. Effectiveness is only ever measured
// for a full four-dimensional combination:
//
//     MARKET × CONTRACT × REGIME × ENTRY CONDITION
//
// A rule that works on R_10 in a TRENDING regime after a "cold digit
// reactivation" trigger says NOTHING about the same rule on R_75 in a CHAOTIC
// regime. Pooling those two is the single fastest way to manufacture a
// convincing, false edge, so this module never does it.
//
// Recency matters as much as sample size: a combination that worked 200 trades
// ago but has failed for the last 20 is not "still 60% effective". Every
// observation therefore carries an exponential recency weight with a
// configurable half-life, and all reported figures are weighted figures with
// their weighted sample size attached.
import type { SimTrade } from "../apex/simulator";
import { safeStorage, safeJsonParse } from "@/lib/storage-fallback";

export type ComboState =
  "UNTESTED" | "TESTING" | "PROMISING" | "VALIDATED" | "DETERIORATING" | "FAILING";

export interface ComboObservation {
  at: number;
  win: boolean;
  /** Net P/L per unit staked for this observation. */
  pnlPerUnit: number;
}

export interface ComboKey {
  symbol: string;
  contract: string;
  regime: string;
  entryCondition: string;
}

export interface ComboEvidence extends ComboKey {
  key: string;
  /** Raw resolved count for this exact combination. */
  n: number;
  wins: number;
  losses: number;
  /** Recency-weighted sample size — the figure all rates are computed on. */
  weightedN: number;
  /** Recency-weighted win rate (0..1). −1 when there is no sample. */
  weightedWinRate: number;
  /** Unweighted win rate (0..1). −1 when there is no sample. */
  winRate: number;
  /** Wilson 95% lower bound on the weighted win rate. */
  lower: number;
  /** Recency-weighted expectancy per unit staked. */
  weightedExpectancy: number;
  expectancy: number;
  netPnl: number;
  maxDrawdown: number;
  /** Weighted recent rate − weighted lifetime rate, in percentage points. */
  deteriorationPp: number;
  currentStreak: number;
  longestLosingStreak: number;
  lastOutcomeAt: number | null;
  state: ComboState;
  /** 0..100 — how much authority this evidence has earned. */
  confidence: number;
  /** Bounded ranking influence, in score points. */
  rankingDelta: number;
  note: string;
}

export interface ComboLookup {
  /** The exact four-dimension combination, always reported. */
  exact: ComboEvidence;
  /** Same market + contract + regime, best entry condition by weighted edge. */
  bestEntryCondition: ComboEvidence | null;
  /** Every entry condition measured for this market + contract + regime. */
  siblings: ComboEvidence[];
  /** Market + contract across ALL regimes — context only, never authority. */
  regimeSiblings: ComboEvidence[];
}

export interface ComboSerialised {
  version: number;
  halfLifeMs: number;
  entries: {
    key: string;
    symbol: string;
    contract: string;
    regime: string;
    entryCondition: string;
    obs: ComboObservation[];
  }[];
}

const STORE_VERSION = 2;
const CACHE_KEY = "sentinel.combo.v2";
/** Observations kept per combination — enough for a hold-out, bounded memory. */
const OBS_CAP = 400;
/** Default recency half-life: one hour of live trading. */
const DEFAULT_HALF_LIFE_MS = 3_600_000;
/** Recent slice used for the deterioration measurement. */
const RECENT_SLICE = 25;

export const UNKNOWN_REGIME = "UNKNOWN";
export const IMMEDIATE_CONDITION = "IMMEDIATE";

export function comboKeyOf(k: ComboKey): string {
  return `${k.symbol}|${k.contract}|${k.regime || UNKNOWN_REGIME}|${k.entryCondition || IMMEDIATE_CONDITION}`;
}

function wilsonLower(w: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / d);
}

interface Bucket extends ComboKey {
  key: string;
  obs: ComboObservation[];
}

class CombinationLearning {
  private buckets = new Map<string, Bucket>();
  private halfLifeMs = DEFAULT_HALF_LIFE_MS;
  private listeners = new Set<() => void>();
  private dirtyKeys = new Set<string>();
  private loaded = false;

  // ── configuration ───────────────────────────────────────────────────
  getHalfLifeMs(): number {
    return this.halfLifeMs;
  }

  setHalfLifeMs(ms: number) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.halfLifeMs = ms;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** Keys changed since the last flush — the persistence layer drains this. */
  drainDirty(): ComboEvidence[] {
    const keys = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    return keys
      .map((k) => this.buckets.get(k))
      .filter((b): b is Bucket => Boolean(b))
      .map((b) => this.evaluate(b));
  }

  markAllDirty() {
    this.buckets.forEach((_, k) => this.dirtyKeys.add(k));
  }

  // ── ingestion ───────────────────────────────────────────────────────
  /** Record one RESOLVED simulated contract against its exact combination. */
  recordTrade(trade: SimTrade): ComboEvidence | null {
    if (trade.result !== "WIN" && trade.result !== "LOSS") return null;
    const key: ComboKey = {
      symbol: trade.symbol,
      contract: trade.contract,
      // The regime as measured AT ENTRY — never the current one. Using the
      // present regime would leak the future into past evidence.
      regime: trade.state?.regime || UNKNOWN_REGIME,
      entryCondition: trade.entryCondition || IMMEDIATE_CONDITION,
    };
    const stake = trade.stake || 1;
    return this.record(key, {
      at: trade.resolvedAt ?? trade.openedAt,
      win: trade.result === "WIN",
      pnlPerUnit: trade.pnl / stake,
    });
  }

  record(key: ComboKey, obs: ComboObservation): ComboEvidence {
    const k = comboKeyOf(key);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = {
        key: k,
        symbol: key.symbol,
        contract: key.contract,
        regime: key.regime || UNKNOWN_REGIME,
        entryCondition: key.entryCondition || IMMEDIATE_CONDITION,
        obs: [],
      };
      this.buckets.set(k, bucket);
    }
    bucket.obs.push(obs);
    bucket.obs.sort((a, b) => a.at - b.at);
    if (bucket.obs.length > OBS_CAP) bucket.obs.splice(0, bucket.obs.length - OBS_CAP);
    this.dirtyKeys.add(k);
    this.persistCache();
    this.emit();
    return this.evaluate(bucket);
  }

  // ── measurement ─────────────────────────────────────────────────────
  private weight(at: number, now: number): number {
    const age = Math.max(0, now - at);
    return Math.pow(0.5, age / this.halfLifeMs);
  }

  private evaluate(bucket: Bucket, now = Date.now()): ComboEvidence {
    const obs = bucket.obs;
    const n = obs.length;
    const wins = obs.filter((o) => o.win).length;
    const losses = n - wins;

    let weightedN = 0;
    let weightedWins = 0;
    let weightedPnl = 0;
    let netPnl = 0;
    let peak = 0;
    let equity = 0;
    let maxDrawdown = 0;
    let streak = 0;
    let longestLosing = 0;
    let currentLosing = 0;

    for (const o of obs) {
      const w = this.weight(o.at, now);
      weightedN += w;
      if (o.win) weightedWins += w;
      weightedPnl += o.pnlPerUnit * w;
      netPnl += o.pnlPerUnit;
      equity += o.pnlPerUnit;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
      if (o.win) {
        streak = streak >= 0 ? streak + 1 : 1;
        currentLosing = 0;
      } else {
        streak = streak <= 0 ? streak - 1 : -1;
        currentLosing += 1;
        longestLosing = Math.max(longestLosing, currentLosing);
      }
    }

    const weightedWinRate = weightedN > 0 ? weightedWins / weightedN : -1;
    const winRate = n > 0 ? wins / n : -1;
    const lower = weightedN > 0 ? wilsonLower(weightedWins, weightedN) : 0;
    const weightedExpectancy = weightedN > 0 ? weightedPnl / weightedN : 0;
    const expectancy = n > 0 ? netPnl / n : 0;

    // Deterioration: the most recent slice, weighted, against the whole record.
    const recent = obs.slice(-RECENT_SLICE);
    let rN = 0;
    let rW = 0;
    for (const o of recent) {
      const w = this.weight(o.at, now);
      rN += w;
      if (o.win) rW += w;
    }
    const recentRate = rN > 0 ? rW / rN : -1;
    const deteriorationPp =
      recentRate >= 0 && weightedWinRate >= 0 && recent.length >= 8
        ? Math.round((recentRate - weightedWinRate) * 1000) / 10
        : 0;

    const confidence = Math.round(
      Math.max(0, Math.min(100, Math.min(1, weightedN / 60) * 70 + Math.min(1, n / 120) * 30)),
    );

    const state = this.stateFor(weightedN, lower, weightedExpectancy, deteriorationPp, n);
    const rankingDelta = this.deltaFor(state, weightedExpectancy, confidence);

    const note = n
      ? `${bucket.symbol} · ${bucket.contract} · regime ${bucket.regime} · entry ${bucket.entryCondition}: ${(weightedWinRate * 100).toFixed(1)}% weighted (N=${n} raw, weighted N=${weightedN.toFixed(1)}), 95% LB ${(lower * 100).toFixed(1)}%, expectancy ${weightedExpectancy.toFixed(3)}/unit, drift ${deteriorationPp >= 0 ? "+" : ""}${deteriorationPp.toFixed(1)}pp — ${state}.`
      : `No resolved entries yet for ${bucket.symbol} · ${bucket.contract} · regime ${bucket.regime} · entry ${bucket.entryCondition}. This combination is UNTESTED and carries no authority.`;

    return {
      key: bucket.key,
      symbol: bucket.symbol,
      contract: bucket.contract,
      regime: bucket.regime,
      entryCondition: bucket.entryCondition,
      n,
      wins,
      losses,
      weightedN: Math.round(weightedN * 100) / 100,
      weightedWinRate,
      winRate,
      lower,
      weightedExpectancy,
      expectancy,
      netPnl: Math.round(netPnl * 1000) / 1000,
      maxDrawdown: Math.round(maxDrawdown * 1000) / 1000,
      deteriorationPp,
      currentStreak: streak,
      longestLosingStreak: longestLosing,
      lastOutcomeAt: n ? obs[n - 1].at : null,
      state,
      confidence,
      rankingDelta,
      note,
    };
  }

  private stateFor(
    weightedN: number,
    lower: number,
    expectancy: number,
    deteriorationPp: number,
    n: number,
  ): ComboState {
    if (n === 0) return "UNTESTED";
    if (weightedN < 12) return "TESTING";
    if (expectancy <= -0.08 || lower < 0.35) return "FAILING";
    if (deteriorationPp <= -12) return "DETERIORATING";
    if (weightedN >= 40 && expectancy > 0.02 && lower >= 0.5) return "VALIDATED";
    if (expectancy > 0) return "PROMISING";
    return "TESTING";
  }

  private deltaFor(state: ComboState, expectancy: number, confidence: number): number {
    const authority = confidence / 100;
    const base =
      state === "VALIDATED"
        ? 7
        : state === "PROMISING"
          ? 3
          : state === "DETERIORATING"
            ? -6
            : state === "FAILING"
              ? -12
              : 0;
    const shaped = base * (state === "FAILING" ? 1 : authority);
    const expShift = Math.max(-4, Math.min(4, expectancy * 20 * authority));
    return Math.round((shaped + expShift) * 10) / 10;
  }

  // ── reads ───────────────────────────────────────────────────────────
  lookup(key: ComboKey): ComboLookup {
    const normalised: ComboKey = {
      symbol: key.symbol,
      contract: key.contract,
      regime: key.regime || UNKNOWN_REGIME,
      entryCondition: key.entryCondition || IMMEDIATE_CONDITION,
    };
    const k = comboKeyOf(normalised);
    const bucket = this.buckets.get(k) ?? ({ key: k, ...normalised, obs: [] } satisfies Bucket);
    const exact = this.evaluate(bucket);

    const siblings: ComboEvidence[] = [];
    const regimeSiblings: ComboEvidence[] = [];
    for (const b of this.buckets.values()) {
      if (b.symbol !== normalised.symbol || b.contract !== normalised.contract) continue;
      const ev = this.evaluate(b);
      if (b.regime === normalised.regime) siblings.push(ev);
      else regimeSiblings.push(ev);
    }
    siblings.sort(
      (a, b) => b.weightedExpectancy - a.weightedExpectancy || b.weightedN - a.weightedN,
    );
    const bestEntryCondition =
      siblings.find((s) => s.weightedN >= 12 && s.weightedExpectancy > 0) ?? null;

    return { exact, bestEntryCondition, siblings, regimeSiblings };
  }

  all(): ComboEvidence[] {
    return [...this.buckets.values()]
      .map((b) => this.evaluate(b))
      .sort((a, b) => b.weightedN - a.weightedN);
  }

  forMarket(symbol: string): ComboEvidence[] {
    return this.all().filter((e) => e.symbol === symbol);
  }

  size(): number {
    return this.buckets.size;
  }

  // ── persistence ─────────────────────────────────────────────────────
  serialise(): ComboSerialised {
    return {
      version: STORE_VERSION,
      halfLifeMs: this.halfLifeMs,
      entries: [...this.buckets.values()].map((b) => ({
        key: b.key,
        symbol: b.symbol,
        contract: b.contract,
        regime: b.regime,
        entryCondition: b.entryCondition,
        obs: b.obs,
      })),
    };
  }

  /**
   * Merge a serialised payload. Merging is by observation timestamp so a
   * restore can never double-count evidence, and a foreign market's rows are
   * accepted only under their own key — markets stay isolated.
   */
  hydrate(payload: ComboSerialised | null | undefined): number {
    if (!payload || payload.version > STORE_VERSION) return 0;
    if (Number.isFinite(payload.halfLifeMs) && payload.halfLifeMs > 0) {
      this.halfLifeMs = payload.halfLifeMs;
    }
    let added = 0;
    for (const e of payload.entries ?? []) {
      if (!e?.symbol || !e?.contract) continue;
      const k = comboKeyOf(e);
      let bucket = this.buckets.get(k);
      if (!bucket) {
        bucket = {
          key: k,
          symbol: e.symbol,
          contract: e.contract,
          regime: e.regime || UNKNOWN_REGIME,
          entryCondition: e.entryCondition || IMMEDIATE_CONDITION,
          obs: [],
        };
        this.buckets.set(k, bucket);
      }
      const seen = new Set(bucket.obs.map((o) => `${o.at}:${o.win ? 1 : 0}`));
      for (const o of e.obs ?? []) {
        if (!o || !Number.isFinite(o.at)) continue;
        const sig = `${o.at}:${o.win ? 1 : 0}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        bucket.obs.push({ at: o.at, win: !!o.win, pnlPerUnit: Number(o.pnlPerUnit) || 0 });
        added += 1;
      }
      bucket.obs.sort((a, b) => a.at - b.at);
      if (bucket.obs.length > OBS_CAP) bucket.obs.splice(0, bucket.obs.length - OBS_CAP);
    }
    this.loaded = true;
    this.persistCache();
    this.emit();
    return added;
  }

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Local cache so a reload never starts from zero, even signed out. */
  loadCache() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = safeStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = safeJsonParse<ComboSerialised | null>(raw, null);
        if (parsed) this.hydrate(parsed);
      }
    } catch {
      /* corrupt cache is discarded, never fatal */
    }
  }

  private persistCache() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        safeStorage.setItem(CACHE_KEY, JSON.stringify(this.serialise()));
      } catch {
        /* quota — durable copy lives in the cloud layer */
      }
    }, 2000);
  }

  reset() {
    this.buckets.clear();
    this.dirtyKeys.clear();
    safeStorage.removeItem(CACHE_KEY);
    this.emit();
  }
}

export const comboLearning = new CombinationLearning();

/** Convenience read used by the scanner. */
export function lookupCombination(
  symbol: string,
  contract: string,
  regime: string | undefined,
  entryCondition: string | undefined,
): ComboLookup {
  return comboLearning.lookup({
    symbol,
    contract,
    regime: regime || UNKNOWN_REGIME,
    entryCondition: entryCondition || IMMEDIATE_CONDITION,
  });
}
