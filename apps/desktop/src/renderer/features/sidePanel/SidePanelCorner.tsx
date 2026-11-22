import { Button } from '@clowdy/components/Button';
import { Popover, PopoverTrigger } from '@clowdy/components/Popover';
import { useState } from 'react';

import { PanelIcon } from './PanelIcon';
import { currentPanelSize, panelIconState, panelSizeOptions } from './panelSize';
import styles from './SidePanelCorner.module.css';
import { SidePanelSizes } from './SidePanelSizes';
import { useSidePanel } from './useSidePanel';

import type { SidePanelSize } from '../../stores';

/**
 * The first item of the side panel's rail, at its top, as tall as the window's title band: the button of the panel's size. The button is there with a project on show whether
 * the panel is open or not; with none the top of the rail is empty. A press opens a dropdown under it (`SidePanelSizes`: Wide, Half and Hide in a row, each drawn as the window with
 * the panel in that size, the current one lit and Half grey with its reason where the panel cannot be beside the chat), and a choice sets the panel to it and shuts the dropdown.
 * The pointer resting on the button opens nothing. The focus goes to the current size, `Escape` or a press outside shuts the dropdown, and the focus goes back to the button. The button
 * is pressed (`aria-pressed`, and lit) while the panel is shown, in either size, and its icon (`PanelIcon`) draws the panel as it is.
 */
export function SidePanelCorner() {
    const { available, open, expanded, noHalf, setSize } = useSidePanel();
    const [isOpen, setOpen] = useState(false);

    const size = currentPanelSize({ open, expanded });

    const choose = (chosen: SidePanelSize) => {
        setSize(chosen);
        setOpen(false);
    };

    return (
        <div className={ styles.corner }>
            { available && (
                <PopoverTrigger isOpen={ isOpen } onOpenChange={ setOpen }>
                    <Button variant="filling" size="sm" iconOnly aria-label="Side panel" isPressed={ open }>
                        <PanelIcon state={ panelIconState(size) } />
                    </Button>
                    <Popover placement="bottom end" spacing="md" aria-label="Side panel size">
                        <SidePanelSizes size={ size } options={ panelSizeOptions(noHalf) } onSelect={ choose } />
                    </Popover>
                </PopoverTrigger>
            ) }
        </div>
    );
}
