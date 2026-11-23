import { Close, CloseCompact } from '@clowdy/icons/12';
import { cn } from '@clowdy/lib';
import { type ReactNode, use } from 'react';
import {
    composeRenderProps,
    type Key,
    Provider,
    Tag as RACTag,
    type TagProps as RACTagProps,
    type SelectionMode,
} from 'react-aria-components';

import { Button, ButtonSize } from '../Button';
import { Show } from '../Show';
import { DEFAULT_SLOT, SlotContext } from '../Slot';
import { Text } from '../Text';
import { Tooltip } from '../Tooltip';
import styles from './Tag.module.css';
import { TagContext } from './Tag.types';

import type { TagColor, TagContextValue, TagRemovePlacement, TagSize } from './Tag.types';

const DEFAULT_TAG_CONTEXT = {
    color: 'secondary' as TagColor,
    size: 'md' as TagSize,
    selectionMode: 'none' as SelectionMode,
    removePlacement: 'trailing' as TagRemovePlacement,
    rounded: false,
} satisfies TagContextValue;

export interface TagComponentProps extends Omit<RACTagProps, 'id' | 'className' | 'children'> {
    /** Value used to identify the tag in selection. */
    value: Key;
    /** Optional id for the root element (used as a React key in collections when provided). */
    id?: Key;
    className?: RACTagProps['className'];
    /** String used for accessibility when children are not plain text (e.g. when icon is set). Required by React Aria in that case. */
    textValue?: string;
    /** Optional icon displayed before the label. */
    icon?: ReactNode;
    /** Optional counter displayed at the start of the tag. */
    count?: number;
    /** When set, the tag is wrapped in `Tooltip` with this content (e.g. full path when the label is truncated). */
    tooltip?: ReactNode;
    color?: TagColor;
    size?: TagSize;
    /** Pill shape (`border-radius: full`). Overrides group when set on a single tag. */
    rounded?: boolean;
    children?: ReactNode;
}

const REMOVE_BUTTON_SIZE: Record<TagSize, ButtonSize> = {
    xs: 'xs',
    sm: 'xs',
    md: 'sm',
    lg: 'md',
};

const REMOVE_BUTTON_ICON: Record<TagSize, ReactNode> = {
    xs: <CloseCompact />,
    sm: <CloseCompact />,
    md: <CloseCompact />,
    lg: <Close />,
};

/** Slots inside `RACTag`: label/icon/count use default; dismiss control uses RAC `remove`. */
const TAG_INNER_SLOT_CONTEXT = { slots: { [DEFAULT_SLOT]: {}, remove: {} } } as const;

export function Tag({
    value,
    id,
    className,
    children,
    textValue,
    icon,
    size: sizeProp,
    rounded: roundedProp,
    tooltip,
    ...props
}: TagComponentProps) {
    const context = use(TagContext);
    const { color, size, selectionMode, removePlacement, rounded: roundedFromGroup } = context ?? DEFAULT_TAG_CONTEXT;
    const resolvedSize = sizeProp ?? size;
    const resolvedColor = props.color ?? color;
    const resolvedRounded = roundedProp ?? roundedFromGroup;
    const useLeadingRemove = removePlacement === 'leading';

    const isInteractive = Boolean(
        context?.onAction ||
            props.href ||
            props.onAction ||
            props.onHoverStart ||
            props.onHoverEnd ||
            props.onHoverChange ||
            (['single', 'multiple'] as SelectionMode[]).includes(selectionMode)
    );
    const isActionable = Boolean(context?.onAction || props.onAction);

    const tag = (
        <RACTag
            {...props}
            id={id ?? value}
            className={cn(styles.tag, className)}
            data-color={resolvedColor}
            data-size={resolvedSize}
            data-rounded={resolvedRounded || undefined}
            data-interactive={isInteractive || undefined}
            data-actionable={isActionable || undefined}
            data-remove-placement={useLeadingRemove ? 'leading' : undefined}
            textValue={textValue}
        >
            {composeRenderProps(children, (content, { allowsRemoving }) => (
                <Provider values={[[SlotContext, TAG_INNER_SLOT_CONTEXT]]}>
                    <Show when={props.count != null}>
                        <Text className={styles.count}>{props.count}</Text>
                    </Show>

                    <Show when={useLeadingRemove && allowsRemoving}>
                        <span className={styles.leadingRemoveSlot}>
                            <Show when={icon != null}>
                                <Text className={styles.icon}>{icon}</Text>
                            </Show>

                            <span className={styles.leadingRemoveControl}>
                                <Button
                                    slot="remove"
                                    variant="transparent"
                                    size={REMOVE_BUTTON_SIZE[resolvedSize]}
                                    color="inherit"
                                    iconOnly
                                    className={styles.removeButton}
                                    aria-label="Remove"
                                >
                                    {REMOVE_BUTTON_ICON[resolvedSize]}
                                </Button>
                            </span>
                        </span>
                    </Show>

                    <Show when={!useLeadingRemove && icon != null}>
                        <Text className={styles.icon}>{icon}</Text>
                    </Show>

                    <Text className={cn(styles.text, 'truncate')}>{content}</Text>

                    <Show when={!useLeadingRemove && allowsRemoving}>
                        <Button
                            slot="remove"
                            variant="transparent"
                            size={REMOVE_BUTTON_SIZE[resolvedSize]}
                            color="inherit"
                            iconOnly
                            className={styles.removeButton}
                            aria-label="Remove"
                        >
                            {REMOVE_BUTTON_ICON[resolvedSize]}
                        </Button>
                    </Show>
                </Provider>
            ))}
        </RACTag>
    );

    return tooltip ? <Tooltip content={tooltip}>{tag}</Tooltip> : tag;
}
