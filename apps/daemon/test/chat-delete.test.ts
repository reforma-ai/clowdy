import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { projectSnapshot } from '../src/domain/snapshots';
import { cleanTempDirs, startHarness, waitFor, type Harness } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

async function setup() {
    const h = await startHarness();

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });

    return { h, project, chat };
}

const count = (h: Harness, sql: string, ...params: string[]) => (h.store.db.query(sql).get(...params) as { n: number }).n;

describe('chat.delete', () => {
    test('removes an empty chat and announces it', async () => {
        const { h, project, chat } = await setup();
        const cursor = h.store.headCursor();

        h.ok('chat.delete', { chatId: chat.id });

        expect(projectSnapshot(h.store, project.id).chats).toEqual([]);
        expect(h.events(cursor).map(event => event.data)).toEqual([{ type: 'chat.deleted', chatId: chat.id, runIds: [] }]);
    });

    test('removes a finished chat with its runs, streams and links, and keeps the tasks', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Simplify the booking flow so users book in two steps' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const before = projectSnapshot(h.store, project.id);
        const runIds = before.runs.map(run => run.id);
        const cursor = h.store.headCursor();

        expect(runIds.length).toBeGreaterThan(1);
        expect(before.tasks.length).toBeGreaterThan(0);

        h.ok('chat.delete', { chatId: chat.id });

        const after = projectSnapshot(h.store, project.id);

        expect(after.chats).toEqual([]);
        expect(after.runs).toEqual([]);
        expect(after.runTaskLinks).toEqual([]);
        expect(after.chatTaskLinks).toEqual([]);
        expect(after.tasks.map(task => task.id)).toEqual(before.tasks.map(task => task.id));
        expect(count(h, 'SELECT COUNT(*) AS n FROM stream_items')).toBe(0);
        expect(count(h, 'SELECT COUNT(*) AS n FROM run_mailbox')).toBe(0);

        const [deleted] = h.events(cursor).map(event => event.data);

        expect(deleted).toMatchObject({ type: 'chat.deleted', chatId: chat.id });
        expect([...(deleted as { runIds: string[] }).runIds].sort()).toEqual([...runIds].sort());
    });

    test('keeps the other chats of the project', async () => {
        const { h, project, chat } = await setup();
        const { chat: other } = h.ok('chat.create', { projectId: project.id, title: 'Other' });

        h.ok('chat.delete', { chatId: chat.id });

        expect(projectSnapshot(h.store, project.id).chats.map(candidate => candidate.id)).toEqual([other.id]);
    });

    test('is refused while the chat\'s agents are working', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Simplify the booking flow so users book in two steps' });
        const result = h.send('chat.delete', { chatId: chat.id });

        expect(result.ok).toBe(false);
        expect(result.ok ? '' : result.error.code).toBe('conflict');
        expect(projectSnapshot(h.store, project.id).chats.map(candidate => candidate.id)).toEqual([chat.id]);

        // Once the work is over the same command goes through.
        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);
        h.ok('chat.delete', { chatId: chat.id });
        expect(projectSnapshot(h.store, project.id).chats).toEqual([]);
    });

    test('says so for a chat that does not exist', async () => {
        const { h } = await setup();
        const result = h.send('chat.delete', { chatId: 'cht_missing' });

        expect(result.ok ? '' : result.error.code).toBe('not_found');
    });
});
