jest.mock('@deriv-com/translations', () => ({ localize: text => text }));

beforeAll(() => {
    const colour = { colour: '#111', colourSecondary: '#222', colourTertiary: '#333' };
    global.window.Blockly = {
        Blocks: {},
        Colours: { Special1: colour, Special2: colour, Special3: colour, Base: colour },
        Categories: {},
        JavaScript: {
            javascriptGenerator: { forBlock: {}, statementToCode: () => '        STRATEGY_STACK();\\n' },
        },
    };
    require('../../../../scratch/blocks/Binary/After Purchase/after_purchase');
});

describe('after_purchase code generation', () => {
    it('skips the strategy stack for virtual trades and trades again', () => {
        const code = window.Blockly.JavaScript.javascriptGenerator.forBlock.after_purchase({ id: 'abc' });
        const guard = code.indexOf('Bot.isVirtualResult()');
        const stack = code.indexOf('STRATEGY_STACK();');
        const normalEnd = code.indexOf('Bot.isTradeAgain(false);');
        expect(guard).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(stack);
        expect(stack).toBeLessThan(normalEnd);
        const guardBlock = code.slice(guard, stack);
        expect(guardBlock).toContain('Bot.isTradeAgain(true);');
        expect(guardBlock).toContain('return true;');
    });
});
