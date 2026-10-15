jest.mock('@deriv-com/translations', () => ({ localize: text => text }));
jest.mock('../../../../utils', () => ({ modifyContextMenu: jest.fn() }));

const colour = { colour: '#111', colourSecondary: '#222', colourTertiary: '#333' };

beforeAll(() => {
    const values = { MARKETS: '[]', SYMBOL: "'R_50'", WINDOW: '10', SKIP: '10', DIGITS: '[0, 2, 4]' };
    global.window.Blockly = {
        Blocks: {},
        OUTPUT_SHAPE_ROUND: 2,
        Colours: { Base: colour, Special3: colour },
        Categories: { Miscellaneous: 'misc', Tick_Analysis: 'tick' },
        JavaScript: {
            javascriptGenerator: {
                forBlock: {},
                ORDER_ATOMIC: 0,
                ORDER_NONE: 99,
                valueToCode: (_block, name) => values[name],
            },
        },
    };
    require('../../../../scratch/blocks/Binary/Tick Analysis/multi_market');
});

const gen = () => window.Blockly.JavaScript.javascriptGenerator.forBlock;
const def = type => Object.create(window.Blockly.Blocks[type]).definition();

describe('multi-market blocks', () => {
    it('registers every block with the expected inputs and output types', () => {
        expect(def('market_watch').args0.map(a => a.name)).toEqual(['MARKETS']);
        expect(def('market_tick_count').output).toBe('Number');
        expect(def('market_digit_count').args0.map(a => a.name)).toEqual(['DIGITS', 'SYMBOL', 'WINDOW', 'SKIP']);
        expect(def('market_digit_count').output).toBe('Number');
        expect(def('market_last_digit_list').output).toBe('Array');
        expect(def('trade_market').previousStatement).toBeNull();
        expect(def('trade_market').nextStatement).toBeNull();
    });

    it('generates the engine calls', () => {
        expect(gen().market_watch({})).toBe('Bot.watchMarkets([]);\n');
        expect(gen().market_tick_count({})).toEqual(["Bot.getMarketTickCount('R_50')", 0]);
        expect(gen().market_digit_count({})).toEqual(["Bot.getMarketDigitCount('R_50', 10, 10, [0, 2, 4])", 0]);
        expect(gen().market_last_digit_list({})).toEqual(["Bot.getMarketDigits('R_50')", 0]);
        expect(gen().trade_market({})).toBe("Bot.setTradeMarket('R_50');\n");
    });
});
