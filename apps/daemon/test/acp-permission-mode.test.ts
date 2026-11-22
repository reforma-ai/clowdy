import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { applyChoices } from '../src/engine/acp/conversation';
import { collect, PROTOCOLS, rig, textOf } from './acp-helpers';

import type { ConfigChange, SelectOption } from '../src/engine/acp/conversation';
import type { ResolvedAgent } from '../src/engine/acp/registry';
import type { Rig } from './acp-helpers';

const MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

/** The options a Claude-like agent opens a session with. */
const options = (mode = 'default'): SelectOption[] => [
    { id: 'model', category: 'model', currentValue: 'fast', choices: [{ value: 'fast', name: 'Fast' }, { value: 'smart', name: 'Smart' }] },
    { id: 'effort', category: 'thought_level', currentValue: 'high', choices: ['low', 'high', 'max'].map(value => ({ value, name: value })) },
    { id: 'mode', category: 'mode', currentValue: mode, choices: MODES.map(value => ({ value, name: value })) },
];

/** Runs `applyChoices` on `opened` and says what it sent, in order. */
async function sent(opened: SelectOption[], choices: { model?: string; effort?: string; mode?: string }): Promise<ConfigChange[]> {
    const changes: ConfigChange[] = [];

    await applyChoices({ agent: 'Test agent', options: opened, ...choices, set: async (change) => {
        changes.push(change);

        return undefined;
    } });

    return changes;
}

describe('the permission mode of a preset', () => {
    test('is set on the agent\'s mode option, after the model and the reasoning level', async () => {
        const changes = await sent(options(), { model: 'smart', effort: 'max', mode: 'auto' });

        expect(changes.map(change => [change.configId, change.value])).toEqual([['model', 'smart'], ['effort', 'max'], ['mode', 'auto']]);
    });

    test('is set alone, and found by the value the agent uses for it', async () => {
        expect(await sent(options(), { mode: 'bypassPermissions' })).toEqual([{ configId: 'mode', value: 'bypassPermissions', unchanged: false }]);
    });

    test('is not sent again when the agent is on it already', async () => {
        expect(await sent(options('acceptEdits'), { mode: 'acceptEdits' })).toEqual([]);
    });

    test('is left to the agent, with a note in the log, when the agent does not offer it', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            expect(await sent(options(), { mode: 'plan-ish' })).toEqual([]);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Test agent offers no permission mode called "plan-ish"'));

            // An agent with no mode option at all (Cursor has none that is a permission) is treated the same.
            expect(await sent(options().filter(option => option.id !== 'mode'), { mode: 'auto' })).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(2);
        }
        finally {
            warn.mockRestore();
        }
    });

    test('is not touched when the preset names none', async () => {
        expect(await sent(options(), { model: 'fast' })).toEqual([]);
    });
});

describe.each(PROTOCOLS)('the permission mode through a session over %s', (protocol) => {
    let current: Rig | undefined;

    afterEach(() => {
        current?.stop();
        current = undefined;
    });

    /** Starts the fake agent as the registry would resolve it for a chosen preset (`permission` undefined: none chosen), and reads what the session ended up on. */
    async function chosen(permission: ResolvedAgent['permission'], start: Parameters<Rig['start']>[1] = {}): Promise<{ model: string; effort: string; sets: number; mode?: string }> {
        current = rig({ protocol, agentEnv: { FAKE_ACP_MODES: '1' } });

        const resolve = current.registry.resolve.bind(current.registry);

        current.registry.resolve = async (id) => {
            const found = await resolve(id);

            return found.ok ? { ok: true, agent: { ...found.agent, ...(permission && { permission }) } } : found;
        };

        const { session } = current.start('choice', start);
        const events = await collect(session);

        await session.close();

        return JSON.parse(textOf(events));
    }

    test('reaches the agent as its mode', async () => {
        expect(await chosen({ preset: 'accept-edits', mode: 'acceptEdits', answer: 'ask' })).toMatchObject({ mode: 'acceptEdits', sets: 1 });
    });

    test('is sent again on a session that resumes, since each turn is a new agent process', async () => {
        expect(await chosen({ preset: 'auto', mode: 'auto', answer: 'ask' }, { resumeSessionId: 'earlier-7' })).toMatchObject({ mode: 'auto', sets: 1 });
    });

    test('is not sent for a preset that sets none, nor when no preset was chosen', async () => {
        expect(await chosen({ preset: 'ask', answer: 'ask' })).toEqual({ model: 'fast', effort: 'high', sets: 0 });
        expect(await chosen(undefined)).toEqual({ model: 'fast', effort: 'high', sets: 0 });
    });
});
