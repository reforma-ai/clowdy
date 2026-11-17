'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { For } from '../For';
import { ListBox, ListBoxHeader, ListBoxItem, ListBoxSection } from '../List';
import listStyles from '../List/ListBox.module.css';
import { Scrollable } from '../Scrollable';
import { Show } from '../Show';
import styles from './RichInputTriggerMenu.module.css';

import type { RichInputTriggerItem, RichInputTriggerPlacement } from './types';

export type RichInputTriggerAnchor = {
    x: number;
    top: number;
    bottom: number;
    /** Host box width — menu matches this instead of 260–360 caret sizing. */
    width?: number;
};

export type RichInputTriggerMenuProps = {
    isOpen: boolean;
    anchor: RichInputTriggerAnchor | null;
    placement?: RichInputTriggerPlacement;
    items: readonly RichInputTriggerItem[];
    selectedKey: string | null;
    accessibilityLabel: string;
    onSelect: (item: RichInputTriggerItem) => void;
};

type TriggerSection = {
    key: string;
    items: RichInputTriggerItem[];
};

type MenuPos = {
    left: number;
    maxHeight: number;
    width?: number;
    top?: number;
    bottom?: number;
};

const VIEWPORT_PAD = 8;
const MENU_GAP = 8;
const LIST_MAX = 360;
const MENU_MIN_WIDTH = 260;

function groupItems(items: readonly RichInputTriggerItem[]): TriggerSection[] {
    const sections: TriggerSection[] = [];

    for (const item of items) {
        const key = item.section?.trim() || '_';
        const last = sections[sections.length - 1];

        if (last?.key === key) {
            last.items.push(item);

            continue;
        }

        sections.push({ key, items: [item] });
    }

    return sections;
}

function clampMenuPosition(
    anchor: RichInputTriggerAnchor,
    measuredWidth: number,
    placement: RichInputTriggerPlacement
): MenuPos {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const spaceBelow = vh - VIEWPORT_PAD - MENU_GAP - anchor.bottom;
    const spaceAbove = anchor.top - VIEWPORT_PAD - MENU_GAP;
    const openAbove = placement === 'top' || spaceAbove > spaceBelow;
    const maxHeight = Math.min(LIST_MAX, Math.max(0, openAbove ? spaceAbove : spaceBelow));
    const matchHost = anchor.width != null && anchor.width > 0;
    const width = (matchHost ? anchor.width : measuredWidth) ?? 0;
    let left = anchor.x;

    if (!matchHost) {
        if (left + width > vw - VIEWPORT_PAD) {
            left = Math.max(VIEWPORT_PAD, vw - VIEWPORT_PAD - width);
        }

        if (left < VIEWPORT_PAD) {
            left = VIEWPORT_PAD;
        }
    }

    return openAbove
        ? { left, maxHeight, ...(matchHost ? { width } : {}), bottom: vh - anchor.top + MENU_GAP }
        : { left, maxHeight, ...(matchHost ? { width } : {}), top: anchor.bottom + MENU_GAP };
}

/**
 * Caret- or host-anchored trigger picker (ListBox). Portaled to `document.body`
 * so chat panel `overflow` / `backdrop-filter` cannot clip it. `placement: top`
 * always grows upward from the anchor (composer `/` and `@`); `auto` picks the
 * side with more room.
 */
export function RichInputTriggerMenu({
    isOpen,
    anchor,
    placement = 'auto',
    items,
    selectedKey,
    accessibilityLabel,
    onSelect,
}: RichInputTriggerMenuProps): ReactNode {
    const menuRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<MenuPos | null>(null);
    const sections = groupItems(items);
    const hasItems = items.length > 0;

    useLayoutEffect(() => {
        if (!isOpen || !anchor || !hasItems) {
            setPos(null);

            return;
        }

        const el = menuRef.current;

        if (!el) {
            return;
        }

        const next = clampMenuPosition(anchor, el.offsetWidth || MENU_MIN_WIDTH, placement);

        setPos((prev) => {
            if (
                prev?.left === next.left
                && prev.top === next.top
                && prev.bottom === next.bottom
                && prev.width === next.width
                && prev.maxHeight === next.maxHeight
            ) {
                return prev;
            }

            return next;
        });
    }, [isOpen, anchor, items, hasItems, placement]);

    // No empty / loading chrome — only paint when there is something to pick.
    if (!isOpen || !anchor || !hasItems || typeof document === 'undefined') {
        return null;
    }

    const placed = pos ?? clampMenuPosition(anchor, MENU_MIN_WIDTH, placement);
    const style: CSSProperties = {
        position: 'fixed',
        left: placed.left,
        top: placed.top,
        bottom: placed.bottom,
        zIndex: 1000,
        maxHeight: placed.maxHeight,
        ...(placed.width != null
            ? { width: placed.width, minWidth: placed.width, maxWidth: placed.width }
            : {}),
    };

    return createPortal(
        <Scrollable
            ref={ menuRef }
            className={ styles.menu }
            containerClass={ listStyles.scrollableContainer }
            vertical
            role="presentation"
            style={ style }
            onMouseDown={ (e) => {
                // Keep editor selection; don't steal focus into the panel chrome.
                e.preventDefault();
            } }
        >
            <ListBox
                aria-label={ accessibilityLabel }
                selectionMode="single"
                selectedKeys={ selectedKey ? [selectedKey] : [] }
                // Selection is the pick: RAC drops `onAction` on click while a row is selected,
                // and the highlighted row always is.
                onSelectionChange={ (keys) => {
                    if (keys === 'all') {
                        return;
                    }

                    // Pressing the highlighted row deselects it; that still picks it.
                    const key = keys.values().next().value ?? selectedKey;
                    const item = items.find(candidate => candidate.value === String(key));

                    if (item) {
                        onSelect(item);
                    }
                } }
            >
                <For each={ sections }>
                    { (section): ReactNode => (
                        <ListBoxSection
                            key={ section.key }
                            id={ section.key }
                        >
                            <Show when={ section.key !== '_' }>
                                <ListBoxHeader>
                                    { section.key }
                                </ListBoxHeader>
                            </Show>
                            <For each={ section.items }>
                                { (item): ReactNode => {
                                    const title = item.displayText ?? item.label;

                                    return (
                                        <ListBoxItem
                                            key={ item.value }
                                            id={ item.value }
                                            textValue={ title }
                                            text={ title }
                                            icon={ item.icon }
                                            description={ item.description }
                                            stacked={ item.kind === 'command' }
                                            endAffix={ item.endAffix }
                                            data-highlighted={ item.value === selectedKey || undefined }
                                        />
                                    );
                                } }
                            </For>
                        </ListBoxSection>
                    ) }
                </For>
            </ListBox>
        </Scrollable>,
        document.body
    );
}
