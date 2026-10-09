import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

Blockly.Blocks.over_under_percent = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('%1 %2 %% in last %3 ticks'),
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'TYPE',
                    options: [
                        [localize('Over'), 'OVER'],
                        [localize('Under'), 'UNDER'],
                    ],
                },
                { type: 'field_number', name: 'THRESH', value: 4, min: 0, max: 9, precision: 1 },
                { type: 'field_number', name: 'N', value: 1000, min: 1, precision: 1 },
            ],
            output: 'Number',
            outputShape: Blockly.OUTPUT_SHAPE_ROUND,
            colour: Blockly.Colours.Base.colour,
            colourSecondary: Blockly.Colours.Base.colourSecondary,
            colourTertiary: Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Returns percentage of digits above threshold from last N ticks'),
            category: Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Over/Under Analysis'),
            description: localize('Percentage of digits above/below specified digit from last N ticks'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

Blockly.JavaScript.javascriptGenerator.forBlock.over_under_percent = block => {
    const type = block.getFieldValue('TYPE');
    const thr = Number(block.getFieldValue('THRESH')) || 0;
    const n = Number(block.getFieldValue('N')) || 1000;
    const code = `Bot.getOverUnderPercent({ threshold: ${thr}, n: ${n}, type: '${type}' })`;
    return [code, Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
