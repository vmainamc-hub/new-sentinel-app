import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

Blockly.Blocks.rise_fall_percent = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Rise %1 %% of last %2 ticks'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'TYPE',
                    options: [
                        [localize('Rise'), 'RISE'],
                        [localize('Fall'), 'FALL'],
                    ],
                },
                { type: 'field_number', name: 'N', value: 1000, min: 1, precision: 1 },
            ],
            output: 'Number',
            outputShape: Blockly.OUTPUT_SHAPE_ROUND,
            colour: Blockly.Colours.Base.colour,
            colourSecondary: Blockly.Colours.Base.colourSecondary,
            colourTertiary: Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Percentage of rising or falling ticks from last N ticks'),
            category: Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Rise/Fall %'),
            description: localize('Percentage of rising or falling ticks in last N ticks'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

Blockly.JavaScript.javascriptGenerator.forBlock.rise_fall_percent = block => {
    const type = block.getFieldValue('TYPE');
    const n = Number(block.getFieldValue('N')) || 1000;
    const code = `Bot.getRiseFallPercent({ type: '${type}', n: ${n} })`;
    return [code, Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
