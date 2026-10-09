import { localize } from '@deriv-com/translations';

// Virtual Hook - Fixed Count: after the real-loss trigger, run exactly N virtual trades, then return to real.
window.Blockly.Blocks.virtual_hook_fixed = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Virtual Hook - Fixed Count %1'),
            message1: localize('Enter after actual losses %1'),
            message2: localize('Run virtual trades %1'),
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
            args1: [{ type: 'field_number', name: 'LOSSES', value: 2, min: 1, precision: 1 }],
            args2: [{ type: 'field_number', name: 'COUNT', value: 3, min: 1, precision: 1 }],
            previousStatement: null,
            nextStatement: null,
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            tooltip: localize(
                'After the configured real-loss trigger, execute exactly N virtual trades. Their win/loss results are ignored, then trading returns to real mode.'
            ),
            category: window.Blockly.Categories.Miscellaneous,
        };
    },
    meta() {
        return {
            display_name: localize('Virtual Hook - Fixed Count'),
            description: localize(
                'After the configured real-loss trigger, execute exactly N virtual trades. Their win/loss results are ignored, then trading returns to real mode.'
            ),
        };
    },
};

window.Blockly.JavaScript.javascriptGenerator.forBlock.virtual_hook_fixed = block => {
    const enabled = block.getFieldValue('ENABLED') === 'TRUE';
    const losses = Number(block.getFieldValue('LOSSES')) || 2;
    const count = Number(block.getFieldValue('COUNT')) || 3;
    return `Bot.setVirtualHook({ enabled: ${enabled}, mode: 'fixed', startVirtual: false, enterAfterLosses: ${losses}, fixedCount: ${count} });\n`;
};
