// APEX SENTINEL — statistical validation.
// Distinguishes STATISTICALLY UNUSUAL from PREDICTIVELY USEFUL. A significant
// test result is never presented as proof of profitability.

export type EvidenceGrade =
  "INTERESTING PATTERN" | "STATISTICALLY SUPPORTED" | "HISTORICALLY VALIDATED";

export interface RateEstimate {
  raw: number; // observed rate
  adjusted: number; // shrunk toward the theoretical baseline
  n: number;
  lower: number; // Wilson 95% lower bound
  upper: number;
  confidence: "LOW" | "MODERATE" | "HIGH";
}

export interface StatReport {
  chi2: number;
  chi2df: number;
  chi2p: number;
  chi2Significant: boolean;
  runsZ: number;
  runsP: number;
  runsSignificant: boolean;
  autocorr1: number;
  autocorrSignificant: boolean;
  grade: EvidenceGrade;
  notes: string[];
  /** True when the sample is too small for the tests to mean anything. */
  thin: boolean;
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - margin) / den),
    upper: Math.min(1, (centre + margin) / den),
  };
}

/**
 * Beta-binomial shrinkage toward a baseline. `strength` is the prior sample
 * size: with strength 120 a 18-tick 100% streak barely moves the estimate.
 */
export function shrinkRate(
  successes: number,
  n: number,
  baseline: number,
  strength: number,
): RateEstimate {
  const raw = n > 0 ? successes / n : baseline;
  const alpha = baseline * strength;
  const beta = (1 - baseline) * strength;
  const adjusted = (successes + alpha) / (n + alpha + beta);
  const { lower, upper } = wilson(successes, n);
  const width = upper - lower;
  const confidence =
    n >= 400 && width < 0.09 ? "HIGH" : n >= 150 && width < 0.16 ? "MODERATE" : "LOW";
  return { raw, adjusted, n, lower, upper, confidence };
}

/** Regularised lower incomplete gamma — used for the chi-square p-value. */
function lowerGamma(s: number, x: number): number {
  if (x <= 0) return 0;
  if (x < s + 1) {
    let sum = 1 / s;
    let term = sum;
    for (let k = 1; k < 200; k++) {
      term *= x / (s + k);
      sum += term;
      if (term < sum * 1e-12) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - logGamma(s));
  }
  // Continued fraction for the upper gamma, then complement.
  let a0 = 1;
  let b0 = 0;
  let a1 = x;
  let b1 = 1;
  let fac = 1 / x;
  let g = b1 * fac;
  for (let i = 1; i < 200; i++) {
    const an = i - s;
    a0 = (a1 + a0 * an) * fac;
    b0 = (b1 + b0 * an) * fac;
    const anf = i * fac;
    a1 = x * a0 + anf * a1;
    b1 = x * b0 + anf * b1;
    if (a1 !== 0) {
      fac = 1 / a1;
      const gNew = b1 * fac;
      if (Math.abs((gNew - g) / gNew) < 1e-12) {
        g = gNew;
        break;
      }
      g = gNew;
    }
  }
  return 1 - Math.exp(-x + s * Math.log(x) - logGamma(s)) * g;
}

function logGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.001208650973866179, -5.395239384953e-6,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

export function chiSquareP(chi2: number, df: number): number {
  if (chi2 <= 0 || df <= 0) return 1;
  return 1 - lowerGamma(df / 2, chi2 / 2);
}

/** Two-sided normal tail probability. */
export function normalP(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (1.330274 * t * t * t * t - 1.821256 * t * t * t + 1.781478 * t * t - 0.356538 * t + 0.319382);
  return 2 * p;
}

/** Wald–Wolfowitz runs test over a win/loss sequence. */
export function runsTest(seq: boolean[]): { z: number; p: number } {
  const n = seq.length;
  const n1 = seq.filter(Boolean).length;
  const n2 = n - n1;
  if (n1 < 10 || n2 < 10) return { z: 0, p: 1 };
  let runs = 1;
  for (let i = 1; i < n; i++) if (seq[i] !== seq[i - 1]) runs++;
  const mean = (2 * n1 * n2) / n + 1;
  const varr = (2 * n1 * n2 * (2 * n1 * n2 - n)) / (n * n * (n - 1));
  const sd = Math.sqrt(Math.max(1e-9, varr));
  const z = (runs - mean) / sd;
  return { z, p: normalP(z) };
}

export function autocorrelation(values: number[], lag = 1): number {
  const n = values.length;
  if (n <= lag + 5) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dv = values[i] - mean;
    den += dv * dv;
    if (i >= lag) num += dv * (values[i - lag] - mean);
  }
  return den > 0 ? num / den : 0;
}

export function statisticalReport(
  digitCounts: number[],
  winSequence: boolean[],
  analogueN: number,
  analogueEdge: number,
  alpha: number,
): StatReport {
  const notes: string[] = [];
  const n = digitCounts.reduce((a, b) => a + b, 0);
  const thin = n < 150;

  const expected = n / 10;
  let chi2 = 0;
  if (expected > 0)
    for (const f of digitCounts) chi2 += ((f - expected) * (f - expected)) / expected;
  const chi2p = chiSquareP(chi2, 9);
  const chi2Significant = !thin && chi2p < alpha;

  const runs = runsTest(winSequence);
  const runsSignificant = !thin && runs.p < alpha;

  const ac = autocorrelation(
    winSequence.map((w) => (w ? 1 : 0)),
    1,
  );
  const acSignificant =
    winSequence.length > 100 && Math.abs(ac) > 1.96 / Math.sqrt(winSequence.length);

  if (thin) notes.push(`DATA THIN — ${n} ticks is below the 150-tick minimum.`);
  if (chi2Significant)
    notes.push(
      `Digit distribution is statistically unusual (χ²=${chi2.toFixed(1)}, p=${chi2p.toFixed(4)}).`,
    );
  else if (!thin)
    notes.push(`Digit distribution is indistinguishable from uniform (p=${chi2p.toFixed(3)}).`);
  if (runsSignificant)
    notes.push(
      `Win/loss ordering is non-random (runs z=${runs.z.toFixed(2)}, p=${runs.p.toFixed(4)}).`,
    );
  if (acSignificant) notes.push(`Lag-1 autocorrelation ${ac.toFixed(3)} exceeds the noise band.`);

  let grade: EvidenceGrade = "INTERESTING PATTERN";
  if (!thin && (chi2Significant || runsSignificant || acSignificant))
    grade = "STATISTICALLY SUPPORTED";
  if (grade === "STATISTICALLY SUPPORTED" && analogueN >= 120 && analogueEdge > 0)
    grade = "HISTORICALLY VALIDATED";
  if (grade === "INTERESTING PATTERN")
    notes.push("STATISTICAL SUPPORT WEAK — treat this as an observation, not an edge.");

  return {
    chi2,
    chi2df: 9,
    chi2p,
    chi2Significant,
    runsZ: runs.z,
    runsP: runs.p,
    runsSignificant,
    autocorr1: ac,
    autocorrSignificant: acSignificant,
    grade,
    notes,
    thin,
  };
}
