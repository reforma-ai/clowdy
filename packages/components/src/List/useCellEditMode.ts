import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { DOMAttributes } from 'react';

export interface CellEditModeProps {
    onFocus: NonNullable<DOMAttributes<HTMLElement>['onFocus']>;
    onBlur: NonNullable<DOMAttributes<HTMLElement>['onBlur']>;
}

/**
 * Forward keyboard events into an editable embedded in a RAC {@link GridListItem} rather than consuming them as list navigation (e.g. Space for selection toggling).
 *
 * Attach the returned props to {@link HTMLInputElement}, {@link HTMLTextAreaElement}, or contenteditable hosts. Matches the workaround discussed in react-spectrum#4674 via a capture-phase `window` listener.
 */
export function useCellEditMode(): CellEditModeProps {
    const isFocusedRef = useRef(false);

    useEffect(() => {
        const handler = (event: KeyboardEvent) => {
            if (isFocusedRef.current) {
                event.stopPropagation();
            }
        };

        window.addEventListener('keydown', handler, true);

        return () => {
            window.removeEventListener('keydown', handler, true);
        };
    }, []);

    const onFocus = useCallback(() => {
        isFocusedRef.current = true;
    }, []);

    const onBlur = useCallback(() => {
        isFocusedRef.current = false;
    }, []);

    return useMemo(
        () => ({
            onFocus,
            onBlur,
        }),
        [onBlur, onFocus]
    );
}
