import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { Command } from '../../hotkeys';
import type { DocsStore } from './DocsStore';

export const DOCS_SCOPE = 'docs';

/** A row of the tree is a `treeitem` with the document's path, a folder's too. A row's own keys and the editor are not the tree. */
const treeItemPath = (element: Element) => (element.getAttribute('role') === 'treeitem' ? (element as HTMLElement).dataset.path ?? null : null);

export interface DocTreeCommandDeps {
    /** The element with `role="tree"`. */
    tree: () => Element | null;
    /** The paths of the rows in the order the tree shows them. */
    ids: () => readonly string[];
    /** The open document's path. */
    openId: () => string | null;
}

/**
 * The commands of the documents tree, for the `docs` scope: `J` and `K` move the focus to the next and the previous row, as the arrows do.
 * The tree's own `onKeyDown` keeps the arrows, Home, End, Enter and Space.
 */
export function docTreeCommands({ tree, ids, openId }: DocTreeCommandDeps): Command[] {
    return listMoveCommands({
        scope: DOCS_SCOPE,
        prefix: 'docs',
        group: 'Documents',
        ids,
        focus: () => listFocusOf(tree(), treeItemPath),
        openId,
        focusItem: path => tree()?.querySelector<HTMLElement>(`[role="treeitem"][data-path="${ CSS.escape(path) }"]`)?.focus(),
    });
}

/**
 * Save the open document with `Mod+S`, also from inside the editor. It is live only while there is something to save,
 * which is when the Save button is enabled, so its hint shows exactly then.
 */
export function docSaveCommand(store: Pick<DocsStore, 'current' | 'save'>): Command {
    return {
        id: 'docs.save',
        title: 'Save document',
        group: 'Documents',
        keys: '$mod+s',
        scope: DOCS_SCOPE,
        inInputs: true,
        when: () => {
            const buffer = store.current;

            return buffer !== undefined && buffer.dirty && buffer.conflict === null;
        },
        handler: () => void store.save(),
    };
}
