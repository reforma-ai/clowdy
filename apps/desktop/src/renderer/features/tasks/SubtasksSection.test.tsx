// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubtasksSection, type SubtasksSectionProps } from './SubtasksSection';
import { DEPTH_LIMIT_HINT } from './taskTree';

import type { Task, TaskStatus } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STATUSES: TaskStatus[] = [
    { id: 'todo', name: 'To do', category: 'todo' },
    { id: 'active', name: 'In progress', category: 'active' },
    { id: 'done', name: 'Done', category: 'done' },
] as TaskStatus[];

const task = (number: number, title: string, statusId: string): Task =>
    ({ id: `t-${number}`, key: `CAR-${number}`, number, title, statusId }) as Task;

let container: HTMLDivElement;
let root: Root;
let onOpen: ReturnType<typeof vi.fn<(taskId: string) => void>>;
let onCreate: ReturnType<typeof vi.fn<() => void>>;

const render = (props: Partial<SubtasksSectionProps> = {}) =>
    act(async () =>
        root.render(
            <SubtasksSection
                task={{ key: 'CAR-1' }}
                subtasks={[
                    task(2, 'First step', 'todo'),
                    task(3, 'Second step', 'active'),
                    task(4, 'Third step', 'done'),
                ]}
                rollUp={{ done: 1, total: 3 }}
                statuses={STATUSES}
                canHaveChildren
                onOpen={onOpen}
                onCreate={onCreate}
                {...props}
            />
        )
    );

const rows = () => [...container.querySelectorAll<HTMLButtonElement>('button[title]')];

beforeEach(() => {
    onOpen = vi.fn();
    onCreate = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('SubtasksSection', () => {
    it('lists the tasks as it is given them, each with its key and title and the icon of its status', async () => {
        await render();

        expect(rows().map(row => row.textContent)).toEqual(['CAR-2First step', 'CAR-3Second step', 'CAR-4Third step']);
        expect(rows().every(row => row.querySelector('[data-tone]') !== null)).toBe(true);
    });

    it('keeps the keys aligned for a task whose status the workflow no longer has', async () => {
        await render({ subtasks: [task(2, 'Orphan', 'gone')] });

        expect(rows()[0].querySelector('[data-tone]')).toBeNull();
        expect(rows()[0].textContent).toBe('CAR-2Orphan');
    });

    it('opens a task by its row', async () => {
        await render();
        await act(async () => rows()[1].click());

        expect(onOpen).toHaveBeenCalledExactlyOnceWith('t-3');
    });

    it('says the work done in the header, and nothing when no task counts', async () => {
        await render();

        expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('1 of 3 sub-tasks done');

        await render({ rollUp: undefined });

        expect(container.querySelector('[role="img"]')).toBeNull();
    });

    it('says there are no sub-tasks yet for a task with nothing inside it, with no work done in the header and the button still there', async () => {
        await render({ subtasks: [], rollUp: undefined });

        expect(container.textContent).toContain('No sub-tasks yet');
        expect(rows()).toEqual([]);
        expect(container.querySelector('[role="img"]')).toBeNull();

        await act(async () =>
            [...container.querySelectorAll('button')].find(button => button.textContent === 'New sub-task')!.click()
        );

        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('does not say there are none for a task that has some', async () => {
        await render();

        expect(container.textContent).not.toContain('No sub-tasks yet');
    });

    it('asks for a new sub-task with its button', async () => {
        await render();
        await act(async () =>
            [...container.querySelectorAll('button')].find(button => button.textContent === 'New sub-task')!.click()
        );

        expect(onCreate).toHaveBeenCalledTimes(1);
    });

    it('turns the button off at the last level and says why, on a stand-in that has the focus', async () => {
        await render({ subtasks: [], rollUp: undefined, canHaveChildren: false });

        const button = [...container.querySelectorAll('button')].find(
            candidate => candidate.textContent === 'New sub-task'
        )!;
        const standIn = container.querySelector<HTMLElement>('[role="button"][aria-label="New sub-task"]')!;

        expect(button.hasAttribute('disabled')).toBe(true);
        expect(standIn.getAttribute('aria-disabled')).toBe('true');
        expect(standIn.tabIndex).toBe(0);

        await act(async () => button.click());

        expect(onCreate).not.toHaveBeenCalled();

        // The hint is the one the header's button and the key use.
        await act(async () => standIn.focus());

        expect(document.body.textContent).toContain(DEPTH_LIMIT_HINT);
    });
});
