import { runInAction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_EMPTY_PROJECT_ID, FIXTURE_PROJECT_ID } from '../daemon/fixtureData';
import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { HISTORY_LIMIT } from './NavHistory';
import { RootStore } from './RootStore';

import type { ClowdyEvent } from '@clowdy/protocol';
import type { KeyValueStorage } from './storage';

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage {
    const data = { ...initial };

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

let root: RootStore;

async function readyRoot(storage = memoryStorage()): Promise<RootStore> {
    const store = new RootStore(new FixtureTransport(), { storage });

    await store.load();
    await settle();

    return store;
}

const ui = () => root.ui.forProject(root.selectedProjectId!);

/** Where the window is, in one comparable string: the project and the place. */
function place(): string {
    const { chatId, runId, draft } = ui();

    return `${ root.selectedProjectId }/${ draft ? '@new-chat' : (runId ?? chatId) }`;
}

/** Goes back until the start and returns how many steps it took. */
function stepsBack(): number {
    let steps = 0;

    while (root.history.canGoBack) {
        root.history.back();
        steps++;
    }

    return steps;
}

beforeEach(async () => {
    vi.useFakeTimers();
    root = await readyRoot();
});

afterEach(() => {
    root.dispose();
    vi.useRealTimers();
});

describe('NavHistory recording', () => {
    it('starts with the place the first project opens on, so there is nowhere to go yet', () => {
        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
        expect(root.history.canGoBack).toBe(false);
        expect(root.history.canGoForward).toBe(false);
    });

    it('records a chat and a run, and walks them back and forth', () => {
        ui().openChat('c-1');
        ui().openRun('r-na-02');
        ui().openChat('c-2');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/c-2',
            'p-car/r-na-02',
            'p-car/c-1',
            'p-car/null',
        ]);

        const forward = [place()];

        while (root.history.canGoForward) {
            root.history.forward();
            forward.push(place());
        }

        expect(forward).toEqual([...stops].reverse());
    });

    it('records the new-chat row as a place of its own, and leaves it by opening a chat or a run', () => {
        ui().openChat('c-1');
        ui().openDraft();

        expect(place()).toBe('p-car/@new-chat');

        ui().openRun('r-na-02');

        expect(place()).toBe('p-car/r-na-02');
        expect(ui().draft).toBe(false);

        root.history.back();
        expect(place()).toBe('p-car/@new-chat');
        root.history.back();
        expect(place()).toBe('p-car/c-1');
    });

    it('records the new-chat row of each folder as a place of its own, and brings its folder back', () => {
        ui().openDraft();
        ui().openDraft([], 'fld_other');

        expect(ui().draftFolderId).toBe('fld_other');

        ui().openChat('c-1');
        root.history.back();
        expect([ui().draft, ui().draftFolderId]).toEqual([true, 'fld_other']);

        root.history.back();
        expect([ui().draft, ui().draftFolderId]).toEqual([true, null]);

        root.history.forward();
        expect(ui().draftFolderId).toBe('fld_other');
    });

    it('does not record Settings, which is a window over a place and not one, and a step through the history shuts it', () => {
        root.ui.openSettings('providers');
        root.ui.showSettingsPage('skills');

        expect(root.history.canGoBack).toBe(false);

        ui().openChat('c-1');

        expect(place()).toBe('p-car/c-1');

        root.history.back();
        expect(place()).toBe('p-car/null');
        expect(root.history.canGoBack).toBe(false);

        root.history.forward();
        expect(place()).toBe('p-car/c-1');

        root.ui.openSettings('skills');
        root.history.back();
        expect(root.ui.settingsOpen).toBe(false);
        expect(place()).toBe('p-car/null');
    });

    it('records the selected project, and the place each project was left on comes back with it', () => {
        ui().openChat('c-1');
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.ui.openSettings('appearance');
        ui().openDraft();
        root.selectProject(FIXTURE_PROJECT_ID);

        expect(place()).toBe('p-car/c-1');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/c-1',
            'p-clowdy/@new-chat',
            'p-clowdy/null',
            'p-car/c-1',
            'p-car/null',
        ]);
        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        while (root.history.canGoForward) root.history.forward();

        expect(place()).toBe('p-car/c-1');
    });

    it('records nothing for going back or forward, so the way the other way stays open', () => {
        ui().openChat('c-1');
        ui().openChat('c-2');
        root.history.back();
        root.history.back();
        root.history.forward();

        expect(place()).toBe('p-car/c-1');
        expect(root.history.canGoBack).toBe(true);
        expect(root.history.canGoForward).toBe(true);

        // Going back over a project change applies several fields at once, and still leaves the entries as they were.
        root.history.forward();
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.history.back();
        expect(place()).toBe('p-car/c-2');
        expect(root.history.canGoForward).toBe(true);
        expect(stepsBack()).toBe(2);
    });

    it('drops the way forward when something new happens after going back', () => {
        ui().openChat('c-1');
        ui().openChat('c-2');
        root.history.back();
        root.history.back();
        expect(root.history.canGoForward).toBe(true);

        ui().openChat('c-3');

        expect(root.history.canGoForward).toBe(false);
        root.history.back();
        expect(place()).toBe('p-car/null');
    });

    it('does not record the view options: the Tasks view', () => {
        ui().setTasksView('list');
        ui().setTasksView('board');

        expect(root.history.canGoBack).toBe(false);

        ui().openChat('c-1');
        ui().setTasksView('list');

        expect(stepsBack()).toBe(1);
    });

    it('does not record the side panel or what it shows: the open task, the scope of the Tasks tab, the tab and its size', () => {
        ui().openTask('t-24');
        ui().setTasksScope('t-31');
        ui().openTask('t-32');
        ui().toggleSidePanelExpanded();
        ui().showSidePanelTab('files');
        ui().toggleSidePanel();

        expect(root.history.canGoBack).toBe(false);
    });

    it('does not record a change that leaves the place as it was', () => {
        ui().openChat(null);
        root.ui.showSettingsPage('skills');

        expect(root.history.canGoBack).toBe(false);
    });

    it('keeps the newest 100 entries', () => {
        for (let step = 0; step < 150; step++) ui().openChat(step % 2 === 0 ? 'c-1' : 'c-2');

        expect(stepsBack()).toBe(HISTORY_LIMIT - 1);
        // 150 changes ended on c-2; the oldest 51 entries fell off, so the start is the 51st change: c-1.
        expect(place()).toBe('p-car/c-1');
    });
});

describe('NavHistory entries that are gone', () => {
    const remove = async (command: Parameters<RootStore['command']>[0]) => {
        const result = await root.command(command);

        await settle();

        return result;
    };

    it('skips a deleted chat, and the run of that chat', async () => {
        ui().openChat('c-2');
        ui().openRun('r-orch-2');
        ui().openChat('c-1');

        expect((await remove({ type: 'chat.delete', chatId: 'c-2' })).ok).toBe(true);
        expect(root.selectedProject?.runs.has('r-orch-2')).toBe(false);

        root.history.back();
        expect(place()).toBe('p-car/null');
        expect(root.history.canGoBack).toBe(false);
        root.history.forward();
        expect(place()).toBe('p-car/c-1');
    });

    it('stays put when nothing ahead can be shown, and says so', async () => {
        ui().openChat('c-2');
        ui().openChat('c-4');
        root.history.back();
        root.history.back();
        await remove({ type: 'chat.delete', chatId: 'c-2' });
        await remove({ type: 'chat.delete', chatId: 'c-4' });

        expect(root.history.canGoForward).toBe(false);
        root.history.forward();
        expect(place()).toBe('p-car/null');
    });

    it('cannot tell what a project holds before its snapshot has arrived, and does not skip', async () => {
        const transport = new FixtureTransport();

        root.dispose();
        root = new RootStore(overrideTransport(transport, { getProjectSnapshot: () => new Promise(() => {}) }), { storage: memoryStorage() });
        await root.load();

        expect(root.selectedProject?.status).toBe('loading');

        ui().openChat('c-1');
        ui().openChat('c-9');
        root.history.back();

        expect(place()).toBe('p-car/c-1');
    });

    it('skips a project that is gone', () => {
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.history.back();

        expect(root.history.canGoForward).toBe(true);

        runInAction(() => {
            root.projects = root.projects.filter(project => project.id !== FIXTURE_EMPTY_PROJECT_ID);
        });

        expect(root.history.canGoForward).toBe(false);
        root.history.forward();
        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);
    });

    it('makes the buttons follow the data: a chat that goes changes what back can reach', async () => {
        ui().openChat('c-2');
        ui().openChat('c-4');
        root.history.back();
        root.history.back();
        expect(root.history.canGoForward).toBe(true);

        await remove({ type: 'chat.delete', chatId: 'c-4' });
        expect(root.history.canGoForward).toBe(true);

        await remove({ type: 'chat.delete', chatId: 'c-2' });
        expect(root.history.canGoForward).toBe(false);
    });

});

describe('NavHistory at the start', () => {
    it('records nothing while there is no project, and takes the first one as its first entry', async () => {
        const store = new RootStore(new FixtureTransport({ data: { ...createFixtureData(), projects: [] } }), { storage: memoryStorage() });

        await store.load();
        store.ui.openSettings('skills');
        expect(store.selectedProjectId).toBeNull();
        expect(store.history.canGoBack).toBe(false);

        const project = createFixtureData().projects[0];
        const upsert: ClowdyEvent = { cursor: 7000, at: 0, projectId: project.id, data: { type: 'project.upserted', project, statuses: [] } };

        store.handleEvent(upsert);
        expect(store.selectedProjectId).toBe(project.id);
        expect(store.history.canGoBack).toBe(false);

        store.ui.forProject(project.id).openDraft();
        expect(store.history.canGoBack).toBe(true);
        store.history.back();
        expect(store.ui.forProject(project.id).draft).toBe(false);
        store.dispose();
    });

    it('is not fed by loading again after a retry, or by the project the app showed last time', async () => {
        const storage = memoryStorage({ 'clowdy:selected-project': JSON.stringify(FIXTURE_EMPTY_PROJECT_ID) });
        const store = new RootStore(new FixtureTransport(), { storage });

        await store.load();
        await settle();
        await store.load();
        await settle();

        expect(store.selectedProjectId).toBe(FIXTURE_EMPTY_PROJECT_ID);
        expect(store.history.canGoBack).toBe(false);
        store.dispose();
    });

    it('is not fed by events of the daemon that change the data and not the place', async () => {
        await root.command({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: 'Write the release notes' });
        await root.command({ type: 'chat.rename', chatId: 'c-1', title: 'Renamed' });
        await settle();

        expect(root.history.canGoBack).toBe(false);
    });
});
