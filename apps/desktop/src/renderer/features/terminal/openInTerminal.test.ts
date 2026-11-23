// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { TransportError } from '../../daemon/transport';
import { RootStore } from '../../stores';
import { openInTerminal } from './openInTerminal';
import { terminalsStoreOf } from './useTerminalsStore';

import type { Place } from '../sidePanel/currentPlace';

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

// The Car Rental project's only folder.
const FOLDER = { id: 'fld_car_rental', path: '/Users/dev/car-rental' };
const PLACE: Place = { folder: FOLDER };

let store: RootStore;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
const shells = () => terminalsStoreOf(store.transport).sessionsOf(FIXTURE_PROJECT_ID, FOLDER.id);

beforeEach(async () => {
    // The side panel's state is kept in the browser's storage and comes back with it: a test starts with the panel shut.
    localStorage.clear();
    toasts.error.mockClear();
    store = new RootStore(new FixtureTransport());
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
});

afterEach(() => {
    terminalsStoreOf(store.transport).dispose();
    store.dispose();
    localStorage.clear();
});

describe('opening a folder in the Terminal tab', () => {
    it('starts a shell in the folder, chooses it, and shows the panel on its Terminal tab', async () => {
        expect(ui().sidePanelOpen).toBe(false);
        expect(await openInTerminal(store, FIXTURE_PROJECT_ID, PLACE, '')).toBe(true);

        expect(shells()).toHaveLength(1);
        expect(shells()[0]!.info.cwd).toBe(FOLDER.path);
        expect(terminalsStoreOf(store.transport).activeOf(FIXTURE_PROJECT_ID, FOLDER.id)).toBe(shells()[0]);
        expect(ui().sidePanelOpen).toBe(true);
        expect(ui().sidePanelTab).toBe('terminal');
    });

    it('starts it in a folder below the project folder', async () => {
        expect(await openInTerminal(store, FIXTURE_PROJECT_ID, PLACE, 'src/booking')).toBe(true);

        expect(shells()[0]!.info.cwd).toBe(`${FOLDER.path}/src/booking`);
    });

    it('is a new shell each time, the last one chosen, and the ones the daemon already ran are kept', async () => {
        const { transport } = store;
        const made = await transport.createTerminal({
            projectId: FIXTURE_PROJECT_ID,
            folderId: FOLDER.id,
            cols: 80,
            rows: 24,
        });

        await openInTerminal(store, FIXTURE_PROJECT_ID, PLACE, '');
        await openInTerminal(store, FIXTURE_PROJECT_ID, PLACE, 'src');

        expect(shells().map(shell => shell.id)).toContain(made.id);
        expect(shells()).toHaveLength(3);
        expect(terminalsStoreOf(transport).activeOf(FIXTURE_PROJECT_ID, FOLDER.id)?.info.cwd).toBe(
            `${FOLDER.path}/src`
        );
    });

    it('says why in a toast, and leaves the panel as it was, when no shell could be started', async () => {
        const failing = overrideTransport(store.transport, {
            createTerminal: async () => Promise.reject(new TransportError('The folder is missing on the disk', 503)),
        });
        const broken = new RootStore(failing);

        await broken.load();
        broken.selectProject(FIXTURE_PROJECT_ID);

        expect(await openInTerminal(broken, FIXTURE_PROJECT_ID, PLACE, '')).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({
            title: 'Couldn’t start a terminal',
            message: 'The folder is missing on the disk',
        });
        expect(broken.ui.forProject(FIXTURE_PROJECT_ID).sidePanelOpen).toBe(false);
        terminalsStoreOf(failing).dispose();
        broken.dispose();
    });
});

describe('opening a worktree in the Terminal tab', () => {
    const WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';
    let worktree: Place;

    beforeEach(async () => {
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }));
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        worktree = {
            folder: FOLDER,
            workspace: store.selectedProject!.chats.get(FIXTURE_WORKSPACE_CHAT_ID)!.workspace!,
        };
    });

    it("starts the shell in the worktree, below it for a folder of it, chooses it and shows the tab, and leaves the folder's own checkout without one", async () => {
        const terminals = terminalsStoreOf(store.transport);

        expect(await openInTerminal(store, FIXTURE_PROJECT_ID, worktree, '')).toBe(true);
        expect(await openInTerminal(store, FIXTURE_PROJECT_ID, worktree, 'src/booking')).toBe(true);

        const inside = terminals.sessionsOf(FIXTURE_PROJECT_ID, FOLDER.id, worktree.workspace!.id);

        expect(inside.map(shell => shell.info.cwd)).toEqual([WORKTREE, `${WORKTREE}/src/booking`]);
        expect(terminals.activeOf(FIXTURE_PROJECT_ID, FOLDER.id, worktree.workspace!.id)).toBe(inside[1]);
        expect(terminals.sessionsOf(FIXTURE_PROJECT_ID, FOLDER.id)).toEqual([]);
        expect(ui().sidePanelTab).toBe('terminal');
    });

    it('says the worktree is not made yet, starts nothing and leaves the panel as it was, for a worktree that is not', async () => {
        const waiting = { folder: FOLDER, workspace: { ...worktree.workspace!, ready: false } };

        expect(await openInTerminal(store, FIXTURE_PROJECT_ID, waiting, '')).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({
            title: 'Couldn’t start a terminal',
            message: 'The worktree is not made yet',
        });
        expect(terminalsStoreOf(store.transport).sessions).toEqual([]);
        expect(ui().sidePanelOpen).toBe(false);
    });
});
