import { reaction, type IReactionDisposer } from 'mobx';
import { useEffect, useRef, useState, type RefObject } from 'react';

import hotkeys from './hotkeys';
import { clamp } from './math';

interface Coord {
    x: number;
    y: number;
}

export type RunnerDirection = 'top' | 'right' | 'bottom' | 'left';
export type RunnerCursorType = 'proportional' | 'directional';
export type RunnerCursor = 'ew-resize' | 'ns-resize' | 'n-resize' | 'e-resize' | 's-resize' | 'w-resize';

export interface RunnerChangePayload {
    event: PointerEvent | null;
    value: number;
    shift: number;
}

export interface UseRunnerOptions {
    value: number;
    onChange: (value: number) => void;
    onStart?: (payload: RunnerChangePayload) => void;
    onEnd?: (payload: RunnerChangePayload) => void;
    min?: number;
    max?: number;
    step?: number;
    shiftStep?: number;
    factor?: number;
    direction?: RunnerDirection;
    cursorType?: RunnerCursorType;
    snap?: Partial<{
        duration: number;
        values: number[];
        multipleOf: number;
    }>;
    option?: boolean;
    allowFakeCursor?: boolean;
    disabled?: boolean;
    shouldRun?: (target: HTMLElement) => boolean;
}

export interface UseRunnerReturn {
    isDragging: boolean;
}

const cursorMap: Record<RunnerDirection, Record<RunnerCursorType, RunnerCursor>> = {
    top: { proportional: 'ns-resize', directional: 'n-resize' },
    right: { proportional: 'ew-resize', directional: 'e-resize' },
    bottom: { proportional: 'ns-resize', directional: 's-resize' },
    left: { proportional: 'ew-resize', directional: 'w-resize' },
};

const FAKE_CURSOR_SVG = `
    <svg width="32" height="12" viewBox="0 0 32 12" style="filter: drop-shadow(0 1px 1.1px rgba(0,0,0,.4));">
        <path d="M6.26087 5V2.5L2 6L6.26087 9.5V7H25.7391V9.5L30 6L25.7391 2.5V5H6.26087Z" fill="black"/>
        <path fill-rule="evenodd" d="M2.00001 6.00007L6.26088 9.50007V7.00007H25.7391V9.50007L30 6.00007L25.7391 2.50007V5.00007H6.26088V2.50007L2.00001 6.00007ZM7.26088 4.00007V0.384521L0.424561 6.00007L7.26088 11.6156V8.00007H24.7391V11.6156L31.5755 6.00007L24.7391 0.384521V4.00007H7.26088Z" fill="white"/>
    </svg>
`;

function inRange(value: number, min: number, max: number): boolean {
    return Math.min(min, max) <= value && Math.max(min, max) >= value;
}

export function useRunner<T extends HTMLElement>(
    ref: RefObject<T | null>,
    options: UseRunnerOptions
): UseRunnerReturn {
    const [isDragging, setIsDragging] = useState(false);

    const optionsRef = useRef(options);

    optionsRef.current = options;

    const { disabled, option, direction = 'right', cursorType = 'proportional' } = options;

    useEffect(() => {
        const target = ref.current;

        if (!target || disabled) {
            return;
        }

        const cursor = cursorMap[direction][cursorType];
        const axis: keyof Coord = (direction === 'right' || direction === 'left') ? 'x' : 'y';
        const signFactor: -1 | 1 = (direction === 'right' || direction === 'bottom') ? 1 : -1;

        let overlay: HTMLElement | null = null;
        let fakeCursorEl: HTMLElement | null = null;
        let startCoords: Coord = { x: 0, y: 0 };
        let lastCoords: Coord = { x: 0, y: 0 };
        let snapCoords: { x: number | null; y: number | null } = { x: null, y: null };
        let startValue = 0;
        let currentValue = 0;
        let dragAbort: AbortController | null = null;
        let shiftReactionDisposer: IReactionDisposer | null = null;

        const allowFakeCursor = () => (
            (optionsRef.current.allowFakeCursor ?? true)
            && typeof navigator !== 'undefined'
            && /Chrome/.test(navigator.userAgent)
        );

        const applyValue = (raw: number): number => {
            const { min, max } = optionsRef.current;
            const next = clamp(min ?? -Infinity, raw, max ?? Infinity);

            if (next !== currentValue) {
                currentValue = next;
                optionsRef.current.onChange(next);
            }

            return next;
        };

        const updateFakeCursor = () => {
            if (!fakeCursorEl || !overlay) {
                return;
            }

            const { width, height } = overlay.getBoundingClientRect();
            let nx = lastCoords.x % width;
            let ny = lastCoords.y % height;

            if (nx < 0) {
                nx += width;
            }

            if (ny < 0) {
                ny += height;
            }

            fakeCursorEl.style.left = `${ nx }px`;
            fakeCursorEl.style.top = `${ ny }px`;
        };

        const createFakeCursor = () => {
            if (!overlay || !allowFakeCursor()) {
                return;
            }

            void overlay.requestPointerLock?.();

            fakeCursorEl = document.createElement('div');
            fakeCursorEl.style.cssText = `
                position: absolute;
                z-index: 1;
                width: max-content;
                pointer-events: none;
                transform: translate(-50%, -35%) rotate(${ axis === 'y' ? 90 : 0 }deg);
            `;
            fakeCursorEl.innerHTML = FAKE_CURSOR_SVG;
            overlay.append(fakeCursorEl);

            updateFakeCursor();
        };

        const removeFakeCursor = () => {
            if (!fakeCursorEl) {
                return;
            }

            try {
                document.exitPointerLock?.();
            }
            catch {
                // pointer lock may not be active
            }

            fakeCursorEl.remove();
            fakeCursorEl = null;
        };

        const createOverlay = (ev: PointerEvent) => {
            const doc = (ev.target as HTMLElement)?.ownerDocument ?? document;

            overlay = doc.createElement('div');
            overlay.style.cssText = `
                position: fixed;
                inset: 0;
                z-index: 100000000;
                cursor: ${ cursor };
            `;
            doc.body.appendChild(overlay);

            createFakeCursor();
        };

        const removeOverlay = () => {
            removeFakeCursor();
            overlay?.remove();
            overlay = null;
        };

        const getPayload = (ev: PointerEvent | null): RunnerChangePayload => ({
            event: ev,
            value: currentValue,
            shift: (lastCoords[axis] - startCoords[axis]) * signFactor / (optionsRef.current.factor ?? 1),
        });

        const onPointerMove = (ev?: PointerEvent) => {
            const snap = optionsRef.current.snap ?? {};
            const snapDuration = snap.duration ?? 5;
            const snapValues = snap.values ?? [];
            const snapMultipleOf = snap.multipleOf;

            if (ev) {
                ev.preventDefault();
                ev.stopPropagation();

                lastCoords = {
                    x: fakeCursorEl ? lastCoords.x + (ev.movementX || 0) : ev.clientX,
                    y: fakeCursorEl ? lastCoords.y + (ev.movementY || 0) : ev.clientY,
                };
            }

            updateFakeCursor();

            const snapAxis = snapCoords[axis];

            if (snapAxis != null) {
                const min = snapAxis - snapDuration;
                const max = snapAxis + snapDuration;

                if (inRange(lastCoords[axis], min, max)) {
                    return;
                }

                startCoords[axis] += (lastCoords[axis] < min) ? -snapDuration : snapDuration;
                snapCoords[axis] = null;
            }

            if (lastCoords[axis] === startCoords[axis]) {
                return;
            }

            const factor = optionsRef.current.factor ?? 1;
            const step = hotkeys.shiftKey
                ? (optionsRef.current.shiftStep ?? 10)
                : (optionsRef.current.step ?? 1);

            const rawDelta = Math.round(lastCoords[axis] - startCoords[axis]) * signFactor;
            const steppedDelta = Math.round(rawDelta / factor) * step;
            // integer math keeps up to 4 decimal places without fp drift
            const next = applyValue(((startValue * 1e4) + (steppedDelta * 1e4)) / 1e4);

            if (snapMultipleOf || snapValues.length) {
                const hitsMultiple = snapMultipleOf != null && next % snapMultipleOf === 0;
                const hitsExplicit = snapValues.includes(next);

                if (hitsMultiple || hitsExplicit) {
                    snapCoords[axis] = lastCoords[axis];
                }
            }
        };

        const onPointerUp = (ev: PointerEvent) => {
            ev.preventDefault();
            ev.stopPropagation();

            optionsRef.current.onEnd?.(getPayload(ev));

            shiftReactionDisposer?.();
            shiftReactionDisposer = null;

            dragAbort?.abort();
            dragAbort = null;

            removeOverlay();

            target.classList.remove('runner-in-move');
            setIsDragging(false);
        };

        const onPointerDown = (ev: PointerEvent) => {
            const { shouldRun, option: isOption } = optionsRef.current;

            if (shouldRun && !shouldRun(ev.target as HTMLElement)) {
                return;
            }

            if (isOption && !hotkeys.altKey) {
                return;
            }

            ev.preventDefault();
            ev.stopPropagation();

            startCoords = { x: ev.clientX, y: ev.clientY };
            lastCoords = { x: ev.clientX, y: ev.clientY };
            snapCoords = { x: null, y: null };
            startValue = optionsRef.current.value;
            currentValue = startValue;

            target.classList.add('runner-in-move');
            setIsDragging(true);

            createOverlay(ev);

            optionsRef.current.onStart?.(getPayload(ev));

            dragAbort = new AbortController();
            overlay?.addEventListener('pointermove', onPointerMove as EventListener, { signal: dragAbort.signal });
            overlay?.addEventListener('pointerup', onPointerUp as EventListener, { signal: dragAbort.signal });
            overlay?.addEventListener('pointerleave', onPointerUp as EventListener, { signal: dragAbort.signal });

            // re-apply on Shift toggle so the step change takes effect without pointer movement
            shiftReactionDisposer = reaction(
                () => hotkeys.shiftKey,
                () => onPointerMove()
            );
        };

        const targetAbort = new AbortController();

        target.addEventListener('pointerdown', onPointerDown as EventListener, { signal: targetAbort.signal });

        return () => {
            targetAbort.abort();
            dragAbort?.abort();
            shiftReactionDisposer?.();
            removeOverlay();
            target.classList.remove('runner-in-move');
        };
    }, [ref, disabled, option, direction, cursorType]);

    return { isDragging };
}
