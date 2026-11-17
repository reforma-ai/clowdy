export type ScrollAxisMetrics = {
    offset: number;
    scrollSize: number;
    clientSize: number;
};

/**
 * Abstract scroll axis for {@link useScrollChrome}.
 * HTML elements use {@link elementScrollAxisSource}; remote targets (e.g. iframe
 * document) provide the same surface with their own get/set/subscribe.
 */
export type ScrollAxisSource = {
    getMetrics: () => ScrollAxisMetrics | null;
    setOffset: (offset: number) => void;
    /** Notify chrome to redraw (scroll, resize, remote update). */
    subscribe?: (onChange: () => void) => () => void;
    /** ResizeObserver target when size changes are not covered by subscribe. */
    getObserveElement?: () => Element | null;
};

export function elementScrollAxisSource(
    getElement: () => HTMLElement | null,
    axis: 'vertical' | 'horizontal'
): ScrollAxisSource {
    const vertical = axis === 'vertical';

    return {
        getMetrics: () => {
            const el = getElement();

            if (!el) {
                return null;
            }

            return {
                offset: vertical ? el.scrollTop : el.scrollLeft,
                scrollSize: vertical ? el.scrollHeight : el.scrollWidth,
                clientSize: vertical ? el.clientHeight : el.clientWidth,
            };
        },
        setOffset: (offset) => {
            const el = getElement();

            if (!el) {
                return;
            }

            if (vertical) {
                el.scrollTop = offset;
            }
            else {
                el.scrollLeft = offset;
            }
        },
        subscribe: (onChange) => {
            const el = getElement();

            if (!el) {
                return () => {};
            }

            el.addEventListener('scroll', onChange, { passive: true });

            return () => {
                el.removeEventListener('scroll', onChange);
            };
        },
        getObserveElement: () => getElement(),
    };
}
