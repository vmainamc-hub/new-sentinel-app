// SIGNAL ZONE: the app-wide Sentinel AI pop-up. Turns the signal on the pop-up into a Signal Zone candidate and loads it into a Masika bot
// through the same loader the Signal Zone page uses. It NEVER presses Run: the user does that in Bot Builder.
import { addEntry, entryFor, loadHistory, saveHistory } from './signal-zone-history';
import { loadSignalIntoBot, type LoadOutcome } from './signal-zone-loader';
import type { ZoneCandidate } from './signal-zone-merge';
import { candidateFromSignal, type PopupSignal } from './signal-zone-popup-candidate';
import { loadSettings, validateSettings } from './signal-zone-settings';

export { candidateFromSignal, type PopupSignal };

/** The candidate for the pop-up's signal, or null (with a plain reason) when it cannot be loaded. */
export const candidateForPopup = (signal: PopupSignal, now = Date.now()): { candidate: ZoneCandidate | null; reason: string | null } =>
    candidateFromSignal(signal, loadSettings(), now);

/** Validates the settings, picks the Masika bot for the contract, loads it into Bot Builder and redirects. Throws a plain reason. */
export const loadPopupCandidate = async (candidate: ZoneCandidate, openBotBuilder: () => void): Promise<LoadOutcome> => {
    const settings = loadSettings();
    const problems = validateSettings(settings);
    if (problems.length) throw new Error(`${problems[0]} Fix it in Signal Zone settings.`);
    const now = Date.now();
    const outcome = await loadSignalIntoBot(candidate, settings, openBotBuilder);
    saveHistory(addEntry(loadHistory(), entryFor(candidate, 'sentinel_only', now)));
    return outcome;
};
