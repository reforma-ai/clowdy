import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { RunId } from '@clowdy/protocol';
import type { Command } from '../../hotkeys';

export const AGENTS_SCOPE = 'agents';

/** A row of the tree is a `treeitem` with the run's id. A chevron or a task chip inside it has its own keys and is not the row. */
const treeItemId = (element: Element) => (element.getAttribute('role') === 'treeitem' ? (element as HTMLElement).dataset.runId ?? null : null);

/** Puts the keyboard focus on the run's row. The tree's arrow keys and the commands move it the same way. */
export function focusRun(tree: Element | null, runId: RunId) {
    tree?.querySelector<HTMLElement>(`[data-run-id="${ CSS.escape(runId) }"]`)?.focus();
}

export interface RunCommandDeps {
    /** The element with `role="tree"`. */
    tree: () => Element | null;
    /** The runs in the order the tree shows them. */
    ids: () => readonly RunId[];
    /** The selected run. */
    openId: () => RunId | null;
    /** Selects a run. In this tree the focus selects: an arrow key shows the run it lands on. */
    select: (runId: RunId) => void;
}

/**
 * The commands of the run tree, for the `agents` scope: `J` and `K` move to the next and the previous row, as the arrows do, and select it.
 * The tree's own `onKeyDown` keeps the arrows, Home, End, Enter and Space.
 */
export function runCommands({ tree, ids, openId, select }: RunCommandDeps): Command[] {
    return listMoveCommands({
        scope: AGENTS_SCOPE,
        prefix: 'agents',
        group: 'Agents',
        ids,
        focus: () => listFocusOf(tree(), treeItemId),
        openId,
        focusItem: runId => focusRun(tree(), runId),
        follow: select,
    });
}
