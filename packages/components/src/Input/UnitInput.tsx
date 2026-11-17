import { ChevronDown } from '@clowdy/icons/8';
import { BARE_NUMBER_RE, clamp, cn, parseUnitValue, roundForUnit, shiftStepForUnit, stepForUnit } from '@clowdy/lib';
import hotkeys from '@clowdy/lib/hotkeys';
import { useRunner } from '@clowdy/lib/useRunner';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '../Button';
import { For } from '../For';
import { ListBox, ListBoxItem, ListBoxSection } from '../List';
import { Popover, PopoverScroll, PopoverTrigger } from '../Popover';
import { Show } from '../Show';
import { Slot } from '../Slot';
import { Input, type InputSize } from './Input';
import styles from './UnitInput.module.css';

import type { ReactNode } from 'react';
import type { Key, Selection } from 'react-aria-components';

// ── Types ──────────────────────────────────────────────────────────────────

export interface UnitValue {
    type: 'unit';
    value: number;
    unit: string;
}

export interface KeywordValue {
    type: 'keyword';
    value: string;
}

export type UnitInputValue = UnitValue | KeywordValue;

/** Conversion rates: how many CSS pixels fit in 1 unit */
export type ConversionRates = Partial<Record<string, number>>;

export type ComparableUnitInputValue = { type: 'unit'; value: number; unit: string } | { type: 'keyword'; value: string };

export interface UnitInputProps {
    value?: UnitInputValue | null;
    placeholder?: string;
    placeholderUnit?: string;
    prefix?: ReactNode;
    units?: readonly string[];
    keywords?: readonly string[];
    priorityOptions?: readonly string[];
    min?: number;
    max?: number;
    /** Arrow step. Defaults to the unit's step (px is 1, rem is 0.1). */
    step?: number;
    /** Shift+arrow step. Defaults to ten times the unit step (px is 10). */
    shiftStep?: number;
    conversionRates?: ConversionRates;
    computedPx?: number;
    onApply?: (value: UnitInputValue) => void;
    onCommit?: (value: UnitInputValue) => boolean | void;
    onClear?: () => void;
    size?: InputSize;
    isActive?: boolean;
    autoSelect?: boolean;
    'aria-label'?: string;
    /** Extra class on the unit / keyword list popover. */
    popoverClassName?: string;
}

// ── Conversion ─────────────────────────────────────────────────────────────

/**
 * Convert a value between units through px as intermediate.
 * Falls back to keeping the numeric value if a rate is unknown.
 */
function convertUnit(
    value: number,
    fromUnit: string,
    toUnit: string,
    rates: ConversionRates
): number {
    if (fromUnit === toUnit) {
        return value;
    }

    const fromRate = rates[fromUnit];
    const toRate = rates[toUnit];

    if (fromRate == null || toRate == null || toRate === 0) {
        return value; // unknown unit — keep the number
    }

    const px = value * fromRate;

    return roundForUnit(px / toRate, toUnit);
}

// ── Parsing ────────────────────────────────────────────────────────────────

function clampNumeric(value: number, min: number | undefined, max: number | undefined): number {
    return clamp(min ?? -Infinity, value, max ?? Infinity);
}

interface InputReading {
    /** Absent while the text is still incomplete (`2.`, `2.5r`). */
    value: UnitInputValue | null;
    /** Free CSS, a unit written in the text, or a suffix still being typed. */
    hideUnit: boolean;
}

function readInput(
    raw: string,
    fallbackUnit: string,
    keywords: readonly string[],
    units: readonly string[],
    min: number | undefined,
    max: number | undefined
): InputReading {
    const trimmed = raw.trim();
    const pending = { value: null, hideUnit: false };

    if (!trimmed) {
        return pending;
    }

    if (keywords.includes(trimmed)) {
        return { value: { type: 'keyword', value: trimmed }, hideUnit: false };
    }

    if (/^[+-]?\d+[.,]$/.test(trimmed)) {
        return pending;
    }

    const normalized = trimmed.replace(/^([+-]?\d*),(?=\d)/, '$1.');
    const suffix = normalized.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([a-z%]+)$/i);

    if (suffix) {
        const unit = suffix[2].toLowerCase();
        const known = units.map(item => item.toLowerCase());

        if (!known.includes(unit) && known.some(item => item.startsWith(unit))) {
            return { value: null, hideUnit: true };
        }
    }

    const parsed = parseUnitValue(normalized);

    if (parsed) {
        return {
            value: { type: 'unit', value: clampNumeric(parsed.value, min, max), unit: parsed.unit },
            hideUnit: true,
        };
    }

    if (BARE_NUMBER_RE.test(normalized)) {
        return {
            value: { type: 'unit', value: clampNumeric(parseFloat(normalized), min, max), unit: fallbackUnit },
            hideUnit: false,
        };
    }

    return { value: { type: 'keyword', value: trimmed }, hideUnit: true };
}

function inputHtmlSize(value: string, placeholder: string | undefined): number {
    return Math.max(1, value.length, placeholder?.length ?? 0);
}

function unitInputDraftMatchesValue(
    draft: ComparableUnitInputValue | null | undefined,
    value: ComparableUnitInputValue | null | undefined
): boolean {
    if (!draft || !value) {
        return false;
    }

    if (draft.type !== value.type) {
        return false;
    }

    if (draft.type === 'keyword') {
        return value.type === 'keyword' && draft.value === value.value;
    }

    return value.type === 'unit'
      && draft.value === value.value
      && draft.unit === value.unit;
}

// ── Component ──────────────────────────────────────────────────────────────

export function UnitInput({
    value,
    placeholder,
    placeholderUnit,
    prefix,
    units = [],
    keywords = [],
    priorityOptions = [],
    min,
    max,
    step: stepProp,
    shiftStep: shiftStepProp,
    conversionRates,
    computedPx,
    onApply,
    onCommit,
    onClear,
    size = 'sm',
    isActive,
    autoSelect = false,
    'aria-label': ariaLabel,
    popoverClassName,
}: UnitInputProps) {
    const [localInput, setLocalInput] = useState<string | null>(null);
    const [isPopoverOpen, setIsPopoverOpen] = useState(false);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const fieldRef = useRef<HTMLDivElement | null>(null);
    const draftValueRef = useRef<ComparableUnitInputValue | null>(null);
    const nudgingRef = useRef(false);
    const prevValueRef = useRef(value);

    // Reset local draft only when value prop CONTENT changes from outside
    useEffect(() => {
        if (localInput !== null && unitInputDraftMatchesValue(draftValueRef.current, value)) {
            prevValueRef.current = value;

            return;
        }

        const prev = prevValueRef.current;
        const same = (prev === value)
          || (prev?.type === 'keyword' && value?.type === 'keyword' && prev.value === value.value)
          || (prev?.type === 'unit' && value?.type === 'unit' && prev.value === value.value && prev.unit === value.unit)
          || (prev == null && value == null);

        if (!same) {
            prevValueRef.current = value;
            draftValueRef.current = null;

            setLocalInput(null);
        }
    }, [value, ariaLabel, localInput]);

    // Derive display state from value prop
    const currentUnit = value?.type === 'unit' ? value.unit : (placeholderUnit ?? units[0] ?? 'px');
    const displayText = value
        ? (value.type === 'unit' ? String(value.value) : value.value)
        : '';

    // What user sees in the input
    const inputValue = localInput ?? displayText;
    const htmlSize = inputHtmlSize(inputValue, placeholder);
    const placeholderValue = useMemo(
        () => readInput(placeholder ?? '', currentUnit, keywords, units, min, max).value,
        [placeholder, currentUnit, keywords, units, min, max]
    );

    const draft = localInput == null
        ? null
        : readInput(localInput, currentUnit, keywords, units, min, max);
    const hideUnit = draft?.hideUnit
        ?? (value?.type === 'keyword' && !keywords.includes(value.value));
    const isKeyword = !hideUnit
        && value?.type === 'keyword'
        && keywords.includes(value.value)
        && (localInput === null || localInput === value.value);
    const hasChevronSuffix = !hideUnit && (isKeyword || (!value && !placeholderUnit));
    const suffixText = (hasChevronSuffix || hideUnit) ? undefined : (value ? currentUnit : placeholderUnit);

    // ── Handlers ───────────────────────────────────────────────────────────

    const handleChange = useCallback((raw: string) => {
        setLocalInput(raw);
    }, []);

    const commit = useCallback((raw: string) => {
        if (!raw.trim()) {
            if (value) {
                onClear?.();
            }

            setLocalInput(null);
            draftValueRef.current = null;

            return;
        }

        const parsed = readInput(raw, currentUnit, keywords, units, min, max).value;
        const next = parsed?.type === 'unit'
            ? { ...parsed, value: roundForUnit(parsed.value, parsed.unit) }
            : parsed;

        draftValueRef.current = null;
        setLocalInput(null);

        if (next) {
            onApply?.(next);
            onCommit?.(next);
        }
    }, [currentUnit, keywords, min, max, onApply, onCommit, onClear, units, value]);

    const handleSubmit = useCallback(() => {
        // Nothing to commit if user didn't type anything
        if (localInput === null) {
            return;
        }

        commit(inputValue);
    }, [commit, inputValue, localInput]);

    const handleBlur = useCallback(() => {
        // User didn't touch the input — nothing to commit
        if (localInput === null) {
            return;
        }

        commit(inputValue);
    }, [commit, inputValue, localInput]);

    const runnerStartValue = useMemo(() => {
        if (value?.type === 'unit') {
            return value.value;
        }

        if (!value && placeholderValue?.type === 'unit') {
            return placeholderValue.value;
        }

        const rates = conversionRates ?? {};
        const rate = rates[currentUnit];

        const canUseRenderedValue = value?.type === 'keyword' || placeholderValue?.type === 'keyword';

        if (canUseRenderedValue && computedPx != null && rate != null && rate > 0) {
            return roundForUnit(computedPx / rate, currentUnit);
        }

        return 0;
    }, [value, placeholderValue, conversionRates, currentUnit, computedPx]);

    const step = stepProp ?? stepForUnit(currentUnit);
    const shiftStep = shiftStepProp ?? shiftStepForUnit(currentUnit);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if (isKeyword && (e.key === 'Backspace' || e.key === 'Delete')) {
            e.preventDefault();
            draftValueRef.current = null;
            setLocalInput('');

            return;
        }

        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
            return;
        }

        if (isKeyword || isPopoverOpen || e.altKey || e.ctrlKey || e.metaKey) {
            return;
        }

        const reading = localInput == null
            ? null
            : readInput(localInput, currentUnit, keywords, units, min, max).value;

        if (localInput != null && reading?.type !== 'unit') {
            return;
        }

        const base = reading?.type === 'unit' ? reading.value : runnerStartValue;
        const delta = (e.shiftKey ? shiftStep : step) * (e.key === 'ArrowUp' ? 1 : -1);
        const next = roundForUnit(clampNumeric(base + delta, min, max), currentUnit);
        const nextValue = { type: 'unit', value: next, unit: currentUnit } as const;

        e.preventDefault();

        if (next === base) {
            return;
        }

        nudgingRef.current = true;
        setLocalInput(String(next));
        draftValueRef.current = nextValue;
        onApply?.(nextValue);
    }, [
        currentUnit,
        isKeyword,
        isPopoverOpen,
        keywords,
        localInput,
        max,
        min,
        onApply,
        runnerStartValue,
        shiftStep,
        step,
        units,
    ]);

    const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
        if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !nudgingRef.current) {
            return;
        }

        nudgingRef.current = false;
        const draft = draftValueRef.current;

        draftValueRef.current = null;
        setLocalInput(null);

        if (draft?.type === 'unit') {
            onCommit?.(draft);
        }
    }, [onCommit]);

    useRunner(fieldRef, {
        value: runnerStartValue,
        min,
        max,
        step,
        shiftStep,
        onChange: (next) => {
            const rounded = roundForUnit(next, currentUnit);
            const nextValue = { type: 'unit', value: rounded, unit: currentUnit } as const;

            setLocalInput(String(rounded));
            draftValueRef.current = nextValue;
            onApply?.(nextValue);
        },
        onEnd: (payload) => {
            const rounded = roundForUnit(payload.value, currentUnit);
            const nextValue = { type: 'unit', value: rounded, unit: currentUnit } as const;

            draftValueRef.current = null;
            setLocalInput(null);
            onCommit?.(nextValue);
        },
        shouldRun: target => !hideUnit && (target.closest('[data-scrub-handle]') != null || hotkeys.altKey),
    });

    // Keep selection covering the whole keyword so any typing replaces it
    useEffect(() => {
        if (!isKeyword) {
            return;
        }

        const input = inputRef.current;

        if (!input) {
            return;
        }

        const selectAll = () => {
            requestAnimationFrame(() => input.select());
        };

        input.addEventListener('focus', selectAll);
        input.addEventListener('click', selectAll);

        return () => {
            input.removeEventListener('focus', selectAll);
            input.removeEventListener('click', selectAll);
        };
    }, [isKeyword]);

    // Dropdown selection
    const selectedKeys = useMemo<Set<Key>>(() => {
        if (!value) {
            return new Set();
        }

        if (value.type === 'keyword') {
            return new Set([`kw:${ value.value }`]);
        }

        return new Set([`u:${ value.unit }`]);
    }, [value]);
    const priorityEntries = useMemo(() => priorityOptions.flatMap((option) => {
        if (units.includes(option)) {
            return [{ id: `u:${ option }`, value: option }];
        }

        if (keywords.includes(option)) {
            return [{ id: `kw:${ option }`, value: option }];
        }

        return [];
    }), [keywords, priorityOptions, units]);
    const priorityKeys = useMemo(
        () => new Set(priorityEntries.map(entry => entry.id)),
        [priorityEntries]
    );
    const remainingUnits = useMemo(
        () => units.filter(unit => !priorityKeys.has(`u:${ unit }`)),
        [priorityKeys, units]
    );
    const remainingKeywords = useMemo(
        () => keywords.filter(keyword => !priorityKeys.has(`kw:${ keyword }`)),
        [keywords, priorityKeys]
    );

    const handleSelection = useCallback((keys: Selection) => {
        if (keys === 'all') {
            return;
        }

        const key = [...keys][0] as string;

        if (!key) {
            return;
        }

        let newValue: UnitInputValue;

        if (key.startsWith('kw:')) {
            newValue = { type: 'keyword', value: key.slice(3) };
        }
        else {
            const newUnit = key.slice(2);
            const rates = conversionRates ?? {};

            let newNum: number;

            if (value?.type === 'unit') {
                // Unit → unit: convert through px using user's declared value
                newNum = convertUnit(value.value, value.unit, newUnit, rates);
            }
            else if (!value && placeholderValue?.type === 'unit') {
                // Empty own value with numeric inherited/initial placeholder: keep the visible numeric baseline.
                newNum = convertUnit(placeholderValue.value, placeholderValue.unit, newUnit, rates);
            }
            else if (computedPx != null && rates[newUnit] != null && rates[newUnit] > 0) {
                // Keyword → unit: use rendered pixel size when the caller provides one.
                newNum = roundForUnit(computedPx / rates[newUnit], newUnit);
            }
            else {
                newNum = 0;
            }

            newValue = { type: 'unit', value: newNum, unit: newUnit };
        }

        setLocalInput(null);
        setIsPopoverOpen(false);
        onApply?.(newValue);
        onCommit?.(newValue);
    }, [value, placeholderValue, conversionRates, computedPx, onApply, onCommit]);

    const hasPicker = units.length > 0 || keywords.length > 0;
    const scrubFieldProps = {
        autoComplete: 'off' as const,
        spellCheck: false as const,
        'data-1p-ignore': 'true',
        'data-lpignore': 'true',
        'data-form-type': 'other',
        onKeyUp: handleKeyUp,
    };
    const textPrefix = typeof prefix === 'string' ? prefix : undefined;
    const prefixSlot = (prefix && typeof prefix !== 'string')
        ? <Slot as="span" slot="prefix">{ prefix }</Slot>
        : null;

    if (!hasPicker) {
        return (
            <Input
                ref={ fieldRef }
                type="text"
                size={ size }
                scrubHandle={ !hideUnit }
                isActive={ isActive }
                aria-label={ ariaLabel }
                autoSelect={ autoSelect }
                className={ isKeyword ? styles.keywordMode : undefined }
                inputRef={ inputRef }
                htmlSize={ htmlSize }
                value={ inputValue }
                placeholder={ placeholder }
                prefix={ textPrefix }
                suffix={ suffixText }
                onChange={ handleChange }
                onSubmit={ handleSubmit }
                onBlur={ handleBlur }
                onKeyDown={ handleKeyDown }
                { ...scrubFieldProps }
            >
                { prefixSlot }
            </Input>
        );
    }

    return (
        <Input
            ref={ fieldRef }
            type="text"
            size={ size }
            scrubHandle={ !hideUnit }
            isActive={ isActive }
            aria-label={ ariaLabel }
            autoSelect={ autoSelect }
            className={ cn(styles.unitInput, isKeyword && styles.keywordMode) }
            inputRef={ inputRef }
            htmlSize={ htmlSize }
            value={ inputValue }
            placeholder={ placeholder }
            prefix={ textPrefix }
            onChange={ handleChange }
            onSubmit={ handleSubmit }
            onBlur={ handleBlur }
            onKeyDown={ handleKeyDown }
            { ...scrubFieldProps }
        >
            { prefixSlot }
            { !hideUnit
                ? (
                    <Slot
                        as="div"
                        slot="suffix"
                        data-unit-chevron-slot={ hasChevronSuffix || undefined }
                        data-open={ isPopoverOpen || undefined }
                    >
                        <PopoverTrigger isOpen={ isPopoverOpen } onOpenChange={ setIsPopoverOpen }>
                            <Button
                                variant="filling"
                                size="xs"
                                className={ styles.unitButton }
                                contentClassName={ hasChevronSuffix ? styles.unitButtonContent : undefined }
                                data-chevron-suffix={ hasChevronSuffix || undefined }
                                data-open={ isPopoverOpen || undefined }
                                aria-label="Change unit"
                                aria-expanded={ isPopoverOpen }
                            >
                                { hasChevronSuffix
                                    ? <ChevronDown className={ styles.unitChevron } aria-hidden />
                                    : suffixText }
                            </Button>

                            <Popover placement="bottom end" spacing="xs" className={ cn(styles.popover, popoverClassName) }>
                                <PopoverScroll maxHeight={ 240 }>
                                    <ListBox
                                        selectionMode="single"
                                        selectedKeys={ selectedKeys }
                                        onSelectionChange={ handleSelection }
                                        aria-label="Units and keywords"
                                    >
                                        <Show when={ priorityEntries.length > 0 }>
                                            <ListBoxSection>
                                                <For each={ priorityEntries }>
                                                    { option => (
                                                        <ListBoxItem
                                                            key={ option.id }
                                                            id={ option.id }
                                                            textValue={ option.value }
                                                        >
                                                            { option.value }
                                                        </ListBoxItem>
                                                    ) }
                                                </For>
                                            </ListBoxSection>
                                        </Show>
                                        <Show when={ remainingUnits.length > 0 }>
                                            <ListBoxSection>
                                                <For each={ remainingUnits }>
                                                    { u => (
                                                        <ListBoxItem key={ `u:${ u }` } id={ `u:${ u }` } textValue={ u }>
                                                            { u }
                                                        </ListBoxItem>
                                                    ) }
                                                </For>
                                            </ListBoxSection>
                                        </Show>
                                        <Show when={ remainingKeywords.length > 0 }>
                                            <ListBoxSection>
                                                <For each={ remainingKeywords }>
                                                    { kw => (
                                                        <ListBoxItem key={ `kw:${ kw }` } id={ `kw:${ kw }` } textValue={ kw }>
                                                            { kw }
                                                        </ListBoxItem>
                                                    ) }
                                                </For>
                                            </ListBoxSection>
                                        </Show>
                                    </ListBox>
                                </PopoverScroll>
                            </Popover>
                        </PopoverTrigger>
                    </Slot>
                )
                : null }
        </Input>
    );
}

UnitInput.displayName = 'UnitInput';
