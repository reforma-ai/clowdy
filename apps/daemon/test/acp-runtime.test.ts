import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { listItems } from '../src/db/items';
import { FAKE_AGENT } from './acp-helpers';
import { cleanTempDirs, Harness, testAgents, testConfig, waitFor } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A whole daemon whose only real engine is the fake ACP agent, added the way a user adds a custom agent. */
async function setup(agentEnv: Record<string, string> = {}) {
    const config = testConfig({ engine: 'fake-acp' });

    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(join(config.dataDir, 'agents.json'), JSON.stringify({ agents: [{ id: 'fake-acp', name: 'Fake ACP', command: process.execPath, args: [FAKE_AGENT], env: agentEnv }], overrides: {} }));

    const h = new Harness(await startDaemon(config, { agents: testAgents(config) }), config);

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const say = (text: string): string => h.ok('chat.send', { chatId: chat.id, text }).runId;
    const texts = (runId: string) => listItems(h.store.db, runId, 0).flatMap(item => item.body.kind === 'assistant' ? [item.body.text] : []);

    return { h, project, chat, say, texts };
}

describe('runs on an ACP agent, through the real runtime', () => {
    test('a chat turn streams the agent\'s message into the stream and succeeds, and its session is kept for the next turn', async () => {
        const { h, say, texts } = await setup();
        const runId = say('say hello from acp');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn', 15_000);

        expect(h.run(runId)).toMatchObject({ engine: 'fake-acp', sessionId: 'fake-1', result: 'hello from acp' });
        // The first line of the message the run starts from is not a directive, so the fake agent acknowledges it.
        expect(texts(runId)).toEqual(['ok', 'hello from acp']);
        // The record of the process goes once the session has closed, a moment after the run succeeds.
        await waitFor(() => (h.store.db.query('SELECT pid FROM runs WHERE id = ?').get(runId) as { pid: number | null }).pid === null, 'the process record to be cleared', 15_000);

        say('info');
        await waitFor(() => texts(runId).length === 3, 'the second turn', 15_000);

        expect(JSON.parse(texts(runId)[2])).toMatchObject({ servers: ['clowdy'], model: 'fast' });
        expect(h.run(runId).sessionId).toBe('fake-1');
    });

    test('the window\'s fill the agent reports is left on the run, the last reading of the turn included', async () => {
        const { h, say } = await setup();
        const runId = say('context 40000 200000\ncontext 40100 200000');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);
        expect(h.run(runId).context).toEqual({ used: 40_100, size: 200_000 });
    });

    test('the agent calls the runtime\'s own tools through the bridge', async () => {
        const { h, project, say, texts } = await setup();
        const task = h.ok('task.create', { projectId: project.id, title: 'Fix the footer' }).task;
        const runId = say(`call task_get {"taskId":"${ task.key }"}`);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        const answer = texts(runId).join('\n');

        expect(answer).toContain('result: ');
        expect(answer).toContain('Fix the footer');

        const tools = listItems(h.store.db, runId, 0).flatMap(item => item.body.kind === 'tool' ? [[item.body.name, item.body.state]] : []);

        expect(tools).toEqual([['task_get', 'done']]);
    });

    test('the system skill of the role is in the system prompt the agent gets', async () => {
        const { h, say, texts } = await setup();
        const runId = say('info');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        const { systemPrompt } = JSON.parse(texts(runId)[1]) as { systemPrompt: string };

        expect(systemPrompt).toContain('You are the orchestrator of a Clowdy chat.');
        expect(systemPrompt).toContain('<skill name="clowdy:orchestrate">');
        expect(systemPrompt).toContain('/skills/<name>/SKILL.md');
    });

    test('cancelling a run stops the agent and leaves no process behind', async () => {
        const { h, say } = await setup();
        const runId = say('sleep 60000');
        const pid = await waitFor(() => (h.store.db.query('SELECT pid FROM runs WHERE id = ?').get(runId) as { pid: number | null }).pid, 'the agent to start', 15_000);

        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to be cancelled', 15_000);
        await waitFor(() => {
            try {
                process.kill(pid, 0);

                return false;
            }
            catch {
                return true;
            }
        }, 'the agent process to be gone', 15_000);
    });

    test('an agent that asks for a login fails the run with a message that says what to do', async () => {
        const { h, say } = await setup({ FAKE_ACP_AUTH: '1' });
        const runId = say('say hi');

        await waitFor(() => h.run(runId).status === 'failed', 'the run to fail', 15_000);

        expect(h.run(runId).error).toContain('Fake ACP is not signed in');
    });

    test('an agent that is not installed fails the run and says so', async () => {
        const config = testConfig({ engine: 'opencode' });

        mkdirSync(config.dataDir, { recursive: true });
        // Pointed at a program that is not there, so the test does not depend on what is installed on this machine.
        writeFileSync(join(config.dataDir, 'agents.json'), JSON.stringify({ agents: [], overrides: { opencode: { path: '/nonexistent/opencode' } } }));

        const h = new Harness(await startDaemon(config, { agents: testAgents(config) }), config);

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'hello' });

        await waitFor(() => h.run(runId).status === 'failed', 'the run to fail', 15_000);

        expect(h.run(runId).error).toBe('OpenCode is not installed: no `opencode` command was found. Install it, then try again');
    });

    test('a daemon told to use an agent it does not know refuses to start', async () => {
        await expect(startDaemon(testConfig({ engine: 'gpt' }))).rejects.toThrow(/CLOWDY_ENGINE=gpt is not an agent this daemon knows/);
    });
});
