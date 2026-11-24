// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { filesManagerOf, kindOnDisk, openInFiles } from './openInFiles';
import { treeLayout } from './treeLayout';
import { filesStoreOf } from './useFilesStore';

import type { Place } from '../sidePanel/currentPlace';

// The Car Rental project's only folder, with the fixture's files: README.md, package.json, src/booking/price.ts and the like.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
const PLACE: Place = { folder: FOLDER };
const FILES = [
    'README.md',
    'package.json',
    'src/booking/index.tsx',
    'src/booking/BookingForm.tsx',
    'src/booking/price.ts',
    'src/booking/price.test.ts',
];

let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const manager = (kind: 'files' | 'docs' = 'files') => filesManagerOf(store, FIXTURE_PROJECT_ID, PLACE, kind);
const open = (path: string) => openInFiles(store, FIXTURE_PROJECT_ID, PLACE, path);
const tabs = async (kind: 'files' | 'docs' = 'files') =>
    (await manager(kind)).tabs.documents.map(document => document.path);

beforeEach(async () => {
    // The tabs of a folder are kept in the browser's storage and come back with it: a test starts with none.
    localStorage.clear();
    store = new RootStore(new FixtureTransport());
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    filesStoreOf(store).dispose();
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

    it('shows a document on the Docs tab, in the tabs of that tab, and any other file on the Files tab, in the tabs of that one', async () => {
        expect(await open('.clowdy/docs/decisions/pricing.md')).toBe(true);

        expect((await manager('docs')).tabs.active?.path).toBe('.clowdy/docs/decisions/pricing.md');
        expect(ui().sidePanelOpen).toBe(true);
        expect(ui().sidePanelTab).toBe('docs');

        expect(await open('README.md')).toBe(true);
        expect(ui().sidePanelTab).toBe('files');

        // Each tab has its own tabs: a document is not a tab of the Files tab, and a file is not one of the Docs tab.
        expect(await tabs('docs')).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(await tabs('files')).toEqual(['README.md']);
    });

    it('opens a plan of .briefback on the Docs tab as it does a document, in the tabs of that tab', async () => {
        expect(await open('.briefback/weekend-pricing/plan.md')).toBe(true);

        expect(ui().sidePanelTab).toBe('docs');
        expect(await tabs('docs')).toEqual(['.briefback/weekend-pricing/plan.md']);
        expect(await tabs('files')).toEqual([]);
    });

    it('shows a folder of the tree, with no tab for it, and the folder itself by showing the tab', async () => {
        expect(await open('src/booking')).toBe(true);
        expect((await manager()).revealed?.path).toBe('src/booking');
        expect(await tabs()).toEqual([]);

        expect(await open('')).toBe(true);
        expect(await tabs()).toEqual([]);
        expect(ui().sidePanelTab).toBe('files');
    });

    it('opens a hidden folder in a closed tree without changing the hidden setting, then replaces the exception', async () => {
        if (treeLayout.open) treeLayout.toggle();
        treeLayout.setShowHidden(false);
        try {
            expect(await open('.clowdy/docs')).toBe(true);
            const files = await manager();
            expect(treeLayout.open).toBe(true);
            expect(treeLayout.showHidden).toBe(false);
            expect(files.tree.isVisible('.clowdy/docs')).toBe(true);
            expect(files.revealed?.path).toBe('.clowdy/docs');
            expect(await open('src/booking')).toBe(true);
            expect(files.tree.isVisible('.clowdy/docs')).toBe(false);
            expect(files.revealed?.path).toBe('src/booking');
        } finally {
            if (!treeLayout.open) treeLayout.toggle();
        }
    });

    it('keeps the latest folder when an earlier listing finishes late', async () => {
        const files = await manager();
        const list = files.provider.list.bind(files.provider);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const spy = vi.spyOn(files.provider, 'list').mockImplementation(async (path, depth) => {
            if (path === '.clowdy/docs') await gate;
            return list(path, depth);
        });
        try {
            const slow = open('.clowdy/docs');
            await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('.clowdy/docs', 1));
            expect(await open('src/booking')).toBe(true);
            release();
            await slow;
            expect(files.revealed?.path).toBe('src/booking');
            expect(files.tree.isVisible('.clowdy/docs')).toBe(false);
        } finally {
            release();
            spy.mockRestore();
        }
    });

    it('leaves the panel and hidden setting alone when a folder cannot be read', async () => {
        const files = await manager();
        const list = files.provider.list.bind(files.provider);
        const spy = vi.spyOn(files.provider, 'list').mockImplementation(async (path, depth) => {
            if (path === '.clowdy/docs') throw new Error('Permission denied');
            return list(path, depth);
        });
        try {
            expect(await open('.clowdy/docs')).toBe(false);
            expect(ui().sidePanelOpen).toBe(false);
            expect(files.tree.isVisible('.clowdy/docs')).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    it('forgets the requested folder when a file is opened later', async () => {
        expect(await open('.clowdy/docs')).toBe(true);
        const files = await manager();
        expect(files.revealed?.path).toBe('.clowdy/docs');
        expect(await open('README.md')).toBe(true);
        expect(files.revealed).toBeNull();
        expect(files.tabs.active?.path).toBe('README.md');
    });

    it('does not open the tree when opening a file', async () => {
        if (treeLayout.open) treeLayout.toggle();
        try {
            expect(await open('README.md')).toBe(true);
            expect(treeLayout.open).toBe(false);
        } finally {
            if (!treeLayout.open) treeLayout.toggle();
        }
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
        expect(ui().sidePanelTab).toBe('files');
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
    const kind = (path: string) => kindOnDisk(store, FIXTURE_PROJECT_ID, PLACE, path);

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

describe('opening a path in a worktree', () => {
    let worktree: Place;

    beforeEach(async () => {
        filesStoreOf(store).dispose();
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        worktree = {
            folder: FOLDER,
            workspace: store.selectedProject!.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!,
        };
    });

    it('clears the previous place’s temporary hidden path when navigating in another place', async () => {
        expect(await open('.clowdy/docs')).toBe(true);
        const original = await manager();
        expect(original.tree.isVisible('.clowdy/docs')).toBe(true);
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, worktree, 'src/booking')).toBe(true);
        expect(original.tree.isVisible('.clowdy/docs')).toBe(false);
    });

    it("opens a file that only the worktree has in the worktree's tabs, which the folder's own checkout does not have", async () => {
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, PLACE, 'src/booking/weekend.ts')).toBe(false);
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, worktree, 'src/booking/weekend.ts')).toBe(true);

        expect((await filesManagerOf(store, FIXTURE_PROJECT_ID, worktree)).tabs.active?.path).toBe(
            'src/booking/weekend.ts'
        );
        expect((await filesManagerOf(store, FIXTURE_PROJECT_ID, PLACE)).tabs.documents).toEqual([]);
        expect(ui().sidePanelTab).toBe('files');
    });

    it('opens a plan that only the worktree has on the Docs tab of the worktree', async () => {
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, PLACE, '.briefback/weekend-surcharge/plan.md')).toBe(false);
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, worktree, '.briefback/weekend-surcharge/plan.md')).toBe(
            true
        );

        expect((await filesManagerOf(store, FIXTURE_PROJECT_ID, worktree, 'docs')).tabs.active?.path).toBe(
            '.briefback/weekend-surcharge/plan.md'
        );
        expect(ui().sidePanelTab).toBe('docs');
    });

    it('says what a path is in the worktree', async () => {
        expect(await kindOnDisk(store, FIXTURE_PROJECT_ID, worktree, 'src/booking/weekend.ts')).toBe('file');
        expect(await kindOnDisk(store, FIXTURE_PROJECT_ID, PLACE, 'src/booking/weekend.ts')).toBeUndefined();
        expect(await kindOnDisk(store, FIXTURE_PROJECT_ID, worktree, '')).toBe('directory');
    });

    it('opens nothing in a worktree that is not made yet, and makes no file manager for it, which would keep the listing that failed', async () => {
        const waiting = { folder: FOLDER, workspace: { ...worktree.workspace!, ready: false } };

        expect(await openInFiles(store, FIXTURE_PROJECT_ID, waiting, 'README.md')).toBe(false);
        expect(await openInFiles(store, FIXTURE_PROJECT_ID, waiting, '')).toBe(false);
        expect(await kindOnDisk(store, FIXTURE_PROJECT_ID, waiting, '')).toBeUndefined();
        expect(ui().sidePanelOpen).toBe(false);
    });
});
