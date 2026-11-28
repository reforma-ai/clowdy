import { SwipeTracker } from './swipeTracker';

import type { NativeScrollRecord } from '../../shared/bridge';

export interface SwipeHandlers {
    /** A sideways pull begins. Returns where it starts from (px), so it can pick up content mid-animation. */
    start: () => number;
    move: (x: number) => void;
    /** The fingers let go, `velocity` in px/ms at that moment. */
    release: (x: number, velocity: number) => void;
    /** The gesture was interrupted: the content goes back. */
    cancel: () => void;
}

const OVERLAY =
    '[role="dialog"], [role="alertdialog"], [role="menu"], [data-modal-overlay], [data-modal-clickout-layer]';

/** An unphased wheel has ended when it has been quiet this long (ms). */
const WHEEL_QUIET = 180;

/** After an unphased wheel swipe, its inertia keeps arriving as wheel events and is swallowed until quiet this long (ms). */
const WHEEL_TAIL = 400;

/** Wheel events stay cancelled this long (ms) after the last native record of a claimed gesture or its momentum. */
const SWALLOW_TAIL = 250;

/** Points per line of a coarse AppKit wheel, as Chromium counts it. */
const COARSE_LINE = 40;

function scrollsSideways(target: EventTarget | null, root: HTMLElement, pull: number): boolean {
    for (let child = target instanceof Element ? target : null; child && child !== root; child = child.parentElement) {
        const overflow = getComputedStyle(child).overflowX;
        if (
            (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') &&
            child.scrollWidth > child.clientWidth + 1 &&
            (pull > 0 ? child.scrollLeft > 1 : child.scrollLeft + child.clientWidth < child.scrollWidth - 1)
        )
            return true;
    }
    return false;
}

/** CSS pixels per native point: Chromium's page zoom. */
function zoom(): number {
    return window.innerWidth > 0 && window.outerWidth > 0 ? window.outerWidth / window.innerWidth : 1;
}

/**
 * A sideways swipe over `node`, from a trackpad, a Magic Mouse, a wheel or a finger.
 *
 * On macOS the shell forwards every AppKit scroll event with its phase, in order. The swipe follows that stream alone:
 * it starts with the phase Began over `node`, follows its deltas, and ends exactly when the fingers lift (Ended), so a
 * short flick is measured by its speed and the momentum after it never moves the content. DOM wheel events only get
 * cancelled while a claimed gesture or its momentum runs, so nothing underneath scrolls. Each new gesture starts fresh,
 * even while the previous one is still animating. Without the shell's stream (Windows, an older shell), DOM wheels drive
 * the swipe and it ends when they go quiet.
 */
export function attachHorizontalSwipe(node: HTMLElement, handlers: SwipeHandlers) {
    const bridge = window.desktop?.nativeScroll;
    const native = Boolean(bridge?.available);
    let tracker: SwipeTracker | null = null;
    let source: 'native' | 'wheel' | 'touch' | null = null;
    let origin: EventTarget | null = null;
    let started = false;
    let swallow = false;
    let swallowTimer: ReturnType<typeof setTimeout> | undefined;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    let wheelTail = false;
    let wheelTailTimer: ReturnType<typeof setTimeout> | undefined;
    let touch = { x: 0, y: 0 };

    const reset = () => {
        clearTimeout(wheelTimer);
        tracker = null;
        source = null;
        origin = null;
        started = false;
    };
    const abort = () => {
        const claimed = started;
        reset();
        if (claimed) handlers.cancel();
    };
    const release = (t: number) => {
        if (!tracker || !started) return reset();
        const { x } = tracker;
        const velocity = tracker.velocity(t);
        reset();
        handlers.release(x, velocity);
    };
    const holdSwallow = () => {
        swallow = true;
        clearTimeout(swallowTimer);
        swallowTimer = setTimeout(() => {
            swallow = false;
        }, SWALLOW_TAIL);
    };
    const stopSwallow = () => {
        swallow = false;
        clearTimeout(swallowTimer);
    };
    /** Feeds a movement in the direction the content should follow. Returns whether the swipe owns it. */
    const step = (dx: number, dy: number, t: number): boolean => {
        if (!tracker) return false;
        const before = tracker.axis;
        const axis = tracker.move(dx, dy, t);
        if (axis !== 'horizontal') return false;
        if (before === 'pending') {
            if (scrollsSideways(origin, node, tracker.x)) {
                tracker.axis = 'vertical';
                return false;
            }
            started = true;
            tracker.shift(handlers.start());
        }
        handlers.move(tracker.x);
        return true;
    };
    const overlayOpen = () => Boolean(document.querySelector(OVERLAY));

    const endWheel = (t: number) => {
        if (source !== 'wheel') return;
        const claimed = started;
        release(t);
        if (!claimed) return;
        wheelTail = true;
        clearTimeout(wheelTailTimer);
        wheelTailTimer = setTimeout(() => {
            wheelTail = false;
        }, WHEEL_TAIL);
    };
    /** An unphased wheel: a mouse, or a Windows touchpad. Returns whether the swipe owns the event. */
    const wheelInput = (dx: number, dy: number, t: number, target: EventTarget | null): boolean => {
        if (wheelTail) {
            if (Math.abs(dx) <= Math.abs(dy)) return false;
            clearTimeout(wheelTailTimer);
            wheelTailTimer = setTimeout(() => {
                wheelTail = false;
            }, WHEEL_TAIL);
            return true;
        }
        if (source && source !== 'wheel') return false;
        if (!tracker) {
            if (overlayOpen()) return false;
            tracker = new SwipeTracker();
            source = 'wheel';
            origin = target;
        }
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => endWheel(t), WHEEL_QUIET);
        return step(-dx, -dy, t);
    };

    const receive = (record: NativeScrollRecord) => {
        if (record.kind === 'cancel') {
            stopSwallow();
            return abort();
        }
        const scale = record.precise ? 1 / zoom() : COARSE_LINE / zoom();
        const dx = record.deltaX * scale;
        const dy = record.deltaY * scale;
        if (!record.phase && !record.momentumPhase) {
            if (source === 'native') abort();
            const target = document.elementFromPoint?.(record.x / zoom(), record.y / zoom()) ?? null;
            if (source === 'wheel' || (target && node.contains(target))) {
                if (wheelInput(dx, dy, record.timestamp, target)) holdSwallow();
                else if (!wheelTail) stopSwallow();
            }
            return;
        }
        if (record.momentumPhase) {
            if (!swallow) return;
            if (record.momentumPhase & 8) stopSwallow();
            else holdSwallow();
            return;
        }
        if (record.phase & (1 | 32)) {
            // A new touch on the trackpad: whatever came before is over.
            if (source) abort();
            stopSwallow();
        }
        if (record.phase & 1) {
            const target = document.elementFromPoint?.(record.x / zoom(), record.y / zoom()) ?? null;
            if (!target || !node.contains(target) || overlayOpen()) return;
            tracker = new SwipeTracker();
            source = 'native';
            origin = target;
        }
        if (source !== 'native') return;
        if (record.phase & (1 | 4) && step(-dx, -dy, record.timestamp)) holdSwallow();
        if (record.phase & 8) {
            if (started) holdSwallow();
            release(record.timestamp);
        } else if (record.phase & 16) abort();
    };

    // Native records drive the swipe; DOM wheels are only cancelled while it owns the gesture.
    const captureWheel = (event: WheelEvent) => {
        if (!swallow) return;
        event.preventDefault();
        event.stopPropagation();
    };
    const domWheel = (event: WheelEvent) => {
        if (event.ctrlKey || event.shiftKey || event.defaultPrevented || (!event.deltaX && !event.deltaY)) return;
        const scale =
            event.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? 16
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                  ? node.clientWidth || 270
                  : 1;
        if (wheelInput(event.deltaX * scale, event.deltaY * scale, event.timeStamp, event.target))
            event.preventDefault();
    };

    const touchStart = (event: TouchEvent) => {
        if (event.touches.length !== 1) {
            if (source === 'touch') abort();
            return;
        }
        if (source) return;
        if (overlayOpen()) return;
        tracker = new SwipeTracker(0, 8);
        source = 'touch';
        origin = event.target;
        touch = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const touchMove = (event: TouchEvent) => {
        if (source !== 'touch') return;
        if (event.touches.length !== 1) return abort();
        const { clientX, clientY } = event.touches[0];
        const owned = step(clientX - touch.x, clientY - touch.y, event.timeStamp);
        touch = { x: clientX, y: clientY };
        if (owned) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => {
        if (source !== 'touch') return;
        if (event.touches.length) abort();
        else release(event.timeStamp);
    };
    const touchCancel = () => {
        if (source === 'touch') abort();
    };
    const blur = () => {
        stopSwallow();
        clearTimeout(wheelTailTimer);
        wheelTail = false;
        abort();
    };

    const unsubscribe = native && bridge ? bridge.subscribe(receive) : undefined;
    if (native) window.addEventListener('wheel', captureWheel, { capture: true, passive: false });
    else node.addEventListener('wheel', domWheel, { passive: false });
    node.addEventListener('touchstart', touchStart, { passive: true });
    node.addEventListener('touchmove', touchMove, { passive: false });
    node.addEventListener('touchend', touchEnd);
    node.addEventListener('touchcancel', touchCancel);
    window.addEventListener('blur', blur);

    return {
        /** Interrupts a running gesture, as a resize of the area does. */
        cancel: abort,
        dispose() {
            reset();
            stopSwallow();
            clearTimeout(wheelTailTimer);
            unsubscribe?.();
            window.removeEventListener('wheel', captureWheel, { capture: true });
            node.removeEventListener('wheel', domWheel);
            node.removeEventListener('touchstart', touchStart);
            node.removeEventListener('touchmove', touchMove);
            node.removeEventListener('touchend', touchEnd);
            node.removeEventListener('touchcancel', touchCancel);
            window.removeEventListener('blur', blur);
        },
    };
}
