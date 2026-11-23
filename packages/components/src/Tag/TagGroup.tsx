import { cn, type SelectionInput, toSet } from '@clowdy/lib';
import { type ReactNode, useMemo } from 'react';
import {
    type Key,
    TagGroup as RACTagGroup,
    type TagGroupProps as RACTagGroupProps,
    TagList as RACTagList,
    type TagListProps as RACTagListProps,
    type TagProps as RACTagProps,
} from 'react-aria-components';

import { Tag } from './Tag';
import styles from './Tag.module.css';
import { type TagColor, TagContext, type TagRemovePlacement, type TagSize } from './Tag.types';

export function getItemKey(item: TagGroupItem, items: readonly TagGroupItem[] | undefined): Key {
    const id = item.id;

    if (typeof id === 'string' || typeof id === 'number') {
        return id;
    }

    const index = items?.indexOf(item) ?? 0;

    return `tag-${index}`;
}

export interface TagGroupItem
    extends Pick<
        RACTagProps,
        'href' | 'target' | 'rel' | 'onHoverStart' | 'onHoverEnd' | 'onHoverChange' | 'textValue'
    > {
    id?: Key;
    label: ReactNode;
    /** String used for accessibility when label or icon are not plain text. Defaults to label when it is a string. */
    textValue?: string;
    count?: number;
    icon?: ReactNode;
    /** Passed through to `Tag` — hover/focus tooltip (e.g. full path). */
    tooltip?: ReactNode;
    color?: TagColor;
    className?: string;
    /** Called when this tag is activated (RAC item handler; key comes from group `onAction`). */
    onAction?: () => void;
}

export interface TagGroupProps
    extends Omit<RACTagGroupProps, 'className' | 'children' | 'selectedKeys' | 'onAction'>,
        Pick<RACTagListProps<TagGroupItem>, 'items' | 'children' | 'renderEmptyState'> {
    color?: TagColor;
    size?: TagSize;
    /** Pill shape for every tag in the group. */
    rounded?: boolean;
    className?: string;
    /** Selected key(s). Pass a single Key, array, or Iterable (e.g. Set). */
    selectedKeys?: SelectionInput<Key>;
    /** Called when a tag is activated; receives the activated item's key. */
    onAction?: (key: Key) => void;
    /** Where removable tags show the dismiss control. Defaults to `trailing`. */
    removePlacement?: TagRemovePlacement;
}

export function TagGroup({
    color = 'secondary',
    size = 'md',
    rounded,
    className,
    items,
    children,
    renderEmptyState,
    selectionMode = 'none',
    selectedKeys,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
    onAction,
    removePlacement = 'trailing',
    ...props
}: TagGroupProps) {
    const selectedKeysSet = useMemo(() => toSet(selectedKeys), [selectedKeys]);
    const itemsArray = useMemo(() => (items ? [...items] : undefined), [items]);

    const contextValue = useMemo(
        () => ({
            color,
            size,
            rounded,
            selectionMode,
            onAction,
            removePlacement,
        }),
        [color, size, rounded, selectionMode, onAction, removePlacement]
    );

    /** `TagGroup` must have an accessible name (RAC). Default when `aria-label` / `aria-labelledby` omitted. */
    const accessibilityLabel = ariaLabel ?? (ariaLabelledby != null ? undefined : 'Tags');

    return (
        <TagContext value={contextValue}>
            <RACTagGroup
                {...props}
                selectionMode={selectionMode}
                aria-label={accessibilityLabel}
                aria-labelledby={ariaLabelledby}
                selectedKeys={selectedKeys !== undefined ? selectedKeysSet : undefined}
                className={cn(styles.group, className)}
                data-color={color}
                data-size={size}
                onAction={onAction}
            >
                <RACTagList className={styles.list} items={items} renderEmptyState={renderEmptyState}>
                    {children ??
                        ((item: TagGroupItem) => {
                            const key = getItemKey(item, itemsArray);
                            const { id: _id, textValue, ...rest } = item;

                            return (
                                <Tag
                                    key={key}
                                    {...rest}
                                    id={key}
                                    value={key}
                                    textValue={textValue ?? (typeof item.label === 'string' ? item.label : undefined)}
                                >
                                    {item.label}
                                </Tag>
                            );
                        })}
                </RACTagList>
            </RACTagGroup>
        </TagContext>
    );
}

TagGroup.displayName = 'TagGroup';

export type { TagColor, TagRemovePlacement, TagSize } from './Tag.types';
