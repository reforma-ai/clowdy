import { describe, expect, it } from 'vitest';

import { ChatListPreferences } from './chatListPreferences';

const memory = () => {
    const values = new Map<string, string>();

    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe('the Agents list preferences', () => {
    it('sorts by when the chats were made and lists finished threads by default', () => {
        const preferences = new ChatListPreferences(memory());

        expect([preferences.sort, preferences.showFinishedThreads]).toEqual(['created', true]);
    });

    it('remembers the order and the filter on this computer', () => {
        const storage = memory();
        const preferences = new ChatListPreferences(storage);

        preferences.setSort('activity');
        preferences.setShowFinishedThreads(false);

        const later = new ChatListPreferences(storage);

        expect([later.sort, later.showFinishedThreads]).toEqual(['activity', false]);

        later.setSort('created');
        later.setShowFinishedThreads(true);

        const last = new ChatListPreferences(storage);

        expect([last.sort, last.showFinishedThreads]).toEqual(['created', true]);
    });

    it('reads anything it did not write as the default', () => {
        const storage = memory();

        storage.setItem('clowdy:chat-sort', '"oldest"');
        storage.setItem('clowdy:show-finished-threads', '"no"');

        const preferences = new ChatListPreferences(storage);

        expect([preferences.sort, preferences.showFinishedThreads]).toEqual(['created', true]);
    });

    it('works without storage', () => {
        const preferences = new ChatListPreferences(undefined);

        preferences.setSort('activity');

        expect(preferences.sort).toBe('activity');
    });
});
