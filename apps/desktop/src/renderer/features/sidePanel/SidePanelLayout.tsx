import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { useId, useState } from 'react';

import { browserStorage } from '../../stores/storage';
import { readSidePanelWidth, SIDE_PANEL_MAX_WIDTH, SIDE_PANEL_MIN_WIDTH, writeSidePanelWidth } from './panelWidth';
import { SidePanel } from './SidePanel';
import styles from './SidePanelLayout.module.css';
import { useSidePanel } from './useSidePanel';

import type { ReactNode } from 'react';

/** What the window keeps at the left of the panel: the rail, the narrowest left column and the narrowest page (about 640), with a little to spare, so dragging the panel wide cannot squeeze them out. */
const WINDOW_MIN_WIDTH = 656;

/**
 * The window split in two: everything (title band, rail, the page) on the left, and the side panel on the right while it is open, from the top edge to the
 * bottom. The edge between them can be dragged (or moved with the arrow keys while it has focus), and the width is remembered for the whole window.
 * The left part is the same element whether the panel is open or not, so opening it moves nothing: no page is built again, and no draft or scroll position is lost.
 */
export function SidePanelLayout({ children }: { children: ReactNode }) {
    const { open } = useSidePanel();
    const panel = usePanelRef();

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className={ styles.layout }
            // A window that is resized, or a width the range had to correct, changes the layout too: only the person's own drag is kept.
            onLayoutChanged={ (_layout, meta) => {
                if (!meta.isUserInteraction) return;

                // The size the panel has once the layout has landed: a key press announces its change a step before the panel's size shows it.
                requestAnimationFrame(() => {
                    if (panel.current) writeSidePanelWidth(browserStorage(), panel.current.getSize().inPixels);
                });
            } }
        >
            <ResizablePanel id="window" className={ styles.window } minSize={ WINDOW_MIN_WIDTH }>
                { children }
            </ResizablePanel>

            { open && <SideColumn panel={ panel } /> }
        </ResizablePanelGroup>
    );
}

/**
 * The panel and the edge to drag it by. It is built each time the panel opens, which is when the width is read: a drag while it was open is kept in storage only.
 * Each opening has an id of its own, because the panel library keeps the last layout of every set of ids, in percentages, and would bring it back in place
 * of the stored width, which is a different size when the window was resized while the panel was shut.
 */
function SideColumn({ panel }: { panel: ReturnType<typeof usePanelRef> }) {
    const [width] = useState(() => readSidePanelWidth(browserStorage()));
    const id = useId();

    return (
        <>
            <ResizableHandle aria-label="Resize the side panel" />

            <ResizablePanel
                id={ id }
                panelRef={ panel }
                className={ styles.side }
                defaultSize={ width }
                minSize={ SIDE_PANEL_MIN_WIDTH }
                maxSize={ SIDE_PANEL_MAX_WIDTH }
                groupResizeBehavior="preserve-pixel-size"
            >
                <SidePanel />
            </ResizablePanel>
        </>
    );
}
