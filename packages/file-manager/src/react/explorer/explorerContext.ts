import { createContext, use } from 'react';

import { dirname } from '../../paths';
import { isMac } from '../platform';

import type { NodeApi } from 'react-arborist';
import type { FileManager } from '../../FileManager';
import type { FileEntry, FileKind } from '../../provider';
import type { FileMenuItem } from './ExplorerMenu';

/** An explorer row: a listed path, or the inline row for a new one (`DRAFT_ID`). */
export interface ExplorerItem {
    id: string;
    name: string;
    kind: FileKind;
    children: ExplorerItem[] | null;
}

/**
 * A part of the tree the explorer draws in place of the whole: the rows are the entries below `root`, with `root` itself as the folder a new row, a paste and a drop
 * default to. The hidden and excluded globs do not apply to it.
 */
export interface ExplorerScope {
    /** The folder whose children are the top rows (`.clowdy/docs`). */
    root: string;
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

/** What rows and menus can do; the explorer provides it, since react-arborist renders rows itself. */
export interface ExplorerActions {
    manager: FileManager;
    /** The folder the top rows are in: `''` for the whole tree, the scope's root for a part of it. */
    root: string;
    /** Folder the inline new row creates in, while it shows. */
    draftParent: string | null;
    /** Folder that files dragged in from outside would go in, while they are over the tree. */
    dropFolder: string | null;
    menuItems?: (targets: readonly FileEntry[]) => FileMenuItem[];
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
        .filter(target => target.id !== DRAFT_ID)
        .map(target => ({ path: target.id, kind: target.data.kind }));
}

/** The folder a new item or a paste goes in: a folder itself, or the folder a file is in. */
export function folderOf(path: string, kind: FileKind): string {
    return kind === 'directory' ? path : dirname(path);
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
