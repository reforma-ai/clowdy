import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { Command } from '../../hotkeys';

export const AGENTS_SCOPE = 'agents';

/** Puts the focus on a row, of a chat or of a run. The grid list's highlight plate follows the focus by itself. */
function focusRow(list: Element | null, id: string) {
    list?.querySelector<HTMLElement>(`[role="row"][data-key="${ CSS.escape(id) }"]`)?.focus();
}

/** A row of the list is a row of React Aria's grid list, whose `data-key` is the chat or run id. A button or a field inside a row is not the row. */
const rowId = (element: Element) => (element.getAttribute('role') === 'row' ? element.getAttribute('data-key') : null);

export interface AgentCommandDeps {
    /** The element that holds the grid list. */
    list: () => Element | null;
    /** The chats and runs in the order the list shows them. */
    ids: () => readonly string[];
    /** The row the screen shows: a chat, or the run opened below it. */
    openId: () => string | undefined;
}

/**
 * The commands of the Agents list, for the `agents` scope: `J` and `K` move the focus between its rows (chats and the runs below them), as the arrows do.
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
