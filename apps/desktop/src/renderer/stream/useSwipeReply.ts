import { normalizeWheelDelta } from '@clowdy/lib';
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';

import { dragStep, IDLE, releaseStep, sidewaysRoom, SWIPE, wheelStep, type SwipeState } from './swipeReply';

export interface SwipeReplyOptions {
    /** Off, the hook does nothing: the setting is off, or the message has no Reply. */
    enabled: boolean;
    /** The pull went far enough: Reply to the message. */
    onReply: () => void;
}

/** How long the message takes to settle back into place (ms). */
const SETTLE_MS = 200;

/** Half the height of the Reply mark (px): the mark stays this far inside the top and the bottom of its message. */
const MARK_HALF = 12;

/**
 * Whether an element between the one under the pointer and the message can still scroll sideways toward `pull`: a code block or a wide table keeps its own
 * swipe until it reaches its end. The message itself is not asked.
 */
function scrollerBelow(target: EventTarget | null, message: HTMLElement, pull: number): boolean {
    for (let node = target instanceof Element ? target : null; node && node !== message; node = node.parentElement) {
        const { overflowX } = getComputedStyle(node);

        if ((overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') && sidewaysRoom(node, pull)) return true;
    }

    return false;
}

/**
 * Swipe a message to reply: a sideways scroll of the trackpad over the message (wheel events that go mostly sideways), or a sideways drag of a finger or a pen,
 * pulls the message along with resistance, shows a Reply mark at the side it left, and replies once the pull is far enough; the message then settles back. A
 * mouse drag is left alone, since it selects text, and so is everything that goes mostly up or down, or that a code block or table inside the message can still
 * scroll sideways. The decisions are in `swipeReply.ts`; this puts them on the page: native listeners on the returned element (React's wheel listener is
 * passive and cannot cancel the event), the pull as the element's own `translate` (an entry animation owns its `transform`) and `--swipe-progress` and
 * `data-swipe` (`left`, `right`) for the Reply mark. The settle is not animated for a person who asked for reduced motion.
 */
export function useSwipeReply<T extends HTMLElement>({ enabled, onReply }: SwipeReplyOptions): RefObject<T | null> {
    const ref = useRef<T>(null);
    const reply = useEffectEvent(onReply);

    useEffect(() => {
        const message = ref.current;

        if (!enabled || !message) return;

        let state: SwipeState = IDLE;
        let idle: ReturnType<typeof setTimeout> | undefined;
        let drag: { pointerId: number; x: number; y: number } | undefined;
        // What the message shows now, to tell a pull from a settle.
        let shown = 0;

        const draw = (offset: number, pointerY = 0) => {
            const settle = offset === 0 && shown !== 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            // The mark stands at the height of the pointer, where the swipe is: the middle of a tall answer can be out of view. Measured once, as the pull starts.
            if (offset !== 0 && shown === 0) {
                const { top, height } = message.getBoundingClientRect();

                message.style.setProperty('--swipe-y', `${ Math.max(MARK_HALF, Math.min(pointerY - top, height - MARK_HALF)) }px`);
            }

            // A settle animates, a pull follows the fingers at once.
            message.style.transition = settle ? `translate ${ SETTLE_MS }ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
            message.style.translate = offset === 0 ? '' : `${ offset }px 0`;
            message.style.setProperty('--swipe-progress', String(Math.min(1, Math.abs(offset) / SWIPE.threshold)));

            if (offset !== 0) message.dataset.swipe = offset < 0 ? 'left' : 'right';

            shown = offset;
        };

        const settle = () => {
            clearTimeout(idle);
            state = IDLE;
            draw(0);
        };

        const follow = (next: SwipeState, pointerY: number) => {
            state = next;

            if (next.offset !== shown) draw(next.offset, pointerY);
        };

        const onWheel = (event: WheelEvent) => {
            // A pinch is a wheel with Ctrl held, and Shift turns a mouse wheel into a sideways scroll: neither is a swipe.
            if (event.ctrlKey || event.shiftKey) return;

            const { dx, dy } = normalizeWheelDelta({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode });
            // The wheel reports where the content would go; the message goes where the fingers do.
            const result = wheelStep(state, { dx: -dx, dy: -dy, at: performance.now(), scrolls: pull => scrollerBelow(event.target, message, pull) });

            follow(result.state, event.clientY);

            if (result.claim) {
                event.preventDefault();
                event.stopPropagation();
            }

            // A wheel has no end event: the pull settles once it goes quiet.
            clearTimeout(idle);

            if (result.state.phase === 'pulling') idle = setTimeout(settle, SWIPE.idleMs);

            if (result.fire) reply();
        };

        const onPointerDown = (event: PointerEvent) => {
            // A mouse selects text with a drag; only fingers and pens swipe.
            if (event.pointerType === 'mouse' || !event.isPrimary || drag) return;

            drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            state = IDLE;
        };

        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerId !== drag?.pointerId) return;

            const result = dragStep(state, {
                dx: event.clientX - drag.x,
                dy: event.clientY - drag.y,
                at: event.timeStamp,
                scrolls: pull => scrollerBelow(event.target, message, pull),
            });

            drag = { ...drag, x: event.clientX, y: event.clientY };

            if (result.claim && state.phase !== 'pulling') message.setPointerCapture(event.pointerId);

            follow(result.state, event.clientY);

            if (result.claim) event.preventDefault();
        };

        const onPointerEnd = (event: PointerEvent) => {
            if (event.pointerId !== drag?.pointerId) return;

            drag = undefined;

            // A cancel (the browser took the touch for a vertical scroll) replies to nothing, whatever the pull was.
            const released = event.type === 'pointerup' ? releaseStep(state) : { state: IDLE, fire: false };

            state = released.state;
            draw(0);

            if (released.fire) reply();
        };

        const touchAction = message.style.touchAction;

        // Vertical panning stays the browser's; the sideways drags come to us.
        message.style.touchAction = 'pan-y';
        message.addEventListener('wheel', onWheel, { passive: false });
        message.addEventListener('pointerdown', onPointerDown);
        message.addEventListener('pointermove', onPointerMove);
        message.addEventListener('pointerup', onPointerEnd);
        message.addEventListener('pointercancel', onPointerEnd);

        return () => {
            clearTimeout(idle);
            message.removeEventListener('wheel', onWheel);
            message.removeEventListener('pointerdown', onPointerDown);
            message.removeEventListener('pointermove', onPointerMove);
            message.removeEventListener('pointerup', onPointerEnd);
            message.removeEventListener('pointercancel', onPointerEnd);
            message.style.touchAction = touchAction;
            message.style.transition = '';
            message.style.translate = '';
            message.style.removeProperty('--swipe-progress');
            message.style.removeProperty('--swipe-y');
            delete message.dataset.swipe;
        };
    }, [enabled]);

    return ref;
}
