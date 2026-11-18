// @vitest-environment happy-dom
import { reaction } from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { ListCursor } from '../../hotkeys/listCursor';
import { createRegistry } from '../../hotkeys/registry';
import { RootStore } from '../../stores';
import { sendEach, startTask } from './commands';
import { taskCommands, TASKS_SCOPE, type TaskCommandDeps } from './taskCommands';
import { runsByTask, startBlockedReason, taskGrid } from './taskView';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';
import type { PickerRequest } from '../../shared/PickerPopover';
import type { KeyValueStorage } from '../../stores/storage';

const toasts = vi.hoisted(() => ({ error: vi.fn<(options: { message: string }) => void>() }));

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * The Tasks commands against a real RootStore and the fixture daemon, the way `Screen` wires them: the cursor follows the store's grid,
 * and the commands send what they send through `sendEach`. Checks what the project shows once the daemon's events have come in.
 * The fixture project (CAR-20 to CAR-30): done 20 21 22, review 23, active 24 25, todo 26 27, backlog 28, canceled 29, backlog 30.
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
let pickers: PickerRequest[];
let confirms: OpenConfirmModalOptions[];
let titles: string[];
let sent: CommandInput[];

const settle = () => vi.advanceTimersByTimeAsync(0);
const project = () => root.selectedProject!;
const ui = () => root.ui.forProject(FIXTURE_PROJECT_ID);
const status = (taskId: string) => project().tasks.get(taskId)?.statusId;

/** Opens the Tasks screen's commands on a store whose transport records what it is asked to do and may refuse some of it. */
async function mount(refuse: (input: CommandInput) => string | undefined = () => undefined) {
    const base = new FixtureTransport();
    const transport: Transport = overrideTransport(base, {
        command: async (input) => {
            sent.push(input);

            const message = refuse(input);

            return message ? { ok: false, requestId: 'r', error: { code: 'invalid', message } } satisfies CommandResult : base.command(input);
        },
    });

    root = new RootStore(transport, { storage: memoryStorage() });
    await root.load();
    await settle();
    ui().setTasksView('list');
    cursor = new ListCursor();
    cursor.setGrid(taskGrid('list', project().taskList, project().statuses));

    // `Screen` gives the cursor the grid again whenever the tasks change.
    stopFollowing = reaction(() => taskGrid('list', project().taskList, project().statuses), grid => cursor.setGrid(grid));

    const deps: TaskCommandDeps = {
        cursor,
        ui: ui(),
        hasTask: id => project().tasks.has(id),
        view: () => 'list',
        focusZone: () => 'list',
        isCursorFocused: () => true,
        revealCursor: () => undefined,
        tasks: () => project().taskList,
        statuses: () => project().statuses,
        startBlocked: id => startBlockedReason(runsByTask(project().runTaskLinks.values(), project().runs).get(id)),
        send: inputs => sendEach(root, inputs),
        start: id => startTask(root, id),
        openPicker: request => pickers.push(request),
        confirm: options => confirms.push(options),
        focusTitle: id => titles.push(id),
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
    toasts.error.mockClear();
    document.body.innerHTML = '';
});

afterEach(() => {
    uninstall();
    stopFollowing();
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
        goTo('t-28');
        press('x');
        press('ArrowDown', { shiftKey: true });
        press('ArrowDown', { shiftKey: true });
        press('Backspace', { metaKey: true });

        expect(confirms).toHaveLength(1);
        expect(confirms[0].title).toBe('Delete 3 tasks?');
        expect(sent).toEqual([]);

        await confirms[0].onConfirm();
        await settle();

        expect(['t-28', 't-29', 't-30'].map(id => project().tasks.has(id))).toEqual([false, false, false]);
        expect(project().tasks.size).toBe(8);
        // The three were the last in the list: the cursor falls back to the one above them.
        expect(cursor.cursorId).toBe('t-27');
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
