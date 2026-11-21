import { normalizeWheelDelta } from '@clowdy/lib';
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';

import { dragStep, IDLE, isArmed, progressOf, releaseStep, sidewaysRoom, SWIPE, wheelStep, type SwipeState } from './swipeReply';

export interface SwipeReplyOptions {
    /** Off, the hook does nothing: the setting is off, or the message has no Reply. */
    enabled: boolean;
    /** The swipe was let go far enough: Reply to the message. */
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
 * Swipe a message to reply: a long sideways scroll of the trackpad to the left over the message (wheel events that go mostly sideways), or a sideways drag of a
 * finger or a pen to the left, pulls the message along with resistance and shows a Reply mark at the side it left, which takes its full look once the pull is
 * far enough. Reply is for the end of the swipe, never for the middle of it: the pointer is let go, or the wheel goes quiet (a wheel has no end event, and the
 * inertia a trackpad keeps sending after the fingers left counts as part of the swipe), and the message is held past the threshold at that moment. A pull taken
 * back below it replies to nothing. The message then settles back. A mouse drag is left alone, since it selects text, and so is a swipe to the right, everything
 * that goes mostly up or down, and whatever a code block or table inside the message can still scroll sideways. The decisions are in `swipeReply.ts`; this puts
 * them on the page: native listeners on the returned element (React's wheel listener is passive and cannot cancel the event), the pull as the element's own
 * `translate` (an entry animation owns its `transform`), `--swipe-progress`, `data-swipe` (`left`) and `data-swipe-armed` for the Reply mark. The settle is not
 * animated for a person who asked for reduced motion.
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

        const draw = (pulled: SwipeState, pointerY = 0) => {
            const { offset } = pulled;
            const pulling = pulled.phase === 'pulling';
            const settle = offset === 0 && shown !== 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

            // The mark stands at the height of the pointer, where the swipe is: the middle of a tall answer can be out of view. Measured once, as the pull starts.
            if (offset !== 0 && shown === 0) {
                const { top, height } = message.getBoundingClientRect();

                message.style.setProperty('--swipe-y', `${ Math.max(MARK_HALF, Math.min(pointerY - top, height - MARK_HALF)) }px`);
            }

            // A settle animates, a pull follows the fingers at once.
            message.style.transition = settle ? `translate ${ SETTLE_MS }ms cubic-bezier(0.22, 1, 0.36, 1)` : '';
            message.style.translate = offset === 0 ? '' : `${ offset }px 0`;
            message.style.setProperty('--swipe-progress', String(pulling ? progressOf(pulled.x) : 0));
            // Armed: letting go now replies. The mark says so, and takes it back when the pull is.
            message.toggleAttribute('data-swipe-armed', pulling && isArmed(pulled.x));

            if (offset !== 0) message.dataset.swipe = 'left';

            shown = offset;
        };

        /** The swipe is over, the pointer let go or the wheel gone quiet: Reply when it is held past the threshold (never after a cancel), and the message settles back. */
        const end = (release: boolean) => {
            clearTimeout(idle);

            const released = release ? releaseStep(state) : { state: IDLE, fire: false };

            state = released.state;
            draw(IDLE);

            if (released.fire) reply();
        };

        const follow = (next: SwipeState, pointerY: number) => {
            state = next;

            // A pull is drawn at every event (it may be the armed mark that changes, not the offset); a gesture that is not ours draws nothing.
            if (next.phase === 'pulling' || shown !== 0) draw(next, pointerY);
        };

        const onWheel = (event: WheelEvent) => {
            // A pinch is a wheel with Ctrl held, and Shift turns a mouse wheel into a sideways scroll: neither is a swipe.
            if (event.ctrlKey || event.shiftKey) return;

            // When the event happened, not when it is handled: a page that was busy for a while handles events that came a few ms apart late, and that is no pause
            // of the fingers (it would end the swipe, and reply, while they still move).
            const at = event.timeStamp;

            // The wheel went quiet before this event and its timer has not run yet (a page that is busy takes input first): that swipe ends here, with its Reply.
            if (state.phase !== 'idle' && at - state.at > SWIPE.idleMs) end(true);

            const { dx, dy } = normalizeWheelDelta({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode });
            // The wheel reports where the content would go; the message goes where the fingers do.
            const result = wheelStep(state, { dx: -dx, dy: -dy, at, scrolls: pull => scrollerBelow(event.target, message, pull) });

            follow(result.state, event.clientY);

            if (result.claim) {
                event.preventDefault();
                event.stopPropagation();
            }

            // A wheel has no end event: the swipe is over once it goes quiet.
            clearTimeout(idle);

            if (result.state.phase === 'pulling') idle = setTimeout(() => end(true), SWIPE.idleMs);
        };

        const onPointerDown = (event: PointerEvent) => {
            // A mouse selects text with a drag; only fingers and pens swipe.
            if (event.pointerType === 'mouse' || !event.isPrimary || drag) return;

            // A wheel swipe still in its quiet time ends here, without a Reply: its timer would otherwise run in the middle of this drag and reply for it.
            if (state.phase !== 'idle') end(false);

            drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
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
            end(event.type === 'pointerup');
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
            message.removeAttribute('data-swipe-armed');
            delete message.dataset.swipe;
        };
    }, [enabled]);

    return ref;
}
