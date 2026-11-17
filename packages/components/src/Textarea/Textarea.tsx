import { cn, mergeRefs } from '@clowdy/lib';
import React, { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode, type Ref } from 'react';
import {
    Group,
    TextArea as RACTextArea,
    type TextAreaProps as RACTextAreaProps,
} from 'react-aria-components';

import { Show } from '../Show';
import { useSlotContextProps } from '../Slot';
import styles from './Textarea.module.css';

export type TextareaVariant = 'filled' | 'bordered' | 'transparent' | 'inline';
export type TextareaSize = 'xs' | 'sm' | 'md' | 'lg';

export interface TextareaProps extends Omit<
    RACTextAreaProps,
    'className' | 'isDisabled' | 'isInvalid' | 'isReadOnly' | 'onChange'
> {
    ref?: Ref<HTMLTextAreaElement | null>;
    variant?: TextareaVariant;
    size?: TextareaSize;
    /** Allow user to resize textarea vertically. Ignored when autoResize is true. */
    isResizable?: boolean;
    /** When true, height grows with content via CSS `field-sizing: content`. */
    autoResize?: boolean;
    /** Classes on the field wrapper (`Group`). */
    className?: string;
    /** Classes on the native `<textarea>` */
    textareaClassName?: string;
    isDisabled?: boolean;
    isInvalid?: boolean;
    isReadOnly?: boolean;
    /** Same contract as `Input` — string value, not the DOM event. */
    onChange?: (value: string) => void;
    onRowCountChange?: (rows: number) => void;
    /** Top-end control inside the field (e.g. jump-to-source). */
    endAction?: ReactNode;
}

function readRowCount(el: HTMLTextAreaElement): number | null {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight || '0');

    if (!lineHeight) {
        return null;
    }

    return Math.max(1, Math.round(el.scrollHeight / lineHeight));
}

export function Textarea(props: TextareaProps) {
    // SlotContext size/variant first; local props win; defaults after merge.
    const merged = useSlotContextProps(props);
    const {
        variant = 'filled',
        size = 'md',
        isResizable = true,
        autoResize = false,
        className,
        textareaClassName,
        isDisabled,
        isInvalid,
        isReadOnly,
        value,
        defaultValue,
        onChange,
        onInput,
        rows,
        onRowCountChange,
        autoFocus,
        endAction,
        ref: refProp,
        ...restProps
    } = merged;

    const ref = useRef<HTMLTextAreaElement>(null);
    const lastRowCountRef = useRef<number | null>(null);

    useEffect(() => {
        if (!autoFocus) {
            return;
        }

        const timer = setTimeout(() => {
            ref.current?.focus();
        }, 50);

        return () => clearTimeout(timer);
    }, [autoFocus]);

    const minRows = rows ?? 1;

    const notifyRowCount = useCallback(
        (el: HTMLTextAreaElement | null) => {
            if (!el || !onRowCountChange) {
                return;
            }

            const rowsCount = readRowCount(el);

            if (rowsCount == null || lastRowCountRef.current === rowsCount) {
                return;
            }

            lastRowCountRef.current = rowsCount;
            onRowCountChange(rowsCount);
        },
        [onRowCountChange]
    );

    useLayoutEffect(() => {
        if (!autoResize) {
            return;
        }

        notifyRowCount(ref.current);
    }, [autoResize, notifyRowCount, value]);

    const handleChange = useCallback(
        (event: React.ChangeEvent<HTMLTextAreaElement>) => {
            onChange?.(event.currentTarget.value);
        },
        [onChange]
    );

    const handleInput: NonNullable<RACTextAreaProps['onInput']> = useCallback(
        (e) => {
            if (autoResize) {
                notifyRowCount(e.currentTarget);
            }

            onInput?.(e);
        },
        [autoResize, onInput, notifyRowCount]
    );

    const handleContainerClick = () => {
        ref.current?.focus();
    };

    return (
        <Group
            className={ cn(styles.field, className) }
            data-variant={ variant }
            data-size={ size }
            data-end-action={ endAction ? '' : undefined }
            isDisabled={ isDisabled }
            isReadOnly={ isReadOnly }
            isInvalid={ isInvalid }
            data-modal-drag-exclude
            onClick={ handleContainerClick }
        >
            <RACTextArea
                { ...restProps }
                rows={ rows }
                ref={ mergeRefs(ref, refProp) }
                value={ value }
                defaultValue={ defaultValue }
                onChange={ handleChange }
                onInput={ handleInput }
                className={ cn(styles.textarea, textareaClassName) }
                style={ { '--clowdy-textarea-min-rows': minRows } as React.CSSProperties }
                data-resizable={ autoResize ? 'false' : (isResizable ? 'true' : 'false') }
                data-autoresize={ autoResize ? 'true' : undefined }
                disabled={ isDisabled }
                readOnly={ isReadOnly }
                aria-invalid={ isInvalid ?? restProps['aria-invalid'] }
            />
            <Show when={ endAction }>
                <span
                    className={ styles.endAction }
                    onClick={ (event) => {
                        event.stopPropagation();
                    } }
                    onPointerDown={ (event) => {
                        event.stopPropagation();
                    } }
                >
                    { endAction }
                </span>
            </Show>
        </Group>
    );
}

Textarea.displayName = 'Textarea';
