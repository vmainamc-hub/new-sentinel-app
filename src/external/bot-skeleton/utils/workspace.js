import { config } from '../constants/config';

export const hasAllRequiredBlocks = () => {
    const blocks_in_workspace = window.Blockly.derivWorkspace.getAllBlocks();
    const { mandatoryMainBlocks } = config();
    const required_block_types = ['trade_definition_tradeoptions', ...mandatoryMainBlocks];
    const all_block_types = blocks_in_workspace.map(block => block.type);
    const has_all_required_blocks = required_block_types.every(required_block_type =>
        all_block_types.includes(required_block_type)
    );

    return has_all_required_blocks;
};

export const onWorkspaceResize = () => {
    const workspace = window.Blockly.derivWorkspace;

    // On phones the on-screen keypad shrinks the viewport and fires a window resize. While a block field
    // (e.g. the stake) is being typed into, leave the workspace alone: Blockly repositions its own editor
    // for the resize, and a second svgResize here can make the editor and keypad drop. The resize that
    // follows when the keypad closes still runs this function normally.
    const active_element = document.activeElement;
    if (active_element && active_element.closest && active_element.closest('.blocklyWidgetDiv')) {
        return;
    }

    if (workspace) {
        // kept this commented to fix slow rendering issue
        //workspace.getAllFields().forEach(field => field.forceRerender());

        const el_scratch_div = document.getElementById('scratch_div');
        if (el_scratch_div) {
            window.Blockly.svgResize(workspace);
        }
    }
};

export const removeLimitedBlocks = (workspace, block_types) => {
    const types = Array.isArray(block_types) ? block_types : [block_types];

    types.forEach(block_type => {
        if (config().single_instance_blocks.includes(block_type)) {
            workspace.getAllBlocks().forEach(ws_block => {
                if (ws_block.type === block_type) {
                    ws_block.dispose();
                }
            });
        }
    });
};

export const isDbotRTL = () => {
    const htmlElement = document.documentElement;
    const dirValue = htmlElement.getAttribute('dir');
    return dirValue === 'rtl';
};
