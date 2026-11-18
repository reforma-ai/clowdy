// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { FETCH_DELAY_MS, useTaskArtifacts } from './useTaskArtifacts';

import type { Artifact, TaskDetail } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact = (id: string): Artifact => ({ id, kind: 'doc', title: id, ref: {}, createdAt: 1 }) as Artifact;
const detail = (...ids: string[]): TaskDetail => ({ artifacts: ids.map(artifact) }) as TaskDetail;

let container: HTMLDivElement;
let root: Root;
let getTaskDetail: ReturnType<typeof vi.fn<(taskId: string) => Promise<TaskDetail>>>;
let project: { artifactsRevision: number };
let latest: ReturnType<typeof useTaskArtifacts>;

function Probe({ taskId }: { taskId: string }) {
    latest = useTaskArtifacts(taskId);

    return null;
}

const render = (taskId: string) => act(async () => {
    root.render(
        <RootStoreProvider value={ { transport: { getTaskDetail }, selectedProject: project } as unknown as RootStore }>
            <Probe taskId={ taskId } />
        </RootStoreProvider>
    );
});

const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
});

beforeEach(() => {
    vi.useFakeTimers();
    getTaskDetail = vi.fn<(taskId: string) => Promise<TaskDetail>>(async () => detail('doc-1'));
    project = { artifactsRevision: 0 };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

describe('useTaskArtifacts', () => {
    it('fetches once the task has stayed open for the pause, not before', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS - 1);

        expect(getTaskDetail).not.toHaveBeenCalled();
        expect(latest.state).toEqual({ status: 'loading' });

        await advance(1);

        expect(getTaskDetail).toHaveBeenCalledTimes(1);
        expect(getTaskDetail).toHaveBeenCalledWith('t-1');
        expect(latest.state).toEqual({ status: 'ready', artifacts: detail('doc-1').artifacts });
    });

    it('fetches only the last of tasks that are passed in quick succession, as a held J does', async () => {
        for (const taskId of ['t-1', 't-2', 't-3', 't-4', 't-5']) {
            await render(taskId);
            await advance(30);
        }

        expect(getTaskDetail).not.toHaveBeenCalled();

        await advance(FETCH_DELAY_MS);

        expect(getTaskDetail).toHaveBeenCalledTimes(1);
        expect(getTaskDetail).toHaveBeenCalledWith('t-5');
    });

    it('starts the pause again when the task changes', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS - 10);
        await render('t-2');
        await advance(FETCH_DELAY_MS - 10);

        expect(getTaskDetail).not.toHaveBeenCalled();

        await advance(10);

        expect(getTaskDetail).toHaveBeenCalledTimes(1);
        expect(getTaskDetail).toHaveBeenCalledWith('t-2');
    });

    it('drops an answer that comes after the task changed', async () => {
        let answer: (value: TaskDetail) => void = () => {};

        getTaskDetail.mockImplementationOnce(() => new Promise((resolve) => {
            answer = resolve;
        }));

        await render('t-1');
        await advance(FETCH_DELAY_MS);
        await render('t-2');
        await act(async () => answer(detail('stale')));

        expect(latest.state).toEqual({ status: 'loading' });
    });

    it('keeps showing the old artifacts while a new one is fetched', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS);

        getTaskDetail.mockResolvedValueOnce(detail('doc-1', 'doc-2'));
        project.artifactsRevision = 1;
        await render('t-1');

        expect(latest.state).toEqual({ status: 'ready', artifacts: detail('doc-1').artifacts });

        await advance(FETCH_DELAY_MS);

        expect(getTaskDetail).toHaveBeenCalledTimes(2);
        expect(latest.state).toEqual({ status: 'ready', artifacts: detail('doc-1', 'doc-2').artifacts });
    });

    it('reports a failure, and fetches again on retry after the pause', async () => {
        getTaskDetail.mockRejectedValueOnce(new Error('The daemon cannot be reached'));

        await render('t-1');
        await advance(FETCH_DELAY_MS);

        expect(latest.state).toEqual({ status: 'failed', message: 'The daemon cannot be reached' });

        await act(async () => latest.retry());

        expect(latest.state).toEqual({ status: 'loading' });

        await advance(FETCH_DELAY_MS);

        expect(getTaskDetail).toHaveBeenCalledTimes(2);
        expect(latest.state.status).toBe('ready');
    });

    it('does not fetch for a panel that closed within the pause', async () => {
        await render('t-1');
        await advance(FETCH_DELAY_MS - 1);
        act(() => root.render(null));
        await advance(FETCH_DELAY_MS);

        expect(getTaskDetail).not.toHaveBeenCalled();
    });
});
