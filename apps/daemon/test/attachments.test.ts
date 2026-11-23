import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, MAX_ATTACHMENTS_PER_MESSAGE } from '@clowdy/protocol';

import { formatSize, messageWithFiles } from '../src/attachments/message';
import { contentDisposition, mediaTypeOf, safeFileName, servedMediaType } from '../src/attachments/names';
import { STALE_AFTER_MS } from '../src/attachments/service';
import { projectSnapshot } from '../src/domain/snapshots';
import {
    cleanTempDirs,
    command,
    latch,
    restartHarness,
    ScriptEngine,
    scriptEngines,
    startHarness,
    untilAborted,
    waitFor,
} from './helpers';

import type { Attachment, ChatMode } from '@clowdy/protocol';
import type { Harness, Script } from './helpers';

afterAll(cleanTempDirs);

const harnesses: Harness[] = [];

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(h => h.stop().catch(() => undefined)));
});

const finishing: Script = async function* ({ number }) {
    yield { type: 'session', sessionId: `s${number}` };
    yield { type: 'done', result: `turn ${number}` };
};

const holding: Script = async function* ({ number, signal }) {
    yield { type: 'session', sessionId: `s${number}` };
    await untilAborted(signal);
};

async function setup(script: Script = finishing) {
    const engine = new ScriptEngine(script);
    const h = await startHarness({}, { engines: scriptEngines(engine) });

    harnesses.push(h);

    const project = h.openRepo();
    const { chat } = h.ok('chat.create', { projectId: project.id });

    return { h, engine, project, chat: chat as { id: string } };
}

type Body = NonNullable<RequestInit['body']>;

const bytes = (length: number, fill = 7) => new Uint8Array(length).fill(fill);

function upload(h: Harness, projectId: string, name: string, body: Body | null = bytes(10), contentType?: string) {
    return h.fetch(`/v1/projects/${projectId}/attachments?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body,
        headers: contentType ? { 'content-type': contentType } : {},
    });
}

async function attach(
    h: Harness,
    projectId: string,
    name: string,
    body: Body = bytes(10),
    contentType?: string
): Promise<Attachment> {
    const response = await upload(h, projectId, name, body, contentType);

    expect(response.status).toBe(200);

    return response.json() as Promise<Attachment>;
}

const folderOf = (h: Harness, id: string) => join(h.config.dataDir, 'attachments', id);
const pathOf = (h: Harness, file: Attachment) => join(folderOf(h, file.id), file.name);
const rows = (h: Harness) => (h.store.db.query('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n;
const rowOf = (h: Harness, id: string) =>
    h.store.db.query('SELECT * FROM attachments WHERE id = ?').get(id) as {
        chat_id: string | null;
        run_id: string | null;
        created_at: number;
        project_id: string;
    } | null;
const userItems = (h: Harness, runId: string) =>
    (
        h.store.db.query('SELECT body FROM stream_items WHERE run_id = ? ORDER BY seq').all(runId) as { body: string }[]
    ).map(row => JSON.parse(row.body));
const age = (h: Harness, id: string, ms: number) =>
    h.store.db.query('UPDATE attachments SET created_at = ? WHERE id = ?').run(Date.now() - ms, id);

describe('upload and read back', () => {
    test("stores the body under the person's name in a folder of its own, and serves it with hardening headers", async () => {
        const { h, project } = await setup();
        const content = Uint8Array.from({ length: 300 }, (_, index) => index % 251);
        const response = await upload(h, project.id, 'shot.png', content, 'image/png');
        const file = (await response.json()) as Attachment;

        expect(response.status).toBe(200);
        expect(file).toEqual({
            id: expect.stringMatching(/^att_[0-9A-Z]{26}$/),
            name: 'shot.png',
            mediaType: 'image/png',
            size: 300,
        });
        expect(new Uint8Array(readFileSync(pathOf(h, file)))).toEqual(content);
        expect(readdirSync(folderOf(h, file.id))).toEqual(['shot.png']);
        expect(rowOf(h, file.id)).toMatchObject({ project_id: project.id, chat_id: null, run_id: null });

        if (process.platform !== 'win32') {
            expect(statSync(pathOf(h, file)).mode & 0o777).toBe(0o600);
            expect(statSync(folderOf(h, file.id)).mode & 0o777).toBe(0o700);
        }

        const served = await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`);

        expect(served.status).toBe(200);
        expect(served.headers.get('content-type')).toBe('image/png');
        expect(served.headers.get('x-content-type-options')).toBe('nosniff');
        expect(served.headers.get('content-security-policy')).toBe('sandbox');
        expect(served.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''shot.png");
        expect(new Uint8Array(await served.arrayBuffer())).toEqual(content);
    });

    test('announces nothing: only the message that sends a file is an event', async () => {
        const { h, project } = await setup();
        const cursor = h.store.headCursor();

        await attach(h, project.id, 'a.txt');

        expect(h.events(cursor)).toEqual([]);
    });

    test('a page, an SVG or any XML is served as opaque bytes, though its type is kept', async () => {
        const { h, project } = await setup();

        for (const [name, type] of [
            ['page.html', 'text/html'],
            ['logo.svg', 'image/svg+xml'],
            ['feed.xml', 'application/xml'],
            ['doc.xhtml', 'application/xhtml+xml'],
            ['map.rdf', 'application/rdf+xml'],
        ]) {
            const file = await attach(h, project.id, name, new TextEncoder().encode('<script>alert(1)</script>'), type);
            const served = await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`);

            expect(file.mediaType).toBe(type);
            expect(served.headers.get('content-type')).toBe('application/octet-stream');
            expect(served.headers.get('x-content-type-options')).toBe('nosniff');
            expect(served.headers.get('content-security-policy')).toBe('sandbox');
        }
    });

    test('keeps the declared media type when it is plausible, else goes by the extension, else octet-stream', async () => {
        const { h, project } = await setup();
        const typeOf = async (name: string, contentType?: string) =>
            (await attach(h, project.id, name, bytes(4), contentType)).mediaType;

        expect(await typeOf('a.bin', 'image/webp')).toBe('image/webp');
        expect(await typeOf('a.bin', 'Text/Plain; charset=utf-8')).toBe('text/plain');
        expect(await typeOf('notes.md')).toBe('text/markdown');
        expect(await typeOf('notes.md', 'application/octet-stream')).toBe('text/markdown');
        expect(await typeOf('shot.PNG', 'nonsense')).toBe('image/png');
        expect(await typeOf('server.log', 'multipart/form-data; boundary=x')).toBe('text/plain');
        expect(await typeOf('archive.weird')).toBe('application/octet-stream');
        expect(await typeOf('Makefile')).toBe('application/octet-stream');
    });

    test('cleans the name it was given: no path, no hidden file, no control characters', async () => {
        const { h, project } = await setup();
        const hostile = await attach(h, project.id, '../../etc/passwd');
        const windows = await attach(h, project.id, 'C:\\Users\\me\\.secret\\notes?.txt');

        expect(hostile.name).toBe('passwd');
        expect(windows.name).toBe('notes_.txt');
        expect(pathOf(h, hostile).startsWith(join(h.config.dataDir, 'attachments'))).toBe(true);
        expect(existsSync(join(h.config.dataDir, 'etc'))).toBe(false);
        expect((await attach(h, project.id, '..')).name).toBe('file');

        // An encoded slash is decoded once, then taken for the separator it is.
        const encoded = (await (
            await h.fetch(`/v1/projects/${project.id}/attachments?name=a%2F..%2Fb.txt`, {
                method: 'POST',
                body: bytes(3),
            })
        ).json()) as Attachment;

        expect(encoded.name).toBe('b.txt');
    });

    test('refuses a missing or blank name, an empty body, an unknown project and a request without the token', async () => {
        const { h, project } = await setup();
        const bare = `/v1/projects/${project.id}/attachments`;

        for (const response of [
            await h.fetch(bare, { method: 'POST', body: bytes(3) }),
            await h.fetch(`${bare}?name=`, { method: 'POST', body: bytes(3) }),
            await upload(h, project.id, '   ', bytes(3)),
            await upload(h, project.id, 'empty.txt', new Uint8Array(0)),
            await upload(h, project.id, 'empty.txt', null),
        ]) {
            expect(response.status).toBe(400);
            expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
        }

        expect((await upload(h, 'prj_nope', 'a.txt')).status).toBe(404);
        expect((await fetch(`${h.url}${bare}?name=a.txt`, { method: 'POST', body: bytes(3) })).status).toBe(401);
        expect(rows(h)).toBe(0);
        expect(
            existsSync(join(h.config.dataDir, 'attachments')) ? readdirSync(join(h.config.dataDir, 'attachments')) : []
        ).toEqual([]);
    });

    test('takes a file of exactly the limit and refuses one byte more with a JSON 413, leaving nothing behind', async () => {
        const { h, project } = await setup();
        const exact = await attach(h, project.id, 'exact.bin', bytes(MAX_ATTACHMENT_BYTES));

        expect(exact.size).toBe(MAX_ATTACHMENT_BYTES);

        const over = await upload(h, project.id, 'over.bin', bytes(MAX_ATTACHMENT_BYTES + 1));

        expect(over.status).toBe(413);
        expect(await over.json()).toMatchObject({
            ok: false,
            error: {
                code: 'invalid',
                message: expect.stringContaining('25 MB'),
                details: { maxBytes: MAX_ATTACHMENT_BYTES },
            },
        });

        // Without a declared length the daemon has to count, and does.
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (let sent = 0; sent <= MAX_ATTACHMENT_BYTES; sent += 1024 * 1024) {
                    controller.enqueue(bytes(1024 * 1024));
                }

                controller.close();
            },
        });
        const chunked = await upload(h, project.id, 'chunked.bin', stream as unknown as Body);

        expect(chunked.status).toBe(413);
        expect(await chunked.json()).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(rows(h)).toBe(1);
        expect(readdirSync(join(h.config.dataDir, 'attachments'))).toEqual([exact.id]);
    });

    test('a body past what Bun lets in is refused before the route runs', async () => {
        const { h, project } = await setup();
        const response = await upload(h, project.id, 'huge.bin', bytes(MAX_ATTACHMENT_BYTES + 2 * 1024 * 1024));

        expect(response.status).toBe(413);
        expect(rows(h)).toBe(0);
    });
});

describe('GET and DELETE of a file', () => {
    test('an unknown file, and a file of another project, are not found', async () => {
        const { h, project } = await setup();
        const other = h.openRepo('other');
        const file = await attach(h, project.id, 'a.txt');

        for (const method of ['GET', 'DELETE']) {
            expect((await h.fetch(`/v1/projects/${project.id}/attachments/att_missing`, { method })).status).toBe(404);
            expect((await h.fetch(`/v1/projects/${other.id}/attachments/${file.id}`, { method })).status).toBe(404);
            expect((await h.fetch(`/v1/projects/prj_nope/attachments/${file.id}`, { method })).status).toBe(404);
        }

        expect(rowOf(h, file.id)).not.toBeNull();
        expect(existsSync(pathOf(h, file))).toBe(true);
    });

    test('a file whose bytes are gone is not found', async () => {
        const { h, project } = await setup();
        const file = await attach(h, project.id, 'a.txt');

        await Bun.$`rm -r ${folderOf(h, file.id)}`;

        expect((await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`)).status).toBe(404);
    });

    test('removes a file that was not sent: the row and the folder', async () => {
        const { h, project } = await setup();
        const file = await attach(h, project.id, 'a.txt');
        const response = await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`, { method: 'DELETE' });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(rowOf(h, file.id)).toBeNull();
        expect(existsSync(folderOf(h, file.id))).toBe(false);
        expect((await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`)).status).toBe(404);
    });

    test('refuses to remove a file that was sent, and keeps it', async () => {
        const { h, project, chat } = await setup();
        const file = await attach(h, project.id, 'a.txt');

        h.ok('chat.send', { chatId: chat.id, text: 'Read this', attachmentIds: [file.id] });

        const response = await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`, { method: 'DELETE' });

        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(rowOf(h, file.id)).not.toBeNull();
        expect(existsSync(pathOf(h, file))).toBe(true);
        expect((await h.fetch(`/v1/projects/${project.id}/attachments/${file.id}`)).status).toBe(200);
    });
});

describe('chat.send with files', () => {
    test("the stream shows the person's text and the files; the agent gets the text and a list of where they are", async () => {
        const { h, engine, project, chat } = await setup();
        const shot = await attach(h, project.id, 'my shot.png', bytes(214 * 1024), 'image/png');
        const log = await attach(h, project.id, 'server.log', bytes(3 * 1024));
        const { runId } = h.ok('chat.send', {
            chatId: chat.id,
            text: '  The footer looks off  ',
            attachmentIds: [shot.id, log.id],
        });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        expect(userItems(h, runId)).toEqual([{ kind: 'user', text: 'The footer looks off', attachments: [shot, log] }]);
        expect(engine.turns[0].prompt).toBe(
            [
                'Follow clowdy:orchestrate. Mode: autopilot',
                '',
                'The footer looks off',
                '',
                'Attached files:',
                `- @"${pathOf(h, shot)}" (image/png, 214 KB)`,
                `- @${pathOf(h, log)} (text/plain, 3 KB)`,
            ].join('\n')
        );
        expect(readFileSync(pathOf(h, shot)).length).toBe(214 * 1024);

        // The files now belong to the chat and its run.
        expect(rowOf(h, shot.id)).toMatchObject({ chat_id: chat.id, run_id: runId });
        expect(rowOf(h, log.id)).toMatchObject({ chat_id: chat.id, run_id: runId });
    });

    test('a message to a busy orchestrator keeps its files while it waits, and its turn carries the same text and list', async () => {
        const gate = latch();
        const { h, engine, project, chat } = await setup(async function* ({ number, signal }) {
            yield { type: 'session', sessionId: 's1' };

            if (number === 1) {
                await gate.wait(signal);
            }

            yield { type: 'done', result: `turn ${number}` };
        });
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Start here' });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        const file = await attach(h, project.id, 'trace.txt', bytes(2048));

        h.ok('chat.send', { chatId: chat.id, text: 'Why does it fail?', attachmentIds: [file.id], mode: 'queue' });

        // The files belong to the chat from the moment the message is queued; the person's bubble waits for the agent.
        expect(rowOf(h, file.id)).toMatchObject({ chat_id: chat.id, run_id: runId });
        expect(userItems(h, runId).filter(body => body.kind === 'user')).toHaveLength(1);

        gate.release();
        await waitFor(() => engine.turns.length === 2, "the queued message's turn");

        expect(engine.turns[1].prompt).toBe(
            `Why does it fail?\n\nAttached files:\n- @${pathOf(h, file)} (text/plain, 2 KB)`
        );
        expect(
            userItems(h, runId)
                .filter(body => body.kind === 'user')
                .at(-1)
        ).toEqual({ kind: 'user', text: 'Why does it fail?', attachments: [file] });
    });

    test('a message to a finished chat starts the next turn with the same text and list, and no prefix', async () => {
        const { h, engine, project, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Start here' });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the first turn');

        const file = await attach(h, project.id, 'spec.pdf', bytes(1536), 'application/pdf');

        h.ok('chat.send', { chatId: chat.id, text: 'Use this spec', attachmentIds: [file.id] });
        await waitFor(() => engine.turns.length === 2, 'the second turn');

        expect(engine.turns[1]).toMatchObject({
            resumeSessionId: 's1',
            prompt: `Use this spec\n\nAttached files:\n- @${pathOf(h, file)} (application/pdf, 1.5 KB)`,
        });
    });

    test('files alone make a message: the stream item has empty text and the agent gets only the list', async () => {
        const { h, engine, project, chat } = await setup();
        const file = await attach(h, project.id, 'screen.png', bytes(5), 'image/png');
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: '', attachmentIds: [file.id] });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        expect(userItems(h, runId)).toEqual([{ kind: 'user', text: '', attachments: [file] }]);
        expect(engine.turns[0].prompt).toBe(
            `Follow clowdy:orchestrate. Mode: autopilot\n\nAttached files:\n- @${pathOf(h, file)} (image/png, 5 B)`
        );
    });

    test('a message with neither text nor files is still invalid, and so is blank text with an empty list', async () => {
        const { h, project, chat } = await setup();

        for (const fields of [
            { text: '' },
            { text: '   \n' },
            { text: '', attachmentIds: [] },
            { text: ' ', attachmentIds: [] },
        ]) {
            expect(h.send('chat.send', { chatId: chat.id, ...fields })).toMatchObject({
                ok: false,
                error: { code: 'invalid' },
            });
        }

        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });

        // The schema lets an empty text through, so the refusal is the handler's, over HTTP too.
        const viaHttp = await h.fetch('/v1/commands', {
            method: 'POST',
            body: JSON.stringify(command('chat.send', { chatId: chat.id, text: '' })),
            headers: { 'content-type': 'application/json' },
        });

        expect(viaHttp.status).toBe(400);
        expect(await viaHttp.json()).toMatchObject({
            ok: false,
            error: { code: 'invalid', message: 'The message is empty' },
        });
        expect(project.id).toBeTruthy();
    });

    test('a message without files is what it was: the same item, the same prompt', async () => {
        const { h, engine, chat } = await setup();
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Add dark mode' });

        await waitFor(() => engine.turns.length === 1, 'the orchestrator to start');

        expect(userItems(h, runId)).toEqual([{ kind: 'user', text: 'Add dark mode' }]);
        expect(engine.turns[0].prompt).toBe('Follow clowdy:orchestrate. Mode: autopilot\n\nAdd dark mode');
    });

    test("refuses ids it cannot use and changes nothing: unknown, another project's, listed twice, sent already", async () => {
        const { h, project, chat } = await setup();
        const other = h.openRepo('other');
        const { chat: otherChat } = h.ok('chat.create', { projectId: other.id });
        const mine = await attach(h, project.id, 'mine.txt');
        const foreign = await attach(h, other.id, 'foreign.txt');
        const used = await attach(h, project.id, 'used.txt');

        h.ok('chat.send', { chatId: otherChat.id, text: 'x', attachmentIds: [foreign.id] });
        h.ok('chat.send', {
            chatId: (h.ok('chat.create', { projectId: project.id }).chat as { id: string }).id,
            text: 'y',
            attachmentIds: [used.id],
        });

        const runsBefore = h.store.db.query('SELECT COUNT(*) AS n FROM runs').get();
        const refuse = (attachmentIds: string[], code: string) =>
            expect(h.send('chat.send', { chatId: chat.id, text: 'Look', attachmentIds })).toMatchObject({
                ok: false,
                error: { code },
            });

        refuse([mine.id, 'att_missing'], 'not_found');
        refuse([mine.id, foreign.id], 'not_found');
        refuse([mine.id, mine.id], 'invalid');
        refuse([mine.id, used.id], 'conflict');

        // Nothing was claimed and no run was made, so the same files can go in a good message.
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM runs').get()).toEqual(runsBefore);
        expect(rowOf(h, mine.id)).toMatchObject({ chat_id: null });
        expect(h.send('chat.send', { chatId: chat.id, text: 'Look', attachmentIds: [mine.id] })).toMatchObject({
            ok: true,
        });
    });

    test('refuses more files, or more bytes, than a message may carry', async () => {
        const { h, project, chat } = await setup();
        const ids = [];

        for (let index = 0; index <= MAX_ATTACHMENTS_PER_MESSAGE; index++) {
            ids.push((await attach(h, project.id, `f${index}.txt`, bytes(1))).id);
        }

        // The command handler checks too, not only the schema.
        expect(h.send('chat.send', { chatId: chat.id, text: 'Many', attachmentIds: ids })).toMatchObject({
            ok: false,
            error: { code: 'invalid', message: expect.stringContaining(String(MAX_ATTACHMENTS_PER_MESSAGE)) },
        });

        const viaHttp = await h.fetch('/v1/commands', {
            method: 'POST',
            body: JSON.stringify(command('chat.send', { chatId: chat.id, text: 'Many', attachmentIds: ids })),
            headers: { 'content-type': 'application/json' },
        });

        expect(viaHttp.status).toBe(400);
        expect(
            h.send('chat.send', {
                chatId: chat.id,
                text: 'Ten',
                attachmentIds: ids.slice(0, MAX_ATTACHMENTS_PER_MESSAGE),
            })
        ).toMatchObject({ ok: true });

        // Files too big together: rows with a size, because writing 100 MB to prove it would only slow the suite.
        const { chat: second } = h.ok('chat.create', { projectId: project.id });
        const big = await Promise.all([1, 2, 3, 4, 5].map(index => attach(h, project.id, `big${index}.bin`, bytes(4))));
        const each = Math.ceil(MAX_ATTACHMENTS_BYTES_PER_MESSAGE / 4);

        for (const { id } of big) {
            h.store.db.query('UPDATE attachments SET size = ? WHERE id = ?').run(each, id);
        }

        expect(
            h.send('chat.send', { chatId: second.id, text: 'Heavy', attachmentIds: big.map(file => file.id) })
        ).toMatchObject({ ok: false, error: { code: 'invalid' } });
        expect(
            h.send('chat.send', {
                chatId: second.id,
                text: 'Heavy',
                attachmentIds: big.slice(0, 4).map(file => file.id),
            })
        ).toMatchObject({ ok: true });
    });

    test('a repeated command does not claim the files twice', async () => {
        const { h, project, chat } = await setup();
        const file = await attach(h, project.id, 'a.txt');
        const send = command('chat.send', { chatId: chat.id, text: 'Once', attachmentIds: [file.id] });
        const first = (
            await h.fetch('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(send),
                headers: { 'content-type': 'application/json' },
            })
        ).json();
        const again = (
            await h.fetch('/v1/commands', {
                method: 'POST',
                body: JSON.stringify(send),
                headers: { 'content-type': 'application/json' },
            })
        ).json();

        expect(await again).toEqual(await first);
        expect(await again).toMatchObject({ ok: true });
        expect(h.store.db.query('SELECT COUNT(*) AS n FROM stream_items').get()).toEqual({ n: 1 });
    });

    test('names a new chat after the text, or after the first file when there is no text, and never renames a named chat', async () => {
        const { h, project } = await setup();
        const file = await attach(h, project.id, 'budget 2026.xlsx', bytes(8));
        const other = await attach(h, project.id, 'other.txt', bytes(8));
        const titleOf = (chatId: string) =>
            (h.store.db.query('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string }).title;
        const fresh = (mode?: ChatMode, title?: string) =>
            (h.ok('chat.create', { projectId: project.id, mode, title }).chat as { id: string }).id;
        const withFile = fresh();
        const withText = fresh();
        const named = fresh(undefined, 'Mine');

        h.ok('chat.send', { chatId: withFile, text: '', attachmentIds: [file.id, other.id] });
        h.ok('chat.send', { chatId: withText, text: 'Review the budget\nsecond line', attachmentIds: [] });
        h.ok('chat.send', {
            chatId: named,
            text: '',
            attachmentIds: [(await attach(h, project.id, 'third.txt', bytes(8))).id],
        });

        expect(titleOf(withFile)).toBe('budget 2026.xlsx');
        expect(titleOf(withText)).toBe('Review the budget');
        expect(titleOf(named)).toBe('Mine');
    });
});

describe('lifetime of the files', () => {
    test("deleting a chat removes the files sent in it and keeps the rest of the project's", async () => {
        const { h, project, chat } = await setup();
        const sent = await attach(h, project.id, 'sent.txt');
        const waiting = await attach(h, project.id, 'waiting.txt');
        const { chat: keptChat } = h.ok('chat.create', { projectId: project.id });
        const keptFile = await attach(h, project.id, 'kept.txt');
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Read it', attachmentIds: [sent.id] });

        h.ok('chat.send', { chatId: keptChat.id, text: 'And this', attachmentIds: [keptFile.id] });
        await waitFor(() => h.run(runId).status === 'succeeded', 'the first chat to finish');
        await waitFor(
            () => projectSnapshot(h.store, project.id).runs.every(run => run.status === 'succeeded'),
            'both chats to finish'
        );

        h.ok('chat.delete', { chatId: chat.id });

        expect(rowOf(h, sent.id)).toBeNull();
        expect(existsSync(folderOf(h, sent.id))).toBe(false);
        expect(rowOf(h, waiting.id)).not.toBeNull();
        expect(existsSync(pathOf(h, waiting))).toBe(true);
        expect(rowOf(h, keptFile.id)).not.toBeNull();
        expect(existsSync(pathOf(h, keptFile))).toBe(true);
    });

    test('a refused deletion keeps the files', async () => {
        const { h, project, chat } = await setup(holding);
        const file = await attach(h, project.id, 'a.txt');

        h.ok('chat.send', { chatId: chat.id, text: 'Busy', attachmentIds: [file.id] });

        expect(h.send('chat.delete', { chatId: chat.id })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(rowOf(h, file.id)).not.toBeNull();
        expect(existsSync(pathOf(h, file))).toBe(true);
    });

    test('archiving a chat keeps its files', async () => {
        const { h, project, chat } = await setup();
        const file = await attach(h, project.id, 'a.txt');
        const { runId } = h.ok('chat.send', { chatId: chat.id, text: 'Read it', attachmentIds: [file.id] });

        await waitFor(() => h.run(runId).status === 'succeeded', 'the turn to finish');
        h.ok('chat.setArchived', { chatId: chat.id, archived: true });

        expect(rowOf(h, file.id)).toMatchObject({ chat_id: chat.id });
        expect(existsSync(pathOf(h, file))).toBe(true);
    });

    test('a file nobody sent is swept after a day, by the next upload and at start; sent and recent files stay', async () => {
        const { h, project, chat } = await setup();
        const stale = await attach(h, project.id, 'stale.txt');
        const recent = await attach(h, project.id, 'recent.txt');
        const sentOld = await attach(h, project.id, 'sent.txt');

        h.ok('chat.send', { chatId: chat.id, text: 'Read it', attachmentIds: [sentOld.id] });
        age(h, stale.id, STALE_AFTER_MS + 60_000);
        age(h, recent.id, STALE_AFTER_MS - 60_000);
        age(h, sentOld.id, 3 * STALE_AFTER_MS);

        const next = await attach(h, project.id, 'next.txt');

        expect(rowOf(h, stale.id)).toBeNull();
        expect(existsSync(folderOf(h, stale.id))).toBe(false);

        for (const file of [recent, sentOld, next]) {
            expect(rowOf(h, file.id)).not.toBeNull();
            expect(existsSync(pathOf(h, file))).toBe(true);
        }

        // At start: the same rule, with a day that passed while the daemon was off.
        age(h, recent.id, STALE_AFTER_MS + 1000);
        await h.stop();

        const restarted = await restartHarness(h, { engines: scriptEngines(new ScriptEngine(finishing)) });

        harnesses.push(restarted);

        expect(rowOf(restarted, recent.id)).toBeNull();
        expect(existsSync(folderOf(restarted, recent.id))).toBe(false);
        expect(rowOf(restarted, sentOld.id)).not.toBeNull();
        expect(rowOf(restarted, next.id)).not.toBeNull();
    });

    test('a folder no row knows is removed at start, and one being uploaded is left alone', async () => {
        const { h, project } = await setup();
        const file = await attach(h, project.id, 'a.txt');
        const stray = join(h.config.dataDir, 'attachments', 'att_STRAY');

        mkdirSync(stray, { recursive: true });
        writeFileSync(join(stray, 'left-over.bin'), 'x');
        await h.stop();

        const restarted = await restartHarness(h, { engines: scriptEngines(new ScriptEngine(finishing)) });

        harnesses.push(restarted);

        expect(existsSync(stray)).toBe(false);
        expect(existsSync(pathOf(restarted, file))).toBe(true);

        // An upload that is still arriving has a folder and no row yet; another upload's sweep must not take it.
        const slow = new ReadableStream<Uint8Array>({
            async start(controller) {
                controller.enqueue(bytes(10));
                await Bun.sleep(150);
                controller.enqueue(bytes(10));
                controller.close();
            },
        });
        const pending = upload(restarted, project.id, 'slow.bin', slow as unknown as Body);

        await waitFor(
            () => readdirSync(join(restarted.config.dataDir, 'attachments')).length === 2,
            'the slow upload to start'
        );
        await attach(restarted, project.id, 'quick.txt');

        const slowFile = (await (await pending).json()) as Attachment;

        expect(slowFile.size).toBe(20);
        expect(existsSync(pathOf(restarted, slowFile))).toBe(true);
    });
});

describe('the body limit of the JSON routes', () => {
    const post = (h: Harness, body: Body) =>
        h.fetch('/v1/commands', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    const eightMb = 8 * 1024 * 1024;

    test('a command over 8 MB is refused with a bare 413, as before, and not run', async () => {
        const { h, project } = await setup();
        const padded = (extra: number) =>
            JSON.stringify({ requestId: `req-big-${extra}`, type: 'chat.create', projectId: project.id }) +
            ' '.repeat(extra);
        const chats = () => projectSnapshot(h.store, project.id).chats.length;
        const before = chats();

        const declared = await post(h, padded(eightMb + 1));

        expect(declared.status).toBe(413);
        expect(await declared.text()).toBe('');

        const chunked = await post(
            h,
            new ReadableStream<Uint8Array>({
                start(controller) {
                    for (let index = 0; index < 9; index++) {
                        controller.enqueue(new TextEncoder().encode(padded(0) + ' '.repeat(1024 * 1024)));
                    }

                    controller.close();
                },
            }) as unknown as Body
        );

        expect(chunked.status).toBe(413);
        expect(chats()).toBe(before);

        // A body under the limit still goes through, even when it is large.
        const large = await post(h, padded(7 * 1024 * 1024));

        expect(large.status).toBe(200);
        expect(chats()).toBe(before + 1);
    });

    test("the limit holds for a body past an upload's too, and for routes that read no body", async () => {
        const { h } = await setup();
        const huge = bytes(MAX_ATTACHMENT_BYTES - 1024);

        expect((await post(h, huge)).status).toBe(413);
        expect((await h.fetch('/v1/snapshot', { method: 'POST', body: huge })).status).toBe(413);
        expect((await h.fetch('/v1/health', { method: 'POST', body: bytes(eightMb + 1) })).status).toBe(413);
        expect((await h.fetch('/v1/health')).status).toBe(200);
    });
});

describe('names, types and the message block', () => {
    test('safeFileName keeps the last path segment and drops what a file system or a reader should not meet', () => {
        expect(safeFileName('shot.png')).toBe('shot.png');
        expect(safeFileName('my shot (2).png')).toBe('my shot (2).png');
        expect(safeFileName('/tmp/a/b.txt')).toBe('b.txt');
        expect(safeFileName('C:\\Users\\me\\b.txt')).toBe('b.txt');
        expect(safeFileName('../../etc/passwd')).toBe('passwd');
        expect(safeFileName('a/..')).toBe('file');
        expect(safeFileName('dir/')).toBe('dir');
        expect(safeFileName('.bashrc')).toBe('bashrc');
        expect(safeFileName('...hidden.txt')).toBe('hidden.txt');
        expect(safeFileName('a\u0000b\nc\td.txt')).toBe('abcd.txt');
        expect(safeFileName('photo\u202Egpj.exe')).toBe('photogpj.exe');
        expect(safeFileName('a:b*c?"d<e>f|g.txt')).toBe('a_b_c__d_e_f_g.txt');
        expect(safeFileName('report.')).toBe('report');
        expect(safeFileName('  spaced out.txt  ')).toBe('spaced out.txt');
        expect(safeFileName('nul.txt')).toBe('_nul.txt');
        expect(safeFileName('COM1')).toBe('_COM1');
        expect(safeFileName('CON .txt')).toBe('_CON .txt');
        expect(safeFileName('lpt\u00B9.log')).toBe('_lpt\u00B9.log');
        expect(safeFileName('console.txt')).toBe('console.txt');
        expect(safeFileName('a\u2028b\u2029c\u00ADd.txt')).toBe('abcd.txt');
        expect(safeFileName('')).toBe('file');
        expect(safeFileName('....')).toBe('file');
        expect(safeFileName('ünï cödé.txt')).toBe('ünï cödé.txt');
    });

    test('safeFileName caps a long name and keeps its extension, by characters and by bytes', () => {
        const long = safeFileName(`${'a'.repeat(300)}.tar.gz`);

        expect(long).toHaveLength(120);
        expect(long.endsWith('.gz')).toBe(true);
        expect(safeFileName('b'.repeat(120))).toBe('b'.repeat(120));
        expect(safeFileName('c'.repeat(121))).toBe('c'.repeat(120));

        const wide = safeFileName(`${'日'.repeat(200)}.pdf`);

        expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(240);
        expect(wide.endsWith('.pdf')).toBe(true);
        expect(safeFileName(`${'d'.repeat(300)}.${'x'.repeat(40)}`)).toHaveLength(120);
    });

    test('mediaTypeOf and servedMediaType', () => {
        expect(mediaTypeOf('image/png', 'x')).toBe('image/png');
        expect(mediaTypeOf(null, 'a.JPG')).toBe('image/jpeg');
        expect(mediaTypeOf('', 'a.log')).toBe('text/plain');
        expect(mediaTypeOf('not a type', 'a.pdf')).toBe('application/pdf');
        expect(mediaTypeOf('a/b/c', 'a.zip')).toBe('application/zip');
        expect(mediaTypeOf(null, 'a')).toBe('application/octet-stream');
        expect(servedMediaType('image/png')).toBe('image/png');
        expect(servedMediaType('text/plain')).toBe('text/plain');
        expect(servedMediaType('application/pdf')).toBe('application/pdf');

        for (const active of [
            'text/html',
            'image/svg+xml',
            'text/xml',
            'application/xml',
            'application/xhtml+xml',
            'application/atom+xml',
            'multipart/related',
            'message/rfc822',
        ]) {
            expect(servedMediaType(active)).toBe('application/octet-stream');
        }
    });

    test('contentDisposition escapes what a header value may not hold', () => {
        expect(contentDisposition('shot.png')).toBe("inline; filename*=UTF-8''shot.png");
        expect(contentDisposition("my shot (2) 'x'*.png")).toBe(
            "inline; filename*=UTF-8''my%20shot%20%282%29%20%27x%27%2A.png"
        );
        expect(contentDisposition('日本.pdf')).toBe("inline; filename*=UTF-8''%E6%97%A5%E6%9C%AC.pdf");
    });

    test('formatSize rounds the way a person reads sizes', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1023)).toBe('1023 B');
        expect(formatSize(1024)).toBe('1 KB');
        expect(formatSize(1536)).toBe('1.5 KB');
        expect(formatSize(3 * 1024)).toBe('3 KB');
        expect(formatSize(214 * 1024)).toBe('214 KB');
        expect(formatSize(1024 * 1024 - 1)).toBe('1 MB');
        expect(formatSize(1024 * 1024)).toBe('1 MB');
        expect(formatSize(25 * 1024 * 1024)).toBe('25 MB');
        expect(formatSize(100 * 1024 * 1024)).toBe('100 MB');
        expect(formatSize(3 * 1024 ** 3)).toBe('3 GB');
    });

    test('messageWithFiles writes paths the way the composer mentions them', () => {
        const files = [
            { path: '/data/a b/shot.png', mediaType: 'image/png', size: 2048 },
            { path: '/data/c/x.log', mediaType: 'text/plain', size: 10 },
        ];

        expect(messageWithFiles('Look', [])).toBe('Look');
        expect(messageWithFiles('Look', files)).toBe(
            'Look\n\nAttached files:\n- @"/data/a b/shot.png" (image/png, 2 KB)\n- @/data/c/x.log (text/plain, 10 B)'
        );
        expect(messageWithFiles('', files)).toBe(
            'Attached files:\n- @"/data/a b/shot.png" (image/png, 2 KB)\n- @/data/c/x.log (text/plain, 10 B)'
        );
    });
});
