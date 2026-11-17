import { cn } from '@clowdy/lib';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePress } from 'react-aria';

import { For } from '../For';
import { Show } from '../Show';
import styles from './GradientStopRange.module.css';
import { GradientStopThumb } from './GradientStopThumb';
import {
    formatGradientStopTrackPosition,
    gradientStopRangeBackground,
    hasGradientStopNearPosition,
    positionFromTrackOffset,
    visibleGradientStops,
} from './utils';

import type { CSSProperties, HTMLAttributes, PointerEvent, Ref } from 'react';

export interface GradientStopRangeStop {
    id: string;
    color: string;
    position: number;
    isDisabled?: boolean;
}

export interface GradientStopRangeProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
    ref?: Ref<HTMLDivElement | null>;
    stops: readonly GradientStopRangeStop[];
    activeStopId?: string;
    min?: number;
    max?: number;
    step?: number;
    shiftStep?: number;
    isDisabled?: boolean;
    isReadOnly?: boolean;
    ariaLabel?: string;
    onActiveStopChange?: (stopId: string) => void;
    onStopPreview?: (stopId: string, position: number) => void;
    onStopCommit?: (stopId: string, position: number) => void;
    onStopCancel?: (stopId: string) => void;
    onStopAdd?: (position: number) => void;
    onStopRemove?: (stopId: string) => void;
    onStopDraggingChange?: (isDragging: boolean) => void;
}

const DEFAULT_MIN = 0;
const DEFAULT_MAX = 1;
const DEFAULT_STEP = 0.01;
const DEFAULT_SHIFT_STEP = 0.1;

export function GradientStopRange({
    ref,
    stops,
    activeStopId,
    min = DEFAULT_MIN,
    max = DEFAULT_MAX,
    step = DEFAULT_STEP,
    shiftStep = DEFAULT_SHIFT_STEP,
    isDisabled,
    isReadOnly,
    ariaLabel = 'Gradient stops',
    onActiveStopChange,
    onStopPreview,
    onStopCommit,
    onStopCancel,
    onStopAdd,
    onStopRemove,
    onStopDraggingChange,
    className,
    onPointerLeave,
    ...props
}: GradientStopRangeProps) {
    const trackRef = useRef<HTMLDivElement | null>(null);
    const thumbRefsRef = useRef(new Map<string, HTMLDivElement>());
    const addFocusRequestRef = useRef<Set<string> | null>(null);
    const [hoverPosition, setHoverPosition] = useState<number | null>(null);
    const [isDraggingStop, setIsDraggingStop] = useState(false);
    const bounds = useMemo(() => ({ min, max }), [max, min]);
    const stepOptions = useMemo(() => ({ ...bounds, step, shiftStep }), [bounds, shiftStep, step]);
    const thumbActions = useMemo(() => ({
        onActiveStopChange,
        onStopPreview,
        onStopCommit,
        onStopCancel,
        onStopRemove,
    }), [onActiveStopChange, onStopCancel, onStopCommit, onStopPreview, onStopRemove]);
    const visibleStops = useMemo(
        () => visibleGradientStops(stops, bounds),
        [bounds, stops]
    );
    const gradientBackground = useMemo(
        () => gradientStopRangeBackground(stops, bounds),
        [bounds, stops]
    );
    const isInactive = isDisabled || isReadOnly;
    const canAddStop = Boolean(onStopAdd) && !isInactive;
    const showAddMarker = canAddStop
      && !isDraggingStop
      && hoverPosition != null
      && !hasGradientStopNearPosition(visibleStops, hoverPosition);

    const hideAddMarker = useCallback(() => {
        setHoverPosition(null);
    }, []);

    const handleThumbDraggingChange = useCallback((isDragging: boolean) => {
        setIsDraggingStop(isDragging);
        onStopDraggingChange?.(isDragging);

        if (isDragging) {
            setHoverPosition(null);
        }
    }, [onStopDraggingChange]);

    const rememberStopsBeforeAdd = useCallback(() => {
        addFocusRequestRef.current = new Set(visibleStops.map(stop => stop.id));
    }, [visibleStops]);

    const setThumbRef = useCallback((stopId: string, node: HTMLDivElement | null) => {
        if (node) {
            thumbRefsRef.current.set(stopId, node);
        }
        else {
            thumbRefsRef.current.delete(stopId);
        }
    }, []);

    const handleTrackPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (canAddStop && !isDraggingStop) {
            const rect = event.currentTarget.getBoundingClientRect();

            setHoverPosition(positionFromTrackOffset(event.clientX - rect.left, rect.width, bounds));
        }
    }, [bounds, canAddStop, isDraggingStop]);

    const handlePointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
        setHoverPosition(null);
        onPointerLeave?.(event);
    }, [onPointerLeave]);

    const { pressProps, isPressed } = usePress({
        isDisabled: !canAddStop,
        preventFocusOnPress: true,
        onPress(event) {
            const width = trackRef.current?.getBoundingClientRect().width ?? 0;

            setHoverPosition(null);
            rememberStopsBeforeAdd();
            trackRef.current?.focus();
            onStopAdd?.(positionFromTrackOffset(event.x, width, bounds));
        },
    });

    useLayoutEffect(() => {
        const idsBeforeAdd = addFocusRequestRef.current;

        if (!idsBeforeAdd) {
            return;
        }

        const addedStop = visibleStops.find(stop => !idsBeforeAdd.has(stop.id));

        if (!addedStop) {
            addFocusRequestRef.current = null;

            return;
        }

        addFocusRequestRef.current = null;
        onActiveStopChange?.(addedStop.id);
        thumbRefsRef.current.get(addedStop.id)?.focus();
    }, [onActiveStopChange, visibleStops]);

    return (
        <div
            { ...props }
            ref={ ref }
            className={ cn(styles.range, className) }
            data-disabled={ isDisabled || undefined }
            data-dragging={ isDraggingStop || undefined }
            data-readonly={ isReadOnly || undefined }
            data-modal-drag-exclude
            onPointerLeave={ handlePointerLeave }
        >
            <div
                { ...pressProps }
                ref={ trackRef }
                className={ styles.track }
                data-addable={ canAddStop || undefined }
                data-pressed={ isPressed || undefined }
                role={ canAddStop ? 'button' : undefined }
                tabIndex={ canAddStop ? 0 : undefined }
                aria-label={ canAddStop ? `${ ariaLabel } add stop` : undefined }
                style={ { '--clowdy-gradient-stop-range-background': gradientBackground } as CSSProperties }
                onPointerMove={ handleTrackPointerMove }
            />

            <For each={ visibleStops }>
                { (stop, index) => (
                    <GradientStopThumb
                        key={ stop.id }
                        ref={ node => setThumbRef(stop.id, node) }
                        stop={ stop }
                        index={ index }
                        activeStopId={ activeStopId }
                        ariaLabel={ ariaLabel }
                        trackRef={ trackRef }
                        options={ stepOptions }
                        isDisabled={ isDisabled }
                        isReadOnly={ isReadOnly }
                        actions={ thumbActions }
                        onDraggingChange={ handleThumbDraggingChange }
                        onPointerEnter={ hideAddMarker }
                    />
                ) }
            </For>

            <Show when={ showAddMarker }>
                <span
                    className={ styles.addMarker }
                    style={ {
                        '--clowdy-gradient-stop-position': formatGradientStopTrackPosition(hoverPosition ?? min, bounds),
                    } as CSSProperties }
                    aria-hidden
                />
            </Show>
        </div>
    );
}

GradientStopRange.displayName = 'GradientStopRange';
