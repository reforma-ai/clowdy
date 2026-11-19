import { useCallback, useRef, useState } from 'react';
import { mergeProps, useFocusRing, useHover, useMove } from 'react-aria';

import styles from './GradientStopRange.module.css';
import {
    formatGradientStopPercent,
    formatGradientStopTrackPosition,
    positionFromKeyboardCommand,
    positionFromKeyboardMove,
    positionFromMoveDelta,
} from './utils';

import type { CSSProperties, KeyboardEvent, PointerEvent, Ref, RefObject } from 'react';
import type { GradientStopRangeStop } from './GradientStopRange';
import type { GradientStopRangeStepOptions } from './utils';

export interface GradientStopThumbProps {
    ref?: Ref<HTMLDivElement | null>;
    stop: GradientStopRangeStop;
    index: number;
    activeStopId?: string;
    ariaLabel: string;
    trackRef: RefObject<HTMLDivElement | null>;
    options: GradientStopRangeStepOptions;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    actions: GradientStopThumbActions;
    onDraggingChange?: (isDragging: boolean) => void;
    onPointerEnter?: () => void;
}

export interface GradientStopThumbActions {
    onActiveStopChange?: (stopId: string) => void;
    onStopPreview?: (stopId: string, position: number) => void;
    onStopCommit?: (stopId: string, position: number) => void;
    onStopCancel?: (stopId: string) => void;
    onStopRemove?: (stopId: string) => void;
}

interface UseStopMoveProps {
    stop: GradientStopRangeStop;
    trackRef: RefObject<HTMLDivElement | null>;
    options: GradientStopRangeStepOptions;
    isInteractive: boolean;
    actions: GradientStopThumbActions;
    onDraggingChange?: (isDragging: boolean) => void;
}

/**
 * Drag and keyboard move of a thumb. The positions of a drag live in refs, so the thumb's other
 * handlers get only `commitPosition` from here and never touch a ref themselves.
 */
function useStopMove({
    stop,
    trackRef,
    options,
    isInteractive,
    actions,
    onDraggingChange,
}: UseStopMoveProps) {
    const { onActiveStopChange, onStopPreview, onStopCommit } = actions;
    const dragPositionRef = useRef(stop.position);
    const lastPreviewPositionRef = useRef(stop.position);
    const [isDragging, setIsDragging] = useState(false);

    const previewPosition = useCallback((position: number) => {
        lastPreviewPositionRef.current = position;
        onStopPreview?.(stop.id, position);
    }, [onStopPreview, stop.id]);

    const commitPosition = useCallback((position: number) => {
        lastPreviewPositionRef.current = position;
        onStopPreview?.(stop.id, position);
        onStopCommit?.(stop.id, position);
    }, [onStopCommit, onStopPreview, stop.id]);

    const { moveProps } = useMove({
        onMoveStart() {
            if (!isInteractive) {
                return;
            }

            dragPositionRef.current = stop.position;
            lastPreviewPositionRef.current = stop.position;
            setIsDragging(true);
            onDraggingChange?.(true);
            onActiveStopChange?.(stop.id);
        },
        onMove(event) {
            if (!isInteractive) {
                return;
            }

            const nextPosition = event.pointerType === 'keyboard'
                ? positionFromKeyboardMove(
                    dragPositionRef.current,
                    event.deltaX,
                    event.deltaY,
                    options,
                    event.shiftKey
                )
                : positionFromMoveDelta(
                    dragPositionRef.current,
                    event.deltaX,
                    trackRef.current?.getBoundingClientRect().width ?? 0,
                    options
                );

            dragPositionRef.current = nextPosition;
            previewPosition(nextPosition);
        },
        onMoveEnd() {
            setIsDragging(false);
            onDraggingChange?.(false);

            if (isInteractive) {
                onStopCommit?.(stop.id, lastPreviewPositionRef.current);
            }
        },
    });

    return { moveProps, isDragging, setIsDragging, commitPosition };
}

export function GradientStopThumb({
    ref,
    stop,
    index,
    activeStopId,
    ariaLabel,
    trackRef,
    options,
    isDisabled,
    isReadOnly,
    actions,
    onDraggingChange,
    onPointerEnter,
}: GradientStopThumbProps) {
    const {
        onActiveStopChange,
        onStopCancel,
        onStopRemove,
    } = actions;
    const isThumbDisabled = isDisabled || stop.isDisabled;
    const isInteractive = !isThumbDisabled && !isReadOnly;
    const isActive = stop.id === activeStopId;
    const canRemoveStop = activeStopId == null || isActive;
    const { focusProps, isFocusVisible } = useFocusRing();
    const { hoverProps, isHovered } = useHover({ isDisabled: !isInteractive });
    const { moveProps, isDragging, setIsDragging, commitPosition } = useStopMove({
        stop,
        trackRef,
        options,
        isInteractive,
        actions,
        onDraggingChange,
    });

    const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!isInteractive) {
            return;
        }

        event.currentTarget.focus();
        onActiveStopChange?.(stop.id);
    }, [isInteractive, onActiveStopChange, stop.id]);

    const handleFocus = useCallback(() => {
        if (!isThumbDisabled) {
            onActiveStopChange?.(stop.id);
        }
    }, [isThumbDisabled, onActiveStopChange, stop.id]);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (isThumbDisabled) {
            return;
        }

        if (event.key === 'Escape') {
            event.preventDefault();
            setIsDragging(false);
            onDraggingChange?.(false);
            onStopCancel?.(stop.id);

            return;
        }

        if (isReadOnly) {
            return;
        }

        const nextPosition = positionFromKeyboardCommand(event.key, stop.position, options);

        if (nextPosition != null) {
            event.preventDefault();
            onActiveStopChange?.(stop.id);
            commitPosition(nextPosition);

            return;
        }

        if ((event.key === 'Delete' || event.key === 'Backspace') && onStopRemove && canRemoveStop) {
            event.preventDefault();
            onStopRemove(stop.id);
        }
    }, [
        canRemoveStop,
        commitPosition,
        isReadOnly,
        isThumbDisabled,
        onActiveStopChange,
        onDraggingChange,
        onStopCancel,
        onStopRemove,
        options,
        setIsDragging,
        stop.id,
        stop.position,
    ]);
    const thumbProps = mergeProps(moveProps, focusProps, hoverProps, {
        onFocus: handleFocus,
        onPointerDown: handlePointerDown,
        onPointerEnter,
        onKeyDown: handleKeyDown,
    });

    return (
        <div
            { ...thumbProps }
            ref={ ref }
            className={ styles.thumb }
            data-active={ isActive || undefined }
            data-disabled={ isThumbDisabled || undefined }
            data-dragging={ isDragging || undefined }
            data-focus-visible={ isFocusVisible || undefined }
            data-gradient-stop-thumb
            data-hovered={ isHovered || undefined }
            role="slider"
            tabIndex={ isThumbDisabled ? undefined : 0 }
            aria-label={ `${ ariaLabel } stop ${ index + 1 }` }
            aria-valuemin={ options.min * 100 }
            aria-valuemax={ options.max * 100 }
            aria-valuenow={ Math.round(stop.position * 1000) / 10 }
            aria-valuetext={ formatGradientStopPercent(stop.position) }
            aria-disabled={ isReadOnly || isThumbDisabled || undefined }
            style={ {
                '--clowdy-gradient-stop-position': formatGradientStopTrackPosition(stop.position, options),
                '--clowdy-gradient-stop-color': stop.color,
            } as CSSProperties }
        />
    );
}

GradientStopThumb.displayName = 'GradientStopThumb';
