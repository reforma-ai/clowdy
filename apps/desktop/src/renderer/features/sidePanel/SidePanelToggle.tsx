import { Button } from '@clowdy/components/Button';
import { SidebarRight } from '@clowdy/icons/16';

import { commandTooltip } from '../../hotkeys';
import { SIDE_PANEL_COMMAND } from './commands';
import { useSidePanel } from './useSidePanel';

/**
 * The button that opens and shuts the side panel, at the right edge of the window whether the panel is open or not: in the title band while it is shut, and
 * in the panel's own header while it is open. It is a toggle (`aria-pressed`), so its name stays and the tooltip says what a press does. Not drawn where the
 * window shows no project.
 *
 * The two places hold two buttons, so a press ends on the one that goes away: after a press from the keyboard the other takes the focus, or the person would
 * have nothing focused where they were.
 */
export function SidePanelToggle() {
    const { available, open, toggle } = useSidePanel();

    if (!available) return null;

    const label = open ? 'Hide side panel' : 'Show side panel';

    return (
        <Button
            variant="filling"
            size="sm"
            iconOnly
            aria-label="Side panel"
            tooltip={ commandTooltip(label, SIDE_PANEL_COMMAND) ?? label }
            tooltipPlacement="bottom"
            isPressed={ open }
            data-side-panel-toggle=""
            onPress={ event => {
                toggle();

                if (event.pointerType === 'keyboard') requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-side-panel-toggle]')?.focus());
            } }
        >
            <SidebarRight />
        </Button>
    );
}
