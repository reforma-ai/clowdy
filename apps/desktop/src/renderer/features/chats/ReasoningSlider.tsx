import { For } from '@clowdy/components/For';
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

import { levelLabel } from './modelSelection';
import styles from './ReasoningSlider.module.css';

/** How far the thumb follows the pointer while it is dragged: 0 keeps it on its level, 1 puts it under the pointer. */
export const REASONING_DRAG_PULL = 0.4;

/** Where a pointer is along a track, from 0 (the thumb at the start) to 1 (the thumb at the end), counting the thumb's own width. */
export function progressFromTrackX(clientX: number, track: HTMLElement, thumbWidth: number): number {
    const { left, width } = track.getBoundingClientRect();
    const travel = width - thumbWidth;

    return travel <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - left - thumbWidth / 2) / travel));
}

/** How far along the track the stop `index` of `count` is. A track with one stop (or none) has it at the start, not at `0 / 0`. */
export function stopProgress(index: number, count: number): number {
    return count > 1 ? index / (count - 1) : 0;
}

/** The stop nearest to a pointer `progress` along the track. */
export function stopAt(progress: number, count: number): number {
    return count > 1 ? Math.round(progress * (count - 1)) : 0;
}

export interface ReasoningSliderProps {
    /** The levels the model offers, in order, in the agent's own spelling: one stop each. */
    levels: readonly string[];
    /** The level it is on. One the model does not offer is read as the first. */
    value: string | undefined;
    onChange: (level: string) => void;
}

/**
 * The reasoning effort as a track with a stop for each level and a thumb: a press or a drag sets the nearest level at once, and while
 * dragging the thumb follows the pointer only part of the way (`REASONING_DRAG_PULL`), so it still sits near the level in force. Arrow
 * keys step, Home and End jump to the ends. Made for two levels or more; with fewer it holds still and offers nothing to change.
 */
export function ReasoningSlider({ levels, value, onChange }: ReasoningSliderProps) {
    const count = levels.length;
    const last = Math.max(0, count - 1);
    const index = Math.max(0, value === undefined ? 0 : levels.indexOf(value));
    const thumb = useRef<HTMLSpanElement>(null);
    // The stop last handed to `onChange`: a drag goes on reporting the pointer long before the new level comes back as `value`, and the
    // levels it passed come back late and in turn, so `value` must not reset this while the pointer is down: each press or key starts
    // from `value` (below), and a drag then reports every stop it reaches once, whatever has come back by then.
    const reported = useRef(index);
    const [dragProgress, setDragProgress] = useState<number | null>(null);
    const dragging = dragProgress !== null;
    const anchorProgress = stopProgress(index, count);
    const pointerProgress = dragProgress ?? anchorProgress;

    const select = (next: number) => {
        const level = levels[next];

        if (level === undefined || next === reported.current) return;

        reported.current = next;
        onChange(level);
    };

    const follow = (event: PointerEvent<HTMLDivElement>) => {
        const progress = progressFromTrackX(event.clientX, event.currentTarget, thumb.current?.getBoundingClientRect().width ?? 0);

        setDragProgress(progress);
        select(stopAt(progress, count));
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        let next: number;

        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(last, index + 1);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, index - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = last;
        else return;

        event.preventDefault();
        // A key press is a new start: what was reported before no longer says where the thumb is.
        reported.current = index;
        select(next);
    };

    return (
        <div
            className={ styles.track }
            style={ {
                '--level-anchor-p': anchorProgress * (1 - REASONING_DRAG_PULL),
                '--level-pointer-p': pointerProgress * REASONING_DRAG_PULL,
            } as CSSProperties }
            data-dragging={ dragging || undefined }
            role="slider"
            tabIndex={ 0 }
            aria-label="Reasoning effort"
            aria-valuemin={ 0 }
            aria-valuemax={ last }
            aria-valuenow={ index }
            aria-valuetext={ levels[index] === undefined ? undefined : levelLabel(levels[index]) }
            onPointerDown={ (event) => {
                if (event.button !== 0) return;

                reported.current = index;
                event.currentTarget.setPointerCapture(event.pointerId);
                follow(event);
            } }
            onPointerMove={ (event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) follow(event);
            } }
            onPointerUp={ (event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    follow(event);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }

                setDragProgress(null);
            } }
            onPointerCancel={ () => setDragProgress(null) }
            onLostPointerCapture={ () => setDragProgress(null) }
            onKeyDown={ onKeyDown }
        >
            <span className={ styles.fill } />
            <For each={ levels }>
                { (level, stop) => (
                    <span
                        key={ level }
                        className={ styles.point }
                        data-hot={ (dragging && stop === index) || undefined }
                        style={ { '--point-p': stopProgress(stop, count) } as CSSProperties }
                    />
                ) }
            </For>
            <span ref={ thumb } className={ styles.thumb } data-dragging={ dragging || undefined } />
        </div>
    );
}
