// APEX SENTINEL — FLUCTUATION ENGINE.
//
// A market can look attractive on a snapshot and still be unusable because its
// evidence will not hold still. This engine measures instability directly:
// how often the leading contract flips, how often the composite edge changes
// sign, how much confidence oscillates, how often the psychology alignment
// appears and disappears, and how fast competing digit pressure reverses.
//
// FLUCTUATION_SCORE, FLUCTUATION_STATE and SIGNAL_FLICKER_RATE are quality /
// danger inputs — high fluctuation lowers quality and raises danger.
export type FluctuationState = "CALM" | "SETTLED" | "UNSTABLE" | "CHAOTIC";

export interface FluctuationReport {
  n: number;
  /** 0..100 — higher means the evidence is changing under its own feet. */
  score: number;
  state: FluctuationState;
  /** Leading-contract changes per observation, 0..1. */
  signalFlickerRate: number;
  /** Composite-edge sign changes per observation, 0..1. */
  edgeSignFlipRate: number;
  /** Standard deviation of confidence across the observed window. */
  confidenceOscillation: number;
  /** Psychology alignment appear/disappear rate, 0..1. */
  psychologyFlipRate: number;
  /** Rank churn of the leading contract, 0..1. */
  rankChurn: number;
  drivers: string[];
  summary: string;
}

interface Sample {
  at: number;
  leader: string;
  edge: number;
  confidence: number;
  psychologyAligned: boolean;
  rank: number;
}

const CAP = 90; // observations retained per market (~1 minute at 700 ms)

const clamp = (x: number) => Math.max(0, Math.min(100, x));

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function stateOf(score: number): FluctuationState {
  if (score >= 70) return "CHAOTIC";
  if (score >= 45) return "UNSTABLE";
  if (score >= 22) return "SETTLED";
  return "CALM";
}

class FluctuationTracker {
  private series = new Map<string, Sample[]>();

  /** Record one observation of a market's current evidence state. */
  observe(symbol: string, s: Omit<Sample, "at">) {
    const list = this.series.get(symbol) ?? [];
    const last = list[list.length - 1];
    // Ignore duplicate frames — only real state changes should count as churn.
    if (
      last &&
      last.leader === s.leader &&
      last.edge === s.edge &&
      last.confidence === s.confidence &&
      last.psychologyAligned === s.psychologyAligned
    ) {
      return;
    }
    list.push({ ...s, at: Date.now() });
    if (list.length > CAP) list.splice(0, list.length - CAP);
    this.series.set(symbol, list);
  }

  report(symbol: string): FluctuationReport {
    const list = this.series.get(symbol) ?? [];
    const n = list.length;
    if (n < 6) {
      return {
        n,
        score: 0,
        state: "CALM",
        signalFlickerRate: 0,
        edgeSignFlipRate: 0,
        confidenceOscillation: 0,
        psychologyFlipRate: 0,
        rankChurn: 0,
        drivers: [],
        summary: `Fluctuation not yet measurable (${n} observations).`,
      };
    }

    let leaderFlips = 0;
    let signFlips = 0;
    let psychFlips = 0;
    let rankFlips = 0;
    for (let i = 1; i < n; i++) {
      if (list[i].leader !== list[i - 1].leader) leaderFlips++;
      if (Math.sign(list[i].edge) !== Math.sign(list[i - 1].edge)) signFlips++;
      if (list[i].psychologyAligned !== list[i - 1].psychologyAligned) psychFlips++;
      if (list[i].rank !== list[i - 1].rank) rankFlips++;
    }
    const pairs = n - 1;
    const signalFlickerRate = leaderFlips / pairs;
    const edgeSignFlipRate = signFlips / pairs;
    const psychologyFlipRate = psychFlips / pairs;
    const rankChurn = rankFlips / pairs;
    const confidenceOscillation = stdev(list.map((s) => s.confidence));

    const drivers: string[] = [];
    let score = 0;
    if (signalFlickerRate > 0.05) {
      score += Math.min(34, signalFlickerRate * 130);
      drivers.push(
        `leading contract changed on ${(signalFlickerRate * 100).toFixed(0)}% of updates`,
      );
    }
    if (edgeSignFlipRate > 0.05) {
      score += Math.min(24, edgeSignFlipRate * 110);
      drivers.push(
        `composite edge flipped sign on ${(edgeSignFlipRate * 100).toFixed(0)}% of updates`,
      );
    }
    if (confidenceOscillation > 4) {
      score += Math.min(20, (confidenceOscillation - 4) * 2.4);
      drivers.push(`confidence oscillating ±${confidenceOscillation.toFixed(1)}`);
    }
    if (psychologyFlipRate > 0.05) {
      score += Math.min(16, psychologyFlipRate * 90);
      drivers.push(
        `psychology alignment appeared/disappeared on ${(psychologyFlipRate * 100).toFixed(0)}% of updates`,
      );
    }
    if (rankChurn > 0.15) {
      score += Math.min(12, rankChurn * 40);
      drivers.push(`internal ranking churned on ${(rankChurn * 100).toFixed(0)}% of updates`);
    }

    score = Math.round(clamp(score));
    const state = stateOf(score);
    return {
      n,
      score,
      state,
      signalFlickerRate,
      edgeSignFlipRate,
      confidenceOscillation,
      psychologyFlipRate,
      rankChurn,
      drivers,
      summary:
        state === "CALM" || state === "SETTLED"
          ? `Evidence is holding still (${state.toLowerCase()}, fluctuation ${score}/100 over ${n} observations).`
          : `Evidence is ${state.toLowerCase()} — ${drivers.slice(0, 2).join("; ") || "rapid state changes"} (fluctuation ${score}/100).`,
    };
  }

  reset(symbol?: string) {
    if (symbol) this.series.delete(symbol);
    else this.series.clear();
  }
}

export const fluctuationTracker = new FluctuationTracker();
