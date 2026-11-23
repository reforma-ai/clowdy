// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { shortcutEntries, wholeKeymap } from '../shell/keymap';
import { groupHelpEntries } from './helpEntries';
import { type Command, createRegistry, findKeyConflicts, type Platform } from './registry';

const PLATFORMS: Platform[] = ['darwin', 'win32'];

describe('the whole keymap', () => {
    it('has no key collisions, on either platform', () => {
        expect(findKeyConflicts(wholeKeymap()).map(({ message }) => message)).toEqual([]);
    });

    it.each(PLATFORMS)('registers in one registry on %s, as the sections do while mounted', platform => {
        const registry = createRegistry(platform);
        const commands = wholeKeymap();

        for (const command of commands) registry.defineCommand(command);

        expect(registry.listCommands().all).toHaveLength(commands.length);
        expect(() => registry.assertNoConflicts()).not.toThrow();
    });

    it('gives every command its own id, and every section its own scope', () => {
        const commands = wholeKeymap();

        expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
        expect(new Set(commands.map(({ scope }) => scope))).toEqual(new Set(['app', 'tasks', 'agents', 'files']));
    });

    it('holds the commands the shell, the find bar and the quick search register in the app scope, with the ones of every section', () => {
        const ids = wholeKeymap().map(({ id }) => id);

        expect(ids).toEqual(
            expect.arrayContaining([
                'help.open',
                'chats.new',
                'sidePanel.toggle',
                'find.open',
                'tasks.create',
                'agents.cursor.down',
                'files.showHidden',
                'search.open',
                'search.chats',
                'search.files',
                'search.docs',
                'search.text',
            ])
        );
    });

    it('has J in every section, so the no-collision check above is what lets them share it', () => {
        const keysOf = (scope: string) =>
            wholeKeymap()
                .filter(command => command.scope === scope)
                .flatMap(({ keys }) => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []));

        for (const scope of ['tasks', 'agents']) expect(keysOf(scope)).toContain('j');
    });

    it('does reject an app command that takes a key of a section', () => {
        const stolen: Command = {
            id: 'app.j',
            title: 'Jump',
            group: 'General',
            keys: 'j',
            scope: 'app',
            handler: () => undefined,
        };
        const conflicts = findKeyConflicts([...wholeKeymap(), stolen]);

        expect(conflicts.length).toBeGreaterThan(0);
        expect(conflicts.every(({ a, b }) => a.id === 'app.j' || b.id === 'app.j')).toBe(true);
        expect(new Set(conflicts.flatMap(({ a, b }) => [a.scope, b.scope]))).toEqual(
            new Set(['app', 'tasks', 'agents'])
        );
    });
});

describe('the shortcuts page entries', () => {
    it('list every command of the keymap once, so Settings shows what a section that is not mounted offers', () => {
        const ids = shortcutEntries('darwin').map(({ command }) => command.id);

        expect(ids).toEqual(wholeKeymap().map(({ id }) => id));
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('group by section, with General and Navigation first', () => {
        const names = groupHelpEntries(shortcutEntries('darwin')).map(({ name }) => name);

        expect(names.slice(0, 2)).toEqual(['General', 'Navigation']);
        expect(names).toEqual(expect.arrayContaining(['Agents', 'Tasks']));
        expect(names).not.toContain('Documents');
    });

    it.each([
        ['darwin', [['?'], ['meta', '/'], ['meta', '?']]],
        ['win32', [['?'], ['ctrl', '/'], ['ctrl', '?']]],
    ] as const)('write the keys of the platform, %s', (platform, presses) => {
        const help = shortcutEntries(platform).find(({ command }) => command.id === 'help.open');

        expect(help?.sequences).toEqual(presses.map(press => [press]));
    });
});
