// APEX SENTINEL — SCAN-TO-SCAN MEMORY, SIGNAL PERSISTENCE, EDGE STABILITY.
//
// Repeated SCAN actions must not erase what was learned by the previous ones.
// This module keeps a short rolling history of scans (5–10, never unbounded)
// and derives from it:
//
//   PERSISTENCE     — does this candidate stay COMPETITIVE across scans?
//                     Staying #1 every time is not required; #1/#2/#3 all earn
//                     credit, with strong credit for #1 and little outside the
//                     top tier.
//   EDGE STABILITY  — does the underlying edge hold a narrow range, or swing?
//   MARKET ROTATION — how often the leading candidate changes.
//   CHANGE CLASS    — NORMAL UPDATE vs MATERIAL CHANGE, so ordinary ticks do
//                     not rotate the preferred market, while a genuinely
//                     superior candidate can still take #1 immediately.
//
// Market isolation is structural: every entry is keyed by symbol × contract, so
// nothing measured on one market can ever be attributed to another.

export interface ScanMemoryEntry {
  key: string;
  symbol: string;
  name: string;
  contract: string;
  contractLabel: string;
  rank: number;
  score: number;
  absoluteEdge: number;
  relativeEdge: number;
  danger: number;
  agreement: string;
  evidenceConfidence: number;
  regime: string;
  verdict: string;
  entryDigit: number | null;
  entryCondition: string | null;
}

export interface ScanSnapshot {
  at: number;
  entries: ScanMemoryEntry[];
}

export interface PersistenceReport {
  key: string;
  /** 0..100 — weighted competitiveness across the retained scans. */
  persistence: number;
  currentRank: number;
  previousRank: number | null;
  averageRank: number;
  /** Appearances in the top three, and how many scans were examined. */
  topThree: number;
  scans: number;
  /** 0..100 — how tightly the absolute edge held its range. */
  edgeStability: number;
  edgeSeries: number[];
  edgeRange: number;
  edgeStdDev: number;
  /** LOW / MEDIUM / HIGH — how often the field's #1 changed. */
  rotation: "LOW" | "MEDIUM" | "HIGH";
  rotationChanges: number;
  changeClass: "NEW" | "NORMAL UPDATE" | "MATERIAL CHANGE";
  changeReasons: string[];
  /** Bounded ranking contribution in score points. */
  rankingDelta: number;
  summary: string;
}

const MAX_SCANS = 10;
const STORAGE_KEY = "apex.sentinel.scan-memory.v1";
/** Recency weighting — the newest scan counts most. */
const DECAY = 0.78;

function rankCredit(rank: number): number {
  if (rank === 1) return 1;
  if (rank === 2) return 0.8;
  if (rank === 3) return 0.6;
  if (rank <= 5) return 0.25;
  return 0;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

class ScanMemory {
  private history: ScanSnapshot[] = [];
  private loaded = false;

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as ScanSnapshot[];
      if (Array.isArray(parsed)) this.history = parsed.slice(-MAX_SCANS);
    } catch {
      // A corrupt cache is discarded rather than trusted.
      this.history = [];
    }
  }

  private save() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
    } catch {
      // Storage full or unavailable — memory still works for this session.
    }
  }

  snapshots(): ScanSnapshot[] {
    this.load();
    return this.history;
  }

  /** Record a completed scan. Older scans age out; nothing is kept forever. */
  record(entries: ScanMemoryEntry[]): void {
    this.load();
    this.history.push({ at: Date.now(), entries });
    if (this.history.length > MAX_SCANS) this.history = this.history.slice(-MAX_SCANS);
    this.save();
  }

  clear(): void {
    this.history = [];
    this.loaded = true;
    this.save();
  }

  /** How often did the field's #1 change across the retained scans? */
  rotation(): { changes: number; label: "LOW" | "MEDIUM" | "HIGH" } {
    this.load();
    const leaders = this.history
      .map((s) => s.entries.find((e) => e.rank === 1)?.key ?? null)
      .filter((x): x is string => Boolean(x));
    let changes = 0;
    for (let i = 1; i < leaders.length; i++) if (leaders[i] !== leaders[i - 1]) changes += 1;
    const ratio = leaders.length > 1 ? changes / (leaders.length - 1) : 0;
    return { changes, label: ratio >= 0.6 ? "HIGH" : ratio >= 0.3 ? "MEDIUM" : "LOW" };
  }

  /**
   * Persistence, stability and change classification for one candidate.
   * `current` is the freshly computed entry and is NOT yet in the history.
   */
  assess(current: ScanMemoryEntry): PersistenceReport {
    this.load();
    const past = this.history
      .map((s) => ({ at: s.at, entry: s.entries.find((e) => e.key === current.key) ?? null }))
      .filter((x) => x.entry) as { at: number; entry: ScanMemoryEntry }[];

    const series = [...past.map((p) => p.entry), current];
    const ranks = series.map((e) => e.rank);
    const edges = series.map((e) => e.absoluteEdge);
    const previous = past.length ? past[past.length - 1].entry : null;

    // ── Weighted persistence — newest scans weigh most ──────────────────
    let wSum = 0;
    let cSum = 0;
    for (let i = 0; i < series.length; i++) {
      const age = series.length - 1 - i;
      const w = Math.pow(DECAY, age);
      wSum += w;
      cSum += w * rankCredit(series[i].rank);
    }
    const persistence = Math.round(clamp((cSum / (wSum || 1)) * 100));

    // ── Edge stability across scans ─────────────────────────────────────
    const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
    const variance = edges.reduce((a, b) => a + (b - mean) ** 2, 0) / edges.length;
    const sd = Math.sqrt(variance);
    const range = Math.max(...edges) - Math.min(...edges);
    const edgeStability = edges.length < 2 ? 50 : Math.round(clamp(100 - sd * 9 - range * 2.2));

    // ── NORMAL UPDATE vs MATERIAL CHANGE ────────────────────────────────
    const reasons: string[] = [];
    let changeClass: PersistenceReport["changeClass"] = "NEW";
    if (previous) {
      if (Math.abs(current.score - previous.score) >= 6)
        reasons.push(`score moved ${(current.score - previous.score).toFixed(1)} points`);
      if (Math.abs(current.danger - previous.danger) >= 12)
        reasons.push(`danger moved ${(current.danger - previous.danger).toFixed(0)} points`);
      if (current.regime !== previous.regime)
        reasons.push(`regime changed ${previous.regime} → ${current.regime}`);
      if (current.verdict !== previous.verdict)
        reasons.push(`verdict changed ${previous.verdict} → ${current.verdict}`);
      if (Math.sign(current.relativeEdge) !== Math.sign(previous.relativeEdge))
        reasons.push(
          `relative edge flipped ${previous.relativeEdge.toFixed(2)} → ${current.relativeEdge.toFixed(2)}`,
        );
      if (current.entryDigit !== previous.entryDigit)
        reasons.push(
          `entry digit changed ${previous.entryDigit ?? "—"} → ${current.entryDigit ?? "—"}`,
        );
      changeClass = reasons.length ? "MATERIAL CHANGE" : "NORMAL UPDATE";
    }

    const topThree = series.filter((e) => e.rank <= 3).length;
    const rot = this.rotation();
    const averageRank = Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10;

    // Persistence and stability adjust confidence in the ranking; neither is a
    // blocker, and a brand-new candidate is never punished for being new.
    const persistenceDelta =
      series.length < 2 ? 0 : Math.round(((persistence - 55) / 45) * 4 * 10) / 10;
    const stabilityDelta =
      series.length < 3 ? 0 : Math.round(((edgeStability - 60) / 40) * 3 * 10) / 10;
    const rankingDelta =
      Math.round(Math.max(-6, Math.min(6, persistenceDelta + stabilityDelta)) * 10) / 10;

    return {
      key: current.key,
      persistence,
      currentRank: current.rank,
      previousRank: previous ? previous.rank : null,
      averageRank,
      topThree,
      scans: series.length,
      edgeStability,
      edgeSeries: edges.map((e) => Math.round(e * 100) / 100),
      edgeRange: Math.round(range * 100) / 100,
      edgeStdDev: Math.round(sd * 100) / 100,
      rotation: rot.label,
      rotationChanges: rot.changes,
      changeClass,
      changeReasons: reasons,
      rankingDelta,
      summary:
        series.length < 2
          ? `First observation of ${current.contractLabel} on ${current.name} — no scan history yet, so persistence and stability contribute nothing.`
          : `Persistence ${persistence}/100 — top-3 in ${topThree}/${series.length} recent scans, average rank ${averageRank}, previous rank ${previous ? `#${previous.rank}` : "—"}, current #${current.rank}. Edge stability ${edgeStability}/100 (range ${range.toFixed(2)}, σ ${sd.toFixed(2)}). Market rotation ${rot.label}. ${changeClass}${reasons.length ? `: ${reasons.join("; ")}` : ""}.`,
    };
  }
}

export const scanMemory = new ScanMemory();
