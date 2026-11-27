// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatProgress } from './progress';
import { TasksBanner } from './TasksBanner';
import { TASK_REFERENCE_DRAG_TYPE } from './taskReferences';

import type { ChatProgress } from './progress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('opens the task list, updates progress, and navigates to a selected task', async () => {
    const store = new RootStore(new FixtureTransport({ data: createFixtureData() }));
    await store.load();
    const project = store.selectedProject!;
    const progress = chatProgress(project.tasksOfChat('c-1'), project.statuses)!;
    const tasks = progress.rows.map(({ task }) => task);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (progress: ChatProgress) =>
        root.render(
            <RootStoreProvider value={store}>
                <TasksBanner progress={progress} />
            </RootStoreProvider>
        );
    await act(async () => render(progress));
    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.textContent).toBe(`Tasks${progress.summary}`);
    expect(container.textContent).not.toContain(tasks[0].title);
    await act(async () => header.click());
    const row = [...container.querySelectorAll<HTMLElement>('[role="row"]')].find(item =>
        item.textContent?.includes(tasks[0].title)
    )!;
    expect(row.draggable).toBe(true);
    const payload = new Map<string, string>();
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(drag, 'dataTransfer', {
        value: { setData: (type: string, value: string) => payload.set(type, value) },
    });
    await act(async () => row.dispatchEvent(drag));
    expect(JSON.parse(payload.get(TASK_REFERENCE_DRAG_TYPE)!)).toEqual({ key: tasks[0].key, title: tasks[0].title });
    expect(row.textContent).toContain(tasks[0].key);
    expect(row.textContent).toContain(project.statuses.find(status => status.id === tasks[0].statusId)!.name);
    const done = project.statuses.find(status => status.category === 'done')!;
    const completed = chatProgress(
        tasks.map(task => ({ ...task, statusId: done.id })),
        project.statuses
    )!;
    await act(async () => render(completed));
    expect(header.textContent).toBe(`Tasks${tasks.length} done`);
    await act(async () => row.click());
    expect(store.ui.forProject(FIXTURE_PROJECT_ID).taskId).toBe(tasks[0].id);
    await act(async () => header.click());
    expect(container.textContent).not.toContain(tasks[0].title);
    act(() => root.unmount());
    container.remove();
});
