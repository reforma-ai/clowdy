import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { getChat } from '../src/db/chats';
import { cleanTempDirs, ScriptEngine, scriptEngines, startHarness, tempDir, waitFor } from './helpers';

import type { Chat, Project, ProjectInfo } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${ number }` };
    yield { type: 'text', delta: 'Done', done: true };
    yield { type: 'done', result: 'Done' };
};

/** A daemon with a project of three folders (`web` is the main one) and an engine whose turns end at once, so a test can read where each one started. */
async function setup() {
    const engine = new ScriptEngine(finishing);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const parent = tempDir();

    for (const name of ['web', 'api', 'notes']) {
        mkdirSync(join(parent, name));
    }

    const { project } = h.ok('project.add', { name: 'Shop', folders: ['web', 'api', 'notes'].map(name => join(parent, name)) }) as { project: Project };
    const [web, api, notes] = project.folders;
    const chatOf = (chatId: string) => getChat(h.store.db, chatId) as Chat;
    const info = async () => (await (await h.fetch('/v1/projects/info')).json() as ProjectInfo[]).find(entry => entry.projectId === project.id) as ProjectInfo;
    const make = (folderId?: string) => (h.ok('chat.create', { projectId: project.id, ...(folderId && { folderId }) }) as { chat: Chat }).chat;
    /** Sends a message and waits until its turn has started and ended; resolves to the options the engine started it with. */
    const say = async (chat: Chat, text: string) => {
        const turns = engine.turns.length;

        h.ok('chat.send', { chatId: chat.id, text });
        await waitFor(() => engine.turns.length === turns + 1, `the turn on "${ text }" to start`);
        await waitFor(() => h.run(chatOf(chat.id).orchestratorRunId as string).status === 'succeeded', `the turn on "${ text }" to end`);

        return engine.turns[turns];
    };
    const folders = (...ids: string[]) => ids.map(id => ({ id }));

    return { h, engine, project, web, api, notes, chatOf, info, make, say, folders };
}

describe('a chat and its folder', () => {
    test('chat.create keeps a folder of the project, and refuses one it does not have', async () => {
        const { h, project, api, chatOf, make } = await setup();
        const other = h.openRepo('elsewhere');
        const otherFolder = (h.ok('project.add', { folders: [other.path] }).project as Project).folders[0];
        const chat = make(api.id);

        expect(chat.folderId).toBe(api.id);
        expect(chatOf(chat.id).folderId).toBe(api.id);
        expect(make()).not.toHaveProperty('folderId');
        expect(h.send('chat.create', { projectId: project.id, folderId: otherFolder.id })).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(h.send('chat.create', { projectId: project.id, folderId: 'fld_nobody' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
    });

    test('a turn works in its chat\'s folder and gets the others, and a chat without one works in the main folder', async () => {
        const { make, say, web, api, notes } = await setup();
        const inApi = await say(make(api.id), 'Fix the endpoint');
        const inMain = await say(make(), 'Fix the page');

        expect(inApi).toMatchObject({ cwd: api.path, additionalDirectories: [web.path, notes.path] });
        expect(inApi.systemPrompt).toContain(`- ${ web.path } (main)\n- ${ api.path } (you work here)\n- ${ notes.path }\n`);
        expect(inMain).toMatchObject({ cwd: web.path, additionalDirectories: [api.path, notes.path] });
    });

    test('a chat stays in the folder it was made in when the main folder changes, and one without a folder follows the main folder', async () => {
        const { h, project, make, say, web, api, notes, folders } = await setup();
        const inNotes = make(notes.id);
        const inMain = make();

        await say(inNotes, 'Tidy the notes');
        await say(inMain, 'Fix the page');
        h.ok('project.update', { projectId: project.id, folders: folders(api.id, web.id, notes.id) });

        expect(await say(inNotes, 'More notes')).toMatchObject({ cwd: notes.path, additionalDirectories: [api.path, web.path] });
        expect(await say(inMain, 'More pages')).toMatchObject({ cwd: api.path, additionalDirectories: [web.path, notes.path] });
    });

    test('a folder that leaves the project hands its chats back to the main folder, announcing each, and the next turn works there', async () => {
        const { h, project, chatOf, make, say, web, api, notes, folders } = await setup();
        const inApi = make(api.id);
        const inNotes = make(notes.id);

        await say(inApi, 'Fix the endpoint');
        expect((await say(inNotes, 'Tidy the notes')).cwd).toBe(notes.path);

        const cursor = h.store.headCursor();

        h.ok('project.update', { projectId: project.id, folders: folders(web.id, notes.id) });

        expect(chatOf(inApi.id)).not.toHaveProperty('folderId');
        expect(chatOf(inNotes.id).folderId).toBe(notes.id);

        const upserted = h.events(cursor).flatMap(event => (event.data.type === 'chat.upserted' ? [event.data.chat] : []));

        expect(upserted.map(chat => chat.id)).toEqual([inApi.id]);
        expect(upserted[0]).not.toHaveProperty('folderId');
        expect(await say(inApi, 'And again')).toMatchObject({ cwd: web.path, additionalDirectories: [notes.path] });
    });

    test('a chat whose folder is gone from disk fails its turn saying so, and the other chats still work', async () => {
        const { h, engine, chatOf, make, say, web, api } = await setup();
        const inApi = make(api.id);

        rmSync(api.path, { recursive: true });
        h.ok('chat.send', { chatId: inApi.id, text: 'Fix the endpoint' });
        await waitFor(() => h.run(chatOf(inApi.id).orchestratorRunId as string).status === 'failed', 'the turn to fail');

        expect(h.run(chatOf(inApi.id).orchestratorRunId as string).error).toBe(`The folder ${ api.path } no longer exists`);
        expect(engine.turns).toHaveLength(0);
        expect((await say(make(), 'Fix the page')).cwd).toBe(web.path);
    });

    test('a folder that moved keeps its id when it is told its new place, and its chats stay with it and work there', async () => {
        const { h, project, chatOf, info, make, say, web, api, notes } = await setup();
        const inApi = make(api.id);
        const moved = join(tempDir(), 'api-moved');
        const place = () => (project.folders.map(folder => folder.id) as string[]).map(id => ({ id }));

        mkdirSync(moved);
        rmSync(api.path, { recursive: true });
        expect((await info()).folders.find(folder => folder.folderId === api.id)).toMatchObject({ exists: false, chats: 1 });

        const cursor = h.store.headCursor();
        const entries = place().map(entry => (entry.id === api.id ? { id: api.id, path: moved } : entry));
        const { project: updated } = h.ok('project.update', { projectId: project.id, folders: entries }) as { project: Project };
        const there = realpathSync.native(moved);

        expect(updated.folders).toEqual([web, { id: api.id, path: there }, notes]);
        expect((await info()).folders.find(folder => folder.folderId === api.id)).toMatchObject({ exists: true, chats: 1 });
        // The chat is not touched: it is still the folder's, and no event says otherwise.
        expect(chatOf(inApi.id).folderId).toBe(api.id);
        expect(h.events(cursor).some(event => event.data.type === 'chat.upserted')).toBe(false);
        expect(await say(inApi, 'Fix the endpoint')).toMatchObject({ cwd: there, additionalDirectories: [web.path, notes.path] });
    });

    test('the project info counts the chats of each folder', async () => {
        const { make, info, web, api, notes } = await setup();

        make(api.id);
        make(api.id);
        make(notes.id);
        make();

        expect((await info()).folders.map(({ folderId, chats }) => ({ folderId, chats }))).toEqual([
            { folderId: web.id, chats: 0 },
            { folderId: api.id, chats: 2 },
            { folderId: notes.id, chats: 1 },
        ]);
    });
});
