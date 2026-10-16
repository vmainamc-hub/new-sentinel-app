// DIGITS ANALYSIS: loads the #1 ranked market into Bot Builder using site bot 104 (Under) or 105 (Over). It never presses Run.
//
// Only the market and the prediction list of the bot are changed. Stake, take profit, martingale and the purchase block stay exactly
// as shipped in the bot. The result is read back and checked BEFORE Bot Builder opens, so a mismatched bot never reaches Blockly.
import { PremiumDerivApiService } from '@/services/premium-deriv-api.service';
import type { RankedMarket, Trade } from './apex-logic';
import { fetchFreeBotById, loadBotXmlIntoBuilder } from './pages/FreeBotsPage';
import { submarketFor, type ActiveSymbolLike } from './signal-zone/signal-zone-bot';

/** The two bots, resolved by id from the free-bots manifest (never by file path). */
export const DIGITS_BOT_IDS = {
    DIGITOVER: 'apex-library-masika-strategies-digit-over-without-entry-digit-105',
    DIGITUNDER: 'apex-library-masika-strategies-digit-under-without-entry-digit-104',
} as const;

export type DigitsContract = keyof typeof DIGITS_BOT_IDS;

/**
 * The bot reads its barrier from a 4-slot "Prediction List" by the Prediction variable: slot 1 is the first trade, slot 2 the trade
 * after a win, slot 3 the trade after the first loss and slot 4 every trade after that. So the first two slots are the normal digit
 * and the last two are the digit used on a loss:  Over 2 (Over 3 on loss) and Under 7 (Under 6 on loss).
 */
export const PREDICTION_LISTS: Record<DigitsContract, readonly [number, number, number, number]> = {
    DIGITOVER: [2, 2, 3, 3],
    DIGITUNDER: [7, 7, 6, 6],
};

/** Over trades use the Over bot (105), Under trades the Under bot (104). Even/Odd has no bot. */
export const contractForTrade = (trade: Trade): DigitsContract | null => {
    if (trade.side === 'over') return 'DIGITOVER';
    if (trade.side === 'under') return 'DIGITUNDER';
    return null;
};

const parse = (xml: string): Document => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The bot XML is not valid.');
    return doc;
};

const fieldsNamed = (doc: Document, name: string): Element[] =>
    Array.from(doc.getElementsByTagName('field')).filter(field => field.getAttribute('name') === name);

const onlyField = (doc: Document, name: string): Element => {
    const hits = fieldsNamed(doc, name);
    if (hits.length !== 1) throw new Error(`The bot must have exactly one ${name} field (found ${hits.length}).`);
    return hits[0];
};

/** The contract the bot buys, read from its single purchase block. */
export const purchaseOf = (xml: string): string => {
    const doc = parse(xml);
    const before = Array.from(doc.getElementsByTagName('block')).filter(block => block.getAttribute('type') === 'before_purchase');
    const purchases = before.flatMap(block =>
        Array.from(block.getElementsByTagName('block')).filter(item => item.getAttribute('type') === 'purchase'));
    if (purchases.length !== 1) throw new Error(`The bot must have exactly one purchase block (found ${purchases.length}).`);
    return Array.from(purchases[0].getElementsByTagName('field')).find(field => field.getAttribute('name') === 'PURCHASE_LIST')?.textContent?.trim() ?? '';
};

export const marketOf = (xml: string) => {
    const doc = parse(xml);
    return {
        market: onlyField(doc, 'MARKET_LIST').textContent ?? '',
        submarket: onlyField(doc, 'SUBMARKET_LIST').textContent ?? '',
        symbol: onlyField(doc, 'SYMBOL_LIST').textContent ?? '',
    };
};

const LIST_BLOCK_ID = 'prediction-list';

const listBlock = (doc: Document): Element => {
    const hits = Array.from(doc.getElementsByTagName('block')).filter(
        block => block.getAttribute('type') === 'lists_create_with' && block.getAttribute('id') === LIST_BLOCK_ID);
    if (hits.length !== 1) throw new Error(`The bot must have exactly one prediction list (found ${hits.length}).`);
    return hits[0];
};

/** The digits in the bot's prediction list, in slot order. */
export const predictionListOf = (xml: string): number[] =>
    Array.from(listBlock(parse(xml)).getElementsByTagName('field'))
        .filter(field => field.getAttribute('name') === 'NUM')
        .map(field => Number(field.textContent));

/** Returns the bot XML pointed at `symbol`. Throws (with a plain reason) instead of producing a mismatched bot. */
export const configureDigitsBot = (xml: string, symbol: string, contract: DigitsContract, active?: ActiveSymbolLike[]): string => {
    if (!symbol) throw new Error('There is no market to load.');
    const doc = parse(xml);
    onlyField(doc, 'MARKET_LIST').textContent = 'synthetic_index';
    onlyField(doc, 'SUBMARKET_LIST').textContent = submarketFor(symbol, active);
    onlyField(doc, 'SYMBOL_LIST').textContent = symbol;

    const wanted = PREDICTION_LISTS[contract];
    const slots = Array.from(listBlock(doc).getElementsByTagName('field')).filter(field => field.getAttribute('name') === 'NUM');
    if (slots.length !== wanted.length) throw new Error(`The bot prediction list has ${slots.length} digits, expected ${wanted.length}.`);
    slots.forEach((field, index) => { field.textContent = String(wanted[index]); });
    const result = new XMLSerializer().serializeToString(doc.documentElement);

    const bot = marketOf(result);
    if (bot.market !== 'synthetic_index') throw new Error(`Bot check failed: market is ${bot.market}.`);
    if (bot.symbol !== symbol) throw new Error(`Bot check failed: market symbol is ${bot.symbol}, expected ${symbol}.`);
    if (bot.submarket !== submarketFor(symbol, active)) throw new Error(`Bot check failed: submarket is ${bot.submarket}.`);
    const list = predictionListOf(result);
    if (list.join(',') !== wanted.join(',')) throw new Error(`Bot check failed: prediction list is ${list.join(', ')}.`);
    const purchase = purchaseOf(result);
    if (purchase !== contract) throw new Error(`Bot check failed: the bot buys ${purchase} but the signal is ${contract}.`);
    return result;
};

const activeSymbols = async (): Promise<ActiveSymbolLike[] | undefined> => {
    try {
        return await PremiumDerivApiService.activeSymbols();
    } catch {
        return undefined; // only means the fallback submarket is used
    }
};

export type DigitsLoadOutcome = { botName: string; summary: string };

/** Fetches the right bot, points it at the ranked market and sets its prediction list, checks it, opens Bot Builder and loads it. */
export const loadBestMarketIntoBot = async (best: RankedMarket, openBotBuilder: () => void): Promise<DigitsLoadOutcome> => {
    const contract = contractForTrade(best.trade);
    if (!contract) throw new Error('Only Over / Under signals have a bot. Switch Mode to Over / Under.');
    const { bot, xml } = await fetchFreeBotById(DIGITS_BOT_IDS[contract]);
    const configured = configureDigitsBot(xml, best.symbol, contract, await activeSymbols());
    const botName = bot.name || bot.title || bot.file;
    openBotBuilder();
    await loadBotXmlIntoBuilder(configured, `Digits Analysis ${best.symbol} ${best.trade.label}.xml`);
    return { botName, summary: `${best.trade.label} on ${best.name}` };
};
