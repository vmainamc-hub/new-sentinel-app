// APEX SENTINEL — USER-TRADE FEEDBACK & PERSISTENT LEARNING (additive layer).
//
// CORE PRINCIPLE: A SIGNAL SHOWN IS NOT A TRADE TAKEN.
// Nothing in this module observes, scores or filters signals. It only records
// what the operator EXPLICITLY marked as traded, freezes the decision context
// at that instant (no look-ahead: the snapshot is never rewritten after an
// outcome), and aggregates confirmed outcomes into market/contract-isolated
// learning that survives reloads.
import type { RankedOpportunity } from "../apex/types";
import {
  clearGuidance,
  recordFeedbackDirective,
  recordOutcomeDirective,
  removeDirectivesBySource,
} from "./immediate-guidance";
import { observationEngine, resolveExactProposition } from "./observation/observationEngine";
import { safeStorage, safeJsonParse } from "@/lib/storage-fallback";

const KEY = "sentinel.trade-feedback.v1";
const MAX_TRADES = 1000;
const MAX_OBSERVATIONS = 1000;

/** Optional, never required. Free text always remains available. */
export const FEEDBACK_CATEGORIES = [
  "ENTRY QUALITY",
  "ENTRY TOO LATE",
  "ENTRY DIGIT",
  "PRESSURE REVERSAL",
  "DANGER",
  "MARKET ROTATION",
  "SIGNAL STABILITY",
  "ENGINE AGREEMENT",
  "STRONG SIGNAL",
  "WEAK SIGNAL",
  "SIMULATOR",
  "OTHER",
] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Written operator note attached to a confirmed/marked trade. */
export interface TradeFeedbackNote {
  tradeId: string;
  ts: number;
  updatedAt: number | null;
  text: string;
  category: FeedbackCategory | null;
}

/** Written note about a signal the operator did NOT trade. Never an outcome. */
export interface SignalObservation {
  observationId: string;
  ts: number;
  updatedAt: number | null;
  text: string;
  category: FeedbackCategory | null;
  snapshot: TradeSnapshot;
}

export type TradeOutcome = "PENDING" | "WIN" | "LOSS" | "CANCELLED";

/** Frozen decision context captured at the moment the user marks a trade. */
export interface TradeSnapshot {
  symbol: string;
  name: string;
  contract: string;
  contractLabel: string;
  entryDigit: number | null;
  entryConfidence: number;
  entryMargin: number;
  runnerUpDigit: number | null;
  signalState: string;
  signalLabel: string;
  score: number;
  absoluteEdge: number;
  relativeEdge: string;
  danger: number;
  agreement: string;
  persistence: number;
  stability: number;
  evidence: string;
  simulatorSupport: string;
  entryCondition: string;
  validityWindow: string;
  setupGrade: string;
  setupScore: number;
  losingSidePressureState?: string | null;
  losingSidePressureIndex?: number | null;
  regime?: string | null;
  clearanceState?: string;
  clearanceRisk?: number;
  entryClearanceVerdict?: string;
}

export interface TradeRecord {
  id: string;
  ts: number;
  outcome: TradeOutcome;
  resolvedAt: number | null;
  /** Ticks/seconds waited inside the validity window before the outcome. */
  enteredAfterMs: number | null;
  snapshot: TradeSnapshot;
  /** Displayed-signal identity at the instant of marking (optional, legacy rows lack it). */
  signalKey?: string;
  /** Optional written operator feedback. Never rewrites `snapshot`. */
  feedback?: TradeFeedbackNote | null;
}

interface Store {
  version: 2;
  trades: TradeRecord[];
  observations: SignalObservation[];
}

let store: Store | null = null;
let version = 0;
const listeners = new Set<() => void>();

/**
 * Optional durable mirror. The feedback store stays authoritative in-memory /
 * localStorage (so nothing is ever lost offline); when a sink is attached every
 * mutation is also pushed to the operator's own cloud rows. Learning rules are
 * untouched by this: the sink only copies records, it never creates them.
 */
type FeedbackSink = (trades: TradeRecord[], observations: SignalObservation[]) => void;
let sink: FeedbackSink | null = null;

export function setFeedbackSink(fn: FeedbackSink | null) {
  sink = fn;
}

function emit() {
  version++;
  listeners.forEach((l) => l());
}

/** Monotonic revision for useSyncExternalStore snapshots. */
export function feedbackVersion(): number {
  return version;
}

function blank(): Store {
  return { version: 2, trades: [], observations: [] };
}

/** Corrupted or foreign persisted data must never break the scanner. */
function load(): Store {
  if (store) return store;
  store = blank();
  try {
    const raw = safeStorage.getItem(KEY);
    if (raw) {
      const parsed = safeJsonParse<(Omit<Partial<Store>, "version"> & { version?: number }) | null>(
        raw,
        null,
      );
      // MIGRATION: v1 stores (trades only) load unchanged and gain observations.
      if (
        parsed &&
        (parsed.version === 1 || parsed.version === 2) &&
        Array.isArray(parsed.trades)
      ) {
        store = {
          version: 2,
          trades: parsed.trades.filter(
            (t): t is TradeRecord =>
              !!t &&
              typeof t.id === "string" &&
              typeof t.ts === "number" &&
              !!t.snapshot &&
              typeof t.snapshot.symbol === "string" &&
              typeof t.snapshot.contract === "string",
          ),
          observations: Array.isArray(parsed.observations)
            ? parsed.observations.filter(
                (o): o is SignalObservation =>
                  !!o &&
                  typeof o.observationId === "string" &&
                  typeof o.text === "string" &&
                  !!o.snapshot &&
                  typeof o.snapshot.symbol === "string",
              )
            : [],
        };
      }
    }
  } catch {
    store = blank();
  }
  return store;
}

function persist() {
  if (!store) return;
  if (store.trades.length > MAX_TRADES) {
    store.trades.splice(0, store.trades.length - MAX_TRADES);
  }
  if (store.observations.length > MAX_OBSERVATIONS) {
    store.observations.splice(0, store.observations.length - MAX_OBSERVATIONS);
  }
  try {
    safeStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota — in-memory learning still works for this session */
  }
  sink?.(store.trades, store.observations);
  emit();
}

/**
 * Merge rows restored from the operator's cloud store. Records are matched by
 * id; the newer revision wins. A remote record NEVER changes an outcome that
 * was already finalised locally, and a written note is never promoted into a
 * trade result.
 */
export function mergeRemoteFeedback(
  remoteTrades: TradeRecord[],
  remoteObservations: SignalObservation[],
) {
  const s = load();
  const byId = new Map(s.trades.map((t) => [t.id, t]));
  for (const rt of remoteTrades) {
    const local = byId.get(rt.id);
    if (!local) {
      s.trades.push(rt);
      continue;
    }
    const localRev = Math.max(
      local.resolvedAt ?? 0,
      local.feedback?.updatedAt ?? local.feedback?.ts ?? 0,
      local.ts,
    );
    const remoteRev = Math.max(
      rt.resolvedAt ?? 0,
      rt.feedback?.updatedAt ?? rt.feedback?.ts ?? 0,
      rt.ts,
    );
    if (remoteRev > localRev) Object.assign(local, rt);
  }
  const obsById = new Map(s.observations.map((o) => [o.observationId, o]));
  for (const ro of remoteObservations) {
    const local = obsById.get(ro.observationId);
    if (!local) {
      s.observations.push(ro);
      continue;
    }
    if ((ro.updatedAt ?? ro.ts) > (local.updatedAt ?? local.ts)) Object.assign(local, ro);
  }
  s.trades.sort((a, b) => a.ts - b.ts);
  s.observations.sort((a, b) => a.ts - b.ts);
  persist();
}

export function subscribeTradeFeedback(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function snapshotOf(item: RankedOpportunity): TradeSnapshot {
  const ep = item.entryPoint;
  const d = ep.preferred;
  const waiting = item.signal?.waitForEntry ?? !d;
  const exactContract = resolveExactProposition(item.contract.id) ?? item.contract.id;
  return {
    symbol: item.symbol,
    name: item.name,
    contract: exactContract,
    contractLabel: item.contract.label,
    entryDigit: d && !waiting ? d.digit : null,
    entryConfidence: ep.confidence,
    entryMargin: ep.entryMargin,
    runnerUpDigit: ep.runnerUpDigit,
    signalState: item.signal?.state ?? ep.status,
    signalLabel: item.signal?.label ?? ep.status,
    score: item.score,
    absoluteEdge: item.contract.edge,
    relativeEdge: item.relative?.label ?? "—",
    danger: item.contract.danger,
    agreement: item.agreement,
    persistence: item.persistence?.persistence ?? 0,
    stability: item.contract.stability,
    evidence: item.evidence?.status ?? "—",
    simulatorSupport: item.simNote || "—",
    entryCondition: item.entry?.note ?? "—",
    validityWindow: `${ep.window.label} — ${ep.window.basis}`,
    setupGrade: item.setup.grade,
    setupScore: item.setup.score,
    losingSidePressureState: item.contract.losingSidePressure?.state ?? null,
    losingSidePressureIndex: item.contract.losingSidePressure?.index ?? null,
    regime: item.intel?.regime?.label ?? null,
    clearanceState: item.clearance?.state,
    clearanceRisk: item.clearance?.risk,
    entryClearanceVerdict: item.entryClearance?.verdict,
  };
}

/** Deterministic per-signal key so the same displayed signal is marked once. */
export function signalKey(item: RankedOpportunity): string {
  const d = item.entryPoint.preferred?.digit ?? "w";
  return `${item.symbol}:${item.contract.id}:${d}:${item.signal?.state ?? item.entryPoint.status}`;
}

/**
 * A pending trade belongs to a market × contract × ENTRY DIGIT. Ignoring the
 * entry digit made a second, genuinely different setup on the same contract
 * look already-marked, so its outcome was never recorded.
 */
export function pendingFor(item: RankedOpportunity): TradeRecord | null {
  const s = load();
  const d = item.entryPoint.preferred?.digit ?? null;
  const waiting = item.signal?.waitForEntry ?? !item.entryPoint.preferred;
  const entryDigit = d !== null && !waiting ? d : null;
  return (
    s.trades.find(
      (t) =>
        t.outcome === "PENDING" &&
        t.snapshot.symbol === item.symbol &&
        t.snapshot.contract === item.contract.id &&
        t.snapshot.entryDigit === entryDigit,
    ) ?? null
  );
}

/** REFINEMENT: only an explicit user action creates a trade. */
export function markTraded(item: RankedOpportunity): TradeRecord {
  const key = signalKey(item);
  const existing = pendingFor(item);
  // Identity is market × contract × entry digit × displayed-signal key: the same
  // displayed signal is marked once, a different one is a different trade.
  if (existing && (existing.signalKey === undefined || existing.signalKey === key)) return existing;
  const s = load();
  const rec: TradeRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    outcome: "PENDING",
    resolvedAt: null,
    enteredAfterMs: null,
    snapshot: snapshotOf(item),
    signalKey: key,
  };
  s.trades.push(rec);
  persist();
  return rec;
}

/** WIN / LOSS finalise learning exactly once. CANCELLED never trains it. */
export function resolveTrade(id: string, outcome: "WIN" | "LOSS" | "CANCELLED") {
  const s = load();
  const rec = s.trades.find((t) => t.id === id);
  if (!rec || rec.outcome !== "PENDING") return; // no duplicate feedback
  rec.outcome = outcome;
  rec.resolvedAt = Date.now();
  rec.enteredAfterMs = rec.resolvedAt - rec.ts;
  if (outcome === "WIN" || outcome === "LOSS") {
    recordOutcomeDirective({
      sourceId: `outcome:${rec.id}`,
      outcome,
      snapshot: rec.snapshot,
      now: rec.resolvedAt,
    });
    // Immediately inform the observation layer and qualification manager
    observationEngine.ingestTradeFeedback(rec, rec.feedback);
  } else {
    removeDirectivesBySource(`outcome:${rec.id}`);
  }
  persist();
}

export function listPendingTrades(): TradeRecord[] {
  return load().trades.filter((t) => t.outcome === "PENDING");
}

export function listTrades(): TradeRecord[] {
  return [...load().trades].reverse();
}

export function confirmedTrades(): TradeRecord[] {
  return load().trades.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS");
}

export function clearTradeFeedback() {
  store = blank();
  clearGuidance();
  observationEngine.clearFeedbackState();
  persist();
}

// ── OPERATOR FEEDBACK (written) ─────────────────────────────────────────
// Written text NEVER becomes a win, a loss, or a numeric learning weight.
// It is stored, displayed and counted only as an observation.

function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Attach or replace the written note on an existing trade record. */
export function saveTradeFeedback(
  tradeId: string,
  text: string,
  category: FeedbackCategory | null = null,
): TradeFeedbackNote | null {
  const s = load();
  const rec = s.trades.find((t) => t.id === tradeId);
  if (!rec) return null;
  const clean = text.trim();
  if (!clean) return null;
  const existing = rec.feedback ?? null;
  rec.feedback = {
    tradeId,
    ts: existing?.ts ?? Date.now(),
    updatedAt: existing ? Date.now() : null,
    text: clean,
    category,
  };
  // CHANNEL 1: the post-trade report also becomes a bounded, expiring immediate directive
  // that incorporates both the outcome (WIN/LOSS) and the written report to guide next signals.
  recordFeedbackDirective({
    sourceId: `trade:${tradeId}`,
    text: clean,
    category,
    snapshot: rec.snapshot,
    outcome: rec.outcome,
  });
  // Immediately inform the observation layer with the written feedback post-mortem
  observationEngine.ingestTradeFeedback(rec, rec.feedback);
  persist();
  return rec.feedback;
}

export function deleteTradeFeedback(tradeId: string) {
  const s = load();
  const rec = s.trades.find((t) => t.id === tradeId);
  if (!rec || !rec.feedback) return;
  rec.feedback = null;
  removeDirectivesBySource(`trade:${tradeId}`);
  persist();
}

export function tradeFeedbackFor(tradeId: string): TradeFeedbackNote | null {
  return load().trades.find((t) => t.id === tradeId)?.feedback ?? null;
}

/** An observation is NOT a trade: it never enters outcome learning. */
export function addObservation(
  item: RankedOpportunity,
  text: string,
  category: FeedbackCategory | null = null,
): SignalObservation | null {
  const clean = text.trim();
  if (!clean) return null;
  const s = load();
  const obs: SignalObservation = {
    observationId: newId("obs"),
    ts: Date.now(),
    updatedAt: null,
    text: clean,
    category,
    snapshot: snapshotOf(item),
  };
  s.observations.push(obs);
  recordFeedbackDirective({
    sourceId: `obs:${obs.observationId}`,
    text: clean,
    category,
    snapshot: obs.snapshot,
  });
  observationEngine.ingestTradeFeedback(
    {
      id: obs.observationId,
      outcome: "PENDING",
      snapshot: obs.snapshot,
      feedback: { text: clean, category },
    },
    { text: clean, category },
  );
  persist();
  return obs;
}

export function updateObservation(
  observationId: string,
  text: string,
  category?: FeedbackCategory | null,
) {
  const s = load();
  const obs = s.observations.find((o) => o.observationId === observationId);
  if (!obs) return;
  const clean = text.trim();
  if (!clean) return;
  obs.text = clean;
  if (category !== undefined) obs.category = category;
  obs.updatedAt = Date.now();
  // A corrected note SUPERSEDES its own earlier directive.
  recordFeedbackDirective({
    sourceId: `obs:${observationId}`,
    text: clean,
    category: obs.category,
    snapshot: obs.snapshot,
  });
  persist();
}

export function deleteObservation(observationId: string) {
  const s = load();
  const i = s.observations.findIndex((o) => o.observationId === observationId);
  if (i < 0) return;
  s.observations.splice(i, 1);
  removeDirectivesBySource(`obs:${observationId}`);
  persist();
}

export function listObservations(): SignalObservation[] {
  return [...load().observations].reverse();
}

/** Market + contract isolated: an R_10 note is never evidence about R_25. */
export function observationsFor(symbol: string, contract?: string): SignalObservation[] {
  return listObservations().filter(
    (o) => o.snapshot.symbol === symbol && (!contract || o.snapshot.contract === contract),
  );
}

export interface CategoryCount {
  category: FeedbackCategory;
  count: number;
}

/** Counts of OBSERVATIONS — never to be read as trade win/loss statistics. */
export function observationCategoryCounts(symbol?: string, contract?: string): CategoryCount[] {
  const notes: { category: FeedbackCategory | null }[] = [
    ...listObservations().filter(
      (o) =>
        (!symbol || o.snapshot.symbol === symbol) &&
        (!contract || o.snapshot.contract === contract),
    ),
    ...load()
      .trades.filter(
        (t) =>
          !!t.feedback &&
          (!symbol || t.snapshot.symbol === symbol) &&
          (!contract || t.snapshot.contract === contract),
      )
      .map((t) => t.feedback!),
  ];
  const map = new Map<FeedbackCategory, number>();
  for (const n of notes) {
    if (!n.category) continue;
    map.set(n.category, (map.get(n.category) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

export interface FeedbackHistoryEntry {
  id: string;
  ts: number;
  type: "TRADE FEEDBACK" | "SIGNAL OBSERVATION";
  symbol: string;
  contract: string;
  contractLabel: string;
  entryDigit: number | null;
  category: FeedbackCategory | null;
  outcome: TradeOutcome | null;
  text: string;
}

/** Unified, filterable written-feedback history. Deleted notes never appear. */
export function feedbackHistory(filter?: {
  symbol?: string;
  contract?: string;
  type?: FeedbackHistoryEntry["type"];
  category?: FeedbackCategory;
}): FeedbackHistoryEntry[] {
  const s = load();
  const entries: FeedbackHistoryEntry[] = [
    ...s.trades
      .filter((t) => !!t.feedback)
      .map((t) => ({
        id: t.feedback!.tradeId,
        ts: t.feedback!.updatedAt ?? t.feedback!.ts,
        type: "TRADE FEEDBACK" as const,
        symbol: t.snapshot.symbol,
        contract: t.snapshot.contract,
        contractLabel: t.snapshot.contractLabel,
        entryDigit: t.snapshot.entryDigit,
        category: t.feedback!.category,
        outcome: t.outcome,
        text: t.feedback!.text,
      })),
    ...s.observations.map((o) => ({
      id: o.observationId,
      ts: o.updatedAt ?? o.ts,
      type: "SIGNAL OBSERVATION" as const,
      symbol: o.snapshot.symbol,
      contract: o.snapshot.contract,
      contractLabel: o.snapshot.contractLabel,
      entryDigit: o.snapshot.entryDigit,
      category: o.category,
      outcome: null,
      text: o.text,
    })),
  ];
  return entries
    .filter(
      (e) =>
        (!filter?.symbol || e.symbol === filter.symbol) &&
        (!filter?.contract || e.contract === filter.contract) &&
        (!filter?.type || e.type === filter.type) &&
        (!filter?.category || e.category === filter.category),
    )
    .sort((a, b) => b.ts - a.ts);
}

// ── LEARNING AGGREGATION ────────────────────────────────────────────────
export type LearningTier = "INSUFFICIENT SAMPLE" | "EMERGING" | "MORE INFORMATIVE";

export function tierFor(n: number): LearningTier {
  if (n >= 20) return "MORE INFORMATIVE";
  if (n >= 6) return "EMERGING";
  return "INSUFFICIENT SAMPLE";
}

export interface DigitLearning {
  digit: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Sample-size-aware shrinkage toward the base rate — bounded influence. */
  adjusted: number;
  tier: LearningTier;
  recent: string;
}

export interface MarketLearning {
  symbol: string;
  contract: string;
  contractLabel: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  tier: LearningTier;
  digits: DigitLearning[];
  best: DigitLearning | null;
  notes: string[];
  /** Median ms between marking the trade and the reported outcome. */
  recentTrend: "IMPROVING" | "DECLINING" | "FLAT" | "UNKNOWN";
}

const SHRINK = 8; // pseudo-count: one or two trades cannot dominate

function recentTrendOf(list: TradeRecord[]): MarketLearning["recentTrend"] {
  if (list.length < 6) return "UNKNOWN";
  const half = Math.floor(list.length / 2);
  const rate = (arr: TradeRecord[]) =>
    arr.filter((t) => t.outcome === "WIN").length / Math.max(1, arr.length);
  const early = rate(list.slice(0, half));
  const late = rate(list.slice(half));
  if (late - early > 0.1) return "IMPROVING";
  if (early - late > 0.1) return "DECLINING";
  return "FLAT";
}

/** Learning is ALWAYS market + contract isolated. Never global. */
export function learningFor(symbol: string, contract: string): MarketLearning {
  const list = confirmedTrades()
    .filter((t) => t.snapshot.symbol === symbol && t.snapshot.contract === contract)
    .sort((a, b) => a.ts - b.ts);
  const wins = list.filter((t) => t.outcome === "WIN").length;
  const trades = list.length;
  const base = trades ? wins / trades : 0.5;

  const digits: DigitLearning[] = [];
  for (let d = 0; d <= 9; d++) {
    const dl = list.filter((t) => t.snapshot.entryDigit === d);
    if (!dl.length) continue;
    const w = dl.filter((t) => t.outcome === "WIN").length;
    const n = dl.length;
    const winRate = w / n;
    digits.push({
      digit: d,
      trades: n,
      wins: w,
      losses: n - w,
      winRate,
      adjusted: (w + base * SHRINK) / (n + SHRINK),
      tier: tierFor(n),
      recent: dl
        .slice(-6)
        .map((t) => (t.outcome === "WIN" ? "W" : "L"))
        .join(""),
    });
  }
  digits.sort((a, b) => b.adjusted - a.adjusted);
  const best = digits.find((d) => d.trades >= 6) ?? null;

  const notes: string[] = [];
  if (trades === 0) {
    notes.push("No confirmed trades for this market and contract yet.");
  } else {
    if (best && digits.length > 1) {
      notes.push(
        `Entry digit ${best.digit} has performed best of the tested entry digits here (${(best.winRate * 100).toFixed(1)}% over ${best.trades} confirmed trades).`,
      );
    } else {
      notes.push("No reliable entry-digit preference yet — samples per digit are still small.");
    }
    const trend = recentTrendOf(list);
    if (trend === "IMPROVING") notes.push("Recent confirmed performance is improving.");
    if (trend === "DECLINING") notes.push("Recent confirmed performance is deteriorating.");
  }

  return {
    symbol,
    contract,
    contractLabel: list[list.length - 1]?.snapshot.contractLabel ?? contract,
    trades,
    wins,
    losses: trades - wins,
    winRate: trades ? wins / trades : 0,
    tier: tierFor(trades),
    digits,
    best,
    notes,
    recentTrend: recentTrendOf(list),
  };
}

/** Learned view of one entry digit in one market/contract — bounded, honest. */
export function digitLearning(
  symbol: string,
  contract: string,
  digit: number | null,
): DigitLearning | null {
  if (digit === null) return null;
  return learningFor(symbol, contract).digits.find((d) => d.digit === digit) ?? null;
}

export interface SessionLearning {
  confirmed: number;
  wins: number;
  losses: number;
  cancelled: number;
  newDigitObservations: number;
  pairsUpdated: number;
  headline: string | null;
}

export function todaysLearning(now = Date.now()): SessionLearning {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const today = load().trades.filter((t) => (t.resolvedAt ?? 0) >= dayStart.getTime());
  const confirmedToday = today.filter((t) => t.outcome === "WIN" || t.outcome === "LOSS");
  const wins = confirmedToday.filter((t) => t.outcome === "WIN").length;
  const pairs = new Set(confirmedToday.map((t) => `${t.snapshot.symbol}|${t.snapshot.contract}`));
  const digitObs = new Set(
    confirmedToday
      .filter((t) => t.snapshot.entryDigit !== null)
      .map((t) => `${t.snapshot.symbol}|${t.snapshot.contract}|${t.snapshot.entryDigit}`),
  );

  let headline: string | null = null;
  for (const p of pairs) {
    const [sym, con] = p.split("|");
    const l = learningFor(sym, con);
    if (l.best && l.trades >= 6) {
      headline = `${l.contractLabel} on ${sym}: entry digit ${l.best.digit} has outperformed the other tested entry digits (${(l.best.winRate * 100).toFixed(1)}% over ${l.best.trades} trades).`;
      break;
    }
  }

  return {
    confirmed: confirmedToday.length,
    wins,
    losses: confirmedToday.length - wins,
    cancelled: today.filter((t) => t.outcome === "CANCELLED").length,
    newDigitObservations: digitObs.size,
    pairsUpdated: pairs.size,
    headline,
  };
}

/** Every market/contract pair that has confirmed learning, strongest sample first. */
export function allLearning(): MarketLearning[] {
  const pairs = new Set(
    confirmedTrades().map((t) => `${t.snapshot.symbol}|${t.snapshot.contract}`),
  );
  return [...pairs]
    .map((p) => {
      const [sym, con] = p.split("|");
      return learningFor(sym, con);
    })
    .sort((a, b) => b.trades - a.trades);
}
