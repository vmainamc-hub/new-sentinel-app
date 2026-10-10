/** Liquidity Intelligence V3. 1000 ticks define psychology; shorter windows only measure temporal behaviour. */
export const V3_WINDOWS = [10, 20, 30, 60, 120, 240, 500, 1000] as const;
export type Side = "OVER" | "UNDER";
export type Lifecycle =
  | "NO_LIQUIDITY"
  | "FORMING"
  | "BUILDING"
  | "MATURE"
  | "EXHAUSTION_WATCH"
  | "EXHAUSTION_CONFIRMED"
  | "DELIVERY"
  | "DELIVERY_ACCELERATING"
  | "ABSORBING"
  | "RELEASE_WATCH"
  | "RELEASE"
  | "RIPE"
  | "CONFIRMED"
  | "INVALIDATED"
  | "BLOCKED"
  | "CONFLICTED";
export interface V3Tick {
  d: number;
  t?: number;
  q?: number;
}
export interface Psychology1000 {
  window: 1000;
  green: number;
  secondGreen: number;
  red: number;
  secondRed: number;
  purple: number | null;
  pct: number[];
  pressure: number[];
  winners: number[];
  losers: number[];
  valid: boolean;
  outcome: "ACCEPT" | "WATCH" | "REJECT";
  reasons: string[];
}
export interface DigitTemporal {
  digit: number;
  rates: Record<number, number>;
  slope: number;
  slope20_60: number;
  slope60_120: number;
  slope120_240: number;
  slope240_500: number;
  shortLongDivergence: number;
  ewma: number;
  ewmaSlope: number;
  cusum: number;
  changePoint: number;
  dormant: boolean;
  delivering: boolean;
  accelerating: boolean;
}
export interface TransitionEvidence {
  from: number[];
  to: number[];
  recent: number;
  baseline: number;
  delta: number;
  strength: number;
}
export interface LiquidityOpportunity {
  key: string;
  market: string;
  contract: string;
  side: Side;
  barrier: number;
  psychology: Psychology1000;
  reservoirDigits: number[];
  dominantDigits: number[];
  reservoirScore: number;
  exhaustionScore: number;
  deliveryScore: number;
  migrationScore: number;
  absorptionScore: number;
  confirmationScore: number;
  conflictScore: number;
  ageTicks: number;
  lifecycle: Lifecycle;
  previousLifecycle: Lifecycle | null;
  birthTick: number;
  lastTick: number;
  trajectory: number[];
  evidence: string[];
  vetoes: string[];
  temporal: Record<number, DigitTemporal>;
  transitions: TransitionEvidence[];
  entropyVelocity: number;
  entropyAcceleration: number;
  jsd: number;
}
const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (ds: number[]) => {
  const c = Array(10).fill(0);
  for (const d of ds) if (d >= 0 && d < 10) c[d]++;
  const n = Math.max(1, ds.length);
  return c.map((x) => x / n);
};
const entropy = (p: number[]) =>
  -p.reduce((s, x) => s + (x > 0 ? x * Math.log2(x) : 0), 0) / Math.log2(10);
const jsd = (a: number[], b: number[]) => {
  const m = a.map((x, i) => (x + b[i]) / 2);
  const kl = (x: number[], y: number[]) =>
    x.reduce((s, v, i) => s + (v > 0 ? v * Math.log2(v / Math.max(y[i], 1e-9)) : 0), 0);
  return Math.max(0, (kl(a, m) + kl(b, m)) / 2);
};

/** Exact Sentinel psychology contract, anchored ONLY to the 1000-tick sample. */
export function buildPsychology1000(ticks: V3Tick[], side: Side, barrier: number): Psychology1000 {
  const ds = ticks.slice(-1000).map((x) => x.d),
    p = pct(ds),
    half = Math.max(1, Math.floor(ds.length / 2));
  const first = pct(ds.slice(0, half)),
    second = pct(ds.slice(half));
  // Pressure is internal to the same 1000 ticks: second half minus first half.
  const pressure = p.map((_, d) => (second[d] ?? 0) - (first[d] ?? 0));
  const byFreq = [...Array(10).keys()].sort((a, b) => p[b] - p[a] || a - b);
  const green = byFreq[0],
    secondGreen = byFreq[1],
    red = byFreq[9],
    secondRed = byFreq[8];
  let purple: number | null = null,
    best = 0.005;
  for (let d = 0; d < 10; d++)
    if (pressure[d] > best) {
      best = pressure[d];
      purple = d;
    }
  const winners = [...Array(10).keys()].filter((d) =>
      side === "OVER" ? d > barrier : d < barrier,
    ),
    losers = [...Array(10).keys()].filter((d) => !winners.includes(d));
  const reasons: string[] = [];
  const bars = [green, secondGreen, red, secondRed, ...(purple === null ? [] : [purple])];
  const losingBars = bars.filter((d) => losers.includes(d)).length;
  if (losingBars > 2) reasons.push(`${losingBars}/5 psychological bars are in losing zone`);
  if (losers.includes(red)) reasons.push(`Red d${red} is in losing zone`);
  if (losers.includes(secondRed)) reasons.push(`2nd Red d${secondRed} is in losing zone`);
  if (losers.includes(secondGreen)) reasons.push(`2nd Green d${secondGreen} is in losing zone`);
  if (purple !== null && losers.includes(purple))
    reasons.push(`Purple d${purple} is growing in losing zone`);
  const gp = p[green];
  if (losers.includes(green)) {
    if (gp < 0.105) reasons.push(`Green d${green} is losing-side and below 10.5% exhaustion`);
    else if (pressure[green] > 0.005)
      reasons.push(`Green d${green} is elevated but still increasing`);
  } else {
    if (side === "UNDER" && green % 2 === 0) reasons.push(`UNDER Green d${green} must be odd`);
    if (side === "OVER" && green % 2 !== 0) reasons.push(`OVER Green d${green} must be even`);
  }
  if (!losers.includes(red)) {
    if (side === "UNDER" && (red % 2 !== 0 || red === 8))
      reasons.push(`UNDER Red d${red} must be even and never 8`);
    if (side === "OVER" && (red % 2 === 0 || red === 1))
      reasons.push(`OVER Red d${red} must be odd and never 1`);
  }
  if (side === "UNDER" && p[9] >= 0.105 && pressure[9] > 0.005)
    reasons.push("UNDER digit 9 is elevated but not releasing");
  if (side === "OVER" && p[0] >= 0.105 && pressure[0] > 0.005)
    reasons.push("OVER digit 0 is elevated but not releasing");
  const valid = ds.length >= 1000 && reasons.length === 0;
  return {
    window: 1000,
    green,
    secondGreen,
    red,
    secondRed,
    purple,
    pct: p,
    pressure,
    winners,
    losers,
    valid,
    outcome: valid ? "ACCEPT" : ds.length >= 1000 && reasons.length <= 1 ? "WATCH" : "REJECT",
    reasons,
  };
}
function ewma(a: number[], lambda = 0.2) {
  if (!a.length) return 0;
  let z = a[0];
  for (let i = 1; i < a.length; i++) z = lambda * a[i] + (1 - lambda) * z;
  return z;
}
function cusum(a: number[], target: number) {
  let pos = 0,
    neg = 0,
    peak = 0;
  const k = Math.max(0.0005, Math.abs(target) * 0.08);
  for (const v of a) {
    pos = Math.max(0, pos + v - target - k);
    neg = Math.min(0, neg + v - target + k);
    peak = Math.max(peak, pos, -neg);
  }
  return clamp(peak * 900);
}
function changePoint(a: number[]) {
  if (a.length < 12) return 0;
  const h = Math.floor(a.length / 2),
    m = mean(a),
    a1 = mean(a.slice(0, h)),
    a2 = mean(a.slice(h)),
    v = mean(a.map((x) => (x - m) ** 2));
  return clamp((Math.abs(a2 - a1) / Math.sqrt(v + 1e-7)) * 18);
}
export function rateSeries(ds: number[], d: number) {
  const r: Record<number, number> = {};
  for (const w of V3_WINDOWS) r[w] = pct(ds.slice(-w))[d] ?? 0;
  return r;
}
export function temporalFor(ds: number[], d: number): DigitTemporal {
  const r = rateSeries(ds, d);
  const series = ds.slice(-120).map((_, i, a) => {
    const end = ds.length - a.length + i + 1;
    return pct(ds.slice(Math.max(0, end - 20), end))[d] ?? 0;
  });
  const target = r[120] ?? r[1000],
    e = ewma(series),
    cp = changePoint(series),
    c = cusum(series, target);
  const s20 = r[20] - r[60],
    s60 = r[60] - r[120],
    s120 = r[120] - r[240],
    s240 = r[240] - r[500],
    div = r[20] - r[500],
    es = e - r[120];
  return {
    digit: d,
    rates: r,
    slope: s20,
    slope20_60: s20,
    slope60_120: s60,
    slope120_240: s120,
    slope240_500: s240,
    shortLongDivergence: div,
    ewma: e,
    ewmaSlope: es,
    cusum: c,
    changePoint: cp,
    dormant: Math.abs(div) < 0.012 && Math.abs(s20) < 0.006,
    delivering: s20 > 0.004 && s60 > 0,
    accelerating: s20 > 0.006 && s20 > s60,
  };
}
export function transitionEvidence(ds: number[], from: number[], to: number[]): TransitionEvidence {
  const calc = (x: number[]) => {
    let n = 0,
      h = 0;
    for (let i = 0; i < x.length - 1; i++)
      if (from.includes(x[i])) {
        n++;
        if (to.includes(x[i + 1])) h++;
      }
    return n ? h / n : 0;
  };
  const recent = calc(ds.slice(-500)),
    baseline = calc(ds.slice(-1000, -500));
  return {
    from,
    to,
    recent,
    baseline,
    delta: recent - baseline,
    strength: clamp((recent - baseline) * 700),
  };
}

export interface MarketSentinelPsychology {
  window: 1000;
  sampleSize: number;
  green: number;
  secondGreen: number;
  red: number;
  secondRed: number;
  purple: number | null;
  pct: number[];
  pressure: number[];
  byFreq: number[];
  valid: boolean;
  outcome: "ACCEPT" | "WATCH" | "REJECT";
  reasons: string[];
}

export function getMarketSentinelPsychology(ticks: V3Tick[]): MarketSentinelPsychology {
  const ds = ticks.slice(-1000).map((x) => x.d);
  const p = pct(ds);
  const half = Math.max(1, Math.floor(ds.length / 2));
  const first = pct(ds.slice(0, half));
  const second = pct(ds.slice(half));
  const pressure = p.map((_, d) => (second[d] ?? 0) - (first[d] ?? 0));
  const byFreq = [...Array(10).keys()].sort((a, b) => p[b] - p[a] || a - b);
  const green = byFreq[0] ?? 0;
  const secondGreen = byFreq[1] ?? 1;
  const red = byFreq[9] ?? 9;
  const secondRed = byFreq[8] ?? 8;
  let purple: number | null = null;
  let best = 0.005;
  for (let d = 0; d < 10; d++) {
    if (pressure[d] > best) {
      best = pressure[d];
      purple = d;
    }
  }

  const reasons: string[] = [];
  if (ds.length < 1000) {
    reasons.push(`Canonical baseline accumulating: ${ds.length}/1000 ticks observed`);
  } else {
    reasons.push(
      `1000-tick baseline locked: Green d${green} (${(p[green] * 100).toFixed(1)}%), Red d${red} (${(p[red] * 100).toFixed(1)}%)`,
    );
  }
  if (p[green] >= 0.14) {
    reasons.push(
      `Elevated dominant exhaustion on Green d${green} (${(p[green] * 100).toFixed(1)}%)`,
    );
  }
  if (p[red] <= 0.06) {
    reasons.push(`Deep liquidity reservoir on Red d${red} (${(p[red] * 100).toFixed(1)}%)`);
  }
  if (purple !== null) {
    reasons.push(
      `Velocity vector on Purple d${purple} (+${(pressure[purple] * 100).toFixed(1)}% dynamic shift)`,
    );
  } else {
    reasons.push("Velocity vector distributed across multiple digits (no distinct single purple)");
  }

  const valid = ds.length >= 1000 && p[green] < 0.18 && p[red] > 0.03;
  const outcome: "ACCEPT" | "WATCH" | "REJECT" = valid
    ? "ACCEPT"
    : ds.length >= 500
      ? "WATCH"
      : "REJECT";

  return {
    window: 1000,
    sampleSize: ds.length,
    green,
    secondGreen,
    red,
    secondRed,
    purple,
    pct: p,
    pressure,
    byFreq,
    valid,
    outcome,
    reasons,
  };
}

export function analyzeLiquidity(
  market: string,
  ticks: V3Tick[],
  side: Side,
  barrier: number,
  previous?: LiquidityOpportunity,
): LiquidityOpportunity {
  const psychology = buildPsychology1000(ticks, side, barrier),
    ds = ticks.map((x) => x.d),
    temporal: Record<number, DigitTemporal> = {};
  for (let d = 0; d < 10; d++) temporal[d] = temporalFor(ds, d);
  const reservoirDigits = [psychology.red, psychology.secondRed].filter((d) =>
    psychology.winners.includes(d),
  );
  const dominantDigits = [psychology.green, psychology.secondGreen];
  const reservoir = clamp(
    mean(reservoirDigits.map((d) => clamp((0.1 - psychology.pct[d]) * 900 + 45))) * 0.65 +
      (reservoirDigits.length === 2 ? 35 : 10),
  );
  const exhaustion = clamp(
    mean(
      dominantDigits.map((d) => {
        const x = temporal[d];
        return clamp(
          50 -
            x.slope20_60 * 7000 +
            Math.max(0, -x.ewmaSlope) * 3000 +
            x.cusum * 0.45 +
            x.changePoint * 0.35,
        );
      }),
    ),
  );
  const delivery = clamp(
    mean(
      reservoirDigits.map((d) => {
        const x = temporal[d];
        return clamp(
          35 +
            x.slope20_60 * 7000 +
            x.slope60_120 * 4000 +
            Math.max(0, x.ewmaSlope) * 3000 +
            x.cusum * 0.35 +
            x.changePoint * 0.2,
        );
      }),
    ),
  );
  const transitions = [transitionEvidence(ds, dominantDigits, reservoirDigits)];
  const migration = clamp(
    transitions[0].strength * 0.8 +
      (psychology.purple !== null && reservoirDigits.includes(psychology.purple) ? 35 : 0),
  );
  const h20 = entropy(pct(ds.slice(-20))),
    h120 = entropy(pct(ds.slice(-120))),
    h500 = entropy(pct(ds.slice(-500)));
  const entropyVelocity = h20 - h120,
    entropyAcceleration = h20 - h120 - (h120 - h500),
    divergence = jsd(pct(ds.slice(-20)), pct(ds.slice(-500)));
  const absorption = clamp(delivery * 0.45 + exhaustion * 0.3 + migration * 0.25);
  const vetoes = [...psychology.reasons];
  if (!reservoirDigits.length) vetoes.push("No Sentinel-valid Red/2nd-Red winning-side reservoir");
  const conflict = clamp(
    (psychology.valid ? 0 : 65) +
      (psychology.outcome === "WATCH" ? 18 : 0) +
      Math.max(0, 55 - migration) * 0.25,
  );
  const confirmation = clamp(
    reservoir * 0.18 +
      exhaustion * 0.2 +
      delivery * 0.24 +
      migration * 0.16 +
      absorption * 0.12 +
      clamp(divergence * 220) * 0.1,
  );
  let lifecycle: Lifecycle = "NO_LIQUIDITY";
  if (reservoir >= 35) lifecycle = "FORMING";
  if (reservoir >= 55) lifecycle = "BUILDING";
  if (reservoir >= 70) lifecycle = "MATURE";
  if (exhaustion >= 62) lifecycle = "EXHAUSTION_WATCH";
  if (exhaustion >= 75) lifecycle = "EXHAUSTION_CONFIRMED";
  if (delivery >= 62) lifecycle = "DELIVERY";
  if (delivery >= 78 && migration >= 60) lifecycle = "DELIVERY_ACCELERATING";
  if (absorption >= 70) lifecycle = "ABSORBING";
  if (exhaustion >= 75 && delivery >= 72) lifecycle = "RELEASE_WATCH";
  if (exhaustion >= 80 && delivery >= 80 && migration >= 65) lifecycle = "RELEASE";
  if (confirmation >= 76 && lifecycle === "RELEASE") lifecycle = "RIPE";
  if (confirmation >= 84 && lifecycle === "RIPE" && vetoes.length === 0) lifecycle = "CONFIRMED";
  if (!psychology.valid && psychology.outcome === "REJECT") lifecycle = "BLOCKED";
  if (conflict >= 70 && lifecycle !== "BLOCKED") lifecycle = "CONFLICTED";
  const order: Lifecycle[] = [
    "NO_LIQUIDITY",
    "FORMING",
    "BUILDING",
    "MATURE",
    "EXHAUSTION_WATCH",
    "EXHAUSTION_CONFIRMED",
    "DELIVERY",
    "DELIVERY_ACCELERATING",
    "ABSORBING",
    "RELEASE_WATCH",
    "RELEASE",
    "RIPE",
    "CONFIRMED",
  ];
  if (previous && psychology.valid) {
    const pi = order.indexOf(previous.lifecycle),
      ni = order.indexOf(lifecycle);
    if (pi >= 0 && ni >= 0 && ni < pi && pi - ni <= 2 && confirmation >= 45)
      lifecycle = previous.lifecycle;
  }
  const ageTicks = previous
    ? Math.max(0, previous.ageTicks + Math.max(1, ticks.length - previous.lastTick))
    : 1;
  const evidence: string[] = [];
  if (reservoir >= 65) evidence.push(`Reservoir depth ${Math.round(reservoir)}`);
  if (exhaustion >= 65) evidence.push(`Dominant exhaustion ${Math.round(exhaustion)}`);
  if (delivery >= 65) evidence.push(`Reservoir delivery ${Math.round(delivery)}`);
  if (migration >= 60) evidence.push(`Dominant→reservoir migration ${Math.round(migration)}`);
  if (psychology.purple !== null && reservoirDigits.includes(psychology.purple))
    evidence.push(`Purple d${psychology.purple} aligned with reservoir`);
  if (divergence > 0.04)
    evidence.push(`Recent/500 distribution divergence ${divergence.toFixed(3)}`);
  if (entropyVelocity > 0.02 && delivery > 60)
    evidence.push("Entropy broadening accompanies delivery");
  return {
    key: `${market}:${side}${barrier}`,
    market,
    contract: `${side}${barrier}`,
    side,
    barrier,
    psychology,
    reservoirDigits,
    dominantDigits,
    reservoirScore: reservoir,
    exhaustionScore: exhaustion,
    deliveryScore: delivery,
    migrationScore: migration,
    absorptionScore: absorption,
    confirmationScore: confirmation,
    conflictScore: conflict,
    ageTicks,
    lifecycle,
    previousLifecycle: previous?.lifecycle ?? null,
    birthTick: previous?.birthTick ?? ticks.length,
    lastTick: ticks.length,
    trajectory: [...(previous?.trajectory ?? []), confirmation].slice(-80),
    evidence,
    vetoes,
    temporal,
    transitions,
    entropyVelocity,
    entropyAcceleration,
    jsd: divergence,
  };
}
export function analyzeMarketV3(
  market: string,
  ticks: V3Tick[],
  previous: Record<string, LiquidityOpportunity> = {},
): LiquidityOpportunity[] {
  const out: LiquidityOpportunity[] = [];
  for (const side of ["OVER", "UNDER"] as const) {
    for (let b = side === "OVER" ? 1 : 5; b <= 4 || (side === "UNDER" && b <= 8); b++) {
      if (side === "OVER" && b > 4) break;
      const key = `${market}:${side}${b}`;
      out.push(analyzeLiquidity(market, ticks, side, b, previous[key]));
    }
  }
  return out;
}
