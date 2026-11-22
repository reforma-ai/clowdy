import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { Command } from '../../hotkeys';
import type { DocsStore } from './DocsStore';

export const DOCS_SCOPE = 'docs';

/** A row of the tree is a `treeitem` with the key of its document or folder. A row's own keys and the editor are not the tree. */
const treeItemKey = (element: Element) => (element.getAttribute('role') === 'treeitem' ? (element as HTMLElement).dataset.key ?? null : null);

export interface DocTreeCommandDeps {
    /** The element with `role="tree"`. */
    tree: () => Element | null;
    /** The keys of the rows in the order the tree shows them. */
    ids: () => readonly string[];
    /** The open document's key. */
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
        focus: () => listFocusOf(tree(), treeItemKey),
        openId,
        focusItem: key => tree()?.querySelector<HTMLElement>(`[role="treeitem"][data-key="${ CSS.escape(key) }"]`)?.focus(),
    });
}

/**
 * `/` puts the keyboard in the search field. It belongs to the screen, not to a row,
 * so it works wherever the key is not a character of a text field, which the dispatcher already keeps out.
 */
export function docSearchCommand(focusSearch: () => void): Command {
    return {
        id: 'docs.search',
        title: 'Find document',
        group: 'Documents',
        keys: '/',
        scope: DOCS_SCOPE,
        handler: () => focusSearch(),
    };
}

/**
 * Save the open document with `Mod+S`, also from inside the editor. It is live only while there is something to save,
 * which is when the Save button is enabled, so its hint shows exactly then. The side panel has editors of its own (its Files tab saves a file with the same key):
 * with the focus there the key is theirs, and the document is saved by its own button.
 */
export function docSaveCommand(store: Pick<DocsStore, 'current' | 'save'>): Command {
    return {
        id: 'docs.save',
        title: 'Save document',
        group: 'Documents',
        keys: '$mod+s',
        scope: DOCS_SCOPE,
        inInputs: true,
        focus: () => document.activeElement?.closest('[data-side-panel]') == null,
        when: () => {
            const buffer = store.current;

            return buffer !== undefined && buffer.dirty && buffer.conflict === null;
        },
        handler: () => void store.save(),
    };
}
