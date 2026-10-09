import { localize } from '@deriv-com/translations';

// Virtual Hook: switch to zero-stake virtual trades after real losses, return after virtual wins.
window.Blockly.Blocks.virtual_hook = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Virtual Hook %1'),
            message1: localize('Start execution %1'),
            message2: localize('Enter after actual losses %1'),
            message3: localize('Return to real after consecutive virtual wins %1'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'ENABLED',
                    options: [
                        [localize('Enabled'), 'TRUE'],
                        [localize('Disabled'), 'FALSE'],
                    ],
                },
            ],
            args1: [
                {
                    type: 'field_dropdown',
                    name: 'START',
                    options: [
                        [localize('Real'), 'REAL'],
                        [localize('Virtual'), 'VIRTUAL'],
                    ],
                },
            ],
            args2: [{ type: 'field_number', name: 'LOSSES', value: 2, min: 1, precision: 1 }],
            args3: [{ type: 'field_number', name: 'WINS', value: 1, min: 1, precision: 1 }],
            previousStatement: null,
            nextStatement: null,
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            tooltip: localize(
                'Mirrors qualified trades with zero financial stake. Choose whether execution starts in virtual or real mode; virtual losses stay virtual until the configured consecutive virtual wins are reached.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Virtual Hook'),
            description: localize(
                'Mirrors qualified trades with zero financial stake. Choose whether execution starts in virtual or real mode; virtual losses stay virtual until the configured consecutive virtual wins are reached.'
            ),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.virtual_hook = block => {
    const enabled = block.getFieldValue('ENABLED') === 'TRUE';
    const start_virtual = block.getFieldValue('START') === 'VIRTUAL';
    const losses = Number(block.getFieldValue('LOSSES')) || 2;
    const wins = Number(block.getFieldValue('WINS')) || 1;
    return `Bot.setVirtualHook({ enabled: ${enabled}, mode: 'streak', startVirtual: ${start_virtual}, enterAfterLosses: ${losses}, returnAfterWins: ${wins} });\n`;
};
