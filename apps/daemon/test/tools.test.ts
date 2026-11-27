import { Database } from 'bun:sqlite';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { getProject } from '../src/db/projects';
import { upsertRun } from '../src/db/runs';
import { getTask } from '../src/db/tasks';
import { appendItem } from '../src/domain/items';
import { taskCommentsPage } from '../src/domain/taskComments';
import { ToolBridge } from '../src/engine/acp/bridge';
import { AgentRegistry } from '../src/engine/acp/registry';
import { toolsFor } from '../src/runs/tools';
import {
    cleanTempDirs,
    latch,
    restartHarness,
    ScriptEngine,
    scriptEngines,
    startHarness,
    untilAborted,
    waitFor,
} from './helpers';

import type { Run } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

/** A session that holds until the test releases it, then ends. The runs of these tests use it to stay alive. */
function holding(hold = latch()): { script: Script; hold: ReturnType<typeof latch> } {
    return {
        hold,
        script: async function* ({ options, number }) {
            yield { type: 'session', sessionId: `s-${number}` };
            await hold.wait(options.signal);
            yield { type: 'done', result: 'finished' };
        },
    };
}

async function setup(
    script: Script = holding().script,
    overrides: Parameters<typeof startHarness>[0] = {},
    mode?: 'semi'
) {
    const engine = new ScriptEngine(script);
    const h = await startHarness(overrides, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id, mode });
    const { store, runs, threads } = h.daemon.services;
    const entity = getProject(store.db, project.id)!;
    const orchestrator = runs.createRun({ project: entity, role: 'orchestrator', chatId: chat.id, summary: 'Plan' });
    const toolsOf = (run: Run) => toolsFor({ store, runs, threads }, run, runs.modeOf(run));
    const exec = async (run: Run, name: string, input: unknown = {}): Promise<any> => {
        const tool = toolsOf(run).find(candidate => candidate.name === name);

        if (!tool) {
            throw new Error(`${run.name} has no ${name} tool`);
        }

        return tool.execute(input, new AbortController().signal);
    };
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
        (await exec(orchestrator, 'task_create', { title, ...extra })).task;

    return { h, engine, project, chat, entity, orchestrator, toolsOf, exec, task };
}

describe('the tool vocabulary', () => {
    test('an orchestrator has the task, thread and chat tools, and ask_user only in semi-manual', async () => {
        const { orchestrator, toolsOf } = await setup();
        const names = (run: Run) => toolsOf(run).map(tool => tool.name);
        const threads = [
            'thread_spawn',
            'thread_tell',
            'thread_stop',
            'thread_wait',
            'thread_output',
            'thread_log',
            'thread_list',
        ];

        expect(names(orchestrator)).toEqual([
            'task_get',
            'task_list',
            'task_comments',
            'task_create',
            'task_update',
            'task_comment',
            'task_archive',
            'task_unarchive',
            ...threads,
            'chat_read',
        ]);

        const semi = await setup(undefined, {}, 'semi');

        expect(semi.toolsOf(semi.orchestrator).map(tool => tool.name)).toEqual([
            'task_get',
            'task_list',
            'task_comments',
            'task_create',
            'task_update',
            'task_comment',
            'task_archive',
            'task_unarchive',
            ...threads,
            'chat_read',
            'ask_user',
        ]);

        // Every tool brings its schema in both forms and says how to use it.
        for (const tool of toolsOf(orchestrator)) {
            expect(tool.description.length).toBeGreaterThan(40);
            expect(tool.inputSchema).toMatchObject({ type: 'object' });
            expect(tool.schema).toBeDefined();
        }
    });

    test('the task tools are shell commands unless the agent uses MCP; the thread and chat tools are always shell commands', async () => {
        const { h, orchestrator } = await setup();
        const { store, runs, threads } = h.daemon.services;
        const tools = (channel?: 'cli' | 'mcp') => toolsFor({ store, runs, threads }, orchestrator, 'semi', channel);
        const shell = (channel?: 'cli' | 'mcp') =>
            tools(channel)
                .filter(tool => tool.cli)
                .map(tool => tool.name);
        const taskTools = [
            'task_get',
            'task_list',
            'task_comments',
            'task_create',
            'task_update',
            'task_comment',
            'task_archive',
            'task_unarchive',
        ];
        const chatTools = [
            'thread_spawn',
            'thread_tell',
            'thread_stop',
            'thread_wait',
            'thread_output',
            'thread_log',
            'thread_list',
            'chat_read',
        ];

        expect(shell()).toEqual([...taskTools, ...chatTools]);
        expect(shell('cli')).toEqual([...taskTools, ...chatTools]);
        expect(shell('mcp')).toEqual(chatTools);
        expect(tools('mcp').map(tool => tool.name)).toEqual(tools('cli').map(tool => tool.name));
        expect(tools('mcp').find(tool => tool.name === 'task_get')?.cli).toBeUndefined();

        // A bridge lists each door its own tools: in autopilot an agent on the shell route has no MCP server at all.
        const bridge = new ToolBridge();

        try {
            const signal = new AbortController().signal;
            const viaShell = bridge.register(
                toolsFor({ store, runs, threads }, orchestrator, 'autopilot', 'cli'),
                signal
            );
            const viaMcp = bridge.register(
                toolsFor({ store, runs, threads }, orchestrator, 'autopilot', 'mcp'),
                signal
            );
            const listed = async (url: string, auth: string, path: string) =>
                (
                    (await (await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${auth}` } })).json()) as {
                        tools: { name: string }[];
                    }
                ).tools.map(tool => tool.name);

            expect(viaShell.server).toBeUndefined();
            expect(viaMcp.server).toBeDefined();
            expect(viaShell.cli && (await listed(viaShell.cli.url, viaShell.cli.auth, '/cli/tools'))).toEqual([
                ...taskTools,
                ...chatTools,
            ]);
            expect(viaMcp.cli && (await listed(viaMcp.cli.url, viaMcp.cli.auth, '/cli/tools'))).toEqual(chatTools);
            expect(viaMcp.cli && (await listed(viaMcp.cli.url, viaMcp.cli.auth, '/tools'))).toEqual(taskTools);
        } finally {
            bridge.stop();
        }
    });

    test('tasks come back with key, status name and category, dependencies and dependents as key, title and status, and active runs; task_list adds the statuses', async () => {
        const { exec, orchestrator, task, h, project } = await setup();
        const first = await task('Groundwork', { description: 'Outcome: x' });
        const second = await task('Build', { dependsOn: [first.key] });
        const { statuses, tasks } = await exec(orchestrator, 'task_list', { sort: 'number' });

        expect(statuses.map((status: { name: string; category: string }) => [status.name, status.category])).toEqual([
            ['To do', 'todo'],
            ['In progress', 'active'],
            ['Review', 'review'],
            ['Done', 'done'],
            ['Canceled', 'canceled'],
        ]);
        expect(statuses.every((status: { id: string }) => status.id.startsWith('sts_'))).toBe(true);
        expect(tasks.map((item: { key: string }) => item.key)).toEqual(['REP-1', 'REP-2']);

        const { task: got } = await exec(orchestrator, 'task_get', { taskId: second.key });

        expect(got).toEqual({
            id: second.id,
            key: 'REP-2',
            title: 'Build',
            description: '',
            status: 'To do',
            category: 'todo',
            dependsOn: [{ key: 'REP-1', title: 'Groundwork', status: 'To do' }],
            blocks: [],
            activeRuns: [],
            createdBy: 'agent',
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
            updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        });
        expect((await exec(orchestrator, 'task_get', { taskId: first.id })).task).toMatchObject({
            description: 'Outcome: x',
            blocks: [{ key: 'REP-2', title: 'Build', status: 'To do' }],
        });

        // The run of a chat started from the task shows up under activeRuns, and its start moves the task to In progress.
        const started = h.ok('task.start', { taskId: first.id });

        await waitFor(() => h.run(started.runId).status === 'running', "the task's chat to start");
        expect((await exec(orchestrator, 'task_get', { taskId: first.key })).task.activeRuns).toEqual([
            { runId: started.runId, name: 'Orchestrator 02', role: 'orchestrator', status: 'running' },
        ]);

        // A run with a request open to the person reads waiting_user to the agent that asks, whatever its own status.
        const working = h.run(started.runId);

        upsertRun(h.store.db, { ...working, awaitingUser: true });
        expect((await exec(orchestrator, 'task_get', { taskId: first.key })).task.activeRuns).toEqual([
            { runId: started.runId, name: 'Orchestrator 02', role: 'orchestrator', status: 'waiting_user' },
        ]);
        upsertRun(h.store.db, working);

        // Filters
        expect(
            (await exec(orchestrator, 'task_list', { query: 'BUILD' })).tasks.map((item: { key: string }) => item.key)
        ).toEqual(['REP-2']);
        expect(
            (await exec(orchestrator, 'task_list', { status: ['In progress'] })).tasks.map(
                (item: { key: string }) => item.key
            )
        ).toEqual(['REP-1']);
        expect(
            (await exec(orchestrator, 'task_list', { running: true })).tasks.map((item: { key: string }) => item.key)
        ).toEqual(['REP-1']);
        expect(
            (await exec(orchestrator, 'task_list', { ready: true })).tasks.map((item: { key: string }) => item.key)
        ).toEqual(['REP-1']);
        expect((await exec(orchestrator, 'task_list', { blocked: true })).tasks).toMatchObject([
            { key: 'REP-2', blockedBy: ['REP-1'] },
        ]);
        expect(project.id).toBeTruthy();
        expect(h.store.headCursor()).toBeGreaterThan(0);
    });

    test('task_list shows the work in flight and counts the rest; a page has a cursor, and only the first one lists the statuses', async () => {
        const { exec, orchestrator, task } = await setup();

        const { statuses } = await exec(orchestrator, 'task_list');
        const closed = statuses.find((status: { category: string }) => status.category === 'done').id;

        for (let index = 0; index < 30; index++) {
            await task(`Finished ${index}`, { status: closed });
        }

        const open = await task('Open one');
        const first = await exec(orchestrator, 'task_list');

        expect(first.tasks.map((item: { key: string }) => item.key)).toEqual([open.key]);
        expect(first).toMatchObject({ total: 1, shown: 1, counts: { todo: 1, done: 30 } });
        expect(first.nextCursor).toBeUndefined();

        const everything = await exec(orchestrator, 'task_list', { all: true, limit: 20 });

        expect(everything).toMatchObject({ total: 31, shown: 20 });
        expect(everything.statuses).toHaveLength(5);

        const rest = await exec(orchestrator, 'task_list', { all: true, limit: 20, cursor: everything.nextCursor });

        expect(rest).toMatchObject({ total: 31, shown: 11 });
        expect(rest.statuses).toBeUndefined();
        expect(rest.nextCursor).toBeUndefined();
        expect(
            (await exec(orchestrator, 'task_list', { status: ['done'], sort: 'number', limit: 2 })).tasks.map(
                (item: { key: string }) => item.key
            )
        ).toEqual(['REP-1', 'REP-2']);
        expect((await exec(orchestrator, 'task_list', { all: true, status: ['Done', 'todo'] })).total).toBe(31);
        expect((await exec(orchestrator, 'task_list', { all: true, status: ['review'] })).total).toBe(0);
        expect(
            (await exec(orchestrator, 'task_list', { query: 'finished 7' })).tasks.map(
                (item: { title: string }) => item.title
            )
        ).toEqual(['Finished 7']);
        expect((await exec(orchestrator, 'task_list', { mine: true, all: true, limit: 1 })).total).toBe(31);
        await expect(exec(orchestrator, 'task_list', { updatedSince: 'last week' })).rejects.toThrow(/is not a time/);
        await expect(exec(orchestrator, 'task_list', { limit: 500 })).rejects.toThrow(/Invalid input for task_list/);
    });

    test('task_list rows leave the description out; task_get has it whole', async () => {
        const { exec, orchestrator, task } = await setup();
        const long = 'x'.repeat(1000);
        const created = await task('Long', { description: long });

        expect((await exec(orchestrator, 'task_list')).tasks[0]).not.toHaveProperty('description');
        expect((await exec(orchestrator, 'task_get', { taskId: created.key })).task.description).toBe(long);
    });

    test('a status may be given as an id, a name or a category, in any case; a wrong one lists what exists; the old statusId is refused', async () => {
        const { exec, orchestrator, task } = await setup();
        const { statuses } = await exec(orchestrator, 'task_list');
        const byCategory = (category: string) =>
            statuses.find((status: { category: string }) => status.category === category);
        const first = await task('A', { status: byCategory('active').id });

        expect(first.category).toBe('active');
        expect((await task('B', { status: 'in PROGRESS' })).category).toBe('active');
        expect((await task('C', { status: 'Review' })).status).toBe('Review');
        expect((await task('D', { status: 'DONE' })).category).toBe('done');

        const moved = await exec(orchestrator, 'task_update', { taskId: first.key, status: 'canceled' });

        expect(moved.task.category).toBe('canceled');
        await expect(exec(orchestrator, 'task_update', { taskId: first.key, status: 'sts_nope' })).rejects.toThrow(
            /Unknown status "sts_nope"\. Use the id of one of: sts_\w+ \(To do, todo\); .*\(Canceled, canceled\)/
        );
        await expect(
            exec(orchestrator, 'task_update', { taskId: first.key, statusId: byCategory('done').id })
        ).rejects.toThrow(/Invalid input for task_update.*statusId/s);
        await expect(task('E', { dependsOn: ['REP-99'] })).rejects.toThrow(/does not exist/);
        await expect(exec(orchestrator, 'task_get', {})).rejects.toThrow(/Invalid input for task_get/);
    });

    test('task_update changes any field of a task by key and refuses a circular dependency', async () => {
        const { exec, orchestrator, task } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const { task: updated } = await exec(orchestrator, 'task_update', {
            taskId: a.key,
            title: 'A2',
            description: 'new text',
            dependsOn: [],
        });

        expect(updated).toMatchObject({ title: 'A2', description: 'new text', dependsOn: [] });
        await expect(exec(orchestrator, 'task_update', { taskId: a.key, dependsOn: [b.key] })).rejects.toThrow(
            /Circular dependency/
        );
        await expect(exec(orchestrator, 'task_update', { taskId: a.key, addDependsOn: [b.key] })).rejects.toThrow(
            /Circular dependency/
        );
    });

    test('task_update has no append: a stale call is an error of the strict schema, and a note goes in a comment', async () => {
        const { exec, orchestrator, task } = await setup();
        const a = await task('A', { description: 'Outcome: x\n' });

        await expect(
            exec(orchestrator, 'task_update', { taskId: a.key, append: 'Verification: passed' })
        ).rejects.toThrow(/Invalid input for task_update.*append/s);
        await expect(
            exec(orchestrator, 'task_update', { taskId: a.key, description: 'x', append: 'y' })
        ).rejects.toThrow(/Invalid input for task_update.*append/s);
        expect((await exec(orchestrator, 'task_get', { taskId: a.key })).task.description).toBe('Outcome: x\n');

        await exec(orchestrator, 'task_comment', { taskId: a.key, body: 'Verification: passed' });

        const read = (await exec(orchestrator, 'task_get', { taskId: a.key })).task;

        expect(read.description).toBe('Outcome: x\n');
        expect(read.latestComments.map((comment: { body: string }) => comment.body)).toEqual(['Verification: passed']);
    });

    test('addDependsOn and removeDependsOn change the list by tasks; dependsOn replaces it and cannot be combined with them', async () => {
        const { exec, orchestrator, task } = await setup();
        const [a, b, c] = [await task('A'), await task('B'), await task('C')];
        const target = await task('Target', { dependsOn: [a.key] });
        const keysOf = (result: { task: { dependsOn: { key: string }[] } }) =>
            result.task.dependsOn.map(item => item.key);

        expect(
            keysOf(await exec(orchestrator, 'task_update', { taskId: target.key, addDependsOn: [b.key, a.key] }))
        ).toEqual(['REP-1', 'REP-2']);
        expect(
            keysOf(await exec(orchestrator, 'task_update', { taskId: target.key, removeDependsOn: [a.key, c.key] }))
        ).toEqual(['REP-2']);
        expect(
            keysOf(
                await exec(orchestrator, 'task_update', {
                    taskId: target.key,
                    addDependsOn: [c.key],
                    removeDependsOn: [b.key],
                })
            )
        ).toEqual(['REP-3']);
        expect(keysOf(await exec(orchestrator, 'task_update', { taskId: target.key, dependsOn: [a.key] }))).toEqual([
            'REP-1',
        ]);
        await expect(
            exec(orchestrator, 'task_update', { taskId: target.key, dependsOn: [a.key], addDependsOn: [b.key] })
        ).rejects.toThrow(/do not combine it/);
    });

    test('blocks makes existing tasks wait for the new one, and a task that already feeds the new one is refused', async () => {
        const { exec, orchestrator, task } = await setup();
        const waiting = await task('Waiting');
        const base = await task('Base');
        const prerequisite = await task('Prerequisite', { blocks: [waiting.key] });

        expect((await exec(orchestrator, 'task_get', { taskId: waiting.key })).task.dependsOn).toEqual([
            { key: prerequisite.key, title: 'Prerequisite', status: 'To do' },
        ]);
        expect(prerequisite.blocks).toEqual([{ key: waiting.key, title: 'Waiting', status: 'To do' }]);
        expect((await exec(orchestrator, 'task_get', { taskId: prerequisite.key })).task.blocks).toEqual([
            { key: waiting.key, title: 'Waiting', status: 'To do' },
        ]);
        // The refusal comes on the second entry: the first one's new dependency and the task itself are rolled back with it.
        const other = await task('Other');

        await expect(task('Loop', { dependsOn: [base.key], blocks: [other.key, base.key] })).rejects.toThrow(
            /Circular dependency/
        );
        expect((await exec(orchestrator, 'task_list', { query: 'Loop', all: true })).total).toBe(0);
        expect((await exec(orchestrator, 'task_get', { taskId: other.key })).task.dependsOn).toEqual([]);
    });

    test('a task created by an orchestrator is linked to its chat and to the run that created it', async () => {
        const { h, task, chat, orchestrator } = await setup();
        const created = await task('Linked');

        expect(h.store.db.query('SELECT chat_id FROM chat_task_links WHERE task_id = ?').all(created.id)).toEqual([
            { chat_id: chat.id },
        ]);
        expect(
            h.store.db.query('SELECT run_id, relation FROM run_task_links WHERE task_id = ?').all(created.id)
        ).toEqual([{ run_id: orchestrator.id, relation: 'created' }]);
    });
});

describe('tasks inside tasks', () => {
    const keysOf = (rows: { key: string }[]) => rows.map(row => row.key);

    test('task_create puts the task inside another by key, and task_update moves it and takes it out again', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');
        const stage = await task('Stage', { parent: epic.key });
        const other = await task('Other epic');

        expect(stage.parent).toEqual({ key: epic.key, title: 'Epic' });
        expect(epic).not.toHaveProperty('parent');
        expect((await exec(orchestrator, 'task_update', { taskId: stage.key, parent: other.key })).task.parent).toEqual(
            { key: other.key, title: 'Other epic' }
        );
        expect(
            (await exec(orchestrator, 'task_update', { taskId: stage.key, clearParent: true })).task
        ).not.toHaveProperty('parent');
        expect((await exec(orchestrator, 'task_update', { taskId: stage.id, parent: epic.id })).task.parent.key).toBe(
            epic.key
        );
        // clearParent: false leaves the parent alone.
        expect(
            (await exec(orchestrator, 'task_update', { taskId: stage.key, clearParent: false, title: 'Stage 2' })).task
                .parent.key
        ).toBe(epic.key);
    });

    test('a parent that is the task, its descendant, too deep, missing or in both fields is refused with the reason', async () => {
        const { exec, orchestrator, task } = await setup();
        const a = await task('A');
        const child = await task('B', { parent: a.key });

        await expect(exec(orchestrator, 'task_update', { taskId: a.key, parent: a.key })).rejects.toThrow(
            'cannot be its own parent'
        );
        await expect(exec(orchestrator, 'task_update', { taskId: a.key, parent: child.key })).rejects.toThrow(
            `Task ${child.key} is inside ${a.key}, so it cannot be its parent`
        );
        await expect(task('x', { parent: 'REP-99' })).rejects.toThrow(/does not exist/);
        await expect(exec(orchestrator, 'task_update', { taskId: a.key, parent: 'REP-99' })).rejects.toThrow(
            /does not exist/
        );
        await expect(
            exec(orchestrator, 'task_update', { taskId: a.key, parent: child.key, clearParent: true })
        ).rejects.toThrow('give one of them');

        let last = a;

        for (let level = 2; level <= 8; level++) {
            last = await task(`Level ${level}`, { parent: last.key });
        }

        await expect(task('Level 9', { parent: last.key })).rejects.toThrow(
            /would reach level 9, and a tree has at most 8 levels/
        );
    });

    test("a parent from another project is refused, by key as unknown and by id as another project's, and no task is left behind", async () => {
        const { exec, orchestrator, task, h } = await setup();
        const other = h.openRepo('other');
        const foreign = h.ok('task.create', { projectId: other.id, title: 'Foreign' }).task;

        await expect(task('Orphan', { parent: foreign.key })).rejects.toThrow(/does not exist/);
        await expect(task('Orphan', { parent: foreign.id })).rejects.toThrow(/belongs to another space/);
        expect((await exec(orchestrator, 'task_list', { all: true })).total).toBe(0);
    });

    test('task_get names the parent, lists the children with a total, counts the tasks below by category and the checklist, and says nothing of them for a leaf', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { description: 'Plan\n- [x] design\n- [ ] build' });
        const stage = await task('Stage', { parent: epic.key });
        const done = await task('Done stage', { parent: epic.key, status: 'done' });
        const step = await task('Step', { parent: stage.key, status: 'active' });
        const leaf = await task('Leaf');

        const { task: got } = await exec(orchestrator, 'task_get', { taskId: epic.key });

        expect(got).toMatchObject({
            checklist: { done: 1, total: 2 },
            children: [
                { key: stage.key, title: 'Stage', status: 'To do' },
                { key: done.key, title: 'Done stage', status: 'Done' },
            ],
            childrenTotal: 2,
            descendants: { todo: 1, active: 1, done: 1 },
        });
        expect(got).not.toHaveProperty('parent');
        expect((await exec(orchestrator, 'task_get', { taskId: step.key })).task).toMatchObject({
            parent: { key: stage.key, title: 'Stage' },
        });
        expect((await exec(orchestrator, 'task_get', { taskId: step.key })).task).not.toHaveProperty('children');
        expect((await exec(orchestrator, 'task_get', { taskId: stage.key })).task).toMatchObject({
            parent: { key: epic.key, title: 'Epic' },
            children: [{ key: step.key, status: 'In progress' }],
            childrenTotal: 1,
            descendants: { active: 1 },
        });

        for (const field of ['parent', 'children', 'childrenTotal', 'descendants', 'checklist']) {
            expect((await exec(orchestrator, 'task_get', { taskId: leaf.key })).task).not.toHaveProperty(field);
        }
    });

    test('task_get names at most 50 children and still says how many there are', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');

        for (let index = 0; index < 52; index++) {
            await task(`Child ${index}`, { parent: epic.key, status: index < 10 ? 'done' : 'todo' });
        }

        const { task: got } = await exec(orchestrator, 'task_get', { taskId: epic.key });

        expect(got.children).toHaveLength(50);
        expect(got.children[0].title).toBe('Child 0');
        expect(got.children[49].title).toBe('Child 49');
        expect(got.childrenTotal).toBe(52);
        expect(got.descendants).toEqual({ todo: 42, done: 10 });
    });

    test('task_list rows carry parent, children and checklist, and parent, under and roots list a part of the tree with its own counts', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { status: 'active' });
        const stage = await task('Stage', { parent: epic.key, description: '- [x] a\n- [ ] b' });
        const closed = await task('Closed stage', { parent: epic.key, status: 'done' });
        const step = await task('Step', { parent: stage.key });
        const root = await task('Another root');

        const whole = await exec(orchestrator, 'task_list', { sort: 'number' });

        expect(keysOf(whole.tasks)).toEqual([epic.key, stage.key, step.key, root.key]);
        expect(whole.tasks[0]).toMatchObject({ key: epic.key, children: { todo: 1, done: 1 } });
        expect(whole.tasks[0]).not.toHaveProperty('parent');
        expect(whole.tasks[1]).toMatchObject({
            key: stage.key,
            parent: epic.key,
            children: { todo: 1 },
            checklist: { done: 1, total: 2 },
        });
        expect(whole.tasks[2]).toMatchObject({ key: step.key, parent: stage.key });
        expect(whole.tasks[2]).not.toHaveProperty('children');
        expect(whole.counts).toMatchObject({ todo: 3, active: 1, done: 1 });

        const direct = await exec(orchestrator, 'task_list', { parent: epic.key, sort: 'number' });

        expect(keysOf(direct.tasks)).toEqual([stage.key]);
        expect(direct).toMatchObject({ total: 1, counts: { todo: 1, done: 1, active: 0 } });
        expect(
            keysOf((await exec(orchestrator, 'task_list', { parent: epic.key, all: true, sort: 'number' })).tasks)
        ).toEqual([stage.key, closed.key]);
        expect(
            keysOf((await exec(orchestrator, 'task_list', { under: epic.key, all: true, sort: 'number' })).tasks)
        ).toEqual([stage.key, closed.key, step.key]);
        expect(keysOf((await exec(orchestrator, 'task_list', { under: epic.key, sort: 'number' })).tasks)).toEqual([
            stage.key,
            step.key,
        ]);
        expect((await exec(orchestrator, 'task_list', { under: epic.id, all: true })).counts).toMatchObject({
            todo: 2,
            done: 1,
            active: 0,
        });
        expect(keysOf((await exec(orchestrator, 'task_list', { roots: true, sort: 'number' })).tasks)).toEqual([
            epic.key,
            root.key,
        ]);
        expect((await exec(orchestrator, 'task_list', { roots: true })).counts).toMatchObject({
            todo: 1,
            active: 1,
            done: 0,
        });
        await expect(exec(orchestrator, 'task_list', { parent: epic.key, roots: true })).rejects.toThrow(
            'give one of them'
        );
        await expect(exec(orchestrator, 'task_list', { under: 'REP-99' })).rejects.toThrow(/does not exist/);
    });

    test("deleting a parent shows in the list at once: its children are roots or the grandparent's", async () => {
        const { exec, orchestrator, task, h } = await setup();
        const epic = await task('Epic');
        const stage = await task('Stage', { parent: epic.key });
        const step = await task('Step', { parent: stage.key });

        h.ok('task.delete', { taskId: stage.id });
        expect((await exec(orchestrator, 'task_get', { taskId: step.key })).task.parent).toEqual({
            key: epic.key,
            title: 'Epic',
        });
        h.ok('task.delete', { taskId: epic.id });
        expect(keysOf((await exec(orchestrator, 'task_list', { roots: true })).tasks)).toEqual([step.key]);
    });

    test('a canceled dependency is resolved: the waiting task is ready, not blocked, and has no blockedBy', async () => {
        const { exec, orchestrator, task } = await setup();
        const first = await task('First');
        const second = await task('Second', { dependsOn: [first.key] });

        expect((await exec(orchestrator, 'task_list', { blocked: true })).tasks).toMatchObject([
            { key: second.key, blockedBy: [first.key] },
        ]);
        await exec(orchestrator, 'task_update', { taskId: first.key, status: 'canceled' });
        expect((await exec(orchestrator, 'task_list', { blocked: true })).tasks).toEqual([]);
        expect(keysOf((await exec(orchestrator, 'task_list', { ready: true })).tasks)).toEqual([second.key]);
        expect((await exec(orchestrator, 'task_list', { ready: true })).tasks[0]).not.toHaveProperty('blockedBy');
    });

    test('the tools say how to spell the parent, and refuse a field they do not have', async () => {
        const { orchestrator, toolsOf } = await setup();
        const tool = (name: string) => toolsOf(orchestrator).find(candidate => candidate.name === name)!;
        const properties = (name: string) =>
            (tool(name).inputSchema as { properties: Record<string, { description?: string }> }).properties;

        expect(Object.keys(properties('task_create'))).toContain('parent');
        expect(Object.keys(properties('task_update'))).toEqual(expect.arrayContaining(['parent', 'clearParent']));
        expect(Object.keys(properties('task_list'))).toEqual(expect.arrayContaining(['parent', 'under', 'roots']));
        expect(properties('task_update').clearParent.description).toContain('top-level');
        await expect(
            tool('task_update').execute({ taskId: 'REP-1', parentId: 'REP-2' }, new AbortController().signal)
        ).rejects.toThrow(/Invalid input for task_update.*parentId/s);
    });
});

describe('task comments', () => {
    const iso = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    test("task_comment writes the comment as the run, and the person's comments from the app read as user", async () => {
        const { exec, orchestrator, task, h } = await setup();
        const epic = await task('Epic');
        const answer = await exec(orchestrator, 'task_comment', {
            taskId: epic.key,
            body: 'Found the cause.\n\n- the cache key',
        });

        expect(answer).toEqual({
            comment: {
                id: expect.stringMatching(/^cmt_/),
                author: 'agent',
                createdAt: iso,
                body: 'Found the cause.\n\n- the cache key',
            },
            total: 1,
        });
        expect(answer.comment).not.toHaveProperty('editedAt');

        const stored = taskCommentsPage(h.store, epic.id).comments;

        expect(stored).toEqual([
            expect.objectContaining({
                id: answer.comment.id,
                taskId: epic.id,
                author: { kind: 'run', runId: orchestrator.id },
                body: 'Found the cause.\n\n- the cache key',
            }),
        ]);
        expect(
            h
                .events()
                .filter(event => event.data.type === 'task.comment.upserted')
                .map(event => event.data)
        ).toEqual([{ type: 'task.comment.upserted', comment: stored[0] }]);

        h.ok('task.comment.add', { taskId: epic.id, body: 'Thanks' });

        const { comments } = await exec(orchestrator, 'task_comments', { taskId: epic.key });

        expect(comments.map((comment: { author: string; body: string }) => [comment.author, comment.body])).toEqual([
            ['agent', 'Found the cause.\n\n- the cache key'],
            ['user', 'Thanks'],
        ]);
        expect(taskCommentsPage(h.store, epic.id).comments.map(comment => comment.author)).toEqual([
            { kind: 'run', runId: orchestrator.id },
            { kind: 'user' },
        ]);
    });

    test('task_comment takes a key or an id, refuses an empty body, a task that does not exist, a task of another project and a field it does not have', async () => {
        const { exec, orchestrator, task, h, toolsOf } = await setup();
        const epic = await task('Epic');
        const elsewhere = h.openRepo('elsewhere');
        const foreign = h.ok('task.create', { projectId: elsewhere.id, title: 'Foreign' }).task;

        expect((await exec(orchestrator, 'task_comment', { taskId: epic.id, body: 'By id' })).total).toBe(1);
        await expect(exec(orchestrator, 'task_comment', { taskId: epic.key, body: '' })).rejects.toThrow(
            'A comment cannot be empty'
        );
        await expect(exec(orchestrator, 'task_comment', { taskId: epic.key, body: '  \n ' })).rejects.toThrow(
            'A comment cannot be empty'
        );
        await expect(exec(orchestrator, 'task_comment', { taskId: 'REP-99', body: 'x' })).rejects.toThrow(
            /does not exist/
        );
        await expect(exec(orchestrator, 'task_comment', { taskId: foreign.id, body: 'x' })).rejects.toThrow(
            /belongs to another space/
        );
        await expect(exec(orchestrator, 'task_comment', { taskId: epic.key, text: 'x', body: 'y' })).rejects.toThrow(
            /Invalid input for task_comment.*text/s
        );
        await expect(exec(orchestrator, 'task_comment', { taskId: epic.key })).rejects.toThrow(
            /Invalid input for task_comment/
        );
        expect(taskCommentsPage(h.store, epic.id).total).toBe(1);

        // Agents write and read; the person edits and deletes.
        expect(
            toolsOf(orchestrator)
                .map(tool => tool.name)
                .filter(name => name.includes('comment'))
        ).toEqual(['task_comments', 'task_comment']);
    });

    test('task_get names no comments for a task without any, and with some gives their count and the last three, oldest first', async () => {
        const { exec, orchestrator, task, h } = await setup();
        const epic = await task('Epic');

        expect((await exec(orchestrator, 'task_get', { taskId: epic.key })).task).not.toHaveProperty('commentCount');
        expect((await exec(orchestrator, 'task_get', { taskId: epic.key })).task).not.toHaveProperty('latestComments');

        for (const body of ['One', 'Two', 'Three', 'Four', 'Five']) {
            await exec(orchestrator, 'task_comment', { taskId: epic.key, body });
        }

        const { task: got } = await exec(orchestrator, 'task_get', { taskId: epic.key });

        expect(got.commentCount).toBe(5);
        expect(got.latestComments).toEqual([
            { id: expect.stringMatching(/^cmt_/), author: 'agent', createdAt: iso, body: 'Three' },
            { id: expect.stringMatching(/^cmt_/), author: 'agent', createdAt: iso, body: 'Four' },
            { id: expect.stringMatching(/^cmt_/), author: 'agent', createdAt: iso, body: 'Five' },
        ]);

        // A body edited by the person shows its edit time; one deleted is not counted.
        const [, , three] = taskCommentsPage(h.store, epic.id).comments;

        h.ok('task.comment.edit', { taskId: epic.id, commentId: three.id, body: 'Three, edited' });
        h.ok('task.comment.delete', { taskId: epic.id, commentId: taskCommentsPage(h.store, epic.id).comments[4].id });

        const after = (await exec(orchestrator, 'task_get', { taskId: epic.key })).task;

        expect(after.commentCount).toBe(4);
        expect(after.latestComments.map((comment: { body: string }) => comment.body)).toEqual([
            'Two',
            'Three, edited',
            'Four',
        ]);
        expect(after.latestComments[1]).toEqual({
            id: three.id,
            author: 'agent',
            createdAt: iso,
            editedAt: iso,
            body: 'Three, edited',
        });
    });

    test('task_get cuts a long comment to a short preview with an ellipsis and task_comments gives it whole', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');
        const long = `${'word '.repeat(200)}end`;
        const short = 'y'.repeat(300);

        await exec(orchestrator, 'task_comment', { taskId: epic.key, body: long });
        await exec(orchestrator, 'task_comment', { taskId: epic.key, body: short });

        const { latestComments } = (await exec(orchestrator, 'task_get', { taskId: epic.key })).task;

        expect(latestComments[0].body).toHaveLength(300);
        expect(latestComments[0].body.endsWith('…')).toBe(true);
        expect(long.startsWith(latestComments[0].body.slice(0, -1))).toBe(true);
        // A body of exactly the preview's length is whole.
        expect(latestComments[1].body).toBe(short);

        const { comments } = await exec(orchestrator, 'task_comments', { taskId: epic.key });

        expect(comments.map((comment: { body: string }) => comment.body)).toEqual([long, short]);
    });

    test('task_get leaves out an emoji that the cut of the preview would split, so the preview stays valid text', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');

        // The emoji is two UTF-16 units at 298 and 299; the preview keeps 299 units less the ellipsis.
        await exec(orchestrator, 'task_comment', { taskId: epic.key, body: `${'x'.repeat(298)}\u{1F600} and more` });

        const [preview] = (await exec(orchestrator, 'task_get', { taskId: epic.key })).task.latestComments;

        expect(preview.body).toBe(`${'x'.repeat(298)}…`);
        expect(preview.body.isWellFormed()).toBe(true);
    });

    test('task_get of a parent with comments and children keeps every field it had', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');

        await task('Stage', { parent: epic.key });

        const plain = (await exec(orchestrator, 'task_get', { taskId: epic.key })).task;

        await exec(orchestrator, 'task_comment', { taskId: epic.key, body: 'Note' });

        const { commentCount, latestComments, ...rest } = (await exec(orchestrator, 'task_get', { taskId: epic.key }))
            .task;

        expect(commentCount).toBe(1);
        expect(latestComments).toHaveLength(1);
        expect(rest).toEqual(plain);

        // The answers of the tools that change a task do not carry comments: only a read does.
        expect(
            (await exec(orchestrator, 'task_update', { taskId: epic.key, title: 'Epic 2' })).task
        ).not.toHaveProperty('commentCount');
    });

    test('task_comments pages oldest first with total, shown and a cursor, the body whole, 25 a page unless limit says otherwise, at most 100', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');
        const other = await task('Other');
        const long = 'z'.repeat(5000);

        for (let index = 1; index <= 30; index++) {
            await exec(orchestrator, 'task_comment', {
                taskId: epic.key,
                body: index === 1 ? long : `Comment ${index}`,
            });
        }

        await exec(orchestrator, 'task_comment', { taskId: other.key, body: 'Elsewhere' });

        const first = await exec(orchestrator, 'task_comments', { taskId: epic.key });

        expect(Object.keys(first)).toEqual(['comments', 'total', 'shown', 'nextCursor']);
        expect(first).toMatchObject({ total: 30, shown: 25 });
        expect(first.comments[0]).toEqual({
            id: expect.stringMatching(/^cmt_/),
            author: 'agent',
            createdAt: iso,
            body: long,
        });
        expect(first.comments.at(-1).body).toBe('Comment 25');

        const rest = await exec(orchestrator, 'task_comments', { taskId: epic.key, cursor: first.nextCursor });

        expect(Object.keys(rest)).toEqual(['comments', 'total', 'shown']);
        expect(rest).toMatchObject({ total: 30, shown: 5 });
        expect(rest.comments.map((comment: { body: string }) => comment.body)).toEqual([
            'Comment 26',
            'Comment 27',
            'Comment 28',
            'Comment 29',
            'Comment 30',
        ]);

        const small = await exec(orchestrator, 'task_comments', { taskId: epic.key, limit: 2 });

        expect(small).toMatchObject({ total: 30, shown: 2, nextCursor: expect.any(String) });
        expect(await exec(orchestrator, 'task_comments', { taskId: epic.key, limit: 100 })).toMatchObject({
            shown: 30,
        });
        expect(await exec(orchestrator, 'task_comments', { taskId: other.key })).toEqual({
            comments: [expect.objectContaining({ body: 'Elsewhere' })],
            total: 1,
            shown: 1,
        });

        await expect(exec(orchestrator, 'task_comments', { taskId: epic.key, limit: 101 })).rejects.toThrow(
            /Invalid input for task_comments/
        );
        await expect(exec(orchestrator, 'task_comments', { taskId: epic.key, limit: 0 })).rejects.toThrow(
            /Invalid input for task_comments/
        );
        await expect(exec(orchestrator, 'task_comments', { taskId: epic.key, cursor: 'nope' })).rejects.toThrow(
            'is not a cursor'
        );
        await expect(exec(orchestrator, 'task_comments', { taskId: 'REP-99' })).rejects.toThrow(/does not exist/);
    });

    test('a task without comments reads as an empty page', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');

        expect(await exec(orchestrator, 'task_comments', { taskId: epic.key })).toEqual({
            comments: [],
            total: 0,
            shown: 0,
        });
    });
});

describe('the archive', () => {
    const keysOf = (rows: { key: string }[]) => rows.map(row => row.key);
    const iso = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    test('task_archive archives closed tasks by key with everything inside them and answers the keys; task_unarchive brings them back with the same batch', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { status: 'done' });
        const stage = await task('Stage', { parent: epic.key, status: 'done' });
        const step = await task('Step', { parent: stage.key, status: 'canceled' });
        const live = await task('Live');

        expect(await exec(orchestrator, 'task_archive', { taskId: [epic.key] })).toEqual({
            archived: [epic.key, stage.key, step.key],
        });
        expect(keysOf((await exec(orchestrator, 'task_list', { all: true })).tasks)).toEqual([live.key]);
        expect(await exec(orchestrator, 'task_archive', { taskId: [epic.key] })).toEqual({ archived: [] });
        expect(await exec(orchestrator, 'task_unarchive', { taskId: [epic.key] })).toEqual({
            restored: [epic.key, stage.key, step.key],
        });
        expect(keysOf((await exec(orchestrator, 'task_list', { all: true, sort: 'number' })).tasks)).toEqual([
            epic.key,
            stage.key,
            step.key,
            live.key,
        ]);
        expect(await exec(orchestrator, 'task_unarchive', { taskId: [epic.key] })).toEqual({ restored: [] });
        // An id works as a key does.
        expect(await exec(orchestrator, 'task_archive', { taskId: [step.id] })).toEqual({ archived: [step.key] });
    });

    test('a refusal names the open tasks and the way out; cancel closes them first and answers which it canceled', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');
        const stage = await task('Stage', { parent: epic.key, status: 'active' });

        await expect(exec(orchestrator, 'task_archive', { taskId: [epic.key] })).rejects.toThrow(
            `${epic.key} (To do), ${stage.key} (In progress) are not closed: close them first, or archive with cancel`
        );
        expect((await exec(orchestrator, 'task_list', { all: true })).total).toBe(2);
        expect(await exec(orchestrator, 'task_archive', { taskId: [epic.key], cancel: true })).toEqual({
            archived: [epic.key, stage.key],
            canceled: [epic.key, stage.key],
        });
        expect((await exec(orchestrator, 'task_get', { taskId: stage.key })).task).toMatchObject({
            status: 'Canceled',
            category: 'canceled',
            archived: true,
        });
        // Nothing to cancel: the answer does not mention it.
        expect(
            await exec(orchestrator, 'task_archive', {
                taskId: [await task('Done', { status: 'done' }).then(done => done.key)],
                cancel: true,
            })
        ).not.toHaveProperty('canceled');
    });

    test('several tasks go in one call, all of them or none, and a task given with one inside it goes in one batch whatever the order of the words', async () => {
        const { exec, orchestrator, task } = await setup();
        const [first, second] = [await task('First', { status: 'done' }), await task('Second', { status: 'done' })];
        const open = await task('Open');

        await expect(exec(orchestrator, 'task_archive', { taskId: [first.key, open.key, second.key] })).rejects.toThrow(
            `${open.key} (To do) is not closed`
        );
        expect((await exec(orchestrator, 'task_list', { archived: true })).total).toBe(0);
        expect(await exec(orchestrator, 'task_archive', { taskId: [first.key, second.key, first.key] })).toEqual({
            archived: [first.key, second.key],
        });
        await expect(exec(orchestrator, 'task_archive', { taskId: ['REP-99'] })).rejects.toThrow(/does not exist/);

        // The child first and the parent after: one batch, so restoring the parent brings the child along.
        const epic = await task('Epic', { status: 'done' });
        const stage = await task('Stage', { parent: epic.key, status: 'done' });

        expect(await exec(orchestrator, 'task_archive', { taskId: [stage.key, epic.key] })).toEqual({
            archived: [epic.key, stage.key],
        });
        // Restoring the child first is refused by itself, but in one call the parent goes first.
        expect(await exec(orchestrator, 'task_unarchive', { taskId: [stage.key, epic.key] })).toEqual({
            restored: [epic.key, stage.key],
        });
        expect(keysOf((await exec(orchestrator, 'task_list', { archived: true, sort: 'number' })).tasks)).toEqual([
            first.key,
            second.key,
        ]);
    });

    test('a task whose parent is archived is refused on its own, with the reason', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { status: 'done' });
        const stage = await task('Stage', { parent: epic.key, status: 'done' });

        await exec(orchestrator, 'task_archive', { taskId: [epic.key] });
        await expect(exec(orchestrator, 'task_unarchive', { taskId: [stage.key] })).rejects.toThrow(
            `Task ${stage.key} is inside ${epic.key}, which is archived: restore ${epic.key} first`
        );
        expect((await exec(orchestrator, 'task_list', { archived: true })).total).toBe(2);
    });

    test('a run working on the task refuses the archive, one on a task inside it does too, and the run of the caller does not count', async () => {
        const { exec, orchestrator, task, h, chat, entity } = await setup();
        const own = await task('Own', { status: 'done' });
        const other = await task('Other', { status: 'done' });
        const epic = await task('Epic', { status: 'done' });
        const inside = await task('Inside', { parent: epic.key, status: 'done' });
        const { runs } = h.daemon.services;
        const assign = (summary: string, ...ids: string[]) =>
            runs.createRun({
                project: entity,
                role: 'orchestrator',
                chatId: chat.id,
                summary,
                assigned: ids.map(id => getTask(h.store.db, id) as NonNullable<ReturnType<typeof getTask>>),
            });
        const callerRun = assign('Own', own.id);
        const otherRun = assign('Other', other.id, inside.id);

        await expect(exec(orchestrator, 'task_archive', { taskId: [own.key] })).rejects.toThrow(
            `Task ${own.key} has an active run (${callerRun.name}): stop it first`
        );
        await expect(exec(orchestrator, 'task_archive', { taskId: [other.key], cancel: true })).rejects.toThrow(
            `Task ${other.key} has an active run (${otherRun.name}): stop it first`
        );
        await expect(exec(orchestrator, 'task_archive', { taskId: [epic.key] })).rejects.toThrow(
            `Task ${inside.key}, inside ${epic.key}, has an active run`
        );
        expect((await exec(orchestrator, 'task_list', { archived: true })).total).toBe(0);
        // The run that archives the task it works on is not in its own way.
        expect(await exec(callerRun, 'task_archive', { taskId: [own.key] })).toEqual({ archived: [own.key] });
        await expect(exec(callerRun, 'task_archive', { taskId: [other.key] })).rejects.toThrow(/has an active run/);
    });

    test('task_list leaves archived tasks out of every listing, lists only them with archived, and carries the count of the archive in every answer', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { status: 'done' });
        const stage = await task('Stage', { parent: epic.key, status: 'canceled' });
        const live = await task('Live');
        const earlier = await task('Earlier', { status: 'done' });

        expect(await exec(orchestrator, 'task_list')).toMatchObject({
            archived: 0,
            counts: { todo: 1, done: 2, canceled: 1 },
        });
        await exec(orchestrator, 'task_archive', { taskId: [earlier.key] });
        await exec(orchestrator, 'task_archive', { taskId: [epic.key] });

        const board = await exec(orchestrator, 'task_list', { all: true });

        expect(keysOf(board.tasks)).toEqual([live.key]);
        expect(board).toMatchObject({ total: 1, archived: 3, counts: { todo: 1, done: 0, canceled: 0 } });
        expect((await exec(orchestrator, 'task_list', { status: ['done'] })).total).toBe(0);
        expect((await exec(orchestrator, 'task_list', { query: 'stage' })).total).toBe(0);
        expect((await exec(orchestrator, 'task_list', { roots: true, all: true })).archived).toBe(3);

        const archive = await exec(orchestrator, 'task_list', { archived: true, sort: 'number' });

        expect(keysOf(archive.tasks)).toEqual([epic.key, stage.key, earlier.key]);
        expect(archive).toMatchObject({ total: 3, shown: 3, archived: 3, counts: { done: 2, canceled: 1, todo: 0 } });
        expect(archive.tasks[1]).toMatchObject({
            key: stage.key,
            status: 'Canceled',
            category: 'canceled',
            parent: epic.key,
            archivedAt: iso,
        });
        expect(archive.tasks[0]).toMatchObject({ children: { canceled: 1 }, archivedAt: iso });
        expect(keysOf((await exec(orchestrator, 'task_list', { archived: true, query: 'stage' })).tasks)).toEqual([
            stage.key,
        ]);
        expect(keysOf((await exec(orchestrator, 'task_list', { archived: true, status: ['canceled'] })).tasks)).toEqual(
            [stage.key]
        );
        expect(keysOf((await exec(orchestrator, 'task_list', { archived: true, parent: epic.key })).tasks)).toEqual([
            stage.key,
        ]);
        expect(keysOf((await exec(orchestrator, 'task_list', { archived: true, under: epic.key })).tasks)).toEqual([
            stage.key,
        ]);
        expect(
            keysOf((await exec(orchestrator, 'task_list', { archived: true, roots: true, sort: 'number' })).tasks)
        ).toEqual([epic.key, earlier.key]);
        expect(keysOf((await exec(orchestrator, 'task_list', { parent: epic.key, all: true })).tasks)).toEqual([]);

        // The first page lists the statuses, a later one does not, and the archive pages like any listing.
        const first = await exec(orchestrator, 'task_list', { archived: true, sort: 'number', limit: 2 });
        const rest = await exec(orchestrator, 'task_list', {
            archived: true,
            sort: 'number',
            limit: 2,
            cursor: first.nextCursor,
        });

        expect([keysOf(first.tasks), keysOf(rest.tasks)]).toEqual([[epic.key, stage.key], [earlier.key]]);
        expect(first.statuses).toHaveLength(5);
        expect(rest.statuses).toBeUndefined();
        expect(rest.nextCursor).toBeUndefined();
    });

    test('task_get reads an archived task and says so; a parent on the board does not count its archived children, an archived one holds its own', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic');
        const kept = await task('Kept', { parent: epic.key, status: 'done' });
        const stage = await task('Stage', { parent: epic.key, status: 'done' });
        const step = await task('Step', { parent: stage.key, status: 'done' });

        await exec(orchestrator, 'task_archive', { taskId: [stage.key] });

        const got = (await exec(orchestrator, 'task_get', { taskId: stage.key })).task;

        expect(got).toMatchObject({
            key: stage.key,
            archived: true,
            archivedAt: iso,
            status: 'Done',
            parent: { key: epic.key, title: 'Epic' },
            children: [{ key: step.key }],
            childrenTotal: 1,
            descendants: { done: 1 },
        });
        expect((await exec(orchestrator, 'task_get', { taskId: epic.key })).task).toMatchObject({
            children: [{ key: kept.key }],
            childrenTotal: 1,
            descendants: { done: 1 },
        });
        expect((await exec(orchestrator, 'task_get', { taskId: epic.key })).task).not.toHaveProperty('archived');
        expect((await exec(orchestrator, 'task_get', { taskId: kept.key })).task).not.toHaveProperty('archivedAt');
        expect((await exec(orchestrator, 'task_get', { taskId: step.key })).task).toMatchObject({ archived: true });

        // When every child is archived the parent has none to name.
        await exec(orchestrator, 'task_archive', { taskId: [kept.key] });
        for (const field of ['children', 'childrenTotal', 'descendants']) {
            expect((await exec(orchestrator, 'task_get', { taskId: epic.key })).task).not.toHaveProperty(field);
        }
    });

    test('a task that waited for an archived one is ready, still names it as a dependency, and the archived task still lists it as waiting', async () => {
        const { exec, orchestrator, task } = await setup();
        const first = await task('First', { status: 'done' });
        const second = await task('Second', { dependsOn: [first.key] });

        await exec(orchestrator, 'task_archive', { taskId: [first.key] });

        const row = (await exec(orchestrator, 'task_list', { ready: true })).tasks[0];

        expect(row).toMatchObject({ key: second.key, dependsOn: [first.key] });
        expect(row).not.toHaveProperty('blockedBy');
        expect((await exec(orchestrator, 'task_get', { taskId: second.key })).task.dependsOn).toEqual([
            { key: first.key, title: 'First', status: 'Done' },
        ]);
        expect((await exec(orchestrator, 'task_get', { taskId: first.key })).task.blocks).toEqual([
            { key: second.key, title: 'Second', status: 'To do' },
        ]);
        // A new dependency on an archived task is accepted, by key.
        expect(
            (await exec(orchestrator, 'task_create', { title: 'Third', dependsOn: [first.key] })).task.dependsOn
        ).toHaveLength(1);
    });

    test('an archived task stays closed: task_update refuses to reopen it and still edits its words; new tasks cannot go inside it', async () => {
        const { exec, orchestrator, task } = await setup();
        const epic = await task('Epic', { status: 'done' });

        await exec(orchestrator, 'task_archive', { taskId: [epic.key] });
        await expect(exec(orchestrator, 'task_update', { taskId: epic.key, status: 'todo' })).rejects.toThrow(
            `Task ${epic.key} is archived: restore it before reopening it`
        );
        expect(
            (await exec(orchestrator, 'task_update', { taskId: epic.key, title: 'Renamed epic' })).task
        ).toMatchObject({ title: 'Renamed epic', archived: true });
        await expect(exec(orchestrator, 'task_create', { title: 'Inside', parent: epic.key })).rejects.toThrow(
            `Task ${epic.key} is archived: restore it before putting tasks inside it`
        );
    });

    test('the tools list the tasks as bare words, say what they do, and refuse a field they do not have, an empty list and a single key', async () => {
        const { exec, orchestrator, toolsOf, task } = await setup();
        const tool = (name: string) => toolsOf(orchestrator).find(candidate => candidate.name === name)!;
        const properties = (name: string) =>
            (
                tool(name).inputSchema as {
                    properties: Record<string, { type?: string; items?: { type?: string }; description?: string }>;
                }
            ).properties;
        const closed = await task('Closed', { status: 'done' });

        expect(tool('task_archive').cli).toEqual({ positional: ['taskId'] });
        expect(tool('task_unarchive').cli).toEqual({ positional: ['taskId'] });
        expect(properties('task_archive').taskId).toMatchObject({ type: 'array', items: { type: 'string' } });
        expect(properties('task_archive').cancel).toMatchObject({ type: 'boolean' });
        expect(Object.keys(properties('task_archive'))).toEqual(['taskId', 'cancel']);
        expect(Object.keys(properties('task_unarchive'))).toEqual(['taskId']);
        expect(Object.keys(properties('task_list'))).toContain('archived');
        expect(tool('task_archive').description).toContain('cancel');
        expect(tool('task_get').description).toContain('archived');

        const refused = (name: string, input: unknown) =>
            expect(exec(orchestrator, name, input)).rejects.toThrow(new RegExp(`Invalid input for ${name}`));

        await refused('task_archive', { taskId: closed.key });
        await refused('task_archive', { taskId: [] });
        await refused('task_archive', { taskId: [''] });
        await refused('task_archive', { taskId: [closed.key], force: true });
        await refused('task_archive', { taskIds: [closed.key] });
        await refused('task_archive', { taskId: [closed.key], cancel: 'yes' });
        await refused('task_archive', {});
        await refused('task_unarchive', { taskId: closed.key });
        await refused('task_unarchive', { taskId: [closed.key], cancel: true });
        await refused('task_list', { archived: 'yes' });
        expect((await exec(orchestrator, 'task_list', { all: true })).total).toBe(1);
    });
});

describe('ask_user', () => {
    test('a delayed empty message close does not interrupt a live question', async () => {
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            const pending = options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            yield { type: 'text', delta: '', done: true };
            await pending;
            yield { type: 'done', result: 'done' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the live question');
        await Bun.sleep(50);
        expect(engine.closed).toBe(0);
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        expect(question.durable).toBeUndefined();
        h.ok('run.answer', { runId, questionId: question.questionId, answer: 'A' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to finish');
    });
    test('stops an agent that continues while its question call is still pending', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) {
                void options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal)
                    .catch(() => undefined);
                yield { type: 'text', delta: 'continued without an answer', done: true };
                yield { type: 'done', result: 'wrong' };
            } else {
                yield { type: 'done', result: 'done' };
            }
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        const readQuestion = () =>
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .map((row: any) => JSON.parse(row.body))
                .find((body: any) => body.kind === 'question');
        await waitFor(
            () =>
                readQuestion()?.durable === true &&
                readQuestion()?.state === undefined &&
                h.run(runId).status === 'waiting_user',
            'the transferred question'
        );
        expect(engine.closed).toBe(1);
        expect(
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .some((row: any) => JSON.parse(row.body).text === 'continued without an answer')
        ).toBe(false);
        h.ok('run.answer', { runId, questionId: readQuestion().questionId, answer: 'A' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the continued turn');
        expect(engine.turns[1].prompt).toContain("The user's answer: A");
    });

    test('a foreground tool event during a live question safely transfers the question', async () => {
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            void options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal)
                .catch(() => undefined);
            yield { type: 'tool', toolCallId: 'wrapper', name: 'Execute', input: {}, state: 'running' };
            yield { type: 'done', result: 'wrong' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        const readQuestion = () =>
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .map((row: any) => JSON.parse(row.body))
                .find((body: any) => body.kind === 'question');
        await waitFor(
            () =>
                readQuestion()?.durable === true &&
                readQuestion()?.state === undefined &&
                h.run(runId).status === 'waiting_user',
            'the transferred question'
        );
        expect(engine.closed).toBe(1);
        expect(h.run(runId).result).toBeUndefined();
    });
    test('an agent without elicitation stops before the question opens and continues after the answer', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) {
                const ask = options.tools.find(tool => tool.name === 'ask_user')!;
                await ask.execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
                yield { type: 'text', delta: 'should not happen', done: true };
            }
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the durable question');
        expect(engine.closed).toBe(1);
        const body = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((item: any) => item.kind === 'question');
        expect(body.durable).toBe(true);
        expect(typeof body.questionId).toBe('string');
        expect(body.state).toBeUndefined();
        h.ok('run.answer', { runId, questionId: body.questionId, answer: 'my own answer' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the continued turn');
        expect(engine.turns).toHaveLength(2);
        expect(engine.turns[1].prompt).toContain('my own answer');
        expect(
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .some((row: any) => JSON.parse(row.body).text === 'should not happen')
        ).toBe(false);
    });

    test('a durable question survives daemon restart and continues after an answer', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) {
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            }
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const engines = scriptEngines(engine);
        const h = await startHarness({}, { engines, agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        await h.stop();
        const restarted = await restartHarness(h, { engines, agents });
        harnesses.push(restarted);
        expect(restarted.run(runId).status).toBe('waiting_user');
        restarted.ok('run.answer', { runId, questionId: question.questionId, answer: 'A' });
        await waitFor(() => restarted.run(runId).status === 'succeeded', 'the resumed turn');
        expect(engine.turns[1].prompt).toContain("The user's answer: A");
    });

    test('recovery opens a preparing question after the old session is gone', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) await untilAborted(options.signal);
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const engines = scriptEngines(engine);
        const h = await startHarness({}, { engines, agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'running', 'the agent');
        appendItem(h.store, runId, { kind: 'assistant', text: 'Partial answer', done: false });
        appendItem(h.store, runId, {
            kind: 'question',
            questionId: 'q-prepared',
            text: 'Which?',
            options: [{ id: 'a', label: 'A' }],
            durable: true,
            state: 'preparing',
        });
        await h.stop();
        const restarted = await restartHarness(h, { engines, agents });
        harnesses.push(restarted);
        expect(restarted.run(runId).status).toBe('waiting_user');
        const partial = restarted.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'assistant' && body.text === 'Partial answer');
        expect(partial.done).toBe(true);
        const question = restarted.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.questionId === 'q-prepared');
        expect(question.state).toBeUndefined();
        restarted.ok('run.answer', { runId, questionId: 'q-prepared', answer: 'A' });
        await waitFor(() => restarted.run(runId).status === 'succeeded', 'the continued turn');
        expect(engine.turns[1].prompt).toContain("The user's answer: A");
    });

    test('recovery does not open a preparing question while an unverified process may still be alive', async () => {
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            await untilAborted(options.signal);
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const engines = scriptEngines(engine);
        const h = await startHarness({}, { engines, agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'running', 'the agent');
        appendItem(h.store, runId, {
            kind: 'question',
            questionId: 'q-prepared',
            text: 'Which?',
            options: [{ id: 'a', label: 'A' }],
            durable: true,
            state: 'preparing',
        });
        await h.stop();
        const db = new Database(join(h.config.dataDir, 'clowdy.db'));
        db.query('UPDATE runs SET pid = ?, pgid = NULL, process_started_at = NULL WHERE id = ?').run(
            process.pid,
            runId
        );
        db.close();
        const restarted = await restartHarness(h, { engines, agents });
        harnesses.push(restarted);
        expect(restarted.run(runId).status).toBe('interrupted');
        const question = restarted.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.questionId === 'q-prepared');
        expect(question.state).toBe('expired');
        // The fake reference names this test process without a start time, so recovery never signals it.
        restarted.daemon.services.runs.setProcess(runId, null);
    });

    test('replays an answered durable question after the continuation fails to start', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            if (number === 2) {
                yield { type: 'error', message: 'Cannot start agent', retryable: false };
                return;
            }
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1)
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        const readQuestion = () =>
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .map((row: any) => JSON.parse(row.body))
                .find((body: any) => body.kind === 'question');
        const questionId = readQuestion().questionId;
        h.ok('run.answer', { runId, questionId, answer: 'A' });
        await waitFor(() => h.run(runId).status === 'failed', 'the continuation failure');
        expect(readQuestion().delivered).toBeUndefined();
        h.ok('chat.send', { chatId: chat.id, text: 'Please retry' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the retry');
        expect(engine.turns[2].prompt).toContain("The user's answer: A");
        expect(engine.turns[2].prompt).toContain('Please retry');
        expect(readQuestion().delivered).toBe(true);
    });

    test('an explicit stop retires an unanswered continuation before a later message', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1)
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            if (number === 2)
                await new Promise<void>(resolve => {
                    if (options.signal.aborted) resolve();
                    else options.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        const readQuestion = () =>
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .map((row: any) => JSON.parse(row.body))
                .find((body: any) => body.kind === 'question');
        h.ok('run.answer', { runId, questionId: readQuestion().questionId, answer: 'A' });
        await waitFor(() => engine.turns.length === 2 && h.run(runId).status === 'running', 'the continuation');
        h.ok('run.cancel', { runId });
        expect(readQuestion().abandoned).toBe(true);
        h.ok('chat.send', { chatId: chat.id, text: 'A new request' });
        await waitFor(() => engine.turns.length === 3 && h.run(runId).status === 'succeeded', 'the new turn');
        expect(engine.turns[2].prompt).not.toContain("The user's answer: A");
    });

    test('expires an orphaned legacy card before preparing a durable question', async () => {
        const gate = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            await gate.promise;
            await options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'New?', options: [{ id: 'b', label: 'B' }] }, options.signal);
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'running', 'the first turn');
        appendItem(h.store, runId, {
            kind: 'question',
            questionId: 'old',
            text: 'Old?',
            options: [{ id: 'a', label: 'A' }],
        });
        gate.resolve();
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the new question');
        const questions = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .filter((body: any) => body.kind === 'question');
        expect(questions[0].state).toBe('expired');
        expect(questions[1].state).toBeUndefined();
    });

    test('does not open a durable question when stopping the agent fails', async () => {
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            await options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
        });
        const start = engine.start.bind(engine);
        engine.start = options => {
            const session = start(options);
            return {
                ...session,
                close: async () => {
                    await session.close();
                    throw new Error('could not stop');
                },
            };
        };
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'failed', 'the failed stop');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        expect(question.state).toBe('cancelled');
        expect(h.send('run.answer', { runId, questionId: question.questionId, answer: 'A' }).ok).toBe(false);
    });

    test('stopping a run while a durable question is open withdraws it', async () => {
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            await options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        h.ok('run.cancel', { runId });
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        expect(question.state).toBe('cancelled');
        expect(h.send('run.answer', { runId, questionId: question.questionId, answer: 'A' }).ok).toBe(false);
    });

    test('stopping while the agent is closing never opens the durable question', async () => {
        const gate = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            await options.tools
                .find(tool => tool.name === 'ask_user')!
                .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
        });
        const start = engine.start.bind(engine);
        engine.start = options => {
            const session = start(options);
            return {
                ...session,
                close: async () => {
                    await session.close();
                    await gate.promise;
                },
            };
        };
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        const readQuestion = () =>
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .map((row: any) => JSON.parse(row.body))
                .find((body: any) => body.kind === 'question');
        await waitFor(() => readQuestion()?.state === 'preparing', 'the question to prepare');
        const approval = h.daemon.services.runs.askApproval(
            runId,
            {
                title: 'Run pwd',
                subject: { kind: 'command', command: 'pwd' },
                decisions: ['allow_once'],
                key: 'command:pwd',
            },
            AbortSignal.timeout(500)
        );
        expect(await approval).toBeUndefined();
        expect(readQuestion().state).toBe('preparing');
        h.ok('run.cancel', { runId });
        gate.resolve();
        await waitFor(() => engine.closed === 1, 'the session to close');
        expect(h.run(runId).status).toBe('cancelled');
        expect(readQuestion().state).toBe('cancelled');
    });

    test('an answered durable question waits for a free execution slot before continuing', async () => {
        const gate = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: `s-${number}` };
            if (options.prompt.includes('hold the slot')) await gate.promise;
            else if (number === 1)
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({ engineCaps: { fake: 1 } }, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const first = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const second = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const firstRun = h.ok('chat.send', { chatId: first.id, text: 'ask' }).runId;
        await waitFor(() => h.run(firstRun).status === 'waiting_user', 'first question');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(firstRun)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        const secondRun = h.ok('chat.send', { chatId: second.id, text: 'hold the slot' }).runId;
        await waitFor(() => h.run(secondRun).status === 'running', 'second run');
        h.ok('run.answer', { runId: firstRun, questionId: question.questionId, answer: 'A' });
        expect(h.run(firstRun).status).toBe('queued');
        expect(engine.turns).toHaveLength(2);
        gate.resolve();
        await waitFor(() => h.run(firstRun).status === 'succeeded', 'the continued turn');
        expect(engine.turns).toHaveLength(3);
    });

    test('an answer queued for a slot is replayed after a daemon restart', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: `s-${number}` };
            if (options.prompt.includes('hold the slot')) await untilAborted(options.signal);
            else if (number === 1)
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const engines = scriptEngines(engine);
        const h = await startHarness({ engineCaps: { fake: 1 } }, { engines, agents });
        harnesses.push(h);
        const project = h.openRepo();
        const first = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const second = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const firstRun = h.ok('chat.send', { chatId: first.id, text: 'ask' }).runId;
        await waitFor(() => h.run(firstRun).status === 'waiting_user', 'first question');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(firstRun)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        const secondRun = h.ok('chat.send', { chatId: second.id, text: 'hold the slot' }).runId;
        await waitFor(() => h.run(secondRun).status === 'running', 'second run');
        h.ok('run.answer', { runId: firstRun, questionId: question.questionId, answer: 'A' });
        expect(h.run(firstRun).status).toBe('queued');
        await h.stop();
        const restarted = await restartHarness(h, { engines, agents });
        harnesses.push(restarted);
        await waitFor(() => restarted.run(firstRun).status === 'succeeded', 'continuation after restart');
        expect(engine.turns.at(-1)!.prompt).toContain("The user's answer: A");
    });

    test('a durable pause tells the person and the continued agent when background work was stopped', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) {
                yield { type: 'background', items: [{ id: 'job', kind: 'command', title: 'long test' }] };
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            }
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        const items = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body));
        expect(
            items.some(
                (body: any) =>
                    body.kind === 'note' && body.text === 'Background work stopped while waiting for your answer'
            )
        ).toBe(true);
        const questionId = items.find((body: any) => body.kind === 'question').questionId;
        h.ok('run.answer', { runId, questionId, answer: 'A' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the continuation');
        expect(engine.turns[1].prompt).toContain('long test');
        expect(engine.turns[1].prompt).toContain('lost');
    });

    test('keeps the stopped background work in context if the continuation fails', async () => {
        const engine = new ScriptEngine(async function* ({ options, number }) {
            if (number === 2) {
                yield { type: 'background', items: [{ id: 'job-2', kind: 'command', title: 'another test' }] };
                yield { type: 'error', message: 'Cannot start agent', retryable: false };
                return;
            }
            yield { type: 'session', sessionId: 's-1' };
            if (number === 1) {
                yield { type: 'background', items: [{ id: 'job', kind: 'command', title: 'long test' }] };
                await options.tools
                    .find(tool => tool.name === 'ask_user')!
                    .execute({ question: 'Which?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            }
            yield { type: 'done', result: 'done' };
        });
        const agents = new AgentRegistry();
        agents.questionElicitation = () => false;
        const h = await startHarness({}, { engines: scriptEngines(engine), agents });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        h.ok('run.answer', { runId, questionId: question.questionId, answer: 'A' });
        await waitFor(() => h.run(runId).status === 'failed', 'the failed continuation');
        h.ok('chat.send', { chatId: chat.id, text: 'Please retry' });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the retry');
        expect(engine.turns[2].prompt).toContain('long test');
        expect(engine.turns[2].prompt).toContain('another test');
        expect(engine.turns[2].prompt).toContain("The user's answer: A");
    });

    test('preserving a question when the turn ends does not require another execution slot', async () => {
        const finishQuestionTurn = Promise.withResolvers<void>();
        const finishOtherTurn = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            if (options.prompt.includes('hold the slot')) {
                await finishOtherTurn.promise;
            } else {
                const ask = options.tools.find(tool => tool.name === 'ask_user')!;
                void ask
                    .execute({ question: 'First?', options: [{ id: 'a', label: 'A' }] }, options.signal)
                    .catch(() => {});
                await finishQuestionTurn.promise;
            }
            yield { type: 'done', result: 'done' };
        });
        const h = await startHarness({ engineCaps: { fake: 1 } }, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const first = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const second = h.ok('chat.create', { projectId: project.id, mode: 'semi' }).chat;
        const firstRun = h.ok('chat.send', { chatId: first.id, text: 'ask' }).runId;
        await waitFor(() => h.run(firstRun).status === 'waiting_user', 'first question');
        const secondRun = h.ok('chat.send', { chatId: second.id, text: 'hold the slot' }).runId;
        await waitFor(() => h.run(secondRun).status === 'running', 'second run');
        finishQuestionTurn.resolve();
        await waitFor(
            () =>
                h.store.db
                    .query('SELECT body FROM stream_items WHERE run_id = ?')
                    .all(firstRun)
                    .map((row: any) => JSON.parse(row.body))
                    .some((body: any) => body.kind === 'question' && body.durable && body.state === undefined),
            'the durable question'
        );
        expect(h.run(firstRun).status).toBe('waiting_user');
        expect(h.run(secondRun).status).toBe('running');
        finishOtherTurn.resolve();
        await waitFor(() => h.run(secondRun).status === 'succeeded', 'second turn to finish');
    });

    test('preserves a question when the agent ends its turn without waiting', async () => {
        const gate = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            const ask = options.tools.find(tool => tool.name === 'ask_user')!;
            void ask
                .execute({ question: 'First?', options: [{ id: 'a', label: 'A' }] }, options.signal)
                .catch(() => {});
            await gate.promise;
            yield { type: 'done', result: 'done without an answer' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        gate.resolve();
        await waitFor(
            () =>
                h.store.db
                    .query('SELECT body FROM stream_items WHERE run_id = ?')
                    .all(runId)
                    .map((row: any) => JSON.parse(row.body))
                    .some((body: any) => body.kind === 'question' && body.durable && body.state === undefined),
            'the question to become durable'
        );
        expect(h.run(runId).status).toBe('waiting_user');
    });

    test('withdrawing a question closes its card and releases the waiting state', async () => {
        const withdrawal = new AbortController();
        const gate = Promise.withResolvers<void>();
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };
            const ask = options.tools.find(tool => tool.name === 'ask_user')!;
            const pending = ask.execute({ question: 'First?', options: [{ id: 'a', label: 'A' }] }, withdrawal.signal);
            await pending.catch(() => undefined);
            await gate.promise;
            yield { type: 'done', result: 'ok' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });
        harnesses.push(h);
        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });
        await waitFor(() => h.run(runId).status === 'waiting_user', 'the question');
        withdrawal.abort();
        await waitFor(() => h.run(runId).status === 'running', 'the agent to resume');
        const question = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ?')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .find((body: any) => body.kind === 'question');
        expect(question.state).toBe('cancelled');
        expect(h.run(runId).awaitingUser).not.toBe(true);
        gate.resolve();
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
    });

    test('a second question while one is open is refused at once, so the first stays answerable', async () => {
        const outcomes: string[] = [];
        const engine = new ScriptEngine(async function* ({ options }) {
            yield { type: 'session', sessionId: 's-1' };

            const ask = options.tools.find(tool => tool.name === 'ask_user')!;
            const first = ask.execute({ question: 'First?', options: [{ id: 'a', label: 'A' }] }, options.signal);
            const second = await ask
                .execute({ question: 'Second?', options: [{ id: 'b', label: 'B' }] }, options.signal)
                .catch((error: Error) => error.message);

            outcomes.push(`second: ${second}`);
            outcomes.push(`first: ${JSON.stringify(await first)}`);
            yield { type: 'done', result: 'ok' };
        });
        const h = await startHarness({}, { engines: scriptEngines(engine) });

        harnesses.push(h);

        const project = h.openRepo();
        const { chat } = h.ok('chat.create', { projectId: project.id, mode: 'semi' });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'go' });

        await waitFor(() => h.run(runId).status === 'waiting_user', 'the first question');

        const [question] = h.store.db
            .query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq')
            .all(runId)
            .map((row: any) => JSON.parse(row.body))
            .filter((body: any) => body.kind === 'question');

        expect(h.ok('run.answer', { runId, questionId: question.questionId, answer: 'A' })).toEqual({ runId });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the run to finish');
        expect(outcomes).toEqual([
            'second: Another question is waiting for the user. Ask one question at a time and wait for its answer.',
            'first: {"answer":"A"}',
        ]);
        expect(
            h.store.db
                .query('SELECT body FROM stream_items WHERE run_id = ?')
                .all(runId)
                .filter((row: any) => JSON.parse(row.body).kind === 'question')
        ).toHaveLength(1);
    });
});

describe('a run on a task', () => {
    test('waits while the task has unfinished dependencies, and starts by itself when the orchestrator sets the last one Done', async () => {
        const { engine, exec, orchestrator, task, h } = await setup();
        const a = await task('A');
        const b = await task('B', { dependsOn: [a.key] });
        const { runId } = h.ok('task.start', { taskId: b.id });

        expect(h.run(runId)).toMatchObject({ status: 'blocked', statusReason: 'Waiting for REP-1' });
        await Bun.sleep(30);
        expect(engine.turns).toHaveLength(0);

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'review' });
        await Bun.sleep(30);
        expect(h.run(runId).status).toBe('blocked');

        await exec(orchestrator, 'task_update', { taskId: a.key, status: 'done' });
        await waitFor(() => engine.turns.length === 1, 'the dependent run to start');
        expect(h.run(runId).status).toBe('running');
    });
});
