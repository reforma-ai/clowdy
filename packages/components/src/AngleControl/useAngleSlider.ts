import { useCallback, useMemo, useRef } from 'react';
import { mergeProps, useSlider, useSliderThumb } from 'react-aria';
import { useSliderState } from 'react-stately';

import {
    formatAngleNumber,
    getAnglePrecision,
    toDegrees,
} from './angle';

import type { InputHTMLAttributes, KeyboardEvent, RefObject } from 'react';
import type { AngleChangeSource, AnglePrecision, AngleUnit, AngleValue, AngleValueRange } from './angle';
import type { AngleState } from './useAngleState';

interface AngleSliderBounds {
    min: number;
    max: number;
}

interface UseAngleSliderOptions {
    rootRef: RefObject<HTMLDivElement | null>;
    angle: AngleState;
    step?: number;
    precision?: AnglePrecision;
    valueRange: AngleValueRange;
    isDisabled?: boolean;
    ariaLabel: string;
    ariaLabelledBy?: string;
    onChangeDegrees: (degrees: number, source: AngleChangeSource, committed: boolean) => void;
}

const DEFAULT_STEP_BY_UNIT: Record<AngleUnit, number> = {
    deg: 1,
    grad: 1 / 0.9,
    rad: Math.PI / 180,
    turn: 1 / 360,
};

const SLIDER_THUMB_INDEX = 0;
const SHIFT_KEY_STEP_DEGREES = 15;

function formatAriaValue(value: AngleValue, precision?: AnglePrecision): string {
    const unitLabel: Record<AngleUnit, string> = {
        deg: 'degrees',
        grad: 'gradians',
        rad: 'radians',
        turn: 'turns',
    };

    return `${ formatAngleNumber(value, { precision }) } ${ unitLabel[value.unit] }`;
}

function sliderBoundsForAngle(
    degrees: number,
    minDegrees: number | undefined,
    maxDegrees: number | undefined,
    valueRange: AngleValueRange
): AngleSliderBounds {
    let fallback: AngleSliderBounds;

    if (valueRange === 'signed') {
        fallback = { min: -180, max: 180 };
    }
    else if (valueRange === 'positive') {
        fallback = { min: 0, max: 360 };
    }
    else {
        const revolutionStart = Math.floor(degrees / 360) * 360;

        fallback = { min: revolutionStart, max: revolutionStart + 360 };
    }

    const min = minDegrees ?? Math.min(fallback.min, degrees);
    const max = maxDegrees ?? Math.max(fallback.max, degrees);
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);

    if (lower === upper) {
        return { min: lower - 1, max: upper + 1 };
    }

    return { min: lower, max: upper };
}

function stepDegreesForUnit(step: number | undefined, unit: AngleUnit): number {
    const degrees = toDegrees({ value: step ?? DEFAULT_STEP_BY_UNIT[unit], unit });

    return (Number.isFinite(degrees) && degrees > 0) ? degrees : 1;
}

export function useAngleSlider({
    rootRef,
    angle,
    step,
    precision,
    valueRange,
    isDisabled,
    ariaLabel,
    ariaLabelledBy,
    onChangeDegrees,
}: UseAngleSliderOptions) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    const bounds = sliderBoundsForAngle(angle.degrees, angle.minDegrees, angle.maxDegrees, valueRange);
    const value = Math.min(Math.max(angle.degrees, bounds.min), bounds.max);
    const sliderStep = stepDegreesForUnit(step, angle.unit);
    const numberFormatter = useMemo(() => new Intl.NumberFormat(undefined, {
        maximumFractionDigits: getAnglePrecision(angle.unit, precision),
    }), [angle.unit, precision]);

    const handleChange = useCallback((nextDegrees: number | number[]) => {
        if (typeof nextDegrees === 'number') {
            onChangeDegrees(nextDegrees, 'keyboard', true);
        }
    }, [onChangeDegrees]);

    const sliderProps = {
        value,
        minValue: bounds.min,
        maxValue: bounds.max,
        step: sliderStep,
        orientation: 'horizontal' as const,
        isDisabled,
        'aria-label': ariaLabel,
        'aria-labelledby': ariaLabelledBy,
        onChange: handleChange,
    };
    const state = useSliderState({
        ...sliderProps,
        numberFormatter,
    });
    const { groupProps } = useSlider(sliderProps, state, rootRef);
    const {
        inputProps: sliderInputProps,
        isDragging,
        isFocused,
    } = useSliderThumb({
        index: SLIDER_THUMB_INDEX,
        trackRef: rootRef,
        inputRef,
        isDisabled,
        'aria-label': ariaLabel,
        'aria-labelledby': ariaLabelledBy,
    }, state);

    const focusThumb = useCallback(() => {
        state.setFocusedThumb(SLIDER_THUMB_INDEX);
        inputRef.current?.focus();
    }, [state]);

    const startThumbDrag = useCallback(() => {
        focusThumb();
        state.setThumbDragging(SLIDER_THUMB_INDEX, true);
    }, [focusThumb, state]);

    const endThumbDrag = useCallback(() => {
        state.setThumbDragging(SLIDER_THUMB_INDEX, false);
    }, [state]);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
        if (isDisabled || !event.shiftKey) {
            return;
        }

        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
            event.preventDefault();
            onChangeDegrees(angle.degrees + SHIFT_KEY_STEP_DEGREES, 'keyboard', true);
        }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
            event.preventDefault();
            onChangeDegrees(angle.degrees - SHIFT_KEY_STEP_DEGREES, 'keyboard', true);
        }
    }, [angle.degrees, isDisabled, onChangeDegrees]);

    const inputProps = mergeProps(sliderInputProps, {
        'aria-valuetext': formatAriaValue(angle.value, precision),
        onKeyDown: handleKeyDown,
    }) as InputHTMLAttributes<HTMLInputElement>;

    return {
        groupProps,
        inputProps,
        inputRef,
        isDragging,
        isFocused,
        focusThumb,
        startThumbDrag,
        endThumbDrag,
    };
}
