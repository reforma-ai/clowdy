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

const chatOf = (h: Harness, projectId: string, chatId: string) => projectSnapshot(h.store, projectId).chats.find(chat => chat.id === chatId);

describe('chat.setArchived', () => {
    test('archives a chat and brings it back, announcing each change, and changes nothing else', async () => {
        const { h, project, chat } = await setup();
        const cursor = h.store.headCursor();

        const archived = h.ok('chat.setArchived', { chatId: chat.id, archived: true }).chat as { archivedAt?: number; updatedAt: number; title: string };

        expect(archived.archivedAt).toBeGreaterThan(0);
        expect(archived).toMatchObject({ updatedAt: chat.updatedAt, title: chat.title });
        expect(chatOf(h, project.id, chat.id)?.archivedAt).toBe(archived.archivedAt);

        const restored = h.ok('chat.setArchived', { chatId: chat.id, archived: false }).chat as { archivedAt?: number };

        expect(restored.archivedAt).toBeUndefined();
        expect(chatOf(h, project.id, chat.id)).not.toHaveProperty('archivedAt');
        expect(h.events(cursor).map(event => (event.data as { type: string }).type)).toEqual(['chat.upserted', 'chat.upserted']);
    });

    test('says nothing for what is set already', async () => {
        const { h, chat } = await setup();
        const cursor = h.store.headCursor();

        h.ok('chat.setArchived', { chatId: chat.id, archived: false });
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });
        h.ok('chat.setArchived', { chatId: chat.id, archived: false });
        h.ok('chat.setArchived', { chatId: chat.id, archived: false });

        // Only the two real changes were announced.
        expect(h.events(cursor)).toHaveLength(2);
    });

    test('refuses an unknown chat', async () => {
        const { h } = await setup();

        expect(h.send('chat.setArchived', { chatId: 'cht_nope', archived: true })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    });

    test('keeps the runs, the tasks and the stream of a finished chat', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Simplify the booking flow so users book in two steps' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);

        const before = projectSnapshot(h.store, project.id);

        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        const after = projectSnapshot(h.store, project.id);

        expect(after.runs.map(run => run.id)).toEqual(before.runs.map(run => run.id));
        expect(after.tasks.map(task => task.id)).toEqual(before.tasks.map(task => task.id));
        expect(after.chatTaskLinks).toEqual(before.chatTaskLinks);
    });

    test('is refused while an agent of the chat works, as delete is', async () => {
        const { h, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        expect(h.send('chat.setArchived', { chatId: chat.id, archived: true })).toMatchObject({ ok: false, error: { code: 'conflict' } });

        h.ok('run.cancel', { runId });
    });

    test('is undone by a message to the chat', async () => {
        const { h, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the orchestrator to succeed', 8000);
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        expect(chatOf(h, project.id, chat.id)?.archivedAt).toBeGreaterThan(0);

        h.ok('chat.send', { chatId: chat.id, text: 'And what about contrast?' });

        expect(chatOf(h, project.id, chat.id)).not.toHaveProperty('archivedAt');
    });

    test('is stored with the chat', async () => {
        const { h, project, chat } = await setup();

        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        const row = h.store.db.query('SELECT archived_at FROM chats WHERE id = ?').get(chat.id) as { archived_at: number | null };

        expect(row.archived_at).toBeGreaterThan(0);
        expect(chatOf(h, project.id, chat.id)?.archivedAt).toBe(row.archived_at ?? undefined);
    });
});
