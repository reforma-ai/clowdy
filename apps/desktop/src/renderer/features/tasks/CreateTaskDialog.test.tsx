// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { RootStore } from '../../stores';
import { openCreateTask } from './CreateTaskDialog';
import { lateTaskEvents, memoryStorage } from './screenHarness';

import type { CommandInput } from '../../daemon/transport';

const modal = vi.hoisted(() => ({ create: vi.fn<(options: { component: unknown }) => void>(), cancel: vi.fn<() => void>() }));

// `Modal` itself cannot load under the desktop's Vitest (decorators): the dialog's form is drawn from the options it was given.
vi.mock('@clowdy/components/Modal', () => ({
    Modal: { create: modal.create },
    useModalContext: () => ({ modal: { cancel: modal.cancel } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;
let root: RootStore;
let sent: CommandInput[];
let late: ReturnType<typeof lateTaskEvents>;

beforeEach(async () => {
    sent = [];
    late = lateTaskEvents();
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);

    const base = new FixtureTransport();

    root = new RootStore(overrideTransport(late.wrap(base), {
        command: async (input) => {
            sent.push(input);

            return base.command(input);
        },
    }), { storage: memoryStorage() });
    await root.load();
});

afterEach(() => {
    act(() => reactRoot.unmount());
    root.dispose();
    container.remove();
    modal.create.mockClear();
    modal.cancel.mockClear();
});

/** Opens the dialog the way a screen does and draws its form. */
async function open(parentId?: string) {
    const project = root.selectedProject!;

    openCreateTask({ root, project, ui: root.ui.forProject(FIXTURE_PROJECT_ID), parentId });

    await act(async () => reactRoot.render(modal.create.mock.calls[0][0].component as never));
}

/** Types a title and presses the button that makes the task. */
async function submit(title: string) {
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;

    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, title);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLFormElement>('form')!.requestSubmit());
}

describe('the New task dialog', () => {
    it('names the task a new task goes inside, in a muted line under the heading', async () => {
        await open('t-31');

        const heading = container.querySelector('form')!.firstElementChild!;

        expect(heading.textContent).toContain('New task');
        expect(heading.textContent).toContain('Sub-task of CAR-31 Payments');
    });

    it('sends the parent with the new task, and opens the task it made', async () => {
        await open('t-31');
        await submit('Retry a failed payment');

        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: 'task.create', projectId: FIXTURE_PROJECT_ID, title: 'Retry a failed payment', parentId: 't-31' });

        const created = root.selectedProject!.taskList.find(task => task.title === 'Retry a failed payment')!;

        expect(created.parentId).toBe('t-31');
        expect(root.ui.forProject(FIXTURE_PROJECT_ID).taskId).toBe(created.id);
        expect(modal.cancel).toHaveBeenCalled();
    });

    it('says nothing about a parent, and sends none, for a task of the roots', async () => {
        await open();
        await submit('A task of the roots');

        expect(container.querySelector('form')!.firstElementChild!.textContent).toBe('New task');
        expect(sent[0]).toMatchObject({ type: 'task.create', title: 'A task of the roots' });
        expect(sent[0]).not.toHaveProperty('parentId', expect.anything());
        expect(root.selectedProject!.taskList.find(task => task.title === 'A task of the roots')?.parentId).toBeUndefined();
    });

    it('shows what the daemon refused and stays open, for a parent that is gone', async () => {
        await open('t-gone');
        await submit('Orphan');

        expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
        expect(modal.cancel).not.toHaveBeenCalled();
        // No muted line for a parent the project does not hold.
        expect(container.querySelector('form')!.firstElementChild!.textContent).toBe('New task');
    });

    it('leaves the scope where it is for a task made inside it, and moves it to the roots for a task made outside it, so the new task shows', async () => {
        const window = root.ui.forProject(FIXTURE_PROJECT_ID);

        window.setTasksScope('t-31');
        await open('t-31');
        await submit('Inside the scope');

        expect(window.tasksScope).toBe('t-31');

        modal.create.mockClear();
        await open();
        await submit('Outside the scope');

        expect(window.tasksScope).toBeNull();
        expect(window.taskId).toBe(root.selectedProject!.taskList.find(task => task.title === 'Outside the scope')!.id);
    });

    describe('when the daemon\'s event comes after the reply, so the project does not hold the new task yet', () => {
        const made = (title: string) => root.selectedProject!.taskList.find(task => task.title === title);

        it('keeps the scope for a task made inside it, opens the task, and shows it once the event is in', async () => {
            const window = root.ui.forProject(FIXTURE_PROJECT_ID);

            window.setTasksScope('t-31');
            late.hold();
            await open('t-31');
            await submit('Inside, and late');

            expect(made('Inside, and late')).toBeUndefined();
            expect(window.taskId).not.toBeNull();
            expect(window.tasksScope).toBe('t-31');

            await late.release();

            expect(window.taskId).toBe(made('Inside, and late')!.id);
            expect(window.tasksScope).toBe('t-31');
        });

        it('moves the scope to the roots for a task made outside it, at once, and not after the event', async () => {
            const window = root.ui.forProject(FIXTURE_PROJECT_ID);

            window.setTasksScope('t-31');
            late.hold();
            await open();
            await submit('Outside, and late');

            expect(made('Outside, and late')).toBeUndefined();
            expect(window.tasksScope).toBeNull();

            await late.release();

            expect(window.taskId).toBe(made('Outside, and late')!.id);
            expect(window.tasksScope).toBeNull();
        });

        it('moves a board of one level to the task a deeper task is made in, which is where its card is', async () => {
            const window = root.ui.forProject(FIXTURE_PROJECT_ID);

            window.setTasksScope('t-31');
            late.hold();
            await open('t-32');
            await submit('Deeper, and late');

            expect(window.tasksScope).toBe('t-32');

            await late.release();

            expect(made('Deeper, and late')!.parentId).toBe('t-32');
            expect(window.tasksScope).toBe('t-32');
        });
    });
});
