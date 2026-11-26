import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startDaemon } from '../src/daemon';
import { listItems } from '../src/db/items';
import { projectSnapshot } from '../src/domain/snapshots';
import { ToolBridge } from '../src/engine/acp/bridge';
import { AcpEngine } from '../src/engine/acp/engine';
import { alive, FAKE_AGENT, FAKE_AGENT_V2 } from './acp-helpers';
import { cleanTempDirs, Harness, testAgents, testConfig, waitFor } from './helpers';

import type { EngineRegistry } from '../src/engine/types';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A whole daemon whose only real engine is the fake ACP agent, added the way a user adds a custom agent. */
async function setup(agentEnv: Record<string, string> = {}, taskTools?: 'cli' | 'mcp') {
    const config = testConfig({ engine: 'fake-acp' });

    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(
        join(config.dataDir, 'agents.json'),
        JSON.stringify({
            agents: [
                {
                    id: 'fake-acp',
                    name: 'Fake ACP',
                    command: process.execPath,
                    args: [FAKE_AGENT],
                    env: agentEnv,
                    taskTools,
                },
            ],
            overrides: {},
        })
    );

    const h = new Harness(await startDaemon(config, { agents: testAgents(config) }), config);

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });
    const say = (text: string): string => h.ok('chat.send', { chatId: chat.id, text }).runId;
    const texts = (runId: string) =>
        listItems(h.store.db, runId, 0).flatMap(item => (item.body.kind === 'assistant' ? [item.body.text] : []));

    return { h, project, chat, say, texts };
}

describe('a message while an ACP agent works', () => {
    /** Starts a turn that says `first`, sleeps, and says `last`, and sends `say steered` as a steer once `first` is in the stream. */
    async function steerDuringTurn(agentEnv: Record<string, string>) {
        const { h, chat, say } = await setup(agentEnv);
        const runId = say('say first\nsleep 800\nsay last');
        const bodies = () => listItems(h.store.db, runId, 0).map(item => item.body);
        const said = () =>
            bodies().flatMap(body =>
                body.kind === 'assistant'
                    ? [body.text]
                    : body.kind === 'user'
                      ? [`> ${body.text.split('\n').at(-1)}`]
                      : []
            );

        await waitFor(() => said().includes('first'), 'the first words', 15_000);
        h.ok('chat.send', { chatId: chat.id, text: 'say steered', mode: 'steer' });

        return { h, runId, said };
    }

    test('steers the running prompt of an agent that can take one, and the bubble sits where the agent took it', async () => {
        const { h, runId, said } = await steerDuringTurn({ FAKE_ACP_STEERING: '1' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        expect(said()).toEqual(['> say last', 'ok', 'first', '> say steered', 'steered', 'last']);
    });

    test('waits for the next turn with an agent that cannot steer', async () => {
        const { h, runId, said } = await steerDuringTurn({});

        await waitFor(() => said().includes('steered') && h.run(runId).status === 'succeeded', 'the next turn', 15_000);

        expect(said()).toEqual(['> say last', 'ok', 'first', 'last', '> say steered', 'steered']);
    });
});

describe('an ACP agent on the preset that asks, through the real runtime', () => {
    const approvals = (h: Harness, runId: string) =>
        listItems(h.store.db, runId, 0).flatMap(item => (item.body.kind === 'approval' ? [item.body] : []));

    test('its permission request is a card in the stream, the run waits for the person, and their decision reaches the agent', async () => {
        const { h, say, texts } = await setup();

        h.ok('agent.update', { id: 'fake-acp', permission: 'ask' });

        const runId = say('perm execute {"title":"Run ls","rawInput":{"command":"ls -la"}}\nsay after');

        await waitFor(() => approvals(h, runId).length === 1, 'the approval', 15_000);

        expect(h.run(runId)).toMatchObject({ status: 'waiting_user', statusReason: 'Waiting for your approval' });
        expect(approvals(h, runId)[0]).toMatchObject({
            state: 'open',
            title: 'Run ls',
            subject: { kind: 'command', command: 'ls -la' },
            decisions: ['allow_once', 'allow_always', 'reject'],
        });

        h.ok('run.decide', { runId, approvalId: approvals(h, runId)[0]!.approvalId, decision: 'reject' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        expect(texts(runId)).toContain('permission: reject');
        expect(approvals(h, runId)[0]).toMatchObject({ state: 'decided', decision: 'reject' });
    });

    test('allowing for the rest of the run spares the same request in the next turn, which is another agent process', async () => {
        const { h, chat, say } = await setup();

        h.ok('agent.update', { id: 'fake-acp', permission: 'ask' });

        const runId = say('perm execute {"rawInput":{"command":"make"}}');

        await waitFor(() => approvals(h, runId).length === 1, 'the approval', 15_000);
        h.ok('run.decide', { runId, approvalId: approvals(h, runId)[0]!.approvalId, decision: 'allow_always' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn', 15_000);

        h.ok('chat.send', { chatId: chat.id, text: 'perm execute {"rawInput":{"command":"make"}}' });
        await waitFor(
            () =>
                listItems(h.store.db, runId, 0).filter(
                    item => item.body.kind === 'assistant' && item.body.text === 'permission: once'
                ).length === 2,
            'the answer without a card',
            15_000
        );

        expect(approvals(h, runId)).toHaveLength(1);
    });

    test('a Stop with a request waiting ends the run and marks the card cancelled', async () => {
        const { h, say } = await setup();

        h.ok('agent.update', { id: 'fake-acp', permission: 'ask' });

        const runId = say('perm');

        await waitFor(() => approvals(h, runId).length === 1, 'the approval', 15_000);
        h.ok('run.cancel', { runId });
        await waitFor(
            () => h.run(runId).status === 'cancelled' && approvals(h, runId)[0]?.state === 'cancelled',
            'the stop',
            15_000
        );

        expect(approvals(h, runId)[0]).not.toHaveProperty('decision');
    });
});

describe('runs on an ACP agent, through the real runtime', () => {
    test("a chat turn streams the agent's message into the stream and succeeds, and its session is kept for the next turn", async () => {
        const { h, say, texts } = await setup();
        const runId = say('say hello from acp');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn', 15_000);

        expect(h.run(runId)).toMatchObject({ engine: 'fake-acp', sessionId: 'fake-1', result: 'hello from acp' });
        // The first line of the message the run starts from is not a directive, so the fake agent acknowledges it.
        expect(texts(runId)).toEqual(['ok', 'hello from acp']);
        // The record of the process goes once the session has closed, a moment after the run succeeds.
        await waitFor(
            () =>
                (h.store.db.query('SELECT pid FROM runs WHERE id = ?').get(runId) as { pid: number | null }).pid ===
                null,
            'the process record to be cleared',
            15_000
        );

        say('info');
        await waitFor(() => texts(runId).length === 3, 'the second turn', 15_000);

        // Every tool of an autopilot chat is a shell command for this agent, so the session names no MCP server.
        expect(JSON.parse(texts(runId)[2])).toMatchObject({ servers: [], model: 'fast' });
        expect(h.run(runId).sessionId).toBe('fake-1');
    });

    test("the window's fill the agent reports is left on the run, the last reading of the turn included", async () => {
        const { h, say } = await setup();
        const runId = say('context 40000 200000\ncontext 40100 200000');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);
        expect(h.run(runId).context).toEqual({ used: 40_100, size: 200_000 });
    });

    test('an agent that uses the MCP door calls the task tools through the bridge, and one on the shell door has no MCP server for them', async () => {
        const shell = await setup();
        const noServer = shell.say('call task_get {"taskId":"REP-1"}');

        await waitFor(() => shell.h.run(noServer).status === 'succeeded', 'the turn', 15_000);
        expect(shell.texts(noServer).join('\n')).toContain('no mcp server');

        const { h, project, say, texts } = await setup({}, 'mcp');
        const task = h.ok('task.create', { projectId: project.id, title: 'Fix the footer' }).task;
        const runId = say(`call task_get {"taskId":"${task.key}"}`);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        const answer = texts(runId).join('\n');

        expect(answer).toContain('result: ');
        expect(answer).toContain('Fix the footer');

        const tools = listItems(h.store.db, runId, 0).flatMap(item =>
            item.body.kind === 'tool' ? [[item.body.name, item.body.state]] : []
        );

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

    test('new ACP sessions receive the selected system skills after switches change', async () => {
        const { h, project, say, texts } = await setup();
        h.ok('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: false });
        const first = say('info');
        await waitFor(() => h.run(first).status === 'succeeded', 'disabled session', 15_000);
        const disabled = JSON.parse(texts(first)[1]) as { systemPrompt: string };
        expect(disabled.systemPrompt).not.toContain('clowdy:orchestrate');

        h.ok('skills.setEnabled', { name: 'clowdy:orchestrate', enabled: true });
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const second = h.ok('chat.send', { chatId: chat.id, text: 'info' }).runId;
        await waitFor(() => h.run(second).status === 'succeeded', 'enabled session', 15_000);
        const enabled = JSON.parse(texts(second)[1]) as { systemPrompt: string };
        expect(enabled.systemPrompt).toContain('<skill name="clowdy:orchestrate">');
    });

    test("a sub-agent Claude's adapter stamps becomes a native child run under its call, ended by the call", async () => {
        const { h, project, say, texts } = await setup();
        const runId = say('subagent Explore Map the docs\nsay all mapped');

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn', 15_000);

        const [child] = projectSnapshot(h.store, project.id).runs.filter(run => run.origin === 'native');
        const body = (id: string) => listItems(h.store.db, id, 0).map(item => item.body);

        expect(child).toMatchObject({
            parentRunId: runId,
            parentToolCallId: 'a1-1',
            name: 'Explore',
            summary: 'Map the docs',
            status: 'succeeded',
            result: 'Explore found the readme.',
        });
        expect(body(child.id)).toEqual([
            { kind: 'assistant', text: 'Looking around.', done: true },
            {
                kind: 'tool',
                toolCallId: 'a1-1-read',
                name: 'Read',
                input: { file_path: 'README.md' },
                state: 'done',
                output: '# Readme',
            },
        ]);
        // The parent keeps the call that started it, and none of what the sub-agent said or did.
        expect(
            body(runId).flatMap(item => (item.kind === 'tool' ? [[item.toolCallId, item.name, item.state]] : []))
        ).toEqual([['a1-1', 'Agent', 'done']]);
        expect(texts(runId)).toEqual(['ok', 'all mapped']);
        expect(h.run(runId).result).toBe('all mapped');
    });

    test('cancelling a run stops the agent and leaves no process behind', async () => {
        const { h, say } = await setup();
        const runId = say('sleep 60000');
        const pid = await waitFor(
            () => (h.store.db.query('SELECT pid FROM runs WHERE id = ?').get(runId) as { pid: number | null }).pid,
            'the agent to start',
            15_000
        );

        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to be cancelled', 15_000);
        await waitFor(
            () => {
                try {
                    process.kill(pid, 0);

                    return false;
                } catch {
                    return true;
                }
            },
            'the agent process to be gone',
            15_000
        );
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
        writeFileSync(
            join(config.dataDir, 'agents.json'),
            JSON.stringify({ agents: [], overrides: { opencode: { path: '/nonexistent/opencode' } } })
        );

        const h = new Harness(await startDaemon(config, { agents: testAgents(config) }), config);

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'hello' });

        await waitFor(() => h.run(runId).status === 'failed', 'the run to fail', 15_000);

        expect(h.run(runId).error).toBe(
            'OpenCode is not installed: no `opencode` command was found. Install it, then try again'
        );
    });

    test('a daemon told to use an agent it does not know refuses to start', async () => {
        await expect(startDaemon(testConfig({ engine: 'gpt' }))).rejects.toThrow(
            /CLOWDY_ENGINE=gpt is not an agent this daemon knows/
        );
    });
});

describe('a chat on an ACP v2 agent that works in the background, through the real runtime', () => {
    const bridges: ToolBridge[] = [];

    afterEach(() => {
        for (const bridge of bridges.splice(0)) {
            bridge.stop();
        }
    });

    /** A whole daemon whose only engine is the v2 fake agent, with a handoff guard of a fraction of a second. */
    async function setupV2() {
        const config = testConfig({ engine: 'fake-acp' });
        const agents = testAgents(config);

        agents.add({ id: 'fake-acp', name: 'Fake ACP', command: process.execPath, args: [FAKE_AGENT_V2] });

        // A custom agent speaks v1; this one is set to v2, as the built-in ones are once the real adapters pass their checks.
        const resolve = agents.resolve.bind(agents);

        agents.resolve = async id => {
            const found = await resolve(id);

            return found.ok ? { ok: true, agent: { ...found.agent, protocol: 'v2' } } : found;
        };

        const bridge = new ToolBridge();
        const engine = new AcpEngine('fake-acp', { registry: agents, bridge, backgroundHandoffMs: 300 });
        const engines: EngineRegistry = {
            has: id => id === 'fake-acp',
            get: id => (id === 'fake-acp' ? engine : undefined),
        };

        bridges.push(bridge);

        const h = new Harness(await startDaemon(config, { agents, engines }), config);

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id });
        const say = (text: string): string => h.ok('chat.send', { chatId: chat.id, text }).runId;
        const pid = (runId: string) =>
            (h.store.db.query('SELECT pid FROM runs WHERE id = ?').get(runId) as { pid: number | null }).pid;
        /** The stream as lines: what the person said (`> `), what the agent said (`< `), and the notes. */
        const stream = (runId: string) =>
            listItems(h.store.db, runId, 0).flatMap(item =>
                item.body.kind === 'user'
                    ? [`> ${item.body.text.split('\n')[0]}`]
                    : item.body.kind === 'assistant'
                      ? [`< ${item.body.text}`]
                      : item.body.kind === 'note'
                        ? [`note: ${item.body.text}`]
                        : []
            );

        return { h, chat, say, pid, stream };
    }

    test('a turn that starts a command leaves the run waiting, the report turn is a message with no `user` item before it, and the run settles when nothing is open', async () => {
        const { h, say, pid, stream } = await setupV2();
        const runId = say(
            'say started\nbackground terminal 1200 sleep 60\nreport say the command finished\nreport sleep 100'
        );

        // The turn is over, and the run waits with the session: its process recorded, its slot free.
        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait for the command', 15_000);

        const agent = pid(runId);

        expect(h.run(runId).background).toEqual([{ id: 'term-1', kind: 'command', title: 'sleep 60' }]);
        expect(agent).not.toBeNull();
        expect(alive(agent as number)).toBe(true);
        expect(stream(runId).filter(line => line.startsWith('<'))).toEqual(['< ok', '< started']);

        // A message sent meanwhile goes into the live session, and the agent answers it in the same process.
        h.ok('chat.send', { chatId: h.run(runId).chatId, text: 'say heard you' });
        await waitFor(() => stream(runId).includes('< heard you'), 'the answer to the message', 15_000);
        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait again', 15_000);

        expect(pid(runId)).toBe(agent);
        expect(h.run(runId).background).toHaveLength(1);

        // The command ends: the agent starts a turn of its own, which is a message with no `user` item, and the session ends with the guard.
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to settle', 15_000);

        expect(stream(runId)).toEqual([
            '> say started',
            '< ok',
            '< started',
            '> say heard you',
            '< heard you',
            'note: Background command finished: sleep 60',
            '< the command finished',
        ]);
        expect(h.run(runId).background).toBeUndefined();
        expect(h.run(runId).result).toBe('the command finished');
        await waitFor(() => pid(runId) === null && !alive(agent as number), 'the agent process to be gone', 15_000);
    }, 30_000);

    test('a workflow that goes on after the turn is a task of the run until it ends, and its call is finished by it', async () => {
        const { h, say } = await setupV2();
        const runId = say('say started\nbackground workflow 1000 Verify the docs\nreport say verified');
        const calls = () =>
            listItems(h.store.db, runId, 0).flatMap(item =>
                item.body.kind === 'tool' ? [[item.body.name, item.body.state]] : []
            );

        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait', 15_000);
        expect(h.run(runId).background).toEqual([{ id: 'wf-1', kind: 'task', title: 'Workflow: Verify the docs' }]);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to settle', 15_000);
        expect(calls()).toEqual([['Workflow', 'done']]);
        expect(h.run(runId).result).toBe('verified');
    }, 30_000);

    test('stopping a run that waits for background work ends the session and leaves no process', async () => {
        const { h, say, pid } = await setupV2();
        const runId = say('say started\nbackground terminal 60000 sleep 600');

        await waitFor(() => h.run(runId).status === 'waiting_background', 'the run to wait for the command', 15_000);

        const agent = pid(runId) as number;

        h.ok('run.cancel', { runId });
        await waitFor(() => h.run(runId).status === 'cancelled', 'the run to be cancelled', 15_000);
        await waitFor(() => !alive(agent), 'the agent process to be gone', 15_000);
        expect(h.run(runId).background).toBeUndefined();
    }, 30_000);
});
