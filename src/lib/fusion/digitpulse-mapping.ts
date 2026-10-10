/**
 * DIGITPULSE -> SENTINEL EVIDENCE MAPPING.
 *
 * DigitPulse never produces a competing final decision. Each of its engines is
 * mapped, explicitly and testably, into the Sentinel evidence dimension it
 * genuinely speaks to. Sentinel's confluence weights remain authoritative; this
 * layer only enriches the dimensions Sentinel already reasons over.
 */
import type {
  ContractAnalysis as DigitPulseContract,
  MarketAnalysis as DigitPulseMarket,
} from "@/lib/liquidity/engine";
import type { Proposition } from "@/lib/propositions";
import { propositionSide } from "@/lib/propositions";

/** The Sentinel evidence dimensions DigitPulse may contribute to. */
export type SentinelDimension =
  | "PSYCHOLOGY"
  | "PRESSURE"
  | "LIQUIDITY"
  | "DANGER"
  | "CONFIRMATION"
  | "REGIME"
  | "ENGINE_AGREEMENT";

export type EvidenceStance = "SUPPORTING" | "OPPOSING" | "NEUTRAL";

export interface DigitPulseReading {
  /** DigitPulse engine name, kept inspectable for the diagnostics surface. */
  engine: string;
  label: string;
  /** Raw engine value, 0..100 unless the engine is inherently signed. */
  value: number | null;
  /** Sentinel dimension this engine enriches. */
  dimension: SentinelDimension;
  stance: EvidenceStance;
  detail: string;
}

export interface DigitPulseEvidence {
  market: string;
  proposition: Proposition;
  available: boolean;
  sample: number;
  /** DigitPulse's own read of the side, derived from its engines only. */
  side: "OVER" | "UNDER" | "NONE";
  lifecycle: string | null;
  readings: DigitPulseReading[];
  supporting: DigitPulseReading[];
  opposing: DigitPulseReading[];
  vetoes: string[];
  narrative: string[];
  /** 0..100 strength of DigitPulse's evidence for this exact proposition. */
  strength: number;
  /** 0..100 DigitPulse-observed danger against this proposition. */
  danger: number;
  persistence: number;
  confirmed: boolean;
  ripe: boolean;
}

/** The published mapping table — also asserted by the test suite. */
export const DIGITPULSE_DIMENSION_MAP: Record<string, SentinelDimension> = {
  reservoir: "LIQUIDITY",
  exhaustion: "PRESSURE",
  delivery: "CONFIRMATION",
  migration: "REGIME",
  absorption: "LIQUIDITY",
  confirmation: "CONFIRMATION",
  conflict: "ENGINE_AGREEMENT",
  boundaryPressure: "PRESSURE",
  regime: "REGIME",
  entropy: "REGIME",
  changePoint: "REGIME",
  transition: "PRESSURE",
  sweep: "LIQUIDITY",
  digitMomentum: "PSYCHOLOGY",
  bayesianBaseline: "PSYCHOLOGY",
  lifecycle: "CONFIRMATION",
  persistence: "CONFIRMATION",
  trajectory: "CONFIRMATION",
  danger: "DANGER",
  psychology1000: "PSYCHOLOGY",
};

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const num = (n: number | undefined | null): number | null =>
  typeof n === "number" && Number.isFinite(n) ? n : null;

function reading(
  engine: string,
  label: string,
  value: number | null,
  stance: EvidenceStance,
  detail: string,
): DigitPulseReading {
  return { engine, label, value, dimension: DIGITPULSE_DIMENSION_MAP[engine], stance, detail };
}

function stanceFrom(value: number | null, good: number, bad: number): EvidenceStance {
  if (value === null) return "NEUTRAL";
  if (value >= good) return "SUPPORTING";
  if (value <= bad) return "OPPOSING";
  return "NEUTRAL";
}

function invertedStance(value: number | null, badAbove: number): EvidenceStance {
  if (value === null) return "NEUTRAL";
  return value >= badAbove ? "OPPOSING" : "SUPPORTING";
}

export function emptyDigitPulseEvidence(market: string, proposition: Proposition): DigitPulseEvidence {
  return {
    market,
    proposition,
    available: false,
    sample: 0,
    side: "NONE",
    lifecycle: null,
    readings: [],
    supporting: [],
    opposing: [],
    vetoes: [],
    narrative: [],
    strength: 0,
    danger: 0,
    persistence: 0,
    confirmed: false,
    ripe: false,
  };
}

/**
 * Adapts one DigitPulse contract analysis (already computed on the shared
 * canonical tick history) into Sentinel-shaped proposition evidence.
 */
export function mapDigitPulseEvidence(
  market: string,
  proposition: Proposition,
  marketAnalysis: DigitPulseMarket | null | undefined,
  contract: DigitPulseContract | null | undefined,
): DigitPulseEvidence {
  if (!marketAnalysis || !contract) return emptyDigitPulseEvidence(market, proposition);

  const v3 = contract.v3;
  const readings: DigitPulseReading[] = [
    reading(
      "reservoir",
      "Reservoir",
      num(contract.reservoirScore ?? v3?.reservoirScore),
      stanceFrom(num(contract.reservoirScore ?? v3?.reservoirScore), 55, 25),
      "Opposing-side liquidity held in reserve on the losing digits.",
    ),
    reading(
      "exhaustion",
      "Exhaustion",
      num(contract.exhaustion ?? contract.exhaustionScore),
      stanceFrom(num(contract.exhaustion ?? contract.exhaustionScore), 55, 25),
      "Degree to which the opposing digits have spent their pressure.",
    ),
    reading(
      "delivery",
      "Delivery",
      num(contract.release ?? contract.deliveryScore),
      stanceFrom(num(contract.release ?? contract.deliveryScore), 55, 25),
      "Whether stored liquidity is actually being released into the winning side.",
    ),
    reading(
      "migration",
      "Migration",
      num(contract.migrationScore ?? v3?.migrationScore),
      stanceFrom(num(contract.migrationScore ?? v3?.migrationScore), 55, 25),
      "Structural migration of the digit distribution across the barrier.",
    ),
    reading(
      "absorption",
      "Absorption",
      num(contract.absorption ?? contract.absorptionScore),
      stanceFrom(num(contract.absorption ?? contract.absorptionScore), 55, 25),
      "Winning side absorbing opposing attempts without breaking.",
    ),
    reading(
      "confirmation",
      "Confirmation",
      num(contract.confirmation ?? contract.confirmationScore),
      stanceFrom(num(contract.confirmation ?? contract.confirmationScore), 55, 25),
      "Multi-dimensional confirmation score across DigitPulse dimensions.",
    ),
    reading(
      "conflict",
      "Conflict",
      num(contract.conflict ?? contract.conflictScore),
      invertedStance(num(contract.conflict ?? contract.conflictScore), 50),
      "Internal DigitPulse conflict — raises engine disagreement, never a bonus.",
    ),
    reading(
      "boundaryPressure",
      "Boundary pressure",
      num(contract.boundaryAttack),
      invertedStance(num(contract.boundaryAttack), 55),
      "Attacks against the barrier's boundary digits.",
    ),
    reading(
      "regime",
      `Regime — ${marketAnalysis.regime?.state ?? "UNKNOWN"}`,
      num(marketAnalysis.regimeDanger),
      invertedStance(num(marketAnalysis.regimeDanger), 55),
      "DigitPulse regime state and its danger to a developing proposition.",
    ),
    reading(
      "entropy",
      "Entropy",
      num(marketAnalysis.entropy),
      "NEUTRAL",
      "Distribution entropy — stability context for the regime dimension.",
    ),
    reading(
      "changePoint",
      "Change point",
      num(marketAnalysis.changePoint),
      invertedStance(num(marketAnalysis.changePoint), 60),
      "Page-Hinkley change-point evidence that the regime just broke.",
    ),
    reading(
      "transition",
      "Transition stability",
      num(marketAnalysis.transitionStability),
      stanceFrom(num(marketAnalysis.transitionStability), 55, 25),
      "Stability of the Markov digit-transition structure.",
    ),
    reading(
      "sweep",
      `Sweep — ${marketAnalysis.sweep?.side ?? "NONE"}`,
      num(marketAnalysis.sweep?.intensity),
      sweepStance(proposition, marketAnalysis),
      "DigitPulse sweep detector; supplements Sentinel's authoritative sweep logic.",
    ),
    reading(
      "digitMomentum",
      "Digit momentum",
      momentumFor(proposition, marketAnalysis),
      stanceFrom(momentumFor(proposition, marketAnalysis), 55, 40),
      "Momentum share carried by the proposition's winning digits.",
    ),
    reading(
      "bayesianBaseline",
      "Bayesian baseline",
      num(contract.bayesian !== undefined ? contract.bayesian * 100 : null),
      stanceFrom(
        num(contract.bayesian !== undefined ? contract.bayesian * 100 : null),
        contract.barrier >= 6 ? 72 : 62,
        50,
      ),
      "Shrunk win-share estimate versus the theoretical baseline.",
    ),
    reading(
      "lifecycle",
      `Lifecycle — ${v3?.lifecycle ?? contract.state ?? "UNKNOWN"}`,
      null,
      v3?.lifecycle === "RIPE" || contract.ripe ? "SUPPORTING" : "NEUTRAL",
      "DigitPulse liquidity lifecycle stage for this proposition.",
    ),
    reading(
      "persistence",
      "Persistence",
      num(marketAnalysis.persistence),
      stanceFrom(num(marketAnalysis.persistence), 55, 25),
      "How persistently the condition has held rather than flickering.",
    ),
    reading(
      "trajectory",
      "Trajectory",
      num(v3?.ageTicks ?? null),
      "NEUTRAL",
      "Age of the opportunity in ticks — feeds temporal confirmation.",
    ),
    reading(
      "danger",
      "DigitPulse danger",
      num(contract.danger),
      invertedStance(num(contract.danger), 55),
      "Danger DigitPulse observes against this proposition's losing side.",
    ),
    reading(
      "psychology1000",
      "1,000-tick psychology",
      num(marketAnalysis.sentinelPsychology?.sampleSize ?? null),
      marketAnalysis.sentinelPsychology?.outcome === "ACCEPT"
        ? "SUPPORTING"
        : marketAnalysis.sentinelPsychology?.outcome === "REJECT"
          ? "OPPOSING"
          : "NEUTRAL",
      "1,000-tick structural psychology verdict for the market.",
    ),
  ];

  const supporting = readings.filter((r) => r.stance === "SUPPORTING");
  const opposing = readings.filter((r) => r.stance === "OPPOSING");

  const strengthInputs = [
    num(contract.confirmation ?? contract.confirmationScore),
    num(contract.reservoirScore ?? v3?.reservoirScore),
    num(contract.release ?? contract.deliveryScore),
    num(contract.absorption ?? contract.absorptionScore),
  ].filter((n): n is number => n !== null);
  const strength = strengthInputs.length
    ? clamp(strengthInputs.reduce((a, b) => a + b, 0) / strengthInputs.length)
    : 0;

  return {
    market,
    proposition,
    available: true,
    sample: marketAnalysis.sample ?? 0,
    side: dpSide(marketAnalysis, proposition, strength, contract),
    lifecycle: v3?.lifecycle ?? contract.state ?? null,
    readings,
    supporting,
    opposing,
    vetoes: contract.vetoes ?? [],
    narrative: contract.evidence ?? [],
    strength,
    danger: clamp(num(contract.danger) ?? 0),
    persistence: clamp(num(marketAnalysis.persistence) ?? 0),
    confirmed: Boolean(contract.confirmed),
    ripe: Boolean(contract.ripe || v3?.lifecycle === "RIPE"),
  };
}

function momentumFor(proposition: Proposition, analysis: DigitPulseMarket): number | null {
  const momentum = analysis.digitMomentum;
  if (!Array.isArray(momentum) || momentum.length < 10) return null;
  const side = propositionSide(proposition);
  const threshold = Number(proposition.replace(/\D/g, ""));
  const winners = side === "OVER" ? range(threshold + 1, 9) : range(0, threshold - 1);
  const total = momentum.reduce((a, b) => a + Math.abs(b), 0);
  if (total <= 0) return null;
  const share = winners.reduce((a, d) => a + Math.abs(momentum[d] ?? 0), 0) / total;
  return clamp(share * 100);
}

function sweepStance(proposition: Proposition, analysis: DigitPulseMarket): EvidenceStance {
  const sweep = analysis.sweep;
  if (!sweep || !sweep.active || sweep.side === "NONE") return "NEUTRAL";
  const side = propositionSide(proposition);
  // A completed sweep of the LOW digits releases pressure upward (helps OVER).
  if (side === "OVER") return sweep.side === "LOW" ? "SUPPORTING" : "OPPOSING";
  return sweep.side === "HIGH" ? "SUPPORTING" : "OPPOSING";
}

function dpSide(
  analysis: DigitPulseMarket,
  proposition: Proposition,
  strength: number,
  contract: DigitPulseContract,
): "OVER" | "UNDER" | "NONE" {
  if (strength < 45 && !contract.confirmed) return "NONE";
  const best = Object.values(analysis.v3Opportunities ?? {})
    .filter((o) => o && typeof o.confirmationScore === "number")
    .sort((a, b) => b.confirmationScore - a.confirmationScore)[0];
  if (best?.side) return best.side === "OVER" || best.side === "UNDER" ? best.side : "NONE";
  return propositionSide(proposition);
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
