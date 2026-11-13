// APEX INTEL: the entry digit for its second mode ("Entry digit"), now read from the Entry Digit Lab (entry-lab.ts).
//
// The first version worked a digit out from a one-off replay of a market's history and kept it for a minute. A 1-tick contract
// can trade dozens of times in a minute, so one digit served all of them while the market kept moving. That memory is gone: the
// lab takes every tick of every market, re-scores all ten candidate digits on each one and weighs the newest data most. `get`
// always answers from the newest tick, and a digit that is not holding up gets no trade at all (`tradable: false`).
//
// Sentinel AI's own entry digit (sentinel/overlay.ts, the Bulk Trader's `discoverEntry`) is untouched.
import type { Contract } from '@/components/premium/sixfold/bot';
import { EntryDigitLab, type LabParams, type LabView } from './entry-lab';

export type { DigitRead, DigitState, LabView as EntryLabView } from './entry-lab';

export type EntryDigit = {
    digit: number;
    /** confirmed: beats luck even for the best of ten digits. leading: ahead of fair on recent entries and the newest ones agree. weak: neither, so not traded. */
    strength: 'confirmed' | 'leading' | 'weak';
    /** Only a digit that holds up right now is traded. */
    tradable: boolean;
    /** Plain words for the log and the page: how the contract did when it was entered right after this digit, on the newest data. */
    note: string;
};

export type EntryDigitSource = {
    /** The entry digit for this contract on this market on the newest tick, or null when the history is too short or the contract is not one of the six. */
    get: (market: string, contract: Contract, duration: number) => EntryDigit | null;
    /** Every live tick of a market, whether or not a run is on: the lab never stops. */
    observe: (market: string, digit: number) => void;
    /** A trade entered on `digit` settled. Returns a log line when the digit was benched for losing. */
    record: (market: string, contract: Contract, duration: number, digit: number, won: boolean) => string | null;
    /** All ten digits of a contract on a market (for the page). */
    view: (market: string, contract: Contract, duration: number) => LabView | null;
    reset: () => void;
};

export const createEntryDigitSource = (opts: {
    /** The live digits of a market (current tick included). */
    series: (market: string) => readonly number[] | undefined;
    /** Test hook: the lab's settings. */
    params?: Partial<LabParams>;
}): EntryDigitSource => {
    const lab = new EntryDigitLab(opts.params);
    // Keep the lab's copy of a market the same as the feed's: first sight, or after a reconnect that replaced the history.
    const sync = (market: string): boolean => {
        const series = opts.series(market);
        if (!series || series.length < lab.params.minTicks) return false;
        if (!lab.matches(market, series)) lab.load(market, series);
        return true;
    };
    return {
        get: (market, contract, duration) => {
            try {
                if (!sync(market)) return null;
                const c = lab.choose(market, contract, duration);
                if (!c) return null;
                return {
                    digit: c.digit,
                    strength: c.state === 'confirmed' ? 'confirmed' : c.state === 'leading' ? 'leading' : 'weak',
                    tradable: c.tradable,
                    note: c.note,
                };
            } catch {
                return null; // a digit that cannot be worked out means no trade on that market, never a guess
            }
        },
        observe: (market, digit) => {
            try {
                if (lab.has(market)) lab.observe(market, digit);
                else sync(market);
            } catch {
                /* the lab is an extra look: it never disturbs the feed */
            }
        },
        record: (market, contract, duration, digit, won) => {
            try {
                return lab.record(market, contract, duration, digit, won);
            } catch {
                return null;
            }
        },
        view: (market, contract, duration) => {
            try {
                return sync(market) ? lab.view(market, contract, duration) : null;
            } catch {
                return null;
            }
        },
        reset: () => lab.reset(),
    };
};
