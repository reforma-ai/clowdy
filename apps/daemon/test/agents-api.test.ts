import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { KNOWN_AGENTS } from '../src/engine/acp/catalog';
import { announceAgentsChanged } from '../src/providers/announce';
import { ProvidersService } from '../src/providers/service';
import { FAKE_AGENT } from './acp-helpers';
import { cleanTempDirs, Harness, restartHarness, startHarness, testAgents, testConfig, waitFor } from './helpers';

import type { AgentInfo } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];
const codexLaunch = KNOWN_AGENTS.find(agent => agent.id === 'codex')?.launch;
const codexPackage = codexLaunch?.kind === 'package' ? codexLaunch.package : undefined;

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup() {
    const h = await startHarness();

    harnesses.push(h);

    const project = h.openRepo();
    const list = async (): Promise<AgentInfo[]> => await (await h.fetch('/v1/agents')).json() as AgentInfo[];
    const add = (id = 'mine') => h.ok('agent.add', { id, name: 'My agent', command: process.execPath, args: [FAKE_AGENT] });

    return { h, project, list, add };
}

describe('GET /v1/agents', () => {
    test('lists the built-in agents with what is found on this machine, and needs the token', async () => {
        const { h, list } = await setup();
        const agents = await list();

        expect(agents.map(agent => agent.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'gemini', 'copilot', 'grok', 'omp', 'hermes']);
        // The test daemon finds nothing on this machine, so every built-in agent is missing whatever is installed here.
        expect(agents.every(agent => !agent.custom && agent.enabled && agent.launch !== '' && agent.status === 'missing' && agent.detail !== undefined)).toBe(true);
        expect(agents.find(agent => agent.id === 'claude')).toMatchObject({ name: 'Claude Code', login: 'claude auth login' });
        expect(agents.find(agent => agent.id === 'codex')?.fetches).toBe(codexPackage);
        expect((await fetch(`${ h.url }/v1/agents`)).status).toBe(401);
    });
});

describe('agent commands', () => {
    test('an added agent is listed, switched off and on, and removed, and the clients hear about each change', async () => {
        const { h, project, list, add } = await setup();
        const before = h.events().length;

        expect(add()).toEqual({ id: 'mine' });
        expect((await list()).find(agent => agent.id === 'mine')).toMatchObject({ custom: true, status: 'ready', launch: `${ process.execPath } ${ FAKE_AGENT }` });

        h.ok('agent.update', { id: 'mine', enabled: false });
        expect((await list()).find(agent => agent.id === 'mine')).toMatchObject({ status: 'disabled', enabled: false });

        h.ok('agent.update', { id: 'mine', enabled: true, name: 'Renamed' });
        expect((await list()).find(agent => agent.id === 'mine')).toMatchObject({ status: 'ready', name: 'Renamed' });

        h.ok('agent.remove', { id: 'mine' });
        expect((await list()).some(agent => agent.id === 'mine')).toBe(false);

        const changed = h.events(before).filter(event => event.data.type === 'agents.changed');

        // Every project hears each change: the personal space and the one this test opened.
        expect(changed).toHaveLength(8);
        expect(changed.filter(event => event.projectId === project.id)).toHaveLength(4);
        expect(changed.filter(event => event.projectId === h.personal.id)).toHaveLength(4);
    });

    test('a path the user chose replaces the search, and null goes back to searching', async () => {
        const { h, list } = await setup();

        h.ok('agent.update', { id: 'opencode', path: '/nonexistent/opencode' });
        expect((await list()).find(agent => agent.id === 'opencode')).toMatchObject({ status: 'missing' });

        h.ok('agent.update', { id: 'opencode', path: process.execPath });
        expect((await list()).find(agent => agent.id === 'opencode')).toMatchObject({ status: 'ready', path: process.execPath });

        h.ok('agent.update', { id: 'opencode', path: null });
        expect((await list()).find(agent => agent.id === 'opencode')?.path).not.toBe(process.execPath);
    });

    test('changing one setting of an agent leaves its other settings alone', async () => {
        const { h, list } = await setup();

        h.ok('agent.update', { id: 'opencode', enabled: false });
        h.ok('agent.update', { id: 'opencode', path: process.execPath });

        expect((await list()).find(agent => agent.id === 'opencode')).toMatchObject({ status: 'disabled', enabled: false, path: process.execPath });
    });

    test('refusals are command errors: a bad id, a clash, an unknown agent, a built-in one removed', async () => {
        const { h, add } = await setup();

        add();

        const code = (type: string, fields: Record<string, unknown>) => {
            const result = h.send(type as 'agent.add', fields);

            return result.ok ? 'ok' : result.error.code;
        };

        expect(code('agent.add', { id: 'Bad Id', name: 'x', command: 'x' })).toBe('invalid');
        expect(code('agent.add', { id: 'mine', name: 'x', command: 'x' })).toBe('conflict');
        expect(code('agent.add', { id: 'claude', name: 'x', command: 'x' })).toBe('conflict');
        expect(code('agent.update', { id: 'nobody', enabled: false })).toBe('not_found');
        expect(code('agent.remove', { id: 'nobody' })).toBe('not_found');
        expect(code('agent.remove', { id: 'claude' })).toBe('invalid');
        expect(code('agent.add', { id: 'rel', name: 'x', command: './agent' })).toBe('invalid');
        expect(code('agent.update', { id: 'opencode', path: 'bin/opencode' })).toBe('invalid');
    });

    test('an agent added at run time runs a chat without restarting the daemon', async () => {
        const { h, project, add } = await setup();

        add();
        h.ok('project.update', { projectId: project.id, settings: { engine: 'mine' } });

        const { chat } = h.ok('chat.create', { projectId: project.id });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'say it works' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run on the added agent', 15_000);

        expect(h.run(runId)).toMatchObject({ engine: 'mine', result: 'it works' });
    });

    test('the agents survive a restart', async () => {
        const { h, add } = await setup();

        add();
        h.ok('agent.update', { id: 'cursor', enabled: false });

        await h.stop();

        const again = await restartHarness(h);

        harnesses.push(again);

        const agents = await (await again.fetch('/v1/agents')).json() as AgentInfo[];

        expect(agents.find(agent => agent.id === 'mine')).toMatchObject({ custom: true });
        expect(agents.find(agent => agent.id === 'cursor')).toMatchObject({ status: 'disabled' });
    });
});

describe('accounts, usage and sign-in over the API', () => {
    /** A daemon whose agent `mine` has a reader: signed out until its login program has run, then signed in with usage. */
    async function withReader() {
        const config = testConfig();
        const agents = testAgents(config);
        const login = join(config.dataDir, 'login.ts');
        const marker = join(config.dataDir, 'signed-in');

        mkdirSync(config.dataDir, { recursive: true });
        writeFileSync(login, `console.log('Open https://example.com/login?x=1'); await Bun.write(${ JSON.stringify(marker) }, '1');`);

        // The announce of the real daemon, once it exists: background reads and login output announce from outside any transaction.
        let announce = () => {};
        const providers = new ProvidersService({
            registry: agents,
            announce: () => announce(),
            cwd: config.dataDir,
            providers: [{
                id: 'mine',
                login: { args: [login] },
                read: async () => await Bun.file(marker).exists()
                    ? { signIn: { status: 'signed-in', account: { email: 'ada@example.com', plan: 'Max', method: 'subscription' } }, usage: { state: 'ok', windows: [{ id: 'session', label: 'Session', usedPercent: 8 }], fetchedAt: 1 } }
                    : { signIn: { status: 'signed-out' }, usage: { state: 'unavailable', windows: [] } },
            }],
        });
        const h = new Harness(await startDaemon(config, { agents, providers }), config);

        announce = () => announceAgentsChanged(h.store);
        harnesses.push(h);
        h.openRepo();
        h.ok('agent.add', { id: 'mine', name: 'My agent', command: process.execPath, args: [FAKE_AGENT] });

        return { h, list: async (): Promise<AgentInfo[]> => (await (await h.fetch('/v1/agents')).json() as AgentInfo[]).filter(agent => agent.id === 'mine') };
    }

    /** Asks again until the answer is what the test waits for: the reads happen in the background. */
    async function until(check: () => Promise<boolean>) {
        for (let i = 0; i < 150 && !await check(); i++) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }

    test('lists the account and usage of an agent that has a reader, and runs its login on request', async () => {
        const { h, list } = await withReader();
        const changes = () => h.events().filter(event => event.data.type === 'agents.changed').length;

        expect((await list())[0]).toMatchObject({ canSignIn: true });
        await until(async () => (await list())[0]?.signIn?.status === 'signed-out');

        // The first read told the clients, though it ran from a timer and not from a command.
        expect(changes()).toBeGreaterThan(1);

        const before = changes();

        expect(h.ok('agent.signIn', { id: 'mine' })).toEqual({ id: 'mine' });
        await until(async () => (await list())[0]?.signInSession?.step === 'done');
        await until(async () => (await list())[0]?.signIn?.status === 'signed-in');

        // The link, the end of the login and the new account each reached the clients.
        expect(changes() - before).toBeGreaterThanOrEqual(3);
        expect((await list())[0]).toMatchObject({
            signInSession: { step: 'done', url: 'https://example.com/login?x=1' },
            signIn: { status: 'signed-in', account: { email: 'ada@example.com', plan: 'Max' } },
            usage: { state: 'ok', windows: [{ id: 'session', label: 'Session', usedPercent: 8 }] },
        });
    });

    test('refuses a sign-in to an agent without a login to run, and answers a cancel with nothing to cancel', async () => {
        const { h } = await withReader();
        const refused = h.send('agent.signIn', { id: 'claude' });

        expect(refused).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(h.ok('agent.cancelSignIn', { id: 'mine' })).toEqual({ id: 'mine' });
    });
});
