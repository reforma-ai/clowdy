import { useEffect, useMemo } from 'react';

import { For } from '../For';
import styles from './AngleControl.module.css';
import {
    applyPresetDegrees,
    clampAngle,
    formatAngleDisplay,
    formatAngleDisplayNumber,
    fromDegrees,
    getPointOnCircle,
} from './angle';

import type { AnglePoint, AnglePrecision, AnglePresetBehavior, AngleUnit, AngleValueRange } from './angle';

interface AnglePresetItem {
    value: number;
    point: AnglePoint;
    label: string;
    previewValue: string;
}

interface AnglePresetsProps {
    presets: readonly number[];
    center: AnglePoint;
    radius: number;
    currentDegrees: number;
    unit: AngleUnit;
    minDegrees?: number;
    maxDegrees?: number;
    precision?: AnglePrecision;
    valueRange: AngleValueRange;
    presetBehavior: AnglePresetBehavior;
    isDragging?: boolean;
    isDisabled?: boolean;
    onPreviewChange?: (value: string | null) => void;
    onSelect: (preset: number) => void;
}

export function AnglePresets({
    presets,
    center,
    radius,
    currentDegrees,
    unit,
    minDegrees,
    maxDegrees,
    precision,
    valueRange,
    presetBehavior,
    isDragging,
    isDisabled,
    onPreviewChange,
    onSelect,
}: AnglePresetsProps) {
    const items = useMemo<readonly AnglePresetItem[]>(
        () =>
            presets.map(preset => {
                const appliedDegrees = clampAngle(
                    applyPresetDegrees(currentDegrees, preset, valueRange, presetBehavior),
                    minDegrees,
                    maxDegrees
                );
                const appliedValue = fromDegrees(appliedDegrees, unit);

                return {
                    value: preset,
                    point: getPointOnCircle(preset, radius, center),
                    label: formatAngleDisplay(appliedValue, { precision }),
                    previewValue: formatAngleDisplayNumber(appliedValue, { precision }),
                };
            }),
        [center, currentDegrees, maxDegrees, minDegrees, precision, presetBehavior, presets, radius, unit, valueRange]
    );
    const disablePresetPreview = isDisabled || isDragging;

    useEffect(() => {
        if (disablePresetPreview) {
            onPreviewChange?.(null);
        }
    }, [disablePresetPreview, onPreviewChange]);

    return (
        <For each={items}>
            {preset => {
                return (
                    <button
                        key={preset.value}
                        type="button"
                        tabIndex={-1}
                        className={styles.preset}
                        style={{
                            left: preset.point.x,
                            top: preset.point.y,
                        }}
                        disabled={isDisabled}
                        aria-label={`Set ${preset.label}`}
                        onPointerEnter={() => {
                            if (!disablePresetPreview) {
                                onPreviewChange?.(preset.previewValue);
                            }
                        }}
                        onPointerLeave={() => {
                            onPreviewChange?.(null);
                        }}
                        onPointerCancel={() => {
                            onPreviewChange?.(null);
                        }}
                        onClick={event => {
                            event.stopPropagation();
                            onSelect(preset.value);
                            onPreviewChange?.(null);
                        }}
                    />
                );
            }}
        </For>
    );
}

AnglePresets.displayName = 'AnglePresets';
