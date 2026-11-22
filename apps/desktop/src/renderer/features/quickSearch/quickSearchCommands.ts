import type { ScopedCommand } from '../../hotkeys';
import type { QuickSearchTab } from './QuickSearchModel';

/** The ids of the commands that open the palette on a tab, which the palette's own tabs ask for the hint of each. */
export const QUICK_SEARCH_COMMAND = 'search.open';
export const QUICK_SEARCH_FILES_COMMAND = 'search.files';
export const QUICK_SEARCH_TEXT_COMMAND = 'search.text';

/** The command that opens each tab. */
export const TAB_COMMANDS: Record<QuickSearchTab, string> = {
    all: QUICK_SEARCH_COMMAND,
    files: QUICK_SEARCH_FILES_COMMAND,
    text: QUICK_SEARCH_TEXT_COMMAND,
};

export interface QuickSearchCommandsDeps {
    open: (tab: QuickSearchTab) => void;
    /** The window shows a project's screen, which is what there is to search. */
    available: () => boolean;
}

/**
 * The commands that open the quick search palette, for the `app` scope: `Cmd+K` on every tab, `Cmd+P` on the one of file names, and `Cmd+Shift+F` on the one of the
 * text in files (starting with what the open file has selected, as a code editor's does). They work from a text field too: the message box and the editor are where
 * they are wanted, and with the palette open, where each goes to its tab (the tabs of the palette show these keys). A dialog that is open is in the way of opening it: see `openQuickSearch`.
 */
export function quickSearchCommands({ open, available }: QuickSearchCommandsDeps): ScopedCommand[] {
    return [
        { id: QUICK_SEARCH_COMMAND, title: 'Search', group: 'General', keys: '$mod+k', inInputs: true, inOverlays: true, when: available, handler: () => open('all') },
        { id: QUICK_SEARCH_FILES_COMMAND, title: 'Search files by name', group: 'General', keys: '$mod+p', inInputs: true, inOverlays: true, when: available, handler: () => open('files') },
        { id: QUICK_SEARCH_TEXT_COMMAND, title: 'Search text in files', group: 'General', keys: '$mod+Shift+f', inInputs: true, inOverlays: true, when: available, handler: () => open('text') },
    ];
}
