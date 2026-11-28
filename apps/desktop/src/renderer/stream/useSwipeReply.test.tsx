// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { AssistantMessage } from './AssistantMessage';
import { SWIPE } from './swipeReply';
import { UserBubble } from './UserBubble';

import type { MessageActionsConfig } from './MessageActions';

// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom; the message's own root is what is checked here.
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="rendered">{text}</div> }));
vi.mock('@clowdy/components/Toast', () => ({
    toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The swipe on a real message: wheel events (and pointer events of a finger) dispatched on the rendered row, the way a trackpad makes them. The decisions
 * themselves are tested in `swipeReply.test.ts`; this checks what the hook does with them on the page: what it moves, what it cancels, and when it replies.
 * A wheel has no end event, so a swipe ends when the timers say the wheel went quiet (`quiet`). The events carry the time they happened at, on a clock of the
 * test's own (`clock`), that moves 16 ms for each event, as a trackpad's does, and with the timers when time passes (`elapse`).
 */

let container: HTMLDivElement;
let root: Root;
let onReply: Mock<(text: string) => void>;

// The time (ms) the next wheel event happened at.
let clock: number;

const at = new Date(2025, 10, 19, 22, 54).getTime();
const TEXT = 'Make the title bigger';

const config = (extra: Partial<MessageActionsConfig> = {}): MessageActionsConfig => ({
    show: 'hover',
    onReply,
    swipeToReply: true,
    ...extra,
});
// `null` is a message with no row of actions at all (an `undefined` would take the default).
const person = (actions: MessageActionsConfig | null = config(), text = TEXT) => (
    <UserBubble text={text} at={at} turn="i-3" actions={actions ?? undefined} />
);

const draw = (element: React.ReactElement) => act(async () => root.render(element));
const row = () => container.querySelector<HTMLElement>('[data-message]')!;
const hint = () => row().querySelector(':scope > span[aria-hidden]');
const pulled = () => Number.parseFloat(row().style.translate);
const armed = () => row().hasAttribute('data-swipe-armed');

/** Time passes for `ms`: the timers run, and the next event comes that much later. */
const elapse = (ms: number) =>
    act(() => {
        clock += ms;
        vi.advanceTimersByTime(ms);
    });

/** The wheel goes quiet: the timer that ends a swipe runs. */
const quiet = () => elapse(SWIPE.idleMs + 1);

/** A wheel event on `target`; `deltaX` is where the content would scroll, as the browser reports it, so a positive one pulls the message to the left. */
function wheel(
    deltaX: number,
    deltaY = 0,
    target: Element = row(),
    init: WheelEventInit & { ctrlKey?: boolean; shiftKey?: boolean } = {}
) {
    const { ctrlKey, shiftKey, clientY, ...rest } = init;
    const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true, ...rest });

    // happy-dom's wheel event has no modifier keys or pointer position of its own, and stamps the real time, which is not the test's.
    Object.defineProperties(event, {
        ctrlKey: { value: ctrlKey ?? false },
        shiftKey: { value: shiftKey ?? false },
        clientY: { value: clientY ?? 0 },
        timeStamp: { value: clock },
    });

    target.dispatchEvent(event);
    clock += 16;

    return event;
}

/** A swipe of `count` events of `deltaX` each (positive: the fingers go left), with the events it made. */
const swipe = (count: number, deltaX = 10, target?: Element) =>
    Array.from({ length: count }, () => wheel(deltaX, 0, target));

/** The same swipe with the pointer at `clientY`. */
const swipeAt = (count: number, clientY: number) =>
    Array.from({ length: count }, () => wheel(10, 0, row(), { clientY }));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    clock = 1000;
    onReply = vi.fn<(text: string) => void>();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('swipe to reply', () => {
    describe('with the wheel', () => {
        it('pulls the message to the left the way the fingers go, with a Reply mark that fades in, and claims the events', async () => {
            await draw(person());

            // A first event too short to say which way the gesture goes is not claimed; the swipe that follows is.
            const first = wheel(2);
            const rest = swipe(4);

            expect(first.defaultPrevented).toBe(false);
            expect(rest.every(event => event.defaultPrevented)).toBe(true);
            // The content would scroll right, so the fingers went left and so does the message.
            expect(pulled()).toBeLessThan(0);
            expect(row().dataset.swipe).toBe('left');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBeGreaterThan(0);
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBeLessThan(1);
            expect(armed()).toBe(false);
            expect(onReply).not.toHaveBeenCalled();
        });

        it('leaves a swipe to the right alone, for something else: nothing is claimed, moved or replied to, even after the wheel goes quiet', async () => {
            await draw(person());

            const events = swipe(40, -10);

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(row().dataset.swipe).toBeUndefined();
            expect(onReply).not.toHaveBeenCalled();
        });

        it('is a long swipe: the mark takes its full look at the threshold, and not before', async () => {
            await draw(person());
            swipe(Math.floor(SWIPE.threshold / 10) - 1);

            expect(armed()).toBe(false);
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBeLessThan(1);

            swipe(1);

            expect(armed()).toBe(true);
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBe(1);
        });

        it('does not reply while the fingers move, however far: the message stays pulled and armed until the wheel goes quiet', async () => {
            await draw(person());
            swipe(30);

            expect(onReply).not.toHaveBeenCalled();
            expect(pulled()).toBeLessThan(0);
            expect(armed()).toBe(true);

            // Still moving: the events keep coming within the idle time.
            elapse(SWIPE.idleMs - 20);
            swipe(1);
            elapse(SWIPE.idleMs - 20);

            expect(onReply).not.toHaveBeenCalled();
            expect(pulled()).toBeLessThan(0);
        });

        it('replies with the message as it was written once the wheel goes quiet with the message held past the threshold, and puts the message back', async () => {
            await draw(person(config(), 'Make the **title** bigger'));
            swipe(30);
            quiet();

            expect(onReply).toHaveBeenCalledExactlyOnceWith('Make the **title** bigger');
            expect(row().style.translate).toBe('');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBe(0);
            expect(armed()).toBe(false);
        });

        it('replies to nothing for a swipe that was not long enough, and settles the message back', async () => {
            await draw(person());
            swipe(Math.floor(SWIPE.threshold / 10) - 2);

            expect(pulled()).toBeLessThan(0);

            quiet();

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBe(0);
        });

        describe('changing its mind in the middle', () => {
            it('follows the fingers back, and takes the mark back with the pull', async () => {
                await draw(person());
                swipe(20);

                const far = pulled();

                expect(armed()).toBe(true);

                // The fingers turn back: the message goes with them, and the mark is no longer ready.
                swipe(10, -10);

                expect(pulled()).toBeGreaterThan(far);
                expect(pulled()).toBeLessThan(0);
                expect(armed()).toBe(false);
            });

            it('replies to nothing when it was taken back below the threshold before the wheel went quiet', async () => {
                await draw(person());
                swipe(20);
                swipe(10, -10);
                quiet();

                expect(onReply).not.toHaveBeenCalled();
                expect(row().style.translate).toBe('');
            });

            it('replies to nothing when it was taken all the way back, and the message does not go to the right of where it was', async () => {
                await draw(person());
                swipe(20);

                const events = swipe(40, -10);

                expect(events.every(event => event.defaultPrevented)).toBe(true);
                // At rest, nothing is shown pulled in either direction.
                expect(pulled() || 0).toBe(0);

                quiet();

                expect(onReply).not.toHaveBeenCalled();
                expect(row().style.translate).toBe('');
            });

            it('replies to nothing for a hard swipe that was taken back by the length of the way out, however much inertia had piled up', async () => {
                await draw(person());
                swipe(80);

                expect(armed()).toBe(true);

                // About the threshold and a little more: with the pull counted only up to the reach, that is enough to be no longer ready.
                swipe(Math.ceil(SWIPE.threshold / 10) + 1, -10);

                expect(armed()).toBe(false);

                quiet();

                expect(onReply).not.toHaveBeenCalled();
            });

            it('replies when it was taken back and then out again past the threshold', async () => {
                await draw(person());
                swipe(20);
                swipe(15, -10);
                swipe(20);
                quiet();

                expect(onReply).toHaveBeenCalledOnce();
            });
        });

        it('counts the inertia a trackpad keeps sending after the fingers left as part of the swipe, and replies once when it is over', async () => {
            await draw(person());

            const events = swipe(80, 10);

            // The tail is still the swipe's: nothing under it scrolls.
            expect(events.at(-1)?.defaultPrevented).toBe(true);
            expect(onReply).not.toHaveBeenCalled();

            quiet();

            expect(onReply).toHaveBeenCalledOnce();
            expect(row().style.translate).toBe('');
        });

        it('takes the next swipe after a pause as a new one, which can reply again', async () => {
            await draw(person());
            swipe(30);
            quiet();
            swipe(30);
            quiet();

            expect(onReply).toHaveBeenCalledTimes(2);
        });

        it('ends a swipe whose wheel went quiet before the next event, even when its timer has not run yet', async () => {
            await draw(person());
            swipe(30);
            // The page was busy through the pause: the timer has not run, and the next event is handled first.
            clock += SWIPE.idleMs + 50;

            // A vertical scroll that comes after the pause: the old swipe ends with its Reply, and this is a gesture of its own, which passes.
            const event = wheel(0, 40);

            expect(onReply).toHaveBeenCalledOnce();
            expect(row().style.translate).toBe('');
            expect(event.defaultPrevented).toBe(false);

            // The timer of the old swipe does not reply a second time.
            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('goes by when the events happened, not when the page handled them: a stall in between is no pause of the fingers', async () => {
            const now = vi.spyOn(performance, 'now');

            await draw(person());
            swipe(15);
            // The page was busy for half a second: the events that came meanwhile were stamped a few ms apart, and are handled only now.
            now.mockReturnValue(performance.now() + 500);
            swipe(15);

            expect(onReply).not.toHaveBeenCalled();
            expect(pulled()).toBeLessThan(0);
            expect(armed()).toBe(true);

            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('takes a swipe to the left after one to the right, with a pause between, as its own', async () => {
            await draw(person());
            swipe(30, -10);
            quiet();

            const events = swipe(30);

            expect(events.slice(1).every(event => event.defaultPrevented)).toBe(true);

            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('replies to an answer the same way', async () => {
            await draw(<AssistantMessage text="The table is done." at={at} actions={config()} />);
            swipe(30);
            quiet();

            expect(onReply).toHaveBeenCalledExactlyOnceWith('The table is done.');
        });

        it('leaves a vertical scroll alone: nothing is claimed, moved or replied to', async () => {
            await draw(person());

            const events = Array.from({ length: 30 }, () => wheel(0, 40));

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('leaves a mostly vertical scroll alone even with a little drift sideways', async () => {
            await draw(person());

            const events = Array.from({ length: 30 }, () => wheel(6, 30));

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('ignores a pinch (the wheel with Ctrl) and a Shift scroll, which are not swipes', async () => {
            await draw(person());

            const events = [
                ...Array.from({ length: 20 }, () => wheel(10, 0, row(), { ctrlKey: true })),
                ...Array.from({ length: 20 }, () => wheel(10, 0, row(), { shiftKey: true })),
            ];

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('takes a wheel that counts in lines for its pixels', async () => {
            await draw(person());
            // Three lines of 16 px a notch, as a tilt wheel reports: two notches are short of the threshold, three are past it.
            wheel(3, 0, row(), { deltaMode: 1 });
            wheel(3, 0, row(), { deltaMode: 1 });
            quiet();

            expect(onReply).not.toHaveBeenCalled();

            wheel(3, 0, row(), { deltaMode: 1 });
            wheel(3, 0, row(), { deltaMode: 1 });
            wheel(3, 0, row(), { deltaMode: 1 });
            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });

        it("keeps the message's turn and its row of actions", async () => {
            await draw(person());
            swipe(4);

            expect(row().dataset.turn).toBe('i-3');
            expect(container.querySelector('button[aria-label="Copy message"]')).not.toBeNull();
        });
    });

    describe('settling back', () => {
        it('is at once for a person who asked for reduced motion, as every test is', async () => {
            await draw(person());
            swipe(30);
            quiet();

            expect(row().style.transition).toBe('');
        });

        it('is animated otherwise, and the next pull cancels the animation', async () => {
            const matchMedia = window.matchMedia.bind(window);

            vi.stubGlobal('matchMedia', (query: string) => ({ ...matchMedia(query), matches: false }));
            await draw(person());
            swipe(30);
            quiet();

            expect(row().style.translate).toBe('');
            expect(row().style.transition).toContain('translate');

            swipe(4);

            expect(row().style.transition).toBe('');
            expect(row().style.translate).not.toBe('');
        });
    });

    describe('where a code block or a table can scroll sideways', () => {
        /** A scrollable block inside the message, with the metrics a browser would measure (happy-dom does no layout). */
        function withScroller(metrics: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
            const pre = document.createElement('pre');

            pre.style.overflowX = 'auto';
            Object.defineProperties(pre, {
                scrollLeft: { value: metrics.scrollLeft, configurable: true },
                scrollWidth: { value: metrics.scrollWidth, configurable: true },
                clientWidth: { value: metrics.clientWidth, configurable: true },
            });
            row().querySelector('[data-testid="rendered"]')!.append(pre);

            return pre;
        }

        it('leaves the swipe to the left to it while it can still scroll that way: the message does not move and nothing is claimed', async () => {
            await draw(person());

            const events = swipe(30, 10, withScroller({ scrollLeft: 0, scrollWidth: 800, clientWidth: 300 }));

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it("takes the swipe for the message at the scroller's end, the way it cannot scroll", async () => {
            await draw(person());
            swipe(30, 10, withScroller({ scrollLeft: 500, scrollWidth: 800, clientWidth: 300 }));
            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('is not a scroller when its content fits or it does not scroll', async () => {
            await draw(person());

            const pre = withScroller({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });

            swipe(30, 10, pre);
            quiet();

            expect(onReply).toHaveBeenCalledOnce();
        });
    });

    describe('where it does nothing', () => {
        const nothingHappens = () => {
            const events = swipe(60);

            quiet();

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(row().style.touchAction).toBe('');
            expect(hint()).toBeNull();
            expect(onReply).not.toHaveBeenCalled();
        };

        it('with the setting off', async () => {
            await draw(person(config({ swipeToReply: false })));
            nothingHappens();
        });

        it('with no setting given', async () => {
            await draw(person(config({ swipeToReply: undefined })));
            nothingHappens();
        });

        it('on a message with no Reply: a page that cannot reply, a message of files alone', async () => {
            await draw(person(config({ onReply: undefined })));
            nothingHappens();

            await draw(
                <UserBubble
                    text=""
                    attachments={[{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }]}
                    at={at}
                    actions={config()}
                />
            );
            nothingHappens();
        });

        it('on a message with no row of actions at all, as on the page that only reads a run', async () => {
            await draw(person(null));
            nothingHappens();
        });

        it('when the setting goes off while the message is drawn: it lets go of the message and what it set on it, and a pull in progress replies to nothing', async () => {
            await draw(person());
            swipe(30);

            expect(row().style.translate).not.toBe('');
            expect(armed()).toBe(true);

            await draw(person(config({ swipeToReply: false })));

            expect(row().style.translate).toBe('');
            expect(row().dataset.swipe).toBeUndefined();
            expect(armed()).toBe(false);
            expect(row().style.touchAction).toBe('');
            expect(row().style.getPropertyValue('--swipe-progress')).toBe('');
            expect(row().style.getPropertyValue('--swipe-y')).toBe('');
            // No timer is left to reply later.
            expect(vi.getTimerCount()).toBe(0);

            quiet();

            expect(onReply).not.toHaveBeenCalled();
            nothingHappens();
        });

        it('when the message goes away in the middle of a swipe: its timer goes with it, and nothing is replied to', async () => {
            await draw(person());
            swipe(30);
            await draw(<div />);

            expect(vi.getTimerCount()).toBe(0);

            quiet();

            expect(onReply).not.toHaveBeenCalled();
        });
    });

    describe('the mark', () => {
        it('is on a message that swipes, not drawn as text for a screen reader, and is not there without a swipe', async () => {
            await draw(person());

            expect(hint()).not.toBeNull();
            expect(hint()?.textContent).toBe('');

            await draw(person(config({ swipeToReply: false })));

            expect(hint()).toBeNull();
        });

        // The middle of a tall answer can be out of view, so the mark stands at the height of the pointer when the pull starts, and stays inside the message.
        it.each([
            ['at the pointer', 250, '150px'],
            ['no nearer the top than its own half height', 102, '12px'],
            ['no nearer the bottom than its own half height', 900, '588px'],
        ])('stands %s', async (_where, clientY, expected) => {
            await draw(person());
            // happy-dom does no layout: a message 600px tall that starts at 100px.
            vi.spyOn(row(), 'getBoundingClientRect').mockReturnValue({ top: 100, height: 600 } as DOMRect);
            swipeAt(4, clientY);

            expect(row().style.getPropertyValue('--swipe-y')).toBe(expected);
        });

        it('is measured once for a pull: it does not follow the pointer after', async () => {
            await draw(person());
            vi.spyOn(row(), 'getBoundingClientRect').mockReturnValue({ top: 100, height: 600 } as DOMRect);
            swipeAt(1, 250);
            swipeAt(2, 400);

            expect(row().style.getPropertyValue('--swipe-y')).toBe('150px');
        });
    });

    describe('with a finger or a pen', () => {
        const pointer = (type: string, init: PointerEventInit) => {
            const event = new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                isPrimary: true,
                pointerId: 1,
                ...init,
            });

            row().dispatchEvent(event);

            return event;
        };
        /** Puts the pointer down at 300 and moves it `by` px (negative: to the left) in steps of 10; the moves it made. */
        const drag = (pointerType: string, by: number) => {
            const moves: PointerEvent[] = [];

            pointer('pointerdown', { pointerType, clientX: 300, clientY: 100 });

            for (let moved = 10; moved <= Math.abs(by); moved += 10)
                moves.push(pointer('pointermove', { pointerType, clientX: 300 + Math.sign(by) * moved, clientY: 100 }));

            return moves;
        };

        beforeEach(() => {
            HTMLElement.prototype.setPointerCapture = vi.fn();
        });

        it('pulls the message to the left and replies on release when held past the threshold, not before', async () => {
            await draw(person());
            drag('touch', -150);

            expect(pulled()).toBeLessThan(0);
            expect(armed()).toBe(true);
            expect(onReply).not.toHaveBeenCalled();

            pointer('pointerup', { pointerType: 'touch', clientX: 150, clientY: 100 });

            expect(onReply).toHaveBeenCalledExactlyOnceWith(TEXT);
            expect(row().style.translate).toBe('');
            expect(armed()).toBe(false);
        });

        it('replies to nothing when it is let go short of the threshold, and when the browser takes the touch for a scroll', async () => {
            await draw(person());
            drag('pen', -20);
            pointer('pointerup', { pointerType: 'pen', clientX: 280, clientY: 100 });

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');

            drag('touch', -150);
            pointer('pointercancel', { pointerType: 'touch', clientX: 150, clientY: 100 });

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');
        });

        it('replies to nothing when the pull was taken back below the threshold before it was let go', async () => {
            await draw(person());
            drag('touch', -150);
            // Back toward where it started, 100 px.
            pointer('pointermove', { pointerType: 'touch', clientX: 250, clientY: 100 });

            expect(armed()).toBe(false);

            pointer('pointerup', { pointerType: 'touch', clientX: 250, clientY: 100 });

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');
        });

        it('leaves a drag to the right alone', async () => {
            await draw(person());

            const moves = drag('touch', 200);
            const up = pointer('pointerup', { pointerType: 'touch', clientX: 500, clientY: 100 });

            expect(moves.some(move => move.defaultPrevented)).toBe(false);
            expect(up.defaultPrevented).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('leaves a mouse drag alone, since it selects text', async () => {
            await draw(person());
            drag('mouse', -200);

            const up = pointer('pointerup', { pointerType: 'mouse', clientX: 100, clientY: 100 });

            expect(up.defaultPrevented).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('lets go of a wheel swipe still in its quiet time when a finger goes down, so its timer does not reply in the middle of the drag', async () => {
            await draw(person());
            swipe(30);
            pointer('pointerdown', { pointerType: 'touch', clientX: 300, clientY: 100 });

            expect(row().style.translate).toBe('');
            expect(armed()).toBe(false);

            for (let moved = 10; moved <= 150; moved += 10)
                pointer('pointermove', { pointerType: 'touch', clientX: 300 - moved, clientY: 100 });
            // The timer of the wheel swipe would run here.
            quiet();

            expect(armed()).toBe(true);
            expect(onReply).not.toHaveBeenCalled();

            pointer('pointerup', { pointerType: 'touch', clientX: 150, clientY: 100 });

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('keeps vertical panning for the browser, and gives it only the swipes of the message it is on', async () => {
            await draw(person());

            expect(row().style.touchAction).toBe('pan-y');
        });
    });
});

describe('native wheel lifecycle', () => {
    function phases() {
        let sequence = 0;
        let active = false;
        let last: import('../../shared/bridge').NativeScrollRecord | null = null;
        const listeners = new Set<(event: import('../../shared/bridge').NativeScrollRecord) => void>();
        vi.stubGlobal('desktop', {
            nativeScroll: {
                available: true,
                snapshot: () => ({ sequence, gesture: 1, active, origin: null, last }),
                subscribe: (listener: (event: import('../../shared/bridge').NativeScrollRecord) => void) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
            },
        });
        return (phase: number, deliver = true, momentumPhase = 0) => {
            active = phase === 1 || phase === 4;
            last = {
                kind: 'scroll',
                sequence: ++sequence,
                phase,
                momentumPhase,
                x: 0,
                y: 0,
                deltaX: 10,
                deltaY: 0,
                timestamp: sequence,
                precise: true,
            };
            if (deliver) for (const listener of listeners) listener(last);
            return last;
        };
    }

    it('holds an armed message for over two seconds and replies once on release, ignoring momentum', async () => {
        const phase = phases();
        await draw(person());
        phase(1, false);
        swipe(13);
        elapse(2500);
        expect([armed(), onReply.mock.calls.length]).toEqual([true, 0]);
        phase(8);
        elapse(41);
        phase(0, true, 1);
        swipe(20);
        quiet();
        expect(onReply.mock.calls).toEqual([[TEXT]]);
    });

    it('accepts coalesced motion before release', async () => {
        const phase = phases();
        await draw(person());
        phase(1, false);
        wheel(130);
        phase(8);
        elapse(41);
        expect(onReply.mock.calls).toEqual([[TEXT]]);
    });

    it('uses the quiet-time fallback for an unphased wheel even when the bridge is available', async () => {
        const phase = phases();
        await draw(person());
        phase(0);
        swipe(13);
        quiet();
        expect(onReply.mock.calls).toEqual([[TEXT]]);
    });

    it('returns an early release without replying', async () => {
        const phase = phases();
        await draw(person());
        phase(1);
        swipe(3);
        phase(8);
        elapse(41);
        expect([row().style.translate, onReply.mock.calls.length]).toEqual(['', 0]);
    });

    it('keeps ownership on the first message when the pointer moves', async () => {
        const phase = phases();
        await draw(
            <>
                {person(config(), 'first')}
                {person(config(), 'second')}
            </>
        );
        const messages = container.querySelectorAll<HTMLElement>('[data-message]');
        phase(1);
        swipe(13, 10, messages[0]);
        swipe(13, 10, messages[1]);
        phase(8);
        elapse(41);
        expect(onReply.mock.calls).toEqual([['first']]);
    });

    it('follows a claimed native swipe when the pointer moves to another message', async () => {
        const phase = phases();
        await draw(
            <>
                {person(config(), 'first')}
                {person(config(), 'second')}
            </>
        );
        const messages = container.querySelectorAll<HTMLElement>('[data-message]');
        phase(1);
        swipe(13, 10, messages[0]);
        const reversal = swipe(8, -10, messages[1]);
        phase(8);
        elapse(41);
        expect(reversal.every(event => event.defaultPrevented)).toBe(true);
        expect(onReply).not.toHaveBeenCalled();
    });

    it('leaves a native vertical gesture unclaimed when the pointer moves to another message', async () => {
        const phase = phases();
        await draw(
            <>
                {person(config(), 'first')}
                {person(config(), 'second')}
            </>
        );
        const messages = container.querySelectorAll<HTMLElement>('[data-message]');
        phase(1);
        const first = wheel(0, 40, messages[0]);
        const second = wheel(0, 40, messages[1]);
        phase(8);
        elapse(41);
        expect([first.defaultPrevented, second.defaultPrevented, onReply.mock.calls.length]).toEqual([false, false, 0]);
    });

    it('cancels a claimed swipe when the pointer moves over a dialog', async () => {
        const phase = phases();
        await draw(person());
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        document.body.append(dialog);
        try {
            phase(1);
            swipe(13);
            const event = wheel(0, 40, dialog);
            phase(8);
            elapse(41);
            expect([event.defaultPrevented, row().style.translate, onReply.mock.calls.length]).toEqual([false, '', 0]);
        } finally {
            dialog.remove();
        }
    });

    it('cancels an armed swipe when a dialog opens while the pointer is still', async () => {
        const phase = phases();
        await draw(person());
        phase(1);
        swipe(13);
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        document.body.append(dialog);
        try {
            phase(8);
            elapse(41);
            expect([row().style.translate, onReply.mock.calls.length]).toEqual(['', 0]);
        } finally {
            dialog.remove();
        }
    });

    it('does not reply after reversing below the threshold before release', async () => {
        const phase = phases();
        await draw(person());
        phase(1);
        swipe(13);
        elapse(2100);
        swipe(5, -10);
        phase(8);
        elapse(41);
        expect(onReply).not.toHaveBeenCalled();
    });

    it('cancels an armed pull when native input is cancelled', async () => {
        const phase = phases();
        await draw(person());
        phase(1);
        swipe(13);
        phase(16);
        elapse(2500);
        expect([row().style.translate, onReply.mock.calls.length]).toEqual(['', 0]);
    });

    it('cancels when queued DOM motion arrives after native release', async () => {
        const phase = phases();
        await draw(person());
        phase(1);
        swipe(13);
        phase(8);
        wheel(-60);
        elapse(2500);
        expect([row().style.translate, onReply.mock.calls.length]).toEqual(['', 0]);
    });

    it('ignores a DOM wheel delivered after the native gesture ended', async () => {
        const phase = phases();
        await draw(person());
        phase(1, false);
        phase(8, false);
        swipe(20);
        quiet();
        expect([row().style.translate, onReply.mock.calls.length]).toEqual(['', 0]);
    });
});
