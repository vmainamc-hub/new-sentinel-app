// SIGNAL ZONE: writes a signal and the user's settings into a Masika Strike bot (DBot XML). Pure apart from DOMParser.
//
// It ONLY sets values of fields and variables the bots already have. It never adds, removes or moves a block, and it never
// edits the purchase block (the Over bot buys DIGITOVER and the Under bot buys DIGITUNDER). Everything it writes is read back
// from the serialised XML and checked before the bot is handed to Blockly.

import { ALLOWED_BARRIERS, isAllowedContract, type OverUnderContract } from '../over-under-engine';
import { MIN_STAKE, type SignalZoneSettings } from './signal-zone-settings';

/** The two free bots, resolved by id from the free-bots manifest (never by file path). */
export const MASIKA_BOT_IDS: Record<OverUnderContract, string> = {
    DIGITOVER: 'apex-library-the-masika-strike-over-bot-50',
    DIGITUNDER: 'apex-library-the-masika-strike-under-bot-51',
};

export type BotSignal = { symbol: string; contract: OverUnderContract; barrier: number; entryDigit: number };
export type BotSettings = Pick<
    SignalZoneSettings,
    'stake' | 'martingaleMultiplier' | 'martingaleLevel' | 'takeProfit' | 'maxStake' | 'recoveryOverBarrier' | 'recoveryUnderBarrier'
>;
export type ActiveSymbolLike = { symbol?: string; market?: string; submarket?: string };

/** Variable name in the bot -> the number written to it. */
export const variableValues = (signal: BotSignal, settings: BotSettings): Record<string, number> => ({
    Stake: settings.stake,
    Martangle: settings.martingaleMultiplier,
    'Martangle Level': settings.martingaleLevel,
    'Take Profit': settings.takeProfit,
    'Max Stake': settings.maxStake,
    'Entry Point': signal.entryDigit,
});

/**
 * The bot reads `Prediction List[Prediction]`: slot 1 is the first trade, slot 2 is used after a win, slot 3 after the first
 * loss and slot 4 after further losses. So the signal's barrier fills slots 1-2 and the recovery barrier of the same side fills 3-4.
 */
export const predictionListFor = (signal: BotSignal, settings: BotSettings): number[] => {
    const recovery = signal.contract === 'DIGITOVER' ? settings.recoveryOverBarrier : settings.recoveryUnderBarrier;
    return [signal.barrier, signal.barrier, recovery, recovery];
};

/**
 * The submarket DBot lists the symbol under. Taken from the live active symbols when available. The fallback is the value the
 * shipped Masika Under bot uses for a 1-second market (`random_index`), which is what Deriv's own bots carry.
 */
export const submarketFor = (symbol: string, active?: ActiveSymbolLike[]): string => {
    const match = active?.find(item => item.symbol === symbol && item.submarket);
    return match?.submarket || 'random_index';
};

const parse = (xml: string): Document => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The bot XML is not valid.');
    return doc;
};

const direct = (element: Element, tag: string, name?: string): Element | undefined =>
    Array.from(element.children).find(child => child.localName === tag && (!name || child.getAttribute('name') === name));

const blocksOf = (doc: Document | Element, type: string): Element[] =>
    Array.from(doc.getElementsByTagName('block')).filter(block => block.getAttribute('type') === type);

const inInitialization = (element: Element): boolean => {
    for (let node = element.parentElement; node; node = node.parentElement) {
        if (node.localName === 'statement' && node.getAttribute('name') === 'INITIALIZATION') return true;
    }
    return false;
};

const fieldOf = (doc: Document, name: string): Element => {
    const field = Array.from(doc.getElementsByTagName('field')).find(item => item.getAttribute('name') === name);
    if (!field) throw new Error(`The bot has no ${name} field.`);
    return field;
};

/** The numeric field of the initial `variables_set` block for `variable`. Exactly one must exist. */
const variableNumberField = (doc: Document, variable: string): Element => {
    const hits = blocksOf(doc, 'variables_set').filter(block =>
        inInitialization(block) && direct(block, 'field', 'VAR')?.textContent?.trim() === variable);
    if (hits.length !== 1) throw new Error(`The bot must set "${variable}" exactly once at the start (found ${hits.length}).`);
    const value = direct(hits[0], 'value', 'VALUE');
    const numberBlock = value ? direct(value, 'block') : undefined;
    const field = numberBlock?.getAttribute('type') === 'math_number' ? direct(numberBlock, 'field', 'NUM') : undefined;
    if (!field) throw new Error(`"${variable}" is not set from a plain number in the bot.`);
    return field;
};

const predictionFields = (doc: Document): Element[] => {
    const lists = blocksOf(doc, 'lists_create_with').filter(block =>
        inInitialization(block) && direct(block, 'field', 'VARIABLE')?.textContent?.trim() === 'Prediction List');
    if (lists.length !== 1) throw new Error(`The bot must build "Prediction List" exactly once (found ${lists.length}).`);
    const slots = blocksOf(lists[0], 'lists_statement').map(block =>
        Array.from(block.getElementsByTagName('field')).find(field => field.getAttribute('name') === 'NUM'));
    if (slots.length !== 4 || slots.some(slot => !slot)) throw new Error('"Prediction List" must hold exactly four numbers.');
    return slots as Element[];
};

const purchaseContract = (doc: Document): string => {
    const before = blocksOf(doc, 'before_purchase')[0];
    const purchases = before ? blocksOf(before, 'purchase') : [];
    if (purchases.length !== 1) throw new Error(`The bot must have exactly one purchase block (found ${purchases.length}).`);
    return Array.from(purchases[0].getElementsByTagName('field')).find(field => field.getAttribute('name') === 'PURCHASE_LIST')?.textContent?.trim() ?? '';
};

export type BotReadback = {
    market: string;
    submarket: string;
    symbol: string;
    tradeType: string;
    purchase: string;
    variables: Record<string, number>;
    predictions: number[];
};

/** Reads back everything Signal Zone writes (and the purchase contract it must not change). */
export const readBot = (xml: string): BotReadback => {
    const doc = parse(xml);
    const variables: Record<string, number> = {};
    for (const name of Object.keys(variableValues({ symbol: '', contract: 'DIGITOVER', barrier: 0, entryDigit: 0 }, {
        stake: 0, martingaleMultiplier: 0, martingaleLevel: 0, takeProfit: 0, maxStake: 0, recoveryOverBarrier: 0, recoveryUnderBarrier: 0,
    }))) variables[name] = Number(variableNumberField(doc, name).textContent);
    return {
        market: fieldOf(doc, 'MARKET_LIST').textContent ?? '',
        submarket: fieldOf(doc, 'SUBMARKET_LIST').textContent ?? '',
        symbol: fieldOf(doc, 'SYMBOL_LIST').textContent ?? '',
        tradeType: fieldOf(doc, 'TRADETYPE_LIST').textContent ?? '',
        purchase: purchaseContract(doc),
        variables,
        predictions: predictionFields(doc).map(slot => Number(slot.textContent)),
    };
};

/** Block types in document order: used to prove that configuring a bot never changes its structure. */
export const structureOf = (xml: string): string[] =>
    Array.from(parse(xml).getElementsByTagName('block')).map(block => block.getAttribute('type') ?? '');

/** Throws when the bot does not carry exactly what the signal and settings call for. */
export const verifyBot = (xml: string, signal: BotSignal, settings: BotSettings, active?: ActiveSymbolLike[]): void => {
    const bot = readBot(xml);
    const fail = (message: string): never => { throw new Error(`Bot check failed: ${message}`); };
    if (!isAllowedContract(signal.contract, signal.barrier)) fail(`${signal.contract} ${signal.barrier} is not a permitted contract.`);
    if (bot.market !== 'synthetic_index') fail(`market is ${bot.market}.`);
    if (bot.symbol !== signal.symbol) fail(`market symbol is ${bot.symbol}, expected ${signal.symbol}.`);
    if (bot.submarket !== submarketFor(signal.symbol, active)) fail(`submarket is ${bot.submarket}.`);
    if (bot.tradeType !== 'overunder') fail(`trade type is ${bot.tradeType}.`);
    if (bot.purchase !== signal.contract) fail(`the bot buys ${bot.purchase} but the signal is ${signal.contract}.`);
    if (!Number.isInteger(signal.entryDigit) || signal.entryDigit < 0 || signal.entryDigit > 9) fail('the entry digit must be a digit from 0 to 9.');
    const expected = variableValues(signal, settings);
    for (const [name, value] of Object.entries(expected)) {
        if (!(bot.variables[name] === value)) fail(`"${name}" is ${bot.variables[name]}, expected ${value}.`);
    }
    if (!(settings.stake >= MIN_STAKE)) fail(`stake is below ${MIN_STAKE}.`);
    if (!(settings.maxStake >= settings.stake)) fail('max stake is below the stake.');
    const wanted = predictionListFor(signal, settings);
    if (bot.predictions.length !== 4 || bot.predictions.some((n, i) => n !== wanted[i])) fail(`prediction list is ${bot.predictions.join(', ')}, expected ${wanted.join(', ')}.`);
    const permitted = ALLOWED_BARRIERS[signal.contract];
    if (bot.predictions.some(n => !permitted.includes(n))) fail(`prediction list ${bot.predictions.join(', ')} holds a barrier outside ${permitted.join('/')}.`);
};

/** Returns the bot XML configured for the signal. Throws (with a plain reason) instead of producing a mismatched bot. */
export const configureMasikaBot = (xml: string, signal: BotSignal, settings: BotSettings, active?: ActiveSymbolLike[]): string => {
    const doc = parse(xml);
    fieldOf(doc, 'MARKET_LIST').textContent = 'synthetic_index';
    fieldOf(doc, 'SUBMARKET_LIST').textContent = submarketFor(signal.symbol, active);
    fieldOf(doc, 'SYMBOL_LIST').textContent = signal.symbol;
    // The contract is never edited: the Over bot buys DIGITOVER, the Under bot DIGITUNDER. A wrong pairing is caught by verifyBot.
    for (const [name, value] of Object.entries(variableValues(signal, settings))) variableNumberField(doc, name).textContent = String(value);
    predictionListFor(signal, settings).forEach((value, index) => { predictionFields(doc)[index].textContent = String(value); });
    const result = new XMLSerializer().serializeToString(doc.documentElement);
    verifyBot(result, signal, settings, active);
    return result;
};
