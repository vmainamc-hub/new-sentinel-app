// APEX SENTINEL — RELATIVE EDGE.
//
// Absolute edge answers "is this candidate good?". Relative edge answers the
// question the operator actually asks: "is this the BEST available opportunity
// right now, among the alternatives?".
//
//   relativeEdge = candidateRiskAdjustedEdge − bestAlternativeComparableEdge
//
// A candidate does not need perfect absolute conditions to be #1 — it needs to
// be the strongest risk-adjusted opportunity in the current field. The lowest
// danger market is NOT automatically preferred: danger is priced into the
// risk-adjusted edge, it does not veto a materially stronger edge.

export type RelativeEdgeLabel = "STRONG" | "MODERATE" | "MARGINAL" | "LEVEL" | "BEHIND";

export interface RelativeEdgeInput {
  key: string;
  symbol: string;
  contract: string;
  /** Composite edge produced by the statistical engines, −100..100. */
  absoluteEdge: number;
  /** 0..100 measured danger for this candidate. */
  danger: number;
}

export interface RelativeEdgeReport {
  key: string;
  /** The engines' composite edge, unchanged. */
  absoluteEdge: number;
  /** Composite edge after the measured danger charge. */
  riskAdjustedEdge: number;
  /** riskAdjustedEdge − best comparable alternative (different market × contract). */
  relativeEdge: number;
  /** Same measure but only against other contracts on the SAME market. */
  relativeWithinMarket: number;
  /** 0..100 position of this candidate inside the current field. */
  normalized: number;
  /** Position in the field by risk-adjusted edge (1 = strongest). */
  fieldRank: number;
  fieldSize: number;
  label: RelativeEdgeLabel;
  /** Bounded ranking contribution in score points. */
  rankingDelta: number;
  detail: string;
}

/** Danger is priced, not vetoed: it charges the edge proportionally. */
export function riskAdjust(absoluteEdge: number, danger: number): number {
  const charge = Math.max(0, danger - 35) * 0.16;
  return Math.round((absoluteEdge - charge) * 100) / 100;
}

function labelOf(relative: number): RelativeEdgeLabel {
  if (relative >= 4) return "STRONG";
  if (relative >= 1.5) return "MODERATE";
  if (relative >= 0.4) return "MARGINAL";
  if (relative > -0.4) return "LEVEL";
  return "BEHIND";
}

export function computeRelativeEdges(inputs: RelativeEdgeInput[]): Map<string, RelativeEdgeReport> {
  const out = new Map<string, RelativeEdgeReport>();
  if (!inputs.length) return out;

  const adjusted = inputs.map((i) => ({ ...i, risk: riskAdjust(i.absoluteEdge, i.danger) }));
  const sorted = [...adjusted].sort((a, b) => b.risk - a.risk);
  const max = sorted[0].risk;
  const min = sorted[sorted.length - 1].risk;
  const span = Math.max(0.001, max - min);

  for (const c of adjusted) {
    // Best COMPARABLE alternative: any other market × contract candidate.
    let bestAlt = -Infinity;
    let bestAltKey = "";
    let bestSameMarket = -Infinity;
    let bestSameMarketKey = "";
    for (const o of adjusted) {
      if (o.key === c.key) continue;
      if (o.risk > bestAlt) {
        bestAlt = o.risk;
        bestAltKey = `${o.contract} on ${o.symbol}`;
      }
      if (o.symbol === c.symbol && o.risk > bestSameMarket) {
        bestSameMarket = o.risk;
        bestSameMarketKey = o.contract;
      }
    }
    const relative = bestAlt === -Infinity ? 0 : Math.round((c.risk - bestAlt) * 100) / 100;
    const within =
      bestSameMarket === -Infinity ? 0 : Math.round((c.risk - bestSameMarket) * 100) / 100;
    const fieldRank = sorted.findIndex((s) => s.key === c.key) + 1;
    const label = labelOf(relative);
    const rankingDelta = Math.round(Math.max(-6, Math.min(7, relative * 1.1)) * 10) / 10;

    out.set(c.key, {
      key: c.key,
      absoluteEdge: Math.round(c.absoluteEdge * 100) / 100,
      riskAdjustedEdge: c.risk,
      relativeEdge: relative,
      relativeWithinMarket: within,
      normalized: Math.round(((c.risk - min) / span) * 100),
      fieldRank,
      fieldSize: adjusted.length,
      label,
      rankingDelta,
      detail:
        bestAlt === -Infinity
          ? `Only candidate in the field — relative edge is undefined and contributes nothing.`
          : `Risk-adjusted edge ${c.risk.toFixed(2)} (absolute ${c.absoluteEdge.toFixed(2)} less a ${Math.max(0, c.danger - 35) * 0.16 > 0 ? (Math.max(0, c.danger - 35) * 0.16).toFixed(2) : "0.00"} danger charge at danger ${c.danger.toFixed(0)}/100) vs best alternative ${bestAltKey} at ${bestAlt.toFixed(2)} → relative edge ${relative >= 0 ? "+" : ""}${relative.toFixed(2)} (${label}). Field position ${fieldRank}/${adjusted.length}${bestSameMarketKey ? `; within this market the nearest rival is ${bestSameMarketKey} (${within >= 0 ? "+" : ""}${within.toFixed(2)})` : ""}.`,
    });
  }
  return out;
}
