import { LAST_USED } from '@clowdy/protocol';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { infoPath, lockPath } from '../src/instance';
import { firstMessage, skillPrompt, systemPrompt, taskMessage } from '../src/runs/prompts';
import { toolsFor } from '../src/runs/tools';
import { cleanTempDirs, latch, restartHarness, ScriptEngine, scriptEngines, startHarness, tempDir, untilAborted, waitFor } from './helpers';

import type { Chat, Project, Task } from '@clowdy/protocol';
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
        const message = ['Complete task REP-1: Fix the footer', 'Description:\nOutcome: the footer shows the year.\nCheck: the page.', 'This chat is bound to REP-1; read it with `clowdy task get REP-1`, do the work, and finish with a short report.'].join('\n\n');

        expect(engine.turns[0].prompt).toBe(`Follow clowdy:orchestrate. Mode: autopilot\n\n${ message }`);
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
        expect(engine.turns[0].prompt.startsWith('Follow clowdy:orchestrate. Mode: semi-manual\n\n')).toBe(true);
        expect(engine.turns[0].tools.map(tool => tool.name)).toContain('ask_user');
        expect(h.ok('chat.create', { projectId: project.id }).chat.mode).toBe('semi');
        expect(h.ok('chat.create', { projectId: project.id, mode: 'autopilot' }).chat.mode).toBe('autopilot');
    });

    test('a project that keeps the last used agent and mode names neither to the daemon, which only the app can resolve', async () => {
        const { h, engine, project, task } = await setup();

        h.ok('project.update', { projectId: project.id, settings: { engine: LAST_USED, chatMode: LAST_USED } });

        const { chatId } = h.ok('task.start', { taskId: task('A').id });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        expect((h.store.db.query('SELECT mode FROM chats WHERE id = ?').get(chatId) as { mode: string }).mode).toBe('autopilot');
        expect(h.ok('chat.create', { projectId: project.id }).chat.mode).toBe('autopilot');
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

describe('the record of a conversation for an agent that lost its session', () => {
    test('a turn that resumes can tell what was said, without the message it is sent with', async () => {
        const { h, engine, task } = await setup(async function* ({ number }) {
            yield { type: 'session', sessionId: `s${ number }` };
            yield { type: 'text', delta: `Answer ${ number }`, done: true };
            yield { type: 'done' };
        });
        const { runId, chatId } = h.ok('task.start', { taskId: task('Fix the footer').id });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn');
        h.ok('chat.send', { chatId, text: 'And the header?' });
        await waitFor(() => engine.turns.length === 2, 'the second turn');

        // The first turn has no session to lose.
        expect(engine.turns[0]!.history).toBeUndefined();

        const record = engine.turns[1]!.history!()!;

        expect(record).toContain('Complete task');
        expect(record).toContain('You: Answer 1');
        expect(record).not.toContain('And the header?');
    });
});

describe('the prompts of a run', () => {
    const project: Project = { id: 'prj_1', name: 'Car Rental', folders: [{ id: 'fld_1', path: '/work/cars' }], taskPrefix: 'CAR', settings: {}, createdAt: 1, position: 1 };

    test('the first message names the entry skill and the mode, then the content', () => {
        expect(firstMessage('autopilot', 'Add dark mode')).toBe('Follow clowdy:orchestrate. Mode: autopilot\n\nAdd dark mode');
        expect(firstMessage('semi', 'Add dark mode')).toBe('Follow clowdy:orchestrate. Mode: semi-manual\n\nAdd dark mode');
    });

    test('the system prompt points to the skill, states the mode and the project facts, and stays short', () => {
        const prompt = systemPrompt('semi', project);

        expect(prompt).toContain('You are the orchestrator of a Clowdy chat. Follow clowdy:orchestrate');
        expect(prompt).toContain('Mode: semi-manual.');
        // Any folder can be a project's, so none is called a repository.
        expect(prompt).toContain('Project: Car Rental, folder at /work/cars, task keys CAR-<number>, project documents in .clowdy/docs/.');
        expect(prompt).not.toContain('repository');
        expect(prompt.length).toBeLessThan(900);
        expect(systemPrompt('autopilot', project)).toContain('Mode: autopilot.');
    });

    test('a project of several folders names each by path, marks the main one and the one the run works in, and says where instructions and documents are', () => {
        const several = { ...project, folders: [{ id: 'fld_1', path: '/work/cars' }, { id: 'fld_2', path: '/work/cars-api' }, { id: 'fld_3', path: '/notes/fleet' }] };
        const prompt = systemPrompt('semi', several);

        expect(prompt).toContain([
            'Project: Car Rental, task keys CAR-<number>, folders (use absolute paths outside the folder you work in):',
            '- /work/cars (main, you work here)',
            '- /work/cars-api',
            '- /notes/fleet',
            'Each folder may have its own AGENTS.md or CLAUDE.md; read it before you change files in that folder.',
            'Documents: each folder has its own .clowdy/docs/. A document about one folder goes into that folder\'s; one about several folders or the whole project goes into the main folder\'s.',
        ].join('\n'));
        expect(prompt).not.toContain('repository');
        expect(prompt.length).toBeLessThan(1200);
        // A run whose `cwd` is another folder of the project works there, and one in a copy outside the project works in none of them.
        expect(systemPrompt('semi', several, '/notes/fleet')).toContain('- /work/cars (main)\n- /work/cars-api\n- /notes/fleet (you work here)\n');
        expect(systemPrompt('semi', several, '/tmp/cars-copy')).toContain('- /work/cars (main)\n- /work/cars-api\n- /notes/fleet\n');
    });

    test('the entry skill is inlined without its front matter, with where the other skills are; no folder, no skill text', () => {
        const dir = tempDir();
        const empty = tempDir();

        mkdirSync(join(dir, 'skills', 'orchestrate'), { recursive: true });
        writeFileSync(join(dir, 'skills', 'orchestrate', 'SKILL.md'), '---\nname: orchestrate\ndescription: Run the chat\n---\n\n# Orchestrate\n\nRead the request first.\n');

        const prompt = skillPrompt(dir);

        expect(prompt).toContain(`${ join(dir, 'skills', '<name>', 'SKILL.md') }`);
        expect(prompt).toContain('<skill name="clowdy:orchestrate">\n# Orchestrate\n\nRead the request first.\n</skill>');
        expect(prompt).not.toContain('description: Run the chat');
        // A folder without the skill: the pointer stays, the text does not.
        expect(skillPrompt(empty)).not.toContain('<skill');
        expect(skillPrompt(empty)).toContain('System skills are plain files');
        expect(skillPrompt(undefined)).toBe('');
    });

    test('a run of a chat is told about threads and the command, and a thread\'s run whose thread it is, how to report and whom it may write to', () => {
        const parent = { id: 'cht_parent', title: 'Plan the release' };
        const none = systemPrompt('autopilot', project);
        const chat = systemPrompt('autopilot', project, undefined, {});
        const thread = systemPrompt('autopilot', project, undefined, { parent });

        // A run without a chat has no thread commands, and every run is told how to reach the task tools.
        expect(none).not.toContain('clowdy thread');
        expect(none).toContain('Tasks: read and change them with the shell command `clowdy task`');
        expect(none).toContain('`task_get`, `task_list`, `task_create` and `task_update`');

        expect(chat).toContain('Threads: you can hand work to other agents as threads');
        expect(chat).toContain('`clowdy thread --help`');
        expect(chat).toContain('`"$CLOWDY_CLI"` is the same command if your shell does not find `clowdy`');
        expect(chat).toContain('if a sandboxed shell refuses it (`EPERM`), run the same command again with escalated permissions, outside the sandbox');
        expect(chat).toContain('Delegate only when the person asked for it or the work really splits');
        expect(chat).toContain('self-contained brief');
        expect(chat).toContain('Its last message of a turn is its report');
        expect(chat).toContain('never poll');
        expect(chat).toContain('Never send a thread acknowledgements or thanks');
        expect(chat).not.toContain('This chat is a thread');
        expect(chat.length).toBeLessThan(1950);

        expect(thread).toContain('This chat is a thread: the chat "Plan the release" (cht_parent) started it, and the first message is your assignment from that chat.');
        expect(thread).toContain('Your last message of each turn is your report to it, delivered when you stop: the verdict first');
        expect(thread).toContain('`clowdy thread tell cht_parent "<question>"` only when you are blocked');
        expect(thread).toContain('Write to no other chat unless your assignment says so');
        expect(thread).toContain('threads of your own while the depth limit allows');
        expect(thread).toContain('Follow clowdy:thread');
        expect(thread).toContain('Threads: you can hand work');
        expect(thread.length).toBeLessThan(2650);
    });

    test('a thread\'s run starts from the thread skill too', () => {
        const dir = tempDir();

        for (const [name, body] of [['orchestrate', 'Read the request first.'], ['thread', 'Report to your parent.']]) {
            mkdirSync(join(dir, 'skills', name), { recursive: true });
            writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${ name }\ndescription: The ${ name } skill\n---\n\n${ body }\n`);
        }

        expect(skillPrompt(dir)).not.toContain('clowdy:thread');
        expect(skillPrompt(dir, true)).toContain('The skills you start from are below');
        expect(skillPrompt(dir, true)).toContain('<skill name="clowdy:orchestrate">\nRead the request first.\n</skill>\n\n<skill name="clowdy:thread">\nReport to your parent.\n</skill>');
    });

    test('every turn of a thread is told whose thread it is, with the thread skill, and its parent only about threads', async () => {
        const { h, engine, project: opened } = await setup();
        const { store, runs, threads } = h.daemon.services;
        const { chat } = h.ok('chat.create', { projectId: opened.id, title: 'Plan the release' }) as { chat: Chat };

        h.ok('chat.send', { chatId: chat.id, text: 'Hello' });
        await waitFor(() => engine.turns.length === 1, 'the parent to start');

        const parent = runs.require(getChat(store.db, chat.id)?.orchestratorRunId as string);
        const spawn = toolsFor({ store, runs, threads }, parent, 'autopilot').find(candidate => candidate.name === 'thread_spawn');

        await spawn?.execute({ prompt: 'Look into the cache' }, new AbortController().signal);
        await waitFor(() => engine.turns.length === 2, 'the thread to start');

        expect(engine.turns[0].systemPrompt).toContain('Threads: you can hand work');
        expect(engine.turns[0].systemPrompt).not.toContain('This chat is a thread');
        expect(engine.turns[0].systemPrompt).not.toContain('<skill name="clowdy:thread">');
        expect(engine.turns[1].systemPrompt).toContain(`This chat is a thread: the chat "Plan the release" (${ chat.id }) started it`);
        expect(engine.turns[1].systemPrompt).toContain(`clowdy thread tell ${ chat.id }`);
        expect(engine.turns[1].systemPrompt).toContain('<skill name="clowdy:orchestrate">');
        expect(engine.turns[1].systemPrompt).toContain('<skill name="clowdy:thread">');
    });

    test('a task becomes the first message of its chat', () => {
        const task = { key: 'CAR-3', title: 'Fix the footer', description: '' } as Task;

        expect(taskMessage(task)).toBe('Complete task CAR-3: Fix the footer\n\nThis chat is bound to CAR-3; read it with `clowdy task get CAR-3`, do the work, and finish with a short report.');
    });

    test('every turn of a run is told its system prompt, with the chat\'s mode', async () => {
        const { h, engine, project: opened } = await setup();
        const { chat } = h.ok('chat.create', { projectId: opened.id, mode: 'semi' });

        h.ok('chat.send', { chatId: chat.id, text: 'Hello' });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');
        expect(engine.turns[0].systemPrompt).toContain('Mode: semi-manual.');
        expect(engine.turns[0].systemPrompt).toContain(`folder at ${ opened.path }`);
        // A project of one folder has no other folder to hand the agent.
        expect(engine.turns[0].additionalDirectories).toEqual([]);
    });

    test('a turn gets the project\'s other folders that are still there, in order, but not the one it works in', async () => {
        const { h, engine } = await setup();
        const parent = tempDir();

        for (const name of ['web', 'api', 'notes']) {
            mkdirSync(join(parent, name));
        }

        const { project } = h.ok('project.add', { name: 'Shop', folders: ['web', 'api', 'notes'].map(name => join(parent, name)) }) as { project: Project };
        const [web, api, notes] = project.folders.map(folder => folder.path);

        rmSync(api, { recursive: true });

        const { chat } = h.ok('chat.create', { projectId: project.id });

        h.ok('chat.send', { chatId: chat.id, text: 'Hello' });
        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        // The orchestrator works in the main folder; the missing folder is left out of what the agent gets, not of what it is told.
        expect(engine.turns[0]).toMatchObject({ cwd: web, additionalDirectories: [notes] });
        expect(engine.turns[0].systemPrompt).toContain(`- ${ web } (main, you work here)\n- ${ api }\n- ${ notes }\n`);

        // A run that works in another folder of the project (`cwd`) gets the main folder instead of its own, and is told where it works.
        const { runs, driver } = h.daemon.services;
        const elsewhere = runs.createRun({ project, role: 'orchestrator', summary: 'Tidy the notes', cwd: notes, nextPrompt: 'Tidy the notes' });

        driver.launch(elsewhere.id);
        await waitFor(() => engine.turns.length === 2, 'the run in the notes folder to start');
        expect(engine.turns[1]).toMatchObject({ cwd: notes, additionalDirectories: [web] });
        expect(engine.turns[1].systemPrompt).toContain(`- ${ web } (main)\n- ${ api }\n- ${ notes } (you work here)\n`);
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
