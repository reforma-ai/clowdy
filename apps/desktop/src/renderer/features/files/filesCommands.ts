import type { Command } from '../../hotkeys';

/** The scope of the Files tab's commands, live while the tab is shown. */
export const FILES_SCOPE = 'files';

/** The id of the command that shows or hides the hidden files (the names that start with a dot, and `node_modules`). */
export const SHOW_HIDDEN_COMMAND = 'files.showHidden';

export interface FilesCommandsDeps {
    toggleHidden: () => void;
}

/**
 * The commands of the Files tab, for the `files` scope: `Cmd+Shift+.` shows the hidden files and hides them again, the key Finder has for it. It is one of
 * the keys a text field keeps for itself, so it works with the focus on the tree or off the page's fields, not in the code editor or the rich Markdown editor,
 * whose own `Cmd+Shift+.` is Quote. Its own scope, since `Cmd+.` of a task's key takes Shift too (a symbol key does) and would collide with it in `app`; on the Tasks
 * screen with the Files tab open the tab is the inner scope, so the key with Shift is the tab's and the one without it is still the task's.
 */
export function filesCommands({ toggleHidden }: FilesCommandsDeps): Command[] {
    return [
        {
            id: SHOW_HIDDEN_COMMAND,
            title: 'Show or hide hidden files',
            group: 'Files',
            keys: '$mod+Shift+.',
            scope: FILES_SCOPE,
            handler: () => toggleHidden(),
        },
    ];
}
