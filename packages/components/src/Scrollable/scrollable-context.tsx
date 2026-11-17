import { createContext, use } from 'react';

import type { StickToBottomInstance } from '../hooks/useStickToBottom';

/**
 * Value exposed to descendants of {@link Scrollable}.
 * When `stickToBottom` is `false` on the parent, `stickToBottom` is `null`
 * (hook still runs with `enabled: false`; use the prop/API to pause without unmounting).
 */
export type ScrollableContextValue = {
    stickToBottom: StickToBottomInstance | null;
    /** Jump the vertical scrollport to the top (`scrollTop = 0`). */
    scrollToTop: () => void;
    /** Vertical axis: near the top (`scrollTop` ≈ 0). False when vertical scrolling is off. */
    atVerticalStart: boolean;
    /** Vertical axis: near the bottom (`scrollTop` + `clientHeight` ≈ `scrollHeight`). False when vertical scrolling is off. */
    atVerticalEnd: boolean;
    /** Horizontal axis: near the left (`scrollLeft` ≈ 0). False when horizontal scrolling is off. */
    atHorizontalStart: boolean;
    /** Horizontal axis: near the right (`scrollLeft` + `clientWidth` ≈ `scrollWidth`). False when horizontal scrolling is off. */
    atHorizontalEnd: boolean;
};

export const ScrollableContext = createContext<ScrollableContextValue | null>(null);

/**
 * Read stick-to-bottom state and actions for the enclosing {@link Scrollable}.
 * For a bare scroll container outside `Scrollable`, use {@link useStickToBottom} directly.
 */
export function useScrollable(): ScrollableContextValue {
    const ctx = use(ScrollableContext);

    if (!ctx) {
        throw new Error('useScrollable must be used within Scrollable');
    }

    return ctx;
}
