import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../../utils';

/*
 * Multi-market blocks. They let ONE strategy scan the digits of several markets on every tick and place the next
 * contract on whichever market qualifies. Runtime lives in services/tradeEngine/trade/MultiMarket.js.
 * The tick loop keeps following the market chosen in the Trade definition; only the purchase market changes.
 */
const javascriptGenerator = window.Blockly.JavaScript.javascriptGenerator;
const { ORDER_ATOMIC, ORDER_NONE } = javascriptGenerator;

const baseColours = () => ({
    colour: window.Blockly.Colours.Base.colour,
    colourSecondary: window.Blockly.Colours.Base.colourSecondary,
    colourTertiary: window.Blockly.Colours.Base.colourTertiary,
});

const statementColours = () => ({
    colour: window.Blockly.Colours.Special3.colour,
    colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
    colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
});

// Statement: subscribe to a list of markets (call once, in Initialization).
window.Blockly.Blocks.market_watch = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Watch markets in list %1'),
            args0: [{ type: 'input_value', name: 'MARKETS', check: ['Array'] }],
            previousStatement: null,
            nextStatement: null,
            ...statementColours(),
            tooltip: localize(
                'Starts reading the live ticks of every market in the list (for example R_50, 1HZ100V, JD25). Use it once in Initialization.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Watch markets'),
            description: localize(
                'Subscribes to the tick history and live ticks of the markets in the list so other blocks can read their last digits. Markets are released when the bot stops.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

javascriptGenerator.forBlock.market_watch = block => {
    const markets = javascriptGenerator.valueToCode(block, 'MARKETS', ORDER_NONE) || '[]';
    return `Bot.watchMarkets(${markets});\n`;
};

// Number of ticks available for a market.
window.Blockly.Blocks.market_tick_count = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Ticks available for market %1'),
            args0: [{ type: 'input_value', name: 'SYMBOL', check: ['String'] }],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            ...baseColours(),
            tooltip: localize(
                'Returns how many ticks are buffered for a watched market. It is 0 while the market is warming up or its feed has gone quiet.'
            ),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Ticks available for market'),
            description: localize(
                'Returns the number of buffered ticks (up to 1000) for a market listed in "Watch markets", or 0 if it is not ready.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

javascriptGenerator.forBlock.market_tick_count = block => {
    const symbol = javascriptGenerator.valueToCode(block, 'SYMBOL', ORDER_NONE) || "''";
    return [`Bot.getMarketTickCount(${symbol})`, ORDER_ATOMIC];
};

// Count of ticks whose last digit is in a list, over a window that can be shifted back in time.
window.Blockly.Blocks.market_digit_count = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Count of last digits in %1 for market %2 over last %3 ticks, skipping newest %4 ticks'),
            args0: [
                { type: 'input_value', name: 'DIGITS', check: ['Array'] },
                { type: 'input_value', name: 'SYMBOL', check: ['String'] },
                { type: 'input_value', name: 'WINDOW', check: ['Number'] },
                { type: 'input_value', name: 'SKIP', check: ['Number'] },
            ],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            ...baseColours(),
            tooltip: localize(
                'Counts how many of the chosen ticks of a watched market ended in one of the digits. Skip 0 = the latest ticks; skip equal to the window = the same number of ticks just before them.'
            ),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Count of last digits for market'),
            description: localize(
                'Returns how many of the N ticks that end "skip" ticks before the newest one have a last digit in the list. Returns NaN while the market has fewer than N + skip ticks, so missing data is never read as zero.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

javascriptGenerator.forBlock.market_digit_count = block => {
    const digits = javascriptGenerator.valueToCode(block, 'DIGITS', ORDER_NONE) || '[]';
    const symbol = javascriptGenerator.valueToCode(block, 'SYMBOL', ORDER_NONE) || "''";
    const window_size = javascriptGenerator.valueToCode(block, 'WINDOW', ORDER_NONE) || '0';
    const skip = javascriptGenerator.valueToCode(block, 'SKIP', ORDER_NONE) || '0';
    return [`Bot.getMarketDigitCount(${symbol}, ${window_size}, ${skip}, ${digits})`, ORDER_ATOMIC];
};

// Raw last digits of a market (oldest first). Heavier than the count blocks; use them for statistics.
window.Blockly.Blocks.market_last_digit_list = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Last digits list of market %1'),
            args0: [{ type: 'input_value', name: 'SYMBOL', check: ['String'] }],
            output: 'Array',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            ...baseColours(),
            tooltip: localize('Returns the list of last digits of the 1000 recent ticks of a watched market, oldest first.'),
            category: window.Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Last digits list of market'),
            description: localize(
                'Same as "Last digits list" but for any market listed in "Watch markets". Returns an empty list if the market is not ready.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

javascriptGenerator.forBlock.market_last_digit_list = block => {
    const symbol = javascriptGenerator.valueToCode(block, 'SYMBOL', ORDER_NONE) || "''";
    return [`Bot.getMarketDigits(${symbol})`, ORDER_ATOMIC];
};

// Statement: choose the market of the next purchase (use in Before purchase, right before Purchase).
window.Blockly.Blocks.trade_market = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Trade the next contract on market %1'),
            args0: [{ type: 'input_value', name: 'SYMBOL', check: ['String'] }],
            previousStatement: null,
            nextStatement: null,
            ...statementColours(),
            tooltip: localize(
                'Makes the next Purchase on this market instead of the market in the Trade definition. Needs Stake basis and no Payout / Ask price blocks.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Trade on market'),
            description: localize(
                'Place this right before Purchase in "Before purchase". Only the purchase market changes; every new trade starts on the Trade definition market again.'
            ),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

javascriptGenerator.forBlock.trade_market = block => {
    const symbol = javascriptGenerator.valueToCode(block, 'SYMBOL', ORDER_NONE) || "''";
    return `Bot.setTradeMarket(${symbol});\n`;
};
