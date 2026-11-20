import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, docHash, FIXTURE_LIVE_RUN_ID, FIXTURE_LIVE_TEXT_ID, FIXTURE_LIVE_TOOL_ID, FIXTURE_PROJECT_ID } from './fixtureData';
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
    it('covers the states of a chat and its sub-agents, and every task status, with dependencies and assigned runs', async () => {
        const transport = new FixtureTransport();
        const snapshot = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        expect(new Set(snapshot.runs.map(run => run.status))).toEqual(new Set(['running', 'waiting_background', 'waiting_user', 'succeeded', 'failed']));
        // A run below another is a native sub-agent; every other run is a chat's orchestrator.
        expect(snapshot.runs.filter(run => run.parentRunId).every(run => run.origin === 'native' && run.role === 'executor')).toBe(true);
        expect(snapshot.runs.filter(run => !run.parentRunId).every(run => run.role === 'orchestrator' && run.chatId !== undefined)).toBe(true);
        expect(new Set(snapshot.tasks.map(task => task.statusId))).toEqual(new Set(snapshot.statuses.map(status => status.id)));
        expect(snapshot.tasks.some(task => task.dependsOn.length > 0)).toBe(true);
        expect(snapshot.runTaskLinks.some(link => link.relation === 'assigned')).toBe(true);
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

    it('opens a chat for a started task, with its orchestrator assigned to it, and runs it to the Review column', async () => {
        const { transport, events } = await connected();
        const started = await transport.command({ type: 'task.start', taskId: 't-28' });

        expect(started).toMatchObject({ ok: true, data: { runId: expect.any(String), chatId: expect.any(String) } });

        const { runId, chatId } = (started as { data: { runId: string; chatId: string } }).data;
        const snapshot = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        expect(snapshot.chats.find(chat => chat.id === chatId)).toMatchObject({ title: 'Search by location', orchestratorRunId: runId });
        expect(snapshot.runs.find(run => run.id === runId)).toMatchObject({ role: 'orchestrator', chatId });
        expect(snapshot.runTaskLinks).toContainEqual({ runId, taskId: 't-28', relation: 'assigned' });

        await vi.advanceTimersByTimeAsync(3000);

        const taskStatuses = events.flatMap(event => (event.data.type === 'task.upserted' && event.data.task.id === 't-28' ? [event.data.task.statusId] : []));

        expect(taskStatuses).toEqual(['active', 'review']);
        expect(events.some(event => event.data.type === 'run.upserted' && event.data.run.status === 'succeeded')).toBe(true);
    });

    it('answers a question: the item gets its answer and the run goes on', async () => {
        const { transport, events } = await connected();

        expect(await transport.command({ type: 'run.answer', runId: 'r-orch-3', questionId: 'q-store', answer: 'SQLite' })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(1500);

        const items = await transport.getItems({ runId: 'r-orch-3' });

        expect(items.find(item => item.body.kind === 'question')?.body).toMatchObject({ answer: 'SQLite' });
        expect(events.some(event => event.data.type === 'run.upserted' && event.data.run.id === 'r-orch-3' && event.data.run.status === 'running')).toBe(true);
        expect(items.at(-1)?.body).toMatchObject({ kind: 'assistant', done: true });
    });

    it('cancels an orchestrator together with the sub-agents below it, and leaves finished ones alone', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'run.cancel', runId: 'r-orch-1' });

        const { runs } = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const status = (id: string) => runs.find(run => run.id === id)?.status;

        expect([status('r-orch-1'), status('r-na-02'), status('r-na-03'), status('r-na-01'), status('r-na-04')]).toEqual(['cancelled', 'cancelled', 'cancelled', 'succeeded', 'failed']);
    });

    it('stops a sub-agent of the session alone when its session can end it, refuses one that cannot, and keeps the orchestrator at work', async () => {
        const data = createFixtureData();

        data.runs.push({ ...structuredClone(data.runs.find(run => run.id === 'r-na-02')!), id: 'r-na-09', canStopAlone: undefined });

        const { transport } = await connected({ data });
        const status = async (id: string) => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === id)?.status;

        expect(await transport.command({ type: 'run.cancel', runId: 'r-na-09' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ type: 'run.cancel', runId: 'r-na-02' })).toMatchObject({ ok: true, data: { cancelled: ['r-na-02'] } });
        expect([await status('r-na-02'), await status('r-na-09'), await status('r-na-03'), await status('r-orch-1')]).toEqual(['cancelled', 'running', 'running', 'running']);
    });

    it('stops the sub-agents of an orchestrator that can stop alone, and not the orchestrator', async () => {
        const data = createFixtureData();

        data.runs.push({ ...structuredClone(data.runs.find(run => run.id === 'r-na-02')!), id: 'r-na-09', canStopAlone: undefined });

        const { transport } = await connected({ data });
        const result = await transport.command({ type: 'run.stopAgents', runId: 'r-orch-1' });
        const { runs } = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const status = (id: string) => runs.find(run => run.id === id)?.status;

        expect(result).toMatchObject({ ok: true });
        expect(result.ok && new Set((result.data as { stopped: string[] }).stopped)).toEqual(new Set(['r-na-02', 'r-na-03']));
        expect([status('r-na-02'), status('r-na-03'), status('r-na-09'), status('r-orch-1'), status('r-na-01')]).toEqual(['cancelled', 'cancelled', 'running', 'running', 'succeeded']);
        expect(await transport.command({ type: 'run.stopAgents', runId: 'r-missing' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

    it('stops one background command that can be stopped alone: it leaves the list with a note, and the run and the rest of its work go on', async () => {
        const { transport } = await connected();
        const orchestrator = async () => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === 'r-orch-5')!;

        // The other one cannot be stopped alone, and an item that is not listed is no stop.
        expect(await transport.command({ type: 'run.stopBackground', runId: 'r-orch-5', itemId: 'bg-2' })).toMatchObject({ ok: true, data: { stopped: false } });
        expect(await transport.command({ type: 'run.stopBackground', runId: 'r-orch-5', itemId: 'nobody' })).toMatchObject({ ok: true, data: { stopped: false } });
        expect((await orchestrator()).background).toHaveLength(2);

        expect(await transport.command({ type: 'run.stopBackground', runId: 'r-orch-5', itemId: 'bg-1' })).toMatchObject({ ok: true, data: { stopped: true } });
        expect(await orchestrator()).toMatchObject({ status: 'waiting_background', background: [{ id: 'bg-2' }] });
        expect((await transport.getItems({ runId: 'r-orch-5' })).some(item => item.body.kind === 'note' && item.body.text === 'Background command stopped: bun run test')).toBe(true);

        // Gone now: a repeat stops nothing, and the last one that cannot be stopped alone stays.
        expect(await transport.command({ type: 'run.stopBackground', runId: 'r-orch-5', itemId: 'bg-1' })).toMatchObject({ ok: true, data: { stopped: false } });
        expect(await transport.command({ type: 'run.stopBackground', runId: 'r-missing', itemId: 'bg-1' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
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

    describe('the queue of a chat', () => {
        const chatOf = async (transport: FixtureTransport, id: string) => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(chat => chat.id === id)!;
        const people = async (transport: FixtureTransport, chatId: string) => (await transport.getItems({ chatId })).flatMap(item => (item.body.kind === 'user' ? [item.body.text] : []));

        it('keeps a message for a busy orchestrator in the queue, and takes a steer a moment later', async () => {
            const { transport } = await connected();
            const before = await people(transport, 'c-1');

            await transport.command({ type: 'chat.send', chatId: 'c-1', text: 'Later', mode: 'queue' });
            await transport.command({ type: 'chat.send', chatId: 'c-1', text: 'Now', mode: 'steer' });

            expect((await chatOf(transport, 'c-1')).queue?.map(item => [item.mode, item.text])).toEqual([['steer', 'Now'], ['queue', 'Later']]);
            expect(await people(transport, 'c-1')).toEqual(before);

            await vi.advanceTimersByTimeAsync(1000);

            expect((await chatOf(transport, 'c-1')).queue?.map(item => item.text)).toEqual(['Later']);
            expect(await people(transport, 'c-1')).toEqual([...before, 'Now']);
        });

        it('holds the queue after Stop, and Send now sends a message as the next turn, after which the queue flows', async () => {
            const { transport } = await connected();

            await transport.command({ type: 'chat.send', chatId: 'c-1', text: 'First' });
            await transport.command({ type: 'chat.send', chatId: 'c-1', text: 'Second' });
            await transport.command({ type: 'run.cancel', runId: 'r-orch-1' });

            const stopped = await chatOf(transport, 'c-1');

            expect(stopped.queuePaused).toBe('stopped');

            await transport.command({ type: 'chat.sendQueued', chatId: 'c-1', itemId: stopped.queue![1].id });

            expect(await chatOf(transport, 'c-1')).toMatchObject({ queue: [{ text: 'First' }] });
            expect((await chatOf(transport, 'c-1')).queuePaused).toBeUndefined();
            expect((await people(transport, 'c-1')).at(-1)).toBe('Second');

            // The turn ends, and the rest of the queue is the next one.
            await vi.advanceTimersByTimeAsync(1500);

            expect((await people(transport, 'c-1')).at(-1)).toBe('First');
            expect((await chatOf(transport, 'c-1')).queue).toBeUndefined();
        });

        it('moves a message among its own kind and removes one', async () => {
            const { transport } = await connected();

            for (const text of ['one', 'two', 'three']) await transport.command({ type: 'chat.send', chatId: 'c-1', text });

            const queue = (await chatOf(transport, 'c-1')).queue!;

            await transport.command({ type: 'chat.moveQueued', chatId: 'c-1', itemId: queue[2].id, index: 0 });
            await transport.command({ type: 'chat.removeQueued', chatId: 'c-1', itemId: queue[1].id });

            expect((await chatOf(transport, 'c-1')).queue?.map(item => item.text)).toEqual(['three', 'one']);
            expect(await transport.command({ type: 'chat.removeQueued', chatId: 'c-1', itemId: 'q-missing' })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        });
    });

    describe('a chat whose orchestrator waits for background work', () => {
        const orchestrator = async (transport: FixtureTransport) => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === 'r-orch-5')!;

        it('is c-5, with two open items and no slot or queue', async () => {
            const { transport } = await connected();
            const chat = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(candidate => candidate.id === 'c-5');

            expect(chat?.orchestratorRunId).toBe('r-orch-5');
            expect(await orchestrator(transport)).toMatchObject({
                status: 'waiting_background',
                statusReason: 'Waiting for background work',
                background: [{ id: 'bg-1', kind: 'command', title: 'bun run test' }, { id: 'bg-2', kind: 'command', title: 'bun run typecheck' }],
            });
            expect(chat?.queue).toBeUndefined();
        });

        it('takes a message at once, answers it, and goes back to waiting while the work is open', async () => {
            const { transport } = await connected();

            await transport.command({ type: 'chat.send', chatId: 'c-5', text: 'How is it going?', mode: 'steer' });

            expect((await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(candidate => candidate.id === 'c-5')?.queue).toBeUndefined();
            expect(await orchestrator(transport)).toMatchObject({ status: 'running', background: [{ id: 'bg-1' }, { id: 'bg-2' }] });

            await vi.advanceTimersByTimeAsync(1500);

            expect(await orchestrator(transport)).toMatchObject({ status: 'waiting_background', statusReason: 'Waiting for background work', background: [{ id: 'bg-1' }, { id: 'bg-2' }] });
            expect((await transport.getItems({ chatId: 'c-5' })).at(-1)?.body).toMatchObject({ kind: 'assistant', done: true });
        });

        it('ends the work with the run when it is stopped', async () => {
            const { transport } = await connected();

            await transport.command({ type: 'run.cancel', runId: 'r-orch-5' });

            const run = await orchestrator(transport);

            expect(run.status).toBe('cancelled');
            expect(run.background).toBeUndefined();
        });
    });

    it('rejects a document write that started from an old version, and a create over an existing file', async () => {
        const { transport } = await connected();
        const path = 'decisions/pricing.md';
        const write = { type: 'docs.write', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path, content: 'mine' } as const;
        const file = await transport.getDocFile(FIXTURE_PROJECT_ID, 'fld_car_rental', path);

        expect(await transport.command({ ...write, baseHash: 'fx-old' })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ ...write, baseHash: null })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(await transport.command({ ...write, baseHash: file.hash })).toMatchObject({ ok: true, data: { hash: docHash('mine') } });
        expect((await transport.getDocFile(FIXTURE_PROJECT_ID, 'fld_car_rental', path)).content).toBe('mine');
        expect(await transport.command({ ...write, folderId: 'fld_nope', baseHash: null })).toMatchObject({ ok: false, error: { code: 'not_found' } });
        await expect(transport.getDocFile(FIXTURE_PROJECT_ID, 'fld_nope', path)).rejects.toMatchObject({ status: 404 });
    });

    it('serves each folder\'s docs as a tree, directories first', async () => {
        const transport = new FixtureTransport();
        const tree = await transport.getDocsTree(FIXTURE_PROJECT_ID);

        expect(tree.map(folder => folder.folderId)).toEqual(['fld_car_rental']);
        expect(tree[0].nodes.map(node => `${ node.kind }:${ node.path }`)).toEqual(['dir:decisions', 'dir:specs', 'file:README.md']);
        expect(tree[0].nodes[0].children?.map(node => node.path)).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md']);
    });

    it('serves the documents of every folder, an empty one too, and the first write into a folder makes its docs', async () => {
        const { transport, events } = await connected();

        await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/car-rental-api' }, { path: '/Users/dev/notes' }] });

        const tree = await transport.getDocsTree(FIXTURE_PROJECT_ID);
        const [, api, notes] = tree.map(folder => folder.folderId);

        expect(tree.map(folder => folder.nodes.map(node => node.path))).toEqual([['decisions', 'specs', 'README.md'], ['decisions', 'endpoints.md'], []]);
        expect((await transport.getDocFile(FIXTURE_PROJECT_ID, api, 'endpoints.md')).content).toContain('# Endpoints');

        events.length = 0;
        expect(await transport.command({ type: 'docs.write', projectId: FIXTURE_PROJECT_ID, folderId: notes, path: 'plan.md', content: '# Plan', baseHash: null })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(0);

        expect((await transport.getDocsTree(FIXTURE_PROJECT_ID))[2].nodes.map(node => node.path)).toEqual(['plan.md']);
        expect(events.map(event => event.data)).toEqual([{ type: 'docs.changed', folderId: notes, path: 'plan.md', change: 'created' }]);
    });

    it('shares the documents of a folder two projects have, and tells both of a change', async () => {
        const { transport, events } = await connected();
        const added = await transport.command({ type: 'project.add', folders: ['/Users/dev/web', '/Users/dev/car-rental'] });
        const other = (added as { data: { project: { id: string; folders: { id: string }[] } } }).data.project;

        expect((await transport.getDocsTree(other.id))[1].nodes.map(node => node.path)).toEqual(['decisions', 'specs', 'README.md']);

        events.length = 0;
        await transport.command({ type: 'docs.write', projectId: other.id, folderId: other.folders[1].id, path: 'shared.md', content: '# Shared', baseHash: null });
        await vi.advanceTimersByTimeAsync(0);

        expect(events.map(event => [event.projectId, event.data])).toEqual([
            [FIXTURE_PROJECT_ID, { type: 'docs.changed', folderId: 'fld_car_rental', path: 'shared.md', change: 'created' }],
            [other.id, { type: 'docs.changed', folderId: other.folders[1].id, path: 'shared.md', change: 'created' }],
        ]);
        expect((await transport.getDocFile(FIXTURE_PROJECT_ID, 'fld_car_rental', 'shared.md')).content).toBe('# Shared');
    });

    it('plays the timeline once, after the first subscription: a tool finishes and text streams in', async () => {
        const { transport, events } = await connected({ timeline: true });

        await vi.advanceTimersByTimeAsync(7000);

        const items = await transport.getItems({ runId: FIXTURE_LIVE_RUN_ID });
        const tool = items.find(item => item.id === FIXTURE_LIVE_TOOL_ID);
        const text = items.find(item => item.id === FIXTURE_LIVE_TEXT_ID);
        const { runs } = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const call = (await transport.getItems({ runId: 'r-orch-1' })).find(item => item.body.kind === 'tool' && item.body.toolCallId === 'tc-agent-3');

        expect(tool?.body).toMatchObject({ kind: 'tool', state: 'done' });
        expect(text?.body).toMatchObject({ kind: 'assistant', done: true });
        // The sub-agent ends, and the call that started it returns its report.
        expect(runs.find(run => run.id === FIXTURE_LIVE_RUN_ID)?.status).toBe('succeeded');
        expect(call?.body).toMatchObject({ kind: 'tool', state: 'done' });
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

    it('archives a chat and brings it back, keeping its runs, and refuses one whose agents are working', async () => {
        const { transport, events } = await connected();
        const before = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        const refused = await transport.command({ type: 'chat.setArchived', chatId: 'c-1', archived: true });

        expect(refused.ok ? '' : refused.error.code).toBe('conflict');

        const archived = await transport.command({ type: 'chat.setArchived', chatId: 'c-4', archived: true });

        await vi.advanceTimersByTimeAsync(0);

        const during = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        expect(archived.ok).toBe(true);
        expect(during.chats.find(chat => chat.id === 'c-4')?.archivedAt).toBeGreaterThan(0);
        expect(during.runs.length).toBe(before.runs.length);
        expect(events.filter(event => event.data.type === 'chat.upserted')).toHaveLength(1);

        // What is set already is not announced again.
        await transport.command({ type: 'chat.setArchived', chatId: 'c-4', archived: true });
        await vi.advanceTimersByTimeAsync(0);

        expect(events.filter(event => event.data.type === 'chat.upserted')).toHaveLength(1);

        await transport.command({ type: 'chat.setArchived', chatId: 'c-4', archived: false });
        await vi.advanceTimersByTimeAsync(0);

        expect((await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(chat => chat.id === 'c-4')).not.toHaveProperty('archivedAt');
        expect((await transport.command({ type: 'chat.setArchived', chatId: 'nope', archived: true })).ok).toBe(false);
    });
});

describe('FixtureTransport agents', () => {
    const agentsOf = async (transport: FixtureTransport) => Object.fromEntries((await transport.getAgents()).map(agent => [agent.id, agent]));

    it('lists Claude, Codex and Cursor as installed and signed in, with the usage rows each shows', async () => {
        const agents = await agentsOf(new FixtureTransport());

        expect(Object.keys(agents)).toEqual(['claude', 'codex', 'cursor']);
        expect(agents.claude?.signIn?.account).toMatchObject({ plan: 'Max' });
        expect(agents.claude?.usage?.windows.map(window => window.label)).toEqual(['Session', 'Week', 'Fable']);
        expect(agents.codex?.usage?.windows.map(window => window.label)).toEqual(['Session', 'Week']);
        expect(agents.cursor?.usage?.windows.map(window => window.label)).toEqual(['Plan usage']);
    });

    it('switches an agent off and on, and announces it once per project', async () => {
        const { transport, events } = await connected();
        const projects = (await transport.getRootSnapshot()).projects.length;
        const off = await transport.command({ type: 'agent.update', id: 'codex', enabled: false });

        await vi.advanceTimersByTimeAsync(0);

        expect(off.ok).toBe(true);
        expect(events.filter(event => event.data.type === 'agents.changed')).toHaveLength(projects);
        expect(await agentsOf(transport)).toMatchObject({ codex: { enabled: false, status: 'disabled' } });

        await transport.command({ type: 'agent.update', id: 'codex', enabled: true });

        expect(await agentsOf(transport)).toMatchObject({ codex: { enabled: true, status: 'ready' } });
    });

    it('changes the settings of an agent by id, and refuses one it does not have', async () => {
        const transport = new FixtureTransport();

        await transport.command({ type: 'agent.update', id: 'claude', settings: { memory: true, subagents: false } });

        const settings = (await agentsOf(transport)).claude?.settings;

        expect(settings?.find(setting => setting.id === 'memory')?.value).toBe(true);
        expect(settings?.find(setting => setting.id === 'subagents')?.value).toBe(false);
        expect(settings?.find(setting => setting.id === 'longContext')?.value).toBe(true);
        expect((await transport.command({ type: 'agent.update', id: 'claude', settings: { nope: true } })).ok).toBe(false);
        expect((await transport.command({ type: 'agent.update', id: 'nobody', enabled: true })).ok).toBe(false);
    });

    it('takes a program path, and goes back to the one it found with null', async () => {
        const transport = new FixtureTransport();

        await transport.command({ type: 'agent.update', id: 'cursor', path: '/opt/cursor/agent' });

        expect((await agentsOf(transport)).cursor?.path).toBe('/opt/cursor/agent');

        await transport.command({ type: 'agent.update', id: 'cursor', path: null });

        expect((await agentsOf(transport)).cursor?.path).toBe('/Users/dev/.local/bin/cursor-agent');
    });

    it('lists what the person changed as overrides: the path they chose, and the environment, which replaces the saved set', async () => {
        const transport = new FixtureTransport();

        expect((await agentsOf(transport)).claude?.overrides).toBeUndefined();

        await transport.command({ type: 'agent.update', id: 'claude', path: '/opt/claude', env: { A: '1', B: '2' } });
        await transport.command({ type: 'agent.update', id: 'claude', env: { C: '3' } });

        expect((await agentsOf(transport)).claude?.overrides).toEqual({ path: '/opt/claude', env: { C: '3' } });

        await transport.command({ type: 'agent.update', id: 'claude', path: null });

        expect((await agentsOf(transport)).claude?.overrides).toEqual({ env: { C: '3' } });
    });

    it('does not make a program that is not installed ready by switching it on', async () => {
        const data = createFixtureData();

        data.agents.find(agent => agent.id === 'cursor')!.status = 'missing';

        const transport = new FixtureTransport({ data });

        await transport.command({ type: 'agent.update', id: 'cursor', enabled: true });

        expect((await agentsOf(transport)).cursor?.status).toBe('missing');
    });

    it('runs a sign-in: starting, then waiting with the link, then done with the agent signed in', async () => {
        const { transport, types } = await connected();
        const session = async () => (await agentsOf(transport)).codex?.signInSession;

        expect((await transport.command({ type: 'agent.signIn', id: 'codex' })).ok).toBe(true);
        expect(await session()).toMatchObject({ step: 'starting' });

        await vi.advanceTimersByTimeAsync(500);

        expect(await session()).toMatchObject({ step: 'waiting', url: expect.stringContaining('auth.openai.com') });
        // One at a time.
        expect((await transport.command({ type: 'agent.signIn', id: 'codex' })).ok).toBe(false);

        await vi.advanceTimersByTimeAsync(4000);

        expect(await session()).toMatchObject({ step: 'done' });
        expect((await agentsOf(transport)).codex?.signIn?.status).toBe('signed-in');
        expect(types().filter(type => type === 'agents.changed').length).toBeGreaterThanOrEqual(3);
    });

    it('cancels a sign-in, and then the timers do not finish it', async () => {
        const transport = new FixtureTransport();

        await transport.command({ type: 'agent.signIn', id: 'claude' });
        await vi.advanceTimersByTimeAsync(500);
        await transport.command({ type: 'agent.cancelSignIn', id: 'claude' });

        expect((await agentsOf(transport)).claude?.signInSession).toMatchObject({ step: 'cancelled', message: expect.stringContaining('cancelled') });

        await vi.advanceTimersByTimeAsync(10_000);

        expect((await agentsOf(transport)).claude?.signInSession?.step).toBe('cancelled');
        // It can be started again.
        expect((await transport.command({ type: 'agent.signIn', id: 'claude' })).ok).toBe(true);
    });

    it('reads accounts and usage again on refresh, and announces it', async () => {
        const { transport, types } = await connected();
        const before = (await agentsOf(transport)).claude?.usage?.fetchedAt ?? 0;

        await vi.advanceTimersByTimeAsync(1000);
        await transport.command({ type: 'agents.refresh' });
        await vi.advanceTimersByTimeAsync(0);

        expect((await agentsOf(transport)).claude?.usage?.fetchedAt).toBeGreaterThan(before);
        expect(types()).toContain('agents.changed');
    });
});

/*
 * The threads of c-6 (Ship the checkout, at rest): c-6a (running, with a notice of its thread c-6a1 waiting in its queue), c-6b (done), c-6c (failed),
 * c-6e (waiting for background work); c-6a1 (done) is the thread of c-6a.
 */
describe('FixtureTransport threads', () => {
    const snapshot = (transport: FixtureTransport) => transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
    const chatOf = async (transport: FixtureTransport, id: string) => (await snapshot(transport)).chats.find(chat => chat.id === id);
    const runOf = async (transport: FixtureTransport, id: string) => (await snapshot(transport)).runs.find(run => run.id === id);
    const lastUser = async (transport: FixtureTransport, chatId: string) => (await transport.getItems({ chatId })).findLast(item => item.body.kind === 'user')?.body;

    it('seeds threads as chats below their parent, each answered by a root run of its own, in every state the app draws', async () => {
        const { chats, runs } = await snapshot(new FixtureTransport());
        const threads = chats.filter(chat => chat.parentChatId !== undefined);
        const statusOf = (chatId: string) => runs.find(run => run.chatId === chatId)?.status;

        expect(threads.map(chat => [chat.id, chat.parentChatId])).toEqual([['c-6a', 'c-6'], ['c-6a1', 'c-6a'], ['c-6b', 'c-6'], ['c-6c', 'c-6'], ['c-6e', 'c-6']]);
        expect(threads.map(chat => runs.find(run => run.id === chat.orchestratorRunId)).every(run => run?.role === 'orchestrator' && run.parentRunId === undefined && run.rootRunId === run.id)).toBe(true);
        expect(threads.map(chat => statusOf(chat.id))).toEqual(['running', 'succeeded', 'succeeded', 'failed', 'waiting_background']);
        expect(chats.find(chat => chat.id === 'c-6a')?.queue?.[0]).toMatchObject({ text: 'Thread "Check the currency table" finished', from: { kind: 'threadNotice' } });
    });

    it('opens every thread with a message from its parent, and tells the parent what stopped', async () => {
        const transport = new FixtureTransport();

        expect((await transport.getItems({ chatId: 'c-6b' }))[0].body).toMatchObject({ kind: 'user', from: { kind: 'thread', chatId: 'c-6', title: 'Ship the checkout' } });
        expect((await transport.getItems({ chatId: 'c-6' })).flatMap(item => (item.body.kind === 'user' && item.body.from?.kind === 'threadNotice' ? item.body.from.threads.map(entry => entry.outcome) : []))).toEqual(['finished', 'failed', 'finished']);
    });

    it('stops a thread alone: its run is cancelled and its queue held, its parent and the other threads go on', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'run.cancel', runId: 'r-orch-6a' });

        expect((await runOf(transport, 'r-orch-6a'))?.status).toBe('cancelled');
        expect((await chatOf(transport, 'c-6a'))?.queuePaused).toBe('stopped');
        expect([(await runOf(transport, 'r-orch-6'))?.status, (await runOf(transport, 'r-orch-6e'))?.status]).toEqual(['succeeded', 'waiting_background']);
    });

    it('refuses to archive or delete a chat while one of its threads works, and takes the threads with it once they are stopped', async () => {
        const { transport, events } = await connected();

        for (const type of ['chat.setArchived', 'chat.delete'] as const) {
            const refused = await transport.command(type === 'chat.delete' ? { type, chatId: 'c-6' } : { type, chatId: 'c-6', archived: true });

            expect(refused.ok ? '' : refused.error.code).toBe('conflict');
        }

        await transport.command({ type: 'run.cancel', runId: 'r-orch-6a' });
        await transport.command({ type: 'run.cancel', runId: 'r-orch-6e' });
        await vi.advanceTimersByTimeAsync(0);
        events.length = 0;

        expect((await transport.command({ type: 'chat.setArchived', chatId: 'c-6', archived: true })).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        const archived = events.flatMap(event => (event.data.type === 'chat.upserted' ? [event.data.chat.id] : []));

        // Each thread before its parent, the chat itself last.
        expect(archived).toEqual(['c-6a1', 'c-6e', 'c-6c', 'c-6b', 'c-6a', 'c-6']);
        expect((await snapshot(transport)).chats.filter(chat => chat.id.startsWith('c-6')).every(chat => chat.archivedAt !== undefined)).toBe(true);

        // Back from the archive: the chat alone.
        await transport.command({ type: 'chat.setArchived', chatId: 'c-6', archived: false });

        expect((await chatOf(transport, 'c-6'))?.archivedAt).toBeUndefined();
        expect((await chatOf(transport, 'c-6a'))?.archivedAt).toBeDefined();
    });

    it('deletes a chat with every thread below it, archived ones too, and their runs', async () => {
        const { transport, events } = await connected();

        await transport.command({ type: 'run.cancel', runId: 'r-orch-6a' });
        await transport.command({ type: 'run.cancel', runId: 'r-orch-6e' });
        await transport.command({ type: 'chat.setArchived', chatId: 'c-6b', archived: true });
        await vi.advanceTimersByTimeAsync(0);
        events.length = 0;

        expect((await transport.command({ type: 'chat.delete', chatId: 'c-6' })).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        const deleted = events.flatMap(event => (event.data.type === 'chat.deleted' ? [[event.data.chatId, event.data.runIds]] : []));
        const after = await snapshot(transport);

        expect(deleted).toEqual([['c-6a1', ['r-orch-6a1']], ['c-6e', ['r-orch-6e']], ['c-6c', ['r-orch-6c']], ['c-6b', ['r-orch-6b']], ['c-6a', ['r-orch-6a']], ['c-6', ['r-orch-6']]]);
        expect(after.chats.some(chat => chat.id.startsWith('c-6'))).toBe(false);
        expect(after.runs.some(run => run.id.startsWith('r-orch-6'))).toBe(false);
    });

    it('takes a message to a thread in that thread\'s chat, and tells its parent at rest when the turn ends, which starts the parent\'s turn', async () => {
        const { transport } = await connected();
        const parentBefore = (await transport.getItems({ chatId: 'c-6' })).length;

        await transport.command({ type: 'chat.send', chatId: 'c-6b', text: 'Add a case for a refund in another currency' });

        expect(await lastUser(transport, 'c-6b')).toEqual({ kind: 'user', text: 'Add a case for a refund in another currency' });
        expect((await transport.getItems({ chatId: 'c-6' })).length).toBe(parentBefore);

        await vi.advanceTimersByTimeAsync(1500);

        expect(await lastUser(transport, 'c-6')).toMatchObject({
            kind: 'user',
            text: '',
            from: { kind: 'threadNotice', threads: [{ chatId: 'c-6b', title: 'Write the refund tests', outcome: 'finished', text: expect.stringContaining('Got it') }] },
        });
        expect((await runOf(transport, 'r-orch-6'))?.status).toBe('running');
    });

    it('queues the notice for a busy parent, merged with the notices already waiting, the latest of a thread winning', async () => {
        const data = createFixtureData();

        data.chats.push({ ...data.chats.find(chat => chat.id === 'c-6a1')!, id: 'c-6a2', title: 'Check the tax table', orchestratorRunId: 'r-orch-6a2' });
        data.runs.push({ ...data.runs.find(run => run.id === 'r-orch-6a1')!, id: 'r-orch-6a2', rootRunId: 'r-orch-6a2', chatId: 'c-6a2' });

        const { transport } = await connected({ data });

        await transport.command({ type: 'chat.send', chatId: 'c-6a1', text: 'Check the rates again' });
        await transport.command({ type: 'chat.send', chatId: 'c-6a2', text: 'Check the taxes' });
        await vi.advanceTimersByTimeAsync(1500);

        const [item, ...rest] = (await chatOf(transport, 'c-6a'))?.queue ?? [];

        expect(rest).toEqual([]);
        expect(item).toMatchObject({ id: 'q-notice-6a', mode: 'queue', text: '2 threads stopped' });
        expect(item.from?.kind === 'threadNotice' && item.from.threads.map(entry => [entry.chatId, entry.text?.slice(0, 6)])).toEqual([['c-6a1', 'Got it'], ['c-6a2', 'Got it']]);
        expect((await runOf(transport, 'r-orch-6a'))?.status).toBe('running');
    });

    it('holds the notice in a parent whose queue is held, and sends a queued notice as a turn without words of its own', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'run.cancel', runId: 'r-orch-6a' });
        await transport.command({ type: 'chat.send', chatId: 'c-6a1', text: 'Check the rates again' });
        await vi.advanceTimersByTimeAsync(1500);

        expect((await chatOf(transport, 'c-6a'))?.queue).toHaveLength(1);
        expect((await runOf(transport, 'r-orch-6a'))?.status).toBe('cancelled');

        await transport.command({ type: 'chat.sendQueued', chatId: 'c-6a', itemId: 'q-notice-6a' });

        expect(await lastUser(transport, 'c-6a')).toMatchObject({ kind: 'user', text: '', from: { kind: 'threadNotice' } });
        expect((await chatOf(transport, 'c-6a'))?.queue).toBeUndefined();
    });

    it('tells no parent of a thread that was stopped, or of a parent in the archive', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'chat.send', chatId: 'c-6b', text: 'One more case' });
        await transport.command({ type: 'run.cancel', runId: 'r-orch-6b' });
        await vi.advanceTimersByTimeAsync(1500);

        expect((await runOf(transport, 'r-orch-6'))?.status).toBe('succeeded');

        await transport.command({ type: 'chat.setArchived', chatId: 'c-6a1', archived: true });
        await transport.command({ type: 'run.cancel', runId: 'r-orch-6a' });
        await transport.command({ type: 'chat.setArchived', chatId: 'c-6a', archived: true });
        await transport.command({ type: 'chat.send', chatId: 'c-6a1', text: 'Again' });
        await vi.advanceTimersByTimeAsync(1500);

        // The notice that waited is the same one: a new one would have replaced the thread's words with the reply to `Again`.
        const queue = (await chatOf(transport, 'c-6a'))?.queue ?? [];

        expect(queue).toHaveLength(1);
        expect(queue[0].from?.kind === 'threadNotice' && queue[0].from.threads.map(entry => entry.text)).toEqual(['Every currency in the table has two decimals except JPY, which has none.']);
    });
});
