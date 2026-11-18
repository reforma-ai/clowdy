// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { Screen } from './Screen';

import type { CommandInput } from '../../daemon/transport';
import type { KeyValueStorage } from '../../stores/storage';

// `Modal` cannot load under the desktop's Vitest (decorators), and neither dialog is opened here.
vi.mock('@clowdy/components/modals', () => ({ openConfirmModal: vi.fn() }));
vi.mock('./CreateTaskDialog', () => ({ openCreateTask: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The Tasks screen on the fixture project (CAR-20 to CAR-30): done 20 21 22, review 23, active 24 25, todo 26 27, backlog 28, canceled 29, backlog 30.
 * The test build has no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;

const draw = () => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><Screen /></RootStoreProvider>);
});

const cardOf = (taskId: string) => container.querySelector<HTMLElement>(`[data-task-id="${ taskId }"]`)!;

/** The title button holds the focus of a card. */
const titleOf = (taskId: string) => cardOf(taskId).querySelector<HTMLElement>('button')!;
const columnOf = (taskId: string) => cardOf(taskId).closest('section')?.getAttribute('aria-label');

/** The daemon changes the project, from this window or from anywhere else, and the screen draws what came in. */
async function change(input: CommandInput) {
    await act(async () => {
        await store.command(input);
    });
    await draw();
}

async function mount() {
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    store.ui.forProject(FIXTURE_PROJECT_ID).setTasksView('board');
    await draw();
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
});

describe('focus on a card that is rebuilt or removed', () => {
    it('stays on the card when its status changes from anywhere', async () => {
        await mount();
        await act(async () => titleOf('t-26').focus());

        expect(columnOf('t-26')).toBe('To do');

        await change({ type: 'task.update', taskId: 't-26', statusId: 'done' });

        expect(columnOf('t-26')).toBe('Done');
        expect(document.activeElement).toBe(titleOf('t-26'));
    });

    it('is left where it is when it was somewhere else, such as the search field', async () => {
        await mount();
        await act(async () => titleOf('t-26').focus());

        const search = container.querySelector<HTMLInputElement>('input')!;

        await act(async () => search.focus());
        await change({ type: 'task.update', taskId: 't-26', statusId: 'done' });

        expect(document.activeElement).toBe(search);
    });

    it('goes to the cursor, the neighbour of the task, when the task is deleted', async () => {
        await mount();
        await act(async () => titleOf('t-26').focus());
        await change({ type: 'task.delete', taskId: 't-26' });

        expect(container.querySelector('[data-task-id="t-26"]')).toBeNull();
        expect(document.activeElement).toBe(titleOf('t-27'));
    });

    it('does not take focus a person moved to the page on purpose', async () => {
        await mount();
        await act(async () => titleOf('t-26').focus());
        await act(async () => (document.activeElement as HTMLElement).blur());
        await draw();

        expect(document.activeElement).toBe(document.body);
    });
});
