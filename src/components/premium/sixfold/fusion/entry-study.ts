// SIXFOLD (fused): the studied entry digit. Two engines study the same market and have to be reconciled into ONE digit:
//   - Sentinel AI / Apex Intel's formula (`entryTriggerOf` -> the Bulk Trader's `discoverEntry`): replays the market's own history,
//     picks the digit after which the contract kept winning on the older two thirds and checks it on the newest third.
//   - Sixfold's Entry Brain (`replayCell`): cuts the last 1000 ticks into five windows and PROVES the digits that beat the contract's
//     base rate in nearly all of them, up to the newest.
// They support each other like this:
//   both agree on the digit      -> 'both'     the strongest label; trade it.
//   Sentinel's digit is confirmed -> 'sentinel' trade it (the Brain's view is added to the note).
//   Sentinel's digit is only weak and the Brain has a PROVEN digit -> 'brain'  the proven digit replaces the weak one.
//   Sentinel found nothing, the Brain has a digit -> 'brain'.
//   otherwise Sentinel's weak digit stands (a timing choice, not an edge) -> 'sentinel', weak.
// The trade is placed on the first NEW tick that shows the digit (the runner does that; see `RunnerOverlay.entryTrigger`).
//
// Pure apart from the injected series and clock. The digit is kept for ENTRY_DIGIT_TTL_MS so the digit being waited for does not
// change on every scan.
import type { Contract } from '../bot';
import { BRAIN_HISTORY, replayCell, type TriggerDigit } from '../entry-brain';
import type { EntryTrigger } from '../overlay';
import { ENTRY_DIGIT_TTL_MS, entryTriggerOf } from '../../sentinel/overlay';

export type StudySource = 'both' | 'sentinel' | 'brain';

export type BrainView = { digit: number; proven: boolean; rate: number | null; touches: number; passed: number };

export type Study = {
    trigger: EntryTrigger;
    source: StudySource;
    /** The Brain's best entry digit for this contract, whether or not it was the one chosen. */
    brain: BrainView | null;
};

/** A missing digit (history too short) is looked for again after this long, not kept for the full minute. */
export const STUDY_RETRY_MS = 5_000;

const pct = (x: number | null) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const viewOf = (t: TriggerDigit): BrainView => ({ digit: t.digit, proven: t.evidence === 'PROVEN', rate: t.rate, touches: t.touches, passed: t.passed });
const brainNote = (t: TriggerDigit) => `${t.digit}: ${pct(t.rate)} over ${t.touches} touches, ${t.passed}/5 windows`;

/** Reconciles the two studies. Exported for tests. */
export function reconcile(
    sentinel: EntryTrigger | null,
    brainDigits: readonly TriggerDigit[]
): Study | null {
    const proven = brainDigits.filter(t => t.evidence === 'PROVEN');
    const bestBrain = proven[0] ?? brainDigits[0] ?? null;
    const brain = bestBrain ? viewOf(bestBrain) : null;
    if (sentinel) {
        const same = proven.find(t => t.digit === sentinel.digit);
        if (same) {
            return {
                source: 'both',
                brain,
                trigger: { digit: sentinel.digit, strength: 'confirmed', note: `${sentinel.note}. The Entry Brain proves the same digit (${brainNote(same)})` },
            };
        }
        if (sentinel.strength === 'confirmed') {
            return {
                source: 'sentinel',
                brain,
                trigger: { ...sentinel, note: bestBrain ? `${sentinel.note}. Entry Brain's own pick: ${brainNote(bestBrain)}` : sentinel.note },
            };
        }
        if (proven.length) {
            const pick = proven[0];
            return {
                source: 'brain',
                brain,
                trigger: {
                    digit: pick.digit,
                    strength: 'confirmed',
                    note: `the Entry Brain proves digit ${brainNote(pick)} (Sentinel's formula found no digit that stands out, best was ${sentinel.digit})`,
                },
            };
        }
        return { source: 'sentinel', brain, trigger: sentinel };
    }
    if (bestBrain) {
        const isProven = bestBrain.evidence === 'PROVEN';
        return {
            source: 'brain',
            brain,
            trigger: {
                digit: bestBrain.digit,
                strength: isProven ? 'confirmed' : 'weak',
                note: isProven
                    ? `the Entry Brain proves digit ${brainNote(bestBrain)}`
                    : `best digit for the Entry Brain (${brainNote(bestBrain)}), none proven. Waiting for it is a timing choice, not an edge`,
            },
        };
    }
    return null;
}

export type EntryStudySource = {
    /** The studied digit for this contract on this market (and why), or null when the history is too short. Cached. */
    get: (symbol: string, contract: Contract, series: readonly number[], duration: number, now: number) => Study | null;
    /** What is already worked out, without working anything out. For the page. */
    peek: (symbol: string, contract: Contract, duration: number) => Study | null;
    /** A new session works every digit out afresh from the newest ticks. */
    reset: () => void;
};

export const createEntryStudy = (
    opts: {
        /** Test hooks. Defaults: Sentinel's `entryTriggerOf` and the Brain's `replayCell`. */
        discover?: typeof entryTriggerOf;
        replay?: typeof replayCell;
    } = {}
): EntryStudySource => {
    const discover = opts.discover ?? entryTriggerOf;
    const replay = opts.replay ?? replayCell;
    const cache = new Map<string, { at: number; value: Study | null }>();
    const keyOf = (symbol: string, c: Contract, duration: number) => `${symbol}|${c.side}:${c.param}|${duration}`;
    return {
        get: (symbol, contract, series, duration, now) => {
            const key = keyOf(symbol, contract, duration);
            const hit = cache.get(key);
            if (hit && now - hit.at < ENTRY_DIGIT_TTL_MS && (hit.value || now - hit.at < STUDY_RETRY_MS)) return hit.value;
            let value: Study | null = null;
            try {
                let sentinel: EntryTrigger | null = null;
                try {
                    sentinel = discover(series, contract.side, contract.param, duration)?.trigger ?? null;
                } catch {
                    sentinel = null; // one engine failing leaves the other
                }
                let brain: readonly TriggerDigit[] = [];
                try {
                    brain = replay(symbol, series.slice(-BRAIN_HISTORY), contract, duration)?.triggers ?? [];
                } catch {
                    brain = [];
                }
                value = reconcile(sentinel, brain);
            } catch {
                value = null; // a digit that cannot be worked out means no trade on that market yet, never a guess
            }
            cache.set(key, { at: now, value });
            return value;
        },
        peek: (symbol, contract, duration) => cache.get(keyOf(symbol, contract, duration))?.value ?? null,
        reset: () => cache.clear(),
    };
};
