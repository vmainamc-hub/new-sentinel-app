// The High Tick + Low Tick hedge: what a pair of opposite trades really does, worked out from the contract's rules.
//
// The contract: you pick one of the 5 ticks. High Tick wins if that tick is the highest of the five, Low Tick if it is the lowest.
//
// What the maths says (and what the panel shows, so the money decision is made with the real numbers):
//  - The two trades of a pair can never both win on the SAME tick (one tick cannot be both the highest and the lowest). On the
//    same tick the pair wins exactly once, or loses both. It is NOT "one always wins".
//  - Which tick you pick matters. For a price that moves up or down independently each tick, the highest (or lowest) of 5 ticks
//    sits at the first or last tick far more often than in the middle: 70/256 = 27.3% at ticks 1 and 5, 40/256 = 15.6% at ticks
//    2 and 4, 36/256 = 14.1% at tick 3 (Sparre Andersen's theorem for random walks). Chance alone, a fair payout is 1 / p.
//  - Whatever the pairing, the expected result of a pair is the sum of its two trades: p(High) x payout - stake plus
//    p(Low) x payout - stake. Pairing changes how often you win and how big the swings are, never the average. Deriv's payout for
//    each tick is what turns the average positive or negative, so the quotes (live, from Deriv) decide it.
// Pure logic, no React, no network.

/** P(tick k is the highest) = P(tick k is the lowest) for k = 1..5, as (70, 40, 36, 40, 70) / 256. */
export const PICK_ODDS: readonly number[] = [70 / 256, 40 / 256, 36 / 256, 40 / 256, 70 / 256];

/** P(the highest tick is row a AND the lowest tick is column b). From a 20-million-run simulation; symmetric, zero on the diagonal. */
const JOINT: readonly (readonly number[])[] = [
    [0, 0.0218, 0.052, 0.0747, 0.1251],
    [0.0218, 0, 0.0183, 0.0415, 0.0747],
    [0.052, 0.0183, 0, 0.0183, 0.052],
    [0.0747, 0.0415, 0.0183, 0, 0.0218],
    [0.1251, 0.0747, 0.052, 0.0218, 0],
];

const r2 = (x: number) => Math.round(x * 100) / 100;
const inRange = (pick: number) => Number.isInteger(pick) && pick >= 1 && pick <= 5;

export type HedgeInput = {
    stake: number;
    /** Tick picked for the High Tick trade, and for the Low Tick trade (1 to 5). */
    highPick: number;
    lowPick: number;
    /** What Deriv quotes as the total payout of each trade (stake included). */
    highPayout: number;
    lowPayout: number;
};

export type HedgeStats = {
    cost: number;
    /** Probabilities (model: independent, symmetric tick moves). */
    pHighWins: number;
    pLowWins: number;
    pBothWin: number;
    pExactlyOne: number;
    pNeither: number;
    /** Money result of each outcome. */
    netHighOnly: number;
    netLowOnly: number;
    netBoth: number;
    netNeither: number;
    /** Average result per entry and per 1 staked, at these quotes. */
    expected: number;
    expectedPerStake: number;
    /** Does one winning trade pay back both stakes? */
    oneWinCoversBoth: boolean;
    /** Smallest total payout per trade at which each side breaks even on average. */
    breakEvenHigh: number;
    breakEvenLow: number;
    note: string;
};

/** The whole picture of one High + Low pair. Null when a pick is out of range or a quote is missing. */
export const hedgeStats = (input: HedgeInput): HedgeStats | null => {
    const { stake, highPick, lowPick, highPayout, lowPayout } = input;
    if (!inRange(highPick) || !inRange(lowPick) || !(stake > 0) || !Number.isFinite(highPayout) || !Number.isFinite(lowPayout)) return null;
    const pHigh = PICK_ODDS[highPick - 1];
    const pLow = PICK_ODDS[lowPick - 1];
    const pBoth = JOINT[highPick - 1][lowPick - 1];
    const pExactlyOne = pHigh + pLow - 2 * pBoth;
    const pNeither = 1 - pHigh - pLow + pBoth;
    const cost = 2 * stake;
    const expected = pHigh * highPayout + pLow * lowPayout - cost;
    const oneWinCoversBoth = Math.min(highPayout, lowPayout) > cost;
    const sameTick = highPick === lowPick;
    return {
        cost: r2(cost),
        pHighWins: pHigh, pLowWins: pLow, pBothWin: pBoth, pExactlyOne, pNeither,
        netHighOnly: r2(highPayout - cost), netLowOnly: r2(lowPayout - cost), netBoth: r2(highPayout + lowPayout - cost), netNeither: r2(-cost),
        expected: r2(expected), expectedPerStake: Math.round((expected / cost) * 1000) / 1000,
        oneWinCoversBoth,
        breakEvenHigh: r2(stake / pHigh), breakEvenLow: r2(stake / pLow),
        note: sameTick
            ? `On the same tick the two trades cannot both win. About ${Math.round(pExactlyOne * 100)}% of pairs win once, and ${Math.round(pNeither * 100)}% lose both stakes.`
            : `The picks can both win (${(pBoth * 100).toFixed(1)}% of pairs), win once (${Math.round(pExactlyOne * 100)}%), or lose both stakes (${Math.round(pNeither * 100)}%).`,
    };
};

export type PickRow = {
    pick: number;
    highPayout: number | null;
    lowPayout: number | null;
    /** Model chance and the chance seen in recent ticks (null when there are too few). */
    modelOdds: number;
    recentOdds: number | null;
    /** Average result per 1 staked for a High / Low trade on this tick, using the model chance. */
    highEdge: number | null;
    lowEdge: number | null;
};

/** One row per tick: the payout Deriv quotes and what the model chance makes of it (per 1 staked, stake included in the payout). */
export const pickTable = (stake: number, quotes: ReadonlyArray<{ high: number | null; low: number | null }>, recent?: { high: number[]; low: number[]; windows: number } | null): PickRow[] =>
    [1, 2, 3, 4, 5].map(pick => {
        const q = quotes[pick - 1];
        const high = q?.high ?? null;
        const low = q?.low ?? null;
        const p = PICK_ODDS[pick - 1];
        return {
            pick, highPayout: high, lowPayout: low, modelOdds: p,
            recentOdds: recent && recent.windows >= 100 ? (recent.high[pick - 1] + recent.low[pick - 1]) / 2 : null,
            highEdge: high !== null && stake > 0 ? Math.round((p * high / stake - 1) * 1000) / 1000 : null,
            lowEdge: low !== null && stake > 0 ? Math.round((p * low / stake - 1) * 1000) / 1000 : null,
        };
    });

/**
 * How often each of the 5 ticks was the strict highest / lowest in the last `maxWindows` stretches of 5 ticks of this market.
 * Overlapping stretches, so it describes the past without being independent samples. Ties are not wins.
 */
export const recentPickOdds = (prices: readonly number[], maxWindows = 600): { high: number[]; low: number[]; windows: number } => {
    const high = [0, 0, 0, 0, 0];
    const low = [0, 0, 0, 0, 0];
    const start = Math.max(0, prices.length - 5 - Math.max(1, maxWindows) + 1);
    let windows = 0;
    for (let i = start; i + 5 <= prices.length; i += 1) {
        const span = prices.slice(i, i + 5);
        windows += 1;
        const top = Math.max(...span);
        const bottom = Math.min(...span);
        if (span.filter(x => x === top).length === 1) high[span.indexOf(top)] += 1;
        if (span.filter(x => x === bottom).length === 1) low[span.indexOf(bottom)] += 1;
    }
    return windows ? { high: high.map(n => n / windows), low: low.map(n => n / windows), windows } : { high, low, windows: 0 };
};
