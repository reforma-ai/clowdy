import { Button } from '@clowdy/components/Button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@clowdy/components/HoverCard';
import { useEffect, useRef, useState } from 'react';

import { PanelIcon } from './PanelIcon';
import { currentPanelSize, panelIconState, panelSizes } from './panelSize';
import styles from './SidePanelCorner.module.css';
import { SidePanelSizes } from './SidePanelSizes';
import { useSidePanel } from './useSidePanel';

import type { SidePanelSize } from '../../stores';

/** How long the pointer rests on the button before its menu opens, and how long the menu waits for it to come back before it shuts (the pointer crosses the gap between them). */
const OPEN_DELAY = 120;
const CLOSE_DELAY = 200;

/**
 * The first item of the side panel's rail, at its top, as tall as the window's title band: the button of the panel's size. The button is there with a project on show whether
 * the panel is open or not; with none the top of the rail is empty. A press, or the pointer resting on it, opens a menu of the sizes in a row (`SidePanelSizes`: Wide, Half
 * and Hide, each drawn as the window with the panel in that size, the current one lit), and a choice sets the panel to it and shuts the menu. A press also moves the focus to the
 * current size, so the keys work in the menu; `Escape` or a Tab out of it shuts it and the focus goes back to the button. The button is pressed (`aria-pressed`, and lit) while the
 * panel is shown, in either size, and its icon (`PanelIcon`) draws the panel as it is.
 */
export function SidePanelCorner() {
    const { available, open, expanded, tabIsFull, setSize } = useSidePanel();
    const [isOpen, setOpen] = useState(false);
    const [focusRequests, setFocusRequests] = useState(0);
    const button = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);

    const size = currentPanelSize({ open, expanded });

    // The menu is in the page's overlay layer and mounts with the state, so the focus moves a frame later.
    useEffect(() => {
        if (focusRequests === 0) return;

        const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus());

        return () => cancelAnimationFrame(frame);
    }, [focusRequests]);

    // A menu shut by a key, or by a choice, took the focus with it: it goes back to the button.
    const changeOpen = (next: boolean) => {
        if (!next && menu.current?.contains(document.activeElement)) button.current?.focus();

        setOpen(next);
    };

    const choose = (chosen: SidePanelSize) => {
        setSize(chosen);
        changeOpen(false);
    };

    return (
        <div className={ styles.corner }>
            { available && (
                <HoverCard isOpen={ isOpen } onOpenChange={ changeOpen } openDelay={ OPEN_DELAY } closeDelay={ CLOSE_DELAY }>
                    <HoverCardTrigger className={ styles.trigger }>
                        <Button
                            ref={ button }
                            variant="filling"
                            size="sm"
                            iconOnly
                            aria-label="Side panel"
                            aria-haspopup="true"
                            aria-expanded={ isOpen }
                            isPressed={ open }
                            onPress={ () => {
                                setOpen(true);
                                setFocusRequests(count => count + 1);
                            } }
                        >
                            <PanelIcon state={ panelIconState(size) } />
                        </Button>
                    </HoverCardTrigger>
                    <HoverCardContent placement="bottom end">
                        <SidePanelSizes ref={ menu } size={ size } sizes={ panelSizes(tabIsFull) } onSelect={ choose } />
                    </HoverCardContent>
                </HoverCard>
            ) }
        </div>
    );
}
