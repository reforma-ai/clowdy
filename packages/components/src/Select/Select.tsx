import { ChevronDown } from '@clowdy/icons/10';
import { cn } from '@clowdy/lib';
import { useState } from 'react';
import {
    Button,
    ListLayout,
    Label as RACLabel,
    Select as RACSelect,
    SelectValue,
    useFilter,
    Virtualizer,
} from 'react-aria-components';

import { Autocomplete } from '../Autocomplete';
import { ListBox } from '../List';
import { Popover } from '../Popover';
import { Show } from '../Show';
import { useSlotContextProps } from '../Slot';
import styles from './Select.module.css';

import type { ReactNode } from 'react';
import type { ListLayoutOptions } from 'react-aria-components';
import type { ListBoxSize } from '../List';

export type SelectSize = 'xs' | 'sm' | 'md' | 'lg';
export type SelectVariant = 'filled' | 'filling' | 'bordered' | 'transparent';
export type SelectColor = 'default' | 'primary';
export type SelectValueDisplay = 'item' | 'text';

/** Trigger heights in px (16px root) — negative popover offset covers the trigger like Omnibox. */
const OVERLAY_OFFSET_PX: Record<SelectSize, number> = {
    xs: 24,
    sm: 30,
    md: 36,
    lg: 56,
};

/** Grow overlay past the trigger so Popover `spacing=xs` (4px) insets align with the input. */
const OVERLAY_INSET_PX = 4;

/** Gap between the trigger and its menu. Search overlays cover the trigger instead. */
const MENU_OFFSET_PX = 4;
const SEARCH_LIST_MAX_HEIGHT = '16rem';
const VIRTUALIZED_LIST_LAYOUT_OPTIONS: Record<ListBoxSize, ListLayoutOptions> = {
    sm: { rowSize: 30, gap: 2 },
    md: { rowSize: 36, gap: 2 },
    lg: { rowSize: 56, gap: 2 },
};

export interface SelectProps<T extends object = object> {
    slot?: string;
    label?: ReactNode;
    'aria-label'?: string;
    size?: SelectSize;
    variant?: SelectVariant;
    color?: SelectColor;
    placeholder?: string;
    isDisabled?: boolean;
    isRequired?: boolean;
    isActive?: boolean;
    /**
     * Search field in the popover (RAC Autocomplete).
     * Opens as an Omnibox-style overlay that covers the trigger.
     */
    showSearch?: boolean;
    searchPlaceholder?: string;
    /**
     * Only render visible fixed-height ListBox rows.
     * Use ListBox + Virtualizer directly for sections or variable-height content.
     */
    isVirtualized?: boolean;
    /** Render the selected item's textValue instead of its custom row content. */
    valueDisplay?: SelectValueDisplay;
    onOpenChange?: (isOpen: boolean) => void;
    className?: string;
    triggerClassName?: string;
    /** Extra class on the dropdown popover (e.g. a wider min-width for described options). */
    popoverClassName?: string;
    /** Which side of the trigger the list opens on, optionally aligned to its start or end. */
    placement?: 'top' | 'bottom' | `${'top' | 'bottom'} ${'start' | 'end'}`;
    /** Gap between the trigger and the list, in px. Defaults to 4. */
    offset?: number;
    shouldFlip?: boolean;
    /** Dropdown list max height in px. */
    maxHeight?: number;
    icon?: ReactNode;
    iconColor?: 'default' | 'primary';
    items?: Iterable<T>;
    children: (item: T) => ReactNode;
    [key: string]: unknown;
}

export function Select<T extends object>(props: SelectProps<T>) {
    const merged = useSlotContextProps(props as SelectProps<T> & { slot?: string }) as SelectProps<T>;
    const {
        label,
        size = 'md',
        variant = 'filled',
        color = 'default',
        placeholder,
        className,
        triggerClassName,
        popoverClassName,
        placement = 'bottom',
        offset: popoverOffset,
        shouldFlip,
        icon,
        iconColor = 'default',
        isActive,
        showSearch = false,
        searchPlaceholder = 'Search…',
        isVirtualized = false,
        valueDisplay = 'item',
        items,
        children,
        onOpenChange,
        maxHeight,
        ...selectProps
    } = merged;
    // TODO pashtet: тут косяк, нужно добавить xs стиль для ListBox
    const listBoxSize: ListBoxSize = size === 'xs' ? 'sm' : size;
    const { 'aria-label': passedAriaLabel, ...selectFieldProps } = selectProps;
    const ariaLabel = label == null && typeof passedAriaLabel === 'string' ? passedAriaLabel : undefined;
    const [searchQuery, setSearchQuery] = useState('');
    const { contains } = useFilter({ sensitivity: 'base' });

    const renderListBox = (autoFocus: boolean, showEmptyState = false) => {
        const listBox = (
            <ListBox
                aria-label={ariaLabel}
                size={listBoxSize}
                autoFocus={autoFocus}
                className={cn(styles.listBox, isVirtualized && styles.virtualizedListBox)}
                items={items}
                renderEmptyState={showEmptyState ? () => <div className={styles.empty}>Nothing found</div> : undefined}
                style={isVirtualized ? { maxHeight: SEARCH_LIST_MAX_HEIGHT } : undefined}
            >
                {children}
            </ListBox>
        );

        if (!isVirtualized) {
            return listBox;
        }

        return (
            <Virtualizer layout={ListLayout} layoutOptions={VIRTUALIZED_LIST_LAYOUT_OPTIONS[listBoxSize]}>
                {listBox}
            </Virtualizer>
        );
    };

    return (
        <RACSelect
            {...selectFieldProps}
            aria-label={ariaLabel}
            className={cn(styles.select, className)}
            placeholder={placeholder}
            data-size={size}
            data-show-search={showSearch || undefined}
            onOpenChange={isOpen => {
                if (!isOpen) {
                    setSearchQuery('');
                }

                onOpenChange?.(isOpen);
            }}
        >
            {label != null && <RACLabel className={styles.label}>{label}</RACLabel>}
            <Button
                className={cn(styles.trigger, triggerClassName)}
                data-size={size}
                data-variant={variant}
                data-color={color}
                data-active={isActive || undefined}
            >
                <Show when={icon != null}>
                    <span className={styles.icon} data-color={iconColor}>
                        {icon}
                    </span>
                </Show>
                <Show
                    when={icon != null || valueDisplay === 'text'}
                    fallback={<SelectValue className={styles.value} />}
                >
                    <SelectValue className={styles.value}>
                        {({ selectedText, isPlaceholder }) => (isPlaceholder ? placeholder : selectedText)}
                    </SelectValue>
                </Show>
                <ChevronDown className={styles.chevron} aria-hidden />
            </Button>

            <Popover
                className={cn(styles.popover, showSearch && styles.popoverOverlay, popoverClassName)}
                spacing="xs"
                placement={placement}
                // Width is trigger+8px; bottom (center) placement already overhangs ±4px — no crossOffset.
                offset={showSearch ? -(OVERLAY_OFFSET_PX[size] + OVERLAY_INSET_PX) : (popoverOffset ?? MENU_OFFSET_PX)}
                shouldFlip={shouldFlip ?? !showSearch}
                maxHeight={maxHeight}
            >
                <Show when={showSearch} fallback={renderListBox(true)}>
                    <Autocomplete
                        inputValue={searchQuery}
                        onInputChange={setSearchQuery}
                        filter={contains}
                        maxHeight={SEARCH_LIST_MAX_HEIGHT}
                        placeholder={searchPlaceholder}
                        inputClassName={styles.overlaySearch}
                        childrenOwnScroll={isVirtualized}
                    >
                        {renderListBox(false, true)}
                    </Autocomplete>
                </Show>
            </Popover>
        </RACSelect>
    );
}

Select.displayName = 'Select';
