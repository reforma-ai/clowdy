import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { useState } from 'react';

import { browserStorage } from '../stores/storage';
import styles from './SidebarLayout.module.css';
import { MAIN_MIN_WIDTH, readSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, writeSidebarWidth } from './sidebarWidth';

import type { ReactNode } from 'react';

export interface SidebarLayoutProps {
    /** The screen, as the width is remembered per screen: `agents`, `docs`, `settings`. */
    screen: string;
    /** The column's width until the person drags it, in pixels. */
    defaultWidth: number;
    /** The left column: a `Panel` or an `aside` that fills the width it is given. */
    sidebar: ReactNode;
    children: ReactNode;
}

/**
 * The frame of a screen with a column on the left and a page beside it. The edge between them can be dragged (or moved with the arrow keys
 * while it has focus) within a range, and the width is remembered for the next visit. The panel library is the one Reforma uses.
 */
export function SidebarLayout({ screen, defaultWidth, sidebar, children }: SidebarLayoutProps) {
    const sidebarPanel = usePanelRef();
    // Read once, when the screen opens: from then on the panel holds the width, and storage is only for the next visit.
    const [initialWidth] = useState(() => readSidebarWidth(browserStorage(), screen, defaultWidth));

    return (
        <ResizablePanelGroup
            orientation="horizontal"
            className={ styles.layout }
            // A window that is resized, or a width the range had to correct, changes the layout too: only the person's own drag is kept.
            onLayoutChanged={ (_layout, meta) => {
                if (meta.isUserInteraction && sidebarPanel.current) writeSidebarWidth(browserStorage(), screen, sidebarPanel.current.getSize().inPixels);
            } }
        >
            <ResizablePanel
                id="sidebar"
                panelRef={ sidebarPanel }
                className={ styles.sidebar }
                defaultSize={ initialWidth }
                minSize={ SIDEBAR_MIN_WIDTH }
                maxSize={ SIDEBAR_MAX_WIDTH }
                groupResizeBehavior="preserve-pixel-size"
            >
                { sidebar }
            </ResizablePanel>

            <ResizableHandle aria-label="Resize the sidebar" />

            <ResizablePanel id="main" className={ styles.main } minSize={ MAIN_MIN_WIDTH }>
                { children }
            </ResizablePanel>
        </ResizablePanelGroup>
    );
}
