// Precision Parity — Market Intelligence Analyst panel.
//
// Precision Parity is not a signal generator. It is a panel of independent
// quantitative analysts:
//   1. Bull Analyst  — argues why the winning contract should win.
//   2. Bear Analyst  — argues why the winning contract will fail.
//   3. Cross-Exam    — the two analysts debate until neither has new evidence.
//   4. Chief Analyst — reads the debate and issues a verdict + prose reasoning.
//   5. DBot Survival — estimates whether the edge will survive 1..5 entries.
//   6. Contrarian    — one last challenger. If it lands, the signal is blocked.
//   7. Confidence Decomposition — one score is replaced by a full breakdown.
//
// The panel operates entirely on already-computed features (hypotheses,
// transitions, regime, virtual-trades, stability). It is a pure function of
// evidence — no I/O, no randomness beyond the caller's Monte Carlo.

import type {
  AnalystArgument,
  BearReview,
  BullReview,
  ChiefVerdict,
  ConfidenceBreakdown,
  ContrarianReview,
  DBotSurvivalProfile,
  DebateExchange,
  Evidence,
  HiddenRegime,
  HypothesisEvaluation,
  IntelligencePanel,
  MarketRegime,
  TransitionMatrix,
} from "./types";

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface PanelInputs {
  winner: HypothesisEvaluation;
  loser: HypothesisEvaluation;
  margin: number;
  persistence: number;
  regime: MarketRegime;
  hidden: HiddenRegime;
  manipulation: number;
  fluctuation: number;
  crowding: number;
  transition: TransitionMatrix;      // first-order @ 100t
  virtual: {
    winRate: number;                 // 0..1
    expectedValue: number;
    stable: boolean;
    worstStreak: number;
  };
  stability: {
    score: number;                   // 0..100
    expectedEntries: number;
  };
}

// ── Bull Analyst ────────────────────────────────────────────────────────────
// Its ONLY job is to argue for the winning contract. It cannot consider the
// opposite side; that is the Bear's job.
function runBull(input: PanelInputs): BullReview {
  const { winner, virtual, stability, persistence, transition } = input;
  const side = winner.contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const args: AnalystArgument[] = [];
  // Convert supporting evidence into structured claims.
  for (const e of winner.supports.slice(0, 6)) {
    args.push({
      claim: `${e.engine} favours ${side}`,
      evidence: e.detail,
      weight: clamp01(e.strength / 2.5),
    });
  }
  // Add derived arguments beyond raw evidence.
  const pForWinner =
    winner.contract === "BUY_EVEN"
      ? (transition.pEE + transition.pOE) / 2
      : (transition.pEO + transition.pOO) / 2;
  if (pForWinner > 0.52) {
    args.push({
      claim: `Markov transition matrix leans ${side}`,
      evidence: `P(next=${side}) ≈ ${(pForWinner * 100).toFixed(1)}% over the live 100-tick window`,
      weight: clamp01((pForWinner - 0.5) * 4),
    });
  }
  if (virtual.winRate >= 0.55) {
    args.push({
      claim: `Forward simulations survive`,
      evidence: `Monte Carlo forward-play returns ${(virtual.winRate * 100).toFixed(0)}% win-rate, EV ${virtual.expectedValue.toFixed(2)}`,
      weight: clamp01((virtual.winRate - 0.5) * 3),
    });
  }
  if (persistence >= 4) {
    args.push({
      claim: `The setup has already lived`,
      evidence: `Winning hypothesis has persisted ${persistence} consecutive evaluations`,
      weight: clamp01(persistence / 12),
    });
  }
  if (stability.score >= 60) {
    args.push({
      claim: `Edge stability is above the durability floor`,
      evidence: `Composite stability score ${stability.score.toFixed(0)}/100 → expected to survive ~${stability.expectedEntries} entries`,
      weight: clamp01(stability.score / 100),
    });
  }
  const strength = clamp(
    100 * (args.reduce((a, x) => a + x.weight, 0) / Math.max(1, args.length)),
  );
  const summary =
    args.length === 0
      ? `Bull sees no meaningful evidence for ${side}.`
      : `Bull argues ${side} is the correct contract: ${args
          .slice(0, 3)
          .map((a) => a.claim.toLowerCase())
          .join("; ")}.`;
  return { contract: winner.contract, arguments: args, strength, summary };
}

// ── Bear Analyst ────────────────────────────────────────────────────────────
// Its ONLY job is to destroy the Bull's case. It cannot defend the Bull's
// contract; it can only attack it.
function runBear(input: PanelInputs): BearReview {
  const { winner, loser, margin, regime, hidden, manipulation, fluctuation, crowding, virtual, transition } = input;
  const side = winner.contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const opp = winner.contract === "BUY_EVEN" ? "ODD" : "EVEN";
  const attacks: AnalystArgument[] = [];

  // Every explicit conflict from the winning hypothesis is a Bear attack.
  for (const e of winner.conflicts.slice(0, 6)) {
    attacks.push({
      claim: `${e.engine} is fighting ${side}`,
      evidence: e.detail,
      weight: clamp01(e.strength / 2.0),
    });
  }
  // Environmental attacks.
  if (regime === "CHAOTIC" || regime === "MANIPULATED") {
    attacks.push({
      claim: `Regime is hostile`,
      evidence: `Market regime is ${regime} — directional edges rarely survive here`,
      weight: 0.9,
    });
  }
  if (hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING") {
    attacks.push({
      claim: `Hidden state suggests reversal`,
      evidence: `Hidden regime = ${hidden}, so ${side} is fighting a building counter-current`,
      weight: 0.75,
    });
  }
  if (manipulation > 35) {
    attacks.push({
      claim: `Distribution is distorted`,
      evidence: `Manipulation index at ${manipulation.toFixed(0)}% — probabilities are not clean`,
      weight: clamp01(manipulation / 100),
    });
  }
  if (fluctuation > 55) {
    attacks.push({
      claim: `Noise floor is high`,
      evidence: `Fluctuation ${fluctuation.toFixed(0)}% — signal / noise ratio is poor`,
      weight: clamp01(fluctuation / 100),
    });
  }
  if (crowding > 65) {
    attacks.push({
      claim: `Setup is crowded`,
      evidence: `Crowding ${crowding.toFixed(0)}% — the obvious side is already fully priced`,
      weight: clamp01(crowding / 100),
    });
  }
  if (margin < 8) {
    attacks.push({
      claim: `Loser is close behind`,
      evidence: `Only ${margin.toFixed(1)}-pt margin over ${opp} (${winner.confidence.toFixed(0)} vs ${loser.confidence.toFixed(0)}) — thin edge`,
      weight: clamp01((10 - margin) / 10),
    });
  }
  if (!virtual.stable) {
    attacks.push({
      claim: `Forward-play is unstable`,
      evidence: `Monte Carlo win-rate wobbles across sub-batches — the edge is not reproducible`,
      weight: 0.7,
    });
  }
  if (virtual.worstStreak >= 5) {
    attacks.push({
      claim: `Losing streaks are realistic`,
      evidence: `Worst simulated losing streak = ${virtual.worstStreak} — a DBot sequence could blow up before recovery`,
      weight: clamp01(virtual.worstStreak / 10),
    });
  }
  const pForOpp = 1 - (
    winner.contract === "BUY_EVEN"
      ? (transition.pEE + transition.pOE) / 2
      : (transition.pEO + transition.pOO) / 2
  );
  if (pForOpp > 0.48) {
    attacks.push({
      claim: `Markov leaves the opposition alive`,
      evidence: `P(next=${opp}) still ≈ ${(pForOpp * 100).toFixed(1)}% — the "other side" is not defeated`,
      weight: clamp01((pForOpp - 0.4) * 3),
    });
  }

  const destructiveness = clamp(
    100 * (attacks.reduce((a, x) => a + x.weight, 0) / Math.max(1, attacks.length)),
  );
  const summary =
    attacks.length === 0
      ? `Bear cannot find a credible attack.`
      : `Bear challenges ${side}: ${attacks
          .slice(0, 3)
          .map((a) => a.claim.toLowerCase())
          .join("; ")}.`;
  return { attacks, destructiveness, summary };
}

// ── Cross-Examination ───────────────────────────────────────────────────────
// Interleave the top Bull and Bear points into a short debate transcript.
function runCrossExamination(bull: BullReview, bear: BearReview): DebateExchange[] {
  const rounds = Math.min(4, Math.max(bull.arguments.length, bear.attacks.length));
  const out: DebateExchange[] = [];
  for (let i = 0; i < rounds; i++) {
    const b = bull.arguments[i];
    const r = bear.attacks[i];
    if (b) out.push({ side: "BULL", line: `${b.claim} — ${b.evidence}` });
    if (r) out.push({ side: "BEAR", line: `${r.claim} — ${r.evidence}` });
  }
  return out;
}

// ── Chief Analyst ───────────────────────────────────────────────────────────
// Only after both sides finish does the Chief speak. Decides whether the
// Bull's case survived cross-examination.
function runChief(input: PanelInputs, bull: BullReview, bear: BearReview): ChiefVerdict {
  const { winner, loser, margin, virtual, stability } = input;
  const side = winner.contract === "BUY_EVEN" ? "EVEN" : "ODD";
  const opp = winner.contract === "BUY_EVEN" ? "ODD" : "EVEN";

  const bullWon = bull.strength >= bear.destructiveness + 5;
  const catastrophic =
    bear.destructiveness >= 70 ||
    (bear.destructiveness > bull.strength && bear.attacks.length >= 3);

  let decision: ChiefVerdict["decision"] = "DEFER";
  if (bullWon && virtual.winRate >= 0.55 && stability.score >= 55 && margin >= 4) {
    decision = "APPROVE";
  } else if (catastrophic || virtual.winRate < 0.5 || stability.score < 40) {
    decision = "REJECT";
  } else {
    decision = "DEFER";
  }

  const strongestSupport =
    bull.arguments.slice().sort((a, b) => b.weight - a.weight)[0]?.evidence ??
    `No single dominant argument — Bull relies on ensemble weight ${bull.strength.toFixed(0)}.`;
  const strongestOpposition =
    bear.attacks.slice().sort((a, b) => b.weight - a.weight)[0]?.evidence ??
    `Bear found no credible individual objection.`;
  const whyOppositionRejected =
    decision === "APPROVE"
      ? bear.attacks.length === 0
        ? `The Bear could not muster a credible attack; the Bull's case is unchallenged.`
        : `The Bear's strongest point (${bear.attacks[0].claim.toLowerCase()}) is outweighed by ${bull.arguments.length} converging supports, a ${(virtual.winRate * 100).toFixed(0)}% forward win-rate and stability ${stability.score.toFixed(0)}/100.`
      : decision === "REJECT"
      ? `The Bear's case was NOT rejected — the Chief agrees the ${side} hypothesis fails cross-examination.`
      : `The Bear's case is credible but not conclusive; more evidence is required before ${side} can be approved.`;
  const uncertainty =
    winner.confidence < 75
      ? `Winning confidence is only ${winner.confidence.toFixed(0)}/100, with ${loser.confidence.toFixed(0)} residual for ${opp}.`
      : `Residual uncertainty is limited — winning confidence ${winner.confidence.toFixed(0)}, loser ${loser.confidence.toFixed(0)}.`;

  const reasoning =
    decision === "APPROVE"
      ? `After weighing every piece of supporting and opposing evidence, the Bull's case for BUY ${side} survives cross-examination. The winning hypothesis carries ${bull.arguments.length} independent supports totalling ${bull.strength.toFixed(0)}/100, against a Bear attack of only ${bear.destructiveness.toFixed(0)}/100. Forward simulations return ${(virtual.winRate * 100).toFixed(0)}% and edge stability is ${stability.score.toFixed(0)}/100 — durable enough for the intended DBot sequence.`
      : decision === "REJECT"
      ? `The Chief rejects the ${side} hypothesis. Bear pressure of ${bear.destructiveness.toFixed(0)}/100 exceeds Bull support of ${bull.strength.toFixed(0)}/100${virtual.winRate < 0.5 ? `, and forward simulations only clear ${(virtual.winRate * 100).toFixed(0)}%` : ""}. Decision quality demands stepping aside — no trade.`
      : `The Chief defers. Bull (${bull.strength.toFixed(0)}) and Bear (${bear.destructiveness.toFixed(0)}) are within reach of each other and stability is ${stability.score.toFixed(0)}/100. The panel would rather wait for stronger evidence than risk a five-entry DBot sequence on a contested edge.`;

  const gradeScore =
    0.35 * bull.strength -
    0.25 * bear.destructiveness +
    0.20 * stability.score +
    0.20 * (virtual.winRate * 100);
  const grade: ChiefVerdict["grade"] =
    gradeScore >= 55 ? "A" : gradeScore >= 40 ? "B" : gradeScore >= 25 ? "C" : "D";

  return {
    decision,
    contract: decision === "APPROVE" ? winner.contract : "NO_TRADE",
    bullWon,
    strongestSupport,
    strongestOpposition,
    whyOppositionRejected,
    uncertainty,
    reasoning,
    grade,
  };
}

// ── DBot Survival Analysis ──────────────────────────────────────────────────
// The user does NOT trade one contract at a time — signals are loaded into a
// DBot that runs 3–5 consecutive contracts on the same edge. Persistence
// matters more than instantaneous probability.
function runDBotSurvival(input: PanelInputs): DBotSurvivalProfile {
  const { virtual, persistence, regime, hidden } = input;
  // Base per-entry survival probability = win-rate, softened by stability.
  const p = clamp01(virtual.winRate);
  // Environmental multiplier — hostile regimes accelerate decay.
  const envDecay =
    regime === "CHAOTIC" || regime === "MANIPULATED"
      ? 0.85
      : hidden === "ALTERNATING" || hidden === "REVERSAL_BUILDING"
      ? 0.9
      : regime === "STABLE" || regime === "TRENDING"
      ? 0.98
      : 0.94;
  const persistBoost = 1 + Math.min(0.1, persistence / 100);
  // survival[k] = probability the edge is still "in force" after k entries.
  const survival: number[] = [];
  let s = 1;
  for (let k = 1; k <= 5; k++) {
    s *= p * envDecay * persistBoost;
    survival.push(clamp01(s));
  }
  const flipProbability5 = 1 - survival[survival.length - 1];
  // Expected run lengths under Bernoulli(p).
  const expectedWinRun = p > 0.999 ? 5 : Math.min(5, 1 / Math.max(0.001, 1 - p));
  const expectedLossRun = p < 0.001 ? 5 : Math.min(5, 1 / Math.max(0.001, p));
  const composite = 100 * ((survival[2] + survival[4]) / 2);
  const durability: DBotSurvivalProfile["durability"] =
    composite >= 75 ? "VERY_HIGH" : composite >= 60 ? "HIGH" : composite >= 45 ? "MODERATE" : "LOW";
  const recommendedRuns =
    composite >= 75 ? 5 : composite >= 60 ? 4 : composite >= 45 ? 3 : composite >= 30 ? 2 : 1;
  const cooldownSeconds =
    durability === "VERY_HIGH" ? 15 : durability === "HIGH" ? 20 : durability === "MODERATE" ? 30 : 60;
  return {
    survival,
    expectedWinRun,
    expectedLossRun,
    flipProbability5,
    durability,
    recommendedRuns,
    cooldownSeconds,
  };
}

// ── Contrarian Analyst ──────────────────────────────────────────────────────
// One last challenge before the recommendation reaches the user. If the
// Contrarian's case is convincing, we block the signal.
function runContrarian(input: PanelInputs, chief: ChiefVerdict): ContrarianReview {
  const { winner, persistence, crowding, virtual, stability } = input;
  const concerns: AnalystArgument[] = [];
  const late = persistence >= 12 || winner.maturity === "PEAK";
  const crowded = crowding >= 70;
  if (late) {
    concerns.push({
      claim: `The move is mature`,
      evidence: `Persistence ${persistence}t${winner.maturity === "PEAK" ? ` and maturity is PEAK` : ""} — most of the edge may already be spent`,
      weight: clamp01(persistence / 15),
    });
  }
  if (crowded) {
    concerns.push({
      claim: `Everyone can see this`,
      evidence: `Crowding ${crowding.toFixed(0)}% — this pattern is obvious and probably already priced in`,
      weight: clamp01(crowding / 100),
    });
  }
  if (virtual.expectedValue < 0.05) {
    concerns.push({
      claim: `Expected value is thin`,
      evidence: `Per-trade EV only ${virtual.expectedValue.toFixed(2)} — one bad streak wipes the profit`,
      weight: 0.7,
    });
  }
  if (stability.score < 60 && chief.decision === "APPROVE") {
    concerns.push({
      claim: `Chief approved a fragile edge`,
      evidence: `Stability ${stability.score.toFixed(0)}/100 is below the durability floor for a 5-entry DBot`,
      weight: 0.6,
    });
  }
  const trapRisk = clamp(100 * concerns.reduce((a, c) => a + c.weight, 0) / 3);
  const block = trapRisk >= 55 || (chief.decision === "APPROVE" && crowded && late);
  return {
    verdict: block ? "BLOCK" : "PASS",
    concerns,
    crowded,
    late,
    trapRisk,
    summary: block
      ? `Contrarian BLOCKS: ${concerns.slice(0, 2).map((c) => c.claim.toLowerCase()).join("; ")}.`
      : concerns.length === 0
      ? `Contrarian finds no reason to block.`
      : `Contrarian is uneasy (${concerns.map((c) => c.claim.toLowerCase()).join("; ")}) but the case still stands.`,
  };
}

// ── Confidence Decomposition ────────────────────────────────────────────────
function runBreakdown(
  input: PanelInputs,
  bull: BullReview,
  bear: BearReview,
  dbot: DBotSurvivalProfile,
): ConfidenceBreakdown {
  const { winner, stability, virtual, regime } = input;
  const reversalRisk =
    (regime === "CHAOTIC" || regime === "MANIPULATED" ? 30 : 0) +
    (bear.destructiveness * 0.5) +
    (100 - stability.score) * 0.3;
  const reasoningQuality =
    Math.min(100, bull.arguments.length * 12 + (bull.strength - bear.destructiveness));
  return {
    prediction: winner.confidence,
    persistence: clamp(dbot.survival[4] * 100),
    stability: stability.score,
    reversalRisk: clamp(reversalRisk),
    contradiction: winner.contradictionScore,
    dbotSurvival: clamp(100 * (dbot.survival[2] + dbot.survival[4]) / 2),
    expectedValue: virtual.expectedValue,
    hypothesisStrength: bull.strength,
    reasoningQuality: clamp(reasoningQuality),
    expectedWinRun: dbot.expectedWinRun,
    expectedLossRun: dbot.expectedLossRun,
  };
}

function computeGrade(
  chief: ChiefVerdict,
  contrarian: ContrarianReview,
  breakdown: ConfidenceBreakdown,
): "A" | "B" | "C" | "D" {
  if (contrarian.verdict === "BLOCK") return "D";
  if (chief.decision === "REJECT") return "D";
  if (chief.decision === "DEFER") return "C";
  // APPROVE
  const composite =
    0.3 * breakdown.hypothesisStrength +
    0.25 * breakdown.stability +
    0.25 * breakdown.dbotSurvival +
    0.2 * breakdown.reasoningQuality -
    0.2 * breakdown.reversalRisk;
  return composite >= 55 ? "A" : composite >= 40 ? "B" : "C";
}

// ── Panel entry point ───────────────────────────────────────────────────────
export function runIntelligencePanel(input: PanelInputs): IntelligencePanel {
  const bull = runBull(input);
  const bear = runBear(input);
  const crossExamination = runCrossExamination(bull, bear);
  const chief = runChief(input, bull, bear);
  const dbotSurvival = runDBotSurvival(input);
  const contrarian = runContrarian(input, chief);
  const breakdown = runBreakdown(input, bull, bear, dbotSurvival);
  const intelligenceGrade = computeGrade(chief, contrarian, breakdown);
  return {
    bull,
    bear,
    crossExamination,
    chief,
    dbotSurvival,
    contrarian,
    breakdown,
    intelligenceGrade,
  };
}

// Helper for engine: does the panel authorise a trade?
export function panelApproves(panel: IntelligencePanel): boolean {
  return panel.chief.decision === "APPROVE" && panel.contrarian.verdict === "PASS";
}

// (Evidence is not used at runtime here, but re-exported so future tools can
// consume analyst arguments in the same shape.)
export type { Evidence };