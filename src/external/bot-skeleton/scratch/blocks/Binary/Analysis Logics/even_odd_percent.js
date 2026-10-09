import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

Blockly.Blocks.even_odd_percent = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('%1 %% of last %2 digits are %3'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'TYPE',
                    options: [
                        [localize('Even'), 'EVEN'],
                        [localize('Odd'), 'ODD'],
                    ],
                },
                { type: 'field_number', name: 'N', value: 1000, min: 1, precision: 1 },
                { type: 'field_dropdown', name: 'LBL', options: [[localize('digits'), 'DIGITS']] },
            ],
            output: 'Number',
            outputShape: Blockly.OUTPUT_SHAPE_ROUND,
            colour: Blockly.Colours.Base.colour,
            colourSecondary: Blockly.Colours.Base.colourSecondary,
            colourTertiary: Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Returns percentage of even or odd digits from last N ticks'),
            category: Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Even/Odd %'),
            description: localize('Returns percentage of even or odd digits in last N ticks'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

Blockly.JavaScript.javascriptGenerator.forBlock.even_odd_percent = block => {
    const type = block.getFieldValue('TYPE');
    const n = Number(block.getFieldValue('N')) || 1000;
    const code = `Bot.getEvenOddPercent({ type: '${type}', n: ${n} })`;
    return [code, Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
