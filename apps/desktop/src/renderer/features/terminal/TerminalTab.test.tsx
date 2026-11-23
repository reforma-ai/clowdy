// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import TerminalTab, { TerminalShell } from './TerminalTab';
import { terminalsStoreOf } from './useTerminalsStore';

import type { Chat } from '@clowdy/protocol';
import type { TerminalSession } from './TerminalsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// xterm needs a layout engine: here the view is only asked to mount, unmount and be disposed, and says so.
const views: Array<{ mounts: number; unmounts: number; disposed: boolean; options: { onGone: () => void } }> = [];

vi.mock('./TerminalView', () => ({
    TerminalView: class {
        mounts = 0;
        unmounts = 0;
        disposed = false;

        constructor(
            _session: unknown,
            readonly options: { onGone: () => void }
        ) {
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

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
const press = (target: Element | null | undefined) =>
    act(async () => {
        target?.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target?.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        (target as HTMLElement | null | undefined)?.click();
    });
const bar = () => container.querySelector('[role="tablist"][aria-label="Terminals"]');
const tabs = () => [...(bar()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
const labels = () => tabs().map(button => button.textContent);
const chosen = () => tabs().find(button => button.getAttribute('aria-selected') === 'true')?.textContent;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const textButton = (text: string) =>
    [...container.querySelectorAll('button')].find(candidate => candidate.textContent === text);

async function draw(element: React.ReactElement) {
    act(() => root.render(<RootStoreProvider value={store}>{element}</RootStoreProvider>));
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

    it('closes a shell with its cross and ends it in the daemon, and shuts the panel when the last goes', async () => {
        const ui = store.ui.forProject(store.selectedProjectId!);

        ui.openSidePanelTab('terminal');
        await draw(<Tab />);
        await press(button('New terminal'));
        await press(button('Close zsh 2'));
        await settle();

        const terminals = terminalsStoreOf(store.transport);

        expect(labels()).toEqual(['zsh']);
        expect(views[1].disposed).toBe(true);
        expect(await store.transport.listTerminals()).toHaveLength(1);
        // One shell is left: the panel stays.
        expect(ui.sidePanelOpen).toBe(true);

        await press(button('Close zsh'));
        await settle();

        expect(terminals.sessions).toHaveLength(0);
        expect(ui.sidePanelOpen).toBe(false);
        expect(container.textContent).not.toContain('No terminals');
        expect(await store.transport.listTerminals()).toHaveLength(0);
    });

    it('starts a shell when the tab is opened again with none, so it is never open on nothing', async () => {
        const ui = store.ui.forProject(store.selectedProjectId!);

        ui.openSidePanelTab('terminal');
        await draw(<Tab />);
        await press(button('Close zsh'));
        await settle();

        expect(ui.sidePanelOpen).toBe(false);

        await draw(<p>Another tab</p>);
        ui.openSidePanelTab('terminal');
        await draw(<Tab />);

        expect(labels()).toEqual(['zsh']);
        expect(terminalsStoreOf(store.transport).sessions).toHaveLength(1);
        expect(ui.sidePanelOpen).toBe(true);
    });

    it('shuts the panel when the daemon takes away the last shell, and keeps it while another is left', async () => {
        const ui = store.ui.forProject(store.selectedProjectId!);
        const terminals = terminalsStoreOf(store.transport);

        ui.openSidePanelTab('terminal');
        await draw(<Tab />);
        await press(button('New terminal'));
        await settle();

        expect(terminals.sessions).toHaveLength(2);

        // What the view does when the daemon says its shell is gone: first the chosen one, then the other.
        act(() => views[1].options.onGone());

        expect(terminals.sessions).toHaveLength(1);
        expect(ui.sidePanelOpen).toBe(true);

        act(() => views[0].options.onGone());

        expect(terminals.sessions).toHaveLength(0);
        expect(ui.sidePanelOpen).toBe(false);
    });

    it('does not start a second shell on a second look, and brings back the one the daemon already runs', async () => {
        const folder = store.selectedProject!.project.folders[0];

        await store.transport.createTerminal({
            projectId: store.selectedProjectId!,
            folderId: folder.id,
            cols: 80,
            rows: 24,
        });
        await draw(<Tab />);

        expect(labels()).toEqual(['zsh']);
        expect(await store.transport.listTerminals()).toHaveLength(1);
    });

    it('says the reason in a toast and shuts the panel when the daemon refuses to start a shell', async () => {
        const ui = store.ui.forProject(store.selectedProjectId!);
        const error = vi.spyOn(toast, 'error').mockImplementation(() => '');

        ui.openSidePanelTab('terminal');
        vi.spyOn(store.transport, 'createTerminal').mockRejectedValue(new Error('The folder /p is missing'));
        await draw(<Tab />);

        expect(error).toHaveBeenCalledWith({ title: 'Couldn’t start a terminal', message: 'The folder /p is missing' });
        expect(ui.sidePanelOpen).toBe(false);
        expect(container.textContent).not.toContain('No terminals');
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

        await draw(<Shell session={made} />);
        expect(container.textContent).not.toContain('Process exited');

        act(() => made.update({ state: 'exited', exitCode: 1 }));

        expect(container.textContent).toContain('Process exited');

        await press(textButton('New terminal'));
        await settle();

        expect(terminalsStoreOf(store.transport).sessions).toHaveLength(2);
    });

    it('says it is reconnecting while the stream is down', async () => {
        const made = await session();

        await draw(<Shell session={made} />);
        act(() => made.setStatus('reconnecting'));

        expect(container.textContent).toContain('Reconnecting');

        act(() => made.setStatus('open'));

        expect(container.textContent).not.toContain('Reconnecting');
    });

    it('moves its view out of the tab when the tab goes, and keeps it for the next time', async () => {
        const made = await session();

        await draw(<Shell session={made} />);
        await draw(<p>Another tab</p>);

        expect(views).toHaveLength(1);
        expect(views[0].unmounts).toBe(1);
        expect(views[0].disposed).toBe(false);

        await draw(<Shell session={made} />);

        expect(views).toHaveLength(1);
        expect(views[0].mounts).toBe(2);
    });
});

describe("the Terminal tab in a chat's worktree", () => {
    const WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';

    beforeEach(async () => {
        terminalsStoreOf(store.transport).dispose();
        store.dispose();
        store = new RootStore(new FixtureTransport({ data: withFixtureWorkspace(createFixtureData()) }), {
            storage: memory(),
        });
        await store.load();
        await settle();
    });

    const openWorktreeChat = () => store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);

    it("opens on a shell in the worktree, and the folder's own shells are not its tabs", async () => {
        store.selectProject(FIXTURE_PROJECT_ID);
        await store.transport.createTerminal({
            projectId: FIXTURE_PROJECT_ID,
            folderId: 'fld_car_rental',
            cols: 80,
            rows: 24,
        });
        openWorktreeChat();
        await draw(<Tab />);

        const terminals = terminalsStoreOf(store.transport);

        expect(labels()).toEqual(['zsh']);
        expect(terminals.sessions.map(session => [session.info.cwd, session.info.workspaceId])).toEqual([
            ['/Users/dev/car-rental', undefined],
            [WORKTREE, 'wks_ab12cd34'],
        ]);
        expect(terminals.activeOf(FIXTURE_PROJECT_ID, 'fld_car_rental', 'wks_ab12cd34')?.info.cwd).toBe(WORKTREE);
    });

    it("adds a shell in the worktree with the plus, and brings back the folder's own shells when another chat is open", async () => {
        store.selectProject(FIXTURE_PROJECT_ID);
        openWorktreeChat();
        await draw(<Tab />);
        await press(button('New terminal'));
        await settle();

        const terminals = terminalsStoreOf(store.transport);

        expect(labels()).toEqual(['zsh', 'zsh 2']);
        expect(terminals.sessionsOf(FIXTURE_PROJECT_ID, 'fld_car_rental', 'wks_ab12cd34')).toHaveLength(2);
        expect(terminals.sessionsOf(FIXTURE_PROJECT_ID, 'fld_car_rental')).toEqual([]);

        // The folder's own checkout has its shell of its own: a second look at it starts one there.
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(null);
        await settle();
        await settle();

        expect(labels()).toEqual(['zsh']);
        expect(terminals.sessionsOf(FIXTURE_PROJECT_ID, 'fld_car_rental')).toHaveLength(1);
        expect(terminals.sessionsOf(FIXTURE_PROJECT_ID, 'fld_car_rental')[0]!.info.cwd).toBe('/Users/dev/car-rental');
    });

    it("says the worktree is not made yet and starts no shell for it, then opens on one once the chat's first message has made it", async () => {
        const made = await store.command({
            type: 'chat.create',
            projectId: FIXTURE_PROJECT_ID,
            workspace: { mode: 'new' },
        });
        const { chat } = (made as { data: { chat: Chat } }).data;
        const project = store.projectState(FIXTURE_PROJECT_ID)!;

        await vi.waitFor(() => expect(project.chats.get(chat.id)?.workspace?.ready).toBe(false));
        store.selectProject(FIXTURE_PROJECT_ID);
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(chat.id);
        await draw(<Tab />);

        const terminals = terminalsStoreOf(store.transport);

        expect(container.textContent).toContain('The worktree is not made yet');
        expect(bar()).toBeNull();
        expect(terminals.sessions).toEqual([]);

        // The chat's first message makes the worktree, and the daemon says so.
        await store.command({ type: 'chat.send', chatId: chat.id, text: 'Go' });
        await vi.waitFor(() => expect(project.chats.get(chat.id)?.workspace?.ready).toBe(true));
        await settle();
        await settle();

        expect(container.textContent).not.toContain('The worktree is not made yet');
        expect(labels()).toEqual(['zsh']);
        expect(terminals.sessions[0]?.info.workspaceId).toBe(chat.workspace!.id);
    });
});
