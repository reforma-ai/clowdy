// @vitest-environment happy-dom
import { reaction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { ListCursor } from '../../hotkeys/listCursor';
import { createRegistry } from '../../hotkeys/registry';
import { createUndoStack, type UndoStack } from '../../hotkeys/undo';
import { RootStore } from '../../stores';
import { openDocument } from '../files/openDocument';
import { filesStoreOf } from '../files/useFilesStore';
import { archiveTasks } from './archiveActions';
import { startTask } from './commands';
import { taskCommands, TASKS_SCOPE, type TaskCommandDeps } from './taskCommands';
import { sendWithUndo } from './taskUndo';
import { newestDocPath, runsByTask, startBlockedReason, taskGrid } from './taskView';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { Artifact, CommandResult, Task, TaskDetail } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { KeyValueStorage } from '../../stores/storage';

const toasts = vi.hoisted(() => {
    let count = 0;
    const next = () => `toast-${ ++count }`;

    return {
        error: vi.fn<(options: { message: string }) => void>(),
        show: vi.fn<(options: { message: string; action?: { label: string; onPress: () => void } }) => string>(next),
        success: vi.fn<(options: { message: string }) => string>(next),
        queue: { close: vi.fn<(key: string) => void>() },
    };
});

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The Tasks commands against a real RootStore and the fixture daemon, the way `Screen` wires them: the cursor follows the store's grid,
 * and the commands send what they send through `sendEach`. Checks what the project shows once the daemon's events have come in.
 * The fixture project (CAR-20 to CAR-37 on the board): done 20 21 22, review 23, active 24 25, todo 26 27, backlog 28, canceled 29, backlog 30, then the tree of
 * Payments: active 31 32, done 33, todo 34 35, review 36, canceled 37 (the archived CAR-38 to CAR-40 are not on the board).
 * In the list the tasks run in task order, so the cursor starts on CAR-20.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let root: RootStore;
let cursor: ListCursor;
let uninstall: () => void;
let stopFollowing: () => void;
let stack: UndoStack;
/** The daemon behind the store, for a change that does not come from the commands under test: an agent, another window. */
let daemon: FixtureTransport;
let pickers: PickerRequest[];
let confirms: OpenConfirmModalOptions[];
let titles: string[];
let sent: CommandInput[];
let copied: { text: string; message: string }[];
let notices: { message: string; tone?: 'info' | 'error' }[];
/** What the daemon answers for a task's results, by task id. A task not in it has none. */
let artifactsOf: Record<string, Artifact[]>;
/** Makes the daemon fail to answer for results. */
let resultsFail: boolean;

const settle = () => vi.advanceTimersByTimeAsync(0);
const project = () => root.selectedProject!;
const ui = () => root.ui.forProject(FIXTURE_PROJECT_ID);
const status = (taskId: string) => project().tasks.get(taskId)?.statusId;

/** Opens the Tasks screen's commands on a store whose transport records what it is asked to do and may refuse some of it. */
async function mount(refuse: (input: CommandInput) => string | undefined = () => undefined) {
    const base = new FixtureTransport();

    daemon = base;

    const transport: Transport = overrideTransport(base, {
        command: async (input) => {
            sent.push(input);

            const message = refuse(input);

            return message ? { ok: false, requestId: 'r', error: { code: 'invalid', message } } satisfies CommandResult : base.command(input);
        },
        getTaskDetail: async (taskId): Promise<TaskDetail> => {
            if (resultsFail) throw new Error('The daemon is not answering');

            return { ...(await base.getTaskDetail(taskId)), chatIds: [], runIds: [], artifacts: artifactsOf[taskId] ?? [] };
        },
    });

    stack = createUndoStack();
    root = new RootStore(transport, { storage: memoryStorage() });
    await root.load();
    await settle();
    ui().setTasksView('list');
    cursor = new ListCursor();
    cursor.setGrid(taskGrid('list', project().taskList, project().statuses));

    // `Screen` gives the cursor the grid again whenever the tasks change.
    stopFollowing = reaction(() => taskGrid('list', project().taskList, project().statuses), grid => cursor.setGrid(grid));

    // The window's state the commands navigate with: the real task selection, and a document opened where the real window opens it.
    const taskUi: TaskCommandDeps['ui'] = {
        get taskId() {
            return ui().taskId;
        },
        openTask: (...args) => ui().openTask(...args),
        openDoc: path => void openDocument(root, project(), path),
    };
    const deps: TaskCommandDeps = {
        cursor,
        ui: taskUi,
        hasTask: id => project().tasks.has(id),
        view: () => 'list',
        setView: view => ui().setTasksView(view),
        scope: () => null,
        isArchive: () => false,
        rows: () => [],
        setFolded: () => undefined,
        openScope: () => undefined,
        goUp: () => undefined,
        canHaveChildren: () => true,
        focusZone: () => 'list',
        isCursorFocused: () => true,
        revealCursor: () => undefined,
        tasks: () => project().taskList,
        statuses: () => project().statuses,
        startBlocked: id => startBlockedReason(runsByTask(project().runTaskLinks.values(), project().runs).get(id)),
        send: inputs => sendWithUndo(root, project(), inputs, stack),
        undo: { canUndo: () => stack.canUndo(FIXTURE_PROJECT_ID), undoLatest: () => stack.undoLatest(FIXTURE_PROJECT_ID) },
        archive: tasks => archiveTasks({ root, project: project(), ui: ui(), confirm: options => confirms.push(options), stack }, tasks),
        start: id => startTask(root, id),
        openPicker: request => pickers.push(request),
        confirm: options => confirms.push(options),
        focusTitle: id => titles.push(id),
        create: () => undefined,
        openFilter: () => undefined,
        focusSearch: () => undefined,
        openChat: chatId => ui().openChat(chatId),
        chatsOf: id => project().chatsOfTask(id),
        docPathOf: async id => newestDocPath((await root.transport.getTaskDetail(id)).artifacts),
        copy: (text, message) => copied.push({ text, message }),
        notify: (message, tone) => notices.push({ message, tone }),
        replacing: change => root.history.replacing(change),
    };
    const registry = createRegistry('darwin');

    registry.pushScope(TASKS_SCOPE);
    taskCommands(deps).forEach(command => registry.defineCommand(command));
    uninstall = installDispatcher(registry);
}

function press(key: string, init: KeyboardEventInit = {}, target: Element = document.body) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

/** Puts the cursor on a task and waits for nothing: the cursor is local state. */
const goTo = (taskId: string) => cursor.setCursor(taskId);

beforeEach(() => {
    vi.useFakeTimers();
    pickers = [];
    confirms = [];
    titles = [];
    sent = [];
    copied = [];
    notices = [];
    artifactsOf = {};
    resultsFail = false;
    toasts.error.mockClear();
    toasts.show.mockClear();
    toasts.success.mockClear();
    toasts.queue.close.mockClear();
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall();
    stopFollowing();
    filesStoreOf(root).dispose();
    root.dispose();
    vi.useRealTimers();
});

describe('Change status', () => {
    it('lists the project\'s statuses in workflow order and marks the status of the cursor task', async () => {
        await mount();
        goTo('t-24');
        press('s');

        expect(pickers[0].options.map(option => option.label)).toEqual(['Backlog', 'To do', 'In progress', 'Review', 'Done', 'Canceled']);
        expect(pickers[0].selectedIds).toEqual(['active']);
    });

    it('moves the cursor task, and the project shows it once the daemon has said so', async () => {
        await mount();
        goTo('t-28');
        press('s');
        pickers[0].onPick('review');
        await settle();

        expect(status('t-28')).toBe('review');
        expect(sent).toEqual([{ type: 'task.update', taskId: 't-28', statusId: 'review' }]);
    });

    it('moves every selected task, in the order of the list, and not the ones that are already there', async () => {
        await mount();
        goTo('t-24');
        press('x');
        goTo('t-25');
        press('x');
        goTo('t-27');
        press('x');
        press('s');

        expect(pickers[0].selectedIds).toEqual([]);

        pickers[0].onPick('active');
        await settle();

        expect(sent).toEqual([{ type: 'task.update', taskId: 't-27', statusId: 'active' }]);
        expect(['t-24', 't-25', 't-27'].map(status)).toEqual(['active', 'active', 'active']);
    });

    it('applies what the daemon accepted and says once what it refused', async () => {
        await mount(input => (input.type === 'task.update' && input.taskId === 't-27' ? 'CAR-27 cannot move to Done while CAR-24 is open.' : undefined));
        goTo('t-26');
        press('x');
        goTo('t-27');
        press('x');
        goTo('t-28');
        press('x');
        press('s');
        pickers[0].onPick('done');
        await settle();

        expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['done', 'todo', 'done']);
        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(toasts.error).toHaveBeenCalledWith({ message: '1 of 3 changes failed: CAR-27 cannot move to Done while CAR-24 is open.' });
    });
});

describe('Next and previous status', () => {
    it('moves a card one status along the workflow in either direction', async () => {
        await mount();
        goTo('t-24');
        press('ArrowRight', { altKey: true });
        await settle();

        expect(status('t-24')).toBe('review');

        press('ArrowLeft', { altKey: true });
        await settle();

        expect(status('t-24')).toBe('active');

        press('ArrowLeft', { altKey: true });
        await settle();

        expect(status('t-24')).toBe('todo');
    });

    it('moves a selection, each task from its own status, and stops at the ends', async () => {
        await mount();
        goTo('t-28');
        press('x');
        goTo('t-29');
        press('x');
        press('ArrowRight', { altKey: true });
        await settle();

        // Backlog moves to To do; Canceled is the last status and stays.
        expect(status('t-28')).toBe('todo');
        expect(status('t-29')).toBe('canceled');
        expect(sent).toEqual([{ type: 'task.update', taskId: 't-28', statusId: 'todo' }]);
    });
});

describe('Blocked by and blocking', () => {
    it('adds a dependency and the project shows the full list', async () => {
        await mount();
        goTo('t-27');
        press('m');
        press('b');

        expect(pickers[0].selectedIds).toEqual(['t-24']);

        pickers[0].onPick('t-25');
        await settle();

        expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24', 't-25']);
        expect(sent).toEqual([{ type: 'task.update', taskId: 't-27', dependsOn: ['t-24', 't-25'] }]);
    });

    it('removes a dependency that is there', async () => {
        await mount();
        goTo('t-26');
        press('m');
        press('b');
        pickers[0].onPick('t-24');
        await settle();

        expect(project().tasks.get('t-26')?.dependsOn).toEqual(['t-25']);
    });

    it('"blocking" adds the cursor task to the picked task\'s list, and takes it out again', async () => {
        await mount();
        goTo('t-28');
        press('m');
        press('x');
        pickers[0].onPick('t-27');
        await settle();

        expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24', 't-28']);

        press('m');
        press('x');

        expect(pickers[1].selectedIds).toEqual(['t-27']);

        pickers[1].onPick('t-27');
        await settle();

        expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24']);
        expect(project().tasks.get('t-28')?.dependsOn).toEqual([]);
    });

    it('does not offer a task that would close a loop', async () => {
        await mount();
        goTo('t-21');
        press('m');
        press('x');

        // Only CAR-22 depends on CAR-21 directly. CAR-21 itself is never offered.
        const ids = pickers[0].options.map(option => option.id);

        expect(ids).not.toContain('t-21');
        expect(pickers[0].selectedIds).toEqual(['t-22']);

        goTo('t-26');
        press('m');
        press('b');

        expect(pickers[1].options.map(option => option.id)).not.toContain('t-26');
    });
});

describe('Rename and start', () => {
    it('opens the cursor task and asks for the title', async () => {
        await mount();
        goTo('t-23');
        press('R', { shiftKey: true });

        expect(ui().taskId).toBe('t-23');
        expect(titles).toEqual(['t-23']);
    });

    it('starts the cursor task through task.start, and is off while the run it made is working', async () => {
        await mount();
        goTo('t-22');
        press('Enter', { metaKey: true });
        await settle();

        expect(sent).toEqual([{ type: 'task.start', taskId: 't-22' }]);
        expect([...project().runTaskLinks.values()].some(link => link.taskId === 't-22' && link.relation === 'assigned')).toBe(true);

        press('Enter', { metaKey: true });
        await settle();

        expect(sent).toHaveLength(1);
    });

    it('starts only the cursor task when several are selected', async () => {
        await mount();
        goTo('t-20');
        press('x');
        goTo('t-22');
        press('x');
        press('Enter', { metaKey: true });
        await settle();

        expect(sent).toEqual([{ type: 'task.start', taskId: 't-22' }]);
    });

    it('does not offer Start for a task an agent is working on', async () => {
        await mount();

        const working = [...project().runTaskLinks.values()].find(link => link.relation === 'assigned' && project().runs.get(link.runId)?.status === 'running');

        expect(working).toBeDefined();

        goTo(working!.taskId);
        press('Enter', { metaKey: true });
        await settle();

        expect(sent).toEqual([]);
    });
});

describe('Delete', () => {
    it('asks once, then deletes every selected task and puts the cursor on the nearest one left', async () => {
        await mount();
        goTo('t-35');
        press('x');
        press('ArrowDown', { shiftKey: true });
        press('ArrowDown', { shiftKey: true });
        press('Backspace', { metaKey: true });

        expect(confirms).toHaveLength(1);
        expect(confirms[0].title).toBe('Delete 3 tasks?');
        expect(sent).toEqual([]);

        await confirms[0].onConfirm();
        await settle();

        expect(['t-35', 't-36', 't-37'].map(id => project().tasks.has(id))).toEqual([false, false, false]);
        expect(project().tasks.size).toBe(15);
        // The three were the last in the list: the cursor falls back to the one above them.
        expect(cursor.cursorId).toBe('t-34');
        expect(cursor.selected.size).toBe(0);
        expect(sent.map(input => input.type)).toEqual(['task.delete', 'task.delete', 'task.delete']);
    });

    it('moves the cursor to the neighbour of a deleted task in the middle of the list', async () => {
        await mount();
        goTo('t-24');
        press('Backspace', { metaKey: true });
        await confirms[0].onConfirm();
        await settle();

        expect(project().tasks.has('t-24')).toBe(false);
        expect(cursor.cursorId).toBe('t-25');
    });

    it('closes the panel when the open task is deleted', async () => {
        await mount();
        ui().openTask('t-25');
        goTo('t-25');
        press('Backspace', { metaKey: true });
        await confirms[0].onConfirm();
        await settle();

        expect(ui().taskId).toBeNull();
    });

    it('deletes what it can, says once what the daemon refused, and keeps the refused task selected', async () => {
        await mount(input => (input.type === 'task.delete' && input.taskId === 't-29' ? 'CAR-29 is linked to a running agent.' : undefined));
        goTo('t-28');
        press('x');
        press('ArrowDown', { shiftKey: true });
        press('ArrowDown', { shiftKey: true });
        press('Backspace', { metaKey: true });
        await confirms[0].onConfirm();
        await settle();

        expect(['t-28', 't-29', 't-30'].map(id => project().tasks.has(id))).toEqual([false, true, false]);
        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(toasts.error).toHaveBeenCalledWith({ message: '1 of 3 changes failed: CAR-29 is linked to a running agent.' });
        expect([...cursor.selected]).toEqual(['t-29']);
    });

    it('asks and sends nothing when the person does not agree', async () => {
        await mount();
        goTo('t-28');
        press('Backspace', { metaKey: true });
        await settle();

        expect(confirms).toHaveLength(1);
        expect(sent).toEqual([]);
        expect(project().tasks.has('t-28')).toBe(true);
    });
});

const docArtifact = (id: string, path: string | undefined, createdAt: number): Artifact => ({ id, projectId: FIXTURE_PROJECT_ID, kind: 'doc', title: id, ref: path ? { path } : {}, createdAt });

describe('Copy', () => {
    it('copies the key of the cursor task and says so', async () => {
        await mount();
        goTo('t-24');
        press('.', { metaKey: true });

        expect(copied).toEqual([{ text: 'CAR-24', message: 'Copied CAR-24' }]);
    });

    it('copies the titles of a selection, one per line in the order of the list, on the physical quote key', async () => {
        await mount();
        goTo('t-26');
        press('x');
        goTo('t-24');
        press('x');
        press('"', { metaKey: true, shiftKey: true, code: 'Quote' });

        expect(copied).toHaveLength(1);
        expect(copied[0].text.split('\n')).toEqual([project().tasks.get('t-24')!.title, project().tasks.get('t-26')!.title]);
        expect(copied[0].message).toBe('Copied 2 task titles');
    });
});

describe('Open the linked chat', () => {
    it('opens the newest chat that discusses the cursor task, in Agents', async () => {
        await mount();
        // CAR-28 is discussed in c-2 (four days ago) and now in c-4 (minutes ago).
        project().applyEvent({ cursor: project().cursor + 1, at: 0, projectId: FIXTURE_PROJECT_ID, data: { type: 'link.chatTask', link: { chatId: 'c-4', taskId: 't-28' }, present: true } });
        goTo('t-28');
        press('o');
        press('c');

        expect(project().chatsOfTask('t-28').map(chat => chat.id).sort()).toEqual(['c-2', 'c-4']);
        expect(ui().section).toBe('agents');
        expect(ui().chatId).toBe('c-4');
    });

    it('says so for a task no chat discusses, and leaves the window as it was', async () => {
        await mount();
        ui().openTask(null);
        goTo('t-30');
        press('o');
        press('c');

        expect(project().chatsOfTask('t-30')).toEqual([]);
        expect(ui().chatId).toBeNull();
        expect(notices).toEqual([{ message: 'CAR-30 has no chat yet', tone: undefined }]);
    });
});

describe('Open the latest document', () => {
    /** The paths open in the tabs of the main folder's file manager, which the Files and Docs tabs share. */
    const tabsOfFolder = (kind: 'files' | 'docs' = 'docs') => filesStoreOf(root).managerOf(FIXTURE_PROJECT_ID, project().project.folders[0].id, kind).tabs.documents.map(document => document.path);

    it('opens the newest document the daemon lists for the task, on the Docs tab', async () => {
        await mount();
        artifactsOf['t-23'] = [docArtifact('old', 'notes/old.md', 1), docArtifact('new', 'decisions/pricing.md', 9)];
        goTo('t-23');
        press('o');
        press('d');
        await settle();

        expect([ui().sidePanelOpen, ui().sidePanelTab]).toEqual([true, 'docs']);
        expect(tabsOfFolder()).toEqual(['.clowdy/docs/decisions/pricing.md']);
        expect(notices).toEqual([]);
    });

    it('says so when the task has no document, and stays where it is', async () => {
        await mount();
        goTo('t-23');
        press('o');
        press('d');
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
        expect(notices).toEqual([{ message: 'CAR-23 has no document yet', tone: undefined }]);
    });

    it('says that the results did not load when the daemon fails', async () => {
        await mount();
        resultsFail = true;
        goTo('t-23');
        press('o');
        press('d');
        await settle();

        expect(ui().sidePanelOpen).toBe(false);
        expect(notices).toEqual([{ message: 'Could not load the results of CAR-23: The daemon is not answering', tone: 'error' }]);
    });

    it('opens the document of the task the key was pressed on, even when the cursor moves while the daemon answers', async () => {
        await mount();
        artifactsOf['t-23'] = [docArtifact('a', 'decisions/pricing.md', 1)];
        goTo('t-23');
        press('o');
        press('d');
        goTo('t-24');
        await settle();

        expect(tabsOfFolder()).toEqual(['.clowdy/docs/decisions/pricing.md']);
    });
});

describe('The open task and the cursor', () => {
    it('follows the cursor while a task is open, however far the cursor goes', async () => {
        await mount();
        ui().openTask('t-20');
        goTo('t-20');
        press('j');
        press('j');
        press('ArrowDown');
        press('End');

        expect(ui().taskId).toBe('t-37');
    });

    it('opens the task under the cursor on Enter, and the following of the cursor goes on from there', async () => {
        await mount();
        press('Enter');

        expect(ui().taskId).toBe('t-20');

        press('j');
        press('j');

        expect(ui().taskId).toBe('t-22');
    });
});

describe('Undo', () => {
    /** Cmd+Z, and whether a command took the key. */
    function undoKey(): boolean {
        const event = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true });

        document.body.dispatchEvent(event);

        return event.defaultPrevented;
    }

    /** The toast that offers the undo of the latest change. */
    const offer = () => toasts.show.mock.calls.at(-1)![0];

    /** An agent or another window changes a task through the daemon, and the project shows it once the event comes in. */
    async function changedElsewhere(taskId: string, changes: Partial<Pick<Task, 'title' | 'description' | 'statusId' | 'dependsOn'>>) {
        await daemon.command({ type: 'task.update', taskId, ...changes });
        await settle();
    }

    /** Selects the tasks, which the keys then act on together. */
    function select(...taskIds: string[]) {
        for (const taskId of taskIds) {
            goTo(taskId);
            press('x');
        }
    }

    describe('a status change', () => {
        it('goes back with Cmd+Z after a pick, and the toast named it and offered the undo', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();

            expect(status('t-28')).toBe('review');
            expect(toasts.show).toHaveBeenCalledTimes(1);
            expect(offer()).toEqual({ message: 'CAR-28 moved to Review', timeout: 5000, action: { label: 'Undo', onPress: expect.any(Function) } });

            expect(undoKey()).toBe(true);
            await settle();

            expect(status('t-28')).toBe('backlog');
            expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-28', statusId: 'backlog' });
            expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: CAR-28 moved to Review' });
        });

        it('goes back when the toast\'s Undo is pressed, and then there is nothing left for the key', async () => {
            await mount();
            goTo('t-24');
            press('ArrowRight', { altKey: true });
            await settle();

            expect(status('t-24')).toBe('review');

            offer().action!.onPress();
            await settle();

            expect(status('t-24')).toBe('active');
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
            expect(undoKey()).toBe(false);
            expect(sent).toHaveLength(2);
        });

        it('takes one undo per Alt+Arrow, latest first, and each one finds the task as the one before left it', async () => {
            await mount();
            goTo('t-24');
            press('ArrowRight', { altKey: true });
            await settle();
            press('ArrowRight', { altKey: true });
            await settle();

            expect(status('t-24')).toBe('done');

            undoKey();
            await settle();

            expect(status('t-24')).toBe('review');

            undoKey();
            await settle();

            expect(status('t-24')).toBe('active');
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        });

        it('takes a quick second change\'s toast in place of the first one\'s instead of stacking them', async () => {
            await mount();
            goTo('t-24');
            press('ArrowRight', { altKey: true });
            await settle();

            const first = toasts.show.mock.results[0].value;

            press('ArrowRight', { altKey: true });
            await settle();

            expect(toasts.show).toHaveBeenCalledTimes(2);
            expect(toasts.queue.close).toHaveBeenCalledWith(first);
            expect(offer().message).toBe('CAR-24 moved to Done');
        });

        it('is one entry and one toast for a whole selection, which Cmd+Z puts back task by task', async () => {
            await mount();
            select('t-26', 't-27', 't-28');
            press('s');
            pickers[0].onPick('review');
            await settle();

            expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['review', 'review', 'review']);
            expect(stack.entries).toHaveLength(1);
            expect(toasts.show).toHaveBeenCalledTimes(1);
            expect(offer().message).toBe('3 tasks moved to Review');

            undoKey();
            await settle();

            expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['todo', 'todo', 'backlog']);
            expect(sent.slice(3)).toEqual([
                { type: 'task.update', taskId: 't-26', statusId: 'todo' },
                { type: 'task.update', taskId: 't-27', statusId: 'todo' },
                { type: 'task.update', taskId: 't-28', statusId: 'backlog' },
            ]);
            expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: 3 tasks moved to Review' });
        });

        it('does not name a status when a selection stepped to several', async () => {
            await mount();
            select('t-26', 't-28');
            press('ArrowRight', { altKey: true });
            await settle();

            // CAR-26 To do to In progress, CAR-28 Backlog to To do.
            expect(['t-26', 't-28'].map(status)).toEqual(['active', 'todo']);
            expect(offer().message).toBe('2 tasks moved');
        });

        it('records the tasks the daemon took, and puts back only those', async () => {
            await mount(input => (input.type === 'task.update' && input.taskId === 't-27' && input.statusId === 'done' ? 'CAR-27 cannot move to Done while CAR-24 is open.' : undefined));
            select('t-26', 't-27', 't-28');
            press('s');
            pickers[0].onPick('done');
            await settle();

            expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['done', 'todo', 'done']);
            expect(offer().message).toBe('2 tasks moved to Done');

            undoKey();
            await settle();

            expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['todo', 'todo', 'backlog']);
            expect(sent.slice(3).map(input => 'taskId' in input && input.taskId)).toEqual(['t-26', 't-28']);
        });
    });

    describe('a change that was not made', () => {
        it('records nothing and offers nothing when the daemon refuses it, and Cmd+Z is left alone', async () => {
            await mount(() => 'No');
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();

            expect(status('t-28')).toBe('backlog');
            expect(toasts.error).toHaveBeenCalledWith({ message: 'No' });
            expect(toasts.show).not.toHaveBeenCalled();
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
            expect(undoKey()).toBe(false);
        });

        it('records nothing at the end of the workflow, where Alt+Arrow does nothing', async () => {
            await mount();
            goTo('t-29');
            press('ArrowRight', { altKey: true });
            await settle();

            expect(sent).toEqual([]);
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        });

        it('records nothing for a delete, which has no way back, and nothing for a start', async () => {
            await mount();
            goTo('t-30');
            press('Backspace', { metaKey: true });
            await confirms[0].onConfirm();
            await settle();

            expect(project().tasks.has('t-30')).toBe(false);

            goTo('t-22');
            press('Enter', { metaKey: true });
            await settle();

            expect(sent.map(input => input.type)).toEqual(['task.delete', 'task.start']);
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
            expect(toasts.show).not.toHaveBeenCalled();
        });
    });

    describe('dependencies', () => {
        it('puts back the whole previous list after "blocked by", whether it added or removed', async () => {
            await mount();
            goTo('t-27');
            press('m');
            press('b');
            pickers[0].onPick('t-25');
            await settle();

            expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24', 't-25']);
            expect(offer().message).toBe('Dependencies of CAR-27 changed');

            undoKey();
            await settle();

            expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24']);
            expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-27', dependsOn: ['t-24'] });

            goTo('t-26');
            press('m');
            press('b');
            pickers[1].onPick('t-24');
            await settle();

            expect(project().tasks.get('t-26')?.dependsOn).toEqual(['t-25']);

            undoKey();
            await settle();

            expect(project().tasks.get('t-26')?.dependsOn).toEqual(['t-24', 't-25']);
        });

        it('puts back the list of the task that got the link after "blocking", which is not the cursor task', async () => {
            await mount();
            goTo('t-28');
            press('m');
            press('x');
            pickers[0].onPick('t-27');
            await settle();

            expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24', 't-28']);
            expect(offer().message).toBe('Dependencies of CAR-27 changed');

            undoKey();
            await settle();

            expect(project().tasks.get('t-27')?.dependsOn).toEqual(['t-24']);
            expect(project().tasks.get('t-28')?.dependsOn).toEqual([]);
        });
    });

    describe('a task that changed since', () => {
        it('is not overwritten: the person is told, nothing is sent, and the entry and its offer are gone', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();

            const offered = toasts.show.mock.results[0].value;

            await changedElsewhere('t-28', { statusId: 'done' });
            sent.length = 0;

            undoKey();
            await settle();

            expect(status('t-28')).toBe('done');
            expect(sent).toEqual([]);
            expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-28 changed since, so this cannot be undone' });
            expect(toasts.success).not.toHaveBeenCalled();
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
            // No "Undone" toast closes it on this path, and a button whose entry is gone must not stay on the screen.
            expect(toasts.queue.close).toHaveBeenCalledWith(offered);
        });

        it('leaves a field that changed since but was not part of the change, and still puts back the one the change set', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            await changedElsewhere('t-28', { dependsOn: ['t-20'] });

            offer().action!.onPress();
            await settle();

            expect(status('t-28')).toBe('backlog');
            expect(project().tasks.get('t-28')?.dependsOn).toEqual(['t-20']);
            expect(toasts.error).not.toHaveBeenCalled();
        });

        it('is not overwritten when the undo comes from the toast\'s button either', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            await changedElsewhere('t-28', { statusId: 'active' });
            sent.length = 0;
            offer().action!.onPress();
            await settle();

            expect(sent).toEqual([]);
            expect(status('t-28')).toBe('active');
            expect(toasts.error).toHaveBeenCalledTimes(1);
        });

        it('is told about when the task is gone', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            await daemon.command({ type: 'task.delete', taskId: 't-28' });
            await settle();
            sent.length = 0;
            undoKey();
            await settle();

            expect(sent).toEqual([]);
            expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-28 changed since, so this cannot be undone' });
        });

        it('puts back the tasks of a selection that are as the change left them, and says which were not', async () => {
            await mount();
            select('t-26', 't-27', 't-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            await changedElsewhere('t-27', { statusId: 'done' });
            sent.length = 0;

            undoKey();
            await settle();

            expect(['t-26', 't-27', 't-28'].map(status)).toEqual(['todo', 'done', 'backlog']);
            expect(sent.map(input => 'taskId' in input && input.taskId)).toEqual(['t-26', 't-28']);
            expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-27 changed since and was left as it is' });
            // Not all of it is undone, so there is no "Undone" to claim.
            expect(toasts.success).not.toHaveBeenCalled();
        });

        it('says how many when a whole selection changed', async () => {
            await mount();
            select('t-26', 't-27');
            press('s');
            pickers[0].onPick('review');
            await settle();
            await changedElsewhere('t-26', { statusId: 'done' });
            await changedElsewhere('t-27', { statusId: 'done' });
            sent.length = 0;

            undoKey();
            await settle();

            expect(sent).toEqual([]);
            expect(toasts.error).toHaveBeenCalledWith({ message: '2 tasks changed since, so this cannot be undone' });
        });
    });

    describe('a refused undo', () => {
        it('shows the daemon\'s own message, leaves the task as it is, and drops the entry', async () => {
            let refusing = false;

            await mount(() => (refusing ? 'CAR-28 cannot go back to Backlog.' : undefined));
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            refusing = true;
            undoKey();
            await settle();

            expect(status('t-28')).toBe('review');
            expect(toasts.error).toHaveBeenCalledTimes(1);
            expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-28 cannot go back to Backlog.' });
            expect(toasts.success).not.toHaveBeenCalled();
            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        });
    });

    describe('what an undo is not', () => {
        it('is not a change of its own: it records nothing, so there is no redo and no second toast offer', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();
            undoKey();
            await settle();

            expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
            expect(toasts.show).toHaveBeenCalledTimes(1);
            expect(undoKey()).toBe(false);
        });

        it('closes the offer of the change it took back, so the toast does not outlive its entry', async () => {
            await mount();
            goTo('t-28');
            press('s');
            pickers[0].onPick('review');
            await settle();

            const offered = toasts.show.mock.results[0].value;

            undoKey();
            await settle();

            expect(toasts.queue.close).toHaveBeenCalledWith(offered);
        });
    });
});
