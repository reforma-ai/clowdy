import { LAST_USED } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { NewChatDefaults, startingChoice } from './newChatDefaults';

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

describe('startingChoice', () => {
    it('takes the project\'s own agent and mode over the app\'s', () => {
        expect(startingChoice({ engine: 'codex', chatMode: 'semi' }, { engine: 'claude', mode: 'autopilot' })).toEqual({ engine: 'codex', mode: 'semi' });
    });

    it('follows the app where the project saved nothing (Default)', () => {
        expect(startingChoice({}, { engine: 'claude', mode: 'semi' })).toEqual({ engine: 'claude', mode: 'semi' });
    });

    it('names nothing for Last used, in the project or in the app, so the message box starts where the last chat left off', () => {
        expect(startingChoice({ engine: LAST_USED, chatMode: LAST_USED }, { engine: 'claude', mode: 'semi' })).toEqual({});
        expect(startingChoice({}, {})).toEqual({});
    });
});

describe('NewChatDefaults', () => {
    it('keeps the app\'s choice on this computer, and Last used clears it', () => {
        const storage = memoryStorage();
        const first = new NewChatDefaults(storage);

        first.setEngine('codex');
        first.setMode('semi');

        expect([new NewChatDefaults(storage).engine, new NewChatDefaults(storage).mode]).toEqual(['codex', 'semi']);

        first.setEngine(undefined);
        first.setMode(undefined);

        expect([new NewChatDefaults(storage).engine, new NewChatDefaults(storage).mode]).toEqual([undefined, undefined]);
    });
});
