import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

const ACTIVE_ROW = '[data-highlighted], [data-selected], [data-focus-visible]';

/**
 * Bring a row into the nearest scrollport when it becomes active (selected,
 * keyboard, or `data-highlighted`). Staying active must not scroll again —
 * a parent re-render would yank an ancestor pager back to this row.
 *
 * Attach the returned callback to the row. A collection list detaches that
 * ref while the visible row stays mounted; writing the null through would
 * make the scroll miss the selected row.
 */
export function useScrollActiveListItem<T extends HTMLElement>(
    ref: RefObject<T | null>,
    enabled = true
): (node: T | null) => void {
    const wasActive = useRef(false);
    const scheduled = useRef(false);

    const schedule = useCallback(() => {
        if (!enabled || scheduled.current) {
            return;
        }

        scheduled.current = true;
        queueMicrotask(() => {
            scheduled.current = false;
            const el = ref.current;

            if (!el?.isConnected) {
                return;
            }

            const active = el.matches(ACTIVE_ROW);

            if (active && !wasActive.current) {
                el.scrollIntoView({ block: 'nearest' });
            }

            wasActive.current = active;
        });
    }, [enabled, ref]);

    useLayoutEffect(schedule);

    return useCallback(
        node => {
            if (node) {
                ref.current = node;
                schedule();

                return;
            }

            // The collection clears the ref on the visible row without unmounting it.
            if (ref.current?.isConnected) {
                return;
            }

            ref.current = null;
        },
        [ref, schedule]
    );
}
