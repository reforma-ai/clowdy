import type { ScopedCommand } from '../hotkeys';

/** What the find bar does for the three commands. */
export interface FindActions {
    open: () => void;
    next: () => void;
    previous: () => void;
}

/**
 * Find in the window, for the `app` scope: `Cmd/Ctrl+F` opens the bar, `Cmd/Ctrl+G` the next match, `Cmd/Ctrl+Shift+G` the previous.
 * They work from a text field and from a dialog, which is where a person is when they want to search a chat or a settings page.
 * The Edit menu has the same shortcuts. In the app the menu takes the key, and these commands are what the shortcuts page lists
 * and what a page without that menu runs.
 */
export function findCommands({ open, next, previous }: FindActions): ScopedCommand[] {
    return [
        { id: 'find.open', title: 'Find', group: 'General', keys: '$mod+f', inInputs: true, inOverlays: true, handler: () => open() },
        { id: 'find.next', title: 'Find next', group: 'General', keys: '$mod+g', inInputs: true, inOverlays: true, repeat: true, handler: () => next() },
        { id: 'find.previous', title: 'Find previous', group: 'General', keys: '$mod+Shift+g', inInputs: true, inOverlays: true, repeat: true, handler: () => previous() },
    ];
}
