import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { FAKE_AGENT } from './acp-helpers';
import { cleanTempDirs, Harness, restartHarness, startHarness, waitFor } from './helpers';

import type { AgentInfo } from '@clowdy/protocol';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

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
        expect(agents.find(agent => agent.id === 'codex')?.fetches).toBe('@agentclientprotocol/codex-acp@2.7.0');
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

        expect(changed).toHaveLength(4);
        expect(changed.every(event => event.projectId === project.id)).toBe(true);
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
