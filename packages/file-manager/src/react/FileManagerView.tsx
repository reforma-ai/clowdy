import { Panel, PanelHeader, PanelSearchButton, PanelTab, PanelTabHeader } from '@clowdy/components/Panel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { Show } from '@clowdy/components/Show';
import { cn } from '@clowdy/lib';
import { observer } from 'mobx-react-lite';
import { useId, useRef, useState } from 'react';

import { closeTab } from './editor/closeTab';
import { EditorArea } from './editor/EditorArea';
import { Explorer } from './explorer/Explorer';
import { ExplorerPanelMenu } from './explorer/ExplorerMenu';
import styles from './FileManagerView.module.css';
import { isMac } from './platform';
import { SearchView } from './search/SearchView';

import type { Extension } from '@codemirror/state';
import type { KeyboardEvent, ReactNode } from 'react';
import type { FileManager, SidebarPanel } from '../FileManager';
import type { FileEntry } from '../provider';
import type { ExplorerHandle, ExplorerProps } from './explorer/Explorer';
import type { FileMenuItem } from './explorer/ExplorerMenu';

const TABS: ReadonlyArray<{ value: SidebarPanel; label: string }> = [
    { value: 'files', label: 'Files' },
    { value: 'search', label: 'Search' },
];

export interface FileManagerViewProps {
    manager: FileManager;
    /** Items the host adds to the explorer's row menus, for the files and folders they act on. */
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
    /** CodeMirror extensions added to every text document while it is shown (host keys, a language server). Keep the value stable: a new one reconfigures the editor. */
    editorExtensions?: Extension;
    /** The react-dnd manager the host's other trees use, so they share one HTML5 backend. Without it the explorer makes its own. */
    dndManager?: ExplorerProps['dndManager'];
    /** The sidebar (the file tree and the search) is shown. It is built each time it opens, at `sidebarWidth`. */
    sidebarOpen?: boolean;
    /** The width in pixels the sidebar opens at. */
    sidebarWidth?: number;
    /** The width the sidebar has landed on after a drag or a key press of the person's. */
    onSidebarWidthChange?: (width: number) => void;
    /** ⌘P and ⇧⌘F were pressed while the sidebar is hidden: the filter and the search are in it, so the host shows it. */
    onSidebarRequest?: () => void;
    className?: string;
}

/** The narrowest the sidebar and the editor can be dragged to. */
const SIDEBAR_MIN_WIDTH = 160;
const EDITOR_MIN_WIDTH = 100;
const SIDEBAR_DEFAULT_WIDTH = 240;

/**
 * The editor area, and beside it at the right the sidebar with its Files and Search tabs, on an edge that can be dragged. Its shortcuts (⌘S, ⌥W or ⌘W,
 * ⌘P, ⇧⌘F) work only while focus is inside it; a host binds global ones to `showFilter` and `showSearch`.
 */
export const FileManagerView = observer(function FileManagerView({
    manager,
    menuItems,
    editorExtensions,
    dndManager,
    sidebarOpen = true,
    sidebarWidth = SIDEBAR_DEFAULT_WIDTH,
    onSidebarWidthChange,
    onSidebarRequest,
    className,
}: FileManagerViewProps) {
    const explorer = useRef<ExplorerHandle>(null);
    const sidebar = usePanelRef();
    const id = useId();
    const { panel } = manager;

    // The filter and the search focus themselves when the sidebar is built, so a hidden one only has to be asked to show.
    const showSidebar = () => {
        if (!sidebarOpen) {
            onSidebarRequest?.();
        }
    };

    // ⌘ on macOS and Ctrl elsewhere, by physical key like the app's hotkeys. On macOS, Ctrl+P and
    // Ctrl+Shift+F stay the editor's line and character moves.
    const handleKeyDown = (event: KeyboardEvent) => {
        const mod = isMac ? event.metaKey : event.ctrlKey;
        const alt = event.altKey && !event.metaKey && !event.ctrlKey;

        // ⌥W, since browsers keep ⌘W for their own tab; ⌘W reaches the page only in the desktop app.
        if (event.code === 'KeyW' && !event.shiftKey && (alt || (mod && !event.altKey)) && manager.tabs.active) {
            event.preventDefault();
            void closeTab(manager, manager.tabs.active);

            return;
        }

        if (!mod || event.altKey) {
            return;
        }

        if (!event.shiftKey && event.code === 'KeyS') {
            event.preventDefault();
            void manager.tabs.active?.save();
        }
        else if (!event.shiftKey && event.code === 'KeyP') {
            event.preventDefault();
            manager.showFilter();
            showSidebar();
        }
        else if (event.shiftKey && event.code === 'KeyF') {
            event.preventDefault();
            manager.showSearch();
            showSidebar();
        }
    };

    return (
        <div className={cn(styles.root, className)} onKeyDown={handleKeyDown}>
            <ResizablePanelGroup
                orientation="horizontal"
                // Only the person's own drag is kept: a window that is resized, or a width the range had to correct, changes the layout too.
                onLayoutChanged={(_layout, meta) => {
                    if (!meta.isUserInteraction) {
                        return;
                    }

                    // After the layout has landed: a key press announces its change a step before the panel's size shows it.
                    requestAnimationFrame(() => {
                        if (sidebar.current) {
                            onSidebarWidthChange?.(sidebar.current.getSize().inPixels);
                        }
                    });
                }}
            >
                <ResizablePanel id={`${id}-editor`} className={styles.editor} minSize={EDITOR_MIN_WIDTH}>
                    <EditorArea manager={manager} editorExtensions={editorExtensions} />
                </ResizablePanel>

                <Show when={sidebarOpen}>
                    <Sidebar panelRef={sidebar} width={sidebarWidth}>
                        <Panel side="right" className={styles.sidebar}>
                            <PanelHeader>
                                <PanelTabHeader tab={panel} tabs={TABS} onSelect={next => manager.showPanel(next)} />
                                <Show when={panel === 'files'}>
                                    <PanelHeader.Actions>
                                        <PanelSearchButton
                                            isOpen={manager.filterOpen}
                                            tooltip="Filter files"
                                            onPress={() => (manager.filterOpen ? manager.closeFilter() : manager.showFilter())}
                                        />
                                        <ExplorerPanelMenu
                                            manager={manager}
                                            onCreate={kind => explorer.current?.create(kind)}
                                            onPaste={() => explorer.current?.paste()}
                                        />
                                    </PanelHeader.Actions>
                                </Show>
                            </PanelHeader>
                            <PanelTab key={panel}>
                                <Show when={panel === 'files'} fallback={<SearchView manager={manager} />}>
                                    <Explorer ref={explorer} manager={manager} menuItems={menuItems} dndManager={dndManager} />
                                </Show>
                            </PanelTab>
                        </Panel>
                    </Sidebar>
                </Show>
            </ResizablePanelGroup>
        </div>
    );
});

/**
 * The sidebar's panel and the edge to drag it by. It is built each time the sidebar opens, which is when its width is read, with an id of its own each
 * time: the panel library keeps the last layout of every set of ids, in percentages, and would bring it back in place of the width, which is a different
 * size when the view was resized meanwhile.
 */
function Sidebar({ panelRef, width, children }: { panelRef: ReturnType<typeof usePanelRef>; width: number; children: ReactNode }) {
    const [opened] = useState(width);
    const id = useId();

    return (
        <>
            <ResizableHandle aria-label="Resize the file tree" />

            <ResizablePanel
                id={id}
                panelRef={panelRef}
                className={styles.side}
                defaultSize={opened}
                minSize={SIDEBAR_MIN_WIDTH}
                groupResizeBehavior="preserve-pixel-size"
            >
                {children}
            </ResizablePanel>
        </>
    );
}
