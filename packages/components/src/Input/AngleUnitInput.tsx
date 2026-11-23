import { isAngleUnit, parseAngleValue } from '@clowdy/lib';
import { useCallback, useMemo, useState } from 'react';

import { AngleControl, toDegrees } from '../AngleControl';
import { Box } from '../Box';
import { UnitInput } from './UnitInput';

import type { ReactNode } from 'react';
import type {
    AngleControlSize,
    AnglePrecision,
    AnglePresetBehavior,
    AngleUnit,
    AngleValue,
    AngleValueRange,
} from '../AngleControl';
import type { ConversionRates, UnitInputValue } from './UnitInput';

const DEFAULT_ANGLE_VALUE: AngleValue = { value: 0, unit: 'deg' };
const DEFAULT_ANGLE_UNITS: readonly AngleUnit[] = ['deg', 'grad', 'rad', 'turn'];
const ANGLE_CONVERSION_RATES = {
    deg: 1,
    grad: 0.9,
    rad: 180 / Math.PI,
    turn: 360,
} as const satisfies ConversionRates;

interface AngleInputState {
    angle: AngleValue;
    externalAngle: AngleValue;
    hasValue: boolean;
}

export interface AngleUnitInputProps {
    value?: AngleValue | null;
    fallbackValue?: AngleValue;
    placeholder?: string;
    placeholderUnit?: AngleUnit;
    units?: readonly AngleUnit[];
    min?: number;
    max?: number;
    angleMin?: number;
    angleMax?: number;
    step?: number;
    precision?: AnglePrecision;
    valueRange?: AngleValueRange;
    presetBehavior?: AnglePresetBehavior;
    size?: AngleControlSize;
    isActive?: boolean;
    ariaLabel?: string;
    angleAriaLabel?: string;
    /** Content positioned against the numeric input, before the angle control. */
    inputOverlay?: ReactNode;
    onApply?: (value: AngleValue) => void;
    onCommit?: (value: AngleValue) => boolean | void;
    onClear?: () => void;
}

export function AngleUnitInput({
    value,
    fallbackValue,
    placeholder,
    placeholderUnit,
    units = DEFAULT_ANGLE_UNITS,
    min,
    max,
    angleMin,
    angleMax,
    step,
    precision,
    valueRange = 'signed',
    presetBehavior,
    size = 'sm',
    isActive,
    ariaLabel = 'Angle value',
    angleAriaLabel = 'Angle',
    inputOverlay,
    onApply,
    onCommit,
    onClear,
}: AngleUnitInputProps) {
    const fallbackAngle = useMemo(
        () => fallbackValue ?? angleFromPlaceholder(placeholder, placeholderUnit),
        [fallbackValue, placeholder, placeholderUnit]
    );
    const hasValue = value != null;
    const externalAngle = value ?? fallbackAngle;
    const [state, setState] = useState<AngleInputState>(() => ({
        angle: externalAngle,
        externalAngle,
        hasValue,
    }));
    const externalChanged = state.hasValue !== hasValue || !isSameAngle(state.externalAngle, externalAngle);

    if (externalChanged) {
        setState({ angle: externalAngle, externalAngle, hasValue });
    }

    const angle = externalChanged ? externalAngle : state.angle;
    const setAngle = useCallback(
        (nextAngle: AngleValue) => {
            setState({ angle: nextAngle, externalAngle, hasValue });
        },
        [externalAngle, hasValue]
    );

    const handleInputApply = useCallback(
        (nextValue: UnitInputValue) => {
            const nextAngle = unitInputToAngleValue(nextValue);

            if (nextAngle) {
                setAngle(nextAngle);
                onApply?.(nextAngle);
            }
        },
        [onApply, setAngle]
    );

    const handleInputCommit = useCallback(
        (nextValue: UnitInputValue) => {
            const nextAngle = unitInputToAngleValue(nextValue);

            if (!nextAngle) {
                return false;
            }

            setAngle(nextAngle);

            return onCommit?.(nextAngle);
        },
        [onCommit, setAngle]
    );

    const handleClear = useCallback(() => {
        setAngle(fallbackAngle);
        onClear?.();
    }, [fallbackAngle, onClear, setAngle]);

    const handleAngleApply = useCallback(
        (nextValue: AngleValue) => {
            setAngle(nextValue);
            onApply?.(nextValue);
        },
        [onApply, setAngle]
    );

    const handleAngleCommit = useCallback(
        (nextValue: AngleValue) => {
            setAngle(nextValue);
            onCommit?.(nextValue);
        },
        [onCommit, setAngle]
    );

    return (
        <Box direction="row" align="center" gap="xs" fullWidth>
            <Box grow style={{ position: 'relative' }}>
                <UnitInput
                    size={size}
                    aria-label={placeholder ? undefined : ariaLabel}
                    value={hasValue ? angleToUnitInput(angle) : null}
                    placeholder={placeholder}
                    placeholderUnit={placeholderUnit ?? fallbackAngle.unit}
                    units={units}
                    min={min}
                    max={max}
                    step={step}
                    conversionRates={ANGLE_CONVERSION_RATES}
                    isActive={isActive}
                    onApply={handleInputApply}
                    onCommit={handleInputCommit}
                    onClear={handleClear}
                />
                {inputOverlay}
            </Box>

            <AngleControl
                value={angle}
                unit={angle.unit}
                size={size}
                min={angleMin}
                max={angleMax}
                step={step}
                precision={precision}
                valueRange={valueRange}
                presetBehavior={presetBehavior}
                ariaLabel={angleAriaLabel}
                onChange={handleAngleApply}
                onChangeEnd={handleAngleCommit}
            />
        </Box>
    );
}

function unitInputToAngleValue(value: UnitInputValue | null): AngleValue | null {
    if (value?.type !== 'unit' || !isAngleUnit(value.unit)) {
        return null;
    }

    return { value: value.value, unit: value.unit };
}

function angleToUnitInput(value: AngleValue): UnitInputValue {
    return {
        type: 'unit',
        value: value.value,
        unit: value.unit,
    };
}

function angleFromPlaceholder(placeholder: string | undefined, placeholderUnit: AngleUnit | undefined): AngleValue {
    const fallbackUnit = placeholderUnit ?? DEFAULT_ANGLE_VALUE.unit;

    return parseAngleValue(placeholder ?? '', fallbackUnit) ?? { ...DEFAULT_ANGLE_VALUE, unit: fallbackUnit };
}

function isSameAngle(first: AngleValue, second: AngleValue): boolean {
    return Math.abs(toDegrees(first) - toDegrees(second)) < 0.0001;
}

AngleUnitInput.displayName = 'AngleUnitInput';
