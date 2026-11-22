import { Button } from '@clowdy/components/Button';

import { commandTooltip } from '../../hotkeys';
import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND } from './commands';
import { PanelIcon, type PanelIconState } from './PanelIcon';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The corner of the title band over the side panel's rail: as wide as the rail, so the usage status stops short of it, and with the button that steps the panel through its
 * three states (`ProjectUi.stepSidePanel`). The button is there with a project on show whether the panel is open or not, and says what a press does with its label. Its icon
 * (`PanelIcon`) draws the panel as it is, and glides to the panel as it will be while the pointer is over the button: a shut panel is shown (beside the chat, or expanded when
 * it was left expanded and comes back so), one beside the chat is expanded into the place of the chat, and an expanded one is hidden.
 */
export function SidePanelCorner() {
    const { available, railShown, open, expanded, expandedChoice, step } = useSidePanel();

    if (!railShown) return null;

    const state: PanelIconState = !open ? 'none' : expanded ? 'large' : 'small';
    const next: PanelIconState = !open ? (expandedChoice ? 'large' : 'small') : expanded ? 'none' : 'large';
    const label = !open ? 'Show panel' : expanded ? 'Hide panel' : 'Expand panel';
    const command = open && !expanded ? SIDE_PANEL_EXPAND_COMMAND : SIDE_PANEL_COMMAND;

    return (
        <div className={ styles.corner }>
            { available && (
                <Button
                    variant="filling"
                    size="sm"
                    iconOnly
                    aria-label={ label }
                    tooltip={ commandTooltip(label, command) ?? label }
                    tooltipPlacement="bottom"
                    onPress={ step }
                >
                    <PanelIcon state={ state } next={ next } />
                </Button>
            ) }
        </div>
    );
}
