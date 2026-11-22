import { Button } from '@clowdy/components/Button';
import { SearchInput } from '@clowdy/components/Input';
import { Panel, PanelHeader, PanelTab } from '@clowdy/components/Panel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup, usePanelRef } from '@clowdy/components/Resizable';
import { Show } from '@clowdy/components/Show';
import { Spinner } from '@clowdy/components/Spinner';
import { Folder } from '@clowdy/icons/14';
import { cn } from '@clowdy/lib';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useRef, useState } from 'react';
import useResizeObserver from 'use-resize-observer';

import { closeTab } from './editor/closeTab';
import { EditorArea } from './editor/EditorArea';
import { Explorer } from './explorer/Explorer';
import { scopeFilter } from './explorer/scopeFilter';
import styles from './FileManagerView.module.css';
import { isMac } from './platform';

import type { Extension } from '@codemirror/state';
import type { KeyboardEvent, ReactNode } from 'react';
import type { FileManager } from '../FileManager';
import type { FileEntry } from '../provider';
import type { ExplorerHandle, ExplorerProps } from './explorer/Explorer';
import type { ExplorerScope } from './explorer/explorerContext';
import type { FileMenuItem } from './explorer/ExplorerMenu';

export interface FileManagerViewProps {
    manager: FileManager;
    /** Items the host adds to the explorer's row menus, for the files and folders they act on. */
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
    /** CodeMirror extensions added to every text document while it is shown (host keys, a language server). Keep the value stable: a new one reconfigures the editor. */
    editorExtensions?: Extension;
    /** Draws a part of the tree in the sidebar (a folder of documents) in place of all of it, with a name filter of its own. Keep the value stable. */
    scope?: ExplorerScope;
    /** What the sidebar's filter field says while it is empty. */
    filterPlaceholder?: string;
    /** What the sidebar says while its scope has no rows and nothing is typed. */
    emptyText?: string;
    /** The react-dnd manager the host's other trees use, so they share one HTML5 backend. Without it the explorer makes its own. */
    dndManager?: ExplorerProps['dndManager'];
    /** The sidebar (the file tree) is shown, unless no file is open: then it is shown whatever this says (and has no button to hide it). It is built each time it opens, at `sidebarWidth`. */
    sidebarOpen?: boolean;
    /** Shows or hides the sidebar: the button at the end of the editor's tab strip while a file is open. Without it the view has no such button. */
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
    scope,
    filterPlaceholder = 'Filter files',
    emptyText,
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
    const { ref: rootRef, width: rootWidth = 0 } = useResizeObserver<HTMLDivElement>();
    // A group built in a box that has no width yet (a host that mounts the view in the same pass that sizes its column, as the side panel does when it opens
    // again) lays itself out at that width, which squeezes the sidebar to its narrowest and leaves it there once the box grows. So the group is built when the
    // box has a width, and stays built.
    const [sized, setSized] = useState(false);
    // A scope is drawn from the tree's own entries, and its folders below the first level are not listed until they are opened: list every root of the scope whole,
    // once the tree has, and again (all of them, which a tree that holds them already lists once more) when the set of roots changes. The roots are read here, so that the view
    // (an observer) follows a scope whose list changes.
    const ready = manager.tree.status === 'ready';
    // With no file open the editor has nothing to show, and a tree hidden then leaves an empty panel: the tree is shown whatever the host asked for, and the button that
    // would hide it is not there. The host's choice is not changed: it applies again as soon as a file is open, which is how a single file can be edited with the tree away.
    const nothingOpen = manager.tabs.documents.length === 0;
    const shown = sidebarOpen || nothingOpen;
    const toggle = nothingOpen ? undefined : onSidebarToggle;
    const rootsKey = scope ? scope.roots.map(({ root }) => root).join('\n') : '';

    useEffect(() => {
        if (scope && ready) {
            for (const root of rootsKey === '' ? [] : rootsKey.split('\n')) {
                manager.tree.loadDeep(root).catch((error: unknown) => manager.notify('Couldn’t list the folder', error));
            }
        }
    }, [manager, scope, ready, rootsKey]);

    // A scope has a filter of its own: the manager's goes through the provider, whose search can leave the scope's folders out.
    const [scopeQuery, setScopeQuery] = useState('');
    const scoped = scope ? scopeFilter(manager.tree, scope, scopeQuery) : undefined;

    useEffect(() => {
        if (rootWidth > 0) {
            setSized(true);
        }
    }, [rootWidth]);

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
        <div ref={rootRef} className={cn(styles.root, className)} onKeyDown={handleKeyDown}>
            <Show when={sized}>
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
                            toolbar={!shown && toggle && <SidebarToggle open={false} onPress={toggle} />}
                        />
                    </ResizablePanel>

                    <Show when={shown}>
                        <Sidebar panelRef={sidebar} width={sidebarWidth}>
                            <Panel side="right" className={styles.sidebar}>
                                <PanelHeader>
                                    <FilterField
                                        manager={manager}
                                        placeholder={filterPlaceholder}
                                        scoped={scope ? { query: scopeQuery, onChange: setScopeQuery } : undefined}
                                        onSubmit={() => explorer.current?.openFirstMatch()}
                                    />
                                    <PanelHeader.Actions>
                                        {toggle && <SidebarToggle open onPress={toggle} />}
                                    </PanelHeader.Actions>
                                </PanelHeader>
                                <PanelTab>
                                    <Explorer
                                        ref={explorer}
                                        manager={manager}
                                        menuItems={menuItems}
                                        dndManager={dndManager}
                                        scope={scope}
                                        filter={scope ? (scoped ?? null) : undefined}
                                        emptyText={ready ? emptyText : undefined}
                                    />
                                </PanelTab>
                            </Panel>
                        </Sidebar>
                    </Show>
                </ResizablePanelGroup>
            </Show>
        </div>
    );
});

/**
 * The filter of the tree: the files whose name has what is typed, with the folders above them. Enter opens the first. It takes the place a title would have in the
 * header. A scope keeps its query in the view (`scoped`), and the manager's goes through the provider.
 */
const FilterField = observer(function FilterField({ manager, placeholder, scoped, onSubmit }: { manager: FileManager; placeholder: string; scoped?: { query: string; onChange: (query: string) => void }; onSubmit: () => void }) {
    const { filterQuery, filterResult } = manager;
    const query = scoped ? scoped.query : filterQuery;
    const pending = !scoped && filterQuery.trim() !== '' && filterResult?.query !== filterQuery;

    return (
        <SearchInput
            size="sm"
            variant="inline"
            className={styles.filter}
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onChange={(next: string) => (scoped ? scoped.onChange(next) : void manager.filter(next))}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    onSubmit();
                }
            }}
        >
            {pending ? <Spinner slot="suffix" size="xs" aria-label="Searching" /> : null}
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
