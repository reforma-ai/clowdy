import { useLayoutEffect, useState } from 'react';

type BoxSize = [ref: (element: HTMLElement | null) => void, size: number];

/**
 * The width of an element, kept as it is resized: the ref to put on it, and the width in pixels (0 until it has been measured, and where there is no layout to measure). The view
 * builds its resizable group only once its box has a width, since a group built in an unsized box (the side panel mounts the view in the same pass that sizes its column) lays
 * itself out at that width, which leaves the sidebar at its narrowest for good.
 */
export function useBoxWidth(): BoxSize {
    const [element, setElement] = useState<HTMLElement | null>(null);
    const [size, setSize] = useState(0);

    useLayoutEffect(() => {
        if (!element) return;

        setSize(element.getBoundingClientRect().width);

        if (typeof ResizeObserver === 'undefined') return;

        const observer = new ResizeObserver(entries => setSize(entries.at(-1)?.contentRect.width ?? 0));

        observer.observe(element);

        return () => observer.disconnect();
    }, [element]);

    return [setElement, size];
}
