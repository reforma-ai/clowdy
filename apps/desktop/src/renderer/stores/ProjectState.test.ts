import { describe, expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { ProjectState } from './ProjectState';

import type { ClowdyEvent, EventData, Run, Task } from '@clowdy/protocol';

async function loadedProject() {
    const data = createFixtureData();
    const transport = new FixtureTransport({ data });
    const state = new ProjectState(transport, data.projects[0]);

    await state.load();

    return { data, transport, state };
}

const event = (cursor: number, data: EventData): ClowdyEvent => ({ cursor, at: 0, projectId: FIXTURE_PROJECT_ID, data });

describe('ProjectState', () => {
    it('loads the snapshot and starts its cursor there', async () => {
        const { state } = await loadedProject();

        expect(state.status).toBe('ready');
        expect(state.cursor).toBe(1000);
        expect(state.tasks.get('t-24')?.title).toBe('Update the booking form');
        expect(state.chats.size).toBe(5);
    });

    it('applies an upsert event once its cursor is past the snapshot cursor, and advances', async () => {
        const { state } = await loadedProject();
        const task = { ...state.tasks.get('t-24')!, title: 'Renamed' };

        state.applyEvent(event(1001, { type: 'task.upserted', task }));

        expect(state.tasks.get('t-24')?.title).toBe('Renamed');
        expect(state.cursor).toBe(1001);
    });

    it('skips an event at or before the snapshot cursor, because the snapshot already holds it', async () => {
        const { state } = await loadedProject();
        const stale = { ...state.tasks.get('t-24')!, title: 'Stale' };

        state.applyEvent(event(1000, { type: 'task.upserted', task: stale }));
        state.applyEvent(event(990, { type: 'task.upserted', task: stale }));

        expect(state.tasks.get('t-24')?.title).toBe('Update the booking form');
        expect(state.cursor).toBe(1000);
    });

    it('does not apply the same event twice or an older one after a newer one', async () => {
        const { state } = await loadedProject();
        const first = { ...state.tasks.get('t-24')!, title: 'First' };
        const second = { ...first, title: 'Second' };

        state.applyEvent(event(1002, { type: 'task.upserted', task: second }));
        state.applyEvent(event(1001, { type: 'task.upserted', task: first }));

        expect(state.tasks.get('t-24')?.title).toBe('Second');
    });

    it('holds events that arrive during the first load and applies those newer than the snapshot', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const state = new ProjectState(transport, data.projects[0]);
        const loading = state.load();
        const task = (title: string): Task => ({ ...data.tasks[0], title });

        state.applyEvent(event(999, { type: 'task.upserted', task: task('Older than the snapshot') }));
        state.applyEvent(event(1001, { type: 'task.upserted', task: task('Newer than the snapshot') }));
        await loading;

        expect(state.tasks.get(data.tasks[0].id)?.title).toBe('Newer than the snapshot');
        expect(state.cursor).toBe(1001);
    });

    it('drops a deleted task together with its links', async () => {
        const { state } = await loadedProject();

        expect(state.runsOfTask('t-24').map(run => run.id)).toEqual(['r-orch-1', 'r-orch-5']);
        state.applyEvent(event(1001, { type: 'task.deleted', taskId: 't-24' }));

        expect(state.tasks.has('t-24')).toBe(false);
        expect(state.runsOfTask('t-24')).toEqual([]);
        expect(state.tasksOfChat('c-1').map(task => task.key)).not.toContain('CAR-24');
    });

    it('drops a deleted chat with its runs and their task links, and keeps the tasks', async () => {
        const { state } = await loadedProject();
        const chat = state.chats.get('c-1')!;
        const runIds = [...state.runs.values()].filter(run => run.chatId === 'c-1' || run.rootRunId === chat.orchestratorRunId).map(run => run.id);

        expect(runIds.length).toBeGreaterThan(1);
        expect(state.tasksOfChat('c-1').length).toBeGreaterThan(0);

        state.applyEvent(event(1001, { type: 'chat.deleted', chatId: 'c-1', runIds }));

        expect(state.chats.has('c-1')).toBe(false);
        expect(runIds.some(runId => state.runs.has(runId))).toBe(false);
        expect(state.tasksOfChat('c-1')).toEqual([]);
        expect(runIds.flatMap(runId => state.linksOfRun(runId))).toEqual([]);
        expect(state.tasks.has('t-24')).toBe(true);
        expect(state.chats.size).toBe(4);
    });

    it('adds and removes links by event', async () => {
        const { state } = await loadedProject();
        const link = { chatId: 'c-4', taskId: 't-28' };

        state.applyEvent(event(1001, { type: 'link.chatTask', link, present: true }));
        expect(state.tasksOfChat('c-4').map(task => task.key)).toEqual(['CAR-28']);
        expect(state.chatsOfTask('t-28').map(chat => chat.id).sort()).toEqual(['c-2', 'c-4']);

        state.applyEvent(event(1002, { type: 'link.chatTask', link, present: false }));
        expect(state.tasksOfChat('c-4')).toEqual([]);
    });

    it('answers many-to-many questions: tasks of a run, runs of a task', async () => {
        const { state } = await loadedProject();

        // One run on several tasks: the ones its orchestrator created and works on.
        expect(state.tasksOfRun('r-orch-1').map(task => task.key)).toEqual(['CAR-21', 'CAR-24', 'CAR-25']);
        // Two runs on one task: the orchestrator that created it and works on it, and another chat's orchestrator assigned to it.
        expect(state.runsOfTask('t-24').map(run => run.name)).toEqual(['Orchestrator 01', 'Orchestrator 05']);
        expect(state.linksOfRun('r-orch-5')).toEqual([{ runId: 'r-orch-5', taskId: 't-24', relation: 'assigned' }]);
        expect(state.runsOfTask('t-999')).toEqual([]);
    });

    it('does not list a run twice when it is linked to one task under two relations', async () => {
        const { state } = await loadedProject();

        state.applyEvent(event(1001, { type: 'link.runTask', link: { runId: 'r-orch-5', taskId: 't-24', relation: 'created' }, present: true }));

        expect(state.runsOfTask('t-24').filter(run => run.id === 'r-orch-5')).toHaveLength(1);
        expect(state.linksOfRun('r-orch-5')).toHaveLength(2);
    });

    it('groups tasks by status in workflow order, with empty columns kept', async () => {
        const { state } = await loadedProject();
        const columns = [...state.tasksByStatus].map(([statusId, tasks]) => [statusId, tasks.map(task => task.number)]);

        expect(columns).toEqual([
            ['backlog', [28, 30]],
            ['todo', [26, 27]],
            ['active', [24, 25]],
            ['review', [23]],
            ['done', [20, 21, 22]],
            ['canceled', [29]],
        ]);

        const task = { ...state.tasks.get('t-24')!, statusId: 'review' };

        state.applyEvent(event(1001, { type: 'task.upserted', task }));
        expect(state.tasksByStatus.get('review')?.map(candidate => candidate.number)).toEqual([23, 24]);
    });

    it('follows run upserts', async () => {
        const { state } = await loadedProject();
        const finished: Run = { ...state.runs.get('r-na-03')!, status: 'succeeded' };

        state.applyEvent(event(1001, { type: 'run.upserted', run: finished }));

        expect(state.runs.get('r-na-03')?.status).toBe('succeeded');
    });

    it('notes docs changes and artifacts for the screens that show them', async () => {
        const { state } = await loadedProject();

        state.applyEvent(event(1001, { type: 'docs.changed', folderId: 'fld_car_rental', path: 'decisions/pricing.md', change: 'modified' }));
        state.applyEvent(event(1002, { type: 'artifact.added', artifact: { id: 'a', projectId: FIXTURE_PROJECT_ID, kind: 'diff', title: 'Diff', ref: {}, createdAt: 0 } }));

        expect(state.lastDocsChange).toEqual({ folderId: 'fld_car_rental', path: 'decisions/pricing.md', change: 'modified', cursor: 1001 });
        expect(state.artifactsRevision).toBe(1);
    });

    it('records a failed load and ignores events until a load succeeds', async () => {
        const data = createFixtureData();
        const transport = new FixtureTransport({ data });
        const state = new ProjectState(overrideTransport(transport, { getProjectSnapshot: () => Promise.reject(new Error('offline')) }), data.projects[0]);

        expect(await state.load()).toBe(false);
        expect(state.status).toBe('failed');
        expect(state.error).toBe('offline');

        state.applyEvent(event(1001, { type: 'task.upserted', task: data.tasks[0] }));
        expect(state.tasks.size).toBe(0);
    });
});
