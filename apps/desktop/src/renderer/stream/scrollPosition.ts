/** An older reading position, or undefined when the stream should follow its latest message. */
export interface ScrollPosition {
    top: number;
    anchor?: { id: string; offset: number };
}

export interface ScrollMemory {
    read: () => ScrollPosition | undefined;
    write: (position: ScrollPosition | undefined) => void;
}

const ANCHORS = '[data-turn], [data-scroll-anchor]';

/** The same distance from the end that the stream's live follow behavior counts as latest. */
export const LATEST_THRESHOLD = 50;

/** Keep a visible message as an anchor so a change in the height of earlier work does not move the reading position. */
export function captureScrollPosition(scroll: HTMLElement, bottomInset = 0): ScrollPosition | undefined {
    if (scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= LATEST_THRESHOLD) return undefined;

    const viewport = scroll.getBoundingClientRect();
    const visibleBottom = viewport.bottom - bottomInset;
    if (visibleBottom <= viewport.top) return { top: scroll.scrollTop };

    for (const message of scroll.querySelectorAll<HTMLElement>(ANCHORS)) {
        const bounds = message.getBoundingClientRect();
        const id = message.dataset.turn ?? message.dataset.scrollAnchor;

        if (id && bounds.bottom > bounds.top && bounds.bottom > viewport.top && bounds.top < visibleBottom) {
            return { top: scroll.scrollTop, anchor: { id, offset: bounds.top - viewport.top } };
        }
    }

    return { top: scroll.scrollTop };
}

/** An edited or removed anchor falls back to the saved pixel position, clamped by the browser. */
export function restoreScrollPosition(scroll: HTMLElement, position: ScrollPosition): void {
    const { anchor, top } = position;
    const message =
        anchor &&
        scroll.querySelector<HTMLElement>(
            `[data-turn="${CSS.escape(anchor.id)}"], [data-scroll-anchor="${CSS.escape(anchor.id)}"]`
        );
    scroll.scrollTop =
        message && anchor
            ? Math.max(
                  0,
                  scroll.scrollTop +
                      message.getBoundingClientRect().top -
                      scroll.getBoundingClientRect().top -
                      anchor.offset
              )
            : top;
}
