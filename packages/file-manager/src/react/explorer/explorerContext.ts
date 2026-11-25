import { createContext, use } from 'react';

import { dirname } from '../../paths';
import { isMac } from '../platform';

import type { NodeApi } from 'react-arborist';
import type { FileManager } from '../../FileManager';
import type { FileEntry, FileKind } from '../../provider';
import type { FileMenuItem } from './ExplorerMenu';

/** An explorer row: a listed path, the inline row for a new one (`DRAFT_ID`), or the gray label that heads a scope's root (`heading`). */
export interface ExplorerItem {
    id: string;
    name: string;
    kind: FileKind;
    children: ExplorerItem[] | null;
    /** Set on a label row: the root folder it heads. A label is not a path and not a file or a folder of the tree: it cannot be selected, opened, renamed, dragged or dropped on. */
    heading?: string;
}

/** One root of a scope: a folder of the tree whose entries are drawn under a gray label. */
export interface ExplorerScopeRoot {
    /** Names the root among the others, for the label row's id. */
    id: string;
    /** What the gray label row says. */
    label: string;
    /** The folder whose children are the rows under the label (`.briefback`). */
    root: string;
}

/**
 * A part of the tree the explorer draws in place of the whole: the entries below each of several roots, each root under a gray label row, in the order given. The first
 * root that has rows (the first one when none has) is the folder a new row, a paste and a drop default to. The hidden and excluded globs do not apply to it.
 */
export interface ExplorerScope {
    /**
     * The roots, in the order they are drawn. A root with no included entry is not drawn. It may be a getter that reads observable state (the explorer and the view
     * observe it): when the list changes the rows are drawn again and every new root is listed whole.
     */
    roots: ReadonlyArray<ExplorerScopeRoot>;
    /** What the tree is called to a screen reader, in place of `Files`. */
    label?: string;
    /** Which entries are rows; folders are asked too. Without it every entry is. */
    include?: (path: string, kind: FileKind) => boolean;
    /** The name a file gets from the one that was typed for it (a document gets `.md` when it has none). */
    fileName?: (name: string) => string;
}

/** A name filter a host draws in place of the manager's: the query and the paths of the files that have it. */
export interface ExplorerFilter {
    query: string;
    paths: ReadonlySet<string>;
}

/** The id of the inline new row; no listed path starts with a slash. */
export const DRAFT_ID = '/new';

/** What the id of a label row starts with, then the root's `id`; no listed path starts with a slash either. */
export const HEADING_PREFIX = '/root:';

/** What rows and menus can do; the explorer provides it, since react-arborist renders rows itself. */
export interface ExplorerActions {
    manager: FileManager;
    /** The folder the top rows are in, and the one a new row, a paste and a drop default to: `''` for the whole tree, for a scope its first root that has rows. */
    root: string;
    /** The name a file gets from the one typed for it, as a scope says (a document gets `.md`); the typed name as it is without one. */
    fileName?: (name: string) => string;
    /** Folder the inline new row creates in, while it shows. */
    draftParent: string | null;
    /** Folder that files dragged in from outside would go in, while they are over the tree. */
    dropFolder: string | null;
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
    onEntryDragStart?: (targets: readonly FileEntry[], transfer: DataTransfer) => void;
    /** Shows the inline new row inside `parent`. */
    create: (parent: string, kind: FileKind) => void;
    /** Shows the inline rename input on a row. */
    rename: (path: string) => void;
    /** Puts the items on the system clipboard as files, for Paste here and in the host's file manager. */
    copy: (paths: readonly string[]) => void;
    /** Asks first, then deletes. */
    delete: (targets: readonly FileEntry[]) => void;
}

/** What a row's menu or key acts on: the selection when the row is in it, otherwise the row. */
export function targetsOf(node: NodeApi<ExplorerItem>): FileEntry[] {
    return (node.isSelected ? node.tree.selectedNodes : [node])
        .filter(target => target.id !== DRAFT_ID && target.data.heading === undefined)
        .map(target => ({ path: target.id, kind: target.data.kind }));
}

/** The folder a new item or a paste goes in: a folder itself, or the folder a file is in. */
export function folderOf(path: string, kind: FileKind): string {
    return kind === 'directory' ? path : dirname(path);
}

/** The folder a new item or a paste goes in for a row: the root a label heads, or `folderOf` the row's path. */
export function folderOfNode(node: NodeApi<ExplorerItem>): string {
    return node.data.heading ?? folderOf(node.id, node.data.kind);
}

/** The host item whose ⌘ (Ctrl off Mac) + letter this key press is. */
export function hotkeyItem(
    items: readonly FileMenuItem[],
    event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>
): FileMenuItem | undefined {
    const mod = (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;

    return mod ? items.find(item => item.hotkey && event.code === `Key${item.hotkey.toUpperCase()}`) : undefined;
}

export const ExplorerContext = createContext<ExplorerActions | null>(null);

export function useExplorer(): ExplorerActions {
    const actions = use(ExplorerContext);

    if (!actions) {
        throw new Error('Explorer rows render inside the explorer');
    }

    return actions;
}
