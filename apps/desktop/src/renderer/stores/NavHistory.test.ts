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

/** Where the window is, in one comparable string: the project and the place, or Settings over it. */
function place(): string {
    const { section, chatId, taskId, runId, docPath, draft } = ui();
    const here = { agents: draft ? '@new-chat' : (runId ?? chatId), tasks: taskId, docs: docPath }[section];

    return `${ root.selectedProjectId }/${ root.ui.settingsOpen ? `settings:${ root.ui.settingsPage }` : `${ section }:${ here }` }`;
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

    it('records a section, a chat, a task, a run and a document, and walks them back and forth', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().openChat('c-1');
        ui().openTask('t-24');
        ui().openRun('r-ex-07');
        ui().openDoc('decisions/pricing.md');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/docs:decisions/pricing.md',
            'p-car/agents:r-ex-07',
            'p-car/tasks:t-24',
            'p-car/agents:c-1',
            'p-car/tasks:null',
            'p-car/agents:null',
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

        expect(place()).toBe('p-car/agents:@new-chat');

        ui().openRun('r-ex-07');

        expect(place()).toBe('p-car/agents:r-ex-07');
        expect(ui().draft).toBe(false);

        root.history.back();
        expect(place()).toBe('p-car/agents:@new-chat');
        root.history.back();
        expect(place()).toBe('p-car/agents:c-1');
    });

    it('records Settings and its pages', () => {
        root.ui.openSettings('engine');
        root.ui.showSettingsPage('skills');
        root.ui.showSection(ui(), 'tasks');

        expect(place()).toBe('p-car/tasks:null');

        root.history.back();
        expect(place()).toBe('p-car/settings:skills');
        root.history.back();
        expect(place()).toBe('p-car/settings:engine');
        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        expect(root.history.canGoBack).toBe(false);

        root.history.forward();
        root.history.forward();
        root.history.forward();
        expect(place()).toBe('p-car/tasks:null');
        expect(root.ui.settingsOpen).toBe(false);
    });

    it('records the selected project, and the place each project was left on comes back with it', () => {
        ui().openTask('t-24');
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.ui.openSettings('appearance');
        root.ui.showSection(ui(), 'docs');
        root.selectProject(FIXTURE_PROJECT_ID);

        expect(place()).toBe('p-car/tasks:t-24');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/tasks:t-24',
            'p-clowdy/docs:null',
            'p-clowdy/settings:appearance',
            'p-clowdy/agents:null',
            'p-car/tasks:t-24',
            'p-car/agents:null',
        ]);
        expect(root.selectedProjectId).toBe(FIXTURE_PROJECT_ID);

        while (root.history.canGoForward) root.history.forward();

        expect(place()).toBe('p-car/tasks:t-24');
    });

    it('records nothing for going back or forward, so the way the other way stays open', () => {
        ui().openTask('t-24');
        ui().openTask('t-25');
        root.history.back();
        root.history.back();
        root.history.forward();

        expect(place()).toBe('p-car/tasks:t-24');
        expect(root.history.canGoBack).toBe(true);
        expect(root.history.canGoForward).toBe(true);

        // Going back over a project change and out of Settings applies several fields at once, and still leaves the entries as they were.
        root.history.forward();
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.ui.openSettings('skills');
        root.history.back();
        root.history.back();
        expect(place()).toBe('p-car/tasks:t-25');
        expect(root.history.canGoForward).toBe(true);
        expect(stepsBack()).toBe(2);
    });

    it('drops the way forward when something new happens after going back', () => {
        ui().openTask('t-21');
        ui().openTask('t-22');
        root.history.back();
        root.history.back();
        expect(root.history.canGoForward).toBe(true);

        root.ui.showSection(ui(), 'docs');

        expect(root.history.canGoForward).toBe(false);
        root.history.back();
        expect(place()).toBe('p-car/agents:null');
    });

    it('does not record the view options: the Tasks view, the subthreads shown', () => {
        ui().setTasksView('list');
        ui().setShowFinished(false);
        ui().setShowSubthreads(false);
        ui().setTasksView('board');

        expect(root.history.canGoBack).toBe(false);

        ui().openTask('t-24');
        ui().setTasksView('list');
        ui().setShowFinished(true);
        ui().setShowSubthreads(true);

        expect(stepsBack()).toBe(1);
    });

    it('does not record a change that leaves the place as it was', () => {
        root.ui.showSection(ui(), 'agents');
        ui().openChat(null);
        root.ui.showSettingsPage('skills');

        expect(root.history.canGoBack).toBe(false);
    });

    it('keeps the newest 100 entries', () => {
        for (let step = 0; step < 150; step++) ui().openTask(step % 2 === 0 ? 't-21' : 't-22');

        expect(stepsBack()).toBe(HISTORY_LIMIT - 1);
        // 150 changes ended on t-22; the oldest 51 entries fell off, so the start is the 52nd change: t-21.
        expect(place()).toBe('p-car/tasks:t-21');
    });
});

describe('NavHistory.replacing', () => {
    it('overwrites the current entry, and the next change after it is a new entry', () => {
        ui().openTask('t-21');
        root.history.replacing(() => ui().openTask('t-22'));
        root.history.replacing(() => ui().openTask('t-23'));

        // One entry for the three, over the section it came from.
        expect(stepsBack()).toBe(1);
        expect(place()).toBe('p-car/agents:null');

        root.history.forward();
        expect(place()).toBe('p-car/tasks:t-23');

        ui().openTask('t-24');
        expect(stepsBack()).toBe(2);
    });

    it('is a normal change when nothing changed inside it, and does not leak into the next one', () => {
        root.history.replacing(() => {
            ui().openChat(null);
        });
        ui().openTask('t-21');
        ui().openTask('t-22');

        expect(stepsBack()).toBe(2);
    });

    it('keeps the entries ahead, as a browser does when it replaces the current one', () => {
        ui().openTask('t-21');
        ui().openTask('t-22');
        root.history.back();
        root.history.replacing(() => ui().openTask('t-23'));

        expect(place()).toBe('p-car/tasks:t-23');
        root.history.forward();
        expect(place()).toBe('p-car/tasks:t-22');
    });

    it('does not make back stand still when the replacement repeats the entry before it', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().openTask('t-21');
        root.history.replacing(() => ui().openTask(null));

        expect(place()).toBe('p-car/tasks:null');
        expect(stepsBack()).toBe(1);
        expect(place()).toBe('p-car/agents:null');
    });
});

describe('NavHistory entries that are gone', () => {
    const remove = async (command: Parameters<RootStore['command']>[0]) => {
        const result = await root.command(command);

        await settle();

        return result;
    };

    it('skips a deleted task in both directions', async () => {
        ui().openTask('t-24');
        ui().openTask('t-25');
        ui().openTask('t-26');

        expect((await remove({ type: 'task.delete', taskId: 't-25' })).ok).toBe(true);

        root.history.back();
        expect(place()).toBe('p-car/tasks:t-24');
        root.history.forward();
        expect(place()).toBe('p-car/tasks:t-26');
    });

    it('does not offer a place that is showing already: open a task, delete it, close the panel, and back does not stand still', async () => {
        root.ui.showSection(ui(), 'tasks');
        ui().openTask('t-24');
        await remove({ type: 'task.delete', taskId: 't-24' });
        ui().openTask(null);

        // The entry of the deleted task is gone, and the one before it shows what the window shows now.
        expect(stepsBack()).toBe(1);
        expect(place()).toBe('p-car/agents:null');

        root.history.forward();
        expect(place()).toBe('p-car/tasks:null');
        expect(root.history.canGoForward).toBe(false);
    });

    it('skips a deleted chat, and the run of that chat', async () => {
        ui().openChat('c-2');
        ui().openRun('r-orch-2');
        ui().openChat('c-1');

        expect((await remove({ type: 'chat.delete', chatId: 'c-2' })).ok).toBe(true);
        expect(root.selectedProject?.runs.has('r-orch-2')).toBe(false);

        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        expect(root.history.canGoBack).toBe(false);
        root.history.forward();
        expect(place()).toBe('p-car/agents:c-1');
    });

    it('does not skip a place because of a selection it remembers in another section', async () => {
        ui().openChat('c-2');
        ui().openDoc('decisions/pricing.md');
        await remove({ type: 'chat.delete', chatId: 'c-2' });

        // The Docs entry carries `chatId: 'c-2'` along, which Docs does not show.
        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        root.history.forward();
        expect(place()).toBe('p-car/docs:decisions/pricing.md');
    });

    it('stays put when nothing ahead can be shown, and says so', async () => {
        ui().openTask('t-24');
        ui().openTask('t-25');
        root.history.back();
        root.history.back();
        await remove({ type: 'task.delete', taskId: 't-24' });
        await remove({ type: 'task.delete', taskId: 't-25' });

        expect(root.history.canGoForward).toBe(false);
        root.history.forward();
        expect(place()).toBe('p-car/agents:null');
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

        expect(place()).toBe('p-car/agents:c-1');
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

    it('makes the buttons follow the data: a task that appears or goes changes what back can reach', async () => {
        ui().openTask('t-24');
        ui().openTask('t-25');
        ui().openTask('t-26');
        root.history.back();
        root.history.back();
        root.history.back();
        expect(root.history.canGoForward).toBe(true);

        await remove({ type: 'task.delete', taskId: 't-24' });
        await remove({ type: 'task.delete', taskId: 't-25' });
        await remove({ type: 'task.delete', taskId: 't-26' });

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

        store.ui.showSection(store.ui.forProject(project.id), 'docs');
        expect(store.history.canGoBack).toBe(true);
        store.history.back();
        expect(store.ui.settingsOpen).toBe(true);
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
