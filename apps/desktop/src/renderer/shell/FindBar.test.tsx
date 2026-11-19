// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hotkeys, installDispatcher } from '../hotkeys';
import { FindBar } from './FindBar';

import type { DesktopBridge, FindCommand, FindOptions, FindResult } from '../../shared/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let uninstall: () => void;
let command: ((command: FindCommand) => void) | undefined;

const findInPage = vi.fn<(text: string, options: FindOptions) => Promise<FindResult>>(async () => ({ matches: 4, activeMatchOrdinal: 1 }));
const stopFind = vi.fn(async () => undefined);

const field = () => container.querySelector<HTMLInputElement>('input[aria-label="Find in page"]');
const bar = () => container.querySelector('[role="search"]');
const count = () => container.querySelector('[aria-live="polite"]')?.getAttribute('aria-label');

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

        for (let step = 0; step < 5; step++) await Promise.resolve();
    });
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    uninstall = installDispatcher(hotkeys);
    command = undefined;
    findInPage.mockClear();
    stopFind.mockClear();
    window.desktop = {
        findInPage,
        stopFind,
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
    window.desktop = undefined;
});

async function draw() {
    await act(async () => root.render(<FindBar />));
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
        }
        finally {
            composer.remove();
        }
    });

    it('searches what is typed, then moves to the next and previous match', async () => {
        await draw();
        await act(async () => press('f', { mod: true }));
        await type('booking');

        expect(findInPage).toHaveBeenCalledWith('booking', { forward: true, findNext: true });
        expect(count()).toBe('1 of 3');

        findInPage.mockClear();
        await act(async () => press('Enter', {}, field()!));

        expect(findInPage).toHaveBeenCalledWith('booking', { forward: true, findNext: false });

        findInPage.mockClear();
        await act(async () => press('Enter', { shiftKey: true }, field()!));

        expect(findInPage).toHaveBeenCalledWith('booking', { forward: false, findNext: false });
    });

    it('drops the match in the field, and clears the highlight when that is the only one', async () => {
        findInPage.mockResolvedValue({ matches: 1, activeMatchOrdinal: 1 });
        await draw();
        await act(async () => press('f', { mod: true }));
        await type('booking');

        expect(count()).toBe('No matches');
        expect(stopFind).toHaveBeenCalled();
    });

    it('moves the highlight off the field when the page has other matches', async () => {
        await draw();
        await act(async () => press('f', { mod: true }));

        const input = field()!;

        input.getBoundingClientRect = () => ({
            x: 420,
            y: 48,
            width: 188,
            height: 36,
            left: 420,
            top: 48,
            right: 608,
            bottom: 84,
            toJSON() {
                return {};
            },
        });
        findInPage.mockReset();
        findInPage
            .mockResolvedValueOnce({
                matches: 5,
                activeMatchOrdinal: 2,
                selectionArea: { x: 424, y: 56, width: 40, height: 16 },
            })
            .mockResolvedValueOnce({
                matches: 5,
                activeMatchOrdinal: 3,
                selectionArea: { x: 20, y: 200, width: 40, height: 16 },
            });

        await type('booking');

        expect(findInPage).toHaveBeenLastCalledWith('booking', { forward: true, findNext: false });
        expect(count()).toBe('2 of 4');
        expect(stopFind).not.toHaveBeenCalled();
    });

    it('steps from the last page match, not from the caret in the field', async () => {
        await draw();
        await act(async () => press('f', { mod: true }));
        await type('booking');

        expect(document.activeElement).toBe(field());
        field()!.setSelectionRange(1, 4);

        let focusedDuringFind = true;

        findInPage.mockImplementation(() => {
            focusedDuringFind = document.activeElement === field();

            return Promise.resolve({ matches: 19, activeMatchOrdinal: 2 });
        });

        await act(async () => {
            press('Enter', {}, field()!);

            for (let step = 0; step < 5; step++) await Promise.resolve();
        });

        expect(focusedDuringFind).toBe(false);
        expect(document.activeElement).toBe(field());
        expect(count()).toBe('2 of 18');
        expect(field()!.selectionStart).toBe(1);
        expect(field()!.selectionEnd).toBe(4);
    });

    it('says when nothing matches, and Escape closes the bar and clears the highlights', async () => {
        findInPage.mockResolvedValue({ matches: 0, activeMatchOrdinal: 0 });
        await draw();
        await act(async () => press('f', { mod: true }));
        await type('zzzz');

        expect(count()).toBe('No matches');

        await act(async () => press('Escape', {}, field()!));

        expect(bar()).toBeNull();
        expect(stopFind).toHaveBeenCalled();
    });

    it('Cmd+G opens a closed bar and starts a search, and moves through one that is open', async () => {
        await draw();
        await act(async () => press('f', { mod: true }));
        await type('booking');
        await act(async () => press('Escape', {}, field()!));

        findInPage.mockClear();
        await act(async () => press('g', { mod: true }));

        expect(bar()).not.toBeNull();
        expect(findInPage).toHaveBeenCalledWith('booking', { forward: true, findNext: true });

        findInPage.mockClear();
        await act(async () => press('g', { mod: true, shiftKey: true, code: 'KeyG' }));

        expect(findInPage).toHaveBeenCalledWith('booking', { forward: false, findNext: false });
    });

    it('follows the Edit menu', async () => {
        await draw();
        await act(async () => command?.('open'));

        expect(document.activeElement).toBe(field());

        await type('booking');
        findInPage.mockClear();
        await act(async () => command?.('next'));

        expect(findInPage).toHaveBeenCalledWith('booking', { forward: true, findNext: false });
    });

    describe('a search that finishes late', () => {
        const pending: Array<(result: FindResult) => void> = [];

        beforeEach(() => {
            pending.length = 0;
            findInPage.mockImplementation(() => new Promise(resolve => {
                pending.push(resolve);
            }));
        });

        afterEach(() => {
            findInPage.mockReset();
            findInPage.mockResolvedValue({ matches: 4, activeMatchOrdinal: 1 });
        });

        async function finish(index: number, result: FindResult = { matches: 3, activeMatchOrdinal: 1 }) {
            await act(async () => {
                pending[index]!(result);
                await Promise.resolve();
            });
        }

        it('clears the highlights again when the query was emptied', async () => {
            await draw();
            await act(async () => press('f', { mod: true }));
            await type('booking');

            stopFind.mockClear();
            await type('');

            expect(stopFind).toHaveBeenCalledTimes(1);
            expect(count() ?? '').toBe('');

            stopFind.mockClear();
            await finish(0);

            expect(stopFind).toHaveBeenCalledTimes(1);
            expect(count() ?? '').toBe('');
            expect(bar()).not.toBeNull();
        });

        it('clears the highlights again after Escape', async () => {
            await draw();
            await act(async () => press('f', { mod: true }));
            await type('booking');

            stopFind.mockClear();
            await act(async () => press('Escape', {}, field()!));

            expect(bar()).toBeNull();
            expect(stopFind).toHaveBeenCalledTimes(1);

            stopFind.mockClear();
            await finish(0);

            expect(stopFind).toHaveBeenCalledTimes(1);
        });

        it('leaves a newer search alone when an older one finishes', async () => {
            await draw();
            await act(async () => press('f', { mod: true }));
            await type('book');
            await type('booking');

            stopFind.mockClear();
            await finish(0);

            expect(stopFind).not.toHaveBeenCalled();

            await finish(1);

            expect(stopFind).not.toHaveBeenCalled();
            expect(count()).toBe('1 of 2');
        });
    });
});
