import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { RefCallback } from 'react';

export type StickToBottomAnimation = 'instant' | 'smooth';

export type StickToBottomOptions = {
    /** Pause auto-stick without detaching refs. @default true */
    enabled?: boolean;
    /** Distance from bottom (px) counted as “at bottom”. @default 50 */
    threshold?: number;
    /** Scroll on first attach. @default 'instant' */
    initial?: StickToBottomAnimation | false;
    /** Scroll on content / viewport resize while stuck. @default 'instant' */
    resize?: StickToBottomAnimation;
};

export type ScrollToBottomOptions = { animation?: StickToBottomAnimation };

export type StickToBottomInstance = {
    scrollRef: RefCallback<HTMLElement | null>;
    /** Inner wrapper that grows with content (needed for ResizeObserver). */
    contentRef: RefCallback<HTMLElement | null>;
    isAtBottom: boolean;
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
    scrollToBottom: (options?: ScrollToBottomOptions) => void;
    stopScroll: () => void;
};

const DEFAULT_THRESHOLD = 50;
const EPS = 1;
/** Unlocked + near-bottom: ignore subpixel / sibling-layout jitter, still catch stream growth. */
const RELOCK_GROWTH_PX = 8;
/** Cover multi-frame layout (phase peek collapse + React commit) before scroll unlock. */
const RESIZE_IGNORE_MS = 120;
const SMOOTH_MS = 800;
const UNLOCK_KEYS = new Set(['ArrowUp', 'PageUp', 'Home']);
const LOCK_KEYS = new Set(['ArrowDown', 'PageDown', 'End']);

type StickRuntime = {
    options: StickToBottomOptions;
    scroll: HTMLElement | null;
    content: HTMLElement | null;
    stuck: boolean;
    enabled: boolean;
    programmatic: boolean;
    didInitial: boolean;
    lastScrollTop: number;
    lastScrollHeight: number;
    lastTouchY: number | null;
    ignoreScrollUntil: number;
    releaseTimer: ReturnType<typeof setTimeout> | null;
    resizeObserver: ResizeObserver | null;
    listeners: AbortController | null;
    setIsAtBottom: (value: boolean) => void;
    setEnabledState: (value: boolean) => void;
};

function distanceFromBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function thresholdOf(rt: StickRuntime) {
    return rt.options.threshold ?? DEFAULT_THRESHOLD;
}

function syncUi(rt: StickRuntime, atBottom: boolean) {
    if (rt.scroll) {
        rt.scroll.dataset.stickAtBottom = String(atBottom);
    }

    rt.setIsAtBottom(atBottom);
}

function clearProgrammatic(rt: StickRuntime) {
    if (rt.releaseTimer != null) {
        clearTimeout(rt.releaseTimer);
        rt.releaseTimer = null;
    }

    rt.programmatic = false;
}

function unlock(rt: StickRuntime) {
    if (!rt.enabled || !rt.stuck) {
        return;
    }

    clearProgrammatic(rt);
    rt.stuck = false;
    syncUi(rt, rt.scroll ? distanceFromBottom(rt.scroll) <= thresholdOf(rt) : false);
}

function lock(rt: StickRuntime) {
    if (!rt.enabled || !rt.scroll || distanceFromBottom(rt.scroll) > thresholdOf(rt)) {
        return;
    }

    rt.stuck = true;
    syncUi(rt, true);
}

function pin(rt: StickRuntime, el: HTMLElement, animation: StickToBottomAnimation) {
    if (distanceFromBottom(el) <= EPS) {
        rt.lastScrollTop = el.scrollTop;
        rt.lastScrollHeight = el.scrollHeight;
        syncUi(rt, true);

        return;
    }

    clearProgrammatic(rt);
    rt.programmatic = true;

    const finish = () => {
        rt.releaseTimer = null;
        rt.programmatic = false;

        if (rt.scroll) {
            syncUi(rt, distanceFromBottom(rt.scroll) <= thresholdOf(rt));
        }
    };

    if (animation === 'instant') {
        el.scrollTop = el.scrollHeight;
        rt.lastScrollTop = el.scrollTop;
        rt.lastScrollHeight = el.scrollHeight;
        rt.releaseTimer = setTimeout(finish, 0);

        return;
    }

    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    rt.lastScrollTop = el.scrollTop;
    rt.lastScrollHeight = el.scrollHeight;
    rt.releaseTimer = setTimeout(finish, SMOOTH_MS);
}

function bindResizeObserver(rt: StickRuntime) {
    rt.resizeObserver?.disconnect();
    rt.resizeObserver = null;

    if (!rt.scroll || typeof ResizeObserver === 'undefined') {
        return;
    }

    const observer = new ResizeObserver(() => {
        const el = rt.scroll;

        if (!el) {
            return;
        }

        const prevHeight = rt.lastScrollHeight;
        const nextHeight = el.scrollHeight;
        const grew = nextHeight > prevHeight + RELOCK_GROWTH_PX;

        rt.lastScrollHeight = nextHeight;
        const atBottom = distanceFromBottom(el) <= thresholdOf(rt);

        if (!rt.enabled) {
            syncUi(rt, atBottom);

            return;
        }

        if (rt.stuck) {
            rt.ignoreScrollUntil = performance.now() + RESIZE_IGNORE_MS;
            pin(rt, el, rt.options.resize ?? 'instant');

            return;
        }

        // Soft unlock can leave us within threshold. Follow real growth (stream),
        // not same-size ResizeObserver noise that used to yank a 20px scroll-up.
        if (atBottom && grew) {
            rt.stuck = true;
            rt.ignoreScrollUntil = performance.now() + RESIZE_IGNORE_MS;
            pin(rt, el, rt.options.resize ?? 'instant');

            return;
        }

        syncUi(rt, atBottom);
    });

    observer.observe(rt.scroll);

    if (rt.content) {
        observer.observe(rt.content);
    }

    rt.resizeObserver = observer;
}

function detachListeners(rt: StickRuntime) {
    rt.listeners?.abort();
    rt.listeners = null;
}

/** Composer sits beside the chat port, not inside it. Collapsed-caret delete still
 *  native-reveals into this scrollport (~line-height). Range delete (Cmd+A) does not. */
function isForeignContentEditable(scroll: HTMLElement) {
    const active = document.activeElement;

    return active instanceof HTMLElement && active.isContentEditable && !scroll.contains(active);
}

function attachListeners(rt: StickRuntime, node: HTMLElement) {
    detachListeners(rt);

    const controller = new AbortController();
    const { signal } = controller;
    const passive = { passive: true, signal } as const;

    node.addEventListener(
        'scroll',
        () => {
            if (!rt.scroll || rt.programmatic) {
                return;
            }

            const el = rt.scroll;
            const { scrollTop, scrollHeight } = el;
            const scrollingUp = scrollTop < rt.lastScrollTop - EPS;
            const scrollingDown = scrollTop > rt.lastScrollTop + EPS;
            // Browser clamps scrollTop when content shrinks — often before ResizeObserver.
            // That looks like a user scroll-up and used to unlock stick (chat jumps up; new
            // layout settles below the viewport).
            const contentShrunk = scrollHeight < rt.lastScrollHeight - EPS;

            rt.lastScrollTop = scrollTop;
            rt.lastScrollHeight = scrollHeight;

            const atBottom = distanceFromBottom(el) <= thresholdOf(rt);
            const settling = performance.now() < rt.ignoreScrollUntil;

            syncUi(rt, atBottom);

            if (!rt.enabled) {
                rt.stuck = false;

                return;
            }

            if (contentShrunk) {
                if (rt.stuck) {
                    rt.ignoreScrollUntil = performance.now() + RESIZE_IGNORE_MS;
                    pin(rt, el, rt.options.resize ?? 'instant');
                }

                return;
            }

            // Soft trackpad unlock must not re-lock just because still within threshold.
            if (rt.stuck && scrollingUp && !settling) {
                if (isForeignContentEditable(el)) {
                    pin(rt, el, rt.options.resize ?? 'instant');

                    return;
                }

                rt.stuck = false;
            } else if (!rt.stuck && scrollingDown && atBottom && !settling) {
                rt.stuck = true;
            }
        },
        passive
    );

    node.addEventListener(
        'wheel',
        event => {
            if (event.deltaY < 0) {
                unlock(rt);
            } else if (event.deltaY > 0) {
                lock(rt);
            }
        },
        passive
    );

    node.addEventListener(
        'touchstart',
        event => {
            rt.lastTouchY = event.touches[0]?.clientY ?? null;
        },
        passive
    );

    node.addEventListener(
        'touchmove',
        event => {
            const y = event.touches[0]?.clientY;

            if (y == null || rt.lastTouchY == null) {
                return;
            }

            const dy = y - rt.lastTouchY;

            if (dy > EPS) {
                unlock(rt);
            } else if (dy < -EPS) {
                lock(rt);
            }

            rt.lastTouchY = y;
        },
        passive
    );

    const clearTouch = () => {
        rt.lastTouchY = null;
    };

    node.addEventListener('touchend', clearTouch, passive);
    node.addEventListener('touchcancel', clearTouch, passive);

    node.addEventListener(
        'keydown',
        event => {
            if (UNLOCK_KEYS.has(event.key)) {
                unlock(rt);
            } else if (LOCK_KEYS.has(event.key)) {
                lock(rt);
            }
        },
        { signal }
    );

    rt.listeners = controller;
}

/**
 * Stick a scrollport to the bottom while locked.
 * Unlock via gestures (wheel / touch / keys / scroll-up). Resize never unlocks.
 * Caret-reveal from a sibling contenteditable (chat composer) does not unlock.
 * After a soft unlock, only content growth past `RELOCK_GROWTH_PX` re-locks
 * while still within `threshold` — same-size / shrink jitter does not yank.
 */
export function useStickToBottom(options: StickToBottomOptions = {}): StickToBottomInstance {
    const [isAtBottom, setIsAtBottom] = useState(true);
    const [enabled, setEnabledState] = useState(options.enabled !== false);
    const rtRef = useRef<StickRuntime | null>(null);

    if (!rtRef.current) {
        rtRef.current = {
            options,
            scroll: null,
            content: null,
            stuck: true,
            enabled: options.enabled !== false,
            programmatic: false,
            didInitial: false,
            lastScrollTop: 0,
            lastScrollHeight: 0,
            lastTouchY: null,
            ignoreScrollUntil: 0,
            releaseTimer: null,
            resizeObserver: null,
            listeners: null,
            setIsAtBottom: value => setIsAtBottom(prev => (prev === value ? prev : value)),
            setEnabledState: value => setEnabledState(prev => (prev === value ? prev : value)),
        };
    }

    const rt = rtRef.current;

    rt.options = options;
    rt.setIsAtBottom = value => setIsAtBottom(prev => (prev === value ? prev : value));
    rt.setEnabledState = value => setEnabledState(prev => (prev === value ? prev : value));

    const setEnabled = useCallback((next: boolean) => {
        const state = rtRef.current!;

        state.enabled = next;
        state.setEnabledState(next);

        if (!next) {
            state.stuck = false;

            if (state.scroll) {
                syncUi(state, distanceFromBottom(state.scroll) <= thresholdOf(state));
            }

            return;
        }

        if (state.scroll) {
            const atBottom = distanceFromBottom(state.scroll) <= thresholdOf(state);

            state.stuck = atBottom;
            syncUi(state, atBottom);
        }
    }, []);

    useEffect(() => {
        if (options.enabled === undefined || rtRef.current!.enabled === options.enabled) {
            return;
        }

        setEnabled(options.enabled);
    }, [options.enabled, setEnabled]);

    const scrollToBottom = useCallback((scrollOptions: ScrollToBottomOptions = {}) => {
        const state = rtRef.current!;

        state.enabled = true;
        state.setEnabledState(true);
        state.stuck = true;
        syncUi(state, true);

        if (state.scroll) {
            pin(state, state.scroll, scrollOptions.animation ?? 'smooth');
        }
    }, []);

    const stopScroll = useCallback(() => {
        const state = rtRef.current!;

        clearProgrammatic(state);
        state.stuck = false;

        if (!state.scroll) {
            syncUi(state, false);

            return;
        }

        state.scroll.scrollTo({ top: state.scroll.scrollTop, behavior: 'auto' });
        syncUi(state, distanceFromBottom(state.scroll) <= thresholdOf(state));
    }, []);

    const scrollRef = useCallback<RefCallback<HTMLElement | null>>(node => {
        const state = rtRef.current!;

        detachListeners(state);
        state.scroll = node;

        if (!node) {
            state.didInitial = false;
            state.resizeObserver?.disconnect();
            state.resizeObserver = null;

            return;
        }

        attachListeners(state, node);
        state.lastScrollTop = node.scrollTop;
        state.lastScrollHeight = node.scrollHeight;

        if (!state.didInitial) {
            state.didInitial = true;
            const { initial = 'instant' } = state.options;

            if (initial !== false && state.enabled) {
                state.stuck = true;
                pin(state, node, initial);
            } else {
                const atBottom = distanceFromBottom(node) <= thresholdOf(state);

                state.stuck = atBottom;
                syncUi(state, atBottom);
            }
        } else {
            syncUi(state, distanceFromBottom(node) <= thresholdOf(state));
        }

        bindResizeObserver(state);
    }, []);

    const contentRef = useCallback<RefCallback<HTMLElement | null>>(node => {
        const state = rtRef.current!;

        state.content = node;
        bindResizeObserver(state);
    }, []);

    useEffect(
        () => () => {
            const state = rtRef.current!;

            clearProgrammatic(state);
            detachListeners(state);
            state.resizeObserver?.disconnect();
            state.resizeObserver = null;
        },
        []
    );

    return useMemo(
        () => ({ scrollRef, contentRef, isAtBottom, enabled, setEnabled, scrollToBottom, stopScroll }),
        [contentRef, enabled, isAtBottom, scrollRef, scrollToBottom, setEnabled, stopScroll]
    );
}
