import { Button } from '@clowdy/components/Button';
import { LargePanel, NoPanel, SmallPanel } from '@clowdy/icons/14';

import { commandTooltip } from '../../hotkeys';
import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND } from './commands';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The corner of the title band over the side panel's rail: as wide as the rail, so the usage status stops short of it, and with the button that steps the panel through its
 * three states (`ProjectUi.stepSidePanel`). The button is there with a project on show whether the panel is open or not, and says what a press does with the icon of the state
 * it leads to: a shut panel is shown (`SmallPanel`, or `LargePanel` when it was left expanded and comes back so), one beside the chat is expanded into the place of the chat
 * (`LargePanel`), and an expanded one is hidden (`NoPanel`).
 */
export function SidePanelCorner() {
    const { available, railShown, open, expanded, expandedChoice, step } = useSidePanel();

    if (!railShown) return null;

    const [label, command, Icon] = !open
        ? ['Show panel', SIDE_PANEL_COMMAND, expandedChoice ? LargePanel : SmallPanel] as const
        : expanded
            ? ['Hide panel', SIDE_PANEL_COMMAND, NoPanel] as const
            : ['Expand panel', SIDE_PANEL_EXPAND_COMMAND, LargePanel] as const;

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
                    <Icon />
                </Button>
            ) }
        </div>
    );
}
