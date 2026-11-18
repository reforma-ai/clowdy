import { listFocusOf, listMoveCommands } from '../../hotkeys/listNavigation';

import type { Command } from '../../hotkeys';

export const CHATS_SCOPE = 'chats';

/** Puts the focus on a chat's row. The grid list's highlight plate follows the focus by itself. */
function focusRow(list: Element | null, chatId: string) {
    list?.querySelector<HTMLElement>(`[role="row"][data-key="${ CSS.escape(chatId) }"]`)?.focus();
}

/** A row of the list is a row of React Aria's grid list, whose `data-key` is the chat id. A button or a field inside a row is not the row. */
const rowId = (element: Element) => (element.getAttribute('role') === 'row' ? element.getAttribute('data-key') : null);

export interface ChatCommandDeps {
    /** The element that holds the grid list. */
    list: () => Element | null;
    /** The chats in the order the list shows them. */
    ids: () => readonly string[];
    /** The chat the screen shows. */
    openId: () => string | undefined;
}

/**
 * The commands of the Chats list, for the `chats` scope: `J` and `K` move the focus between chats, as the arrows do.
 * The grid list keeps the arrows, Home and End, and Enter and Space, which open the focused chat, so only the aliases are ours.
 */
export function chatCommands({ list, ids, openId }: ChatCommandDeps): Command[] {
    return listMoveCommands({
        scope: CHATS_SCOPE,
        prefix: 'chats',
        group: 'Chats',
        ids,
        focus: () => listFocusOf(list(), rowId),
        openId: () => openId() ?? null,
        focusItem: id => focusRow(list(), id),
    });
}
