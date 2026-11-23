// @vitest-environment happy-dom
import { search } from '@codemirror/search';
import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hotkeys, installDispatcher } from '../hotkeys';
import { FindBar } from './FindBar';

import type { DesktopBridge, FindCommand } from '../../shared/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeHighlight {
    ranges: Range[] = [];
    priority = 0;

    constructor(...ranges: Range[]) {
        this.ranges = ranges;
    }

    add(range: Range) {
        this.ranges.push(range);
    }
}

const PAGE = '<p>First booking here.</p><p>A second Booking, and then a third booking.</p>';

let container: HTMLDivElement;
let page: HTMLDivElement;
let root: Root;
let uninstall: () => void;
let command: ((command: FindCommand) => void) | undefined;
const painted = new Map<string, FakeHighlight>();

const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Find in page"]');
const bar = () => container.querySelector('[role="search"]');
const count = () => container.querySelector('[aria-live="polite"]')?.textContent;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
/** The text of the hit that is on, as the page paints it. */
const active = () => painted.get('find-active')?.ranges.map(range => range.toString());

function press(key: string, init: KeyboardEventInit & { mod?: boolean } = {}, target: Element = document.body) {
    const { mod, ...rest } = init;
    const modifier = hotkeys.platform === 'darwin' ? { metaKey: mod === true } : { ctrlKey: mod === true };
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifier, ...rest });

    target.dispatchEvent(event);

    return event;
}

async function type(text: string) {
    await act(async () => {
        const input = field()!;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

        setValue.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    painted.clear();
    vi.stubGlobal('Highlight', FakeHighlight);
    vi.stubGlobal('CSS', { highlights: painted });
    container = document.createElement('div');
    page = document.createElement('div');
    page.innerHTML = PAGE;
    document.body.append(page, container);
    root = createRoot(container);
    uninstall = installDispatcher(hotkeys);
    command = undefined;
    window.desktop = {
        onFindCommand: (listener: (command: FindCommand) => void) => {
            command = listener;

            return () => {
                command = undefined;
            };
        },
    } as unknown as DesktopBridge;
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
    page.remove();
    window.desktop = undefined;
    vi.unstubAllGlobals();
});

async function draw() {
    await act(async () => root.render(<FindBar />));
}

async function open() {
    await draw();
    await act(async () => press('f', { mod: true }));
}

describe('Find in page', () => {
    it('opens on Cmd+F from a text field, selects what is there, and a plain f stays a character', async () => {
        await draw();

        const composer = document.createElement('textarea');

        document.body.append(composer);

        try {
            const found = await act(async () => press('f', { mod: true }, composer));

            expect(found.defaultPrevented).toBe(true);
            expect(bar()).not.toBeNull();
            expect(document.activeElement).toBe(field());

            await type('booking');
            await act(async () => press('f', { mod: true }, field()!));

            expect(field()!.selectionStart).toBe(0);
            expect(field()!.selectionEnd).toBe('booking'.length);

            const typed = press('f', {}, field()!);

            expect(typed.defaultPrevented).toBe(false);
        } finally {
            composer.remove();
        }
    });

    it('searches what is typed, paints the hits and goes to the first', async () => {
        await open();
        await type('booking');

        expect(count()).toBe('1 of 3');
        expect(painted.get('find')?.ranges.map(range => range.toString())).toEqual(['booking', 'Booking', 'booking']);
        expect(active()).toEqual(['booking']);
    });

    it('moves to the next and previous match with Enter and Shift+Enter, round the ends', async () => {
        await open();
        await type('booking');
        await act(async () => press('Enter', {}, field()!));

        expect(count()).toBe('2 of 3');
        expect(active()).toEqual(['Booking']);

        await act(async () => press('Enter', {}, field()!));
        await act(async () => press('Enter', {}, field()!));

        expect(count()).toBe('1 of 3');

        await act(async () => press('Enter', { shiftKey: true }, field()!));

        expect(count()).toBe('3 of 3');
    });

    it('moves with the buttons too', async () => {
        await open();
        await type('booking');
        await act(async () => button('Next match')!.click());

        expect(count()).toBe('2 of 3');

        await act(async () => button('Previous match')!.click());
        await act(async () => button('Previous match')!.click());

        expect(count()).toBe('3 of 3');
    });

    it('does not find its own query: the field is not part of the page', async () => {
        page.innerHTML = '<p>nothing about it</p>';
        await open();
        await type('booking');

        expect(count()).toBe('No matches');
        expect(painted.size).toBe(0);

        page.innerHTML = PAGE;
        await type('booking!');
        await type('booking');

        // The three on the page, and not a fourth in the bar.
        expect(count()).toBe('1 of 3');
        expect(painted.get('find')?.ranges.every(range => !bar()!.contains(range.startContainer))).toBe(true);
    });

    it('keeps the focus in the field while typing and stepping, by the keys and by the buttons', async () => {
        await open();
        await type('b');

        expect(document.activeElement).toBe(field());

        await type('booking');

        expect(document.activeElement).toBe(field());

        await act(async () => press('Enter', {}, field()!));

        expect(document.activeElement).toBe(field());

        await act(async () => button('Next match')!.click());
        await act(async () => button('Previous match')!.click());

        expect(document.activeElement).toBe(field());
    });

    it('gives the focus to the field when the bar around it is pressed, and leaves the field its own press so the pointer places the caret', async () => {
        await open();
        await type('booking');

        const press = (target: Element) => {
            const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });

            target.dispatchEvent(event);

            return event;
        };
        const label = container.querySelector('[aria-live="polite"]')!;

        field()!.blur();

        expect(document.activeElement).not.toBe(field());
        expect(press(label).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(field());

        field()!.blur();

        expect(press(bar()!).defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(field());

        // Where the caret goes is the field's own business.
        expect(press(field()!).defaultPrevented).toBe(false);
    });

    it('says when nothing matches and leaves the field alive: it keeps the focus, takes the next word, and finds again', async () => {
        await open();
        await type('zzzz');

        expect(count()).toBe('No matches');
        expect(painted.size).toBe(0);
        expect(document.activeElement).toBe(field());

        await act(async () => press('Enter', {}, field()!));
        await act(async () => button('Next match')!.click());

        expect(document.activeElement).toBe(field());

        await type('booking');

        expect(count()).toBe('1 of 3');
        expect(document.activeElement).toBe(field());
    });

    it('stays on the hit it is on when more of the word is typed, and goes to the first when that hit is gone', async () => {
        await open();
        await type('book');
        await act(async () => press('Enter', {}, field()!));
        await type('booking');

        expect(count()).toBe('2 of 3');

        await type('booking,');

        expect(count()).toBe('1 of 1');
    });

    it('drops the count and the paint when the field is emptied', async () => {
        await open();
        await type('booking');
        await type('');

        expect(count()).toBe('');
        expect(painted.size).toBe(0);
    });

    it('closes on Escape, clears the paint, and the bar can be opened again', async () => {
        await open();
        await type('booking');
        await act(async () => press('Escape', {}, field()!));

        expect(bar()).toBeNull();
        expect(painted.size).toBe(0);

        await act(async () => press('f', { mod: true }));

        expect(bar()).not.toBeNull();
        expect(field()!.value).toBe('booking');
        // It starts again from its query, so the page shows the hits it had.
        expect(count()).toBe('1 of 3');
        expect(painted.get('find')?.ranges).toHaveLength(3);
    });

    it('closes from its button and takes the paint with it', async () => {
        await open();
        await type('booking');
        await act(async () => button('Close find')!.click());

        expect(bar()).toBeNull();
        expect(painted.size).toBe(0);
    });

    it('takes the paint off the page when it goes away with the bar open', async () => {
        await open();
        await type('booking');
        await act(async () => root.render(null));

        expect(painted.size).toBe(0);
    });

    it('wears the same buttons as the rest of the app', async () => {
        await open();

        for (const label of ['Previous match', 'Next match', 'Close find'])
            expect(button(label)?.dataset.variant).toBe('filling');
    });

    it('Cmd+G opens a closed bar and starts a search, and moves through one that is open', async () => {
        await open();
        await type('booking');
        await act(async () => press('Escape', {}, field()!));
        await act(async () => press('g', { mod: true }));

        expect(bar()).not.toBeNull();
        expect(count()).toBe('1 of 3');

        await act(async () => press('g', { mod: true }));

        expect(count()).toBe('2 of 3');

        await act(async () => press('g', { mod: true, shiftKey: true, code: 'KeyG' }));

        expect(count()).toBe('1 of 3');
    });

    it('Cmd+G with nothing to look for opens the bar and does not search', async () => {
        await draw();
        await act(async () => press('g', { mod: true }));

        expect(bar()).not.toBeNull();
        expect(document.activeElement).toBe(field());
        expect(count()).toBe('');
        expect(painted.size).toBe(0);
    });

    it('goes to the next match from the place the last one stood, even when the page changed in between', async () => {
        await open();
        await type('booking');
        await act(async () => press('Enter', {}, field()!));

        expect(count()).toBe('2 of 3');

        page.insertAdjacentHTML('beforeend', '<p>The last booking of all.</p>');
        await act(async () => press('Enter', {}, field()!));

        expect(count()).toBe('3 of 4');
    });

    it('follows the Edit menu', async () => {
        await draw();
        await act(async () => command?.('open'));

        expect(document.activeElement).toBe(field());

        await type('booking');
        await act(async () => command?.('next'));

        expect(count()).toBe('2 of 3');

        await act(async () => command?.('previous'));

        expect(count()).toBe('1 of 3');
    });
});

describe('Find in page with a code editor in focus', () => {
    it("leaves Find, Find next and Find previous to the editor's own search while it has the focus, and has them back once the focus is elsewhere", async () => {
        await draw();

        const host = document.createElement('div');

        document.body.append(host);

        const view = new EditorView({ doc: 'one two one', extensions: [search({ top: true })], parent: host });

        view.contentDOM.focus();
        act(() => command!('open'));

        expect(bar()).toBeNull();
        expect(host.querySelector('.cm-search')).not.toBeNull();

        act(() => command!('next'));
        act(() => command!('previous'));

        expect(bar()).toBeNull();
        expect(painted.size).toBe(0);

        view.destroy();
        host.remove();
        (document.activeElement as HTMLElement | null)?.blur();
        act(() => command!('open'));

        expect(bar()).not.toBeNull();
    });
});
