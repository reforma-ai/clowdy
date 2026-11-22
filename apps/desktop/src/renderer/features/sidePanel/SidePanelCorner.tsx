import { Button } from '@clowdy/components/Button';
import { Collapse, Expand } from '@clowdy/icons/16';

import { commandTooltip } from '../../hotkeys';
import { SIDE_PANEL_EXPAND_COMMAND } from './commands';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The corner of the title band over the side panel's rail: as wide as the rail, so the usage status stops short of it, and with the button that expands the open panel into
 * the place of the chat and gives it back (`ProjectUi.toggleSidePanelExpanded`, and the key `Cmd+Shift+Enter`). The button is there while the panel is open; a shut panel
 * leaves the corner empty. The corner is there with the rail.
 */
export function SidePanelCorner() {
    const { railShown, open, expanded, toggleExpanded } = useSidePanel();

    if (!railShown) return null;

    const label = expanded ? 'Collapse panel' : 'Expand panel';

    return (
        <div className={ styles.corner }>
            { open && (
                <Button
                    variant="filling"
                    size="sm"
                    iconOnly
                    aria-label={ label }
                    aria-pressed={ expanded }
                    tooltip={ commandTooltip(label, SIDE_PANEL_EXPAND_COMMAND) ?? label }
                    tooltipPlacement="bottom"
                    onPress={ toggleExpanded }
                >
                    { expanded ? <Collapse /> : <Expand /> }
                </Button>
            ) }
        </div>
    );
}
