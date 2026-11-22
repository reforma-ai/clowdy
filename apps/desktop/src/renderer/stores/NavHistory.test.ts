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
    const { section, chatId, taskId, runId, draft } = ui();
    const here = { agents: draft ? '@new-chat' : (runId ?? chatId), tasks: taskId }[section];

    return `${ root.selectedProjectId }/${ section }:${ here }`;
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

    it('records a section, a chat, a task and a run, and walks them back and forth', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().openChat('c-1');
        ui().openTask('t-24');
        ui().openRun('r-na-02');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/agents:r-na-02',
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

        ui().openRun('r-na-02');

        expect(place()).toBe('p-car/agents:r-na-02');
        expect(ui().draft).toBe(false);

        root.history.back();
        expect(place()).toBe('p-car/agents:@new-chat');
        root.history.back();
        expect(place()).toBe('p-car/agents:c-1');
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

        root.ui.showSection(ui(), 'tasks');

        expect(root.ui.settingsOpen).toBe(false);
        expect(place()).toBe('p-car/tasks:null');

        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        expect(root.history.canGoBack).toBe(false);

        root.history.forward();
        expect(place()).toBe('p-car/tasks:null');

        root.ui.openSettings('skills');
        root.history.back();
        expect(root.ui.settingsOpen).toBe(false);
        expect(place()).toBe('p-car/agents:null');
    });

    it('records the selected project, and the place each project was left on comes back with it', () => {
        ui().openTask('t-24');
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
        root.ui.openSettings('appearance');
        root.ui.showSection(ui(), 'tasks');
        root.selectProject(FIXTURE_PROJECT_ID);

        expect(place()).toBe('p-car/tasks:t-24');

        const stops = [place()];

        while (root.history.canGoBack) {
            root.history.back();
            stops.push(place());
        }

        expect(stops).toEqual([
            'p-car/tasks:t-24',
            'p-clowdy/tasks:null',
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

        // Going back over a project change applies several fields at once, and still leaves the entries as they were.
        root.history.forward();
        root.selectProject(FIXTURE_EMPTY_PROJECT_ID);
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

        root.ui.showSection(ui(), 'tasks');

        expect(root.history.canGoForward).toBe(false);
        root.history.back();
        expect(place()).toBe('p-car/agents:null');
    });

    it('does not record the view options: the Tasks view', () => {
        ui().setTasksView('list');
        ui().setTasksView('board');

        expect(root.history.canGoBack).toBe(false);

        ui().openTask('t-24');
        ui().setTasksView('list');

        expect(stepsBack()).toBe(1);
    });

    it('records the scope of the Tasks screen as part of the place, and back and forward bring it back', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        ui().setTasksScope('t-32');
        ui().setTasksScope(null);

        expect(stepsBack()).toBe(4);
        expect(ui().tasksScope).toBeNull();
        expect(ui().section).toBe('agents');

        root.history.forward();
        root.history.forward();
        expect([ui().section, ui().tasksScope]).toEqual(['tasks', 't-31']);

        root.history.forward();
        expect(ui().tasksScope).toBe('t-32');

        root.history.back();
        expect(ui().tasksScope).toBe('t-31');
    });

    it('records the scope together with the open task, as one place', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        ui().openTask('t-32');
        ui().setTasksScope('t-32');
        root.history.back();

        expect([ui().tasksScope, ui().taskId]).toEqual(['t-31', 't-32']);

        root.history.back();
        expect([ui().tasksScope, ui().taskId]).toEqual(['t-31', null]);
    });

    it('records a task opened from outside the scope with the scope it moved to, as one place, and back returns to the place it left', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-32');
        // CAR-24 is a root: a chip in a chat opens it, and the screen shows the roots with it.
        ui().openTask('t-24');

        expect([ui().tasksScope, ui().taskId]).toEqual([null, 't-24']);

        root.history.back();

        expect([ui().section, ui().tasksScope, ui().taskId]).toEqual(['tasks', 't-32', null]);

        root.history.forward();

        expect([ui().tasksScope, ui().taskId]).toEqual([null, 't-24']);
    });

    it('keeps one entry for a task opened inside the scope, whose folds open with it', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        ui().setTasksSubtasks(true);
        ui().toggleTaskCollapsed('t-32');
        ui().openTask('t-33');

        expect([ui().tasksScope, ui().taskId, ui().tasksCollapsed]).toEqual(['t-31', 't-33', []]);
        expect(stepsBack()).toBe(3);
    });

    it('does not record the options of a scope: the sub-tasks toggle, the page view and the folds', () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        ui().setTasksSubtasks(true);
        ui().setTaskPageView('list');
        ui().toggleTaskCollapsed('t-32');
        ui().setTasksSubtasks(false);

        expect(stepsBack()).toBe(2);
    });

    it('skips an entry whose scope is no longer on the board, as it skips a task that is gone', async () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        ui().setTasksScope('t-32');
        ui().setTasksScope(null);

        // Payments leaves the board with everything inside it: neither of its scopes is a place to go back to.
        await root.command({ type: 'task.archive', taskId: 't-31', cancel: true });
        await settle();

        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        expect(root.history.canGoBack).toBe(false);
    });

    it('keeps the place of the Tasks screen as the roots when the window leaves it by the rail while its scope is gone, so back returns to Tasks', async () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        root.ui.showSection(ui(), 'agents');

        // Payments is archived while the person is away. They come back by the rail: the screen shows the roots, and the remembered scope is left as it is.
        await root.command({ type: 'task.archive', taskId: 't-31', cancel: true });
        await settle();
        root.ui.showSection(ui(), 'tasks');
        expect(ui().resolveTasksScope(root.selectedProject!.tasks)).toBeNull();
        expect(ui().tasksScope).toBe('t-31');

        // Nothing has settled the scope when they leave by the rail again.
        root.ui.showSection(ui(), 'agents');
        root.history.back();

        expect([ui().section, ui().tasksScope]).toEqual(['tasks', null]);

        root.history.forward();
        expect(ui().section).toBe('agents');
    });

    it('leaves the scope of an entry alone while it is on the board when the window moves on', async () => {
        root.ui.showSection(ui(), 'tasks');
        ui().setTasksScope('t-31');
        root.ui.showSection(ui(), 'agents');

        root.history.back();

        expect([ui().section, ui().tasksScope]).toEqual(['tasks', 't-31']);
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

    describe('an archived task', () => {
        it('is a place to go back and forward to once the window has read it, and is skipped when it was not read', async () => {
            const project = root.selectedProject!;

            ui().openTask('t-24');
            // The window read CAR-38 (a dependency row, the archive view): it is opened, then another task.
            await project.readTask('t-38');
            ui().openTask('t-38');
            ui().openTask('t-26');

            root.history.back();
            expect(place()).toBe('p-car/tasks:t-38');
            root.history.back();
            expect(place()).toBe('p-car/tasks:t-24');
            root.history.forward();
            expect(place()).toBe('p-car/tasks:t-38');

            // An archived task the window has not read cannot be told from a task that is gone.
            ui().openTask('t-39');
            ui().openTask('t-25');
            root.history.back();
            expect(place()).toBe('p-car/tasks:t-38');
        });

        it('stops being one when it is deleted, and stays one when it is restored, now as a task of the board', async () => {
            const project = root.selectedProject!;

            await project.readTask('t-38');
            await project.readTask('t-40');
            ui().openTask('t-38');
            ui().openTask('t-40');
            ui().openTask('t-24');

            expect((await root.command({ type: 'task.unarchive', taskId: 't-38' })).ok).toBe(true);
            expect((await root.command({ type: 'task.delete', taskId: 't-40' })).ok).toBe(true);
            await settle();

            root.history.back();
            expect(place()).toBe('p-car/tasks:t-38');
        });
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
        ui().openTask('t-24');
        await remove({ type: 'chat.delete', chatId: 'c-2' });

        // The Tasks entry carries `chatId: 'c-2'` along, which the Tasks screen does not show.
        root.history.back();
        expect(place()).toBe('p-car/agents:null');
        root.history.forward();
        expect(place()).toBe('p-car/tasks:t-24');
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

        store.ui.showSection(store.ui.forProject(project.id), 'tasks');
        expect(store.history.canGoBack).toBe(true);
        store.history.back();
        expect(store.ui.forProject(project.id).section).toBe('agents');
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
