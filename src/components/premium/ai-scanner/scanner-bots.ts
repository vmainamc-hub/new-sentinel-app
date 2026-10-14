// AI ENTRY SCANNER: the two bots it loads, and how a scan result is written into them.
//
// Under signals load bot 46 (Holy Grail, buys DIGITUNDER) and Over signals load bot 26 (OVER 1 RECOVERY OVER 4, buys DIGITOVER).
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
    /**
     * The two variables the bot sets once, from plain numbers, in its INITIALIZATION: the barrier it trades first (and after a
     * win), and the barrier it recovers on. Names are matched exactly, as the bot spells them. The scanner writes `main` only.
     */
    variables: { main: string; recovery: string };
};

export const SCANNER_BOTS: Record<ScannerContract, ScannerBot> = {
    DIGITUNDER: {
        id: 'apex-library-holy-grail-13',
        number: 46,
        name: 'Holy Grail',
        contract: 'DIGITUNDER',
        recovery: { contract: 'DIGITUNDER', barrier: 5 },
        variables: { main: 'STARTING PREDICTION', recovery: 'RECOVERY PREDICTION' },
    },
    DIGITOVER: {
        id: 'over-1-recovery-over-4',
        number: 26,
        name: 'OVER 1 RECOVERY OVER 4',
        contract: 'DIGITOVER',
        recovery: { contract: 'DIGITOVER', barrier: 4 },
        variables: { main: 'Over Prediction', recovery: 'Recovery Prediction' },
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

/** The numeric field of the single initial `variables_set` for `variable` (bots 26 and 46 both keep their barriers this way). */
const initialVariableField = (doc: Document, variable: string): Element => {
    const hits = blocksOf(doc, 'variables_set').filter(block =>
        inInitialization(block) && direct(block, 'field', 'VAR')?.textContent?.trim() === variable);
    if (hits.length !== 1) throw new Error(`The bot must set "${variable}" exactly once at the start (found ${hits.length}).`);
    const field = numberFieldOfValue(direct(hits[0], 'value', 'VALUE'));
    if (!field) throw new Error(`"${variable}" is not set from a plain number in the bot.`);
    return field;
};

/** The main-barrier fields of a bot: the one number it trades first and after a win. */
const barrierFields = (doc: Document, contract: ScannerContract): Element[] =>
    [initialVariableField(doc, SCANNER_BOTS[contract].variables.main)];

/** The recovery barrier of a bot: what it plays after a loss. The scanner never writes it. */
const recoveryField = (doc: Document, contract: ScannerContract): Element =>
    initialVariableField(doc, SCANNER_BOTS[contract].variables.recovery);

// Bots 26 and the other site bots buy with an `apollo_purchase` block; bot 46 (Holy Grail) uses the standard `purchase` block.
const PURCHASE_BLOCKS = ['apollo_purchase', 'purchase'];

const purchaseContracts = (doc: Document): string[] =>
    PURCHASE_BLOCKS.flatMap(type => blocksOf(doc, type))
        .map(block => direct(block, 'field', 'PURCHASE_LIST')?.textContent?.trim() ?? '');

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
