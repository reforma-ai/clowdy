// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from './dispatcher';
import { HelpOverlay } from './HelpOverlay';
import { createRegistry, type Command, type HotkeyRegistry } from './registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Overlay = observer(HelpOverlay);

let container: HTMLDivElement;
const flush = () => act(async () => Promise.resolve());
let root: Root;
let registry: HotkeyRegistry;
let uninstall: () => void;
const moveDown = vi.fn();

const define = (command: Pick<Command, 'id' | 'title' | 'group' | 'keys'> & Partial<Command>) => registry.defineCommand({ scope: 'app', handler: () => undefined, ...command });
const list = () => container.querySelector('[role="listbox"]') as HTMLElement;
const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
const titleOf = (row: Element | null) => row?.querySelector('[slot="label"]')?.textContent;
const titles = () => rows().map(titleOf);
const sections = () => Array.from(container.querySelectorAll('[role="group"]'), section => ({
    name: section.querySelector('header')?.textContent,
    titles: Array.from(section.querySelectorAll('[role="option"]'), titleOf),
}));
const keysOf = (row: Element) => Array.from(row.querySelectorAll('[data-hotkey]'), element => element.textContent);
const active = () => titleOf(document.activeElement);

function press(key: string, target: Element = document.activeElement ?? document.body) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    act(() => {
        target.dispatchEvent(event);
    });

    return event;
}

beforeEach(() => {
    moveDown.mockClear();
    registry = createRegistry('darwin');
    uninstall = installDispatcher(registry);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
});

function render() {
    define({ id: 'help.open', title: 'Show keyboard shortcuts', group: 'General', keys: ['?', '$mod+/'] });
    define({ id: 'nav.tasks', title: 'Go to Tasks', group: 'Navigation', keys: 'g t' });
    define({ id: 'nav.chats', title: 'Go to Chats', group: 'Navigation', keys: 'g c' });
    define({ id: 'tasks.cursor.down', title: 'Move down', group: 'Tasks', keys: ['ArrowDown', 'j'], scope: 'tasks', handler: moveDown });
    // `Modal` draws every window in an overlay, which the dispatcher reads to keep single keys away from a dialog's own widgets.
    act(() => root.render(<div data-modal-overlay=""><Overlay registry={ registry } /></div>));
}

describe('HelpOverlay', () => {
    it('lists every command in a section of its group, headed by the group name', () => {
        render();

        expect(sections()).toEqual([
            { name: 'General', titles: ['Show keyboard shortcuts'] },
            { name: 'Navigation', titles: ['Go to Tasks', 'Go to Chats'] },
            { name: 'Tasks', titles: ['Move down'] },
        ]);
    });

    it('is one labelled list with no search field', () => {
        render();

        expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(1);
        expect(list().getAttribute('aria-label')).toBe('Keyboard shortcuts');
        expect(container.querySelector('input, [role="searchbox"]')).toBeNull();
    });

    it('shows the keys of each command in its row, with every alternative and a quiet "or" between them', () => {
        render();

        const [help, tasks, , move] = rows();

        // The modifier's symbol depends on the platform the page reports, which a test does not pin.
        const helpKeys = keysOf(help);

        expect(helpKeys).toHaveLength(2);
        expect(helpKeys[0]).toBe('?');
        expect(helpKeys[1]).toMatch(/\/$/);
        expect(help.querySelector('[slot="endAffix"]')?.textContent).toMatch(/^\?or.*\/$/);
        expect(keysOf(tasks)).toEqual(['G', 'T']);
        expect(tasks.querySelector('[data-hotkey-sequence]')?.textContent).toBe('GthenT');
        expect(keysOf(move)).toEqual(['↓', 'J']);
        expect(move.querySelector('[slot="endAffix"]')?.textContent).toBe('↓orJ');
    });

    it('follows the registry as commands come and go', async () => {
        render();

        let remove: () => void = () => undefined;

        act(() => {
            remove = define({ id: 'late.command', title: 'Defined later', group: 'Tasks', keys: 'z' });
        });
        await flush();

        expect(sections().find(section => section.name === 'Tasks')?.titles).toEqual(['Move down', 'Defined later']);

        act(() => remove());
        await flush();

        expect(titles()).not.toContain('Defined later');
    });

    describe('keyboard', () => {
        it('takes the focus when it mounts, so its keys work at once', () => {
            render();

            expect(document.activeElement).toBe(list());
        });

        it('moves the active row with the arrow, Home and End keys, across sections', () => {
            render();

            press('ArrowDown');
            expect(active()).toBe('Show keyboard shortcuts');

            press('ArrowDown');
            expect(active()).toBe('Go to Tasks');

            press('ArrowDown');
            press('ArrowDown');
            expect(active()).toBe('Move down');

            press('ArrowUp');
            expect(active()).toBe('Go to Chats');

            press('End');
            expect(active()).toBe('Move down');

            press('Home');
            expect(active()).toBe('Show keyboard shortcuts');
        });

        it('brings the row it moved to into view', async () => {
            const original = Element.prototype.scrollIntoView;
            const scrolled: (string | null | undefined)[] = [];

            Element.prototype.scrollIntoView = function (this: Element) {
                scrolled.push(titleOf(this));
            };

            try {
                render();

                press('ArrowDown');
                await flush();

                expect(new Set(scrolled)).toEqual(new Set(['Show keyboard shortcuts']));

                press('ArrowDown');
                await flush();

                expect(new Set(scrolled)).toEqual(new Set(['Show keyboard shortcuts', 'Go to Tasks']));
            }
            finally {
                Element.prototype.scrollIntoView = original;
            }
        });

        it('leaves the arrows and letters to the list while a window is open, even for live commands that own them', () => {
            const handler = vi.fn();

            define({ id: 'x.single', title: 'Single', group: 'Tests', keys: 'x', handler });
            define({ id: 'q.chord', title: 'Chord', group: 'Tests', keys: 'q w', handler });
            render();
            // The Tasks screen is showing under the window: its `ArrowDown` and `J` are live, and the list must still get the arrow.
            registry.pushScope('tasks');

            press('ArrowDown');
            expect(active()).toBe('Show keyboard shortcuts');

            press('ArrowDown');
            expect(active()).toBe('Go to Tasks');

            press('ArrowUp');
            expect(active()).toBe('Show keyboard shortcuts');

            for (const key of ['x', 'q', 'w', 'j', '?']) press(key);

            expect(handler).not.toHaveBeenCalled();
            expect(moveDown).not.toHaveBeenCalled();
            expect(registry.pending).toBeNull();
        });

        it('selects nothing and runs nothing on Enter, on Space or on a click: the rows only inform', () => {
            const handler = vi.fn();

            define({ id: 'x.enter', title: 'Enter command', group: 'Tests', keys: 'Enter', handler });
            render();

            press('ArrowDown');
            press('Enter');
            press(' ');
            act(() => rows()[0].click());

            expect(handler).not.toHaveBeenCalled();
            expect(container.querySelector('[aria-selected="true"], [data-selected]')).toBeNull();
            expect(rows().every(row => !row.hasAttribute('aria-selected'))).toBe(true);
        });
    });

    describe('pointer', () => {
        const plate = () => list().style.getPropertyValue('--clowdy-listbox-highlight-opacity');

        it('shows the list\'s sliding plate under the hovered row and takes it away when the pointer leaves', () => {
            render();

            expect(plate()).toBe('0');

            act(() => {
                rows()[1].dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5 }));
            });

            expect(plate()).toBe('1');

            act(() => {
                list().dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
            });

            expect(plate()).toBe('0');
        });

        it('uses the list\'s own row look, so the plate and the row share one source', () => {
            render();

            expect(list().hasAttribute('data-interactive')).toBe(true);
            expect(list().getAttribute('data-size')).toBe('md');
        });
    });
});
