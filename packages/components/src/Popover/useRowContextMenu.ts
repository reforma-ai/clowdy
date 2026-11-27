import { useEffect, useState } from 'react';

import { type UseContextMenuResult, useContextMenu } from './useContextMenu';

import type { KeyboardEvent, MouseEvent } from 'react';

export interface UseRowContextMenuOptions {
    /** A row of the list, with its key in `data-key`: `'[role="row"][data-key]'` for a `GridList`, `'[role="option"][data-key]'` for a `ListBox`. */
    rowSelector: string;
    /** Whether the menu acts on a row with this key; a row it does not know opens nothing. */
    isKnown?: (key: string) => boolean;
}

export interface UseRowContextMenuResult extends Omit<UseContextMenuResult, 'areaProps'> {
    /** Spread onto an element around the list: a right click on a row, or the ContextMenu key or Shift+F10 on the focused row, opens the menu. */
    areaProps: {
        onContextMenu: (event: MouseEvent) => void;
        onKeyDown: (event: KeyboardEvent) => void;
    };
    /** The key of the row the menu was last opened on. */
    rowKey: string | undefined;
}

/**
 * `useContextMenu` for the rows of a list: it finds the row from the event, remembers its key and opens the menu at the pointer, or under the row
 * from the keyboard (the focused row, or the one `aria-activedescendant` names). The menu closes when the component unmounts. Render the `Popover`
 * only while `isOpen`, as for `useContextMenu`.
 */
export function useRowContextMenu({ rowSelector, isKnown }: UseRowContextMenuOptions): UseRowContextMenuResult {
    const menu = useContextMenu();
    const [rowKey, setRowKey] = useState<string>();
    const { close } = menu;

    useEffect(() => close, [close]);

    const select = (row: Element | null) => {
        const key = row?.getAttribute('data-key');

        if (!key || (isKnown && !isKnown(key))) {
            return false;
        }

        setRowKey(key);

        return true;
    };

    const onContextMenu = (event: MouseEvent) => {
        if (select((event.target as Element).closest(rowSelector))) {
            menu.areaProps.onContextMenu(event);
        }
    };

    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
            return;
        }

        const target = event.target as Element;
        const activeId = target.getAttribute('aria-activedescendant');
        const active = activeId ? target.ownerDocument.getElementById(activeId) : target;
        const row = active?.closest(rowSelector) ?? null;

        if (!row || !event.currentTarget.contains(row) || !select(row)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const rect = row.getBoundingClientRect();

        menu.openAt(rect.left, rect.bottom);
    };

    return { ...menu, areaProps: { onContextMenu, onKeyDown }, rowKey };
}
