import { cn, mergeRefs } from '@clowdy/lib';
import { useCallback, useMemo, useRef } from 'react';

import { useStickToBottom } from '../hooks/useStickToBottom';
import { filterSlots } from '../Slot';
import styles from './Scrollable.module.css';
import { ScrollChromeBars } from './ScrollChromeBars';
import { ScrollChromeRoot } from './ScrollChromeRoot';
import { ScrollContainer } from './ScrollContainer';
import { elementScrollAxisSource } from './scrollAxisSource';
import { ScrollableContext } from './scrollable-context';
import { useScrollChrome } from './useScrollChrome';

import type { HTMLAttributes, ReactNode, Ref } from 'react';
import type { StickToBottomOptions } from '../hooks/useStickToBottom';
import type { ScrollableContextValue } from './scrollable-context';

/** `slot` value for children rendered in the overlay layer (with {@link useScrollable}), same pattern as {@link filterSlots}. */
export const SCROLLABLE_OVERLAY_SLOT = 'overlay';

export type ScrollableProps = {
    children?: React.ReactNode;

    ref?: Ref<HTMLDivElement | null>;
    containerRef?: Ref<HTMLDivElement | null>;
    contentRef?: Ref<HTMLDivElement | null>;

    className?: string;
    containerClass?: string;
    contentClass?: string;

    /**
     * Optional overlay region after the scroll container, inside `useScrollable` context.
     * Prefer a child with `slot={SCROLLABLE_OVERLAY_SLOT}` (see {@link filterSlots}); this prop overrides that slot when set.
     */
    overlay?: React.ReactNode;
    onScroll?: (e: Event) => void;
    alwaysShowScrollbar?: boolean;
    /**
     * Painted thumb. `false` keeps wheel scrolling and `edgeFade`, and draws no thumb.
     */
    scrollbar?: boolean;
    vertical?: boolean;
    horizontal?: boolean;
    gap?: number;
    /**
     * Stick-to-bottom for the scrollport.
     * The hook always mounts; refs are always attached. Activity is controlled by `enabled`:
     * - `false` — inert (`enabled: false`), `useScrollable().stickToBottom` is `null`
     * - `true` / options — active; pause with `enabled: false` or `setEnabled(false)` without tearing down refs
     */
    stickToBottom?: boolean | StickToBottomOptions;
    edgeFade?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onScroll'>;

/**
 * Custom scroll container with optional stick-to-bottom.
 *
 * The **root** element exposes scroll-edge hints when the corresponding axis is enabled:
 * - Vertical: `data-scroll-v-start`, `data-scroll-v-end` (near top / bottom).
 * - Horizontal: `data-scroll-h-start`, `data-scroll-h-end` (near left / right).
 * Values are booleans in React; in the DOM they appear as `"true"` / `"false"`.
 * The same flags are available from {@link useScrollable}.
 * Overlay UI: pass a child with `slot={SCROLLABLE_OVERLAY_SLOT}`, or use the `overlay` prop.
 */
export function Scrollable({
    ref: userRef,
    children,
    className,
    containerClass,
    contentClass,
    containerRef,
    contentRef,
    overlay,
    onScroll,
    alwaysShowScrollbar,
    scrollbar = true,
    vertical,
    horizontal,
    gap = 0,
    stickToBottom = false,
    edgeFade = false,
    ...attrs
}: ScrollableProps) {
    const overlayFromSlot = useMemo((): ReactNode => filterSlots(children, SCROLLABLE_OVERLAY_SLOT), [children]);

    const scrollChildren = useMemo(
        (): ReactNode => filterSlots(children, slot => slot !== SCROLLABLE_OVERLAY_SLOT, null),
        [children]
    );

    const overlayResolved = overlay ?? overlayFromSlot;

    const scrollContainerRef = useRef<HTMLDivElement>(null);

    const getScrollElement = useCallback(() => scrollContainerRef.current, []);

    const isVerticalEnabled = vertical ?? true;
    const isHorizontalEnabled = horizontal ?? false;

    const verticalSource = useMemo(
        // The getter is stored and called from effects, not during render.
        // eslint-disable-next-line react-hooks/refs -- elementScrollAxisSource does not read `.current` now
        () => (isVerticalEnabled ? elementScrollAxisSource(getScrollElement, 'vertical') : null),
        [getScrollElement, isVerticalEnabled]
    );

    const horizontalSource = useMemo(
        // eslint-disable-next-line react-hooks/refs -- elementScrollAxisSource does not read `.current` now
        () => (isHorizontalEnabled ? elementScrollAxisSource(getScrollElement, 'horizontal') : null),
        [getScrollElement, isHorizontalEnabled]
    );

    const chrome = useScrollChrome({
        verticalSource,
        horizontalSource,
        gap,
        alwaysShowScrollbar,
    });

    // Hook always runs (Rules of Hooks). Behavior is gated by `enabled`, not by omitting refs:
    // - `false` → enabled: false (inert listeners, no pin, context null)
    // - `true` / options → active (options.enabled can still pause at runtime)
    const stickConfigured = stickToBottom !== false;
    const stickToBottomHookOptions = useMemo((): StickToBottomOptions => {
        if (!stickConfigured) {
            return { enabled: false, initial: false };
        }

        if (typeof stickToBottom === 'object' && stickToBottom !== null) {
            return {
                resize: 'instant',
                ...stickToBottom,
                enabled: stickToBottom.enabled !== false,
            };
        }

        return { enabled: true, initial: 'instant', resize: 'instant' };
    }, [stickConfigured, stickToBottom]);

    const stickToBottomInstance = useStickToBottom(stickToBottomHookOptions);
    const { scrollRef: stickScrollRef, contentRef: stickContentRef } = stickToBottomInstance;

    const { edgesRef } = chrome;

    const scrollToTop = useCallback(() => {
        const el = scrollContainerRef.current;

        if (el) {
            el.scrollTop = 0;
        }
    }, []);

    const scrollableContextValue = useMemo<ScrollableContextValue>(
        () => ({
            stickToBottom: stickConfigured ? stickToBottomInstance : null,
            scrollToTop,
            get atVerticalStart() {
                return edgesRef.current.atVerticalStart;
            },
            get atVerticalEnd() {
                return edgesRef.current.atVerticalEnd;
            },
            get atHorizontalStart() {
                return edgesRef.current.atHorizontalStart;
            },
            get atHorizontalEnd() {
                return edgesRef.current.atHorizontalEnd;
            },
        }),
        [edgesRef, scrollToTop, stickConfigured, stickToBottomInstance]
    );

    // mergeRefs() returns a new callback every call — memoize so React does not
    // detach/reattach stick listeners on every parent render (e.g. isAtBottom flips).
    const containerMergedRef = useMemo(
        () => mergeRefs<HTMLDivElement>(scrollContainerRef, containerRef, stickScrollRef),
        [containerRef, stickScrollRef]
    );

    const contentMergedRef = useMemo(
        () => mergeRefs<HTMLDivElement>(contentRef, stickContentRef),
        [contentRef, stickContentRef]
    );

    return (
        <ScrollableContext value={scrollableContextValue}>
            <ScrollChromeRoot
                {...(attrs as HTMLAttributes<HTMLDivElement>)}
                ref={userRef}
                rootRef={chrome.rootRef}
                className={className}
                vertical={isVerticalEnabled}
                horizontal={isHorizontalEnabled}
                edgeFade={edgeFade}
                rootPointerHandlers={chrome.rootPointerHandlers}
            >
                <ScrollContainer
                    ref={containerMergedRef}
                    contentRef={contentMergedRef}
                    containerClass={cn(stickConfigured && styles.containerStickToBottom, containerClass)}
                    contentClass={contentClass}
                    onScroll={
                        onScroll
                            ? e => {
                                  onScroll(e.nativeEvent);
                              }
                            : undefined
                    }
                >
                    {scrollChildren}
                </ScrollContainer>

                {scrollbar && (
                    <ScrollChromeBars
                        vertical={isVerticalEnabled}
                        horizontal={isHorizontalEnabled}
                        setScrollbarV={chrome.setScrollbarV}
                        setScrollbarH={chrome.setScrollbarH}
                        onPointerDown={chrome.handlePointerDown}
                    />
                )}

                {overlayResolved}
            </ScrollChromeRoot>
        </ScrollableContext>
    );
}
