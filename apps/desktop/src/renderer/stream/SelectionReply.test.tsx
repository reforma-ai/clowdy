// @vitest-environment happy-dom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SelectionReply } from './SelectionReply';
import { placeToolbar, readSelection } from './selectedMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const onReply = vi.fn();

/**
 * A list of two messages, a third one outside the list's scope, and a field that is no message; `SelectionReply` watches the list. The row of actions
 * under a message is left out: it is `user-select: none`, which a browser leaves out of `Selection.toString()` and happy-dom does not.
 */
function Page() {
    const list = useRef<HTMLDivElement>(null);

    return (
        <>
            <div ref={list} data-testid="list">
                <div data-message="" data-testid="first">
                    <p>First message, the first paragraph.</p>
                    <p>And a second paragraph.</p>
                </div>
                <div data-message="" data-testid="second">
                    <p>Second message.</p>
                </div>
                <div data-testid="work">Worked for 25s</div>
            </div>
            <div data-message="" data-testid="elsewhere">
                <p>A message of another list.</p>
            </div>
            <div contentEditable data-testid="field">
                Words in the message box
            </div>
            <SelectionReply scope={list} onReply={onReply} />
        </>
    );
}

const part = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const toolbar = () => document.body.querySelector<HTMLElement>('[role="toolbar"]');
const replyButton = () => toolbar()?.querySelector('button');

/** Selects from `start` to `end`, each a text position of a node, and tells the document, as a browser does. */
function select(startNode: Node, startOffset: number, endNode: Node, endOffset: number) {
    const range = document.createRange();

    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
}

const textOf = (id: string, index = 0) => part(id).querySelectorAll('p')[index].firstChild!;

/** Runs the frames that were asked for, as the browser does before it paints. */
const paint = () =>
    act(async () => {
        const due = [...frames.values()];

        frames.clear();
        due.forEach(callback => callback(0));
    });

const press = (type: string, target: Element) =>
    act(async () => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    });

beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);

        return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => frames.delete(handle));
    // happy-dom lays nothing out: a selection is drawn on the line `top` 100 to `bottom` 120, 200px across from x 300.
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(
        () => [{ left: 300, right: 500, top: 100, bottom: 120, width: 200, height: 20 }] as unknown as DOMRectList
    );
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ left: 300, right: 500, top: 100, bottom: 120, width: 200, height: 20 }) as DOMRect
    );
    // The list fills the window, which happy-dom gives a size of 1024 by 768.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
        () => ({ left: 0, right: 1024, top: 0, bottom: 768, width: 1024, height: 768 }) as DOMRect
    );
    onReply.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('SelectionReply', () => {
    beforeEach(async () => {
        await act(async () => root.render(<Page />));
    });

    describe('when it is offered', () => {
        it('shows a Reply button for words inside one message, once the frame is drawn', async () => {
            select(textOf('first'), 6, textOf('first'), 13);

            expect(toolbar()).toBeNull();

            await paint();

            expect(toolbar()).not.toBeNull();
            expect(replyButton()?.textContent).toBe('Reply');
        });

        it('offers words across the paragraphs of one message', async () => {
            select(textOf('first'), 6, textOf('first', 1), 7);
            await paint();
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('message, the first paragraph.'));
            expect(onReply.mock.calls[0][0]).toContain('And a s');
        });

        it('offers nothing for a selection that holds words of two messages', async () => {
            select(textOf('first'), 6, textOf('second'), 6);
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('offers nothing for a caret, for blanks, or for nothing selected', async () => {
            select(textOf('first'), 6, textOf('first'), 6);
            await paint();

            expect(toolbar()).toBeNull();

            const blank = document.createElement('p');

            blank.textContent = '   ';
            part('second').append(blank);
            select(blank.firstChild!, 0, blank.firstChild!, 3);
            await paint();

            expect(toolbar()).toBeNull();

            window.getSelection()!.removeAllRanges();
            document.dispatchEvent(new Event('selectionchange'));
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('counts a selection that spills out of the message by a line break only, as a triple click leaves it', async () => {
            // The whole last paragraph, ending where the next message starts.
            select(textOf('first', 1), 0, textOf('second'), 0);
            await paint();
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith('And a second paragraph.');
        });

        it('counts a selection that starts just before the message, and ends inside it', async () => {
            select(textOf('first', 1), 'And a second paragraph.'.length, textOf('second'), 6);
            await paint();
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith('Second');
        });

        it('offers nothing when the selection spills into words that are not in the message', async () => {
            select(textOf('second'), 0, part('work').firstChild!, 6);
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('offers nothing for a message outside the list it watches, or for the words of the message box', async () => {
            select(textOf('elsewhere'), 2, textOf('elsewhere'), 9);
            await paint();

            expect(toolbar()).toBeNull();

            select(part('field').firstChild!, 0, part('field').firstChild!, 5);
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('offers nothing for a selection that is not drawn', async () => {
            vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [] as unknown as DOMRectList);
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('is placed over the first line of the selection, centred on it', async () => {
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            // The selection is on the line from 100 to 120 and from 300 to 500 across; happy-dom gives the box no size.
            expect(toolbar()?.style.top).toBe('94px');
            expect(toolbar()?.style.left).toBe('400px');
        });

        it('is placed under the selection when the list begins too close over it for the box', async () => {
            vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
                () => ({ left: 0, right: 1024, top: 90, bottom: 768, width: 1024, height: 678 }) as DOMRect
            );
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            expect(toolbar()?.style.top).toBe('126px');
        });
    });

    describe('while a mouse button is down', () => {
        it('hides at the press, offers nothing while the selection is dragged, and shows once the button is released', async () => {
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            expect(toolbar()).not.toBeNull();

            await press('pointerdown', part('first'));

            expect(toolbar()).toBeNull();

            select(textOf('first'), 0, textOf('first'), 5);
            select(textOf('first'), 0, textOf('first'), 9);
            await paint();

            expect(toolbar()).toBeNull();

            await press('pointerup', part('first'));
            await paint();

            expect(toolbar()).not.toBeNull();
        });

        it('leaves the toolbar alone for a press on it, which acts on the selection that is there', async () => {
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();
            await press('pointerdown', replyButton()!);

            expect(toolbar()).not.toBeNull();
        });

        it('does not take the selection or the focus from a press on the toolbar', async () => {
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

            await act(async () => {
                replyButton()!.dispatchEvent(down);
            });

            expect(down.defaultPrevented).toBe(true);
            expect(window.getSelection()!.toString()).toBe('message');
        });
    });

    describe('when it goes', () => {
        const shown = async () => {
            select(textOf('first'), 6, textOf('first'), 13);
            await paint();

            expect(toolbar()).not.toBeNull();
        };

        it('goes on Escape', async () => {
            await shown();
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });

            expect(toolbar()).toBeNull();
        });

        it('stays for other keys', async () => {
            await shown();
            await act(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
            });

            expect(toolbar()).not.toBeNull();
        });

        it('goes when anything scrolls, the list or the message box', async () => {
            await shown();
            await act(async () => {
                part('list').dispatchEvent(new Event('scroll'));
            });

            expect(toolbar()).toBeNull();

            await shown();
            await act(async () => {
                part('field').dispatchEvent(new Event('scroll'));
            });

            expect(toolbar()).toBeNull();
        });

        it('goes when the window is resized', async () => {
            await shown();
            await act(async () => {
                window.dispatchEvent(new Event('resize'));
            });

            expect(toolbar()).toBeNull();
        });

        it('goes when the selection collapses or leaves the message', async () => {
            await shown();
            select(textOf('first'), 6, textOf('first'), 6);
            await paint();

            expect(toolbar()).toBeNull();

            await shown();
            select(textOf('first'), 6, textOf('second'), 6);
            await paint();

            expect(toolbar()).toBeNull();
        });

        it('does not come back for a scroll that hid it, when a read was already waiting', async () => {
            await shown();
            select(textOf('first'), 0, textOf('first'), 5);
            await act(async () => {
                part('list').dispatchEvent(new Event('scroll'));
            });
            await paint();

            expect(toolbar()).toBeNull();
        });
    });

    describe('Reply', () => {
        it('quotes the selected words as they are drawn, trimmed, then collapses the selection and goes', async () => {
            select(textOf('first'), 5, textOf('first'), 14);
            await paint();
            await act(async () => replyButton()!.click());

            expect(onReply).toHaveBeenCalledExactlyOnceWith('message,');
            expect(window.getSelection()!.isCollapsed).toBe(true);
            expect(toolbar()).toBeNull();
        });
    });

    describe('its listeners', () => {
        it('are one set on the document for the whole list, not one per message, and go with the list', async () => {
            // React listens for `selectionchange` itself once the root is made: what is counted is what the toolbar adds.
            await act(async () => root.render(null));

            const add = vi.spyOn(document, 'addEventListener');
            const remove = vi.spyOn(document, 'removeEventListener');

            await act(async () => root.render(<Page />));

            const added = add.mock.calls.map(call => call[0]);

            expect(added.filter(type => type === 'selectionchange')).toHaveLength(1);
            expect(added.filter(type => type === 'pointerdown')).toHaveLength(1);
            expect(added.filter(type => type === 'scroll')).toHaveLength(1);

            await act(async () => root.render(null));

            expect(remove.mock.calls.map(call => call[0]).filter(type => type === 'selectionchange')).toHaveLength(1);

            document.dispatchEvent(new Event('selectionchange'));

            expect(frames.size).toBe(0);
        });

        it('read the selection once per frame, however many changes come in', async () => {
            for (let end = 1; end < 12; end++) select(textOf('first'), 0, textOf('first'), end);

            expect(frames.size).toBe(1);

            await paint();

            expect(toolbar()).not.toBeNull();
        });
    });
});

describe('placeToolbar', () => {
    const within = { left: 0, top: 0, right: 1000, bottom: 800 };
    const size = { width: 100, height: 36 };

    it("puts the box over the first line with its middle on the selection's, a gap above", () => {
        expect(placeToolbar({ x: 400, above: 300, below: 360 }, size, within)).toEqual({ left: 350, top: 258 });
    });

    it('puts it under the last line when there is no room above', () => {
        expect(placeToolbar({ x: 400, above: 20, below: 80 }, size, within)).toEqual({ left: 350, top: 86 });
    });

    it('keeps it inside the window at the sides', () => {
        expect(placeToolbar({ x: 10, above: 300, below: 320 }, size, within).left).toBe(8);
        expect(placeToolbar({ x: 995, above: 300, below: 320 }, size, within).left).toBe(892);
    });

    it('keeps it inside the window when the selection is below or above the part that shows', () => {
        expect(placeToolbar({ x: 400, above: 20, below: 790 }, size, within).top).toBe(756);
        expect(placeToolbar({ x: 400, above: -500, below: -300 }, size, within).top).toBe(8);
    });

    it('keeps it inside the room the list has: under a title band that the window has over it, not over the band', () => {
        const list = { left: 200, top: 48, right: 1000, bottom: 700 };

        // The line is 69px down: there is room over it in the window, but not in the list.
        expect(placeToolbar({ x: 400, above: 69, below: 89 }, size, list)).toEqual({ left: 350, top: 95 });
        expect(placeToolbar({ x: 210, above: 300, below: 320 }, size, list).left).toBe(208);
        expect(placeToolbar({ x: 400, above: 60, below: 800 }, size, list).top).toBe(656);
    });
});

describe('readSelection', () => {
    it('reads nothing without a list to look in', async () => {
        await act(async () => root.render(<Page />));
        select(textOf('first'), 6, textOf('first'), 13);

        expect(readSelection(null)).toBeNull();
    });
});
