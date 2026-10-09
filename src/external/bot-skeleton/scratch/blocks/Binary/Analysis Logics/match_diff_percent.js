import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

Blockly.Blocks.match_diff_percent = {
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
                        [localize('Match'), 'MATCH'],
                        [localize('Differ'), 'DIFFER'],
                    ],
                },
                { type: 'field_number', name: 'VAL', value: 5, min: 0, max: 9, precision: 1 },
                { type: 'field_number', name: 'N', value: 1000, min: 1, precision: 1 },
            ],
            output: 'Number',
            outputShape: Blockly.OUTPUT_SHAPE_ROUND,
            colour: Blockly.Colours.Base.colour,
            colourSecondary: Blockly.Colours.Base.colourSecondary,
            colourTertiary: Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Percentage of digits matching or differing from specified value in last N ticks'),
            category: Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Match/Differ Analysis'),
            description: localize('Percentage of digits matching or differing from specified value in last N ticks'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

Blockly.JavaScript.javascriptGenerator.forBlock.match_diff_percent = block => {
    const type = block.getFieldValue('TYPE');
    const val = Number(block.getFieldValue('VAL')) || 0;
    const n = Number(block.getFieldValue('N')) || 1000;
    const code = `Bot.getMatchDiffPercent({ type: '${type}', val: ${val}, n: ${n} })`;
    return [code, Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
