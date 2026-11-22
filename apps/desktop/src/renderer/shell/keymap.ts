import { agentCommands } from '../features/agents/agentCommands';
import { docSaveCommand, docSearchCommand, docTreeCommands } from '../features/docs/docCommands';
import { filesCommands } from '../features/files/filesCommands';
import { quickSearchCommands } from '../features/quickSearch/quickSearchCommands';
import { taskCommands, type TaskCommandDeps } from '../features/tasks/taskCommands';
import { createRegistry, hotkeys, type Command, type Platform } from '../hotkeys';
import { helpEntries, type HelpEntry } from '../hotkeys/helpEntries';
import { findCommands } from './findCommands';
import { shellCommands } from './shellCommands';

/**
 * Every command of the app as the app registers them, section by section, built with stand-ins for what they read at run time. The builders only read their
 * dependencies inside handlers and `when`, so the stand-ins are never called: this list is about the keys and the titles.
 *
 * A section registers its commands while it is mounted, and Settings takes the section's place, so the registry cannot say what the sections offer while Settings is open.
 * The shortcuts page (`shortcutEntries`) and the keymap test read this list instead. A command defined in a new place goes here too.
 */
export function wholeKeymap(): Command[] {
    const nothing = new Proxy({}, { get: () => () => undefined }) as never;
    const app = [
        ...shellCommands(nothing),
        ...findCommands({ open: () => undefined, next: () => undefined, previous: () => undefined }),
        ...quickSearchCommands({ open: () => undefined, available: () => true }),
    ].map((command): Command => ({ ...command, scope: 'app' }));
    const list = { ids: () => [], openId: () => null };

    return [
        ...app,
        ...taskCommands(nothing as TaskCommandDeps),
        ...agentCommands({ list: () => null, ids: () => [], openId: () => undefined }),
        ...docTreeCommands({ tree: () => null, ...list }),
        ...filesCommands({ toggleHidden: () => undefined }),
        docSearchCommand(() => undefined),
        docSaveCommand(nothing),
    ];
}

/** Every command of the app with the ways to type it on `platform`, in the order the sections define them, for the shortcuts page. */
export function shortcutEntries(platform: Platform = hotkeys.platform): HelpEntry[] {
    const registry = createRegistry(platform);

    for (const command of wholeKeymap()) registry.defineCommand(command);

    return helpEntries(registry);
}
