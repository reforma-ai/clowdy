import { useListHoverHighlight } from '@clowdy/components/List';
import { openConfirmModal } from '@clowdy/components/modals';
import { PanelEmptyRow } from '@clowdy/components/Panel';
import { useContextMenu } from '@clowdy/components/Popover';
import {
    elementScrollAxisSource,
    ScrollChromeBars,
    ScrollChromeRoot,
    useScrollChrome,
} from '@clowdy/components/Scrollable';
import { Show } from '@clowdy/components/Show';
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tree } from 'react-arborist';
import useResizeObserver from 'use-resize-observer';

import { basename, dirname, isPathWithin, joinPath } from '../../paths';
import { isMac } from '../platform';
import styles from './Explorer.module.css';
import { DRAFT_ID, ExplorerContext, folderOfNode, HEADING_PREFIX, hotkeyItem, targetsOf } from './explorerContext';
import { ExplorerAreaMenu } from './ExplorerMenu';
import { ExplorerDragPreview, ExplorerRow, ExplorerRowFrame } from './ExplorerRow';
import { matchedRoots, rootAtIndex } from './scopeRows';

import type { DragEvent, KeyboardEvent, Ref } from 'react';
import type { RenameHandler, TreeApi } from 'react-arborist';
import type { FileManager } from '../../FileManager';
import type { UploadItem } from '../../FileOperations';
import type { FileEntry, FileKind } from '../../provider';
import type { FileTree } from '../../tree/FileTree';
import type { ExplorerActions, ExplorerFilter, ExplorerItem, ExplorerScope, ExplorerScopeRoot } from './explorerContext';
import type { FileMenuItem } from './ExplorerMenu';

const ROW_HEIGHT = 32;
const INDENT = 14;
/** How long a drag rests on a closed folder before it opens. */
const SPRING_OPEN_MS = 1500;

interface Draft {
    parent: string;
    kind: FileKind;
}

/** The entries that are rows below `parent`: the shown ones, or, in a scope, the ones the scope includes, hidden or not. */
function rowsOf(tree: FileTree, parent: string, scope: ExplorerScope | undefined): readonly FileEntry[] {
    if (!scope) {
        return tree.children(parent);
    }

    return tree.entriesOf(parent).filter(entry => scope.include?.(entry.path, entry.kind) ?? true);
}

/** Every shown path as nested rows. An empty cutoff folder is a leaf; an unloaded folder with children keeps a chevron. */
function itemsOf(tree: FileTree, parent: string, scope?: ExplorerScope): ExplorerItem[] {
    return rowsOf(tree, parent, scope).map(entry => ({
        id: entry.path,
        name: basename(entry.path),
        kind: entry.kind,
        children: folderChildren(tree, entry, scope),
    }));
}

function folderChildren(tree: FileTree, entry: FileEntry, scope: ExplorerScope | undefined): ExplorerItem[] | null {
    if (entry.kind !== 'directory' || entry.hasChildren === false) {
        return null;
    }

    const children = itemsOf(tree, entry.path, scope);

    if (children.length > 0) {
        return children;
    }

    return entry.hasChildren ? [] : null;
}

interface RootRows {
    root: ExplorerScopeRoot;
    rows: ExplorerItem[];
}

const NO_ROOTS: ReadonlyArray<ExplorerScopeRoot> = [];

/** The rows of every root of a scope, each root's own, in the order the scope gives its roots. */
function rootRowsOf(tree: FileTree, scope: ExplorerScope): RootRows[] {
    return scope.roots.map(root => ({ root, rows: itemsOf(tree, root.root, scope) }));
}

/** The gray label row that heads a root. */
function headingOf({ id, label, root }: ExplorerScopeRoot): ExplorerItem {
    return { id: `${HEADING_PREFIX}${id}`, name: label, kind: 'directory', children: null, heading: root };
}

/** The rows of a scope as one list: each root that has rows (or hosts the inline new row) under its label, in order. */
function scopedData(groups: readonly RootRows[], draft: Draft | null): ExplorerItem[] {
    return groups.flatMap(({ root, rows }) => {
        const hosts = draft !== null && isPathWithin(draft.parent, root.root);

        if (rows.length === 0 && !hosts) {
            return [];
        }

        return [headingOf(root), ...(draft && hosts ? withDraft(rows, draft, root.root) : rows)];
    });
}

/** `items` with the inline new row first among its kind in its folder. */
function withDraft(items: ExplorerItem[], draft: Draft, parent: string): ExplorerItem[] {
    if (draft.parent === parent) {
        const index = draft.kind === 'directory' ? 0 : items.filter(item => item.kind === 'directory').length;
        const row = { id: DRAFT_ID, name: '', kind: draft.kind, children: null };

        return [...items.slice(0, index), row, ...items.slice(index)];
    }

    // An empty folder is a leaf until the row goes in.
    return items.map(item =>
        item.kind === 'directory' && isPathWithin(draft.parent, item.id)
            ? { ...item, children: withDraft(item.children ?? [], draft, item.id) }
            : item
    );
}

/** Selects a row, opens the folders above it and scrolls it into view, without taking focus. */
function reveal(api: TreeApi<ExplorerItem>, path: string): void {
    const focused = api.hasFocus;

    api.openParents(path);

    if (!api.isSelected(path)) {
        api.setSelection({ ids: [path], anchor: path, mostRecent: path });
    }

    // `focus` also marks the tree focused, which moves DOM focus to the row. Outside the tree, the
    // row is only where keyboard navigation starts.
    api.focus(path);

    if (!focused) {
        api.onBlur();
    }
}

function confirmDelete(manager: FileManager, targets: readonly FileEntry[]): void {
    const [first] = targets;

    if (!first) {
        return;
    }

    const name = `“${basename(first.path)}”`;
    const folder = first.kind === 'directory';
    const many = targets.length > 1;

    openConfirmModal({
        title: many ? `Delete ${targets.length} items` : `Delete ${folder ? 'folder' : 'file'}`,
        message: `Delete ${many ? `${targets.length} items` : folder ? `${name} and everything in it` : name}? ${
            manager.provider.capabilities?.trash ? 'You can undo this.' : 'This can’t be undone.'
        }`,
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: async () => {
            await manager.operations.delete(targets.map(target => target.path));
        },
    });
}

/** Asks whether to replace items a move would overwrite. */
function askToReplace(manager: FileManager, names: readonly string[]): Promise<boolean> {
    const many = names.length > 1;

    return new Promise(resolve => {
        openConfirmModal(
            {
                title: many ? `Replace ${names.length} items?` : `Replace “${names[0]}”?`,
                message: `The folder already has ${many ? `items named ${names.map(name => `“${name}”`).join(', ')}` : 'an item with this name'}. ${
                    manager.provider.capabilities?.trash ? 'You can undo this.' : 'This can’t be undone.'
                }`,
                confirmLabel: 'Replace',
                destructive: true,
                onConfirm: () => resolve(true),
            },
            {
                onCancel: () => resolve(false),
                onClose: () => resolve(false),
            }
        );
    });
}

function NoCursor() {
    return null;
}

/** The folder a drop on `target` goes in: its row's folder, or the root below the rows. */
function dropFolderAt(target: EventTarget, root: string): string {
    return (target as Element).closest<HTMLElement>('[data-folder]')?.dataset.folder ?? root;
}

/** A dropped folder's entries; `readEntries` hands them over in batches until an empty one. */
async function readFolder(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));

    return batch.length === 0 ? [] : [...batch, ...(await readFolder(reader))];
}

/** Dropped files and folders as upload items, each folder before what it holds. */
async function uploadItems(entries: readonly FileSystemEntry[], parent = ''): Promise<UploadItem[]> {
    const items: UploadItem[] = [];

    for (const entry of entries) {
        const path = joinPath(parent, entry.name);

        if (entry.isFile) {
            items.push({
                path,
                file: await new Promise<File>((resolve, reject) =>
                    (entry as FileSystemFileEntry).file(resolve, reject)
                ),
            });
        }
        else if (entry.isDirectory) {
            items.push(
                { path, file: null },
                ...(await uploadItems(await readFolder((entry as FileSystemDirectoryEntry).createReader()), path))
            );
        }
    }

    return items;
}

/** What the panel header asks of the explorer. */
export interface ExplorerHandle {
    /** Shows the inline new row in the selected folder, or next to the selected file. */
    create: (kind: FileKind) => void;
    /** Pastes into the selected folder, or next to the selected file. */
    paste: () => void;
    /** Opens the first file the filter shows: Enter in the filter field, which the host draws. */
    openFirstMatch: () => void;
}

export interface ExplorerProps {
    manager: FileManager;
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
    dndManager?: Parameters<typeof Tree<ExplorerItem>>[0]['dndManager'];
    /** Draws a part of the tree: the entries below a folder, by rules of its own. Keep the value stable. */
    scope?: ExplorerScope;
    /** A name filter the host draws, in place of the manager's (`manager.filter`): the rows are the files it found, with their folders. */
    filter?: ExplorerFilter | null;
    /** What the tree says while it has no rows and no filter is typed: a scope that has nothing in it yet. */
    emptyText?: string;
    ref?: Ref<ExplorerHandle>;
}

/**
 * The file tree: virtualized, filtered by `manager.filter` (the host draws the field), with keyboard navigation and multi-select, inline
 * create and rename, row menus, copy and paste, drag to move, files dropped from outside, and the
 * active tab revealed. Open folders are kept on the manager, so they open again when the tab shows again.
 */
export const Explorer = observer(function Explorer({ manager, menuItems, dndManager, scope, filter, emptyText, ref }: ExplorerProps) {
    const treeApi = useRef<TreeApi<ExplorerItem>>(null);
    const { width = 0, height = 0, ref: measure } = useResizeObserver<HTMLDivElement>();
    // The tree's own element is where react-dnd's HTML5 backend listens (see `dndRootElement`): on the window, the backend would also cancel the native drags of the
    // host's other screens, since it takes every drag it does not know for a stray one. It must exist when the tree first renders, so the tree waits for it.
    const [dndRoot, setDndRoot] = useState<HTMLDivElement | null>(null);
    const treeHost = useCallback(
        (element: HTMLDivElement | null) => {
            measure(element);
            setDndRoot(element);
        },
        [measure]
    );
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [dropFolder, setDropFolder] = useState<string | null>(null);
    const areaMenu = useContextMenu();
    const [initialOpenState] = useState<Record<string, boolean>>(() =>
        Object.fromEntries([...manager.openFolders].map(path => [path, true]))
    );
    // A scope's rows are read from its roots as they are now (the list may change with the tree): the explorer is an observer, so a root is drawn when it comes.
    const groups = useMemo(() => computed(() => (scope ? rootRowsOf(manager.tree, scope) : null)), [manager, scope]).get();
    const items = useMemo(() => computed(() => (scope ? [] : itemsOf(manager.tree, '', undefined))), [manager, scope]).get();
    const roots = groups?.map(group => group.root) ?? NO_ROOTS;
    const hasRows = groups ? groups.some(group => group.rows.length > 0) : items.length > 0;
    // The folder a new row, a paste and a drop default to: the whole tree's, or the scope's first root that has rows (its first one when none has).
    const root = groups ? ((groups.find(group => group.rows.length > 0) ?? groups[0])?.root.root ?? '') : '';
    // A scope with no root has no folder to put anything in.
    const canCreate = !scope || roots.length > 0;
    const isRootFolder = (path: string) => (scope ? roots.some(candidate => candidate.root === path) : path === '');
    const data = groups ? scopedData(groups, draft) : draft ? withDraft(items, draft, '') : items;
    const { revealed } = manager;
    // The filter the host drew, or the manager's own.
    const filterResult = filter === undefined ? manager.filterResult : filter;
    const matchedHeadings = matchedRoots(filterResult, roots);
    const activePath = manager.tabs.activePath;
    const shown = useRef<{ revealed: typeof revealed; activePath: string | null }>({
        revealed: null,
        activePath: null,
    });
    // The rows a path can have depend on the scope, so a new scope asks for the active tab and a requested path to be shown again, as a first mount does.
    const shownScope = useRef(scope);
    const springOpen = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> } | null>(null);

    // The list is drawn once its host has a size, and takes its offset from the element after every resize. A list built with no size and asked to scroll to the open file
    // (the reveal below runs as the tree mounts, as when the side panel opens again) could end up at an offset the element was not at: the rows for that offset were drawn,
    // the ones above it were not, and the tree stayed that way until something scrolled it, as opening a file does.
    const sized = width > 0 && height > 0;

    useLayoutEffect(() => {
        const api = treeApi.current;
        const list = api?.listEl.current ?? null;

        setScrollElement(list);

        // Whatever moved the element on its own, the list takes its offset from the element again.
        if (api && list) {
            api.scrollToOffset(list.scrollTop);
        }
    }, [width, height]);

    useListHoverHighlight(scrollElement, scrollElement !== null, `.${styles.row}`);

    const getScrollElement = useCallback(() => scrollElement, [scrollElement]);
    const verticalSource = useMemo(() => elementScrollAxisSource(getScrollElement, 'vertical'), [getScrollElement]);
    const chrome = useScrollChrome({ verticalSource, sourceKey: scrollElement });

    // Reveal a requested path and the active tab once their rows exist, each change once.
    useEffect(() => {
        const api = treeApi.current;

        if (!api) {
            return;
        }

        if (shownScope.current !== scope) {
            shownScope.current = scope;
            shown.current = { revealed: null, activePath: null };
        }

        // A row exists for a path the tree shows, or in a scope, for one below a root of it that it includes.
        const visible = (path: string, kind: FileKind = 'file') =>
            scope
                ? roots.some(candidate => path !== candidate.root && isPathWithin(path, candidate.root)) && (scope.include?.(path, kind) ?? true)
                : manager.tree.isVisible(path);
        const ready = (path: string) => manager.tree.get(path) !== undefined || !visible(path);

        if (revealed !== shown.current.revealed && (!revealed || ready(revealed.path))) {
            shown.current.revealed = revealed;

            if (revealed && visible(revealed.path, manager.tree.get(revealed.path)?.kind)) {
                reveal(api, revealed.path);
            }
        }

        if (activePath !== shown.current.activePath && (activePath === null || ready(activePath))) {
            shown.current.activePath = activePath;

            if (activePath !== null && visible(activePath)) {
                reveal(api, activePath);
            }
        }
    }, [manager, scope, roots, revealed, activePath, data, dndRoot, sized]);

    // The inline new row edits as soon as it shows; cancelling removes it.
    useEffect(() => {
        if (!draft) {
            return;
        }

        void treeApi.current?.edit(DRAFT_ID).then(result => {
            if (result.cancelled) {
                setDraft(current => (current === draft ? null : current));
            }
        });
    }, [draft]);

    const actions: ExplorerActions = {
        manager,
        root,
        fileName: scope?.fileName,
        draftParent: draft?.parent ?? null,
        dropFolder,
        menuItems,
        create: (parent, kind) => {
            if (!isRootFolder(parent)) {
                treeApi.current?.openParents(parent);
                treeApi.current?.open(parent);
            }

            setDraft({ parent, kind });
        },
        rename: path => {
            // After the menu that asked for it closes, as react-arborist does for Enter.
            setTimeout(() => void treeApi.current?.edit(path));
        },
        copy: paths => void manager.copy(paths),
        delete: targets => confirmDelete(manager, targets),
    };

    const handleRename: RenameHandler<ExplorerItem> = async ({ id, name }) => {
        if (id !== DRAFT_ID) {
            const renamed = await manager.operations.rename(id, name);

            if (renamed) {
                manager.reveal(renamed);
            }

            return;
        }

        if (!draft) {
            return;
        }

        setDraft(null);

        if (draft.kind === 'directory') {
            const created = await manager.operations.createDirectory(draft.parent, name);

            if (created) {
                manager.reveal(created);
            }

            return;
        }

        const created = await manager.operations.createFile(draft.parent, scope?.fileName?.(name) ?? name);

        if (created) {
            await manager.open(created);
        }
    };

    // react-arborist handles navigation keys; delete, F2 rename, copy and paste are added here.
    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const api = treeApi.current;
        const node = api?.focusedNode;

        if (!api || !node || api.isEditing || !(event.target as Element).closest('[role="tree"]')) {
            return;
        }

        // ⌘ on macOS and Ctrl elsewhere, by physical key, as the view's own shortcuts.
        const mod = (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;

        if (mod && event.code === 'KeyC' && manager.canCopy) {
            const targets = targetsOf(node);

            if (targets.length > 0) {
                event.preventDefault();
                actions.copy(targets.map(target => target.path));
            }
        }
        else if (mod && event.code === 'KeyV' && manager.canPaste) {
            event.preventDefault();
            void manager.paste(folderOfNode(node));
        }
        else if (event.key === 'F2' && node.id !== DRAFT_ID && node.data.heading === undefined && !manager.readonly) {
            event.preventDefault();
            void api.edit(node);
        }
        else if ((event.key === 'Delete' || event.key === 'Backspace') && !manager.readonly) {
            const targets = targetsOf(node);

            if (targets.length > 0) {
                event.preventDefault();
                confirmDelete(manager, targets);
            }
        }
        else if (mod) {
            const targets = targetsOf(node);
            const item = hotkeyItem(menuItems?.(targets) ?? [], event);

            if (item && targets.length > 0) {
                event.preventDefault();
                item.onAction();
            }
        }
    };

    // New items and pastes from the panel menu go in the selected folder, or next to the selected file.
    const selectedFolder = () => {
        const selected = treeApi.current?.selectedNodes.at(-1);

        return selected ? folderOfNode(selected) : root;
    };

    useImperativeHandle(ref, () => ({
        create: kind => actions.create(selectedFolder(), kind),
        paste: () => void manager.paste(selectedFolder()),
        openFirstMatch: () => {
            const first = treeApi.current?.visibleNodes.find(node => filterResult?.paths.has(node.id));

            if (first) {
                void manager.open(first.id);
            }
        },
    }));

    // A closed folder that any drag rests on opens after a moment.
    const holdOver = (folder: string | null) => {
        if (springOpen.current?.folder === folder) {
            return;
        }

        clearTimeout(springOpen.current?.timer);
        springOpen.current = null;

        const node = folder ? treeApi.current?.get(folder) : null;

        if (folder && node?.isInternal && !node.isOpen) {
            springOpen.current = {
                folder,
                timer: setTimeout(() => {
                    springOpen.current = null;
                    treeApi.current?.open(folder);
                }, SPRING_OPEN_MS),
            };
        }
    };

    useEffect(() => () => clearTimeout(springOpen.current?.timer), []);

    // Files dragged in from outside go in the folder under the pointer.
    const isFileDrag = (event: DragEvent) => !manager.readonly && canCreate && event.dataTransfer.types.includes('Files');

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        holdOver(null);
        setDropFolder(null);

        if (!isFileDrag(event)) {
            return;
        }

        event.preventDefault();

        const folder = dropFolderAt(event.target, root);
        // The dropped items can be read only while the event is handled.
        const entries = [...event.dataTransfer.items]
            .map(item => item.webkitGetAsEntry())
            .filter(entry => entry !== null);

        void uploadItems(entries)
            .then(items => manager.operations.upload(items, folder))
            .then(([first]) => {
                if (first) {
                    manager.reveal(first);
                }
            })
            .catch((error: unknown) => manager.notify('Couldn’t read the dropped files', error));
    };

    return (
        <ExplorerContext value={actions}>
            <div className={styles.root} onKeyDown={handleKeyDown}>
                <ScrollChromeRoot
                    rootRef={chrome.rootRef}
                    className={styles.body}
                    vertical
                    rootPointerHandlers={chrome.rootPointerHandlers}
                >
                    <div
                        ref={treeHost}
                        className={styles.treeHost}
                        data-drop-target={dropFolder === root || undefined}
                        onDragOver={event => {
                            if (manager.readonly || !canCreate) {
                                return;
                            }

                            const folder = dropFolderAt(event.target, root);

                            holdOver(folder);

                            if (isFileDrag(event)) {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = 'copy';
                                setDropFolder(folder);
                            }
                        }}
                        onDragLeave={event => {
                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                holdOver(null);
                                setDropFolder(null);
                            }
                        }}
                        onDragEnd={() => holdOver(null)}
                        onDrop={handleDrop}
                        onContextMenu={event => {
                            // Rows open their own menu; the empty area below them is the root folder.
                            // Menus portal out of the DOM but bubble here, so the target must sit inside the host.
                            const target = event.target as Element;

                            if (
                                !manager.readonly &&
                                canCreate &&
                                event.currentTarget.contains(target) &&
                                !target.closest('[role="treeitem"], [data-heading]')
                            ) {
                                areaMenu.areaProps.onContextMenu(event);
                            }
                        }}
                    >
                        <Show when={dndRoot && sized}>
                            <Tree<ExplorerItem>
                                ref={treeApi}
                                data={data}
                                width={width}
                                height={height}
                                rowHeight={ROW_HEIGHT}
                                indent={INDENT}
                                openByDefault={false}
                                initialOpenState={initialOpenState}
                                // Filtered, the tree shows the files the filter found, the inline new row, and the folders above them, open.
                                searchTerm={filterResult?.query ?? ''}
                                searchMatch={node =>
                                    node.id === DRAFT_ID ||
                                    (filterResult?.paths.has(node.id) ?? false) ||
                                    (node.data.heading !== undefined && matchedHeadings.has(node.data.heading))}
                                className={styles.list}
                                aria-label={scope?.label ?? 'Files'}
                                // A label row is neither selected, renamed nor dragged.
                                disableSelect={item => item.heading !== undefined}
                                disableEdit={item => manager.readonly || item.heading !== undefined}
                                disableDrag={item => manager.readonly || item.heading !== undefined}
                                // A drag from another tree on the shared manager brings no rows of this one. A drop at the top level of a scope lands in the root whose label is above that
                                // place, so it moves nothing only for rows that are in that root already.
                                disableDrop={({ parentNode, dragNodes, index }) => {
                                    if (dragNodes.length === 0) {
                                        return true;
                                    }

                                    if (scope && parentNode.isRoot) {
                                        const destination = rootAtIndex(data, index, root);

                                        return dragNodes.every(node => dirname(node.id) === destination);
                                    }

                                    return dragNodes.every(node => node.parent?.id === parentNode.id);
                                }}
                                onToggle={id => {
                                    const api = treeApi.current;
                                    const open = api?.isOpen(id) ?? false;

                                    // Filtered folders open on their own; only the unfiltered tree's choice is kept for the next mount.
                                    if (api && !api.isFiltered) {
                                        if (open) {
                                            manager.openFolders.add(id);
                                        }
                                        else {
                                            manager.openFolders.delete(id);
                                        }
                                    }

                                    if (open) {
                                        manager.tree.load(id).catch((error: unknown) => {
                                            manager.notify('Couldn’t list the folder', error);
                                            api?.close(id);
                                        });
                                    }
                                }}
                                onActivate={node => {
                                    if (node.data.kind === 'file' && node.id !== DRAFT_ID) {
                                        void manager.open(node.id);
                                    }
                                }}
                                onRename={handleRename}
                                onMove={({ dragIds, parentId, index }) => {
                                    void manager.operations.move(dragIds, parentId ?? (scope ? rootAtIndex(data, index, root) : root), {
                                        confirmReplace: names => askToReplace(manager, names),
                                    });
                                }}
                                renderRow={ExplorerRowFrame}
                                renderCursor={NoCursor}
                                renderDragPreview={ExplorerDragPreview}
                                dndManager={dndManager}
                                dndRootElement={dndRoot}
                            >
                                {ExplorerRow}
                            </Tree>
                        </Show>
                        <Show when={filterResult?.paths.size === 0}>
                            <PanelEmptyRow className={styles.empty}>No matches</PanelEmptyRow>
                        </Show>
                        <Show when={emptyText !== undefined && !hasRows && !draft && !filterResult}>
                            <PanelEmptyRow className={styles.empty}>{emptyText}</PanelEmptyRow>
                        </Show>
                    </div>
                    <ScrollChromeBars
                        vertical
                        setScrollbarV={chrome.setScrollbarV}
                        onPointerDown={chrome.handlePointerDown}
                    />
                </ScrollChromeRoot>
                <Show when={areaMenu.isOpen}>
                    <ExplorerAreaMenu contextMenu={areaMenu} />
                </Show>
            </div>
        </ExplorerContext>
    );
});
