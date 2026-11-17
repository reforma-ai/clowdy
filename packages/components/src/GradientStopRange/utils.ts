import { clamp } from '@clowdy/lib';

export interface GradientStopRangeBounds {
    min: number;
    max: number;
}

export interface GradientStopRangeStepOptions extends GradientStopRangeBounds {
    step: number;
    shiftStep: number;
}

const STOP_HIT_TOLERANCE = 0.015;

interface GradientStopRangePosition {
    position: number;
}

interface GradientStopRangeColorStop extends GradientStopRangePosition {
    color: string;
}

export function sortedGradientStops<T extends GradientStopRangePosition>(stops: readonly T[]): T[] {
    return [...stops].sort((first, second) => first.position - second.position);
}

export function visibleGradientStops<T extends GradientStopRangePosition>(
    stops: readonly T[],
    bounds: GradientStopRangeBounds
): T[] {
    return sortedGradientStops(stops).filter(stop => (
        Number.isFinite(stop.position)
        && stop.position >= bounds.min
        && stop.position <= bounds.max
    ));
}

export function gradientStopRangeBackground(
    stops: readonly GradientStopRangeColorStop[],
    bounds: GradientStopRangeBounds
): string {
    const sorted = sortedGradientStops(stops).filter(stop => Number.isFinite(stop.position) && stop.color.trim());

    if (sorted.length === 0) {
        return 'linear-gradient(to right, var(--color-secondary), var(--color-secondary))';
    }

    if (sorted.length === 1) {
        return `linear-gradient(to right, ${ sorted[0].color } 0%, ${ sorted[0].color } 100%)`;
    }

    const colorStops = sorted
        .map(stop => `${ stop.color } ${ formatGradientStopTrackPosition(stop.position, bounds) }`)
        .join(', ');

    return `linear-gradient(to right, ${ colorStops })`;
}

export function formatGradientStopTrackPosition(position: number, bounds: GradientStopRangeBounds): string {
    if (bounds.max === bounds.min) {
        return '0%';
    }

    return `${ ((position - bounds.min) / (bounds.max - bounds.min)) * 100 }%`;
}

export function formatGradientStopPercent(position: number): string {
    return `${ Math.round(position * 1000) / 10 }%`;
}

export function hasGradientStopNearPosition(stops: readonly GradientStopRangePosition[], position: number): boolean {
    return stops.some(stop => Math.abs(stop.position - position) < STOP_HIT_TOLERANCE);
}

export function positionFromTrackOffset(
    offset: number,
    trackSize: number,
    bounds: GradientStopRangeBounds
): number {
    if (trackSize <= 0) {
        return bounds.min;
    }

    const ratio = offset / trackSize;
    const position = bounds.min + (ratio * (bounds.max - bounds.min));

    return clamp(bounds.min, position, bounds.max);
}

export function positionFromMoveDelta(
    position: number,
    delta: number,
    trackSize: number,
    bounds: GradientStopRangeBounds
): number {
    if (trackSize <= 0) {
        return position;
    }

    const deltaPosition = (delta / trackSize) * (bounds.max - bounds.min);

    return clamp(bounds.min, position + deltaPosition, bounds.max);
}

export function positionFromKeyboardMove(
    position: number,
    deltaX: number,
    deltaY: number,
    options: GradientStopRangeStepOptions,
    isShiftKey: boolean
): number {
    const step = isShiftKey ? options.shiftStep : options.step;
    const isBackwardMove = deltaX < 0 || deltaY > 0;
    const direction = isBackwardMove ? -1 : 1;

    return clamp(options.min, position + (direction * step), options.max);
}

export function positionFromKeyboardCommand(
    key: string,
    position: number,
    options: GradientStopRangeStepOptions
): number | null {
    if (key === 'Home') {
        return options.min;
    }

    if (key === 'End') {
        return options.max;
    }

    if (key === 'PageDown') {
        return clamp(options.min, position - options.shiftStep, options.max);
    }

    if (key === 'PageUp') {
        return clamp(options.min, position + options.shiftStep, options.max);
    }

    return null;
}
