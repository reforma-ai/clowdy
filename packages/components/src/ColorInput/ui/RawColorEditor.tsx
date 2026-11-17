import { cn } from '@clowdy/lib';
import { useCallback } from 'react';

import { Input } from '../../Input';
import previewStyles from '../../PreviewInput/PreviewInput.module.css';
import { filterSlots } from '../../Slot';
import { Swatch } from '../../Swatch';
import styles from '../ColorInput.module.css';
import { colorInputValueToString, parseColorInputValue } from '../value';
import { CssColorPreviewContent } from './CssColorPreview';
import { HiddenColorInput } from './HiddenColorInput';

import type { ColorInputEditorProps, ColorInputRenderState } from '../ColorInput';

export function RawColorEditor({
    ref,
    inputRef,
    currentValue,
    editorFormat: _editorFormat,
    requestedFormat,
    size = 'sm',
    variant = 'filled',
    placeholder,
    isDisabled,
    isReadOnly,
    isInvalid,
    isActive,
    autoFocus,
    children,
    name,
    form,
    className,
    onValueChange,
    'aria-label': ariaLabel,
    ...props
}: ColorInputEditorProps) {
    const rawValue = colorInputValueToString(currentValue);
    const parsed = parseColorInputValue(rawValue);

    const handleChange = useCallback((nextValue: string) => {
        const nextParsed = parseColorInputValue(nextValue);

        onValueChange(nextValue || null, {
            value: nextValue || null,
            color: nextParsed.color,
            alpha: nextParsed.alpha,
            format: requestedFormat,
            inputValue: nextValue,
        });
    }, [onValueChange, requestedFormat]);

    const renderedChildren = typeof children === 'function'
        ? children({
            value: rawValue || null,
            color: parsed.color,
            alpha: parsed.alpha,
            format: requestedFormat,
            inputValue: rawValue,
            isInvalid: Boolean(isInvalid),
        } satisfies ColorInputRenderState)
        : children;
    const swatchSlot = filterSlots(
        renderedChildren,
        'swatch',
        <Swatch
            size={ size }
            isDisabled={ isDisabled }
            aria-label="Selected color"
        >
            <CssColorPreviewContent value={ rawValue } />
        </Swatch>
    );

    return (
        <div
            ref={ ref }
            className={ cn(styles.root, className) }
            data-size={ size }
            data-variant={ variant }
            data-editor="raw"
            data-disabled={ isDisabled || undefined }
            data-readonly={ isReadOnly || undefined }
            data-invalid={ isInvalid || undefined }
            data-active={ isActive || undefined }
            { ...props }
        >
            <Input
                inputRef={ inputRef }
                type="text"
                size={ size }
                variant={ variant }
                value={ rawValue }
                placeholder={ placeholder }
                isDisabled={ isDisabled }
                isReadOnly={ isReadOnly }
                isInvalid={ isInvalid }
                isActive={ isActive }
                autoFocus={ autoFocus }
                aria-label={ placeholder ? undefined : ariaLabel }
                onChange={ handleChange }
            >
                <span
                    slot="prefix"
                    className={ previewStyles.previewSlot }
                    data-size={ size }
                >
                    { swatchSlot }
                </span>
            </Input>

            <HiddenColorInput name={ name } form={ form } value={ rawValue } isDisabled={ isDisabled } />
        </div>
    );
}

RawColorEditor.displayName = 'RawColorEditor';
