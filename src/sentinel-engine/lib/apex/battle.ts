// APEX SENTINEL — CONTRACT BATTLE + "WHY THIS IS NOT A FAKE EDGE" CHECK.
import type { ContractEval } from "./types";

export interface BattleSide {
  contract: string;
  side: "OVER" | "UNDER";
  winners: number[];
  losers: number[];
  winningPressurePp: number;
  losingPressurePp: number;
  threatDigits: { digit: number; score: number; state: string }[];
  increasing: number[];
  decreasing: number[];
  barState: string;
  transitionSupport: number;
  historicalSupport: string;
  modelSupport: string;
  danger: number;
  opportunity: number;
}

export interface ContractBattle {
  symbol: string;
  over: BattleSide | null;
  under: BattleSide | null;
  winner: "OVER" | "UNDER" | "NEITHER";
  margin: number;
  reason: string;
}

function sideOf(
  c: ContractEval,
  increasing: number[],
  decreasing: number[],
  barState: string,
): BattleSide {
  return {
    contract: c.label,
    side: c.side,
    winners: c.winners,
    losers: c.threat?.losers ?? [],
    winningPressurePp: (c.threat?.winning.pressure ?? 0) * 100,
    losingPressurePp: (c.threat?.losing.pressure ?? 0) * 100,
    threatDigits: (c.threat?.threats ?? [])
      .slice(0, 3)
      .map((t) => ({ digit: t.digit, score: Math.round(t.score), state: t.state })),
    increasing,
    decreasing,
    barState,
    transitionSupport: c.transitionSupport,
    historicalSupport: c.analogue
      ? `${c.analogue.n} analogous outcomes at ${(c.analogue.rate * 100).toFixed(1)}%`
      : "no observed analogue",
    modelSupport:
      c.ensemble && c.ensemble.validated
        ? `${c.ensemble.validated} validated models, agreement ${c.ensemble.agreement.toFixed(0)}`
        : "MODEL NOT VALIDATED",
    danger: c.danger,
    opportunity: c.opportunity,
  };
}

export function buildBattle(
  symbol: string,
  contracts: ContractEval[],
  increasing: number[],
  decreasing: number[],
  barState: string,
): ContractBattle {
  const overs = contracts
    .filter((c) => c.side === "OVER")
    .sort((a, b) => b.opportunity - a.opportunity);
  const unders = contracts
    .filter((c) => c.side === "UNDER")
    .sort((a, b) => b.opportunity - a.opportunity);
  const over = overs[0] ? sideOf(overs[0], increasing, decreasing, barState) : null;
  const under = unders[0] ? sideOf(unders[0], increasing, decreasing, barState) : null;

  if (!over && !under) {
    return { symbol, over, under, winner: "NEITHER", margin: 0, reason: "No evaluable contract." };
  }
  const o = over?.opportunity ?? -1;
  const u = under?.opportunity ?? -1;
  const margin = Math.abs(o - u);
  const winner = margin < 3 ? "NEITHER" : o > u ? "OVER" : "UNDER";
  const reason =
    winner === "NEITHER"
      ? `Both sides score within ${margin.toFixed(1)} points — no genuine structural separation.`
      : winner === "OVER"
        ? `Over side leads by ${margin.toFixed(1)}: winning-side pressure ${over!.winningPressurePp.toFixed(2)}pp vs losing ${over!.losingPressurePp.toFixed(2)}pp, worst losing-digit threat ${over!.threatDigits[0]?.score ?? 0}.`
        : `Under side leads by ${margin.toFixed(1)}: winning-side pressure ${under!.winningPressurePp.toFixed(2)}pp vs losing ${under!.losingPressurePp.toFixed(2)}pp, worst losing-digit threat ${under!.threatDigits[0]?.score ?? 0}.`;

  return { symbol, over, under, winner, margin, reason };
}

export interface FakeEdgeAnswer {
  question: string;
  ok: boolean;
  answer: string;
}

export interface FakeEdgeCheck {
  answers: FakeEdgeAnswer[];
  failures: number;
  /** Score multiplier applied to the opportunity, 0.4..1. */
  multiplier: number;
  verdict: "PASSES" | "DOWNGRADED" | "REJECTED";
}

export function fakeEdgeCheck(c: ContractEval, minSample: number): FakeEdgeCheck {
  const threat = c.threat;
  const a: FakeEdgeAnswer[] = [];
  const q = (question: string, ok: boolean, answer: string) => a.push({ question, ok, answer });

  q(
    "Is the edge mainly a short-window hit rate?",
    Math.abs(c.recent - c.empirical) < 0.08,
    `Recent ${(c.recent * 100).toFixed(1)}% vs base ${(c.empirical * 100).toFixed(1)}% over ${c.n} ticks.`,
  );
  q(
    "Is sample size sufficient?",
    c.n >= minSample,
    `${c.n} ticks against a ${minSample}-tick minimum.`,
  );
  q(
    "Are losing digits becoming dangerous?",
    (threat?.groupThreat ?? 100) < 55,
    threat
      ? `Group threat ${threat.groupThreat.toFixed(0)} (${threat.state}), recurrence ${threat.recurrence}.`
      : "Threat engine unavailable.",
  );
  q(
    "Are critical digit structures contradicting?",
    (c.critical?.conflicts.length ?? 1) === 0,
    c.critical?.detail ?? "Critical digit engine unavailable.",
  );
  q(
    "Is pressure asymmetry genuine?",
    (threat?.asymmetry ?? 0) > 0.05,
    `Asymmetry ${(threat?.asymmetry ?? 0).toFixed(2)}.`,
  );
  q(
    "Is the edge stable across windows?",
    c.stability >= 55,
    `Stability ${c.stability.toFixed(0)}/100 across the rolling edge history.`,
  );
  q("Is the regime compatible?", c.regimeCompatible, c.regimeNote);
  q(
    "Are transitions supportive?",
    c.transitionSupport >= 0,
    `Transition support ${c.transitionSupport.toFixed(2)}.`,
  );
  q(
    "Do historical analogues agree?",
    Boolean(c.analogue && c.analogue.n >= 30 && c.analogue.rate > c.theoretical),
    c.analogue
      ? `${c.analogue.n} analogous outcomes at ${(c.analogue.rate * 100).toFixed(1)}% vs ${(c.theoretical * 100).toFixed(0)}% theoretical.`
      : "No observed analogue yet.",
  );
  q(
    "Do validated models agree?",
    Boolean(c.ensemble && c.ensemble.validated > 0 && c.ensemble.agreement >= 60),
    c.ensemble?.disagreement ?? "Ensemble unavailable.",
  );
  q(
    "Is the setup fresh?",
    c.freshness >= 50,
    `Freshness ${c.freshness.toFixed(0)}/100, age ${c.ageTicks} ticks.`,
  );
  q(
    "Is the evidence deteriorating?",
    c.forward
      ? c.forward.direction === "STRENGTHENING" || c.forward.direction === "HOLDING"
      : false,
    c.forward
      ? `Forward state ${c.forward.direction} (uncertainty ${c.forward.uncertainty.toFixed(0)}).`
      : "Projection unavailable.",
  );
  q("Is the market stable?", c.danger < 55, `Danger ${c.danger.toFixed(0)}/100.`);

  const failures = a.filter((x) => !x.ok).length;
  const multiplier = Math.max(0.4, 1 - failures * 0.06);
  const verdict: FakeEdgeCheck["verdict"] =
    failures >= 8 ? "REJECTED" : failures >= 4 ? "DOWNGRADED" : "PASSES";
  return { answers: a, failures, multiplier, verdict };
}
