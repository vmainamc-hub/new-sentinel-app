// What Deriv actually offers, per market, for the contracts that carry a price barrier (Higher/Lower, Ends Between/Outside).
//
// Why this exists: those contracts do not accept just any duration or barrier. Deriv publishes the rules per market in its
// `contracts_for` answer (which duration units exist, the shortest and longest duration, the barrier category), and rejects
// anything else with errors such as "Invalid barrier". Instead of guessing, the DTrader reads the rules, turns the ticks you
// asked for into a duration Deriv offers, finds a barrier distance Deriv accepts by asking for price quotes (a quote costs
// nothing; nothing is bought), and only then trades. Everything in this file is pure logic with the network injected, so it is
// unit-tested without Deriv.

import type { Family } from './dtrader-engine';

export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';
export type Duration = { value: number; unit: DurationUnit };

const UNIT_SECONDS: Record<DurationUnit, number> = { t: 0, s: 1, m: 60, h: 3600, d: 86_400 };

/** "5t", "15s", "1m", "2h", "1d" -> a duration. Null for anything else. */
export const parseDuration = (text: unknown): Duration | null => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([tsmhd])\s*$/i.exec(String(text ?? ''));
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? { value, unit: match[2].toLowerCase() as DurationUnit } : null;
};

export const durationText = (d: Duration) => `${d.value}${d.unit}`;
export const durationWords = (d: Duration) => `${d.value} ${{ t: 'tick', s: 'second', m: 'minute', h: 'hour', d: 'day' }[d.unit]}${d.value === 1 ? '' : 's'}`;
/** Seconds a duration lasts. Ticks need the market's tick length. */
export const toSeconds = (d: Duration, tickSeconds: number) => (d.unit === 't' ? d.value * tickSeconds : d.value * UNIT_SECONDS[d.unit]);

export type ContractRule = {
    contractType: string;
    expiryType: string;
    barrierCategory: string;
    min: Duration | null;
    max: Duration | null;
};

/** The contract types and barrier category a family trades. Null: the family needs no rules lookup. */
const RULE_SOURCE: Partial<Record<Family, { types: string[]; category: string }>> = {
    highlow: { types: ['CALL', 'PUT'], category: 'euro_non_atm' },
    range: { types: ['EXPIRYRANGE', 'EXPIRYMISS'], category: 'euro_non_atm' },
};
export const needsRules = (family: Family) => Boolean(RULE_SOURCE[family]);

/**
 * Picks the offers of a `contracts_for` answer that belong to this family. CALL/PUT appear twice in Deriv's list (Rise/Fall with
 * no barrier, Higher/Lower with one), so the barrier category matters. When the category is missing from every entry, any entry
 * of the right contract type that is not the barrier-less kind is used.
 */
export const extractRules = (available: unknown, family: Family): ContractRule[] => {
    const source = RULE_SOURCE[family];
    if (!source || !Array.isArray(available)) return [];
    const mine = available.filter((entry: any) => source.types.includes(String(entry?.contract_type)));
    const exact = mine.filter((entry: any) => String(entry?.barrier_category) === source.category);
    const chosen = exact.length ? exact : mine.filter((entry: any) => String(entry?.barrier_category) !== 'euro_atm');
    const seen = new Set<string>();
    const rules: ContractRule[] = [];
    chosen.forEach((entry: any) => {
        const rule: ContractRule = {
            contractType: String(entry.contract_type),
            expiryType: String(entry.expiry_type ?? ''),
            barrierCategory: String(entry.barrier_category ?? ''),
            min: parseDuration(entry.min_contract_duration),
            max: parseDuration(entry.max_contract_duration),
        };
        const key = `${rule.expiryType}|${rule.min ? durationText(rule.min) : ''}|${rule.max ? durationText(rule.max) : ''}`;
        if (!seen.has(key)) { seen.add(key); rules.push(rule); }
    });
    return rules;
};

export type DurationPlan = {
    duration: Duration;
    /** True when the duration is not the ticks that were asked for. */
    changed: boolean;
    /** Plain words for the panel. */
    note: string;
    /** Settles at a clock time rather than after a tick count. */
    timed: boolean;
};
export type DurationResult = { ok: true; plan: DurationPlan } | { ok: false; error: string };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Turns "N ticks" into a duration the market offers. Tick contracts are used when offered and in range; otherwise the nearest
 * tick length; otherwise the same time span in seconds (or minutes/days) within the allowed range.
 */
export const planDuration = (rules: readonly ContractRule[], ticks: number, tickSeconds: number, label: string): DurationResult => {
    if (!rules.length) return { ok: false, error: `Deriv does not offer ${label} on this market.` };
    const tickRule = rules.find(r => r.min?.unit === 't' || r.max?.unit === 't' || r.expiryType === 'tick');
    if (tickRule) {
        const min = tickRule.min?.unit === 't' ? tickRule.min.value : 1;
        const max = tickRule.max?.unit === 't' ? tickRule.max.value : 10;
        const value = clamp(Math.trunc(ticks), min, max);
        const changed = value !== ticks;
        return {
            ok: true,
            plan: {
                duration: { value, unit: 't' }, changed, timed: false,
                note: changed ? `${label} on this market runs ${min} to ${max} ticks, so ${value} ticks is used instead of ${ticks}.` : '',
            },
        };
    }
    const wantedSeconds = Math.max(1, Math.round(ticks * tickSeconds));
    const timeRule = rules.find(r => r.expiryType === 'intraday') ?? rules.find(r => r.min && r.min.unit !== 'd') ?? rules[0];
    if (timeRule.min && timeRule.min.unit !== 'd') {
        const minS = toSeconds(timeRule.min, tickSeconds);
        const maxS = timeRule.max ? toSeconds(timeRule.max, tickSeconds) : 86_400;
        const seconds = clamp(wantedSeconds, minS, maxS);
        const duration: Duration = seconds >= 60 && seconds % 60 === 0 ? { value: seconds / 60, unit: 'm' } : { value: seconds, unit: 's' };
        return {
            ok: true,
            plan: {
                duration, changed: true, timed: true,
                note: `${label} is not offered in ticks on this market. It runs ${durationWords(duration)} (at least ${durationWords(timeRule.min)}) and settles at that clock time, not on a tick count.`,
            },
        };
    }
    const days = clamp(1, timeRule.min?.value ?? 1, timeRule.max?.value ?? 365);
    return { ok: true, plan: { duration: { value: days, unit: 'd' }, changed: true, timed: true, note: `${label} on this market runs ${days} day${days === 1 ? '' : 's'} at the shortest.` } };
};

/** Signed barrier text the way Deriv reads it: "+0.50" / "-0.50", with the market's own number of decimals. */
export const barrierText = (sign: '+' | '-', offset: number, decimals: number) => `${sign}${Math.abs(offset).toFixed(Math.max(0, Math.min(8, decimals)))}`;

/** Offsets to try, smallest first: the one you asked for, then larger multiples, rounded to the market's price step. */
export const offsetCandidates = (base: number, decimals: number, volatilityOffset = 0): number[] => {
    const step = 10 ** -Math.max(0, decimals);
    const round = (x: number) => Math.max(step, Math.round(x / step) * step);
    const list = [base, base * 2, base * 4, base * 8, base * 16, volatilityOffset, volatilityOffset * 2, volatilityOffset * 4]
        .filter(x => Number.isFinite(x) && x > 0)
        .map(round);
    return [...new Set(list.map(x => Number(x.toFixed(Math.max(0, decimals)))))].sort((a, b) => a - b);
};

/** Deriv's rejection wording that a larger or differently formatted barrier can cure. */
export const isBarrierComplaint = (message: string) => /barrier/i.test(message);

export type Quote = { label: string; payout: number };
export type ProbeInput = {
    candidates: number[];
    /** Quotes every leg for one candidate offset. Throws Deriv's error when it refuses. */
    quote: (offset: number) => Promise<Quote[]>;
};
export type ProbeResult = { ok: true; offset: number; quotes: Quote[]; tried: number[] } | { ok: false; error: string; tried: number[] };

/** First candidate Deriv accepts. Stops early on an error a bigger barrier would not fix. */
export const probeOffsets = async ({ candidates, quote }: ProbeInput): Promise<ProbeResult> => {
    const tried: number[] = [];
    let lastError = 'Deriv did not accept any barrier distance.';
    for (const offset of candidates) {
        tried.push(offset);
        try {
            return { ok: true, offset, quotes: await quote(offset), tried };
        } catch (error) {
            lastError = error instanceof Error ? error.message : (error as { message?: string })?.message || String(error);
            if (!isBarrierComplaint(lastError)) return { ok: false, error: lastError, tried };
        }
    }
    return { ok: false, error: `${lastError} (distances tried: ${tried.join(', ')})`, tried };
};

/**
 * What a pair of opposite trades (Higher + Lower, Over + Under, Rise + Fall ...) can pay. Two trades of `stake` each cost
 * 2 x stake. When one side wins you collect that side's payout; when neither does (price ends inside a Higher/Lower band, or
 * exactly on a barrier) you collect nothing. `locked` is true when even a win leaves you behind, which is the normal result of
 * hedging at a typical payout of under 2 x stake.
 */
export type PairOutcome = { total: number; ifFirstWins: number; ifSecondWins: number; ifNeither: number; locked: boolean; note: string };
export const pairOutcome = (stake: number, firstPayout: number, secondPayout: number, bothCanLose: boolean): PairOutcome => {
    const total = Math.round(stake * 2 * 100) / 100;
    const r = (x: number) => Math.round(x * 100) / 100;
    const ifFirstWins = r(firstPayout - total);
    const ifSecondWins = r(secondPayout - total);
    const ifNeither = bothCanLose ? r(-total) : Math.min(ifFirstWins, ifSecondWins);
    const locked = ifFirstWins < 0 && ifSecondWins < 0;
    return {
        total, ifFirstWins, ifSecondWins, ifNeither, locked,
        note: locked
            ? 'Both sides together cost more than either one pays, so this pair loses money whichever side wins.'
            : bothCanLose ? 'If the price ends between the two barriers, both trades lose.' : '',
    };
};
