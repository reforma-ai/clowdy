import type { Command, HotkeyRegistry } from './registry';

/** A command as the help overlay lists it. */
export interface HelpEntry {
    command: Command;
    /** Every way to type the command, each as presses of key names for `Hotkey`. */
    sequences: string[][][];
}

export interface HelpGroup {
    name: string;
    entries: HelpEntry[];
}

/** Sections the overlay puts first, in this order. The others follow in the order their first command was defined. */
const GROUP_ORDER = ['General', 'Navigation'];

/** Every defined command, which the overlay lists as it is whether or not it can run right now. Reads the registry's observables, so call it while rendering. */
export function helpEntries(registry: HotkeyRegistry): HelpEntry[] {
    return registry.entries.map(entry => ({
        command: entry.command,
        sequences: entry.sequences[registry.family].map(sequence => sequence.display),
    }));
}

/** Entries by the `group` of their command, the first groups in `GROUP_ORDER`, and each group in the order its commands were defined. */
export function groupHelpEntries(entries: readonly HelpEntry[]): HelpGroup[] {
    const groups = new Map<string, HelpEntry[]>();

    for (const entry of entries) {
        const group = groups.get(entry.command.group);

        if (group) group.push(entry);
        else groups.set(entry.command.group, [entry]);
    }

    const rank = (name: string) => {
        const index = GROUP_ORDER.indexOf(name);

        return index >= 0 ? index : GROUP_ORDER.length;
    };

    // `sort` is stable, so groups of the same rank keep the order of their first command.
    return [...groups].map(([name, grouped]) => ({ name, entries: grouped })).sort((a, b) => rank(a.name) - rank(b.name));
}
