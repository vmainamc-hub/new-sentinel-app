import {
  evaluateMomentumSeparation,
  MOMENTUM_MIN_TICKS,
} from "../momentum-separation";
import type { ContractPriceAction, DigitPressureReading, SidePressure } from "../../sentinel/price-action-psychology";

function reading(digit: number, pct: number, pctMid: number, pctFast: number): DigitPressureReading {
  return {
    digit,
    pct,
    pctMid,
    pctFast,
    structuralPct: 10,
    vsStructuralPp: pct - 10,
    rateOfChangePp: pctFast - pct,
    accelerationPp: pctFast - 2 * pctMid + pct,
    recentActivity: 3,
    persistence: 1,
    gainingShare: pctFast > pct,
    sinceSeen: 0,
    movement: pctFast > pct ? "STRENGTHENING" : pctFast < pct ? "WEAKENING" : "STABLE",
    pressure: 0,
    note: "test fixture",
  } as DigitPressureReading;
}

function side(
  name: "WINNING" | "LOSING",
  digits: number[],
  pct: number[],
  mid: number[],
  fast: number[],
): SidePressure {
  const sharePct = pct.reduce((sum, value) => sum + value, 0);
  const sharePctMid = mid.reduce((sum, value) => sum + value, 0);
  const sharePctFast = fast.reduce((sum, value) => sum + value, 0);
  const delta = sharePctFast - sharePct;
  const readings = digits.map((digit, index) =>
    reading(digit, pct[index], mid[index], fast[index]),
  );
  return {
    side: name,
    digits,
    sharePct,
    sharePctFast,
    rateOfChangePp: delta,
    accelerationPp: sharePctFast - 2 * sharePctMid + sharePct,
    direction: delta >= 1.5 ? "INCREASING" : delta <= -1.5 ? "DECREASING" : "STABLE",
    pressure: 0,
    leaders: readings,
    summary: "test fixture",
  } as SidePressure;
}

function fixture(overrides: {
  winningPct?: number[];
  winningMid?: number[];
  winningFast?: number[];
  losingPct?: number[];
  losingMid?: number[];
  losingFast?: number[];
  window?: number;
  measurable?: boolean;
} = {}): ContractPriceAction {
  const winners = [3, 4, 5, 6, 7, 8, 9];
  const losers = [0, 1, 2];
  const winningPct = overrides.winningPct ?? [10, 10, 10, 10, 10, 10, 10];
  const winningMid = overrides.winningMid ?? [10, 10, 10, 10, 10, 10, 11];
  const winningFast = overrides.winningFast ?? [11, 11, 11, 11, 10, 11, 11];
  const losingPct = overrides.losingPct ?? [10, 10, 10];
  const losingMid = overrides.losingMid ?? [9.7, 9.7, 9.6];
  const losingFast = overrides.losingFast ?? [8, 8, 8];

  return {
    contract: "Over 2",
    side: "OVER",
    window: overrides.window ?? 120,
    measurable: overrides.measurable ?? true,
    winners,
    losers,
    preferredParity: "EVEN",
    winningSide: side("WINNING", winners, winningPct, winningMid, winningFast),
    losingSide: side("LOSING", losers, losingPct, losingMid, losingFast),
  } as unknown as ContractPriceAction;
}

describe("evaluateMomentumSeparation", () => {
  it("accepts a sustained, broad winning-zone rise with a declining losing zone", () => {
    const result = evaluateMomentumSeparation(fixture(), MOMENTUM_MIN_TICKS);
    expect(result.pass).toBe(true);
    expect(result.winningShareDeltaPp).toBeGreaterThanOrEqual(1.5);
    expect(result.losingShareDeltaPp).toBeLessThanOrEqual(-1.5);
    expect(result.winningDigitsStrengthening).toBeGreaterThanOrEqual(2);
    expect(result.losingDigitsWeakening).toBeGreaterThanOrEqual(1);
    expect(result.blockers).toEqual([]);
  });

  it("fails closed when the observed tick sample is insufficient", () => {
    const result = evaluateMomentumSeparation(fixture(), MOMENTUM_MIN_TICKS - 1);
    expect(result.pass).toBe(false);
    expect(result.blockers.join(" ")).toContain("120-tick");
  });

  it("rejects a short window that is not measurable", () => {
    const result = evaluateMomentumSeparation(fixture({ measurable: false }), 120);
    expect(result.pass).toBe(false);
  });

  it("rejects a material mid-window contradiction", () => {
    const result = evaluateMomentumSeparation(
      fixture({ winningMid: [9, 9, 9, 9, 9, 9, 9] }),
      120,
    );
    expect(result.pass).toBe(false);
    expect(result.blockers.join(" ")).toContain("Mid-window contradicts");
  });

  it("rejects inadequate winning-zone activity for the contract size", () => {
    const result = evaluateMomentumSeparation(
      fixture({ winningFast: [8, 8, 8, 8, 8, 8, 8] }),
      120,
    );
    expect(result.pass).toBe(false);
    expect(result.blockers.join(" ")).toContain("Winning-zone activity too low");
  });

  it("rejects flat or declining winning-side momentum", () => {
    const result = evaluateMomentumSeparation(
      fixture({ winningFast: [9, 9, 9, 9, 9, 9, 9] }),
      120,
    );
    expect(result.pass).toBe(false);
    expect(result.blockers.join(" ")).toContain("Winning zone must be increasing");
  });
});
