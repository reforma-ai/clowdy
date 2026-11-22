import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_FORK_CHAT_ID, FIXTURE_LIVE_RUN_ID, FIXTURE_LIVE_TEXT_ID, FIXTURE_LIVE_TOOL_ID, FIXTURE_PROJECT_ID, withFixtureApprovals, withFixtureFork } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';

import type { ClowdyEvent, StreamItemBody } from '@clowdy/protocol';

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

    it('answers the detail of a task with the task itself, and refuses one it does not have', async () => {
        const transport = new FixtureTransport();
        const [first] = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).tasks;
        const detail = await transport.getTaskDetail(first.id);

        expect(detail.taskId).toBe(first.id);
        expect(detail.task).toEqual(first);

        detail.task.title = 'Tampered';

        expect((await transport.getTaskDetail(first.id)).task.title).toBe(first.title);
        await expect(transport.getTaskDetail('t-missing')).rejects.toMatchObject({ status: 404 });
    });

    it('answers the detail of a task by its key, the archived ones too, and refuses what is not a key of the project like a task it does not have', async () => {
        const transport = new FixtureTransport();
        const [first] = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).tasks;
        const [prefix, number] = first.key.split('-');
        const archived = (await transport.getArchivedTasks(FIXTURE_PROJECT_ID)).tasks[0];

        expect(archived.archivedAt).toBeGreaterThan(0);
        expect(await transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, first.key)).toEqual(await transport.getTaskDetail(first.id));
        expect((await transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, `${ prefix.toLowerCase() }-${ number }`)).taskId).toBe(first.id);
        expect(await transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, archived.key)).toEqual(await transport.getTaskDetail(archived.id));

        const detail = await transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, first.key);

        detail.task.title = 'Tampered';

        expect((await transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, first.key)).task.title).toBe(first.title);

        // Another project's prefix, no such number, and keys that are not keys.
        const refused = [`${ prefix }-9999`, 'CLW-1', prefix, `${ prefix }-`, `-${ number }`, number, `${ prefix }-abc`, `${ first.key }-2`, first.id, ''];

        for (const key of refused) await expect(transport.getTaskDetailByKey(FIXTURE_PROJECT_ID, key), key).rejects.toMatchObject({ status: 404 });

        await expect(transport.getTaskDetailByKey('p-missing', first.key)).rejects.toMatchObject({ status: 404 });
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

        // The next number after the demo tasks, the archived ones too; the daemon answers `{ task }`.
        expect(result).toMatchObject({ ok: true, data: { task: { key: 'CAR-41', statusId: 'todo' } } });
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

    it('decides an approval: the item keeps the decision, a second decision is refused, and the run goes on when no card is left', async () => {
        const data = createFixtureData();
        const body: Omit<Extract<StreamItemBody, { kind: 'approval' }>, 'approvalId' | 'state'> = { kind: 'approval', title: 'Run ls', subject: { kind: 'command', command: 'ls' }, decisions: ['allow_once', 'reject'] };

        data.items['r-orch-3'].push(
            { id: 'r-orch-3-apv-1', runId: 'r-orch-3', seq: 100, at: Date.now(), body: { ...body, approvalId: 'apv-1', state: 'open' } },
            { id: 'r-orch-3-apv-2', runId: 'r-orch-3', seq: 101, at: Date.now(), body: { ...body, approvalId: 'apv-2', state: 'open' } }
        );

        const { transport } = await connected({ data });
        const decide = (approvalId: string, decision: 'allow_once' | 'allow_always' | 'reject') => transport.command({ type: 'run.decide', runId: 'r-orch-3', approvalId, decision });
        const status = async () => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === 'r-orch-3')?.status;

        expect(await decide('apv-missing', 'allow_once')).toMatchObject({ ok: false, error: { code: 'not_found' } });
        expect(await decide('apv-1', 'allow_always')).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(await decide('apv-1', 'reject')).toMatchObject({ ok: true });
        expect(await decide('apv-1', 'reject')).toMatchObject({ ok: false, error: { code: 'conflict' } });

        const items = await transport.getItems({ runId: 'r-orch-3' });

        expect(items.find(item => item.id === 'r-orch-3-apv-1')?.body).toMatchObject({ state: 'decided', decision: 'reject' });
        // One card and the question are still open.
        expect(await status()).toBe('waiting_user');
        expect(await decide('apv-2', 'allow_once')).toMatchObject({ ok: true });
        expect(await status()).toBe('waiting_user');
        expect(await transport.command({ type: 'run.answer', runId: 'r-orch-3', questionId: 'q-store', answer: 'SQLite' })).toMatchObject({ ok: true });
    });

    it('keeps a run waiting while a request for permission is open, whichever of the cards is answered last', async () => {
        const data = withFixtureApprovals(createFixtureData());

        data.items['r-orch-8'].push({ id: 'r-orch-8-q', runId: 'r-orch-8', seq: 100, at: Date.now(), body: { kind: 'question', questionId: 'q-order', text: 'Which order?', options: [{ id: 'a', label: 'A' }] } });

        const { transport } = await connected({ data });
        const status = async () => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === 'r-orch-8')?.status;
        const decide = (approvalId: string) => transport.command({ type: 'run.decide', runId: 'r-orch-8', approvalId, decision: 'allow_once' });

        // The question is answered first: three requests are still open, so the run does not go on.
        expect(await transport.command({ type: 'run.answer', runId: 'r-orch-8', questionId: 'q-order', answer: 'A' })).toMatchObject({ ok: true });
        expect(await status()).toBe('waiting_user');
        expect(await decide('apv-2')).toMatchObject({ ok: true });
        expect(await decide('apv-3')).toMatchObject({ ok: true });
        expect(await status()).toBe('waiting_user');
        expect(await decide('apv-4')).toMatchObject({ ok: true });
        expect(await status()).toBe('running');
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

    it('serves each folder\'s docs as a tree, directories first', async () => {
        const transport = new FixtureTransport();
        const tree = await transport.getDocsTree(FIXTURE_PROJECT_ID);

        expect(tree.map(folder => folder.folderId)).toEqual(['fld_car_rental']);
        expect(tree[0].nodes.map(node => `${ node.kind }:${ node.path }`)).toEqual(['dir:decisions', 'dir:specs', 'file:README.md']);
        expect(tree[0].nodes[0].children?.map(node => node.path)).toEqual(['decisions/booking-flow.md', 'decisions/pricing.md']);
    });

    it('serves the documents of every folder, an empty one too', async () => {
        const { transport } = await connected();

        await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/car-rental-api' }, { path: '/Users/dev/notes' }] });

        const tree = await transport.getDocsTree(FIXTURE_PROJECT_ID);

        expect(tree.map(folder => folder.nodes.map(node => node.path))).toEqual([['decisions', 'specs', 'README.md'], ['decisions', 'endpoints.md'], []]);
    });

    it('keeps the folder a chat is made in, refuses one the project does not have, and hands the chats of a removed folder back to the main folder', async () => {
        const { transport, events } = await connected();

        await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }, { path: '/Users/dev/car-rental-api' }] });

        const [, api] = (await transport.getDocsTree(FIXTURE_PROJECT_ID)).map(folder => folder.folderId);
        const made = await transport.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, folderId: api });
        const chat = (made as { data: { chat: { id: string; folderId?: string } } }).data.chat;

        expect(chat.folderId).toBe(api);
        expect(await transport.command({ type: 'chat.create', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_nobody' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect((await transport.getProjectsInfo()).find(entry => entry.projectId === FIXTURE_PROJECT_ID)?.folders.map(folder => folder.chats)).toEqual([0, 1]);

        events.length = 0;
        await transport.command({ type: 'project.update', projectId: FIXTURE_PROJECT_ID, folders: [{ id: 'fld_car_rental' }] });
        await vi.advanceTimersByTimeAsync(0);

        const after = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(candidate => candidate.id === chat.id);

        expect(after).not.toHaveProperty('folderId');
        expect(events.map(event => event.data.type)).toEqual(['project.upserted', 'chat.upserted', 'skills.changed']);
    });

    it('lists the documents of a folder two projects have in both', async () => {
        const { transport } = await connected();
        const added = await transport.command({ type: 'project.add', folders: ['/Users/dev/web', '/Users/dev/car-rental'] });
        const other = (added as { data: { project: { id: string } } }).data.project;

        expect((await transport.getDocsTree(other.id))[1].nodes.map(node => node.path)).toEqual(['decisions', 'specs', 'README.md']);
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

    it('lists the permission presets of each agent, none chosen, with the default the provider has', async () => {
        const agents = await agentsOf(new FixtureTransport());

        expect(agents.claude?.permissions?.presets.map(preset => preset.id)).toEqual(['ask', 'accept-edits', 'auto', 'full']);
        expect(agents.codex?.permissions?.presets.map(preset => preset.name)).toEqual(['Ask for approval', 'Accept edits', 'Approve for me', 'Full access']);
        expect(agents.cursor?.permissions?.presets.map(preset => preset.id)).toEqual(['ask', 'full']);
        expect([agents.claude, agents.codex, agents.cursor].map(agent => agent?.permissions?.default)).toEqual(['auto', 'auto', 'full']);
        expect([agents.claude, agents.codex, agents.cursor].every(agent => agent?.permissions?.value === undefined)).toBe(true);
    });

    it('takes the permission preset an agent offers, takes it back with null, and refuses one it does not offer', async () => {
        const { transport, events } = await connected();

        expect((await transport.command({ type: 'agent.update', id: 'claude', permission: 'accept-edits' })).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(0);

        expect(events.some(event => event.data.type === 'agents.changed')).toBe(true);
        expect((await agentsOf(transport)).claude?.permissions).toMatchObject({ value: 'accept-edits', default: 'auto' });

        expect((await transport.command({ type: 'agent.update', id: 'claude', permission: null })).ok).toBe(true);
        expect((await agentsOf(transport)).claude?.permissions).not.toHaveProperty('value');

        // Cursor has the pair only; nothing else about the agent changes when a preset is refused.
        const refused = await transport.command({ type: 'agent.update', id: 'cursor', enabled: false, permission: 'auto' });

        expect(refused).toMatchObject({ ok: false, error: { code: 'invalid', message: 'Cursor has no preset called "auto"' } });
        expect(await agentsOf(transport)).toMatchObject({ cursor: { enabled: true } });
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

describe('FixtureTransport forks', () => {
    const snapshot = (transport: FixtureTransport) => transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
    const flags = (items: { seq: number; canFork?: boolean; canEdit?: boolean }[]) => items.flatMap(item => (item.canFork || item.canEdit ? [[item.seq, item.canEdit ? 'edit' : 'fork']] : []));

    it('seeds the items an agent can fork and edit: Edit on the message that starts a turn, Fork on the answer that ends it, and nowhere else', async () => {
        const transport = new FixtureTransport();

        expect(flags(await transport.getItems({ chatId: 'c-2' }))).toEqual([[1, 'edit'], [6, 'fork']]);
        expect(flags(await transport.getItems({ chatId: 'c-1' }))).toEqual([[1, 'edit']]);
        expect(flags(await transport.getItems({ chatId: 'c-3' }))).toEqual([]);
        // The seed has no fork: a chat more in the car project would move what other screens count.
        expect((await snapshot(transport)).chats.some(chat => chat.forkedFrom !== undefined)).toBe(false);
    });

    it('adds, on request, a chat that is a fork of First version: its history through the answer with the same words and times, then a turn of its own', async () => {
        const transport = new FixtureTransport({ data: withFixtureFork(createFixtureData()) });
        const { chats, runs } = await snapshot(transport);
        const fork = chats.find(chat => chat.id === FIXTURE_FORK_CHAT_ID);
        const copied = await transport.getItems({ chatId: FIXTURE_FORK_CHAT_ID });
        const original = await transport.getItems({ chatId: 'c-2' });

        expect(fork).toMatchObject({ title: '(1) First version', engine: 'claude', forkedFrom: { chatId: 'c-2', atSeq: 6 }, orchestratorRunId: 'r-orch-7' });
        expect(fork?.parentChatId).toBeUndefined();
        expect(runs.find(run => run.id === 'r-orch-7')).toMatchObject({ role: 'orchestrator', status: 'succeeded', chatId: FIXTURE_FORK_CHAT_ID });
        expect(copied.slice(0, 6).map(item => [item.seq, item.at, item.body])).toEqual(original.slice(0, 6).map(item => [item.seq, item.at, item.body]));
        expect(copied.map(item => item.body.kind)).toEqual([...original.slice(0, 6).map(item => item.body.kind), 'user', 'assistant']);
        expect(flags(copied)).toEqual([[1, 'edit'], [6, 'fork'], [7, 'edit'], [8, 'fork']]);
        // It forks like any chat of the daemon: the second answer of the fork is another fork's source.
        expect(await transport.command({ type: 'chat.fork', chatId: FIXTURE_FORK_CHAT_ID, itemId: copied[7].id })).toMatchObject({ ok: true, data: { chat: { title: '(2) First version', forkedFrom: { chatId: FIXTURE_FORK_CHAT_ID, atSeq: 8 } } } });
    });

    it('forks a chat at a final answer: a chat with the history through it, the source untouched, and the new chat and its run announced', async () => {
        const { transport, events } = await connected();
        const before = await transport.getItems({ chatId: 'c-2' });
        const answer = before[5];
        const result = await transport.command({ type: 'chat.fork', chatId: 'c-2', itemId: answer.id });

        await vi.advanceTimersByTimeAsync(0);

        expect(result).toMatchObject({ ok: true, data: { chat: { title: '(1) First version', mode: 'autopilot', engine: 'claude', forkedFrom: { chatId: 'c-2', atSeq: 6 } } } });

        const made = (result as { ok: true; data: { chat: { id: string; orchestratorRunId: string; parentChatId?: string; queue?: unknown } } }).data.chat;

        expect(made.parentChatId).toBeUndefined();
        expect(made.queue).toBeUndefined();

        const items = await transport.getItems({ chatId: made.id });

        expect(items.map(item => [item.seq, item.body.kind])).toEqual(before.slice(0, 6).map(item => [item.seq, item.body.kind]));
        expect(items.every(item => item.runId === made.orchestratorRunId && !before.some(other => other.id === item.id))).toBe(true);
        expect(flags(items)).toEqual([[1, 'edit'], [6, 'fork']]);
        expect(await transport.getItems({ chatId: 'c-2' })).toEqual(before);
        expect((await snapshot(transport)).runs.find(run => run.id === made.orchestratorRunId)).toMatchObject({ status: 'succeeded', chatId: made.id, engine: 'claude' });
        expect(events.map(event => event.data.type)).toEqual(['run.upserted', 'chat.upserted']);
    });

    it('numbers the title of a fork of a fork, and every fork of one chat starts from that chat\'s own title', async () => {
        const { transport } = await connected();
        const forkedAt = async (chatId: string, seq: number) => {
            const item = (await transport.getItems({ chatId })).find(candidate => candidate.seq === seq);
            const result = await transport.command({ type: 'chat.fork', chatId, itemId: item?.id ?? '' });

            return (result as { ok: true; data: { chat: { id: string; title: string } } }).data.chat;
        };
        const one = await forkedAt('c-2', 6);

        expect(one.title).toBe('(1) First version');
        expect((await forkedAt(one.id, 6)).title).toBe('(2) First version');
        expect((await forkedAt('c-2', 6)).title).toBe('(1) First version');
    });

    it('ends the history a fork inherited where an edit into it cuts, and leaves it when the edit is after it', async () => {
        const { transport, events } = await connected({ data: withFixtureFork(createFixtureData()) });
        const atSeq = async () => (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).chats.find(chat => chat.id === FIXTURE_FORK_CHAT_ID)?.forkedFrom?.atSeq;
        const items = await transport.getItems({ chatId: FIXTURE_FORK_CHAT_ID });

        expect(await atSeq()).toBe(6);

        // The fork's own message, after the divider: the inherited history is as long as it was.
        expect(await transport.command({ type: 'chat.edit', chatId: FIXTURE_FORK_CHAT_ID, itemId: items.find(item => item.seq === 7)?.id ?? '', text: 'Another second question' })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(3000);
        expect(await atSeq()).toBe(6);

        // The first message of the fork: nothing of the history it inherited is left.
        events.length = 0;
        expect(await transport.command({ type: 'chat.edit', chatId: FIXTURE_FORK_CHAT_ID, itemId: items[0].id, text: 'Another first question' })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(await atSeq()).toBe(0);
        expect(events.flatMap(event => (event.data.type === 'chat.upserted' && event.data.chat.id === FIXTURE_FORK_CHAT_ID ? [event.data.chat.forkedFrom?.atSeq] : []))).toEqual([0]);
    });

    it('refuses what the daemon refuses: no chat, no conversation, no such item, an item that cannot be forked', async () => {
        const { transport } = await connected();
        const code = async (chatId: string, itemId: string) => (await transport.command({ type: 'chat.fork', chatId, itemId }) as { ok: false; error: { code: string } }).error.code;
        const items = await transport.getItems({ chatId: 'c-2' });

        expect(await code('c-nope', 'x')).toBe('not_found');
        expect(await code('c-4', 'x')).toBe('invalid');
        expect(await code('c-2', 'r-orch-2-99')).toBe('not_found');
        // The person's own message, an answer in the middle of a turn, a tool call.
        expect([await code('c-2', items[0].id), await code('c-2', items[1].id), await code('c-2', items[2].id)]).toEqual(['invalid', 'invalid', 'invalid']);
        expect((await snapshot(transport)).chats.filter(chat => chat.forkedFrom !== undefined)).toHaveLength(0);
    });

    it('gives a fork a file of its own for each file a copied message carries, and shows a call that still ran in the source as stopped', async () => {
        // Simplify booking works, which does not stop it being forked at an answer it gave: its first message carries files, and a call is still running at that answer.
        const data = createFixtureData();

        data.items['r-orch-1'][11].canFork = true;

        const transport = new FixtureTransport({ data });
        const source = await transport.getItems({ chatId: 'c-1' });
        const result = await transport.command({ type: 'chat.fork', chatId: 'c-1', itemId: source[11].id });
        const { chat } = (result as { ok: true; data: { chat: { id: string } } }).data;
        const copied = await transport.getItems({ chatId: chat.id });
        const [original, own] = [source[0].body, copied[0].body].map(body => (body.kind === 'user' ? body.attachments ?? [] : []));

        expect(copied).toHaveLength(12);
        expect(own).toHaveLength(original.length);
        expect(own.map(file => file.id).some(id => original.some(file => file.id === id))).toBe(false);
        expect(own.map(({ name, size, mediaType }) => [name, size, mediaType])).toEqual(original.map(({ name, size, mediaType }) => [name, size, mediaType]));
        expect(await (await transport.getAttachment(FIXTURE_PROJECT_ID, own[0].id)).text()).toBe(await (await transport.getAttachment(FIXTURE_PROJECT_ID, original[0].id)).text());
        // The call that ran at the answer has no process in the fork; the source's own is still running.
        expect(copied[10].body).toMatchObject({ kind: 'tool', state: 'error', error: 'Stopped before it finished' });
        expect(source[10].body).toMatchObject({ kind: 'tool', state: 'running' });
    });
});

describe('FixtureTransport edits', () => {
    const kinds = (items: { body: { kind: string; text?: string } }[]) => items.map(item => (item.body.kind === 'user' ? item.body.text : item.body.kind));
    const code = async (transport: FixtureTransport, fields: { chatId: string; itemId: string; text: string; attachmentIds?: string[] }) =>
        (await transport.command({ type: 'chat.edit', ...fields }) as { ok: false; error: { code: string } }).error.code;

    it('rewrites a chat from its first message: the stream is cut, the sub-agent runs of the cut part go, and the new message is answered on a stream that starts again', async () => {
        const { transport, events } = await connected();
        const before = await transport.getItems({ chatId: 'c-2' });
        const result = await transport.command({ type: 'chat.edit', chatId: 'c-2', itemId: before[0].id, text: '  Start again  ' });

        await vi.advanceTimersByTimeAsync(0);

        expect(result).toMatchObject({ ok: true, data: { chatId: 'c-2', runId: 'r-orch-2' } });
        expect(events[0].data).toEqual({ type: 'stream.truncated', runId: 'r-orch-2', fromSeq: 1, removedRunIds: ['r-na-06'] });
        // The cut comes first: the new message and the turn that answers it follow.
        expect(events.map(event => event.data.type)).toContain('stream.item');

        const snapshot = await transport.getProjectSnapshot(FIXTURE_PROJECT_ID);

        expect(snapshot.runs.some(run => run.id === 'r-na-06')).toBe(false);
        expect(snapshot.runs.find(run => run.id === 'r-orch-2')).toMatchObject({ status: 'running', chatId: 'c-2' });

        const cut = await transport.getItems({ chatId: 'c-2' });

        // The new message takes the freed number under a new id, and offers Edit again.
        expect(cut.map(item => [item.seq, item.canEdit === true])).toEqual([[1, true]]);
        expect(cut[0]).toMatchObject({ body: { kind: 'user', text: 'Start again' } });
        expect(cut[0].id).not.toBe(before[0].id);

        // Its turn ends with an answer that offers Fork, and the next message offers Edit, as the daemon's flags go.
        await vi.advanceTimersByTimeAsync(3000);
        await transport.command({ type: 'chat.send', chatId: 'c-2', text: 'And then?' });
        await vi.advanceTimersByTimeAsync(3000);

        const grown = await transport.getItems({ chatId: 'c-2' });

        expect(grown.map(item => [item.seq, item.body.kind, item.canEdit === true, item.canFork === true])).toEqual([
            [1, 'user', true, false], [2, 'assistant', false, true], [3, 'user', true, false], [4, 'assistant', false, true],
        ]);
    });

    it('rewrites from a message in the middle: what goes before it stays, the run gets a session of its own and forgets its context reading', async () => {
        const { transport } = await connected();
        const forkAnswer = (await transport.getItems({ chatId: 'c-2' }))[5];
        const { data } = await transport.command({ type: 'chat.fork', chatId: 'c-2', itemId: forkAnswer.id }) as { ok: true; data: { chat: { id: string; orchestratorRunId: string } } };
        const { id, orchestratorRunId } = data.chat;

        await transport.command({ type: 'chat.send', chatId: id, text: 'Second question' });
        await vi.advanceTimersByTimeAsync(3000);

        const grown = await transport.getItems({ chatId: id });
        const session = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(run => run.id === orchestratorRunId)?.sessionId;

        expect(kinds(grown).slice(-2)).toEqual(['Second question', 'assistant']);
        expect(session).toBeDefined();

        const second = grown.find(item => item.seq === 7);

        expect(second?.canEdit).toBe(true);
        expect(await transport.command({ type: 'chat.edit', chatId: id, itemId: second?.id ?? '', text: 'Another question' })).toMatchObject({ ok: true });
        await vi.advanceTimersByTimeAsync(3000);

        const after = await transport.getItems({ chatId: id });
        const run = (await transport.getProjectSnapshot(FIXTURE_PROJECT_ID)).runs.find(candidate => candidate.id === orchestratorRunId);

        // The copied history is as it was, and the second turn is the new one.
        expect(after.map(item => item.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(kinds(after).slice(0, 6)).toEqual(grown.slice(0, 6).map(item => (item.body.kind === 'user' ? item.body.text : item.body.kind)));
        expect(kinds(after).slice(6)).toEqual(['Another question', 'assistant']);
        expect(run?.sessionId).toBeDefined();
        expect(run?.sessionId).not.toBe(session);
        expect(run?.status).toBe('succeeded');
    });

    it('refuses what the daemon refuses: no chat, no conversation, no such item, an item that cannot be edited, a chat that works, an empty message', async () => {
        const { transport } = await connected();
        const items = await transport.getItems({ chatId: 'c-2' });
        const running = await transport.getItems({ chatId: 'c-1' });

        expect(await code(transport, { chatId: 'c-nope', itemId: 'x', text: 'again' })).toBe('not_found');
        expect(await code(transport, { chatId: 'c-4', itemId: 'x', text: 'again' })).toBe('invalid');
        expect(await code(transport, { chatId: 'c-2', itemId: 'r-orch-2-99', text: 'again' })).toBe('not_found');
        // An answer, a call, and a message after the agent's compact turn.
        expect([await code(transport, { chatId: 'c-2', itemId: items[1].id, text: 'again' }), await code(transport, { chatId: 'c-2', itemId: items[2].id, text: 'again' })]).toEqual(['invalid', 'invalid']);
        expect(running[0].canEdit).toBe(true);
        expect(await code(transport, { chatId: 'c-1', itemId: running[0].id, text: 'again' })).toBe('conflict');
        expect(await code(transport, { chatId: 'c-2', itemId: items[0].id, text: '   ' })).toBe('invalid');
        expect(await code(transport, { chatId: 'c-2', itemId: items[0].id, text: 'again', attachmentIds: ['a-nope'] })).toBe('not_found');
        expect(await transport.getItems({ chatId: 'c-2' })).toEqual(items);
    });

    it('drops the files of the cut messages except those the new message carries on, and sends the files it names', async () => {
        const { transport } = await connected();
        const upload = (name: string) => transport.uploadAttachment(FIXTURE_PROJECT_ID, new File([name], name, { type: 'text/plain' }));
        const served = async (id: string) => (await transport.getAttachment(FIXTURE_PROJECT_ID, id).then(blob => blob.text(), () => undefined));
        const [a, b, c, d] = await Promise.all(['a.txt', 'b.txt', 'c.txt', 'd.txt'].map(upload));
        const first = (await transport.getItems({ chatId: 'c-2' }))[0];

        // Two turns: the first message carries `a`, the second `b` and `c`.
        await transport.command({ type: 'chat.edit', chatId: 'c-2', itemId: first.id, text: 'One', attachmentIds: [a.id] });
        await vi.advanceTimersByTimeAsync(3000);
        await transport.command({ type: 'chat.send', chatId: 'c-2', text: 'Two', attachmentIds: [b.id, c.id] });
        await vi.advanceTimersByTimeAsync(3000);

        const second = (await transport.getItems({ chatId: 'c-2' })).find(item => item.seq === 3);

        expect(second?.canEdit).toBe(true);
        // A file of an earlier message cannot go with a later one.
        expect(await code(transport, { chatId: 'c-2', itemId: second?.id ?? '', text: 'Two again', attachmentIds: [a.id] })).toBe('conflict');
        expect(await served(b.id)).toBe('b.txt');

        expect(await transport.command({ type: 'chat.edit', chatId: 'c-2', itemId: second?.id ?? '', text: 'Two again', attachmentIds: [c.id, d.id] })).toMatchObject({ ok: true });

        const rewritten = (await transport.getItems({ chatId: 'c-2' })).find(item => item.seq === 3);

        expect(rewritten?.body).toMatchObject({ kind: 'user', text: 'Two again', attachments: [{ id: c.id }, { id: d.id }] });
        expect([await served(a.id), await served(b.id), await served(c.id), await served(d.id)]).toEqual(['a.txt', undefined, 'c.txt', 'd.txt']);
    });
});
