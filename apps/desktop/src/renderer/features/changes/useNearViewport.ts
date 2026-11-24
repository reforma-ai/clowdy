import { scrollParent } from '@clowdy/lib';
import { useEffect, useState } from 'react';

/** How far outside the scroller a card starts to be read: the diff view builds its editor at the same distance (`DiffView`), so a card has its text by the time its editor is wanted. */
export const NEAR_MARGIN = '800px 0px';

/** Where the element stands: near the scroller's edge or not, whether the observer has said so yet, and how tall it was when it last went far. */
export interface NearState {
    near: boolean;
    /** The observer has said where the element is at least once: until then `near` is only the guess that it is not. */
    known: boolean;
    /** The element's height as the observer measured it when it last went far (no layout of its own is read for it), or nothing while it has not. */
    height: number | undefined;
}

/**
 * What the margin is measured against: the scroll container the element is in. A margin reaches past the edge of a scroll container only when that container is the observer's
 * root; with the viewport as root, a card below the fold of its scroller counts as far away however big the margin.
 */
function observerRoot(element: HTMLElement): Element | null {
    const container = scrollParent(element);
    const { documentElement, scrollingElement } = element.ownerDocument;

    return container === documentElement || container === scrollingElement ? null : container;
}

/**
 * Whether the element is within `NEAR_MARGIN` of the scroll container it is in, as it scrolls: a card that is built and read when it comes near, and that goes back to a box of its
 * height when it goes far again (a person who scrolls through hundreds of cards asks for the ones where they stop, not for every one they passed). Where there is no
 * `IntersectionObserver` (a test) everything is near.
 */
export function useNearViewport(element: HTMLElement | null): NearState {
    const [state, setState] = useState<NearState>({ near: false, known: false, height: undefined });
    const observable = typeof IntersectionObserver !== 'undefined';

    useEffect(() => {
        if (!observable || !element) return;

        const observer = new IntersectionObserver(
            entries => {
                // The newest entry of the element is how it stands now.
                const entry = entries.at(-1);

                if (!entry) return;

                setState(previous => {
                    if (entry.isIntersecting)
                        return previous.near ? previous : { near: true, known: true, height: previous.height };

                    const height = entry.boundingClientRect.height || previous.height;

                    return !previous.near && previous.known && previous.height === height
                        ? previous
                        : { near: false, known: true, height };
                });
            },
            { root: observerRoot(element), rootMargin: NEAR_MARGIN }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [observable, element]);

    return observable ? state : { near: true, known: true, height: undefined };
}
