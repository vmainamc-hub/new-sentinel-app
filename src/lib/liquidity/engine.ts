/**
 * Shared quantitative engine.
 *
 * Pipeline: canonical bounded tick state -> market features -> psychology ->
 * contract projection -> liquidity lifecycle -> danger -> confirmation.
 *
 * The engine is pure. The UI never feeds data back into it.
 *
 * Scientific boundary: every output is an observable statistical/psychological
 * pattern measured on public tick data. Nothing here claims hidden order flow,
 * trader intent, or manipulation.
 */

import {
  ANALYSIS_VERSION,
  CONTRACTS,
  WINDOWS,
  type ContractDef,
  type ContractKind,
  type LiquidityState,
} from "./universe";
import {
  autocorr,
  bayes,
  changePoint,
  clamp,
  conditionalEntropy,
  contractMask,
  entropy,
  freq,
  hazardFunction,
  isHigh,
  isLow,
  jsd,
  mean,
  mutualInformation,
  normalizedEntropy,
  pageHinkley,
  runs,
  sigmoid,
  transition,
  wilson,
  type HazardPoint,
} from "./math";
import {
  V3_WINDOWS,
  buildPsychology1000,
  getMarketSentinelPsychology,
  temporalFor,
  transitionEvidence,
  analyzeLiquidity,
  type DigitTemporal,
  type LiquidityOpportunity,
  type MarketSentinelPsychology,
  type Psychology1000,
  type TransitionEvidence,
} from "./liquidity-v3";

export interface Tick {
  q: number;
  d: number;
  t: number;
}

export interface DigitPsychology {
  freq: number[];
  baseline: number[];
  momentum: number[];
  pressure: number[];
}

export interface BoundaryStat {
  pair: string;
  share: number;
  imbalance: number;
  attack: number;
  rejection: number;
}

export interface RegimeInfo {
  state: "STABLE" | "CONCENTRATED" | "DEPENDENT" | "SHIFT";
  change: number;
  entropy: number;
  autocorr: number;
}

export interface HmmInfo {
  low: number;
  high: number;
  confidence: number;
}

export interface SweepInfo {
  active: boolean;
  side: "LOW" | "HIGH" | "NONE";
  intensity: number;
  boundaryBurst: number;
  reversion: number;
  note: string;
}

export interface ConfirmationComponent {
  key: string;
  label: string;
  value: number;
  weight: number;
  supports: boolean;
}

export interface ContractAnalysis {
  id: string;
  label: string;
  kind: ContractKind;
  barrier: number;
  winShare: number;
  recentWin: number;
  wilsonLo: number;
  wilsonHi: number;
  bayesian: number;
  creation: number;
  maturity: number;
  absorption: number;
  exhaustion: number;
  release: number;
  danger: number;
  conflict: number;
  confirmation: number;
  pressure: number;
  boundaryAttack: number;
  drift: number;
  run: number;
  opposingRun: number;
  hazard: HazardPoint[];
  dimensions: ConfirmationComponent[];
  supportCount: number;
  state: LiquidityState;
  law: boolean;
  ripe: boolean;
  confirmed: boolean;
  v3?: LiquidityOpportunity;
  psychology1000?: Psychology1000;
  reservoirScore?: number;
  exhaustionScore?: number;
  deliveryScore?: number;
  migrationScore?: number;
  absorptionScore?: number;
  confirmationScore?: number;
  conflictScore?: number;
  evidence?: string[];
  vetoes?: string[];
  temporal?: Record<number, DigitTemporal>;
  transitions?: TransitionEvidence[];
  entropyVelocity?: number;
  entropyAcceleration?: number;
  jsdScore?: number;
}

/**
 * LOW/HIGH zone balance.
 *
 * NOTE: the upstream DigitPulse build also analysed EVEN/ODD ("parity") here and
 * exposed it as a tradable family. This unified build is Over/Under only, so the
 * EVEN/ODD contract analysis has been removed entirely — no parity share,
 * pressure, danger, score, signal or veto exists anywhere in the pipeline.
 * Digit-parity *psychology* rules (GREEN/RED digit placement) are unrelated and
 * remain intact: they are structural Over/Under requirements, not a proposition.
 */
export interface ZoneBalanceAnalysis {
  low: { share: number; recent: number; pressure: number };
  high: { share: number; recent: number; pressure: number };
  zones: Record<string, number>;
}

export interface MarketAnalysis {
  sample: number;
  last: number;
  observationId: string;
  sentinelPsychology: MarketSentinelPsychology;
  temporal: Record<number, DigitTemporal>;
  v3Opportunities: Record<string, LiquidityOpportunity>;
  entropyVelocity: number;
  entropyAcceleration: number;
  jsd500: number;
  f1000: number[];
  f20: number[];
  f50: number[];
  entropy: number;
  entropyFast: number;
  entropyShock: number;
  jsd: number;
  low1000: number;
  high1000: number;
  low20: number;
  high20: number;
  zoneMomentum: number;
  transition: number[][];
  mi: number;
  conditionalEntropy: number;
  changePoint: number;
  pageHinkley: number;
  fluctuation: number;
  anomaly: number;
  persistence: number;
  transitionStability: number;
  autocorr: number;
  regime: RegimeInfo;
  regimeDanger: number;
  hmm: HmmInfo;
  sweep: SweepInfo;
  adversarial: number;
  boundaries: BoundaryStat[];
  psychology: DigitPsychology;
  digitMomentum: number[];
  lowHazard: HazardPoint[];
  highHazard: HazardPoint[];
  zoneBalance: ZoneBalanceAnalysis;
  contracts: ContractAnalysis[];
  top: ContractAnalysis;
  bayesian: Record<string, number>;
}

interface Features {
  f1000: number[];
  f20: number[];
  f50: number[];
  entropy: number;
  entropyFast: number;
  entropyShock: number;
  jsd: number;
  zoneMomentum: number;
  fluctuation: number;
  anomaly: number;
  persistence: number;
  transitionStability: number;
  changePoint: number;
  regimeDanger: number;
  digitMomentum: number[];
  bayesian: Record<string, number>;
  baseline: Record<ContractKind, Record<number, number>>;
  sweep: SweepInfo;
}

function psychologicalDigits(ds: number[], base: number[]): DigitPsychology {
  const f = freq(ds);
  const fb = freq(base);
  const momentum = f.map((x, i) => (x - (fb[i] ?? 0)) * 100);
  const pressure = f.map((_, i) => clamp(50 + (momentum[i] ?? 0) * 4));
  return { freq: f, baseline: fb, momentum, pressure };
}

/** Lower / upper / extreme boundary psychology. */
function boundaryStats(ds: number[]): BoundaryStat[] {
  const f = freq(ds);
  const pairs: [number, number][] = [
    [0, 1],
    [5, 6],
    [6, 7],
    [7, 8],
    [8, 9],
    [0, 9],
  ];
  return pairs.map(([a, b]) => {
    const fa = f[a] ?? 0;
    const fb = f[b] ?? 0;
    return {
      pair: `${a}/${b}`,
      share: (fa + fb) * 100,
      imbalance: (fa - fb) * 100,
      attack: clamp((fa + fb) * 350),
      rejection: clamp(Math.abs(fa - fb) * 500),
    };
  });
}

function regimeOf(ds: number[]): RegimeInfo {
  const z = changePoint(ds.map((d) => (isLow(d) ? 0 : 1)));
  const ent = entropy(freq(ds)) / Math.log2(10);
  const ac = Math.abs(autocorr(ds.map((d) => d % 2)));
  const state: RegimeInfo["state"] =
    z.score > 65 ? "SHIFT" : ent < 0.88 ? "CONCENTRATED" : ac > 0.18 ? "DEPENDENT" : "STABLE";
  return { state, change: z.score, entropy: ent * 100, autocorr: ac };
}

/** HMM-inspired two-state (LOW / HIGH) regime inference. */
function hmmProxy(ds: number[]): HmmInfo {
  if (ds.length < 30) return { low: 0.5, high: 0.5, confidence: 0 };
  const x = ds.map((d) => (isLow(d) ? 0 : 1));
  const p = mean(x);
  const r = mean(x.slice(-20));
  const high = sigmoid((r - p) * 8);
  return { low: 1 - high, high, confidence: clamp(Math.abs(r - p) * 250) };
}

/**
 * Liquidity sweep detection.
 * A sweep is an observed burst of extreme boundary digits followed by an
 * opposite-zone reversion inside the same short window.
 */
function detectSweep(recent: number[], baseline: number[]): SweepInfo {
  if (recent.length < 20)
    return {
      active: false,
      side: "NONE",
      intensity: 0,
      boundaryBurst: 0,
      reversion: 0,
      note: "Insufficient sample.",
    };
  const fr = freq(recent);
  const fb = freq(baseline);
  const lowExtreme = (fr[0] ?? 0) + (fr[1] ?? 0) - ((fb[0] ?? 0) + (fb[1] ?? 0));
  const highExtreme = (fr[8] ?? 0) + (fr[9] ?? 0) - ((fb[8] ?? 0) + (fb[9] ?? 0));
  const half = Math.floor(recent.length / 2);
  const firstHalf = recent.slice(0, half);
  const secondHalf = recent.slice(half);
  const firstHigh = mean(firstHalf.map((d) => (isHigh(d) ? 1 : 0)));
  const secondHigh = mean(secondHalf.map((d) => (isHigh(d) ? 1 : 0)));
  const swing = secondHigh - firstHigh;

  const highSweep = clamp(highExtreme * 400) * clamp(Math.max(0, -swing) * 300, 0, 100);
  const lowSweep = clamp(lowExtreme * 400) * clamp(Math.max(0, swing) * 300, 0, 100);
  const side = highSweep > lowSweep ? "HIGH" : lowSweep > 0 ? "LOW" : "NONE";
  const intensity = clamp(Math.sqrt(Math.max(highSweep, lowSweep)));
  const boundaryBurst = clamp(Math.max(highExtreme, lowExtreme) * 400);
  const reversion = clamp(Math.abs(swing) * 200);
  return {
    active: intensity >= 45,
    side: side as SweepInfo["side"],
    intensity,
    boundaryBurst,
    reversion,
    note:
      intensity >= 45
        ? `Observed ${side} boundary burst followed by opposite-zone reversion.`
        : "No sweep signature in the recent window.",
  };
}

function analyzeContract(
  ds: number[],
  f: Features,
  c: ContractDef,
  v3Opp: LiquidityOpportunity,
): ContractAnalysis {
  const win = (d: number) => contractMask(c.kind, c.barrier, d);
  const n = Math.max(1, ds.length);
  const wins = ds.filter(win).length;
  const wf = wins / n;
  const recent = ds.slice(-50);
  const rf = recent.filter(win).length / Math.max(1, recent.length);
  const w = wilson(wins, n);
  const drift = rf - wf;

  const winningDigits = ds.filter(win);
  const losingDigits = ds.filter((d) => !win(d));
  const wr = runs(ds, win);
  const lr = runs(ds, (d) => !win(d));
  const hazard = hazardFunction(ds, win);

  const boundary = c.kind === "OVER" ? c.barrier + 1 : c.barrier - 1;
  const boundaryAttack = clamp((f.f1000[boundary] ?? 0) * 500);

  const winMomentum = mean(winningDigits.slice(-20).map((d) => f.digitMomentum[d] ?? 0));
  const loseMomentum = mean(losingDigits.slice(-20).map((d) => f.digitMomentum[d] ?? 0));
  const pressure = clamp(50 + (winMomentum - loseMomentum) * 3);

  // V3 Quantitative metrics
  const creation = v3Opp.reservoirScore;
  const maturity = clamp(
    v3Opp.reservoirScore * 0.5 +
      v3Opp.exhaustionScore * 0.3 +
      (v3Opp.ageTicks > 15 ? 20 : v3Opp.ageTicks),
  );
  const absorption = v3Opp.absorptionScore;
  const exhaustion = v3Opp.exhaustionScore;
  const release = v3Opp.deliveryScore;
  const conflict = v3Opp.conflictScore;
  const danger = clamp(
    v3Opp.conflictScore * 0.35 +
      f.anomaly * 0.2 +
      f.regimeDanger * 0.15 +
      Math.max(0, exhaustion - 75) * 0.3,
  );

  // LAW 4 — decomposable multi-dimensional confirmation based on V3 engines.
  const dimensions: ConfirmationComponent[] = [
    {
      key: "reservoir",
      label: "Reservoir depth (Red/2nd Red)",
      value: v3Opp.reservoirScore,
      weight: 0.18,
      supports: v3Opp.reservoirScore >= 55,
    },
    {
      key: "exhaustion",
      label: "Dominant exhaustion (Green/2nd Green)",
      value: v3Opp.exhaustionScore,
      weight: 0.2,
      supports: v3Opp.exhaustionScore >= 62,
    },
    {
      key: "delivery",
      label: "Reservoir delivery slope",
      value: v3Opp.deliveryScore,
      weight: 0.24,
      supports: v3Opp.deliveryScore >= 62,
    },
    {
      key: "migration",
      label: "Dominant→reservoir migration",
      value: v3Opp.migrationScore,
      weight: 0.16,
      supports: v3Opp.migrationScore >= 50,
    },
    {
      key: "absorption",
      label: "Structural absorption",
      value: v3Opp.absorptionScore,
      weight: 0.12,
      supports: v3Opp.absorptionScore >= 55,
    },
    {
      key: "divergence",
      label: "Distribution departure (JSD)",
      value: clamp(v3Opp.jsd * 220),
      weight: 0.1,
      supports: v3Opp.jsd >= 0.03,
    },
  ];

  const confirmation = v3Opp.confirmationScore;
  const supportCount = dimensions.filter((d) => d.supports).length;

  const law = v3Opp.reservoirScore >= 25 && v3Opp.lifecycle !== "NO_LIQUIDITY";
  const ripe = v3Opp.lifecycle === "RIPE" || v3Opp.lifecycle === "CONFIRMED";
  const confirmed = v3Opp.lifecycle === "CONFIRMED";
  const state: LiquidityState = v3Opp.lifecycle as LiquidityState;

  return {
    id: c.id,
    label: c.label,
    kind: c.kind,
    barrier: c.barrier,
    winShare: wf * 100,
    recentWin: rf * 100,
    wilsonLo: w.lo,
    wilsonHi: w.hi,
    bayesian: f.bayesian[c.id] ?? 0,
    creation,
    maturity,
    absorption,
    exhaustion,
    release,
    danger,
    conflict,
    confirmation,
    pressure,
    boundaryAttack,
    drift: drift * 100,
    run: wr.current,
    opposingRun: lr.current,
    hazard,
    dimensions,
    supportCount,
    state,
    law,
    ripe,
    confirmed,
    v3: v3Opp,
    psychology1000: v3Opp.psychology,
    reservoirScore: v3Opp.reservoirScore,
    exhaustionScore: v3Opp.exhaustionScore,
    deliveryScore: v3Opp.deliveryScore,
    migrationScore: v3Opp.migrationScore,
    absorptionScore: v3Opp.absorptionScore,
    confirmationScore: v3Opp.confirmationScore,
    conflictScore: v3Opp.conflictScore,
    evidence: v3Opp.evidence,
    vetoes: v3Opp.vetoes,
    temporal: v3Opp.temporal,
    transitions: v3Opp.transitions,
    entropyVelocity: v3Opp.entropyVelocity,
    entropyAcceleration: v3Opp.entropyAcceleration,
    jsdScore: v3Opp.jsd,
  };
}

function analyzeZoneBalance(ds: number[]): ZoneBalanceAnalysis {
  const n = Math.max(1, ds.length);
  const l = ds.filter(isLow).length / n;
  const h = 1 - l;
  const rec = ds.slice(-50);
  const rn = Math.max(1, rec.length);
  const lr = rec.filter(isLow).length / rn;
  return {
    low: { share: l * 100, recent: lr * 100, pressure: clamp(50 + (lr - l) * 250) },
    high: { share: h * 100, recent: (1 - lr) * 100, pressure: clamp(50 + (1 - lr - h) * 250) },
    zones: {
      LOW: (ds.filter((d) => isLow(d)).length / n) * 100,
      HIGH: (ds.filter((d) => isHigh(d)).length / n) * 100,
    },
  };
}

export function analyzeMarket(
  history: Tick[],
  marketSymbol: string = "MARKET",
  previousV3: Record<string, LiquidityOpportunity> = {},
): MarketAnalysis | null {
  const ds = history.map((x) => x.d);
  if (ds.length < 30) return null;

  const sentinelPsychology = getMarketSentinelPsychology(history);
  const temporal: Record<number, DigitTemporal> = {};
  for (let d = 0; d < 10; d++) {
    temporal[d] = temporalFor(ds, d);
  }

  const v3Opportunities: Record<string, LiquidityOpportunity> = {};
  for (const c of CONTRACTS) {
    v3Opportunities[c.id] = analyzeLiquidity(
      marketSymbol,
      history,
      c.kind,
      c.barrier,
      previousV3[c.id],
    );
  }

  const w = Object.fromEntries(WINDOWS.map((n) => [n, ds.slice(-n)])) as Record<number, number[]>;
  const w1000 = w[1000] ?? ds;
  const w500 = w[500] ?? ds;
  const w200 = w[200] ?? ds;
  const w120 = w[120] ?? ds;
  const w50 = w[50] ?? ds;
  const w20 = w[20] ?? ds;

  const f1000 = freq(w1000);
  const f50 = freq(w50);
  const f20 = freq(w20);
  const ent1000 = normalizedEntropy(f1000);
  const ent120 = normalizedEntropy(freq(w120));
  const ent500 = normalizedEntropy(freq(w500));
  const ent20 = normalizedEntropy(f20);
  const js = jsd(f20, f1000);
  const jsd500 = jsd(f20, freq(w500));
  const entropyVelocity = ent20 - ent120;
  const entropyAcceleration = ent20 - ent120 - (ent120 - ent500);

  const low20 = mean(w20.map((x) => (isLow(x) ? 1 : 0)));
  const low1000 = mean(w1000.map((x) => (isLow(x) ? 1 : 0)));
  const zoneMomentum = (low20 - low1000) * 100;

  const trans = transition(w1000);
  const mi = mutualInformation(w1000);
  const ch = changePoint(w200.map((x) => (isLow(x) ? 0 : 1))).score;
  const ph = pageHinkley(w200.map((x) => (isLow(x) ? 0 : 1)));

  const fluctuation = clamp(
    Math.abs(ent20 - ent1000) * 2 +
      Math.abs(zoneMomentum) * 0.75 +
      // Was |even/odd share - 0.5|; this build is Over/Under only, so instability
      // is measured from entropy velocity instead of any parity term.
      Math.abs(entropyVelocity) * 60 +
      js * 120,
  );
  // LOW/HIGH autocorrelation (upstream used digit parity here).
  const ac = autocorr(ds.map((x) => (isLow(x) ? 0 : 1)));
  const anomaly = clamp(js * 170 + ch * 0.45 + ph * 0.25 + Math.abs(ac) * 80);
  const persistence = clamp((runs(ds, isLow).max + runs(ds, isHigh).max) * 3);
  const transitionStability = clamp(100 - mi * 80);
  const entropyShock = ent20 - ent1000;
  const regime = regimeOf(w200);
  const hmm = hmmProxy(w200);
  const psychology = psychologicalDigits(w50, w1000);
  const boundaries = boundaryStats(w1000);
  const sweep = detectSweep(ds.slice(-40), w1000);

  const regimeDanger = clamp(
    regime.change * 0.45 + (regime.state === "SHIFT" ? 35 : 0) + (100 - regime.entropy) * 0.2,
  );
  /** Structural-adversarial observable-pattern proxy (no intent claim). */
  const adversarial = clamp(
    js * 150 + sweep.intensity * 0.3 + regimeDanger * 0.25 + Math.abs(ac) * 70 + ph * 0.2,
  );

  const bayesian: Record<string, number> = {};
  const baseline: Record<ContractKind, Record<number, number>> = { OVER: {}, UNDER: {} };
  for (const c of CONTRACTS) {
    const k = w1000.filter((d) => contractMask(c.kind, c.barrier, d)).length;
    const post = bayes(k, w1000.length);
    bayesian[c.id] = post.mean * 100;
    baseline[c.kind][c.barrier] = post.mean;
  }

  const features: Features = {
    f1000,
    f20,
    f50,
    entropy: ent1000,
    entropyFast: ent20,
    entropyShock,
    jsd: js,
    zoneMomentum,
    fluctuation,
    anomaly,
    persistence,
    transitionStability,
    changePoint: ch,
    regimeDanger,
    digitMomentum: psychology.momentum,
    bayesian,
    baseline,
    sweep,
  };

  const contracts = CONTRACTS.map((c) => analyzeContract(ds, features, c, v3Opportunities[c.id]!));
  const zoneBalance = analyzeZoneBalance(ds);
  const qualified = contracts.filter((x) => x.law).sort((a, b) => b.confirmation - a.confirmation);
  const top = qualified[0] ?? contracts[0]!;
  const lastTick = history[history.length - 1];
  const observationId = `${lastTick?.t ?? 0}-${lastTick?.q ?? 0}-${top.id}-${ANALYSIS_VERSION}`;

  return {
    sample: ds.length,
    last: ds[ds.length - 1] ?? 0,
    observationId,
    sentinelPsychology,
    temporal,
    v3Opportunities,
    entropyVelocity,
    entropyAcceleration,
    jsd500,
    f1000,
    f20,
    f50,
    entropy: ent1000,
    entropyFast: ent20,
    entropyShock,
    jsd: js,
    low1000: low1000 * 100,
    high1000: (1 - low1000) * 100,
    low20: low20 * 100,
    high20: (1 - low20) * 100,
    zoneMomentum,
    transition: trans,
    mi,
    conditionalEntropy: conditionalEntropy(w1000),
    changePoint: ch,
    pageHinkley: ph,
    fluctuation,
    anomaly,
    persistence,
    transitionStability,
    autocorr: ac,
    regime,
    regimeDanger,
    hmm,
    sweep,
    adversarial,
    boundaries,
    psychology,
    digitMomentum: psychology.momentum,
    lowHazard: hazardFunction(ds, isLow),
    highHazard: hazardFunction(ds, isHigh),
    zoneBalance,
    contracts,
    top,
    bayesian,
  };
}

export function makeExplanation(c: ContractAnalysis, a: MarketAnalysis): string[] {
  const p = c.psychology1000 ?? a.sentinelPsychology;
  const purpleStr = p.purple !== null ? `d${p.purple}` : "none";
  return [
    `1000-tick Sentinel psychology: Green d${p.green} · 2nd Green d${p.secondGreen} · Red d${p.red} · 2nd Red d${p.secondRed} · Purple ${purpleStr}.`,
    `V3 Lifecycle: ${c.state} · confirmation ${c.confirmation.toFixed(0)} · reservoir depth ${(c.reservoirScore ?? c.creation).toFixed(0)} · dominant exhaustion ${(c.exhaustionScore ?? c.exhaustion).toFixed(0)}.`,
    `Delivery ${(c.deliveryScore ?? c.release).toFixed(0)} · migration ${(c.migrationScore ?? 0).toFixed(0)} · absorption ${(c.absorptionScore ?? c.absorption).toFixed(0)} · danger ${c.danger.toFixed(0)}.`,
    c.evidence && c.evidence.length
      ? `Evidence: ${c.evidence.join(" · ")}`
      : "Structural formation developing.",
    c.vetoes && c.vetoes.length
      ? `Vetoes: ${c.vetoes.join(" · ")}`
      : "All Sentinel structural rules satisfied.",
    `${c.supportCount}/6 V3 independent dimensions support this structure. ${c.ripe && !c.confirmed ? "RIPE is not CONFIRMED." : ""}`.trim(),
    `Read as observable tick structure only — no hidden order flow, no manipulation claims.`,
  ];
}
