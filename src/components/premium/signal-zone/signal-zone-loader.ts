// SIGNAL ZONE: turns a chosen candidate into a configured Masika bot and loads it into DBot. It never presses Run.
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import { fetchFreeBotById, loadBotXmlIntoBuilder } from '../pages/FreeBotsPage';
import { MASIKA_BOT_IDS, configureMasikaBot, type ActiveSymbolLike } from './signal-zone-bot';
import type { ZoneCandidate } from './signal-zone-merge';
import { signalZoneSession } from './signal-zone-session';
import type { SignalZoneSettings } from './signal-zone-settings';

export type LoadOutcome = { botName: string; summary: string };

/** Live active symbols give the exact submarket DBot lists a market under. A failure here only means the fallback is used. */
const activeSymbols = async (): Promise<ActiveSymbolLike[] | undefined> => {
    try {
        return await PremiumDerivApiService.activeSymbols();
    } catch {
        return undefined;
    }
};

/**
 * Fetches the right bot, writes the signal and settings into it, checks the result, opens Bot Builder and loads it.
 * Everything is validated BEFORE Bot Builder opens, so a mismatched bot never reaches Blockly. The outcome is also recorded on the
 * session, because the Signal Zone page is no longer on screen once Bot Builder is open.
 */
export const loadSignalIntoBot = async (
    candidate: ZoneCandidate, settings: SignalZoneSettings, openBotBuilder: () => void,
): Promise<LoadOutcome> => {
    const entry = candidate.entryDigit;
    if (!candidate.loadable || entry === null) throw new Error(candidate.reason ?? 'This signal cannot be loaded.');
    const summary = `${candidate.label} on ${candidate.market}, entry digit ${entry}`;
    try {
        const { bot, xml } = await fetchFreeBotById(MASIKA_BOT_IDS[candidate.contract]);
        const configured = configureMasikaBot(
            xml, { symbol: candidate.symbol, contract: candidate.contract, barrier: candidate.barrier, entryDigit: entry }, settings, await activeSymbols(),
        );
        const botName = bot.name || bot.title || bot.file;
        openBotBuilder();
        await loadBotXmlIntoBuilder(configured, `Signal Zone ${candidate.symbol} ${candidate.label}.xml`);
        signalZoneSession.arm(settings.stopLoss, summary, Date.now());
        signalZoneSession.setLoadStatus(true, `Loaded ${botName}: ${summary}. Press Run in Bot Builder.`, Date.now());
        return { botName, summary };
    } catch (error) {
        signalZoneSession.setLoadStatus(false, error instanceof Error ? error.message : String(error), Date.now());
        throw error;
    }
};
