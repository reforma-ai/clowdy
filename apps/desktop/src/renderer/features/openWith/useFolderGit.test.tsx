// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RootStoreProvider, type RootStore } from '../../stores';
import { useFolderGit } from './useFolderGit';

import type { ProjectInfo } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (folders: Record<string, string>): ProjectInfo[] => [{
    projectId: 'p-1',
    folders: Object.entries(folders).map(([folderId, branch]) => ({ folderId, exists: true, branch, chats: 0 })),
    chats: 0,
    tasks: 0,
    activeRuns: 0,
}];

/** The reads the hook has made, each one answered when the test says so. */
function transport() {
    const reads: Array<(answer: ProjectInfo[]) => void> = [];
    const getProjectsInfo = vi.fn(() => new Promise<ProjectInfo[]>(resolve => void reads.push(resolve)));

    return { getProjectsInfo, answer: (read: number, answer: ProjectInfo[]) => act(async () => reads[read]!(answer)) };
}

let container: HTMLDivElement;
let root: Root;

const Branch = ({ folderId }: { folderId: string }) => <span>{ useFolderGit('p-1', folderId)?.branch ?? 'none' }</span>;
const draw = (store: RootStore, folderId: string) => act(() => root.render(<RootStoreProvider value={ store }><Branch folderId={ folderId } /></RootStoreProvider>));
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

    it('keeps what it knew when a read fails, and shows nothing for a folder the answer does not have', async () => {
        const daemon = { getProjectsInfo: vi.fn().mockResolvedValueOnce(info({ 'f-a': 'main' })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(info({})) };
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
