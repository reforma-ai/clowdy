import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FS_VERSION_HEADER } from '@clowdy/protocol';

import { EventReader, openFolder, put } from './fs-helpers';
import { cleanTempDirs, Harness, startHarness, tempDir } from './helpers';

import type { FsEntry } from '@clowdy/protocol';
import type { OpenFolder } from './fs-helpers';

afterAll(cleanTempDirs);

let h: Harness;
const readers: EventReader[] = [];

beforeEach(async () => {
    h = await startHarness();
});

afterEach(async () => {
    await Promise.all(readers.splice(0).map(reader => reader.close()));
    await h.stop();
});

const query = (folder: OpenFolder, params: Record<string, string> = {}) =>
    new URLSearchParams({ folderId: folder.folderId, ...params }).toString();
const base = (folder: OpenFolder) => `/v1/projects/${folder.project.id}/fs`;
const post = (folder: OpenFolder, route: string, body: unknown) =>
    h.fetch(`${base(folder)}/${route}`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
    });
const put_ = (folder: OpenFolder, path: string, body: string | null, headers: Record<string, string> = {}) =>
    h.fetch(`${base(folder)}/file?${query(folder, { path })}`, { method: 'PUT', body, headers });
const get = (folder: OpenFolder, path: string) => h.fetch(`${base(folder)}/file?${query(folder, { path })}`);

async function failureOf(response: Response) {
    const body = (await response.json()) as {
        ok: false;
        error: {
            code: string;
            message: string;
            details?: { reason?: string; path?: string; currentVersion?: string | null };
        };
    };

    expect(body.ok).toBe(false);

    return body.error;
}

describe('every route is behind the token', () => {
    test('answers 401 without it and with a wrong one', async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const requests: Array<[string, string]> = [
            ['GET', `list?${query(folder)}`],
            ['GET', `find?${query(folder, { query: 'a' })}`],
            ['GET', `file?${query(folder, { path: 'a.txt' })}`],
            ['PUT', `file?${query(folder, { path: 'a.txt' })}`],
            ['POST', 'folder'],
            ['POST', 'move'],
            ['POST', 'copy'],
            ['POST', 'delete'],
            ['GET', `watch?${query(folder)}`],
        ];

        for (const [method, route] of requests) {
            for (const headers of [{}, { authorization: 'Bearer wrong' }] as Record<string, string>[]) {
                const response = await fetch(`${h.url}${base(folder)}/${route}`, {
                    method,
                    headers,
                    body: method === 'GET' ? undefined : '{}',
                });

                expect(response.status).toBe(401);
            }
        }

        expect(readFileSync(join(folder.dir, 'a.txt'), 'utf8')).toBe('1');
    });
});

describe('GET fs/list', () => {
    test('answers the entries, honours depth and path, and refuses what is not a listing', async () => {
        const folder = openFolder(h, { 'a.txt': 'abc', 'src/app/main.ts': 'x', '.git/HEAD': 'r' });
        const all = (await (await h.fetch(`${base(folder)}/list?${query(folder)}`)).json()) as FsEntry[];

        expect(all.map(entry => entry.path).sort()).toEqual(['.git', 'a.txt', 'src', 'src/app', 'src/app/main.ts']);
        expect(all.find(entry => entry.path === '.git')).toEqual({
            path: '.git',
            kind: 'directory',
            hasChildren: true,
        });

        const shallow = (await (
            await h.fetch(`${base(folder)}/list?${query(folder, { depth: '1' })}`)
        ).json()) as FsEntry[];

        expect(shallow.find(entry => entry.path === 'src')).toEqual({
            path: 'src',
            kind: 'directory',
            hasChildren: true,
        });
        expect(
            await (await h.fetch(`${base(folder)}/list?${query(folder, { path: 'src', depth: '1' })}`)).json()
        ).toEqual([{ path: 'src/app', kind: 'directory', hasChildren: true }]);

        expect((await failureOf(await h.fetch(`${base(folder)}/list?${query(folder, { depth: 'deep' })}`))).code).toBe(
            'invalid'
        );
        expect((await failureOf(await h.fetch(`${base(folder)}/list?${query(folder, { path: 'a.txt' })}`))).code).toBe(
            'invalid'
        );
        expect((await h.fetch(`${base(folder)}/list?${query(folder, { path: 'nope' })}`)).status).toBe(404);
        expect((await h.fetch(`${base(folder)}/list?${query(folder, { path: '../x' })}`)).status).toBe(400);
    });

    test('an unknown project or folder is 404 and no folder is 400', async () => {
        const folder = openFolder(h);

        expect((await h.fetch(`/v1/projects/prj_nope/fs/list?folderId=${folder.folderId}`)).status).toBe(404);
        expect((await h.fetch(`${base(folder)}/list?folderId=fld_nope`)).status).toBe(404);
        expect((await h.fetch(`${base(folder)}/list`)).status).toBe(400);
    });
});

describe('GET fs/find', () => {
    test('answers the paths whose name matches', async () => {
        const folder = openFolder(h, { 'src/Button.tsx': '1', 'src/card.tsx': '2', 'notes.md': '3' });

        expect(await (await h.fetch(`${base(folder)}/find?${query(folder, { query: 'button' })}`)).json()).toEqual([
            'src/Button.tsx',
        ]);
        expect(
            (
                (await (await h.fetch(`${base(folder)}/find?${query(folder, { query: '*.tsx' })}`)).json()) as string[]
            ).sort()
        ).toEqual(['src/Button.tsx', 'src/card.tsx']);
        expect(await (await h.fetch(`${base(folder)}/find?${query(folder)}`)).json()).toEqual([]);
    });
});

describe('GET and PUT fs/file', () => {
    test('serves the bytes as an opaque download with the version in a header', async () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 255]);
        const folder = openFolder(h, { 'a.bin': bytes, '<script>.html': '<script>alert(1)</script>' });
        const response = await get(folder, 'a.bin');

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/octet-stream');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toBe('sandbox');
        expect(response.headers.get(FS_VERSION_HEADER)).toMatch(/^\d+:\d+$/);
        expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([...bytes]);

        const page = await get(folder, '<script>.html');

        expect(page.headers.get('content-type')).toBe('application/octet-stream');
    });

    test("exposes the version header to the app's page", async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const response = await h.fetch(`${base(folder)}/file?${query(folder, { path: 'a.txt' })}`, {
            headers: { origin: 'app://clowdy' },
        });

        expect(response.headers.get('access-control-expose-headers')?.toLowerCase()).toContain(FS_VERSION_HEADER);
    });

    test('refuses what cannot be read: a missing file, a folder, a file over the limit, a path that leaves the folder', async () => {
        const folder = openFolder(h, { 'dir/a.txt': '1', 'big.txt': '123456' });

        expect((await get(folder, 'nope.txt')).status).toBe(404);
        expect((await failureOf(await get(folder, 'dir'))).code).toBe('invalid');
        expect(await failureOf(await get(folder, '../../etc/passwd'))).toMatchObject({
            code: 'invalid',
            details: { reason: 'outside' },
        });
        expect(await failureOf(await get(folder, '/etc/passwd'))).toMatchObject({
            code: 'invalid',
            details: { reason: 'outside' },
        });

        folder.fs.maxFileBytes = 5;

        const big = await get(folder, 'big.txt');

        expect(big.status).toBe(400);
        expect(await failureOf(big)).toMatchObject({ code: 'invalid', details: { reason: 'too_large' } });
    });

    test('writes the raw body, makes the parent folders and answers the version a read gives', async () => {
        const folder = openFolder(h);
        const response = await put_(folder, 'new/dir/a.txt', 'héllo');
        const { version } = (await response.json()) as { version: string };

        expect(response.status).toBe(200);
        expect(readFileSync(join(folder.dir, 'new/dir/a.txt'), 'utf8')).toBe('héllo');
        expect((await get(folder, 'new/dir/a.txt')).headers.get(FS_VERSION_HEADER)).toBe(version);
        expect((await put_(folder, 'empty.txt', null)).status).toBe(200);
        expect(readFileSync(join(folder.dir, 'empty.txt')).length).toBe(0);
    });

    test('If-None-Match: * writes only a new file; the conflict says it exists', async () => {
        const folder = openFolder(h, { 'a.txt': 'one' });
        const refused = await put_(folder, 'a.txt', 'two', { 'if-none-match': '*' });

        expect(refused.status).toBe(409);
        expect(await failureOf(refused)).toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'a.txt' },
        });
        expect(readFileSync(join(folder.dir, 'a.txt'), 'utf8')).toBe('one');
        expect((await put_(folder, 'b.txt', 'new', { 'if-none-match': '*' })).status).toBe(200);
    });

    test('If-Match writes only over that version; the conflict says what is there now, or null when nothing is', async () => {
        const folder = openFolder(h, { 'a.txt': 'one' });
        const stale = (await get(folder, 'a.txt')).headers.get(FS_VERSION_HEADER) as string;
        const { version } = (await (await put_(folder, 'a.txt', 'two!', { 'if-match': stale })).json()) as {
            version: string;
        };
        const refused = await put_(folder, 'a.txt', 'three', { 'if-match': stale });

        expect(refused.status).toBe(409);
        expect(await failureOf(refused)).toMatchObject({
            code: 'conflict',
            details: { reason: 'version', currentVersion: version },
        });
        expect(readFileSync(join(folder.dir, 'a.txt'), 'utf8')).toBe('two!');

        const gone = await put_(folder, 'gone.txt', 'x', { 'if-match': '1:1' });

        expect(await failureOf(gone)).toMatchObject({
            code: 'conflict',
            details: { reason: 'version', currentVersion: null },
        });
        // A version may come quoted, as HTTP quotes an entity tag.
        expect((await put_(folder, 'a.txt', 'four', { 'if-match': `"${version}"` })).status).toBe(200);
    });

    test('refuses preconditions that make no sense, a body over the limit, and a write over a folder', async () => {
        const folder = openFolder(h, { 'dir/a.txt': '1' });

        expect((await put_(folder, 'a.txt', 'x', { 'if-none-match': '"abc"' })).status).toBe(400);
        expect((await put_(folder, 'a.txt', 'x', { 'if-none-match': '*', 'if-match': '1:1' })).status).toBe(400);
        expect(await failureOf(await put_(folder, 'dir', 'x'))).toMatchObject({
            code: 'conflict',
            details: { reason: 'exists' },
        });
        expect(await failureOf(await put_(folder, '../out.txt', 'x'))).toMatchObject({
            code: 'invalid',
            details: { reason: 'outside' },
        });

        folder.fs.maxFileBytes = 3;

        const big = await put_(folder, 'big.txt', 'abcd');

        expect(big.status).toBe(413);
        expect(await failureOf(big)).toMatchObject({ code: 'invalid', details: { reason: 'too_large', maxBytes: 3 } });
        expect(existsSync(join(folder.dir, 'big.txt'))).toBe(false);
    });

    test.skipIf(process.platform === 'win32')('never writes through a link out of the folder', async () => {
        const outside = tempDir('outside');
        const folder = openFolder(h);

        symlinkSync(outside, join(folder.dir, 'out'));

        expect(await failureOf(await put_(folder, 'out/new.txt', 'x'))).toMatchObject({
            code: 'invalid',
            details: { reason: 'outside' },
        });
        expect(existsSync(join(outside, 'new.txt'))).toBe(false);
    });
});

describe('POST fs/folder, move, copy and delete', () => {
    test('make a folder, move, copy and delete, answering ok', async () => {
        const folder = openFolder(h, { 'a.txt': 'a', 'b.txt': 'b', 'src/c.ts': 'c' });
        const id = folder.folderId;

        expect(await (await post(folder, 'folder', { folderId: id, path: 'x/y' })).json()).toEqual({ ok: true });
        expect(existsSync(join(folder.dir, 'x/y'))).toBe(true);
        expect(
            await (await post(folder, 'move', { folderId: id, moves: [{ from: 'a.txt', to: 'x/a.txt' }] })).json()
        ).toEqual({ ok: true });
        expect(
            await (await post(folder, 'copy', { folderId: id, copies: [{ from: 'src', to: 'src2' }] })).json()
        ).toEqual({ ok: true });
        expect(
            await (await post(folder, 'delete', { folderId: id, paths: ['b.txt', 'src', 'never-there'] })).json()
        ).toEqual({ ok: true });

        expect(readFileSync(join(folder.dir, 'x/a.txt'), 'utf8')).toBe('a');
        expect(readFileSync(join(folder.dir, 'src2/c.ts'), 'utf8')).toBe('c');
        expect(existsSync(join(folder.dir, 'b.txt'))).toBe(false);
        expect(existsSync(join(folder.dir, 'src'))).toBe(false);
    });

    test('a target that is there is 409 with the reason and the path, and overwrite replaces it', async () => {
        const folder = openFolder(h, { 'a.txt': 'a', 'b.txt': 'b' });
        const id = folder.folderId;
        const refused = await post(folder, 'move', { folderId: id, moves: [{ from: 'a.txt', to: 'b.txt' }] });

        expect(refused.status).toBe(409);
        expect(await failureOf(refused)).toMatchObject({
            code: 'conflict',
            details: { reason: 'exists', path: 'b.txt' },
        });
        expect(readFileSync(join(folder.dir, 'a.txt'), 'utf8')).toBe('a');

        expect((await post(folder, 'copy', { folderId: id, copies: [{ from: 'a.txt', to: 'b.txt' }] })).status).toBe(
            409
        );
        expect(
            (await post(folder, 'copy', { folderId: id, copies: [{ from: 'a.txt', to: 'b.txt' }], overwrite: true }))
                .status
        ).toBe(200);
        expect(readFileSync(join(folder.dir, 'b.txt'), 'utf8')).toBe('a');
    });

    test('a missing source is 404, a path that leaves the folder 400 with the reason, the folder itself 400', async () => {
        const folder = openFolder(h, { 'a.txt': 'a' });
        const id = folder.folderId;

        expect((await post(folder, 'move', { folderId: id, moves: [{ from: 'nope', to: 'x' }] })).status).toBe(404);
        expect(
            await failureOf(await post(folder, 'move', { folderId: id, moves: [{ from: 'a.txt', to: '../a.txt' }] }))
        ).toMatchObject({ code: 'invalid', details: { reason: 'outside' } });
        expect(await failureOf(await post(folder, 'delete', { folderId: id, paths: ['/'] }))).toMatchObject({
            code: 'invalid',
        });
        expect((await post(folder, 'delete', { folderId: id, paths: [''] })).status).toBe(400);
        expect(existsSync(folder.dir)).toBe(true);
        expect(existsSync(join(folder.dir, 'a.txt'))).toBe(true);
    });

    test('a body that is not what the route takes is 400, and so is one that is not JSON', async () => {
        const folder = openFolder(h);

        expect((await post(folder, 'move', { folderId: folder.folderId, moves: 'a.txt' })).status).toBe(400);
        expect((await post(folder, 'delete', { paths: [] })).status).toBe(400);
        expect((await post(folder, 'folder', { folderId: folder.folderId, path: 7 })).status).toBe(400);
        expect((await h.fetch(`${base(folder)}/delete`, { method: 'POST', body: 'not json' })).status).toBe(400);
        expect((await post(folder, 'move', { folderId: 'fld_nope', moves: [] })).status).toBe(404);
    });

    test('a path that is not a method of the route is 405', async () => {
        const folder = openFolder(h);

        expect((await h.fetch(`${base(folder)}/move`)).status).toBe(405);
        expect((await h.fetch(`${base(folder)}/file?${query(folder)}`, { method: 'POST' })).status).toBe(405);
    });
});

describe('GET fs/watch', () => {
    test('streams the changes of the folder as events with no event name', async () => {
        const folder = openFolder(h, { 'a.txt': '1' });
        const response = await h.fetch(`${base(folder)}/watch?${query(folder)}`);

        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toStartWith('text/event-stream');

        const reader = new EventReader(response.body as ReadableStream<Uint8Array>);

        readers.push(reader);
        await new Promise(resolve => setTimeout(resolve, 300));

        // A write over HTTP is told on the stream with the version it answered.
        const { version } = (await (await put_(folder, 'new.txt', 'hello')).json()) as { version: string };
        const [event] = await reader.next();

        expect(event).toEqual({
            type: 'changes',
            changes: [{ type: 'created', path: 'new.txt', kind: 'file', version, size: 5 }],
        });
        expect(reader.text).not.toContain('event:');
    });

    test('is 404 for an unknown folder and stays open past the idle timeout with heartbeats', async () => {
        const folder = openFolder(h);

        expect((await h.fetch(`${base(folder)}/watch?folderId=fld_nope`)).status).toBe(404);

        const beating = await startHarness({}, { heartbeatMs: 50 });
        const beatingFolder = openFolder(beating);
        const reader = new EventReader(
            (await beating.fetch(`${base(beatingFolder)}/watch?${query(beatingFolder)}`))
                .body as ReadableStream<Uint8Array>
        );

        readers.push(reader);
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(reader.text).toContain(': heartbeat');
        await reader.close();
        await beating.stop();
    });
});

describe('a project with a folder that has no files in common with another', () => {
    test('two folders of one project are separate trees', async () => {
        const first = openFolder(h, { 'one.txt': '1' });
        const second = tempDir('second');

        put(second, { 'two.txt': '2' });

        const updated = h.ok('project.update', {
            projectId: first.project.id,
            folders: [{ id: first.folderId }, { path: second }],
        }).project;
        const ids = updated.folders.map((folder: { id: string }) => folder.id) as string[];

        expect(await (await h.fetch(`${base(first)}/list?folderId=${ids[0]}`)).json()).toEqual([
            { path: 'one.txt', kind: 'file', size: 1 },
        ]);
        expect(await (await h.fetch(`${base(first)}/list?folderId=${ids[1]}`)).json()).toEqual([
            { path: 'two.txt', kind: 'file', size: 1 },
        ]);
        expect((await h.fetch(`${base(first)}/file?folderId=${ids[0]}&path=two.txt`)).status).toBe(404);
    });
});
