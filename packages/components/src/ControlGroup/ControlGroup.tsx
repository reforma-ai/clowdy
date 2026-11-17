import { cn } from '@clowdy/lib';
import { createContext, use, useMemo } from 'react';

import { AsChild } from '../AsChild';
import { FormField } from '../FormField';
import { Input } from '../Input';
import { Select } from '../Select';
import styles from './ControlGroup.module.css';

import type { CSSProperties, HTMLAttributes, ReactNode, Ref } from 'react';
import type { FormFieldSize } from '../FormField';
import type { InputProps, InputSize, InputVariant } from '../Input';
import type { SelectProps } from '../Select';

export type ControlGroupSize = InputSize;
export type ControlGroupVariant = Extract<InputVariant, 'filled' | 'bordered' | 'transparent'>;

interface ControlGroupContextValue {
    size: ControlGroupSize;
    variant: ControlGroupVariant;
}

type ControlGroupStyle = CSSProperties & {
    '--clowdy-control-group-columns'?: string;
};

const ControlGroupContext = createContext<ControlGroupContextValue | null>(null);

export interface ControlGroupProps extends HTMLAttributes<HTMLDivElement> {
    size?: ControlGroupSize;
    variant?: ControlGroupVariant;
    columns?: number;
    templateColumns?: string;
    children: ReactNode;
}

export interface ControlGroupFieldProps {
    size?: FormFieldSize;
    className?: string;
    children: ReactNode;
}

export interface ControlGroupControlProps extends HTMLAttributes<HTMLElement> {
    ref?: Ref<HTMLElement | null>;
    children: ReactNode;
}

export type ControlGroupInputProps = InputProps & {
    size?: ControlGroupSize;
    variant?: ControlGroupVariant;
};

export interface ControlGroupSelectProps<T extends object = object> extends Omit<SelectProps<T>, 'size' | 'variant' | 'className' | 'triggerClassName' | 'children'> {
    size?: ControlGroupSize;
    variant?: ControlGroupVariant;
    className?: string;
    triggerClassName?: string;
    children: SelectProps<T>['children'];
}

export function ControlGroup({
    size = 'sm',
    variant = 'filled',
    columns,
    templateColumns,
    className,
    style,
    children,
    ...props
}: ControlGroupProps) {
    const contextValue = useMemo(() => ({ size, variant }), [size, variant]);
    const groupStyle = useMemo<ControlGroupStyle>(() => ({
        ...style,
        '--clowdy-control-group-columns': templateColumns ?? (columns ? `repeat(${ columns }, minmax(0, 1fr))` : undefined),
    }), [columns, style, templateColumns]);

    return (
        <ControlGroupContext value={ contextValue }>
            <div
                { ...props }
                className={ cn(styles.group, className) }
                style={ groupStyle }
                data-size={ size }
                data-variant={ variant }
            >
                { children }
            </div>
        </ControlGroupContext>
    );
}

function ControlGroupFieldRoot({
    size,
    className,
    children,
}: ControlGroupFieldProps) {
    const context = use(ControlGroupContext);

    return (
        <FormField
            size={ size ?? context?.size ?? 'sm' }
            labelPlacement="bottom"
            labelAlign="center"
            className={ cn(styles.field, className) }
        >
            { children }
        </FormField>
    );
}

export const ControlGroupField = Object.assign(ControlGroupFieldRoot, {
    Label: FormField.Label,
});

export function ControlGroupControl({
    className,
    children,
    ...props
}: ControlGroupControlProps) {
    return (
        <AsChild { ...props } className={ cn(styles.control, className) }>
            { children }
        </AsChild>
    );
}

export function ControlGroupInput({
    className,
    size,
    variant,
    ...props
}: ControlGroupInputProps) {
    const context = use(ControlGroupContext);

    return (
        <ControlGroupControl className={ className }>
            <Input
                { ...props }
                size={ size ?? context?.size ?? 'sm' }
                variant={ variant ?? context?.variant ?? 'filled' }
            />
        </ControlGroupControl>
    );
}

export function ControlGroupSelect<T extends object>({
    className,
    triggerClassName,
    size,
    variant,
    children,
    ...props
}: ControlGroupSelectProps<T>) {
    const context = use(ControlGroupContext);
    const controlSize = size ?? context?.size ?? 'sm';

    return (
        <Select
            { ...props }
            className={ cn(styles.select, className) }
            triggerClassName={ cn(styles.control, styles.selectTrigger, triggerClassName) }
            size={ controlSize }
            variant={ variant ?? context?.variant ?? 'filled' }
        >
            { children }
        </Select>
    );
}

ControlGroup.displayName = 'ControlGroup';
ControlGroupFieldRoot.displayName = 'ControlGroupField';
ControlGroupControl.displayName = 'ControlGroupControl';
ControlGroupInput.displayName = 'ControlGroupInput';
ControlGroupSelect.displayName = 'ControlGroupSelect';
