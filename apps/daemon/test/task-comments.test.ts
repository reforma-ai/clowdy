import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { insertTaskComment } from '../src/db/taskComments';
import { taskCommentsPage } from '../src/domain/taskComments';
import { cleanTempDirs, startHarness } from './helpers';

import type { Task, TaskComment } from '@clowdy/protocol';
import type { Harness } from './helpers';

afterAll(cleanTempDirs);

let h: Harness;

beforeEach(async () => {
    h = await startHarness();
});

afterEach(async () => {
    await h.stop();
});

const failure = (result: ReturnType<Harness['send']>) => {
    if (result.ok) {
        throw new Error('expected a failure');
    }

    return result.error;
};

const rows = (table: string) => (h.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function setup() {
    const project = h.openRepo();
    const create = (title: string, extra: Record<string, unknown> = {}): Task =>
        h.ok('task.create', { projectId: project.id, title, ...extra }).task;
    const add = (taskId: string, body: string): TaskComment => h.ok('task.comment.add', { taskId, body }).comment;
    const page = async (taskId: string, query = '') =>
        (await h.fetch(`/v1/tasks/${taskId}/comments${query}`)).json() as Promise<{
            comments: TaskComment[];
            total: number;
            nextCursor?: string;
        }>;

    return { project, create, add, page };
}

describe('task.comment.add', () => {
    test('adds a comment written by the person, answers it, and announces it', () => {
        const { create } = setup();
        const task = create('Epic');
        const cursor = h.store.headCursor();
        const before = Date.now();
        const { comment } = h.ok('task.comment.add', { taskId: task.id, body: '**Found it**\n\n- the cache key' });

        expect(comment).toEqual({
            id: expect.stringMatching(/^cmt_/),
            taskId: task.id,
            author: { kind: 'user' },
            body: '**Found it**\n\n- the cache key',
            createdAt: expect.any(Number),
        });
        expect(comment.createdAt).toBeGreaterThanOrEqual(before);
        expect(comment).not.toHaveProperty('editedAt');
        expect(h.events(cursor).map(event => event.data)).toEqual([{ type: 'task.comment.upserted', comment }]);
        expect(h.events(cursor)[0].projectId).toBe(task.projectId);
    });

    test('keeps the Markdown as written, less the whitespace at its end', () => {
        const { create, add } = setup();
        const task = create('Epic');

        expect(add(task.id, '    indented first line\n\nsecond\n\n  \n').body).toBe(
            '    indented first line\n\nsecond'
        );
    });

    test('refuses a body with nothing in it, a task that does not exist, and a repeat of the request does not add a second comment', () => {
        const { create } = setup();
        const task = create('Epic');
        const cursor = h.store.headCursor();

        expect(failure(h.send('task.comment.add', { taskId: task.id, body: '' }))).toEqual({
            code: 'invalid',
            message: 'A comment cannot be empty',
        });
        expect(failure(h.send('task.comment.add', { taskId: task.id, body: ' \n\t ' })).code).toBe('invalid');
        expect(failure(h.send('task.comment.add', { taskId: 'tsk_nope', body: 'x' })).code).toBe('not_found');
        expect(h.store.headCursor()).toBe(cursor);
        expect(rows('task_comments')).toBe(0);

        const first = h.send('task.comment.add', { requestId: 'req-comment-once', taskId: task.id, body: 'Once' });

        expect(h.send('task.comment.add', { requestId: 'req-comment-once', taskId: task.id, body: 'Twice' })).toEqual(
            first
        );
        expect(rows('task_comments')).toBe(1);
    });
});

describe('task.comment.edit', () => {
    test('replaces the body, stamps editedAt, keeps the author and the time written, and announces the comment', () => {
        const { create, add } = setup();
        const task = create('Epic');
        const written = add(task.id, 'First draft');
        const cursor = h.store.headCursor();
        const before = Date.now();
        const { comment } = h.ok('task.comment.edit', {
            taskId: task.id,
            commentId: written.id,
            body: 'Second draft\n',
        });

        expect(comment).toEqual({ ...written, body: 'Second draft', editedAt: expect.any(Number) });
        expect(comment.editedAt).toBeGreaterThanOrEqual(before);
        expect(h.events(cursor).map(event => event.data)).toEqual([{ type: 'task.comment.upserted', comment }]);
        expect(taskCommentsPage(h.store, task.id).comments).toEqual([comment]);
    });

    test('the same body is no edit: nothing is stamped and nothing is announced', () => {
        const { create, add } = setup();
        const task = create('Epic');
        const written = add(task.id, 'Same');
        const cursor = h.store.headCursor();

        expect(h.ok('task.comment.edit', { taskId: task.id, commentId: written.id, body: 'Same\n\n' }).comment).toEqual(
            written
        );
        expect(h.store.headCursor()).toBe(cursor);
    });

    test('refuses an empty body and keeps the old one, a comment the task does not have, and a task that does not exist', () => {
        const { create, add } = setup();
        const [task, other] = [create('Epic'), create('Other')];
        const written = add(task.id, 'Keep me');
        const cursor = h.store.headCursor();

        expect(failure(h.send('task.comment.edit', { taskId: task.id, commentId: written.id, body: '  ' })).code).toBe(
            'invalid'
        );
        expect(failure(h.send('task.comment.edit', { taskId: task.id, commentId: 'cmt_nope', body: 'x' })).code).toBe(
            'not_found'
        );
        expect(failure(h.send('task.comment.edit', { taskId: other.id, commentId: written.id, body: 'x' })).code).toBe(
            'not_found'
        );
        expect(
            failure(h.send('task.comment.edit', { taskId: 'tsk_nope', commentId: written.id, body: 'x' })).code
        ).toBe('not_found');
        expect(h.store.headCursor()).toBe(cursor);
        expect(taskCommentsPage(h.store, task.id).comments).toEqual([written]);
    });
});

describe('task.comment.delete', () => {
    test('removes the comment, answers its ids, and announces the deletion; the others stay', () => {
        const { create, add } = setup();
        const task = create('Epic');
        const [first, second] = [add(task.id, 'One'), add(task.id, 'Two')];
        const cursor = h.store.headCursor();

        expect(h.ok('task.comment.delete', { taskId: task.id, commentId: first.id })).toEqual({
            taskId: task.id,
            commentId: first.id,
        });
        expect(h.events(cursor).map(event => event.data)).toEqual([
            { type: 'task.comment.deleted', taskId: task.id, commentId: first.id },
        ]);
        expect(taskCommentsPage(h.store, task.id)).toMatchObject({ comments: [second], total: 1 });
    });

    test('refuses a comment that is gone, one of another task, and a task that does not exist', () => {
        const { create, add } = setup();
        const [task, other] = [create('Epic'), create('Other')];
        const written = add(task.id, 'One');

        expect(failure(h.send('task.comment.delete', { taskId: other.id, commentId: written.id })).code).toBe(
            'not_found'
        );
        expect(failure(h.send('task.comment.delete', { taskId: 'tsk_nope', commentId: written.id })).code).toBe(
            'not_found'
        );
        h.ok('task.comment.delete', { taskId: task.id, commentId: written.id });
        expect(failure(h.send('task.comment.delete', { taskId: task.id, commentId: written.id })).code).toBe(
            'not_found'
        );
    });
});

describe("a task's comments, paged", () => {
    test('come oldest first in pages of the size asked for, and the cursor of one page leads to the next', () => {
        const { create, add } = setup();
        const task = create('Epic');
        const bodies = Array.from({ length: 7 }, (_, index) => `Comment ${index + 1}`);

        for (const body of bodies) {
            add(task.id, body);
        }

        const first = taskCommentsPage(h.store, task.id, { limit: 3 });

        expect(first).toMatchObject({ total: 7, shown: 3 });
        expect(typeof first.nextCursor).toBe('string');
        expect(first.comments.map(comment => comment.body)).toEqual(bodies.slice(0, 3));

        const second = taskCommentsPage(h.store, task.id, { limit: 3, cursor: first.nextCursor });

        expect(second.comments.map(comment => comment.body)).toEqual(bodies.slice(3, 6));
        expect(second.nextCursor).toBeDefined();

        const last = taskCommentsPage(h.store, task.id, { limit: 3, cursor: second.nextCursor });

        expect(last).toMatchObject({ total: 7, shown: 1 });
        expect(last.comments.map(comment => comment.body)).toEqual(['Comment 7']);
        expect(last).not.toHaveProperty('nextCursor');

        // A page that ends exactly with the comments has no cursor either.
        expect(taskCommentsPage(h.store, task.id, { limit: 7 })).not.toHaveProperty('nextCursor');
        expect(taskCommentsPage(h.store, task.id)).toMatchObject({ total: 7, shown: 7 });
    });

    test('the limit is 25 by default and at most 100, and a task with no comments has an empty page', () => {
        const { create } = setup();
        const task = create('Epic');
        const empty = taskCommentsPage(h.store, task.id);

        expect(empty).toEqual({ comments: [], total: 0, shown: 0 });

        for (let index = 0; index < 130; index++) {
            insertTaskComment(h.store.db, {
                id: `cmt_${String(index).padStart(26, '0')}`,
                taskId: task.id,
                author: { kind: 'user' },
                body: `c${index}`,
                createdAt: 1000 + index,
            });
        }

        expect(taskCommentsPage(h.store, task.id)).toMatchObject({ total: 130, shown: 25 });
        expect(taskCommentsPage(h.store, task.id, { limit: 500 })).toMatchObject({ total: 130, shown: 100 });
        expect(taskCommentsPage(h.store, task.id, { limit: 0 })).toMatchObject({ shown: 1 });
    });

    test('comments written in the same millisecond keep their order across a page boundary, none repeated or skipped', () => {
        const { create } = setup();
        const task = create('Epic');
        const ids = [
            'cmt_0000000000000000000000000A',
            'cmt_0000000000000000000000000B',
            'cmt_0000000000000000000000000C',
            'cmt_0000000000000000000000000D',
            'cmt_0000000000000000000000000E',
        ];

        // Inserted out of order: the order is the time, then the id.
        for (const id of [...ids].reverse()) {
            insertTaskComment(h.store.db, {
                id,
                taskId: task.id,
                author: { kind: 'user' },
                body: id.slice(-1),
                createdAt: 5000,
            });
        }

        const seen: string[] = [];
        let cursor: string | undefined;

        do {
            const page = taskCommentsPage(h.store, task.id, { limit: 2, cursor });

            seen.push(...page.comments.map(comment => comment.id));
            cursor = page.nextCursor;
        } while (cursor);

        expect(seen).toEqual(ids);
    });

    test('a comment deleted or added between two pages neither repeats nor shifts the rest', () => {
        const { create, add } = setup();
        const task = create('Epic');
        const written = ['A', 'B', 'C', 'D', 'E'].map(body => add(task.id, body));
        const first = taskCommentsPage(h.store, task.id, { limit: 2 });

        // The comment the cursor stands on goes, and a new one arrives at the end.
        h.ok('task.comment.delete', { taskId: task.id, commentId: written[1].id });
        add(task.id, 'F');

        const rest = taskCommentsPage(h.store, task.id, { limit: 10, cursor: first.nextCursor });

        expect(rest.comments.map(comment => comment.body)).toEqual(['C', 'D', 'E', 'F']);
        expect(rest.total).toBe(5);
    });

    test('a cursor that is not one is refused with what to do, and a task that does not exist is not_found', () => {
        const { create } = setup();
        const task = create('Epic');

        expect(() => taskCommentsPage(h.store, task.id, { cursor: 'abc' })).toThrow(
            '"abc" is not a cursor: pass the nextCursor of the previous page unchanged'
        );
        expect(() => taskCommentsPage(h.store, task.id, { cursor: '12.tsk_nope' })).toThrow('is not a cursor');
        expect(() => taskCommentsPage(h.store, 'tsk_nope')).toThrow('does not exist');
    });

    test("are another task's own: a page holds only the comments of its task", () => {
        const { create, add } = setup();
        const [task, other] = [create('Epic'), create('Other')];

        add(task.id, 'Mine');
        add(other.id, 'Theirs');
        expect(taskCommentsPage(h.store, task.id)).toMatchObject({ total: 1, comments: [{ body: 'Mine' }] });
        expect(taskCommentsPage(h.store, other.id)).toMatchObject({ total: 1, comments: [{ body: 'Theirs' }] });
    });
});

describe('GET /v1/tasks/:id/comments', () => {
    test('answers the page oldest first with total and nextCursor, takes limit and cursor, and the last page has no cursor', async () => {
        const { create, add, page } = setup();
        const task = create('Epic');
        const written = ['One', 'Two', 'Three'].map(body => add(task.id, body));

        const everything = await page(task.id);

        expect(everything).toEqual({ comments: written, total: 3 });

        const first = await page(task.id, '?limit=2');

        expect(first).toEqual({
            comments: written.slice(0, 2),
            total: 3,
            nextCursor: `${written[1].createdAt}.${written[1].id}`,
        });

        const rest = await page(task.id, `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`);

        expect(rest).toEqual({ comments: written.slice(2), total: 3 });
        expect(await page(task.id, '?limit=500')).toMatchObject({ total: 3 });
    });

    test('is a page of comments only: an edit shows in it, a deleted comment does not, and the project snapshot carries none', async () => {
        const { project, create, add, page } = setup();
        const task = create('Epic');
        const [one, two] = [add(task.id, 'One'), add(task.id, 'Two')];

        h.ok('task.comment.edit', { taskId: task.id, commentId: one.id, body: 'One, edited' });
        h.ok('task.comment.delete', { taskId: task.id, commentId: two.id });

        expect((await page(task.id)).comments).toEqual([{ ...one, body: 'One, edited', editedAt: expect.any(Number) }]);

        const snapshot = await (await h.fetch(`/v1/projects/${project.id}/snapshot`)).json();

        expect(JSON.stringify(snapshot)).not.toContain('One, edited');
        expect(snapshot).not.toHaveProperty('comments');
    });

    test('refuses a limit that is not a whole number and a cursor that is not one with 400, and a task that does not exist with 404', async () => {
        const { create } = setup();
        const task = create('Epic');

        expect((await h.fetch(`/v1/tasks/${task.id}/comments?limit=ten`)).status).toBe(400);
        expect((await h.fetch(`/v1/tasks/${task.id}/comments?limit=-1`)).status).toBe(400);
        expect((await h.fetch(`/v1/tasks/${task.id}/comments?cursor=nope`)).status).toBe(400);
        expect((await h.fetch('/v1/tasks/tsk_nope/comments')).status).toBe(404);
        expect((await fetch(`${h.url}/v1/tasks/${task.id}/comments`)).status).toBe(401);
    });
});

describe('a task that goes', () => {
    test('takes its comments along, and the events say only that the task is gone', () => {
        const { create, add } = setup();
        const [task, other] = [create('Epic'), create('Other')];

        add(task.id, 'One');
        add(task.id, 'Two');
        add(other.id, 'Stays');

        const cursor = h.store.headCursor();

        h.ok('task.delete', { taskId: task.id });

        expect(h.events(cursor).map(event => event.data)).toEqual([{ type: 'task.deleted', taskId: task.id }]);
        expect(rows('task_comments')).toBe(1);
        expect(taskCommentsPage(h.store, other.id).total).toBe(1);
        expect(failure(h.send('task.comment.add', { taskId: task.id, body: 'late' })).code).toBe('not_found');
    });

    test('a task inside it keeps its own comments when it moves up', () => {
        const { create, add } = setup();
        const epic = create('Epic');
        const stage = create('Stage', { parentId: epic.id });

        add(epic.id, 'On the epic');
        add(stage.id, 'On the stage');
        h.ok('task.delete', { taskId: epic.id });
        expect(taskCommentsPage(h.store, stage.id)).toMatchObject({ total: 1, comments: [{ body: 'On the stage' }] });
        expect(rows('task_comments')).toBe(1);
    });

    test('a project that goes takes the comments of all its tasks', async () => {
        const { project, create, add } = setup();

        add(create('One').id, 'x');
        add(create('Two').id, 'y');
        expect(rows('task_comments')).toBe(2);
        h.ok('project.delete', { projectId: project.id });
        expect(rows('task_comments')).toBe(0);
    });
});
