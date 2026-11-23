// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, withFixtureWorkspace, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { currentPlace } from '../sidePanel/currentPlace';
import { DraftChat } from './DraftChat';

import type { Chat, CommandResult, FolderGit } from '@clowdy/protocol';
import type { Editor } from '@tiptap/core';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The new-chat page's chips for where the chat works, on the fixture project: one folder, `car-rental`, a repository on `main` whose default branch is `origin/main`, with
 * the branches `main`, `dev`, `feature/payments`, `origin/main` and `origin/dev`, and one worktree besides its own, `clowdy/ab12cd34`, with changes in it.
 */

const API = { id: 'fld_api', path: '/Users/dev/car-rental-api' };
const WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

const ui = (projectId = FIXTURE_PROJECT_ID) => store.ui.forProject(projectId);
// The test build has no MobX observer plugin, so the page is drawn again by hand after a change, as the observer does in the app.
const render = () => root.render(<RootStoreProvider value={ store }><DraftChat missing={ new Set() } /></RootStoreProvider>);
const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    render();
});
const press = async (target: HTMLElement) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    target.click();
    render();
});

const modeChip = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Where it runs"]');
const baseChip = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Branch from"]');
const folderSelect = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Folder:"]');
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')];
const menuItem = (text: string) => menuItems().find(row => row.textContent?.startsWith(text))!;
const options = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const option = (text: string) => options().find(row => row.textContent?.startsWith(text))!;
const search = () => document.body.querySelector<HTMLInputElement>('input[type="text"]')!;
const field = () => container.querySelector<HTMLElement>('[contenteditable="true"]');
const editor = () => (field() as HTMLElement & { editor: Editor }).editor;
/** What the line under the message box says, apart from the mode at its end. */
const line = () => container.textContent;

const draw = (before?: () => void) => act(async () => {
    before?.();
    render();
});

async function start({ data = createFixtureData(), project = FIXTURE_PROJECT_ID, transport = new FixtureTransport({ data }) }: { data?: FixtureData; project?: string; transport?: FixtureTransport } = {}) {
    act(() => root.unmount());
    store.dispose();
    root = createRoot(container);
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(project);
    await draw(() => ui(project).openDraft());
    await settle();
}

async function chooseMode(text: string) {
    await press(modeChip()!);
    await press(menuItem(text));
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

/** What the daemon answers a command it cannot take. */
const refused: CommandResult = { ok: false, requestId: 'req-refused', error: { code: 'unavailable', message: 'No daemon' } };

const made = (before: ReadonlySet<string>): Chat[] => [...store.selectedProject!.chats.values()].filter(chat => !before.has(chat.id));

beforeEach(async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await draw(() => ui().openDraft());
    await settle();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
});

describe('the mode chip', () => {
    it('says Project checkout to begin with, with the branch that is checked out beside it and nothing to pick it from', () => {
        expect(modeChip()?.textContent).toBe('Project checkout');
        expect(line()).toContain('Project checkoutmain');
        expect(container.querySelector('[aria-label="Branch: main"]')).not.toBeNull();
        expect(baseChip()).toBeNull();
    });

    it('lists Project checkout, New worktree and Existing worktree, the chosen one ticked, each with a line of what it does', async () => {
        await press(modeChip()!);

        expect(menuItems().map(row => row.textContent)).toEqual([
            'Project checkoutWork in the folder as it is',
            'New worktreeA separate checkout on a branch of its own',
            'Existing worktree…Pick one the folder already has',
        ]);
        expect(menuItems().map(row => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
        expect(menuItems().every(row => row.getAttribute('aria-disabled') !== 'true')).toBe(true);
    });

    it('makes the chat a new worktree from the default branch, with Branch from as its second chip in place of the branch label', async () => {
        await chooseMode('New worktree');

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(modeChip()?.textContent).toBe('New worktree');
        expect(baseChip()?.textContent).toBe('Branch from: origin/main');
        expect(container.querySelector('[aria-label="Branch: main"]')).toBeNull();

        await press(modeChip()!);

        expect(menuItem('New worktree').getAttribute('aria-checked')).toBe('true');
    });

    // A single choice list shuts for Enter, and leaves itself open for Space unless its items say otherwise.
    it('shuts for Space as for Enter, and opens the list of worktrees only for the item that asks it, as the menu closes', async () => {
        const key = async (target: HTMLElement, name: string, code: string) => act(async () => {
            target.focus();
            target.dispatchEvent(new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: name, code, bubbles: true, cancelable: true }));
            render();
        });

        await press(modeChip()!);
        await key(menuItem('New worktree'), ' ', 'Space');
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
        expect(menuItems()).toEqual([]);
        expect(options()).toEqual([]);

        await press(modeChip()!);
        await key(menuItem('Existing worktree'), ' ', 'Space');
        await settle();

        expect(menuItems()).toEqual([]);
        expect(options().map(row => row.textContent)).toEqual(['clowdy/ab12cd34No chat uses itChanges']);
    });

    it('does not open the list of worktrees for a menu that was shut some other way after Existing worktree was asked for', async () => {
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();
        await act(async () => {
            search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(options()).toEqual([]);

        // The next time the menu opens and shuts, no list comes with it.
        await press(modeChip()!);
        await press(menuItem('Project checkout'));
        await settle();

        expect(options()).toEqual([]);
        expect(ui().draftWorkspace).toBeNull();
    });

    it('goes back to Project checkout from a worktree', async () => {
        await chooseMode('New worktree');
        await chooseMode('Project checkout');

        expect(ui().draftWorkspace).toBeNull();
        expect(baseChip()).toBeNull();
        expect(container.querySelector('[aria-label="Branch: main"]')).not.toBeNull();
    });

    it('keeps the base that was picked when New worktree is pressed again', async () => {
        await chooseMode('New worktree');
        await press(baseChip()!);
        await press(option('dev'));
        await chooseMode('New worktree');

        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'dev' });
    });
});

describe('the branch a new worktree starts from', () => {
    beforeEach(async () => {
        await chooseMode('New worktree');
        await press(baseChip()!);
    });

    it('lists the branches, local and remote, with the default one marked and ticked', () => {
        expect(options().map(row => row.textContent)).toEqual(['main', 'dev', 'feature/payments', 'origin/mainDefault', 'origin/dev']);
        expect(option('origin/main').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(baseChip()?.hasAttribute('data-open')).toBe(true);
    });

    it('is searched as the person types', async () => {
        await act(async () => {
            search().focus();
        });
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), 'pay');
            search().dispatchEvent(new Event('input', { bubbles: true }));
        });

        expect(options().map(row => row.textContent)).toEqual(['feature/payments']);
    });

    it('sets the base to the one picked and shuts the list', async () => {
        await press(option('origin/dev'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'origin/dev' });
        expect(baseChip()?.textContent).toBe('Branch from: origin/dev');
        expect(options()).toEqual([]);
    });

    it('is shut by Escape, and keeps the base', async () => {
        await act(async () => {
            search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(options()).toEqual([]);
        expect(ui().draftWorkspace).toEqual({ mode: 'new' });
    });
});

describe('Existing worktree', () => {
    it('lists the worktrees of the folder but the folder\'s own, by branch, with the chats that use each and a mark for changes', async () => {
        await start({ data: withFixtureWorkspace(createFixtureData()) });
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();

        expect(options().map(row => row.textContent)).toEqual(['clowdy/ab12cd34Weekend surcharge in a worktreeChanges']);
    });

    it('says no chat uses a worktree nobody has picked yet', async () => {
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();

        expect(options().map(row => row.textContent)).toEqual(['clowdy/ab12cd34No chat uses itChanges']);
    });

    it('names a few chats, and counts the rest', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const used = data.chats.find(chat => chat.workspace)!;

        for (const [id, title] of [['c-x1', 'Second chat'], ['c-x2', 'Third chat'], ['c-x3', 'Fourth chat']]) data.chats.push({ ...structuredClone(used), id, title, orchestratorRunId: undefined });

        await start({ data });
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();

        expect(options()[0]?.textContent).toContain('Weekend surcharge in a worktree, Second chat and 2 more');
    });

    it('sends the chat into the worktree that is picked, with that worktree as the mode\'s own label and no branch chip', async () => {
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();
        await press(option('clowdy/ab12cd34'));
        await settle();

        expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: WORKTREE });
        expect(modeChip()?.textContent).toBe('Worktree: clowdy/ab12cd34');
        expect(baseChip()).toBeNull();
        expect(container.querySelector('[aria-label^="Branch:"]')).toBeNull();
        expect(options()).toEqual([]);

        await press(modeChip()!);

        expect(menuItem('Existing worktree').getAttribute('aria-checked')).toBe('true');
    });

    it('is off, saying so, in a folder that has no other worktree', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockResolvedValue({ isRepository: true, branch: 'main', defaultBranch: 'origin/main', branches: [{ name: 'main', remote: false }], worktrees: [{ path: '/Users/dev/car-rental', branch: 'main', head: 'a1b2c3d', main: true, dirty: false }] });
        await start({ transport });
        await press(modeChip()!);

        expect(menuItem('Existing worktree').getAttribute('aria-disabled')).toBe('true');
        expect(menuItem('Existing worktree').textContent).toContain('The folder has no other worktrees');
    });
});

describe('a folder that offers no worktree', () => {
    const hint = async () => {
        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            container.querySelector<HTMLElement>('[role="button"][aria-disabled][aria-label="Where it runs: Project checkout"]')!.focus();
        });
        await settle();

        return document.querySelector('[role="tooltip"]')?.textContent;
    };

    it('keeps Project checkout alone, off, and says on hover that the folder is no repository', async () => {
        await start({ project: FIXTURE_PERSONAL_PROJECT_ID });

        expect(modeChip()).toBeNull();
        expect(container.querySelector('[aria-label="Where it runs: Project checkout"]')?.textContent).toBe('Project checkout');
        expect(await hint()).toBe('This folder is not a git repository');
        // Nothing of a branch.
        expect(container.querySelector('[aria-label^="Branch"]')).toBeNull();
    });

    it('says why the daemon could not read the folder, in its own words when it gave them', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockRejectedValue(new TransportError('git did not answer', 503));
        await start({ transport });

        expect(modeChip()).toBeNull();
        expect(await hint()).toBe('Git did not answer');
    });

    it('says something when the daemon gave no reason', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockRejectedValue(new Error(''));
        await start({ transport });

        expect(await hint()).toBe('Couldn\'t read the folder\'s git');
    });

    it('is off with no word to say while the daemon has not answered yet', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await start({ transport });

        expect(modeChip()).toBeNull();
        expect(container.querySelector('[aria-label="Where it runs: Project checkout"]')).not.toBeNull();
        expect(container.querySelector('[role="button"][aria-label^="Where it runs"]')).toBeNull();
    });

    it('holds the first message while a choice that was made waits for the read, rather than send the chat to the folder itself, and lets it go once the read answers', async () => {
        const transport = new FixtureTransport();
        let answer: (git: FolderGit) => void = () => undefined;

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>((resolve) => {
            answer = resolve;
        }));
        await start({ transport });
        // The page comes back from another chat (back, forward) with its choice, and the read is on its way again.
        await draw(() => ui().setDraftWorkspace({ mode: 'new', base: 'dev' }));

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');
        expect(made(before)).toHaveLength(0);
        expect(editor().getText()).toContain('Fix it');

        const sentWith = await FixtureTransport.prototype.getFolderGit.call(transport, FIXTURE_PROJECT_ID, 'fld_car_rental');

        await act(async () => answer(sentWith));
        await settle();
        await act(async () => {
            field()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace?.managed).toBe(true);
    });

    it('holds nothing back while the read is on its way and Project checkout is what was chosen', async () => {
        const transport = new FixtureTransport();

        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await start({ transport });

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });

    it('sends the chat to the folder itself, whatever had been chosen, while the read does not bear the choice out', async () => {
        const transport = new FixtureTransport();
        const read = vi.spyOn(transport, 'getFolderGit');

        await start({ transport });
        await chooseMode('New worktree');
        expect(ui().draftWorkspace).toEqual({ mode: 'new' });

        // The window gets focus, and the read now says the folder is no repository: the chips are Project checkout again and nothing is sent.
        read.mockResolvedValue({ isRepository: false });
        act(() => void window.dispatchEvent(new Event('focus')));
        await settle();

        expect(container.querySelector('[aria-label="Where it runs: Project checkout"]')).not.toBeNull();

        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix it');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });
});

describe('the first message', () => {
    it('makes a chat in the folder itself when Project checkout is on', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace).toBeUndefined();
    });

    it('makes a chat in a new worktree that starts from the base that was picked', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await chooseMode('New worktree');
        await press(baseChip()!);
        await press(option('dev'));
        await send('Fix the price');

        const [chat] = made(before);

        // The fixture daemon makes the worktree at the first message, as the daemon does: it is ready, on the branch of its own, with the step in the chat's stream.
        expect(chat?.workspace).toMatchObject({ managed: true, ready: true, folderId: 'fld_car_rental', branch: `clowdy/${ chat!.id.slice(-8) }` });
        expect((await store.transport.getItems({ chatId: chat!.id })).slice(0, 2).map(item => (item.body.kind === 'tool' ? item.body.name : item.body.kind))).toEqual(['user', 'workspace']);
    });

    it('makes a chat in the existing worktree that was picked, sharing the worktree with the chats that have it', async () => {
        const before = new Set(store.selectedProject!.chats.keys());

        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();
        await press(option('clowdy/ab12cd34'));
        await send('Fix the price');

        expect(made(before)[0]?.workspace).toMatchObject({ path: WORKTREE, ready: true, branch: 'clowdy/ab12cd34' });
    });

    it('shows the chat that was made, and the page that made it starts over in Project checkout', async () => {
        await chooseMode('New worktree');
        await send('Fix the price');

        expect(ui().draft).toBe(false);
        expect(ui().draftWorkspace).toBeNull();

        await draw(() => ui().openDraft());
        await settle();

        expect(modeChip()?.textContent).toBe('Project checkout');
    });

    it('goes on in the chat a first message that failed had made while the choice is as it was, and starts another when it changed', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        const commands = vi.spyOn(transport, 'command');

        await start({ transport });
        await chooseMode('New worktree');

        // The chat is made, and its first message is refused.
        commands.mockImplementationOnce(original).mockImplementationOnce(async () => refused);

        const before = new Set(store.selectedProject!.chats.keys());

        await send('First try');
        expect(made(before)).toHaveLength(1);
        expect(ui().draft).toBe(true);

        commands.mockRestore();
        await send('Second try');
        // The retry goes to the chat that was made, which has its worktree.
        expect(made(before)).toHaveLength(1);
        expect(made(before)[0]?.workspace?.managed).toBe(true);
        expect(ui().draft).toBe(false);
    });

    it('makes another chat when the worktree was changed after a first message that failed, since a chat\'s worktree is fixed from the start', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        const commands = vi.spyOn(transport, 'command');

        await start({ transport });
        await chooseMode('New worktree');
        commands.mockImplementationOnce(original).mockImplementationOnce(async () => refused);

        const before = new Set(store.selectedProject!.chats.keys());

        await send('First try');
        expect(made(before)).toHaveLength(1);

        commands.mockRestore();
        await chooseMode('Project checkout');
        await send('Second try');

        const chats = made(before);

        expect(chats).toHaveLength(2);
        expect(chats.filter(chat => chat.workspace)).toHaveLength(1);
        expect(ui().draft).toBe(false);
        expect(ui().chatId).toBe(chats.find(chat => !chat.workspace)?.id);
    });
});

describe('the folder of the page', () => {
    const twoFolders = () => {
        const data = createFixtureData();

        data.projects.find(candidate => candidate.id === FIXTURE_PROJECT_ID)!.folders.push(API);

        return data;
    };

    it('takes the chips along: the lists are read for the folder that is picked, and the choice goes back to Project checkout', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });
        const read = vi.spyOn(transport, 'getFolderGit');

        await start({ transport });
        await chooseMode('New worktree');
        await press(baseChip()!);
        await press(option('dev'));

        expect(ui().draftWorkspace).toEqual({ mode: 'new', base: 'dev' });
        expect(read).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, 'fld_car_rental');

        await press(folderSelect()!);
        await press([...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(row => row.textContent === 'car-rental-api')!);
        await settle();

        expect(read).toHaveBeenLastCalledWith(FIXTURE_PROJECT_ID, API.id);
        expect(ui().draftWorkspace).toBeNull();
        expect(modeChip()?.textContent).toBe('Project checkout');
        // The branch label is the other folder's.
        expect(container.querySelector('[aria-label="Branch: feature/payments"]')).not.toBeNull();
    });

    it('shows no chip of the folder it had while the answer for the new one is on its way, and sends nothing for it', async () => {
        const transport = new FixtureTransport({ data: twoFolders() });

        await start({ transport });
        await chooseMode('New worktree');
        vi.spyOn(transport, 'getFolderGit').mockReturnValue(new Promise<FolderGit>(() => undefined));
        await draw(() => ui().setDraftFolder(API.id));

        expect(baseChip()).toBeNull();
        expect(container.querySelector('[aria-label^="Branch"]')).toBeNull();
        expect(container.querySelector('[aria-label="Where it runs: Project checkout"]')).not.toBeNull();
    });

    it('keeps the choice with the page through another chat, back and forward', async () => {
        await chooseMode('New worktree');
        await press(baseChip()!);
        await press(option('dev'));

        const view = ui().view;

        await draw(() => ui().openChat('c-1'));
        await draw(() => ui().show(view));
        await settle();

        expect(modeChip()?.textContent).toBe('New worktree');
        expect(baseChip()?.textContent).toBe('Branch from: dev');
    });
});

describe('the place of the page', () => {
    const pickWorktree = async () => {
        await press(modeChip()!);
        await press(menuItem('Existing worktree'));
        await settle();
        await press(option('clowdy/ab12cd34'));
        await settle();
    };
    const placeOfPage = () => currentPlace(store.selectedProject!, ui());

    it('is the folder\'s own checkout in Project checkout and for a new worktree, which the first message makes', async () => {
        expect(placeOfPage().workspace).toBeUndefined();

        await chooseMode('New worktree');

        expect(placeOfPage().workspace).toBeUndefined();
        expect(ui().draftWorkspaceRow).toBeNull();
    });

    it('is the worktree that is picked once the daemon has answered for it, and the folder\'s own checkout again when it is left', async () => {
        await pickWorktree();

        expect(ui().draftWorkspaceRow).toMatchObject({ path: WORKTREE, managed: true, ready: true });
        expect(placeOfPage()).toMatchObject({ folder: { id: 'fld_car_rental' }, workspace: { path: WORKTREE, ready: true } });

        await chooseMode('Project checkout');

        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });

    it('makes the chat of the first message work in that same row, so the place does not change when it starts', async () => {
        await pickWorktree();

        const before = placeOfPage();
        const known = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        const [chat] = made(known);

        expect(chat?.workspace?.id).toBe(before.workspace?.id);
        expect(chat?.workspace?.path).toBe(WORKTREE);
    });

    it('asks once for a worktree, and again for another', async () => {
        const transport = new FixtureTransport();
        const asked = vi.spyOn(transport, 'command');

        await start({ transport });
        await pickWorktree();
        await draw(() => ui().setDraftWorkspace({ mode: 'existing', path: WORKTREE }));
        await settle();

        expect(asked.mock.calls.filter(([command]) => command.type === 'workspace.open')).toEqual([[{ type: 'workspace.open', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path: WORKTREE }]]);
    });

    it('asks again for a worktree whose row went with the last chat that worked in it, so the page and the chat of its first message share the row that is made', async () => {
        const data = withFixtureWorkspace(createFixtureData());
        const transport = new FixtureTransport({ data });
        const asked = vi.spyOn(transport, 'command');

        await start({ data, transport });
        await pickWorktree();

        const sharing = [...store.selectedProject!.chats.values()].find(chat => chat.workspace?.path === WORKTREE)!;
        const opened = () => asked.mock.calls.filter(([command]) => command.type === 'workspace.open').length;

        expect(ui().draftWorkspaceRow?.id).toBe(sharing.workspace!.id);
        expect(opened()).toBe(1);

        // The only chat that worked in the worktree is deleted while the page is open: its row goes with it, so the page asks for the worktree again.
        await act(async () => {
            await store.command({ type: 'chat.delete', chatId: sharing.id });
        });
        await settle();
        await settle();
        await settle();

        expect(store.selectedProject!.chats.has(sharing.id)).toBe(false);
        expect(opened()).toBe(2);
        expect(ui().draftWorkspaceRow).toMatchObject({ path: WORKTREE });
        expect(placeOfPage().workspace?.path).toBe(WORKTREE);

        const row = ui().draftWorkspaceRow!;
        const known = new Set(store.selectedProject!.chats.keys());

        await send('Fix the price');

        expect(made(known)[0]?.workspace?.id).toBe(row.id);
    });

    it('does not ask again for a row nobody has worked in when the chats change', async () => {
        const transport = new FixtureTransport();
        const asked = vi.spyOn(transport, 'command');

        await start({ transport });
        await pickWorktree();
        await settle();
        await settle();

        expect(asked.mock.calls.filter(([command]) => command.type === 'workspace.open')).toHaveLength(1);
    });

    it('drops an answer for a choice that changed while it was on its way', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);
        let answer: () => void = () => undefined;

        vi.spyOn(transport, 'command').mockImplementation(async (command) => {
            if (command.type !== 'workspace.open') return original(command);

            await new Promise<void>((resolve) => {
                answer = resolve;
            });

            return original(command);
        });
        await start({ transport });
        await pickWorktree();

        expect(ui().draftWorkspaceRow).toBeNull();

        await chooseMode('Project checkout');
        await act(async () => answer());
        await settle();

        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });

    it('stays in the folder\'s own checkout, without a word, when the daemon refuses or cannot be reached', async () => {
        const transport = new FixtureTransport();
        const original = transport.command.bind(transport);

        vi.spyOn(transport, 'command').mockImplementation(async command => (command.type === 'workspace.open' ? refused : original(command)));
        await start({ transport });
        await pickWorktree();

        expect(ui().draftWorkspace).toEqual({ mode: 'existing', path: WORKTREE });
        expect(ui().draftWorkspaceRow).toBeNull();
        expect(placeOfPage().workspace).toBeUndefined();
    });
});
