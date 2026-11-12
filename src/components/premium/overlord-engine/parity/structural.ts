// Structural Digit Psychology Engine (Precision Parity AI V4).
// Additive reasoning layer: interprets the five structural digits
// (Green/Red/Yellow/LightRed/Purple bars) as interacting participants in a
// dynamic market ecosystem — persistence, relationships, crowd positioning,
// entropy, volatility, and reversal probability — and contributes weighted
// evidence to the existing Bayesian fusion. Nothing here fires trades on its
// own; every observation is submitted as evidence.

import type { Evidence, ParityContract, Parity } from "./types";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const parityOf = (d: number): Parity => (d % 2 === 0 ? "EVEN" : "ODD");

export type EntropyLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
export type VolatilityRegime =
  | "STABLE" | "EXPANDING" | "CONTRACTING" | "EXPLOSIVE" | "RECOVERING" | "ROTATIONAL" | "CHAOTIC";
export type MarketHypothesis =
  | "ACCUMULATION" | "DISTRIBUTION" | "ROTATION" | "REVERSAL"
  | "CONSOLIDATION" | "RECOVERY" | "MANIPULATION" | "UNCERTAIN";

export interface StructuralBar {
  role: "GREEN" | "RED" | "YELLOW" | "LIGHT_RED" | "PURPLE";
  digit: number;
  parity: Parity;
  pct: number;         // recent share (0..1)
  velocity: number;    // recent - baseline (-1..1)
  accel: number;       // short-window - medium-window velocity
  persistence: number; // ticks the digit has held its structural role
  migrated: boolean;   // role holder just changed on this evaluation
}

export interface StructuralReport {
  bars: Record<StructuralBar["role"], StructuralBar>;
  entropy: number;                 // Shannon entropy over 10 digits (0..log2 10)
  entropyLevel: EntropyLevel;
  volatility: number;              // 0..1 realised parity variance vs long-run
  volatilityRegime: VolatilityRegime;
  crowding: number;                // 0..1 dominance concentration
  crowdOvercrowded: boolean;
  reversalProbability: number;     // 0..1
  rotationRate: number;            // 0..1 how many structural roles swapped
  hypothesis: MarketHypothesis;
  narrative: string[];             // human-readable structural reasoning
  evidence: Evidence[];            // submitted into the Bayesian fusion
}

export interface StructuralMemory {
  lastDigits: Partial<Record<StructuralBar["role"], number>>;
  persistence: Partial<Record<StructuralBar["role"], number>>;
  lastEvenPct100: number | null;
  volatilityHistory: number[];     // rolling parity variance samples
}

const MEM = new Map<string, StructuralMemory>();
function getMem(market: string): StructuralMemory {
  const e = MEM.get(market);
  if (e) return e;
  const m: StructuralMemory = {
    lastDigits: {},
    persistence: {},
    lastEvenPct100: null,
    volatilityHistory: [],
  };
  MEM.set(market, m);
  return m;
}
export function resetStructuralMemory(market?: string) {
  if (market) MEM.delete(market);
  else MEM.clear();
}

function freq(digits: number[]): number[] {
  const f = new Array(10).fill(0);
  for (const d of digits) f[d]++;
  const n = Math.max(1, digits.length);
  return f.map((x) => x / n);
}

function shannon(dist: number[]): number {
  let h = 0;
  for (const p of dist) if (p > 0) h -= p * Math.log2(p);
  return h; // 0..log2(10) ≈ 3.3219
}

function parityVariance(digits: number[], chunk = 20): number {
  const means: number[] = [];
  for (let i = 0; i + chunk <= digits.length; i += chunk) {
    const c = digits.slice(i, i + chunk);
    means.push(c.filter((d) => d % 2 === 0).length / c.length);
  }
  if (means.length < 2) return 0;
  const mu = means.reduce((a, b) => a + b, 0) / means.length;
  return means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length;
}

function rank(pairs: Array<[number, number]>, dir: "desc" | "asc"): number[] {
  return [...pairs].sort((a, b) => (dir === "desc" ? b[1] - a[1] : a[1] - b[1])).map((p) => p[0]);
}

// Build the five structural bars in the prompt's convention.
function computeBars(recentF: number[], baselineF: number[], shortF: number[]): Record<StructuralBar["role"], Omit<StructuralBar, "persistence" | "migrated">> {
  const pairs = recentF.map((v, i) => [i, v] as [number, number]);
  const desc = rank(pairs, "desc");
  const asc = rank(pairs, "asc");
  const delta = recentF.map((v, i) => v - baselineF[i]);
  const shortDelta = recentF.map((v, i) => v - shortF[i]);
  // Purple = fastest INCREASING (largest positive delta).
  let purpleIdx = 0;
  for (let d = 1; d < 10; d++) if (delta[d] > delta[purpleIdx]) purpleIdx = d;

  const mk = (role: StructuralBar["role"], idx: number): Omit<StructuralBar, "persistence" | "migrated"> => ({
    role,
    digit: idx,
    parity: parityOf(idx),
    pct: recentF[idx],
    velocity: delta[idx],
    accel: shortDelta[idx] - delta[idx],
  });
  return {
    GREEN: mk("GREEN", asc[0]),               // least appearing
    RED: mk("RED", desc[0]),                  // most appearing
    YELLOW: mk("YELLOW", desc[1]),            // 2nd most appearing
    LIGHT_RED: mk("LIGHT_RED", asc[1]),       // 2nd least appearing
    PURPLE: mk("PURPLE", purpleIdx),          // fastest increasing
  };
}

/**
 * Structural Digit Psychology Engine.
 * Interprets the five structural bars in context (persistence, acceleration,
 * migration, relationships, crowd positioning) and emits Evidence that the
 * existing hypothesis fusion consumes. Never fires trades directly.
 */
export function analyseStructural(
  market: string,
  digits: number[],
): StructuralReport {
  const mem = getMem(market);
  const recent = digits.slice(-100);
  const baseline = digits.slice(-500);
  const short = digits.slice(-30);
  const recentF = freq(recent);
  const baselineF = freq(baseline);
  const shortF = freq(short);

  const raw = computeBars(recentF, baselineF, shortF);

  // Update persistence + migration flags against session memory.
  const bars = {} as Record<StructuralBar["role"], StructuralBar>;
  let migrations = 0;
  (Object.keys(raw) as StructuralBar["role"][]).forEach((role) => {
    const b = raw[role];
    const prev = mem.lastDigits[role];
    const migrated = prev !== undefined && prev !== b.digit;
    if (migrated) migrations++;
    const persistence = migrated || prev === undefined ? 1 : (mem.persistence[role] ?? 1) + 1;
    mem.lastDigits[role] = b.digit;
    mem.persistence[role] = persistence;
    bars[role] = { ...b, persistence, migrated };
  });
  const rotationRate = migrations / 5;

  // Entropy (over the digit distribution — measures disorder).
  const entropy = shannon(recentF);
  const entMax = Math.log2(10);
  const entRatio = entropy / entMax;
  const entropyLevel: EntropyLevel =
    entRatio > 0.98 ? "VERY_HIGH" :
    entRatio > 0.94 ? "HIGH" :
    entRatio > 0.88 ? "MEDIUM" : "LOW";

  // Volatility interpretation: compare short-window variance vs medium.
  const vShort = parityVariance(digits.slice(-100), 20);
  const vLong = parityVariance(digits.slice(-400), 40) || 1e-6;
  const volatility = clamp01(vShort / (vShort + vLong) * 2 - 0.5 + 0.5);
  mem.volatilityHistory.push(vShort);
  if (mem.volatilityHistory.length > 40) mem.volatilityHistory.shift();
  const vh = mem.volatilityHistory;
  const trend = vh.length >= 6 ? vh.slice(-3).reduce((a,b)=>a+b,0)/3 - vh.slice(-6,-3).reduce((a,b)=>a+b,0)/3 : 0;
  let volatilityRegime: VolatilityRegime = "STABLE";
  if (vShort > vLong * 2.2) volatilityRegime = "EXPLOSIVE";
  else if (trend > vLong * 0.35) volatilityRegime = "EXPANDING";
  else if (trend < -vLong * 0.35) volatilityRegime = rotationRate >= 0.4 ? "ROTATIONAL" : "CONTRACTING";
  else if (vShort < vLong * 0.55 && entropyLevel === "LOW") volatilityRegime = "RECOVERING";
  else if (entropyLevel === "VERY_HIGH" && rotationRate >= 0.4) volatilityRegime = "CHAOTIC";
  else if (rotationRate >= 0.4) volatilityRegime = "ROTATIONAL";

  // Crowd positioning — how concentrated probability is around the leader.
  const crowding = clamp01((bars.RED.pct - 0.1) * 4);
  const crowdOvercrowded = crowding > 0.6 && bars.RED.persistence >= 20;

  // Reversal probability: purple accelerating, red losing dominance, migrations high, light-red recovering.
  const purpleAccel = Math.max(0, bars.PURPLE.velocity) + Math.max(0, bars.PURPLE.accel) * 1.5;
  const redExhaustion = Math.max(0, -bars.RED.velocity) + (bars.RED.persistence > 40 ? 0.05 : 0);
  const lightRedRecovery = Math.max(0, bars.LIGHT_RED.velocity);
  const structuralChurn = rotationRate * 0.6;
  const reversalProbability = clamp01(
    purpleAccel * 4 + redExhaustion * 3 + lightRedRecovery * 2 + structuralChurn +
    (entropyLevel === "VERY_HIGH" ? 0.15 : 0),
  );

  // Market hypothesis synthesis.
  let hypothesis: MarketHypothesis = "UNCERTAIN";
  if (crowdOvercrowded && reversalProbability > 0.55) hypothesis = "DISTRIBUTION";
  else if (crowdOvercrowded && bars.RED.velocity > 0.01) hypothesis = "ACCUMULATION";
  else if (reversalProbability > 0.6) hypothesis = "REVERSAL";
  else if (rotationRate >= 0.4) hypothesis = "ROTATION";
  else if (entropyLevel === "LOW" && volatilityRegime === "STABLE") hypothesis = "CONSOLIDATION";
  else if (lightRedRecovery > 0.015 && bars.RED.velocity <= 0) hypothesis = "RECOVERY";
  else if (bars.RED.pct > 0.22 && rotationRate === 0 && entropyLevel === "LOW") hypothesis = "MANIPULATION";

  // ─── Build weighted evidence for the Bayesian fusion ────────────────────
  const evidence: Evidence[] = [];
  const narrative: string[] = [];
  const push = (
    engine: string,
    supports: ParityContract | "NEUTRAL",
    strength: number,
    detail: string,
  ) => {
    if (strength <= 0) return;
    evidence.push({ engine, supports, strength: clamp01(strength), detail });
    narrative.push(detail);
  };
  const barContract = (p: Parity): ParityContract => (p === "EVEN" ? "BUY_EVEN" : "BUY_ODD");

  // Green Bar (least appearing) — a persistent green bar of parity P suggests
  // P is under-represented and MAY be due to recover, but only if the market is
  // not clearly trending against it. Treat as WEAK evidence; interpret in context.
  if (bars.GREEN.persistence >= 6) {
    const s = 0.15 + clamp01(bars.GREEN.persistence / 60) * 0.25;
    push(
      "Structural: Green Bar",
      barContract(bars.GREEN.parity),
      s,
      `Green Bar d${bars.GREEN.digit} (${bars.GREEN.parity}) persistent ${bars.GREEN.persistence}t at ${(bars.GREEN.pct*100).toFixed(1)}% — recovery pressure`,
    );
  }

  // Red Bar (most appearing) — dominance means the same-parity is loaded.
  // Fresh + still accelerating = continuation; exhausted = reversal risk.
  if (bars.RED.persistence >= 4 && !crowdOvercrowded && bars.RED.velocity >= -0.005) {
    const s = clamp01(bars.RED.velocity * 8 + 0.2);
    push(
      "Structural: Red Bar",
      barContract(bars.RED.parity),
      s,
      `Red Bar d${bars.RED.digit} (${bars.RED.parity}) leading ${bars.RED.persistence}t at ${(bars.RED.pct*100).toFixed(1)}%, velocity ${(bars.RED.velocity*100).toFixed(2)}%`,
    );
  } else if (crowdOvercrowded) {
    push(
      "Structural: Crowd Exhaustion",
      barContract(bars.RED.parity === "EVEN" ? "ODD" : "EVEN"),
      clamp01(crowding * 0.6),
      `Red Bar d${bars.RED.digit} overcrowded (${(bars.RED.pct*100).toFixed(1)}% for ${bars.RED.persistence}t) — crowd late, edge favours opposite parity`,
    );
  } else if (redExhaustion > 0.01) {
    push(
      "Structural: Red Bar Exhaustion",
      barContract(bars.RED.parity === "EVEN" ? "ODD" : "EVEN"),
      clamp01(redExhaustion * 8),
      `Red Bar d${bars.RED.digit} losing dominance (v=${(bars.RED.velocity*100).toFixed(2)}%) — probability leaking to opposite parity`,
    );
  }

  // Yellow Bar — supports the dominant regime; contributes small confirmation.
  if (bars.YELLOW.parity === bars.RED.parity && bars.YELLOW.persistence >= 3) {
    push(
      "Structural: Yellow Bar",
      barContract(bars.YELLOW.parity),
      0.2,
      `Yellow Bar d${bars.YELLOW.digit} (${bars.YELLOW.parity}) reinforces the dominant ${bars.YELLOW.parity} structure`,
    );
  } else if (bars.YELLOW.velocity > 0.01 && bars.YELLOW.parity !== bars.RED.parity) {
    push(
      "Structural: Yellow Rotation",
      barContract(bars.YELLOW.parity),
      clamp01(bars.YELLOW.velocity * 6),
      `Yellow Bar d${bars.YELLOW.digit} (${bars.YELLOW.parity}) strengthening against Red — rotation into ${bars.YELLOW.parity}`,
    );
  }

  // Light Red Bar — a recovering weak digit signals redistribution.
  if (lightRedRecovery > 0.01) {
    push(
      "Structural: Light Red Recovery",
      barContract(bars.LIGHT_RED.parity),
      clamp01(lightRedRecovery * 6),
      `Light Red d${bars.LIGHT_RED.digit} (${bars.LIGHT_RED.parity}) recovering (+${(lightRedRecovery*100).toFixed(2)}%) — weak-side re-entry`,
    );
  }

  // Purple Bar — fastest-increasing digit; potential replacement of the leader.
  if (bars.PURPLE.velocity > 0.015) {
    const replacing = bars.PURPLE.digit !== bars.RED.digit && purpleAccel > 0.03;
    const s = clamp01(bars.PURPLE.velocity * 5 + Math.max(0, bars.PURPLE.accel) * 4);
    push(
      "Structural: Purple Bar",
      barContract(bars.PURPLE.parity),
      s,
      replacing
        ? `Purple Bar d${bars.PURPLE.digit} (${bars.PURPLE.parity}) accelerating (+${(bars.PURPLE.velocity*100).toFixed(2)}%) — replacing Red d${bars.RED.digit}`
        : `Purple Bar d${bars.PURPLE.digit} (${bars.PURPLE.parity}) strengthening (+${(bars.PURPLE.velocity*100).toFixed(2)}%)`,
    );
  }

  // Reversal engine — when reversal probability is high, push NEUTRAL conflict
  // AND slight support to the opposite of the currently dominant parity.
  if (reversalProbability > 0.55) {
    push(
      "Structural: Reversal",
      "NEUTRAL",
      clamp01(reversalProbability),
      `Structural reversal probability ${(reversalProbability*100).toFixed(0)}% — persistence loss, purple acceleration, and structural churn all agree`,
    );
    push(
      "Structural: Reversal Bias",
      barContract(bars.RED.parity === "EVEN" ? "ODD" : "EVEN"),
      clamp01((reversalProbability - 0.5) * 1.4),
      `Reversal bias against dominant ${bars.RED.parity} structure`,
    );
  }

  // Entropy engine — high entropy should reduce confidence via NEUTRAL conflict.
  if (entropyLevel === "HIGH" || entropyLevel === "VERY_HIGH") {
    push(
      "Structural: Entropy",
      "NEUTRAL",
      entropyLevel === "VERY_HIGH" ? 0.85 : 0.55,
      `Market entropy ${entropyLevel} (H=${entropy.toFixed(3)}/${entMax.toFixed(2)}) — disorder elevated`,
    );
  } else if (entropyLevel === "LOW") {
    push(
      "Structural: Order",
      barContract(bars.RED.parity),
      0.2,
      `Low entropy (H=${entropy.toFixed(3)}) — market is organised around ${bars.RED.parity} structure`,
    );
  }

  // Volatility interpretation — chaos/explosion damps confidence.
  if (volatilityRegime === "EXPLOSIVE" || volatilityRegime === "CHAOTIC") {
    push(
      "Structural: Volatility",
      "NEUTRAL",
      volatilityRegime === "EXPLOSIVE" ? 0.7 : 0.85,
      `Volatility regime ${volatilityRegime} — parity behaviour unstable`,
    );
  } else if (volatilityRegime === "RECOVERING" || volatilityRegime === "STABLE") {
    push(
      "Structural: Volatility Support",
      barContract(bars.RED.parity),
      0.15,
      `Volatility ${volatilityRegime} — supports continuation of current structure`,
    );
  }

  // Structural rotation — many roles swapping means the ecosystem is in flux.
  if (rotationRate >= 0.4) {
    push(
      "Structural: Rotation",
      "NEUTRAL",
      clamp01(rotationRate),
      `Structural rotation ${(rotationRate*100).toFixed(0)}% — ${migrations}/5 bars migrated this cycle`,
    );
  }

  // Market hypothesis — the synthesised story.
  if (hypothesis === "DISTRIBUTION" || hypothesis === "REVERSAL") {
    push(
      "Structural: Hypothesis",
      barContract(bars.RED.parity === "EVEN" ? "ODD" : "EVEN"),
      0.35,
      `Structural hypothesis: ${hypothesis} — probability rotating away from ${bars.RED.parity}`,
    );
  } else if (hypothesis === "ACCUMULATION" || hypothesis === "CONSOLIDATION") {
    push(
      "Structural: Hypothesis",
      barContract(bars.RED.parity),
      0.3,
      `Structural hypothesis: ${hypothesis} — ${bars.RED.parity} structure holding`,
    );
  } else if (hypothesis === "MANIPULATION") {
    push(
      "Structural: Hypothesis",
      "NEUTRAL",
      0.6,
      `Structural hypothesis: MANIPULATION — leader d${bars.RED.digit} frozen, no rotation, low entropy`,
    );
  } else if (hypothesis === "ROTATION") {
    push(
      "Structural: Hypothesis",
      "NEUTRAL",
      0.4,
      `Structural hypothesis: ROTATION — structural roles reshuffling`,
    );
  }

  // Also feed the entropy/volatility percentages back so upstream sees them.
  return {
    bars,
    entropy,
    entropyLevel,
    volatility,
    volatilityRegime,
    crowding,
    crowdOvercrowded,
    reversalProbability,
    rotationRate,
    hypothesis,
    narrative,
    evidence,
  };
}

// Silence unused warning if consumer only imports the type.
export type { Evidence, ParityContract } from "./types";
