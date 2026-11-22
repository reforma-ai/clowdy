// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { filesManagerOf, kindOnDisk, openInFiles } from './openInFiles';
import { filesStoreOf } from './useFilesStore';

// The Car Rental project's only folder, with the fixture's files: README.md, package.json, src/booking/price.ts and the like.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
const FILES = ['README.md', 'package.json', 'src/booking/index.tsx', 'src/booking/BookingForm.tsx', 'src/booking/price.ts', 'src/booking/price.test.ts'];

let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const manager = () => filesManagerOf(store, FIXTURE_PROJECT_ID, FOLDER);
const open = (path: string) => openInFiles(store, FIXTURE_PROJECT_ID, FOLDER, path);
const tabs = async () => (await manager()).tabs.documents.map(document => document.path);

beforeEach(async () => {
    // The tabs of a folder are kept in the browser's storage and come back with it: a test starts with none.
    localStorage.clear();
    store = new RootStore(new FixtureTransport());
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    filesStoreOf(store.transport).dispose();
    store.dispose();
    localStorage.clear();
});

describe('opening a path in the Files tab', () => {
    it('opens a file in a tab, and shows the side panel on its Files tab', async () => {
        expect(ui().sidePanelOpen).toBe(false);
        expect(await open('src/booking/price.ts')).toBe(true);

        expect((await manager()).tabs.active?.path).toBe('src/booking/price.ts');
        expect(ui().sidePanelOpen).toBe(true);
        expect(ui().sidePanelTab).toBe('files');
    });

    it('shows a folder of the tree, with no tab for it, and the folder itself by showing the tab', async () => {
        expect(await open('src/booking')).toBe(true);
        expect((await manager()).revealed?.path).toBe('src/booking');
        expect(await tabs()).toEqual([]);

        expect(await open('')).toBe(true);
        expect(await tabs()).toEqual([]);
        expect(ui().sidePanelTab).toBe('files');
    });

    it('is false for a path that is not there, with no tab added, the active one kept, and the panel as it was', async () => {
        const files = await manager();

        await files.open('README.md');
        await files.open('package.json');
        files.tabs.activate('README.md');

        expect(await open('src/gone.ts')).toBe(false);
        expect(await open('gone/deeper/file.ts')).toBe(false);

        expect(await tabs()).toEqual(['README.md', 'package.json']);
        expect(files.tabs.active?.path).toBe('README.md');
        expect(ui().sidePanelOpen).toBe(false);
        expect(ui().sidePanelTab).toBe('info');
    });

    it('closes none of the tabs that are open, at the most tabs, for a path that is not there', async () => {
        const files = await manager();

        for (const path of FILES) await files.open(path);

        expect(await tabs()).toEqual(FILES);
        expect(await open('src/gone.ts')).toBe(false);
        expect(await tabs()).toEqual(FILES);
    });
});

describe('what a path is on the disk', () => {
    const kind = (path: string) => kindOnDisk(store, FIXTURE_PROJECT_ID, FOLDER, path);

    it('is a file or a folder, as the disk has it, for a path with or without a trailing slash', async () => {
        expect(await kind('src/booking/price.ts')).toBe('file');
        expect(await kind('src/booking')).toBe('directory');
        expect(await kind('src')).toBe('directory');
    });

    it('is a folder for the folder itself, and nothing for a path that is not there', async () => {
        expect(await kind('')).toBe('directory');
        expect(await kind('src/gone')).toBeUndefined();
        expect(await kind('gone/deeper/file.ts')).toBeUndefined();
    });
});
