import { ChevronDown } from '@clowdy/icons/10';
import { cn, type SelectionInput, toSet } from '@clowdy/lib';
import { createContext, use, useMemo } from 'react';
import {
    composeRenderProps,
    type Key,
    Button as RACButton,
    Select as RACSelect,
    type SelectProps as RACSelectProps,
    ToggleButton as RACToggleButton,
    ToggleButtonGroup as RACToggleButtonGroup,
    type ToggleButtonGroupProps as RACToggleButtonGroupProps,
    type ToggleButtonProps as RACToggleButtonProps,
    SelectionIndicator,
} from 'react-aria-components';

import { ListBox, type ListBoxSize } from '../List';
import { Popover } from '../Popover';
import { useSlotContextProps } from '../Slot';
import { Tooltip } from '../Tooltip';
import styles from './ToggleButtonGroup.module.css';

import type { ReactNode } from 'react';

export type ToggleButtonGroupVariant = 'filled' | 'transparent' | 'multiselect' | 'text';
export type ToggleButtonGroupSize = 'xs' | 'sm' | 'md' | 'lg';
export type { Key };

export type SelectedKeysInput = SelectionInput<Key>;

interface ToggleButtonGroupContextValue {
    variant: ToggleButtonGroupVariant;
    size: ToggleButtonGroupSize;
}

const ToggleButtonGroupContext = createContext<ToggleButtonGroupContextValue | null>(null);

export interface ToggleButtonGroupProps
    extends Omit<RACToggleButtonGroupProps, 'className' | 'children' | 'selectionMode' | 'selectedKeys'> {
    variant?: ToggleButtonGroupVariant;
    size?: ToggleButtonGroupSize;
    fullWidth?: boolean;
    isActive?: boolean;
    isPlaceholderSelected?: boolean;
    className?: string;
    selectedKeys?: SelectedKeysInput | null;
    children: ReactNode;
}

export interface ToggleButtonGroupItemProps extends Omit<RACToggleButtonProps, 'id' | 'className' | 'children'> {
    /** Value used to identify the item in selection. */
    value: Key;
    iconOnly?: boolean;
    tooltip?: string | ReactNode;
    tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
    className?: RACToggleButtonProps['className'];
    children: ReactNode;
}

export interface ToggleButtonGroupSelectItemProps<T extends object = object>
    extends Omit<RACSelectProps<T>, 'className' | 'children'> {
    items: Iterable<T>;
    isSelected?: boolean;
    iconOnly?: boolean;
    className?: string;
    popoverClassName?: string;
    selectedContent: ReactNode;
    tooltip?: string | ReactNode;
    children: (item: T) => ReactNode;
}

export function ToggleButtonGroup(props: ToggleButtonGroupProps) {
    const merged = useSlotContextProps(props);
    const {
        variant = 'filled',
        size = 'md',
        fullWidth = false,
        isActive,
        isPlaceholderSelected,
        className,
        children,
        selectedKeys,
        disallowEmptySelection,
        ...restProps
    } = merged;
    const selectionMode = variant === 'multiselect' ? 'multiple' : 'single';
    const requireSelection = disallowEmptySelection ?? variant !== 'multiselect';
    const contextValue = useMemo(() => ({ variant, size }), [variant, size]);
    const selectedKeysSet = useMemo(
        () => (selectedKeys !== undefined ? toSet(selectedKeys) : undefined),
        [selectedKeys]
    );

    return (
        <ToggleButtonGroupContext value={contextValue}>
            <RACToggleButtonGroup
                {...restProps}
                selectedKeys={selectedKeysSet}
                selectionMode={selectionMode}
                disallowEmptySelection={requireSelection}
                className={cn(styles.group, className, { 'w-full': fullWidth })}
                data-variant={variant}
                data-size={size}
                data-active={isActive || undefined}
                data-placeholder-selected={isPlaceholderSelected || undefined}
            >
                {children}
            </RACToggleButtonGroup>
        </ToggleButtonGroupContext>
    );
}

ToggleButtonGroup.displayName = 'ToggleButtonGroup';

export function ToggleButtonGroupItem({
    value,
    iconOnly = false,
    tooltip,
    tooltipPlacement,
    className,
    children,
    ...props
}: ToggleButtonGroupItemProps) {
    const context = use(ToggleButtonGroupContext);

    if (!context) {
        throw new Error('ToggleButtonGroupItem must be used within ToggleButtonGroup');
    }

    const { variant, size } = context;

    const useSelectionIndicator = variant === 'filled' || variant === 'transparent';

    const button = (
        <RACToggleButton
            {...props}
            id={value}
            className={renderProps =>
                cn(styles.item, typeof className === 'function' ? className(renderProps) : className)
            }
            data-variant={variant}
            data-size={size}
            data-icon-only={iconOnly || undefined}
        >
            {useSelectionIndicator
                ? composeRenderProps(children, content => (
                      <>
                          <SelectionIndicator className={styles.selectionIndicator} data-selected />
                          <span className={styles.itemContent}>{content}</span>
                      </>
                  ))
                : composeRenderProps(children, content => <span className={styles.itemContent}>{content}</span>)}
        </RACToggleButton>
    );

    if (tooltip) {
        return (
            <Tooltip content={tooltip} placement={tooltipPlacement}>
                {button}
            </Tooltip>
        );
    }

    return button;
}

ToggleButtonGroupItem.displayName = 'ToggleButtonGroupItem';

export function ToggleButtonGroupSelectItem<T extends object = object>({
    isSelected,
    iconOnly = false,
    className,
    popoverClassName,
    selectedContent,
    tooltip,
    items,
    children,
    ...props
}: ToggleButtonGroupSelectItemProps<T>) {
    const context = use(ToggleButtonGroupContext);

    if (!context) {
        throw new Error('ToggleButtonGroupSelectItem must be used within ToggleButtonGroup');
    }

    const { variant, size } = context;
    const listBoxSize: ListBoxSize = size === 'xs' ? 'sm' : size;
    const useSelectionIndicator = variant === 'filled' || variant === 'transparent';

    const button = (
        <RACButton
            className={cn(styles.item, className)}
            data-variant={variant}
            data-size={size}
            data-icon-only={iconOnly || undefined}
            data-selected={isSelected || undefined}
            data-select-item
        >
            {useSelectionIndicator && isSelected && (
                <span className={styles.selectionIndicator} data-selected aria-hidden />
            )}
            <span className={styles.itemContent}>
                <span className={styles.selectItemLabel}>{selectedContent}</span>
                <ChevronDown className={styles.itemChevron} aria-hidden />
            </span>
        </RACButton>
    );

    return (
        <RACSelect {...props} className={styles.selectItem}>
            {tooltip ? <Tooltip content={tooltip}>{button}</Tooltip> : button}

            <Popover className={cn(styles.selectPopover, popoverClassName)} spacing="xs">
                <ListBox
                    aria-label={props['aria-label']}
                    size={listBoxSize}
                    autoFocus
                    className={styles.selectListBox}
                    items={items}
                >
                    {children}
                </ListBox>
            </Popover>
        </RACSelect>
    );
}

ToggleButtonGroupSelectItem.displayName = 'ToggleButtonGroupSelectItem';
