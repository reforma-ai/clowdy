// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RootStore, RootStoreProvider } from '../../stores';
import { FETCH_DELAY_MS } from './useTaskArtifacts';
import { COMMENTS_PAGE_SIZE, MAX_COMMENTS, REFRESH_DELAY_MS, useTaskComments } from './useTaskComments';

import type { TaskComment, TaskCommentsPage } from '@clowdy/protocol';
import type { PageQuery } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const comment = (index: number, taskId = 't-1'): TaskComment => ({
    id: `c-${taskId}-${index}`,
    taskId,
    author: { kind: 'user' },
    body: `Comment ${index}`,
    createdAt: index,
});

/** A daemon with `total` comments on a task, answering pages the way the route does: oldest first, `limit` at a time, a cursor that names the last one. */
function pagedDaemon(total: number) {
    const all = Array.from({ length: total }, (_, index) => comment(index + 1));

    return vi.fn(async (taskId: string, { limit = 25, cursor }: PageQuery = {}): Promise<TaskCommentsPage> => {
        const start = cursor === undefined ? 0 : Number(cursor);
        const page = all.slice(start, start + limit).map(found => ({ ...found, taskId }));
        const next = start + limit;

        return { comments: page, total, ...(next < total && { nextCursor: String(next) }) };
    });
}

let container: HTMLDivElement;
let root: Root;
let getTaskComments: ReturnType<typeof pagedDaemon>;
let revisions: Map<string, number>;
let latest: ReturnType<typeof useTaskComments>;

function Probe({ taskId }: { taskId: string }) {
    latest = useTaskComments(taskId);

    return null;
}

// One store for every render, as the app has: a transport that is a new object each time would be a reason to read again.
const store = {
    transport: { getTaskComments: (taskId: string, query?: PageQuery) => getTaskComments(taskId, query) },
    selectedProject: { commentsRevision: (id: string) => revisions.get(id) ?? 0 },
} as unknown as RootStore;

const render = (taskId: string) =>
    act(async () => {
        root.render(
            <RootStoreProvider value={store}>
                <Probe taskId={taskId} />
            </RootStoreProvider>
        );
    });

const advance = (ms: number) =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });

const readyComments = () => (latest.state.status === 'ready' ? latest.state.comments : []);
const refreshError = () => (latest.state.status === 'ready' ? latest.state.refreshError : undefined);

beforeEach(() => {
    vi.useFakeTimers();
    getTaskComments = pagedDaemon(3);
    revisions = new Map();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('useTaskComments', () => {
    it('waits the pause the artifacts wait, then reads the comments oldest first, a hundred at a time', async () => {
        await render('t-1');

        expect(latest.state).toEqual({ status: 'loading' });

        await advance(FETCH_DELAY_MS - 1);

        expect(getTaskComments).not.toHaveBeenCalled();

        await advance(1);

        expect(getTaskComments).toHaveBeenCalledExactlyOnceWith('t-1', {
            limit: COMMENTS_PAGE_SIZE,
            cursor: undefined,
        });
        expect(latest.state).toMatchObject({ status: 'ready', total: 3, isCut: false });
        expect(readyComments().map(found => found.body)).toEqual(['Comment 1', 'Comment 2', 'Comment 3']);
    });

    it('reads every page of a task with more than a hundred, in order, with the cursor of each', async () => {
        getTaskComments = pagedDaemon(250);

        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(getTaskComments.mock.calls.map(([, query]) => query)).toEqual([
            { limit: 100, cursor: undefined },
            { limit: 100, cursor: '100' },
            { limit: 100, cursor: '200' },
        ]);
        expect(latest.state).toMatchObject({ status: 'ready', total: 250, isCut: false });
        expect(readyComments().map(found => found.createdAt)).toEqual(
            Array.from({ length: 250 }, (_, index) => index + 1)
        );
    });

    it('stops at 1000 comments and says the task has more', async () => {
        getTaskComments = pagedDaemon(1200);

        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(getTaskComments).toHaveBeenCalledTimes(MAX_COMMENTS / COMMENTS_PAGE_SIZE);
        expect(readyComments()).toHaveLength(MAX_COMMENTS);
        expect(latest.state).toMatchObject({ status: 'ready', total: 1200, isCut: true });
    });

    it('does not call a task with exactly 1000 comments cut', async () => {
        getTaskComments = pagedDaemon(1000);

        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(readyComments()).toHaveLength(1000);
        expect(latest.state).toMatchObject({ total: 1000, isCut: false });
    });

    it('reads the comments again a moment after their revision changes, and keeps the old ones on show meanwhile', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        let answer: (page: TaskCommentsPage) => void = () => {};

        getTaskComments.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    answer = resolve;
                })
        );
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS - 1);

        expect(getTaskComments).toHaveBeenCalledTimes(1);
        expect(readyComments()).toHaveLength(3);

        await advance(1);

        expect(getTaskComments).toHaveBeenCalledTimes(2);
        expect(readyComments()).toHaveLength(3);

        await act(async () => answer({ comments: [comment(1), comment(2), comment(3), comment(4)], total: 4 }));

        expect(readyComments()).toHaveLength(4);
        expect(latest.state).toMatchObject({ total: 4 });
    });

    it('reads once for a burst of changes, a moment after the last of them', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        // A comment event for each comment of a task an agent is writing to.
        for (const revision of [1, 2, 3, 4]) {
            revisions.set('t-1', revision);
            await render('t-1');
            await advance(REFRESH_DELAY_MS - 50);
        }

        expect(getTaskComments).toHaveBeenCalledTimes(1);

        await advance(49);

        expect(getTaskComments).toHaveBeenCalledTimes(1);

        await advance(1);

        expect(getTaskComments).toHaveBeenCalledTimes(2);
        expect(readyComments()).toHaveLength(3);
    });

    it('does not show an answer to a read that a later change has replaced', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        let stale: (page: TaskCommentsPage) => void = () => {};

        getTaskComments.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    stale = resolve;
                })
        );
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);

        revisions.set('t-1', 2);
        await render('t-1');
        await act(async () => stale({ comments: [comment(1)], total: 1 }));

        expect(readyComments()).toHaveLength(3);

        await advance(REFRESH_DELAY_MS);

        expect(getTaskComments).toHaveBeenCalledTimes(3);
        expect(readyComments()).toHaveLength(3);
    });

    it('keeps the comments on show when a read for a change fails, and says why beside them', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);
        getTaskComments.mockRejectedValueOnce(new Error('The daemon cannot be reached'));
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);

        expect(latest.state).toMatchObject({ status: 'ready', total: 3, refreshError: 'The daemon cannot be reached' });
        expect(readyComments().map(found => found.body)).toEqual(['Comment 1', 'Comment 2', 'Comment 3']);
    });

    it('reads again on Retry after a failed refresh without taking the comments from the screen, and drops the failure at once', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);
        getTaskComments.mockRejectedValueOnce(new Error('The daemon cannot be reached'));
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);

        expect(refreshError()).toBe('The daemon cannot be reached');

        await act(async () => latest.retry());

        // Never the loader: the comments are still on show, and the line about the failure is gone while the read is on its way.
        expect(latest.state).toMatchObject({ status: 'ready', total: 3 });
        expect(refreshError()).toBeUndefined();

        await advance(REFRESH_DELAY_MS);

        expect(getTaskComments).toHaveBeenCalledTimes(3);
        expect(latest.state).toMatchObject({ status: 'ready', total: 3 });
        expect(refreshError()).toBeUndefined();
    });

    it('shows the failure again when the read after Retry fails too', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);
        getTaskComments.mockRejectedValueOnce(new Error('First'));
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);

        expect(refreshError()).toBe('First');

        getTaskComments.mockRejectedValueOnce(new Error('Second'));
        await act(async () => latest.retry());
        await advance(REFRESH_DELAY_MS);

        expect(latest.state).toMatchObject({ status: 'ready', refreshError: 'Second' });
        expect(readyComments()).toHaveLength(3);
    });

    it('clears the failure when the next change is read', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);
        getTaskComments.mockRejectedValueOnce(new Error('The daemon cannot be reached'));
        revisions.set('t-1', 1);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);
        revisions.set('t-1', 2);
        await render('t-1');
        await advance(REFRESH_DELAY_MS);

        expect(latest.state).toMatchObject({ status: 'ready', total: 3 });
        expect(refreshError()).toBeUndefined();
    });

    it('does not read again for the revision of another task', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        revisions.set('t-2', 5);
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(getTaskComments).toHaveBeenCalledTimes(1);
    });

    it('starts the pause again when the task changes, and shows no comments of the task before it meanwhile', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);
        await render('t-2');

        expect(latest.state).toEqual({ status: 'loading' });

        await advance(FETCH_DELAY_MS - 1);

        expect(getTaskComments).toHaveBeenCalledTimes(1);

        await advance(1);

        expect(getTaskComments).toHaveBeenLastCalledWith('t-2', { limit: COMMENTS_PAGE_SIZE, cursor: undefined });
        expect(readyComments().every(found => found.taskId === 't-2')).toBe(true);
    });

    it('drops an answer that comes after the task changed', async () => {
        let answer: (page: TaskCommentsPage) => void = () => {};

        getTaskComments.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    answer = resolve;
                })
        );

        await render('t-1');
        await advance(FETCH_DELAY_MS);
        await render('t-2');
        await act(async () => answer({ comments: [comment(9, 't-1')], total: 1 }));

        expect(latest.state).toEqual({ status: 'loading' });
    });

    it('stops reading pages once the task has changed', async () => {
        getTaskComments = pagedDaemon(500);

        let release: () => void = () => {};
        const first = getTaskComments.getMockImplementation()!;

        // The second page is slow: the person moves to another task while it is on its way.
        getTaskComments.mockImplementation(async (taskId, query) => {
            if (query?.cursor === '100') await new Promise<void>(resolve => void (release = resolve));

            return first(taskId, query);
        });

        await render('t-1');
        await advance(FETCH_DELAY_MS);
        await render('t-2');
        await act(async () => release());
        await advance(FETCH_DELAY_MS);

        const forFirst = getTaskComments.mock.calls.filter(([taskId]) => taskId === 't-1');

        // The pages after the slow one are not asked for.
        expect(forFirst).toHaveLength(2);
    });

    it('reports a failure, and reads again on retry after the pause', async () => {
        getTaskComments.mockRejectedValueOnce(new Error('The daemon cannot be reached'));

        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(latest.state).toEqual({ status: 'failed', message: 'The daemon cannot be reached' });

        await act(async () => latest.retry());

        expect(latest.state).toEqual({ status: 'loading' });

        await advance(FETCH_DELAY_MS);

        expect(latest.state.status).toBe('ready');
    });

    it('reads nothing for a panel that closed within the pause', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS - 1);
        act(() => root.render(null));
        await advance(FETCH_DELAY_MS);

        expect(getTaskComments).not.toHaveBeenCalled();
    });
});
