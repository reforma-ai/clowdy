import { describe, expect, it } from 'vitest';

import { filterHelpEntries, groupHelpEntries, helpEntries } from './helpEntries';
import { createRegistry, type Command } from './registry';

const noop = () => undefined;

function setup() {
    const registry = createRegistry('darwin');
    const define = (command: Pick<Command, 'id' | 'title' | 'group' | 'keys'> & Partial<Command>) => registry.defineCommand({ scope: 'app', handler: noop, ...command });

    define({ id: 'tasks.cursor.down', title: 'Move down', group: 'Tasks', keys: ['ArrowDown', 'j'], scope: 'tasks' });
    define({ id: 'nav.tasks', title: 'Go to Tasks', group: 'Navigation', keys: 'g t' });
    define({ id: 'nav.chats', title: 'Go to Chats', group: 'Navigation', keys: 'g c' });
    define({ id: 'help.open', title: 'Show keyboard shortcuts', group: 'General', keys: ['?', '$mod+/'] });
    define({ id: 'tasks.delete', title: 'Delete task', group: 'Tasks', keys: { mac: '$mod+Backspace', win: '$mod+Delete' }, scope: 'tasks' });

    return { registry, entries: helpEntries(registry) };
}

const ids = (entries: { command: { id: string } }[]) => entries.map(({ command }) => command.id);

describe('helpEntries', () => {
    it('lists every defined command, whether or not it can run now, with every way to type it', () => {
        const { entries } = setup();

        expect(ids(entries)).toEqual(['tasks.cursor.down', 'nav.tasks', 'nav.chats', 'help.open', 'tasks.delete']);
        expect(entries[0].sequences).toEqual([[['down']], [['j']]]);
        expect(entries[1].sequences).toEqual([[['g'], ['t']]]);
        expect(entries[4].sequences).toEqual([[['meta', 'backspace']]]);
    });

});


describe('filterHelpEntries', () => {
    it('keeps everything for an empty query', () => {
        const { entries } = setup();

        expect(filterHelpEntries(entries, '')).toEqual(entries);
        expect(filterHelpEntries(entries, '   ')).toEqual(entries);
    });

    it('matches the title in any case', () => {
        const { entries } = setup();

        expect(ids(filterHelpEntries(entries, 'CHATS'))).toEqual(['nav.chats']);
        expect(ids(filterHelpEntries(entries, 'go to'))).toEqual(['nav.tasks', 'nav.chats']);
    });

    it('matches the group', () => {
        const { entries } = setup();

        expect(ids(filterHelpEntries(entries, 'navigation'))).toEqual(['nav.tasks', 'nav.chats']);
    });

    it('matches keys by their symbols and by the words a person types', () => {
        const { entries } = setup();

        expect(ids(filterHelpEntries(entries, '?'))).toEqual(['help.open']);
        expect(ids(filterHelpEntries(entries, 'cmd'))).toEqual(['help.open', 'tasks.delete']);
        expect(ids(filterHelpEntries(entries, 'command /'))).toEqual(['help.open']);
        expect(ids(filterHelpEntries(entries, 'cmd+/'))).toEqual(['help.open']);
        expect(ids(filterHelpEntries(entries, 'arrow'))).toEqual(['tasks.cursor.down']);
        expect(ids(filterHelpEntries(entries, 'backspace'))).toEqual(['tasks.delete']);
    });

    it('matches a chord written as the capsules read', () => {
        const { entries } = setup();

        expect(ids(filterHelpEntries(entries, 'g then t'))).toEqual(['nav.tasks']);
        expect(ids(filterHelpEntries(entries, 'g then'))).toEqual(['nav.tasks', 'nav.chats']);
    });

    it('needs every word of the query to match', () => {
        const { entries } = setup();

        expect(ids(filterHelpEntries(entries, 'go chats'))).toEqual(['nav.chats']);
        expect(filterHelpEntries(entries, 'go nowhere')).toEqual([]);
    });
});

describe('groupHelpEntries', () => {
    it('puts General and Navigation first and keeps the other groups in the order they were defined', () => {
        const { entries } = setup();

        expect(groupHelpEntries(entries).map(group => group.name)).toEqual(['General', 'Navigation', 'Tasks']);
    });

    it('keeps the commands of a group in the order they were defined', () => {
        const { entries } = setup();
        const groups = groupHelpEntries(entries);

        expect(ids(groups[1].entries)).toEqual(['nav.tasks', 'nav.chats']);
        expect(ids(groups[2].entries)).toEqual(['tasks.cursor.down', 'tasks.delete']);
    });

    it('has no group for a filter that matches nothing', () => {
        expect(groupHelpEntries([])).toEqual([]);
    });
});
