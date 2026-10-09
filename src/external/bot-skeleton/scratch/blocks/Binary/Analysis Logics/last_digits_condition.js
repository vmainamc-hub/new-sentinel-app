import { localize } from '@deriv-com/translations';
import { modifyContextMenu } from '../../../utils';

Blockly.Blocks.last_digits_condition = {
    init() {
        this.jsonInit(this.definition());
    },
    definition() {
        return {
            message0: localize('Last %1 digits are %2 than digit %3'),
            args0: [
                {
                    type: 'field_number',
                    name: 'N',
                    value: 3,
                    min: 1,
                    precision: 1,
                },
                {
                    type: 'field_dropdown',
                    name: 'CONDITION',
                    options: [
                        [localize('less'), 'LESS'],
                        [localize('less than or equal'), 'LEQ'],
                        [localize('greater'), 'GREATER'],
                        [localize('greater than or equal'), 'GEQ'],
                        [localize('equal'), 'EQ'],
                        [localize('not equal'), 'NEQ'],
                    ],
                },
                {
                    type: 'field_number',
                    name: 'DIGIT',
                    value: 4,
                    min: 0,
                    max: 9,
                    precision: 1,
                },
            ],
            output: 'Boolean',
            outputShape: Blockly.OUTPUT_SHAPE_ROUND,
            colour: Blockly.Colours.Base.colour,
            colourSecondary: Blockly.Colours.Base.colourSecondary,
            colourTertiary: Blockly.Colours.Base.colourTertiary,
            tooltip: localize('Checks if last N digits satisfy the given condition against a digit'),
            category: Blockly.Categories.Tick_Analysis,
        };
    },
    meta() {
        return {
            display_name: localize('Last Digits Condition'),
            description: localize('Checks if the last N digits meet the specified condition.'),
        };
    },
    customContextMenu(menu) {
        modifyContextMenu(menu);
    },
};

Blockly.JavaScript.javascriptGenerator.forBlock.last_digits_condition = block => {
    const n = Number(block.getFieldValue('N')) || 1;
    const condition = block.getFieldValue('CONDITION');
    const d = Number(block.getFieldValue('DIGIT')) || 0;
    const op =
        {
            LESS: '<',
            LEQ: '<=',
            GREATER: '>',
            GEQ: '>=',
            EQ: '===',
            NEQ: '!==',
        }[condition] || '===';

    const code = `Bot.getLastDigitsCondition({ n: ${n}, op: '${condition}', digit: ${d} })`;
    return [code, Blockly.JavaScript.javascriptGenerator.ORDER_ATOMIC];
};
