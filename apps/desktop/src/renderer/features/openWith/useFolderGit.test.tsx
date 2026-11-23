// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RootStore, RootStoreProvider } from '../../stores';
import { refreshFolderGit, useFolderGit } from './useFolderGit';

import type { ProjectInfo } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (folders: Record<string, string>): ProjectInfo[] => [
    {
        projectId: 'p-1',
        folders: Object.entries(folders).map(([folderId, branch]) => ({ folderId, exists: true, branch, chats: 0 })),
        chats: 0,
        tasks: 0,
        activeRuns: 0,
    },
];

/** The reads the hook has made, each one answered when the test says so. */
function transport() {
    const reads: Array<(answer: ProjectInfo[]) => void> = [];
    const getProjectsInfo = vi.fn(() => new Promise<ProjectInfo[]>(resolve => void reads.push(resolve)));

    return { getProjectsInfo, answer: (read: number, answer: ProjectInfo[]) => act(async () => reads[read]!(answer)) };
}

let container: HTMLDivElement;
let root: Root;

const Branch = ({ folderId }: { folderId: string }) => <span>{useFolderGit('p-1', folderId)?.branch ?? 'none'}</span>;
const draw = (store: RootStore, folderId: string) =>
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Branch folderId={folderId} />
            </RootStoreProvider>
        )
    );
const shown = () => container.textContent;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useFolderGit', () => {
    it('reads the branch of one project when drawn, and again each time the window gets focus', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        expect(shown()).toBe('none');
        expect(daemon.getProjectsInfo).toHaveBeenCalledExactlyOnceWith('p-1');

        await daemon.answer(0, info({ 'f-a': 'main' }));
        expect(shown()).toBe('main');

        act(() => void window.dispatchEvent(new Event('focus')));
        expect(daemon.getProjectsInfo).toHaveBeenCalledTimes(2);

        await daemon.answer(1, info({ 'f-a': 'feature/menu' }));
        expect(shown()).toBe('feature/menu');
    });

    it("reads again at once when something that changed the folder's branch says so, for that folder alone", async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.answer(0, info({ 'f-a': 'main' }));

        act(() => refreshFolderGit('p-1', 'f-b'));
        act(() => refreshFolderGit('p-2', 'f-a'));
        expect(daemon.getProjectsInfo).toHaveBeenCalledTimes(1);

        act(() => refreshFolderGit('p-1', 'f-a'));
        expect(daemon.getProjectsInfo).toHaveBeenCalledTimes(2);

        await daemon.answer(1, info({ 'f-a': 'feature/menu' }));
        expect(shown()).toBe('feature/menu');

        act(() => root.unmount());
        root = createRoot(container);
        act(() => refreshFolderGit('p-1', 'f-a'));
        expect(daemon.getProjectsInfo).toHaveBeenCalledTimes(2);
    });

    it('shows nothing of the folder it had, while the answer for the folder it has now is on its way', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.answer(0, info({ 'f-a': 'main', 'f-b': 'next' }));
        expect(shown()).toBe('main');

        draw(store, 'f-b');
        expect(shown()).toBe('none');

        await daemon.answer(1, info({ 'f-a': 'main', 'f-b': 'next' }));
        expect(shown()).toBe('next');
    });

    it('drops an answer that comes after the folder changed, and one that comes after a newer read', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        draw(store, 'f-b');
        await daemon.answer(0, info({ 'f-a': 'old', 'f-b': 'old' }));
        expect(shown()).toBe('none');

        act(() => void window.dispatchEvent(new Event('focus')));
        await daemon.answer(2, info({ 'f-b': 'new' }));
        await daemon.answer(1, info({ 'f-b': 'older' }));
        expect(shown()).toBe('new');
    });

    describe('for the worktree of a chat', () => {
        const worktreeInfo = (workspaces: ProjectInfo['workspaces']): ProjectInfo[] => [
            { ...info({ 'f-a': 'main' })[0]!, workspaces },
        ];
        const Head = ({ workspace }: { workspace: { id: string; branch?: string; ready: boolean } }) => (
            <span>{useFolderGit('p-1', 'f-a', workspace)?.branch ?? 'none'}</span>
        );
        const drawHead = (store: RootStore, workspace: { id: string; branch?: string; ready: boolean }) =>
            act(() =>
                root.render(
                    <RootStoreProvider value={store}>
                        <Head workspace={workspace} />
                    </RootStoreProvider>
                )
            );

        it("answers the branch the worktree has now, read like the folder's, and again when the window gets focus", async () => {
            const daemon = transport();
            const store = { transport: daemon } as unknown as RootStore;

            drawHead(store, { id: 'wks_1', branch: 'clowdy/ab12cd34', ready: true });
            // The branch the chat was made with is not shown in the read's place.
            expect(shown()).toBe('none');
            expect(daemon.getProjectsInfo).toHaveBeenCalledExactlyOnceWith('p-1');

            await daemon.answer(0, worktreeInfo([{ workspaceId: 'wks_1', exists: true, branch: 'feature/menu' }]));
            expect(shown()).toBe('feature/menu');

            act(() => void window.dispatchEvent(new Event('focus')));
            await daemon.answer(1, worktreeInfo([{ workspaceId: 'wks_1', exists: true, branch: 'feature/other' }]));
            expect(shown()).toBe('feature/other');
        });

        it('shows the branch it will be made on while it is not made, and reads again once it is', async () => {
            const daemon = transport();
            const store = { transport: daemon } as unknown as RootStore;

            drawHead(store, { id: 'wks_1', branch: 'clowdy/ab12cd34', ready: false });
            expect(shown()).toBe('clowdy/ab12cd34');

            drawHead(store, { id: 'wks_1', branch: 'clowdy/ab12cd34', ready: true });
            expect(daemon.getProjectsInfo).toHaveBeenCalledTimes(2);
            expect(shown()).toBe('none');

            await daemon.answer(1, worktreeInfo([{ workspaceId: 'wks_1', exists: true, branch: 'feature/menu' }]));
            expect(shown()).toBe('feature/menu');
        });

        it('shows nothing of the worktree it had when the answer for another comes, and for one the answer does not know', async () => {
            const daemon = transport();
            const store = { transport: daemon } as unknown as RootStore;

            drawHead(store, { id: 'wks_1', ready: true });
            await daemon.answer(0, worktreeInfo([{ workspaceId: 'wks_1', exists: true, branch: 'feature/menu' }]));
            expect(shown()).toBe('feature/menu');

            drawHead(store, { id: 'wks_2', ready: true });
            expect(shown()).toBe('none');

            await daemon.answer(1, worktreeInfo([{ workspaceId: 'wks_1', exists: true, branch: 'feature/menu' }]));
            expect(shown()).toBe('none');
        });
    });

    it('keeps what it knew when a read fails, and shows nothing for a folder the answer does not have', async () => {
        const daemon = {
            getProjectsInfo: vi
                .fn()
                .mockResolvedValueOnce(info({ 'f-a': 'main' }))
                .mockRejectedValueOnce(new Error('offline'))
                .mockResolvedValueOnce(info({})),
        };
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await act(async () => undefined);
        expect(shown()).toBe('main');

        act(() => void window.dispatchEvent(new Event('focus')));
        await act(async () => undefined);
        expect(shown()).toBe('main');

        act(() => void window.dispatchEvent(new Event('focus')));
        await act(async () => undefined);
        expect(shown()).toBe('none');
    });
});
