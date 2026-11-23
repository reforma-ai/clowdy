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
 * True once the element has come within `NEAR_MARGIN` of the scroll container it is in, and for good: the card is read once, and a card that scrolls away keeps what it has. Where
 * there is no `IntersectionObserver` (a test) everything is near.
 */
export function useNearViewport(element: HTMLElement | null): boolean {
    const [near, setNear] = useState(false);
    const observable = typeof IntersectionObserver !== 'undefined';
    const waiting = observable && !near;

    useEffect(() => {
        if (!waiting || !element) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some(entry => entry.isIntersecting)) setNear(true);
            },
            { root: observerRoot(element), rootMargin: NEAR_MARGIN }
        );

        observer.observe(element);

        return () => observer.disconnect();
    }, [waiting, element]);

    return !waiting;
}
