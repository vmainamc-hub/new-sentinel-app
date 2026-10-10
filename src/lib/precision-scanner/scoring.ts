// Scoring dimensions for the Precision Multi-Market Scanner.
// Pure functions — Manipulation, Edge, Persistence and the composite Final Score.
import type { PressureField } from "@/lib/precision-edge-v2/pressure-engine";

export type ScannerWeights = {
  manipulation: number;
  edge: number;
  persistence: number;
  pressure: number;
};

export type ManipulationScore = { value: number; label: string; tone: string };
export type EdgeScore = {
  rawEdge: number;
  edgeScore: number;
  label: string;
  momentum: number;
  momentumTag: "Building" | "Fading" | "Stable";
};
export type PersistenceScore = {
  streakTicks: number;
  winDensity: number;
  persistenceScore: number;
  label: string;
};

export function computeManipulation(digitPct: number[]): ManipulationScore {
  const tvd = 0.5 * digitPct.reduce((a, p) => a + Math.abs(p - 0.1), 0);
  const value = Math.min(100, Math.round(tvd * 220));
  const label =
    value <= 15 ? "Clean" : value <= 25 ? "Acceptable" : value <= 39 ? "Elevated" : "Excessive";
  const tone = value <= 15 ? "var(--bull)" : value <= 25 ? "var(--warn)" : "var(--bear)";
  return { value, label, tone };
}

export function computeEdge(field: PressureField, fullWinners: number[]): EdgeScore {
  const theoretical = fullWinners.length / 10;
  const empirical = fullWinners.reduce((a, d) => a + field.digits[d].share, 0);
  const rawEdge = empirical - theoretical;
  const momentum = fullWinners.reduce((a, d) => a + field.digits[d].momentum, 0);
  const edgeScore = Math.max(0, Math.min(100, Math.round(50 + rawEdge * 800)));
  const label =
    rawEdge >= 0.04
      ? "Strong"
      : rawEdge >= 0.02
        ? "Solid"
        : rawEdge >= 0.008
          ? "Present"
          : rawEdge >= 0
            ? "Marginal"
            : "Negative";
  const momentumTag = momentum > 0.01 ? "Building" : momentum < -0.01 ? "Fading" : "Stable";
  return { rawEdge, edgeScore, label, momentum, momentumTag };
}

export function computePersistence(digits: number[], fullWinners: number[]): PersistenceScore {
  const winnerSet = new Set(fullWinners);
  let streak = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (winnerSet.has(digits[i])) streak++;
    else break;
  }
  const last20 = digits.slice(-20);
  const winDensity = last20.length
    ? last20.filter((d) => winnerSet.has(d)).length / last20.length
    : 0;
  const theoretical = fullWinners.length / 10;
  const densityEdge = winDensity - theoretical;

  const streakScore = Math.min(40, streak * 4);
  const densityScore = Math.max(-20, Math.min(40, densityEdge * 400));
  const stabilityScore = 20;
  const persistenceScore = Math.max(
    0,
    Math.min(100, Math.round(streakScore + densityScore + stabilityScore)),
  );
  const label =
    persistenceScore >= 75
      ? "Strong"
      : persistenceScore >= 55
        ? "Building"
        : persistenceScore >= 35
          ? "Early"
          : "Weak";
  return { streakTicks: streak, winDensity, persistenceScore, label };
}

export function computeFinalScore(
  manipulation: number,
  edgeScore: number,
  persistenceScore: number,
  pressureConviction: number,
  weights: ScannerWeights,
): number {
  const total = weights.manipulation + weights.edge + weights.persistence + weights.pressure || 1;
  const raw =
    (100 - manipulation) * weights.manipulation +
    edgeScore * weights.edge +
    persistenceScore * weights.persistence +
    pressureConviction * weights.pressure;
  return Math.max(0, Math.min(100, Math.round(raw / total)));
}

export function grade(finalScore: number): { letter: string; label: string; color: string } {
  if (finalScore >= 82) return { letter: "A", label: "Excellent", color: "var(--bull)" };
  if (finalScore >= 70) return { letter: "B", label: "Good", color: "var(--bull)" };
  if (finalScore >= 58) return { letter: "C", label: "Average", color: "var(--warn)" };
  return { letter: "D", label: "Weak", color: "var(--bear)" };
}
