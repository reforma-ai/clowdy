import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { codexModel, MODEL_ROUTES, ModelCatalog, parseClaudeModels, parseCursorModels } from '../src/providers/models';
import { FAKE_AGENT } from './acp-helpers';
import { cleanTempDirs, Harness, testAgents, testConfig } from './helpers';

import type { AgentModels } from '@clowdy/protocol';
import type { AgentRegistry } from '../src/engine/acp/registry';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clowdy-models-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function program(name: string, body: string, shebang = '#!/bin/sh'): string {
    const path = join(root, name);

    writeFileSync(path, `${ shebang }\n${ body }\n`);
    chmodSync(path, 0o755);

    return path;
}

const response = (models: unknown[]) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'clowdy-models', response: { models } } });

describe('Claude Code models', () => {
    const rows = [
        { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
        { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
        { value: 'haiku-4', displayName: 'Haiku 4.5', resolvedModel: 'haiku-4' },
        { value: 'cc-update-required-1', displayName: 'Update', disabled: true },
        { displayName: 'No value' },
    ];

    test('takes the rows of the control response: the alias is the id, the versioned model is what it stands for', () => {
        expect(parseClaudeModels(`${ JSON.stringify({ type: 'system', subtype: 'init' }) }\n${ response(rows) }\n`)).toEqual([
            { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', isDefault: true, resolvedId: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true },
            { id: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5', efforts: ['low', 'high'], supportsFast: true },
            { id: 'haiku-4', name: 'Haiku 4.5' },
        ]);
    });

    test('has none when the program answered with an error or with nothing', () => {
        expect(parseClaudeModels(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Unsupported control request' } }))).toBeUndefined();
        expect(parseClaudeModels('')).toBeUndefined();
        expect(parseClaudeModels(response([]))).toEqual([]);
    });

    test('is read from the program with the request on its standard input', async () => {
        const claude = program('claude', `read line; case "$line" in *list_models*) echo '${ response(rows.slice(0, 2)) }';; *) echo '{"type":"result"}';; esac`);
        const catalog = new ModelCatalog({ registry: registryOf({ claude }), cwd: root });
        const models = await catalog.get('claude');

        expect(models).toMatchObject({ state: 'ok', models: [{ id: 'default' }, { id: 'opus' }] });
        expect(models.fetchedAt).toBeGreaterThan(0);
    });
});

describe('Codex models', () => {
    test('maps a row of model/list: the efforts are the agent\'s own words, a priority tier is the fast mode, a hidden row is left out', () => {
        expect(codexModel({ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', displayName: 'GPT-6.2-Sol', description: 'Frontier', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }], serviceTiers: [{ id: 'priority' }] }))
            .toEqual({ id: 'gpt-6.2-sol', name: 'GPT-6.2-Sol', description: 'Frontier', isDefault: true, efforts: ['low', 'ultra'], defaultEffort: 'low', supportsFast: true });
        expect(codexModel({ id: 'old', hidden: true })).toBeUndefined();
        expect(codexModel({ model: 'slug-only' })).toEqual({ id: 'slug-only', name: 'slug-only' });
    });

    test('is read from `codex app-server`, page after page', async () => {
        const codex = program('codex', `
            const rl = require('node:readline').createInterface({ input: process.stdin });
            const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
            rl.on('line', (line) => {
                const message = JSON.parse(line);
                if (message.method === 'initialize') send({ id: message.id, result: {} });
                else if (message.method === 'model/list') {
                    const second = message.params && message.params.cursor === 'next';
                    send({ id: message.id, result: second
                        ? { data: [{ id: 'gpt-b', displayName: 'B', hidden: true }, { id: 'gpt-c', displayName: 'C' }], nextCursor: null }
                        : { data: [{ id: 'gpt-a', displayName: 'A', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }], nextCursor: 'next' } });
                }
            });
        `, `#!${ process.execPath }`);
        const models = await new ModelCatalog({ registry: registryOf({ codex }), cwd: root }).get('codex');

        expect(models).toMatchObject({ state: 'ok', models: [{ id: 'gpt-a', isDefault: true, efforts: ['high'] }, { id: 'gpt-c' }] });
        expect(models.models).toHaveLength(2);
    });

    test('says why when the program does not answer', async () => {
        const codex = program('codex', 'echo boom >&2; exit 2');
        const models = await new ModelCatalog({ registry: registryOf({ codex }), cwd: root }).get('codex');

        expect(models).toMatchObject({ state: 'error', detail: expect.stringContaining('boom') });
    });
});

describe('Cursor models', () => {
    const listing = 'Available models\n\nauto - Auto (current, default)\ngpt-5.3-codex-low - Codex 5.3 Low\nclaude-opus-5-thinking-high - Claude Opus 5 (1M) Thinking High\n\nTip: use --model <id> to switch.\n';

    test('takes the `id - Name` lines, drops the markers from the name and notes the default', () => {
        expect(parseCursorModels(listing)).toEqual([
            { id: 'auto', name: 'Auto', isDefault: true },
            { id: 'gpt-5.3-codex-low', name: 'Codex 5.3 Low' },
            { id: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 (1M) Thinking High' },
        ]);
        expect(parseCursorModels('Not signed in\n')).toEqual([]);
    });

    test('is read with --list-models, and a program that prints no models is an error with its first line', async () => {
        const cursor = program('cursor-agent', `echo '${ listing.replaceAll('\n', '\\n') }' | sed 's/\\\\n/\\n/g'`);
        const listed = await new ModelCatalog({ registry: registryOf({ cursor }), cwd: root }).get('cursor');

        expect(listed).toMatchObject({ state: 'ok', models: [{ id: 'auto' }, { id: 'gpt-5.3-codex-low' }, { id: 'claude-opus-5-thinking-high' }] });

        const out = program('cursor-out', 'echo "Not logged in. Run cursor-agent login"; exit 1');
        const none = await new ModelCatalog({ registry: registryOf({ cursor: out }), cwd: root }).get('cursor');

        expect(none).toMatchObject({ state: 'error', detail: 'Not logged in. Run cursor-agent login' });
    });
});

describe('ModelCatalog', () => {
    test('keeps a list for ten minutes, does not keep a failure, and starts one read for callers that ask together', async () => {
        let calls = 0;
        let time = 1_000;
        const answers: AgentModels[] = [{ state: 'error', models: [], detail: 'offline' }, { state: 'ok', models: [{ id: 'a', name: 'A' }], fetchedAt: 1 }];
        const catalog = new ModelCatalog({
            registry: registryOf({ claude: '/bin/claude' }),
            now: () => time,
            routes: { claude: async () => {
                await new Promise(resolve => setTimeout(resolve, 20)); return answers[Math.min(calls++, 1)]!;
            } },
        });

        expect((await Promise.all([catalog.get('claude'), catalog.get('claude')])).map(answer => answer.state)).toEqual(['error', 'error']);
        expect(calls).toBe(1);
        expect((await catalog.get('claude')).state).toBe('ok');
        expect(calls).toBe(2);

        time += 9 * 60_000;
        await catalog.get('claude');

        expect(calls).toBe(2);

        time += 2 * 60_000;
        await catalog.get('claude');

        expect(calls).toBe(3);

        catalog.forget('claude');
        await catalog.get('claude');

        expect(calls).toBe(4);
    });

    test('stop fires the signal its reads carry, so the programs of a read under way end with the daemon', async () => {
        let signal: AbortSignal | undefined;
        const catalog = new ModelCatalog({
            registry: registryOf({ claude: '/bin/claude' }),
            routes: { claude: async (context) => {
                signal = context.signal;

                return { state: 'ok', models: [], fetchedAt: 1 };
            } },
        });

        await catalog.get('claude');

        expect(signal?.aborted).toBe(false);

        catalog.stop();

        expect(signal?.aborted).toBe(true);
    });

    test('answers an error, and asks again next time, when even finding the program fails', async () => {
        let asked = 0;
        const registry = { probeTarget: async () => {
            asked++;

            throw new Error('no search path');
        }, nameOf: () => 'Claude Code' } as unknown as AgentRegistry;
        const catalog = new ModelCatalog({ registry });

        expect(await catalog.get('claude')).toMatchObject({ state: 'error', detail: 'no search path' });
        expect(await catalog.get('claude')).toMatchObject({ state: 'error' });
        expect(asked).toBe(2);
    });

    test('is unavailable for an agent it has no way to read or that is not installed', async () => {
        const catalog = new ModelCatalog({ registry: registryOf({}) });

        expect(await catalog.get('opencode')).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('cannot list the models') });
        expect(await catalog.get('claude')).toMatchObject({ state: 'unavailable', detail: expect.stringContaining('not installed') });
        expect(Object.keys(MODEL_ROUTES)).toEqual(['claude', 'codex', 'cursor']);
    });
});

describe('GET /v1/agents/:id/models', () => {
    afterEachClean();

    test('answers with the list of an agent, 404 for one that does not exist, and needs the token', async () => {
        const config = testConfig();
        const agents = testAgents(config);
        const models = new ModelCatalog({ registry: agents, routes: { mine: async () => ({ state: 'ok', models: [{ id: 'm1', name: 'Model one', isDefault: true }], fetchedAt: 5 }) } });
        const h = new Harness(await startDaemon(config, { agents, models }), config);

        harnesses.push(h);
        h.ok('agent.add', { id: 'mine', name: 'Mine', command: process.execPath, args: [FAKE_AGENT] });

        expect(await (await h.fetch('/v1/agents/mine/models')).json()).toEqual({ state: 'ok', models: [{ id: 'm1', name: 'Model one', isDefault: true }], fetchedAt: 5 });
        expect((await h.fetch('/v1/agents/nobody/models')).status).toBe(404);
        expect((await fetch(`${ h.url }/v1/agents/mine/models`)).status).toBe(401);
    });
});

/* ------------------------------------ helpers ----------------------------------- */

const harnesses: Harness[] = [];

function afterEachClean() {
    afterEach(async () => {
        await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
        cleanTempDirs();
    });
}

/** A registry that knows the programs by agent id; an id without one is not installed. */
function registryOf(programs: Record<string, string>): AgentRegistry {
    return {
        probeTarget: async (id: string) => programs[id] ? { program: programs[id], env: { PATH: process.env.PATH ?? '' } } : undefined,
        nameOf: (id: string) => id === 'claude' ? 'Claude Code' : id === 'opencode' ? 'OpenCode' : id,
    } as unknown as AgentRegistry;
}
