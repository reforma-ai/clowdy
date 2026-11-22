import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { Panel, PanelHeader, PanelTab } from '@clowdy/components/Panel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Folder } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { observer } from 'mobx-react-lite';
import { useId, useRef, useState } from 'react';

import { closeTab } from './editor/closeTab';
import { EditorArea } from './editor/EditorArea';
import { Explorer } from './explorer/Explorer';
import styles from './FileManagerView.module.css';
import { isMac } from './platform';

import type { Extension } from '@codemirror/state';
import type { KeyboardEvent, ReactNode } from 'react';
import type { FileManager } from '../FileManager';
import type { FileEntry } from '../provider';
import type { ExplorerHandle, ExplorerProps } from './explorer/Explorer';
import type { FileMenuItem } from './explorer/ExplorerMenu';

export interface FileManagerViewProps {
    manager: FileManager;
    /** Items the host adds to the explorer's row menus, for the files and folders they act on. */
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
    /** CodeMirror extensions added to every text document while it is shown (host keys, a language server). Keep the value stable: a new one reconfigures the editor. */
    editorExtensions?: Extension;
    /** The react-dnd manager the host's other trees use, so they share one HTML5 backend. Without it the explorer makes its own. */
    dndManager?: ExplorerProps['dndManager'];
    /** The sidebar (the file tree) is shown. It is built each time it opens, at `sidebarWidth`. */
    sidebarOpen?: boolean;
    /** Shows or hides the sidebar: the button at the end of the editor's tab strip, which is there while no file is open too. Without it the view has no such button. */
    onSidebarToggle?: () => void;
    /** The width in pixels the sidebar opens at. */
    sidebarWidth?: number;
    /** The width the sidebar has landed on after a drag or a key press of the person's. */
    onSidebarWidthChange?: (width: number) => void;
    className?: string;
}

/** The narrowest the sidebar and the editor can be dragged to. */
const SIDEBAR_MIN_WIDTH = 160;
const EDITOR_MIN_WIDTH = 100;
const SIDEBAR_DEFAULT_WIDTH = 240;

/**
 * The editor area, and beside it at the right the sidebar with the file tree, on an edge that can be dragged. The sidebar's header is the filter of the tree (by file
 * name), with the button that hides the sidebar at its end. Its shortcuts (⌘S, ⌥W or ⌘W) work only while focus is inside it. Finding a file anywhere by its name, or text in
 * the files, is the host's search: it calls `manager.open`.
 */
export const FileManagerView = observer(function FileManagerView({
    manager,
    menuItems,
    editorExtensions,
    dndManager,
    sidebarOpen = true,
    sidebarWidth = SIDEBAR_DEFAULT_WIDTH,
    onSidebarWidthChange,
    onSidebarToggle,
    className,
}: FileManagerViewProps) {
    const sidebar = usePanelRef();
    const explorer = useRef<ExplorerHandle>(null);
    const id = useId();

    // ⌘ on macOS and Ctrl elsewhere, by physical key like the app's hotkeys.
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
                    <EditorArea
                        manager={manager}
                        editorExtensions={editorExtensions}
                        toolbar={!sidebarOpen && onSidebarToggle && <SidebarToggle open={false} onPress={onSidebarToggle} />}
                    />
                </ResizablePanel>

                <Show when={sidebarOpen}>
                    <Sidebar panelRef={sidebar} width={sidebarWidth}>
                        <Panel side="right" className={styles.sidebar}>
                            <PanelHeader>
                                <FilterField manager={manager} onSubmit={() => explorer.current?.openFirstMatch()} />
                                <PanelHeader.Actions>
                                    {onSidebarToggle && <SidebarToggle open onPress={onSidebarToggle} />}
                                </PanelHeader.Actions>
                            </PanelHeader>
                            <PanelTab>
                                <Explorer ref={explorer} manager={manager} menuItems={menuItems} dndManager={dndManager} />
                            </PanelTab>
                        </Panel>
                    </Sidebar>
                </Show>
            </ResizablePanelGroup>
        </div>
    );
});

/** The filter of the tree: the files whose name has what is typed, with the folders above them. Enter opens the first. It takes the place a title would have in the header. */
const FilterField = observer(function FilterField({ manager, onSubmit }: { manager: FileManager; onSubmit: () => void }) {
    const { filterQuery, filterResult } = manager;

    return (
        <SearchInput
            size="sm"
            variant="inline"
            className={styles.filter}
            placeholder="Filter files"
            aria-label="Filter files"
            value={filterQuery}
            onChange={(query: string) => void manager.filter(query)}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    onSubmit();
                }
            }}
        >
            {filterQuery.trim() !== '' && filterResult?.query !== filterQuery ? <Spinner slot="suffix" size="xs" aria-label="Searching" /> : null}
        </SearchInput>
    );
});

/**
 * The button that shows and hides the sidebar. It is at the right edge of the view whichever the state, so a second press lands where the first did: at the end of the
 * editor's tab strip while the sidebar is hidden, and at the end of the sidebar's own header while it is shown (the two bars are one height, and one the same
 * distance from the edge). Pressed while the sidebar is shown. One takes the other's place, so after a press from the keyboard the new one takes the focus.
 */
function SidebarToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
    return (
        <Button
            variant="filling"
            color="secondary"
            size="sm"
            iconOnly
            className={styles.toggle}
            aria-label="File tree"
            tooltip={open ? 'Hide the file tree' : 'Show the file tree'}
            tooltipPlacement="bottom"
            isPressed={open}
            data-sidebar-toggle=""
            onPress={event => {
                onPress();

                if (event.pointerType === 'keyboard') {
                    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar-toggle]')?.focus());
                }
            }}
        >
            <Folder />
        </Button>
    );
}

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
