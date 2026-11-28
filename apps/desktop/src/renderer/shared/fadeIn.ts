import { useLayoutEffect, useRef } from 'react';

import type { RefObject } from 'react';

const FADE: KeyframeAnimationOptions = { duration: 220, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };

/** Brings `node` up from transparent, at once for a person who prefers less motion. */
export function fadeIn(node: HTMLElement | null | undefined) {
    if (!node || typeof node.animate !== 'function') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    node.animate([{ opacity: 0 }, { opacity: 1 }], FADE);
}

/**
 * Fades `ref` in each time `key` changes, before the new content is painted, so another space's chats show up rather
 * than pop in. With `initial`, the first render fades in too.
 */
export function useFadeIn(ref: RefObject<HTMLElement | null>, key: string, { initial = false } = {}) {
    const shown = useRef(initial ? undefined : key);
    useLayoutEffect(() => {
        if (shown.current === key) return;
        shown.current = key;
        fadeIn(ref.current);
    }, [key, ref]);
}
