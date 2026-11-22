import { useEffect, useEffectEvent } from 'react';

/** What a dragged card carries: the id of its task, under this type, so the board's columns and the archive's target take only the app's own drag and not a file or a link. */
export const DRAG_TYPE = 'application/x-clowdy-task';

/**
 * Ends a drag whose own `dragend` never came. A card that is rebuilt while it is dragged (an event moves its task to another column) or leaves the page gets the browser's
 * `dragend` on the node it started on, which is gone, so the board would keep its Archive strip up. While `isDragging`, the drag ends on a `dragend` or a `drop` that reaches the
 * window (the targets read a drop first, so it is listened to when it comes back up), and on the first pointer move with no button down, or the first press, after the drag
 * began: the pointer's events stop for the native drag and come back only when it is over. A pointer move with a button still down is not that, so a drag is never cut short.
 */
export function useEndStuckDrag(isDragging: boolean, onEnd: () => void): void {
    const end = useEffectEvent(onEnd);

    useEffect(() => {
        if (!isDragging) return;

        const onPointerMove = (event: PointerEvent) => {
            if (event.buttons === 0) end();
        };
        const onEvent = () => end();

        window.addEventListener('dragend', onEvent, true);
        window.addEventListener('drop', onEvent);
        window.addEventListener('pointerdown', onEvent, true);
        window.addEventListener('pointermove', onPointerMove, true);

        return () => {
            window.removeEventListener('dragend', onEvent, true);
            window.removeEventListener('drop', onEvent);
            window.removeEventListener('pointerdown', onEvent, true);
            window.removeEventListener('pointermove', onPointerMove, true);
        };
    }, [isDragging]);
}
