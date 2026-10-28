// The DTrader's strategy engine. Pure logic: no React, no network. The Auto button asks a strategy, once per candidate entry,
// "trade now, and on which side / digit / barrier?" and the strategy answers with a decision or null (wait).
//
// A word on what strategies can and cannot do. Last digits and tick-to-tick price moves on Deriv's synthetic indices are random
// by design, and every payout already carries the house margin. A strategy decides WHEN to trade and WHAT to trade, and a good one
// keeps you out of the market when its own conditions are not met. It cannot create an edge that is not in the data. That is why
// every strategy here can be scored on the recent past (`backtest`) before it risks money, and why the scoring reports the hit
// rate next to the hit rate chance alone would give.

import { digitWins, FAMILIES, type Family, type SideIndex } from './dtrader-engine';

export type StrategyParams = Record<string, number>;
export type ParamDef = { key: string; label: string; min: number; max: number; step: number; default: number; hint: string };

export type StrategyContext = {
    family: Family;
    /** Last digits, oldest first. */
    digits: readonly number[];
    /** Prices, oldest first (same length and order as `digits`). */
    prices: readonly number[];
    /** The digit set in the panel (Over/Under, Matches/Differs). */
    prediction: number;
    /** The barrier distance set in the panel (Higher/Lower, Ends Between/Outside). */
    offset: number;
    /** Contract length in ticks. */
    ticks: number;
    decimals: number;
    params: StrategyParams;
};

export type Decision = {
    side: SideIndex | 'both';
    /** Replaces the panel's digit when the strategy chose its own. */
    prediction?: number;
    /** Replaces the panel's barrier distance when the strategy sized its own. */
    offset?: number;
    /** One line for the journal. */
    reason: string;
};

export type Strategy = {
    id: string;
    title: string;
    families: Family[];
    summary: string;
    params: ParamDef[];
    decide: (ctx: StrategyContext) => Decision | null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------------------------------------------------

/** How many standard deviations the observed hits are above what chance (probability p) gives over n tries. */
export const zScore = (hits: number, n: number, p: number): number => {
    const sd = Math.sqrt(n * p * (1 - p));
    return sd > 0 ? (hits - n * p) / sd : 0;
};

export const stdev = (values: readonly number[]): number => {
    if (values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1));
};

const changes = (prices: readonly number[], window: number): number[] => {
    const slice = prices.slice(-(window + 1));
    const out: number[] = [];
    for (let i = 1; i < slice.length; i += 1) out.push(slice[i] - slice[i - 1]);
    return out;
};

/** Per-tick price movement (standard deviation of tick-to-tick changes) over the last `window` ticks. */
export const tickSigma = (prices: readonly number[], window: number): number => stdev(changes(prices, window));

export const ema = (values: readonly number[], period: number): number => {
    if (!values.length) return 0;
    const k = 2 / (Math.max(1, period) + 1);
    return values.slice(1).reduce((acc, v) => v * k + acc * (1 - k), values[0]);
};

export const rsi = (prices: readonly number[], period: number): number | null => {
    const diffs = changes(prices, period * 3);
    if (diffs.length < period) return null;
    let gain = 0;
    let loss = 0;
    diffs.slice(0, period).forEach(d => { if (d > 0) gain += d; else loss -= d; });
    gain /= period; loss /= period;
    diffs.slice(period).forEach(d => {
        gain = (gain * (period - 1) + Math.max(0, d)) / period;
        loss = (loss * (period - 1) + Math.max(0, -d)) / period;
    });
    return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
};

/** Barrier distance that covers about `k` standard deviations of the price move over `ticks`, rounded to the price step. */
export const sigmaOffset = (prices: readonly number[], ticks: number, k: number, decimals: number, window = 200): number => {
    const step = 10 ** -Math.max(0, decimals);
    const raw = k * tickSigma(prices, window) * Math.sqrt(Math.max(1, ticks));
    return Math.max(step, Math.round(raw / step) * step);
};

// ---------------------------------------------------------------------------------------------------------------------
// Digit strategies
// ---------------------------------------------------------------------------------------------------------------------

type Bet = { side: SideIndex; prediction: number; p: number; label: string };

/** Every bet the digit families allow, with the probability that chance alone makes it win. */
const digitBets = (family: Family, prediction: number, lock: boolean): Bet[] => {
    const def = FAMILIES[family];
    const make = (side: SideIndex, digit: number, p: number): Bet => ({ side, prediction: digit, p, label: def.needsDigit ? `${def.sides[side]} ${digit}` : def.sides[side] });
    if (family === 'evenodd') return [make(0, 0, 0.5), make(1, 0, 0.5)];
    if (family === 'matchesdiffers') {
        const digits = lock ? [prediction] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
        return digits.flatMap(d => [make(0, d, 0.1), make(1, d, 0.9)]);
    }
    if (family === 'overunder') {
        const digits = lock ? [prediction] : [1, 2, 3, 4, 5, 6, 7, 8];
        return digits.flatMap(d => [
            ...(d <= 8 ? [make(0, d, (9 - d) / 10)] : []),
            ...(d >= 1 ? [make(1, d, d / 10)] : []),
        ]);
    }
    return [];
};

const hitCount = (family: Family, bet: Bet, sample: readonly number[]) => sample.reduce((n, d) => n + (digitWins(family, bet.side, bet.prediction, d) ? 1 : 0), 0);

/** The bet whose results in `sample` beat chance by the most standard deviations (needs at least minZ of them). */
const bestBet = (family: Family, bets: Bet[], sample: readonly number[], minZ: number): { bet: Bet; z: number; rate: number } | null => {
    let best: { bet: Bet; z: number; rate: number } | null = null;
    for (const bet of bets) {
        const hits = hitCount(family, bet, sample);
        const z = zScore(hits, sample.length, bet.p);
        if (z >= minZ && (best === null || z > best.z)) best = { bet, z, rate: hits / sample.length };
    }
    return best;
};

const DIGIT_FAMILIES: Family[] = ['overunder', 'matchesdiffers', 'evenodd'];
const PRICE_FAMILIES: Family[] = ['risefall', 'highlow'];

const decisionFor = (bet: Bet, ctx: StrategyContext, reason: string): Decision => ({
    side: bet.side, reason,
    ...(FAMILIES[ctx.family].needsDigit && bet.prediction !== ctx.prediction ? { prediction: bet.prediction } : {}),
});

const recentStats: Strategy = {
    id: 'recent-stats',
    title: 'Recent hit rate (always trades)',
    families: DIGIT_FAMILIES,
    summary: 'Takes the side that has won more often over the recent window. It describes the past; it does not predict the next tick.',
    params: [{ key: 'window', label: 'Window (ticks)', min: 20, max: 1000, step: 10, default: 200, hint: 'How many recent ticks decide the side.' }],
    decide: ctx => {
        const bets = digitBets(ctx.family, ctx.prediction, true);
        const sample = ctx.digits.slice(-Math.max(1, ctx.params.window));
        if (!sample.length || bets.length < 2) return { side: 0, reason: 'Recent hit rate: not enough ticks yet, defaulting to the first side.' };
        const rates = [0, 1].map(side => {
            const bet = bets.find(b => b.side === side);
            return bet ? hitCount(ctx.family, bet, sample) / sample.length : 0;
        });
        const side: SideIndex = rates[1] > rates[0] ? 1 : 0;
        return { side, reason: `Recent hit rate over ${sample.length} ticks: ${FAMILIES[ctx.family].sides[0]} ${pct(rates[0])}, ${FAMILIES[ctx.family].sides[1]} ${pct(rates[1])}.` };
    },
};

const edgeScanner: Strategy = {
    id: 'edge-scanner',
    title: 'Edge scanner',
    families: DIGIT_FAMILIES,
    summary: 'Trades only when one bet has beaten chance over the window by a set number of standard deviations. Waits otherwise.',
    params: [
        { key: 'window', label: 'Window (ticks)', min: 50, max: 1000, step: 10, default: 300, hint: 'Ticks the scan looks back over.' },
        { key: 'minZ', label: 'Required strength (σ)', min: 0.5, max: 5, step: 0.1, default: 2.5, hint: 'Higher means fewer, stronger signals. 2.5 means roughly a 1-in-160 fluke if the data were pure chance.' },
        { key: 'lock', label: 'Keep my digit (1 = yes)', min: 0, max: 1, step: 1, default: 1, hint: 'With 0 the scan may also move the digit of Over/Under and Matches/Differs, which changes the payout.' },
    ],
    decide: ctx => {
        const sample = ctx.digits.slice(-Math.max(20, ctx.params.window));
        const found = bestBet(ctx.family, digitBets(ctx.family, ctx.prediction, ctx.params.lock >= 1), sample, ctx.params.minZ);
        if (!found) return null;
        return decisionFor(found.bet, ctx, `Edge scanner: ${found.bet.label} won ${pct(found.rate)} of the last ${sample.length} ticks against ${pct(found.bet.p)} by chance (${found.z.toFixed(1)}σ).`);
    },
};

const markov: Strategy = {
    id: 'sequence-model',
    title: 'Sequence model',
    families: DIGIT_FAMILIES,
    summary: 'Looks at what followed the same last digits earlier in the history and trades only when that follow-up beats chance with enough samples.',
    params: [
        { key: 'order', label: 'Digits in the pattern', min: 1, max: 3, step: 1, default: 1, hint: '1 = the last digit, 2 = the last two digits ...' },
        { key: 'window', label: 'History (ticks)', min: 200, max: 1000, step: 50, default: 1000, hint: 'How far back to search for the same pattern.' },
        { key: 'minSamples', label: 'Minimum matches', min: 10, max: 200, step: 5, default: 40, hint: 'The pattern must have occurred at least this many times.' },
        { key: 'minZ', label: 'Required strength (σ)', min: 0.5, max: 5, step: 0.1, default: 2.5, hint: 'How far above chance the follow-up must be.' },
        { key: 'lock', label: 'Keep my digit (1 = yes)', min: 0, max: 1, step: 1, default: 1, hint: 'With 0 the model may also move the digit.' },
    ],
    decide: ctx => {
        const order = clamp(Math.trunc(ctx.params.order), 1, 3);
        const history = ctx.digits.slice(-Math.max(order + 2, ctx.params.window));
        if (history.length < order + 2) return null;
        const context = history.slice(-order);
        // `followers` holds the digit that came right after each earlier occurrence of the pattern. The occurrence we are standing
        // on (the newest) has no follower yet, so it is not counted.
        const followers: number[] = [];
        for (let i = order; i < history.length; i += 1) {
            let same = true;
            for (let k = 0; k < order; k += 1) if (history[i - order + k] !== context[k]) { same = false; break; }
            if (same) followers.push(history[i]);
        }
        if (followers.length < ctx.params.minSamples) return null;
        const found = bestBet(ctx.family, digitBets(ctx.family, ctx.prediction, ctx.params.lock >= 1), followers, ctx.params.minZ);
        if (!found) return null;
        return decisionFor(found.bet, ctx, `Sequence model: after ${context.join(' ')} the next digit made ${found.bet.label} win ${pct(found.rate)} of ${followers.length} times (chance ${pct(found.bet.p)}, ${found.z.toFixed(1)}σ).`);
    },
};

const streak: Strategy = {
    id: 'streak',
    title: 'Streak fade / follow',
    families: ['overunder', 'evenodd'],
    summary: 'After a run of the same outcome, bets against it (fade) or with it (follow).',
    params: [
        { key: 'run', label: 'Run length', min: 2, max: 12, step: 1, default: 4, hint: 'Consecutive ticks with the same outcome.' },
        { key: 'follow', label: 'Follow the run (1) or fade it (0)', min: 0, max: 1, step: 1, default: 0, hint: '0 bets the run ends, 1 bets it continues. Independent digits give neither an edge.' },
    ],
    decide: ctx => {
        const run = Math.max(2, Math.trunc(ctx.params.run));
        const last = ctx.digits.slice(-run);
        if (last.length < run) return null;
        const wins = (side: SideIndex) => last.every(d => digitWins(ctx.family, side, ctx.prediction, d));
        const side: SideIndex | null = wins(0) ? 0 : wins(1) ? 1 : null;
        if (side === null) return null;
        const bet: SideIndex = ctx.params.follow >= 1 ? side : (side === 0 ? 1 : 0);
        return { side: bet, reason: `Streak: ${run} ticks in a row were ${FAMILIES[ctx.family].sides[side]}, so ${ctx.params.follow >= 1 ? 'following' : 'fading'} it with ${FAMILIES[ctx.family].sides[bet]}.` };
    },
};

const overdue: Strategy = {
    id: 'overdue-digit',
    title: 'Overdue digit',
    families: ['matchesdiffers'],
    summary: 'Bets Matches on your digit once it has not printed for a set number of ticks.',
    params: [{ key: 'gap', label: 'Ticks without the digit', min: 5, max: 200, step: 1, default: 25, hint: 'Longer gaps mean rarer signals. A digit is never "due": every tick is a fresh 1-in-10.' }],
    decide: ctx => {
        const gap = Math.max(1, Math.trunc(ctx.params.gap));
        const last = ctx.digits.slice(-gap);
        if (last.length < gap || last.includes(ctx.prediction)) return null;
        return { side: 0, reason: `Overdue digit: ${ctx.prediction} has not printed for ${gap} ticks.` };
    },
};

const lastDigitDiffers: Strategy = {
    id: 'differs-last',
    title: 'Differs from the last digit',
    families: ['matchesdiffers'],
    summary: 'Always trades Differs on the digit that just printed (the next tick repeats it only 1 time in 10).',
    params: [],
    decide: ctx => {
        const digit = ctx.digits[ctx.digits.length - 1];
        return digit === undefined ? null : { side: 1, prediction: digit, reason: `Differs from the last digit (${digit}).` };
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// Price strategies (Rise/Fall, Higher/Lower, Ends Between/Outside)
// ---------------------------------------------------------------------------------------------------------------------

/** For Higher/Lower the barrier distance may be sized from recent movement instead of the panel's fixed number. */
const sizedOffset = (ctx: StrategyContext): number | undefined => {
    if (ctx.family !== 'highlow') return undefined;
    const k = ctx.params.sigmaK ?? 0;
    return k > 0 ? Math.max(ctx.offset, sigmaOffset(ctx.prices, ctx.ticks, k, ctx.decimals)) : undefined;
};
const sizeParam: ParamDef = { key: 'sigmaK', label: 'Size barrier by movement (σ, 0 = off)', min: 0, max: 4, step: 0.1, default: 0, hint: 'Higher/Lower only. Sets the barrier distance to this many standard deviations of the expected move, never below your own distance.' };

const priceDecision = (side: SideIndex, ctx: StrategyContext, reason: string): Decision => {
    const offset = sizedOffset(ctx);
    return { side, reason, ...(offset !== undefined ? { offset } : {}) };
};

const momentum: Strategy = {
    id: 'tick-momentum',
    title: 'Tick momentum',
    families: PRICE_FAMILIES,
    summary: 'After a run of ticks moving the same way, follows it (or fades it).',
    params: [
        { key: 'run', label: 'Ticks in a row', min: 2, max: 10, step: 1, default: 3, hint: 'Consecutive ticks in the same direction.' },
        { key: 'follow', label: 'Follow (1) or fade (0)', min: 0, max: 1, step: 1, default: 1, hint: '1 bets the move continues, 0 bets it reverses.' },
        sizeParam,
    ],
    decide: ctx => {
        const run = Math.max(2, Math.trunc(ctx.params.run));
        const diffs = changes(ctx.prices, run);
        if (diffs.length < run) return null;
        const up = diffs.every(d => d > 0);
        const down = diffs.every(d => d < 0);
        if (!up && !down) return null;
        const follow = ctx.params.follow >= 1;
        const side: SideIndex = up === follow ? 0 : 1;
        return priceDecision(side, ctx, `Tick momentum: ${run} ${up ? 'rising' : 'falling'} ticks in a row, ${follow ? 'following' : 'fading'} it with ${FAMILIES[ctx.family].sides[side]}.`);
    },
};

const emaTrend: Strategy = {
    id: 'ema-trend',
    title: 'EMA trend',
    families: PRICE_FAMILIES,
    summary: 'Trades with the direction of a fast average over a slow one once they are clearly apart.',
    params: [
        { key: 'fast', label: 'Fast average (ticks)', min: 2, max: 50, step: 1, default: 5, hint: 'Short average.' },
        { key: 'slow', label: 'Slow average (ticks)', min: 5, max: 200, step: 1, default: 20, hint: 'Long average.' },
        { key: 'minSep', label: 'Minimum gap (σ)', min: 0, max: 3, step: 0.05, default: 0.3, hint: 'How far apart the averages must be, in units of typical tick movement.' },
        sizeParam,
    ],
    decide: ctx => {
        const slow = Math.max(3, Math.trunc(ctx.params.slow));
        const fast = Math.min(slow - 1, Math.max(2, Math.trunc(ctx.params.fast)));
        const window = ctx.prices.slice(-slow * 4);
        if (window.length < slow * 2) return null;
        const sigma = tickSigma(ctx.prices, 100);
        if (sigma <= 0) return null;
        const gap = (ema(window, fast) - ema(window, slow)) / sigma;
        if (Math.abs(gap) < ctx.params.minSep) return null;
        const side: SideIndex = gap > 0 ? 0 : 1;
        return priceDecision(side, ctx, `EMA trend: fast ${fast} is ${Math.abs(gap).toFixed(2)}σ ${gap > 0 ? 'above' : 'below'} slow ${slow}, so ${FAMILIES[ctx.family].sides[side]}.`);
    },
};

const rsiFade: Strategy = {
    id: 'rsi-extreme',
    title: 'RSI extremes',
    families: PRICE_FAMILIES,
    summary: 'Fades stretched moves: Fall when the RSI is high, Rise when it is low.',
    params: [
        { key: 'period', label: 'RSI period', min: 3, max: 50, step: 1, default: 14, hint: 'Ticks in the RSI.' },
        { key: 'high', label: 'High level', min: 55, max: 95, step: 1, default: 70, hint: 'At or above this the move counts as stretched up.' },
        { key: 'low', label: 'Low level', min: 5, max: 45, step: 1, default: 30, hint: 'At or below this the move counts as stretched down.' },
        sizeParam,
    ],
    decide: ctx => {
        const value = rsi(ctx.prices, Math.max(3, Math.trunc(ctx.params.period)));
        if (value === null) return null;
        if (value >= ctx.params.high) return priceDecision(1, ctx, `RSI ${value.toFixed(0)} is at or above ${ctx.params.high}: fading the rise with ${FAMILIES[ctx.family].sides[1]}.`);
        if (value <= ctx.params.low) return priceDecision(0, ctx, `RSI ${value.toFixed(0)} is at or below ${ctx.params.low}: fading the fall with ${FAMILIES[ctx.family].sides[0]}.`);
        return null;
    },
};

const sigmaBand: Strategy = {
    id: 'sigma-band',
    title: 'Volatility band',
    families: ['highlow', 'range'],
    summary: 'Sizes the barrier(s) from recent movement and trades by whether movement is shrinking or growing. Higher/Lower trades both sides (a pair) when movement is growing; Ends Between when it is shrinking; Ends Outside when it is growing.',
    params: [
        { key: 'k', label: 'Barrier distance (σ)', min: 0.3, max: 4, step: 0.1, default: 1, hint: 'Standard deviations of the expected move over the contract length.' },
        { key: 'shortWindow', label: 'Short window (ticks)', min: 5, max: 100, step: 1, default: 20, hint: 'Recent movement.' },
        { key: 'longWindow', label: 'Long window (ticks)', min: 50, max: 500, step: 10, default: 200, hint: 'Baseline movement.' },
        { key: 'lowRatio', label: 'Shrinking below', min: 0.3, max: 1, step: 0.05, default: 0.8, hint: 'Recent ÷ baseline movement under this counts as shrinking.' },
        { key: 'highRatio', label: 'Growing above', min: 1, max: 3, step: 0.05, default: 1.25, hint: 'Recent ÷ baseline movement over this counts as growing.' },
    ],
    decide: ctx => {
        const long = tickSigma(ctx.prices, ctx.params.longWindow);
        const short = tickSigma(ctx.prices, ctx.params.shortWindow);
        if (long <= 0 || ctx.prices.length < ctx.params.shortWindow + 2) return null;
        const ratio = short / long;
        const offset = sigmaOffset(ctx.prices, ctx.ticks, ctx.params.k, ctx.decimals, ctx.params.longWindow);
        if (ctx.family === 'range') {
            if (ratio <= ctx.params.lowRatio) return { side: 0, offset, reason: `Volatility band: movement is shrinking (${ratio.toFixed(2)}× baseline), Ends Between ±${offset}.` };
            if (ratio >= ctx.params.highRatio) return { side: 1, offset, reason: `Volatility band: movement is growing (${ratio.toFixed(2)}× baseline), Ends Outside ±${offset}.` };
            return null;
        }
        if (ratio >= ctx.params.highRatio) return { side: 'both', offset, reason: `Volatility band: movement is growing (${ratio.toFixed(2)}× baseline), Higher + Lower pair at ±${offset}.` };
        return null;
    },
};

export const STRATEGIES: Strategy[] = [recentStats, edgeScanner, markov, streak, overdue, lastDigitDiffers, momentum, emaTrend, rsiFade, sigmaBand];

export const strategiesFor = (family: Family): Strategy[] => STRATEGIES.filter(s => s.families.includes(family));
export const getStrategy = (id: string): Strategy | undefined => STRATEGIES.find(s => s.id === id);
/** The strategy Auto uses when none is chosen: the original recent-hit-rate rule for digits, tick momentum for prices. */
export const defaultStrategyId = (family: Family): string => (FAMILIES[family].digits ? 'recent-stats' : family === 'range' ? 'sigma-band' : 'tick-momentum');

export const paramDefaults = (strategy: Strategy): StrategyParams => Object.fromEntries(strategy.params.map(p => [p.key, p.default]));
/** Saved values over the defaults, each clamped to its allowed range. Unknown keys are dropped. */
export const resolveParams = (strategy: Strategy, saved: Partial<StrategyParams> = {}): StrategyParams =>
    Object.fromEntries(strategy.params.map(p => {
        const value = Number(saved[p.key]);
        return [p.key, Number.isFinite(value) ? clamp(value, p.min, p.max) : p.default];
    }));

// ---------------------------------------------------------------------------------------------------------------------
// Scoring on recent ticks
// ---------------------------------------------------------------------------------------------------------------------

export type Backtest = {
    ticksScanned: number;
    signals: number;
    wins: number;
    hitRate: number;
    /** Average hit rate chance alone would give for the bets taken (digit families). Null for price families. */
    chanceRate: number | null;
    /** Standard deviations above chance (digit families). */
    z: number | null;
    /** The hit rate needed to break even at the quoted payout, when one is given. */
    breakEven: number | null;
    /** Share of tested ticks that were skipped (the strategy waited). */
    waitedShare: number;
};

/** Hit probability of one bet, for scoring. */
const chanceOf = (family: Family, side: SideIndex, prediction: number): number => FAMILIES[family].hitProbability(side, prediction);

/**
 * Replays a strategy over past ticks: at every tick it asks for a decision using only what was known then, then checks the
 * result `ticks` later. It is a description of the past, not a forecast. Capped at `limit` ticks for speed.
 */
export const backtest = (
    strategy: Strategy,
    base: Omit<StrategyContext, 'digits' | 'prices' | 'params'>,
    digits: readonly number[],
    prices: readonly number[],
    params: StrategyParams,
    options: { limit?: number; warmup?: number; payoutRatio?: number | null } = {},
): Backtest => {
    const total = Math.min(digits.length, prices.length);
    const limit = options.limit ?? 1000;
    const from = Math.max(options.warmup ?? 60, total - limit);
    const ticks = Math.max(1, Math.trunc(base.ticks));
    const isDigit = FAMILIES[base.family].digits;
    const lookahead = isDigit ? ticks : ticks + 1;
    let signals = 0;
    let wins = 0;
    let chance = 0;
    let tested = 0;
    for (let i = from; i < total - lookahead; i += 1) {
        tested += 1;
        const d = strategy.decide({ ...base, digits: digits.slice(0, i + 1), prices: prices.slice(0, i + 1), params });
        if (!d) continue;
        signals += 1;
        const prediction = d.prediction ?? base.prediction;
        const offset = d.offset ?? base.offset;
        if (isDigit) {
            const side = d.side === 'both' ? 0 : d.side;
            if (digitWins(base.family, side, prediction, digits[i + ticks])) wins += 1;
            chance += chanceOf(base.family, side, prediction);
        } else {
            const entry = prices[i + 1];
            const exit = prices[i + 1 + ticks];
            const higher = base.family === 'range' ? Math.abs(exit - entry) < offset : exit > entry + (base.family === 'highlow' ? offset : 0);
            const lower = base.family === 'range' ? Math.abs(exit - entry) > offset : exit < entry - (base.family === 'highlow' ? offset : 0);
            if (d.side === 'both') wins += higher || lower ? 1 : 0;
            else wins += (d.side === 0 ? higher : lower) ? 1 : 0;
        }
    }
    const hitRate = signals ? wins / signals : 0;
    const chanceRate = isDigit && signals ? chance / signals : null;
    return {
        ticksScanned: tested, signals, wins, hitRate, chanceRate,
        z: chanceRate !== null && signals ? zScore(wins, signals, chanceRate) : null,
        breakEven: options.payoutRatio && options.payoutRatio > 0 ? 1 / (1 + options.payoutRatio) : null,
        waitedShare: tested ? 1 - signals / tested : 1,
    };
};

/** The score in one honest line. */
export const backtestText = (result: Backtest): string => {
    if (!result.signals) return `Scored on the last ${result.ticksScanned} ticks: no signals, so it would have waited the whole time.`;
    const parts = [`${result.signals} signal${result.signals === 1 ? '' : 's'}`, `${pct(result.hitRate)} won`];
    if (result.chanceRate !== null) parts.push(`${pct(result.chanceRate)} by chance${result.z !== null ? ` (${result.z >= 0 ? '+' : ''}${result.z.toFixed(1)}σ)` : ''}`);
    if (result.breakEven !== null) parts.push(`${pct(result.breakEven)} needed to break even`);
    return `Scored on the last ${result.ticksScanned} ticks: ${parts.join(' · ')}. This describes the past, not the next trade.`;
};
