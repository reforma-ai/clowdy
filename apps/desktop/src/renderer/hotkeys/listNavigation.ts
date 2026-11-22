import { stepTo } from './listCursor';

import type { Command } from './registry';

/**
 * Where the keyboard focus is, from a list's point of view.
 * `item`: on one of the list's items. `idle`: nothing in particular has it (the page body, or a button of the rail), so the list's keys may bring it in.
 * `other`: a control inside the list (a row's menu button, a rename field), another part of the screen, or a dialog: it keeps its own keys.
 */
export type ListFocus =
    | { zone: 'item'; id: string }
    | { zone: 'idle' }
    | { zone: 'other' };

/** The shell's navigation, which sits beside the screen. A `nav` inside the screen (a breadcrumb) is the screen's own control. */
function isRail(element: Element): boolean {
    const nav = element.closest('nav');

    return nav !== null && nav.closest('main') === null;
}

/**
 * The zone of the focused element, for a list whose items are the elements inside `region` that `itemId` names.
 * `itemId` gives the id of an item and null for anything else, so a button or an input inside a row is not the row.
 */
export function listFocusOf(region: Element | null, itemId: (element: Element) => string | null, active: Element | null = document.activeElement): ListFocus {
    if (active && region?.contains(active)) {
        const id = itemId(active);

        return id === null ? { zone: 'other' } : { zone: 'item', id };
    }

    if (!active || active === active.ownerDocument.body || active === active.ownerDocument.documentElement || isRail(active)) return { zone: 'idle' };

    return { zone: 'other' };
}

export interface ListMoveOptions {
    scope: string;
    /** `chats` makes the ids `chats.cursor.down` and `chats.cursor.up`. */
    prefix: string;
    /** The group of the shortcuts page. */
    group: string;
    /** The items in the order the list shows them. */
    ids: () => readonly string[];
    focus: () => ListFocus;
    /** The item that is open: where the first key lands while the focus is not on the list. */
    openId: () => string | null;
    focusItem: (id: string) => void;
    /** Called after the focus moved to an item, for a list whose focus opens its item. */
    follow?: (id: string) => void;
}

/**
 * `J` and `K` for a list that already has its own arrow keys, Home and End: they move the focus to the next and the previous item, the way the arrows do.
 * Only the list's own items take them, so a key never leaves a field, a row's control or a dialog. While nothing has the focus the first key brings it
 * to the open item without moving it, so it cannot skip an item the person has not seen.
 */
export function listMoveCommands({ scope, prefix, group, ids, focus, openId, focusItem, follow }: ListMoveOptions): Command[] {
    // The zone is a focus gate and not part of `when`: the key hints show these commands wherever the focus sits, and must not show them as dead.
    const inList = () => focus().zone !== 'other';
    const hasItems = () => ids().length > 0;

    const move = (direction: 'down' | 'up') => () => {
        const items = ids();
        const where = focus();

        if (where.zone === 'other' || items.length === 0) return;

        if (where.zone === 'idle') {
            const open = openId();

            focusItem(open !== null && items.includes(open) ? open : items[0]);

            return;
        }

        const target = stepTo([items], where.id, direction);

        if (target === null || target === where.id) return;

        focusItem(target);
        follow?.(target);
    };

    return [
        { id: `${ prefix }.cursor.down`, title: 'Move down', group, keys: 'j', scope, when: hasItems, focus: inList, repeat: true, handler: move('down') },
        { id: `${ prefix }.cursor.up`, title: 'Move up', group, keys: 'k', scope, when: hasItems, focus: inList, repeat: true, handler: move('up') },
    ];
}
