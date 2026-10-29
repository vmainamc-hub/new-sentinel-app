// Sixfold Meter: a read on the market's recent wins and losses, to answer "is this a good moment to press Run?".
//
// For every market and every contract Sixfold trades, each past tick is scored as if a contract had been bought on it
// (win or loss). From that win/loss strip the meter reads the regime the market is in:
//   COLD     a loss cluster: the last 30 ticks well under the normal win rate, or 4+ losses in a row right now
//   TURNING  just out of a loss cluster: 3+ losses in a row, then wins have started
//   HOT      a win cluster: the last 30 ticks well over the normal win rate
//   NORMAL   nothing unusual
// The verdict (GO / WAIT / AVOID) is read from how many cells are in which regime. Whether the regimes carry any
// information about the NEXT result is a separate question, answered by `meterTrackRecord`, which replays the history
// tick by tick and counts what happened after each state. The meter is only as useful as that record says.
import { type Contract, contractKey, contractLabel, winningDigits, winProbability } from './bot';
import { bhAdjust, chiSquareSf, normalCdf } from './stats';

export type RegimeState = 'COLD' | 'NORMAL' | 'HOT' | 'TURNING';
export type Verdict = 'GO' | 'WAIT' | 'AVOID' | 'LOADING';

export const REGIME_WINDOW = 30;
export const STRIP_LENGTH = 24;
export const MIN_REGIME_TICKS = 60;
const HISTORY = 1000;
const BLOCK = 20;

export function classify(z: number, lossRun: number, winRun: number, lossesBeforeWins: number): RegimeState {
    if (lossRun >= 4 || z <= -1.5) return 'COLD';
    if (winRun >= 1 && winRun <= 6 && lossesBeforeWins >= 3) return 'TURNING';
    if (z >= 1) return 'HOT';
    return 'NORMAL';
}

export function strengthOf(z: number, lossRun: number, state: RegimeState): number {
    const raw = 50 + 12 * z - 6 * Math.max(0, lossRun - 1) + (state === 'TURNING' ? 8 : 0);
    return Math.round(Math.min(100, Math.max(0, raw)));
}

export type RegimeCell = {
    symbol: string;
    key: string;
    label: string;
    state: RegimeState;
    /** 0-100. 50 is a normal stretch; higher means the last 30 ticks won more than normal. */
    strength: number;
    z: number;
    /** Win rate over the last 30 ticks. */
    rate: number;
    lossRun: number;
    winRun: number;
    /** Oldest first, true = would have won. */
    strip: boolean[];
    /** The digits behind the strip, oldest first. */
    digits: number[];
    /** p-value that wins and losses arrive in clusters (dispersion test over blocks of 20 ticks); null with too little history. */
    clusterP: number | null;
    /** The same p after correcting for every cell tested. */
    clusterQ: number | null;
};

const zOf = (wins: number, n: number, p: number) => (wins - n * p) / Math.sqrt(n * p * (1 - p));

/** Wins and losses of one contract on one market, newest last. */
export function outcomesOf(digits: readonly number[], contract: Contract, limit = HISTORY): boolean[] {
    const win = new Set(winningDigits(contract));
    return digits.slice(-limit).map(d => win.has(d));
}

function clusterPValue(o: readonly boolean[], p: number): number | null {
    const blocks = Math.floor(o.length / BLOCK);
    if (blocks < 10) return null;
    let stat = 0;
    const start = o.length - blocks * BLOCK;
    for (let b = 0; b < blocks; b++) {
        let w = 0;
        for (let i = 0; i < BLOCK; i++) if (o[start + b * BLOCK + i]) w += 1;
        stat += Math.pow(w - BLOCK * p, 2);
    }
    // p is known (not fitted), so the statistic has one degree of freedom per block.
    return chiSquareSf(stat / (BLOCK * p * (1 - p)), blocks);
}

export function regimeCell(symbol: string, digits: readonly number[], contract: Contract): RegimeCell | null {
    if (digits.length < MIN_REGIME_TICKS) return null;
    const o = outcomesOf(digits, contract);
    const p = winProbability(contract);
    const tail = o.slice(-REGIME_WINDOW);
    const wins = tail.filter(Boolean).length;
    let lossRun = 0;
    let winRun = 0;
    for (let i = o.length - 1; i >= 0; i--) {
        if (!o[i] && winRun === 0) lossRun += 1;
        else if (o[i] && lossRun === 0) winRun += 1;
        else break;
    }
    let before = 0;
    if (winRun > 0) for (let i = o.length - 1 - winRun; i >= 0 && !o[i]; i--) before += 1;
    const z = zOf(wins, tail.length, p);
    const state = classify(z, lossRun, winRun, before);
    return {
        symbol,
        key: contractKey(contract),
        label: contractLabel(contract),
        state,
        strength: strengthOf(z, lossRun, state),
        z,
        rate: wins / tail.length,
        lossRun,
        winRun,
        strip: o.slice(-STRIP_LENGTH),
        digits: digits.slice(-STRIP_LENGTH),
        clusterP: clusterPValue(o, p),
        clusterQ: null,
    };
}

export type RegimeSummary = {
    at: number;
    cells: RegimeCell[];
    verdict: Verdict;
    /** Mean strength of all cells, 0-100. */
    meter: number;
    counts: Record<RegimeState, number>;
    total: number;
    reason: string;
    /** Cells where wins and losses cluster more than chance allows, after correcting for the number tested. */
    clustered: number;
};

export function summarize(cells: RegimeCell[], at: number): RegimeSummary {
    const counts: Record<RegimeState, number> = { COLD: 0, NORMAL: 0, HOT: 0, TURNING: 0 };
    cells.forEach(c => (counts[c.state] += 1));
    const q = bhAdjust(cells.map(c => c.clusterP));
    const withQ = cells.map((c, i) => ({ ...c, clusterQ: q[i] }));
    const total = cells.length;
    if (!total) {
        return { at, cells: withQ, verdict: 'LOADING', meter: 0, counts, total, reason: 'Waiting for enough ticks on the markets.', clustered: 0 };
    }
    const meter = Math.round(withQ.reduce((a, c) => a + c.strength, 0) / total);
    const coldShare = counts.COLD / total;
    let verdict: Verdict = 'WAIT';
    if (coldShare >= 0.4 || meter < 44) verdict = 'AVOID';
    else if (meter >= 50 && coldShare <= 0.25) verdict = 'GO';
    const clustered = withQ.filter(c => c.clusterQ !== null && c.clusterQ <= 0.1).length;
    const bits = [`${counts.COLD} of ${total} in a loss cluster`, `${counts.HOT + counts.TURNING} hot or turning`, `meter ${meter}`];
    const lead =
        verdict === 'GO'
            ? 'Few markets are cold and the recent results are at or above normal.'
            : verdict === 'AVOID'
              ? 'Many markets are in a loss cluster right now.'
              : 'Mixed: not clearly good, not clearly bad.';
    return { at, cells: withQ, verdict, meter, counts, total, reason: `${lead} ${bits.join(', ')}.`, clustered };
}

/** Meter reading for the given markets and contracts, from their latest ticks. */
export function computeRegime(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    contracts: readonly Contract[],
    at: number
): RegimeSummary {
    const cells: RegimeCell[] = [];
    for (const symbol of symbols) {
        for (const contract of contracts) {
            const c = regimeCell(symbol, series[symbol] ?? [], contract);
            if (c) cells.push(c);
        }
    }
    return summarize(cells, at);
}

const cellCache = new Map<string, WeakMap<readonly number[], RegimeCell | null>>();

/**
 * Like `computeRegime`, but for published (immutable) series snapshots: a market's cell is recomputed only when that
 * market's own array changed, so each market updates exactly when its own ticks arrive and never because another did.
 * Do not use with arrays that are mutated in place.
 */
export function computeRegimeFromSnapshot(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    contracts: readonly Contract[],
    at: number
): RegimeSummary {
    const cells: RegimeCell[] = [];
    for (const symbol of symbols) {
        const digits = series[symbol];
        if (!digits) continue;
        for (const contract of contracts) {
            const k = `${symbol}|${contractKey(contract)}`;
            let byArray = cellCache.get(k);
            if (!byArray) cellCache.set(k, (byArray = new WeakMap()));
            let cell = byArray.get(digits);
            if (cell === undefined) {
                cell = regimeCell(symbol, digits, contract);
                byArray.set(digits, cell);
            }
            if (cell) cells.push(cell);
        }
    }
    return summarize(cells, at);
}

// ---------- does the meter tell you anything about the next result? ----------

export type StateRecord = { n: number; wins: number; rate: number | null };
export type TrackRecord = {
    ticks: number;
    states: Record<RegimeState, StateRecord>;
    /** Win rate after any non-cold state vs after COLD, in points, with a two-sided p-value. */
    restVsCold: { diffPts: number | null; p: number | null };
    /** True only when non-cold states did clearly better than cold ones. */
    informative: boolean;
};

const record = (n: number, wins: number): StateRecord => ({ n, wins, rate: n ? wins / n : null });

/**
 * Replays every market's history tick by tick. At each tick the state is read from the results up to that tick, and
 * the result of the next trade (`duration` ticks later) is counted under that state. Each result is counted once, so the
 * numbers are plain win rates with honest sample sizes.
 */
export function meterTrackRecord(
    series: Record<string, readonly number[]>,
    symbols: readonly string[],
    contracts: readonly Contract[],
    duration = 1
): TrackRecord {
    const len = Math.max(1, Math.min(10, Math.trunc(duration) || 1));
    const acc: Record<RegimeState, [number, number]> = { COLD: [0, 0], NORMAL: [0, 0], HOT: [0, 0], TURNING: [0, 0] };
    let ticks = 0;
    for (const symbol of symbols) {
        const digits = series[symbol] ?? [];
        if (digits.length < MIN_REGIME_TICKS + len + 10) continue;
        for (const contract of contracts) {
            const o = outcomesOf(digits, contract, 5000);
            const p = winProbability(contract);
            const pre = [0];
            o.forEach(w => pre.push(pre[pre.length - 1] + (w ? 1 : 0)));
            let lossRun = 0;
            let winRun = 0;
            let before = 0;
            for (let i = 0; i + len < o.length; i++) {
                if (o[i]) {
                    if (winRun === 0) before = lossRun;
                    winRun += 1;
                    lossRun = 0;
                } else {
                    lossRun += 1;
                    winRun = 0;
                }
                if (i + 1 < MIN_REGIME_TICKS) continue;
                const w = pre[i + 1] - pre[i + 1 - REGIME_WINDOW];
                const state = classify(zOf(w, REGIME_WINDOW, p), lossRun, winRun, winRun > 0 ? before : 0);
                acc[state][0] += 1;
                acc[state][1] += o[i + len] ? 1 : 0;
                ticks += 1;
            }
        }
    }
    const states = {
        COLD: record(...acc.COLD),
        NORMAL: record(...acc.NORMAL),
        HOT: record(...acc.HOT),
        TURNING: record(...acc.TURNING),
    };
    const restN = acc.NORMAL[0] + acc.HOT[0] + acc.TURNING[0];
    const restW = acc.NORMAL[1] + acc.HOT[1] + acc.TURNING[1];
    const [coldN, coldW] = acc.COLD;
    let diffPts: number | null = null;
    let p: number | null = null;
    if (restN >= 30 && coldN >= 30) {
        const r1 = restW / restN;
        const r0 = coldW / coldN;
        const pool = (restW + coldW) / (restN + coldN);
        const se = Math.sqrt(pool * (1 - pool) * (1 / restN + 1 / coldN));
        diffPts = (r1 - r0) * 100;
        p = se > 0 ? 2 * (1 - normalCdf(Math.abs((r1 - r0) / se))) : 1;
    }
    return { ticks, states, restVsCold: { diffPts, p }, informative: diffPts !== null && p !== null && diffPts > 0 && p < 0.05 };
}
