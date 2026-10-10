// DIGIT ROLE ASSIGNMENT — single source of truth for the five sensitive
// digits (hot, hot 2, cold, cold 2, rising).
//
// Every digit 0-9 is equally eligible for every role in every panel and engine.

export type DigitRole = "HOT" | "HOT 2" | "COLD" | "COLD 2" | "RISING";

export interface DigitRoles {
  hot: number;
  hot2: number;
  cold: number;
  cold2: number;
  rising: number;
}

const NONE = -1;

/**
 * Assign the five distinguished roles from a per-digit percentage array and a
 * per-digit recent delta array. Pure.
 */
export function assignDigitRoles(pct: number[], delta: number[], risingMin = 0.01): DigitRoles {
  const ranked = pct.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p || a.i - b.i);

  const hot = ranked[0]?.i ?? NONE;
  const hot2 = ranked[1]?.i ?? NONE;
  const cold = ranked[ranked.length - 1]?.i ?? NONE;
  const cold2 = ranked[ranked.length - 2]?.i ?? NONE;
  const rising = pickRising(delta, risingMin);

  return { hot, hot2, cold, cold2, rising };
}

function pickRising(delta: number[], risingMin: number): number {
  let best = NONE;
  for (let i = 0; i < delta.length; i++) {
    if (best === NONE || delta[i] > delta[best]) best = i;
  }
  if (best === NONE) return NONE;
  return delta[best] > risingMin ? best : NONE;
}

/** Convenience: percentages + recent deltas from a digit stream. */
export function digitRoleStats(digits: number[], recentWindow = 150) {
  const freq = new Array(10).fill(0);
  digits.forEach((d) => freq[d]++);
  const total = digits.length || 1;
  const pct = freq.map((c) => (c / total) * 100);

  const recent = digits.slice(-recentWindow);
  const prior = digits.slice(-recentWindow * 2, -recentWindow);
  const rc = new Array(10).fill(0);
  const pc = new Array(10).fill(0);
  recent.forEach((d) => rc[d]++);
  prior.forEach((d) => pc[d]++);
  const rTot = recent.length || 1;
  const pTot = prior.length || 1;
  const delta = rc.map((c, i) => c / rTot - pc[i] / pTot);

  return { freq, pct, delta, total: digits.length };
}
