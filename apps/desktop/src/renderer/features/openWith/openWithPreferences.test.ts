import { describe, expect, it } from 'vitest';

import { OpenWithPreferences } from './openWithPreferences';

import type { KeyValueStorage } from '../../stores/storage';

function memory(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));

    return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

describe('OpenWithPreferences', () => {
    it('has no choice until one is made, so the first program the computer has opens a folder', () => {
        const preferences = new OpenWithPreferences(memory());

        expect([preferences.editor, preferences.terminal, preferences.fileManager]).toEqual([undefined, undefined, undefined]);
    });

    it('keeps each choice on this computer and reads it back', () => {
        const storage = memory();
        const preferences = new OpenWithPreferences(storage);

        preferences.setEditor('zed');
        preferences.setTerminal('ghostty');
        preferences.setFileManager('path-finder');

        const again = new OpenWithPreferences(storage);

        expect([again.editor, again.terminal, again.fileManager]).toEqual(['zed', 'ghostty', 'path-finder']);
    });

    it('ignores what is stored that is not the id of a program', () => {
        const preferences = new OpenWithPreferences(memory({ 'clowdy:default-editor': '7', 'clowdy:default-terminal': '{}', 'clowdy:default-file-manager': '""' }));

        expect([preferences.editor, preferences.terminal, preferences.fileManager]).toEqual([undefined, undefined, undefined]);
    });

    it('works with no storage at all', () => {
        const preferences = new OpenWithPreferences(undefined);

        preferences.setEditor('cursor');

        expect(preferences.editor).toBe('cursor');
    });
});
