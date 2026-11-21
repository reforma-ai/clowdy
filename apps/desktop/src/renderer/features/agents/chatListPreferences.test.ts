import { describe, expect, it } from 'vitest';

import { ChatListPreferences } from './chatListPreferences';

const memory = () => {
    const values = new Map<string, string>();

    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('the Agents list preferences', () => {
    it('sorts by last activity and lists finished threads by default', () => {
        const preferences = new ChatListPreferences(memory());

        expect([preferences.sort, preferences.showFinishedThreads]).toEqual(['activity', true]);
    });

    it('remembers the order and the filter on this computer', () => {
        const storage = memory();
        const preferences = new ChatListPreferences(storage);

        preferences.setSort('created');
        preferences.setShowFinishedThreads(false);

        const later = new ChatListPreferences(storage);

        expect([later.sort, later.showFinishedThreads]).toEqual(['created', false]);

        later.setSort('activity');
        later.setShowFinishedThreads(true);

        const last = new ChatListPreferences(storage);

        expect([last.sort, last.showFinishedThreads]).toEqual(['activity', true]);
    });

    it('reads anything it did not write as the default', () => {
        const storage = memory();

        storage.setItem('clowdy:chat-sort', '"oldest"');
        storage.setItem('clowdy:show-finished-threads', '"no"');

        const preferences = new ChatListPreferences(storage);

        expect([preferences.sort, preferences.showFinishedThreads]).toEqual(['activity', true]);
    });

    it('works without storage', () => {
        const preferences = new ChatListPreferences(undefined);

        preferences.setSort('created');

        expect(preferences.sort).toBe('created');
    });
});
