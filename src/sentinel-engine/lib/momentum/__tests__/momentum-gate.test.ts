import type { RankedOpportunity } from "../../apex/types";
import type {
  ContractPriceAction,
  DigitPressureReading,
  SidePressure,
} from "../../sentinel/price-action-psychology";
import { evaluateCandidateMomentum, selectTradable } from "../momentum-gate";

function reading(digit: number, pct: number, pctMid: number, pctFast: number): DigitPressureReading {
  return {
    digit,
    pct,
    pctMid,
    pctFast,
    rateOfChangePp: pctFast - pct,
  } as unknown as DigitPressureReading;
}

function side(digits: number[], pct: number[], mid: number[], fast: number[]): SidePressure {
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const delta = sum(fast) - sum(pct);
  return {
    digits,
    sharePct: sum(pct),
    sharePctFast: sum(fast),
    rateOfChangePp: delta,
    direction: delta >= 1.5 ? "INCREASING" : delta <= -1.5 ? "DECREASING" : "STABLE",
    leaders: digits.map((digit, index) => reading(digit, pct[index], mid[index], fast[index])),
  } as unknown as SidePressure;
}

function priceAction(passes: boolean): ContractPriceAction {
  const winners = [3, 4, 5, 6, 7, 8, 9];
  const losers = [0, 1, 2];
  const winningFast = passes ? [11, 11, 11, 11, 10, 11, 11] : [9, 9, 9, 9, 9, 9, 9];
  return {
    window: 120,
    measurable: true,
    winners,
    losers,
    winningSide: side(winners, [10, 10, 10, 10, 10, 10, 10], [10, 10, 10, 10, 10, 10, 11], winningFast),
    losingSide: side(losers, [10, 10, 10], [9.7, 9.7, 9.6], [8, 8, 8]),
  } as unknown as ContractPriceAction;
}

const candidate = (id: string, passes: boolean, ticks = 120): RankedOpportunity =>
  ({ id, priceAction: priceAction(passes), priceActionField: { n: ticks } }) as unknown as RankedOpportunity;

const ids = (list: readonly RankedOpportunity[]) => list.map((item) => (item as unknown as { id: string }).id);

describe("momentum gate", () => {
  const a = candidate("A", false);
  const b = candidate("B", true);
  const c = candidate("C", true);
  const d = candidate("D", false);

  it("with the switch off the tradable candidate is the first one and nothing is blocked", () => {
    const result = selectTradable([a, b, c, d], { requireMomentum: false });
    expect(result.tradable).toBe(a);
    expect(result.blockedCount).toBe(0);
    expect(result.reports.every((report) => report.blocked === false)).toBe(true);
  });

  it("with the switch off the reports keep the same membership and order as the input", () => {
    const input = [a, b, c, d];
    const result = selectTradable(input, { requireMomentum: false });
    expect(result.reports.map((report) => report.candidate)).toEqual(input);
    expect(ids(result.reports.map((report) => report.candidate))).toEqual(["A", "B", "C", "D"]);
  });

  it("with the switch on it takes the first passing candidate in rank order", () => {
    const result = selectTradable([a, b, c, d], { requireMomentum: true });
    expect(result.tradable).toBe(b);
    expect(result.blockedCount).toBe(2);
    expect(result.reports.map((report) => report.blocked)).toEqual([true, false, false, true]);
  });

  it("returns no tradable candidate when every candidate fails", () => {
    const result = selectTradable([a, d], { requireMomentum: true });
    expect(result.tradable).toBeNull();
    expect(result.blockedCount).toBe(2);
  });

  it("an empty list gives no tradable candidate", () => {
    expect(selectTradable([], { requireMomentum: true })).toEqual({ tradable: null, reports: [], blockedCount: 0 });
    expect(selectTradable([], { requireMomentum: false }).tradable).toBeNull();
  });

  it("fails closed on missing evidence when on, and lets it through when off", () => {
    const noData = { id: "N" } as unknown as RankedOpportunity;
    const tooFew = candidate("T", true, 40);
    const on = selectTradable([noData, tooFew], { requireMomentum: true });
    expect(on.tradable).toBeNull();
    expect(on.blockedCount).toBe(2);
    expect(on.reports[0].momentum.measurable).toBe(false);
    const off = selectTradable([noData, tooFew], { requireMomentum: false });
    expect(off.tradable).toBe(noData);
  });

  it("a malformed price-action object fails closed instead of throwing", () => {
    const broken = { id: "X", priceAction: { measurable: true, window: 120, winners: [1], losers: [2] }, priceActionField: { n: 200 } } as unknown as RankedOpportunity;
    expect(() => evaluateCandidateMomentum(broken)).not.toThrow();
    expect(evaluateCandidateMomentum(broken).pass).toBe(false);
    expect(selectTradable([broken], { requireMomentum: true }).tradable).toBeNull();
  });

  it("never re-sorts or mutates its input", () => {
    const input = [a, b, c, d] as const;
    const snapshot = JSON.stringify(input);
    const copy = [...input];
    selectTradable(input, { requireMomentum: true });
    selectTradable(input, { requireMomentum: false });
    expect([...input]).toEqual(copy);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
