// Small, dependency-free statistics used by the simulator, the crowd model and the edge test.

export const clamp = (x: number, min = 0, max = 1) => Math.max(min, Math.min(max, x));

/** z-score of `wins` out of `n` trials against a true win probability `p`. 0 when it cannot be computed. */
export function zScore(wins: number, n: number, p: number): number {
    if (n <= 0 || p <= 0 || p >= 1) return 0;
    return (wins - n * p) / Math.sqrt(n * p * (1 - p));
}

/** Wilson score interval for a proportion (default 95%). Honest about small samples, unlike a normal approximation. */
export function wilson(wins: number, n: number, z = 1.96): { lo: number; hi: number } {
    if (n <= 0) return { lo: 0, hi: 1 };
    const p = wins / n,
        z2 = z * z,
        denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
    return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * Deriv digit contracts pay a fixed amount for a win. With a platform margin `m`, a contract whose true win
 * probability is `p` pays a profit of (1 - m) / p - 1 per unit staked. The real number comes from the live proposal;
 * this is an adjustable estimate so break-even can be shown before a quote exists.
 */
export const profitMultiple = (p: number, margin: number) => (p > 0 ? (1 - margin) / p - 1 : 0);

/** Win rate a contract must sustain to break even at that payout. Equals p / (1 - margin). */
export const breakEvenRate = (p: number, margin: number) => 1 / (1 + profitMultiple(p, margin));

/** Expected profit per unit staked when the contract wins `rate` of the time. */
export const evPerTrade = (rate: number, p: number, margin: number) => rate * profitMultiple(p, margin) - (1 - rate);

/** Deterministic PRNG so demo data and shuffles are reproducible. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates shuffle into a new array. */
export function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
    const out = xs.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// ---------- distribution helpers (used by the scanner and the Lab) ----------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26; absolute error below 1.5e-7). */
export function normalCdf(z: number): number {
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const erf = 1 - poly * Math.exp(-x * x);
    return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Lanczos approximation of ln(Gamma(x)) for x > 0. */
export function lnGamma(x: number): number {
    const c = [
        76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2,
        -0.5395239384953e-5,
    ];
    let y = x;
    let tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a, x) (Numerical Recipes: series below a+1, continued fraction above). */
function gammaQ(a: number, x: number): number {
    if (x <= 0) return 1;
    const lg = lnGamma(a);
    if (x < a + 1) {
        let ap = a,
            sum = 1 / a,
            del = sum;
        for (let n = 0; n < 500; n++) {
            ap += 1;
            del *= x / ap;
            sum += del;
            if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
        }
        return clamp(1 - sum * Math.exp(-x + a * Math.log(x) - lg));
    }
    const tiny = 1e-300;
    let b = x + 1 - a,
        c = 1 / tiny,
        d = 1 / b,
        h = d;
    for (let i = 1; i <= 500; i++) {
        const an = -i * (i - a);
        b += 2;
        d = an * d + b;
        if (Math.abs(d) < tiny) d = tiny;
        c = b + an / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1) < 1e-14) break;
    }
    return clamp(Math.exp(-x + a * Math.log(x) - lg) * h);
}

/** P(chi-square with `df` degrees of freedom >= x). */
export const chiSquareSf = (x: number, df: number): number => (df <= 0 ? 1 : gammaQ(df / 2, x / 2));

const lnChoose = (n: number, k: number) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

/** Exact one-sided binomial tail: P(X >= wins) for X ~ Binomial(n, p). */
export function binomialUpperP(wins: number, n: number, p: number): number {
    if (n <= 0) return 1;
    if (wins <= 0) return 1;
    if (wins > n) return 0;
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    const lp = Math.log(p),
        lq = Math.log(1 - p);
    let total = 0;
    for (let k = wins; k <= n; k++) total += Math.exp(lnChoose(n, k) + k * lp + (n - k) * lq);
    return clamp(total);
}

/**
 * Benjamini-Hochberg adjusted p-values (q-values). Entries that are null stay null and do not count toward the number
 * of tests. A cell is "significant at false-discovery rate q" when its q-value is at or below q.
 */
export function bhAdjust(pValues: ReadonlyArray<number | null>): Array<number | null> {
    const idx = pValues.map((p, i) => ({ p, i })).filter((x): x is { p: number; i: number } => x.p !== null);
    const m = idx.length;
    const out: Array<number | null> = pValues.map(() => null);
    idx.sort((a, b) => a.p - b.p);
    let running = 1;
    for (let r = m - 1; r >= 0; r--) {
        running = Math.min(running, (idx[r].p * m) / (r + 1));
        out[idx[r].i] = clamp(running);
    }
    return out;
}

/** Percentile (0-1) of an array, linear interpolation. */
export function quantile(xs: readonly number[], q: number): number {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const pos = clamp(q) * (s.length - 1);
    const lo = Math.floor(pos),
        hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
