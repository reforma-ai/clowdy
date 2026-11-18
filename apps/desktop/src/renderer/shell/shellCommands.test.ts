// @vitest-environment happy-dom
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDispatcher } from '../hotkeys/dispatcher';
import { commandHint } from '../hotkeys/react';
import { createRegistry, type HotkeyRegistry } from '../hotkeys/registry';
import { UiStore } from '../stores';
import { navCommandId, shellCommands, type ShellCommandsRoot } from './shellCommands';

let registry: HotkeyRegistry;
let uninstall: () => void;
let ui: UiStore;
let root: ShellCommandsRoot;
let history: ShellCommandsRoot['history'] & { canGoBack: boolean; canGoForward: boolean };
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
    // A stand-in for the real history, which has its own tests: only what the commands read and call.
    history = observable({ canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn() }, { back: false, forward: false });
    // `ui` and `history` stay out of the observable: they are stores of their own, like on the real `RootStore`.
    root = observable({ selectedProjectId: 'p' as string | null, ui, history }, { ui: false, history: false });
    openHelp = vi.fn();

    for (const command of shellCommands(root, openHelp)) registry.defineCommand({ ...command, scope: 'app' });

    uninstall = installDispatcher(registry);
});

afterEach(() => {
    uninstall();
});

describe('section chords', () => {
    it.each([
        ['a', 'agents'],
        ['t', 'tasks'],
        ['d', 'docs'],
    ] as const)('G then %s shows the %s section of the selected project', (second, section) => {
        ui.forProject('p').section = section === 'agents' ? 'tasks' : 'agents';

        press({ key: 'g' });
        press({ key: second });

        expect(sectionOf()).toBe(section);
        expect(registry.pending).toBeNull();
    });

    it('does nothing after a G alone, and leaves a chord after its timeout', () => {
        vi.useFakeTimers();

        try {
            press({ key: 'g' });

            expect(registry.pending?.candidates.map(({ command }) => command.id).sort()).toEqual(['nav.agents', 'nav.docs', 'nav.tasks']);
            expect(sectionOf()).toBe('agents');

            vi.advanceTimersByTime(1000);

            expect(registry.pending).toBeNull();

            press({ key: 't' });

            expect(sectionOf()).toBe('agents');
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
        expect(sectionOf()).toBe('agents');
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

        expect(sectionOf()).toBe('agents');
    });

    it('is a plain letter while a text field has focus', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            const first = press({ key: 'g' }, input);

            press({ key: 't' }, input);

            expect(first.defaultPrevented).toBe(false);
            expect(registry.pending).toBeNull();
            expect(sectionOf()).toBe('agents');
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

            expect(sectionOf()).toBe('agents');
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

    it('opens on Cmd+? too, which is Cmd+Shift+/ on a US keyboard: Shift turns the key into "?", so `$mod+/` alone does not match it', () => {
        const event = press({ key: '?', code: 'Slash', metaKey: true, shiftKey: true });

        expect(openHelp).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
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

describe('back and forward', () => {
    const setHistory = (canGoBack: boolean, canGoForward: boolean) => runInAction(() => {
        history.canGoBack = canGoBack;
        history.canGoForward = canGoForward;
    });

    it('go back on Cmd+[ and forward on Cmd+], when there is somewhere to go', () => {
        setHistory(true, true);

        const back = press({ key: '[', code: 'BracketLeft', metaKey: true });
        const forward = press({ key: ']', code: 'BracketRight', metaKey: true });

        expect(history.back).toHaveBeenCalledTimes(1);
        expect(history.forward).toHaveBeenCalledTimes(1);
        expect(back.defaultPrevented).toBe(true);
        expect(forward.defaultPrevented).toBe(true);
    });

    it('go by the physical bracket keys, so a layout that types letters there works too', () => {
        setHistory(true, true);

        // The Russian layout: the key at `[` types "х", and its event names no bracket.
        press({ key: 'х', code: 'BracketLeft', metaKey: true });
        press({ key: 'ъ', code: 'BracketRight', metaKey: true });

        expect(history.back).toHaveBeenCalledTimes(1);
        expect(history.forward).toHaveBeenCalledTimes(1);
    });

    it('are off at the ends of the history, and leave the key to the page', () => {
        setHistory(false, false);

        const back = press({ key: '[', code: 'BracketLeft', metaKey: true });
        const forward = press({ key: ']', code: 'BracketRight', metaKey: true });

        expect(history.back).not.toHaveBeenCalled();
        expect(history.forward).not.toHaveBeenCalled();
        expect(back.defaultPrevented).toBe(false);
        expect(forward.defaultPrevented).toBe(false);

        setHistory(false, true);
        press({ key: '[', code: 'BracketLeft', metaKey: true });
        press({ key: ']', code: 'BracketRight', metaKey: true });

        expect(history.back).not.toHaveBeenCalled();
        expect(history.forward).toHaveBeenCalledTimes(1);
    });

    it('show their keys as hints only while they can run', () => {
        expect(commandHint('nav.back', registry)).toBeUndefined();
        expect(commandHint('nav.forward', registry)).toBeUndefined();

        setHistory(true, false);

        expect(commandHint('nav.back', registry)).toEqual([['meta', '[']]);
        expect(commandHint('nav.forward', registry)).toBeUndefined();

        setHistory(true, true);

        expect(commandHint('nav.forward', registry)).toEqual([['meta', ']']]);
    });

    it('leave Cmd+[ to a text field, where it outdents', () => {
        setHistory(true, true);

        const input = document.createElement('input');

        document.body.append(input);

        try {
            const event = press({ key: '[', code: 'BracketLeft', metaKey: true }, input);

            expect(history.back).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        }
        finally {
            input.remove();
        }
    });

    it('need Cmd on macOS, not Ctrl', () => {
        setHistory(true, true);
        press({ key: '[', code: 'BracketLeft', ctrlKey: true });
        press({ key: '[', code: 'BracketLeft' });

        expect(history.back).not.toHaveBeenCalled();
    });
});

describe('the keymap', () => {
    it('has no key conflicts and unique ids', () => {
        const probe = createRegistry('win32');

        for (const command of shellCommands(root, openHelp)) probe.defineCommand({ ...command, scope: 'app' });

        expect(() => probe.assertNoConflicts()).not.toThrow();
        expect(probe.entries.map(({ command }) => command.id)).toEqual(['help.open', 'nav.agents', 'nav.tasks', 'nav.docs', 'nav.back', 'nav.forward']);
        expect(navCommandId('tasks')).toBe('nav.tasks');
    });
});
