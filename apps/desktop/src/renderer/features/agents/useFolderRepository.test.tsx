// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransportError } from '../../daemon/transport';
import { type RootStore, RootStoreProvider } from '../../stores';
import { refreshFolderGit } from '../openWith';
import { useFolderRepository } from './useFolderRepository';

import type { FolderGit } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repository = (branch: string): FolderGit => ({
    isRepository: true,
    branch,
    defaultBranch: 'origin/main',
    branches: [{ name: branch, remote: false }],
    worktrees: [],
});

/** The reads the hook has made, each one answered or refused when the test says so. */
function transport() {
    const reads: Array<{ resolve: (answer: FolderGit) => void; reject: (error: Error) => void }> = [];
    const getFolderGit = vi.fn(() => new Promise<FolderGit>((resolve, reject) => void reads.push({ resolve, reject })));

    return {
        getFolderGit,
        answer: (read: number, answer: FolderGit) => act(async () => reads[read]!.resolve(answer)),
        refuse: (read: number, message: string, status = 503) =>
            act(async () => reads[read]!.reject(new TransportError(message, status))),
    };
}

let container: HTMLDivElement;
let root: Root;

const Said = ({ folderId }: { folderId: string }) => {
    const repo = useFolderRepository('p-1', folderId);

    return (
        <span>
            {repo.status === 'ready'
                ? repo.git.isRepository
                    ? `ready ${repo.git.branch}`
                    : 'ready none'
                : repo.status === 'failed'
                  ? `failed ${repo.reason}`
                  : 'loading'}
        </span>
    );
};
const draw = (store: RootStore, folderId: string) =>
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Said folderId={folderId} />
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

describe('useFolderRepository', () => {
    it('reads the folder when drawn, and again each time the window gets focus', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        expect(shown()).toBe('loading');
        expect(daemon.getFolderGit).toHaveBeenCalledExactlyOnceWith('p-1', 'f-a');

        await daemon.answer(0, repository('main'));
        expect(shown()).toBe('ready main');

        act(() => void window.dispatchEvent(new Event('focus')));
        expect(daemon.getFolderGit).toHaveBeenCalledTimes(2);
        // What is known stays on show while the new read is on its way.
        expect(shown()).toBe('ready main');

        await daemon.answer(1, repository('next'));
        expect(shown()).toBe('ready next');
    });

    it("reads the folder again when the app has changed its branch (`refreshFolderGit`), and for no other folder or project's", async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.answer(0, repository('main'));

        act(() => refreshFolderGit('p-1', 'f-b'));
        act(() => refreshFolderGit('p-2', 'f-a'));
        expect(daemon.getFolderGit).toHaveBeenCalledTimes(1);

        act(() => refreshFolderGit('p-1', 'f-a'));
        expect(daemon.getFolderGit).toHaveBeenCalledTimes(2);
        expect(shown()).toBe('ready main');

        await daemon.answer(1, repository('dev'));
        expect(shown()).toBe('ready dev');

        // Unmounted, it listens no more.
        act(() => root.unmount());
        act(() => refreshFolderGit('p-1', 'f-a'));
        expect(daemon.getFolderGit).toHaveBeenCalledTimes(2);
        root = createRoot(container);
    });

    it('says why the daemon could not read the folder, and that it is no repository when it says so', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.refuse(0, 'git did not answer');
        expect(shown()).toBe('failed git did not answer');

        act(() => void window.dispatchEvent(new Event('focus')));
        await daemon.answer(1, { isRepository: false });
        expect(shown()).toBe('ready none');
    });

    it("gives no reason for a failure that is not the daemon saying it cannot read the folder, whose words are a route or the network's", async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.refuse(0, 'The daemon answered 502 for /v1/projects/p-1/git?folderId=f-a', 502);
        expect(shown()).toBe('failed ');
    });

    it('keeps what it knew of the folder when a later read fails', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.answer(0, repository('main'));

        act(() => void window.dispatchEvent(new Event('focus')));
        await daemon.refuse(1, 'git did not answer');
        expect(shown()).toBe('ready main');
    });

    it('shows nothing of the folder it had while the answer for the folder it has now is on its way, and drops a late answer for the old one', async () => {
        const daemon = transport();
        const store = { transport: daemon } as unknown as RootStore;

        draw(store, 'f-a');
        await daemon.answer(0, repository('main'));
        draw(store, 'f-b');
        expect(shown()).toBe('loading');

        await daemon.refuse(1, 'The folder is missing');
        expect(shown()).toBe('failed The folder is missing');

        // A read that was made for the first folder and comes last is not the second's.
        draw(store, 'f-a');
        expect(shown()).toBe('loading');
        draw(store, 'f-b');
        expect(daemon.getFolderGit).toHaveBeenCalledTimes(4);
        await daemon.answer(2, repository('stale'));
        expect(shown()).not.toContain('stale');
        await daemon.answer(3, repository('right'));
        expect(shown()).toBe('ready right');
    });
});
