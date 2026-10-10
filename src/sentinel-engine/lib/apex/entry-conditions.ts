// APEX SENTINEL — ENTRY CONDITION DISCOVERY (contract-resolved, per market).
//
// Sentinel must discover HOW to enter, not only WHICH contract looks best.
// This module runs an independent shadow simulator for every
// market × contract × entry rule combination:
//
//   • a rule may only look at information that existed at the trigger tick,
//   • a triggered entry freezes its context and is never rewritten,
//   • resolution happens on the ACTUAL expiry digit under the real contract
//     rule — never on a "winning digit / losing digit" tick bucket,
//   • rules are ranked by contract-resolved expectancy with sample-size,
//     interval, out-of-sample and recency evidence — never by raw win rate.
//
// Nothing here fabricates a trade: when a rule does not trigger, nothing is
// recorded.
import type { ApexContractId, ContractEval, MarketIntel } from "./types";

export type EntryRuleId =
  | "IMMEDIATE"
  | "LOSING_ABSENT_3"
  | "CONSEC_WINNERS_4"
  | "WINNERS_7_OF_10"
  | "PRESSURE_CONFIRM"
  | "PRESSURE_PLUS_DIGIT"
  | "LOSING_EXHAUSTION"
  | "WINNING_ACCELERATION"
  | "RED_SAFETY"
  | "SEQUENCE_VALIDATED"
  | "HYBRID";

/** Evidence level of an entry rule for one market/contract. */
export type EntryConditionState =
  | "UNTESTED"
  | "TESTING"
  | "WEAK"
  | "PROMISING"
  | "VALIDATED"
  | "STRONG"
  | "DEGRADING"
  | "INVALIDATED";

/** Everything a trigger may legally see at the entry tick. */
export interface EntryContext {
  /** Chronological tail of observed digits, newest last. */
  digits: number[];
  winners: number[];
  losers: number[];
  /** Recent-minus-base share of the winning side, in percentage points. */
  winningPressure: number;
  losingPressure: number;
  asymmetry: number;
  /** Losing-side group threat, 0..100. */
  losingThreat: number;
  mostIncreasing: number | null;
  /** A Red / Light-Red (suppressed) sensitive digit sits on the losing side. */
  redOnLosingSide: boolean;
  regime: string;
  opportunity: number;
  danger: number;
  freshness: number;
  stability: number;
  quality: number;
  edge: number;
  lastDigit: number;
}

export interface EntryRule {
  id: EntryRuleId;
  label: string;
  family: "immediate" | "wait" | "pressure" | "structure" | "hybrid";
  description: string;
  /** Pure, causal trigger: it may only read the supplied context. */
  test: (ctx: EntryContext) => { ok: boolean; trigger: string };
}

const tail = (a: number[], n: number) => (a.length > n ? a.slice(a.length - n) : a.slice());
const isWin = (d: number, w: number[]) => w.includes(d);

export const ENTRY_RULES: EntryRule[] = [
  {
    id: "IMMEDIATE",
    label: "Immediate entry",
    family: "immediate",
    description:
      "Enter on the current tick as soon as the contract qualifies. The control condition every other rule must beat.",
    test: () => ({ ok: true, trigger: "qualified on this tick" }),
  },
  {
    id: "LOSING_ABSENT_3",
    label: "Losing side absent 3 ticks",
    family: "wait",
    description: "Wait until no losing digit has printed for 3 consecutive ticks.",
    test: (c) => {
      const t = tail(c.digits, 3);
      const ok = t.length === 3 && t.every((d) => isWin(d, c.winners));
      return { ok, trigger: `last 3 digits ${t.join("-")}` };
    },
  },
  {
    id: "CONSEC_WINNERS_4",
    label: "4 consecutive qualifying ticks",
    family: "wait",
    description: "Wait for 4 consecutive ticks that would have settled the contract as a win.",
    test: (c) => {
      const t = tail(c.digits, 4);
      const ok = t.length === 4 && t.every((d) => isWin(d, c.winners));
      return { ok, trigger: `last 4 digits ${t.join("-")}` };
    },
  },
  {
    id: "WINNERS_7_OF_10",
    label: "7 of last 10 in the winning range",
    family: "wait",
    description:
      "Wait until at least 7 of the last 10 digits fall inside the contract's winning range.",
    test: (c) => {
      const t = tail(c.digits, 10);
      const n = t.filter((d) => isWin(d, c.winners)).length;
      return { ok: t.length === 10 && n >= 7, trigger: `${n}/10 in range` };
    },
  },
  {
    id: "PRESSURE_CONFIRM",
    label: "Pressure confirmation",
    family: "pressure",
    description: "Enter only while winning-side pressure genuinely exceeds losing-side pressure.",
    test: (c) => ({
      ok: c.asymmetry >= 2,
      trigger: `asymmetry ${c.asymmetry.toFixed(1)}pp`,
    }),
  },
  {
    id: "PRESSURE_PLUS_DIGIT",
    label: "Pressure + digit confirmation",
    family: "pressure",
    description:
      "Pressure asymmetry positive AND the current digit already sits in the winning range.",
    test: (c) => ({
      ok: c.asymmetry >= 2 && isWin(c.lastDigit, c.winners),
      trigger: `asymmetry ${c.asymmetry.toFixed(1)}pp, digit ${c.lastDigit}`,
    }),
  },
  {
    id: "LOSING_EXHAUSTION",
    label: "Losing-side exhaustion",
    family: "pressure",
    description: "Losing-side share is contracting and no losing digit has printed for 5 ticks.",
    test: (c) => {
      const t = tail(c.digits, 5);
      const quiet = t.length === 5 && t.every((d) => isWin(d, c.winners));
      return {
        ok: quiet && c.losingPressure <= -1,
        trigger: `losing pressure ${c.losingPressure.toFixed(1)}pp, 5 quiet ticks`,
      };
    },
  },
  {
    id: "WINNING_ACCELERATION",
    label: "Winning-side acceleration",
    family: "pressure",
    description:
      "The most increasing digit belongs to the winning range while asymmetry is positive.",
    test: (c) => ({
      ok: c.mostIncreasing !== null && isWin(c.mostIncreasing, c.winners) && c.asymmetry > 0,
      trigger: `most increasing digit ${c.mostIncreasing ?? "—"}`,
    }),
  },
  {
    id: "RED_SAFETY",
    label: "Red / Light-Red structural safety",
    family: "structure",
    description:
      "Refuse entry while a suppressed Red / Light-Red digit sits on the losing side or losing threat is elevated.",
    test: (c) => ({
      ok: !c.redOnLosingSide && c.losingThreat < 45,
      trigger: `losing threat ${c.losingThreat.toFixed(0)}, no suppressed losing-side structure`,
    }),
  },
  {
    id: "SEQUENCE_VALIDATED",
    label: "Validated winning sequence",
    family: "structure",
    description:
      "A run of at least 3 winning-range digits with no repeated losing digit in the last 8 ticks.",
    test: (c) => {
      const t = tail(c.digits, 8);
      let run = 0;
      for (let i = c.digits.length - 1; i >= 0 && isWin(c.digits[i], c.winners); i--) run++;
      const losing = t.filter((d) => !isWin(d, c.winners));
      const repeated = new Set(losing).size < losing.length;
      return {
        ok: run >= 3 && !repeated,
        trigger: `run ${run}, ${losing.length} losing prints in 8`,
      };
    },
  },
  {
    id: "HYBRID",
    label: "Hybrid: pressure + structure + confirmation",
    family: "hybrid",
    description:
      "Positive asymmetry, contained losing-side threat, no suppressed losing-side structure and two confirming ticks.",
    test: (c) => {
      const t = tail(c.digits, 2);
      const confirm = t.length === 2 && t.every((d) => isWin(d, c.winners));
      const ok = confirm && c.asymmetry >= 1.5 && !c.redOnLosingSide && c.losingThreat < 50;
      return {
        ok,
        trigger: `asymmetry ${c.asymmetry.toFixed(1)}pp, threat ${c.losingThreat.toFixed(0)}, 2 confirming ticks`,
      };
    },
  },
];

export const ENTRY_RULE_BY_ID: Record<EntryRuleId, EntryRule> = Object.fromEntries(
  ENTRY_RULES.map((r) => [r.id, r]),
) as Record<EntryRuleId, EntryRule>;

export interface EntryTrade {
  id: string;
  symbol: string;
  market: string;
  contract: ApexContractId;
  contractLabel: string;
  rule: EntryRuleId;
  trigger: string;
  openedAt: number;
  resolvedAt: number | null;
  winners: number[];
  entryDigit: number;
  durationTicks: number;
  ticksElapsed: number;
  expiryDigit: number | null;
  result: "OPEN" | "WIN" | "LOSS";
  stake: number;
  payout: number;
  pnl: number;
  /** Frozen evidence at the entry tick. */
  context: {
    opportunity: number;
    edge: number;
    quality: number;
    stability: number;
    danger: number;
    freshness: number;
    regime: string;
    winningPressure: number;
    losingPressure: number;
    losingThreat: number;
    redOnLosingSide: boolean;
    mostIncreasing: number | null;
  };
}

export interface EntryConditionStats {
  symbol: string;
  contract: ApexContractId;
  contractLabel: string;
  rule: EntryRuleId;
  label: string;
  description: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  theoretical: number;
  /** Wilson 95% lower bound on the observed contract win rate. */
  lower: number;
  /** Payout-adjusted P/L per unit staked. */
  expectancy: number;
  netPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  longestLosingStreak: number;
  /** Win rate over the most recent 40 resolutions (−1 = unavailable). */
  recentWinRate: number;
  recentExpectancy: number;
  /** Chronological hold-out: the last 40% of resolutions. */
  oosN: number;
  oosWinRate: number;
  oosExpectancy: number;
  /** Standard deviation of P/L per trade — lower is steadier. */
  volatility: number;
  regimeBuckets: { key: string; n: number; winRate: number; expectancy: number }[];
  state: EntryConditionState;
  /** Composite ranking score used to choose between rules (not a win rate). */
  score: number;
  note: string;
}

export interface EntryRecommendation {
  best: EntryConditionStats | null;
  runnerUp: EntryConditionStats | null;
  all: EntryConditionStats[];
  /** Is the winning rule's trigger firing on the current tick? */
  activeNow: boolean;
  currentTrigger: string;
  /** Ranking influence this evidence is allowed, in score points. */
  rankingDelta: number;
  note: string;
}

const LEDGER_CAP = 4000;
const CONTEXT_TAIL = 40;

function wilsonLower(w: number, n: number): number {
  if (!n) return 0;
  const z = 1.96;
  const p = w / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

function expectancyOf(trades: EntryTrade[]): number {
  if (!trades.length) return 0;
  const stake = trades.reduce((a, t) => a + t.stake, 0);
  if (!stake) return 0;
  return trades.reduce((a, t) => a + t.pnl, 0) / stake;
}

function classify(s: Omit<EntryConditionStats, "state" | "score" | "note">): EntryConditionState {
  if (!s.n) return "UNTESTED";
  if (s.n < 25) return "TESTING";
  const beatsBaseline = s.lower > s.theoretical;
  const positive = s.expectancy > 0;
  const deteriorating = s.recentWinRate >= 0 && s.recentWinRate < s.winRate - 0.08;
  if (s.n >= 60 && !positive && s.winRate < s.theoretical - 0.03) return "INVALIDATED";
  if (s.n >= 60 && positive && deteriorating) return "DEGRADING";
  if (s.n >= 250 && beatsBaseline && positive && s.oosExpectancy > 0) return "STRONG";
  if (s.n >= 120 && beatsBaseline && positive) return "VALIDATED";
  if (positive && s.winRate >= s.theoretical) return "PROMISING";
  return "WEAK";
}

/**
 * Composite ranking of an entry rule. Expectancy is the base, but authority is
 * bought with sample size, interval evidence, out-of-sample agreement,
 * recency and drawdown — so 92% over 12 trades cannot outrank 75% over 800.
 */
function scoreOf(s: Omit<EntryConditionStats, "state" | "score" | "note">): number {
  if (!s.n) return 0;
  const confidence = Math.min(1, Math.log10(1 + s.n) / Math.log10(301)); // 0 at N=0, 1 at N≈300
  const base = s.expectancy * 100 * confidence;
  const intervalEvidence = (s.lower - s.theoretical) * 100 * confidence;
  const oos = s.oosN >= 25 ? s.oosExpectancy * 100 * 0.6 : 0;
  const recent = s.recentWinRate >= 0 ? (s.recentWinRate - s.theoretical) * 60 : 0;
  const drawdownPenalty = Math.min(12, s.maxDrawdown * 1.5);
  const streakPenalty = Math.min(8, Math.max(0, s.longestLosingStreak - 6));
  return (
    Math.round(
      (base + intervalEvidence * 0.8 + oos + recent - drawdownPenalty - streakPenalty) * 10,
    ) / 10
  );
}

function summarise(
  key: { symbol: string; contract: ApexContractId; contractLabel: string; rule: EntryRuleId },
  trades: EntryTrade[],
  theoretical: number,
): EntryConditionStats {
  const rule = ENTRY_RULE_BY_ID[key.rule];
  const closed = trades.filter((t) => t.result !== "OPEN");
  const n = closed.length;
  const wins = closed.filter((t) => t.result === "WIN").length;
  const losses = n - wins;
  const netPnl = closed.reduce((a, t) => a + t.pnl, 0);
  const gross = closed.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const loss = Math.abs(closed.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let streak = 0;
  let longestLosingStreak = 0;
  for (const t of closed) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (t.result === "LOSS") {
      streak++;
      longestLosingStreak = Math.max(longestLosingStreak, streak);
    } else streak = 0;
  }

  const recent = closed.slice(-40);
  const split = Math.floor(n * 0.6);
  const oos = closed.slice(split);
  const mean = n ? netPnl / n : 0;
  const variance = n ? closed.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / n : 0;

  const regimeMap = new Map<string, EntryTrade[]>();
  for (const t of closed) {
    const arr = regimeMap.get(t.context.regime) ?? [];
    arr.push(t);
    regimeMap.set(t.context.regime, arr);
  }

  const partial = {
    symbol: key.symbol,
    contract: key.contract,
    contractLabel: key.contractLabel,
    rule: key.rule,
    label: rule.label,
    description: rule.description,
    n,
    wins,
    losses,
    winRate: n ? wins / n : 0,
    theoretical,
    lower: wilsonLower(wins, n),
    expectancy: expectancyOf(closed),
    netPnl,
    profitFactor: loss > 0 ? gross / loss : gross > 0 ? Number.POSITIVE_INFINITY : 0,
    maxDrawdown,
    longestLosingStreak,
    recentWinRate:
      recent.length >= 15 ? recent.filter((t) => t.result === "WIN").length / recent.length : -1,
    recentExpectancy: recent.length >= 15 ? expectancyOf(recent) : 0,
    oosN: oos.length,
    oosWinRate: oos.length ? oos.filter((t) => t.result === "WIN").length / oos.length : 0,
    oosExpectancy: oos.length ? expectancyOf(oos) : 0,
    volatility: Math.sqrt(variance),
    regimeBuckets: [...regimeMap.entries()]
      .map(([k, v]) => ({
        key: k,
        n: v.length,
        winRate: v.filter((t) => t.result === "WIN").length / v.length,
        expectancy: expectancyOf(v),
      }))
      .sort((a, b) => b.n - a.n),
  };

  const state = classify(partial);
  const score = scoreOf(partial);
  const note = !n
    ? "No triggered entries yet — untested."
    : n < 25
      ? `TESTING — only ${n} contract resolutions; carries no ranking authority.`
      : `${(partial.winRate * 100).toFixed(1)}% over N=${n} (baseline ${(theoretical * 100).toFixed(0)}%), expectancy ${(partial.expectancy * 100).toFixed(1)}% per stake, OOS ${(partial.oosExpectancy * 100).toFixed(1)}% over ${partial.oosN}.`;

  return { ...partial, state, score, note };
}

export interface EntryLabConfig {
  durationTicks: number;
  stake: number;
  houseMargin: number;
  /** Resolutions before a rule may influence ranking at all. */
  minAuthorityN: number;
  /** Maximum ranking points entry evidence may add or remove. */
  maxRankingDelta: number;
}

export const DEFAULT_ENTRY_CONFIG: EntryLabConfig = {
  durationTicks: 1,
  stake: 1,
  houseMargin: 0.05,
  minAuthorityN: 60,
  maxRankingDelta: 7,
};

/**
 * The discovery engine itself. One ledger, strictly partitioned by
 * symbol → contract → rule. Nothing is ever read across markets.
 */
export class EntryLab {
  private config: EntryLabConfig = { ...DEFAULT_ENTRY_CONFIG };
  private ledger: EntryTrade[] = [];
  private open = new Map<string, EntryTrade>(); // `${symbol}:${contract}:${rule}`
  private live = new Map<string, EntryContext>(); // latest context per `${symbol}:${contract}`
  private seq = 0;
  private listeners = new Set<() => void>();

  /** Bumped on every ledger/context/config mutation; all caches key off it. */
  private ledgerVersion = 0;
  private statsCache = new Map<string, { version: number; value: EntryConditionStats[] }>();
  private recommendCache = new Map<string, { version: number; value: EntryRecommendation }>();
  private cacheHits = 0;
  private cacheMisses = 0;

  getConfig() {
    return this.config;
  }

  /** Monotonic version of the shadow ledger; caches invalidate when it moves. */
  getLedgerVersion(): number {
    return this.ledgerVersion;
  }

  cacheStats() {
    return {
      version: this.ledgerVersion,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      statsEntries: this.statsCache.size,
      recommendEntries: this.recommendCache.size,
    };
  }

  private bumpVersion() {
    this.ledgerVersion++;
    if (this.statsCache.size > 512) this.statsCache.clear();
    if (this.recommendCache.size > 512) this.recommendCache.clear();
  }

  /** The catalogue of discoverable entry formulas under test. */
  rules(): EntryRule[] {
    return ENTRY_RULES;
  }

  setConfig(patch: Partial<EntryLabConfig>) {
    this.config = { ...this.config, ...patch };
    this.bumpVersion();
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private payoutFor(theoretical: number): number {
    if (theoretical <= 0) return 0;
    return Math.max(0, (1 / theoretical) * (1 - this.config.houseMargin) - 1);
  }

  /**
   * Resolve open shadow entries on an observed tick. Only entries opened
   * strictly before this tick can be settled by it — the sole reason this
   * ledger is free of look-ahead.
   */
  onTick(symbol: string, digit: number, at: number) {
    let changed = false;
    for (const [key, trade] of this.open) {
      if (trade.symbol !== symbol) continue;
      trade.ticksElapsed++;
      if (trade.ticksElapsed < trade.durationTicks) continue;
      trade.expiryDigit = digit;
      const won = trade.winners.includes(digit);
      trade.result = won ? "WIN" : "LOSS";
      trade.pnl = won ? trade.stake * trade.payout : -trade.stake;
      trade.resolvedAt = at;
      this.open.delete(key);
      changed = true;
    }
    if (changed) {
      this.bumpVersion();
      this.emit();
    }
  }

  /** Build the causal context for one contract from the current market state. */
  buildContext(intel: MarketIntel, c: ContractEval, digits: number[]): EntryContext {
    const pressure = intel.pressure?.pressure ?? new Array(10).fill(0);
    const losers: number[] = [];
    for (let d = 0; d <= 9; d++) if (!c.winners.includes(d)) losers.push(d);
    const winningPressure = c.winners.reduce((a, d) => a + (pressure[d] ?? 0), 0) * 100;
    const losingPressure = losers.reduce((a, d) => a + (pressure[d] ?? 0), 0) * 100;
    return {
      digits: tail(digits, CONTEXT_TAIL),
      winners: [...c.winners],
      losers,
      winningPressure,
      losingPressure,
      asymmetry: winningPressure - losingPressure,
      losingThreat: c.threat?.groupThreat ?? 0,
      mostIncreasing: intel.digitIntel?.increasing[0] ?? null,
      redOnLosingSide: Boolean(c.critical && c.critical.conflicts.length > 0),
      regime: intel.regime?.label ?? "UNKNOWN",
      opportunity: c.opportunity,
      danger: c.danger,
      freshness: c.freshness,
      stability: c.stability,
      quality: c.quality,
      edge: c.compositeEdge,
      lastDigit: intel.stats?.lastDigit ?? -1,
    };
  }

  /**
   * Offer the current state of a market to every entry rule. Runs continuously
   * for every market — not only for the current #1 candidate.
   */
  consider(intel: MarketIntel, digits: number[], contracts?: ContractEval[]) {
    if (intel.dataState !== "OK") return;
    const list = contracts ?? intel.contracts;
    for (const c of list) {
      const ctx = this.buildContext(intel, c, digits);
      if (ctx.lastDigit < 0) continue;
      this.live.set(`${intel.symbol}:${c.id}`, ctx);
      for (const rule of ENTRY_RULES) {
        const key = `${intel.symbol}:${c.id}:${rule.id}`;
        if (this.open.has(key)) continue;
        const { ok, trigger } = rule.test(ctx);
        if (!ok) continue;
        const trade: EntryTrade = {
          id: `${key}-${++this.seq}`,
          symbol: intel.symbol,
          market: intel.name,
          contract: c.id,
          contractLabel: c.label,
          rule: rule.id,
          trigger,
          openedAt: intel.lastTickAt || Date.now(),
          resolvedAt: null,
          winners: [...c.winners],
          entryDigit: ctx.lastDigit,
          durationTicks: this.config.durationTicks,
          ticksElapsed: 0,
          expiryDigit: null,
          result: "OPEN",
          stake: this.config.stake,
          payout: this.payoutFor(c.theoretical),
          pnl: 0,
          context: {
            opportunity: Math.round(c.opportunity),
            edge: Math.round(c.compositeEdge * 10) / 10,
            quality: Math.round(c.quality),
            stability: Math.round(c.stability),
            danger: Math.round(c.danger),
            freshness: Math.round(c.freshness),
            regime: ctx.regime,
            winningPressure: Math.round(ctx.winningPressure * 10) / 10,
            losingPressure: Math.round(ctx.losingPressure * 10) / 10,
            losingThreat: Math.round(ctx.losingThreat),
            redOnLosingSide: ctx.redOnLosingSide,
            mostIncreasing: ctx.mostIncreasing,
          },
        };
        this.open.set(key, trade);
        this.ledger.push(trade);
      }
    }
    if (this.ledger.length > LEDGER_CAP) this.ledger.splice(0, this.ledger.length - LEDGER_CAP);
    this.bumpVersion();
  }

  /** Every tested entry rule for ONE market/contract, strongest evidence first. */
  statsFor(symbol: string, contract: ApexContractId, theoretical: number): EntryConditionStats[] {
    const key = `${symbol}:${contract}:${theoretical}`;
    const hit = this.statsCache.get(key);
    if (hit && hit.version === this.ledgerVersion) {
      this.cacheHits++;
      return hit.value;
    }
    this.cacheMisses++;
    const scoped = this.ledger.filter((t) => t.symbol === symbol && t.contract === contract);
    const label = scoped[0]?.contractLabel ?? contract;
    const value = ENTRY_RULES.map((r) =>
      summarise(
        { symbol, contract, contractLabel: label, rule: r.id },
        scoped.filter((t) => t.rule === r.id),
        theoretical,
      ),
    ).sort((a, b) => b.score - a.score || b.n - a.n);
    this.statsCache.set(key, { version: this.ledgerVersion, value });
    return value;
  }

  /**
   * The discovered entry condition for a market/contract, plus whether its
   * trigger is firing right now and how much it may move the ranking.
   */
  recommend(symbol: string, contract: ApexContractId, theoretical: number): EntryRecommendation {
    const cacheKey = `${symbol}:${contract}:${theoretical}`;
    const cached = this.recommendCache.get(cacheKey);
    if (cached && cached.version === this.ledgerVersion) {
      this.cacheHits++;
      return cached.value;
    }
    this.cacheMisses++;
    const all = this.statsFor(symbol, contract, theoretical);
    const cfg = this.config;
    const eligible = all.filter(
      (s) => s.n >= cfg.minAuthorityN && s.state !== "INVALIDATED" && s.expectancy > 0,
    );
    const best = eligible[0] ?? null;
    const runnerUp = eligible[1] ?? null;
    const ctx = this.live.get(`${symbol}:${contract}`);
    const fired = best && ctx ? ENTRY_RULE_BY_ID[best.rule].test(ctx) : null;

    let rankingDelta = 0;
    if (best) {
      const authority =
        best.state === "STRONG"
          ? 1
          : best.state === "VALIDATED"
            ? 0.7
            : best.state === "PROMISING"
              ? 0.3
              : 0.1;
      rankingDelta = Math.max(
        -cfg.maxRankingDelta,
        Math.min(cfg.maxRankingDelta, best.expectancy * 100 * authority),
      );
      // An entry rule that is not currently triggering is evidence about how to
      // enter, not permission to enter now.
      if (!fired?.ok) rankingDelta = Math.min(rankingDelta, 0) - 1.5;
    }
    // A comprehensively invalidated rule set is itself a warning.
    const invalidated = all.filter((s) => s.state === "INVALIDATED").length;
    if (!best && invalidated >= 3) rankingDelta = -3;

    const value: EntryRecommendation = {
      best,
      runnerUp,
      all,
      activeNow: Boolean(fired?.ok),
      currentTrigger:
        fired?.trigger ?? (ctx ? "condition not met on the current tick" : "no live context"),
      rankingDelta: Math.round(rankingDelta * 10) / 10,
      note: best
        ? `${best.label} — ${best.state}. ${best.note}`
        : all.some((s) => s.n > 0)
          ? `No entry condition has yet earned authority (needs N≥${cfg.minAuthorityN} with positive contract-resolved expectancy).`
          : "Entry conditions untested on this market/contract.",
    };
    this.recommendCache.set(cacheKey, { version: this.ledgerVersion, value });
    return value;
  }

  /** Chronological shadow ledger for one market, newest first. */
  ledgerFor(symbol: string, limit = 80): EntryTrade[] {
    return this.ledger
      .filter((t) => t.symbol === symbol)
      .slice(-limit)
      .reverse();
  }

  totals() {
    const closed = this.ledger.filter((t) => t.result !== "OPEN");
    return {
      tested: this.ledger.length,
      resolved: closed.length,
      open: this.open.size,
      markets: new Set(this.ledger.map((t) => t.symbol)).size,
      rules: ENTRY_RULES.length,
    };
  }

  reset() {
    this.ledger = [];
    this.open.clear();
    this.live.clear();
    this.statsCache.clear();
    this.recommendCache.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.bumpVersion();
    this.emit();
  }
}

export const entryLab = new EntryLab();
