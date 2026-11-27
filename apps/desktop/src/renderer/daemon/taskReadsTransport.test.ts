import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '@clowdy/protocol';
import { describe, expect, it } from 'vitest';

import { FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from './fixtureData';
import { FixtureTransport } from './fixtureTransport';
import { HttpTransport } from './httpTransport';
import { overrideTransport } from './testing';

import type { TaskArchivePage, TaskCommentsPage } from '@clowdy/protocol';

type Call = { url: string; init: RequestInit };

function scripted(answer: (call: Call) => Response) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const call = { url: String(input), init };

        calls.push(call);

        return answer(call);
    }) as typeof fetch;

    return { fetchImpl, calls };
}

const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('HttpTransport.getTaskComments', () => {
    it("reads the first page from the task's route, with the token and the protocol version", async () => {
        const page: TaskCommentsPage = { comments: [], total: 0 };
        const { fetchImpl, calls } = scripted(() => json(page));
        const transport = new HttpTransport({ url: 'http://d/', token: 'secret', fetch: fetchImpl });

        expect(await transport.getTaskComments('t 1')).toEqual(page);
        expect(calls[0].url).toBe('http://d/v1/tasks/t%201/comments');
        expect(calls[0].init.headers).toMatchObject({
            authorization: 'Bearer secret',
            [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        });
    });

    it('passes the size and the cursor of the page before, and leaves out what it is not given', async () => {
        const { fetchImpl, calls } = scripted(() => json({ comments: [], total: 0 }));
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

        await transport.getTaskComments('t1', { limit: 10 });
        await transport.getTaskComments('t1', { cursor: '1700000000000.cmt_01AB' });
        await transport.getTaskComments('t1', { limit: 50, cursor: '1.cmt_X' });
        await transport.getTaskComments('t1', {});

        expect(calls.map(call => call.url)).toEqual([
            'http://d/v1/tasks/t1/comments?limit=10',
            'http://d/v1/tasks/t1/comments?cursor=1700000000000.cmt_01AB',
            'http://d/v1/tasks/t1/comments?limit=50&cursor=1.cmt_X',
            'http://d/v1/tasks/t1/comments',
        ]);
    });

    it('throws a TransportError with the status when the daemon refuses: no such task, a cursor it does not know, a wrong token', async () => {
        for (const status of [404, 400, 401]) {
            const { fetchImpl } = scripted(() => json({ error: { message: 'No' } }, status));
            const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

            await expect(transport.getTaskComments('t1', { cursor: 'x' })).rejects.toMatchObject({
                name: 'TransportError',
                status,
            });
        }
    });
});

describe('HttpTransport.getArchivedTasks', () => {
    it('reads the archive of the project, with the same page parameters', async () => {
        const page: TaskArchivePage = { tasks: [], total: 0 };
        const { fetchImpl, calls } = scripted(() => json(page));
        const transport = new HttpTransport({ url: 'http://d', token: 'secret', fetch: fetchImpl });

        expect(await transport.getArchivedTasks('p/1')).toEqual(page);
        await transport.getArchivedTasks('p1', { limit: 5, cursor: '9000.3' });

        expect(calls.map(call => call.url)).toEqual([
            'http://d/v1/projects/p%2F1/archived-tasks',
            'http://d/v1/projects/p1/archived-tasks?limit=5&cursor=9000.3',
        ]);
        expect(calls[0].init.headers).toMatchObject({ authorization: 'Bearer secret' });
    });

    it('throws a TransportError with the status when the daemon refuses', async () => {
        const { fetchImpl } = scripted(() => json({}, 404));
        const transport = new HttpTransport({ url: 'http://d', token: 't', fetch: fetchImpl });

        await expect(transport.getArchivedTasks('p1')).rejects.toMatchObject({ name: 'TransportError', status: 404 });
    });
});

describe('FixtureTransport.getTaskComments', () => {
    it('lists the comments of a task oldest first, with the count', async () => {
        const page = await new FixtureTransport().getTaskComments('t-32');

        expect(page.total).toBe(3);
        expect(page.comments.map(comment => comment.id)).toEqual(['cmt_A001', 'cmt_A002', 'cmt_A003']);
        expect(page.comments.map(comment => comment.author.kind)).toEqual(['user', 'run', 'user']);
        expect(page.comments[2].editedAt).toBeDefined();
        expect(page.nextCursor).toBeUndefined();
    });

    it('answers an empty page for a task with no comments, and 404 for a task it does not have', async () => {
        const transport = new FixtureTransport();

        expect(await transport.getTaskComments('t-24')).toEqual({ comments: [], total: 0 });
        await expect(transport.getTaskComments('t-missing')).rejects.toMatchObject({
            name: 'TransportError',
            status: 404,
            message: 'Task t-missing does not exist',
        });
    });

    it('pages with the cursor the page before gave, and the last page has none', async () => {
        const transport = new FixtureTransport();
        const first = await transport.getTaskComments('t-32', { limit: 2 });

        expect(first.comments.map(comment => comment.id)).toEqual(['cmt_A001', 'cmt_A002']);
        expect(first.total).toBe(3);
        expect(first.nextCursor).toMatch(/^\d+\.cmt_A002$/);

        const second = await transport.getTaskComments('t-32', { limit: 2, cursor: first.nextCursor });

        expect(second.comments.map(comment => comment.id)).toEqual(['cmt_A003']);
        expect(second.nextCursor).toBeUndefined();
    });

    it("holds a limit to the daemon's 1 to 100, and refuses a cursor that is not one, and a limit that is not a whole number", async () => {
        const transport = new FixtureTransport();

        expect((await transport.getTaskComments('t-32', { limit: 0 })).comments).toHaveLength(1);
        expect((await transport.getTaskComments('t-32', { limit: 1000 })).comments).toHaveLength(3);
        await expect(transport.getTaskComments('t-32', { cursor: 'soon' })).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('is not a cursor'),
        });

        for (const limit of [-1, 2.5, Number.NaN]) {
            await expect(transport.getTaskComments('t-32', { limit })).rejects.toMatchObject({
                status: 400,
                message: 'limit must be a non-negative integer',
            });
        }
    });

    it('hands out copies', async () => {
        const transport = new FixtureTransport();
        const page = await transport.getTaskComments('t-32');

        page.comments[0].body = 'Changed';

        expect((await transport.getTaskComments('t-32')).comments[0].body).not.toBe('Changed');
    });
});

describe('FixtureTransport.getArchivedTasks', () => {
    it('lists the archived tasks of the project, a batch by number, with the count', async () => {
        const page = await new FixtureTransport().getArchivedTasks(FIXTURE_PROJECT_ID);

        expect(page.tasks.map(task => task.number)).toEqual([38, 39, 40]);
        expect(page.total).toBe(3);
        expect(page.tasks.every(task => task.archivedAt !== undefined)).toBe(true);
        expect(new Set(page.tasks.map(task => task.archivedAt)).size).toBe(1);
        expect(page.nextCursor).toBeUndefined();
    });

    it('answers an empty page for a project with no archive, and 404 for a project it does not have', async () => {
        const transport = new FixtureTransport();

        expect(await transport.getArchivedTasks(FIXTURE_EMPTY_PROJECT_ID)).toEqual({ tasks: [], total: 0 });
        await expect(transport.getArchivedTasks('p-missing')).rejects.toMatchObject({
            status: 404,
            message: 'Space p-missing does not exist',
        });
    });

    it('pages with the cursor, the latest batch first', async () => {
        const transport = new FixtureTransport();

        await transport.command({ type: 'task.archive', taskId: 't-21' });

        const first = await transport.getArchivedTasks(FIXTURE_PROJECT_ID, { limit: 2 });

        // The batch just archived is the newest.
        expect(first.tasks.map(task => task.number)).toEqual([21, 38]);
        expect(first.total).toBe(4);
        expect(first.nextCursor).toBe(`${first.tasks[1].archivedAt}.38`);

        const second = await transport.getArchivedTasks(FIXTURE_PROJECT_ID, { limit: 2, cursor: first.nextCursor });

        expect(second.tasks.map(task => task.number)).toEqual([39, 40]);
        expect(second.nextCursor).toBeUndefined();
        await expect(transport.getArchivedTasks(FIXTURE_PROJECT_ID, { cursor: '38' })).rejects.toMatchObject({
            status: 400,
        });
        await expect(transport.getArchivedTasks(FIXTURE_PROJECT_ID, { limit: -5 })).rejects.toMatchObject({
            status: 400,
            message: 'limit must be a non-negative integer',
        });
        expect((await transport.getArchivedTasks(FIXTURE_PROJECT_ID, { limit: 500 })).tasks).toHaveLength(4);
    });
});

describe('overrideTransport', () => {
    it('overrides the task reads like any other method, and passes the rest on', async () => {
        const base = new FixtureTransport();
        const transport = overrideTransport(base, { getTaskComments: () => Promise.reject(new Error('offline')) });

        await expect(transport.getTaskComments('t-32')).rejects.toThrow('offline');
        expect((await transport.getArchivedTasks(FIXTURE_PROJECT_ID)).total).toBe(3);
    });
});
