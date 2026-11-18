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
let root: Root;
let registry: HotkeyRegistry;
let uninstall: () => void;

const define = (command: Pick<Command, 'id' | 'title' | 'group' | 'keys'> & Partial<Command>) => registry.defineCommand({ scope: 'app', handler: () => undefined, ...command });
const field = () => container.querySelector('input') as HTMLInputElement;
const rows = () => Array.from(container.querySelectorAll('li'));
const titles = () => rows().map(row => row.firstElementChild?.textContent);
const headings = () => Array.from(container.querySelectorAll('h3'), heading => heading.textContent);

function type(text: string) {
    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(), text);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
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
    define({ id: 'tasks.cursor.down', title: 'Move down', group: 'Tasks', keys: ['ArrowDown', 'j'], scope: 'tasks' });
    act(() => root.render(<Overlay registry={ registry } />));
}

const press = (key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

    act(() => {
        field().dispatchEvent(event);
    });

    return event;
};

describe('HelpOverlay', () => {
    it('lists every command under its group', () => {
        render();

        expect(headings()).toEqual(['General', 'Navigation', 'Tasks']);
        expect(titles()).toEqual(['Show keyboard shortcuts', 'Go to Tasks', 'Go to Chats', 'Move down']);
    });

    it('shows the keys of each command, with every alternative', () => {
        render();

        const [help, tasks, , move] = rows();

        // The modifier's symbol depends on the platform the page reports, which a test does not pin.
        const helpKeys = Array.from(help.querySelectorAll('[data-hotkey]'), element => element.textContent);

        expect(helpKeys).toHaveLength(2);
        expect(helpKeys[0]).toBe('?');
        expect(helpKeys[1]).toMatch(/\/$/);
        expect(Array.from(tasks.querySelectorAll('[data-hotkey]'), element => element.textContent)).toEqual(['G', 'T']);
        expect(tasks.querySelector('[data-hotkey-sequence]')?.textContent).toBe('GthenT');
        expect(Array.from(move.querySelectorAll('[data-hotkey]'), element => element.textContent)).toEqual(['↓', 'J']);
        expect(move.textContent).toContain('or');
    });



    it('filters as the person types, by title and by keys', () => {
        render();
        type('chats');

        expect(titles()).toEqual(['Go to Chats']);
        expect(headings()).toEqual(['Navigation']);

        type('g then t');

        expect(titles()).toEqual(['Go to Tasks']);

        type('arrow');

        expect(titles()).toEqual(['Move down']);

        type('');

        expect(rows()).toHaveLength(4);
    });

    it('says so when nothing matches', () => {
        render();
        type('zzz');

        expect(rows()).toHaveLength(0);
        expect(container.textContent).toContain('No shortcut matches “zzz”');
    });

    it('scrolls the list from the search field with the arrow and page keys, so a long list is reachable without a pointer', () => {
        render();

        const scroller = container.querySelector('[tabindex="-1"]') as HTMLElement;
        const scrollBy = vi.fn();

        Object.defineProperty(scroller, 'clientHeight', { value: 400 });
        scroller.scrollBy = scrollBy;

        expect(press('ArrowDown').defaultPrevented).toBe(true);
        expect(scrollBy).toHaveBeenLastCalledWith({ top: 48 });

        press('PageUp');

        expect(scrollBy).toHaveBeenLastCalledWith({ top: -360 });

        expect(press('a').defaultPrevented).toBe(false);
        expect(scrollBy).toHaveBeenCalledTimes(2);
    });

    it('keeps single keys and chords off while the search field has focus', () => {
        const handler = vi.fn();

        define({ id: 'x.single', title: 'Single', group: 'Tests', keys: 'x', handler });
        define({ id: 'q.chord', title: 'Chord', group: 'Tests', keys: 'q w', handler });
        render();

        for (const key of ['x', 'q', 'w', '?']) {
            const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });

            act(() => {
                field().dispatchEvent(event);
            });

            expect(event.defaultPrevented).toBe(false);
        }

        expect(handler).not.toHaveBeenCalled();
        expect(registry.pending).toBeNull();
    });
});
