// @vitest-environment happy-dom
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from '../hotkeys/dispatcher';
import { createRegistry, type HotkeyRegistry } from '../hotkeys/registry';
import { UiStore } from '../stores';
import { navCommandId, shellCommands } from './shellCommands';

import type { RootStore } from '../stores';

let registry: HotkeyRegistry;
let uninstall: () => void;
let ui: UiStore;
let root: Pick<RootStore, 'selectedProjectId' | 'ui'>;
let openHelp: () => void;

const press = (init: KeyboardEventInit & { key: string }, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);

    return event;
};
const sectionOf = () => ui.forProject('p').section;

beforeEach(() => {
    registry = createRegistry('darwin');
    ui = new UiStore();
    // `ui` stays out of the observable: it is a store of its own, like on the real `RootStore`.
    root = observable({ selectedProjectId: 'p' as string | null, ui }, { ui: false });
    openHelp = vi.fn();

    for (const command of shellCommands(root, openHelp)) registry.defineCommand({ ...command, scope: 'app' });

    uninstall = installDispatcher(registry);
});

afterEach(() => {
    uninstall();
});

describe('section chords', () => {
    it.each([
        ['c', 'chats'],
        ['t', 'tasks'],
        ['a', 'agents'],
        ['d', 'docs'],
    ] as const)('G then %s shows the %s section of the selected project', (second, section) => {
        ui.forProject('p').section = section === 'chats' ? 'agents' : 'chats';

        press({ key: 'g' });
        press({ key: second });

        expect(sectionOf()).toBe(section);
        expect(registry.pending).toBeNull();
    });

    it('does nothing after a G alone, and leaves a chord after its timeout', () => {
        vi.useFakeTimers();

        try {
            press({ key: 'g' });

            expect(registry.pending?.candidates.map(({ command }) => command.id).sort()).toEqual(['nav.agents', 'nav.chats', 'nav.docs', 'nav.tasks']);
            expect(sectionOf()).toBe('chats');

            vi.advanceTimersByTime(1000);

            expect(registry.pending).toBeNull();

            press({ key: 't' });

            expect(sectionOf()).toBe('chats');
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('is cancelled by Escape', () => {
        press({ key: 'g' });
        press({ key: 'Escape' });
        press({ key: 't' });

        expect(registry.pending).toBeNull();
        expect(sectionOf()).toBe('chats');
    });

    it('also leaves Settings', () => {
        ui.openSettings('engine');

        press({ key: 'g' });
        press({ key: 'd' });

        expect(ui.settingsOpen).toBe(false);
        expect(sectionOf()).toBe('docs');
    });

    it('needs a selected project, and does not even start the chord without one', () => {
        runInAction(() => {
            root.selectedProjectId = null;
        });

        const event = press({ key: 'g' });

        expect(registry.pending).toBeNull();
        expect(event.defaultPrevented).toBe(false);

        press({ key: 't' });

        expect(sectionOf()).toBe('chats');
    });

    it('is a plain letter while a text field has focus', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            const first = press({ key: 'g' }, input);

            press({ key: 't' }, input);

            expect(first.defaultPrevented).toBe(false);
            expect(registry.pending).toBeNull();
            expect(sectionOf()).toBe('chats');
        }
        finally {
            input.remove();
        }
    });

    it('stays off while a dialog is open', () => {
        const overlay = document.createElement('div');

        overlay.dataset.modalOverlay = '';
        document.body.append(overlay);

        try {
            press({ key: 'g' });
            press({ key: 't' });

            expect(sectionOf()).toBe('chats');
        }
        finally {
            overlay.remove();
        }
    });
});

describe('help.open', () => {
    it('opens on ?, which is Shift+/ on a US keyboard, and on Cmd+/', () => {
        press({ key: '?', shiftKey: true });
        press({ key: '/', metaKey: true });

        expect(openHelp).toHaveBeenCalledTimes(2);
    });

    it('calls openHelp with nothing, not with the key event it would take for a registry', () => {
        press({ key: '?', shiftKey: true });

        expect(openHelp).toHaveBeenCalledWith();
    });

    it('does not open on Ctrl+/ on macOS, or on a bare slash', () => {
        press({ key: '/', ctrlKey: true });
        press({ key: '/' });

        expect(openHelp).not.toHaveBeenCalled();
    });

    it('stays shut while a text field has focus, so the search field of the overlay can take a ?', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            const event = press({ key: '?', shiftKey: true }, input);

            expect(openHelp).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        }
        finally {
            input.remove();
        }
    });
});

describe('the keymap', () => {
    it('has no key conflicts and unique ids', () => {
        const probe = createRegistry('win32');

        for (const command of shellCommands(root, openHelp)) probe.defineCommand({ ...command, scope: 'app' });

        expect(() => probe.assertNoConflicts()).not.toThrow();
        expect(probe.entries.map(({ command }) => command.id)).toEqual(['help.open', 'nav.chats', 'nav.tasks', 'nav.agents', 'nav.docs']);
        expect(navCommandId('tasks')).toBe('nav.tasks');
    });
});
