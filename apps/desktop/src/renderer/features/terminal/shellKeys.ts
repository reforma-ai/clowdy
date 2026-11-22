/** What a key does in the shell that xterm alone would not: the shortcuts of the person's own terminal app. `undefined` leaves the key to xterm. */
export function shellSequence(event: Pick<KeyboardEvent, 'type' | 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>, platform: string): string | undefined {
    if (event.type !== 'keydown' || event.shiftKey || platform !== 'darwin') return undefined;

    // Option+←/→ jump by word, as in Terminal.app; xterm alone sends sequences a shell does not bind.
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
        if (event.key === 'ArrowLeft') return '\x1bb';

        if (event.key === 'ArrowRight') return '\x1bf';
    }

    // Cmd+←/→ go to the start and the end of the line, Cmd+Backspace clears it before the cursor.
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
        if (event.key === 'ArrowLeft') return '\x01';

        if (event.key === 'ArrowRight') return '\x05';

        if (event.key === 'Backspace') return '\x15';
    }

    return undefined;
}

/**
 * Keys that are the app's own and must reach it from the terminal, where xterm would turn them into bytes for the shell and stop them: `Ctrl+`` (the terminal's
 * toggle) on every system, `Cmd+Esc` (the side panel's) on a Mac, where xterm would send the Esc, and `Ctrl+Shift+B` (the panel's) elsewhere. Other Cmd chords on a
 * Mac are never taken by xterm.
 */
export function isAppShortcut(event: Pick<KeyboardEvent, 'type' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>, platform: string): boolean {
    if (event.type !== 'keydown' || event.altKey) return false;

    if (platform === 'darwin' && event.code === 'Escape') return event.metaKey && !event.ctrlKey && !event.shiftKey;

    if (!event.ctrlKey || event.metaKey) return false;

    if (event.code === 'Backquote') return !event.shiftKey;

    return platform !== 'darwin' && event.shiftKey && event.code === 'KeyB';
}
