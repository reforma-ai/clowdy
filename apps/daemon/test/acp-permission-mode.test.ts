import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { ToolBridge } from '../src/engine/acp/bridge';
import { applyChoices } from '../src/engine/acp/conversation';
import { AcpEngine } from '../src/engine/acp/engine';
import { AgentRegistry } from '../src/engine/acp/registry';
import { claude } from '../src/providers/claude';
import { collect, FAKE_AGENT, FAKE_AGENT_V2, PROTOCOLS, quietDiscovery, rig, textOf } from './acp-helpers';
import { testSpec } from './helpers';

import type { ConfigChange, SelectOption } from '../src/engine/acp/conversation';
import type { ResolvedAgent } from '../src/engine/acp/registry';
import type { ApprovalRequest } from '../src/engine/types';
import type { Provider } from '../src/providers/types';
import type { Rig } from './acp-helpers';

const MODES = ['default', 'acceptEdits', 'auto', 'bypassPermissions'];

/** The options a Claude-like agent opens a session with. */
const options = (mode = 'default'): SelectOption[] => [
    {
        id: 'model',
        category: 'model',
        currentValue: 'fast',
        choices: [
            { value: 'fast', name: 'Fast' },
            { value: 'smart', name: 'Smart' },
        ],
    },
    {
        id: 'effort',
        category: 'thought_level',
        currentValue: 'high',
        choices: ['low', 'high', 'max'].map(value => ({ value, name: value })),
    },
    { id: 'mode', category: 'mode', currentValue: mode, choices: MODES.map(value => ({ value, name: value })) },
];

/** Runs `applyChoices` on `opened` and says what it sent, in order. */
async function sent(
    opened: SelectOption[],
    choices: { model?: string; effort?: string; mode?: string }
): Promise<ConfigChange[]> {
    const changes: ConfigChange[] = [];

    await applyChoices({
        agent: 'Test agent',
        options: opened,
        ...choices,
        set: async change => {
            changes.push(change);

            return undefined;
        },
    });

    return changes;
}

describe('the permission mode of a preset', () => {
    test("is set on the agent's mode option, after the model and the reasoning level", async () => {
        const changes = await sent(options(), { model: 'smart', effort: 'max', mode: 'auto' });

        expect(changes.map(change => [change.configId, change.value])).toEqual([
            ['model', 'smart'],
            ['effort', 'max'],
            ['mode', 'auto'],
        ]);
    });

    test('is set alone, and found by the value the agent uses for it', async () => {
        expect(await sent(options(), { mode: 'bypassPermissions' })).toEqual([
            { configId: 'mode', value: 'bypassPermissions', unchanged: false },
        ]);
    });

    test('is not sent again when the agent is on it already', async () => {
        expect(await sent(options('acceptEdits'), { mode: 'acceptEdits' })).toEqual([]);
    });

    test('is left to the agent, with a note in the log, when the agent does not offer it', async () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            expect(await sent(options(), { mode: 'plan-ish' })).toEqual([]);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Test agent offers no permission mode called "plan-ish"')
            );

            // An agent with no mode option at all (Cursor has none that is a permission) is treated the same.
            expect(
                await sent(
                    options().filter(option => option.id !== 'mode'),
                    { mode: 'auto' }
                )
            ).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });

    test('is not touched when the preset names none', async () => {
        expect(await sent(options(), { model: 'fast' })).toEqual([]);
    });
});

describe.each(PROTOCOLS)('the permission mode through a session over %s', protocol => {
    let current: Rig | undefined;

    afterEach(() => {
        current?.stop();
        current = undefined;
    });

    /** Starts the fake agent as a registry would resolve it for `permission` (undefined: an agent a test builds with no preset at all), and reads what the session ended up on. */
    async function chosen(
        permission: ResolvedAgent['permission'],
        start: Parameters<Rig['start']>[1] = {}
    ): Promise<{ model: string; effort: string; sets: number; mode?: string }> {
        current = rig({ protocol, agentEnv: { FAKE_ACP_MODES: '1' } });

        const resolve = current.registry.resolve.bind(current.registry);

        current.registry.resolve = async id => {
            const found = await resolve(id);

            return found.ok ? { ok: true, agent: { ...found.agent, permission } } : found;
        };

        const { session } = current.start('choice', start);
        const events = await collect(session);

        await session.close();

        return JSON.parse(textOf(events));
    }

    test('reaches the agent as its mode', async () => {
        expect(await chosen({ preset: 'accept-edits', mode: 'acceptEdits', answer: 'ask' })).toMatchObject({
            mode: 'acceptEdits',
            sets: 1,
        });
    });

    test('is sent again on a session that resumes, since each turn is a new agent process', async () => {
        expect(
            await chosen({ preset: 'auto', mode: 'auto', answer: 'ask' }, { resumeSessionId: 'earlier-7' })
        ).toMatchObject({ mode: 'auto', sets: 1 });
    });

    test('is not sent for a preset that sets none', async () => {
        expect(await chosen({ preset: 'ask', answer: 'ask' })).toEqual({ model: 'fast', effort: 'high', sets: 0 });
    });
});

describe.each(PROTOCOLS)('an agent the person has not chosen a preset for, through a session over %s', protocol => {
    let bridge: ToolBridge | undefined;

    afterEach(() => {
        bridge?.stop();
        bridge = undefined;
    });

    /** The real provider's `permissions` (or none) on the fake agent, which offers the modes of Claude's adapter; the registry resolves it as it does for a run. */
    function agentOn(provider: Pick<Provider, 'permissions'>): {
        registry: AgentRegistry;
        run: (prompt: string) => Promise<{ text: string; asked: ApprovalRequest[] }>;
    } {
        const registry = new AgentRegistry({
            discovery: quietDiscovery(),
            providers: [
                {
                    ...provider,
                    spec: {
                        ...testSpec('stub').spec,
                        launch: { kind: 'binary', args: [protocol === 'v2' ? FAKE_AGENT_V2 : FAKE_AGENT] },
                        env: { FAKE_ACP_MODES: '1' },
                        protocol,
                    },
                },
            ],
        });

        registry.update('stub', { path: process.execPath });
        bridge = new ToolBridge();

        const engine = new AcpEngine('stub', { registry, bridge, env: process.env, backgroundHandoffMs: 400 });

        return {
            registry,
            async run(prompt) {
                const asked: ApprovalRequest[] = [];
                const { signal } = new AbortController();
                const session = engine.start({
                    cwd: process.cwd(),
                    prompt,
                    tools: [],
                    signal,
                    approve: async request => {
                        asked.push(request);

                        return 'allow_once';
                    },
                });
                const events = await collect(session);

                await session.close();

                return { text: textOf(events), asked };
            },
        };
    }

    /** The agent's `choice` line (a JSON object) and what its permission request was answered with. */
    const read = (text: string) => {
        const end = text.indexOf('}') + 1;

        return { choice: JSON.parse(text.slice(0, end)) as Record<string, unknown>, answer: text.slice(end) };
    };

    const REQUEST = 'choice\nperm execute {"title":"Run ls","rawInput":{"command":"ls"}}';

    test('Claude Code starts in Approve for me and has its requests put to the person', async () => {
        const { run } = agentOn({ permissions: claude.permissions });
        const { text, asked } = await run(REQUEST);

        expect(read(text)).toEqual({
            choice: { model: 'fast', effort: 'high', sets: 1, mode: 'auto' },
            answer: 'permission: once',
        });
        expect(asked).toHaveLength(1);
    });

    test("an agent whose provider declares none starts on the client's Full access: no mode, every request allowed, nobody asked", async () => {
        const { run } = agentOn({});
        const { text, asked } = await run(REQUEST);

        expect(read(text)).toEqual({ choice: { model: 'fast', effort: 'high', sets: 0 }, answer: 'permission: once' });
        expect(asked).toEqual([]);
    });

    test("the person's choice wins over the default", async () => {
        const full = agentOn({ permissions: claude.permissions });

        full.registry.update('stub', { permission: 'full' });

        const { text, asked } = await full.run(REQUEST);

        expect(read(text)).toEqual({
            choice: { model: 'fast', effort: 'high', sets: 1, mode: 'bypassPermissions' },
            answer: 'permission: once',
        });
        expect(asked).toEqual([]);
    });
});
