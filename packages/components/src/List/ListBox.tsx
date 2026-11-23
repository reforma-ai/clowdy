import { cn, mergeRefs, type SelectionInput, toSet } from '@clowdy/lib';
import { useRef, useState } from 'react';
import {
    Header as AriaHeader,
    ListBox as AriaListBox,
    ListBoxItem as AriaListBoxItem,
    type ListBoxItemProps as AriaListBoxItemProps,
    ListBoxSection as AriaListBoxSection,
    type Key,
    type ListBoxSectionProps,
    type ListBoxProps as RACListBoxProps,
} from 'react-aria-components';

import styles from './ListBox.module.css';
import { renderListRowItemContent } from './listRowItemContent';
import { useListHoverHighlight } from './useListHoverHighlight';
import { useScrollActiveListItem } from './useScrollActiveListItem';

import type { HTMLAttributes, ReactNode, Ref } from 'react';

export type { ListBoxProps, ListBoxSectionProps } from 'react-aria-components';

export type ListBoxSize = 'sm' | 'md' | 'lg';

/**
 * Valid `data-show` values on any descendant of a shared list row (e.g. a control in `endAffix`).
 * {@link GridListItem} and {@link ListBoxItem} both use `ListBox.module.css` (`.item`); name is historical.
 */
export const listBoxItemDataShow = {
    itemHover: 'item-hover',
    itemSelected: 'item-selected',
    itemBoth: 'item-both',
    /** Visible until the row is hovered. */
    itemRest: 'item-rest',
} as const;

export type ListBoxItemDataShow = (typeof listBoxItemDataShow)[keyof typeof listBoxItemDataShow];

export interface ListBoxItemSlots {
    icon?: ReactNode;
    description?: ReactNode;
    startAffix?: ReactNode;
    endAffix?: ReactNode;
    stacked?: boolean;
}

export type ListBoxItemProps<T extends object = object> = AriaListBoxItemProps<T> &
    ListBoxItemSlots & {
        text?: string;
        isDanger?: boolean;
    };

export interface ListBoxComponentProps<T extends object = object> extends Omit<RACListBoxProps<T>, 'selectedKeys'> {
    ref?: Ref<HTMLDivElement>;
    size?: ListBoxSize;
    /** Selected key(s). Pass a single Key, array, or Iterable (e.g. Set). */
    selectedKeys?: SelectionInput<Key>;
    /** When false, items do not show hover background. Use for plain/display-only lists. Default true. */
    interactive?: boolean;
}

function sameKeys<T>(left: Set<T>, right: Set<T>): boolean {
    if (left.size !== right.size) {
        return false;
    }

    for (const key of left) {
        if (!right.has(key)) {
            return false;
        }
    }

    return true;
}

/**
 * **List surface for option-like rows** (arrow-key listbox UX, ComboBox / Select overlays). Rows should not contain nested widgets that require Tab —
 * use {@link GridList} with `keyboardNavigationBehavior="tab"` instead.
 *
 * Styled like {@link GridList} via shared `ListBox.module.css`; choose by interaction model and RAC composition (Select renders `ListBox`, not GridList).
 */
export function ListBox<T extends object>({
    className,
    size = 'sm',
    selectionMode = 'none',
    selectedKeys,
    escapeKeyBehavior = 'none',
    interactive = true,
    ref,
    ...props
}: ListBoxComponentProps<T>) {
    const listRef = useRef<HTMLDivElement>(null);
    const nextKeys = toSet(selectedKeys);
    const [selectedKeysSet, setSelectedKeysSet] = useState(nextKeys);

    if (!sameKeys(selectedKeysSet, nextKeys)) {
        setSelectedKeysSet(nextKeys);
    }

    useListHoverHighlight(listRef, interactive);

    return (
        <AriaListBox
            ref={mergeRefs(listRef, ref as Ref<HTMLDivElement>)}
            className={cn(styles.list, className)}
            selectionMode={selectionMode}
            selectedKeys={selectedKeysSet}
            escapeKeyBehavior={escapeKeyBehavior}
            data-size={size}
            data-interactive={interactive || undefined}
            {...props}
        />
    );
}

export function ListBoxItem<T extends object>({
    startAffix,
    icon,
    text,
    description,
    endAffix,
    stacked,
    children,
    className,
    isDanger,
    ref,
    ...props
}: ListBoxItemProps<T> & { ref?: Ref<HTMLDivElement> }) {
    const itemRef = useRef<HTMLDivElement>(null);
    const textValue = text || props.textValue || (typeof children === 'string' ? children : undefined);
    const scrollRef = useScrollActiveListItem(itemRef);

    return (
        <AriaListBoxItem
            ref={mergeRefs(scrollRef, ref)}
            className={cn(styles.item, stacked && styles.itemStacked, isDanger && styles.itemDanger, className)}
            textValue={textValue}
            {...props}
        >
            {renderListRowItemContent(children, {
                icon,
                description,
                startAffix,
                endAffix,
                stacked,
                textValue,
            })}
        </AriaListBoxItem>
    );
}

export function ListBoxHeader({ className, sticky, ...props }: HTMLAttributes<HTMLElement> & { sticky?: boolean }) {
    return <AriaHeader className={cn(styles.sectionHeader, className)} {...props} data-sticky={sticky || undefined} />;
}

export function ListBoxSection<T extends object>({ className, ...props }: ListBoxSectionProps<T>) {
    return <AriaListBoxSection className={cn(styles.section, className)} {...props} />;
}
