import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Discovery } from '../src/engine/acp/discovery';
import { AgentRegistry } from '../src/engine/acp/registry';
import { PROVIDERS } from '../src/providers/builtin';
import { alive, collect, FAKE_AGENT, rig, textOf, tool, types, until } from './acp-helpers';

import type { EngineEvent } from '../src/engine/types';
import type { Rig } from './acp-helpers';

const SPECS = PROVIDERS.map(provider => provider.spec);

let root: string;
let bin: string;
let current: Rig | undefined;

/** An executable that prints a version when run, so discovery finds the agent installed. */
function program(name: string): string {
    const path = join(bin, name);

    writeFileSync(path, '#!/bin/sh\necho "1.0.0"\n');
    chmodSync(path, 0o755);

    return path;
}

const registry = () =>
    new AgentRegistry({
        discovery: new Discovery({
            env: { PATH: bin },
            home: join(root, 'home'),
            loginPath: async () => undefined,
            installDirs: [],
        }),
        runtime: async () => process.execPath,
    });

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-layers-'));
    bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'home'));
});

afterEach(() => {
    current?.stop();
    current = undefined;
    rmSync(root, { recursive: true, force: true });
});

describe('the protocol of an agent', () => {
    test('a built-in agent resolves with the protocol its catalog entry names, and v1 when it names none', async () => {
        const reg = registry();
        const [spec] = SPECS;
        const named = spec.protocol;

        program(spec.programs[0]);

        const protocolOf = async () => {
            const resolved = await reg.resolve(spec.id);

            return resolved.ok && resolved.agent.protocol;
        };

        try {
            delete spec.protocol;
            expect(await protocolOf()).toBe('v1');

            spec.protocol = 'v2';
            expect(await protocolOf()).toBe('v2');
        } finally {
            if (named) {
                spec.protocol = named;
            } else {
                delete spec.protocol;
            }
        }
    });

    test('a built-in agent resolves with the wake flag its catalog entry names, and without one when it names none', async () => {
        const reg = registry();
        const [spec] = SPECS;
        const named = spec.wakesOnBackgroundEnd;

        program(spec.programs[0]);

        const flagOf = async () => {
            const resolved = await reg.resolve(spec.id);

            return resolved.ok && resolved.agent.wakesOnBackgroundEnd;
        };

        try {
            delete spec.wakesOnBackgroundEnd;
            expect(await flagOf()).toBeUndefined();

            spec.wakesOnBackgroundEnd = true;
            expect(await flagOf()).toBe(true);
        } finally {
            if (named) {
                spec.wakesOnBackgroundEnd = named;
            } else {
                delete spec.wakesOnBackgroundEnd;
            }
        }
    });

    test('Claude Code reports finished background work by itself, so the runtime does not tell it', () => {
        expect(SPECS.find(spec => spec.id === 'claude')?.wakesOnBackgroundEnd).toBeUndefined();
    });

    test('Claude Code and Codex are on v2, and every other built-in agent stays on v1', () => {
        expect(SPECS.filter(spec => spec.protocol === 'v2').map(spec => spec.id)).toEqual(['claude', 'codex']);
        expect(SPECS.find(spec => spec.id === 'cursor')?.protocol).toBeUndefined();
    });

    test('Codex starts no turn to report background work that ended, so the runtime tells it, and Claude Code does start one', () => {
        expect(SPECS.filter(spec => spec.wakesOnBackgroundEnd).map(spec => spec.id)).toEqual(['codex']);
    });

    test('Codex is pinned to an adapter that reports background work on v2', () => {
        const launch = SPECS.find(spec => spec.id === 'codex')?.launch;

        expect(launch).toMatchObject({ kind: 'package', package: '@agentclientprotocol/codex-acp@2.8.0' });
    });

    test('a custom agent speaks v1', async () => {
        const reg = registry();

        reg.add({ id: 'mine', name: 'Mine', command: program('mine'), args: [], env: {} });

        const resolved = await reg.resolve('mine');

        expect(resolved.ok && resolved.agent.protocol).toBe('v1');
    });

    test("an agent set to v2 is spoken to in v2: the handshake carries the client's info and no file access or terminal", async () => {
        const { session } = (current = rig({ protocol: 'v2' })).start('capabilities\nsay hello world');
        const events = await collect(session);

        await session.close();

        // Only a v2 agent takes this handshake: `info` is required, and the answer has `capabilities.session`, not `agentCapabilities`.
        expect(types(events).filter(type => type === 'process')).toHaveLength(1);
        expect(JSON.parse(textOf(events).replace(/hello world$/, ''))).toEqual({});
        expect(textOf(events)).toMatch(/hello world$/);
        expect(events.at(-1)).toEqual({ type: 'done', result: 'hello world' });
    });

    test('what the adapter needs to hear about the client rides in the capabilities of a v2 handshake as well', async () => {
        const meta = { parameterizedModelPicker: true };
        const { session } = (current = rig({ protocol: 'v2', clientMeta: meta })).start('capabilities');
        const events = await collect(session);

        await session.close();

        expect(JSON.parse(textOf(events))).toEqual({ _meta: meta });
    });
});

describe('an agent that is asked for v2 and speaks v1', () => {
    let warn: ReturnType<typeof spyOn>;

    // Each restart says so in the log; a test does not need it on the screen.
    beforeEach(() => {
        warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    /** The agent is the v1 fake, set to v2: it answers `initialize` with version 1, or (FAKE_ACP_REFUSE_V2) with an error. */
    const v1Agent = (agentEnv: Record<string, string> = {}) =>
        (current = rig({ protocol: 'v2', args: [FAKE_AGENT], agentEnv }));
    const processes = (events: EngineEvent[]) => events.filter(event => event.type === 'process');

    test('is stopped and started again on v1, with the first attempt telling the runtime nothing but its process', async () => {
        const { session } = v1Agent().start('say hello world');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'process', 'session', 'text', 'text', 'text', 'done']);
        expect(textOf(events)).toBe('hello world');

        const [first, second] = processes(events);

        expect(first.type === 'process' && second.type === 'process' && first.pid !== second.pid).toBe(true);
        // The first process is gone before the second one is told about.
        await until(() => first.type === 'process' && !alive(first.pid), 'the first attempt to be gone');
    });

    test('is started again on v1 when it refuses the v2 handshake instead of answering 1', async () => {
        const { session } = v1Agent({ FAKE_ACP_REFUSE_V2: '1' }).start('say hello world');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'process', 'session', 'text', 'text', 'text', 'done']);
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('does not speak ACP v2 (Unsupported protocol version 2)')
        );
    });

    test('is remembered for the life of the engine: the next session starts it on v1 at once', async () => {
        const { start } = v1Agent();
        const first = start('say one');

        await collect(first.session);
        await first.session.close();

        const second = start('say two');
        const events = await collect(second.session);

        await second.session.close();

        expect(types(events)).toEqual(['process', 'session', 'text', 'text', 'text', 'done']);
        expect(textOf(events)).toBe('two');

        // Another daemon (another engine) knows nothing of it, and asks for v2 again.
        const other = rig({ protocol: 'v2', args: [FAKE_AGENT] });

        try {
            const again = other.start('say three');
            const seen = await collect(again.session);

            await again.session.close();
            expect(processes(seen)).toHaveLength(2);
        } finally {
            other.stop();
        }
    });

    test("has none of the first attempt's doings repeated: one live bridge token for the session, one title taken", async () => {
        const rigged = v1Agent({ FAKE_ACP_TITLES: '1' });
        const register = spyOn(rigged.bridge, 'register');
        const titles: string[] = [];
        const { session } = rigged.start('title Dark mode toggle\ncall task_list\nsay done', {
            tools: [tool('task_list', async () => 'ok')],
            title: { onTitle: title => titles.push(title) > 0 },
        });
        const events = await collect(session);
        // Each start of the process has a token of its own, since its environment carries the credential of the `clowdy` command.
        const [first, second] = register.mock.results.map(
            result => result.value as ReturnType<typeof rigged.bridge.register>
        );
        const status = async (access: typeof first) => {
            const env = Object.fromEntries((access.server?.env ?? []).map(({ name, value }) => [name, value]));

            return (
                await fetch(`${env.CLOWDY_BRIDGE_URL}/tools`, {
                    headers: { authorization: `Bearer ${env.CLOWDY_BRIDGE_TOKEN}` },
                })
            ).status;
        };

        expect(register).toHaveBeenCalledTimes(2);
        // The first attempt's token ended with its process; the session's calls went through the second one's.
        expect(await status(first)).toBe(401);
        expect(textOf(events)).toContain('result: ok');

        await session.close();

        expect(await status(second)).toBe(401);
        expect(events.at(-1)).toMatchObject({ type: 'done' });
        expect(titles).toEqual(['Dark mode toggle']);
    });

    test('is not mistaken for one that is slow to answer: silence is a failure, with no second attempt', async () => {
        const { session } = (current = rig({
            protocol: 'v2',
            command: '/bin/sh',
            args: ['-c', 'echo not an agent >&2; sleep 30'],
            initializeTimeoutMs: 400,
        })).start('say hi');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'error']);
        expect(events.at(-1)).toMatchObject({
            type: 'error',
            message: expect.stringMatching(/did not answer the ACP handshake.*not an agent/s),
        });
    });

    test('is not mistaken for one that crashed: a program that exits is a failure, with no second attempt', async () => {
        const { session } = (current = rig({
            protocol: 'v2',
            command: process.execPath,
            args: ['-e', 'process.exit(2)'],
        })).start('say hi');
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'error']);
        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'process_crashed' });
    });

    test('is not mistaken for one that wants a sign-in: asking for it at the handshake is a failure, with no second attempt', async () => {
        const answer =
            'process.stdin.on("data", (chunk) => { const request = JSON.parse(String(chunk).split("\\n")[0]); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Authentication required" } }) + "\\n"); });';
        const { session } = (current = rig({ protocol: 'v2', command: process.execPath, args: ['-e', answer] })).start(
            'say hi'
        );
        const events = await collect(session);

        await session.close();

        expect(types(events)).toEqual(['process', 'error']);
        expect(events.at(-1)).toMatchObject({ type: 'error', code: 'not_logged_in' });
    });

    test('is not started again when the run was cancelled meanwhile', async () => {
        const { session, abort } = v1Agent().start('say hi');
        const events: EngineEvent[] = [];

        for await (const event of session) {
            events.push(event);

            // The first attempt's process is announced before its handshake ends; the run is cancelled right then.
            if (event.type === 'process') {
                abort.abort();
            }
        }

        await session.close();

        expect(processes(events)).toHaveLength(1);
        expect(types(events)).not.toContain('session');
        expect(types(events)).not.toContain('error');
    });
});
