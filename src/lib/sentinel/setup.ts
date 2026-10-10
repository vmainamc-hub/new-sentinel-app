// APEX SENTINEL — STAGE 2: SETUP SCORE.
//
// Stage 1 (direction.ts) answers "which way does the measured evidence point?".
// Stage 2a (danger.ts) answers "what is actively dangerous right now, and by
// how much?". This module composes the two into ONE quality figure for the
// setup — belief discounted by measured danger and by how much evidence is
// actually standing behind that belief.
//
// Nothing here invents a number. Every deduction is an attributed line item
// with the measured value that produced it, so the operator can always read
// back why a setup scored what it scored.
import type { ContractEval, MarketIntel } from "../apex/types";
import type { SimPerformance } from "../apex/simulator";
import { computeDirection, type DirectionReport } from "./direction";
import { composeDanger, type DangerComposition } from "./danger";

export interface SetupFactor {
  code: string;
  label: string;
  /** Points contributed to the setup score (may be negative). */
  points: number;
  /** The measured value behind the contribution. */
  value: number | null;
  detail: string;
}

export type SetupGrade = "PRIME" | "GOOD" | "MARGINAL" | "POOR" | "UNUSABLE";

export interface SetupReport {
  /** 0..100 — direction quality after danger and evidence discounting. */
  score: number;
  grade: SetupGrade;
  /** 0..100 — how much measured evidence stands behind this setup. */
  confidence: number;
  /** Sample size the setup rests on (contract-resolved entries). */
  sampleSize: number;
  /** Sample size of the rolling window used for the deterioration check. */
  recentSampleSize: number;
  direction: DirectionReport;
  danger: DangerComposition;
  factors: SetupFactor[];
  /** True when a Stage 2a component forces a block regardless of score. */
  autoBlocked: boolean;
  summary: string;
}

export interface SetupInputs {
  intel: MarketIntel;
  contract: ContractEval;
  /** Contract-resolved lifetime record for THIS market + contract. */
  lifetime: SimPerformance | null;
  /** Rolling-window record for THIS market + contract. */
  recent: SimPerformance | null;
  /** Pre-computed Stage 1 output; recomputed when omitted. */
  direction?: DirectionReport;
  /** Pre-computed Stage 2a output; recomputed when omitted. */
  danger?: DangerComposition;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

function gradeFor(score: number, autoBlocked: boolean): SetupGrade {
  if (autoBlocked) return "UNUSABLE";
  if (score >= 78) return "PRIME";
  if (score >= 64) return "GOOD";
  if (score >= 50) return "MARGINAL";
  if (score >= 34) return "POOR";
  return "UNUSABLE";
}

/**
 * STAGE 2 — compose Direction (Stage 1) with the Danger composition (Stage 2a).
 *
 * The danger total is NOT subtracted raw: it is applied as a proportional
 * discount so a strong direction in a mildly dangerous market still ranks
 * above a weak direction in a calm one, while severe danger collapses the
 * setup no matter how confident the direction is.
 */
export function computeSetup(input: SetupInputs): SetupReport {
  const { intel, contract: c, lifetime, recent } = input;
  const direction = input.direction ?? computeDirection(intel, c);
  const danger = input.danger ?? composeDanger({ intel, contract: c, lifetime, recent });

  const factors: SetupFactor[] = [];
  const add = (
    code: string,
    label: string,
    points: number,
    detail: string,
    value: number | null = null,
  ) => factors.push({ code, label, points: r1(points), value, detail });

  // ── Base: the Stage 1 belief ──────────────────────────────────────────
  add(
    "DIRECTION",
    "Stage 1 direction score",
    direction.score,
    `${direction.label} — ${direction.supporting.length} supporting vote(s), ${direction.opposing.length} opposing, disagreement ${direction.disagreement.toFixed(0)}/100.`,
    direction.score,
  );

  // ── Danger discount: proportional, never a flat subtraction ───────────
  const dangerFactor = danger.total / 100;
  const dangerDiscount = -(direction.score * dangerFactor * 0.55);
  add(
    "DANGER_DISCOUNT",
    "Danger composition discount",
    dangerDiscount,
    `Composed danger ${danger.total.toFixed(0)}/100 (${danger.level}) from ${danger.components.length} labelled component(s) — removes ${(dangerFactor * 55).toFixed(0)}% of the direction belief.`,
    danger.total,
  );

  // ── Severe components bite harder than their point share ─────────────
  const severePenalty = -Math.min(18, danger.severe.length * 6);
  add(
    "SEVERE_COMPONENTS",
    "Severe danger components",
    severePenalty,
    danger.severe.length
      ? danger.severe.map((s) => `${s.label} (${s.severity})`).join(" · ")
      : "No HIGH or SEVERE danger component measured.",
    danger.severe.length,
  );

  // ── Evidence maturity: authority scales with contract-resolved sample ─
  const n = lifetime?.n ?? 0;
  const maturity = n >= 120 ? 1 : n / 120;
  const maturityPoints = (maturity - 0.5) * 10;
  add(
    "EVIDENCE_MATURITY",
    "Contract-resolved sample",
    maturityPoints,
    n
      ? `N=${n} resolved entries on this market + contract (${lifetime?.tier ?? "—"}, ${lifetime?.health ?? "—"}); authority ×${maturity.toFixed(2)}.`
      : "No contract-resolved sample yet on this market + contract — the setup rests on live statistics only.",
    n,
  );

  // ── Realised edge: only when the sample can support it ───────────────
  const edgePoints =
    lifetime && lifetime.n >= 20 ? clamp((lifetime.lower - c.theoretical) * 100 * 0.6, -14, 10) : 0;
  add(
    "REALISED_EDGE",
    "Realised edge (95% lower bound)",
    edgePoints,
    lifetime && lifetime.n >= 20
      ? `Wilson LB ${(lifetime.lower * 100).toFixed(1)}% vs theoretical ${(c.theoretical * 100).toFixed(1)}% over N=${lifetime.n}.`
      : `Sample too small for a realised-edge claim (N=${n} < 20) — no influence.`,
    lifetime && lifetime.n >= 20 ? r1((lifetime.lower - c.theoretical) * 100) : null,
  );

  // ── Deterioration: the rolling window against the lifetime record ────
  const deterioration = recent && recent.n >= 10 ? clamp(recent.deteriorationPp * 0.35, -12, 6) : 0;
  add(
    "DETERIORATION",
    "Rolling-window drift",
    deterioration,
    recent && recent.n >= 10
      ? `Recent window ${(recent.winRate * 100).toFixed(1)}% over N=${recent.n} — drift ${recent.deteriorationPp >= 0 ? "+" : ""}${recent.deteriorationPp.toFixed(1)}pp against the lifetime record.`
      : `Rolling window has N=${recent?.n ?? 0} (< 10) — no drift influence.`,
    recent?.deteriorationPp ?? null,
  );

  // ── Disagreement already cost Stage 1 points; surface the residual ───
  const conflictPenalty = -Math.min(10, direction.disagreement * 0.1);
  add(
    "ENGINE_CONFLICT",
    "Residual engine conflict",
    conflictPenalty,
    direction.opposing.length
      ? `${direction.opposing.length} engine(s) fighting the direction: ${direction.opposing.map((v) => v.engine).join(", ")}.`
      : "No engine is measurably fighting the direction.",
    direction.disagreement,
  );

  const raw = factors.reduce((a, f) => a + f.points, 0);
  const autoBlocked = danger.autoBlock.length > 0;
  const score = autoBlocked ? Math.min(r1(clamp(raw)), 25) : r1(clamp(raw));
  const grade = gradeFor(score, autoBlocked);

  // Confidence is about EVIDENCE, not about the score's size.
  const confidence = Math.round(
    clamp(
      direction.confidence * 0.5 +
        maturity * 100 * 0.3 +
        (recent && recent.n >= 10 ? 20 : (recent?.n ?? 0) * 2),
    ),
  );

  const summary = autoBlocked
    ? `SETUP UNUSABLE — ${danger.autoBlock.map((a) => a.label).join(" · ")}. Direction ${direction.score.toFixed(0)}/100 is irrelevant while an auto-block component is active.`
    : `SETUP ${grade} ${score.toFixed(0)}/100 — direction ${direction.score.toFixed(0)} (${direction.label}) discounted by danger ${danger.total.toFixed(0)} (${danger.level}); evidence confidence ${confidence}/100 over N=${n}.`;

  return {
    score,
    grade,
    confidence,
    sampleSize: n,
    recentSampleSize: recent?.n ?? 0,
    direction,
    danger,
    factors,
    autoBlocked,
    summary,
  };
}
