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
