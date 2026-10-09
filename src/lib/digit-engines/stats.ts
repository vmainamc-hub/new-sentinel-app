import type { Digit, DigitDistribution, DigitTick, FrequencyWindow } from "./types";
export const WINDOWS = { short: 24, medium: 80, long: 240 } as const;
export const DIGITS: Digit[] = [0,1,2,3,4,5,6,7,8,9];

export function lastDigitFromQuote(quote: string | number, pipSize: number): Digit | null {
  if (!Number.isFinite(Number(quote)) || !Number.isInteger(pipSize) || pipSize < 0 || pipSize > 10) return null;
  const raw = String(quote).trim();
  let fixed: string;
  if (pipSize === 0) fixed = String(Math.abs(Math.trunc(Number(raw))));
  else if (/^[+-]?\d+(?:\.\d+)?$/.test(raw) && (raw.split(".")[1] ?? "").length <= pipSize) {
    const parts = raw.replace(/^[+-]/, "").split(".");
    fixed = parts[0] + "." + (parts[1] ?? "").padEnd(pipSize, "0");
  } else fixed = Math.abs(Number(raw)).toFixed(pipSize);
  const text = pipSize === 0 ? fixed.slice(-1) : fixed.split(".")[1]?.slice(-1);
  const digit = Number(text);
  return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit as Digit : null;
}
export function extractDigits(ticks: DigitTick[]): Digit[] {
  const result: Digit[] = [];
  for (const tick of ticks) { const digit = lastDigitFromQuote(tick.quote, tick.pipSize); if (digit !== null) result.push(digit); }
  return result;
}
export function frequencyWindow(digits: Digit[], size: number): FrequencyWindow {
  const slice = digits.slice(-size), counts = Array<number>(10).fill(0);
  for (const digit of slice) counts[digit] += 1;
  const n = slice.length;
  return { size, sampleSize: n, counts, rates: counts.map(count => n ? count / n : 0) };
}
export function distribution(digits: Digit[]): DigitDistribution {
  const long = frequencyWindow(digits, WINDOWS.long), medium = frequencyWindow(digits, WINDOWS.medium), short = frequencyWindow(digits, WINDOWS.short);
  const entropy = long.rates.reduce((sum, p) => sum + (p > 0 ? -p * Math.log2(p) : 0), 0);
  return { digits, windows: { short, medium, long }, entropy };
}
export function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (!Number.isFinite(successes) || !Number.isFinite(trials) || trials <= 0) return 0;
  const n = Math.max(0, Math.floor(trials)), k = Math.min(n, Math.max(0, Math.floor(successes))), p = k / n, z2 = z*z;
  const denominator = 1 + z2/n, center = p + z2/(2*n), margin = z*Math.sqrt(p*(1-p)/n + z2/(4*n*n));
  return Math.max(0, (center-margin)/denominator);
}
export function smoothedRate(successes: number, trials: number, priorRate: number, priorWeight: number): number {
  if (trials < 0 || priorWeight < 0 || priorRate < 0 || priorRate > 1) return priorRate;
  return (successes + priorRate*priorWeight)/(trials+priorWeight || 1);
}
export function clamp(value: number, min = 0, max = 100): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
