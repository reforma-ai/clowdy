import { hotkeysToSymbols } from '@clowdy/components/Hotkey';

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

/** What a person might type for a key besides the symbol the capsule shows. */
const KEY_WORDS: Record<string, string> = {
    meta: 'cmd command',
    ctrl: 'ctrl control',
    alt: 'alt option opt',
    escape: 'esc escape',
    up: 'up arrow',
    down: 'down arrow',
    left: 'left arrow',
    right: 'right arrow',
    backspace: 'backspace delete',
    delete: 'delete del',
};

/** Every defined command, which the overlay lists as it is whether or not it can run right now. Reads the registry's observables, so call it while rendering. */
export function helpEntries(registry: HotkeyRegistry): HelpEntry[] {
    return registry.entries.map(entry => ({
        command: entry.command,
        sequences: entry.sequences[registry.family].map(sequence => sequence.display),
    }));
}

/** The words of one key sequence a search can match: its symbols ("⌘ /", "G then T") and the plain names of its keys ("cmd", "esc"). */
function keyText(sequence: readonly (readonly string[])[]): string {
    const symbols = sequence.map(press => hotkeysToSymbols(press).join(' ')).join(' then ');
    const words = sequence.flatMap(press => press.map(key => KEY_WORDS[key] ?? key)).join(' ');

    return `${ symbols } ${ words }`;
}

/**
 * Entries that match every word of the query, in any case. A word matches inside the title or group (`chats`, `go to`),
 * or the start of a key word (`cmd`, `arrow`; a single character must be the whole key). For keys all the words must fit one way to type the command,
 * so `g then t` finds that chord and not every title with a `t` in it. A `+` separates words like a space, so `cmd+/` works as it is written.
 * An empty query keeps all entries.
 */
export function filterHelpEntries(entries: readonly HelpEntry[], query: string): HelpEntry[] {
    const words = query.toLowerCase().split(/[\s+]+/).filter(Boolean);

    if (!words.length) return [...entries];

    return entries.filter(({ command, sequences }) => {
        const text = `${ command.title } ${ command.group }`.toLowerCase();

        if (words.every(word => text.includes(word))) return true;

        return sequences.some((sequence) => {
            const tokens = keyText(sequence).toLowerCase().split(/\s+/);

            return words.every(word => tokens.some(token => (word.length > 1 ? token.startsWith(word) : token === word)));
        });
    });
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
