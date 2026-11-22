// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { createUndoStack, type UndoStack } from '../../hotkeys/undo';
import { RootStore } from '../../stores';
import { archiveTasks, archiveWithUndo, restoreTask } from './archiveActions';

import type { OpenConfirmModalOptions } from '@clowdy/components/modals';
import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput } from '../../daemon/transport';
import type { KeyValueStorage } from '../../stores/storage';

const toasts = vi.hoisted(() => {
    let count = 0;
    const next = () => `toast-${ ++count }`;

    return {
        error: vi.fn<(options: { message: string }) => void>(),
        show: vi.fn<(options: { message: string; timeout?: number; action?: { label: string; onPress: () => void } }) => string>(next),
        success: vi.fn<(options: { message: string }) => string>(next),
        queue: { close: vi.fn<(key: string) => void>() },
    };
});

vi.mock('@clowdy/components/Toast', () => ({ toast: toasts }));

/*
 * What archiving sends and records, through the store and the fixture daemon, which follows the daemon's archive rules.
 * The fixture project: CAR-20 21 22 done, CAR-28 backlog, CAR-29 canceled, CAR-24 active with an agent working on it; Payments is CAR-31 (active) with CAR-32 (active) holding
 * CAR-33 (done) and CAR-34 (todo), CAR-35 (todo), CAR-36 (review) and CAR-37 (canceled); CAR-38 (done) with CAR-39 and CAR-40 inside it is already in the archive.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let root: RootStore;
let stack: UndoStack;
let daemon: FixtureTransport;
let sent: CommandInput[];
let confirms: OpenConfirmModalOptions[];
let refuse: (input: CommandInput) => string | undefined;

const settle = () => vi.advanceTimersByTimeAsync(0);
const project = () => root.selectedProject!;
const ui = () => root.ui.forProject(FIXTURE_PROJECT_ID);
const task = (taskId: string) => project().tasks.get(taskId);
const board = (...ids: string[]) => ids.map(id => project().tasks.has(id));
const tasksOf = (...ids: string[]) => ids.map(id => project().tasks.get(id)!);
const archives = () => sent.filter(input => input.type === 'task.archive');

/** What the screen does for a key, a menu item or a drop: `archiveTasks`, then the daemon's events. */
async function archive(...ids: string[]) {
    archiveTasks({ root, project: project(), ui: ui(), confirm: options => confirms.push(options), stack }, tasksOf(...ids));
    await settle();
}

/** The person agrees to the question that was asked. */
async function agree() {
    await confirms.at(-1)!.onConfirm();
    await settle();
}

/** The daemon changes the project on its own, as an agent or another window does. */
async function elsewhere(input: CommandInput) {
    await daemon.command(input);
    await settle();
}

beforeEach(async () => {
    vi.useFakeTimers();
    sent = [];
    confirms = [];
    refuse = () => undefined;
    daemon = new FixtureTransport();
    stack = createUndoStack();
    Object.values(toasts).forEach(value => 'mockClear' in value && value.mockClear());
    toasts.queue.close.mockClear();

    const transport = overrideTransport(daemon, {
        command: async (input) => {
            sent.push(input);

            const message = refuse(input);

            return message ? { ok: false, requestId: 'r', error: { code: 'invalid', message } } satisfies CommandResult : daemon.command(input);
        },
    });

    root = new RootStore(transport, { storage: memoryStorage() });
    await root.load();
    await settle();
});

afterEach(() => {
    root.dispose();
    vi.useRealTimers();
});

describe('a closed task', () => {
    it('is archived at once, with no question, and the board loses it', async () => {
        await archive('t-20');

        expect(confirms).toEqual([]);
        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-20' }]);
        expect(board('t-20')).toEqual([false]);
        expect(project().archivedKnown.get('t-20')?.archivedAt).toBeDefined();
    });

    it('goes with every task inside it, and a canceled task counts as closed', async () => {
        // CAR-32 and what is inside it, all closed.
        await elsewhere({ type: 'task.update', taskId: 't-34', statusId: 'canceled' });
        await elsewhere({ type: 'task.update', taskId: 't-32', statusId: 'done' });
        await archive('t-32');

        expect(confirms).toEqual([]);
        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-32' }]);
        expect(board('t-32', 't-33', 't-34')).toEqual([false, false, false]);
        // The rest of Payments is where it was.
        expect(board('t-31', 't-35', 't-36', 't-37')).toEqual([true, true, true, true]);
    });

    it('offers one undo, "Archived CAR-20", which restores it', async () => {
        await archive('t-20');

        expect(stack.entries.map(entry => entry.label)).toEqual(['Archived CAR-20']);
        expect(toasts.show).toHaveBeenCalledWith({ message: 'Archived CAR-20', timeout: 5000, action: { label: 'Undo', onPress: expect.any(Function) } });

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(true);
        await settle();

        expect(sent.at(-1)).toEqual({ type: 'task.unarchive', taskId: 't-20' });
        expect(task('t-20')?.statusId).toBe('done');
        expect(task('t-20')?.archivedAt).toBeUndefined();
        expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: Archived CAR-20' });
    });
});

describe('open work', () => {
    it('is not archived before the person agrees, and the question says how many open tasks it cancels, counted from the board', async () => {
        await archive('t-31');

        expect(sent).toEqual([]);
        expect(confirms).toHaveLength(1);
        // CAR-31 and CAR-32 are active, CAR-34 and CAR-35 to do, CAR-36 in review: five. CAR-33 is done and CAR-37 canceled.
        expect(confirms[0]).toMatchObject({ title: 'Cancel and archive CAR-31?', confirmLabel: 'Cancel and archive', destructive: true });
        expect(confirms[0].message).toContain('5 open tasks will be canceled first.');
        expect(board('t-31')).toEqual([true]);
    });

    it('is canceled and archived with the whole tree when the person agrees, in one call with cancel', async () => {
        await archive('t-31');
        await agree();

        expect(archives()).toEqual([{ type: 'task.archive', taskId: 't-31', cancel: true }]);
        expect(board('t-31', 't-32', 't-33', 't-34', 't-35', 't-36', 't-37')).toEqual([false, false, false, false, false, false, false]);
        // What the daemon canceled shows as canceled in the archive.
        expect(project().archivedKnown.get('t-34')?.statusId).toBe('canceled');
        expect(project().archivedKnown.get('t-33')?.statusId).toBe('done');
    });

    it('asks nothing for a task that is not archived when the person says no', async () => {
        await archive('t-28');

        expect(confirms[0].title).toBe('Cancel and archive CAR-28?');
        expect(confirms[0].message).toContain('1 open task will be canceled first.');
        expect(sent).toEqual([]);
    });

    it('is undone by restoring the tree and putting each task that was canceled back to the status it had', async () => {
        await archive('t-31');
        await agree();

        expect(stack.entries.map(entry => entry.label)).toEqual(['Canceled and archived CAR-31']);

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(true);
        await settle();

        // The tree is restored first, then each task that was canceled goes back; the order of those does not matter.
        const undone = sent.filter(input => input.type !== 'task.archive');

        expect(undone[0]).toEqual({ type: 'task.unarchive', taskId: 't-31' });
        expect(undone.slice(1).map(input => [input.type, 'taskId' in input ? input.taskId : undefined, 'statusId' in input ? input.statusId : undefined]).sort()).toEqual([
            ['task.update', 't-31', 'active'],
            ['task.update', 't-32', 'active'],
            ['task.update', 't-34', 'todo'],
            ['task.update', 't-35', 'todo'],
            ['task.update', 't-36', 'review'],
        ]);
        expect(['t-31', 't-32', 't-33', 't-34', 't-35', 't-36', 't-37'].map(id => task(id)?.statusId)).toEqual(['active', 'active', 'done', 'todo', 'todo', 'review', 'canceled']);
        // A task that is open again has no closing time, and one that stayed closed keeps its own.
        expect(task('t-34')?.closedAt).toBeUndefined();
        expect(task('t-33')?.closedAt).toBeDefined();
        expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: Canceled and archived CAR-31' });
    });

    it('is left as it is by an undo that finds the tree restored already, and the person is told', async () => {
        await archive('t-31');
        await agree();
        await elsewhere({ type: 'task.unarchive', taskId: 't-31' });
        // Whoever restored it moved a task on.
        await elsewhere({ type: 'task.update', taskId: 't-34', statusId: 'review' });

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(false);
        await settle();

        expect(sent.filter(input => input.type === 'task.update')).toEqual([]);
        expect(task('t-34')?.statusId).toBe('review');
        expect(toasts.error).toHaveBeenCalledWith({ message: 'Already restored, so there is nothing to undo' });
    });
});

describe('a selection', () => {
    it('sends one task.archive per task, in the order given, with cancel only for the task that has open work, after one question for all of them', async () => {
        await archive('t-20', 't-28', 't-29');

        expect(sent).toEqual([]);
        expect(confirms).toHaveLength(1);
        expect(confirms[0].title).toBe('Cancel and archive 3 tasks?');
        expect(confirms[0].message).toContain('The 3 selected tasks and everything inside them will go to the archive. 1 open task will be canceled first.');

        await agree();

        expect(archives()).toEqual([
            { type: 'task.archive', taskId: 't-20' },
            { type: 'task.archive', taskId: 't-28', cancel: true },
            { type: 'task.archive', taskId: 't-29' },
        ]);
        expect(board('t-20', 't-28', 't-29')).toEqual([false, false, false]);
    });

    it('asks nothing when all of it is closed, and is one undo that restores all of it, the last archived first', async () => {
        await archive('t-20', 't-21', 't-22');

        expect(confirms).toEqual([]);
        expect(archives().map(input => input.taskId)).toEqual(['t-20', 't-21', 't-22']);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Archived 3 tasks']);

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(true);
        await settle();

        expect(sent.filter(input => input.type === 'task.unarchive').map(input => input.taskId)).toEqual(['t-22', 't-21', 't-20']);
        expect(board('t-20', 't-21', 't-22')).toEqual([true, true, true]);
    });

    it('counts a task once when it is selected with the task it is inside, and archives it with it', async () => {
        await elsewhere({ type: 'task.update', taskId: 't-34', statusId: 'canceled' });
        await elsewhere({ type: 'task.update', taskId: 't-32', statusId: 'done' });
        await archive('t-32', 't-33');

        expect(confirms).toEqual([]);
        // The second is archived with the first: the daemon changes nothing, and nothing of it is recorded.
        expect(archives().map(input => input.taskId)).toEqual(['t-32', 't-33']);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Archived CAR-32']);

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(board('t-32', 't-33', 't-34')).toEqual([true, true, true]);
    });

    it('counts the open tasks of a selection once, even when one is inside another', async () => {
        await archive('t-31', 't-32');

        // CAR-31, 32, 34, 35 and 36 are open, CAR-32 being inside CAR-31.
        expect(confirms[0].message).toContain('5 open tasks will be canceled first.');
    });
});

describe('what the daemon refuses', () => {
    it('shows the reason of a refusal as the toast, keeps the task on the board and records nothing', async () => {
        refuse = input => (input.type === 'task.archive' ? 'Task CAR-20 cannot be archived today' : undefined);

        await archive('t-20');

        expect(toasts.error).toHaveBeenCalledWith({ message: 'Task CAR-20 cannot be archived today' });
        expect(board('t-20')).toEqual([true]);
        expect(stack.entries).toEqual([]);
        expect(toasts.show).not.toHaveBeenCalled();
    });

    it('names the task that has an active run, whatever the person confirmed, and archives nothing', async () => {
        await archive('t-24');
        await agree();

        expect(toasts.error).toHaveBeenCalledWith({ message: expect.stringMatching(/^Task CAR-24 has an active run \(.+\): stop it first$/) });
        expect(board('t-24')).toEqual([true]);
        expect(stack.entries).toEqual([]);
    });

    it('names the task below that has an active run, since the whole tree is refused', async () => {
        await elsewhere({ type: 'task.update', taskId: 't-24', parentId: 't-28' });
        await archive('t-28');
        await agree();

        expect(toasts.error).toHaveBeenCalledWith({ message: expect.stringMatching(/^Task CAR-24, inside CAR-28, has an active run/) });
        expect(board('t-28', 't-24')).toEqual([true, true]);
        expect(stack.entries).toEqual([]);
    });

    it('archives the tasks the daemon takes in a selection, says why it refused the rest, and records only what was archived', async () => {
        await archive('t-20', 't-24');

        // CAR-24 is open, so the question comes first; CAR-20 goes with it.
        await agree();

        expect(toasts.error).toHaveBeenCalledWith({ message: expect.stringContaining('1 of 2 changes failed: Task CAR-24 has an active run') });
        expect(board('t-20', 't-24')).toEqual([false, true]);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Archived CAR-20']);
    });

    it('answers every result, so a caller can tell which task was taken', async () => {
        const results = await archiveWithUndo(root, project(), [{ taskId: 't-20', cancel: false }, { taskId: 't-24', cancel: true }], stack);

        expect(results.map(result => result.ok)).toEqual([true, false]);
    });
});

describe('the panel of an archived task', () => {
    it('closes when the task, or a task it archived, is the one it shows', async () => {
        await elsewhere({ type: 'task.update', taskId: 't-34', statusId: 'canceled' });
        await elsewhere({ type: 'task.update', taskId: 't-32', statusId: 'done' });

        ui().openTask('t-33');
        await archive('t-32');

        expect(ui().taskId).toBeNull();
    });

    it('stays for a task that was not archived, and for a refusal', async () => {
        ui().openTask('t-24');
        await archive('t-20');

        expect(ui().taskId).toBe('t-24');

        await archive('t-24');
        await agree();

        expect(ui().taskId).toBe('t-24');
    });
});

describe('restoring', () => {
    const archivedTask = (taskId: string) => project().archivedKnown.get(taskId) ?? { id: taskId, key: taskId };

    it('brings back the task and everything archived with it, and offers to archive it again', async () => {
        await project().readTask('t-38');

        expect(await restoreTask(root, project(), archivedTask('t-38'), stack)).toBe(true);
        await settle();

        expect(sent).toEqual([{ type: 'task.unarchive', taskId: 't-38' }]);
        expect(board('t-38', 't-39', 't-40')).toEqual([true, true, true]);
        expect(project().archivedKnown.size).toBe(0);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Restored CAR-38']);
        expect(toasts.show).toHaveBeenCalledWith({ message: 'Restored CAR-38', timeout: 5000, action: { label: 'Undo', onPress: expect.any(Function) } });
    });

    it('is undone by archiving it again, with the tree that went with it', async () => {
        await project().readTask('t-38');
        await restoreTask(root, project(), archivedTask('t-38'), stack);
        await settle();

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(true);
        await settle();

        expect(sent.at(-1)).toEqual({ type: 'task.archive', taskId: 't-38' });
        expect(board('t-38', 't-39', 't-40')).toEqual([false, false, false]);
        expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: Restored CAR-38' });
    });

    it('says why the daemon refuses a task whose parent is archived, and records nothing', async () => {
        await project().readTask('t-39');

        expect(await restoreTask(root, project(), archivedTask('t-39'), stack)).toBe(false);

        expect(toasts.error).toHaveBeenCalledWith({ message: 'Task CAR-39 is inside CAR-38, which is archived: restore CAR-38 first' });
        expect(stack.entries).toEqual([]);
        expect(board('t-39')).toEqual([false]);
    });

    it('changes nothing for a task that is restored already, and records nothing', async () => {
        await project().readTask('t-38');
        await restoreTask(root, project(), archivedTask('t-38'), stack);
        await settle();

        stack.clear();

        expect(await restoreTask(root, project(), { id: 't-38', key: 'CAR-38' }, stack)).toBe(true);
        expect(stack.entries).toEqual([]);
    });
});
