// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { FilesStore } from './FilesStore';

import type { Place } from '../sidePanel/currentPlace';

const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));

    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};

const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
/** A place that is a folder's own checkout. */
const folderPlace = (id: string, path = `/Users/dev/${ id }`): Place => ({ folder: { id, path } });
/** A place that is a worktree of a folder; it has the fixture's own files when it is the fixture's. */
const worktreePlace = (id: string, path: string, folder = FOLDER): Place => ({ folder, workspace: { id, folderId: folder.id, path, branch: `clowdy/${ id }`, managed: true, ready: true } });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const CAR_RENTAL = folderPlace(FOLDER.id, FOLDER.path);

describe('FilesStore', () => {
    afterEach(() => {
        delete window.desktop;
    });

    it('gives a folder the desktop app\'s clipboard when the app is there and says where the folder is, and none otherwise', async () => {
        const bare = new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory());

        expect(bare.managerOf('p', folderPlace('f1', '/Users/dev/web')).clipboard).toBeUndefined();

        const writeClipboardFiles = vi.fn(async () => undefined);

        window.desktop = { platform: 'darwin', readClipboardFiles: async () => [], writeClipboardFiles, pasteClipboardFiles: async () => undefined } as never;

        const located = new FilesStore({ fileSystem: () => new MemoryFileSystem({ 'a.ts': '' }) }, memory());
        const manager = located.managerOf('p', folderPlace('f1', '/Users/dev/web'));
        const worktree = located.managerOf('p', worktreePlace('wks_1', '/Users/dev/Clowdy/workspaces/web/ab12cd34/web', { id: 'f1', path: '/Users/dev/web' }));

        expect(manager.canCopy).toBe(true);

        await settle();
        await manager.copy(['a.ts']);
        await worktree.copy(['a.ts']);

        // The files of a worktree are on the disk at the worktree's path, not the folder's.
        expect(writeClipboardFiles).toHaveBeenNthCalledWith(1, ['/Users/dev/web/a.ts']);
        expect(writeClipboardFiles).toHaveBeenNthCalledWith(2, ['/Users/dev/Clowdy/workspaces/web/ab12cd34/web/a.ts']);

        delete window.desktop;

        // In a page that is not the desktop app the tree has no Copy and no Paste.
        expect(new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory()).managerOf('p', folderPlace('f1')).clipboard).toBeUndefined();

        for (const store of [bare, located]) store.dispose();
    });

    it('makes one file manager for each folder and keeps it, so what is open in a folder is still there when it comes back', async () => {
        const store = new FilesStore(new FixtureTransport(), memory());
        const manager = store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);
        const other = new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory());

        expect(store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL)).toBe(manager);
        expect(other.managerOf('p', folderPlace('f1'))).not.toBe(other.managerOf('p', folderPlace('f2')));
        expect(other.managerOf('p', folderPlace('f1'))).not.toBe(other.managerOf('q', folderPlace('f1')));

        await settle();
        await manager.open('README.md');

        expect(store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL).tabs.active?.path).toBe('README.md');

        store.dispose();
        other.dispose();
    });

    it('gives a folder a file manager for its documents besides the one for its files, each with its own tabs, kept between runs under its own key', async () => {
        const storage = memory();
        const first = new FilesStore(new FixtureTransport(), storage);
        const files = first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);
        const docs = first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL, 'docs');

        expect(docs).not.toBe(files);
        expect(first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL, 'docs')).toBe(docs);
        expect(first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL, 'files')).toBe(files);

        await settle();
        await files.open('README.md');
        await docs.open('.clowdy/docs/decisions/pricing.md');
        await settle();

        // A tab of one is not a tab of the other, though both are the same folder on the disk.
        expect(files.tabs.documents.map(document => document.path)).toEqual(['README.md']);
        expect(docs.tabs.documents.map(document => document.path)).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`)!)).toEqual({ paths: ['README.md'], active: 'README.md' });
        expect(JSON.parse(storage.data.get(`clowdy:docs:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`)!)).toEqual({ paths: ['.clowdy/docs/decisions/pricing.md'], active: '.clowdy/docs/decisions/pricing.md' });

        first.dispose();

        const second = new FilesStore(new FixtureTransport(), storage);
        const reopened = await second.startedManagerOf(FIXTURE_PROJECT_ID, CAR_RENTAL, 'docs');

        expect(reopened.tabs.documents.map(document => document.path)).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect((await second.startedManagerOf(FIXTURE_PROJECT_ID, CAR_RENTAL)).tabs.documents.map(document => document.path)).toEqual(['README.md']);

        second.dispose();
    });

    it('lists the folder through the provider and keeps the hidden files back until asked: the names that start with a dot, and node_modules', async () => {
        const provider = new MemoryFileSystem({ 'a.ts': '', '.git/config': '', '.DS_Store': '', 'src/.env': '', 'src/b.ts': '', 'node_modules/x/index.js': '', '.clowdy/docs/a.md': '' });
        const store = new FilesStore({ fileSystem: () => provider }, memory());
        const manager = store.managerOf('p', folderPlace('f'));

        await settle();

        expect(['a.ts', 'src', 'src/b.ts'].map(path => manager.tree.isVisible(path))).toEqual([true, true, true]);
        expect(['.git', '.DS_Store', 'src/.env', 'node_modules', '.clowdy', '.clowdy/docs/a.md'].map(path => manager.tree.isVisible(path))).toEqual([false, false, false, false, false, false]);

        manager.tree.setShowHidden(true);

        expect(['.git', '.DS_Store', 'src/.env', 'node_modules', '.clowdy', '.clowdy/docs/a.md'].map(path => manager.tree.isVisible(path))).toEqual([true, true, true, true, true, true]);

        store.dispose();
    });

    it('searches through the daemon when its file system has a search, and scans the files itself when it has none', async () => {
        const found = { files: [{ path: 'a.ts', matches: [{ line: 1, column: 1, preview: 'needle', ranges: [{ start: 0, end: 6 }] }] }], truncated: false };
        const search = vi.fn(async () => found);
        const served = new FilesStore({ fileSystem: () => Object.assign(new MemoryFileSystem({ 'a.ts': 'needle' }), { search }) }, memory());
        const scanned = new FilesStore({ fileSystem: () => new MemoryFileSystem({ 'a.ts': 'a needle\n', 'b.ts': 'nothing' }) }, memory());
        const remote = served.managerOf('p', folderPlace('f'));
        const local = scanned.managerOf('p', folderPlace('f'));

        await settle();
        remote.search.set({ query: 'needle' });
        await remote.search.run();
        local.search.set({ query: 'needle' });
        await local.search.run();

        expect(search).toHaveBeenCalledOnce();
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'needle', matchCase: false, wholeWord: false }), expect.any(AbortSignal));
        expect(remote.search.result).toEqual(found);
        expect(local.search.result?.files.map(file => file.path)).toEqual(['a.ts']);

        served.dispose();
        scanned.dispose();
    });

    it('keeps the open tabs between runs, and brings back the ones whose files are still there', async () => {
        const storage = memory();
        const first = new FilesStore(new FixtureTransport(), storage);
        const manager = first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);

        await settle();
        await manager.open('README.md');
        await manager.open('package.json');
        await settle();

        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`)!)).toEqual({ paths: ['README.md', 'package.json'], active: 'package.json' });

        first.dispose();

        // A file that was open and is gone, in the stored list of the next run.
        storage.data.set(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`, JSON.stringify({ paths: ['README.md', 'gone.md', 'package.json'], active: 'README.md' }));

        const second = new FilesStore(new FixtureTransport(), storage);
        const reopened = second.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);

        await settle();

        expect(reopened.tabs.documents.map(document => document.path)).toEqual(['README.md', 'package.json']);
        expect(reopened.tabs.active?.path).toBe('README.md');

        second.dispose();
    });

    it('ignores tabs that were stored damaged', async () => {
        const store = new FilesStore(new FixtureTransport(), memory({ [`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`]: '{"paths":"README.md"}' }));
        const manager = store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);

        await settle();

        expect(manager.tabs.documents).toEqual([]);

        store.dispose();
    });

    it('keeps no tabs after it is disposed, even for a folder that was still being listed', async () => {
        const storage = memory();
        const store = new FilesStore(new FixtureTransport(), storage);
        const manager = store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);

        store.dispose();
        await settle();
        await manager.open('README.md');
        await settle();

        expect(storage.data.size).toBe(0);
    });
});

describe('FilesStore over a worktree', () => {
    // The fixture's chat in a worktree of Car Rental: the worktree has a file (`src/booking/weekend.ts`) and a plan (`.briefback/weekend-surcharge/plan.md`) the folder's own checkout lacks.
    const transport = () => new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) });
    const workspace = withFixtureWorkspace(createFixtureData()).chats.find(chat => chat.id === FIXTURE_WORKSPACE_CHAT_ID)!.workspace!;
    const WORKTREE: Place = { folder: FOLDER, workspace };

    it('gives a worktree a file manager of its own, listing the worktree\'s files and not the folder\'s, and the same one to every chat that works in it', async () => {
        const store = new FilesStore(transport(), memory());
        const own = store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);
        const worktree = store.managerOf(FIXTURE_PROJECT_ID, WORKTREE);

        await settle();

        expect(worktree).not.toBe(own);
        expect(worktree.tree.get('src/booking/weekend.ts')).toBeDefined();
        expect(own.tree.get('src/booking/weekend.ts')).toBeUndefined();
        // Another chat in the same worktree has another place object and the same worktree.
        expect(store.managerOf(FIXTURE_PROJECT_ID, { folder: { ...FOLDER }, workspace: { ...workspace } })).toBe(worktree);
        expect(store.managerOf(FIXTURE_PROJECT_ID, WORKTREE, 'docs')).not.toBe(worktree);

        store.dispose();
    });

    it('asks the transport for the worktree of the folder, and for the folder alone when the place has none', () => {
        const fileSystem = vi.fn(() => new MemoryFileSystem());
        const store = new FilesStore({ fileSystem }, memory());

        store.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);
        store.managerOf(FIXTURE_PROJECT_ID, WORKTREE);

        expect(fileSystem).toHaveBeenNthCalledWith(1, FIXTURE_PROJECT_ID, FOLDER.id, undefined);
        expect(fileSystem).toHaveBeenNthCalledWith(2, FIXTURE_PROJECT_ID, FOLDER.id, workspace.id);

        store.dispose();
    });

    it('keeps the tabs of a worktree under its own id, apart from the folder\'s, and brings each back to its own place', async () => {
        const storage = memory();
        const first = new FilesStore(transport(), storage);
        const own = first.managerOf(FIXTURE_PROJECT_ID, CAR_RENTAL);
        const worktree = first.managerOf(FIXTURE_PROJECT_ID, WORKTREE);
        const plans = first.managerOf(FIXTURE_PROJECT_ID, WORKTREE, 'docs');

        await settle();
        await own.open('README.md');
        await worktree.open('src/booking/weekend.ts');
        await plans.open('.briefback/weekend-surcharge/plan.md');
        await settle();

        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`)!)).toEqual({ paths: ['README.md'], active: 'README.md' });
        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ workspace.id }`)!)).toEqual({ paths: ['src/booking/weekend.ts'], active: 'src/booking/weekend.ts' });
        expect(JSON.parse(storage.data.get(`clowdy:docs:${ FIXTURE_PROJECT_ID }:${ workspace.id }`)!)).toEqual({ paths: ['.briefback/weekend-surcharge/plan.md'], active: '.briefback/weekend-surcharge/plan.md' });
        expect(storage.data.has(`clowdy:docs:${ FIXTURE_PROJECT_ID }:${ FOLDER.id }`)).toBe(false);

        first.dispose();

        const second = new FilesStore(transport(), storage);

        expect((await second.startedManagerOf(FIXTURE_PROJECT_ID, WORKTREE)).tabs.documents.map(document => document.path)).toEqual(['src/booking/weekend.ts']);
        expect((await second.startedManagerOf(FIXTURE_PROJECT_ID, WORKTREE, 'docs')).tabs.documents.map(document => document.path)).toEqual(['.briefback/weekend-surcharge/plan.md']);
        expect((await second.startedManagerOf(FIXTURE_PROJECT_ID, CAR_RENTAL)).tabs.documents.map(document => document.path)).toEqual(['README.md']);

        second.dispose();
    });

    it('does not bring a tab back into a worktree that lacks its file: the worktree is another checkout', async () => {
        // A file of the folder's own checkout in the worktree's stored tabs, such as a worktree made again on another commit.
        const storage = memory({ [`clowdy:files:${ FIXTURE_PROJECT_ID }:${ workspace.id }`]: JSON.stringify({ paths: ['README.md', 'only-in-the-folder.md'], active: 'only-in-the-folder.md' }) });
        const store = new FilesStore(transport(), storage);
        const worktree = await store.startedManagerOf(FIXTURE_PROJECT_ID, WORKTREE);

        expect(worktree.tabs.documents.map(document => document.path)).toEqual(['README.md']);

        store.dispose();
    });
});
