import { useCallback, useMemo, useState } from 'react';

import {
    applyAngleValueRange,
    clampAngle,
    fromDegrees,
    normalizeDegrees,
    roundAngleValueInRange,
    toDegrees,
    type AngleChangeMeta,
    type AngleChangeSource,
    type AnglePrecision,
    type AngleUnit,
    type AngleValue,
    type AngleValueRange,
} from './angle';

interface UseAngleStateOptions {
    value?: AngleValue;
    defaultValue?: AngleValue;
    unit?: AngleUnit;
    min?: number;
    max?: number;
    precision?: AnglePrecision;
    valueRange?: AngleValueRange;
    onChange?: (value: AngleValue, meta: AngleChangeMeta) => void;
    onChangeEnd?: (value: AngleValue, meta: AngleChangeMeta) => void;
}

export interface AngleState {
    value: AngleValue;
    unit: AngleUnit;
    degrees: number;
    normalizedDegrees: number;
    minDegrees: number | undefined;
    maxDegrees: number | undefined;
    setDegrees: (degrees: number, source: AngleChangeSource, committed: boolean) => AngleValue;
    setValue: (value: AngleValue, source: AngleChangeSource, committed: boolean) => AngleValue;
}

const FALLBACK_VALUE: AngleValue = { value: 0, unit: 'deg' };

export function useAngleState({
    value: controlledValue,
    defaultValue,
    unit: unitProp,
    min,
    max,
    precision,
    valueRange = 'unbounded',
    onChange,
    onChangeEnd,
}: UseAngleStateOptions): AngleState {
    const [uncontrolledValue, setUncontrolledValue] = useState<AngleValue>(
        defaultValue ?? { ...FALLBACK_VALUE, unit: unitProp ?? FALLBACK_VALUE.unit }
    );

    const isControlled = controlledValue !== undefined;
    const rawValue = controlledValue ?? uncontrolledValue;
    const unit = unitProp ?? rawValue.unit;
    const minDegrees = min == null ? undefined : toDegrees({ value: min, unit });
    const maxDegrees = max == null ? undefined : toDegrees({ value: max, unit });
    const rawDegrees = clampAngle(applyAngleValueRange(toDegrees(rawValue), valueRange), minDegrees, maxDegrees);
    const value = useMemo(() => (
        roundAngleValueInRange(fromDegrees(rawDegrees, unit), precision, min, max)
    ), [max, min, precision, rawDegrees, unit]);
    const degrees = toDegrees(value);

    const emitValue = useCallback((nextValue: AngleValue, source: AngleChangeSource, committed: boolean): AngleValue => {
        const outputUnit = unitProp ?? nextValue.unit;
        const nextDegrees = clampAngle(applyAngleValueRange(toDegrees(nextValue), valueRange), minDegrees, maxDegrees);
        const outputValue = roundAngleValueInRange(fromDegrees(nextDegrees, outputUnit), precision, min, max);
        const outputDegrees = toDegrees(outputValue);
        const meta: AngleChangeMeta = {
            source,
            degrees: outputDegrees,
            normalizedDegrees: normalizeDegrees(outputDegrees),
            unit: outputUnit,
            committed,
        };

        if (!isControlled) {
            setUncontrolledValue(outputValue);
        }

        onChange?.(outputValue, meta);

        if (committed) {
            onChangeEnd?.(outputValue, meta);
        }

        return outputValue;
    }, [isControlled, max, maxDegrees, min, minDegrees, onChange, onChangeEnd, precision, unitProp, valueRange]);

    const setDegrees = useCallback((nextDegrees: number, source: AngleChangeSource, committed: boolean): AngleValue => (
        emitValue(fromDegrees(nextDegrees, unit), source, committed)
    ), [emitValue, unit]);

    return {
        value,
        unit,
        degrees,
        normalizedDegrees: normalizeDegrees(degrees),
        minDegrees,
        maxDegrees,
        setDegrees,
        setValue: emitValue,
    };
}
