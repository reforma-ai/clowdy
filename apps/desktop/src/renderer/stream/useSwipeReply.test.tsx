// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { AssistantMessage } from './AssistantMessage';
import { SWIPE } from './swipeReply';
import { UserBubble } from './UserBubble';

import type { MessageActionsConfig } from './MessageActions';

// Streamdown highlights code with Shiki, whose WebAssembly cannot load under happy-dom; the message's own root is what is checked here.
vi.mock('./Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div data-testid="rendered">{ text }</div> }));
vi.mock('@clowdy/components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(), show: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The swipe on a real message: wheel events (and pointer events of a finger) dispatched on the rendered row, the way a trackpad makes them. The decisions
 * themselves are tested in `swipeReply.test.ts`; this checks what the hook does with them on the page: what it moves, what it cancels, and when it replies.
 */

let container: HTMLDivElement;
let root: Root;
let onReply: Mock<(text: string) => void>;

const at = new Date(2025, 10, 19, 22, 54).getTime();
const TEXT = 'Make the title bigger';

const config = (extra: Partial<MessageActionsConfig> = {}): MessageActionsConfig => ({ show: 'hover', onReply, swipeToReply: true, ...extra });
// `null` is a message with no row of actions at all (an `undefined` would take the default).
const person = (actions: MessageActionsConfig | null = config(), text = TEXT) => (
    <UserBubble text={ text } at={ at } turn="i-3" actions={ actions ?? undefined } />
);

const draw = (element: React.ReactElement) => act(async () => root.render(element));
const row = () => container.querySelector<HTMLElement>('[data-message]')!;
const hint = () => row().querySelector(':scope > span[aria-hidden]');

/** A wheel event on `target`; `deltaX` is where the content would scroll, as the browser reports it, so a negative one pulls the message to the right. */
function wheel(deltaX: number, deltaY = 0, target: Element = row(), init: WheelEventInit & { ctrlKey?: boolean; shiftKey?: boolean } = {}) {
    const { ctrlKey, shiftKey, clientY, ...rest } = init;
    const event = new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true, ...rest });

    // happy-dom's wheel event has no modifier keys or pointer position of its own.
    Object.defineProperties(event, { ctrlKey: { value: ctrlKey ?? false }, shiftKey: { value: shiftKey ?? false }, clientY: { value: clientY ?? 0 } });

    target.dispatchEvent(event);

    return event;
}

/** A swipe of `count` events of `deltaX` each, with the events it made. */
const swipe = (count: number, deltaX = 10, target?: Element) => Array.from({ length: count }, () => wheel(deltaX, 0, target));

/** The same swipe with the pointer at `clientY`. */
const swipeAt = (count: number, clientY: number) => Array.from({ length: count }, () => wheel(10, 0, row(), { clientY }));

beforeEach(() => {
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
        it('pulls the message the way the fingers go, with a Reply mark that fades in, and claims the events', async () => {
            await draw(person());

            // A first event too short to say which way the gesture goes is not claimed; the swipe that follows is.
            const first = wheel(2);
            const rest = swipe(4);

            expect(first.defaultPrevented).toBe(false);
            expect(rest.every(event => event.defaultPrevented)).toBe(true);
            // The content would scroll right, so the fingers went left and so does the message.
            expect(Number.parseFloat(row().style.translate)).toBeLessThan(0);
            expect(row().dataset.swipe).toBe('left');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBeGreaterThan(0);
            expect(onReply).not.toHaveBeenCalled();
        });

        it('pulls to the right for a swipe the other way', async () => {
            await draw(person());
            swipe(4, -10);

            expect(Number.parseFloat(row().style.translate)).toBeGreaterThan(0);
            expect(row().dataset.swipe).toBe('right');
        });

        it('replies with the message as it was written once the pull is far enough, and puts the message back', async () => {
            await draw(person(config(), 'Make the **title** bigger'));
            swipe(30);

            expect(onReply).toHaveBeenCalledExactlyOnceWith('Make the **title** bigger');
            expect(row().style.translate).toBe('');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBe(0);
        });

        it('replies once for one swipe: the inertia after it is ignored, and so are its stray vertical bits', async () => {
            await draw(person());

            const events = swipe(80, 10);

            expect(onReply).toHaveBeenCalledOnce();
            expect(row().style.translate).toBe('');
            // The tail is still the swipe's: nothing under it scrolls.
            expect(events.at(-1)?.defaultPrevented).toBe(true);
            expect(wheel(2, 1).defaultPrevented).toBe(true);
            expect(onReply).toHaveBeenCalledOnce();
        });

        it('replies to an answer the same way', async () => {
            await draw(<AssistantMessage text="The table is done." at={ at } actions={ config() } />);
            swipe(30);

            expect(onReply).toHaveBeenCalledExactlyOnceWith('The table is done.');
        });

        it('leaves a vertical scroll alone: nothing is claimed, moved or replied to', async () => {
            await draw(person());

            const events = Array.from({ length: 30 }, () => wheel(0, 40));

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('leaves a mostly vertical scroll alone even with a little drift sideways', async () => {
            await draw(person());

            const events = Array.from({ length: 30 }, () => wheel(6, 30));

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
        });

        it('settles a pull that did not get far enough once the wheel goes quiet', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await draw(person());
            swipe(4);

            expect(row().style.translate).not.toBe('');

            vi.advanceTimersByTime(SWIPE.idleMs + 1);

            expect(row().style.translate).toBe('');
            expect(Number(row().style.getPropertyValue('--swipe-progress'))).toBe(0);
            expect(onReply).not.toHaveBeenCalled();
        });

        it('holds the pull while the events keep coming within the idle time', async () => {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
            await draw(person());
            swipe(4);
            vi.advanceTimersByTime(SWIPE.idleMs - 20);
            wheel(1);
            vi.advanceTimersByTime(SWIPE.idleMs - 20);

            expect(row().style.translate).not.toBe('');
        });

        it('ignores a pinch (the wheel with Ctrl) and a Shift scroll, which are not swipes', async () => {
            await draw(person());

            const events = [...Array.from({ length: 20 }, () => wheel(10, 0, row(), { ctrlKey: true })), ...Array.from({ length: 20 }, () => wheel(10, 0, row(), { shiftKey: true }))];

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('takes a wheel that counts in lines for its pixels', async () => {
            await draw(person());
            // Three lines a notch, as a tilt wheel reports: two notches are enough for a Reply.
            wheel(3, 0, row(), { deltaMode: 1 });
            wheel(3, 0, row(), { deltaMode: 1 });
            wheel(3, 0, row(), { deltaMode: 1 });

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('keeps the message\'s turn and its row of actions', async () => {
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

            expect(row().style.transition).toBe('');
        });

        it('is animated otherwise, and the next pull cancels the animation', async () => {
            const matchMedia = window.matchMedia.bind(window);

            vi.stubGlobal('matchMedia', (query: string) => ({ ...matchMedia(query), matches: false }));
            await draw(person());
            swipe(30);

            expect(row().style.translate).toBe('');
            expect(row().style.transition).toContain('translate');

            // The idle time passes in real time between two swipes; the next gesture's first event after it starts clean.
            await new Promise(resolve => setTimeout(resolve, SWIPE.idleMs + 20));
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

        it('leaves the sideways swipe to it while it can still scroll that way: the message does not move and nothing is claimed', async () => {
            await draw(person());

            const events = swipe(30, 10, withScroller({ scrollLeft: 0, scrollWidth: 800, clientWidth: 300 }));

            expect(events.some(event => event.defaultPrevented)).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('takes the swipe for the message at the scroller\'s end, the way it cannot scroll', async () => {
            await draw(person());
            swipe(30, 10, withScroller({ scrollLeft: 500, scrollWidth: 800, clientWidth: 300 }));

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('takes a swipe to the other way at its start, where it cannot scroll back', async () => {
            await draw(person());
            swipe(30, -10, withScroller({ scrollLeft: 0, scrollWidth: 800, clientWidth: 300 }));

            expect(onReply).toHaveBeenCalledOnce();
        });

        it('is not a scroller when its content fits or it does not scroll', async () => {
            await draw(person());

            const pre = withScroller({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });

            swipe(30, 10, pre);

            expect(onReply).toHaveBeenCalledOnce();
        });
    });

    describe('where it does nothing', () => {
        const nothingHappens = () => {
            const events = swipe(60);

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

            await draw(<UserBubble text="" attachments={ [{ id: 'a-1', name: 'shot.png', mediaType: 'image/png', size: 10 }] } at={ at } actions={ config() } />);
            nothingHappens();
        });

        it('on a message with no row of actions at all, as on the page that only reads a run', async () => {
            await draw(person(null));
            nothingHappens();
        });

        it('when the setting goes off while the message is drawn: it lets go of the message and what it set on it', async () => {
            await draw(person());
            swipe(4);

            expect(row().style.translate).not.toBe('');

            await draw(person(config({ swipeToReply: false })));

            expect(row().style.translate).toBe('');
            expect(row().dataset.swipe).toBeUndefined();
            expect(row().style.touchAction).toBe('');

            nothingHappens();
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
            const event = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 1, ...init });

            row().dispatchEvent(event);

            return event;
        };
        const drag = (pointerType: string, to: number) => {
            pointer('pointerdown', { pointerType, clientX: 300, clientY: 100 });

            for (let x = 300; x <= 300 + to; x += 10) pointer('pointermove', { pointerType, clientX: x, clientY: 100 });
        };

        beforeEach(() => {
            HTMLElement.prototype.setPointerCapture = vi.fn();
        });

        it('pulls the message along and replies on release when held past the threshold', async () => {
            await draw(person());
            drag('touch', 120);

            expect(Number.parseFloat(row().style.translate)).toBeGreaterThan(SWIPE.threshold);
            expect(onReply).not.toHaveBeenCalled();

            pointer('pointerup', { pointerType: 'touch', clientX: 420, clientY: 100 });

            expect(onReply).toHaveBeenCalledExactlyOnceWith(TEXT);
            expect(row().style.translate).toBe('');
        });

        it('replies to nothing when it is let go short of the threshold, and when the browser takes the touch for a scroll', async () => {
            await draw(person());
            drag('pen', 20);
            pointer('pointerup', { pointerType: 'pen', clientX: 320, clientY: 100 });

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');

            drag('touch', 120);
            pointer('pointercancel', { pointerType: 'touch', clientX: 420, clientY: 100 });

            expect(onReply).not.toHaveBeenCalled();
            expect(row().style.translate).toBe('');
        });

        it('leaves a mouse drag alone, since it selects text', async () => {
            await draw(person());
            drag('mouse', 200);

            const up = pointer('pointerup', { pointerType: 'mouse', clientX: 500, clientY: 100 });

            expect(up.defaultPrevented).toBe(false);
            expect(row().style.translate).toBe('');
            expect(onReply).not.toHaveBeenCalled();
        });

        it('keeps vertical panning for the browser, and gives it only the swipes of the message it is on', async () => {
            await draw(person());

            expect(row().style.touchAction).toBe('pan-y');
        });
    });
});
