// AI ENTRY SCANNER: the two bots it loads, and how a scan result is written into them.
//
// Under signals load bot 11 (D2 BY MR.DUKE, buys DIGITUNDER) and Over signals load bot 26 (OVER 1 RECOVERY OVER 4, buys DIGITOVER).
// They are resolved by manifest id (the way Signal Zone does it), never by file path.
//
// Configuring a bot ONLY sets values the bot already has: the market fields and the main barrier. It never adds, removes or
// moves a block and never edits a purchase block, so each bot keeps its own stake, martingale and recovery logic. Everything
// written is read back from the serialised XML and checked before the bot is handed to Blockly.

export type ScannerContract = 'DIGITOVER' | 'DIGITUNDER';

export type ScannerSignal = {
    symbol: string;
    contract: ScannerContract;
    barrier: number;
    /** The submarket DBot lists the symbol under (from the live active symbols when known). */
    submarket?: string;
};

export type ScannerBot = {
    /** Manifest id in public/free-bots. */
    id: string;
    /** The bot's number in the Free Bots list. */
    number: number;
    name: string;
    contract: ScannerContract;
    /** What the bot does after a loss. It trades its own direction only, so this is fixed by the bot. */
    recovery: { contract: ScannerContract; barrier: number };
};

export const SCANNER_BOTS: Record<ScannerContract, ScannerBot> = {
    DIGITUNDER: {
        id: 'd2-by-mr-duke',
        number: 11,
        name: 'D2 BY MR.DUKE',
        contract: 'DIGITUNDER',
        recovery: { contract: 'DIGITUNDER', barrier: 4 },
    },
    DIGITOVER: {
        id: 'over-1-recovery-over-4',
        number: 26,
        name: 'OVER 1 RECOVERY OVER 4',
        contract: 'DIGITOVER',
        recovery: { contract: 'DIGITOVER', barrier: 4 },
    },
};

const parse = (xml: string): Document => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The scanner bot XML is not valid.');
    return doc;
};

const direct = (element: Element, tag: string, name?: string): Element | undefined =>
    Array.from(element.children).find(child => child.localName === tag && (!name || child.getAttribute('name') === name));

const blocksOf = (scope: Document | Element, type: string): Element[] =>
    Array.from(scope.getElementsByTagName('block')).filter(block => block.getAttribute('type') === type);

const fieldOf = (doc: Document, name: string): Element => {
    const field = Array.from(doc.getElementsByTagName('field')).find(item => item.getAttribute('name') === name);
    if (!field) throw new Error(`The scanner bot has no ${name} field.`);
    return field;
};

const inInitialization = (element: Element): boolean => {
    for (let node = element.parentElement; node; node = node.parentElement) {
        if (node.localName === 'statement' && node.getAttribute('name') === 'INITIALIZATION') return true;
    }
    return false;
};

/**
 * The NUM field of the number held directly in a value input. Blockly stores a placeholder `shadow` next to a real block when a
 * value was typed in, and the real block is what the bot uses, so a real math_number block wins over its shadow. A real block of
 * any other type (a variable, a sum) means the value is not a plain number and nothing is returned.
 */
const numberFieldOfValue = (value: Element | undefined): Element | undefined => {
    if (!value) return undefined;
    const real = Array.from(value.children).find(child => child.localName === 'block');
    const holder = real ?? Array.from(value.children).find(child => child.localName === 'shadow');
    return holder?.getAttribute('type') === 'math_number' ? direct(holder, 'field', 'NUM') : undefined;
};

/** Bot 26: the numeric field of the single initial `variables_set` for `variable`. */
const initialVariableField = (doc: Document, variable: string): Element => {
    const hits = blocksOf(doc, 'variables_set').filter(block =>
        inInitialization(block) && direct(block, 'field', 'VAR')?.textContent?.trim() === variable);
    if (hits.length !== 1) throw new Error(`The bot must set "${variable}" exactly once at the start (found ${hits.length}).`);
    const field = numberFieldOfValue(direct(hits[0], 'value', 'VALUE'));
    if (!field) throw new Error(`"${variable}" is not set from a plain number in the bot.`);
    return field;
};

/**
 * Bot 11 sets `predict 3` from a `random integer from N to N` block in four places, in document order: the first trade, after a
 * win, after a loss (the three main-barrier draws), and the recovery draw. They are found by what they feed, never by their
 * current number, so the same lookup works on the shipped bot and on a configured one. Each draw is its FROM and TO field.
 */
const predictDraws = (doc: Document): Element[][] => {
    const draws = blocksOf(doc, 'math_random_int').filter(block => {
        const input = block.parentElement;
        const set = input?.parentElement;
        return input?.localName === 'value' && input.getAttribute('name') === 'VALUE'
            && set?.getAttribute('type') === 'variables_set'
            && direct(set, 'field', 'VAR')?.textContent?.trim() === 'predict 3';
    }).map(block => [numberFieldOfValue(direct(block, 'value', 'FROM')), numberFieldOfValue(direct(block, 'value', 'TO'))]);
    if (draws.length !== 4 || draws.some(pair => !pair[0] || !pair[1])) {
        throw new Error(`Bot 11 should draw "predict 3" in 4 places (found ${draws.length}).`);
    }
    return draws as Element[][];
};

/** The main-barrier fields of a bot, in document order. */
const barrierFields = (doc: Document, contract: ScannerContract): Element[] => {
    if (contract === 'DIGITOVER') return [initialVariableField(doc, 'Over Prediction')];
    const main = predictDraws(doc).slice(0, 3).flat();
    // The three draws are one barrier written three times; a bot whose draws disagree is not the bot this was written for.
    if (new Set(main.map(field => field.textContent)).size !== 1) throw new Error('Bot 11 draws different main barriers in different places.');
    return main;
};

/** The recovery barrier of a bot: what it plays after a loss. The scanner never writes it. */
const recoveryField = (doc: Document, contract: ScannerContract): Element =>
    contract === 'DIGITOVER' ? initialVariableField(doc, 'Recovery Prediction') : predictDraws(doc)[3][0];

const purchaseContracts = (doc: Document): string[] =>
    blocksOf(doc, 'apollo_purchase').map(block => direct(block, 'field', 'PURCHASE_LIST')?.textContent?.trim() ?? '');

export type ScannerBotReadback = {
    market: string;
    submarket: string;
    symbol: string;
    tradeType: string;
    purchases: string[];
    barriers: number[];
    recovery: number;
};

/** Reads back everything the scanner writes, plus the purchase contracts it must not change. */
export const readScannerBot = (xml: string, contract: ScannerContract): ScannerBotReadback => {
    const doc = parse(xml);
    return {
        market: fieldOf(doc, 'MARKET_LIST').textContent ?? '',
        submarket: fieldOf(doc, 'SUBMARKET_LIST').textContent ?? '',
        symbol: fieldOf(doc, 'SYMBOL_LIST').textContent ?? '',
        tradeType: fieldOf(doc, 'TRADETYPE_LIST').textContent ?? '',
        purchases: purchaseContracts(doc),
        barriers: barrierFields(doc, contract).map(field => Number(field.textContent)),
        recovery: Number(recoveryField(doc, contract).textContent),
    };
};

/** Block types in document order: proves configuring a bot never changes its structure. */
export const structureOf = (xml: string): string[] =>
    Array.from(parse(xml).getElementsByTagName('block')).map(block => block.getAttribute('type') ?? '');

export const submarketFor = (symbol: string, known?: string): string =>
    known || (symbol.startsWith('1HZ') ? 'random_index_1s' : 'random_index');

/** Throws when the bot does not carry exactly what the signal calls for. */
export const verifyScannerBot = (xml: string, signal: ScannerSignal): void => {
    const bot = readScannerBot(xml, signal.contract);
    const fail = (message: string): never => { throw new Error(`Bot check failed: ${message}`); };
    if (bot.market !== 'synthetic_index') fail(`market is ${bot.market}.`);
    if (bot.symbol !== signal.symbol) fail(`market symbol is ${bot.symbol}, expected ${signal.symbol}.`);
    if (bot.submarket !== submarketFor(signal.symbol, signal.submarket)) fail(`submarket is ${bot.submarket}.`);
    if (bot.tradeType !== 'overunder') fail(`trade type is ${bot.tradeType}.`);
    if (!bot.purchases.length || bot.purchases.some(purchase => purchase !== signal.contract)) {
        fail(`the bot buys ${bot.purchases.join('/') || 'nothing'} but the signal is ${signal.contract}.`);
    }
    if (!bot.barriers.length || bot.barriers.some(barrier => barrier !== signal.barrier)) {
        fail(`barrier is ${bot.barriers.join(', ')}, expected ${signal.barrier}.`);
    }
    const recovery = SCANNER_BOTS[signal.contract].recovery.barrier;
    if (bot.recovery !== recovery) fail(`recovery barrier is ${bot.recovery}, the bot's own is ${recovery}.`);
};

/** Returns the bot XML configured for the signal. Throws (with a plain reason) instead of producing a mismatched bot. */
export const configureScannerBot = (xml: string, signal: ScannerSignal): string => {
    if (!Number.isInteger(signal.barrier) || signal.barrier < 0 || signal.barrier > 9) {
        throw new Error(`${signal.barrier} is not a valid digit barrier.`);
    }
    const doc = parse(xml);
    fieldOf(doc, 'MARKET_LIST').textContent = 'synthetic_index';
    fieldOf(doc, 'SUBMARKET_LIST').textContent = submarketFor(signal.symbol, signal.submarket);
    fieldOf(doc, 'SYMBOL_LIST').textContent = signal.symbol;
    barrierFields(doc, signal.contract).forEach(field => { field.textContent = String(signal.barrier); });
    const result = new XMLSerializer().serializeToString(doc.documentElement);
    verifyScannerBot(result, signal);
    return result;
};
