import type { Candidate, Digit, EngineInput, EngineResult } from "./types";
import { buildCandidate, candidateKey, sortCandidates } from "./qualification";
import { clamp, distribution, extractDigits, smoothedRate, WINDOWS } from "./stats";

type Side = "over" | "under";
type OverUnderDefinition = { side: Side; barrier: number; contractType: "DIGITOVER" | "DIGITUNDER"; theoreticalRate: number };

const CONTRACTS: OverUnderDefinition[] = [
  ...Array.from({ length: 9 }, (_, barrier) => ({
    side: "over" as const, barrier, contractType: "DIGITOVER" as const, theoreticalRate: (9 - barrier) / 10,
  })),
  ...Array.from({ length: 9 }, (_, index) => {
    const barrier = index + 1;
    return { side: "under" as const, barrier, contractType: "DIGITUNDER" as const, theoreticalRate: barrier / 10 };
  }),
];

const winCount = (counts: number[], side: Side, barrier: number): number =>
  counts.reduce((total, count, digit) => total + ((side === "over" ? digit > barrier : digit < barrier) ? count : 0), 0);

const winRate = (rates: number[], side: Side, barrier: number): number =>
  rates.reduce((total, rate, digit) => total + ((side === "over" ? digit > barrier : digit < barrier) ? rate : 0), 0);

/**
 * Over/Under digit engine. It ranks all legal Deriv barriers using multi-window
 * deviations and momentum. Candidate scores are rankings, never win probabilities.
 * Every candidate remains unqualified until live quote economics and genuine
 * prequential walk-forward validation are supplied.
 */
export function analyseOverUnder(input: EngineInput): EngineResult {
  const digits = extractDigits(input.ticks);
  const stats = distribution(digits);
  const { short, medium, long } = stats.windows;
  const n = digits.length;
  const minN = input.minSampleSize ?? WINDOWS.long;
  const currentDigit: Digit | null = n ? digits[n - 1] : null;

  const candidates: Candidate[] = CONTRACTS.map(definition => {
    const s = winRate(short.rates, definition.side, definition.barrier);
    const m = winRate(medium.rates, definition.side, definition.barrier);
    const l = winRate(long.rates, definition.side, definition.barrier);
    const blended = 0.55 * s + 0.30 * m + 0.15 * l;
    const adjusted = smoothedRate(blended * short.sampleSize, short.sampleSize, definition.theoreticalRate, 100);
    const momentum = s - m;
    const recovery = m - l;
    const score = clamp(50 + momentum * 260 + recovery * 100 + (blended - definition.theoreticalRate) * 90);
    const key = candidateKey(definition.contractType, String(definition.barrier));
    const sampleSize = Math.min(n, WINDOWS.long);
    const empiricalWins = winCount(long.counts, definition.side, definition.barrier);

    return buildCandidate({
      engine: "over-under",
      symbol: input.symbol,
      contractType: definition.contractType,
      barrier: String(definition.barrier),
      label: definition.side === "over" ? "Over " + definition.barrier : "Under " + definition.barrier,
      candidateScore: score,
      estimatedWinProbability: adjusted,
      empiricalWins,
      sampleSize,
      minSampleSize: minN,
      quote: input.quotes?.[key],
      validation: input.validation?.[key],
      strategyReasons: [
        "Win-rate estimates blend short, medium and long windows and shrink toward the contract's theoretical baseline.",
        "Short-versus-medium momentum: " + (momentum * 100).toFixed(1) + " percentage points.",
        "Medium-versus-long recovery: " + (recovery * 100).toFixed(1) + " percentage points.",
        "Observed rate: " + (blended * 100).toFixed(1) + "%; theoretical rate: " + (definition.theoreticalRate * 100).toFixed(1) + "%.",
        "A ranking score is not a calibrated probability; historical deviation alone does not establish an edge.",
      ],
    });
  });

  const ranked = sortCandidates(candidates);
  return {
    engine: "over-under",
    symbol: input.symbol,
    sampleSize: n,
    currentDigit,
    candidates: ranked,
    bestCandidate: ranked[0] ?? null,
    status: n >= minN ? "READY" : n ? "INSUFFICIENT_DATA" : "NO_CANDIDATE",
    note: "Over barriers are 0–8 and Under barriers are 1–9. Selection is a historical ranking, not permission to trade.",
  };
}
