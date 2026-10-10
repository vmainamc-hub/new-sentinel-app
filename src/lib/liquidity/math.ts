/**
 * Shared quantitative primitives.
 * Every function here is pure and deterministic — no rendering, no side effects.
 */

export const clamp = (x: number, a = 0, b = 100) =>
  Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : 0;

export const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export const variance = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return mean(a.map((x) => (x - m) ** 2));
};

export const sd = (a: number[]) => Math.sqrt(variance(a));

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Shannon entropy in bits over a probability vector. */
export const entropy = (p: number[]) => -p.reduce((s, x) => (x > 0 ? s + x * Math.log2(x) : s), 0);

/** Normalized entropy (0-100) over a 10-symbol alphabet. */
export const normalizedEntropy = (p: number[]) => (entropy(p) / Math.log2(10)) * 100;

export function freq(ds: number[]): number[] {
  const c = Array(10).fill(0);
  for (const d of ds) c[d]++;
  return c.map((x) => (ds.length ? x / ds.length : 0));
}

export function normalize(a: number[]): number[] {
  const s = a.reduce((x, y) => x + y, 0);
  return s ? a.map((x) => x / s) : a.map(() => 0);
}

/** Jensen-Shannon divergence between two distributions (bits, 0..1). */
export function jsd(p: number[], q: number[]): number {
  const m = p.map((x, i) => (x + (q[i] ?? 0)) / 2);
  const kl = (a: number[], b: number[]) =>
    a.reduce((s, x, i) => (x > 0 ? s + x * Math.log2(x / Math.max(b[i] ?? 0, 1e-12)) : s), 0);
  return (kl(p, m) + kl(q, m)) / 2;
}

/** Wilson score interval, expressed in percent. */
export function wilson(k: number, n: number, z = 1.96) {
  if (!n) return { lo: 0, hi: 0, center: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const r = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: (c - r) * 100, hi: (c + r) * 100, center: p * 100 };
}

/** Beta-binomial posterior. */
export function bayes(k: number, n: number, alpha = 1, beta = 9) {
  return {
    mean: (k + alpha) / (n + alpha + beta),
    alpha: alpha + k,
    beta: beta + n - k,
  };
}

export function ewma(values: number[], lambda = 0.25) {
  let s = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) s = lambda * (values[i] ?? 0) + (1 - lambda) * s;
  return s;
}

export function autocorr(a: number[], lag = 1) {
  if (a.length <= lag + 1) return 0;
  const m = mean(a);
  const v = a.reduce((s, x) => s + (x - m) ** 2, 0);
  if (!v) return 0;
  let c = 0;
  for (let i = lag; i < a.length; i++) c += ((a[i] ?? 0) - m) * ((a[i - lag] ?? 0) - m);
  return c / v;
}

export interface RunStats {
  current: number;
  max: number;
  count: number;
  rate: number;
  lengths: number[];
  meanLength: number;
}

/** Run statistics for a boolean predicate over a digit series. */
export function runs(ds: number[], p: (d: number) => boolean): RunStats {
  let cur = 0;
  let max = 0;
  let count = 0;
  const lengths: number[] = [];
  for (const d of ds) {
    if (p(d)) {
      cur++;
      count++;
      max = Math.max(max, cur);
    } else {
      if (cur > 0) lengths.push(cur);
      cur = 0;
    }
  }
  return {
    current: cur,
    max,
    count,
    rate: ds.length ? count / ds.length : 0,
    lengths,
    meanLength: mean(lengths),
  };
}

export interface HazardPoint {
  length: number;
  reached: number;
  ended: number;
  hazard: number;
  survival: number;
}

/**
 * Discrete hazard function of run continuation.
 * hazard(k) = P(run terminates at length k | run reached length k).
 * Observed frequencies only — never presented as a forward-looking probability.
 */
export function hazardFunction(ds: number[], p: (d: number) => boolean, maxLen = 8): HazardPoint[] {
  const r = runs(ds, p);
  const closed = r.current > 0 ? [...r.lengths, r.current] : r.lengths;
  const out: HazardPoint[] = [];
  let survival = 1;
  for (let k = 1; k <= maxLen; k++) {
    const reached = closed.filter((l) => l >= k).length;
    const ended = closed.filter((l) => l === k).length;
    const hazard = reached ? ended / reached : 0;
    out.push({ length: k, reached, ended, hazard: hazard * 100, survival: survival * 100 });
    survival *= 1 - hazard;
  }
  return out;
}

export function transitionCounts(ds: number[], bins = 10): number[][] {
  const m = Array.from({ length: bins }, () => Array(bins).fill(0) as number[]);
  for (let i = 1; i < ds.length; i++) {
    const a = ds[i - 1] ?? 0;
    const b = ds[i] ?? 0;
    const row = m[a];
    if (row) row[b] = (row[b] ?? 0) + 1;
  }
  return m;
}

/** Row-stochastic 10x10 Markov transition matrix. */
export function transition(ds: number[], bins = 10): number[][] {
  return transitionCounts(ds, bins).map((r) => {
    const n = r.reduce((s, x) => s + x, 0);
    return n ? r.map((x) => x / n) : r.map(() => 0);
  });
}

/** Mutual information between consecutive digits (bits). */
export function mutualInformation(ds: number[]): number {
  if (ds.length < 3) return 0;
  const c = transitionCounts(ds);
  const n = ds.length - 1;
  const px = Array(10).fill(0) as number[];
  const py = Array(10).fill(0) as number[];
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++) {
      const v = c[i]?.[j] ?? 0;
      px[i] = (px[i] ?? 0) + v;
      py[j] = (py[j] ?? 0) + v;
    }
  let mi = 0;
  for (let i = 0; i < 10; i++)
    for (let j = 0; j < 10; j++) {
      const v = c[i]?.[j] ?? 0;
      if (v) {
        const p = v / n;
        mi += p * Math.log2(p / Math.max(((px[i] ?? 0) / n) * ((py[j] ?? 0) / n), 1e-12));
      }
    }
  return Math.max(0, mi);
}

/** Conditional entropy H(next | current) in bits. */
export function conditionalEntropy(ds: number[]): number {
  const c = transitionCounts(ds);
  const n = Math.max(1, ds.length - 1);
  let h = 0;
  for (const r of c) {
    const row = r.reduce((s, x) => s + x, 0);
    if (!row) continue;
    for (const x of r) {
      if (x) h -= (x / n) * Math.log2(x / row);
    }
  }
  return h;
}

/** CUSUM-style change-point proxy comparing recent window to its own baseline. */
export function changePoint(values: number[]) {
  if (values.length < 20) return { score: 0, index: -1, z: 0 };
  const base = mean(values.slice(0, -10));
  const recent = mean(values.slice(-10));
  const s = sd(values.slice(0, -10)) || 1;
  const z = Math.abs(recent - base) / s;
  return { score: clamp(z * 20), index: values.length - 10, z };
}

/** Page-Hinkley style drift detector, scaled to 0-100. */
export function pageHinkley(values: number[], delta = 0.01, threshold = 5) {
  let avg = 0;
  let cum = 0;
  let min = 0;
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0;
    avg += (v - avg) / (i + 1);
    cum += v - avg - delta;
    min = Math.min(min, cum);
    max = Math.max(max, cum);
  }
  return clamp((Math.max(Math.abs(cum - min), Math.abs(cum - max)) / threshold) * 20);
}

/**
 * Last decimal digit of a Deriv quote.
 * Respects Deriv canonical pip_size (decimal precision) so trailing zeros (e.g. 4851.830 -> 0)
 * are accurately preserved and never truncated by JavaScript floating-point representations.
 */
export function lastDigit(q: number | string, pipSize?: number): number {
  if (typeof pipSize === "number" && pipSize >= 0) {
    const num = typeof q === "number" ? q : Number(q);
    if (Number.isFinite(num)) {
      const formatted = num.toFixed(pipSize);
      const lastChar = formatted[formatted.length - 1];
      const d = Number(lastChar);
      return Number.isFinite(d) && d >= 0 && d <= 9 ? d : 0;
    }
  }
  if (typeof q === "string" && q.includes(".")) {
    const clean = q.trim();
    const lastChar = clean[clean.length - 1];
    if (lastChar && /^\d$/.test(lastChar)) {
      return Number(lastChar);
    }
  }
  const m = String(q).match(/(\d)(?!.*\d)/);
  return m?.[1] ? Number(m[1]) : 0;
}

export const zoneOf = (d: number) => (d <= 6 ? "LOW" : "HIGH");
export const parityOf = (d: number) => (d % 2 ? "ODD" : "EVEN");
export const isLow = (d: number) => d <= 6;
export const isHigh = (d: number) => d >= 7;
export const isEven = (d: number) => d % 2 === 0;

export const contractMask = (kind: "OVER" | "UNDER", barrier: number, d: number) =>
  kind === "OVER" ? d > barrier : d < barrier;
