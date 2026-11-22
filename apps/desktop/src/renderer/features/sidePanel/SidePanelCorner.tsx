import { Button } from '@clowdy/components/Button';

import { commandTooltip } from '../../hotkeys';
import { PanelIcon } from './PanelIcon';
import { panelStep } from './panelStep';
import styles from './SidePanelCorner.module.css';
import { useSidePanel } from './useSidePanel';

/**
 * The first item of the side panel's rail, at its top, as tall as the window's title band was: the button that steps the panel through its three states
 * (`ProjectUi.stepSidePanel`, the step is `panelStep`). The button is there with a project on show whether the panel is open or not; with none the top of the rail is empty. It is a toggle of the panel's
 * being on show, so its name stays and it is pressed (`aria-pressed`, and lit) while the panel is shown, in either size; the tooltip says what a press does. Its icon
 * (`PanelIcon`) draws the panel as it is, and glides to the panel as it will be while the pointer is over the button.
 */
export function SidePanelCorner() {
    const { available, open, expanded, expandedChoice, step } = useSidePanel();

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
