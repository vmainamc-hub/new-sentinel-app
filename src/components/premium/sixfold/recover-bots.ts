// SIXFOLD -> BOT BUILDER. Loads a Sixfold signal into one of the two "Recover ... Bandwagon No Entry" bots. It never presses Run.
//
// The bots have no entry condition, so they buy as soon as they are started. Configuring a bot ONLY writes values it already
// has: the market fields and the first number in its "Prediction List" (the barrier it trades first, because the bot starts
// with Prediction = 1). Everything else, including stake, martingale, take profit and the rest of the list, stays the bot's own.
// No block is added, removed or moved. The result is read back from the XML and checked before Bot Builder opens.

import { submarketFor } from '../ai-scanner/scanner-bots';
import { fetchFreeBotById, loadBotXmlIntoBuilder } from '../pages/FreeBotsPage';

export type RecoverContract = 'DIGITOVER' | 'DIGITUNDER';

export type RecoverSignal = {
    symbol: string;
    contract: RecoverContract;
    barrier: number;
    submarket?: string;
};

export type RecoverBot = {
    /** Manifest id in public/free-bots/domains/apex-sentinel.json. */
    id: string;
    number: number;
    name: string;
    contract: RecoverContract;
};

export const RECOVER_BOTS: Record<RecoverContract, RecoverBot> = {
    DIGITUNDER: {
        id: 'recover-under-bandwagon-no-entry',
        number: 106,
        name: 'Recover Under Bandwagon No Entry',
        contract: 'DIGITUNDER',
    },
    DIGITOVER: {
        id: 'recover-over-bandwagon-no-entry',
        number: 107,
        name: 'Recover Over Bandwagon No Entry',
        contract: 'DIGITOVER',
    },
};

export const LIST_VARIABLE = 'Prediction List';
export const POINTER_VARIABLE = 'Prediction';

/** Over barriers run 0-8 and Under barriers 1-9 on Deriv. */
export const isValidBarrier = (contract: RecoverContract, barrier: number): boolean =>
    Number.isInteger(barrier) &&
    (contract === 'DIGITOVER' ? barrier >= 0 && barrier <= 8 : barrier >= 1 && barrier <= 9);

const parse = (xml: string): Document => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The bot XML is not valid.');
    return doc;
};

const direct = (element: Element, tag: string, name?: string): Element | undefined =>
    Array.from(element.children).find(
        child => child.localName === tag && (!name || child.getAttribute('name') === name)
    );

const blocksOf = (scope: Document | Element, type: string): Element[] =>
    Array.from(scope.getElementsByTagName('block')).filter(block => block.getAttribute('type') === type);

const fieldOf = (doc: Document, name: string): Element => {
    const field = Array.from(doc.getElementsByTagName('field')).find(item => item.getAttribute('name') === name);
    if (!field) throw new Error(`The bot has no ${name} field.`);
    return field;
};

/** The plain number held in a value input (a real block wins over its shadow). */
const numberOf = (value: Element | undefined): Element | undefined => {
    if (!value) return undefined;
    const holder =
        Array.from(value.children).find(c => c.localName === 'block') ??
        Array.from(value.children).find(c => c.localName === 'shadow');
    return holder?.getAttribute('type') === 'math_number' ? direct(holder, 'field', 'NUM') : undefined;
};

/** The numbers of the Prediction List, in order, as the bot builds it. */
const listItems = (doc: Document): Element[] => {
    const lists = blocksOf(doc, 'lists_create_with').filter(
        b => direct(b, 'field', 'VARIABLE')?.textContent?.trim() === LIST_VARIABLE
    );
    if (lists.length !== 1)
        throw new Error(`The bot must build "${LIST_VARIABLE}" exactly once (found ${lists.length}).`);
    const items: Element[] = [];
    let node: Element | undefined = direct(direct(lists[0], 'statement', 'STACK') ?? lists[0], 'block');
    while (node && node.getAttribute('type') === 'lists_statement') {
        const field = numberOf(direct(node, 'value', 'VALUE'));
        if (!field) throw new Error('The Prediction List holds something other than plain numbers.');
        items.push(field);
        const next = direct(node, 'next');
        node = next ? direct(next, 'block') : undefined;
    }
    if (!items.length) throw new Error('The Prediction List is empty.');
    return items;
};

/** What the "Start Info" procedure sets Prediction to (the list position the bot trades first). */
const startPointer = (doc: Document): number => {
    const hits = blocksOf(doc, 'variables_set').filter(block => {
        if (direct(block, 'field', 'VAR')?.textContent?.trim() !== POINTER_VARIABLE) return false;
        for (let n = block.parentElement; n; n = n.parentElement)
            if (n.localName === 'block' && n.getAttribute('type') === 'procedures_defnoreturn') return true;
        return false;
    });
    const field = hits.length === 1 ? numberOf(direct(hits[0], 'value', 'VALUE')) : undefined;
    if (!field) throw new Error(`The bot must set ${POINTER_VARIABLE} to a plain number once at the start.`);
    return Number(field.textContent);
};

const purchases = (doc: Document): string[] =>
    ['purchase', 'apollo_purchase']
        .flatMap(type => blocksOf(doc, type))
        .map(b => direct(b, 'field', 'PURCHASE_LIST')?.textContent?.trim() ?? '');

export type RecoverReadback = {
    symbol: string;
    submarket: string;
    market: string;
    tradeType: string;
    purchases: string[];
    list: number[];
    start: number;
    first: number;
};

export const readRecoverBot = (xml: string): RecoverReadback => {
    const doc = parse(xml);
    const list = listItems(doc).map(f => Number(f.textContent));
    const start = startPointer(doc);
    return {
        symbol: fieldOf(doc, 'SYMBOL_LIST').textContent ?? '',
        submarket: fieldOf(doc, 'SUBMARKET_LIST').textContent ?? '',
        market: fieldOf(doc, 'MARKET_LIST').textContent ?? '',
        tradeType: fieldOf(doc, 'TRADETYPE_LIST').textContent ?? '',
        purchases: purchases(doc),
        list,
        start,
        first: list[start - 1],
    };
};

export const structureOf = (xml: string): string[] =>
    Array.from(parse(xml).getElementsByTagName('block')).map(b => b.getAttribute('type') ?? '');

export const verifyRecoverBot = (xml: string, signal: RecoverSignal): void => {
    const bot = readRecoverBot(xml);
    const fail = (message: string): never => {
        throw new Error(`Bot check failed: ${message}`);
    };
    if (bot.market !== 'synthetic_index') fail(`market is ${bot.market}.`);
    if (bot.symbol !== signal.symbol) fail(`market symbol is ${bot.symbol}, expected ${signal.symbol}.`);
    if (bot.submarket !== submarketFor(signal.symbol, signal.submarket)) fail(`submarket is ${bot.submarket}.`);
    if (bot.tradeType !== 'overunder') fail(`trade type is ${bot.tradeType}.`);
    if (!bot.purchases.length || bot.purchases.some(p => p !== signal.contract)) {
        fail(`the bot buys ${bot.purchases.join('/') || 'nothing'} but the signal is ${signal.contract}.`);
    }
    if (bot.first !== signal.barrier) fail(`first barrier is ${bot.first}, expected ${signal.barrier}.`);
};

/** Returns the bot XML configured for the signal. Throws, with a plain reason, instead of producing a mismatched bot. */
export const configureRecoverBot = (xml: string, signal: RecoverSignal): string => {
    if (!isValidBarrier(signal.contract, signal.barrier)) {
        throw new Error(
            `${signal.contract === 'DIGITOVER' ? 'Over' : 'Under'} ${signal.barrier} is not a valid contract.`
        );
    }
    const doc = parse(xml);
    fieldOf(doc, 'MARKET_LIST').textContent = 'synthetic_index';
    fieldOf(doc, 'SUBMARKET_LIST').textContent = submarketFor(signal.symbol, signal.submarket);
    fieldOf(doc, 'SYMBOL_LIST').textContent = signal.symbol;
    const items = listItems(doc);
    const pointer = startPointer(doc);
    if (pointer < 1 || pointer > items.length)
        throw new Error(`The bot starts at list position ${pointer}, which is outside its list.`);
    items[pointer - 1].textContent = String(signal.barrier);
    // An empty <next/> carries no block; Blockly does not need it.
    Array.from(doc.getElementsByTagName('next'))
        .filter(n => n.children.length === 0)
        .forEach(n => n.remove());
    const result = new XMLSerializer().serializeToString(doc.documentElement);
    verifyRecoverBot(result, signal);
    return result;
};

// ---- download + load, same pattern as the AI Entry Scanner ----
type Fetched = { name: string; xml: string };
const cache = new Map<string, Fetched>();
const pending = new Map<string, Promise<Fetched>>();

const download = (bot: RecoverBot): Promise<Fetched> => {
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

/** Downloads both bots in the background so a later load still works if the site's access session expires. */
export const prefetchRecoverBots = (): void => {
    Object.values(RECOVER_BOTS).forEach(bot => {
        void download(bot).catch(() => undefined);
    });
};

const botXml = async (bot: RecoverBot): Promise<Fetched> => {
    const cached = cache.get(bot.id);
    if (cached) return cached;
    try {
        return await download(bot);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
            /401|403/.test(reason)
                ? `Bot ${bot.number} (${bot.name}) was refused by the site (${reason}). Reload the page, sign in again, then try again.`
                : reason
        );
    }
};

export const loadSignalIntoRecoverBot = async (
    signal: RecoverSignal,
    openBotBuilder: () => void
): Promise<{ bot: RecoverBot; botName: string }> => {
    const bot = RECOVER_BOTS[signal.contract];
    const { name, xml } = await botXml(bot);
    const configured = configureRecoverBot(xml, signal);
    openBotBuilder();
    await loadBotXmlIntoBuilder(
        configured,
        `Sixfold ${signal.symbol} ${signal.contract === 'DIGITOVER' ? 'Over' : 'Under'} ${signal.barrier} (bot ${bot.number}).xml`
    );
    return { bot, botName: name };
};
