import { scrollParent } from '@clowdy/lib';
import { useEffect, useState } from 'react';

/** How far outside the scroller a card starts to be read: the diff view builds its editor at the same distance (`DiffView`), so a card has its text by the time its editor is wanted. */
export const NEAR_MARGIN = '800px 0px';

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
 * Whether the element is within `NEAR_MARGIN` of the scroll container it is in, as it scrolls: a card that is read when it comes near, and whose read that is still waiting is let go
 * of when it goes far again (a person who scrolls through hundreds of cards asks for the ones where they stop, not for every one they passed). Where there is no
 * `IntersectionObserver` (a test) everything is near.
 */
export function useNearViewport(element: HTMLElement | null): boolean {
    const [near, setNear] = useState(false);
    const observable = typeof IntersectionObserver !== 'undefined';

    useEffect(() => {
        if (!observable || !element) return;

        const observer = new IntersectionObserver(
            // The newest entry of the element is how it stands now.
            entries => setNear(entries.at(-1)?.isIntersecting ?? false),
            { root: observerRoot(element), rootMargin: NEAR_MARGIN }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [observable, element]);

    return !observable || near;
}
