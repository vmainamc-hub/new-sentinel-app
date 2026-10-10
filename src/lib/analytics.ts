// Statistical + probabilistic engines for Deriv Edge AI
export type Tick = { t: number; price: number };

export const lastDigit = (p: number) => Math.abs(Math.round(p * 100)) % 10;

export function generateTick(prev: number, volatility = 0.0008): number {
  // GBM-ish synthetic tick
  const drift = 0;
  const z = (Math.random() + Math.random() + Math.random() - 1.5) * 1.4;
  return Math.max(0.0001, prev * (1 + drift + volatility * z));
}

export function rollingWindow<T>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

// ---------- Even / Odd ----------
export function evenOddStats(ticks: Tick[]) {
  const digits = ticks.map((t) => lastDigit(t.price));
  const even = digits.filter((d) => d % 2 === 0).length;
  const odd = digits.length - even;
  // current streak
  let streak = 1;
  const streakType: "even" | "odd" = digits[digits.length - 1] % 2 === 0 ? "even" : "odd";
  for (let i = digits.length - 2; i >= 0; i--) {
    const t = digits[i] % 2 === 0 ? "even" : "odd";
    if (t === streakType) streak++;
    else break;
  }
  const pEven = even / Math.max(1, digits.length);
  const pOdd = 1 - pEven;
  // entropy
  const H = -(pEven * Math.log2(pEven || 1) + pOdd * Math.log2(pOdd || 1));
  // Markov transition
  let ee = 0,
    eo = 0,
    oe = 0,
    oo = 0;
  for (let i = 1; i < digits.length; i++) {
    const a = digits[i - 1] % 2,
      b = digits[i] % 2;
    if (a === 0 && b === 0) ee++;
    else if (a === 0 && b === 1) eo++;
    else if (a === 1 && b === 0) oe++;
    else oo++;
  }
  const fromE = ee + eo || 1,
    fromO = oe + oo || 1;
  const transition = { ee: ee / fromE, eo: eo / fromE, oe: oe / fromO, oo: oo / fromO };
  const last = digits[digits.length - 1] % 2;
  const nextEven = last === 0 ? transition.ee : transition.oe;
  // Bayesian smoothing
  const alpha = 4;
  const nextEvenSmoothed =
    ((last === 0 ? ee : oe) + alpha) / ((last === 0 ? fromE : fromO) + 2 * alpha);
  const continuation = streakType === "even" ? nextEvenSmoothed : 1 - nextEvenSmoothed;
  const reversal = 1 - continuation;
  // momentum: weighted recent bias
  let mom = 0,
    w = 0;
  digits.slice(-20).forEach((d, i) => {
    const ww = i + 1;
    mom += (d % 2 === 0 ? 1 : -1) * ww;
    w += ww;
  });
  const momentum = mom / w;
  return {
    even,
    odd,
    pEven,
    pOdd,
    entropy: H,
    streak,
    streakType,
    transition,
    nextEvenProb: nextEvenSmoothed,
    nextOddProb: 1 - nextEvenSmoothed,
    continuation,
    reversal,
    momentum,
  };
}

export function predictNextEvenOdd(ticks: Tick[], n = 10) {
  const stats = evenOddStats(ticks);
  const seq: { label: "EVEN" | "ODD"; conf: number }[] = [];
  let last = lastDigit(ticks[ticks.length - 1].price) % 2;
  for (let i = 0; i < n; i++) {
    const p = last === 0 ? stats.transition.ee : stats.transition.oe;
    const evenP = p * 0.6 + stats.pEven * 0.4;
    const label: "EVEN" | "ODD" = evenP >= 0.5 ? "EVEN" : "ODD";
    const conf = Math.round(Math.max(evenP, 1 - evenP) * 100);
    seq.push({ label, conf });
    last = label === "EVEN" ? 0 : 1;
  }
  return seq;
}

// ---------- Rise / Fall ----------
export function sma(arr: number[], n: number) {
  if (arr.length < n) return arr.reduce((a, b) => a + b, 0) / arr.length;
  const s = arr.slice(-n);
  return s.reduce((a, b) => a + b, 0) / n;
}
export function rsi(prices: number[], n = 14) {
  if (prices.length < n + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = prices.length - n; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d >= 0) gains += d;
    else losses -= d;
  }
  const rs = gains / (losses || 1e-9);
  return 100 - 100 / (1 + rs);
}
export function ema(arr: number[], n: number) {
  if (!arr.length) return 0;
  const k = 2 / (n + 1);
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
export function macd(prices: number[]) {
  const m = ema(prices, 12) - ema(prices, 26);
  const sig = ema(prices.slice(-30), 9);
  return { macd: m, signal: sig, hist: m - sig };
}
export function volatility(prices: number[], n = 30) {
  const s = prices.slice(-n);
  if (s.length < 2) return 0;
  const rets = s.slice(1).map((p, i) => Math.log(p / s[i]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(v) * 100;
}
export function riseFallStats(ticks: Tick[]) {
  const prices = ticks.map((t) => t.price);
  const dirs = prices.slice(1).map((p, i) => (p > prices[i] ? 1 : p < prices[i] ? -1 : 0));
  const rises = dirs.filter((d) => d > 0).length;
  const falls = dirs.filter((d) => d < 0).length;
  let streak = 1;
  const lastDir = dirs[dirs.length - 1];
  for (let i = dirs.length - 2; i >= 0; i--) {
    if (dirs[i] === lastDir && lastDir !== 0) streak++;
    else break;
  }
  const r = rsi(prices),
    m = macd(prices),
    v = volatility(prices);
  const sma10 = sma(prices, 10),
    sma50 = sma(prices, 50);
  const trendStrength = ((sma10 - sma50) / sma50) * 1000;
  // probability of next rise via logistic on momentum + rsi deviation
  const features = 0.4 * (trendStrength / 5) + 0.3 * ((r - 50) / 50) + 0.3 * Math.sign(m.hist);
  const pRise = 1 / (1 + Math.exp(-features * 1.5));
  return {
    rises,
    falls,
    streak,
    lastDir,
    rsi: r,
    macd: m,
    volatility: v,
    sma10,
    sma50,
    trendStrength,
    pRise,
    pFall: 1 - pRise,
    exhaustion: r > 75 || r < 25,
    acceleration: Math.abs(m.hist) > Math.abs(m.signal) * 0.5,
  };
}

// ---------- Over / Under ----------
export function overUnderStats(ticks: Tick[], threshold = 5) {
  const digits = ticks.map((t) => lastDigit(t.price));
  const freq = new Array(10).fill(0);
  digits.forEach((d) => freq[d]++);
  const over = digits.filter((d) => d > threshold).length;
  const under = digits.filter((d) => d < threshold).length;
  const total = digits.length;
  const pOver = over / total,
    pUnder = under / total;
  // chi-square vs uniform
  const expected = total / 10;
  const chi = freq.reduce((acc, f) => acc + (f - expected) ** 2 / expected, 0);
  const anomaly = Math.min(1, chi / 30);
  return { freq, over, under, pOver, pUnder, chi, anomaly, threshold };
}

// ---------- Matches / Differs ----------
export function matchDiffStats(ticks: Tick[]) {
  const digits = ticks.map((t) => lastDigit(t.price));
  const freq = new Array(10).fill(0);
  digits.forEach((d) => freq[d]++);
  const total = digits.length;
  const probs = freq.map((f) => f / total);
  const mostLikely = probs.indexOf(Math.max(...probs));
  const leastLikely = probs.indexOf(Math.min(...probs));
  // repetition: how often same digit follows
  let reps = 0;
  for (let i = 1; i < digits.length; i++) if (digits[i] === digits[i - 1]) reps++;
  const pMatch = reps / Math.max(1, digits.length - 1);
  return { freq, probs, mostLikely, leastLikely, pMatch, pDiffer: 1 - pMatch };
}

// ---------- Monte Carlo continuation ----------
export function monteCarlo(ticks: Tick[], steps = 50, runs = 200) {
  const prices = ticks.map((t) => t.price);
  const vol = volatility(prices) / 100 || 0.001;
  const last = prices[prices.length - 1];
  const paths: number[][] = [];
  for (let r = 0; r < runs; r++) {
    const p = [last];
    for (let s = 0; s < steps; s++) p.push(generateTick(p[s], vol));
    paths.push(p);
  }
  // confidence band
  const band = Array.from({ length: steps + 1 }, (_, i) => {
    const col = paths.map((p) => p[i]).sort((a, b) => a - b);
    return {
      i,
      lo: col[Math.floor(col.length * 0.1)],
      mid: col[Math.floor(col.length * 0.5)],
      hi: col[Math.floor(col.length * 0.9)],
    };
  });
  const finals = paths.map((p) => p[p.length - 1]);
  const pUp = finals.filter((f) => f > last).length / runs;
  return { band, pUp, pDown: 1 - pUp };
}

// ---------- Market Intelligence ----------
export function marketIntel(ticks: Tick[]) {
  const eo = evenOddStats(ticks);
  const rf = riseFallStats(ticks);
  const ou = overUnderStats(ticks);
  const md = matchDiffStats(ticks);
  const streakPressure = Math.min(1, eo.streak / 8);
  const crowdBias = (rf.pRise - 0.5) * 2; // -1..1
  const manipulation = ou.anomaly * 0.5 + (md.pMatch > 0.18 ? 0.4 : 0) + (eo.streak > 6 ? 0.2 : 0);
  const reversalZone = (rf.rsi > 72 || rf.rsi < 28) && eo.streak > 4;
  const edgeScore = Math.round(
    Math.abs(crowdBias) * 30 +
      (1 - eo.entropy) * 25 +
      ou.anomaly * 25 +
      (rf.acceleration ? 10 : 0) +
      (reversalZone ? 10 : 0),
  );
  return {
    streakPressure,
    crowdBias,
    manipulation: Math.min(1, manipulation),
    reversalZone,
    edgeScore,
    volatilityIndex: rf.volatility,
    trendStrength: rf.trendStrength,
    momentumExhaustion: rf.exhaustion,
  };
}

// ---------- Safe barrier digit picker ----------
// For OVER/UNDER trades, find the safest barrier digit (0-9) so that the
// contract is most likely to win N consecutive runs in a row.
//   side="OVER"  -> contract wins when next digit > barrier (barrier 0..8)
//   side="UNDER" -> contract wins when next digit < barrier (barrier 1..9)
// Picks the barrier maximising survival = p(win)^runs while still respecting
// the trade direction (highest barrier for OVER, lowest for UNDER) when ties.
export function pickSafeBarrier(
  ticks: Tick[],
  side: "OVER" | "UNDER",
  runs = 5,
  minSurvival = 0.8,
): { barrier: number; pWin: number; survival: number } {
  const f = new Array(10).fill(0);
  for (const tk of ticks) f[lastDigit(tk.price)]++;
  const total = Math.max(1, ticks.length);

  if (side === "OVER") {
    // prefer highest barrier whose 5-run survival ≥ minSurvival
    let best = { barrier: 0, pWin: 0, survival: 0 };
    for (let b = 0; b <= 8; b++) {
      let count = 0;
      for (let d = b + 1; d <= 9; d++) count += f[d];
      const p = count / total;
      const surv = Math.pow(p, runs);
      if (surv >= minSurvival && b >= best.barrier) {
        best = { barrier: b, pWin: p, survival: surv };
      }
    }
    if (best.pWin === 0) {
      // fallback: barrier 0 (safest, widest win range)
      let count = 0;
      for (let d = 1; d <= 9; d++) count += f[d];
      const p = count / total;
      best = { barrier: 0, pWin: p, survival: Math.pow(p, runs) };
    }
    return best;
  } else {
    let best = { barrier: 9, pWin: 0, survival: 0 };
    for (let b = 9; b >= 1; b--) {
      let count = 0;
      for (let d = 0; d < b; d++) count += f[d];
      const p = count / total;
      const surv = Math.pow(p, runs);
      if (surv >= minSurvival && b <= best.barrier) {
        best = { barrier: b, pWin: p, survival: surv };
      }
    }
    if (best.pWin === 0) {
      let count = 0;
      for (let d = 0; d <= 8; d++) count += f[d];
      const p = count / total;
      best = { barrier: 9, pWin: p, survival: Math.pow(p, runs) };
    }
    return best;
  }
}
