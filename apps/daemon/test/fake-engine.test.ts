import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { streamItems } from '../src/domain/items';
import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, Harness, startHarness, waitFor } from './helpers';

import type {
    ChatTaskLink,
    ClowdyEvent,
    ProjectSnapshot,
    Run,
    StreamItem,
    Task,
    TaskStatusCategory,
} from '@clowdy/protocol';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup(overrides: Parameters<typeof startHarness>[0] = {}, mode?: 'semi') {
    const h = await startHarness(overrides);

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, mode });

    return { h, project, chat };
}

const snapshot = (h: Harness, projectId: string) => projectSnapshot(h.store, projectId);
/** A run's stream as a client reads it, with the flags of what the fake agent can fork. */
const items = (h: Harness, runId: string): StreamItem[] => streamItems(h.store, runId, 0);
const toolItems = (list: StreamItem[]) => list.flatMap(item => (item.body.kind === 'tool' ? [item.body] : []));
const upserts = (events: ClowdyEvent[], runId: string) =>
    events.flatMap(event =>
        event.data.type === 'run.upserted' && event.data.run.id === runId ? [event.data.run] : []
    );

function categoryTrail(h: Harness, projectId: string, taskId: string): TaskStatusCategory[] {
    const statuses = new Map(snapshot(h, projectId).statuses.map(status => [status.id, status.category]));
    const trail = h
        .events()
        .flatMap(event =>
            event.data.type === 'task.upserted' && event.data.task.id === taskId
                ? [statuses.get(event.data.task.statusId)!]
                : []
        );

    return trail.filter((category, index) => category !== trail[index - 1]);
}

describe('the scripted orchestrator', () => {
    test('a chat message becomes three linked tasks that the orchestrator does itself, and a finished orchestrator', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', {
            chatId: chat.id,
            text: 'Simplify the booking flow so users book in two steps',
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const state = snapshot(h, project.id);
        const orchestrator = state.runs.find(run => run.id === runId)!;
        const natives = state.runs.filter(run => run.origin === 'native');
        const [first, second, third] = state.tasks;
        const categories = new Map(state.statuses.map(status => [status.id, status.category]));

        // The chat and its orchestrator
        expect(state.chats[0]).toMatchObject({
            id: chat.id,
            orchestratorRunId: runId,
            title: 'Simplify the booking flow so users book in two steps',
        });
        expect(orchestrator).toMatchObject({
            role: 'orchestrator',
            chatId: chat.id,
            name: 'Orchestrator 01',
            rootRunId: runId,
            engine: 'fake',
            status: 'succeeded',
        });
        expect(orchestrator.parentRunId).toBeUndefined();
        expect(orchestrator.result).toContain('REP-1, REP-2 and REP-3 are complete');
        expect(orchestrator.usage?.outputTokens).toBeGreaterThan(0);

        // Three tasks, the third depends on the first, all done in the end
        expect(state.tasks.map(task => task.key)).toEqual(['REP-1', 'REP-2', 'REP-3']);
        expect(third.dependsOn).toEqual([first.id]);
        expect(second.dependsOn).toEqual([]);
        expect(state.tasks.every(task => categories.get(task.statusId) === 'done')).toBe(true);
        expect(state.tasks.every(task => task.createdBy.kind === 'run' && task.createdBy.runId === runId)).toBe(true);

        // Links: chat <-> tasks, the orchestrator created the tasks, and no run is assigned to them
        const chatLinks = (link: ChatTaskLink) => [link.chatId, link.taskId];

        expect(state.chatTaskLinks.map(chatLinks)).toEqual(state.tasks.map(task => [chat.id, task.id]));
        expect(state.runTaskLinks).toEqual(state.tasks.map(task => ({ runId, taskId: task.id, relation: 'created' })));

        // The only other runs are its sub-agents, one per task, all finished
        expect(state.runs.filter(run => run.origin !== 'native')).toEqual([orchestrator]);
        expect(natives).toHaveLength(3);

        for (const native of natives) {
            expect(native).toMatchObject({
                role: 'executor',
                origin: 'native',
                name: 'Explore',
                parentRunId: runId,
                rootRunId: runId,
                status: 'succeeded',
                engine: 'fake',
            });
        }
    });

    test('the orchestrator does the dependency first, and the dependent task starts only after it is done', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const state = snapshot(h, project.id);
        const events = h.events();
        const [first, , third] = state.tasks;
        const category = (name: TaskStatusCategory) => state.statuses.find(status => status.category === name)!.id;
        const cursorOf = (taskId: string, statusId: string) =>
            events.find(
                event =>
                    event.data.type === 'task.upserted' &&
                    event.data.task.id === taskId &&
                    event.data.task.statusId === statusId
            )!.cursor;

        expect(cursorOf(third.id, category('active'))).toBeGreaterThan(cursorOf(first.id, category('done')));

        // One turn from start to end: nothing it waited for.
        expect(
            upserts(events, runId)
                .map(run => run.status)
                .filter((status, index, all) => status !== all[index - 1])
        ).toEqual(['queued', 'running', 'succeeded']);
    });

    test('tasks move through To do, In progress, Review and Done as the orchestrator works', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        for (const task of snapshot(h, project.id).tasks) {
            expect(categoryTrail(h, project.id, task.id)).toEqual(['todo', 'active', 'review', 'done']);
        }
    });

    test('the stream has one item per message and per tool call, updated in place, in order', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const list = items(h, runId);
        const tools = toolItems(list);
        const counts = tools.reduce<Record<string, number>>(
            (acc, tool) => ({ ...acc, [tool.name]: (acc[tool.name] ?? 0) + 1 }),
            {}
        );

        expect(list.map(item => item.seq)).toEqual(list.map((_, index) => index + 1));
        expect(list[0].body).toEqual({ kind: 'user', text: 'Add dark mode' });
        expect(counts).toEqual({
            read_file: 4,
            task_create: 3,
            task_update: 9,
            Agent: 3,
            edit_file: 3,
            bash: 3,
            task_list: 1,
        });
        expect(tools.every(tool => tool.state === 'done')).toBe(true);
        expect(new Set(tools.map(tool => tool.toolCallId)).size).toBe(tools.length);
        expect(
            list
                .filter(item => item.body.kind === 'assistant')
                .every(item => item.body.kind === 'assistant' && item.body.done)
        ).toBe(true);
        expect(list.some(item => item.body.kind === 'note')).toBe(false);

        // The log agrees with the table: the last event per item is the stored item.
        const last = new Map<string, StreamItem>();

        for (const event of h.events()) {
            if (event.data.type === 'stream.item' && event.data.item.runId === runId) {
                last.set(event.data.item.id, event.data.item);
            }
        }

        expect([...last.values()]).toEqual(list);
        expect(project.id).toBeTruthy();
    });

    test('the orchestrator reads, checks the callers with a sub-agent, edits with a diff-like output, and runs a command', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        // The work on the first task: from moving it to In progress to marking it Done.
        const tools = toolItems(items(h, runId));
        const start = tools.findIndex(tool => tool.name === 'task_update');
        const work = tools.slice(start, start + 8);

        expect(work.map(tool => [tool.name, tool.state])).toEqual([
            ['task_update', 'done'],
            ['read_file', 'done'],
            ['Agent', 'done'],
            ['edit_file', 'done'],
            ['task_update', 'done'],
            ['bash', 'done'],
            ['task_update', 'done'],
            ['task_update', 'done'],
        ]);
        expect(work[0].input).toEqual({ taskId: 'REP-1', status: 'active' });
        expect(work[3].output).toEqual({
            path: expect.stringMatching(/^src\/.*\.ts$/),
            added: expect.any(Number),
            removed: expect.any(Number),
        });
        expect(work[4].input).toEqual({ taskId: 'REP-1', status: 'review' });
        expect(work[5]).toMatchObject({
            input: { command: 'bun run typecheck' },
            output: { command: 'bun run typecheck', exitCode: 0 },
        });
        expect(work[6].input).toEqual({ taskId: 'REP-1', status: 'done' });

        // The sub-agent is a native child of the orchestrator, known by the `Agent` call that started it, and that call's result is its report.
        const agent = work[2];
        const native = snapshot(h, project.id).runs.find(
            run => run.origin === 'native' && run.parentToolCallId === agent.toolCallId
        )!;

        expect(agent).toMatchObject({
            input: { subagent_type: 'Explore' },
            output: expect.stringContaining('none affected'),
        });
        expect(native).toMatchObject({
            parentRunId: runId,
            name: 'Explore',
            status: 'succeeded',
            result: agent.output,
        });
        expect(toolItems(items(h, native.id)).map(tool => tool.name)).toEqual(['grep']);
    });

    test('a second message in a finished chat runs another turn on the same orchestrator run', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn', 8000);

        const firstFinish = h.run(runId).finishedAt!;
        const before = items(h, runId).length;
        const second = h.ok('chat.send', { chatId: chat.id, text: 'And what about contrast?' });

        expect(second.runId).toBe(runId);
        expect(h.run(runId).status).toBe('queued');
        await waitFor(
            () => h.run(runId).status === 'succeeded' && h.run(runId).finishedAt !== firstFinish,
            'the second turn'
        );

        const list = items(h, runId);
        const user = list.filter(item => item.body.kind === 'user').map(item => (item.body as { text: string }).text);

        expect(user).toEqual(['Add dark mode', 'And what about contrast?']);
        expect(list.length).toBeGreaterThan(before + 2);
        expect(h.run(runId).result).toContain('Nothing else is needed');
        expect(h.run(runId).sessionId).toMatch(/^fake-/);
        expect(snapshot(h, project.id).tasks).toHaveLength(3);
        expect(snapshot(h, project.id).runs.filter(run => run.origin !== 'native')).toHaveLength(1);
        expect(h.run(runId).error).toBeUndefined();
    });

    test('the orchestrator reports how full its context is, and the reading grows by the same step with each turn of a conversation', async () => {
        const { h, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn', 8000);

        const before = h.run(runId);

        expect(before.context).toEqual({ used: 10_000, size: 200_000 });

        h.ok('chat.send', { chatId: chat.id, text: 'And what about contrast?' });
        // A message makes the run `queued` at once, so `succeeded` is the end of the second turn.
        await waitFor(() => h.run(runId).status === 'succeeded', 'the second turn');
        expect(h.run(runId).context).toEqual({ used: before.context!.used + 4_000, size: 200_000 });
    });

    test('a steer sent while the orchestrator works reaches its turn and is acknowledged there', async () => {
        const { h, chat } = await setup({ fakeSpeed: 0.05 });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'running', 'the run to start');
        h.ok('chat.send', { chatId: chat.id, text: 'Also keep it accessible', mode: 'steer' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish', 15_000);

        const texts = items(h, runId).flatMap(item =>
            item.body.kind === 'user' || item.body.kind === 'assistant' ? [item.body.text] : []
        );
        const noted = texts.indexOf('Noted: "Also keep it accessible". I\'ll take that into account.');

        // The bubble is where the agent took the steer, before the work on the tasks: the plan answered it.
        expect(texts.indexOf('Also keep it accessible')).toBeGreaterThan(0);
        expect(noted).toBeGreaterThan(texts.indexOf('Also keep it accessible'));
        expect(texts.findIndex(text => text.startsWith('Starting on REP-1'))).toBeGreaterThan(noted);
    });

    test('a message queued while the orchestrator works is its next turn once it has finished', async () => {
        const { h, chat } = await setup({ fakeSpeed: 0.05 });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'running', 'the run to start');
        h.ok('chat.send', { chatId: chat.id, text: 'Also keep it accessible', mode: 'queue' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish', 15_000);

        const texts = items(h, runId).flatMap(item =>
            item.body.kind === 'user' || item.body.kind === 'assistant' ? [item.body.text] : []
        );

        expect(texts.indexOf('Also keep it accessible')).toBeGreaterThan(
            texts.findIndex(text => text.startsWith('Done: REP-1, REP-2 and REP-3'))
        );
        expect(texts.some(text => text.startsWith('Got it: "Also keep it accessible'))).toBe(true);
    });
});

describe('semi-manual mode', () => {
    test('asks one question before creating tasks and resumes on the answer', async () => {
        const { h, project, chat } = await setup({}, 'semi');
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');

        expect(h.run(runId).statusReason).toBe('Waiting for your answer');
        expect(snapshot(h, project.id).tasks).toEqual([]);
        expect(h.send('chat.setMode', { chatId: chat.id, mode: 'autopilot' })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });

        const question = items(h, runId).find(item => item.body.kind === 'question')!.body as Extract<
            StreamItem['body'],
            { kind: 'question' }
        >;

        expect(question).toMatchObject({
            options: [{ id: 'small', label: 'Small, focused tasks' }, { id: 'single' }],
            recommended: 'small',
        });
        expect(question.answer).toBeUndefined();
        expect(items(h, runId).some(item => item.body.kind === 'tool' && item.body.name === 'ask_user')).toBe(false);

        expect(h.send('run.answer', { runId, questionId: 'qst_nope', answer: 'small' })).toMatchObject({
            ok: false,
            error: { code: 'not_found' },
        });
        expect(h.ok('run.answer', { runId, questionId: question.questionId, answer: 'small' })).toEqual({ runId });
        expect(h.send('run.answer', { runId, questionId: question.questionId, answer: 'single' })).toMatchObject({
            ok: false,
            error: { code: 'conflict' },
        });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish', 8000);

        expect(snapshot(h, project.id).tasks).toHaveLength(3);

        const stream = items(h, runId);

        expect(stream.find(item => item.body.kind === 'question')!.body).toMatchObject({ answer: 'small' });
        expect(
            stream.some(
                item => item.body.kind === 'assistant' && item.body.text.includes('going with: Small, focused tasks')
            )
        ).toBe(true);
        expect(h.send('chat.setMode', { chatId: chat.id, mode: 'autopilot' })).toMatchObject({ ok: true });
    });

    test('autopilot never asks', async () => {
        const { h, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish', 8000);
        expect(items(h, runId).some(item => item.body.kind === 'question')).toBe(false);
    });

    test('cancelling a run that waits for an answer stops it', async () => {
        const { h, chat } = await setup({}, 'semi');
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        h.ok('run.cancel', { runId });
        expect(h.run(runId).status).toBe('cancelled');

        const question = items(h, runId).find(item => item.body.kind === 'question')!.body as { questionId: string };

        expect(h.send('run.answer', { runId, questionId: question.questionId, answer: 'small' })).toMatchObject({
            ok: false,
        });
    });
});

describe('cancelling scripted work', () => {
    test('stops the orchestrator and its sub-agent promptly without failing anything', async () => {
        const { h, project, chat } = await setup({ fakeSpeed: 0.2 });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(
            () => snapshot(h, project.id).runs.some(run => run.origin === 'native' && run.status === 'running'),
            'a running sub-agent',
            15_000
        );
        h.ok('run.cancel', { runId });

        const state = snapshot(h, project.id);

        expect(state.runs.map(run => run.status)).toEqual(['cancelled', 'cancelled']);

        await Bun.sleep(100);

        const settled = h.store.headCursor();

        await Bun.sleep(600);
        expect(h.store.headCursor()).toBe(settled);
        expect(snapshot(h, project.id).runs.every(run => run.status === 'cancelled' && run.finishedAt)).toBe(true);
        expect(h.events().some(event => event.data.type === 'run.upserted' && event.data.run.status === 'failed')).toBe(
            false
        );

        // Work stopped half way: no assistant message is left open, and the tasks stay where the agent put them (no run was assigned to them).
        expect(
            items(h, runId)
                .filter(item => item.body.kind === 'assistant')
                .every(item => item.body.kind === 'assistant' && item.body.done)
        ).toBe(true);

        const categories = new Map(state.statuses.map(status => [status.id, status.category]));

        expect(state.tasks.map(task => categories.get(task.statusId))).toEqual(['active', 'todo', 'todo']);
    });
});

describe('a task started by the user', () => {
    test('opens a chat bound to the task, whose orchestrator completes it itself', async () => {
        const { h, project } = await setup();
        const task = h.ok('task.create', { projectId: project.id, title: 'Fix the footer' }).task;
        const { runId, chatId } = h.ok('task.start', { taskId: task.id });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to finish', 8000);

        const state = snapshot(h, project.id);
        const run = h.run(runId);

        expect(run).toMatchObject({
            role: 'orchestrator',
            rootRunId: runId,
            chatId,
            summary: 'Fix the footer',
            name: 'Orchestrator 01',
        });
        expect(state.chats.find(chat => chat.id === chatId)).toMatchObject({
            title: 'Fix the footer',
            mode: 'autopilot',
            orchestratorRunId: runId,
        });
        expect(state.tasks).toHaveLength(1);
        expect(state.runs.filter(candidate => candidate.origin !== 'native')).toEqual([run]);
        expect(run.result).toContain('REP-1 is done');
        expect(toolItems(items(h, runId)).map(tool => tool.name)).toEqual([
            'task_get',
            'task_update',
            'read_file',
            'Agent',
            'edit_file',
            'task_update',
            'bash',
            'task_update',
        ]);
        expect(categoryTrail(h, project.id, task.id)).toEqual(['todo', 'active', 'review', 'done']);
    });

    test('a task with an unfinished dependency waits blocked', async () => {
        const { h, project } = await setup();
        const first = h.ok('task.create', { projectId: project.id, title: 'First' }).task;
        const second = h.ok('task.create', { projectId: project.id, title: 'Second', dependsOn: [first.id] }).task;
        const { runId } = h.ok('task.start', { taskId: second.id });

        expect(h.run(runId)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });
        h.ok('run.cancel', { runId });
        expect(h.run(runId).status).toBe('cancelled');
    });
});

describe('log and state agree', () => {
    /** Applies events to a project snapshot the way a client does. */
    function fold(base: ProjectSnapshot, events: ClowdyEvent[]): ProjectSnapshot {
        const chats = new Map(base.chats.map(chat => [chat.id, chat]));
        const tasks = new Map(base.tasks.map(task => [task.id, task]));
        const runs = new Map(base.runs.map(run => [run.id, run]));
        const chatLinks = new Map(base.chatTaskLinks.map(link => [`${link.chatId}|${link.taskId}`, link]));
        const runLinks = new Map(
            base.runTaskLinks.map(link => [`${link.runId}|${link.taskId}|${link.relation}`, link])
        );

        for (const { data } of events) {
            if (data.type === 'chat.upserted') {
                chats.set(data.chat.id, data.chat);
            } else if (data.type === 'task.upserted') {
                tasks.set(data.task.id, data.task);
            } else if (data.type === 'task.deleted') {
                tasks.delete(data.taskId);
            } else if (data.type === 'run.upserted') {
                runs.set(data.run.id, data.run);
            } else if (data.type === 'link.chatTask') {
                data.present
                    ? chatLinks.set(`${data.link.chatId}|${data.link.taskId}`, data.link)
                    : chatLinks.delete(`${data.link.chatId}|${data.link.taskId}`);
            } else if (data.type === 'link.runTask') {
                const key = `${data.link.runId}|${data.link.taskId}|${data.link.relation}`;

                data.present ? runLinks.set(key, data.link) : runLinks.delete(key);
            }
        }

        const byId = <T extends { id: string }>(map: Map<string, T>) =>
            [...map.values()].sort((a, b) => a.id.localeCompare(b.id));

        return {
            ...base,
            cursor: events.at(-1)?.cursor ?? base.cursor,
            chats: byId(chats),
            tasks: byId(tasks) as Task[],
            runs: byId(runs) as Run[],
            chatTaskLinks: [...chatLinks.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            runTaskLinks: [...runLinks.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        };
    }

    /** The same state with collections in the order `fold` produces. */
    const normalize = (state: ProjectSnapshot) => fold(state, []);

    test('a snapshot plus the events after its cursor equals the later state, whenever the snapshot was taken', async () => {
        const { h, project, chat } = await setup({ fakeSpeed: 0.05 });
        const taken: ProjectSnapshot[] = [];
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });
        const poll = setInterval(() => taken.push(snapshot(h, project.id)), 7);

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 15_000);
        clearInterval(poll);
        taken.push(snapshot(h, project.id));

        const final = taken.at(-1)!;

        expect(taken.length).toBeGreaterThan(10);
        expect(new Set(taken.map(state => state.cursor)).size).toBeGreaterThan(5);

        for (const state of taken) {
            const rest = h.events(state.cursor);

            expect(rest.every(event => event.cursor > state.cursor)).toBe(true);
            expect(fold(state, rest)).toEqual(normalize(final));
        }

        // The log alone, from nothing, gives the same state.
        const empty: ProjectSnapshot = {
            ...final,
            cursor: 0,
            chats: [],
            tasks: [],
            runs: [],
            chatTaskLinks: [],
            runTaskLinks: [],
        };

        expect(fold(empty, h.events())).toEqual(normalize(final));
        expect(final.cursor).toBe(h.store.headCursor());
    });
});

describe('the fake engine and rewind points', () => {
    test('its chats offer Edit on the first message and Fork on the answer that ends a turn, as an agent that can fork does', async () => {
        const { h, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Say hi' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const read = async () => (await (await h.fetch(`/v1/chats/${chat.id}/items`)).json()) as StreamItem[];
        const items = await read();
        const answers = items.filter(item => item.body.kind === 'assistant');

        expect(items[0]).toMatchObject({ body: { kind: 'user' }, canEdit: true });
        expect(answers.filter(item => item.canFork)).toEqual([answers.at(-1) as StreamItem]);
        expect(items.filter(item => item.canEdit)).toHaveLength(1);

        h.ok('chat.send', { chatId: chat.id, text: 'And again' });
        await waitFor(
            () =>
                h.run(runId).status === 'succeeded' &&
                streamItems(h.store, runId, 0).filter(item => item.body.kind === 'user').length === 2,
            'the second turn',
            8000
        );

        // The follow-up is a message that starts a turn: the one before it ended at a point.
        const later = await read();

        expect(later.filter(item => item.body.kind === 'user').map(item => item.canEdit)).toEqual([true, true]);
        expect(later.filter(item => item.canFork)).toHaveLength(2);
    });
});
