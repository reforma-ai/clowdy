import { describe, expect, it, vi } from 'vitest';

import { createRegistry } from '../../hotkeys';
import { FILES_SCOPE, filesCommands, SHOW_HIDDEN_COMMAND } from './filesCommands';

describe('filesCommands', () => {
    it('has one command, Cmd+Shift+. in its own scope, that shows and hides the hidden files', () => {
        const toggleHidden = vi.fn();
        const [command, ...others] = filesCommands({ toggleHidden });

        expect(others).toEqual([]);
        expect(command).toMatchObject({ id: SHOW_HIDDEN_COMMAND, scope: FILES_SCOPE, keys: '$mod+Shift+.' });

        command!.handler({} as KeyboardEvent);

        expect(toggleHidden).toHaveBeenCalledOnce();
    });

    it('is not a text field\'s key: the editors keep Cmd+Shift+. for Quote', () => {
        expect(filesCommands({ toggleHidden: () => undefined })[0]!.inInputs).toBeUndefined();
    });

    it('is a key the registry takes beside the task\'s Cmd+. on the Tasks screen, since the scopes differ', () => {
        const registry = createRegistry('darwin');

        registry.defineCommand(filesCommands({ toggleHidden: () => undefined })[0]!);
        registry.defineCommand({ id: 'tasks.copy.key', title: 'Copy task key', group: 'Tasks', keys: '$mod+.', scope: 'tasks', handler: () => undefined });

        expect(() => registry.assertNoConflicts()).not.toThrow();
    });
});
