// SENTINEL — STAGE 1: DIRECTION SCORE (0–100).
//
// "Do we believe the contract direction?"
//
// This stage answers ONLY that question. It never looks at danger, at
// simulator safety, or at whether entering right now is wise — those belong to
// Stage 2 and Stage 3 and must remain separate, visible outputs.
//
// Engine disagreement NEVER auto-rejects here: it reduces the Direction Score
// proportionally to how much weight the opposing engines carry.
import type { ContractEval, MarketIntel } from "@/lib/apex/types";
import type { SentinelSpineReport } from "./proposal";

export type EngineStance = "SUPPORT" | "OPPOSE" | "NEUTRAL";

export interface DirectionEngineVote {
  /** Stable machine code for the engine. */
  engine: string;
  label: string;
  stance: EngineStance;
  /** −1..+1 — signed strength of this engine's opinion on the direction. */
  weight: number;
  /** Relative influence of this engine in the blend (sums to 1 across votes). */
  influence: number;
  /** Sample size behind the reading (0 = not sample-based). */
  n: number;
  detail: string;
}

export interface DirectionReport {
  /** 0..100 — belief in the direction, independent of safety. */
  score: number;
  /** 0..100 — how much measurable evidence stands behind the score. */
  confidence: number;
  label: "STRONG" | "MODERATE" | "WEAK" | "AGAINST";
  votes: DirectionEngineVote[];
  supporting: DirectionEngineVote[];
  opposing: DirectionEngineVote[];
  /** 0..100 — how much of the engine weight is fighting the direction. */
  disagreement: number;
  /** Points removed from the raw belief because engines disagree. */
  disagreementPenalty: number;
  summary: string;
  /** Read-only spine display fields (present once the decision spine is wired). */
  spine?: {
    structuralDirection: string;
    structuralConviction: number;
    pressureVerdict: string;
    vetoVerdict: string;
    /** Multiplier actually applied to the direction score. */
    gateModifier: number;
    aligned: boolean | null;
  };
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

interface RawVote {
  engine: string;
  label: string;
  /** −1..+1 */
  weight: number;
  /** Base influence before measurability scaling. */
  base: number;
  n: number;
  detail: string;
  /** 0..1 — how measurable this reading was (0 removes the vote entirely). */
  measurability: number;
}

/**
 * Stage 1. Every input is a real engine output on THIS market only — digit
 * statistics, pressure, transition/exhaustion, digit psychology, the validated
 * model ensemble and regime compatibility.
 */
export function computeDirection(
  intel: MarketIntel,
  c: ContractEval,
  spine?: SentinelSpineReport | null,
): DirectionReport {
  const raw: RawVote[] = [];

  // ── DECISION SPINE — structure owns direction ─────────────────────────
  // When the spine is wired, a contract whose side disagrees with the
  // 1,000-tick structural direction can never score as a direction candidate,
  // and the pressure / psychology votes below are removed: pressure is a gate,
  // not a vote.
  if (spine && spine.direction && spine.direction !== c.side) {
    return againstStructure(spine, c);
  }

  // ── Digit statistics: observed vs theoretical, interval-bounded ────────
  {
    const edge = c.edge; // fraction
    const lbEdge = c.edgeLB;
    const w = clamp(edge * 8, -1, 1);
    raw.push({
      engine: "DIGIT_STATS",
      label: "Digit statistics",
      weight: w,
      base: 0.24,
      n: c.n,
      measurability: c.n >= 200 ? 1 : c.n >= 60 ? 0.6 : c.n > 0 ? 0.25 : 0,
      detail: `Observed ${(c.empirical * 100).toFixed(1)}% vs theoretical ${(c.theoretical * 100).toFixed(1)}% over ${c.n} ticks (95% lower-bound edge ${(lbEdge * 100).toFixed(2)}pp).`,
    });
  }

  // ── Pressure engine: winning-side vs losing-side mass ─────────────────
  // Skipped entirely under the decision spine (pressure gates, never votes).
  if (!spine) {
    const asym = c.pressureAsymmetry; // −1..1
    raw.push({
      engine: "PRESSURE",
      label: "Pressure engine",
      weight: clamp(asym, -1, 1),
      base: 0.18,
      n: intel.stats?.n ?? 0,
      measurability: intel.pressure ? 1 : 0,
      detail: intel.pressure
        ? `Winning-side pressure asymmetry ${((asym ?? 0) * 100).toFixed(0)}% (zone migration ${(intel.pressure.migration ?? 0).toFixed(2)}).`
        : "Pressure engine has no reading on this market.",
    });
  }

  // ── Transition / exhaustion engine (observed Markov chain) ────────────
  {
    raw.push({
      engine: "TRANSITION",
      label: "Transition / exhaustion",
      weight: clamp(c.transitionSupport, -1, 1),
      base: 0.14,
      n: intel.transition?.rowN ?? 0,
      measurability:
        intel.transition && intel.transition.rowN >= 25 ? 1 : intel.transition ? 0.4 : 0,
      detail: intel.transition
        ? `Chain support ${(c.transitionSupport * 100).toFixed(0)}% from ${intel.transition.rowN} observed transitions (dependency ${(intel.transition.dependency * 100).toFixed(0)}%).`
        : "No transition chain observed yet.",
    });
  }

  // ── Digit psychology (OVER/UNDER release & gain patterns, crowd groups) ─
  // Skipped under the spine — Engine A already owns structural psychology.
  if (!spine) {
    const psy = intel.psychology;
    const pattern = psy ? (c.side === "OVER" ? psy.over : psy.under) : null;
    const opposite = psy ? (c.side === "OVER" ? psy.under : psy.over) : null;
    const net = pattern && opposite ? (pattern.score - opposite.score) / 100 : 0;
    raw.push({
      engine: "PSYCHOLOGY",
      label: "Digit psychology",
      weight: clamp(net * 1.6, -1, 1),
      base: 0.16,
      n: psy?.n ?? 0,
      measurability: pattern ? clamp(pattern.confidence / 100, 0, 1) : 0,
      detail: pattern
        ? `${pattern.side} pattern ${pattern.score}/100 vs opposite ${opposite?.score ?? 0}/100 (confidence ${pattern.confidence}/100). ${pattern.supporting[0] ?? pattern.note}`
        : "Psychology engine has no reading for this market yet.",
    });
  }

  // ── Crowd groups: EVEN/ODD/OVER/UNDER release-and-gain configuration ───
  {
    const groups = intel.psychology?.groups ?? [];
    const g = (name: string) => groups.find((x) => x.group === name) ?? null;
    const over = g("OVER");
    const under = g("UNDER");
    const even = g("EVEN");
    const odd = g("ODD");
    let w = 0;
    const parts: string[] = [];
    if (over && under) {
      const dir =
        c.side === "OVER" ? over.pressure - under.pressure : under.pressure - over.pressure;
      w += clamp(dir * 12, -0.7, 0.7);
      parts.push(
        `OVER ${(over.pressure * 100).toFixed(1)}pp vs UNDER ${(under.pressure * 100).toFixed(1)}pp`,
      );
    }
    if (even && odd) {
      // EVEN releasing while ODD gains supports OVER (7,9 sit in the OVER range
      // for the operator's contracts); the inverse supports UNDER.
      const oddGain = odd.pressure - even.pressure;
      const dir = c.side === "OVER" ? oddGain : -oddGain;
      w += clamp(dir * 8, -0.5, 0.5);
      parts.push(
        `EVEN ${(even.pressure * 100).toFixed(1)}pp vs ODD ${(odd.pressure * 100).toFixed(1)}pp`,
      );
    }
    raw.push({
      engine: "CROWD_GROUPS",
      label: "Crowd group configuration",
      weight: clamp(w, -1, 1),
      base: 0.1,
      n: intel.psychology?.n ?? 0,
      measurability: groups.length ? 1 : 0,
      detail: parts.length ? parts.join(" · ") : "Group pressure not measurable yet.",
    });
  }

  // ── ML / statistical model ensemble (validated models only) ───────────
  {
    const ens = c.ensemble;
    raw.push({
      engine: "MODEL",
      label: "Model ensemble",
      weight: ens && ens.validated > 0 ? clamp(ens.signal * 2, -1, 1) : 0,
      base: 0.1,
      n: ens?.validated ?? 0,
      measurability: ens && ens.validated > 0 ? clamp(ens.agreement / 100, 0.2, 1) : 0,
      detail: ens
        ? ens.validated > 0
          ? `${ens.validated} walk-forward validated model(s), signal ${ens.signal.toFixed(2)}, agreement ${ens.agreement.toFixed(0)}/100.`
          : "Models present but none validated out-of-sample — no directional influence."
        : "No model output on this market.",
    });
  }

  // ── Regime compatibility ──────────────────────────────────────────────
  {
    raw.push({
      engine: "REGIME",
      label: "Regime compatibility",
      weight: c.regimeCompatible ? 0.45 : -0.65,
      base: 0.08,
      n: 0,
      measurability: intel.regime
        ? clamp(
            (intel.regime.confidence ?? 70) / 100,
            0.3,
            1,
          )
        : 0,
      detail: intel.regime
        ? `${intel.regime.label} (confidence ${(intel.regime.confidence ?? 70).toFixed(0)}). ${c.regimeNote || (c.regimeCompatible ? "Regime supports this contract." : "Regime is outside this contract's validated range.")}`
        : "Regime not yet classified on this market.",
    });
  }

  const live = raw.filter((v) => v.measurability > 0);
  const totalInfluence = live.reduce((a, v) => a + v.base * v.measurability, 0);

  const votes: DirectionEngineVote[] = live.map((v) => ({
    engine: v.engine,
    label: v.label,
    stance: (Math.abs(v.weight) < 0.05
      ? "NEUTRAL"
      : v.weight > 0
        ? "SUPPORT"
        : "OPPOSE") as EngineStance,
    weight: Math.round(v.weight * 100) / 100,
    influence: totalInfluence
      ? Math.round(((v.base * v.measurability) / totalInfluence) * 100) / 100
      : 0,
    n: v.n,
    detail: v.detail,
  }));

  const belief = totalInfluence
    ? live.reduce((a, v) => a + v.weight * v.base * v.measurability, 0) / totalInfluence
    : 0;

  const supportMass = live
    .filter((v) => v.weight > 0.05)
    .reduce((a, v) => a + Math.abs(v.weight) * v.base * v.measurability, 0);
  const opposeMass = live
    .filter((v) => v.weight < -0.05)
    .reduce((a, v) => a + Math.abs(v.weight) * v.base * v.measurability, 0);
  const disagreement =
    supportMass + opposeMass ? Math.round((opposeMass / (supportMass + opposeMass)) * 100) : 0;

  // Disagreement reduces the score proportionally — it never blocks Stage 1.
  const disagreementPenalty = Math.round(disagreement * 0.25 * 10) / 10;

  // The gates DISCOUNT the measured direction score, they never erase it — a
  // veto is expressed as a block downstream, not by reporting "0 evidence".
  const gateModifier = spine
    ? clamp(Math.max(0.4, (spine.validation?.modifier ?? 1) * spine.veto.modifier), 0.4, 1.2)
    : 1;

  const rawScore = 50 + belief * 50;
  const score =
    Math.round(clamp((rawScore - disagreementPenalty) * gateModifier, 0, 100) * 10) / 10;

  // Confidence is measurability + breadth of evidence, not the score itself.
  const measuredShare = raw.length ? live.length / raw.length : 0;
  const sampleWeight = clamp((c.n || 0) / 600, 0, 1);
  const confidence = Math.round(
    clamp(measuredShare * 45 + sampleWeight * 35 + (100 - disagreement) * 0.2, 0, 100),
  );

  const label: DirectionReport["label"] =
    score >= 75 ? "STRONG" : score >= 60 ? "MODERATE" : score >= 45 ? "WEAK" : "AGAINST";

  const supporting = votes
    .filter((v) => v.stance === "SUPPORT")
    .sort((a, b) => b.influence - a.influence);
  const opposing = votes
    .filter((v) => v.stance === "OPPOSE")
    .sort((a, b) => b.influence - a.influence);

  const summary = `Direction ${score.toFixed(0)}/100 (${label}) — ${supporting.length} engine(s) support, ${opposing.length} oppose${
    disagreementPenalty > 0 ? `, −${disagreementPenalty.toFixed(1)} for disagreement` : ""
  }. ${supporting[0]?.detail ?? opposing[0]?.detail ?? "No measurable engine reading."}`;

  return {
    score,
    confidence,
    label,
    votes,
    supporting,
    opposing,
    disagreement,
    disagreementPenalty,
    summary: spine ? `${summary} SPINE: ${spine.headline}.` : summary,
    ...(spine ? { spine: spineDisplay(spine, c.side, gateModifier) } : {}),
  };
}

function spineDisplay(
  spine: SentinelSpineReport,
  side: string,
  gateModifier: number,
): NonNullable<DirectionReport["spine"]> {
  return {
    structuralDirection: spine.structure.direction,
    structuralConviction: spine.structure.conviction,
    pressureVerdict: spine.validation?.verdict ?? "—",
    vetoVerdict: spine.veto.verdict,
    gateModifier: Math.round(gateModifier * 1000) / 1000,
    aligned: spine.direction ? spine.direction === side : null,
  };
}

/** A contract fighting the structural direction is not a direction candidate. */
function againstStructure(spine: SentinelSpineReport, c: ContractEval): DirectionReport {
  const detail =
    `Structure (1,000 ticks) owns direction and says ${spine.structure.direction} ` +
    `with conviction ${spine.structure.conviction}/100; ${c.label} is ${c.side}.`;
  const vote: DirectionEngineVote = {
    engine: "STRUCTURE",
    label: "Structural direction (1,000t)",
    stance: "OPPOSE",
    weight: -1,
    influence: 1,
    n: 0,
    detail,
  };
  return {
    score: 0,
    confidence: Math.round(clamp(spine.structure.conviction, 0, 100)),
    label: "AGAINST",
    votes: [vote],
    supporting: [],
    opposing: [vote],
    disagreement: 100,
    disagreementPenalty: 0,
    summary: `Direction 0/100 (AGAINST) — ${detail}`,
    spine: spineDisplay(spine, c.side, 0),
  };
}

/** Utility kept local so scoring code never re-derives it inconsistently. */
export const directionSign = sign;
