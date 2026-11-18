// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { hotkeys } from '../../hotkeys';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { RootStore, RootStoreProvider } from '../../stores';
import { openCreateTask } from './CreateTaskDialog';
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
let uninstall: () => void;

/** Draws the screen, after `before` if there is one, in the same step: the observer does that in the app, where a key that changes the store is drawn before the next frame. */
const draw = (before?: () => void) => act(async () => {
    before?.();
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
    // The shell installs the dispatcher in the app; the screen's commands are on the app's registry.
    uninstall = installDispatcher(hotkeys);
});

afterEach(() => {
    uninstall();
    act(() => reactRoot.unmount());
    store.dispose();
    container.remove();
    vi.mocked(openCreateTask).mockClear();
});

/** A key as the dispatcher sees it, from the body or from an element, with the platform's Cmd or Ctrl for `mod`. */
function press(key: string, { mod = false, ...init }: KeyboardEventInit & { mod?: boolean } = {}, target: Element = document.body) {
    const modifier = hotkeys.platform === 'darwin' ? { metaKey: mod } : { ctrlKey: mod };
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifier, ...init });

    target.dispatchEvent(event);

    return event;
}

/** Real time: the screen hands the keyboard back a tick after a dialog closes, and after a frame for the title field. */
const wait = (ms = 40) => act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
});

/** The commands register in an effect, so the first draw has no hints; the second has them. */
const mountWithHints = async () => {
    await mount();
    await draw();
};

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

describe('keys that open something', () => {
    it('C opens the New task dialog, and the keyboard comes back to the list when it closes', async () => {
        await mountWithHints();

        expect(press('c').defaultPrevented).toBe(true);
        expect(openCreateTask).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(document.body);

        const [, options] = vi.mocked(openCreateTask).mock.calls[0];

        options?.onClose?.();
        await wait();

        expect(document.activeElement).toBe(container.querySelector<HTMLElement>('[data-task-id] button'));
    });

    it('a dialog opened with the header button hands the keyboard back as it was', async () => {
        await mountWithHints();

        const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === 'Task')!;

        await act(async () => button.focus());

        const [, options] = (await act(async () => button.click()), vi.mocked(openCreateTask).mock.calls[0]);

        options?.onClose?.();
        await wait();

        expect(document.activeElement).toBe(button);
    });

    it('/ puts the keyboard in the search field and the slash is not typed into it', async () => {
        await mountWithHints();

        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

        expect(press('/').defaultPrevented).toBe(true);
        expect(document.activeElement).toBe(search);

        // A key typed in the field is the field's: the command is off there, so a second slash is a character.
        expect(press('/', {}, search).defaultPrevented).toBe(false);
    });

    it('Esc in the search field clears the text first and leaves the field when there is none, and Enter leaves it at once', async () => {
        await mountWithHints();

        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

        await act(async () => search.focus());
        await act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

            setValue.call(search, 'booking');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => press('Escape', {}, search));

        expect(search.value).toBe('');
        expect(document.activeElement).toBe(search);

        await act(async () => press('Escape', {}, search));

        // The cursor sat on the first task the text matched.
        expect(document.activeElement?.closest('[data-task-id]')).not.toBeNull();

        await act(async () => search.focus());

        // The keypress of that Enter would land on the card that has the keyboard by then and open it, so the keydown is taken.
        const enter = await act(async () => press('Enter', {}, search));

        expect(enter.defaultPrevented).toBe(true);
        expect(document.activeElement?.closest('[data-task-id]')).not.toBeNull();
    });

    it('F opens the filter popover, and the keyboard goes back to the list when it closes', async () => {
        await mountWithHints();

        expect(press('f').defaultPrevented).toBe(true);
        await wait();

        const popover = document.querySelector('[aria-label="Filter tasks"]');

        expect(popover).not.toBeNull();

        await act(async () => {
            popover!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await wait();

        expect(document.querySelector('[aria-label="Filter tasks"]')).toBeNull();
        expect(document.activeElement).toBe(container.querySelector('[data-task-id] button'));
    });

    it('Cmd+B switches between the board and the list', async () => {
        await mountWithHints();

        expect(container.querySelector('section[aria-label="To do"]')).not.toBeNull();

        await act(async () => press('b', { mod: true }));
        await draw();

        expect(store.ui.forProject(FIXTURE_PROJECT_ID).tasksView).toBe('list');
        expect(container.querySelector('section[aria-label="To do"]')).toBeNull();

        await act(async () => press('b', { mod: true }));
        await draw();

        expect(container.querySelector('section[aria-label="To do"]')).not.toBeNull();
    });

    it('keeps the keyboard on the cursor task when the view switches under it', async () => {
        await mountWithHints();
        await act(async () => titleOf('t-26').focus());
        await act(async () => press('b', { mod: true }, titleOf('t-26')));
        await draw();
        await wait();

        expect(document.activeElement).toBe(cardOf('t-26'));

        // And back: the row that has the keyboard is the one that leaves.
        await act(async () => press('b', { mod: true }, cardOf('t-26')));
        await draw();
        await wait();

        expect(document.activeElement).toBe(titleOf('t-26'));
    });
});

describe('a rename that starts from the keyboard', () => {
    /** Shift+R on the card, and the panel's title field has the keyboard once the frame is drawn. */
    async function startRename(taskId: string) {
        await act(async () => titleOf(taskId).focus());
        await draw(() => press('R', { shiftKey: true }, titleOf(taskId)));
        await wait();
    }

    const title = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')!;

    it('hands the keyboard back to the card when Enter saves the title', async () => {
        await mountWithHints();
        await startRename('t-26');

        expect(document.activeElement).toBe(title());

        await act(async () => press('Enter', {}, title()));
        await wait();

        expect(document.activeElement).toBe(titleOf('t-26'));
    });

    it('hands the keyboard back to the card when Esc drops the edit', async () => {
        await mountWithHints();
        await startRename('t-26');
        await act(async () => press('Escape', {}, title()));
        await wait();

        expect(document.activeElement).toBe(titleOf('t-26'));
    });

    it('leaves the keyboard where the person put it when they click elsewhere', async () => {
        await mountWithHints();
        await startRename('t-26');

        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

        await act(async () => search.focus());
        await wait();

        expect(document.activeElement).toBe(search);
    });

    it('does not take the keyboard when a title is edited by hand and ended with Enter', async () => {
        await mountWithHints();
        await act(async () => titleOf('t-26').click());
        await draw();
        await act(async () => title().focus());
        await act(async () => press('Enter', {}, title()));
        await wait();

        expect(document.activeElement).toBe(document.body);
    });
});

describe('key hints', () => {
    it('shows the key of the search field only while the field is empty', async () => {
        await mountWithHints();

        expect(container.querySelector('header [slot="suffix"] kbd')?.textContent).toBe('/');

        const search = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

        await act(async () => {
            const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

            setValue.call(search, 'booking');
            search.dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(container.querySelector('header [slot="suffix"] kbd')).toBeNull();
    });
});
