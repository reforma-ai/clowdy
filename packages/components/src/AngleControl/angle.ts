import { angleFromDegrees, angleToDegrees, clamp, isAngleUnit, parseAngleValue, UNIT_PRECISION } from '@clowdy/lib';

import type { AngleUnit, AngleUnitValue } from '@clowdy/lib';
import type { CSSProperties, Ref } from 'react';

export type { AngleUnit } from '@clowdy/lib';

export type AngleString = `${number}${AngleUnit}`;

export interface AngleValue extends AngleUnitValue {}

export type AngleChangeSource = 'drag' | 'preset' | 'input' | 'keyboard';

export interface AngleChangeMeta {
    source: AngleChangeSource;
    degrees: number;
    normalizedDegrees: number;
    unit: AngleUnit;
    committed: boolean;
}

export type AngleControlSize = 'sm' | 'md' | 'lg';

export type AnglePrecision = number | Partial<Record<AngleUnit, number>>;
export type AngleValueRange = 'unbounded' | 'positive' | 'signed';
export type AnglePresetBehavior = 'canonical' | 'preserve-revolution';

export interface AngleControlProps {
    ref?: Ref<HTMLButtonElement | null>;
    value?: AngleValue;
    defaultValue?: AngleValue;
    onChange?: (value: AngleValue, meta: AngleChangeMeta) => void;
    onChangeEnd?: (value: AngleValue, meta: AngleChangeMeta) => void;
    unit?: AngleUnit;
    presets?: readonly number[];
    snap?: boolean;
    snapThresholdDeg?: number;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    min?: number;
    max?: number;
    step?: number;
    precision?: AnglePrecision;
    valueRange?: AngleValueRange;
    presetBehavior?: AnglePresetBehavior;
    size?: AngleControlSize;
    expandedSize?: number;
    showInlineInput?: boolean;
    className?: string;
    popoverClassName?: string;
    style?: CSSProperties;
    isOpen?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (isOpen: boolean) => void;
    ariaLabel?: string;
    ariaLabelledBy?: string;
}

export interface AnglePoint {
    x: number;
    y: number;
}

export interface AngleDialGeometry {
    controlSize: number;
    handleRadius: number;
    handleSize: number;
    presetRadius: number;
}

export interface AngleGeometryOptions {
    /**
     * 0deg is at 12 o'clock,
     * positive values rotate clockwise.
     */
    zero?: 'top' | 'right';
    direction?: 'clockwise' | 'counterclockwise';
}

export const DEFAULT_ANGLE_PRECISION: Record<AngleUnit, number> = {
    deg: UNIT_PRECISION.deg ?? 0,
    grad: UNIT_PRECISION.grad ?? 2,
    rad: UNIT_PRECISION.rad ?? 3,
    turn: UNIT_PRECISION.turn ?? 3,
};

export const DEFAULT_ANGLE_PRESETS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export const DEFAULT_ANGLE_EXPANDED_SIZE = 72;
export const ANGLE_RING_WIDTH = 2;
const RADIAN_PI_DENOMINATORS = [1, 2, 3, 4, 6, 8, 12] as const;
const PI_FRACTION_TOLERANCE_RADIANS = 0.001;
const PI_COEFFICIENT_PRECISION = 2;

export const ANGLE_PREVIEW_GEOMETRY: Record<
    AngleControlSize,
    {
        size: number;
        handleRadius: number;
        handleSize: number;
    }
> = {
    sm: { size: 30, handleRadius: 9 - ANGLE_RING_WIDTH, handleSize: 6 },
    md: { size: 36, handleRadius: 11 - ANGLE_RING_WIDTH, handleSize: 8 },
    lg: { size: 56, handleRadius: 18 - ANGLE_RING_WIDTH, handleSize: 10 },
};

export { isAngleUnit };

export const parseAngle = parseAngleValue;

export function toDegrees(value: AngleValue): number {
    return angleToDegrees(value);
}

export function fromDegrees(degrees: number, unit: AngleUnit): AngleValue {
    return angleFromDegrees(degrees, unit);
}

export function normalizeDegrees(degrees: number): number {
    return ((degrees % 360) + 360) % 360;
}

export function normalizeSignedDegrees(degrees: number): number {
    const normalized = normalizeDegrees(degrees);

    return normalized > 180 ? normalized - 360 : normalized;
}

export function applyAngleValueRange(degrees: number, range: AngleValueRange = 'unbounded'): number {
    if (range === 'positive') {
        return normalizeDegrees(degrees);
    }

    if (range === 'signed') {
        return normalizeSignedDegrees(degrees);
    }

    return degrees;
}

export function getAnglePrecision(unit: AngleUnit, precision?: AnglePrecision): number {
    const value = typeof precision === 'number' ? precision : (precision?.[unit] ?? DEFAULT_ANGLE_PRECISION[unit]);

    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_ANGLE_PRECISION[unit];
}

export function roundAngleNumber(value: number, precision: number): number {
    if (!Number.isFinite(value)) {
        return value;
    }

    const factor = 10 ** precision;
    const rounded = Math.round((value + Number.EPSILON) * factor) / factor;

    return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundAngleValue(value: AngleValue, precision?: AnglePrecision): AngleValue {
    return {
        value: roundAngleNumber(value.value, getAnglePrecision(value.unit, precision)),
        unit: value.unit,
    };
}

export function roundAngleValueInRange(
    value: AngleValue,
    precision?: AnglePrecision,
    min?: number,
    max?: number
): AngleValue {
    const rounded = roundAngleValue(value, precision);

    return {
        value: clamp(min ?? -Infinity, rounded.value, max ?? Infinity),
        unit: rounded.unit,
    };
}

export function formatAngle(
    value: AngleValue,
    options: {
        precision?: AnglePrecision;
        trimTrailingZeros?: boolean;
    } = {}
): string {
    const precision = getAnglePrecision(value.unit, options.precision);
    const trimTrailingZeros = options.trimTrailingZeros ?? true;
    const fixed = roundAngleValue(value, precision).value.toFixed(precision);
    const formatted = trimTrailingZeros ? fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : fixed;

    return `${formatted === '-0' ? '0' : formatted}${value.unit}`;
}

export function formatAngleNumber(value: AngleValue, options?: Parameters<typeof formatAngle>[1]): string {
    return formatAngle(value, options).slice(0, -value.unit.length);
}

function gcd(a: number, b: number): number {
    let left = Math.abs(a);
    let right = Math.abs(b);

    while (right !== 0) {
        const next = left % right;

        left = right;
        right = next;
    }

    return left || 1;
}

function formatPiRadianNumber(value: number): string | null {
    let bestNumerator = 0;
    let bestDenominator = 1;
    let bestDistance = Infinity;

    for (const denominator of RADIAN_PI_DENOMINATORS) {
        const numerator = Math.round((value / Math.PI) * denominator);
        const candidate = (numerator / denominator) * Math.PI;
        const distance = Math.abs(candidate - value);

        if (distance < bestDistance) {
            bestNumerator = numerator;
            bestDenominator = denominator;
            bestDistance = distance;
        }
    }

    if (bestDistance > PI_FRACTION_TOLERANCE_RADIANS) {
        return null;
    }

    if (bestNumerator === 0) {
        return '0';
    }

    const divisor = gcd(bestNumerator, bestDenominator);
    const numerator = bestNumerator / divisor;
    const denominator = bestDenominator / divisor;
    const sign = numerator < 0 ? '-' : '';
    const absoluteNumerator = Math.abs(numerator);
    const piPart = absoluteNumerator === 1 ? 'π' : `${absoluteNumerator}π`;

    return denominator === 1 ? `${sign}${piPart}` : `${sign}${piPart}/${denominator}`;
}

function formatPiCoefficientRadianNumber(value: number, precision?: AnglePrecision): string {
    const coefficientPrecision =
        typeof precision === 'number' ? precision : (precision?.rad ?? PI_COEFFICIENT_PRECISION);
    const coefficient = roundAngleNumber(value / Math.PI, coefficientPrecision);

    if (coefficient === 0) {
        return '0';
    }

    if (coefficient === 1) {
        return 'π';
    }

    if (coefficient === -1) {
        return '-π';
    }

    const formatted = coefficient
        .toFixed(coefficientPrecision)
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, '');

    return `${formatted}π`;
}

export function formatAngleDisplayNumber(value: AngleValue, options?: Parameters<typeof formatAngle>[1]): string {
    if (value.unit === 'rad') {
        return formatPiRadianNumber(value.value) ?? formatPiCoefficientRadianNumber(value.value, options?.precision);
    }

    return formatAngleNumber(value, options);
}

export function formatAngleDisplay(value: AngleValue, options?: Parameters<typeof formatAngle>[1]): string {
    return `${formatAngleDisplayNumber(value, options)}${value.unit}`;
}

export function angleDistance(leftDeg: number, rightDeg: number): number {
    const diff = Math.abs(normalizeDegrees(leftDeg) - normalizeDegrees(rightDeg));

    return Math.min(diff, 360 - diff);
}

export function getAngleFromPoint(point: AnglePoint, center: AnglePoint, options: AngleGeometryOptions = {}): number {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const zero = options.zero ?? 'top';
    const direction = options.direction ?? 'clockwise';
    const rawDeg = zero === 'top' ? Math.atan2(dx, -dy) * (180 / Math.PI) : Math.atan2(dy, dx) * (180 / Math.PI);

    return normalizeDegrees(direction === 'clockwise' ? rawDeg : -rawDeg);
}

export function getPointOnCircle(
    angleDeg: number,
    radius: number,
    center: AnglePoint,
    options: AngleGeometryOptions = {}
): AnglePoint {
    const zero = options.zero ?? 'top';
    const direction = options.direction ?? 'clockwise';
    const directedDeg = direction === 'clockwise' ? angleDeg : -angleDeg;
    const radians = directedDeg * (Math.PI / 180);

    if (zero === 'right') {
        return {
            x: center.x + Math.cos(radians) * radius,
            y: center.y + Math.sin(radians) * radius,
        };
    }

    return {
        x: center.x + Math.sin(radians) * radius,
        y: center.y - Math.cos(radians) * radius,
    };
}

export function getAngleDialGeometry(controlSize = DEFAULT_ANGLE_EXPANDED_SIZE): AngleDialGeometry {
    return {
        controlSize,
        handleRadius: controlSize * 0.375 - ANGLE_RING_WIDTH,
        handleSize: Math.max(10, controlSize * 0.125),
        presetRadius: controlSize * 0.4 - ANGLE_RING_WIDTH,
    };
}

export function getPresetForAngle(angleDeg: number, presets: readonly number[] = DEFAULT_ANGLE_PRESETS): number {
    let closestPreset = presets[0] ?? 0;
    let closestDistance = Infinity;

    for (const preset of presets) {
        const distance = angleDistance(angleDeg, preset);

        if (distance < closestDistance) {
            closestPreset = preset;
            closestDistance = distance;
        }
    }

    return normalizeDegrees(closestPreset);
}

/**
 * Presets stay near the current revolution instead of collapsing values to 0..360.
 * For negative values, the closest candidate is less surprising than raw floor/trunc.
 */
export function applyPresetKeepingRevolution(currentDeg: number, presetDeg: number): number {
    const normalizedPreset = normalizeDegrees(presetDeg);
    const base = Math.trunc(currentDeg / 360) * 360;
    const candidates = [base - 360 + normalizedPreset, base + normalizedPreset, base + 360 + normalizedPreset];

    return candidates.reduce((best, candidate) => {
        const bestDistance = Math.abs(best - currentDeg);
        const candidateDistance = Math.abs(candidate - currentDeg);

        if (candidateDistance < bestDistance) {
            return candidate;
        }

        if (candidateDistance === bestDistance && candidate > best) {
            return candidate;
        }

        return best;
    });
}

export function applyPresetDegrees(
    currentDeg: number,
    presetDeg: number,
    range: AngleValueRange = 'unbounded',
    behavior: AnglePresetBehavior = 'canonical'
): number {
    if (behavior === 'preserve-revolution') {
        return applyAngleValueRange(applyPresetKeepingRevolution(currentDeg, presetDeg), range);
    }

    return applyAngleValueRange(presetDeg, range === 'unbounded' ? 'positive' : range);
}

export function clampAngle(deg: number, minDeg?: number, maxDeg?: number): number {
    return clamp(minDeg ?? -Infinity, deg, maxDeg ?? Infinity);
}

export function snapDegreesToPresets(
    degrees: number,
    presets: readonly number[] = DEFAULT_ANGLE_PRESETS,
    thresholdDeg = 4
): number {
    const preset = getPresetForAngle(degrees, presets);
    const snapped = applyPresetKeepingRevolution(degrees, preset);

    return Math.abs(snapped - degrees) <= thresholdDeg ? snapped : degrees;
}

export function shortestAngleDelta(fromDeg: number, toDeg: number): number {
    let delta = normalizeDegrees(toDeg) - normalizeDegrees(fromDeg);

    if (delta > 180) {
        delta -= 360;
    } else if (delta < -180) {
        delta += 360;
    }

    return delta;
}
