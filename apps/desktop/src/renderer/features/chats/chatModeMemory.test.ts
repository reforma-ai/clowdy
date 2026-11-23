import { describe, expect, it } from 'vitest';

import { readRememberedMode, startingMode, writeRememberedMode } from './chatModeMemory';

import type { KeyValueStorage } from '../../stores/storage';

const memory = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return {
        getItem: key => data[key] ?? null,
        setItem: (key, value) => {
            data[key] = value;
        },
    };
};

describe('chatModeMemory', () => {
    it('gives back the mode that was written', () => {
        const storage = memory();

        expect(readRememberedMode(storage)).toBeUndefined();

        writeRememberedMode('semi', storage);
        expect(readRememberedMode(storage)).toBe('semi');

        writeRememberedMode('autopilot', storage);
        expect(readRememberedMode(storage)).toBe('autopilot');
    });

    it('remembers nothing for what is stored but not a mode, or when storage throws', () => {
        const storage = memory();

        storage.setItem('clowdy:chat-mode', JSON.stringify('manual'));
        expect(readRememberedMode(storage)).toBeUndefined();

        storage.setItem('clowdy:chat-mode', '{not json');
        expect(readRememberedMode(storage)).toBeUndefined();

        expect(
            readRememberedMode({
                getItem: () => {
                    throw new Error('blocked');
                },
                setItem: () => {
                    throw new Error('blocked');
                },
            })
        ).toBeUndefined();
    });

    it('starts a chat in the mode its project asks for, else the last one picked, else Hands-off', () => {
        expect(startingMode('semi', 'autopilot')).toBe('semi');
        expect(startingMode(undefined, 'semi')).toBe('semi');
        expect(startingMode(undefined, undefined)).toBe('autopilot');
    });
});
