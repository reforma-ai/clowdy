import { describe, expect, it } from 'vitest';

import { STAR_CARD_MIN_AGE_MS, STAR_CARD_MIN_CHATS, StarCardPreferences, starCardDue } from './starCardState';

import type { ChatId } from '@clowdy/protocol';

const memory = () => {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
    };
};

const NOW = 1_800_000_000_000;
const chats = (count: number, threads = 0) => [
    ...Array.from({ length: count }, () => ({})),
    ...Array.from({ length: threads }, () => ({ parentChatId: 'c-1' as ChatId })),
];

describe('the Star card rule', () => {
    it('is due once the oldest project is three days old and the project has three chats', () => {
        const projects = [{ createdAt: NOW - STAR_CARD_MIN_AGE_MS }];

        expect(starCardDue({ projects, chats: chats(STAR_CARD_MIN_CHATS), now: NOW })).toBe(true);
    });

    it('waits while the data is younger than that', () => {
        const projects = [{ createdAt: NOW - STAR_CARD_MIN_AGE_MS + 1 }];

        expect(starCardDue({ projects, chats: chats(10), now: NOW })).toBe(false);
    });

    it('waits while the project has fewer chats than that', () => {
        const projects = [{ createdAt: NOW - 30 * STAR_CARD_MIN_AGE_MS }];

        expect(starCardDue({ projects, chats: chats(STAR_CARD_MIN_CHATS - 1), now: NOW })).toBe(false);
    });

    it('does not count the threads that agents started', () => {
        const projects = [{ createdAt: NOW - 30 * STAR_CARD_MIN_AGE_MS }];

        expect(starCardDue({ projects, chats: chats(STAR_CARD_MIN_CHATS - 1, 5), now: NOW })).toBe(false);
    });

    it('takes the oldest project for the age, which is the personal space', () => {
        const projects = [{ createdAt: NOW - 1000 }, { createdAt: NOW - STAR_CARD_MIN_AGE_MS }];

        expect(starCardDue({ projects, chats: chats(STAR_CARD_MIN_CHATS), now: NOW })).toBe(true);
    });

    it('is not due before the projects have loaded', () => {
        expect(starCardDue({ projects: [], chats: chats(10), now: NOW })).toBe(false);
    });
});

describe('the Star card preferences', () => {
    it('start open', () => {
        expect(new StarCardPreferences(memory()).dismissed).toBe(false);
    });

    it('remember on this computer that the card was closed', () => {
        const storage = memory();

        new StarCardPreferences(storage).dismiss();

        expect(new StarCardPreferences(storage).dismissed).toBe(true);
    });

    it('read anything they did not write as open', () => {
        const storage = memory();

        storage.setItem('clowdy:star-card-dismissed', '"yes"');

        expect(new StarCardPreferences(storage).dismissed).toBe(false);
    });

    it('work without storage', () => {
        const preferences = new StarCardPreferences(undefined);

        preferences.dismiss();

        expect(preferences.dismissed).toBe(true);
    });
});
