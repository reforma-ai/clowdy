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
