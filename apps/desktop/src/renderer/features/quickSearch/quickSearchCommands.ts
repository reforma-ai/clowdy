import type { ScopedCommand } from '../../hotkeys';
import type { QuickSearchTab } from './QuickSearchModel';

/** The id of the command that opens the palette, which a button that opens it asks for its hint. */
export const QUICK_SEARCH_COMMAND = 'search.open';

export interface QuickSearchCommandsDeps {
    open: (tab: QuickSearchTab) => void;
    /** The window shows a project's screen, which is what there is to search. */
    available: () => boolean;
}

/**
 * The commands that open the quick search palette, for the `app` scope: `Cmd+K` on every tab, `Cmd+P` on the one of file names, and `Cmd+Shift+F` on the one of the
 * text in files (starting with what the open file has selected, as a code editor's does). They work from a text field too: the message box and the editor are where
 * they are wanted. The palette itself takes `Cmd+K` once it is open, to close.
 */
export function quickSearchCommands({ open, available }: QuickSearchCommandsDeps): ScopedCommand[] {
    return [
        { id: QUICK_SEARCH_COMMAND, title: 'Search', group: 'General', keys: '$mod+k', inInputs: true, when: available, handler: () => open('all') },
        { id: 'search.files', title: 'Search files by name', group: 'General', keys: '$mod+p', inInputs: true, when: available, handler: () => open('files') },
        { id: 'search.text', title: 'Search text in files', group: 'General', keys: '$mod+Shift+f', inInputs: true, when: available, handler: () => open('text') },
    ];
}
