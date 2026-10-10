// APEX SENTINEL — SPECIAL DIGIT RISK (0, 1, 8, 9).
//
// These four digits repeatedly behave differently at the edges of the digit
// range. Sentinel does NOT claim they are manipulated. It monitors them as a
// dedicated risk layer: pressure, acceleration, frequency, exhaustion,
// persistence, sensitive bar role, recent adverse outcomes and current
// contract exposure. When one of them sits on the LOSING side of a proposed
// contract and shows strong adverse behaviour, danger rises sharply.
import type { BarStructure } from "./bars";
import type { DigitIntel } from "./digit-intel";

export const SPECIAL_DIGITS = [0, 1, 8, 9] as const;

export type SpecialState = "CALM" | "WATCH" | "ELEVATED" | "HOSTILE";

export interface SpecialDigitState {
  digit: number;
  /** 0..100 — how energetic / risky this digit currently looks. */
  score: number;
  state: SpecialState;
  share: number; // fast-window share
  baseline: number;
  pressure: number;
  acceleration: number;
  exhaustion: number;
  persistence: number; // consecutive appearances
  sinceSeen: number;
  role: "GREEN" | "RED" | "SECOND" | "NONE";
  /** True when this digit loses the contract currently being evaluated. */
  onLosingSide: boolean;
  drivers: string[];
}

export interface SpecialDigitReport {
  digits: SpecialDigitState[];
  /** 0..100 market-level special-digit energy. */
  marketRisk: number;
  /** 0..100 risk restricted to the losing side of the evaluated contract. */
  exposureRisk: number;
  state: SpecialState;
  alerts: string[];
  summary: string;
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));

function stateOf(score: number): SpecialState {
  if (score >= 75) return "HOSTILE";
  if (score >= 55) return "ELEVATED";
  if (score >= 32) return "WATCH";
  return "CALM";
}

/**
 * @param losers Digits that lose the contract under evaluation. Pass [] for a
 * market-level (contract-agnostic) reading.
 */
export function specialDigitRisk(
  intel: DigitIntel | null,
  bars: BarStructure | null,
  losers: number[] = [],
  recentAdverse: Record<number, number> = {},
): SpecialDigitReport {
  const loserSet = new Set(losers);
  const cur = bars?.current ?? null;
  const prev = bars?.previous ?? null;
  const second = bars?.secondPrevious ?? null;

  const roleOf = (d: number): SpecialDigitState["role"] => {
    if (cur && cur.digit === d)
      return cur.color === "GREEN" ? "GREEN" : cur.color === "RED" ? "RED" : "NONE";
    if (prev && prev.digit === d) return "SECOND";
    if (second && second.digit === d) return "SECOND";
    return "NONE";
  };

  const digits: SpecialDigitState[] = SPECIAL_DIGITS.map((d) => {
    const p = intel?.profiles?.[d];
    const drivers: string[] = [];
    let score = 0;

    const share = p?.fast ?? 0.1;
    const baseline = p?.baseline ?? 0.1;
    const pressure = p?.pressure ?? 0;
    const acceleration = p?.pressureAcceleration ?? 0;
    const exhaustion = p?.exhaustion ?? 0;
    const persistence = p?.consecutive ?? 0;
    const sinceSeen = p?.sinceSeen ?? 0;

    if (pressure > 0.02) {
      score += Math.min(28, pressure * 700);
      drivers.push(`pressure +${(pressure * 100).toFixed(1)}pp over baseline`);
    }
    if (acceleration > 0) {
      score += Math.min(18, acceleration * 900);
      drivers.push("pressure accelerating");
    }
    if (share > 0.13) {
      score += Math.min(18, (share - 0.1) * 400);
      drivers.push(`fast share ${(share * 100).toFixed(1)}%`);
    }
    if (persistence >= 2) {
      score += Math.min(14, persistence * 6);
      drivers.push(`${persistence} consecutive prints`);
    }
    if ((p?.clusterDensity ?? 1) >= 1.8) {
      score += 12;
      drivers.push(`clustering ×${(p?.clusterDensity ?? 1).toFixed(1)} in the last 20 ticks`);
    }
    if (exhaustion >= 0.6) {
      score -= 10;
      drivers.push("showing exhaustion");
    }
    const role = roleOf(d);
    if (role !== "NONE") {
      score += role === "SECOND" ? 6 : 10;
      drivers.push(`holds the ${role.toLowerCase()} bar role`);
    }
    const adverse = recentAdverse[d] ?? 0;
    if (adverse > 0) {
      score += Math.min(15, adverse * 5);
      drivers.push(`${adverse} recent adverse resolution(s) attributed to this digit`);
    }

    const onLosingSide = loserSet.has(d);
    if (onLosingSide && score > 40) {
      score += 12;
      drivers.push("sits on the losing side of the evaluated contract");
    }

    score = clamp(score);
    return {
      digit: d,
      score: Math.round(score),
      state: stateOf(score),
      share,
      baseline,
      pressure,
      acceleration,
      exhaustion,
      persistence,
      sinceSeen,
      role,
      onLosingSide,
      drivers,
    };
  });

  const marketRisk = Math.round(
    clamp(
      Math.max(...digits.map((d) => d.score)) * 0.7 +
        (digits.filter((d) => d.score >= 55).length / 4) * 100 * 0.3,
    ),
  );
  const exposed = digits.filter((d) => d.onLosingSide);
  const exposureRisk = exposed.length
    ? Math.round(
        clamp(
          Math.max(...exposed.map((d) => d.score)) * 0.8 +
            (exposed.filter((d) => d.score >= 55).length / exposed.length) * 100 * 0.2,
        ),
      )
    : 0;

  const alerts = digits
    .filter((d) => d.score >= 55)
    .map(
      (d) =>
        `SPECIAL DIGIT RISK — digit ${d.digit} is ${d.state}${d.onLosingSide ? " on the LOSING side" : ""} (${d.drivers.slice(0, 3).join(", ")}).`,
    );

  const worst = [...digits].sort((a, b) => b.score - a.score)[0];
  return {
    digits,
    marketRisk,
    exposureRisk,
    state: stateOf(Math.max(marketRisk, exposureRisk)),
    alerts,
    summary: worst
      ? `Special digits 0/1/8/9 — worst is ${worst.digit} at ${worst.score}/100 (${worst.state}). Losing-side special exposure ${exposureRisk}/100.`
      : "Special digit monitor has no data yet.",
  };
}
