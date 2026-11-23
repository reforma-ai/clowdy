// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from './dispatcher';
import { type Command, createRegistry, type HotkeyRegistry, type Platform } from './registry';

interface PressInit extends KeyboardEventInit {
    /** What `getModifierState('AltGraph')` answers. */
    altGraph?: boolean;
}

/** Dispatches a keydown on the target and returns the event, so a test can read `defaultPrevented`. */
function press(target: EventTarget, key: string, { altGraph = false, ...init }: PressInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    const getModifierState = event.getModifierState.bind(event);

    event.getModifierState = (modifier: string) => (modifier === 'AltGraph' ? altGraph : getModifierState(modifier));
    target.dispatchEvent(event);

    return event;
}

let registry: HotkeyRegistry;
let uninstall: () => void;
let body: HTMLElement;
let counter = 0;

function setup(platform: Platform = 'darwin') {
    uninstall?.();
    registry = createRegistry(platform);
    uninstall = installDispatcher(registry);
}

/** A live command in the app scope that records its calls. */
function define(keys: Command['keys'], overrides: Partial<Command> = {}): ReturnType<typeof vi.fn> {
    const handler = vi.fn();

    registry.defineCommand({
        id: `command-${++counter}`,
        title: 'Command',
        group: 'Tests',
        keys,
        scope: 'app',
        handler,
        ...overrides,
    });

    return handler;
}

beforeEach(() => {
    body = document.body;
    setup();
});

afterEach(() => {
    uninstall();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('chords', () => {
    it('calls the handler once after g then c, and clears the pending chord', () => {
        const handler = define('g c');

        press(body, 'g');

        expect(handler).not.toHaveBeenCalled();
        expect(registry.pending?.typed).toEqual([['g']]);

        press(body, 'c');

        expect(handler).toHaveBeenCalledTimes(1);
        expect(registry.pending).toBeNull();

        press(body, 'c');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lists what the next key can complete while the chord waits', () => {
        define('g c', { id: 'nav.chats', title: 'Chats' });
        define('g t', { id: 'nav.tasks', title: 'Tasks' });
        define('x', { id: 'other', title: 'Other' });

        press(body, 'g');

        expect(registry.pending?.candidates.map(({ command, remaining }) => [command.id, remaining])).toEqual([
            ['nav.chats', [['c']]],
            ['nav.tasks', [['t']]],
        ]);
    });

    it('cancels on a key that does not continue it, and then the second key alone does nothing', () => {
        const handler = define('g c');

        press(body, 'g');

        const wrong = press(body, 'x');

        expect(registry.pending).toBeNull();
        expect(wrong.defaultPrevented).toBe(false);

        press(body, 'c');

        expect(handler).not.toHaveBeenCalled();
    });

    it('lets the key that broke a chord start a command of its own', () => {
        const chord = define('g c');
        const single = define('j');

        press(body, 'g');

        const event = press(body, 'j');

        expect(chord).not.toHaveBeenCalled();
        expect(single).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
    });

    it('cancels on Escape, clears the pending chord and claims the key', () => {
        const handler = define('g c');

        press(body, 'g');

        const escape = press(body, 'Escape');

        expect(registry.pending).toBeNull();
        expect(escape.defaultPrevented).toBe(true);

        press(body, 'c');

        expect(handler).not.toHaveBeenCalled();
    });

    it('cancels after the timeout', () => {
        vi.useFakeTimers();

        const handler = define('g c');

        press(body, 'g');
        vi.advanceTimersByTime(999);

        expect(registry.pending).not.toBeNull();

        vi.advanceTimersByTime(1);

        expect(registry.pending).toBeNull();

        press(body, 'c');

        expect(handler).not.toHaveBeenCalled();
    });

    it('restarts the timeout on each press', () => {
        vi.useFakeTimers();

        const handler = define('g a b');

        press(body, 'g');
        vi.advanceTimersByTime(800);
        press(body, 'a');
        vi.advanceTimersByTime(800);

        expect(registry.pending?.typed).toEqual([['g'], ['a']]);

        press(body, 'b');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('is not broken by a modifier key pressed on the way to the next key', () => {
        const handler = define('g Shift+c');

        press(body, 'g');
        press(body, 'Shift', { shiftKey: true });
        press(body, 'C', { shiftKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not let a held key continue or break the chord, and keeps the held key from type-ahead', () => {
        const handler = define('g c');

        press(body, 'g');

        const held = press(body, 'g', { repeat: true });

        expect(held.defaultPrevented).toBe(true);
        expect(registry.pending).not.toBeNull();

        press(body, 'c');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not restart a chord from the repeats of a held first key once it timed out', () => {
        vi.useFakeTimers();
        define('g c');
        press(body, 'g');
        vi.advanceTimersByTime(1000);

        const held = press(body, 'g', { repeat: true });

        expect(registry.pending).toBeNull();
        expect(held.defaultPrevented).toBe(true);
    });

    it('leaves nothing pending and keeps working after a handler throws', () => {
        const good = vi.fn();

        registry.defineCommand({
            id: 'bad',
            title: 'Bad',
            group: 'Tests',
            keys: 'g b',
            scope: 'app',
            handler: () => {
                throw new Error('boom');
            },
        });
        registry.defineCommand({ id: 'good', title: 'Good', group: 'Tests', keys: 'g c', scope: 'app', handler: good });
        press(body, 'g');

        // happy-dom rethrows an error from a listener, where a browser reports it and carries on.
        expect(() => press(body, 'b')).toThrow('boom');
        expect(registry.pending).toBeNull();

        press(body, 'g');
        press(body, 'c');

        expect(good).toHaveBeenCalledTimes(1);
    });

    it('claims the first key of a chord so type-ahead never sees it', () => {
        define('g c');

        expect(press(body, 'g').defaultPrevented).toBe(true);
    });

    it('drops a pending chord whose command was removed', () => {
        const handler = vi.fn();
        const dispose = registry.defineCommand({
            id: 'a',
            title: 'A',
            group: 'Tests',
            keys: 'g c',
            scope: 'app',
            handler,
        });

        press(body, 'g');
        dispose();
        press(body, 'c');

        expect(handler).not.toHaveBeenCalled();
        expect(registry.pending).toBeNull();
    });

    it('clears the chord when the dispatcher is removed', () => {
        define('g c');
        press(body, 'g');
        uninstall();

        expect(registry.pending).toBeNull();
    });
});

describe('text targets', () => {
    function field(tag: string, attributes: Record<string, string> = {}): HTMLElement {
        const element = document.createElement(tag);

        Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
        body.append(element);

        return element;
    }

    it.each([
        ['an input', () => field('input', { type: 'text' })],
        ['an input without a type', () => field('input')],
        ['a search input', () => field('input', { type: 'search' })],
        ['a textarea', () => field('textarea')],
        ['a select', () => field('select')],
        ['a contenteditable', () => field('div', { contenteditable: 'true' })],
        ['an empty contenteditable attribute', () => field('div', { contenteditable: '' })],
        [
            'an element inside a contenteditable',
            () => {
                const editor = field('div', { contenteditable: 'true' });
                const inner = document.createElement('span');

                editor.append(inner);

                return inner;
            },
        ],
        ['a textbox role', () => field('div', { role: 'textbox' })],
        ['a combobox role', () => field('div', { role: 'combobox' })],
        ['a searchbox role', () => field('div', { role: 'searchbox' })],
        ['a spinbutton role', () => field('div', { role: 'spinbutton' })],
    ])('blocks single keys on %s but not a command that allows inputs', (_, create) => {
        const plain = define('x');
        const allowed = define('y', { inInputs: true });
        const target = create();

        expect(press(target, 'x').defaultPrevented).toBe(false);
        expect(press(target, 'y').defaultPrevented).toBe(true);
        expect(plain).not.toHaveBeenCalled();
        expect(allowed).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a checkbox', () => field('input', { type: 'checkbox' })],
        ['a radio', () => field('input', { type: 'radio' })],
        ['a range', () => field('input', { type: 'range' })],
        ['a button input', () => field('input', { type: 'button' })],
        ['a button', () => field('button')],
        ['a contenteditable switched off', () => field('div', { contenteditable: 'false' })],
        ['a plain element', () => field('div')],
    ])('lets a single key through on %s', (_, create) => {
        const handler = define('x');

        press(create(), 'x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not start a chord in a text field', () => {
        const handler = define('g c');
        const input = field('input');

        press(input, 'g');
        press(input, 'c');

        expect(handler).not.toHaveBeenCalled();
        expect(registry.pending).toBeNull();
    });
});

describe('IME composition', () => {
    it.each([
        ['isComposing', 'x', { isComposing: true }],
        ['keyCode 229', 'x', { keyCode: 229 }],
        ['the Process key', 'Process', {}],
    ])('ignores a key with %s, even for a command that works in inputs', (_, key, init) => {
        const handler = define(key, { inInputs: true, inOverlays: true });
        const event = press(body, key, init);

        expect(handler).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
    });

    it('does not break a pending chord', () => {
        const handler = define('g c');

        press(body, 'g');
        press(body, 'c', { isComposing: true });

        expect(registry.pending).not.toBeNull();

        press(body, 'c');

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('key repeat', () => {
    it('does not run a command for a held key, and swallows the key', () => {
        const handler = define('x');

        press(body, 'x');

        const held = press(body, 'x', { repeat: true });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(held.defaultPrevented).toBe(true);
    });

    it('runs a command that asks for repeats on every repeat', () => {
        const handler = define('j', { repeat: true });

        press(body, 'j');
        press(body, 'j', { repeat: true });
        press(body, 'j', { repeat: true });

        expect(handler).toHaveBeenCalledTimes(3);
    });

    it('leaves a held key that no command takes alone', () => {
        expect(press(body, 'q', { repeat: true }).defaultPrevented).toBe(false);
    });

    describe('after the command moved the keyboard into a text field', () => {
        let field: HTMLInputElement;

        beforeEach(() => {
            field = document.createElement('input');
            document.body.append(field);
            define('/', { handler: () => field.focus() });
        });

        it('keeps taking the held key, so the field does not type it again and again', () => {
            press(body, '/', { code: 'Slash' });

            expect(document.activeElement).toBe(field);
            expect(press(field, '/', { code: 'Slash', repeat: true }).defaultPrevented).toBe(true);
            expect(press(field, '/', { code: 'Slash', repeat: true }).defaultPrevented).toBe(true);
        });

        it('leaves the key to the field once it was let go and pressed again, and when another key came between', () => {
            press(body, '/', { code: 'Slash' });

            expect(press(field, '/', { code: 'Slash' }).defaultPrevented).toBe(false);
            expect(press(field, '/', { code: 'Slash', repeat: true }).defaultPrevented).toBe(false);

            press(body, '/', { code: 'Slash' });
            press(field, 'a', { code: 'KeyA' });

            expect(press(field, '/', { code: 'Slash', repeat: true }).defaultPrevented).toBe(false);
        });

        it('takes no other key that is held', () => {
            press(body, '/', { code: 'Slash' });

            expect(press(field, 'a', { code: 'KeyA', repeat: true }).defaultPrevented).toBe(false);
        });
    });
});

describe('overlays', () => {
    it('blocks a command outside the overlay while a Modal overlay is open, and lets one that allows overlays through', () => {
        const outside = define('x');
        const inside = define('y', { inOverlays: true });
        const overlay = document.createElement('div');

        overlay.setAttribute('data-modal-overlay', '');
        body.append(overlay);

        // The key comes from the page behind the overlay, which Modal does not make inert.
        expect(press(body, 'x').defaultPrevented).toBe(false);
        expect(press(body, 'y').defaultPrevented).toBe(true);
        expect(outside).not.toHaveBeenCalled();
        expect(inside).toHaveBeenCalledTimes(1);
    });

    it('runs the command again once the overlay is gone', () => {
        const handler = define('x');
        const overlay = document.createElement('div');

        overlay.setAttribute('data-modal-overlay', '');
        body.append(overlay);
        press(body, 'x');
        overlay.remove();
        press(body, 'x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a dialog', { role: 'dialog' }],
        ['an alert dialog', { role: 'alertdialog' }],
        ['a popover layer', { 'data-modal-clickout-layer': '' }],
    ])('blocks keys that come from inside %s', (_, attributes) => {
        const outside = define('x');
        const inside = define('y', { inOverlays: true });
        const container = document.createElement('div');
        const button = document.createElement('button');

        Object.entries(attributes).forEach(([name, value]) => container.setAttribute(name, value));
        container.append(button);
        body.append(container);
        press(button, 'x');
        press(button, 'y');

        expect(outside).not.toHaveBeenCalled();
        expect(inside).toHaveBeenCalledTimes(1);
    });

    it.each(['listbox', 'menu'])(
        'blocks keys from a %s inside a popover, which React Aria renders as a dialog',
        role => {
            const handler = define('x');
            const popover = document.createElement('div');
            const list = document.createElement('div');
            const option = document.createElement('div');

            popover.setAttribute('role', 'dialog');
            popover.setAttribute('data-modal-clickout-layer', '');
            list.setAttribute('role', role);
            option.setAttribute('role', role === 'menu' ? 'menuitem' : 'option');
            list.append(option);
            popover.append(list);
            body.append(popover);
            press(option, 'x');

            expect(handler).not.toHaveBeenCalled();
        }
    );

    it.each(['listbox', 'menu'])('does not take a %s that sits in the page for an overlay', role => {
        const handler = define('x');
        const list = document.createElement('div');
        const option = document.createElement('div');

        list.setAttribute('role', role);
        list.append(option);
        body.append(list);

        expect(press(option, 'x').defaultPrevented).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('AltGr', () => {
    it('does not read the Ctrl+Alt of AltGr as the modifiers of a command', () => {
        setup('win32');

        const handler = define('Control+Alt+q');

        press(body, 'q', { ctrlKey: true, altKey: true, altGraph: true });

        expect(handler).not.toHaveBeenCalled();

        press(body, 'q', { ctrlKey: true, altKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not run a plain key command for a character typed with AltGr', () => {
        setup('win32');

        const handler = define('q');

        expect(press(body, 'q', { ctrlKey: true, altKey: true, altGraph: true }).defaultPrevented).toBe(false);
        expect(handler).not.toHaveBeenCalled();
    });
});

describe('platform keys', () => {
    const keys = { mac: '$mod+Backspace', win: '$mod+Delete' };

    it('uses the Mac keys on macOS', () => {
        setup('darwin');

        const handler = define(keys);

        press(body, 'Delete', { ctrlKey: true });
        press(body, 'Backspace', { ctrlKey: true });

        expect(handler).not.toHaveBeenCalled();

        press(body, 'Backspace', { metaKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it.each<Platform>(['win32', 'linux'])('uses the Windows keys on %s', platform => {
        setup(platform);

        const handler = define(keys);

        press(body, 'Backspace', { metaKey: true });
        press(body, 'Delete', { metaKey: true });

        expect(handler).not.toHaveBeenCalled();

        press(body, 'Delete', { ctrlKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('resolves $mod to the platform modifier', () => {
        setup('win32');

        const handler = define('$mod+k');

        press(body, 'k', { metaKey: true });

        expect(handler).not.toHaveBeenCalled();

        press(body, 'k', { ctrlKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('scopes and when', () => {
    it('runs a command only while its scope is on the stack', () => {
        const handler = define('x', { scope: 'tasks' });

        press(body, 'x');

        expect(handler).not.toHaveBeenCalled();

        const pop = registry.pushScope('tasks');

        press(body, 'x');

        expect(handler).toHaveBeenCalledTimes(1);

        pop();
        press(body, 'x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('runs the command of the innermost scope when two live commands share keys', () => {
        const outer = define('Enter', { scope: 'tasks' });
        const inner = define('Enter', { scope: 'picker' });

        registry.pushScope('tasks');

        const popPicker = registry.pushScope('picker');

        press(body, 'Enter');

        expect(inner).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();

        popPicker();
        press(body, 'Enter');

        expect(outer).toHaveBeenCalledTimes(1);
    });

    it('lets the scope pushed last win whatever order the commands were defined in', () => {
        const picker = define('Enter', { scope: 'picker' });
        const tasks = define('Enter', { scope: 'tasks' });

        registry.pushScope('picker');
        registry.pushScope('tasks');
        press(body, 'Enter');

        expect(tasks).toHaveBeenCalledTimes(1);
        expect(picker).not.toHaveBeenCalled();
    });

    it('lets a single key of an inner scope shadow a chord that starts with it in an outer scope', () => {
        const chord = define('o c', { scope: 'tasks' });
        const single = define('o', { scope: 'picker' });

        registry.pushScope('tasks');

        const popPicker = registry.pushScope('picker');

        press(body, 'o');

        expect(single).toHaveBeenCalledTimes(1);
        expect(registry.pending).toBeNull();

        press(body, 'c');

        expect(chord).not.toHaveBeenCalled();

        popPicker();
        press(body, 'o');
        press(body, 'c');

        expect(single).toHaveBeenCalledTimes(1);
        expect(chord).toHaveBeenCalledTimes(1);
    });

    it('does not call a command whose when returns false, and leaves the key alone', () => {
        let enabled = false;
        const handler = define('x', { when: () => enabled });

        expect(press(body, 'x').defaultPrevented).toBe(false);
        expect(handler).not.toHaveBeenCalled();

        enabled = true;
        press(body, 'x');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets the key reach a command of an outer scope when the inner one is switched off by when', () => {
        const outer = define('Enter', { scope: 'tasks' });

        define('Enter', { scope: 'picker', when: () => false });
        registry.pushScope('tasks');
        registry.pushScope('picker');
        press(body, 'Enter');

        expect(outer).toHaveBeenCalledTimes(1);
    });
});

describe('focus', () => {
    it('does not run a command whose focus says the keyboard is elsewhere, and leaves the key alone', () => {
        let inList = false;
        const handler = define('j', { focus: () => inList });

        expect(press(body, 'j').defaultPrevented).toBe(false);
        expect(handler).not.toHaveBeenCalled();

        inList = true;

        expect(press(body, 'j').defaultPrevented).toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('needs both when and focus', () => {
        let exists = true;
        let inList = true;
        const handler = define('j', { when: () => exists, focus: () => inList });

        exists = false;
        press(body, 'j');
        exists = true;
        inList = false;
        press(body, 'j');

        expect(handler).not.toHaveBeenCalled();

        inList = true;
        press(body, 'j');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets the key reach a command of an outer scope when the inner one has no focus, as it does for when', () => {
        const outer = define('Enter', { scope: 'tasks' });

        define('Enter', { scope: 'picker', focus: () => false });
        registry.pushScope('tasks');
        registry.pushScope('picker');
        press(body, 'Enter');

        expect(outer).toHaveBeenCalledTimes(1);
    });

    it('does not start a chord for a command without focus, and checks it again for the next key', () => {
        let inList = false;
        const chord = define('o c', { focus: () => inList });

        press(body, 'o');

        expect(registry.pending).toBeNull();

        inList = true;
        press(body, 'o');

        expect(registry.pending?.typed).toEqual([['o']]);

        inList = false;
        press(body, 'c');

        expect(chord).not.toHaveBeenCalled();
        expect(registry.pending).toBeNull();
    });

    it('is asked while a command is held, so a held key is still swallowed only where the command applies', () => {
        let inList = true;
        const handler = define('j', { repeat: true, focus: () => inList });

        press(body, 'j', { repeat: true });

        expect(handler).toHaveBeenCalledTimes(1);

        inList = false;

        expect(press(body, 'j', { repeat: true }).defaultPrevented).toBe(false);
        expect(handler).toHaveBeenCalledTimes(1);
    });
});

describe('matching', () => {
    it('treats modifiers as strict', () => {
        const plain = define('r');
        const shifted = define('Shift+r');

        press(body, 'R', { shiftKey: true });

        expect(plain).not.toHaveBeenCalled();
        expect(shifted).toHaveBeenCalledTimes(1);

        press(body, 'r');

        expect(plain).toHaveBeenCalledTimes(1);
        expect(shifted).toHaveBeenCalledTimes(1);
    });

    it('does not run a plain key while Cmd or Ctrl is held', () => {
        const handler = define('c');

        press(body, 'c', { metaKey: true });
        press(body, 'c', { ctrlKey: true });

        expect(handler).not.toHaveBeenCalled();
    });

    it('matches a symbol key typed with Shift', () => {
        const handler = define('?');

        press(body, '?', { shiftKey: true });
        press(body, '?');

        expect(handler).toHaveBeenCalledTimes(2);
    });

    it('keeps `/` and `?` apart on a US layout, where Shift+/ types `?`', () => {
        const slash = define('/');
        const question = define('?');

        press(body, '?', { code: 'Slash', shiftKey: true });

        expect(question).toHaveBeenCalledTimes(1);
        expect(slash).not.toHaveBeenCalled();

        press(body, '/', { code: 'Slash' });

        expect(slash).toHaveBeenCalledTimes(1);
        expect(question).toHaveBeenCalledTimes(1);
    });

    it('matches `/` where it needs Shift, as on a German layout', () => {
        const slash = define('/');

        press(body, '/', { code: 'Digit7', shiftKey: true });

        expect(slash).toHaveBeenCalledTimes(1);
    });

    it('does not take Shift for a letter command', () => {
        const handler = define('c');

        press(body, 'C', { code: 'KeyC', shiftKey: true });

        expect(handler).not.toHaveBeenCalled();
    });

    it('matches by code as well as by key', () => {
        const handler = define('$mod+Shift+Quote');

        press(body, '"', { code: 'Quote', metaKey: true, shiftKey: true });

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('matches case-insensitively, so Caps Lock does not hide a command', () => {
        const handler = define('c');

        press(body, 'C');

        expect(handler).toHaveBeenCalledTimes(1);
    });

    it('matches a letter command by the physical key on a layout without Latin letters', () => {
        const chord = define('g c');
        const modified = define('$mod+a');
        const shifted = define('Shift+r');

        press(body, 'п', { code: 'KeyG' });
        press(body, 'с', { code: 'KeyC' });
        press(body, 'ф', { code: 'KeyA', metaKey: true });
        press(body, 'К', { code: 'KeyR', shiftKey: true });

        expect(chord).toHaveBeenCalledTimes(1);
        expect(modified).toHaveBeenCalledTimes(1);
        expect(shifted).toHaveBeenCalledTimes(1);
    });

    it('matches a Latin layout by the letter it types, not by the key position', () => {
        const typed = define('j');
        const position = define('c');

        // The C position of a Dvorak keyboard types `j`.
        press(body, 'j', { code: 'KeyC' });

        expect(typed).toHaveBeenCalledTimes(1);
        expect(position).not.toHaveBeenCalled();

        // `ö` is a Latin letter, so it does not stand for the key's physical letter.
        press(body, 'ö', { code: 'KeyP' });

        expect(position).not.toHaveBeenCalled();
    });

    it('ignores events that carry no key', () => {
        const handler = define('x');
        const event = new Event('keydown', { bubbles: true, cancelable: true });

        body.dispatchEvent(event);

        expect(handler).not.toHaveBeenCalled();
    });
});

describe('claiming keys', () => {
    it('stops a claimed key before a bubbling listener on the target sees it', () => {
        define('x');

        const target = document.createElement('div');
        const seen = vi.fn();

        target.addEventListener('keydown', seen);
        body.append(target);

        const event = press(target, 'x');

        expect(event.defaultPrevented).toBe(true);
        expect(seen).not.toHaveBeenCalled();
    });

    it('leaves a key that no command takes untouched', () => {
        define('x');

        const target = document.createElement('div');
        const seen = vi.fn();

        target.addEventListener('keydown', seen);
        body.append(target);

        const event = press(target, 'z');

        expect(event.defaultPrevented).toBe(false);
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('leaves a key that a blocked command would have taken untouched', () => {
        define('x');

        const input = document.createElement('input');
        const seen = vi.fn();

        input.addEventListener('keydown', seen);
        body.append(input);

        expect(press(input, 'x').defaultPrevented).toBe(false);
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('stops listening when removed', () => {
        const handler = define('x');

        uninstall();
        press(body, 'x');

        expect(handler).not.toHaveBeenCalled();
    });
});
