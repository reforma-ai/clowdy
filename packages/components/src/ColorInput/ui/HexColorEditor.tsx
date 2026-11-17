import { cn, mergeRefs } from '@clowdy/lib';
import { useRunner } from '@clowdy/lib/useRunner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Provider } from 'react-aria-components';

import { Box } from '../../Box';
import { Input } from '../../Input';
import { Show } from '../../Show';
import { DEFAULT_SLOT, filterSlots, SlotContext } from '../../Slot';
import { ColorSwatch } from '../../Swatch';
import styles from '../ColorInput.module.css';
import { serializeColorObject } from '../format';
import {
    colorToHexInput,
    normalizeAlphaInput,
    normalizeHexInput,
    parseColorInputValue,
    parseHexAlphaInput,
    parseHexInput,
    serializeColorInputValue,
    shiftHexColor,
    withAlpha,
} from '../value';
import { HiddenColorInput } from './HiddenColorInput';

import type { ClipboardEvent, FocusEvent, KeyboardEvent } from 'react';
import type { Color } from 'react-stately';
import type { ColorInputEditorProps, ColorInputRenderState } from '../ColorInput';

const COLOR_INPUT_SLOTS = {
    [DEFAULT_SLOT]: {},
    swatch: {},
    value: {},
    alpha: {},
};

export function HexColorEditor({
    ref,
    inputRef,
    currentValue,
    editorFormat: _editorFormat,
    requestedFormat,
    size = 'sm',
    variant = 'filled',
    showAlpha = true,
    placeholder,
    isDisabled,
    isReadOnly,
    isInvalid,
    isActive,
    autoFocus,
    name,
    form,
    children,
    className,
    onBlur,
    onKeyDown,
    onValueChange,
    ...props
}: ColorInputEditorProps) {
    const parsed = useMemo(() => parseColorInputValue(currentValue), [currentValue]);
    const [inputValue, setInputValue] = useState(() => colorToHexInput(parsed.color));
    const [alphaValue, setAlphaValue] = useState(() => String(parsed.alpha));
    const hexInputRef = useRef<HTMLInputElement | null>(null);
    const alphaFieldRef = useRef<HTMLDivElement | null>(null);
    const mergedInputRef = useMemo(() => mergeRefs(hexInputRef, inputRef), [inputRef]);

    useEffect(() => {
        setInputValue(colorToHexInput(parsed.color));
        setAlphaValue(String(parsed.alpha));
    }, [parsed.color, parsed.alpha]);

    const emitChange = useCallback((nextColor: Color | null, nextAlpha: number) => {
        const alpha = normalizeAlphaInput(nextAlpha);
        const color = withAlpha(nextColor, alpha);
        const nextValue = nextColor
            ? serializeColorObject(nextColor, alpha, requestedFormat, 'hex')
            : null;

        onValueChange(nextValue, {
            value: nextValue,
            color,
            alpha,
            format: requestedFormat,
            inputValue: nextValue ?? '',
        });
    }, [onValueChange, requestedFormat]);

    const commitInputValue = useCallback((nextInputValue = inputValue) => {
        if (!nextInputValue) {
            emitChange(null, Number(alphaValue));

            return;
        }

        const nextColor = parseHexInput(nextInputValue);

        if (!nextColor) {
            setInputValue(colorToHexInput(parsed.color));

            return;
        }

        const normalizedInput = colorToHexInput(nextColor);

        setInputValue(normalizedInput);
        emitChange(nextColor, Number(alphaValue));
    }, [alphaValue, emitChange, inputValue, parsed.color]);

    const handleInputChange = useCallback((nextInputValue: string) => {
        const normalized = normalizeHexInput(nextInputValue);

        if (normalized == null) {
            return;
        }

        setInputValue(normalized);

        if (normalized.length === 6) {
            const nextColor = parseHexInput(normalized);

            if (nextColor) {
                emitChange(nextColor, Number(alphaValue));
            }
        }
    }, [alphaValue, emitChange]);

    const handleInputPaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
        const parsedHexAlpha = parseHexAlphaInput(event.clipboardData.getData('text'));

        if (!parsedHexAlpha) {
            return;
        }

        event.preventDefault();

        setInputValue(parsedHexAlpha.inputValue);
        setAlphaValue(String(parsedHexAlpha.alpha));
        emitChange(parsedHexAlpha.color, parsedHexAlpha.alpha);
    }, [emitChange]);

    const handleAlphaChange = useCallback((nextAlphaValue: string) => {
        if (!/^\d{0,3}$/.test(nextAlphaValue)) {
            return;
        }

        setAlphaValue(nextAlphaValue);

        if (nextAlphaValue === '') {
            return;
        }

        emitChange(parsed.color, Number(nextAlphaValue));
    }, [emitChange, parsed.color]);

    const handleAlphaBlur = useCallback(() => {
        const alpha = normalizeAlphaInput(Number(alphaValue));

        setAlphaValue(String(alpha));
        emitChange(parsed.color, alpha);
    }, [alphaValue, emitChange, parsed.color]);

    const handleAlphaRunnerChange = useCallback((nextAlpha: number) => {
        const alpha = normalizeAlphaInput(nextAlpha);

        setAlphaValue(String(alpha));
        emitChange(parsed.color, alpha);
    }, [emitChange, parsed.color]);

    useRunner(alphaFieldRef, {
        value: parsed.alpha,
        min: 0,
        max: 100,
        step: 1,
        shiftStep: 10,
        disabled: isDisabled || isReadOnly || !showAlpha,
        onChange: handleAlphaRunnerChange,
        shouldRun: target => target.closest('[data-scrub-handle]') != null,
    });

    const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
        commitInputValue();
        onBlur?.(event);
    }, [commitInputValue, onBlur]);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter') {
            commitInputValue();
        }
        else if (event.key === 'Escape') {
            setInputValue(colorToHexInput(parsed.color));
        }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            if (event.target === hexInputRef.current) {
                event.preventDefault();

                const direction = event.key === 'ArrowUp' ? 1 : -1;
                const step = event.shiftKey ? 16 : 1;
                const nextColor = shiftHexColor(parsed.color, direction * step);

                setInputValue(colorToHexInput(nextColor));
                emitChange(nextColor, Number(alphaValue));
            }
        }

        onKeyDown?.(event);
    }, [alphaValue, commitInputValue, emitChange, onKeyDown, parsed.color]);

    const colorWithAlpha = withAlpha(parsed.color, parsed.alpha);
    const renderedChildren = typeof children === 'function'
        ? children({
            value: serializeColorInputValue(parsed.color, parsed.alpha, requestedFormat),
            color: colorWithAlpha,
            alpha: parsed.alpha,
            format: requestedFormat,
            inputValue,
            isInvalid: Boolean(isInvalid || (!parsed.color && inputValue)),
        } satisfies ColorInputRenderState)
        : children;
    const swatchSlot = filterSlots(
        renderedChildren,
        'swatch',
        <ColorSwatch
            slot="swatch"
            size={ size }
            color={ colorWithAlpha }
            isDisabled={ isDisabled }
            aria-label="Selected color"
        />
    );
    const restSlots = filterSlots(renderedChildren, slot => !['swatch', 'alpha'].includes(slot));
    const alphaSlot = filterSlots(
        renderedChildren,
        'alpha',
        <div ref={ alphaFieldRef } className={ styles.alphaField }>
            <div className={ styles.alphaScrubHandle } data-scrub-handle />
            <Input
                className={ styles.alphaInput }
                type="text"
                variant="inline"
                size={ size }
                inputMode="numeric"
                value={ alphaValue }
                isDisabled={ isDisabled }
                isReadOnly={ isReadOnly }
                aria-label="Color opacity"
                onChange={ handleAlphaChange }
                onBlur={ handleAlphaBlur }
            />
            <span className={ styles.alphaSuffix } aria-hidden>%</span>
        </div>
    );
    const submittedValue = parsed.color
        ? serializeColorObject(parsed.color, parsed.alpha, requestedFormat, 'hex')
        : '';

    return (
        <Provider values={ [[SlotContext, { slots: COLOR_INPUT_SLOTS }]] }>
            <div
                ref={ ref }
                className={ cn(styles.root, className) }
                data-size={ size }
                data-variant={ variant }
                data-editor="hex"
                data-disabled={ isDisabled || undefined }
                data-readonly={ isReadOnly || undefined }
                data-invalid={ isInvalid || undefined }
                data-active={ isActive || undefined }
                onBlur={ handleBlur }
                onKeyDown={ handleKeyDown }
                { ...props }
            >
                <div className={ styles.colorField } data-single={ !showAlpha || undefined }>
                    <Box direction="row" align="center" justify="center" className="flex-shrink-0">
                        { swatchSlot }
                    </Box>

                    <Input
                        className={ styles.hexInput }
                        inputRef={ mergedInputRef }
                        type="text"
                        variant="inline"
                        size={ size }
                        value={ inputValue }
                        placeholder={ placeholder }
                        isDisabled={ isDisabled }
                        isReadOnly={ isReadOnly }
                        isInvalid={ isInvalid }
                        aria-label={ props['aria-label'] ?? 'Color' }
                        autoFocus={ autoFocus }
                        spellCheck={ false }
                        onChange={ handleInputChange }
                        onPaste={ handleInputPaste }
                    />

                    { restSlots }
                </div>

                <Show when={ showAlpha }>
                    { alphaSlot }
                </Show>

                <HiddenColorInput name={ name } form={ form } value={ submittedValue } isDisabled={ isDisabled } />
            </div>
        </Provider>
    );
}
