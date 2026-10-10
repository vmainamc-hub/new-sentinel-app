// APEX SENTINEL — independent quantitative engines.
// Every function here is pure: (digits/prices) -> typed measurement.
// No randomness, no placeholders, no AI. Sample sizes are always reported so
// the layers above can refuse to act on thin data.
import type {
  AnomalyOut,
  DigitLifecycle,
  DigitStatsOut,
  EntropyOut,
  HiddenBuildupOut,
  MarketQualityOut,
  PersonalityOut,
  PressureOut,
  RegimeOut,
  SequenceOut,
  TransitionOut,
  TrendOut,
  VolatilityOut,
} from "./types";

export const WINDOW_BASE = 1000;
export const WINDOW_MID = 300;
export const WINDOW_RECENT = 120;
export const WINDOW_MICRO = 40;

export const clamp = (x: number, lo = 0, hi = 100) =>
  Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo;

export function tail<T>(arr: T[], n: number): T[] {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

function share(digits: number[]): number[] {
  const c = new Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) c[d]++;
  const n = digits.length || 1;
  return c.map((x) => x / n);
}

function counts(digits: number[]): number[] {
  const c = new Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) c[d]++;
  return c;
}

/** Wilson score lower bound for a binomial proportion (95%). */
export function wilsonLower(successes: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / den);
}

// ── 1. DIGIT STATISTICS ────────────────────────────────────────────────
export function digitStatistics(digits: number[]): DigitStatsOut {
  const base = tail(digits, WINDOW_BASE);
  const n = base.length;
  const freq = counts(base);
  const pct = share(base);
  const midPct = share(tail(digits, WINDOW_MID));
  const recentPct = share(tail(digits, WINDOW_RECENT));
  const microPct = share(tail(digits, WINDOW_MICRO));
  const p0 = 0.1;
  const se = Math.sqrt((p0 * (1 - p0)) / Math.max(1, n));
  const z = pct.map((p) => (p - p0) / (se || 1));
  let dominant = 0;
  let suppressed = 0;
  for (let d = 1; d < 10; d++) {
    if (freq[d] > freq[dominant]) dominant = d;
    if (freq[d] < freq[suppressed]) suppressed = d;
  }
  return {
    n,
    freq,
    pct,
    midPct,
    recentPct,
    microPct,
    z,
    lastDigit: base.length ? base[base.length - 1] : -1,
    dominant,
    suppressed,
  };
}

// ── 2. PRESSURE / LIFECYCLE / EXHAUSTION / MIGRATION ───────────────────
export function digitPressure(s: DigitStatsOut): PressureOut {
  const pressure = new Array(10).fill(0);
  const impulse = new Array(10).fill(0);
  const exhaustion = new Array(10).fill(0);
  const lifecycle: DigitLifecycle[] = new Array(10).fill("neutral");

  for (let d = 0; d < 10; d++) {
    pressure[d] = s.recentPct[d] - s.pct[d];
    impulse[d] = s.microPct[d] - s.recentPct[d];

    const midUp = s.midPct[d] - s.pct[d];
    const recUp = s.recentPct[d] - s.midPct[d];
    const micUp = s.microPct[d] - s.recentPct[d];

    // Lifecycle from the direction of three successive window deltas.
    if (midUp > 0.008 && recUp > 0.004) lifecycle[d] = "dominant";
    else if (recUp > 0.01 && micUp >= 0) lifecycle[d] = "emerging";
    else if (midUp > 0.006 && micUp < -0.012) lifecycle[d] = "exhausting";
    else if (s.recentPct[d] < 0.055 && micUp <= 0) lifecycle[d] = "suppressed";
    else if (s.pct[d] < 0.09 && recUp > 0.008) lifecycle[d] = "recovering";

    // Exhaustion: was over-represented, now decaying.
    const over = Math.max(0, s.midPct[d] - 0.1);
    const decay = Math.max(0, s.recentPct[d] - s.microPct[d]);
    exhaustion[d] = clamp((over * 6 + decay * 6) as number, 0, 1);
  }

  const zoneAShare = s.recentPct.slice(0, 5).reduce((a, b) => a + b, 0);
  const zoneBShare = s.recentPct.slice(5).reduce((a, b) => a + b, 0);
  const baseB = s.pct.slice(5).reduce((a, b) => a + b, 0);
  return {
    pressure,
    impulse,
    lifecycle,
    exhaustion,
    zoneAShare,
    zoneBShare,
    migration: zoneBShare - baseB,
  };
}

// ── 3. TRANSITION (first-order Markov chain) ───────────────────────────
export function transitions(digits: number[]): TransitionOut {
  const seq = tail(digits, WINDOW_BASE);
  const n = seq.length;
  if (n < 60) {
    return { n, nextDist: new Array(10).fill(0.1), rowN: 0, dependency: 0 };
  }
  const m: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const rowTotals = new Array(10).fill(0);
  for (let i = 1; i < n; i++) {
    const a = seq[i - 1];
    const b = seq[i];
    if (a < 0 || a > 9 || b < 0 || b > 9) continue;
    m[a][b]++;
    rowTotals[a]++;
  }
  const cur = seq[n - 1];
  const rowN = rowTotals[cur] ?? 0;
  const nextDist = rowN >= 20 ? m[cur].map((c) => c / rowN) : new Array(10).fill(0.1);

  // Dependency: mean absolute divergence of each row from the marginal.
  const marginal = share(seq);
  let acc = 0;
  let rows = 0;
  for (let a = 0; a < 10; a++) {
    if (rowTotals[a] < 20) continue;
    let dv = 0;
    for (let b = 0; b < 10; b++) dv += Math.abs(m[a][b] / rowTotals[a] - marginal[b]);
    acc += dv / 2;
    rows++;
  }
  return {
    n,
    nextDist,
    rowN,
    dependency: rows ? clamp(acc / rows, 0, 1) : 0,
  };
}

// ── 4. SEQUENCE / PATTERN ──────────────────────────────────────────────
export function sequencePattern(digits: number[], winners: number[]): SequenceOut {
  const seq = tail(digits, WINDOW_RECENT);
  let repeats = 0;
  let alternations = 0;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) repeats++;
    if (seq[i] > 4 !== seq[i - 1] > 4) alternations++;
  }
  const win = new Set(winners);
  let maxRun = 0;
  let run = 0;
  for (const d of seq) {
    if (win.has(d)) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else run = 0;
  }
  let currentRun = 0;
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i] === seq[seq.length - 1]) currentRun++;
    else break;
  }
  const den = Math.max(1, seq.length - 1);
  return {
    repeatRate: repeats / den,
    alternationRate: alternations / den,
    maxRunWinners: maxRun,
    currentRun,
    runDigit: seq.length ? seq[seq.length - 1] : -1,
  };
}

// ── 5. ENTROPY / DISTRIBUTION ──────────────────────────────────────────
export function entropyEngine(s: DigitStatsOut): EntropyOut {
  let h = 0;
  for (const p of s.pct) if (p > 0) h -= p * Math.log(p);
  const entropy = h / Math.log(10);
  const expected = s.n / 10;
  let chi2 = 0;
  if (expected > 0) {
    for (const f of s.freq) chi2 += ((f - expected) * (f - expected)) / expected;
  }
  return { entropy, chi2, uniformityFail: chi2 > 16.92 };
}

// ── 6. ANOMALY ─────────────────────────────────────────────────────────
export function anomalyEngine(s: DigitStatsOut, ent: EntropyOut, seq: SequenceOut): AnomalyOut {
  const reasons: string[] = [];
  let score = 0;
  const maxZ = Math.max(...s.z.map(Math.abs));
  if (maxZ > 3) {
    score += Math.min(35, (maxZ - 3) * 14);
    reasons.push(`Digit distribution ${maxZ.toFixed(1)}σ from uniform.`);
  }
  if (ent.entropy < 0.965) {
    score += (0.965 - ent.entropy) * 900;
    reasons.push(`Entropy compressed to ${(ent.entropy * 100).toFixed(1)}%.`);
  }
  if (seq.repeatRate > 0.16) {
    score += (seq.repeatRate - 0.16) * 200;
    reasons.push(`Repeat rate ${(seq.repeatRate * 100).toFixed(1)}% vs 10% expected.`);
  }
  if (seq.currentRun >= 4) {
    score += seq.currentRun * 4;
    reasons.push(`Digit ${seq.runDigit} repeated ${seq.currentRun}× consecutively.`);
  }
  return { score: clamp(score), reasons };
}

// ── 7. VOLATILITY ──────────────────────────────────────────────────────
export function volatilityEngine(prices: number[]): VolatilityOut {
  const rets = (arr: number[]) => {
    const out: number[] = [];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i - 1] > 0) out.push(Math.log(arr[i] / arr[i - 1]));
    }
    return out;
  };
  const sd = (a: number[]) => {
    if (a.length < 2) return 0;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
  };
  const base = sd(rets(tail(prices, WINDOW_BASE)));
  const recent = sd(rets(tail(prices, WINDOW_RECENT)));
  const ratio = base > 0 ? recent / base : 1;
  const label: VolatilityOut["label"] =
    ratio < 0.7 ? "calm" : ratio < 1.25 ? "normal" : ratio < 1.8 ? "elevated" : "violent";
  return { base, recent, ratio, label };
}

// ── 8. TREND / MOMENTUM / RED-GREEN BARS ───────────────────────────────
export function trendEngine(prices: number[]): TrendOut {
  const p = tail(prices, WINDOW_RECENT);
  if (p.length < 10) return { slopePctPer100: 0, greenRate: 0.5, momentum: 0, label: "flat" };
  let green = 0;
  for (let i = 1; i < p.length; i++) if (p[i] > p[i - 1]) green++;
  const greenRate = green / (p.length - 1);
  const first = p[0];
  const last = p[p.length - 1];
  const slopePctPer100 = first > 0 ? ((last - first) / first) * (100 / p.length) * 100 : 0;
  const momentum = clamp((greenRate - 0.5) * 4, -1, 1);
  return {
    slopePctPer100,
    greenRate,
    momentum,
    label: momentum > 0.15 ? "up" : momentum < -0.15 ? "down" : "flat",
  };
}

// ── 9. REGIME ──────────────────────────────────────────────────────────
export function regimeEngine(
  ent: EntropyOut,
  vol: VolatilityOut,
  trend: TrendOut,
  pres: PressureOut,
): RegimeOut {
  const skew = Math.abs(pres.zoneAShare - 0.5);
  if (vol.label === "violent" || ent.entropy < 0.955) {
    return {
      label: "CHAOTIC",
      confidence: clamp(60 + (1 - ent.entropy) * 900),
      detail: `Volatility ${vol.ratio.toFixed(2)}× baseline, entropy ${(ent.entropy * 100).toFixed(1)}%.`,
    };
  }
  if (skew > 0.06) {
    return {
      label: "SKEWED",
      confidence: clamp(50 + skew * 500),
      detail: `Zone A share ${(pres.zoneAShare * 100).toFixed(1)}% vs 50% neutral.`,
    };
  }
  if (Math.abs(trend.momentum) > 0.3) {
    return {
      label: "TRENDING",
      confidence: clamp(45 + Math.abs(trend.momentum) * 60),
      detail: `Directional bars ${(trend.greenRate * 100).toFixed(0)}% green.`,
    };
  }
  if (vol.label === "calm") {
    return {
      label: "COMPRESSED",
      confidence: clamp(50 + (1 - vol.ratio) * 90),
      detail: `Realised volatility ${vol.ratio.toFixed(2)}× baseline.`,
    };
  }
  return {
    label: "BALANCED",
    confidence: clamp(40 + ent.entropy * 50),
    detail: `Distribution near uniform (χ² ${ent.chi2.toFixed(1)}).`,
  };
}

// ── 10. DIGIT PERSONALITY ──────────────────────────────────────────────
export function personalityEngine(digits: number[]): PersonalityOut {
  const seq = tail(digits, WINDOW_BASE);
  const lastIdx = new Array(10).fill(-1);
  const gapSum = new Array(10).fill(0);
  const gapCnt = new Array(10).fill(0);
  const selfNext = new Array(10).fill(0);
  const occur = new Array(10).fill(0);
  for (let i = 0; i < seq.length; i++) {
    const d = seq[i];
    if (d < 0 || d > 9) continue;
    if (lastIdx[d] >= 0) {
      gapSum[d] += i - lastIdx[d];
      gapCnt[d]++;
    }
    lastIdx[d] = i;
    occur[d]++;
    if (i + 1 < seq.length && seq[i + 1] === d) selfNext[d]++;
  }
  const base = share(seq);
  return {
    meanGap: gapSum.map((g, d) => (gapCnt[d] ? g / gapCnt[d] : 0)),
    sinceSeen: lastIdx.map((i) => (i < 0 ? seq.length : seq.length - 1 - i)),
    stickiness: selfNext.map((c, d) => (occur[d] > 0 && base[d] > 0 ? c / occur[d] / base[d] : 0)),
  };
}

// ── 11. HIDDEN BUILDUP ─────────────────────────────────────────────────
export function hiddenBuildup(s: DigitStatsOut, p: PressureOut): HiddenBuildupOut {
  const quiet: number[] = [];
  let score = 0;
  for (let d = 0; d < 10; d++) {
    // Base share still ordinary, but the fast windows are stacking up.
    const stealth = p.pressure[d] > 0.012 && Math.abs(s.z[d]) < 2 && p.impulse[d] > 0;
    if (stealth) {
      quiet.push(d);
      score += p.pressure[d] * 900;
    }
  }
  return {
    score: clamp(score),
    digits: quiet,
    detail: quiet.length
      ? `Digits ${quiet.join(", ")} accumulating without breaching distribution limits.`
      : "No stealth accumulation detected.",
  };
}

// ── 12. MARKET QUALITY ─────────────────────────────────────────────────
export function marketQuality(
  s: DigitStatsOut,
  ent: EntropyOut,
  vol: VolatilityOut,
  anomaly: AnomalyOut,
): MarketQualityOut {
  const sample = clamp((s.n / WINDOW_BASE) * 100);
  const cleanliness = clamp(100 - anomaly.score);
  const stability = clamp(100 - Math.abs(1 - vol.ratio) * 90);
  const structure = clamp(ent.entropy * 100);
  const score = clamp(sample * 0.3 + cleanliness * 0.3 + stability * 0.2 + structure * 0.2);
  return {
    score,
    detail: `sample ${s.n}/${WINDOW_BASE}, anomaly ${anomaly.score.toFixed(0)}, vol ${vol.ratio.toFixed(2)}×`,
  };
}
