// APEX INTEL: the entry digit, for its second mode ("Entry digit"). It is the SAME formula Sentinel AI and the Bulk Trader use:
// `discoverEntry` (bulk-scan.ts) replays the market's own history and finds the digit after which the contract kept winning, chosen
// on the older two thirds and checked on the newest third. Sentinel's `entryTriggerOf` wraps it per contract; this file only adds
// the same one-minute memory Sentinel's overlay keeps, so the digit being waited for does not change on every tick.
//
// Pure apart from the injected `series` and `now`. The executor (executor.ts) asks it for a digit per market and contract.
import type { Contract } from '@/components/premium/sixfold/bot';
import { ENTRY_DIGIT_TTL_MS, entryTriggerOf } from '@/components/premium/sentinel/overlay';

export type EntryDigit = {
    digit: number;
    /** 'confirmed': the digit also held on the newest part of the history. 'weak': the best digit found, but none stands out (a timing choice, not an edge). */
    strength: 'confirmed' | 'weak';
    /** Plain words for the log and the page: how the contract did when it was entered right after this digit. */
    note: string;
};

/** A missing digit (history too short) is looked for again after this long, not kept for the full minute. Same as Sentinel's overlay. */
export const ENTRY_DIGIT_RETRY_MS = 5_000;

export type EntryDigitSource = {
    /** The entry digit for this contract on this market, or null when the history is too short or the contract is not one of the six. */
    get: (market: string, contract: Contract, duration: number, now: number) => EntryDigit | null;
    /** A new session works every digit out afresh from the newest ticks. */
    reset: () => void;
};

export const createEntryDigitSource = (opts: {
    /** The live digits of a market (current tick included). */
    series: (market: string) => readonly number[] | undefined;
    /** Test hook: the discovery itself. Default: Sentinel's `entryTriggerOf` (the Bulk Trader's replay). */
    discover?: typeof entryTriggerOf;
}): EntryDigitSource => {
    const discover = opts.discover ?? entryTriggerOf;
    // Each market's digit per contract and length, kept for ENTRY_DIGIT_TTL_MS.
    const cache = new Map<string, { at: number; value: EntryDigit | null }>();
    return {
        get: (market, contract, duration, now) => {
            const key = `${market}|${contract.side}:${contract.param}|${duration}`;
            const hit = cache.get(key);
            if (hit && now - hit.at < ENTRY_DIGIT_TTL_MS && (hit.value || now - hit.at < ENTRY_DIGIT_RETRY_MS))
                return hit.value;
            let value: EntryDigit | null = null;
            try {
                const found = discover(opts.series(market) ?? [], contract.side, contract.param, duration);
                value = found
                    ? { digit: found.trigger.digit, strength: found.trigger.strength, note: found.trigger.note }
                    : null;
            } catch {
                value = null; // a digit that cannot be worked out means no trade on that market, never a guess
            }
            cache.set(key, { at: now, value });
            return value;
        },
        reset: () => cache.clear(),
    };
};
