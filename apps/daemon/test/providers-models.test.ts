import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { claudeModelsError, codexModel, cursorModels, MODEL_ROUTES, ModelCatalog, parseClaudeModels, parseCursorFamilies, parseCursorModels } from '../src/providers/models';
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

    test('takes the rows of the control response: the alias is the id and a main model, the versioned model is what it stands for', () => {
        expect(parseClaudeModels(`${ JSON.stringify({ type: 'system', subtype: 'init' }) }\n${ response(rows) }\n`)).toEqual([
            { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5', isDefault: true, resolvedId: 'claude-opus-5-5', featured: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFast: true },
            { id: 'opus', name: 'Opus 5.5', resolvedId: 'claude-opus-5-5', featured: true, efforts: ['low', 'high'], supportsFast: true },
            { id: 'haiku-4', name: 'Haiku 4.5' },
        ]);
    });

    test('has none when the program answered with an error or with nothing', () => {
        expect(parseClaudeModels(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Unsupported control request' } }))).toBeUndefined();
        expect(parseClaudeModels('')).toBeUndefined();
        expect(parseClaudeModels(response([]))).toEqual([]);
    });

    test('reads the error the program answered with, and nothing from an answer that is not one', () => {
        expect(claudeModelsError(`${ JSON.stringify({ type: 'system' }) }\n${ JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Unsupported control request subtype: list_models' } }) }`)).toBe('Unsupported control request subtype: list_models');
        expect(claudeModelsError(response(rows))).toBeUndefined();
        expect(claudeModelsError(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: '  ' } }))).toBeUndefined();
        expect(claudeModelsError('not json\n')).toBeUndefined();
    });

    test('says which program is too old when it does not know the request, as an old Claude Code answers it', async () => {
        const claude = program('claude', `read line; echo '${ JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'clowdy-models', error: 'Unsupported control request subtype: list_models' } }) }'`);
        const models = await new ModelCatalog({ registry: registryOf({ claude }), cwd: root }).get('claude');

        expect(models).toEqual({ state: 'error', models: [], detail: `Claude Code at ${ claude } is too old to list its models. Update it, then try again` });
    });

    test('gives the program\'s own words for any other failure, and says so when it listed nothing', async () => {
        const refusing = program('claude-refusing', `read line; echo '${ JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Not logged in' } }) }'`);
        const failing = program('claude-failing', 'read line; echo "Error: the settings file is damaged" >&2; exit 1');
        const empty = program('claude-empty', `read line; echo '${ response([]) }'`);
        const catalog = (claude: string) => new ModelCatalog({ registry: registryOf({ claude }), cwd: root }).get('claude');

        expect((await catalog(refusing)).detail).toBe('Claude Code could not list its models: Not logged in');
        expect((await catalog(failing)).detail).toBe('Claude Code could not list its models: Error: the settings file is damaged');
        expect((await catalog(empty)).detail).toBe('Claude Code listed no models');
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

    const option = (id: string, category: string, currentValue: string, values: string[]) => ({ id, name: id, category, type: 'select', currentValue, options: values.map(value => ({ value, name: value })) });
    const families = {
        models: [
            { value: 'default', name: 'Auto', configOptions: [] },
            { value: 'grok-4.7', name: 'Grok 4.7', configOptions: [option('reasoning_effort', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh']), option('context', 'model_config', '256k', ['256k', '500k']), option('fast', 'model_config', 'true', ['false', 'true'])] },
            { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [option('fast', 'model_config', 'true', ['false', 'true'])] },
            { value: 'claude-opus-4-8', name: 'Claude Opus 4.8', configOptions: [option('thinking', 'thought_level', 'true', ['false', 'true']), option('effort', 'thought_level', 'high', ['low', 'medium', 'high', 'xhigh', 'max'])] },
            { value: 'claude-sonnet-4', name: 'Claude Sonnet 4', configOptions: [option('thinking', 'thought_level', 'false', ['false', 'true'])] },
            { value: 'gpt-5.5', name: 'GPT-5.5', configOptions: [option('reasoning', 'thought_level', 'medium', ['none', 'low', 'medium', 'high', 'extra-high'])] },
            { name: 'no value' },
        ],
    };

    test('takes the families in Cursor\'s own order and the effort among their options by what it offers', () => {
        expect(parseCursorFamilies(families)).toEqual([
            { id: 'default', name: 'Auto', isDefault: true },
            { id: 'grok-4.7', name: 'Grok 4.7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', supportsFast: true },
            { id: 'composer-2.5', name: 'Composer 2.5', supportsFast: true },
            // `thinking` is a switch, not a level, wherever it stands among the options.
            { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
            { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['none', 'low', 'medium', 'high', 'extra-high'], defaultEffort: 'medium' },
        ]);
        expect(parseCursorFamilies(undefined)).toEqual([]);
        expect(parseCursorFamilies({ models: 'x' })).toEqual([]);
    });

    test('is read over ACP from `cursor-agent acp`, and an older Cursor that does not answer falls back to --list-models', async () => {
        const acp = program('cursor-agent', `
            const rl = require('node:readline').createInterface({ input: process.stdin });
            const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
            if (!process.argv.includes('acp')) { console.log('Available models\\n\\nauto - Auto (current, default)'); process.exit(0); }
            rl.on('line', (line) => {
                const message = JSON.parse(line);
                if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
                else if (message.method === 'cursor/list_available_models') send({ jsonrpc: '2.0', id: message.id, result: ${ JSON.stringify(families) } });
            });
        `, `#!${ process.execPath }`);
        const listed = await new ModelCatalog({ registry: registryOf({ cursor: acp }), cwd: root }).get('cursor');

        expect(listed.state).toBe('ok');
        expect(listed.models.map(model => model.id)).toEqual(['default', 'grok-4.7', 'composer-2.5', 'claude-opus-4-8', 'claude-sonnet-4', 'gpt-5.5']);

        // A program that ends at once on `acp` (an older Cursor) is read with --list-models instead.
        const old = program('cursor-old', 'if [ "$1" = "acp" ]; then exit 1; fi; printf "Available models\\n\\nauto - Auto (current, default)\\n"');
        const fallback = await new ModelCatalog({ registry: registryOf({ cursor: old }), cwd: root }).get('cursor');

        expect(fallback).toMatchObject({ state: 'ok', models: [{ id: 'auto', name: 'Auto', isDefault: true }] });
    });

    /**
     * A `cursor-agent` that speaks ACP in JavaScript: `onLine(message)` runs for each request of the client (`send` answers, `note` leaves a line
     * in the returned file); `--list-models` (no `acp` argument) prints one model and leaves the note `list-models`.
     */
    function cursorAgent(onLine: string): { path: string; notes: () => string[] } {
        const notes = join(root, 'notes.txt');
        const path = program('cursor-agent', `
            const fs = require('node:fs');
            const note = (text) => fs.appendFileSync(${ JSON.stringify(notes) }, text + '\\n');
            const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
            if (!process.argv.includes('acp')) { note('list-models'); console.log('Available models\\n\\nauto - Auto (current, default)'); process.exit(0); }
            note('acp');
            let listing;
            require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
                const message = JSON.parse(line);
                ${ onLine }
            });
        `, `#!${ process.execPath }`);

        return { path, notes: () => existsSync(notes) ? readFileSync(notes, 'utf8').split('\n').filter(Boolean) : [] };
    }

    const initialized = 'if (message.method === \'initialize\') send({ id: message.id, result: { protocolVersion: 1 } });';

    test('a request of Cursor, even one that reuses the id of a call, is refused and does not stand for the answer', async () => {
        const cursor = cursorAgent(`
            ${ initialized }
            else if (message.method === 'cursor/list_available_models') {
                listing = message.id;
                send({ id: message.id, method: 'session/request_permission', params: {} });
            }
            // Cursor goes on only once its request was answered (it would wait for a permission for ever).
            else if (message.error) {
                note('refused ' + message.error.code);
                send({ id: listing, result: ${ JSON.stringify(families) } });
            }
        `);
        const listed = await new ModelCatalog({ registry: registryOf({ cursor: cursor.path }), cwd: root, routes: { cursor: context => cursorModels(context, 2_000) } }).get('cursor');

        // Taken for the answer, the request would have given an empty list and sent the read to --list-models.
        expect(listed.models.map(model => model.id)).toEqual(['default', 'grok-4.7', 'composer-2.5', 'claude-opus-4-8', 'claude-sonnet-4', 'gpt-5.5']);
        expect(cursor.notes()).toEqual(['acp', 'refused -32601']);
    });

    test('a Cursor that is signed out is told so once, not asked a second time through --list-models, and is asked again next time', async () => {
        const cursor = cursorAgent(`
            ${ initialized }
            else if (message.method === 'cursor/list_available_models') send({ id: message.id, error: { code: -32000, message: "Authentication required. Please run 'cursor-agent login' first" } });
        `);
        const catalog = new ModelCatalog({ registry: registryOf({ cursor: cursor.path }), cwd: root });
        const first = await catalog.get('cursor');

        expect(first).toEqual({ state: 'error', models: [], detail: 'Cursor is not signed in. Sign in on the Providers page, then try again.' });
        expect(cursor.notes()).toEqual(['acp']);

        // A failed read is not kept for ten minutes: signing in and asking again works.
        await catalog.get('cursor');

        expect(cursor.notes()).toEqual(['acp', 'acp']);
    });

    test('a Cursor that does not answer in time ends the read at that deadline, without a second wait on --list-models', async () => {
        const cursor = cursorAgent('/* never answers */');
        const started = Date.now();
        const listed = await new ModelCatalog({ registry: registryOf({ cursor: cursor.path }), cwd: root, routes: { cursor: context => cursorModels(context, 400) } }).get('cursor');

        expect(listed).toEqual({ state: 'error', models: [], detail: 'Cursor did not list its models in time' });
        expect(cursor.notes()).not.toContain('list-models');
        expect(Date.now() - started).toBeLessThan(3_000);
    });

    test('a Cursor that refuses the method, or lists nothing, is read with --list-models', async () => {
        const unknown = cursorAgent(`
            ${ initialized }
            else if (message.method === 'cursor/list_available_models') send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
        `);

        expect(await new ModelCatalog({ registry: registryOf({ cursor: unknown.path }), cwd: root }).get('cursor')).toMatchObject({ state: 'ok', models: [{ id: 'auto' }] });
        expect(unknown.notes()).toEqual(['acp', 'list-models']);

        const empty = cursorAgent(`
            ${ initialized }
            else if (message.method === 'cursor/list_available_models') send({ id: message.id, result: { models: [] } });
        `);

        expect(await new ModelCatalog({ registry: registryOf({ cursor: empty.path }), cwd: root }).get('cursor')).toMatchObject({ state: 'ok', models: [{ id: 'auto' }] });
    });

    test('an odd answer is read for what is in it and never thrown over: no records, repeated ids, grouped or empty options, values that are not text', () => {
        const group = (...values: string[]) => ({ group: 'g', name: 'G', options: values.map(value => ({ value, name: value })) });
        const odd = {
            models: [
                null, 'text', 7, [], { value: 5, name: 'a number' }, { name: 'no value' },
                { value: 'a', name: 'First', configOptions: [null, 'x', 1, { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [null, { value: 'low' }, { value: 'low' }, { value: 3 }, group('high', 'max')] }] },
                // The same family twice: the first stays.
                { value: 'a', name: 'Second', configOptions: [] },
                // A level option with nothing in it does not hide the one that has levels, and a switch is not a level.
                { value: 'b', configOptions: [{ category: 'thought_level', type: 'select', options: [] }, { category: 'thought_level', type: 'select', options: [{ value: 'false' }, { value: 'true' }] }, { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'zzz', options: [{ value: 'low' }, { value: 'high' }] }] },
                // Options that are not a list, or not a select.
                { value: 'c', name: 'C', configOptions: { id: 'effort' } },
                { value: 'd', name: 'D', configOptions: [{ id: 'effort', category: 'thought_level', type: 'text', options: [{ value: 'low' }] }, { id: 'effort', category: 'thought_level', type: 'select', options: 'low' }] },
            ],
        };

        expect(parseCursorFamilies(odd)).toEqual([
            { id: 'a', name: 'First', efforts: ['low', 'high', 'max'], defaultEffort: 'low' },
            // `zzz` is not one of its levels, so there is no default level to claim.
            { id: 'b', name: 'b', efforts: ['low', 'high'] },
            { id: 'c', name: 'C' },
            { id: 'd', name: 'D' },
        ]);
        expect(parseCursorFamilies(null)).toEqual([]);
        expect(parseCursorFamilies({ models: { value: 'a' } })).toEqual([]);
    });

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
