// OPERATOR-DEFINED SPECIAL DIGIT ACTION — digit 1 in OVER, digit 8 in UNDER.
//
// This is operator knowledge, not a mathematical law: losses have repeatedly
// followed from failing to watch the ACTION of digit 1 while running an Over
// contract, and digit 8 while running an Under contract. Sentinel therefore
// monitors the ACTION of that one digit (frequency, recent frequency,
// direction, transitions, acceleration, pressure, persistence, abnormality)
// and converts it into a BOUNDED, INTERNAL ranking penalty.
//
// It is never a blocker, never a certainty claim, and is deliberately not
// surfaced as a repeated "CAUTION DIGIT 1/8" banner on the primary card.
import type { DigitIntel } from "../apex/digit-intel";

export type SpecialActionState = "NORMAL" | "ELEVATED" | "ABNORMAL" | "UNMEASURED";

export interface OperatorSpecialDigitRead {
  /** The digit watched for this side: 1 for OVER, 8 for UNDER. */
  digit: number;
  side: "OVER" | "UNDER";
  /** 0..100 — how energetic/abnormal the watched digit's ACTION currently is. */
  action: number;
  state: SpecialActionState;
  /** Bounded ranking contribution, 0 .. −6. Never positive, never a blocker. */
  rankingDelta: number;
  /** True when the watched digit loses this contract (the risky orientation). */
  onLosingSide: boolean;
  drivers: string[];
  summary: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function stateOf(action: number): SpecialActionState {
  if (action >= 68) return "ABNORMAL";
  if (action >= 42) return "ELEVATED";
  return "NORMAL";
}

/**
 * @param winners Winning digits of the contract, used only to decide whether
 * the watched digit sits on the losing side.
 */
export function operatorSpecialDigitAction(
  side: "OVER" | "UNDER",
  winners: number[],
  intel: DigitIntel | null,
): OperatorSpecialDigitRead {
  const digit = side === "OVER" ? 1 : 8;
  const onLosingSide = !winners.includes(digit);
  const p = intel?.profiles?.[digit] ?? null;

  if (!p) {
    return {
      digit,
      side,
      action: 0,
      state: "UNMEASURED",
      rankingDelta: 0,
      onLosingSide,
      drivers: [],
      summary: `Digit ${digit} action is not measurable yet on this market — no influence applied.`,
    };
  }

  const drivers: string[] = [];
  let action = 0;

  if (p.pressure > 0.015) {
    action += Math.min(26, p.pressure * 650);
    drivers.push(`pressure +${(p.pressure * 100).toFixed(1)}pp over its own baseline`);
  }
  if (p.pressureAcceleration > 0) {
    action += Math.min(16, p.pressureAcceleration * 800);
    drivers.push("pressure accelerating");
  }
  if (p.frequencyVelocity > 0.01) {
    action += Math.min(14, p.frequencyVelocity * 500);
    drivers.push(
      `recent frequency rising (${(p.fast * 100).toFixed(1)}% fast vs ${(p.medium * 100).toFixed(1)}% medium)`,
    );
  }
  if (p.clusterDensity >= 1.8) {
    action += 12;
    drivers.push(`clustering ×${p.clusterDensity.toFixed(1)} in the last 20 ticks`);
  }
  if (p.consecutive >= 2) {
    action += Math.min(12, p.consecutive * 5);
    drivers.push(`${p.consecutive} consecutive prints`);
  }
  if (p.transitionInflow >= 0.14) {
    action += Math.min(12, (p.transitionInflow - 0.1) * 160);
    drivers.push(
      `transition inflow ${(p.transitionInflow * 100).toFixed(0)}% from the current digit`,
    );
  }
  if (p.anomaly >= 55) {
    action += Math.min(14, (p.anomaly - 50) * 0.28);
    drivers.push(`abnormal frequency (anomaly ${Math.round(p.anomaly)}/100)`);
  }
  if (p.historicalPercentile >= 85) {
    action += 8;
    drivers.push(`sitting in its ${Math.round(p.historicalPercentile)}th percentile of activity`);
  }
  if (p.exhaustion >= 0.6) {
    action -= 10;
    drivers.push("showing exhaustion — action fading");
  }

  action = clamp(Math.round(action), 0, 100);
  const state = stateOf(action);

  // Only the risky orientation (watched digit LOSES the contract) is penalised,
  // and only above the NORMAL band. Bounded to −6 points.
  const raw = onLosingSide && action > 42 ? -((action - 42) / 58) * 6 : 0;
  const rankingDelta = Math.round(clamp(raw, -6, 0) * 10) / 10;

  const summary = onLosingSide
    ? `Operator watch — digit ${digit} action on this ${side} contract is ${state} (${action}/100)${
        drivers.length ? `: ${drivers.slice(0, 3).join(", ")}` : ""
      }. Applied as a bounded ${rankingDelta.toFixed(1)} ranking influence, never a block.`
    : `Digit ${digit} wins this ${side} contract, so its action (${action}/100, ${state}) carries no penalty here.`;

  return { digit, side, action, state, rankingDelta, onLosingSide, drivers, summary };
}
