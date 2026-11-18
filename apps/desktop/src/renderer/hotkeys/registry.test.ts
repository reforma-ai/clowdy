import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

import { commandPresses, commandSequences, createRegistry, findKeyConflicts, type Command } from './registry';

let counter = 0;

function command(overrides: Partial<Command> = {}): Command {
    return { id: `command-${ ++counter }`, title: 'Command', group: 'Tests', keys: 'x', scope: 'tasks', handler: vi.fn(), ...overrides };
}

describe('commandPresses', () => {
    it('writes a modifier chord in the key names of hotkeysToSymbols', () => {
        expect(commandPresses({ keys: '$mod+k' }, 'darwin')).toEqual([['meta', 'k']]);
        expect(commandPresses({ keys: '$mod+k' }, 'win32')).toEqual([['ctrl', 'k']]);
        expect(commandPresses({ keys: '$mod+Shift+Alt+x' }, 'darwin')).toEqual([['alt', 'shift', 'meta', 'x']]);
        expect(commandPresses({ keys: '$mod+Shift+Alt+x' }, 'win32')).toEqual([['ctrl', 'alt', 'shift', 'x']]);
    });

    it('writes a sequence as one entry per press', () => {
        expect(commandPresses({ keys: 'g c' }, 'darwin')).toEqual([['g'], ['c']]);
    });

    it('names keys, codes and punctuation', () => {
        expect(commandPresses({ keys: 'ArrowDown' })).toEqual([['down']]);
        expect(commandPresses({ keys: 'Escape' })).toEqual([['escape']]);
        expect(commandPresses({ keys: 'Shift+R' }, 'darwin')).toEqual([['shift', 'r']]);
        expect(commandPresses({ keys: '$mod+Shift+Quote' }, 'darwin')).toEqual([['shift', 'meta', '\'']]);
        expect(commandPresses({ keys: 'KeyK' })).toEqual([['k']]);
        expect(commandPresses({ keys: '?' })).toEqual([['?']]);
        expect(commandPresses({ keys: '$mod+/' }, 'win32')).toEqual([['ctrl', '/']]);
    });

    it('shows the first of several alternatives and lists them all through commandSequences', () => {
        const keys = ['ArrowDown', 'j'];

        expect(commandPresses({ keys }, 'darwin')).toEqual([['down']]);
        expect(commandSequences({ keys }, 'darwin')).toEqual([[['down']], [['j']]]);
    });

    it('picks the keys of the platform, and Linux uses the Windows ones', () => {
        const keys = { mac: '$mod+Backspace', win: '$mod+Delete' };

        expect(commandPresses({ keys }, 'darwin')).toEqual([['meta', 'backspace']]);
        expect(commandPresses({ keys }, 'win32')).toEqual([['ctrl', 'delete']]);
        expect(commandPresses({ keys }, 'linux')).toEqual([['ctrl', 'delete']]);
    });
});

describe('defineCommand', () => {
    it('removes the command when the returned function runs, and frees its keys', () => {
        const registry = createRegistry('darwin');
        const dispose = registry.defineCommand(command({ id: 'a', keys: 'x' }));

        expect(registry.listCommands().all.map(({ id }) => id)).toEqual(['a']);

        dispose();

        expect(registry.listCommands().all).toEqual([]);
        expect(() => registry.defineCommand(command({ id: 'b', keys: 'x' }))).not.toThrow();
    });

    it('rejects a second command with the same id', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'x' }));

        expect(() => registry.defineCommand(command({ id: 'a', keys: 'y' }))).toThrow('already defined');
    });

    it('rejects keys it cannot parse, with the command id', () => {
        const registry = createRegistry('darwin');

        expect(() => registry.defineCommand(command({ id: 'bad', keys: '' }))).toThrow('"bad"');
        expect(() => registry.defineCommand(command({ id: 'bad', keys: 'Cmd+k' }))).toThrow('unknown modifier "Cmd"');
    });
});

describe('key conflicts', () => {
    it('throws for the same keys in one scope', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: '$mod+k' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'Meta+k' }))).toThrow('same keys');
    });

    it('throws when either scope is app, even for a scope that is not live', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'g c', scope: 'app' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'g c', scope: 'tasks' }))).toThrow('same keys');

        const other = createRegistry('darwin');

        other.defineCommand(command({ id: 'a', keys: 'j', scope: 'tasks' }));

        expect(() => other.defineCommand(command({ id: 'b', keys: 'j', scope: 'app' }))).toThrow('same keys');
    });

    it('lets the scopes of different sections share keys', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'tasks.down', keys: 'j', scope: 'tasks' }));

        expect(() => registry.defineCommand(command({ id: 'agents.down', keys: 'j', scope: 'agents' }))).not.toThrow();
    });

    it('throws when a single key is also the start of a chord', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'g', scope: 'tasks' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'g c', scope: 'tasks' }))).toThrow('starts or continues');

        const other = createRegistry('darwin');

        other.defineCommand(command({ id: 'a', keys: 'g c', scope: 'tasks' }));

        expect(() => other.defineCommand(command({ id: 'b', keys: 'g', scope: 'tasks' }))).toThrow('starts or continues');
    });

    it('allows chords that only share a first key', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'g c', scope: 'app' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'g t', scope: 'app' }))).not.toThrow();
    });

    it('treats modifiers as strict', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'r' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'Shift+r' }))).not.toThrow();
        expect(() => registry.defineCommand(command({ id: 'c', keys: '$mod+r' }))).not.toThrow();
    });

    it('sees a code and its character as the same key', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: '$mod+Slash' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: '$mod+/' }))).toThrow('same keys');
    });

    it('sees a symbol key that tolerates Shift as the same as one that needs it', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: '?' }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: 'Shift+?' }))).toThrow('same keys');
    });

    it('checks the keys of both platforms, so a Windows collision shows on a Mac', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: { mac: '$mod+Backspace', win: '$mod+Delete' } }));

        expect(() => registry.defineCommand(command({ id: 'b', keys: { mac: 'x', win: 'Control+Delete' } }))).toThrow('same keys');
    });

    it('checks the alternatives of one command against each other', () => {
        const registry = createRegistry('darwin');

        expect(() => registry.defineCommand(command({ keys: ['g', 'g c'] }))).toThrow('starts or continues');
    });

    it('lets a test assert that the whole keymap has none', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(command({ id: 'a', keys: 'j', scope: 'tasks' }));
        registry.defineCommand(command({ id: 'b', keys: 'j', scope: 'agents' }));

        expect(registry.findConflicts()).toEqual([]);
        expect(() => registry.assertNoConflicts()).not.toThrow();

        const clashing = [command({ id: 'a', keys: 'j', scope: 'tasks' }), command({ id: 'b', keys: 'j', scope: 'tasks' }), command({ id: 'c', keys: 'k', scope: 'tasks' })];

        expect(findKeyConflicts(clashing).map(({ a, b, kind }) => [a.id, b.id, kind])).toEqual([['a', 'b', 'duplicate']]);
        expect(findKeyConflicts([command({ id: 'own', keys: ['g', 'g c'] })]).map(({ a, b, kind }) => [a.id, b.id, kind])).toEqual([['own', 'own', 'prefix']]);
    });
});

describe('scopes', () => {
    it('keeps app live always and the others while they are on the stack', () => {
        const registry = createRegistry('darwin');
        const app = command({ id: 'app', keys: 'a', scope: 'app' });
        const tasks = command({ id: 'tasks', keys: 'b', scope: 'tasks' });

        registry.defineCommand(app);
        registry.defineCommand(tasks);

        expect(registry.listCommands().live).toEqual([app]);

        const pop = registry.pushScope('tasks');

        expect(registry.listCommands().live).toEqual([app, tasks]);
        expect(registry.listCommands().all).toEqual([app, tasks]);

        pop();

        expect(registry.listCommands().live).toEqual([app]);
    });

    it('pops the scope that was pushed even when scopes leave out of order', () => {
        const registry = createRegistry('darwin');
        const popTasks = registry.pushScope('tasks');
        const popPicker = registry.pushScope('picker');

        popTasks();

        expect(registry.scopes).toEqual(['picker']);

        popPicker();

        expect(registry.scopes).toEqual([]);
    });

    it('keeps a scope pushed twice until both pop', () => {
        const registry = createRegistry('darwin');
        const first = registry.pushScope('tasks');
        const second = registry.pushScope('tasks');

        first();

        expect(registry.scopeDepth('tasks')).toBe(0);

        second();

        expect(registry.scopeDepth('tasks')).toBeNull();
    });

    it('switches a command off while its when returns false', () => {
        const registry = createRegistry('darwin');
        let enabled = true;
        const gated = command({ id: 'gated', scope: 'app', when: () => enabled });

        registry.defineCommand(gated);

        expect(registry.listCommands().live).toEqual([gated]);

        enabled = false;

        expect(registry.listCommands().live).toEqual([]);
        expect(registry.listCommands().all).toEqual([gated]);
    });
});

describe('observed by a component', () => {
    // A key hint reads `entries` and the scope stack while it renders, and a command or scope leaves from a React cleanup, outside any action.
    it('removes a command and a scope without MobX warning about a change outside an action', () => {
        const registry = createRegistry('darwin');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const runs: string[] = [];
        const stop = autorun(() => runs.push(`${ registry.entries.length } entries, scopes ${ registry.scopes.join('+') }`));

        try {
            const remove = registry.defineCommand(command({ scope: 'app' }));
            const leave = registry.pushScope('tasks');

            remove();
            leave();

            expect(runs).toEqual(['0 entries, scopes ', '1 entries, scopes ', '1 entries, scopes tasks', '0 entries, scopes tasks', '0 entries, scopes ']);
            expect(warn).not.toHaveBeenCalled();
        }
        finally {
            stop();
            warn.mockRestore();
        }
    });
});
