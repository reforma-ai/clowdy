import { Button } from '@clowdy/components/Button';
import { LargePanel, SmallPanel } from '@clowdy/icons/14';

import { commandTooltip } from '../../hotkeys';
import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND } from './commands';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The corner of the title band over the side panel's rail: as wide as the rail, so the usage status stops short of it, and with the button of the panel's size
 * (`ProjectUi.toggleSidePanelExpanded`, and the key `Cmd+Shift+Enter`). The button is there with a project on show whether the panel is open or not. Open, a press expands the
 * panel into the place of the chat and gives it back. Shut, a press opens it as `Cmd+Esc` does, on the tab and in the size it was left in. Its icon draws the panel as it is,
 * or as it will come back: the narrow panel (`SmallPanel`) while the project has it beside the chat, the wide one (`LargePanel`) while it has it expanded.
 */
export function SidePanelCorner() {
    const { available, railShown, open, expanded, expandedChoice, toggle, toggleExpanded } = useSidePanel();

    if (!railShown) return null;

    const label = !open ? 'Show panel' : expanded ? 'Collapse panel' : 'Expand panel';
    const command = open ? SIDE_PANEL_EXPAND_COMMAND : SIDE_PANEL_COMMAND;

    return (
        <div className={ styles.corner }>
            { available && (
                <Button
                    variant="filling"
                    size="sm"
                    iconOnly
                    aria-label={ label }
                    aria-pressed={ open ? expanded : undefined }
                    tooltip={ commandTooltip(label, command) ?? label }
                    tooltipPlacement="bottom"
                    onPress={ open ? toggleExpanded : toggle }
                >
                    { expandedChoice ? <LargePanel /> : <SmallPanel /> }
                </Button>
            ) }
        </div>
    );
}
