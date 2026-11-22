import { Button } from '@clowdy/components/Button';

import { commandTooltip } from '../../hotkeys';
import { PanelIcon } from './PanelIcon';
import { panelStep } from './panelStep';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The corner of the title band over the side panel's rail: as wide as the rail, so the usage status stops short of it, and with the button that steps the panel through its
 * three states (`ProjectUi.stepSidePanel`, the step is `panelStep`). The button is there with a project on show whether the panel is open or not. It is a toggle of the panel's
 * being on show, so its name stays and it is pressed (`aria-pressed`, and lit) while the panel is shown, in either size; the tooltip says what a press does. Its icon
 * (`PanelIcon`) draws the panel as it is, and glides to the panel as it will be while the pointer is over the button.
 */
export function SidePanelCorner() {
    const { available, railShown, open, expanded, expandedChoice, step } = useSidePanel();

    if (!railShown) return null;

    const { state, next, action, command } = panelStep({ open, expanded, expandedChoice });

    return (
        <div className={ styles.corner }>
            { available && (
                <Button
                    variant="filling"
                    size="sm"
                    iconOnly
                    aria-label="Side panel"
                    isPressed={ open }
                    tooltip={ commandTooltip(action, command) ?? action }
                    tooltipPlacement="bottom"
                    onPress={ step }
                >
                    <PanelIcon state={ state } next={ next } />
                </Button>
            ) }
        </div>
    );
}
