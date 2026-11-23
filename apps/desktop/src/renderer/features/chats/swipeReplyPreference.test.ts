import { describe, expect, it } from 'vitest';

import { SwipeReplyPreference } from './swipeReplyPreference';

const memory = () => {
    const values = new Map<string, string>();

    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
    };
};

describe('Swipe a message to reply', () => {
    it('is on by default, and remembers a choice on this computer', () => {
        const storage = memory();

        expect(new SwipeReplyPreference(storage).enabled).toBe(true);

        new SwipeReplyPreference(storage).setEnabled(false);

        expect(storage.getItem('clowdy:swipe-to-reply')).toBe('false');
        expect(new SwipeReplyPreference(storage).enabled).toBe(false);

        new SwipeReplyPreference(storage).setEnabled(true);

        expect(new SwipeReplyPreference(storage).enabled).toBe(true);
    });

    it('reads anything it did not write as the default, on', () => {
        const storage = memory();

        storage.setItem('clowdy:swipe-to-reply', '"no"');

        expect(new SwipeReplyPreference(storage).enabled).toBe(true);
    });

    it('works without storage', () => {
        const preference = new SwipeReplyPreference(undefined);

        preference.setEnabled(false);

        expect(preference.enabled).toBe(false);
    });
});
