import { describe, expect, it, vi } from 'vitest';

import { quickSearchCommands } from './quickSearchCommands';

describe('the quick search commands', () => {
    const open = vi.fn();
    const commands = (available = true) => quickSearchCommands({ open, available: () => available });

    it('open the palette on a tab each: all with Cmd+K, the names with Cmd+P, the text with Cmd+Shift+F', () => {
        const byId = Object.fromEntries(commands().map(command => [command.id, command]));

        expect(byId['search.open']).toMatchObject({ keys: '$mod+k' });
        expect(byId['search.files']).toMatchObject({ keys: '$mod+p' });
        expect(byId['search.text']).toMatchObject({ keys: '$mod+Shift+f' });

        byId['search.open']!.handler({} as KeyboardEvent);
        byId['search.files']!.handler({} as KeyboardEvent);
        byId['search.text']!.handler({} as KeyboardEvent);

        expect(open.mock.calls).toEqual([['all'], ['files'], ['text']]);
    });

    it('work from text fields and with the palette open, where each goes to its tab, and only where there is a project to search', () => {
        for (const command of commands(false)) {
            expect(command.inInputs).toBe(true);
            expect(command.inOverlays).toBe(true);
            expect(command.when?.()).toBe(false);
        }

        for (const command of commands(true)) expect(command.when?.()).toBe(true);
    });
});
