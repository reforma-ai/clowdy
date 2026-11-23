// @vitest-environment happy-dom
import { observable, runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_COMMAND, SETTINGS_KEYS } from '../features/settings/commands';
import { SIDE_PANEL_EXPAND_KEYS, SIDE_PANEL_KEYS, SIDE_PANEL_TAB_KEYS } from '../features/sidePanel';
import { installDispatcher } from '../hotkeys/dispatcher';
import { commandHint } from '../hotkeys/react';
import { commandPresses, createRegistry, type HotkeyRegistry } from '../hotkeys/registry';
import { UiStore } from '../stores';
import { findCommands } from './findCommands';
import { NEW_CHAT_COMMAND, type ShellCommandsRoot, shellCommands } from './shellCommands';

let registry: HotkeyRegistry;
let uninstall: () => void;
let ui: UiStore;
/** Whether the window shows a project: what the real root works out from its phase, Settings and the selected project. */
let screen: { shown: boolean };
/** How far the window has loaded, as the real root's `phase` says. */
let loading: { phase: ShellCommandsRoot['phase'] };
let root: ShellCommandsRoot;
let history: ShellCommandsRoot['history'] & { canGoBack: boolean; canGoForward: boolean };

const press = (init: KeyboardEventInit & { key: string }, target: EventTarget = document.body) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

    target.dispatchEvent(event);

    return event;
};

beforeEach(() => {
    registry = createRegistry('darwin');
    ui = new UiStore();
    // A stand-in for the real history, which has its own tests: only what the commands read and call.
    history = observable(
        { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn() },
        { back: false, forward: false }
    );
    // `ui` and `history` stay out of the observable: they are stores of their own, like on the real `RootStore`.
    screen = observable({ shown: true });
    loading = observable({ phase: 'ready' as ShellCommandsRoot['phase'] });
    root = observable(
        {
            get phase() {
                return loading.phase;
            },
            selectedProjectId: 'p' as string | null,
            get selectedProjectUi() {
                return this.selectedProjectId ? ui.forProject(this.selectedProjectId) : undefined;
            },
            get showsProjectScreen() {
                return screen.shown;
            },
            ui,
            history,
        },
        { ui: false, history: false }
    );

    for (const command of shellCommands(root)) registry.defineCommand({ ...command, scope: 'app' });

    uninstall = installDispatcher(registry);
});

afterEach(() => {
    uninstall();
});

describe('the keys that went with the sections', () => {
    it('has no G chord: Tasks is a tab of the side panel with Cmd+4, and there is one screen to go to', () => {
        const event = press({ key: 'g' });

        expect(registry.pending).toBeNull();
        expect(event.defaultPrevented).toBe(false);

        press({ key: 't' });
        press({ key: 'a' });

        expect(ui.forProject('p').sidePanelOpen).toBe(false);
    });
});

describe('help.open', () => {
    const shown = () => [ui.settingsOpen, ui.settingsPage];

    it('opens Settings on the Shortcuts page on ?, which is Shift+/ on a US keyboard', () => {
        press({ key: '?', shiftKey: true });

        expect(shown()).toEqual([true, 'shortcuts']);
    });

    it('opens it on Cmd+/ too, and from another page of Settings', () => {
        ui.openSettings('providers');

        press({ key: '/', metaKey: true });

        expect(shown()).toEqual([true, 'shortcuts']);
    });

    it('opens it on Cmd+? too, which is Cmd+Shift+/ on a US keyboard: Shift turns the key into "?", so `$mod+/` alone does not match it', () => {
        const event = press({ key: '?', code: 'Slash', metaKey: true, shiftKey: true });

        expect(shown()).toEqual([true, 'shortcuts']);
        expect(event.defaultPrevented).toBe(true);
    });

    it('does not open on Ctrl+/ on macOS, or on a bare slash', () => {
        press({ key: '/', ctrlKey: true });
        press({ key: '/' });

        expect(ui.settingsOpen).toBe(false);
    });

    it('stays shut while a text field has focus, so the field can take a ?', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            const event = press({ key: '?', shiftKey: true }, input);

            expect(ui.settingsOpen).toBe(false);
            expect(event.defaultPrevented).toBe(false);
        } finally {
            input.remove();
        }
    });

    it('stays shut until the window has loaded, because Settings shows over nothing before then', () => {
        runInAction(() => {
            loading.phase = 'unreachable';
        });

        const event = press({ key: '?', shiftKey: true });

        expect(ui.settingsOpen).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });
});

describe('settings.open', () => {
    it('opens Settings on Cmd+, on the page it was left on, from a text field too', () => {
        const event = press({ key: ',', code: 'Comma', metaKey: true });

        expect([ui.settingsOpen, ui.settingsPage]).toEqual([true, 'appearance']);
        expect(event.defaultPrevented).toBe(true);

        ui.closeSettings();
        ui.showSettingsPage('skills');

        const input = document.createElement('input');

        document.body.append(input);

        try {
            press({ key: ',', code: 'Comma', metaKey: true }, input);

            expect([ui.settingsOpen, ui.settingsPage]).toEqual([true, 'skills']);
        } finally {
            input.remove();
        }
    });

    it('does not open on Ctrl+, on macOS, or on a bare comma, and stays shut until the window has loaded', () => {
        press({ key: ',', code: 'Comma', ctrlKey: true });
        press({ key: ',', code: 'Comma' });

        expect(ui.settingsOpen).toBe(false);

        runInAction(() => {
            loading.phase = 'unreachable';
        });

        const event = press({ key: ',', code: 'Comma', metaKey: true });

        expect(ui.settingsOpen).toBe(false);
        expect(event.defaultPrevented).toBe(false);
    });

    it('waits while a window is open over the page, as every command does, so Settings is shut with Esc', () => {
        const overlay = document.createElement('div');

        overlay.setAttribute('data-modal-overlay', '');
        document.body.append(overlay);

        try {
            press({ key: ',', code: 'Comma', metaKey: true });

            expect(ui.settingsOpen).toBe(false);
        } finally {
            overlay.remove();
        }
    });

    it('has Cmd+, on a Mac and Ctrl+, elsewhere, and shows it as the hint of the Settings item', () => {
        expect(commandPresses({ keys: SETTINGS_KEYS }, 'darwin')).toEqual([['meta', ',']]);
        expect(commandPresses({ keys: SETTINGS_KEYS }, 'win32')).toEqual([['ctrl', ',']]);
        expect(commandHint(SETTINGS_COMMAND, registry)).toEqual([['meta', ',']]);
    });
});

describe('back and forward', () => {
    const setHistory = (canGoBack: boolean, canGoForward: boolean) =>
        runInAction(() => {
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
        } finally {
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

        for (const command of shellCommands(root)) probe.defineCommand({ ...command, scope: 'app' });

        for (const command of findCommands({ open() {}, next() {}, previous() {} }))
            probe.defineCommand({ ...command, scope: 'app' });

        expect(() => probe.assertNoConflicts()).not.toThrow();
        expect(probe.entries.map(({ command }) => command.id)).toEqual([
            'help.open',
            'settings.open',
            'chats.new',
            'sidePanel.toggle',
            'sidePanel.expand',
            'sidePanel.terminal',
            'sidePanel.tab.info',
            'sidePanel.tab.files',
            'sidePanel.tab.docs',
            'sidePanel.tab.terminal',
            'sidePanel.tab.tasks',
            'sidePanel.tab.changes',
            'nav.back',
            'nav.forward',
            'find.open',
            'find.next',
            'find.previous',
        ]);
    });
});

describe('new chat', () => {
    it('shows the new-chat page of the Agents section on Cmd+N', () => {
        const event = press({ key: 'n', code: 'KeyN', metaKey: true });
        expect(ui.forProject('p').draft).toBe(true);
        expect(event.defaultPrevented).toBe(true);
    });

    it('leaves a chat that is open, and Settings', () => {
        ui.forProject('p').openChat('c-1');
        ui.openSettings('providers');

        press({ key: 'n', code: 'KeyN', metaKey: true });

        expect(ui.settingsOpen).toBe(false);
        expect(ui.forProject('p').draft).toBe(true);
        expect(ui.forProject('p').chatId).toBe('c-1');
    });

    it('works on the Russian layout, where the key at N types "т"', () => {
        press({ key: 'т', code: 'KeyN', metaKey: true });

        expect(ui.forProject('p').draft).toBe(true);
    });

    it('works from a text field, such as the message box, where a bare N is text', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            press({ key: 'n', code: 'KeyN', metaKey: true }, input);

            expect(ui.forProject('p').draft).toBe(true);

            ui.forProject('p').openChat(null);
            press({ key: 'n', code: 'KeyN' }, input);

            expect(ui.forProject('p').draft).toBe(false);
        } finally {
            input.remove();
        }
    });

    it('stays off while a dialog is open', () => {
        const overlay = document.createElement('div');

        overlay.dataset.modalOverlay = '';
        document.body.append(overlay);

        try {
            press({ key: 'n', code: 'KeyN', metaKey: true });

            expect(ui.forProject('p').draft).toBe(false);
        } finally {
            overlay.remove();
        }
    });

    it('needs a selected project, and leaves the key to the page without one', () => {
        runInAction(() => {
            root.selectedProjectId = null;
        });

        const event = press({ key: 'n', code: 'KeyN', metaKey: true });

        expect(event.defaultPrevented).toBe(false);
        expect(commandHint(NEW_CHAT_COMMAND, registry)).toBeUndefined();
    });

    it('shows its keys as the hint of the New chat row', () => {
        expect(commandHint(NEW_CHAT_COMMAND, registry)).toEqual([['meta', 'n']]);
    });
});

describe('the terminal key', () => {
    const state = () => ({ open: ui.forProject('p').sidePanelOpen, tab: ui.forProject('p').sidePanelTab });
    const press_ = (target?: EventTarget) => press({ key: '`', code: 'Backquote', ctrlKey: true }, target);

    it('opens the panel on the Terminal tab, goes back to the tab it was on when pressed over another one, and shuts the panel on a second press', () => {
        const first = press_();

        expect(state()).toEqual({ open: true, tab: 'terminal' });
        expect(first.defaultPrevented).toBe(true);

        ui.forProject('p').showSidePanelTab('files');
        press_();
        expect(state()).toEqual({ open: true, tab: 'terminal' });

        press_();
        expect(state()).toEqual({ open: false, tab: 'terminal' });
    });

    it("works from a text field, which is where the terminal's own input is", () => {
        const input = document.createElement('textarea');

        document.body.append(input);

        try {
            press_(input);
            expect(state().open).toBe(true);
        } finally {
            input.remove();
        }
    });

    it('does nothing where the window shows no project, and shows its key as a hint where it can run', () => {
        expect(commandHint('sidePanel.terminal', registry)).toEqual([['ctrl', '`']]);

        runInAction(() => {
            screen.shown = false;
        });
        press_();

        expect(state().open).toBe(false);
        expect(commandHint('sidePanel.terminal', registry)).toBeUndefined();
    });
});

describe('the side panel', () => {
    const panelOpen = () => ui.forProject('p').sidePanelOpen;

    it("opens and shuts the selected project's panel on Cmd+Esc", () => {
        const first = press({ key: 'Escape', code: 'Escape', metaKey: true });

        expect(panelOpen()).toBe(true);
        expect(first.defaultPrevented).toBe(true);

        press({ key: 'Escape', code: 'Escape', metaKey: true });

        expect(panelOpen()).toBe(false);
        expect(ui.forProject('other').sidePanelOpen).toBe(false);
    });

    it('has Cmd+Esc on a Mac and Ctrl+Shift+B elsewhere, where Ctrl+Esc is the Start menu', () => {
        expect(commandPresses({ keys: SIDE_PANEL_KEYS }, 'darwin')).toEqual([['meta', 'escape']]);
        expect(commandPresses({ keys: SIDE_PANEL_KEYS }, 'win32')).toEqual([['ctrl', 'shift', 'b']]);
    });

    it('works from a text field, since the message box is where a hand is', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            press({ key: 'Escape', code: 'Escape', metaKey: true }, input);

            expect(panelOpen()).toBe(true);
        } finally {
            input.remove();
        }
    });

    it('does nothing, and leaves the key to the page, where the window shows no project (Settings, loading), and takes neither a plain Esc nor Cmd+Shift+B', () => {
        runInAction(() => {
            screen.shown = false;
        });

        const event = press({ key: 'Escape', code: 'Escape', metaKey: true });

        expect(panelOpen()).toBe(false);
        expect(event.defaultPrevented).toBe(false);

        runInAction(() => {
            screen.shown = true;
        });

        const plain = press({ key: 'Escape', code: 'Escape' });

        press({ key: 'B', code: 'KeyB', metaKey: true, shiftKey: true });

        expect(panelOpen()).toBe(false);
        expect(plain.defaultPrevented).toBe(false);
    });

    it('shows its key as the hint of the toggle button, and none where it cannot run', () => {
        expect(commandHint('sidePanel.toggle', registry)).toEqual([['meta', 'escape']]);

        runInAction(() => {
            screen.shown = false;
        });

        expect(commandHint('sidePanel.toggle', registry)).toBeUndefined();
    });
});

describe('the expanded side panel', () => {
    const expanded = () => ui.forProject('p').sidePanelExpanded;
    const expand = (target?: EventTarget) =>
        press({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true }, target);

    it('has Cmd+Shift+Enter on a Mac and Ctrl+Shift+Enter elsewhere', () => {
        expect(commandPresses({ keys: SIDE_PANEL_EXPAND_KEYS }, 'darwin')).toEqual([['shift', 'meta', 'enter']]);
        expect(commandPresses({ keys: SIDE_PANEL_EXPAND_KEYS }, 'win32')).toEqual([['ctrl', 'shift', 'enter']]);
    });

    it('expands the open panel and gives the chat its place back on a second press, from a text field too', () => {
        ui.forProject('p').toggleSidePanel();

        const first = expand();

        expect(expanded()).toBe(true);
        expect(first.defaultPrevented).toBe(true);

        const input = document.createElement('input');

        document.body.append(input);

        try {
            expand(input);
            expect(expanded()).toBe(false);
        } finally {
            input.remove();
        }
    });

    it('does nothing on the Tasks tab, which is full already, and leaves the key to the page', () => {
        ui.forProject('p').openSidePanelTab('tasks');

        const event = expand();

        expect(expanded()).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        expect(commandHint('sidePanel.expand', registry)).toBeUndefined();
    });

    it('does nothing, and leaves the key to the page, while the panel is shut or the window shows no project', () => {
        const shut = expand();

        expect(expanded()).toBe(false);
        expect(shut.defaultPrevented).toBe(false);
        expect(commandHint('sidePanel.expand', registry)).toBeUndefined();

        ui.forProject('p').toggleSidePanel();
        expect(commandHint('sidePanel.expand', registry)).toEqual([['shift', 'meta', 'enter']]);

        runInAction(() => {
            screen.shown = false;
        });

        const away = expand();

        expect(expanded()).toBe(false);
        expect(away.defaultPrevented).toBe(false);
    });
});

describe('the tabs of the side panel', () => {
    const state = () => ({ open: ui.forProject('p').sidePanelOpen, tab: ui.forProject('p').sidePanelTab });
    const digit = (value: string, extra: KeyboardEventInit = {}, target?: EventTarget) =>
        press({ key: value, code: `Digit${value}`, metaKey: true, ...extra }, target);

    it('shows Info on Cmd+0, Files on Cmd+1, Terminal on Cmd+2, Docs on Cmd+3, Tasks on Cmd+4 and Changes on Cmd+5, opening the panel when it is shut', () => {
        const first = digit('1');

        expect(state()).toEqual({ open: true, tab: 'files' });
        expect(first.defaultPrevented).toBe(true);

        digit('2');
        expect(state()).toEqual({ open: true, tab: 'terminal' });

        digit('0');
        expect(state()).toEqual({ open: true, tab: 'info' });

        digit('3');
        expect(state()).toEqual({ open: true, tab: 'docs' });

        digit('4');
        expect(state()).toEqual({ open: true, tab: 'tasks' });

        digit('5');
        expect(state()).toEqual({ open: true, tab: 'changes' });

        runInAction(() => ui.forProject('p').toggleSidePanel());
        expect(state()).toEqual({ open: false, tab: 'changes' });

        digit('2');
        expect(state()).toEqual({ open: true, tab: 'terminal' });
        expect(ui.forProject('other').sidePanelOpen).toBe(false);
    });

    it('shuts the panel when the tab that is shown is picked again, and opens it on that tab with the next press', () => {
        digit('1');
        digit('1');

        expect(state()).toEqual({ open: false, tab: 'files' });

        digit('1');

        expect(state()).toEqual({ open: true, tab: 'files' });

        // Another tab's key only changes the tab.
        digit('2');
        expect(state()).toEqual({ open: true, tab: 'terminal' });
    });

    it('works from a text field', () => {
        const input = document.createElement('input');

        document.body.append(input);

        try {
            digit('1', {}, input);
            expect(state()).toEqual({ open: true, tab: 'files' });

            digit('2', {}, input);
            expect(state().tab).toBe('terminal');
        } finally {
            input.remove();
        }
    });

    it('does nothing, and leaves the key to the page, where the window shows no project, and takes no other digit or modifier', () => {
        runInAction(() => {
            screen.shown = false;
        });

        const event = digit('1');

        expect(state().open).toBe(false);
        expect(event.defaultPrevented).toBe(false);

        runInAction(() => {
            screen.shown = true;
        });
        digit('6');
        digit('1', { shiftKey: true });
        digit('1', { metaKey: false });
        digit('1', { altKey: true });

        expect(state().open).toBe(false);
    });

    it('has Cmd on a Mac and Ctrl elsewhere, and shows the key as the hint of the tab', () => {
        expect(commandPresses({ keys: SIDE_PANEL_TAB_KEYS.info }, 'darwin')).toEqual([['meta', '0']]);
        expect(commandPresses({ keys: SIDE_PANEL_TAB_KEYS.terminal }, 'win32')).toEqual([['ctrl', '2']]);
        expect(commandPresses({ keys: SIDE_PANEL_TAB_KEYS.tasks }, 'win32')).toEqual([['ctrl', '4']]);
        expect(commandPresses({ keys: SIDE_PANEL_TAB_KEYS.changes }, 'win32')).toEqual([['ctrl', '5']]);
        expect(commandHint('sidePanel.tab.files', registry)).toEqual([['meta', '1']]);

        runInAction(() => {
            screen.shown = false;
        });

        expect(commandHint('sidePanel.tab.files', registry)).toBeUndefined();
    });
});
