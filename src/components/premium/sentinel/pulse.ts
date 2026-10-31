// SENTINEL AI: the Pulse engine. One small, readable signal source that replaces the old Sentinel engine and Insight Fusion.
//
// It reads the ticks the app already streams (the Sixfold feed) and, for each market and each of the six contracts (Over 1/2/3 and
// Under 8/7/6), asks one plain question: has the contract been winning MORE than its fair share lately, and in how many time
// windows? It looks at the last 1000, 300, 100 and 30 ticks. The more windows agree, and the fewer losing digits among the last 10,
// the stronger the signal:
//
//   strong  all four windows above fair, and the two latest comfortably so
//   steady  at least three windows above fair, including the latest
//   watch   at least two windows above fair, including the latest
//
// A market with enough ticks always gets its best read, so signals arrive steadily instead of waiting for a rare coincidence.
// Honest limits: Deriv digits are generated randomly. A contract that has been winning is not more likely to win next, and every
// contract pays less than its fair odds, so Pulse decides WHEN to trade and can never create an edge.
import { type Contract, winProbability } from '../sixfold/bot';

export type PulseTier = 'strong' | 'steady' | 'watch';
export const PULSE_WINDOWS = [1000, 300, 100, 30] as const;
export const PULSE_MIN_TICKS = 300;
/** The latest two windows must beat the fair rate by this much for a `strong` read. */
export const STRONG_MARGIN = 0.03;

/** The six contracts Pulse reads. */
export const PULSE_CONTRACTS: readonly Contract[] = [
    { side: 'OVER', param: 1 },
    { side: 'OVER', param: 2 },
    { side: 'OVER', param: 3 },
    { side: 'UNDER', param: 8 },
    { side: 'UNDER', param: 7 },
    { side: 'UNDER', param: 6 },
];

export type PulseRead = {
    symbol: string;
    contract: Contract;
    /** Win rate in each of PULSE_WINDOWS (null when there are not enough ticks for it). */
    rates: Array<number | null>;
    fair: number;
    /** Windows (of those with data) whose rate is above fair. */
    agree: number;
    /** Losing digits among the last 10 ticks. */
    recentLosses: number;
    tier: PulseTier | null;
    /** 0-100: how far above fair the windows sit, in standard errors. */
    score: number;
};

const wins = (digits: readonly number[], c: Contract): number => {
    let n = 0;
    for (const d of digits) if (c.side === 'OVER' ? d > c.param : d < c.param) n += 1;
    return n;
};

export const readContract = (symbol: string, series: readonly number[], c: Contract): PulseRead => {
    const fair = winProbability(c);
    // Each window uses its own length; the 1000 window uses everything we have once at least 300 ticks exist.
    const sample = PULSE_WINDOWS.map(w => {
        const n = Math.min(w, series.length);
        return n >= Math.min(w, PULSE_MIN_TICKS) ? { n, rate: wins(series.slice(-n), c) / n } : null;
    });
    const rates = sample.map(x => (x ? x.rate : null));
    const used = sample.filter((x): x is { n: number; rate: number } => x !== null).map(x => ({ r: x.rate, n: x.n }));
    const agreeFlags = rates.map(r => (r === null ? false : r > fair));
    const agree = agreeFlags.filter(Boolean).length;
    const last10 = series.slice(-10);
    const recentLosses = last10.length - wins(last10, c);
    const expectedLosses = Math.round(10 * (1 - fair));

    const [, r300, r100, r30] = rates;
    let tier: PulseTier | null = null;
    if (r30 !== null && r100 !== null && r300 !== null) {
        if (agree >= 4 && r30 >= fair + STRONG_MARGIN && r100 >= fair + STRONG_MARGIN) tier = 'strong';
        else if (agree >= 3 && r30 > fair && r100 > fair) tier = 'steady';
        else if (agree >= 2 && r30 > fair) tier = 'watch';
    }
    // A market that has just printed an unusual run of losses is stepped down one tier (or dropped from watch).
    if (tier && recentLosses > expectedLosses + 2)
        tier = tier === 'strong' ? 'steady' : tier === 'steady' ? 'watch' : null;

    const z = used.map(({ r, n }) => (r - fair) / Math.sqrt((fair * (1 - fair)) / n));
    const meanZ = z.length ? z.reduce((a, b) => a + b, 0) / z.length : 0;
    const score = Math.round(Math.max(0, Math.min(100, 50 + 12 * meanZ)) * 10) / 10;
    return { symbol, contract: c, rates, fair, agree, recentLosses, tier, score };
};

export type PulseSnapshot = {
    /** Markets with enough ticks to be read. */
    markets: number;
    /** Contracts read (markets x contracts). */
    reads: PulseRead[];
};

/** Reads every market that has enough ticks, for the contracts asked for. */
export const readPulse = (
    series: Readonly<Record<string, readonly number[]>>,
    symbols: readonly string[],
    contracts: readonly Contract[] = PULSE_CONTRACTS
): PulseSnapshot => {
    const reads: PulseRead[] = [];
    let markets = 0;
    for (const symbol of symbols) {
        const s = series[symbol] ?? [];
        if (s.length < PULSE_MIN_TICKS) continue;
        markets += 1;
        for (const c of contracts) reads.push(readContract(symbol, s, c));
    }
    return { markets, reads };
};
