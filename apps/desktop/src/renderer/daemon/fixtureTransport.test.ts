import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, docHash, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';

import type { ClowdyEvent } from '@clowdy/protocol';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

async function connected(options: ConstructorParameters<typeof FixtureTransport>[0] = {}) {
    const transport = new FixtureTransport(options);
    const { cursor } = await transport.getRootSnapshot();
    const events: ClowdyEvent[] = [];

    transport.subscribe(cursor, event => events.push(event), () => undefined);
    await vi.advanceTimersByTimeAsync(0);

    return { transport, events, types: () => events.map(event => event.data.type) };
}

describe('FixtureTransport', () => {
    it('covers every run status and every task status, with dependencies and executors', async () => {
        const transport = new FixtureTransport();
        const snapshot = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        expect(new Set(snapshot.runs.map(run => run.status))).toEqual(new Set(['queued', 'running', 'waiting_user', 'blocked', 'succeeded', 'failed', 'cancelled', 'interrupted']));
        expect(new Set(snapshot.tasks.map(task => task.statusId))).toEqual(new Set(snapshot.statuses.map(status => status.id)));
        expect(snapshot.tasks.some(task => task.dependsOn.length > 0)).toBe(true);
        expect(snapshot.runs.some(run => run.parentRunId && snapshot.runs.some(parent => parent.id === run.parentRunId && parent.parentRunId))).toBe(true);
    });

    it('hands out copies, so a client cannot change what the next snapshot shows', async () => {
        const transport = new FixtureTransport();
        const first = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        first.tasks[0].title = 'Tampered';

        expect((await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).tasks[0].title).not.toBe('Tampered');
    });

    it('replays the events after a cursor to a late subscriber', async () => {
        const transport = new FixtureTransport();
        const { cursor } = await transport.getRootSnapshot();

        await transport.command({ type: 'chat.rename', chatId: 'c-1', title: 'Renamed' });

        const events: ClowdyEvent[] = [];

        transport.subscribe(cursor, event => events.push(event), () => undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(events.map(event => event.cursor)).toEqual([cursor + 1]);
    });

    it('creates a task with the next key, links it to the chat, and announces both', async () => {
        const { transport, types } = await connected();
        const result = await transport.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: 'Add a map', chatId: 'c-1' });

        await vi.advanceTimersByTimeAsync(0);

        expect(result).toMatchObject({ ok: true, data: { key: 'CAR-31', statusId: 'todo' } });
        expect(types()).toEqual(['task.upserted', 'link.chatTask']);
    });

    it('refuses to start a second run on a task that has an active one, unless forced', async () => {
        const { transport } = await connected();

        expect(await transport.command({ type: 'task.start', taskId: 't-24' })).toMatchObject({ ok: false, error: { code: 'already_running' } });
        expect(await transport.command({ type: 'task.start', taskId: 't-24', force: true })).toMatchObject({ ok: true });
    });

    it('runs a started task to the Review column', async () => {
        const { transport, events } = await connected();

        await transport.command({ type: 'task.start', taskId: 't-28' });
        await vi.advanceTimersByTimeAsync(3000);

        const taskStatuses = events.flatMap(event => (event.data.type === 'task.upserted' && event.data.task.id === 't-28' ? [event.data.task.statusId] : []));

        expect(taskStatuses).toEqual(['active', 'review']);
        expect(events.some(event => event.data.type === 'run.upserted' && event.data.run.status === 'succeeded')).toBe(true);
    });

    it('answers a question: the item gets its answer and the run goes on', async () => {
        const { transport, events } = await connected();

        expect(await transport.command({ type: 'run.answer', runId: 'r-ex-08', questionId: 'q-mail', answer: 'Plain SMTP' })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(1500);

        const items = await transport.getItems({ runId: 'r-ex-08' });

        expect(items.find(item => item.body.kind === 'question')?.body).toMatchObject({ answer: 'Plain SMTP' });
        expect(events.some(event => event.data.type === 'run.upserted' && event.data.run.id === 'r-ex-08' && event.data.run.status === 'running')).toBe(true);
        expect(items.at(-1)?.body).toMatchObject({ kind: 'assistant', done: true });
    });

    it('cancels a run together with the runs below it, and leaves finished ones alone', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'run.cancel', runId: 'r-ex-07' });

        const { runs } = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const status = (id: string) => runs.find(run => run.id === id)?.status;

        expect([status('r-ex-07'), status('r-ver-02'), status('r-ex-09'), status('r-orch-1')]).toEqual(['cancelled', 'cancelled', 'succeeded', 'running']);
    });

    it('streams a reply to a chat message, starting an orchestrator for a chat that had none', async () => {
        const { transport, events } = await connected();

        await transport.command({ type: 'chat.send', chatId: 'c-4', text: 'Plan the admin area' });
        await vi.advanceTimersByTimeAsync(1500);

        const chat = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(candidate => candidate.id === 'c-4');
        const items = await transport.getItems({ chatId: 'c-4' });

        expect(chat?.orchestratorRunId).toBeDefined();
        expect(items.map(item => item.body.kind)).toEqual(['user', 'assistant']);
        expect(events.filter(event => event.data.type === 'stream.item')).toHaveLength(4);
        expect(items[1].body).toMatchObject({ done: true });
    });

    it('rejects a document write that started from an old version, and a create over an existing file', async () => {
        const { transport } = await connected();
        const path = 'decisions/pricing.md';
        const file = await transport.getDocFile(FIXTURE_PROJECT_ID, path);

        expect(await transport.command({ type: 'docs.write', projectId: FIXTURE_PROJECT_ID, path, content: 'mine', baseHash: 'fx-old' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'docs.write', projectId: FIXTURE_PROJECT_ID, path, content: 'mine', baseHash: null })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'docs.write', projectId: FIXTURE_PROJECT_ID, path, content: 'mine', baseHash: file.hash })).toMatchObject({ ok: true, data: { hash: docHash('mine') } });
        expect((await transport.getDocFile(FIXTURE_PROJECT_ID, path)).content).toBe('mine');
    });

    it('serves the docs folder as a tree, directories first', async () => {
        const transport = new FixtureTransport();
        const tree = await transport.getDocsTree(FIXTURE_PROJECT_ID);

        expect(tree.map(node => `${ node.kind }:${ node.path }`)).toEqual(['dir:decisions', 'dir:specs', 'file:README.md']);
        expect(tree[0].children?.map(node => node.path)).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md']);
    });

    it('plays the timeline once, after the first subscription: a tool finishes and text streams in', async () => {
        const { transport, events } = await connected({ timeline: true });

        await vi.advanceTimersByTimeAsync(7000);

        const items = await transport.getItems({ runId: 'r-ex-07' });
        const tool = items.find(item => item.id === 'r-ex-07-8');
        const text = items.find(item => item.id === 'r-ex-07-9');

        expect(tool?.body).toMatchObject({ kind: 'tool', state: 'done' });
        expect(text?.body).toMatchObject({ kind: 'assistant', done: true });
        expect(events.filter(event => event.data.type === 'stream.item').length).toBeGreaterThanOrEqual(4);
    });

    it('stays still without the timeline', async () => {
        const { events } = await connected({ data: createFixtureData() });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(events).toEqual([]);
    });

    it('deletes a finished chat with its runs, and refuses one whose agents are working', async () => {
        const { transport, events } = await connected();
        const before = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const refused = await transport.command({ type: 'chat.delete', chatId: 'c-1' });

        expect(refused.ok ? '' : refused.error.code).toBe('conflict');

        const finished = before.chats.find(chat => !before.runs.some(run => run.chatId === chat.id && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)))!;
        const done = await transport.command({ type: 'chat.delete', chatId: finished.id });

        await vi.advanceTimersByTimeAsync(0);

        const after = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const deleted = events.map(event => event.data).find(data => data.type === 'chat.deleted');

        expect(done.ok).toBe(true);
        expect(after.chats.map(chat => chat.id)).not.toContain(finished.id);
        expect(deleted).toMatchObject({ type: 'chat.deleted', chatId: finished.id });
        expect(after.runs.length).toBe(before.runs.length - (deleted as { runIds: string[] }).runIds.length);
    });
});
