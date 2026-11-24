import { describe, expect, it } from 'vitest';

import { ChatListPreferences } from './chatListPreferences';

const memory = () => {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
    };
};

describe('the Agents list preferences', () => {
    it('lists finished threads by default', () => {
        const preferences = new ChatListPreferences(memory());

        expect(preferences.showFinishedThreads).toBe(true);
    });

    it('remembers the filter on this computer', () => {
        const storage = memory();
        const preferences = new ChatListPreferences(storage);

        preferences.setShowFinishedThreads(false);

        const later = new ChatListPreferences(storage);

        expect(later.showFinishedThreads).toBe(false);

        later.setShowFinishedThreads(true);

        const last = new ChatListPreferences(storage);

        expect(last.showFinishedThreads).toBe(true);
    });

    it('reads anything it did not write as the default', () => {
        const storage = memory();

        storage.setItem('clowdy:show-finished-threads', '"no"');

        const preferences = new ChatListPreferences(storage);

        expect(preferences.showFinishedThreads).toBe(true);
    });

    it('works without storage', () => {
        const preferences = new ChatListPreferences(undefined);

        preferences.setShowFinishedThreads(false);

        expect(preferences.showFinishedThreads).toBe(false);
    });
});
