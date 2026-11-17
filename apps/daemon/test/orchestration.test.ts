import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { infoPath, lockPath } from '../src/instance';
import { firstMessage, systemPrompt, taskMessage } from '../src/runs/prompts';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, untilAborted, waitFor } from './helpers';

import type { Project, Task } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const holding: Script = async function* ({ number, signal }) {
    yield { type: 'session', sessionId: `s${ number }` };
    await untilAborted(signal);
};

async function setup(script: Script = holding, overrides: Parameters<typeof startHarness>[0] = {}, options: Parameters<typeof startHarness>[1] = {}) {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine), ...options });

    harnesses.push(h);

    const project = h.openRepo();
    const task = (title: string, extra: Record<string, unknown> = {}) => h.ok('task.create', { projectId: project.id, title, ...extra }).task as Task;

    return { h, engine, project, task };
}

describe('task.start', () => {
    test('opens a new chat named after the task, linked to it, with an orchestrator bound to the task', async () => {
        const { h, engine, project, task } = await setup();
        const fix = task('Fix the footer', { description: 'Outcome: the footer shows the year.\nCheck: the page.' });
        const { runId, chatId } = h.ok('task.start', { taskId: fix.id });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        const chat = h.store.db.query('SELECT * FROM chats WHERE id = ?').get(chatId) as { title: string; mode: string; orchestrator_run_id: string };

        expect(chat).toMatchObject({ title: 'Fix the footer', mode: 'autopilot', orchestrator_run_id: runId });
        expect(h.run(runId)).toMatchObject({ role: 'orchestrator', chatId, rootRunId: runId, summary: 'Fix the footer', status: 'running' });
        expect(h.store.db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ?').all(fix.id)).toEqual([{ chat_id: chatId }]);
        expect(h.store.db.query('SELECT run_id, relation FROM run_task_links WHERE task_id = ?').all(fix.id)).toEqual([{ run_id: runId, relation: 'assigned' }]);

        // The first message is the task with the instruction to complete it; the chat shows it as the user's message.
        const message = ['Complete task REP-1: Fix the footer', 'Description:\nOutcome: the footer shows the year.\nCheck: the page.', 'This chat is bound to REP-1; read it with task_get, do the work, and finish with a short report.'].join('\n\n');

        expect(engine.turns[0].prompt).toBe(`/clowdy:orchestrate Mode: autopilot\n\n${ message }`);
        expect(h.store.db.query('SELECT body FROM stream_items WHERE run_id = ?').all(runId).map(row => JSON.parse((row as { body: string }).body))).toEqual([{ kind: 'user', text: message }]);
        expect(h.events().filter(event => event.data.type === 'chat.upserted').map(event => (event.data as { chat: { orchestratorRunId?: string } }).chat.orchestratorRunId)).toEqual([undefined, runId]);
        expect(project.id).toBeTruthy();
    });

    test('the chat takes the project\'s mode when it names one', async () => {
        const { h, engine, project, task } = await setup();

        h.ok('project.update', { projectId: project.id, settings: { chatMode: 'semi' } });

        const { chatId } = h.ok('task.start', { taskId: task('A').id });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        expect((h.store.db.query('SELECT mode FROM chats WHERE id = ?').get(chatId) as { mode: string }).mode).toBe('semi');
        expect(engine.turns[0].prompt.startsWith('/clowdy:orchestrate Mode: semi-manual\n\n')).toBe(true);
        expect(engine.turns[0].tools.map(tool => tool.name)).toContain('ask_user');
        expect(h.ok('chat.create', { projectId: project.id }).chat.mode).toBe('semi');
        expect(h.ok('chat.create', { projectId: project.id, mode: 'autopilot' }).chat.mode).toBe('autopilot');
    });

    test('refuses a task that already has an active run unless forced, and then opens a second chat', async () => {
        const { h, task } = await setup();
        const fix = task('Fix it');
        const first = h.ok('task.start', { taskId: fix.id });

        expect(h.send('task.start', { taskId: fix.id })).toMatchObject({ ok: false, error: { code: 'already_running', message: expect.stringContaining('already has an active run (Orchestrator 01)') } });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 1 });

        const forced = h.ok('task.start', { taskId: fix.id, force: true });

        expect(forced.chatId).not.toBe(first.chatId);
        expect(h.store.db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ? ORDER BY rowid').all(fix.id)).toEqual([{ chat_id: first.chatId }, { chat_id: forced.chatId }]);
    });

    test('a long title is shortened for the chat, and a later message continues the same chat', async () => {
        const { h, engine, task } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: `s${ number }` };
            yield { type: 'done', result: `turn ${ number }` };
        });
        const { runId, chatId } = h.ok('task.start', { taskId: task('x'.repeat(100)).id });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn');
        expect((h.store.db.query('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string }).title).toBe(`${ 'x'.repeat(59) }…`);
        expect(h.ok('chat.send', { chatId, text: 'And the header?' })).toEqual({ chatId, runId });
        await waitFor(() => engine.turns.length === 2, 'the second turn');
        expect(engine.turns[1]).toMatchObject({ resumeSessionId: 's1', prompt: 'And the header?' });
    });
});

describe('the prompts of a run', () => {
    const project = { id: 'prj_1', name: 'Car Rental', path: '/work/cars', taskPrefix: 'CAR', settings: {}, createdAt: 1 } as Project;

    test('the first message names the entry skill and the mode, then the content', () => {
        expect(firstMessage('orchestrator', 'autopilot', 'Add dark mode')).toBe('/clowdy:orchestrate Mode: autopilot\n\nAdd dark mode');
        expect(firstMessage('orchestrator', 'semi', 'Add dark mode')).toBe('/clowdy:orchestrate Mode: semi-manual\n\nAdd dark mode');
        expect(firstMessage('executor', 'autopilot', 'Goal: x')).toBe('/clowdy:executor Mode: autopilot\n\nGoal: x');
        expect(firstMessage('verifier', 'semi', 'Claim: y')).toBe('/clowdy:verify Mode: semi-manual\n\nClaim: y');
    });

    test('the system prompt points to the skill, states the mode and the project facts, and stays short', () => {
        const prompt = systemPrompt('orchestrator', 'semi', project);

        expect(prompt).toContain('Follow clowdy:orchestrate');
        expect(prompt).toContain('Mode: semi-manual.');
        expect(prompt).toContain('Project: Car Rental, repository at /work/cars, task keys CAR-<number>, project documents in .clowdy/docs/.');
        expect(prompt.length).toBeLessThan(900);
        expect(systemPrompt('executor', 'autopilot', project)).toContain('Follow clowdy:executor. Never ask the user; finish with report_result.');
        expect(systemPrompt('verifier', 'autopilot', project)).toContain('Follow clowdy:verify.');
    });

    test('a task becomes the first message of its chat', () => {
        const task = { key: 'CAR-3', title: 'Fix the footer', description: '' } as Task;

        expect(taskMessage(task)).toBe('Complete task CAR-3: Fix the footer\n\nThis chat is bound to CAR-3; read it with task_get, do the work, and finish with a short report.');
    });

    test('every turn of a run is told its system prompt, with the run\'s own role and the chat\'s mode', async () => {
        const { h, engine, project: opened } = await setup();
        const { chat } = h.ok('chat.create', { projectId: opened.id, mode: 'semi' });

        h.ok('chat.send', { chatId: chat.id, text: 'Hello' });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        expect(engine.turns[0].systemPrompt).toContain('Mode: semi-manual.');
        expect(engine.turns[0].systemPrompt).toContain(`repository at ${ opened.path }`);
    });
});

describe('health and shutdown', () => {
    test('health counts the runs that are still at work', async () => {
        const gate = latch();
        const { h, task } = await setup(async function* ({ signal }) {
            yield { type: 'session', sessionId: 's1' };
            await gate.wait(signal);
            yield { type: 'done' };
        });
        const health = async () => (await (await fetch(`${ h.url }/v1/health`)).json() as { activeRuns: number }).activeRuns;

        expect(await health()).toBe(0);

        const first = h.ok('task.start', { taskId: task('A').id }).runId as string;

        h.ok('task.start', { taskId: task('B', { dependsOn: [] }).id });
        await waitFor(() => h.run(first).status === 'running', 'the run to start');
        expect(await health()).toBe(2);
        gate.release();
        await waitFor(() => h.daemon.services.runs.activeCount() === 0, 'the runs to finish');
        expect(await health()).toBe(0);
    });

    test('POST /v1/shutdown needs the token, answers, then stops the daemon without cancelling anything', async () => {
        let stopped = false;
        const { h, engine, task } = await setup(holding, {}, { onShutdown: () => void (stopped = true) });
        const runId = h.ok('task.start', { taskId: task('A').id }).runId as string;

        await waitFor(() => engine.turns.length === 1, 'the run to start');
        expect((await fetch(`${ h.url }/v1/shutdown`, { method: 'POST' })).status).toBe(401);
        expect((await fetch(`${ h.url }/v1/shutdown`, { headers: { authorization: `Bearer ${ h.config.token }` } })).status).toBe(405);
        expect(stopped).toBe(false);

        const response = await fetch(`${ h.url }/v1/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${ h.config.token }` } });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        await waitFor(() => stopped, 'the daemon to stop');
        expect(existsSync(infoPath(h.config.dataDir))).toBe(false);
        expect(existsSync(lockPath(h.config.dataDir))).toBe(false);
        expect(existsSync(join(h.config.dataDir, 'clowdy.db'))).toBe(true);
        await expect(fetch(`${ h.url }/v1/health`)).rejects.toThrow();

        // Nothing was cancelled: the run is left for the next start to mark.
        const next = await restartHarness(h, { engines: scriptEngines(new ScriptEngine(holding)) });

        harnesses.push(next);
        expect(next.run(runId)).toMatchObject({ status: 'interrupted', statusReason: 'Daemon restarted' });
        expect(next.events().some(event => event.data.type === 'run.upserted' && event.data.run.id === runId && event.data.run.status === 'cancelled')).toBe(false);
    });
});
