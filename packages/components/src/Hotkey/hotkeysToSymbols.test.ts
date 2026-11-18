import { afterEach, describe, expect, it, vi } from 'vitest';

/** The symbols depend on the platform, which the module reads once when it loads. */
async function symbolsFor(userAgent: string) {
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent });

    return (await import('./hotkeysToSymbols')).hotkeysToSymbols;
}

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('hotkeysToSymbols', () => {
    it('writes modifiers as Apple symbols on macOS', async () => {
        const hotkeysToSymbols = await symbolsFor(MAC);

        expect(hotkeysToSymbols(['mod', 'shift', 'k'])).toEqual(['⌘', '⇧', 'K']);
        expect(hotkeysToSymbols(['alt', 'ctrl', 'meta', 'x'])).toEqual(['⌥', '⌃', '⌘', 'X']);
        expect(hotkeysToSymbols('mod+backspace')).toEqual(['⌘', '⌫']);
    });

    it('writes modifiers as words on Windows and Linux', async () => {
        const hotkeysToSymbols = await symbolsFor(WINDOWS);

        expect(hotkeysToSymbols(['mod', 'shift', 'k'])).toEqual(['Ctrl', 'Shift', 'K']);
        expect(hotkeysToSymbols(['alt', 'ctrl', 'x'])).toEqual(['Alt', 'Ctrl', 'X']);
        expect(hotkeysToSymbols('mod+delete')).toEqual(['Ctrl', 'Delete']);
    });

    it('shows arrows, Enter and the names of the keys it could not show before', async () => {
        const hotkeysToSymbols = await symbolsFor(WINDOWS);

        expect(hotkeysToSymbols(['up', 'ArrowDown', 'left', 'arrowright'])).toEqual(['↑', '↓', '←', '→']);
        expect(hotkeysToSymbols('enter')).toEqual(['Enter']);
        expect(hotkeysToSymbols('escape')).toEqual(['Esc']);
        expect(hotkeysToSymbols('Esc')).toEqual(['Esc']);
        expect(hotkeysToSymbols('space')).toEqual(['Space']);
        expect(hotkeysToSymbols('tab')).toEqual(['Tab']);
        expect(hotkeysToSymbols(['pageup', 'pagedown', 'home', 'end'])).toEqual(['Page Up', 'Page Down', 'Home', 'End']);
    });

    it('shows punctuation as the character, whether it comes as a character or as a KeyboardEvent code', async () => {
        const hotkeysToSymbols = await symbolsFor(WINDOWS);

        expect(hotkeysToSymbols(['?', '/', '.', ',', '\'', '`', '-', '=', ';', '[', ']', '\\'])).toEqual(['?', '/', '.', ',', '\'', '`', '-', '=', ';', '[', ']', '\\']);
        expect(hotkeysToSymbols(['slash', 'period', 'comma', 'quote', 'backquote', 'semicolon', 'equal', 'bracketleft', 'bracketright', 'backslash', 'question', 'minus', 'plus']))
            .toEqual(['/', '.', ',', '\'', '`', ';', '=', '[', ']', '\\', '?', '-', '+']);
    });

    it('splits a string on plus signs, spaces and underscores, and keeps a one-character string whole', async () => {
        const hotkeysToSymbols = await symbolsFor(WINDOWS);

        expect(hotkeysToSymbols('mod+shift+/')).toEqual(['Ctrl', 'Shift', '/']);
        expect(hotkeysToSymbols('shift r')).toEqual(['Shift', 'R']);
        expect(hotkeysToSymbols('?')).toEqual(['?']);
        expect(hotkeysToSymbols('+')).toEqual(['+']);
    });

    it('shows the names the hotkey registry writes for its commands', async () => {
        const hotkeysToSymbols = await symbolsFor(MAC);

        expect(hotkeysToSymbols(['meta', '/'])).toEqual(['⌘', '/']);
        expect(hotkeysToSymbols(['shift', 'meta', '\''])).toEqual(['⇧', '⌘', '\'']);
        expect(hotkeysToSymbols(['escape'])).toEqual(['Esc']);
        expect(hotkeysToSymbols(['delete'])).toEqual(['⌫']);
    });
});
