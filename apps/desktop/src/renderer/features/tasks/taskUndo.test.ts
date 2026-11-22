// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { createUndoStack, type UndoStack } from '../../hotkeys/undo';
import { RootStore } from '../../stores';
import { sendWithUndo } from './taskUndo';

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
 * What the panel sends: one `task.update` per edit, with the field it edits, through the store and the fixture daemon.
 * The fixture project (CAR-20 to CAR-37): CAR-24 In progress, CAR-26 To do and depends on CAR-24 and CAR-25; CAR-33 is inside CAR-32, which is inside CAR-31.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let root: RootStore;
let stack: UndoStack;
let daemon: FixtureTransport;
let sent: CommandInput[];
let refuse: (input: CommandInput) => string | undefined;

const settle = () => vi.advanceTimersByTimeAsync(0);
const project = () => root.selectedProject!;
const task = (taskId: string) => project().tasks.get(taskId)!;

const update = (taskId: string, changes: Partial<Extract<CommandInput, { type: 'task.update' }>>): CommandInput => ({ type: 'task.update', taskId, ...changes } as CommandInput);

/** Sends as the panel does and waits for the project to show the daemon's answer. */
async function edit(...inputs: CommandInput[]) {
    const results = await sendWithUndo(root, project(), inputs, stack);

    await settle();

    return results;
}

beforeEach(async () => {
    vi.useFakeTimers();
    sent = [];
    refuse = () => undefined;
    daemon = new FixtureTransport();
    stack = createUndoStack();
    toasts.error.mockClear();
    toasts.show.mockClear();
    toasts.success.mockClear();
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

describe('what is recorded', () => {
    it('records a rename with the previous title, and offers it as "Renamed CAR-24"', async () => {
        const was = task('t-24').title;

        await edit(update('t-24', { title: 'Booking form v2' }));

        expect(task('t-24').title).toBe('Booking form v2');
        expect(stack.entries.map(entry => entry.label)).toEqual(['Renamed CAR-24']);
        expect(toasts.show).toHaveBeenCalledWith({ message: 'Renamed CAR-24', timeout: 5000, action: { label: 'Undo', onPress: expect.any(Function) } });

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(task('t-24').title).toBe(was);
        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-24', title: was });
    });

    it('records the change in the project it was made in, and no other project can take it back', async () => {
        await edit(update('t-24', { title: 'Booking form v2' }));

        expect(stack.entries.map(entry => entry.scope)).toEqual([FIXTURE_PROJECT_ID]);
        expect(stack.canUndo('another-project')).toBe(false);

        const sentBefore = sent.length;

        expect(await stack.undoLatest('another-project')).toBe(false);
        expect(sent).toHaveLength(sentBefore);
        expect(task('t-24').title).toBe('Booking form v2');
    });

    it('records a description edit, an empty previous description included', async () => {
        expect(task('t-27').description).toBe('');

        await edit(update('t-27', { description: 'Cover glass and tyres.' }));

        expect(stack.entries.map(entry => entry.label)).toEqual(['Description of CAR-27 changed']);

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(task('t-27').description).toBe('');
        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-27', description: '' });
    });

    it('records a dependency change with the whole previous list, copied before the daemon changed the task', async () => {
        const was = [...task('t-26').dependsOn];

        await edit(update('t-26', { dependsOn: ['t-24'] }));

        expect(task('t-26').dependsOn).toEqual(['t-24']);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Dependencies of CAR-26 changed']);

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(task('t-26').dependsOn).toEqual(was);
        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-26', dependsOn: was });
    });

    it('records a move under another task with the previous parent, and puts a root back as a root with null', async () => {
        expect(task('t-26').parentId).toBeUndefined();

        await edit(update('t-26', { parentId: 't-35' }));

        expect(task('t-26').parentId).toBe('t-35');
        expect(stack.entries.map(entry => entry.label)).toEqual(['Parent of CAR-26 changed']);

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        // An absent parentId would leave the task where it is: the command that detaches says null.
        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-26', parentId: null });
        expect('parentId' in task('t-26')).toBe(false);
    });

    it('records a detach with the parent the task left, and moves it back under that parent', async () => {
        expect(task('t-33').parentId).toBe('t-32');

        await edit(update('t-33', { parentId: null }));

        expect('parentId' in task('t-33')).toBe(false);
        expect(stack.entries.map(entry => entry.label)).toEqual(['Parent of CAR-33 changed']);

        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-33', parentId: 't-32' });
        expect(task('t-33').parentId).toBe('t-32');
    });

    it('records a move from one parent to another with the first one, and calls a move with a status change an update', async () => {
        await edit(update('t-34', { parentId: 't-35' }));
        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-34', parentId: 't-32' });

        await edit(update('t-34', { parentId: 't-36', statusId: 'review' }));

        expect(stack.entries.map(entry => entry.label)).toEqual(['CAR-34 updated']);
    });

    it('takes a detach of a root, and a parent sent unchanged, for no change: nothing is recorded and the command is sent all the same', async () => {
        await edit(update('t-24', { parentId: null }));
        await edit(update('t-33', { parentId: 't-32' }));

        expect(sent.map(input => input.type)).toEqual(['task.update', 'task.update']);
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        expect(toasts.show).not.toHaveBeenCalled();
    });

    it('records nothing when the daemon refuses the move, and says why', async () => {
        const results = await edit(update('t-31', { parentId: 't-33' }));

        expect(results[0].ok).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'Task CAR-33 is inside CAR-31, so it cannot be its parent' });
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        expect(task('t-31').parentId).toBeUndefined();
    });

    it('records only the fields that changed: a title sent unchanged next to a new status is not part of the undo', async () => {
        const { title } = task('t-24');

        await edit(update('t-24', { title, statusId: 'review' }));
        await stack.undoLatest(FIXTURE_PROJECT_ID);
        await settle();

        expect(sent.at(-1)).toEqual({ type: 'task.update', taskId: 't-24', statusId: 'active' });
    });

    it('calls a change of several fields an update', async () => {
        await edit(update('t-24', { title: 'Booking form v2', statusId: 'review' }));

        expect(stack.entries.map(entry => entry.label)).toEqual(['CAR-24 updated']);
    });

    it('records one entry for several tasks, and says nothing of a status they do not share', async () => {
        await edit(update('t-26', { statusId: 'active' }), update('t-28', { statusId: 'todo' }));

        expect(stack.entries.map(entry => entry.label)).toEqual(['2 tasks moved']);
    });

    it('records nothing for an update that changes nothing, and sends it all the same', async () => {
        const { title, statusId } = task('t-24');

        await edit(update('t-24', { title, statusId }));

        expect(sent).toHaveLength(1);
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        expect(toasts.show).not.toHaveBeenCalled();
    });

    it('records nothing for a command that is not an update, and passes its result on', async () => {
        const results = await edit({ type: 'task.delete', taskId: 't-30' });

        expect(results.map(result => result.ok)).toEqual([true]);
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        expect(toasts.show).not.toHaveBeenCalled();
    });

    it('records nothing for a task the project does not know, whatever the daemon says', async () => {
        const results = await edit(update('t-nope', { title: 'Ghost' }));

        expect(results[0].ok).toBe(false);
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
    });

    it('records nothing and shows only the daemon\'s message when it refuses', async () => {
        refuse = () => 'The title is too long';

        const results = await edit(update('t-24', { title: 'x'.repeat(10) }));

        expect(results[0].ok).toBe(false);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'The title is too long' });
        expect(stack.canUndo(FIXTURE_PROJECT_ID)).toBe(false);
        expect(toasts.show).not.toHaveBeenCalled();
        expect(task('t-24').title).not.toBe('x'.repeat(10));
    });
});

describe('what an undo checks', () => {
    it('does not call a dependency list that someone only reordered a change', async () => {
        await edit(update('t-26', { dependsOn: ['t-24', 't-25', 't-27'] }));
        await daemon.command({ type: 'task.update', taskId: 't-26', dependsOn: ['t-27', 't-25', 't-24'] });
        await settle();

        expect(task('t-26').dependsOn).toEqual(['t-27', 't-25', 't-24']);
        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(true);
        expect(task('t-26').dependsOn).toEqual(['t-24', 't-25']);
    });

    it('refuses to put back a title that was edited since, and does not touch it', async () => {
        await edit(update('t-24', { title: 'Booking form v2' }));
        await daemon.command({ type: 'task.update', taskId: 't-24', title: 'Booking form v3' });
        await settle();
        sent.length = 0;

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(false);
        expect(sent).toEqual([]);
        expect(task('t-24').title).toBe('Booking form v3');
        expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-24 changed since, so this cannot be undone' });
    });

    it('refuses to put back a list whose links changed since', async () => {
        await edit(update('t-26', { dependsOn: ['t-24'] }));
        await daemon.command({ type: 'task.update', taskId: 't-26', dependsOn: ['t-24', 't-27'] });
        await settle();
        sent.length = 0;

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(false);
        expect(sent).toEqual([]);
        expect(task('t-26').dependsOn).toEqual(['t-24', 't-27']);
    });

    it('refuses to put back a parent that was changed since, and does not touch the task', async () => {
        await edit(update('t-26', { parentId: 't-35' }));
        await daemon.command({ type: 'task.update', taskId: 't-26', parentId: 't-36' });
        await settle();
        sent.length = 0;

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(false);
        expect(sent).toEqual([]);
        expect(task('t-26').parentId).toBe('t-36');
        expect(toasts.error).toHaveBeenCalledWith({ message: 'CAR-26 changed since, so this cannot be undone' });
    });

    it('does not put back a parent over a task that was detached since: a root is not the parent the change gave it', async () => {
        await edit(update('t-26', { parentId: 't-35' }));
        await daemon.command({ type: 'task.update', taskId: 't-26', parentId: null });
        await settle();
        sent.length = 0;

        expect(await stack.undoLatest(FIXTURE_PROJECT_ID)).toBe(false);
        expect(sent).toEqual([]);
    });

    it('keeps the entry\'s own toast in step: the offer is replaced by the next change\'s, and closed when its entry is undone', async () => {
        await edit(update('t-24', { title: 'Booking form v2' }));

        const first = toasts.show.mock.results[0].value;

        await edit(update('t-24', { title: 'Booking form v3' }));

        expect(toasts.queue.close).toHaveBeenCalledWith(first);

        const second = toasts.show.mock.results[1].value;

        await stack.undoLatest(FIXTURE_PROJECT_ID);

        expect(toasts.queue.close).toHaveBeenCalledWith(second);
        expect(toasts.success).toHaveBeenCalledWith({ message: 'Undone: Renamed CAR-24' });
    });

    it('presses Undo on an older toast without taking back the newer change first', async () => {
        await edit(update('t-24', { title: 'Booking form v2' }));

        const [{ action }] = toasts.show.mock.calls[0];

        await edit(update('t-27', { description: 'Cover glass.' }));
        action!.onPress();
        await settle();

        expect(task('t-24').title).not.toBe('Booking form v2');
        expect(task('t-27').description).toBe('Cover glass.');
        expect(stack.entries.map(entry => entry.label)).toEqual(['Description of CAR-27 changed']);
    });
});
