// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { runCommands } from '../features/agents/runCommands';
import { chatCommands } from '../features/chats/chatCommands';
import { docSaveCommand, docTreeCommands } from '../features/docs/docCommands';
import { taskCommands, type TaskCommandDeps } from '../features/tasks/taskCommands';
import { shellCommands } from '../shell/shellCommands';
import { createRegistry, findKeyConflicts, type Command, type Platform } from './registry';

import type { RootStore } from '../stores';

/**
 * Every section's commands as the app registers them, built with stand-ins for what they read at run time. The builders only read their
 * dependencies inside handlers and `when`, so the stand-ins are never called: this test is about the keys.
 */
function wholeKeymap(): Command[] {
    const nothing = new Proxy({}, { get: () => () => undefined }) as never;
    const shell = shellCommands(nothing as Pick<RootStore, 'selectedProjectId' | 'ui'>, vi.fn()).map((command): Command => ({ ...command, scope: 'app' }));
    const list = { ids: () => [], openId: () => null };

    return [
        ...shell,
        ...taskCommands(nothing as TaskCommandDeps),
        ...chatCommands({ list: () => null, ids: () => [], openId: () => undefined }),
        ...runCommands({ tree: () => null, ...list, select: vi.fn() }),
        ...docTreeCommands({ tree: () => null, ...list }),
        docSaveCommand(nothing),
    ];
}

const PLATFORMS: Platform[] = ['darwin', 'win32'];

describe('the whole keymap', () => {
    it('has no key collisions, on either platform', () => {
        expect(findKeyConflicts(wholeKeymap()).map(({ message }) => message)).toEqual([]);
    });

    it.each(PLATFORMS)('registers in one registry on %s, as the sections do while mounted', (platform) => {
        const registry = createRegistry(platform);
        const commands = wholeKeymap();

        for (const command of commands) registry.defineCommand(command);

        expect(registry.listCommands().all).toHaveLength(commands.length);
        expect(() => registry.assertNoConflicts()).not.toThrow();
    });

    it('gives every command its own id, and every section its own scope', () => {
        const commands = wholeKeymap();

        expect(new Set(commands.map(({ id }) => id)).size).toBe(commands.length);
        expect(new Set(commands.map(({ scope }) => scope))).toEqual(new Set(['app', 'tasks', 'chats', 'agents', 'docs']));
    });

    it('has J in every section, so the no-collision check above is what lets them share it', () => {
        const keysOf = (scope: string) => wholeKeymap().filter(command => command.scope === scope).flatMap(({ keys }) => (typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : []));

        for (const scope of ['tasks', 'chats', 'agents', 'docs']) expect(keysOf(scope)).toContain('j');
    });

    it('does reject an app command that takes a key of a section', () => {
        const stolen: Command = { id: 'app.j', title: 'Jump', group: 'General', keys: 'j', scope: 'app', handler: () => undefined };
        const conflicts = findKeyConflicts([...wholeKeymap(), stolen]);

        expect(conflicts.length).toBeGreaterThan(0);
        expect(conflicts.every(({ a, b }) => a.id === 'app.j' || b.id === 'app.j')).toBe(true);
        expect(new Set(conflicts.flatMap(({ a, b }) => [a.scope, b.scope]))).toEqual(new Set(['app', 'tasks', 'chats', 'agents', 'docs']));
    });
});
