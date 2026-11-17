import { clamp, cn, mergeRefs, roundNumber } from '@clowdy/lib';
import { useRunner } from '@clowdy/lib/useRunner';
import {
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    type MouseEventHandler,
    type PointerEventHandler,
    type ReactNode,
    type Ref,
    type RefObject,
} from 'react';
import { type AriaTextFieldOptions } from 'react-aria';
import {
    Input as AriaInput,
    NumberField as AriaNumberField,
    TextField as AriaTextField,
    Group,
    InputContext,
    NumberFieldStateContext,
    Provider,
    useContextProps,
    type NumberFieldProps as AriaNumberFieldProps,
    type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';

import { Show } from '../Show';
import { DEFAULT_SLOT, filterSlots, SlotContext, useSlotContextProps } from '../Slot';
import { Text } from '../Text';
import styles from './Input.module.css';

const INPUT_SLOTS = { [DEFAULT_SLOT]: {}, prefix: {}, suffix: {} };
const INTERACTIVE_FIELD_TARGET_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="listbox"]',
    '[role="option"]',
    '[data-scrub-handle]',
].join(',');
const TEXT_SELECTION_INPUT_TYPES = new Set(['email', 'password', 'search', 'tel', 'text', 'url']);

export type InputVariant = 'filled' | 'bordered' | 'transparent' | 'inline';
export type InputSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * Opt-in flush control affix for slotted prefix/suffix (buttons, icons).
 *
 * @example
 * <Input>
 *   <Button slot="suffix" data-input-affix={INPUT_CONTROL_AFFIX}>Apply</Button>
 * </Input>
 */
export const INPUT_CONTROL_AFFIX = 'control';

type NumberInputProps = Omit<AriaNumberFieldProps, 'type' | 'spellCheck'> & {
    type: 'number';
    inputRef?: Ref<HTMLInputElement>;
    interactionStep?: number;
    shiftStep?: number;
    roundTo?: number;
    /** RAC NumberField omits this — wire onto the inner input. */
    placeholder?: string;
};

export type TextInputProps = Omit<AriaTextFieldProps, 'type' | 'size' | 'spellCheck'> & {
    placeholder?: string;
    inputRef?: Ref<HTMLInputElement | null>;
    type: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url';
    inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
    /** RAC TextField forwards these to the inner input. */
    autoCapitalize?: AriaTextFieldOptions<'input'>['autoCapitalize'];
    autoCorrect?: string;
    onChange?: (value: string) => void;
    onPaste?: React.ClipboardEventHandler<HTMLInputElement>;
};

type ClowdyInputProps = {
    ref?: Ref<HTMLDivElement | null>;
    variant?: InputVariant;
    size?: InputSize;
    htmlSize?: number;
    /** Size the field to the typed value instead of filling the parent. Works with `type="number"`. */
    hug?: boolean;
    prefix?: string; // NOTE: use slots if you need non-string content
    suffix?: string; // NOTE: use slots if you need non-string content
    children?: ReactNode;
    className?: string;
    isDisabled?: boolean;
    isInvalid?: boolean;
    isReadOnly?: boolean;
    isActive?: boolean;
    autoFocus?: boolean;
    /** Select the whole value after mount. Typing replaces it. */
    autoSelect?: boolean;
    onPress?: () => void;
    onSubmit?: () => void;
    scrubHandle?: boolean;
    spellCheck?: boolean;
};

export type InputProps = (ClowdyInputProps & NumberInputProps) | (ClowdyInputProps & TextInputProps);

const DEFAULT_NUMBER_FORMAT: Intl.NumberFormatOptions = {
    style: 'decimal',
    useGrouping: false,
};

function NumberInput({
    formatOptions = DEFAULT_NUMBER_FORMAT,
    inputRef,
    fieldRef,
    htmlSize,
    slot,
    placeholder,
    onSubmit,
    step,
    interactionStep,
    shiftStep,
    roundTo,
    ...props
}: NumberInputProps & {
    fieldRef: RefObject<HTMLDivElement | null>;
    htmlSize: number;
    onSubmit?: () => void;
}) {
    // Controlled empty must stay controlled — Aria treats a missing/`undefined`
    // `value` as uncontrolled; NaN is NumberField's empty sentinel.
    const isControlled = Object.hasOwn(props, 'value');
    const rawValue = props.value;
    const value = (isControlled && (rawValue == null || Number.isNaN(rawValue)))
        ? Number.NaN
        : rawValue;

    return (
        <AriaNumberField
            formatOptions={ formatOptions }
            slot={ slot }
            { ...props }
            step={ interactionStep ?? step }
            { ...(isControlled ? { value } : {}) }
        >
            <NumberInputInner
                inputRef={ inputRef }
                fieldRef={ fieldRef }
                htmlSize={ htmlSize }
                placeholder={ placeholder }
                onSubmit={ onSubmit }
                step={ step }
                interactionStep={ interactionStep }
                shiftStep={ shiftStep }
                roundTo={ roundTo }
                { ...props }
            />
        </AriaNumberField>
    );
}

function NumberInputInner({
    step = 1,
    interactionStep = step,
    shiftStep = interactionStep * 10,
    minValue,
    maxValue,
    roundTo,
    inputRef,
    fieldRef,
    htmlSize,
    isDisabled,
    isReadOnly,
    placeholder,
    onKeyDown,
    onSubmit,
}: NumberInputProps & {
    fieldRef: RefObject<HTMLDivElement | null>;
    htmlSize: number;
    onSubmit?: () => void;
}) {
    const state = use(NumberFieldStateContext)!;

    useRunner(fieldRef, {
        value: Number.isFinite(state.numberValue) ? state.numberValue : 0,
        onChange: state.setNumberValue,
        min: minValue,
        max: maxValue,
        step: interactionStep,
        shiftStep,
        option: true,
        disabled: isDisabled || isReadOnly,
    });

    const snapToStep = useCallback(
        () => {
            if (roundTo == null || roundTo <= 0 || !Number.isFinite(roundTo) || !state) {
                return;
            }

            const current = state.numberValue;

            if (!Number.isFinite(current)) {
                return;
            }

            const rounded = roundNumber(current, roundTo, minValue ?? 0);
            const finalValue = clamp(minValue ?? -Infinity, rounded, maxValue ?? Infinity);

            if (finalValue !== state.numberValue) {
                state.setNumberValue(finalValue);
            }
        },
        [roundTo, minValue, maxValue, state]
    );

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLInputElement>) => {
            // Mirror text Input onSubmit — snap first, then defer so RAC onChange /
            // keyup still land on this field before a parent unmounts it.
            if (e.key === 'Enter' && onSubmit) {
                e.preventDefault();

                if (roundTo != null && roundTo > 0) {
                    snapToStep();
                }

                requestAnimationFrame(() => onSubmit());
            }

            // RAC NumberField onKeyDown is BaseEvent; callers pass DOM KeyboardEvent handlers.
            onKeyDown?.(e as Parameters<NonNullable<typeof onKeyDown>>[0]);

            if (e.defaultPrevented) {
                return;
            }

            if (e.key === 'Enter' && roundTo != null && roundTo > 0) {
                snapToStep();

                return;
            }

            if (e.shiftKey
                && !e.altKey
                && !e.ctrlKey
                && !e.metaKey
                && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                const current = Number.isFinite(state.numberValue) ? state.numberValue : 0;
                const direction = e.key === 'ArrowUp' ? 1 : -1;
                const next = clamp(
                    state.minValue ?? -Infinity,
                    current + shiftStep * direction,
                    state.maxValue ?? Infinity
                );

                state.setNumberValue(next);
            }
        },
        [onKeyDown, onSubmit, snapToStep, roundTo, shiftStep, state]
    );

    // NOTE: Any other props AriaInput receives from AriaNumberField (context)
    return (
        <AriaInput
            className={ styles.input }
            ref={ inputRef }
            size={ htmlSize }
            placeholder={ placeholder }
            onBlur={ snapToStep }
            onKeyDown={ handleKeyDown }
        />
    );
}

/** Data attributes on TextField land on the wrapper. Password managers read the input. */
function inputDataAttributes(props: object): Record<string, string> {
    const attributes: Record<string, string> = {};

    for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('data-') && typeof value === 'string') {
            attributes[key] = value;
        }
    }

    return attributes;
}

function TextInput({
    inputRef,
    onSubmit,
    onKeyDown,
    onKeyUp,
    inputMode,
    onPaste,
    spellCheck,
    autoComplete,
    htmlSize,
    ...props
}: TextInputProps & {
    onSubmit?: () => void;
    onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
    onKeyUp?: React.KeyboardEventHandler<HTMLInputElement>;
    htmlSize: number;
    spellCheck?: boolean;
}) {
    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && onSubmit) {
            e.preventDefault();

            // Defer to let keyup fire inside the current DOM before any parent unmounts
            requestAnimationFrame(() => onSubmit());
        }

        onKeyDown?.(e);
    }, [onSubmit, onKeyDown]);

    return (
        <AriaTextField { ...props }>
            <AriaInput
                ref={ inputRef }
                className={ styles.input }
                size={ htmlSize }
                inputMode={ inputMode }
                autoComplete={ autoComplete }
                onKeyDown={ handleKeyDown }
                onKeyUp={ onKeyUp }
                onPaste={ onPaste }
                spellCheck={ spellCheck }
                { ...inputDataAttributes(props) }
            />
        </AriaTextField>
    );
}

export function Input(props: InputProps) {
    // Slot merge drops unknown props such as autoSelect. Keep the caller's flag.
    const autoSelect = props.autoSelect;
    // SlotContext / InputContext first; local props win; defaults after merge.
    const slotMerged = useSlotContextProps(props);
    const [mergedProps, mergedInputRef] = useContextProps(slotMerged, slotMerged.inputRef, InputContext);

    // <input> ref
    const _inputRef = useRef<HTMLInputElement>(null);
    // eslint-disable-next-line react-hooks/refs -- mergeRefs composes; it does not read `.current`
    const inputRef = mergeRefs(_inputRef, mergedInputRef);

    // <Group> ref — exposed so useRunner can attach pointer listeners to the whole field
    const _fieldRef = useRef<HTMLDivElement>(null);

    const {
        ref,
        slot,
        variant = 'filled',
        size = 'md',
        htmlSize = 1,
        hug,
        prefix,
        suffix,
        children,
        className,
        autoFocus,
        autoSelect: _autoSelect,
        inputRef: _callerInputRef,
        onPress,
        onSubmit,
        scrubHandle,
        isActive,
        isDisabled,
        isInvalid,
        isReadOnly,
        ...inputProps
    } = mergedProps as InputProps & { slot?: unknown };
    const domSlot = (typeof slot === 'string' || typeof slot === 'number') ? slot : undefined;

    const fieldRef = mergeRefs(_fieldRef, ref as Ref<HTMLDivElement>);

    useEffect(() => {
        const input = _inputRef.current;

        if (!input?.closest('[role="gridcell"]')) {
            return;
        }

        return bindGridCaret(input);
    }, []);

    useEffect(() => {
        if (!autoFocus && !autoSelect) {
            return;
        }

        const timer = setTimeout(() => {
            const input = _inputRef.current;

            if (!input) return;
            input.focus();
            if (autoSelect) input.select();
        }, 50);

        return () => clearTimeout(timer);
    }, [autoFocus, autoSelect]);

    useLayoutEffect(() => {
        if (!hug) {
            return;
        }

        const input = _inputRef.current;
        const field = _fieldRef.current;

        if (!input || !field) {
            return;
        }

        const sync = () => {
            field.style.setProperty(
                '--clowdy-input-hug-ch',
                String(Math.max(htmlSize, input.value.length, 1))
            );
        };

        sync();
        input.addEventListener('input', sync);

        return () => {
            input.removeEventListener('input', sync);
            field.style.removeProperty('--clowdy-input-hug-ch');
        };
    }, [hug, htmlSize, inputProps.value, inputProps.defaultValue]);

    const prefixSlot = useMemo(
        (): ReactNode => filterSlots(
            children,
            'prefix',
            prefix ? <Text slot="prefix" className={ styles.textPrefix }>{prefix}</Text> : undefined
        ),
        [children, prefix]
    );
    const suffixSlot = useMemo(
        (): ReactNode => filterSlots(
            children,
            'suffix',
            suffix ? <Text slot="suffix" className={ styles.textSuffix }>{suffix}</Text> : undefined
        ),
        [children, suffix]
    );

    const handleContainerPointerDown: PointerEventHandler<HTMLDivElement> = (event) => {
        const input = _inputRef.current;

        if (event.button !== 0 || !input || isDisabled || shouldKeepTargetFocus(event.target, event.currentTarget)) {
            return;
        }

        event.preventDefault();
        input.focus();
        placeCaretAtFieldEdge(input, event.clientX);
    };

    const handleContainerClick: MouseEventHandler<HTMLDivElement> = () => {
        _inputRef.current?.focus();

        if (!isDisabled) {
            onPress?.();
        }
    };

    return (
        <Provider values={ [[SlotContext, { slots: INPUT_SLOTS }]] }>
            <Group
                ref={ fieldRef }
                slot={ domSlot }
                className={ cn(styles.field, className) }
                data-variant={ variant }
                data-size={ size }
                data-active={ isActive || undefined }
                data-disabled={ isDisabled || undefined }
                data-invalid={ isInvalid || undefined }
                data-readonly={ isReadOnly || undefined }
                data-hug={ hug || undefined }
                data-pressable={ (onPress && !isDisabled) || undefined }
                data-modal-drag-exclude
                isDisabled={ isDisabled }
                isInvalid={ isInvalid }
                isReadOnly={ isReadOnly }
                onPointerDown={ handleContainerPointerDown }
                onClick={ handleContainerClick }
            >
                <Show when={ scrubHandle }>
                    <div className={ styles.scrubHandle } data-scrub-handle />
                </Show>

                {prefixSlot}

                {inputProps.type === 'number'
                    ? (
                        <NumberInput
                            inputRef={ inputRef }
                            fieldRef={ _fieldRef }
                            htmlSize={ htmlSize }
                            className="contents"
                            isDisabled={ isDisabled }
                            isInvalid={ isInvalid }
                            isReadOnly={ isReadOnly }
                            onSubmit={ onSubmit }
                            { ...inputProps }
                        />
                    )
                    : (
                        <TextInput
                            inputRef={ inputRef }
                            className="contents"
                            onSubmit={ onSubmit }
                            htmlSize={ htmlSize }
                            isDisabled={ isDisabled }
                            isInvalid={ isInvalid }
                            isReadOnly={ isReadOnly }
                            { ...inputProps }
                        />
                    )}

                {suffixSlot}
            </Group>
        </Provider>
    );
}

function shouldKeepTargetFocus(target: EventTarget, field: HTMLElement): boolean {
    return target instanceof Element
      && Boolean(target.closest(INTERACTIVE_FIELD_TARGET_SELECTOR))
      && field.contains(target);
}

const gridCaretInputs = new Set<HTMLInputElement>();
let unbindGridCaret: (() => void) | undefined;

function bindGridCaret(input: HTMLInputElement): () => void {
    gridCaretInputs.add(input);

    if (!unbindGridCaret) {
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target;

            if (!(target instanceof HTMLInputElement) || !gridCaretInputs.has(target) || !arrowMovesCaret(target, event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            moveCaret(target, event);
        };

        document.addEventListener('keydown', onKeyDown, true);
        unbindGridCaret = () => {
            document.removeEventListener('keydown', onKeyDown, true);
            unbindGridCaret = undefined;
        };
    }

    return () => {
        gridCaretInputs.delete(input);

        if (gridCaretInputs.size === 0) {
            unbindGridCaret?.();
        }
    };
}

function arrowMovesCaret(input: HTMLInputElement, event: KeyboardEvent): boolean {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return false;
    }

    if (event.isComposing || input.disabled || input.readOnly || !TEXT_SELECTION_INPUT_TYPES.has(input.type)) {
        return false;
    }

    const start = input.selectionStart;
    const end = input.selectionEnd;

    if (start == null || end == null) {
        return false;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || start !== end) {
        return true;
    }

    return event.key === 'ArrowLeft' ? start > 0 : end < input.value.length;
}

function moveCaret(input: HTMLInputElement, event: KeyboardEvent) {
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const length = input.value.length;

    try {
        if (event.altKey || event.ctrlKey || event.metaKey) {
            if (event.shiftKey) {
                input.setSelectionRange(
                    direction < 0 ? 0 : start,
                    direction < 0 ? end : length,
                    direction < 0 ? 'backward' : 'forward'
                );
            }
            else {
                const edge = direction < 0 ? 0 : length;

                input.setSelectionRange(edge, edge);
            }

            return;
        }

        if (event.shiftKey) {
            const backward = input.selectionDirection === 'backward';

            if (direction > 0) {
                input.setSelectionRange(
                    backward && start !== end ? start + 1 : start,
                    backward && start !== end ? end : Math.min(length, end + 1),
                    backward && start + 1 < end ? 'backward' : 'forward'
                );
            }
            else {
                input.setSelectionRange(
                    backward || start === end ? Math.max(0, start - 1) : start,
                    backward || start === end ? end : end - 1,
                    !backward && start < end - 1 ? 'forward' : 'backward'
                );
            }

            return;
        }

        const next = start === end ? start + direction : direction > 0 ? end : start;

        input.setSelectionRange(next, next);
    }
    catch {
        // Some browsers reject selection APIs for non-text controls despite input.type checks.
    }
}

function placeCaretAtFieldEdge(input: HTMLInputElement, clientX: number) {
    if (!TEXT_SELECTION_INPUT_TYPES.has(input.type)) {
        return;
    }

    const rect = input.getBoundingClientRect();
    const offset = clientX <= rect.left ? 0 : input.value.length;

    try {
        input.setSelectionRange(offset, offset);
    }
    catch {
        // Some browsers reject selection APIs for non-text controls despite input.type checks.
    }
}

Input.displayName = 'Input';
