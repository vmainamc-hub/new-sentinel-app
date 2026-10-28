// Pure logic for the DTrader: entry rules (instant / digit / pattern), contract legs, bulk sizing, stake and stop rules,
// digit statistics and candle building. No React, no network. Everything here is deterministic and unit-tested.
//
// The one idea the whole DTrader is built around: ONE entry decision can send MANY trades, and every trade must enter on
// the same tick and settle on the same tick. Deriv has no "buy N" call, so the guarantee comes from (1) sending the whole
// burst in one pass right after the entry tick, (2) capping the burst to what reaches Deriv before the next tick, and (3)
// checking afterwards, from what Deriv reports, that every trade really shared one entry tick and one exit tick.

import { MAX_EXPOSURE, MAX_STAKE, MIN_STAKE } from '../bulk-run';
import { fitOnOneTick } from '../burst-pace';
import { barrierText } from './dtrader-catalog';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const round2 = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------------
// Contract families
// ---------------------------------------------------------------------------------------------------------------------

export type Family = 'overunder' | 'matchesdiffers' | 'evenodd' | 'risefall' | 'highlow' | 'range' | 'tickhighlow';
/** first = Over / Matches / Even / Rise / Higher / Ends Between / High Tick, second = Under / Differs / Odd / Fall / Lower / Ends Outside / Low Tick. */
export type SideChoice = 'first' | 'second' | 'both' | 'auto';
export type SideIndex = 0 | 1;

export type FamilyDef = {
    title: string;
    sides: [string, string];
    contracts: [string, string];
    /** Needs a digit prediction (barrier). */
    needsDigit: boolean;
    /** Needs a price offset from the entry spot (Higher/Lower, Ends Between/Outside). */
    needsOffset?: boolean;
    /** Needs a tick number to pick (High Tick / Low Tick). The panel's prediction field carries it. */
    needsTick?: boolean;
    /** Contract length in ticks when Deriv offers only one (High Tick / Low Tick are always 5). */
    fixedTicks?: number;
    /** Digit family: the result is decided by the last digit of the exit tick. */
    digits: boolean;
    /** Probability that a fair random digit wins, per side, for a given prediction. Used for the break-even note only. */
    hitProbability: (side: SideIndex, prediction: number) => number;
};

export const FAMILIES: Record<Family, FamilyDef> = {
    overunder: {
        title: 'Over/Under', sides: ['Over', 'Under'], contracts: ['DIGITOVER', 'DIGITUNDER'], needsDigit: true, digits: true,
        hitProbability: (side, p) => (side === 0 ? (9 - p) / 10 : p / 10),
    },
    matchesdiffers: {
        title: 'Matches/Differs', sides: ['Matches', 'Differs'], contracts: ['DIGITMATCH', 'DIGITDIFF'], needsDigit: true, digits: true,
        hitProbability: side => (side === 0 ? 0.1 : 0.9),
    },
    evenodd: {
        title: 'Even/Odd', sides: ['Even', 'Odd'], contracts: ['DIGITEVEN', 'DIGITODD'], needsDigit: false, digits: true,
        hitProbability: () => 0.5,
    },
    risefall: {
        title: 'Rise/Fall', sides: ['Rise', 'Fall'], contracts: ['CALL', 'PUT'], needsDigit: false, digits: false,
        hitProbability: () => 0.5,
    },
    highlow: {
        title: 'Higher/Lower', sides: ['Higher', 'Lower'], contracts: ['CALL', 'PUT'], needsDigit: false, needsOffset: true, digits: false,
        hitProbability: () => 0.5,
    },
    range: {
        title: 'Ends Between/Outside', sides: ['Ends Between', 'Ends Outside'], contracts: ['EXPIRYRANGE', 'EXPIRYMISS'], needsDigit: false, needsOffset: true, digits: false,
        hitProbability: () => 0.5,
    },
    tickhighlow: {
        // You pick one of the 5 ticks after entry. High Tick wins if it is the highest of the five, Low Tick if it is the lowest.
        // With one winner among five equally likely ticks, chance alone gives 1 in 5 (ties are rare on these markets).
        title: 'High Tick/Low Tick', sides: ['High Tick', 'Low Tick'], contracts: ['TICKHIGH', 'TICKLOW'], needsDigit: false, needsTick: true, fixedTicks: 5, digits: false,
        hitProbability: () => 0.2,
    },
};
export const FAMILY_ORDER: Family[] = ['overunder', 'matchesdiffers', 'evenodd', 'risefall', 'highlow', 'range', 'tickhighlow'];

/** Which of the 5 ticks is picked: a whole number from 1 to 5. */
export const tickPickError = (family: Family, pick: number): string | null => {
    const def = FAMILIES[family];
    if (!def.needsTick) return null;
    const last = def.fixedTicks ?? 5;
    return Number.isInteger(pick) && pick >= 1 && pick <= last ? null : `Pick a tick from 1 to ${last}.`;
};

/** The barrier offset must be a positive price distance, for example 0.5. */
export const offsetError = (family: Family, offset: number): string | null => {
    if (!FAMILIES[family].needsOffset) return null;
    return Number.isFinite(offset) && offset > 0 ? null : 'Enter a barrier offset above 0, for example 0.5.';
};

/** Deriv rejects Over 9 and Under 0 (nothing can be above 9 or below 0). */
export const predictionError = (family: Family, side: SideChoice, prediction: number): string | null => {
    if (!FAMILIES[family].needsDigit) return null;
    if (!Number.isInteger(prediction) || prediction < 0 || prediction > 9) return 'The digit must be a whole number from 0 to 9.';
    if (family !== 'overunder') return null;
    if ((side === 'first' || side === 'both') && prediction > 8) return 'Over needs a digit from 0 to 8.';
    if ((side === 'second' || side === 'both') && prediction < 1) return 'Under needs a digit from 1 to 9.';
    return null;
};

export type Leg = { contract: string; barrier?: string; barrier2?: string; /** High Tick / Low Tick: which of the 5 ticks is picked. */ selectedTick?: number; label: string; sideIndex: SideIndex };

/** The contract(s) one entry buys. 'both' buys the two opposite sides together. 'auto' must be resolved first. */
export const legsFor = (family: Family, side: Exclude<SideChoice, 'auto'>, prediction: number, offset = 0, decimals?: number): Leg[] => {
    const def = FAMILIES[family];
    // Offsets are relative to the entry spot, the way Deriv reads "+0.50" / "-0.50". Higher is above the spot, Lower is below;
    // the two range contracts use a band of +offset and -offset around the spot. With the market's number of decimals known the
    // barrier is written with exactly that many, which is how Deriv expects it.
    const text = (sign: '+' | '-') => (decimals === undefined ? `${sign}${offset}` : barrierText(sign, offset, decimals));
    const priceBarriers = (index: SideIndex): Pick<Leg, 'barrier' | 'barrier2'> => {
        if (!def.needsOffset) return {};
        if (family === 'range') return { barrier: text('+'), barrier2: text('-') };
        return { barrier: index === 0 ? text('+') : text('-') };
    };
    const make = (index: SideIndex): Leg => ({
        contract: def.contracts[index],
        ...(def.needsDigit ? { barrier: String(prediction) } : {}),
        ...priceBarriers(index),
        ...(def.needsTick ? { selectedTick: prediction } : {}),
        label: def.needsDigit ? `${def.sides[index]} ${prediction}` : def.needsTick ? `${def.sides[index]} #${prediction}` : def.needsOffset ? `${def.sides[index]} ±${offset}` : def.sides[index],
        sideIndex: index,
    });
    if (side === 'both') return [make(0), make(1)];
    return [make(side === 'first' ? 0 : 1)];
};

// ---------------------------------------------------------------------------------------------------------------------
// Digit statistics
// ---------------------------------------------------------------------------------------------------------------------

export type DigitStats = { counts: number[]; pct: number[]; total: number; most: number; least: number };

export const digitStats = (digits: readonly number[], window: number): DigitStats => {
    const counts = new Array<number>(10).fill(0);
    const start = Math.max(0, digits.length - Math.max(1, window));
    for (let i = start; i < digits.length; i += 1) if (digits[i] >= 0 && digits[i] <= 9) counts[digits[i]] += 1;
    const total = counts.reduce((a, b) => a + b, 0);
    const pct = counts.map(count => (total ? Math.round((count / total) * 1000) / 10 : 0));
    let most = 0;
    let least = 0;
    counts.forEach((count, digit) => {
        if (count > counts[most]) most = digit;
        if (count < counts[least]) least = digit;
    });
    return { counts, pct, total, most, least };
};

/**
 * 'auto' side for the digit families: the side whose hit rate over the last `window` ticks is higher. This describes the
 * recent past. Digits are independent, so it does not predict the next tick, and the panel says so.
 */
export const autoSide = (family: Family, digits: readonly number[], prediction: number, window = 200): Exclude<SideChoice, 'auto' | 'both'> => {
    const def = FAMILIES[family];
    if (!def.digits) return 'first';
    const slice = digits.slice(-Math.max(1, window));
    if (!slice.length) return 'first';
    const wins = (side: SideIndex) => slice.filter(d => digitWins(family, side, prediction, d)).length;
    return wins(1) > wins(0) ? 'second' : 'first';
};

/** Does a final digit win this side? (Digit families only.) */
export const digitWins = (family: Family, side: SideIndex, prediction: number, digit: number): boolean => {
    switch (family) {
        case 'overunder': return side === 0 ? digit > prediction : digit < prediction;
        case 'matchesdiffers': return side === 0 ? digit === prediction : digit !== prediction;
        case 'evenodd': return side === 0 ? digit % 2 === 0 : digit % 2 === 1;
        default: return false;
    }
};

// ---------------------------------------------------------------------------------------------------------------------
// Entry rules: how the market must behave before anything is bought
// ---------------------------------------------------------------------------------------------------------------------

export type DigitOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | 'even' | 'odd' | 'same';
export const DIGIT_OPS: Array<{ value: DigitOp; label: string }> = [
    { value: '=', label: '=' }, { value: '!=', label: '≠' }, { value: '<', label: '<' }, { value: '<=', label: '≤' },
    { value: '>', label: '>' }, { value: '>=', label: '≥' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }, { value: 'same', label: 'Same' },
];
/** Operators that compare against a digit (the others ignore it). */
export const opNeedsDigit = (op: DigitOp) => !['even', 'odd', 'same'].includes(op);

export type PatternRule =
    /** The last `count` digits must ALL satisfy `op digit` (or, for 'same', all be equal to each other). */
    | { kind: 'last'; count: number; op: DigitOp; digit: number }
    /** The digits must print in this order. The entry fires once the first `fireAfter` of them have printed (default: all). */
    | { kind: 'sequence'; digits: number[]; fireAfter: number };

export type EntryRule =
    | { mode: 'instant' }
    | { mode: 'digit'; op: DigitOp; digit: number }
    | { mode: 'pattern'; pattern: PatternRule };

const test = (op: DigitOp, value: number, digit: number): boolean => {
    switch (op) {
        case '=': return value === digit;
        case '!=': return value !== digit;
        case '<': return value < digit;
        case '<=': return value <= digit;
        case '>': return value > digit;
        case '>=': return value >= digit;
        case 'even': return value % 2 === 0;
        case 'odd': return value % 2 === 1;
        default: return false;
    }
};

/** "1 2 5", "1,2,5" and "125" all mean the digits 1, 2, 5. Null when the text has anything else. */
export const parseSequence = (text: string): number[] | null => {
    const compact = String(text ?? '').trim();
    if (!compact) return null;
    const parts = /[\s,;>→-]/.test(compact) ? compact.split(/[\s,;>→-]+/).filter(Boolean) : compact.split('');
    if (!parts.length || parts.length > 12) return null;
    const digits = parts.map(part => (/^\d$/.test(part) ? Number(part) : NaN));
    return digits.some(Number.isNaN) ? null : digits;
};

/** Does the newest tick complete this entry rule? Called once per new tick with the market's digits (oldest first). */
export const matchEntry = (digits: readonly number[], rule: EntryRule): boolean => {
    if (rule.mode === 'instant') return digits.length > 0;
    if (!digits.length) return false;
    if (rule.mode === 'digit') return test(rule.op, digits[digits.length - 1], rule.digit);
    const p = rule.pattern;
    if (p.kind === 'last') {
        const count = Math.max(1, Math.trunc(p.count));
        if (digits.length < count) return false;
        const recent = digits.slice(-count);
        return p.op === 'same' ? recent.every(d => d === recent[0]) : recent.every(d => test(p.op, d, p.digit));
    }
    const length = clamp(Math.trunc(p.fireAfter) || p.digits.length, 1, p.digits.length);
    if (!p.digits.length || digits.length < length) return false;
    const recent = digits.slice(-length);
    return p.digits.slice(0, length).every((d, i) => recent[i] === d);
};

/** The entry rule in plain words, for the panel and the journal. */
export const describeEntry = (rule: EntryRule): string => {
    const opText = (op: DigitOp, digit: number) => (opNeedsDigit(op) ? `${DIGIT_OPS.find(o => o.value === op)?.label ?? op} ${digit}` : op === 'same' ? 'the same' : op);
    if (rule.mode === 'instant') return 'Instant: buy on the next tick';
    if (rule.mode === 'digit') return `Digit: wait for a last digit ${opText(rule.op, rule.digit)}`;
    const p = rule.pattern;
    if (p.kind === 'last') return `Pattern: the last ${p.count} digit${p.count === 1 ? '' : 's'} ${p.op === 'same' ? 'all the same' : `all ${opText(p.op, p.digit)}`}`;
    const fire = clamp(Math.trunc(p.fireAfter) || p.digits.length, 1, p.digits.length);
    return `Pattern: digits ${p.digits.join(' → ')}${fire < p.digits.length ? `, buy after the ${fire}${fire === 1 ? 'st' : fire === 2 ? 'nd' : fire === 3 ? 'rd' : 'th'}` : ''}`;
};

/** Why an entry rule cannot run, or null. */
export const entryError = (rule: EntryRule): string | null => {
    if (rule.mode === 'digit' && (!Number.isInteger(rule.digit) || rule.digit < 0 || rule.digit > 9)) return 'The entry digit must be 0 to 9.';
    if (rule.mode === 'pattern') {
        const p = rule.pattern;
        if (p.kind === 'last') {
            if (!Number.isInteger(p.count) || p.count < 1 || p.count > 20) return 'The pattern length must be 1 to 20 ticks.';
            if (opNeedsDigit(p.op) && (!Number.isInteger(p.digit) || p.digit < 0 || p.digit > 9)) return 'The pattern digit must be 0 to 9.';
        } else if (!p.digits.length) {
            return 'Type the digits of the pattern, for example 1 2 5.';
        }
    }
    return null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Bulk sizing, stake and stop rules
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_TRADES_PER_ENTRY = 100;

export type BurstPlan = {
    /** Trades per leg actually sent. */
    perLeg: number;
    /** Total contracts sent (legs x perLeg). */
    total: number;
    requestedTotal: number;
    capped: boolean;
    note: string;
};

/**
 * How many trades to send. With the same-tick guard ON, the burst is trimmed to what reaches Deriv before the next tick, so
 * all of it shares one entry tick and one exit tick. With it OFF, everything requested is sent (and may spill over a tick).
 */
export const planBurst = (input: {
    legs: number; perLeg: number; intervalMs: number | null; elapsedMs: number; perBuyMs: number; guard: boolean;
}): BurstPlan => {
    const legs = Math.max(1, input.legs);
    const perLeg = clamp(Math.trunc(input.perLeg) || 1, 1, MAX_TRADES_PER_ENTRY);
    const requestedTotal = legs * perLeg;
    if (!input.guard || !input.intervalMs || requestedTotal <= 1) {
        return { perLeg, total: requestedTotal, requestedTotal, capped: false, note: '' };
    }
    const verdict = fitOnOneTick({ requested: requestedTotal, intervalMs: input.intervalMs, elapsedMs: input.elapsedMs, perBuyMs: input.perBuyMs });
    if (!verdict.capped) return { perLeg, total: requestedTotal, requestedTotal, capped: false, note: '' };
    const fitPerLeg = Math.max(1, Math.floor(verdict.fit / legs));
    const total = fitPerLeg * legs;
    return {
        perLeg: fitPerLeg, total, requestedTotal, capped: total < requestedTotal,
        note: `Sending ${total} of ${requestedTotal} trades: only that many reach Deriv before the next tick (about ${Math.round(input.perBuyMs)} ms per buy, ticks every ${(input.intervalMs / 1000).toFixed(1)} s), so they all share one entry tick and one exit tick.`,
    };
};

export const clampStake = (value: number) => round2(clamp(Number.isFinite(value) ? value : MIN_STAKE, MIN_STAKE, MAX_STAKE));

/** Stake for the next entry: multiplied after a losing entry, back to the base after a winning one. */
export const nextStake = (base: number, current: number, runProfit: number, multiplier: number): number => {
    if (runProfit > 0) return clampStake(base);
    const m = Number.isFinite(multiplier) && multiplier > 1 ? multiplier : 1;
    return clampStake(current * m);
};

/** Null when the entry may be sent, otherwise why not. Stake x trades can never pass the app-wide exposure limit. */
export const exposureError = (stake: number, total: number): string | null =>
    round2(stake * total) > MAX_EXPOSURE
        ? `Total stake ${round2(stake * total).toFixed(2)} is over the ${MAX_EXPOSURE} limit. Lower the stake or the number of trades.`
        : null;

/** Session stop: take profit / stop loss, both in account currency, 0 or empty = off. */
export const stopReason = (pnl: number, takeProfit: number, stopLoss: number): string | null => {
    if (takeProfit > 0 && pnl >= takeProfit) return `Take profit reached (${pnl.toFixed(2)}).`;
    if (stopLoss > 0 && pnl <= -stopLoss) return `Stop loss reached (${pnl.toFixed(2)}).`;
    return null;
};

// ---------------------------------------------------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------------------------------------------------

export type Candle = { open: number; high: number; low: number; close: number; time: number };

/** Groups ticks into candles of `size` ticks each (the newest candle may be partial). */
export const toCandles = (prices: readonly number[], times: readonly number[], size: number): Candle[] => {
    const n = Math.max(1, Math.trunc(size));
    const candles: Candle[] = [];
    const count = Math.min(prices.length, times.length);
    // Anchor on the newest tick so candle boundaries do not jump when old ticks scroll out.
    const offset = count % n;
    for (let i = offset === 0 ? 0 : offset - n; i < count; i += n) {
        const from = Math.max(0, i);
        const to = Math.min(count, i + n);
        const slice = prices.slice(from, to);
        if (!slice.length) continue;
        candles.push({ open: slice[0], high: Math.max(...slice), low: Math.min(...slice), close: slice[slice.length - 1], time: times[to - 1] });
    }
    return candles;
};

export const decimalsText = (value: number, decimals: number) => (Number.isFinite(value) ? value.toFixed(clamp(decimals, 0, 6)) : '—');
