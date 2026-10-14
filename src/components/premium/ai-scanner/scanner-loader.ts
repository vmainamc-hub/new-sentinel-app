// AI ENTRY SCANNER: turns a scan result into a configured bot 11 (Under) or bot 26 (Over) and loads it into DBot. It never presses Run.
import { fetchFreeBotById, loadBotXmlIntoBuilder } from '../pages/FreeBotsPage';
import { configureScannerBot, SCANNER_BOTS, type ScannerBot, type ScannerContract, type ScannerSignal } from './scanner-bots';

type Fetched = { name: string; xml: string };

// Bot XML kept in memory. A tab left open for a long time can have later requests refused (HTTP 401 once the site's access
// session expires); a bot downloaded earlier still loads, so the scanner downloads both when it opens and reuses them.
const cache = new Map<string, Fetched>();
const pending = new Map<string, Promise<Fetched>>();

const download = (bot: ScannerBot): Promise<Fetched> => {
    const running = pending.get(bot.id);
    if (running) return running;
    const request = fetchFreeBotById(bot.id)
        .then(({ bot: entry, xml }) => {
            const fetched = { name: entry.name || entry.title || bot.name, xml };
            cache.set(bot.id, fetched);
            return fetched;
        })
        .finally(() => pending.delete(bot.id));
    pending.set(bot.id, request);
    return request;
};

/** Downloads both bots in the background. Failures are ignored here: loading a bot reports its own error. */
export const prefetchScannerBots = (): void => {
    Object.values(SCANNER_BOTS).forEach(bot => { void download(bot).catch(() => undefined); });
};

/** The cached bot when there is one, otherwise a fresh download. A refused download falls back to the cache if one exists. */
const botXml = async (bot: ScannerBot): Promise<Fetched> => {
    const cached = cache.get(bot.id);
    if (cached) return cached;
    try {
        return await download(bot);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            /401|403/.test(reason)
                ? `Bot ${bot.number} (${bot.name}) was refused by the site (${reason}). Reload the page, sign in again, then press Load Matching Bot.`
                : reason,
        );
    }
};

export type ScannerLoadOutcome = { bot: ScannerBot; botName: string };

/**
 * Picks the bot for the signal's side, writes the market and barrier into it, checks the result, opens Bot Builder and loads it.
 * Everything is validated BEFORE Bot Builder opens, so a mismatched bot never reaches Blockly.
 */
export const loadSignalIntoScannerBot = async (
    signal: ScannerSignal, openBotBuilder: () => void,
): Promise<ScannerLoadOutcome> => {
    const bot = SCANNER_BOTS[signal.contract as ScannerContract];
    if (!bot) throw new Error(`No scanner bot is set for ${signal.contract}.`);
    const { name, xml } = await botXml(bot);
    const configured = configureScannerBot(xml, signal);
    openBotBuilder();
    await loadBotXmlIntoBuilder(
        configured,
        `AI ${signal.symbol} ${signal.contract === 'DIGITOVER' ? 'Over' : 'Under'} ${signal.barrier} (bot ${bot.number}).xml`,
    );
    return { bot, botName: name };
};
