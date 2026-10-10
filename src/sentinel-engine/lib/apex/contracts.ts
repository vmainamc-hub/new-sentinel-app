// APEX SENTINEL — contract intelligence.
// Turns engine measurements into per-contract evidence, edge, quality,
// stability, danger and a final opportunity score. Purely quantitative:
// the AI layer never touches these numbers.
//
// Refinement: scoring is no longer driven by a shallow hit rate. Every score
// passes through digit-level threat analysis, critical-digit protection,
// statistical validation, walk-forward validated models and a structured
// fake-edge interrogation before it is allowed to become an opportunity.
import {
  clamp,
  tail,
  wilsonLower,
  WINDOW_BASE,
  WINDOW_MICRO,
  WINDOW_MID,
  WINDOW_RECENT,
} from "./engines";
import { losingDigitThreat } from "./threat";
import { criticalConflict, type CriticalReport } from "./critical";
import { shrinkRate, statisticalReport } from "./statistics";
import { forwardProjection } from "./forward";
import { fakeEdgeCheck } from "./battle";
import { applyLosingSidePressure, losingSidePressure } from "@/sentinel-engine/lib/sentinel/losing-side-pressure";
import {
  applyWinningSideMomentum,
  winningSideMomentum,
} from "@/sentinel-engine/lib/sentinel/winning-side-momentum";
import { engineInfluence } from "./engine-effectiveness";
import type { DigitIntel } from "./digit-intel";
import type { BarStructure } from "./bars";
import type { EnsembleResult } from "./ml";
import type { ApexRefinementSettings } from "./settings";
import type {
  AnomalyOut,
  ApexContractId,
  ContractEval,
  DigitStatsOut,
  EntropyOut,
  Evidence,
  MarketQualityOut,
  PressureOut,
  RegimeOut,
  SequenceOut,
  SetupPhase,
  TransitionOut,
  TrendOut,
  VolatilityOut,
} from "./types";

export interface ContractSpec {
  id: ApexContractId;
  label: string;
  side: "UNDER" | "OVER";
  barrier: number;
}

export const CONTRACT_SPECS: Record<ApexContractId, ContractSpec> = {
  UNDER6: { id: "UNDER6", label: "Under 6", side: "UNDER", barrier: 6 },
  UNDER7: { id: "UNDER7", label: "Under 7", side: "UNDER", barrier: 7 },
  UNDER8: { id: "UNDER8", label: "Under 8", side: "UNDER", barrier: 8 },
  OVER1: { id: "OVER1", label: "Over 1", side: "OVER", barrier: 1 },
  OVER2: { id: "OVER2", label: "Over 2", side: "OVER", barrier: 2 },
  OVER3: { id: "OVER3", label: "Over 3", side: "OVER", barrier: 3 },
};

export function winnersFor(spec: ContractSpec): number[] {
  const out: number[] = [];
  for (let d = 0; d < 10; d++) {
    if (spec.side === "UNDER" ? d < spec.barrier : d > spec.barrier) out.push(d);
  }
  return out;
}

function winRate(digits: number[], winners: Set<number>): { p: number; w: number; n: number } {
  let w = 0;
  for (const d of digits) if (winners.has(d)) w++;
  return { p: digits.length ? w / digits.length : 0, w, n: digits.length };
}

export interface EvalContext {
  digits: number[];
  stats: DigitStatsOut;
  pressure: PressureOut;
  transition: TransitionOut;
  sequence: SequenceOut;
  entropy: EntropyOut;
  anomaly: AnomalyOut;
  volatility: VolatilityOut;
  trend: TrendOut;
  regime: RegimeOut;
  quality: MarketQualityOut;
  /** Previous evaluation of the same contract, for phase/stability tracking. */
  prev?: ContractEval | undefined;
  /** Rolling history of composite edge for stability measurement. */
  edgeHistory: number[];
  dataAgeMs: number;

  // ---- Refinement inputs ----
  /** Multi-window per-digit intelligence. */
  intel: DigitIntel;
  /** Green/red bar structure (supporting evidence only). */
  bars: BarStructure;
  /** Critical digit roles observed in this market. */
  criticalReport: CriticalReport;
  /** Walk-forward validated ensemble for this contract, or null if not run. */
  ensemble: EnsembleResult | null;
  /** Terminal-observed outcomes in analogous states, or null. */
  analogue: { n: number; rate: number } | null;
  /** Change in normalised entropy (recent − base). */
  entropyDelta: number;
  settings: ApexRefinementSettings;
}

export function evaluateContract(spec: ContractSpec, ctx: EvalContext): ContractEval {
  const winners = winnersFor(spec);
  const winSet = new Set(winners);
  const theoretical = winners.length / 10;

  const base = winRate(tail(ctx.digits, WINDOW_BASE), winSet);
  const mid = winRate(tail(ctx.digits, WINDOW_MID), winSet);
  const recent = winRate(tail(ctx.digits, WINDOW_RECENT), winSet);
  const micro = winRate(tail(ctx.digits, WINDOW_MICRO), winSet);

  const edge = base.p - theoretical;
  const edgeLB = wilsonLower(base.w, base.n) - theoretical;

  // Pressure asymmetry: winner mass gaining vs loser mass gaining.
  let winPress = 0;
  let losePress = 0;
  for (let d = 0; d < 10; d++) {
    if (winSet.has(d)) winPress += ctx.pressure.pressure[d];
    else losePress += ctx.pressure.pressure[d];
  }
  const pressureAsymmetry = clamp((winPress - losePress) * 12, -1, 1);

  // Markov support: probability mass on winners for the next tick.
  let markov = 0;
  for (const d of winners) markov += ctx.transition.nextDist[d];
  const transitionSupport =
    ctx.transition.rowN >= 20 ? clamp((markov - theoretical) * 6, -1, 1) : 0;

  const supports: Evidence[] = [];
  const conflicts: Evidence[] = [];
  const push = (e: Evidence) => {
    const influence = engineInfluence(e.engine);
    const effectiveWeight = clamp(e.weight * influence, -1, 1);
    const effectiveEvidence: Evidence = {
      ...e,
      weight: effectiveWeight,
    };
    (effectiveEvidence.weight >= 0 ? supports : conflicts).push(effectiveEvidence);
  };

  push({
    engine: "Empirical Performance",
    label: `${(base.p * 100).toFixed(1)}% win rate over ${base.n} ticks`,
    detail: `Theoretical ${(theoretical * 100).toFixed(0)}%. Edge ${(edge * 100).toFixed(2)}pp, Wilson 95% lower bound ${(edgeLB * 100).toFixed(2)}pp.`,
    weight: clamp(edgeLB * 25, -1, 1),
    n: base.n,
  });
  push({
    engine: "Recent Performance",
    label: `${(recent.p * 100).toFixed(1)}% over last ${recent.n}`,
    detail: `Mid window ${(mid.p * 100).toFixed(1)}%, micro window ${(micro.p * 100).toFixed(1)}%.`,
    weight: clamp((recent.p - theoretical) * 12, -1, 1),
    n: recent.n,
  });
  push({
    engine: "Digit Pressure",
    label: pressureAsymmetry >= 0 ? "Winner digits gaining share" : "Loser digits gaining share",
    detail: `Winner-side pressure ${(winPress * 100).toFixed(2)}pp vs loser-side ${(losePress * 100).toFixed(2)}pp.`,
    weight: pressureAsymmetry,
    n: WINDOW_RECENT,
  });
  if (ctx.transition.rowN >= 20) {
    push({
      engine: "Transition Chain",
      label: `P(win | last digit ${ctx.stats.lastDigit}) = ${(markov * 100).toFixed(1)}%`,
      detail: `First-order Markov row sample ${ctx.transition.rowN}; chain dependency ${(ctx.transition.dependency * 100).toFixed(1)}%.`,
      weight: transitionSupport,
      n: ctx.transition.rowN,
    });
  }

  // Loser-side exhaustion / lifecycle evidence.
  const exhaustedLosers = winners.length
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
        (d) => !winSet.has(d) && ctx.pressure.exhaustion[d] > 0.45,
      )
    : [];
  if (exhaustedLosers.length) {
    push({
      engine: "Digit Exhaustion",
      label: `Losing digits ${exhaustedLosers.join(", ")} exhausting`,
      detail: `Their share is decaying across mid → recent → micro windows.`,
      weight: clamp(exhaustedLosers.length * 0.18, 0, 0.8),
      n: WINDOW_MID,
    });
  }
  const emergingLosers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter(
    (d) =>
      !winSet.has(d) &&
      (ctx.pressure.lifecycle[d] === "emerging" || ctx.pressure.lifecycle[d] === "dominant"),
  );
  if (emergingLosers.length) {
    push({
      engine: "Digit Lifecycle",
      label: `Losing digits ${emergingLosers.join(", ")} in ascent`,
      detail: "Loser mass is building — this directly threatens the contract.",
      weight: -clamp(emergingLosers.length * 0.22, 0, 0.9),
      n: WINDOW_MID,
    });
  }

  if (ctx.regime.label === "CHAOTIC") {
    push({
      engine: "Market Regime",
      label: "Chaotic regime",
      detail: ctx.regime.detail,
      weight: -0.6,
      n: 0,
    });
  } else if (ctx.regime.label === "SKEWED") {
    const skewFavours =
      (spec.side === "UNDER" && ctx.pressure.zoneAShare > 0.5) ||
      (spec.side === "OVER" && ctx.pressure.zoneBShare > 0.5);
    push({
      engine: "Market Regime",
      label: `Skewed regime ${skewFavours ? "aligned" : "opposed"}`,
      detail: ctx.regime.detail,
      weight: skewFavours ? 0.35 : -0.4,
      n: 0,
    });
  }

  if (ctx.volatility.label === "violent") {
    push({
      engine: "Volatility",
      label: "Volatility spike",
      detail: `Realised volatility ${ctx.volatility.ratio.toFixed(2)}× baseline.`,
      weight: -0.45,
      n: WINDOW_RECENT,
    });
  }
  if (ctx.anomaly.score > 45) {
    push({
      engine: "Anomaly",
      label: `Distribution anomaly ${ctx.anomaly.score.toFixed(0)}`,
      detail: ctx.anomaly.reasons.join(" ") || "Distribution deviating from expectation.",
      weight: -clamp(ctx.anomaly.score / 130, 0, 0.8),
      n: base.n,
    });
  }

  // ── Refinement layer 1: losing-digit threat ─────────────────────────
  const s = ctx.settings;
  const losers: number[] = [];
  for (let d = 0; d < 10; d++) if (!winSet.has(d)) losers.push(d);

  const threat = losingDigitThreat(ctx.intel, ctx.digits, winners, spec.label);
  const alerts = [...threat.alerts];

  if (threat.threats.length) {
    const worst = threat.threats[0];
    push({
      engine: "Losing Digit Threat",
      label: `Worst losing digit ${worst.digit} — threat ${worst.score.toFixed(0)} (${worst.state})`,
      detail: `${worst.drivers.join("; ") || "No individual driver above threshold."} Group threat ${threat.groupThreat.toFixed(0)}, ${threat.risingLosers.length} losing digits rising, recurrence ${threat.recurrence}.`,
      weight: -clamp(threat.groupThreat / 100, 0, 1),
      n: ctx.intel.n,
    });
  }
  push({
    engine: "Digit Group Pressure",
    label:
      threat.asymmetry >= 0
        ? "Winning group holds the pressure"
        : "Losing group holds the pressure",
    detail: `Winning group ${(threat.winning.share * 100).toFixed(1)}% vs baseline ${(threat.winning.baseline * 100).toFixed(1)}%; losing group ${(threat.losing.share * 100).toFixed(1)}% vs baseline ${(threat.losing.baseline * 100).toFixed(1)}%.`,
    weight: clamp(threat.asymmetry, -1, 1),
    n: ctx.intel.n,
  });

  // ── Refinement layer 2: critical digit protection ───────────────────
  // Reliability is evidence-driven: an unvalidated structure cannot dominate.
  const criticalReliability =
    ctx.analogue && ctx.analogue.n >= 120 ? 0.9 : ctx.analogue && ctx.analogue.n >= 30 ? 0.55 : 0.3;
  const critical = criticalConflict(
    ctx.criticalReport,
    losers,
    s.criticalPenalty,
    criticalReliability,
  );
  if (critical.conflicts.length) {
    push({
      engine: "Critical Digit Protection",
      label: `${critical.conflicts.length} critical structure(s) on the losing side`,
      detail: `${critical.detail} Penalty ${critical.penalty.toFixed(1)} (reliability ${(criticalReliability * 100).toFixed(0)}%).`,
      weight: -clamp(critical.penalty / s.criticalPenalty, 0, 1),
      n: ctx.bars.n,
    });
  }

  // ── Refinement layer 3: statistical validation ──────────────────────
  const winSeq = tail(ctx.digits, WINDOW_BASE).map((d) => winSet.has(d));
  const stats = statisticalReport(
    ctx.stats.freq,
    winSeq,
    ctx.analogue?.n ?? 0,
    ctx.analogue ? ctx.analogue.rate - theoretical : 0,
    s.significanceAlpha,
  );
  const rate = shrinkRate(base.w, base.n, theoretical, s.shrinkageStrength);
  push({
    engine: "Statistical Validation",
    label: `${stats.grade} — adjusted rate ${(rate.adjusted * 100).toFixed(1)}% (${rate.confidence} confidence)`,
    detail: `${stats.notes.join(" ")} Wilson 95% interval ${(rate.lower * 100).toFixed(1)}–${(rate.upper * 100).toFixed(1)}% on ${rate.n} ticks.`,
    weight:
      stats.grade === "HISTORICALLY VALIDATED"
        ? 0.5
        : stats.grade === "STATISTICALLY SUPPORTED"
          ? 0.25
          : -0.3,
    n: rate.n,
  });
  if (base.n < s.minSample) {
    alerts.push(
      `SAMPLE BELOW MINIMUM — ${base.n}/${s.minSample} ticks; the rate is shrunk toward ${(theoretical * 100).toFixed(0)}%.`,
    );
  }

  // ── Refinement layer 4: validated model ensemble ────────────────────
  const ens = ctx.ensemble;
  if (ens) {
    push({
      engine: "Model Ensemble",
      label:
        ens.validated > 0
          ? `${ens.validated} validated model(s), ${(ens.probability * 100).toFixed(1)}% win probability`
          : "MODEL NOT VALIDATED",
      detail: ens.disagreement,
      weight: clamp(ens.signal, -1, 1),
      n: ens.models.reduce((a, m) => a + m.testN, 0),
    });
  }

  // ── Refinement layer 5: bar structure (supporting evidence only) ────
  if (ctx.bars.current) {
    push({
      engine: "Bar Structure",
      label: `${ctx.bars.consecutive}× ${ctx.bars.current.color} bar${ctx.bars.longGreenSequence ? " (long green sequence)" : ""}`,
      detail: `Green rate ${(ctx.bars.greenRate * 100).toFixed(1)}%, persistence ${(ctx.bars.directionalPersistence * 100).toFixed(1)}%, reversal rate ${(ctx.bars.reversalRate * 100).toFixed(1)}%. Supporting evidence only.`,
      weight: clamp(
        (ctx.bars.directionalPersistence - 0.5) * (spec.side === "OVER" ? 0.6 : -0.6),
        -0.35,
        0.35,
      ),
      n: ctx.bars.n,
    });
  }

  // ── Composite edge (−100..100) ───────────────────────────────────────
  // Built on the interval-bounded, shrunk rate — never on a raw hit rate —
  // and reduced directly by measured losing-side threat.
  const adjustedEdgeLB = rate.lower - theoretical;
  const threatDrag =
    (Math.max(0, threat.groupThreat - s.threatThreshold) / Math.max(1, 100 - s.threatThreshold)) *
    34;
  const threatPenalty = clamp(threatDrag + critical.penalty);

  const compositeEdge = clamp(
    adjustedEdgeLB * 100 * 3.2 +
      (recent.p - theoretical) * 100 * 1.0 +
      threat.asymmetry * s.pressureWeight +
      pressureAsymmetry * 6 +
      transitionSupport * 8 +
      (ens ? ens.signal * s.modelWeight : 0) +
      (stats.grade === "HISTORICALLY VALIDATED"
        ? 6
        : stats.grade === "STATISTICALLY SUPPORTED"
          ? 2
          : -6) -
      threatPenalty,
    -100,
    100,
  );

  // ── Stability: how steady the composite edge has been ───────────────
  const hist = tail([...ctx.edgeHistory, compositeEdge], 40);
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd =
    hist.length > 1
      ? Math.sqrt(hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (hist.length - 1))
      : 0;
  const sameSign =
    hist.filter((v) => Math.sign(v) === Math.sign(compositeEdge)).length / hist.length;
  const stability = clamp(100 - sd * 4) * 0.6 + clamp(sameSign * 100) * 0.4;

  // ── Freshness: data age + how young this positive state is ──────────
  const ageTicks =
    ctx.prev && Math.sign(ctx.prev.compositeEdge) === Math.sign(compositeEdge)
      ? ctx.prev.ageTicks + 1
      : 0;
  const dataFresh = clamp(100 - ctx.dataAgeMs / 60);
  const shapeFresh = ageTicks <= 3 ? 70 + ageTicks * 8 : clamp(100 - (ageTicks - 6) * 1.6);
  const freshness = clamp(dataFresh * 0.5 + shapeFresh * 0.5);

  // ── Contradiction ───────────────────────────────────────────────────
  const negWeight = conflicts.reduce((a, e) => a + Math.abs(e.weight), 0);
  const posWeight = supports.reduce((a, e) => a + Math.abs(e.weight), 0);
  const contradiction = clamp((negWeight / Math.max(0.001, negWeight + posWeight)) * 100);

  // ── Danger ──────────────────────────────────────────────────────────
  const danger = clamp(
    ctx.anomaly.score * 0.22 +
      (ctx.volatility.ratio > 1 ? (ctx.volatility.ratio - 1) * 45 : 0) +
      contradiction * 0.25 +
      threat.groupThreat * 0.35 +
      (threat.recurrence === "SEVERE" ? 12 : threat.recurrence === "ACTIVE" ? 6 : 0) +
      (base.n < s.minSample ? ((s.minSample - base.n) / s.minSample) * 25 : 0) +
      (ctx.regime.label === "CHAOTIC" ? 18 : 0),
  );

  // ── Quality: is this a measurement we can trust? ────────────────────
  const sampleQ = clamp((base.n / WINDOW_BASE) * 100);
  const quality = clamp(
    ctx.quality.score * 0.4 +
      sampleQ * 0.25 +
      clamp(100 - contradiction) * 0.15 +
      (stats.thin ? 0 : 10) +
      (rate.confidence === "HIGH" ? 10 : rate.confidence === "MODERATE" ? 6 : 0),
  );

  const confidence = clamp(
    clamp(50 + compositeEdge * 0.45) * 0.35 +
      stability * 0.15 +
      quality * 0.15 +
      clamp(100 - danger) * 0.15 +
      (ens && ens.validated ? ens.agreement : 25) * 0.2,
  );

  // ── Regime compatibility ────────────────────────────────────────────
  const regimeCompatible =
    ctx.regime.label !== "CHAOTIC" &&
    !(
      ctx.regime.label === "SKEWED" &&
      ((spec.side === "UNDER" && ctx.pressure.zoneBShare > 0.55) ||
        (spec.side === "OVER" && ctx.pressure.zoneAShare > 0.55))
    );
  const regimeNote = `${ctx.regime.label} regime — ${regimeCompatible ? "compatible" : "opposed"}. ${ctx.regime.detail}`;

  const baseOpportunity = clamp(
    clamp(50 + compositeEdge * 0.5) * 0.38 +
      quality * 0.14 +
      stability * 0.13 +
      freshness * 0.08 +
      clamp(100 - danger) * 0.17 +
      (ens && ens.validated ? ens.agreement : 30) * 0.1,
  );

  // ── Forward projection ──────────────────────────────────────────────
  const forward = forwardProjection(
    spec.label,
    ctx.intel,
    threat,
    ctx.bars,
    ctx.regime.label,
    ctx.entropyDelta,
    ctx.analogue,
    s.forecastHorizon,
  );

  // ── Fake-edge interrogation (runs last, then downgrades the score) ──
  const draft: ContractEval = {
    id: spec.id,
    label: spec.label,
    side: spec.side,
    barrier: spec.barrier,
    winners,
    theoretical,
    empirical: base.p,
    recent: recent.p,
    micro: micro.p,
    n: base.n,
    edge,
    edgeLB,
    pressureAsymmetry,
    transitionSupport,
    compositeEdge,
    stability,
    freshness,
    quality,
    danger,
    confidence,
    opportunity: baseOpportunity,
    phase: derivePhase(compositeEdge, ageTicks, ctx.prev, contradiction),
    supports: supports.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    conflicts: conflicts.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    contradiction,
    ageTicks,
    threat,
    critical,
    stats,
    rate,
    ensemble: ens,
    forward,
    analogue: ctx.analogue,
    fakeEdge: null,
    regimeCompatible,
    regimeNote,
    threatPenalty,
    alerts,
  };

  const fakeEdge = fakeEdgeCheck(draft, s.minSample);
  let opportunity = clamp(baseOpportunity * fakeEdge.multiplier);

  // Hard threat veto — a dangerous losing side cannot be an opportunity.
  if (threat.groupThreat >= s.threatVeto) {
    opportunity = Math.min(opportunity, 34);
    alerts.push(
      `THREAT VETO — losing-digit group threat ${threat.groupThreat.toFixed(0)} exceeds the ${s.threatVeto} veto level.`,
    );
  }
  if (fakeEdge.verdict === "REJECTED") {
    opportunity = Math.min(opportunity, 38);
    alerts.push(`FAKE-EDGE REJECTION — ${fakeEdge.failures} interrogation checks failed.`);
  }
  if (!regimeCompatible) opportunity = Math.min(opportunity, 55);

  // ── LOSING-SIDE DIGIT INTELLIGENCE ──────────────────────────────────
  // Every digit that can make this contract lose is aggregated into one
  // named, bounded ranking modifier. It dampens — it never flips a ranking.
  const lsp = losingSidePressure(threat);
  const applied = applyLosingSidePressure(opportunity, lsp);
  opportunity = applied.opportunity;
  if (applied.pressure.state === "HOSTILE" || applied.pressure.state === "PRESSURED") {
    alerts.push(applied.pressure.reason);
  }

  // ── WINNING-SIDE DIGIT MOMENTUM ──────────────────────────────────────
  // Symmetric counterpart: reward-only, capped, confirms rather than flips.
  const wsm = winningSideMomentum(ctx.intel, winners);
  const appliedWsm = applyWinningSideMomentum(opportunity, wsm);
  opportunity = appliedWsm.opportunity;
  if (appliedWsm.momentum.state === "SURGING") {
    alerts.push(appliedWsm.momentum.reason);
  }

  // ── SUPPRESS — hard gate, independent of the bounded modifier above ──
  // A HOSTILE + broad losing side (2+ losing digits rising at once) hard
  // caps opportunity outright — the "flag down the signal" behaviour the
  // ~28%-max modifier could never produce on its own.
  if (applied.pressure.verdict === "SUPPRESS") {
    opportunity = Math.min(opportunity, 34);
    alerts.push(`LOSING_SIDE_SUPPRESS — ${applied.pressure.reason}`);
  }

  const phase: SetupPhase =
    threat.groupThreat >= s.threatVeto ||
    fakeEdge.verdict === "REJECTED" ||
    applied.pressure.verdict === "SUPPRESS"
      ? "INVALIDATING"
      : draft.phase;

  return {
    ...draft,
    opportunity,
    phase,
    fakeEdge,
    alerts,
    losingSidePressure: applied.pressure,
    winningSideMomentum: appliedWsm.momentum,
  };
}

function derivePhase(
  composite: number,
  ageTicks: number,
  prev: ContractEval | undefined,
  contradiction: number,
): SetupPhase {
  if (composite <= 0) return contradiction > 60 ? "INVALIDATING" : "FORMING";
  const falling = prev ? composite < prev.compositeEdge - 2 : false;
  if (falling && contradiction > 55) return "INVALIDATING";
  if (falling) return "WEAKENING";
  if (ageTicks <= 4) return "FRESH";
  if (ageTicks <= 40) return "MATURE";
  return "WEAKENING";
}
