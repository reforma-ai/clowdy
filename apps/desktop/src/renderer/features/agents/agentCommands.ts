import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { Command } from '../../hotkeys';

export const AGENTS_SCOPE = 'agents';

/** Puts the focus on a row, of a chat or of a thread. The grid list's highlight plate follows the focus by itself. */
function focusRow(list: Element | null, id: string) {
    list?.querySelector<HTMLElement>(`[role="row"][data-key="${ CSS.escape(id) }"]`)?.focus();
}

/** A row of the list is a row of React Aria's grid list, whose `data-key` is the chat's id (a thread is a chat). A button or a field inside a row is not the row. */
const rowId = (element: Element) => (element.getAttribute('role') === 'row' ? element.getAttribute('data-key') : null);

export interface AgentCommandDeps {
    /** The element that holds the grid list. */
    list: () => Element | null;
    /** The rows in the order the list shows them: the chats, and the threads of the folds that are open. */
    ids: () => readonly string[];
    /** The row the screen shows: the open chat or thread. */
    openId: () => string | undefined;
}

/**
 * The commands of the Agents list, for the `agents` scope: `J` and `K` move the focus between its rows (chats and the threads below them), as the arrows do.
 * The grid list keeps the arrows, Home and End, and Enter and Space, which open the focused chat, so only the aliases are ours.
 */
export function agentCommands({ list, ids, openId }: AgentCommandDeps): Command[] {
    return listMoveCommands({
        scope: AGENTS_SCOPE,
        prefix: 'agents',
        group: 'Agents',
        ids,
        focus: () => listFocusOf(list(), rowId),
        openId: () => openId() ?? null,
        focusItem: id => focusRow(list(), id),
    });
}
