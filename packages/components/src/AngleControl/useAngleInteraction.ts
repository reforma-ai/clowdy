import { useCallback, useRef, useState } from 'react';
import { useMove } from 'react-aria';

import { applyPresetDegrees, getAngleFromPoint, shortestAngleDelta, snapDegreesToPresets } from './angle';

import type { AngleChangeSource, AnglePoint, AnglePresetBehavior, AngleValueRange } from './angle';

interface AngleDragState {
    lastDegrees: number;
    lastNormalizedDegrees: number;
    lastOutputDegrees: number;
    point: AnglePoint;
    moved: boolean;
}

interface UseAngleInteractionOptions {
    center: AnglePoint;
    handlePoint: AnglePoint;
    degrees: number;
    normalizedDegrees: number;
    presets: readonly number[];
    snap: boolean;
    snapThresholdDeg: number;
    valueRange: AngleValueRange;
    presetBehavior: AnglePresetBehavior;
    isDisabled: boolean | undefined;
    onChangeDegrees: (degrees: number, source: AngleChangeSource, committed: boolean) => void;
    onDragStart?: () => void;
    onDragEnd?: () => void;
}

export function useAngleInteraction({
    center,
    handlePoint,
    degrees,
    normalizedDegrees,
    presets,
    snap,
    snapThresholdDeg,
    valueRange,
    presetBehavior,
    isDisabled,
    onChangeDegrees,
    onDragStart,
    onDragEnd,
}: UseAngleInteractionOptions) {
    const dragStateRef = useRef<AngleDragState | null>(null);
    const [isDragging, setIsDragging] = useState(false);

    const applyPreset = useCallback(
        (preset: number) => {
            if (isDisabled) {
                return;
            }

            onChangeDegrees(applyPresetDegrees(degrees, preset, valueRange, presetBehavior), 'preset', true);
        },
        [degrees, isDisabled, onChangeDegrees, presetBehavior, valueRange]
    );

    const updateDrag = useCallback(
        (deltaX: number, deltaY: number, shiftKey: boolean) => {
            const dragState = dragStateRef.current;

            if (!dragState) {
                return;
            }

            dragState.point = {
                x: dragState.point.x + deltaX,
                y: dragState.point.y + deltaY,
            };

            const pointerAngle = getAngleFromPoint(dragState.point, center);
            const delta = shortestAngleDelta(dragState.lastNormalizedDegrees, pointerAngle);
            const rawDegrees = dragState.lastDegrees + delta;
            const shouldSnap = snap || shiftKey;
            const nextDegrees = shouldSnap ? snapDegreesToPresets(rawDegrees, presets, snapThresholdDeg) : rawDegrees;

            dragState.lastDegrees = rawDegrees;
            dragState.lastNormalizedDegrees = pointerAngle;
            dragState.lastOutputDegrees = nextDegrees;
            dragState.moved ||= Math.abs(delta) > 0.1;
            setIsDragging(dragState.moved);
            onChangeDegrees(nextDegrees, 'drag', false);
        },
        [center, onChangeDegrees, presets, snap, snapThresholdDeg]
    );

    const { moveProps } = useMove({
        onMoveStart: () => {
            setIsDragging(false);
            onDragStart?.();
            dragStateRef.current = {
                lastDegrees: degrees,
                lastNormalizedDegrees: normalizedDegrees,
                lastOutputDegrees: degrees,
                point: handlePoint,
                moved: false,
            };
        },
        onMove: event => updateDrag(event.deltaX, event.deltaY, event.shiftKey),
        onMoveEnd: () => {
            const dragState = dragStateRef.current;

            if (dragState?.moved) {
                onChangeDegrees(dragState.lastOutputDegrees, 'drag', true);
            }

            dragStateRef.current = null;
            onDragEnd?.();
            setIsDragging(false);
        },
    });

    return {
        isDragging,
        applyPreset,
        handleInteractionProps: isDisabled ? {} : moveProps,
    };
}
