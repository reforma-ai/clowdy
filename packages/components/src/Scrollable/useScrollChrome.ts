import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import styles from './Scrollable.module.css';

import type { ScrollAxisSource } from './scrollAxisSource';

export type ScrollChromeEdges = {
    atVerticalStart: boolean;
    atVerticalEnd: boolean;
    atHorizontalStart: boolean;
    atHorizontalEnd: boolean;
};

export type UseScrollChromeOptions = {
    verticalSource?: ScrollAxisSource | null;
    horizontalSource?: ScrollAxisSource | null;
    /**
     * When a source identity changes (e.g. external scroll target mounts),
     * pass a new key so listeners and ResizeObserver re-bind.
     */
    sourceKey?: unknown;
    gap?: number;
    alwaysShowScrollbar?: boolean;
};

export type UseScrollChromeResult = {
    rootRef: React.RefObject<HTMLDivElement | null>;
    edgesRef: React.RefObject<ScrollChromeEdges>;
    setScrollbarV: (el: HTMLDivElement | null) => void;
    setScrollbarH: (el: HTMLDivElement | null) => void;
    /** Force a chrome redraw (e.g. after layout that sources do not observe). */
    redraw: () => void;
    handlePointerDown: (e: React.PointerEvent) => void;
    rootPointerHandlers: {
        onPointerEnter: () => void;
        onPointerLeave: () => void;
    };
};

type AxisEdgeKeys = {
    start: keyof ScrollChromeEdges;
    end: keyof ScrollChromeEdges;
    startAttr: string;
    endAttr: string;
    showAttr: string;
};

const VERTICAL_EDGES: AxisEdgeKeys = {
    start: 'atVerticalStart',
    end: 'atVerticalEnd',
    startAttr: 'data-scroll-v-start',
    endAttr: 'data-scroll-v-end',
    showAttr: 'data-scroll-show-v',
};

const HORIZONTAL_EDGES: AxisEdgeKeys = {
    start: 'atHorizontalStart',
    end: 'atHorizontalEnd',
    startAttr: 'data-scroll-h-start',
    endAttr: 'data-scroll-h-end',
    showAttr: 'data-scroll-show-h',
};

function clearAxisEdges(root: HTMLDivElement | null, edges: ScrollChromeEdges, keys: AxisEdgeKeys) {
    edges[keys.start] = false;
    edges[keys.end] = false;

    if (root) {
        root.removeAttribute(keys.startAttr);
        root.removeAttribute(keys.endAttr);
        root.removeAttribute(keys.showAttr);
    }
}

function drawAxis(
    root: HTMLDivElement | null,
    source: ScrollAxisSource | null | undefined,
    scrollbar: HTMLDivElement | null,
    edges: ScrollChromeEdges,
    keys: AxisEdgeKeys,
    gap: number
) {
    if (!source) {
        clearAxisEdges(root, edges, keys);

        return;
    }

    const metrics = source.getMetrics();

    if (!metrics || metrics.clientSize <= 0 || metrics.scrollSize <= 0) {
        clearAxisEdges(root, edges, keys);

        return;
    }

    const { offset, scrollSize, clientSize } = metrics;
    const edgeEpsilon = 1;
    const gapPercent = (gap / clientSize) * 100;
    const thumbLength = (clientSize / scrollSize) * 100 - gapPercent * 2;
    const thumbOffset = (offset / scrollSize) * 100 + gapPercent;
    const show = thumbLength < 100 - gapPercent * 2;
    const atStart = show ? offset <= edgeEpsilon : true;
    const atEnd = show ? offset + clientSize >= scrollSize - edgeEpsilon : true;

    if (scrollbar) {
        scrollbar.style.setProperty('--ms-thumb-length', `${thumbLength}%`);
        scrollbar.style.setProperty('--ms-thumb-offset', `${thumbOffset}%`);
    }

    edges[keys.start] = atStart;
    edges[keys.end] = atEnd;

    if (root) {
        root.setAttribute(keys.startAttr, String(atStart));
        root.setAttribute(keys.endAttr, String(atEnd));
        root.setAttribute(keys.showAttr, show ? 'true' : 'false');
    }
}

/**
 * Custom scrollbar chrome driven by direct DOM updates — no React state on scroll.
 * Shared by {@link Scrollable} and app-local scroll chrome (e.g. layers tree, frame page).
 */
export function useScrollChrome({
    verticalSource,
    horizontalSource,
    sourceKey,
    gap = 0,
    alwaysShowScrollbar,
}: UseScrollChromeOptions): UseScrollChromeResult {
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollbarVRef = useRef<HTMLDivElement>(null);
    const scrollbarHRef = useRef<HTMLDivElement>(null);

    const edgesRef = useRef<ScrollChromeEdges>({
        atVerticalStart: true,
        atVerticalEnd: true,
        atHorizontalStart: true,
        atHorizontalEnd: true,
    });

    const dragMetaRef = useRef<{
        source: ScrollAxisSource;
        isVertical: boolean;
        fromScrollOffset: number;
        fromScrollSize: number;
        fromOffset: number;
        totalDistance: number;
    } | null>(null);

    const chromeRef = useRef({
        hovered: false,
        dragging: false,
    });

    const verticalSourceRef = useRef(verticalSource);
    const horizontalSourceRef = useRef(horizontalSource);

    verticalSourceRef.current = verticalSource;
    horizontalSourceRef.current = horizontalSource;

    const setScrollbarV = useCallback((el: HTMLDivElement | null) => {
        scrollbarVRef.current = el;
    }, []);

    const setScrollbarH = useCallback((el: HTMLDivElement | null) => {
        scrollbarHRef.current = el;
    }, []);

    const applyChromeClasses = useCallback(() => {
        const root = rootRef.current;

        if (!root) {
            return;
        }

        const { hovered, dragging } = chromeRef.current;

        root.classList.toggle(styles.hover, alwaysShowScrollbar || hovered);
        root.classList.toggle(styles.inDrag, dragging);
    }, [alwaysShowScrollbar]);

    const draw = useCallback(() => {
        const root = rootRef.current;
        const edges = edgesRef.current;

        drawAxis(root, verticalSourceRef.current, scrollbarVRef.current, edges, VERTICAL_EDGES, gap);
        drawAxis(root, horizontalSourceRef.current, scrollbarHRef.current, edges, HORIZONTAL_EDGES, gap);
    }, [gap]);

    const startDrag = useCallback(
        (e: React.PointerEvent, isVertical: boolean) => {
            const source = isVertical ? verticalSourceRef.current : horizontalSourceRef.current;
            const metrics = source?.getMetrics();

            if (!source || !metrics || metrics.clientSize <= 0) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();

            dragMetaRef.current = {
                source,
                isVertical,
                fromScrollOffset: metrics.offset,
                fromScrollSize: metrics.scrollSize,
                fromOffset: isVertical ? e.screenY : e.screenX,
                totalDistance: metrics.clientSize - gap * 2,
            };
        },
        [gap]
    );

    const processDrag = useCallback((e: PointerEvent) => {
        const dragMeta = dragMetaRef.current;

        if (!dragMeta || dragMeta.totalDistance === 0) {
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const { source, isVertical, fromOffset, fromScrollOffset, fromScrollSize, totalDistance } = dragMeta;
        const toOffset = isVertical ? e.screenY : e.screenX;
        const movePercent = (toOffset - fromOffset) / totalDistance;

        source.setOffset(fromScrollOffset + fromScrollSize * movePercent);
    }, []);

    const endDrag = useCallback((e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        dragMetaRef.current = null;
    }, []);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent) => {
            const isVertical = (e.target as HTMLElement).classList.contains(styles.scrollbarV);

            startDrag(e, isVertical);
            chromeRef.current.dragging = true;
            applyChromeClasses();

            const abortController = new AbortController();

            document.addEventListener(
                'pointermove',
                (ev: PointerEvent) => {
                    processDrag(ev);
                },
                {
                    signal: abortController.signal,
                    capture: true,
                }
            );

            document.addEventListener(
                'pointerup',
                (ev: PointerEvent) => {
                    abortController.abort();
                    processDrag(ev);
                    endDrag(ev);
                    chromeRef.current.dragging = false;
                    applyChromeClasses();
                },
                {
                    signal: abortController.signal,
                    capture: true,
                }
            );
        },
        [startDrag, processDrag, endDrag, applyChromeClasses]
    );

    const rootPointerHandlers = useMemo(
        () => ({
            onPointerEnter: () => {
                chromeRef.current.hovered = true;
                applyChromeClasses();
            },
            onPointerLeave: () => {
                chromeRef.current.hovered = false;
                applyChromeClasses();
            },
        }),
        [applyChromeClasses]
    );

    useLayoutEffect(() => {
        applyChromeClasses();
    }, [applyChromeClasses]);

    useLayoutEffect(() => {
        draw();
    }, [draw, sourceKey, verticalSource, horizontalSource]);

    useLayoutEffect(() => {
        if (typeof ResizeObserver === 'undefined') {
            return;
        }

        const observed = new Set<Element>();
        const ro = new ResizeObserver(() => draw());
        const ports: Element[] = [];

        const watch = () => {
            const next = new Set<Element>();

            for (const source of [verticalSource, horizontalSource]) {
                const el = source?.getObserveElement?.();

                if (!el) {
                    continue;
                }

                next.add(el);
                // The port's own box does not change when content grows. The content
                // child does, and that is what scrollHeight follows.
                const content = el.firstElementChild;

                if (content) {
                    next.add(content);
                }
            }

            for (const el of observed) {
                if (!next.has(el)) {
                    ro.unobserve(el);
                    observed.delete(el);
                }
            }

            for (const el of next) {
                if (observed.has(el)) {
                    continue;
                }

                observed.add(el);
                ro.observe(el);
            }
        };

        watch();

        for (const source of [verticalSource, horizontalSource]) {
            const el = source?.getObserveElement?.();

            if (el && !ports.includes(el)) {
                ports.push(el);
            }
        }

        const mo =
            typeof MutationObserver === 'undefined'
                ? null
                : new MutationObserver(() => {
                      watch();
                      draw();
                  });

        for (const el of ports) {
            mo?.observe(el, { childList: true });
        }

        if (observed.size === 0) {
            ro.disconnect();
            mo?.disconnect();

            return;
        }

        return () => {
            ro.disconnect();
            mo?.disconnect();
        };
    }, [draw, sourceKey, verticalSource, horizontalSource]);

    useEffect(() => {
        const disposers: Array<() => void> = [];
        const subscribedElements = new Set<Element>();

        let frame = 0;
        const onChange = () => {
            draw();
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => draw());
        };

        for (const source of [verticalSource, horizontalSource]) {
            if (!source?.subscribe) {
                continue;
            }

            // Same DOM node → one scroll listener (both axes on one element).
            const el = source.getObserveElement?.();

            if (el) {
                if (subscribedElements.has(el)) {
                    continue;
                }

                subscribedElements.add(el);
            }

            disposers.push(source.subscribe(onChange));
        }

        return () => {
            cancelAnimationFrame(frame);
            disposers.forEach(dispose => dispose());
            dragMetaRef.current = null;
        };
    }, [draw, sourceKey, verticalSource, horizontalSource]);

    return {
        rootRef,
        edgesRef,
        setScrollbarV,
        setScrollbarH,
        redraw: draw,
        handlePointerDown,
        rootPointerHandlers,
    };
}
