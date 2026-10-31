// AI Intel statistical layer: pure functions over a market's digit history. Reuses Sixfold's tested statistics
// (Wilson interval, exact binomial tail, chi-square tail, Benjamini-Hochberg) and the Sixfold-compatible simulator.
// Nothing here predicts the next digit. It measures what a rule did on past ticks and says how sure that is.
import { type Contract, winningDigits, winProbability } from '@/components/premium/sixfold/bot';
import { bhAdjust, binomialUpperP, chiSquareSf, normalCdf, wilson } from '@/components/premium/sixfold/stats';
import { type EntryMethod, OVER_2, simulate, tally, ticksFromDigits, UNDER_7 } from './sim';

export type Regime = 'STABLE' | 'CHANGING' | 'UNUSUAL' | 'UNSTABLE' | 'INSUFFICIENT_DATA';

export const MIN_TICKS_FOR_REGIME = 300;
/** Fewer settled trades than this and a win rate is not reported as evidence. */
export const MIN_TRADES = 60;
export const FDR_Q = 0.05;

export const digitCounts = (digits: readonly number[]): number[] => {
    const c = Array<number>(10).fill(0);
    for (const d of digits) c[d] += 1;
    return c;
};

/** Chi-square goodness of fit against 10 equally likely digits. */
export function uniformity(digits: readonly number[]): { n: number; stat: number; p: number | null } {
    const n = digits.length;
    if (n < 50) return { n, stat: 0, p: null };
    const exp = n / 10;
    const stat = digitCounts(digits).reduce((s, o) => s + (o - exp) ** 2 / exp, 0);
    return { n, stat, p: chiSquareSf(stat, 9) };
}

const winIndicator = (digits: readonly number[], contract: Contract): number[] => {
    const w = new Set(winningDigits(contract));
    return digits.map(d => (w.has(d) ? 1 : 0));
};

/** Share of ticks whose digit wins the contract, over the last `window` ticks. */
export function rollingShare(digits: readonly number[], contract: Contract, window: number): { n: number; rate: number | null } {
    const tail = digits.slice(-window);
    if (!tail.length) return { n: 0, rate: null };
    return { n: tail.length, rate: winIndicator(tail, contract).reduce((a, b) => a + b, 0) / tail.length };
}

/** Standardised two-sided CUSUM on the winning-digit indicator. Returns the largest excursion in sigma units. */
export function cusumPeak(digits: readonly number[], contract: Contract, k = 0.5): number {
    const p = winProbability(contract);
    const sd = Math.sqrt(p * (1 - p));
    if (sd === 0) return 0;
    let hi = 0;
    let lo = 0;
    let peak = 0;
    for (const w of winIndicator(digits, contract)) {
        const z = (w - p) / sd;
        hi = Math.max(0, hi + z - k);
        lo = Math.max(0, lo - z - k);
        peak = Math.max(peak, hi, lo);
    }
    return peak;
}

export const CUSUM_LIMIT = 8;

export type RegimeReport = {
    regime: Regime;
    /** Recent window win-digit share minus the earlier window's, as a z statistic. */
    shiftZ: number | null;
    cusum: number | null;
    uniformityP: number | null;
    n: number;
    reason: string;
};

/** Regime from measurable criteria only: sample size, a recent-vs-earlier shift test, CUSUM and digit uniformity. */
export function classifyRegime(digits: readonly number[], contract: Contract): RegimeReport {
    const n = digits.length;
    if (n < MIN_TICKS_FOR_REGIME)
        return { regime: 'INSUFFICIENT_DATA', shiftZ: null, cusum: null, uniformityP: null, n, reason: `${n} of ${MIN_TICKS_FOR_REGIME} ticks needed` };
    const recentN = Math.min(200, Math.floor(n / 3));
    const recent = winIndicator(digits.slice(-recentN), contract);
    const prior = winIndicator(digits.slice(Math.max(0, n - recentN - 800), n - recentN), contract);
    const pr = recent.reduce((a, b) => a + b, 0) / recent.length;
    const pp = prior.reduce((a, b) => a + b, 0) / prior.length;
    const pooled = (pr * recent.length + pp * prior.length) / (recent.length + prior.length);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / recent.length + 1 / prior.length));
    const shiftZ = se > 0 ? (pr - pp) / se : 0;
    const cusum = cusumPeak(digits.slice(-1000), contract);
    const u = uniformity(digits.slice(-1000));
    let regime: Regime = 'STABLE';
    let reason = 'no measurable shift';
    if (Math.abs(shiftZ) > 3.5 && cusum > CUSUM_LIMIT) {
        regime = 'UNSTABLE';
        reason = `recent share moved ${shiftZ.toFixed(1)} sigma and CUSUM ${cusum.toFixed(1)} > ${CUSUM_LIMIT}`;
    } else if (Math.abs(shiftZ) > 2.5 || cusum > CUSUM_LIMIT) {
        regime = 'CHANGING';
        reason = Math.abs(shiftZ) > 2.5 ? `recent share moved ${shiftZ.toFixed(1)} sigma` : `CUSUM ${cusum.toFixed(1)} > ${CUSUM_LIMIT}`;
    } else if (u.p !== null && u.p < 0.001) {
        regime = 'UNUSUAL';
        reason = `digit distribution far from uniform (p=${u.p.toExponential(1)})`;
    }
    return { regime, shiftZ, cusum, uniformityP: u.p, n, reason };
}

export type EntryStats = {
    method: EntryMethod;
    trades: number;
    wins: number;
    rate: number | null;
    ci: { lo: number; hi: number } | null;
    /** The contract's chance of winning on a fair digit (OVER 2 = 0.7). */
    baseline: number;
    /** Win rate minus baseline, percentage points. */
    edgePts: number | null;
    /** Exact one-sided probability of this many wins or more if the true rate were the baseline. */
    pValue: number | null;
    /** Share of the last 100 settled trades won, to show recent form. */
    recentRate: number | null;
    enough: boolean;
};

export function entryStats(digits: readonly number[], contract: Contract, method: 'SETUP' | 'ANY', duration: number): EntryStats {
    const { trades } = simulate(ticksFromDigits(digits), contract, { method }, duration);
    const t = tally(trades);
    const baseline = winProbability(contract);
    const recent = trades.slice(-100);
    return {
        method,
        trades: t.trades,
        wins: t.wins,
        rate: t.rate,
        ci: t.trades ? wilson(t.wins, t.trades) : null,
        baseline,
        edgePts: t.rate === null ? null : (t.rate - baseline) * 100,
        pValue: t.trades ? binomialUpperP(t.wins, t.trades, baseline) : null,
        recentRate: recent.length ? recent.filter(x => x.won).length / recent.length : null,
        enough: t.trades >= MIN_TRADES,
    };
}

export type DirectionId = 'OVER_2' | 'UNDER_7';
export const DIRECTIONS: ReadonlyArray<{ id: DirectionId; label: string; contract: Contract }> = [
    { id: 'OVER_2', label: 'OVER 2', contract: OVER_2 },
    { id: 'UNDER_7', label: 'UNDER 7', contract: UNDER_7 },
];

export type DirectionReport = {
    id: DirectionId;
    label: string;
    contract: Contract;
    regime: RegimeReport;
    rolling: Array<{ window: number; n: number; rate: number | null }>;
    setup: EntryStats;
    any: EntryStats;
};

export type MarketReport = {
    market: string;
    ticks: number;
    counts: number[];
    uniformity: ReturnType<typeof uniformity>;
    directions: DirectionReport[];
};

export const ROLLING_WINDOWS = [100, 300, 1000] as const;

export function analyseMarket(market: string, digits: readonly number[], duration: number): MarketReport {
    return {
        market,
        ticks: digits.length,
        counts: digitCounts(digits),
        uniformity: uniformity(digits),
        directions: DIRECTIONS.map(d => ({
            id: d.id,
            label: d.label,
            contract: d.contract,
            regime: classifyRegime(digits, d.contract),
            rolling: ROLLING_WINDOWS.map(window => ({ window, ...rollingShare(digits, d.contract, window) })),
            setup: entryStats(digits, d.contract, 'SETUP', duration),
            any: entryStats(digits, d.contract, 'ANY', duration),
        })),
    };
}

export type Row = {
    market: string;
    direction: DirectionId;
    label: string;
    method: 'SETUP' | 'ANY';
    stats: EntryStats;
    regime: Regime;
    /** Benjamini-Hochberg adjusted p across every market x direction x method tested in this scan. */
    q: number | null;
    /** Beats chance after false-discovery control, with enough trades. */
    significant: boolean;
};

/** Every market x direction x entry method as one table, with false-discovery control across the whole scan. */
export function scanRows(series: Record<string, readonly number[]>, duration: number): { reports: MarketReport[]; rows: Row[] } {
    const reports = Object.keys(series).map(m => analyseMarket(m, series[m], duration));
    const rows: Row[] = [];
    for (const r of reports)
        for (const d of r.directions)
            for (const method of ['SETUP', 'ANY'] as const) {
                const stats = method === 'SETUP' ? d.setup : d.any;
                rows.push({ market: r.market, direction: d.id, label: d.label, method, stats, regime: d.regime.regime, q: null, significant: false });
            }
    const q = bhAdjust(rows.map(r => (r.stats.enough ? r.stats.pValue : null)));
    rows.forEach((r, i) => {
        r.q = q[i];
        r.significant = r.stats.enough && q[i] !== null && (q[i] as number) <= FDR_Q && (r.stats.edgePts ?? 0) > 0;
    });
    return { reports, rows };
}

/** Conservative ranking value: the lower bound of the win-rate interval minus the baseline. Small samples rank low. */
export const conservativeEdgePts = (s: EntryStats): number | null => (s.ci ? (s.ci.lo - s.baseline) * 100 : null);

export const normalTwoSided = (z: number): number => 2 * (1 - normalCdf(Math.abs(z)));
