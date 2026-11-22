import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { hotkeys } from '../../hotkeys';
import { installDispatcher } from '../../hotkeys/dispatcher';
import { undoStack } from '../../hotkeys/undo';
import { RootStore, RootStoreProvider } from '../../stores';
import { Screen } from './Screen';

import type { ProjectId } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';
import type { ProjectUi } from '../../stores';
import type { KeyValueStorage } from '../../stores/storage';

/*
 * What the tests of the Tasks screen share: the screen on a real RootStore and the fixture daemon, in a happy-dom page, with the hotkey dispatcher installed as the shell does.
 * The test build has no MobX observer plugin, so the screen is drawn again by hand after a change, as the observer does in the app.
 * A test file mocks `@clowdy/components/modals` and `./CreateTaskDialog` itself: `Modal` cannot load under the desktop's Vitest, and neither dialog is opened here.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let reactRoot: Root;
let uninstall: () => void;

/** The page the screen is drawn in, and the store behind it: set by `mountScreen`. */
export const page = {
    get container() {
        return container;
    },
    store: undefined as unknown as RootStore,
};

export const ui = () => page.store.ui.forProject(page.store.selectedProjectId ?? FIXTURE_PROJECT_ID);
export const project = () => page.store.selectedProject!;

/** Draws the screen, after `before` if there is one, in the same step: the observer does that in the app, where a key that changes the store is drawn before the next frame. */
export const draw = (before?: () => void) => act(async () => {
    before?.();
    reactRoot.render(<RootStoreProvider value={ page.store }><Screen /></RootStoreProvider>);
});

/** Opens a page with the keys installed, for each test; `closePage` in `afterEach`. */
export function openPage() {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
    uninstall = installDispatcher(hotkeys);
}

export function closePage() {
    uninstall();
    // The window's history outlives a screen; a change one test made is not another test's to take back.
    undoStack.clear();
    act(() => reactRoot.unmount());
    page.store.dispose();
    container.remove();
}

export interface MountOptions {
    /** A store that remembers the window between two mounts, as a reload does. */
    storage?: KeyValueStorage;
    /** The project to show; the demo project of the car rental by default. */
    projectId?: ProjectId;
    /** Sets the window up before the first draw: the scope, the view, the open task. */
    prepare?: (window: ProjectUi) => void;
    /** Wraps the fixture daemon, for a test that changes how it answers (`overrideTransport`). */
    transport?: (base: FixtureTransport) => Transport;
}

/** A fresh store on the fixture daemon, with its project loaded, and the screen drawn on it. */
export async function mountScreen({ storage = memoryStorage(), projectId, prepare, transport }: MountOptions = {}) {
    const daemon = new FixtureTransport();

    page.store = new RootStore(transport ? transport(daemon) : daemon, { storage });
    await page.store.load();

    if (projectId) page.store.selectProject(projectId);

    prepare?.(ui());
    await draw();
}

/** Throws the page away and draws the screen again on a new store with the same storage: a reload of the window. */
export async function reloadScreen(storage: KeyValueStorage, options: Omit<MountOptions, 'storage'> = {}) {
    act(() => reactRoot.unmount());
    page.store.dispose();
    reactRoot = createRoot(container);
    await mountScreen({ ...options, storage });
}

/**
 * A daemon whose task events can be made to come late, as the HTTP one's can: the reply to a command may arrive before the event it caused, and until the event comes
 * the project does not hold the task. `wrap` goes around the fixture daemon (`MountOptions.transport`), `hold` starts keeping `task.upserted` events back, and
 * `release` lets them in, in the order they were made.
 */
export function lateTaskEvents() {
    let holding = false;
    const held: (() => void)[] = [];

    return {
        wrap: (base: Transport): Transport => overrideTransport(base, {
            subscribe: (cursor, onEvent, onStatus) => base.subscribe(cursor, event => (holding && event.data.type === 'task.upserted' ? void held.push(() => onEvent(event)) : onEvent(event)), onStatus),
        }),
        hold: () => {
            holding = true;
        },
        release: () => act(async () => {
            holding = false;
            held.splice(0).forEach(deliver => deliver());
        }),
    };
}

/** The daemon changes the project, from this window or from anywhere else, and the screen draws what came in. */
export async function change(input: CommandInput) {
    await act(async () => {
        await page.store.command(input);
    });
    await draw();
}

/** The card or the row of a task. */
export const itemOf = (taskId: string) => container.querySelector<HTMLElement>(`[data-task-id="${ taskId }"]`);

/** The ids of the cards or rows drawn, in the order of the page. */
export const drawn = () => [...container.querySelectorAll<HTMLElement>('[data-task-id]')].map(item => item.dataset.taskId);

/** The keys of the tasks drawn, for a test that reads better by the names the person sees. */
export const drawnKeys = () => drawn().map(id => project().tasks.get(id!)?.key);

/** The title button holds the focus of a card, and a row holds it itself. */
export const focusableOf = (taskId: string) => {
    const item = itemOf(taskId)!;

    return item.hasAttribute('tabindex') ? item : item.querySelector<HTMLElement>('button')!;
};

export const columnOf = (taskId: string) => itemOf(taskId)?.closest('section')?.getAttribute('aria-label');

export const buttonNamed = (name: string | RegExp, within: ParentNode = container) => [...within.querySelectorAll<HTMLElement>('button, [role="button"]')].find(button => (typeof name === 'string'
    ? (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name
    : name.test(button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')));

/** Presses a button the way a person does, and draws what came of it. */
export async function click(element: Element | undefined | null) {
    if (!element) throw new Error('Nothing to click');

    await act(async () => (element as HTMLElement).click());
    await draw();
}

/** A key as the dispatcher sees it, from the body or from an element, with the platform's Cmd or Ctrl for `mod`. */
export function press(key: string, { mod = false, ...init }: KeyboardEventInit & { mod?: boolean } = {}, target: Element = document.body) {
    const modifier = hotkeys.platform === 'darwin' ? { metaKey: mod } : { ctrlKey: mod };
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifier, ...init });

    target.dispatchEvent(event);

    return event;
}

/** Puts the keyboard on the task's card or row, as a person does with a click or Tab: a key that acts on the cursor task first needs it there. */
export const focusTask = (taskId: string) => act(async () => focusableOf(taskId).focus());

/** A key pressed on the task's card or row, which has the keyboard first, with the screen drawn again by the time it returns. */
export async function pressOn(taskId: string, key: string, init: KeyboardEventInit & { mod?: boolean } = {}) {
    if (document.activeElement !== focusableOf(taskId)) await focusTask(taskId);

    await act(async () => void press(key, init, focusableOf(taskId)));
    await draw();
}

/** A key typed outside any field, then the screen drawn again. */
export async function pressKeys(...keys: string[]) {
    for (const key of keys) await act(async () => void press(key));

    await draw();
}

/** Real time: the screen hands the keyboard back a tick after a dialog closes, and after a frame for the title field. */
export const wait = (ms = 40) => act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
});

/** Types into the search field the way a person does: the value, then the input event React listens to. */
export async function search(text: string) {
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;

    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await draw();
}

/** What the board's column sees when a card is dropped on it. */
export async function drop(taskId: string, column: string) {
    const event = new Event('drop', { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'dataTransfer', { value: { types: ['application/x-clowdy-task'], getData: () => taskId } });
    await act(async () => void container.querySelector(`section[aria-label="${ column }"]`)!.dispatchEvent(event));
    await draw();
}

/** The text of the screen's header controls and the path, to read what the person sees. */
export const pathText = () => [...container.querySelectorAll('nav[aria-label="Task path"] li')].map(item => item.textContent?.trim());

/** Whether a toggle of the header (a view, the sub-tasks) is on: a button of a group of one choice says it as `aria-checked`, a lone toggle as `aria-pressed`. */
export const isOn = (name: string) => {
    const button = buttonNamed(name);

    return button?.getAttribute('aria-checked') === 'true' || button?.getAttribute('aria-pressed') === 'true';
};
