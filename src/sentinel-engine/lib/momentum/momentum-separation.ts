// APEX SENTINEL — TWO-SIDED MOMENTUM SEPARATION.
//
// STANDALONE: this folder is added BESIDE the vendored Sentinel engine. It is not wired into surface-vetting.ts, scan.ts or
// any ranking code (those files are unchanged). Sentinel AI applies it through momentum-gate.ts, after the engine's own
// surface vetting, and only when the operator switch is on.
//
// Uses the existing 120/60/30 price-action readings. It does not recalculate,
// override, or reinterpret canonical 1,000-tick digit psychology.
//
// A candidate qualifies only when:
//   1) there are at least 120 observed ticks in a measurable 120-tick field;
//   2) the contract's actual winning zone is gaining share by >= 1.5pp;
//   3) the losing zone is losing share by >= 1.5pp;
//   4) enough individual winning digits contribute to the move;
//   5) at least one losing digit is weakening (two when the losing zone has 4+);
//   6) the mid-window does not materially contradict the move; and
//   7) the winning zone has adequate fast-window activity.
//
// The 1.5pp directional threshold matches the existing SidePressure direction
// threshold. Breadth/activity thresholds are intentionally tolerant of normal
// tick discreteness; this is not an all-digits-must-rise rule.
import type {
  ContractPriceAction,
  DigitPressureReading,
} from "../sentinel/price-action-psychology";

export const MOMENTUM_MIN_TICKS = 120;
export const MOMENTUM_MIN_SIDE_DRIFT_PP = 1.5;
export const MOMENTUM_MIN_WINNING_BREADTH = 2;
export const MOMENTUM_WINNING_ACTIVITY_TOLERANCE_PP = 10;
export const MOMENTUM_MID_CONTRADICTION_LIMIT_PP = 2;
const DIGIT_CHANGE_EPSILON_PP = 0.2;

export interface MomentumSeparationReport {
  pass: boolean;
  measurable: boolean;
  windowTicks: number;
  winningDirection: string;
  losingDirection: string;
  winningShareDeltaPp: number | null;
  losingShareDeltaPp: number | null;
  winningMidDeltaPp: number | null;
  winningActivityPct: number | null;
  minimumWinningActivityPct: number | null;
  winningDigitsStrengthening: number;
  minimumWinningBreadth: number;
  losingDigitsWeakening: number;
  minimumLosingWeaknessBreadth: number;
  score: number;
  reasons: string[];
  blockers: string[];
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function emptyReport(
  priceAction: ContractPriceAction | null | undefined,
  observedTicks: number,
  blockers: string[],
): MomentumSeparationReport {
  return {
    pass: false,
    measurable: false,
    windowTicks: observedTicks,
    winningDirection: priceAction?.winningSide?.direction ?? "UNKNOWN",
    losingDirection: priceAction?.losingSide?.direction ?? "UNKNOWN",
    winningShareDeltaPp: null,
    losingShareDeltaPp: null,
    winningMidDeltaPp: null,
    winningActivityPct: null,
    minimumWinningActivityPct: null,
    winningDigitsStrengthening: 0,
    minimumWinningBreadth: 0,
    losingDigitsWeakening: 0,
    minimumLosingWeaknessBreadth: 0,
    score: 0,
    reasons: [],
    blockers,
  };
}

function countIncreasing(readings: DigitPressureReading[]): number {
  return readings.filter((reading) => reading.rateOfChangePp > DIGIT_CHANGE_EPSILON_PP).length;
}

function countDecreasing(readings: DigitPressureReading[]): number {
  return readings.filter((reading) => reading.rateOfChangePp < -DIGIT_CHANGE_EPSILON_PP).length;
}

/**
 * Evaluate the existing contract-specific price-action evidence.
 *
 * observedTicks must be sourced from candidate.priceActionField.n, not inferred
 * from the configured window length. Missing data fails closed.
 */
export function evaluateMomentumSeparation(
  priceAction: ContractPriceAction | null | undefined,
  observedTicks: number,
): MomentumSeparationReport {
  if (
    !priceAction ||
    !priceAction.measurable ||
    !Number.isFinite(observedTicks) ||
    observedTicks < MOMENTUM_MIN_TICKS ||
    priceAction.window < MOMENTUM_MIN_TICKS ||
    priceAction.winners.length === 0 ||
    priceAction.losers.length === 0
  ) {
    return emptyReport(priceAction, observedTicks, [
      `Two-sided momentum unavailable: requires a measurable ${MOMENTUM_MIN_TICKS}-tick price-action field and valid contract zones`,
    ]);
  }

  const winning = priceAction.winningSide;
  const losing = priceAction.losingSide;
  const winningReadings = winning.leaders.filter((reading) =>
    priceAction.winners.includes(reading.digit),
  );
  const losingReadings = losing.leaders.filter((reading) =>
    priceAction.losers.includes(reading.digit),
  );

  // Mid-window share is summed from the same per-digit readings used by the
  // existing price-action engine. The windows are nested, so mid is used as a
  // contradiction guard, not treated as an independent statistical sample.
  const winningMidSharePct = winningReadings.reduce((sum, reading) => sum + reading.pctMid, 0);
  const winningMidDeltaPp = winningMidSharePct - winning.sharePct;
  const winningShareDeltaPp = winning.rateOfChangePp;
  const losingShareDeltaPp = losing.rateOfChangePp;

  const minimumWinningBreadth = Math.min(
    priceAction.winners.length,
    Math.max(MOMENTUM_MIN_WINNING_BREADTH, Math.ceil(priceAction.winners.length * 0.25)),
  );
  const minimumLosingWeaknessBreadth = priceAction.losers.length >= 4 ? 2 : 1;
  const winningDigitsStrengthening = countIncreasing(winningReadings);
  const losingDigitsWeakening = countDecreasing(losingReadings);

  // The minimum recent activity is contract-specific: the winning zone's
  // theoretical share less a 10pp tolerance, rather than one fixed percentage
  // applied to Over and Under contracts with different barrier sizes.
  const theoreticalWinningSharePct = (priceAction.winners.length / 10) * 100;
  const minimumWinningActivityPct = Math.max(
    0,
    theoreticalWinningSharePct - MOMENTUM_WINNING_ACTIVITY_TOLERANCE_PP,
  );
  const winningActivityPct = winning.sharePctFast;

  const blockers: string[] = [];
  const reasons: string[] = [];

  if (
    winning.direction !== "INCREASING" ||
    winningShareDeltaPp < MOMENTUM_MIN_SIDE_DRIFT_PP
  ) {
    blockers.push(
      `Winning zone must be increasing by at least ${MOMENTUM_MIN_SIDE_DRIFT_PP.toFixed(1)}pp (observed ${winningShareDeltaPp.toFixed(2)}pp)`,
    );
  } else {
    reasons.push(`Winning zone gaining ${winningShareDeltaPp.toFixed(2)}pp`);
  }

  if (
    losing.direction !== "DECREASING" ||
    losingShareDeltaPp > -MOMENTUM_MIN_SIDE_DRIFT_PP
  ) {
    blockers.push(
      `Losing zone must be decreasing by at least ${MOMENTUM_MIN_SIDE_DRIFT_PP.toFixed(1)}pp (observed ${losingShareDeltaPp.toFixed(2)}pp)`,
    );
  } else {
    reasons.push(`Losing zone declining ${Math.abs(losingShareDeltaPp).toFixed(2)}pp`);
  }

  if (winningDigitsStrengthening < minimumWinningBreadth) {
    blockers.push(
      `Winning-digit breadth insufficient (${winningDigitsStrengthening}/${winningReadings.length}; need ${minimumWinningBreadth})`,
    );
  } else {
    reasons.push(
      `${winningDigitsStrengthening} winning digits are strengthening (minimum ${minimumWinningBreadth})`,
    );
  }

  if (losingDigitsWeakening < minimumLosingWeaknessBreadth) {
    blockers.push(
      `Losing-digit decline breadth insufficient (${losingDigitsWeakening}/${losingReadings.length}; need ${minimumLosingWeaknessBreadth})`,
    );
  } else {
    reasons.push(
      `${losingDigitsWeakening} losing digits are weakening (minimum ${minimumLosingWeaknessBreadth})`,
    );
  }

  if (winningActivityPct < minimumWinningActivityPct) {
    blockers.push(
      `Winning-zone activity too low (${winningActivityPct.toFixed(1)}%; minimum ${minimumWinningActivityPct.toFixed(1)}% for this contract)`,
    );
  } else {
    reasons.push(
      `Winning-zone activity ${winningActivityPct.toFixed(1)}% meets its ${minimumWinningActivityPct.toFixed(1)}% floor`,
    );
  }

  if (winningMidDeltaPp < -MOMENTUM_MID_CONTRADICTION_LIMIT_PP) {
    blockers.push(
      `Mid-window contradicts winning momentum (${winningMidDeltaPp.toFixed(2)}pp; limit -${MOMENTUM_MID_CONTRADICTION_LIMIT_PP.toFixed(1)}pp)`,
    );
  } else {
    reasons.push(`Mid-window does not materially contradict the move (${winningMidDeltaPp.toFixed(2)}pp)`);
  }

  // Bounded diagnostic score: direction 35, breadth 25, mid-window 20,
  // and absolute activity 20. Score is descriptive; pass is determined by all
  // explicit gates above, not by a score shortcut.
  const directionScore =
    winningShareDeltaPp >= MOMENTUM_MIN_SIDE_DRIFT_PP &&
    losingShareDeltaPp <= -MOMENTUM_MIN_SIDE_DRIFT_PP
      ? 35
      : 0;
  const breadthScore =
    25 *
    Math.min(
      1,
      winningDigitsStrengthening / Math.max(1, minimumWinningBreadth),
    ) *
    Math.min(
      1,
      losingDigitsWeakening / Math.max(1, minimumLosingWeaknessBreadth),
    );
  const midScore =
    winningMidDeltaPp >= 0
      ? 20
      : 20 * clamp(
          1 + winningMidDeltaPp / MOMENTUM_MID_CONTRADICTION_LIMIT_PP,
          0,
          1,
        );
  const activityScore =
    winningActivityPct >= minimumWinningActivityPct ? 20 : 0;
  const pass = blockers.length === 0;

  return {
    pass,
    measurable: true,
    windowTicks: observedTicks,
    winningDirection: winning.direction,
    losingDirection: losing.direction,
    winningShareDeltaPp,
    losingShareDeltaPp,
    winningMidDeltaPp,
    winningActivityPct,
    minimumWinningActivityPct,
    winningDigitsStrengthening,
    minimumWinningBreadth,
    losingDigitsWeakening,
    minimumLosingWeaknessBreadth,
    score: Math.round(directionScore + breadthScore + midScore + activityScore),
    reasons,
    blockers,
  };
}
