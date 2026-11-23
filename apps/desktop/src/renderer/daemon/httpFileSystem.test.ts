import { FileSystemError } from '@clowdy/file-manager/provider';
import { FS_VERSION_HEADER } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { HttpFileSystem } from './httpFileSystem';

import type { WatchEvent } from '@clowdy/file-manager/provider';

const TARGET = { base: 'http://127.0.0.1:4310', headers: { authorization: 'Bearer t' } };
const ROUTE = '/v1/projects/prj_1/fs';

interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

/** A file system whose daemon answers each request with the next of `answers`, and keeps what it was asked. With `workspaceId` it is the worktree of the folder. */
function system(...answers: Array<Response | (() => Response)>) {
    return systemOf(undefined, ...answers);
}

function systemOf(workspaceId: string | undefined, ...answers: Array<Response | (() => Response)>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>, body: init?.body });

        const answer = answers.shift();

        if (!answer) throw new Error('Nothing is answering');

        return typeof answer === 'function' ? answer() : answer;
    }) as typeof fetch;

    return { calls, files: new HttpFileSystem({ target: () => TARGET, fetch: fetchImpl, route: ROUTE, folderId: 'fld 1', ...(workspaceId !== undefined && { workspaceId }), sleep: () => Promise.resolve() }) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = (status: number, code: string, message: string, details?: unknown) => json({ ok: false, error: { code, message, details } }, status);

async function failure(run: () => Promise<unknown>): Promise<FileSystemError> {
    const error = await run().then(() => undefined, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(FileSystemError);

    return error as FileSystemError;
}

describe('HttpFileSystem reads', () => {
    it('lists a folder to a depth, and a whole folder without one, with the folder and the token on every request', async () => {
        const { calls, files } = system(json([{ path: 'src', kind: 'directory', hasChildren: true }]), json([]));

        expect(await files.list('app', 3)).toEqual([{ path: 'src', kind: 'directory', hasChildren: true }]);
        await files.list();

        expect(calls.map(call => call.url)).toEqual([
            `${ TARGET.base }${ ROUTE }/list?folderId=fld+1&path=app&depth=3`,
            `${ TARGET.base }${ ROUTE }/list?folderId=fld+1&path=`,
        ]);
        expect(calls[0]!.headers).toMatchObject({ authorization: 'Bearer t' });
    });

    it('finds files by name', async () => {
        const { calls, files } = system(json(['src/a b.ts']));

        expect(await files.findFiles('a b&c')).toEqual(['src/a b.ts']);
        expect(calls[0]!.url).toBe(`${ TARGET.base }${ ROUTE }/find?folderId=fld+1&query=a+b%26c`);
    });

    it('reads UTF-8 bytes as text with the version the daemon gave, and anything else as a binary file', async () => {
        const { files } = system(
            new Response('héllo\n', { headers: { [FS_VERSION_HEADER]: '6-1' } }),
            new Response(new Uint8Array([0xff, 0xfe, 0x00]), { headers: { [FS_VERSION_HEADER]: '3-2' } })
        );

        expect(await files.read('a.txt')).toEqual({ kind: 'text', text: 'héllo\n', version: '6-1' });

        const binary = await files.read('a.bin');

        expect(binary).toMatchObject({ kind: 'binary', version: '3-2' });
        expect(binary.kind === 'binary' && binary.blob.size).toBe(3);
    });
});

describe('HttpFileSystem writes', () => {
    it('writes over the version it read, or only a new file, or over whatever is there', async () => {
        const { calls, files } = system(json({ version: '2-2' }), json({ version: '1-1' }), json({ version: '3-3' }));

        expect(await files.write('a.txt', 'hi', { expectedVersion: '1-1' })).toBe('2-2');
        await files.write('b.txt', 'new', { expectedVersion: null });
        await files.write('c.txt', new Blob(['x']));

        expect(calls.map(call => [call.method, call.url.split('?')[1], call.headers['if-match'], call.headers['if-none-match']])).toEqual([
            ['PUT', 'folderId=fld+1&path=a.txt', '1-1', undefined],
            ['PUT', 'folderId=fld+1&path=b.txt', undefined, '*'],
            ['PUT', 'folderId=fld+1&path=c.txt', undefined, undefined],
        ]);
        expect(calls[0]!.body).toBe('hi');
    });

    it('sends a folder, a move, a copy and a delete as JSON that names the folder', async () => {
        const ok = () => json({ ok: true });
        const { calls, files } = system(ok, ok, ok, ok, ok);

        await files.createDirectory('docs/new');
        await files.move([{ from: 'a', to: 'b' }], { overwrite: true });
        await files.copy([{ from: 'a', to: 'c' }]);
        await files.delete(['x', 'y']);

        expect(calls.map(call => [call.method, call.url.slice(TARGET.base.length), JSON.parse(call.body as string)])).toEqual([
            ['POST', `${ ROUTE }/folder`, { folderId: 'fld 1', path: 'docs/new' }],
            ['POST', `${ ROUTE }/move`, { folderId: 'fld 1', moves: [{ from: 'a', to: 'b' }], overwrite: true }],
            ['POST', `${ ROUTE }/copy`, { folderId: 'fld 1', copies: [{ from: 'a', to: 'c' }] }],
            ['POST', `${ ROUTE }/delete`, { folderId: 'fld 1', paths: ['x', 'y'] }],
        ]);
    });
});

describe('HttpFileSystem search', () => {
    it('sends the query and its options to the daemon, and hands the matches over as they come', async () => {
        const found = { files: [{ path: 'src/a.ts', matches: [{ line: 3, column: 5, preview: 'let a = 1', ranges: [{ start: 4, end: 5 }] }] }], truncated: false };
        const { calls, files } = system(json(found));

        expect(await files.search({ query: 'a.b(', matchCase: true, wholeWord: false, exclude: ['**/dist'] }, new AbortController().signal)).toEqual(found);
        expect(calls[0]).toMatchObject({ method: 'POST', url: `${ TARGET.base }${ ROUTE }/search` });
        expect(JSON.parse(calls[0]!.body as string)).toEqual({ folderId: 'fld 1', query: 'a.b(', matchCase: true, wholeWord: false, exclude: ['**/dist'] });
    });

    it('shows the daemon\'s reason when a search is refused', async () => {
        const { files } = system(refused(400, 'invalid', 'The glob is not valid'));

        expect(await failure(() => files.search({ query: 'a', exclude: ['['] }, new AbortController().signal))).toMatchObject({ code: 'Unavailable', message: 'The glob is not valid' });
    });

    it('passes on the abort of a search as it is, not as a daemon that cannot be reached', async () => {
        const controller = new AbortController();
        const files = new HttpFileSystem({
            target: () => TARGET,
            fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            })) as typeof fetch,
            route: ROUTE,
            folderId: 'f',
        });
        const pending = files.search({ query: 'a' }, controller.signal);

        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('HttpFileSystem failures', () => {
    it('tells a missing file, a file that is there, a file that changed, and a path outside the folder apart by the code the file manager acts on', async () => {
        const { files } = system(
            refused(404, 'not_found', 'a.txt does not exist'),
            refused(409, 'conflict', 'b.txt exists', { reason: 'exists', path: 'b.txt' }),
            refused(409, 'conflict', 'c.txt changed', { reason: 'version', currentVersion: '9-9' }),
            refused(409, 'conflict', 'c.txt is gone', { reason: 'version', currentVersion: null }),
            refused(400, 'invalid', 'Outside the folder', { reason: 'outside' }),
            refused(503, 'unavailable', 'The disk does not answer')
        );

        expect(await failure(() => files.read('a.txt'))).toMatchObject({ code: 'NotFound', path: 'a.txt', message: 'a.txt does not exist' });
        expect(await failure(() => files.write('b.txt', '', { expectedVersion: null }))).toMatchObject({ code: 'Exists', path: 'b.txt' });
        expect(await failure(() => files.write('c.txt', '', { expectedVersion: '1-1' }))).toMatchObject({ code: 'Conflict', currentVersion: '9-9' });
        expect(await failure(() => files.write('c.txt', '', { expectedVersion: '1-1' }))).toMatchObject({ code: 'Conflict', currentVersion: null });
        expect(await failure(() => files.read('../x'))).toMatchObject({ code: 'NoPermission' });
        expect(await failure(() => files.list())).toMatchObject({ code: 'Unavailable', message: 'The disk does not answer' });
    });

    it('is unavailable when the daemon cannot be reached, or answers something that is not its error body', async () => {
        const down = new HttpFileSystem({ target: () => TARGET, fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch, route: ROUTE, folderId: 'f' });
        const { files } = system(new Response('<html>', { status: 502 }));

        expect(await failure(() => down.list())).toMatchObject({ code: 'Unavailable', message: 'The daemon cannot be reached' });
        expect(await failure(() => files.list())).toMatchObject({ code: 'Unavailable', message: 'The daemon answered 502' });
    });
});

describe('HttpFileSystem watch', () => {
    const stream = (...frames: string[]) => new Response(new ReadableStream({
        start(controller) {
            for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));

            controller.close();
        },
    }), { headers: { 'content-type': 'text/event-stream' } });

    it('starts every stream with a resync, as changes may have gone by before it opened, and hands over what the stream says', async () => {
        const events: WatchEvent[] = [];
        const { calls, files } = system(
            stream('data: {"type":"changes","changes":[{"type":"deleted","path":"a.txt"}]}\n\n'),
            stream('data: {"type":"changes","changes":[{"type":"changed","path":"b.txt"}]}\n\n'),
            () => new Response(null, { status: 500 })
        );
        const done = new Promise<void>((resolve) => {
            const stop = files.watch((event) => {
                events.push(event);

                if (events.length === 4) {
                    stop();
                    resolve();
                }
            });
        });

        await done;

        expect(events).toEqual([
            { type: 'resync' },
            { type: 'changes', changes: [{ type: 'deleted', path: 'a.txt' }] },
            { type: 'resync' },
            { type: 'changes', changes: [{ type: 'changed', path: 'b.txt' }] },
        ]);
        expect(calls[0]!.url).toBe(`${ TARGET.base }${ ROUTE }/watch?folderId=fld+1`);
        expect(calls[0]!.headers).toMatchObject({ accept: 'text/event-stream', authorization: 'Bearer t' });
    });
    it('skips a frame that is not an event and follows the same stream on', async () => {
        const events: WatchEvent[] = [];
        const { calls, files } = system(
            stream('data: not json\n\n', 'data: null\n\n', 'data: {"type":"nothing"}\n\n', 'data: {"type":"changes"}\n\n', 'data: {"type":"changes","changes":[{"type":"deleted","path":"a.txt"}]}\n\n')
        );
        const done = new Promise<void>((resolve) => {
            const stop = files.watch((event) => {
                events.push(event);

                if (event.type === 'changes') {
                    stop();
                    resolve();
                }
            });
        });

        await done;

        expect(events).toEqual([{ type: 'resync' }, { type: 'changes', changes: [{ type: 'deleted', path: 'a.txt' }] }]);
        expect(calls).toHaveLength(1);
    });

    it('closes the stream it leaves when a listener throws, and starts again with a resync', async () => {
        let cancelled = 0;
        const open = () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"type":"changes","changes":[]}\n\n'));
            },
            cancel() {
                cancelled += 1;
            },
        }));
        const events: string[] = [];
        const { calls, files } = system(open, open);
        const done = new Promise<void>((resolve) => {
            const stop = files.watch((event) => {
                events.push(event.type);

                if (events.length === 2) throw new Error('A listener that fails');

                if (events.length === 4) {
                    stop();
                    resolve();
                }
            });
        });

        await done;

        expect(events.slice(0, 4)).toEqual(['resync', 'changes', 'resync', 'changes']);
        expect(cancelled).toBeGreaterThanOrEqual(1);
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    it('stops following a folder that the daemon does not have, instead of asking again for as long as the app runs', async () => {
        const answers = [() => refused(404, 'not_found', 'There is no such folder')];
        const calls: string[] = [];
        const files = new HttpFileSystem({
            target: () => TARGET,
            fetch: (async (input: RequestInfo | URL) => {
                calls.push(String(input));

                return answers.shift()?.() ?? new Response(null, { status: 500 });
            }) as typeof fetch,
            route: ROUTE,
            folderId: 'gone',
            sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
        });
        const stop = files.watch(() => undefined);

        await new Promise(resolve => setTimeout(resolve, 30));
        stop();

        expect(calls).toHaveLength(1);
    });
});

describe('HttpFileSystem over a worktree', () => {
    const ok = () => json({ ok: true });
    const stream = () => new Response(new ReadableStream({ start: controller => controller.close() }), { headers: { 'content-type': 'text/event-stream' } });

    it('names the worktree beside the folder in the address of a read, a write and the lists', async () => {
        const { calls, files } = systemOf('wks 1', json([]), json([]), new Response('hi', { headers: { [FS_VERSION_HEADER]: '1-1' } }), json({ version: '2-2' }));

        await files.list('app', 3);
        await files.findFiles('a');
        await files.read('a.txt');
        await files.write('a.txt', 'hi', { expectedVersion: '1-1' });

        expect(calls.map(call => [call.method, call.url.slice(TARGET.base.length)])).toEqual([
            ['GET', `${ ROUTE }/list?folderId=fld+1&workspaceId=wks+1&path=app&depth=3`],
            ['GET', `${ ROUTE }/find?folderId=fld+1&workspaceId=wks+1&query=a`],
            ['GET', `${ ROUTE }/file?folderId=fld+1&workspaceId=wks+1&path=a.txt`],
            ['PUT', `${ ROUTE }/file?folderId=fld+1&workspaceId=wks+1&path=a.txt`],
        ]);
    });

    it('names the worktree in the body of a folder, a move, a copy, a delete and a search', async () => {
        const { calls, files } = systemOf('wks_1', ok, ok, ok, ok, json({ files: [], truncated: false }));

        await files.createDirectory('docs/new');
        await files.move([{ from: 'a', to: 'b' }]);
        await files.copy([{ from: 'a', to: 'c' }]);
        await files.delete(['x']);
        await files.search!({ query: 'needle', matchCase: false, wholeWord: false }, new AbortController().signal);

        expect(calls.map(call => [call.url.slice(TARGET.base.length), (JSON.parse(call.body as string) as Record<string, unknown>).workspaceId, (JSON.parse(call.body as string) as Record<string, unknown>).folderId])).toEqual([
            [`${ ROUTE }/folder`, 'wks_1', 'fld 1'],
            [`${ ROUTE }/move`, 'wks_1', 'fld 1'],
            [`${ ROUTE }/copy`, 'wks_1', 'fld 1'],
            [`${ ROUTE }/delete`, 'wks_1', 'fld 1'],
            [`${ ROUTE }/search`, 'wks_1', 'fld 1'],
        ]);
    });

    it('watches the worktree, not the folder', async () => {
        const { calls, files } = systemOf('wks_1', stream());
        const done = new Promise<void>((resolve) => {
            const stop = files.watch(() => {
                stop();
                resolve();
            });
        });

        await done;

        expect(calls[0]!.url).toBe(`${ TARGET.base }${ ROUTE }/watch?folderId=fld+1&workspaceId=wks_1`);
    });

    it('sends no workspace for the folder\'s own checkout', async () => {
        const { calls, files } = system(json([]), ok);

        await files.list('');
        await files.createDirectory('d');

        expect(calls[0]!.url).not.toContain('workspaceId');
        expect(calls[1]!.body).toBe(JSON.stringify({ folderId: 'fld 1', path: 'd' }));
    });
});
