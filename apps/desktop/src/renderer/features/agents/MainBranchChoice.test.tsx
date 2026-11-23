// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { gitFactsOf } from '../changes/gitFacts';
import { DraftChat } from './DraftChat';

import type { Chat, CommandResult } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { FixtureBranchScript } from '../../daemon/fixtureGitBranches';
import type { KeyValueStorage } from '../../stores/storage';

const toasts = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));

vi.mock('@clowdy/components/Toast', async importOriginal => ({
    ...(await importOriginal<typeof import('@clowdy/components/Toast')>()),
    toast: { ...(await importOriginal<typeof import('@clowdy/components/Toast')>()).toast, ...toasts },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The branch of the folder's own checkout, picked in the new chat's pill, on the fixture project: one folder, `car-rental`, a repository on `main` with the local branches `main` and `dev`, and
 * with `&branches=` words, the branches only `origin` has, the ones worktrees hold, a tree with changes and a switch that is refused or takes a while.
 */

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: FixtureTransport;

const ui = () => store.ui.forProject(FIXTURE_PROJECT_ID);
// The test build has no MobX observer plugin, so the page is drawn again by hand after a change, as the observer does in the app.
const render = () =>
    root.render(
        <RootStoreProvider value={store}>
            <DraftChat missing={new Set()} />
        </RootStoreProvider>
    );
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
        render();
    });
const press = async (target: HTMLElement) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        target.click();
        render();
    });
const key = async (target: HTMLElement, name: string) =>
    act(async () => {
        target.focus();
        target.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
        render();
    });

/** The control's pill: the only one of its kind on the page. */
const chip = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Where it runs"]');
/** The branch at the end of the main worktree's row, in the open menu. */
const branchButton = () =>
    document.body.querySelector<HTMLButtonElement>('[role="menu"] button[aria-label^="Branch:"]');
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
const menuItem = (text: string) => menuItems().find(row => row.textContent?.startsWith(text))!;
// The empty state is a row too, without a key.
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"][data-key]')];
const option = (text: string) => options().find(row => row.textContent?.startsWith(text))!;
const headings = () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="presentation"], [role="listbox"] header')]
        .map(element => element.textContent)
        .filter(Boolean);
const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
/** The popover of the branches, with the reason under its list. */
const reason = () =>
    document.body.querySelector<HTMLElement>(
        '[data-picker-popover] [role="alert"], [data-picker-popover] [role="status"]'
    );

/**
 * The page on a fixture transport with the `&branches=` words said. The fixtures have five chats working in the folder, which the pill counts and says; every chat is at rest (`idle`) unless
 * the test asks for the page as it is (`busy`), so what a test looks at is the one thing it names.
 */
async function start(scripts: FixtureBranchScript[] = [], { data = createFixtureData(), busy = false } = {}) {
    act(() => root.unmount());
    store.dispose();
    root = createRoot(container);
    transport = new FixtureTransport({ data, branches: busy ? scripts : ['idle', ...scripts] });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await act(async () => {
        ui().openDraft();
        render();
    });
    await settle();
}

/** Opens the menu and the list of the main worktree's branches, read as the popover opens. */
async function openBranches() {
    await press(chip()!);
    await press(branchButton()!);
    await settle();
    await settle();
}

async function send(words: string) {
    act(() => {
        editor().commands.insertContent(words);
    });
    await act(async () => {
        field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await settle();
}

const made = (before: ReadonlySet<string>): Chat[] =>
    [...store.selectedProject!.chats.values()].filter(chat => !before.has(chat.id));

/** The branch the folder's checkout is on, as the fixture's git says it. */
const folderBranch = async () => {
    const answer = await transport.getFolderGit(FIXTURE_PROJECT_ID, 'fld_car_rental');

    return answer.isRepository ? answer.branch : undefined;
};

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    toasts.warning.mockClear();
    toasts.error.mockClear();
    transport = new FixtureTransport({ branches: ['idle'] });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await act(async () => {
        ui().openDraft();
        render();
    });
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

describe("the branch of the main worktree's row", () => {
    it('is a chip of its own at the row’s end that opens the list of the folder’s branches, with the branch it is on checked', async () => {
        await press(chip()!);

        expect(branchButton()?.textContent).toBe('main');
        expect(menuItem('Main worktree').textContent).toBe('Main worktreeWork in the folder as it ismain');

        await press(branchButton()!);
        await settle();
        await settle();

        expect(options().map(row => row.textContent)).toEqual(['main', 'dev']);
        expect(headings()).toEqual(['Default', 'Recent']);
        expect(option('main').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(option('dev').querySelector('[aria-label="Current"]')).toBeNull();
        // The menu stays open under the list.
        expect(menuItems().length).toBeGreaterThan(0);
        expect(ui().draftWorkspace).toBeNull();
    });

    it('lists what only origin has under Remote and dims a branch that another worktree holds, saying where', async () => {
        await start(['remote', 'held']);
        await openBranches();

        expect(headings()).toEqual(['Default', 'Recent', 'Local', 'Remote']);
        expect(options().map(row => row.textContent)).toEqual([
            'main',
            'dev',
            'feature/paymentsChecked out in ~/car-rental-payments',
            'clowdy/ab12cd34Checked out in ~/…/ab12cd34/car-rental',
            'feature/search',
            'release/2.1',
            'chore/deps',
        ]);
        expect(option('feature/payments').getAttribute('aria-disabled')).toBe('true');
        expect(option('clowdy/ab12cd34').getAttribute('aria-disabled')).toBe('true');
        expect(option('feature/search').getAttribute('aria-disabled')).not.toBe('true');
    });

    it('filters as the person types, and Escape closes the list and picks nothing', async () => {
        await start(['remote']);
        await openBranches();

        const input = document.body.querySelector<HTMLInputElement>('[data-picker-popover] input')!;

        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'rel');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(options().map(row => row.textContent)).toEqual(['release/2.1']);

        await key(input, 'Escape');
        await settle();

        expect(options()).toEqual([]);
        expect(ui().draftWorkspace).toBeNull();
    });

    it('picks the highlighted branch for Enter, or else the first that is not dimmed', async () => {
        await start(['remote']);
        await openBranches();

        const input = document.body.querySelector<HTMLInputElement>('[data-picker-popover] input')!;

        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'chore');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await key(input, 'Enter');
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'main', branch: 'chore/deps' });
    });

    it('opens for the right arrow on the row, and for no other row', async () => {
        await press(chip()!);
        await key(menuItem('Manage worktrees'), 'ArrowRight');
        await settle();

        expect(options()).toEqual([]);

        await key(menuItem('Main worktree'), 'ArrowRight');
        await settle();
        await settle();

        expect(options().map(row => row.textContent)).toEqual(['main', 'dev']);
    });

    it('is out of the tab order, since the right arrow on the row is the keyboard’s way', async () => {
        await press(chip()!);

        expect(branchButton()?.getAttribute('tabindex')).toBe('-1');
    });

    it('pressing the row itself chooses the folder as it is, and the branch pressed inside it does not', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'main', branch: 'dev' });

        await press(chip()!);
        await press(menuItem('Main worktree'));
        await settle();

        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.textContent).toBe('main');
        expect(options()).toEqual([]);
    });
});

describe('picking a branch', () => {
    it('records the choice and says it in the pill, as what the checkout is switched to when the chat starts', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'main', branch: 'dev' });
        expect(chip()?.textContent).toBe('Switch todev');
        expect(chip()?.getAttribute('aria-label')).toBe('Where it runs: Main worktree, switch to branch dev');
        expect(chip()?.getAttribute('data-missing')).toBeNull();
        // Nothing was switched by picking it.
        expect(await folderBranch()).toBe('main');
        // Both lists are shut.
        expect(menuItems()).toEqual([]);
        expect(options()).toEqual([]);
    });

    it('checks the branch that was picked when the list opens again, and the branch of the chip says it', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();
        await press(chip()!);

        expect(branchButton()?.textContent).toBe('dev');

        await press(branchButton()!);
        await settle();
        await settle();

        expect(option('dev').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(option('main').querySelector('[aria-label="Current"]')).toBeNull();
    });

    it('is no choice when it is the branch the folder is on: nothing is sent', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();
        await openBranches();
        await press(option('main'));
        await settle();

        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.textContent).toBe('main');
    });

    it('goes when another mode is chosen', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();
        await press(chip()!);
        await press(menuItem('New worktree'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(chip()?.textContent).toBe('New worktreefrom origin/main');
    });
});

describe('the first message with a branch picked', () => {
    it('switches the checkout and makes the chat in the folder as it is, which then reads the new branch', async () => {
        await openBranches();
        await press(option('dev'));
        await settle();

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        const [chat] = made(before);

        expect(chat).toBeDefined();
        expect(chat?.workspace).toBeUndefined();
        expect(chat?.folderId).toBeUndefined();
        expect(await folderBranch()).toBe('dev');
        // The page gave way to the chat, and starts over as it was.
        expect(ui().draft).toBe(false);
        expect(ui().draftWorkspace).toBeNull();
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('sends the branch with the command, and the first message goes only after the chat is made', async () => {
        const commands = vi.spyOn(transport, 'command');

        await openBranches();
        await press(option('dev'));
        await settle();
        await send('Fix the price');

        expect(commands.mock.calls.map(([command]) => command.type)).toContain('chat.create');

        const create = commands.mock.calls.find(([command]) => command.type === 'chat.create')![0];

        expect(create).toMatchObject({ workspace: { mode: 'main', branch: 'dev' } });

        const order = commands.mock.calls.map(([command]) => command.type);

        expect(order.indexOf('chat.create')).toBeLessThan(order.indexOf('chat.send'));
    });

    it('sends no choice for the branch the folder is on: the command is the one it always was', async () => {
        const commands = vi.spyOn(transport, 'command');

        await send('Fix the price');

        const create = commands.mock.calls.find(([command]) => command.type === 'chat.create')![0];

        expect(create).not.toHaveProperty('workspace');
        expect(await folderBranch()).toBe('main');
    });

    it('is a branch only origin has, which the daemon makes a local one that tracks it', async () => {
        await start(['remote']);
        await openBranches();
        await press(option('feature/search'));
        await settle();
        await send('Fix the price');

        expect(await folderBranch()).toBe('feature/search');
    });

    it('marks the place as switching while the daemon works, so the Changes sidebar of the place and its moves to origin know', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });

        try {
            await start(['slow']);
            await openBranches();
            await press(option('dev'));
            await settle();

            const facts = gitFactsOf(transport).of({ projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' });

            act(() => {
                editor().commands.insertContent('Fix the price');
            });
            await act(async () => {
                field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            });

            expect(facts.switching).toBe(true);
            // The chip says it is on its way.
            await act(async () => {
                render();
            });
            expect(chip()?.textContent).toBe('Switching todev');

            await act(async () => {
                await vi.advanceTimersByTimeAsync(3000);
            });
            await settle();

            expect(facts.switching).toBe(false);
            expect(await folderBranch()).toBe('dev');
        } finally {
            vi.useRealTimers();
        }
    });

    it('tells what a switch that was made had to say, since the page gives way to the chat', async () => {
        await start(['warned']);
        await openBranches();
        await press(option('dev'));
        await settle();
        await send('Fix the price');

        expect(toasts.warning).toHaveBeenCalledWith({
            title: 'Switched to dev',
            message: 'post-checkout: the install failed',
            timeout: 12_000,
        });
        expect(await folderBranch()).toBe('dev');
    });
});

describe('what stands in the way, said before the person types', () => {
    it('dims every branch but the one the folder is on while the tree has changes, and says why with how many files', async () => {
        await start(['dirty', 'remote']);
        await openBranches();

        expect(options().map(row => row.getAttribute('aria-disabled') === 'true')).toEqual([
            false,
            true,
            true,
            true,
            true,
        ]);
        expect(reason()?.textContent).toBe('Commit or discard the changes first3 files changed');
        expect(reason()?.getAttribute('role')).toBe('status');

        // A dimmed row is never picked, by a press or by the Enter that picks the highlighted one.
        await press(option('dev'));
        await settle();
        expect(ui().draftWorkspace).toBeNull();
        expect(options().length).toBeGreaterThan(0);
    });

    it('lets the branch the folder is on be picked, which is no change', async () => {
        await start(['dirty']);
        await openBranches();
        await press(option('main'));
        await settle();

        expect(ui().draftWorkspace).toBeNull();
        expect(options()).toEqual([]);
    });

    it('offers every branch for a clean tree, and says nothing under the list', async () => {
        await openBranches();

        expect(options().every(row => row.getAttribute('aria-disabled') !== 'true')).toBe(true);
        expect(reason()).toBeNull();
    });

    it('reads the tree again each time the list opens', async () => {
        const status = vi.spyOn(transport, 'getGitStatus');

        await openBranches();
        expect(status).toHaveBeenCalledTimes(1);
        await press(option('dev'));
        await settle();
        await openBranches();
        expect(status).toHaveBeenCalledTimes(2);
    });

    it('reads nothing of git until the list opens', async () => {
        const status = vi.spyOn(transport, 'getGitStatus');
        const branches = vi.spyOn(transport, 'getGitBranches');

        await press(chip()!);
        await settle();

        expect(status).not.toHaveBeenCalled();
        expect(branches).not.toHaveBeenCalled();
    });

    it('counts the chats of the project that work in the folder, from the runs it knows, ahead of the tree', async () => {
        await start(['dirty'], { busy: true });
        await openBranches();

        expect(reason()?.textContent).toBe('5 chats are working hereStop them or wait until they finish');
        expect(options().every(row => row.getAttribute('aria-disabled') === 'true' || row.textContent === 'main')).toBe(
            true
        );
    });

    it('counts one chat as one, from the runs it knows', async () => {
        const data = createFixtureData();

        for (const run of data.runs) run.status = 'succeeded';

        const working = data.chats.find(chat => chat.orchestratorRunId && !chat.workspace)!;

        data.runs.find(candidate => candidate.id === working.orchestratorRunId)!.status = 'running';
        await start([], { data, busy: true });
        await openBranches();

        expect(reason()?.textContent).toBe('1 chat is working hereStop them or wait until they finish');
    });
});

describe('what the daemon refuses with at the moment of use', () => {
    /** A page whose tree is clean when the person picks, and has changes when they send (the window did not know). */
    async function pickedThenRefused(script: FixtureBranchScript[]) {
        await start(script);
        await openBranches();
        await press(option('dev'));
        await settle();

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        return before;
    }

    it('makes no chat, gives the message back to the box, keeps the choice and says why in the pill', async () => {
        const before = await pickedThenRefused(['refused']);

        expect(made(before)).toEqual([]);
        expect(editor().getText()).toContain('Fix the price');
        expect(ui().draft).toBe(true);
        expect(ui().draftWorkspace).toEqual({ mode: 'main', branch: 'dev' });
        expect(toasts.error).toHaveBeenCalledWith({ message: '2 chats are working here' });
        expect(await folderBranch()).toBe('main');

        expect(chip()?.getAttribute('data-missing')).toBe('true');
        expect(chip()?.getAttribute('aria-label')).toBe(
            'Where it runs: Main worktree, switch to branch dev, 2 chats are working here (Stop them or wait until they finish)'
        );

        await press(chip()!);
        await press(branchButton()!);
        await settle();
        await settle();

        expect(reason()?.textContent).toBe('2 chats are working hereStop them or wait until they finish');
        expect(reason()?.getAttribute('role')).toBe('alert');
    });

    it('can be sent again from where it was refused: the person goes back to the folder as it is, and the message in the box is made a chat', async () => {
        const before = await pickedThenRefused(['refused']);

        expect(made(before)).toEqual([]);

        await press(chip()!);
        await press(menuItem('Main worktree'));
        await settle();
        expect(ui().draftWorkspace).toBeNull();

        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
        expect(await folderBranch()).toBe('main');
    });

    it('forgets the reason when another branch is picked, and when the mode changes', async () => {
        await pickedThenRefused(['refused']);
        await openBranches();
        await press(option('main'));
        await settle();

        expect(ui().draftWorkspace).toBeNull();
        expect(chip()?.getAttribute('data-missing')).toBeNull();

        await openBranches();
        await press(option('dev'));
        await settle();

        // The same branch again is a new try, not the one that was refused.
        expect(chip()?.getAttribute('data-missing')).toBeNull();
    });

    it('says a refusal for a tree that changed meanwhile, with the files the daemon counted', async () => {
        await start();
        await openBranches();
        await press(option('dev'));
        await settle();

        // Somebody changed the tree after the list was read: the pill did not know, the daemon does.
        const dirty = new FixtureTransport({ branches: ['dirty'] });

        vi.spyOn(transport, 'switchGitBranch').mockImplementation((...args) => dirty.switchGitBranch(...args));

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(before)).toEqual([]);
        expect(toasts.error).toHaveBeenCalledWith({ message: 'Commit or discard the changes first' });
        expect(editor().getText()).toContain('Fix the price');
    });
});

describe('the start page of a project with no chat', () => {
    it('keeps what the pill picks although no row of the list opened the new-chat page: the page opens it', async () => {
        // The page shown for an empty project is not the page `openDraft` opened: the store would ignore the pick.
        act(() => root.unmount());
        store.dispose();
        root = createRoot(container);
        transport = new FixtureTransport({ branches: ['idle'] });
        store = new RootStore(transport, { storage: memoryStorage() });
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        expect(ui().draft).toBe(false);

        await act(async () => render());
        await settle();

        expect(ui().draft).toBe(true);

        await openBranches();
        await press(option('dev'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'main', branch: 'dev' });
        expect(chip()?.textContent).toBe('Switch todev');
    });
});

describe('a folder git cannot change the branch of', () => {
    it('has no list for a folder that is no repository: the pill is not there', async () => {
        await start();
        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({ isRepository: false });
        act(() => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(chip()).toBeNull();
    });

    it('reads a failed list into the popover instead of a list', async () => {
        await press(chip()!);
        vi.spyOn(transport, 'getGitBranches').mockRejectedValue(new Error('git did not answer'));
        await press(branchButton()!);
        await settle();
        await settle();

        expect(options()).toEqual([]);
        expect(reason()?.textContent).toBe('git did not answer');
        expect(document.body.textContent).toContain('No branches to show');
        expect(ui().draftWorkspace).toBeNull();
    });

    it('sends a command result that is no refusal of the switch through as it is', async () => {
        const unavailable: CommandResult = {
            ok: false,
            requestId: 'req-x',
            error: { code: 'unavailable', message: 'No daemon' },
        };

        await openBranches();
        await press(option('dev'));
        await settle();
        vi.spyOn(transport, 'command').mockResolvedValue(unavailable);

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(before)).toEqual([]);
        expect(editor().getText()).toContain('Fix the price');
        expect(chip()?.getAttribute('aria-label')).toContain('No daemon');
    });
});
