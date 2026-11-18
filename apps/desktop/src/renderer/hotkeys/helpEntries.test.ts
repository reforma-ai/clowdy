import { describe, expect, it } from 'vitest';

import { groupHelpEntries, helpEntries } from './helpEntries';
import { createRegistry, type Command } from './registry';

const noop = () => undefined;

function setup(platform: Parameters<typeof createRegistry>[0] = 'darwin') {
    const registry = createRegistry(platform);
    const define = (command: Pick<Command, 'id' | 'title' | 'group' | 'keys'> & Partial<Command>) => registry.defineCommand({ scope: 'app', handler: noop, ...command });

    define({ id: 'tasks.cursor.down', title: 'Move down', group: 'Tasks', keys: ['ArrowDown', 'j'], scope: 'tasks' });
    define({ id: 'nav.tasks', title: 'Go to Tasks', group: 'Navigation', keys: 'g t' });
    define({ id: 'nav.chats', title: 'Go to Chats', group: 'Navigation', keys: 'g c' });
    define({ id: 'help.open', title: 'Show keyboard shortcuts', group: 'General', keys: ['?', '$mod+/'] });
    define({ id: 'tasks.delete', title: 'Delete task', group: 'Tasks', keys: { mac: '$mod+Backspace', win: '$mod+Delete' }, scope: 'tasks' });
    define({ id: 'chats.new', title: 'New chat', group: 'Chats', keys: 'n', scope: 'chats' });

    return { registry, entries: helpEntries(registry) };
}

const ids = (entries: { command: { id: string } }[]) => entries.map(({ command }) => command.id);

describe('helpEntries', () => {
    it('lists every defined command, whether or not it can run now, with every way to type it', () => {
        const { entries } = setup();

        expect(ids(entries)).toEqual(['tasks.cursor.down', 'nav.tasks', 'nav.chats', 'help.open', 'tasks.delete', 'chats.new']);
        expect(entries[0].sequences).toEqual([[['down']], [['j']]]);
        expect(entries[1].sequences).toEqual([[['g'], ['t']]]);
        expect(entries[3].sequences).toEqual([[['?']], [['meta', '/']]]);
        expect(entries[4].sequences).toEqual([[['meta', 'backspace']]]);
    });

    it('shows the keys of the platform the registry serves', () => {
        const { entries } = setup('win32');

        expect(entries.find(({ command }) => command.id === 'tasks.delete')?.sequences).toEqual([[['ctrl', 'delete']]]);
    });
});

describe('groupHelpEntries', () => {
    it('puts General and Navigation first and keeps the other groups in the order they were defined', () => {
        const { entries } = setup();

        expect(groupHelpEntries(entries).map(group => group.name)).toEqual(['General', 'Navigation', 'Tasks', 'Chats']);
    });

    it('keeps the commands of a group in the order they were defined, even when other groups were defined in between', () => {
        const { entries } = setup();
        const groups = groupHelpEntries(entries);

        expect(ids(groups[1].entries)).toEqual(['nav.tasks', 'nav.chats']);
        expect(ids(groups[2].entries)).toEqual(['tasks.cursor.down', 'tasks.delete']);
    });

    it('lists each command once', () => {
        const { entries } = setup();

        expect(ids(groupHelpEntries(entries).flatMap(group => group.entries)).toSorted()).toEqual(ids(entries).toSorted());
    });

    it('has no group when there are no entries', () => {
        expect(groupHelpEntries([])).toEqual([]);
    });
});
