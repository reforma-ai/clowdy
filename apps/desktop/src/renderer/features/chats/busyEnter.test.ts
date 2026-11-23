import { describe, expect, it } from 'vitest';

import { BusyEnterPreference, sendMode } from './busyEnter';

const memory = () => {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
    };
};

describe('Enter while the agent works', () => {
    it('steers by default, and remembers a choice on this computer', () => {
        const storage = memory();

        expect(new BusyEnterPreference(storage).mode).toBe('steer');

        new BusyEnterPreference(storage).setMode('queue');

        expect(new BusyEnterPreference(storage).mode).toBe('queue');
    });

    it('reads anything it did not write as the default', () => {
        const storage = memory();

        storage.setItem('clowdy:enter-while-busy', '"later"');

        expect(new BusyEnterPreference(storage).mode).toBe('steer');
    });

    it('sends the way the setting says on Enter, and the other way on Cmd/Ctrl+Enter', () => {
        expect([
            sendMode('steer', false),
            sendMode('steer', true),
            sendMode('queue', false),
            sendMode('queue', true),
        ]).toEqual(['steer', 'queue', 'queue', 'steer']);
    });
});
