// SIGNAL ZONE: the app-wide Sentinel AI pop-up. Turns the signal on the pop-up into a Signal Zone candidate and loads it into a Masika bot
// through the same loader the Signal Zone page uses. It NEVER presses Run: the user does that in Bot Builder.
import { addEntry, entryFor, loadHistory, saveHistory } from './signal-zone-history';
import { loadSignalIntoBot, type LoadOutcome } from './signal-zone-loader';
import { keyOf, mergeCandidates, revalidate, type ZoneCandidate } from './signal-zone-merge';
import { loadSettings, validateSettings, type SignalZoneSettings } from './signal-zone-settings';
import { readSources } from './signal-zone-sources';

type PopupSignal = { symbol: string; contractType: 'DIGITOVER' | 'DIGITUNDER'; barrier: number };

/** Sentinel-only view of the board, using the Signal Zone settings (stake, martingale, gates, default entry digits). */
const board = (settings: SignalZoneSettings, now: number): ZoneCandidate[] => {
    const read = readSources(settings.requireMomentum, now);
    return mergeCandidates(read.sentinel, read.fusion, { ...settings, mergeMode: 'sentinel_only' }, now);
};

/** The Signal Zone candidate for the signal on the pop-up, or null (with a plain reason) when it cannot be loaded. */
export const candidateForPopup = (signal: PopupSignal, now = Date.now()): { candidate: ZoneCandidate | null; reason: string | null } => {
    const found = board(loadSettings(), now).find(item => item.key === keyOf(signal.symbol, signal.contractType, signal.barrier));
    if (!found) return { candidate: null, reason: 'This signal is no longer on the board.' };
    if (!found.loadable) return { candidate: null, reason: found.reason };
    return { candidate: found, reason: null };
};

/** Re-checks the candidate against a fresh read, then loads it into Bot Builder. Throws a plain reason when it cannot. */
export const loadPopupCandidate = async (candidate: ZoneCandidate, openBotBuilder: () => void): Promise<LoadOutcome> => {
    const settings = loadSettings();
    const problems = validateSettings(settings);
    if (problems.length) throw new Error(`${problems[0]} Fix it in Signal Zone settings.`);
    const now = Date.now();
    const check = revalidate(candidate, board(settings, now), now);
    if (!check.ok) throw new Error(check.reason);
    const outcome = await loadSignalIntoBot(check.candidate, settings, openBotBuilder);
    saveHistory(addEntry(loadHistory(), entryFor(check.candidate, 'sentinel_only', now)));
    return outcome;
};
