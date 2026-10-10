/**
 * COMBINED VERDICT LAYER.
 *
 * Sentinel remains the decision authority. DigitPulse contributes evidence only,
 * mapped into Sentinel dimensions by `digitpulse-mapping.ts`, then fused with
 * Sentinel's correlation-aware evidence fusion engine so that several engines
 * reading the same tick stream cannot manufacture false confidence.
 *
 * Output is one verdict per canonical proposition, plus a ranked view.
 */
import type { Tick as AnalyticsTick } from "@/lib/analytics";
import { lastDigit } from "@/lib/analytics";
import {
  analyzeMarket,
  type ContractAnalysis,
  type MarketAnalysis,
  type Tick as EngineTick,
} from "@/lib/liquidity/engine";
import type { LiquidityOpportunity } from "@/lib/liquidity/liquidity-v3";
import {
  mapDigitPulseEvidence,
  type DigitPulseEvidence,
  type SentinelDimension,
} from "@/lib/fusion/digitpulse-mapping";
import {
  fuseEvidence,
  type EngineEvidenceInput,
  type EngineSource,
  type EvidenceFusionReport,
} from "@/lib/sentinel/evidence-fusion";
import {
  PROPOSITION_SCAN_ORDER,
  propositionSpec,
  type Proposition,
  type PropositionSpec,
} from "@/lib/propositions";

export type VerdictAction = "STAND_DOWN" | "OBSERVE" | "PREPARE" | "EXECUTE";

/** Minimum canonical sample before any verdict above OBSERVE is possible. */
export const MIN_SAMPLE = 120;

export interface PropositionVerdict {
  proposition: Proposition;
  spec: PropositionSpec;
  action: VerdictAction;
  /** 0..100 combined, redundancy-adjusted conviction. */
  score: number;
  /** 0..100 observed danger against this proposition. */
  danger: number;
  /** 0..100 how independent the agreeing evidence actually is. */
  independence: number;
  lifecycle: string | null;
  fusion: EvidenceFusionReport;
  digitpulse: DigitPulseEvidence;
  reasons: string[];
  vetoes: string[];
  invalidations: string[];
}

export interface CombinedVerdict {
  market: string;
  sample: number;
  generatedAt: number;
  ready: boolean;
  analysis: MarketAnalysis | null;
  /** Last-digit frequency over the canonical window, in percent. */
  digitFrequency: number[];
  verdicts: PropositionVerdict[];
  best: PropositionVerdict | null;
  headline: string;
}

const DIMENSION_ENGINE: Record<SentinelDimension, EngineSource> = {
  PSYCHOLOGY: "DIGIT_PSYCHOLOGY",
  PRESSURE: "PRESSURE",
  LIQUIDITY: "PRICE_ACTION",
  CONFIRMATION: "TRANSITION",
  REGIME: "CONTEXT_MARKOV",
  DANGER: "SIMULATOR_LAB",
  ENGINE_AGREEMENT: "SIMULATOR_LAB",
};

const DIMENSION_LABEL: Record<EngineSource, string> = {
  DIGIT_PSYCHOLOGY: "Digit psychology",
  PRESSURE: "Pressure & exhaustion",
  PRICE_ACTION: "Liquidity structure",
  TRANSITION: "Confirmation & persistence",
  CONTEXT_MARKOV: "Regime context",
  SIMULATOR_LAB: "Danger & conflict",
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

export function toEngineTicks(ticks: AnalyticsTick[]): EngineTick[] {
  return ticks.map((t) => ({ q: t.price, d: lastDigit(t.price), t: t.t }));
}

function digitFrequency(ticks: EngineTick[]): number[] {
  const freq = new Array(10).fill(0) as number[];
  if (!ticks.length) return freq;
  for (const t of ticks) freq[t.d] = (freq[t.d] ?? 0) + 1;
  return freq.map((c) => (c / ticks.length) * 100);
}

/** Collapses the mapped DigitPulse readings into one input per Sentinel dimension. */
export function buildEngineInputs(evidence: DigitPulseEvidence): EngineEvidenceInput[] {
  const buckets = new Map<EngineSource, { signal: number[]; conf: number[]; notes: string[] }>();

  for (const r of evidence.readings) {
    const source = DIMENSION_ENGINE[r.dimension];
    if (!source) continue;
    const bucket = buckets.get(source) ?? { signal: [], conf: [], notes: [] };
    const signal = r.stance === "SUPPORTING" ? 1 : r.stance === "OPPOSING" ? -1 : 0;
    bucket.signal.push(signal);
    if (typeof r.value === "number") bucket.conf.push(clamp(Math.abs(r.value)));
    if (r.stance !== "NEUTRAL") bucket.notes.push(`${r.label} ${r.stance.toLowerCase()}`);
    buckets.set(source, bucket);
  }

  const inputs: EngineEvidenceInput[] = [];
  for (const [source, bucket] of buckets) {
    if (!bucket.signal.length) continue;
    const signal = bucket.signal.reduce((a, b) => a + b, 0) / bucket.signal.length;
    const confidence = bucket.conf.length
      ? bucket.conf.reduce((a, b) => a + b, 0) / bucket.conf.length
      : 50;
    inputs.push({
      source,
      label: DIMENSION_LABEL[source],
      signal: Math.max(-1, Math.min(1, signal)),
      confidence: clamp(confidence),
      summary: bucket.notes.length ? bucket.notes.join("; ") : "No directional reading.",
    });
  }
  return inputs;
}

function decide(
  score: number,
  danger: number,
  sample: number,
  evidence: DigitPulseEvidence,
  fusion: EvidenceFusionReport,
): VerdictAction {
  if (sample < MIN_SAMPLE) return "STAND_DOWN";
  if (evidence.vetoes.length) return "STAND_DOWN";
  if (danger >= 60) return "STAND_DOWN";
  if (fusion.consensus === "STRONG_CONFLICT" || fusion.consensus === "CONFLICT") return "STAND_DOWN";
  if (score >= 72 && evidence.confirmed && evidence.ripe && danger < 40) return "EXECUTE";
  if (score >= 60) return "PREPARE";
  return "OBSERVE";
}

function reasonsFor(
  evidence: DigitPulseEvidence,
  fusion: EvidenceFusionReport,
  action: VerdictAction,
  sample: number,
): string[] {
  const out: string[] = [];
  if (sample < MIN_SAMPLE) out.push(`Sample of ${sample} ticks is below the ${MIN_SAMPLE}-tick minimum.`);
  out.push(fusion.summary);
  out.push(fusion.rawAgreementVsEffective);
  for (const r of evidence.supporting.slice(0, 4)) out.push(`Supporting — ${r.label}: ${r.detail}`);
  for (const r of evidence.opposing.slice(0, 4)) out.push(`Opposing — ${r.label}: ${r.detail}`);
  for (const n of evidence.narrative.slice(0, 3)) out.push(n);
  if (action === "STAND_DOWN" && evidence.vetoes.length)
    out.push(`Vetoed: ${evidence.vetoes.join(", ")}`);
  return out.filter(Boolean);
}

function contractFor(
  analysis: MarketAnalysis | null,
  proposition: Proposition,
): ContractAnalysis | null {
  if (!analysis) return null;
  return analysis.contracts.find((c) => c.id === proposition) ?? null;
}

export function computeCombinedVerdict(
  market: string,
  ticks: AnalyticsTick[],
  previousV3: Record<string, LiquidityOpportunity> = {},
): CombinedVerdict {
  const engineTicks = toEngineTicks(ticks);
  const analysis = engineTicks.length >= 30 ? analyzeMarket(engineTicks, market, previousV3) : null;
  const sample = analysis?.sample ?? engineTicks.length;

  const verdicts = PROPOSITION_SCAN_ORDER.map((proposition) => {
    const spec = propositionSpec(proposition);
    const evidence = mapDigitPulseEvidence(
      market,
      proposition,
      analysis,
      contractFor(analysis, proposition),
    );
    const fusion = fuseEvidence(buildEngineInputs(evidence));

    const danger = clamp(evidence.danger);
    const base = evidence.available ? fusion.effectiveScore + fusion.rankingDelta : 0;
    const confirmationBonus = (evidence.confirmed ? 4 : 0) + (evidence.ripe ? 4 : 0);
    const preference = spec.primaryPreference ? 2 : 0;
    const score = evidence.available
      ? clamp(base + confirmationBonus + preference - danger * 0.25 - evidence.vetoes.length * 8)
      : 0;

    const action = decide(score, danger, sample, evidence, fusion);

    return {
      proposition,
      spec,
      action,
      score: Math.round(score),
      danger: Math.round(danger),
      independence: Math.round(fusion.independenceScore),
      lifecycle: evidence.lifecycle,
      fusion,
      digitpulse: evidence,
      reasons: reasonsFor(evidence, fusion, action, sample),
      vetoes: evidence.vetoes,
      invalidations: spec.invalidationConditions,
    } satisfies PropositionVerdict;
  }).sort((a, b) => b.score - a.score || a.spec.threshold - b.spec.threshold);

  const best = verdicts.find((v) => v.action !== "STAND_DOWN") ?? null;

  return {
    market,
    sample,
    generatedAt: Date.now(),
    ready: sample >= MIN_SAMPLE,
    analysis,
    digitFrequency: digitFrequency(engineTicks),
    verdicts,
    best,
    headline: headlineFor(sample, best),
  };
}

function headlineFor(sample: number, best: PropositionVerdict | null): string {
  if (sample < MIN_SAMPLE) return `Observing — ${sample}/${MIN_SAMPLE} ticks collected.`;
  if (!best) return "No proposition qualifies. Standing down on all six.";
  return `${best.spec.label} — ${best.action.replace("_", " ").toLowerCase()} at ${best.score}/100.`;
}
