/*
 * Compatibility blocks for uploaded Blockly XML strategies.
 *
 * Several community bots were exported from customised DBot builds that used
 * block type names which are not present in the current Deriv bot skeleton.
 * Registering the compatible aliases/implementations here lets those XML files
 * load without stripping their strategy logic.
 */

const javascriptGenerator = window.Blockly.JavaScript.javascriptGenerator;

// Older/custom builds called the normal Purchase block `apollo_purchase`.
// The XML shape is identical (PURCHASE_LIST), so this is a lossless alias.
if (window.Blockly.Blocks.purchase) {
    window.Blockly.Blocks.apollo_purchase = window.Blockly.Blocks.purchase;
    javascriptGenerator.forBlock.apollo_purchase = javascriptGenerator.forBlock.purchase;
}

// Older/custom builds called the normal Notify block `btnotify`.
// It uses the same NOTIFICATION_TYPE / NOTIFICATION_SOUND / MESSAGE inputs.
if (window.Blockly.Blocks.notify) {
    window.Blockly.Blocks.btnotify = window.Blockly.Blocks.notify;
    javascriptGenerator.forBlock.btnotify = javascriptGenerator.forBlock.notify;
}

// Community block used by Poverty Destroyer. It returns a digit (0-9) ranked by
// frequency over the latest N digits. Runtime implementation lives in Ticks.js.
window.Blockly.Blocks.digit_frequency_analysis = {
    init() {
        this.jsonInit({
            message0: 'Digit frequency %1 over last %2 ticks',
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'ANALYSIS_TYPE',
                    options: [
                        ['Most frequent', 'MOST_FREQUENT'],
                        ['Second most frequent', 'SECOND_MOST_FREQUENT'],
                        ['Least frequent', 'LEAST_FREQUENT'],
                        ['Second least frequent', 'SECOND_LEAST_FREQUENT'],
                    ],
                },
                {
                    type: 'input_value',
                    name: 'N',
                    check: 'Number',
                },
            ],
            output: 'Number',
            outputShape: window.Blockly.OUTPUT_SHAPE_ROUND,
            colour: window.Blockly.Colours.Base.colour,
            colourSecondary: window.Blockly.Colours.Base.colourSecondary,
            colourTertiary: window.Blockly.Colours.Base.colourTertiary,
            tooltip: 'Returns a digit ranked by frequency in the latest N last digits.',
            category: window.Blockly.Categories.Tick_Analysis,
        });
    },
};

javascriptGenerator.forBlock.digit_frequency_analysis = block => {
    const analysisType = block.getFieldValue('ANALYSIS_TYPE') || 'MOST_FREQUENT';
    const n =
        javascriptGenerator.valueToCode(block, 'N', javascriptGenerator.ORDER_ATOMIC) ||
        '1000';

    return [
        `Bot.getDigitFrequencyAnalysis('${analysisType}', ${n})`,
        javascriptGenerator.ORDER_ATOMIC,
    ];
};

// Community block used by 14 Bora V2. `disable` intentionally means "do not
// switch market". Other values switch the running tick/proposal context to the
// selected symbol through Bot.changeSymbol().
window.Blockly.Blocks.active_symbol_changer = {
    init() {
        this.jsonInit({
            message0: 'Switch active market %1',
            args0: [
                {
                    type: 'field_dropdown',
                    name: 'SYMBOL_ACTIVE_TYPE',
                    options: [
                        ['Do not switch', 'disable'],
                        ['Volatility 10 (1s)', '1HZ10V'],
                        ['Volatility 25 (1s)', '1HZ25V'],
                        ['Volatility 30 (1s)', '1HZ30V'],
                        ['Volatility 50 (1s)', '1HZ50V'],
                        ['Volatility 75 (1s)', '1HZ75V'],
                        ['Volatility 90 (1s)', '1HZ90V'],
                        ['Volatility 100 (1s)', '1HZ100V'],
                        ['Volatility 10', 'R_10'],
                        ['Volatility 25', 'R_25'],
                        ['Volatility 50', 'R_50'],
                        ['Volatility 75', 'R_75'],
                        ['Volatility 100', 'R_100'],
                    ],
                },
            ],
            previousStatement: null,
            nextStatement: null,
            colour: window.Blockly.Colours.Special3.colour,
            colourSecondary: window.Blockly.Colours.Special3.colourSecondary,
            colourTertiary: window.Blockly.Colours.Special3.colourTertiary,
            tooltip: 'Changes the active synthetic index used by the running bot.',
            category: window.Blockly.Categories.Miscellaneous,
        });
    },
};

javascriptGenerator.forBlock.active_symbol_changer = block => {
    const symbol = block.getFieldValue('SYMBOL_ACTIVE_TYPE');
    if (!symbol || symbol === 'disable') return '';
    return `Bot.changeSymbol('${symbol}');\n`;
};
