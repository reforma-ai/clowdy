import { useEffect, useRef } from 'react';

import type { RefObject } from 'react';

/** Document listener used to detect an “outside” interaction (always capture phase). */
export type UseClickoutEvent = 'click' | 'pointerdown' | 'pointerup';

export type UseClickoutOptions = {
    /** When false, no document listener is registered. */
    enabled: boolean;
    /** Refs whose subtrees count as “inside”; events elsewhere invoke `onClickout`. */
    roots: RefObject<Element | null> | ReadonlyArray<RefObject<Element | null>>;
    onClickout: () => void;
    /** Defaults to `pointerdown`. */
    event?: UseClickoutEvent;
};

function isSingleRootRef(
    roots: UseClickoutOptions['roots']
): roots is RefObject<Element | null> {
    return !Array.isArray(roots);
}

function asRootList(roots: UseClickoutOptions['roots']): ReadonlyArray<RefObject<Element | null>> {
    return isSingleRootRef(roots) ? [roots] : roots;
}

/**
 * Registers a capture-phase listener on `document`. When `enabled`, calls `onClickout` if the
 * event target is not contained in any `roots` element.
 */
export function useClickout({ enabled, roots, onClickout, event = 'pointerdown' }: UseClickoutOptions): void {
    const onClickoutRef = useRef(onClickout);

    onClickoutRef.current = onClickout;

    const rootsRef = useRef(roots);

    rootsRef.current = roots;

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const onDocumentCapture = (docEvent: Event) => {
            const { target } = docEvent;

            if (!target || !(target instanceof Node)) {
                return;
            }
            for (const root of asRootList(rootsRef.current)) {
                if (root.current?.contains(target)) {
                    return;
                }
            }

            onClickoutRef.current();
        };

        document.addEventListener(event, onDocumentCapture, true);

        return () => {
            document.removeEventListener(event, onDocumentCapture, true);
        };
    }, [enabled, event]);
}
