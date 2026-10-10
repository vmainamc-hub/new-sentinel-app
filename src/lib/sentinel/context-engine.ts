// APEX SENTINEL — ENGINE #4: VARIABLE-ORDER MARKOV / CONTEXT ENGINE.
//
// Purpose:
// Improve selection of the ENTRY DIGIT by finding the LONGEST RELIABLE CONTEXT
// in historical digit transitions (Orders 1, 2, and 3) while penalising model
// complexity to avoid overfitting sparse n-grams.
//
// Hard Rules Honoured:
//   • Does NOT independently choose the final entry digit on its own authority;
//     contributes weighted contextual evidence to Entry-Point Engine & ranking.
//   • A statistically attractive Markov digit must NEVER be promoted if it is
//     currently a strongly strengthening losing-side digit.
//   • Complexity penalty: Order 3 requires significant evidence (≥18 occurrences)
//     to beat Order 2 (≥25), which requires evidence to beat Order 1 (≥35).
//   • Fallback chain: Order 3 -> Order 2 -> Order 1 -> Fallback / baseline.
//   • Detects digit competition across winning and losing roles.

export interface ContextMatch {
  order: 1 | 2 | 3;
  context: number[];
  contextKey: string;
  n: number;
  wins: number;
  pWin: number;
  pWinLower: number;
  edgePp: number;
  complexityPenalty: number;
  effectiveScore: number;
  reliable: boolean;
}

export interface CandidateContextEvaluation {
  digit: number;
  bestMatch: ContextMatch;
  orderSelected: 1 | 2 | 3;
  pWin: number;
  pWinLower: number;
  sampleSize: number;
  edgePp: number;
  isLosingSide: boolean;
  isLosingSideStrengthening: boolean;
  competitionState: DigitCompetitionState;
  rankingDelta: number;
  notes: string[];
}

export type DigitCompetitionState =
  | "STABLE"
  | "WINNING_SIDE_TAKING_OVER"
  | "LOSING_SIDE_RECOVERING"
  | "CLOSE_COMPETITION"
  | "HIGH_COMPETITION"
  | "TRANSITION_CONFIRMED"
  | "PSYCHOLOGY_CONFLICT";

export interface DigitCompetitionReport {
  state: DigitCompetitionState;
  score: number;
  leadingWinningDigit: number | null;
  leadingLosingDigit: number | null;
  marginPp: number;
  details: string[];
  summary: string;
}

export interface VariableOrderMarkovReport {
  symbol: string;
  contract: string;
  currentSequence: number[];
  evaluations: CandidateContextEvaluation[];
  preferredDigit: number | null;
  preferredOrder: 1 | 2 | 3 | null;
  preferredPWin: number;
  competition: DigitCompetitionReport;
  summary: string;
}

const MIN_N_ORDER_3 = 18;
const MIN_N_ORDER_2 = 25;
const MIN_N_ORDER_1 = 35;

// Complexity penalty (in pp of edge) subtracted per order level
const COMPLEXITY_PENALTY_PER_ORDER = 1.8;

function wilsonLower(wins: number, n: number): number {
  if (n <= 0) return 0;
  const z = 1.96;
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (c - m) / d);
}

/**
 * Extract transition counts for n-gram contexts.
 * Context is: [d_t-(k-1), ..., d_t] -> d_next
 */
function buildNgramMaps(digits: number[]) {
  const map1 = new Map<number, number[]>(); // d -> next 10 counts
  const map2 = new Map<string, number[]>(); // "d1,d2" -> next 10 counts
  const map3 = new Map<string, number[]>(); // "d1,d2,d3" -> next 10 counts

  for (let i = 0; i < digits.length - 1; i++) {
    const next = digits[i + 1];
    if (next < 0 || next > 9) continue;

    // Order 1: digit at i
    const d1 = digits[i];
    if (d1 >= 0 && d1 <= 9) {
      let r = map1.get(d1);
      if (!r) {
        r = new Array(10).fill(0);
        map1.set(d1, r);
      }
      r[next]++;
    }

    // Order 2: digits at i-1, i
    if (i >= 1) {
      const d0 = digits[i - 1];
      if (d0 >= 0 && d0 <= 9 && d1 >= 0 && d1 <= 9) {
        const k2 = `${d0},${d1}`;
        let r = map2.get(k2);
        if (!r) {
          r = new Array(10).fill(0);
          map2.set(k2, r);
        }
        r[next]++;
      }
    }

    // Order 3: digits at i-2, i-1, i
    if (i >= 2) {
      const dm1 = digits[i - 2];
      const d0 = digits[i - 1];
      if (dm1 >= 0 && dm1 <= 9 && d0 >= 0 && d0 <= 9 && d1 >= 0 && d1 <= 9) {
        const k3 = `${dm1},${d0},${d1}`;
        let r = map3.get(k3);
        if (!r) {
          r = new Array(10).fill(0);
          map3.set(k3, r);
        }
        r[next]++;
      }
    }
  }

  return { map1, map2, map3 };
}

/**
 * Measure digit competition between winning and losing sides.
 */
export function evaluateDigitCompetition(
  digits: number[],
  winners: number[],
  recentWindow: number = 150,
): DigitCompetitionReport {
  const recent = digits.slice(-recentWindow);
  const n = recent.length;
  if (n < 40) {
    return {
      state: "STABLE",
      score: 50,
      leadingWinningDigit: null,
      leadingLosingDigit: null,
      marginPp: 0,
      details: ["Insufficient recent history for competition analysis."],
      summary: "Digit competition state: STABLE (insufficient sample).",
    };
  }

  const losers = Array.from({ length: 10 }, (_, d) => d).filter((d) => !winners.includes(d));

  const counts = new Array(10).fill(0);
  for (const d of recent) if (d >= 0 && d <= 9) counts[d]++;

  const winCounts = winners.map((w) => ({ d: w, count: counts[w], share: (counts[w] / n) * 100 }));
  const loseCounts = losers.map((l) => ({ d: l, count: counts[l], share: (counts[l] / n) * 100 }));

  winCounts.sort((a, b) => b.share - a.share);
  loseCounts.sort((a, b) => b.share - a.share);

  const topWin = winCounts[0] ?? { d: -1, share: 0 };
  const topLose = loseCounts[0] ?? { d: -1, share: 0 };

  const marginPp = Math.round((topWin.share - topLose.share) * 10) / 10;
  const details: string[] = [];

  let state: DigitCompetitionState = "STABLE";
  let score = 50;

  if (topWin.share > topLose.share + 4.5) {
    state = "WINNING_SIDE_TAKING_OVER";
    score = 80;
    details.push(
      `Winning digit ${topWin.d} (${topWin.share.toFixed(1)}%) strongly dominates top losing digit ${topLose.d} (${topLose.share.toFixed(1)}%).`,
    );
  } else if (topLose.share > topWin.share + 4.5) {
    state = "LOSING_SIDE_RECOVERING";
    score = 25;
    details.push(
      `Losing digit ${topLose.d} (${topLose.share.toFixed(1)}%) exceeds top winning digit ${topWin.d} (${topWin.share.toFixed(1)}%).`,
    );
  } else if (Math.abs(topWin.share - topLose.share) <= 1.5) {
    state = "CLOSE_COMPETITION";
    score = 45;
    details.push(
      `Close parity between winning digit ${topWin.d} (${topWin.share.toFixed(1)}%) and losing digit ${topLose.d} (${topLose.share.toFixed(1)}%).`,
    );
  } else if (Math.abs(topWin.share - topLose.share) <= 3.0) {
    state = "HIGH_COMPETITION";
    score = 52;
    details.push(
      `Active competition between winning digit ${topWin.d} and losing digit ${topLose.d}.`,
    );
  } else {
    state = "STABLE";
    score = 65;
    details.push(`Structure holding with ${marginPp > 0 ? "+" : ""}${marginPp}pp winning margin.`);
  }

  const summary = `Competition: ${state} (Top Win: ${topWin.d} @ ${topWin.share.toFixed(1)}% vs Top Lose: ${topLose.d} @ ${topLose.share.toFixed(1)}%, Margin: ${marginPp}pp)`;

  return {
    state,
    score,
    leadingWinningDigit: topWin.d >= 0 ? topWin.d : null,
    leadingLosingDigit: topLose.d >= 0 ? topLose.d : null,
    marginPp,
    details,
    summary,
  };
}

/**
 * Evaluate variable-order Markov contexts for entry digit selection.
 */
export function evaluateVariableOrderMarkov(
  digits: number[],
  winners: number[],
  theoretical: number,
  options: {
    symbol?: string;
    contractLabel?: string;
    losingStrengtheningDigits?: number[];
  } = {},
): VariableOrderMarkovReport {
  const symbol = options.symbol ?? "MARKET";
  const contract = options.contractLabel ?? "CONTRACT";
  const losingStrengthening = new Set(options.losingStrengtheningDigits ?? []);
  const losers = Array.from({ length: 10 }, (_, d) => d).filter((d) => !winners.includes(d));

  const competition = evaluateDigitCompetition(digits, winners);

  if (digits.length < 50) {
    return {
      symbol,
      contract,
      currentSequence: digits.slice(-3),
      evaluations: [],
      preferredDigit: null,
      preferredOrder: null,
      preferredPWin: theoretical,
      competition,
      summary: "Variable-order Markov unavailable (insufficient ticks).",
    };
  }

  const { map1, map2, map3 } = buildNgramMaps(digits);
  const recentTrail = digits.slice(-3);
  const d_last = recentTrail.length >= 1 ? recentTrail[recentTrail.length - 1] : 0;
  const d_prev = recentTrail.length >= 2 ? recentTrail[recentTrail.length - 2] : 0;

  const evaluations: CandidateContextEvaluation[] = [];

  for (let cand = 0; cand < 10; cand++) {
    const isLoser = losers.includes(cand);
    const isLosingStren = losingStrengthening.has(cand);
    const notes: string[] = [];

    // Evaluate Order 3 candidate context: [d_prev, d_last, cand]
    const k3 = `${d_prev},${d_last},${cand}`;
    const counts3 = map3.get(k3);
    let match3: ContextMatch | null = null;
    if (counts3) {
      const n3 = counts3.reduce((a, b) => a + b, 0);
      if (n3 >= MIN_N_ORDER_3) {
        const w3 = winners.reduce((a, w) => a + (counts3[w] || 0), 0);
        const pWin = w3 / n3;
        const lower = wilsonLower(w3, n3);
        const edgePp = (pWin - theoretical) * 100;
        const penalty = COMPLEXITY_PENALTY_PER_ORDER * 2;
        match3 = {
          order: 3,
          context: [d_prev, d_last, cand],
          contextKey: `${d_prev} -> ${d_last} -> ${cand}`,
          n: n3,
          wins: w3,
          pWin,
          pWinLower: lower,
          edgePp,
          complexityPenalty: penalty,
          effectiveScore: edgePp - penalty,
          reliable: true,
        };
      }
    }

    // Evaluate Order 2 candidate context: [d_last, cand]
    const k2 = `${d_last},${cand}`;
    const counts2 = map2.get(k2);
    let match2: ContextMatch | null = null;
    if (counts2) {
      const n2 = counts2.reduce((a, b) => a + b, 0);
      if (n2 >= MIN_N_ORDER_2) {
        const w2 = winners.reduce((a, w) => a + (counts2[w] || 0), 0);
        const pWin = w2 / n2;
        const lower = wilsonLower(w2, n2);
        const edgePp = (pWin - theoretical) * 100;
        const penalty = COMPLEXITY_PENALTY_PER_ORDER;
        match2 = {
          order: 2,
          context: [d_last, cand],
          contextKey: `${d_last} -> ${cand}`,
          n: n2,
          wins: w2,
          pWin,
          pWinLower: lower,
          edgePp,
          complexityPenalty: penalty,
          effectiveScore: edgePp - penalty,
          reliable: true,
        };
      }
    }

    // Evaluate Order 1 candidate context: [cand]
    const counts1 = map1.get(cand);
    const n1 = counts1 ? counts1.reduce((a, b) => a + b, 0) : 0;
    const w1 = counts1 ? winners.reduce((a, w) => a + (counts1[w] || 0), 0) : 0;
    const pWin1 = n1 > 0 ? w1 / n1 : theoretical;
    const lower1 = wilsonLower(w1, n1);
    const edgePp1 = (pWin1 - theoretical) * 100;
    const match1: ContextMatch = {
      order: 1,
      context: [cand],
      contextKey: `${cand}`,
      n: n1,
      wins: w1,
      pWin: pWin1,
      pWinLower: lower1,
      edgePp: edgePp1,
      complexityPenalty: 0,
      effectiveScore: edgePp1,
      reliable: n1 >= MIN_N_ORDER_1,
    };

    // Select the LONGEST reliable context where complexity-adjusted effectiveScore beats shorter orders
    let bestMatch: ContextMatch = match1;
    if (match2 && match2.reliable && match2.effectiveScore > bestMatch.effectiveScore) {
      bestMatch = match2;
    }
    if (match3 && match3.reliable && match3.effectiveScore > bestMatch.effectiveScore) {
      bestMatch = match3;
    }

    notes.push(
      `Selected Order-${bestMatch.order} context "${bestMatch.contextKey}": P(win)=${(bestMatch.pWin * 100).toFixed(1)}% (N=${bestMatch.n}, edge ${bestMatch.edgePp > 0 ? "+" : ""}${bestMatch.edgePp.toFixed(1)}pp, penalty -${bestMatch.complexityPenalty.toFixed(1)}pp)`,
    );

    // Hard non-negotiable rule:
    // If cand is on the losing side AND is strengthening, penalise heavily
    let delta = Math.max(-4, Math.min(4, (bestMatch.effectiveScore / 10) * 2));
    if (isLoser) {
      delta -= 1.0;
      if (isLosingStren) {
        delta -= 4.0;
        notes.push(
          `HARD RULE: Digit ${cand} is strengthening on the losing side — Markov score heavily penalised.`,
        );
      }
    }

    evaluations.push({
      digit: cand,
      bestMatch,
      orderSelected: bestMatch.order,
      pWin: bestMatch.pWin,
      pWinLower: bestMatch.pWinLower,
      sampleSize: bestMatch.n,
      edgePp: bestMatch.edgePp,
      isLosingSide: isLoser,
      isLosingSideStrengthening: isLosingStren,
      competitionState: competition.state,
      rankingDelta: Math.round(delta * 10) / 10,
      notes,
    });
  }

  // Filter out strengthening losing-side digits from candidate preference
  const eligible = evaluations.filter((e) => !e.isLosingSideStrengthening);
  eligible.sort((a, b) => b.rankingDelta - a.rankingDelta || b.pWinLower - a.pWinLower);

  const top = eligible[0] ?? evaluations[0] ?? null;

  const summary = top
    ? `Top Context Entry: Digit ${top.digit} (Order-${top.orderSelected}: "${top.bestMatch.contextKey}", P(win)=${(top.pWin * 100).toFixed(1)}%, N=${top.sampleSize}) · ${competition.summary}`
    : "No viable context entry found.";

  return {
    symbol,
    contract,
    currentSequence: recentTrail,
    evaluations,
    preferredDigit: top ? top.digit : null,
    preferredOrder: top ? top.orderSelected : null,
    preferredPWin: top ? top.pWin : theoretical,
    competition,
    summary,
  };
}
