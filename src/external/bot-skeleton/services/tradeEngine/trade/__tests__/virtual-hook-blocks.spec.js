jest.mock('@deriv-com/translations', () => ({ localize: text => text }));

const colour = { colour: '#111', colourSecondary: '#222', colourTertiary: '#333' };

beforeAll(() => {
    global.window.Blockly = {
        Blocks: {},
        Colours: { Special3: colour, Special1: colour, Special2: colour },
        Categories: { Miscellaneous: 'misc', Tick_Analysis: 'tick' },
        JavaScript: { javascriptGenerator: { forBlock: {}, ORDER_ATOMIC: 0, ORDER_NONE: 99, valueToCode: () => '5' } },
    };
    require('../../../../scratch/blocks/VirtualHook');
});

const blockWith = fields => ({ getFieldValue: name => fields[name] });
const gen = () => window.Blockly.JavaScript.javascriptGenerator.forBlock;

describe('Virtual Hook blocks', () => {
    it('registers both blocks with the expected fields', () => {
        const hook = Object.create(window.Blockly.Blocks.virtual_hook);
        const def = hook.definition();
        expect(def.args0[0].name).toBe('ENABLED');
        expect(def.args1[0].name).toBe('START');
        expect(def.args2[0].name).toBe('LOSSES');
        expect(def.args3[0].name).toBe('WINS');
        const fixed = Object.create(window.Blockly.Blocks.virtual_hook_fixed).definition();
        expect(fixed.args2[0].name).toBe('COUNT');
    });

    it('generates the streak configuration', () => {
        const code = gen().virtual_hook(blockWith({ ENABLED: 'TRUE', START: 'VIRTUAL', LOSSES: '3', WINS: '2' }));
        expect(code).toBe(
            "Bot.setVirtualHook({ enabled: true, mode: 'streak', startVirtual: true, enterAfterLosses: 3, returnAfterWins: 2 });\n"
        );
    });

    it('generates the fixed-count configuration and a disabled configuration', () => {
        const code = gen().virtual_hook_fixed(blockWith({ ENABLED: 'TRUE', LOSSES: '2', COUNT: '4' }));
        expect(code).toBe("Bot.setVirtualHook({ enabled: true, mode: 'fixed', startVirtual: false, enterAfterLosses: 2, fixedCount: 4 });\n");
        expect(gen().virtual_hook(blockWith({ ENABLED: 'FALSE', START: 'REAL', LOSSES: '2', WINS: '1' }))).toContain('enabled: false');
    });
});
