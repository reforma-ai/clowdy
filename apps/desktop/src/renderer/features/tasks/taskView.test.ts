import { describe, expect, it } from 'vitest';

import {
    activeExecutors,
    adjacentStatus,
    agentOptions,
    blockedByOptions,
    blockingCandidates,
    blockingOptions,
    boardColumns,
    createdTaskId,
    dependencyCandidates,
    externalLink,
    facetCount,
    filterTasks,
    formatAgo,
    groupByStatus,
    isFiltering,
    newestChat,
    newestDocPath,
    NO_FILTER,
    resultRows,
    runsByTask,
    startBlockedReason,
    taskActivity,
    taskGrid,
    tasksSource,
    toggleDependency,
} from './taskView';

import type { Artifact, Run, RunTaskLink, Task, TaskStatus } from '@clowdy/protocol';

const MINUTE = 60_000;

function task(number: number, rest: Partial<Task> = {}): Task {
    return {
        id: `t-${ number }`,
        projectId: 'p',
        number,
        key: `CAR-${ number }`,
        title: `Task ${ number }`,
        description: '',
        statusId: 'todo',
        dependsOn: [],
        createdBy: { kind: 'user' },
        createdAt: 1_000_000,
        updatedAt: 1_000_000,
        ...rest,
    };
}

function run(id: string, status: Run['status'], rest: Partial<Run> = {}): Run {
    return { id, projectId: 'p', rootRunId: id, role: 'orchestrator', name: `Orchestrator ${ id }`, summary: '', status, engine: 'fake', createdAt: 1000, ...rest };
}

const link = (runId: string, taskId: string, relation: RunTaskLink['relation']): RunTaskLink => ({ runId, taskId, relation });

function runMap(...runs: Run[]): Map<string, Run> {
    return new Map(runs.map(item => [item.id, item]));
}

describe('runsByTask', () => {
    it('lists the assigned runs, oldest first, and leaves out runs that only created the task', () => {
        const runs = runMap(run('a', 'running', { createdAt: 30 }), run('b', 'queued', { createdAt: 10 }), run('orch', 'running'));
        const byTask = runsByTask([link('a', 't-1', 'assigned'), link('b', 't-1', 'assigned'), link('orch', 't-1', 'created')], runs);

        expect(byTask.get('t-1')?.map(item => item.id)).toEqual(['b', 'a']);
    });

    it('lists a run once when it created the task and is assigned to it too, in either order', () => {
        const runs = runMap(run('a', 'running'));

        expect(runsByTask([link('a', 't-1', 'assigned'), link('a', 't-1', 'created')], runs).get('t-1')).toEqual([runs.get('a')]);
        expect(runsByTask([link('a', 't-1', 'created'), link('a', 't-1', 'assigned')], runs).get('t-1')).toEqual([runs.get('a')]);
        expect(runsByTask([link('a', 't-1', 'assigned'), link('a', 't-1', 'assigned')], runs).get('t-1')).toEqual([runs.get('a')]);
    });

    it('skips links to runs that are not known', () => {
        expect(runsByTask([link('gone', 't-1', 'assigned')], runMap()).size).toBe(0);
    });
});

describe('start', () => {
    it('is blocked by an active assigned run, and names it', () => {
        expect(startBlockedReason([run('07', 'running', { name: 'Orchestrator 07' })])).toBe('Orchestrator 07 is already working on this task.');
        expect(startBlockedReason([run('a', 'queued'), run('b', 'waiting_user')])).toBe('2 agents are already working on this task.');
    });

    it('is open when the runs finished, or there are no runs', () => {
        expect(startBlockedReason([run('a', 'failed'), run('b', 'cancelled')])).toBeNull();
        expect(startBlockedReason([])).toBeNull();
        expect(startBlockedReason(undefined)).toBeNull();
    });

    it('shows only the runs that are still active on the card', () => {
        const list = [run('a', 'running'), run('b', 'succeeded')];

        expect(activeExecutors(list).map(item => item.id)).toEqual(['a']);
    });
});

describe('filters', () => {
    const tasks = [
        task(1, { title: 'Update the booking form', statusId: 'active' }),
        task(2, { title: 'Weekend pricing', description: 'Weekend days cost more', statusId: 'review' }),
        task(3, { title: 'Cancel a booking', statusId: 'todo' }),
    ];
    const runs = runMap(run('a', 'running'), run('b', 'succeeded'));
    const byTask = runsByTask([link('a', 't-1', 'assigned'), link('b', 't-3', 'assigned')], runs);
    const keysOf = (filter: Partial<typeof NO_FILTER>) => filterTasks(tasks, { ...NO_FILTER, ...filter }, byTask).map(item => item.key);

    it('searches the key, the title and the description without regard to case', () => {
        expect(keysOf({ query: 'BOOKING' })).toEqual(['CAR-1', 'CAR-3']);
        expect(keysOf({ query: 'car-2' })).toEqual(['CAR-2']);
        expect(keysOf({ query: '  more ' })).toEqual(['CAR-2']);
        expect(keysOf({ query: 'nothing like it' })).toEqual([]);
    });

    it('narrows by status and by agent, and the facets add up', () => {
        expect(keysOf({ statusIds: ['active', 'todo'] })).toEqual(['CAR-1', 'CAR-3']);
        expect(keysOf({ runIds: ['a'] })).toEqual(['CAR-1']);
        expect(keysOf({ runIds: ['a', 'b'], statusIds: ['todo'] })).toEqual(['CAR-3']);
        expect(keysOf({ query: 'booking', statusIds: ['review'] })).toEqual([]);
    });

    it('knows when the list is narrowed', () => {
        expect(isFiltering(NO_FILTER)).toBe(false);
        expect(isFiltering({ ...NO_FILTER, query: '  ' })).toBe(false);
        expect(isFiltering({ ...NO_FILTER, query: 'x' })).toBe(true);
        expect(facetCount({ query: 'x', statusIds: ['a', 'b'], runIds: ['r'] })).toBe(2);
        expect(facetCount({ ...NO_FILTER, query: 'x' })).toBe(0);
    });

    it('offers the agents linked to tasks, working ones first', () => {
        const options = agentOptions(runsByTask(
            [link('b', 't-1', 'assigned'), link('a', 't-2', 'assigned'), link('c', 't-2', 'assigned')],
            runMap(run('a', 'succeeded', { name: 'Orchestrator 02' }), run('b', 'running', { name: 'Orchestrator 10' }), run('c', 'running', { name: 'Orchestrator 09' }))
        ));

        expect(options.map(item => item.name)).toEqual(['Orchestrator 09', 'Orchestrator 10', 'Orchestrator 02']);
    });

    it('groups tasks by status in the order given', () => {
        expect([...groupByStatus(tasks)].map(([status, list]) => [status, list.map(item => item.key)])).toEqual([
            ['active', ['CAR-1']],
            ['review', ['CAR-2']],
            ['todo', ['CAR-3']],
        ]);
    });
});

describe('dependencyCandidates', () => {
    const tasks = [task(1), task(2, { dependsOn: ['t-1'] }), task(3, { dependsOn: ['t-2'] }), task(4)];
    const ids = (list: Task[]) => list.map(item => item.id);

    it('leaves out the task, its current dependencies, and every task that would close a loop', () => {
        expect(ids(dependencyCandidates(tasks, { taskId: 't-1', taken: [] }))).toEqual(['t-4']);
        expect(ids(dependencyCandidates(tasks, { taskId: 't-2', taken: ['t-1'] }))).toEqual(['t-4']);
        expect(ids(dependencyCandidates(tasks, { taskId: 't-4', taken: ['t-3'] }))).toEqual(['t-1', 't-2']);
    });

    it('leaves out only what is taken for a task that does not exist yet', () => {
        expect(ids(dependencyCandidates(tasks, { taken: ['t-2'] }))).toEqual(['t-1', 't-3', 't-4']);
    });

    it('terminates on data that already has a loop', () => {
        const looped = [task(1, { dependsOn: ['t-2'] }), task(2, { dependsOn: ['t-1'] }), task(3)];

        expect(ids(dependencyCandidates(looped, { taskId: 't-1', taken: [] }))).toEqual(['t-3']);
    });
});

describe('blockingCandidates', () => {
    // 1 <- 2 <- 3: task 2 depends on 1, and task 3 on 2.
    const tasks = [task(1), task(2, { dependsOn: ['t-1'] }), task(3, { dependsOn: ['t-2'] }), task(4)];
    const ids = (list: Task[]) => list.map(item => item.id);

    it('lists the tasks that may start to depend on the task, not itself and not the ones that already do', () => {
        expect(ids(blockingCandidates(tasks, { taskId: 't-1' }))).toEqual(['t-3', 't-4']);
        expect(ids(blockingCandidates(tasks, { taskId: 't-4' }))).toEqual(['t-1', 't-2', 't-3']);
    });

    it('leaves out everything the task depends on, directly or through others, because that would close a loop', () => {
        expect(ids(blockingCandidates(tasks, { taskId: 't-3' }))).toEqual(['t-4']);
        expect(ids(blockingCandidates(tasks, { taskId: 't-2' }))).toEqual(['t-4']);
    });

    it('does not offer a loop that dependencyCandidates would refuse from the other side', () => {
        for (const owner of tasks) {
            for (const candidate of blockingCandidates(tasks, { taskId: owner.id })) {
                expect(ids(dependencyCandidates(tasks, { taskId: candidate.id, taken: candidate.dependsOn }))).toContain(owner.id);
            }
        }
    });

    it('terminates on data that already has a loop', () => {
        const looped = [task(1, { dependsOn: ['t-2'] }), task(2, { dependsOn: ['t-1'] }), task(3)];

        expect(ids(blockingCandidates(looped, { taskId: 't-1' }))).toEqual(['t-3']);
    });

    it('offers every other task for one that is not in the list', () => {
        expect(ids(blockingCandidates(tasks, { taskId: 'gone' }))).toEqual(['t-1', 't-2', 't-3', 't-4']);
    });
});

describe('dependency pickers', () => {
    const tasks = [task(1), task(2, { dependsOn: ['t-1'] }), task(3, { dependsOn: ['t-2'] }), task(4), task(5, { dependsOn: ['t-2'] })];
    const ids = (list: Task[]) => list.map(item => item.id);

    it('"blocked by" lists what the task depends on and what it may still depend on, in task order', () => {
        expect(ids(blockedByOptions(tasks, tasks[1]))).toEqual(['t-1', 't-4']);
        expect(ids(blockedByOptions(tasks, tasks[3]))).toEqual(['t-1', 't-2', 't-3', 't-5']);
    });

    it('"blocking" lists what depends on the task and what may start to, in task order', () => {
        expect(ids(blockingOptions(tasks, tasks[1]))).toEqual(['t-3', 't-4', 't-5']);
        expect(ids(blockingOptions(tasks, tasks[0]))).toEqual(['t-2', 't-3', 't-4', 't-5']);
    });

    it('leaves out a dependency whose task is gone', () => {
        expect(ids(blockedByOptions([task(1, { dependsOn: ['gone'] })], { id: 't-1', dependsOn: ['gone'] }))).toEqual([]);
    });
});

describe('toggleDependency', () => {
    it('adds a task at the end and takes one out, leaving the rest in order', () => {
        expect(toggleDependency(['t-1', 't-2'], 't-3')).toEqual(['t-1', 't-2', 't-3']);
        expect(toggleDependency(['t-1', 't-2', 't-3'], 't-2')).toEqual(['t-1', 't-3']);
        expect(toggleDependency([], 't-1')).toEqual(['t-1']);
        expect(toggleDependency(['t-1'], 't-1')).toEqual([]);
    });

    it('does not change the list it is given', () => {
        const list = ['t-1'];

        toggleDependency(list, 't-2');
        toggleDependency(list, 't-1');

        expect(list).toEqual(['t-1']);
    });
});

describe('adjacentStatus', () => {
    const statuses: TaskStatus[] = [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'active', name: 'In progress', category: 'active' },
        { id: 'done', name: 'Done', category: 'done' },
    ];

    it('is the next and the previous status in workflow order', () => {
        expect(adjacentStatus(statuses, 'todo', 1)?.id).toBe('active');
        expect(adjacentStatus(statuses, 'active', 1)?.id).toBe('done');
        expect(adjacentStatus(statuses, 'done', -1)?.id).toBe('active');
        expect(adjacentStatus(statuses, 'active', -1)?.id).toBe('todo');
    });

    it('is nothing at either end', () => {
        expect(adjacentStatus(statuses, 'done', 1)).toBeUndefined();
        expect(adjacentStatus(statuses, 'todo', -1)).toBeUndefined();
    });

    it('is nothing for a status the workflow no longer has, and for an empty workflow', () => {
        expect(adjacentStatus(statuses, 'removed', 1)).toBeUndefined();
        expect(adjacentStatus(statuses, 'removed', -1)).toBeUndefined();
        expect(adjacentStatus([], 'todo', 1)).toBeUndefined();
    });
});

describe('sources', () => {
    const linear = { provider: 'linear', externalId: 'ENG-1', url: 'https://linear.app/x/issue/ENG-1' };

    it('names the source of the list', () => {
        expect(tasksSource([])).toBe('Internal');
        expect(tasksSource([{}, {}])).toBe('Internal');
        expect(tasksSource([{}, { external: linear }])).toBe('Internal + Linear');
        expect(tasksSource([{ external: linear }, { external: { provider: 'jira', externalId: '1' } }])).toBe('Linear + Jira');
    });

    it('links to the provider only for a web address', () => {
        expect(externalLink(linear)).toEqual({ label: 'Linear', url: linear.url });
        expect(externalLink({ ...linear, url: 'javascript:alert(1)' })).toBeNull();
        expect(externalLink({ ...linear, url: undefined })).toBeNull();
        expect(externalLink(undefined)).toBeNull();
    });
});

describe('taskActivity', () => {
    const now = 100 * MINUTE;
    const t = task(24, { createdAt: now - 90 * MINUTE, updatedAt: now - 5 * MINUTE, createdBy: { kind: 'run', runId: 'orch' } });

    it('lists what happened, newest first, with the run behind each event', () => {
        const orch = run('orch', 'running', { name: 'Orchestrator 01' });
        const done = run('x', 'succeeded', { name: 'Orchestrator 09', startedAt: now - 60 * MINUTE, finishedAt: now - 30 * MINUTE, result: 'Added the table.' });
        const live = run('y', 'running', { name: 'Orchestrator 07', startedAt: now - 20 * MINUTE });
        const queued = run('z', 'queued', { name: 'Orchestrator 02', createdAt: now - MINUTE });
        const activity = taskActivity(t, [done, live, queued], runMap(orch, done, live, queued));

        expect(activity.map(item => item.text)).toEqual([
            'Orchestrator 02 is waiting to start',
            'Task updated',
            'Orchestrator 07 started working',
            'Orchestrator 09 finished',
            'Orchestrator 09 started working',
        ]);
        expect(activity[3]).toMatchObject({ detail: 'Added the table.', run: done });
    });

    it('says who created the task, whoever they are', () => {
        const textOf = (createdBy: Task['createdBy'], runs = runMap()) => taskActivity(task(1, { createdBy }), [], runs)[0].text;

        expect(textOf({ kind: 'user' })).toBe('You created the task');
        expect(textOf({ kind: 'provider', provider: 'linear' })).toBe('Imported from Linear');
        expect(textOf({ kind: 'run', runId: 'orch' }, runMap(run('orch', 'running', { name: 'Orchestrator 01' })))).toBe('Orchestrator 01 created the task');
        expect(textOf({ kind: 'run', runId: 'gone' })).toBe('An agent created the task');
    });

    it('reports a failed run with its error and keeps to the limit', () => {
        const failed = run('f', 'failed', { startedAt: 1, finishedAt: 2, error: 'Typecheck failed' });
        const activity = taskActivity(task(1, { createdAt: 0, updatedAt: 0 }), [failed], runMap(failed), 2);

        expect(activity).toHaveLength(2);
        expect(activity[0]).toMatchObject({ text: 'Orchestrator f failed', detail: 'Typecheck failed' });
    });
});

describe('formatAgo', () => {
    const now = 1_000_000_000_000;

    it('rounds to the unit a person would say', () => {
        expect(formatAgo(now - 20_000, now)).toBe('just now');
        expect(formatAgo(now - MINUTE, now)).toBe('1 minute ago');
        expect(formatAgo(now - 2 * MINUTE, now)).toBe('2 minutes ago');
        expect(formatAgo(now - 3 * 60 * MINUTE, now)).toBe('3 hours ago');
        expect(formatAgo(now - 24 * 60 * MINUTE, now)).toBe('yesterday');
        expect(formatAgo(now - 3 * 24 * 60 * MINUTE, now)).toBe('3 days ago');
    });

    it('gives the date once it is a week old', () => {
        expect(formatAgo(now - 10 * 24 * 60 * MINUTE, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    });
});

describe('resultRows', () => {
    const artifact = (id: string, kind: Artifact['kind'], title: string, ref: Artifact['ref'], createdAt = 1): Artifact => ({ id, projectId: 'p', kind, title, ref, createdAt });

    it('reads each kind of artifact, newest first', () => {
        const rows = resultRows([
            artifact('a', 'commit', 'Add the table', { sha: 'f00dcafe1234' }, 1),
            artifact('b', 'diff', 'Form changes', { files: 2, added: 42, removed: 118 }, 5),
            artifact('c', 'check', 'Typecheck', { command: 'bun run typecheck', exitCode: 2 }, 4),
            artifact('d', 'check', 'Tests', { exitCode: 0 }, 3),
            artifact('e', 'doc', 'Pricing notes', { path: 'decisions/pricing.md' }, 2),
            artifact('f', 'build', 'App build', { path: 'release/app.zip' }, 0),
        ], { expectChecks: false });

        expect(rows.map(row => row.id)).toEqual(['b', 'c', 'd', 'e', 'a', 'f']);
        expect(rows[0].meta).toBe('+42 −118');
        expect(rows[1].verdict).toEqual({ label: 'Failed', tone: 'danger' });
        expect(rows[2].verdict).toEqual({ label: 'Passed', tone: 'success' });
        expect(rows[3].docPath).toBe('decisions/pricing.md');
        expect(rows[4].meta).toBe('f00dcaf');
        expect(rows[5].meta).toBe('release/app.zip');
    });

    it('treats a check without an exit code as still waiting, and survives artifacts with thin refs', () => {
        const rows = resultRows([artifact('a', 'check', 'Lint', {}), artifact('b', 'diff', 'Changes', {})], { expectChecks: false });

        expect(rows.find(row => row.id === 'a')?.verdict?.label).toBe('Waiting');
        expect(rows.find(row => row.id === 'b')?.meta).toBeUndefined();
    });

    it('announces checks to come while an agent works and no check has reported', () => {
        expect(resultRows([], { expectChecks: true })).toEqual([{ id: 'checks-waiting', kind: 'check', title: 'Checks', verdict: { label: 'Waiting', tone: 'warning' } }]);
        expect(resultRows([], { expectChecks: false })).toEqual([]);
        expect(resultRows([artifact('a', 'check', 'Lint', { exitCode: 0 })], { expectChecks: true })).toHaveLength(1);
    });
});

describe('newestDocPath', () => {
    const artifact = (id: string, kind: Artifact['kind'], ref: Artifact['ref'], createdAt: number): Artifact => ({ id, projectId: 'p', kind, title: id, ref, createdAt });

    it('is the path of the document created last, whatever else the task produced', () => {
        expect(newestDocPath([
            artifact('old', 'doc', { path: 'notes/old.md' }, 1),
            artifact('diff', 'diff', { files: 1 }, 9),
            artifact('new', 'doc', { path: 'decisions/pricing.md' }, 5),
        ])).toBe('decisions/pricing.md');
    });

    it('is null when the task has no document', () => {
        expect(newestDocPath([])).toBeNull();
        expect(newestDocPath([artifact('c', 'check', { exitCode: 0 }, 1), artifact('d', 'build', { path: 'release/app.zip' }, 2)])).toBeNull();
    });

    it('skips a document artifact that names no file', () => {
        expect(newestDocPath([artifact('e', 'doc', {}, 3)])).toBeNull();
        expect(newestDocPath([artifact('e', 'doc', {}, 3), artifact('f', 'doc', { path: 'a.md' }, 1)])).toBe('a.md');
    });
});

describe('newestChat', () => {
    it('is the chat updated last, and nothing for no chats', () => {
        const chats = [{ id: 'a', updatedAt: 5 }, { id: 'b', updatedAt: 9 }, { id: 'c', updatedAt: 2 }];

        expect(newestChat(chats)?.id).toBe('b');
        expect(newestChat([])).toBeUndefined();
    });

    it('keeps the first of chats updated at the same time', () => {
        expect(newestChat([{ id: 'a', updatedAt: 1 }, { id: 'b', updatedAt: 1 }])?.id).toBe('a');
    });
});

describe('createdTaskId', () => {
    it('reads the id from the daemon answer and from the fixture answer', () => {
        expect(createdTaskId({ task: { id: 't-9' } })).toBe('t-9');
        expect(createdTaskId({ id: 't-9' })).toBe('t-9');
        expect(createdTaskId(undefined)).toBeUndefined();
        expect(createdTaskId({ task: {} })).toBeUndefined();
    });
});

describe('task grid', () => {
    const statuses: TaskStatus[] = [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'active', name: 'In progress', category: 'active' },
        { id: 'done', name: 'Done', category: 'done' },
    ];
    const tasks = [
        task(1, { statusId: 'done' }),
        task(2, { statusId: 'todo' }),
        task(3, { statusId: 'active' }),
        task(4, { statusId: 'todo' }),
        task(5, { statusId: 'removed' }),
    ];

    it('lists the board column by column in workflow order, empty columns included, tasks in task order', () => {
        expect(taskGrid('board', tasks, statuses)).toEqual([['t-2', 't-4'], ['t-3'], ['t-1']]);
        expect(taskGrid('board', [task(2, { statusId: 'done' })], statuses)).toEqual([[], [], ['t-2']]);
    });

    it('leaves out a task whose status is gone, as the board does', () => {
        expect(taskGrid('board', tasks, statuses).flat()).not.toContain('t-5');
        expect(boardColumns(statuses, tasks).flatMap(column => column.tasks).map(item => item.id)).not.toContain('t-5');
    });

    it('lists the list as one column in the order the list draws it', () => {
        expect(taskGrid('list', [tasks[0], tasks[2], tasks[3]], statuses)).toEqual([['t-1', 't-3', 't-4']]);
    });

    it('has one empty column for an empty list and one per status for an empty board', () => {
        expect(taskGrid('list', [], statuses)).toEqual([[]]);
        expect(taskGrid('board', [], statuses)).toEqual([[], [], []]);
    });

    it('matches the columns the board draws', () => {
        const columns = boardColumns(statuses, tasks);

        expect(columns.map(column => column.status.id)).toEqual(['todo', 'active', 'done']);
        expect(taskGrid('board', tasks, statuses)).toEqual(columns.map(column => column.tasks.map(item => item.id)));
    });
});
