import { Tag, type TagComponentProps } from './Tag';
import { TagGroup, type TagGroupProps } from './TagGroup';

import type { ReactNode } from 'react';
import type { Key } from 'react-aria-components';

export interface BadgeProps
    extends Omit<TagGroupProps, 'items' | 'children' | 'renderEmptyState' | 'selectedKeys' | 'selectionMode' | 'id'>,
        Pick<
            TagComponentProps,
            | 'id'
            | 'textValue'
            | 'icon'
            | 'count'
            | 'href'
            | 'target'
            | 'onPress'
            | 'onHoverStart'
            | 'onHoverEnd'
            | 'onHoverChange'
            | 'rounded'
            | 'tooltip'
        > {
    /** Label inside the tag. */
    children?: ReactNode;
    /** React Aria key for the single tag. */
    value?: Key;
    /** Class name on the inner `Tag` (not the group wrapper). */
    tagClassName?: TagComponentProps['className'];
}

/**
 * Single-tag chip: a {@link TagGroup} with one {@link Tag}. Use for badges and status pills; use
 * {@link TagGroup} when you have multiple tags or list semantics.
 * Pass `onRemove` (see {@link TagGroup}) to show the dismiss control.
 */
export function Badge({
    children,
    value = 'badge',
    id,
    textValue,
    icon,
    count,
    tagClassName,
    color = 'secondary',
    size = 'md',
    rounded,
    className,
    href,
    target,
    onPress,
    onHoverStart,
    onHoverEnd,
    onHoverChange,
    onRemove,
    tooltip,
    ...groupProps
}: BadgeProps) {
    const itemKey = id ?? value;

    return (
        <TagGroup
            {...groupProps}
            key={String(itemKey)}
            color={color}
            size={size}
            rounded={rounded}
            className={className}
            onRemove={onRemove}
        >
            <Tag
                id={itemKey}
                value={value}
                textValue={textValue}
                icon={icon}
                count={count}
                rounded={rounded}
                className={tagClassName}
                href={href}
                target={target}
                onPress={onPress}
                onHoverStart={onHoverStart}
                onHoverEnd={onHoverEnd}
                onHoverChange={onHoverChange}
                tooltip={tooltip}
            >
                {children}
            </Tag>
        </TagGroup>
    );
}

Badge.displayName = 'Badge';
