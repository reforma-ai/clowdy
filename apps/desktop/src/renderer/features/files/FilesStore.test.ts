// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { FilesStore } from './FilesStore';

const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));

    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};

const FOLDER = 'fld_car_rental';
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('FilesStore', () => {
    afterEach(() => {
        delete window.desktop;
    });

    it('gives a folder the desktop app\'s clipboard when the app is there and says where the folder is, and none otherwise', async () => {
        const bare = new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory(), () => '/Users/dev/web');

        expect(bare.managerOf('p', 'f1').clipboard).toBeUndefined();

        const writeClipboardFiles = vi.fn(async () => undefined);

        window.desktop = { platform: 'darwin', readClipboardFiles: async () => [], writeClipboardFiles, pasteClipboardFiles: async () => undefined } as never;

        const located = new FilesStore({ fileSystem: () => new MemoryFileSystem({ 'a.ts': '' }) }, memory(), (_project, folder) => (folder === 'f1' ? '/Users/dev/web' : undefined));
        const manager = located.managerOf('p', 'f1');

        expect(manager.canCopy).toBe(true);
        expect(located.managerOf('p', 'f2').clipboard).toBeUndefined();
        expect(new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory()).managerOf('p', 'f1').clipboard).toBeUndefined();

        await settle();
        await manager.copy(['a.ts']);

        expect(writeClipboardFiles).toHaveBeenCalledWith(['/Users/dev/web/a.ts']);

        for (const store of [bare, located]) store.dispose();
    });

    it('makes one file manager for each folder and keeps it, so what is open in a folder is still there when it comes back', async () => {
        const store = new FilesStore(new FixtureTransport(), memory());
        const manager = store.managerOf(FIXTURE_PROJECT_ID, FOLDER);
        const other = new FilesStore({ fileSystem: () => new MemoryFileSystem() }, memory());

        expect(store.managerOf(FIXTURE_PROJECT_ID, FOLDER)).toBe(manager);
        expect(other.managerOf('p', 'f1')).not.toBe(other.managerOf('p', 'f2'));
        expect(other.managerOf('p', 'f1')).not.toBe(other.managerOf('q', 'f1'));

        await settle();
        await manager.open('README.md');

        expect(store.managerOf(FIXTURE_PROJECT_ID, FOLDER).tabs.active?.path).toBe('README.md');

        store.dispose();
        other.dispose();
    });

    it('gives a folder a file manager for its documents besides the one for its files, each with its own tabs, kept between runs under its own key', async () => {
        const storage = memory();
        const first = new FilesStore(new FixtureTransport(), storage);
        const files = first.managerOf(FIXTURE_PROJECT_ID, FOLDER);
        const docs = first.managerOf(FIXTURE_PROJECT_ID, FOLDER, 'docs');

        expect(docs).not.toBe(files);
        expect(first.managerOf(FIXTURE_PROJECT_ID, FOLDER, 'docs')).toBe(docs);
        expect(first.managerOf(FIXTURE_PROJECT_ID, FOLDER, 'files')).toBe(files);

        await settle();
        await files.open('README.md');
        await docs.open('.clowdy/docs/decisions/pricing.md');
        await settle();

        // A tab of one is not a tab of the other, though both are the same folder on the disk.
        expect(files.tabs.documents.map(document => document.path)).toEqual(['README.md']);
        expect(docs.tabs.documents.map(document => document.path)).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER }`)!)).toEqual({ paths: ['README.md'], active: 'README.md' });
        expect(JSON.parse(storage.data.get(`clowdy:docs:${ FIXTURE_PROJECT_ID }:${ FOLDER }`)!)).toEqual({ paths: ['.clowdy/docs/decisions/pricing.md'], active: '.clowdy/docs/decisions/pricing.md' });

        first.dispose();

        const second = new FilesStore(new FixtureTransport(), storage);
        const reopened = await second.startedManagerOf(FIXTURE_PROJECT_ID, FOLDER, 'docs');

        expect(reopened.tabs.documents.map(document => document.path)).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect((await second.startedManagerOf(FIXTURE_PROJECT_ID, FOLDER)).tabs.documents.map(document => document.path)).toEqual(['README.md']);

        second.dispose();
    });

    it('lists the folder through the provider and keeps the hidden files back until asked: the names that start with a dot, and node_modules', async () => {
        const provider = new MemoryFileSystem({ 'a.ts': '', '.git/config': '', '.DS_Store': '', 'src/.env': '', 'src/b.ts': '', 'node_modules/x/index.js': '', '.clowdy/docs/a.md': '' });
        const store = new FilesStore({ fileSystem: () => provider }, memory());
        const manager = store.managerOf('p', 'f');

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
        const remote = served.managerOf('p', 'f');
        const local = scanned.managerOf('p', 'f');

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
        const manager = first.managerOf(FIXTURE_PROJECT_ID, FOLDER);

        await settle();
        await manager.open('README.md');
        await manager.open('package.json');
        await settle();

        expect(JSON.parse(storage.data.get(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER }`)!)).toEqual({ paths: ['README.md', 'package.json'], active: 'package.json' });

        first.dispose();

        // A file that was open and is gone, in the stored list of the next run.
        storage.data.set(`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER }`, JSON.stringify({ paths: ['README.md', 'gone.md', 'package.json'], active: 'README.md' }));

        const second = new FilesStore(new FixtureTransport(), storage);
        const reopened = second.managerOf(FIXTURE_PROJECT_ID, FOLDER);

        await settle();

        expect(reopened.tabs.documents.map(document => document.path)).toEqual(['README.md', 'package.json']);
        expect(reopened.tabs.active?.path).toBe('README.md');

        second.dispose();
    });

    it('ignores tabs that were stored damaged', async () => {
        const store = new FilesStore(new FixtureTransport(), memory({ [`clowdy:files:${ FIXTURE_PROJECT_ID }:${ FOLDER }`]: '{"paths":"README.md"}' }));
        const manager = store.managerOf(FIXTURE_PROJECT_ID, FOLDER);

        await settle();

        expect(manager.tabs.documents).toEqual([]);

        store.dispose();
    });

    it('keeps no tabs after it is disposed, even for a folder that was still being listed', async () => {
        const storage = memory();
        const store = new FilesStore(new FixtureTransport(), storage);
        const manager = store.managerOf(FIXTURE_PROJECT_ID, FOLDER);

        store.dispose();
        await settle();
        await manager.open('README.md');
        await settle();

        expect(storage.data.size).toBe(0);
    });
});
