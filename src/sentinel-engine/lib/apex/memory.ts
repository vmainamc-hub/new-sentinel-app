// APEX SENTINEL — market memory, historical analogue & calibration.
// Everything in here is learned from ticks this app actually observed.
// Nothing is seeded, invented, or back-filled with fake outcomes.
import type { ApexContractId, ContractEval, MarketIntel } from "./types";
import { safeStorage, safeJsonParse } from "@/sentinel-engine/lib/storage-fallback";

const KEY = "apex.memory.v1";
const SAVE_DEBOUNCE = 4000;
const MAX_ANALOGUE_KEYS = 1000;
const MAX_CALIBRATION_KEYS = 200;

interface Bucket {
  n: number;
  wins: number;
}

interface MemoryShape {
  /** fingerprint -> outcome bucket (historical analogue) */
  analogue: Record<string, Bucket>;
  /** confidence decile -> outcome bucket (calibration) */
  calibration: Record<string, Bucket>;
  updatedAt: number;
}

let mem: MemoryShape = { analogue: {}, calibration: {}, updatedAt: 0 };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = safeStorage.getItem(KEY);
    if (raw) {
      const parsed = safeJsonParse<MemoryShape | null>(raw, null);
      if (parsed && parsed.analogue) mem = parsed;
    }
  } catch {
    /* corrupt storage — start clean rather than crash */
  }
}

function pruneAnalogueIfNeeded() {
  const keys = Object.keys(mem.analogue);
  if (keys.length > MAX_ANALOGUE_KEYS) {
    // Sort keys by sample size ascending and drop the least observed
    keys.sort((a, b) => (mem.analogue[a]?.n ?? 0) - (mem.analogue[b]?.n ?? 0));
    const toRemove = keys.length - MAX_ANALOGUE_KEYS;
    for (let i = 0; i < toRemove; i++) {
      delete mem.analogue[keys[i]];
    }
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    mem.updatedAt = Date.now();
    pruneAnalogueIfNeeded();
    try {
      safeStorage.setItem(KEY, JSON.stringify(mem));
    } catch {
      /* quota — memory stays in RAM for this session */
    }
  }, SAVE_DEBOUNCE);
}


function bucketOf(v: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && v >= edges[i]) i++;
  return i;
}

/**
 * Compact description of the current market/contract configuration. Two
 * moments with the same fingerprint are treated as analogous states.
 */
export function fingerprint(intel: MarketIntel, c: ContractEval): string {
  const regime = intel.regime?.label ?? "NA";
  const vol = intel.volatility ? bucketOf(intel.volatility.ratio, [0.8, 1.1, 1.5]) : 0;
  const ce = bucketOf(c.compositeEdge, [-20, -5, 5, 20, 40]);
  const pa = bucketOf(c.pressureAsymmetry, [-0.3, -0.05, 0.05, 0.3]);
  const ent = intel.entropy ? bucketOf(intel.entropy.entropy, [0.96, 0.975, 0.985]) : 0;
  // The MARKET is part of the key: an analogue learned on V75 is never
  // consulted for V100. Cross-market generalisation, if ever wanted, must be
  // an explicit model — never an accidental key collision.
  return `${intel.symbol}|${c.id}|${regime}|v${vol}|e${ce}|p${pa}|h${ent}`;
}

export function observeAnalogue(key: string, won: boolean) {
  load();
  const b = (mem.analogue[key] ??= { n: 0, wins: 0 });
  b.n++;
  if (won) b.wins++;
  scheduleSave();
}

export function lookupAnalogue(key: string): { n: number; rate: number } | null {
  load();
  const b = mem.analogue[key];
  if (!b || b.n < 30) return b ? { n: b.n, rate: b.wins / b.n } : null;
  return { n: b.n, rate: b.wins / b.n };
}

export function observeCalibration(symbol: string, confidence: number, won: boolean) {
  load();
  const decile = Math.min(9, Math.max(0, Math.floor(confidence / 10)));
  // Calibration is learned per market: a well-calibrated V75 cannot vouch for
  // a badly calibrated V100.
  const b = (mem.calibration[`${symbol}|${decile}`] ??= { n: 0, wins: 0 });
  b.n++;
  if (won) b.wins++;
  scheduleSave();
}

/**
 * Calibration deciles. Pass a symbol for that market's own calibration; with no
 * symbol the deciles are pooled and must only be presented as a cross-market
 * view, never as a per-market authority.
 */
export function calibrationTable(symbol?: string): { decile: number; n: number; rate: number }[] {
  load();
  const acc = new Map<number, Bucket>();
  for (const [key, b] of Object.entries(mem.calibration ?? {})) {
    const [sym, dec] = key.includes("|") ? key.split("|") : ["", key];
    if (symbol && sym !== symbol) continue;
    const decile = Number(dec);
    const cur = acc.get(decile) ?? { n: 0, wins: 0 };
    cur.n += b.n;
    cur.wins += b.wins;
    acc.set(decile, cur);
  }
  return [...acc.entries()]
    .map(([decile, b]) => ({ decile, n: b.n, rate: b.n ? b.wins / b.n : 0 }))
    .sort((a, b) => a.decile - b.decile);
}

export function memoryStats() {
  load();
  const states = Object.keys(mem.analogue).length;
  const observations = Object.values(mem.analogue).reduce((a, b) => a + b.n, 0);
  return { states, observations, updatedAt: mem.updatedAt };
}

export function resetMemory() {
  mem = { analogue: {}, calibration: {}, updatedAt: Date.now() };
  safeStorage.removeItem(KEY);
}

/** Snapshot for durable (database) persistence. */
export function exportMemory(): MemoryShape {
  load();
  return {
    analogue: { ...mem.analogue },
    calibration: { ...mem.calibration },
    updatedAt: mem.updatedAt,
  };
}

/**
 * Merge a durable snapshot back in. For each exact key the record with more
 * observations wins, so reloading twice cannot double-count evidence.
 */
export function importMemory(payload: Partial<MemoryShape> | null | undefined) {
  load();
  if (!payload) return;
  for (const [k, b] of Object.entries(payload.analogue ?? {})) {
    if (!b || typeof b.n !== "number") continue;
    const cur = mem.analogue[k];
    if (!cur || b.n > cur.n) mem.analogue[k] = { n: b.n, wins: b.wins };
  }
  for (const [k, b] of Object.entries(payload.calibration ?? {})) {
    if (!b || typeof b.n !== "number") continue;
    const cur = mem.calibration[k];
    if (!cur || b.n > cur.n) mem.calibration[k] = { n: b.n, wins: b.wins };
  }
  mem.updatedAt = Math.max(mem.updatedAt, payload.updatedAt ?? 0);
}

export type { ApexContractId };
