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

import { basename, isPathWithin, joinPath } from '../../paths';
import { isMac } from '../platform';
import styles from './Explorer.module.css';
import { DRAFT_ID, ExplorerContext, folderOf, hotkeyItem, targetsOf } from './explorerContext';
import { ExplorerAreaMenu } from './ExplorerMenu';
import { ExplorerDragPreview, ExplorerRow, ExplorerRowFrame } from './ExplorerRow';

import type { DragEvent, KeyboardEvent, Ref } from 'react';
import type { RenameHandler, TreeApi } from 'react-arborist';
import type { FileManager } from '../../FileManager';
import type { UploadItem } from '../../FileOperations';
import type { FileEntry, FileKind } from '../../provider';
import type { FileTree } from '../../tree/FileTree';
import type { ExplorerActions, ExplorerItem } from './explorerContext';
import type { FileMenuItem } from './ExplorerMenu';

const ROW_HEIGHT = 32;
const INDENT = 14;
/** How long a drag rests on a closed folder before it opens. */
const SPRING_OPEN_MS = 1500;

interface Draft {
    parent: string;
    kind: FileKind;
}

/** Every shown path as nested rows. An empty cutoff folder is a leaf; an unloaded folder with children keeps a chevron. */
function itemsOf(tree: FileTree, parent: string): ExplorerItem[] {
    return tree.children(parent).map(entry => ({
        id: entry.path,
        name: basename(entry.path),
        kind: entry.kind,
        children: folderChildren(tree, entry),
    }));
}

function folderChildren(tree: FileTree, entry: FileEntry): ExplorerItem[] | null {
    if (entry.kind !== 'directory' || entry.hasChildren === false) {
        return null;
    }

    const children = itemsOf(tree, entry.path);

    if (children.length > 0) {
        return children;
    }

    return entry.hasChildren ? [] : null;
}

/** `items` with the inline new row first among its kind in its folder. */
function withDraft(items: ExplorerItem[], draft: Draft, parent = ''): ExplorerItem[] {
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
function dropFolderAt(target: EventTarget): string {
    return (target as Element).closest<HTMLElement>('[data-folder]')?.dataset.folder ?? '';
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
    ref?: Ref<ExplorerHandle>;
}

/**
 * The file tree: virtualized, filtered by `manager.filter` (the host draws the field), with keyboard navigation and multi-select, inline
 * create and rename, row menus, copy and paste, drag to move, files dropped from outside, and the
 * active tab revealed. Open folders are kept on the manager, so they open again when the tab shows again.
 */
export const Explorer = observer(function Explorer({ manager, menuItems, dndManager, ref }: ExplorerProps) {
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
    const items = useMemo(() => computed(() => itemsOf(manager.tree, '')), [manager]).get();
    const data = draft ? withDraft(items, draft) : items;
    const { revealed, filterResult } = manager;
    const activePath = manager.tabs.activePath;
    const shown = useRef<{ revealed: typeof revealed; activePath: string | null }>({
        revealed: null,
        activePath: null,
    });
    const springOpen = useRef<{ folder: string; timer: ReturnType<typeof setTimeout> } | null>(null);

    useLayoutEffect(() => {
        setScrollElement(treeApi.current?.listEl.current ?? null);
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

        const ready = (path: string) => manager.tree.get(path) !== undefined || !manager.tree.isVisible(path);

        if (revealed !== shown.current.revealed && (!revealed || ready(revealed.path))) {
            shown.current.revealed = revealed;

            if (revealed && manager.tree.isVisible(revealed.path)) {
                reveal(api, revealed.path);
            }
        }

        if (activePath !== shown.current.activePath && (activePath === null || ready(activePath))) {
            shown.current.activePath = activePath;

            if (activePath !== null && manager.tree.isVisible(activePath)) {
                reveal(api, activePath);
            }
        }
    }, [manager, revealed, activePath, data, dndRoot]);

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
        draftParent: draft?.parent ?? null,
        dropFolder,
        menuItems,
        create: (parent, kind) => {
            if (parent !== '') {
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

        const created = await manager.operations.createFile(draft.parent, name);

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
            event.preventDefault();
            actions.copy(targetsOf(node).map(target => target.path));
        }
        else if (mod && event.code === 'KeyV' && manager.canPaste) {
            event.preventDefault();
            void manager.paste(folderOf(node.id, node.data.kind));
        }
        else if (event.key === 'F2' && node.id !== DRAFT_ID && !manager.readonly) {
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

        return selected ? folderOf(selected.id, selected.data.kind) : '';
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
    const isFileDrag = (event: DragEvent) => !manager.readonly && event.dataTransfer.types.includes('Files');

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        holdOver(null);
        setDropFolder(null);

        if (!isFileDrag(event)) {
            return;
        }

        event.preventDefault();

        const folder = dropFolderAt(event.target);
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
                        data-drop-target={dropFolder === '' || undefined}
                        onDragOver={event => {
                            if (manager.readonly) {
                                return;
                            }

                            const folder = dropFolderAt(event.target);

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
                                event.currentTarget.contains(target) &&
                                !target.closest('[role="treeitem"]')
                            ) {
                                areaMenu.areaProps.onContextMenu(event);
                            }
                        }}
                    >
                        <Show when={dndRoot}>
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
                                searchMatch={node => node.id === DRAFT_ID || (filterResult?.paths.has(node.id) ?? false)}
                                className={styles.list}
                                aria-label="Files"
                                disableEdit={manager.readonly}
                                disableDrag={manager.readonly}
                                // A drag from another tree on the shared manager brings no rows of this one.
                                disableDrop={({ parentNode, dragNodes }) =>
                                    dragNodes.length === 0 || dragNodes.every(node => node.parent?.id === parentNode.id)
                                }
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
                                onMove={({ dragIds, parentId }) => {
                                    void manager.operations.move(dragIds, parentId ?? '', {
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
