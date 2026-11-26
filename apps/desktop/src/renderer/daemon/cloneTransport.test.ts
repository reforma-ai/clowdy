import { describe, expect, it, vi } from 'vitest';

import { createTransport, resolveDaemonConfig } from './config';
import { cloneName, FIXTURE_PROJECTS_FOLDER, FixtureGitClone } from './fixtureGitClone';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { TransportError } from './transport';

import type { GitCloneRequest } from '@clowdy/protocol';

const REQUEST: GitCloneRequest = { url: 'https://github.com/acme/api.git', path: '/Users/dev/code/api' };
const encoder = new TextEncoder();
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

describe('HttpTransport.getGitCloneTarget', () => {
    it('asks with the address and the folder in the query, and leaves the folder out when none was chosen', async () => {
        const urls: string[] = [];
        const fetchImpl = (async (input: RequestInfo | URL) => {
            urls.push(String(input));

            return Response.json({ folder: '/Users/dev/Clowdy/Projects' });
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310/', token: 't', fetch: fetchImpl });

        expect(await transport.getGitCloneTarget('git@github.com:acme/api.git')).toEqual({
            folder: '/Users/dev/Clowdy/Projects',
        });
        await transport.getGitCloneTarget('', '/Users/dev/my code');

        expect(urls).toEqual([
            'http://127.0.0.1:4310/v1/git/clone-target?url=git%40github.com%3Aacme%2Fapi.git',
            'http://127.0.0.1:4310/v1/git/clone-target?url=&folder=%2FUsers%2Fdev%2Fmy+code',
        ]);
    });

    it('hands the signal to the request, so an answer that is no longer wanted can be dropped', async () => {
        const signals: Array<AbortSignal | null | undefined> = [];
        const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
            signals.push(init.signal);

            return Response.json({ folder: '/x' });
        }) as typeof fetch;
        const controller = new AbortController();

        await new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl }).getGitCloneTarget(
            'u',
            undefined,
            controller.signal
        );

        expect(signals[0]).toBe(controller.signal);
    });

    it("rejects with the daemon's reason", async () => {
        const fetchImpl = (async () =>
            Response.json(
                { error: { code: 'unavailable', message: 'No projects folder' } },
                { status: 503 }
            )) as typeof fetch;

        await expect(
            new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl }).getGitCloneTarget('u')
        ).rejects.toMatchObject({ message: 'No projects folder', status: 503 });
    });
});

describe('HttpTransport.cloneGit', () => {
    it("streams git's progress, sends the address and the path, and resolves the folder it made", async () => {
        const progress = vi.fn();
        const sent: Array<{ url: string; init: RequestInit }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
            sent.push({ url: String(input), init });

            return new Response(
                new ReadableStream({
                    start(controller) {
                        // A frame may arrive in two pieces.
                        controller.enqueue(encoder.encode('data: {"type":"progress","label":"Receiving obj'));
                        controller.enqueue(encoder.encode('ects","percent":42}\n\n'));
                        controller.enqueue(encoder.encode(frame({ type: 'progress', label: 'Resolving deltas' })));
                        controller.enqueue(encoder.encode(frame({ type: 'result', path: REQUEST.path })));
                        controller.close();
                    },
                })
            );
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://127.0.0.1:4310', token: 'secret', fetch: fetchImpl });

        await expect(transport.cloneGit(REQUEST, progress)).resolves.toBe(REQUEST.path);

        expect(progress.mock.calls).toEqual([
            [{ label: 'Receiving objects', percent: 42 }],
            [{ label: 'Resolving deltas' }],
        ]);
        expect(sent[0].url).toBe('http://127.0.0.1:4310/v1/git/clone');
        expect(sent[0].init).toMatchObject({ method: 'POST', body: JSON.stringify(REQUEST) });
        expect(sent[0].init.headers).toMatchObject({ authorization: 'Bearer secret', accept: 'text/event-stream' });
    });

    it('distinguishes a clone that failed from a stream that never said how it ended', async () => {
        const connect = (body: string) =>
            new HttpTransport({ url: 'http://d', token: 't', fetch: async () => new Response(body) });

        await expect(
            connect(
                frame({
                    type: 'error',
                    status: 409,
                    message: "fatal: repository 'x' not found",
                    hint: 'Check the address',
                })
            ).cloneGit(REQUEST)
        ).rejects.toMatchObject({ status: 409, message: "fatal: repository 'x' not found", hint: 'Check the address' });
        await expect(
            connect(frame({ type: 'progress', label: 'Receiving objects' })).cloneGit(REQUEST)
        ).rejects.toMatchObject({ status: 503, message: "Couldn't confirm that the clone finished" });
    });

    it('rejects with the reason of a request the daemon refused before it began', async () => {
        const transport = new HttpTransport({
            url: 'http://d',
            token: 't',
            fetch: async () =>
                Response.json({ error: { code: 'invalid', message: 'The folder is not empty' } }, { status: 400 }),
        });

        await expect(transport.cloneGit(REQUEST)).rejects.toMatchObject({
            message: 'The folder is not empty',
            status: 400,
        });
    });

    it("gives the signal to the request, and rejects with the signal's reason when it aborts mid-stream", async () => {
        let given: AbortSignal | null | undefined;
        const fetchImpl = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
            given = init.signal;

            // As a real response body does: the stream errors with the reason once its request is aborted.
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            encoder.encode(frame({ type: 'progress', label: 'Receiving objects', percent: 3 }))
                        );
                        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                            once: true,
                        });
                    },
                })
            );
        }) as typeof fetch;
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });
        const controller = new AbortController();
        const progress = vi.fn();
        const request = transport.cloneGit(REQUEST, progress, controller.signal);
        const outcome = request.catch((error: unknown) => error);

        await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
        controller.abort();

        expect(given).toBe(controller.signal);
        expect(await outcome).toBe(controller.signal.reason);
    });
});

describe('cloneName', () => {
    it('is the last part of the address without .git, for every form the daemon takes', () => {
        expect(cloneName('https://github.com/acme/api.git')).toBe('api');
        expect(cloneName('  https://github.com/acme/api/ ')).toBe('api');
        expect(cloneName('git@github.com:acme/api.git')).toBe('api');
        expect(cloneName('ssh://git@host:2222/srv/git/api')).toBe('api');
        expect(cloneName('/srv/git/api.git')).toBe('api');
    });

    it('is nothing for an address the daemon does not take, or one that names no repository', () => {
        expect(cloneName('')).toBeUndefined();
        expect(cloneName('   ')).toBeUndefined();
        expect(cloneName('api')).toBeUndefined();
        // The `owner/repo` shorthand needs a host guess, so it is not taken.
        expect(cloneName('acme/api')).toBeUndefined();
        expect(cloneName('https://')).toBeUndefined();
        expect(cloneName('https://github.com')).toBeUndefined();
        expect(cloneName('--upload-pack=x')).toBeUndefined();
    });
});

describe('FixtureTransport clone', () => {
    const target = (url: string, folder?: string) => new FixtureGitClone().target(url, folder);

    it('uses the projects folder when none was chosen, and always puts the repository in a folder of its own inside it', () => {
        expect(target('https://github.com/acme/api.git')).toEqual({
            folder: FIXTURE_PROJECTS_FOLDER,
            path: `${FIXTURE_PROJECTS_FOLDER}/api`,
        });
        // An address with no repository in it still says where the folder is.
        expect(target('')).toEqual({ folder: FIXTURE_PROJECTS_FOLDER });
    });

    it('makes the chosen folder the repository when it is missing or empty, and puts a folder inside it when it holds anything', () => {
        expect(target('https://github.com/acme/clowdy.git', '/Users/dev/empty')).toEqual({
            folder: '/Users/dev/empty',
            path: '/Users/dev/empty',
        });
        expect(target('https://github.com/acme/clowdy.git', '/Users/dev/not/there/yet/')).toEqual({
            folder: '/Users/dev/not/there/yet',
            path: '/Users/dev/not/there/yet',
        });
        expect(target('https://github.com/acme/clowdy.git', '/Users/dev/code')).toEqual({
            folder: '/Users/dev/code',
            path: '/Users/dev/code/clowdy',
        });
    });

    it('refuses a target that exists and is not an empty folder, and a chosen folder that is a file', () => {
        expect(target('https://github.com/acme/notes.git', '/Users/dev/code')).toMatchObject({
            path: '/Users/dev/code/notes',
            blocked: '/Users/dev/code/notes already exists and is not an empty folder',
        });
        expect(target('https://github.com/acme/car-rental.git')).toMatchObject({
            blocked: `${FIXTURE_PROJECTS_FOLDER}/car-rental already exists and is not an empty folder`,
        });
        // The daemon names the folder as the path too when the address names a repository, and only refuses when it does not.
        expect(target('https://github.com/acme/x.git', '/Users/dev/notes.txt')).toEqual({
            folder: '/Users/dev/notes.txt',
            path: '/Users/dev/notes.txt',
            blocked: '/Users/dev/notes.txt is a file, not a folder',
        });
        expect(target('', '/Users/dev/notes.txt')).toEqual({
            folder: '/Users/dev/notes.txt',
            blocked: '/Users/dev/notes.txt is a file, not a folder',
        });
    });

    it('goes through with progress, ends with the folder it made, and leaves it on the fake disk', async () => {
        vi.useFakeTimers();

        try {
            const transport = new FixtureTransport();
            const progress = vi.fn();
            const request = transport.cloneGit(
                { url: 'https://github.com/acme/clowdy.git', path: '/Users/dev/empty' },
                progress
            );

            await vi.runAllTimersAsync();

            await expect(request).resolves.toBe('/Users/dev/empty');
            expect(progress.mock.calls.map(([line]) => line.label)).toContain('Receiving objects');
            expect(progress.mock.calls.at(-1)![0]).toEqual({ label: 'Resolving deltas', percent: 100 });
            // The folder now has files, so the same address goes inside it and the same target is refused.
            expect(await transport.getGitCloneTarget('https://github.com/acme/clowdy.git', '/Users/dev/empty')).toEqual(
                {
                    folder: '/Users/dev/empty',
                    path: '/Users/dev/empty/clowdy',
                }
            );
            await expect(
                transport.cloneGit({ url: 'https://github.com/acme/clowdy.git', path: '/Users/dev/empty' })
            ).rejects.toMatchObject({ status: 409 });
        } finally {
            vi.useRealTimers();
        }
    });

    it("ends as the page's switch says: `failed` stops with git's line and a hint, `slow` waits for the cancel", async () => {
        vi.useFakeTimers();

        try {
            const failed = new FixtureTransport({ clone: 'failed' }).cloneGit(REQUEST);
            const caught = failed.catch((error: unknown) => error);

            await vi.runAllTimersAsync();
            expect(await caught).toBeInstanceOf(TransportError);
            expect(await caught).toMatchObject({
                message: expect.stringContaining('not found'),
                hint: expect.any(String),
            });

            const controller = new AbortController();
            const progress = vi.fn();
            const slow = new FixtureTransport({ clone: 'slow' }).cloneGit(REQUEST, progress, controller.signal);
            const cancelled = slow.catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(5000);
            expect(progress).toHaveBeenLastCalledWith({ label: 'Receiving objects', percent: 42 });

            controller.abort();
            expect(await cancelled).toBe(controller.signal.reason);
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops a target request whose signal is already aborted', async () => {
        const controller = new AbortController();

        controller.abort();

        await expect(new FixtureTransport().getGitCloneTarget('u', undefined, controller.signal)).rejects.toBe(
            controller.signal.reason
        );
    });
});

describe('the page switch for a clone', () => {
    it('takes slow and failed, and leaves any other word out', () => {
        expect(resolveDaemonConfig('?fixtures=static&clone=slow')).toEqual({
            kind: 'fixtures',
            timeline: false,
            clone: 'slow',
        });
        expect(resolveDaemonConfig('?fixtures=static&clone=failed')).toMatchObject({ clone: 'failed' });
        expect(resolveDaemonConfig('?fixtures=static&clone=ok')).toEqual({ kind: 'fixtures', timeline: false });
    });

    it('is carried to the fixture transport', async () => {
        const transport = createTransport({ kind: 'fixtures', timeline: false, clone: 'failed' });
        const caught = transport.cloneGit(REQUEST).catch((error: unknown) => error);

        expect(await caught).toMatchObject({ status: 409 });
    }, 10_000);
});
