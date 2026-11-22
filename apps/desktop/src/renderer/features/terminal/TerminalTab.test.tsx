// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import TerminalTab, { TerminalShell } from './TerminalTab';
import { terminalsStoreOf } from './useTerminalsStore';

import type { TerminalSession } from './TerminalsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// xterm needs a layout engine: here the view is only asked to mount, unmount and be disposed, and says so.
const views: Array<{ mounts: number; unmounts: number; disposed: boolean }> = [];

vi.mock('./TerminalView', () => ({
    TerminalView: class {
        mounts = 0;
        unmounts = 0;
        disposed = false;

        constructor() {
            views.push(this);
        }

        mount() {
            this.mounts++;
        }

        unmount() {
            this.unmounts++;
        }

        fit() {}
        syncTheme() {}

        dispose() {
            this.disposed = true;
        }
    },
}));

// The babel plugin that makes the app's components observers does not run under Vitest.
const Tab = observer(TerminalTab);
const Shell = observer(TerminalShell);

const memory = () => {
    const data = new Map<string, string>();

    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const press = (target: Element | null | undefined) => act(async () => {
    target?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    (target as HTMLElement | null | undefined)?.click();
});
const bar = () => container.querySelector('[aria-label="Terminals"]');
const tabs = () => [...(bar()?.querySelectorAll<HTMLButtonElement>('button:not([aria-label])') ?? [])];
const labels = () => tabs().map(button => button.textContent);
const chosen = () => tabs().find(button => button.getAttribute('aria-pressed') === 'true')?.textContent;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`);
const textButton = (text: string) => [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text);

async function draw(element: React.ReactElement) {
    act(() => root.render(<RootStoreProvider value={ store }>{ element }</RootStoreProvider>));
    await settle();
    await settle();
}

beforeEach(async () => {
    views.length = 0;
    store = new RootStore(new FixtureTransport(), { storage: memory() });
    await store.load();
    await settle();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    terminalsStoreOf(store.transport).dispose();
    store.dispose();
});

describe('the Terminal tab', () => {
    it('opens on a shell of the folder the window is in, with a tab for it', async () => {
        await draw(<Tab />);

        const terminals = terminalsStoreOf(store.transport);

        expect(labels()).toEqual(['zsh']);
        expect(chosen()).toBe('zsh');
        expect(terminals.sessions).toHaveLength(1);
        expect(terminals.sessions[0].info.projectId).toBe(store.selectedProjectId);
        expect(container.querySelector('[data-terminal]')).not.toBeNull();
        expect(views).toHaveLength(1);
        expect(views[0].mounts).toBe(1);
    });

    it('adds a shell with the plus, numbers the ones that share a name, and shows the one that is picked', async () => {
        await draw(<Tab />);
        await press(button('New terminal'));
        await settle();

        expect(labels()).toEqual(['zsh', 'zsh 2']);
        expect(chosen()).toBe('zsh 2');
        expect(views).toHaveLength(2);

        await press(tabs()[0]);

        expect(chosen()).toBe('zsh');
    });

    it('closes a shell with its cross, ends it in the daemon, and leaves an empty tab with a way to start one when the last goes', async () => {
        await draw(<Tab />);
        await press(button('New terminal'));
        await press(button('Close zsh 2'));
        await settle();

        const terminals = terminalsStoreOf(store.transport);

        expect(labels()).toEqual(['zsh']);
        expect(views[1].disposed).toBe(true);
        expect(await store.transport.listTerminals()).toHaveLength(1);

        await press(button('Close zsh'));
        await settle();

        expect(labels()).toEqual([]);
        expect(container.textContent).toContain('No terminals');
        expect(terminals.sessions).toHaveLength(0);

        await press(textButton('New terminal'));
        await settle();

        expect(labels()).toEqual(['zsh']);
    });

    it('does not start a second shell on a second look, and brings back the one the daemon already runs', async () => {
        const folder = store.selectedProject!.project.folders[0];

        await store.transport.createTerminal({ projectId: store.selectedProjectId!, folderId: folder.id, cols: 80, rows: 24 });
        await draw(<Tab />);

        expect(labels()).toEqual(['zsh']);
        expect(await store.transport.listTerminals()).toHaveLength(1);
    });

    it('says the reason when the daemon refuses to start a shell', async () => {
        vi.spyOn(store.transport, 'createTerminal').mockRejectedValue(new Error('The folder /p is missing'));
        await draw(<Tab />);

        expect(container.textContent).toContain('No terminals');
        expect(container.textContent).toContain('The folder /p is missing');
    });
});

describe('a shell in the tab', () => {
    async function session(): Promise<TerminalSession> {
        const terminals = terminalsStoreOf(store.transport);
        const made = await terminals.start(store.selectedProjectId!, store.selectedProject!.project.folders[0].id);

        return made!;
    }

    it('says the shell exited, and offers a new one', async () => {
        const made = await session();

        await draw(<Shell session={ made } />);
        expect(container.textContent).not.toContain('Process exited');

        act(() => made.update({ state: 'exited', exitCode: 1 }));

        expect(container.textContent).toContain('Process exited');

        await press(textButton('New terminal'));
        await settle();

        expect(terminalsStoreOf(store.transport).sessions).toHaveLength(2);
    });

    it('says it is reconnecting while the stream is down', async () => {
        const made = await session();

        await draw(<Shell session={ made } />);
        act(() => made.setStatus('reconnecting'));

        expect(container.textContent).toContain('Reconnecting');

        act(() => made.setStatus('open'));

        expect(container.textContent).not.toContain('Reconnecting');
    });

    it('moves its view out of the tab when the tab goes, and keeps it for the next time', async () => {
        const made = await session();

        await draw(<Shell session={ made } />);
        await draw(<p>Another tab</p>);

        expect(views).toHaveLength(1);
        expect(views[0].unmounts).toBe(1);
        expect(views[0].disposed).toBe(false);

        await draw(<Shell session={ made } />);

        expect(views).toHaveLength(1);
        expect(views[0].mounts).toBe(2);
    });
});
