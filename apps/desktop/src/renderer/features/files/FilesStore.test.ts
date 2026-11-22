// @vitest-environment happy-dom
import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { describe, expect, it } from 'vitest';

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

    it('lists the folder through the provider of the transport, leaving out Git\'s folder and what the system litters, and keeping node_modules back until asked', async () => {
        const provider = new MemoryFileSystem({ 'a.ts': '', '.git/config': '', '.DS_Store': '', 'src/.DS_Store': '', 'node_modules/x/index.js': '', '.clowdy/docs/a.md': '' });
        const store = new FilesStore({ fileSystem: () => provider }, memory());
        const manager = store.managerOf('p', 'f');

        await settle();

        expect(manager.tree.isVisible('a.ts')).toBe(true);
        expect(manager.tree.isVisible('.git')).toBe(false);
        expect(manager.tree.isVisible('.DS_Store')).toBe(false);
        expect(manager.tree.isVisible('src/.DS_Store')).toBe(false);
        expect(manager.tree.isVisible('node_modules')).toBe(false);
        expect(manager.tree.isVisible('.clowdy')).toBe(false);

        manager.tree.setShowHidden(true);

        expect(manager.tree.isVisible('node_modules')).toBe(true);
        expect(manager.tree.isVisible('.git')).toBe(false);

        store.dispose();
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
