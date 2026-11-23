import { cn, mergeRefs, type SelectionInput, toSet } from '@clowdy/lib';
import { useMemo, useRef } from 'react';
import {
    GridList as AriaGridList,
    GridListHeader as AriaGridListHeader,
    GridListItem as AriaGridListItem,
    type GridListItemProps as AriaGridListItemProps,
    GridListSection as AriaGridListSection,
    type Key,
    type GridListProps as RACGridListProps,
    type GridListSectionProps as RACGridListSectionProps,
} from 'react-aria-components';

import styles from './ListBox.module.css';
import { type ListRowItemSlotFields, renderListRowItemContent } from './listRowItemContent';
import { useListHoverHighlight } from './useListHoverHighlight';
import { useScrollActiveListItem } from './useScrollActiveListItem';

import type { HTMLAttributes, Ref } from 'react';
import type { ListBoxItemSlots, ListBoxSize } from './ListBox';

export type { GridListProps, GridListSectionProps } from 'react-aria-components';

export type GridListSize = ListBoxSize;

/**
 * **General-purpose styled list/grid rows** — settings tables, inspectors, rows with trailing actions or **nested controls** (`keyboardNavigationBehavior="tab"`).
 * For ComboBox-/Select-shaped **option lists** (arrow navigation, picker overlays), prefer {@link ListBox}.
 */
export interface GridListComponentProps<T extends object = object> extends Omit<RACGridListProps<T>, 'selectedKeys'> {
    size?: GridListSize;
    selectedKeys?: SelectionInput<Key>;
    interactive?: boolean;
}

export type GridListItemProps<T extends object = object> = AriaGridListItemProps<T> &
    ListBoxItemSlots & {
        text?: string;
        isDanger?: boolean;
        /** Top-align the icon with the first line. Default rows stay centered. */
        align?: 'start';
        /**
         * Scroll this row into view when it becomes selected. Off when a parent
         * pager already owns the scroll, so a preselected row cannot jump it.
         */
        scrollActive?: boolean;
        /**
         * A row that is a label, such as a group's heading: the pointer draws no hover plate under it. The keyboard focus still does, so the focus is seen.
         */
        plateless?: boolean;
    };

export function GridList<T extends object>({
    className,
    size = 'sm',
    selectionMode = 'none',
    selectedKeys,
    escapeKeyBehavior = 'none',
    interactive = true,
    keyboardNavigationBehavior = 'arrow',
    layout = 'stack',
    selectionBehavior,
    ...props
}: GridListComponentProps<T>) {
    const listRef = useRef<HTMLDivElement>(null);
    const selectedKeysSet = useMemo(() => toSet(selectedKeys), [selectedKeys]);

    useListHoverHighlight(listRef, interactive);

    return (
        <AriaGridList
            className={cn(styles.list, className)}
            selectionMode={selectionMode}
            selectedKeys={selectedKeysSet}
            escapeKeyBehavior={escapeKeyBehavior}
            keyboardNavigationBehavior={keyboardNavigationBehavior}
            layout={layout}
            data-size={size}
            data-interactive={interactive || undefined}
            selectionBehavior={selectionBehavior}
            {...props}
            ref={listRef}
        />
    );
}

export function GridListItem<T extends object>({
    startAffix,
    icon,
    text,
    description,
    endAffix,
    children,
    className,
    isDanger,
    align,
    scrollActive = true,
    plateless,
    ref,
    ...props
}: GridListItemProps<T> & { ref?: Ref<HTMLDivElement> }) {
    const itemRef = useRef<HTMLDivElement>(null);
    const textValue = text || props.textValue || (typeof children === 'string' ? children : undefined);

    const scrollRef = useScrollActiveListItem(itemRef, scrollActive);

    const slotFields: ListRowItemSlotFields = {
        icon,
        description,
        startAffix,
        endAffix,
        textValue,
    };

    return (
        <AriaGridListItem
            ref={mergeRefs(scrollRef, ref)}
            className={cn(styles.item, isDanger && styles.itemDanger, className)}
            data-align={align}
            data-plateless={plateless || undefined}
            textValue={textValue}
            {...props}
        >
            {renderListRowItemContent(children, slotFields)}
        </AriaGridListItem>
    );
}

export function GridListHeader({ className, sticky, ...props }: HTMLAttributes<HTMLDivElement> & { sticky?: boolean }) {
    return (
        <AriaGridListHeader
            className={cn(styles.sectionHeader, className)}
            data-sticky={sticky || undefined}
            {...props}
        />
    );
}

export function GridListSection<T extends object>({ className, ...props }: RACGridListSectionProps<T>) {
    return <AriaGridListSection className={cn(styles.section, className)} {...props} />;
}

GridList.displayName = 'GridList';
GridListItem.displayName = 'GridListItem';
GridListHeader.displayName = 'GridListHeader';
GridListSection.displayName = 'GridListSection';
