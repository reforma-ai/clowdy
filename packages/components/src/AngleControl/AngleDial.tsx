import { cn, mergeRefs } from '@clowdy/lib';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Show } from '../Show';
import {
    ANGLE_RING_WIDTH,
    clampAngle,
    DEFAULT_ANGLE_PRESETS,
    getAngleDialGeometry,
    getPointOnCircle,
} from './angle';
import styles from './AngleControl.module.css';
import { AngleDraftInput } from './AngleDraftInput';
import { AnglePresets } from './AnglePresets';
import { useAngleInteraction } from './useAngleInteraction';
import { useAngleSlider } from './useAngleSlider';

import type { CSSProperties, Ref } from 'react';
import type { AnglePrecision, AnglePresetBehavior, AngleValueRange } from './angle';
import type { AngleState } from './useAngleState';

export interface AngleDialProps {
    ref?: Ref<HTMLDivElement | null>;
    angle: AngleState;
    presets?: readonly number[];
    snap?: boolean;
    snapThresholdDeg?: number;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    step?: number;
    precision?: AnglePrecision;
    valueRange?: AngleValueRange;
    presetBehavior?: AnglePresetBehavior;
    controlSize?: number;
    showInlineInput?: boolean;
    className?: string;
    ariaLabel?: string;
    ariaLabelledBy?: string;
    autoFocus?: boolean;
}

export function AngleDial({
    ref,
    angle,
    presets = DEFAULT_ANGLE_PRESETS,
    snap = false,
    snapThresholdDeg = 4,
    isDisabled,
    isReadOnly,
    step,
    precision,
    valueRange = 'unbounded',
    presetBehavior = 'canonical',
    controlSize,
    showInlineInput = true,
    className,
    ariaLabel = 'Angle',
    ariaLabelledBy,
    autoFocus,
}: AngleDialProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const hasAutofocusedRef = useRef(false);
    const presetPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [presetPreviewValue, setPresetPreviewValue] = useState<string | null>(null);
    const geometry = useMemo(() => getAngleDialGeometry(controlSize), [controlSize]);
    const center = useMemo(() => ({
        x: geometry.controlSize / 2,
        y: geometry.controlSize / 2,
    }), [geometry.controlSize]);
    const isInactive = isDisabled || isReadOnly;
    const handlePoint = getPointOnCircle(angle.normalizedDegrees, geometry.handleRadius, center);
    const styleVars = {
        '--clowdy-angle-handle-size': `${ geometry.handleSize }px`,
        '--clowdy-angle-ring-width': `${ ANGLE_RING_WIDTH }px`,
        '--clowdy-angle-size': `${ geometry.controlSize }px`,
    } as CSSProperties;

    const updateDegrees = useCallback((nextDegrees: number, source: Parameters<typeof angle.setDegrees>[1], committed: boolean) => {
        angle.setDegrees(clampAngle(nextDegrees, angle.minDegrees, angle.maxDegrees), source, committed);
    }, [angle]);

    const clearPresetPreviewTimer = useCallback(() => {
        if (presetPreviewTimerRef.current) {
            clearTimeout(presetPreviewTimerRef.current);
            presetPreviewTimerRef.current = null;
        }
    }, []);

    const clearPresetPreview = useCallback(() => {
        clearPresetPreviewTimer();
        setPresetPreviewValue(null);
    }, [clearPresetPreviewTimer]);

    const updatePresetPreview = useCallback((nextValue: string | null) => {
        clearPresetPreviewTimer();

        presetPreviewTimerRef.current = setTimeout(() => {
            setPresetPreviewValue(nextValue);
            presetPreviewTimerRef.current = null;
        }, nextValue == null ? 120 : 70);
    }, [clearPresetPreviewTimer]);

    const {
        groupProps,
        inputProps: sliderInputProps,
        inputRef: sliderInputRef,
        isDragging: isSliderDragging,
        isFocused: isSliderFocused,
        focusThumb,
        startThumbDrag,
        endThumbDrag,
    } = useAngleSlider({
        rootRef,
        angle,
        step,
        precision,
        valueRange,
        isDisabled: isInactive,
        ariaLabel,
        ariaLabelledBy,
        onChangeDegrees: updateDegrees,
    });

    const {
        isDragging,
        applyPreset,
        handleInteractionProps,
    } = useAngleInteraction({
        center,
        handlePoint,
        degrees: angle.degrees,
        normalizedDegrees: angle.normalizedDegrees,
        presets,
        snap,
        snapThresholdDeg,
        valueRange,
        presetBehavior,
        isDisabled: isInactive,
        onChangeDegrees: updateDegrees,
        onDragStart: startThumbDrag,
        onDragEnd: endThumbDrag,
    });

    useEffect(() => {
        if (!autoFocus || hasAutofocusedRef.current) {
            return;
        }

        hasAutofocusedRef.current = true;
        const frame = requestAnimationFrame(focusThumb);

        return () => cancelAnimationFrame(frame);
    }, [autoFocus, focusThumb]);

    const isHandleActive = isDragging || isSliderDragging;

    useEffect(() => () => clearPresetPreviewTimer(), [clearPresetPreviewTimer]);

    useEffect(() => {
        if (isHandleActive || isInactive) {
            clearPresetPreview();
        }
    }, [clearPresetPreview, isHandleActive, isInactive]);

    return (
        <div
            { ...groupProps }
            ref={ mergeRefs(rootRef, ref) }
            className={ cn(styles.dial, className) }
            style={ styleVars }
            data-disabled={ isDisabled || undefined }
            data-readonly={ isReadOnly || undefined }
            data-dragging={ isHandleActive || undefined }
            data-thumb-focused={ isSliderFocused || undefined }
            aria-disabled={ isInactive || undefined }
        >
            <input
                { ...sliderInputProps }
                ref={ sliderInputRef }
                className={ styles.sliderInput }
            />

            <div className={ styles.ring } aria-hidden="true" />

            <AnglePresets
                presets={ presets }
                center={ center }
                radius={ geometry.presetRadius }
                currentDegrees={ angle.degrees }
                unit={ angle.unit }
                minDegrees={ angle.minDegrees }
                maxDegrees={ angle.maxDegrees }
                precision={ precision }
                valueRange={ valueRange }
                presetBehavior={ presetBehavior }
                isDragging={ isHandleActive }
                isDisabled={ isInactive }
                onPreviewChange={ updatePresetPreview }
                onSelect={ (preset) => {
                    clearPresetPreview();
                    applyPreset(preset);
                } }
            />

            <Show when={ showInlineInput }>
                <AngleDraftInput
                    angle={ angle }
                    precision={ precision }
                    previewValue={ presetPreviewValue }
                    isDisabled={ isDisabled }
                    isReadOnly={ isReadOnly }
                    onCancel={ focusThumb }
                />
            </Show>

            <div
                className={ styles.handle }
                data-angle-handle
                style={ {
                    left: handlePoint.x,
                    top: handlePoint.y,
                } }
                { ...handleInteractionProps }
            />
        </div>
    );
}

AngleDial.displayName = 'AngleDial';
