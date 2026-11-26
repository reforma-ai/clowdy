// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { toast } from '@clowdy/components/Toast';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    type FixtureData,
    withFixtureWorktrees,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { RootStore } from '../../stores';
import { openManageWorktrees } from './ManageWorktrees';

import type { CommandResult } from '@clowdy/protocol';
import type { CommandInput, Transport } from '../../daemon/transport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CAR_RENTAL = '/Users/dev/car-rental';
const CLOWDY_WORKTREE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental';
const FOUND_WORKTREE = '/Users/dev/worktrees/car-rental/search-filters';
const MISSING_WORKTREE = '/Users/dev/car-rental-old';
const DETACHED_MERGED = '/Users/dev/worktrees/car-rental-api/readme';
const CLEAN_MERGED = '/Users/dev/worktrees/car-rental/done';
const CLEAN_UNMERGED = '/Users/dev/worktrees/car-rental/wip';
const ONE_CHANGE = '/Users/dev/worktrees/car-rental/one';
const SUBMODULES_ONLY = '/Users/dev/worktrees/car-rental/vendor';
const STRANDED = '/Users/dev/worktrees/car-rental/scratch';

let store: RootStore;
let command: ReturnType<typeof vi.fn<(input: CommandInput) => Promise<CommandResult>>>;
let getProjectWorktrees: ReturnType<typeof vi.fn<(projectId: string) => ReturnType<Transport['getProjectWorktrees']>>>;

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return {
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => void (data[key] = value),
    };
};

/** The windows draw on the next animation frame and their content mounts a little later. */
async function settle() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
    });
}

/** The fixture's worktrees, and the kinds the Manage dialog's removal has a different confirmation for. */
function dataWithKinds(): FixtureData {
    const data = withFixtureWorktrees(createFixtureData());

    data.worktrees![CAR_RENTAL]!.push(
        { path: CLEAN_MERGED, branch: 'feature/done', head: 'aaa1111' },
        { path: CLEAN_UNMERGED, branch: 'wip/pricing', head: 'bbb2222', merged: false },
        { path: ONE_CHANGE, branch: 'one-change', head: 'ccc3333', changes: 1 },
        { path: SUBMODULES_ONLY, branch: 'vendor', head: 'ddd4444', submodules: true },
        { path: STRANDED, head: 'eee5555', merged: false }
    );

    return data;
}

interface OpenOptions {
    data?: FixtureData;
    overrides?: Partial<Transport>;
    folderId?: string;
}

async function open({ data = dataWithKinds(), overrides = {}, folderId }: OpenOptions = {}) {
    const base = new FixtureTransport({ data });

    command = vi.fn((input: CommandInput) => base.command(input));
    getProjectWorktrees = vi.fn((projectId: string) => base.getProjectWorktrees(projectId));
    store = new RootStore(overrideTransport(base, { command, getProjectWorktrees, ...overrides }), {
        storage: memoryStorage(),
    });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    act(() => openManageWorktrees({ root: store, projectId: FIXTURE_PROJECT_ID, folderId }));
    await settle();
}

const row = (path: string) => document.body.querySelector<HTMLElement>(`li[data-worktree-path="${path}"]`);
const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** The confirmation is the window on top of the Manage dialog. */
const confirmation = () => [...document.body.querySelectorAll<HTMLElement>('[data-modal-window]')].at(-1)!;
const isConfirming = () => Modal.opened.length === 2;
const textButton = (parent: HTMLElement, text: string) =>
    [...parent.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text);
const checkbox = () => confirmation().querySelector<HTMLInputElement>('input[aria-label^="Delete the branch"]');
const deleteChats = () => confirmation().querySelector<HTMLInputElement>('input[role="switch"]');
const click = (element: HTMLElement) => act(async () => element.click());
const removals = () => command.mock.calls.map(([input]) => input).filter(input => input.type === 'workspace.remove');

/** Opens the More menu of a row, and gives its Remove item. */
async function removeItem(path: string) {
    await click(row(path)!.querySelector<HTMLElement>('button[aria-label^="More for"]')!);
    await settle();

    return menuItems().find(candidate => candidate.textContent?.startsWith('Remove'))!;
}

/** Presses Remove on a row, and waits for the confirmation it opens. */
async function askToRemove(path: string) {
    await click(await removeItem(path));
    await settle();
    expect(isConfirming()).toBe(true);
}

/** Presses the confirmation's button, which removes, and waits for it to close. */
async function confirm(label: string) {
    await click(textButton(confirmation(), label)!);
    await settle();
}

beforeEach(() => {
    // The windows animate by themselves, whatever the motion setting; a test that ends while one moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
    // The confirmation opens over the Manage dialog, as its child, and closes when the window it came from is not visible: happy-dom has no layout, so every element has no size.
    vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 480,
        width: 640,
        height: 480,
        toJSON: () => ({}),
    });
});

afterEach(async () => {
    for (const modal of [...Modal.opened].reverse()) await modal.close(false);

    vi.restoreAllMocks();
    store.dispose();
    document.body.innerHTML = '';
});

describe('Remove in Manage worktrees', () => {
    it('opens a safe loading dialog while the worktree read is delayed', async () => {
        await open();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        getProjectWorktrees.mockImplementationOnce(async projectId => {
            await gate;
            return new FixtureTransport({ data: dataWithKinds() }).getProjectWorktrees(projectId);
        });
        const item = await removeItem(CLEAN_MERGED);
        await click(item);
        await settle();
        expect(isConfirming()).toBe(true);
        expect(confirmation().querySelector('[role=status]')).not.toBeNull();
        expect(textButton(confirmation(), 'Remove worktree')).toBeUndefined();
        expect(removals()).toEqual([]);
        release();
        await settle();
    });

    it('does not offer removal when the read fails', async () => {
        await open();
        getProjectWorktrees.mockRejectedValueOnce(new Error('Read failed'));
        await click(await removeItem(CLEAN_MERGED));
        await settle();
        expect(confirmation().querySelector('[role=alert]')?.textContent).toContain('Read failed');
        expect(textButton(confirmation(), 'Remove worktree')).toBeUndefined();
        expect(removals()).toEqual([]);
    });

    it('stays closed when a delayed read completes after cancellation', async () => {
        await open();
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        getProjectWorktrees.mockImplementationOnce(async projectId => {
            await gate;
            return new FixtureTransport({ data: dataWithKinds() }).getProjectWorktrees(projectId);
        });
        await click(await removeItem(CLEAN_MERGED));
        await settle();
        await click(confirmation().querySelector<HTMLElement>('button[aria-label="Close"]')!);
        await settle();
        await act(async () => {
            release();
        });
        await settle();
        expect(isConfirming()).toBe(false);
        expect(removals()).toEqual([]);
    });

    describe('a clean worktree', () => {
        it('shows the worktree and selects its merged branch by default', async () => {
            await open();
            await askToRemove(CLEAN_MERGED);

            const window = confirmation();
            const dialog = window.querySelector<HTMLElement>('[role="dialog"]')!;
            const heading = window.querySelector<HTMLElement>(
                `#${CSS.escape(dialog.getAttribute('aria-labelledby')!)}`
            );

            expect(window.textContent).toContain('Remove worktree feature/done');
            expect([dialog.getAttribute('aria-modal'), heading?.textContent]).toEqual([
                'true',
                'Remove worktree feature/done',
            ]);
            expect(window.textContent).toContain('Delete the branch');
            expect(window.textContent).toContain('worktrees/car-rental/done');
            expect(window.textContent).not.toContain('The worktree folder will be deleted');
            expect(checkbox()!.checked).toBe(true);
            expect(checkbox()!.getAttribute('aria-label')).toBe('Delete the branch feature/done');
            expect(textButton(window, 'Cancel')).toBeUndefined();
            expect(window.querySelector('button[aria-label="Close"]')).not.toBeNull();
            expect(window.textContent).not.toContain('Not merged');
            expect(textButton(window, 'Remove worktree')!.dataset.color).toBe('danger');
            // Nothing is sent until the person presses it.
            expect(removals()).toEqual([]);

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_MERGED,
                    deleteBranch: true,
                },
            ]);
            expect(removals()[0]).not.toHaveProperty('discard');
        });

        it('keeps the branch when its switch is disabled', async () => {
            await open();
            await askToRemove(CLEAN_MERGED);
            await act(async () => checkbox()!.click());

            expect(checkbox()!.checked).toBe(false);

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_MERGED,
                },
            ]);
        });

        it('reads the list again after the removal, closes the confirmation, and the row is gone', async () => {
            await open();

            expect(getProjectWorktrees).toHaveBeenCalledTimes(1);

            await askToRemove(CLEAN_MERGED);
            await confirm('Remove worktree');

            expect(getProjectWorktrees).toHaveBeenCalledTimes(4);
            expect(isConfirming()).toBe(false);
            expect(Modal.opened).toHaveLength(1);
            expect(row(CLEAN_MERGED)).toBeNull();
            // The rest of the list is still there.
            expect(row(FOUND_WORKTREE)).not.toBeNull();
        });
    });

    describe('while the command runs', () => {
        it('sends it once for two presses, and keeps the close control off until it answers', async () => {
            let answer!: () => void;
            const slow = vi.fn(
                (input: CommandInput) =>
                    new Promise<CommandResult>(resolve => {
                        answer = () =>
                            void resolve({
                                ok: true,
                                requestId: 'r',
                                data: {
                                    path: input.type === 'workspace.remove' ? input.path : '',
                                    branchDeleted: false,
                                },
                            });
                    })
            );

            await open({ overrides: { command: slow } });
            await askToRemove(CLEAN_MERGED);

            const button = textButton(confirmation(), 'Remove worktree')!;

            await click(button);
            await click(button);

            expect(slow).toHaveBeenCalledTimes(1);
            expect(confirmation().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.disabled).toBe(true);
            expect(isConfirming()).toBe(true);

            await act(async () => answer());
            await settle();

            expect(isConfirming()).toBe(false);
        });
    });

    describe('a branch that is not merged', () => {
        it('keeps an unmerged branch by default and warns when deletion is enabled', async () => {
            await open();
            await askToRemove(CLEAN_UNMERGED);

            const window = confirmation();

            expect(checkbox()!.getAttribute('aria-label')).toBe('Delete the branch wip/pricing');
            expect(window.textContent).not.toContain('Not merged');
            expect(window.textContent).not.toContain('Unmerged commits may be lost if you delete this branch');
            expect(checkbox()!.checked).toBe(false);
            await click(checkbox()!);
            expect(window.textContent).toContain('Unmerged commits may be lost if you delete this branch');
            // The warning is the box's description, so a screen reader hears it with the box.
            expect(
                window.querySelector(`#${CSS.escape(checkbox()!.getAttribute('aria-describedby')!)}`)?.textContent
            ).toBe('Unmerged commits may be lost if you delete this branch');

            await click(checkbox()!);

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_UNMERGED,
                },
            ]);
        });

        it('deletes the branch too once the person ticks it', async () => {
            await open();
            await askToRemove(CLEAN_UNMERGED);
            await act(async () => checkbox()!.click());
            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_UNMERGED,
                    deleteBranch: true,
                },
            ]);
        });

        it('keeps branch deletion off when merge status is unknown', async () => {
            await open();
            const read = getProjectWorktrees.getMockImplementation()!;
            getProjectWorktrees.mockImplementationOnce(async projectId => {
                const groups = await read(projectId);
                const worktree = groups.flatMap(group => group.worktrees).find(row => row.path === CLEAN_MERGED)!;
                worktree.merged = undefined;
                return groups;
            });
            await askToRemove(CLEAN_MERGED);
            expect(checkbox()!.checked).toBe(false);
        });

        it('leaves the box off for the base branch itself, whose work is "in the base" by being it, and says so', async () => {
            const data = dataWithKinds();

            // The fixture's base is `origin/main`: a worktree on the local `main` is merged into it, and deleting `main` keeps nothing of it anywhere else.
            data.worktrees![CAR_RENTAL]!.push({
                path: '/Users/dev/worktrees/car-rental/trunk',
                branch: 'main',
                head: 'fff7777',
            });
            await open({ data });
            await askToRemove('/Users/dev/worktrees/car-rental/trunk');

            expect(checkbox()!.getAttribute('aria-label')).toBe('Delete the branch main');
            expect(confirmation().textContent).not.toContain('Not merged');
            expect(checkbox()!.checked).toBe(false);
            await click(checkbox()!);
            expect(confirmation().textContent).toContain('This is the base branch');
            await click(checkbox()!);

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: '/Users/dev/worktrees/car-rental/trunk',
                },
            ]);
        });

        it('offers the branch whatever it is called, one the person made as well as the one Clowdy named', async () => {
            const data = dataWithKinds();

            data.worktrees![CAR_RENTAL]!.push({
                path: '/Users/dev/worktrees/car-rental/release',
                branch: 'release/1.0',
                head: 'fff6666',
            });
            await open({ data });
            await askToRemove('/Users/dev/worktrees/car-rental/release');

            expect(checkbox()!.getAttribute('aria-label')).toBe('Delete the branch release/1.0');
            expect(checkbox()!.checked).toBe(true);
        });
    });

    describe('a worktree with changes', () => {
        it('asks in red, says how many changes go, and is not sent until the red button is pressed', async () => {
            await open();
            await askToRemove(FOUND_WORKTREE);

            const window = confirmation();
            const red = textButton(window, 'Remove worktree')!;

            expect(red.dataset.color).toBe('danger');
            expect(checkbox()!.checked).toBe(false);
            expect(window.textContent).toContain('Remove worktree');
            expect(window.textContent).toContain('2 uncommitted changes will be lost');
            // An initialised submodule is said as well.
            expect(window.textContent).toContain(
                'Checked-out submodules and any uncommitted changes in them will be removed'
            );
            expect(removals()).toEqual([]);

            await click(red);
            await settle();

            // The branch of the worktree is not merged, so it stays unless it is ticked.
            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: FOUND_WORKTREE,
                    discard: true,
                },
            ]);
            expect(row(FOUND_WORKTREE)).toBeNull();
        });

        it('counts one change in the singular, since an untracked folder is one entry and not a number of files', async () => {
            await open();
            await askToRemove(ONE_CHANGE);
            expect(checkbox()!.checked).toBe(false);

            expect(textButton(confirmation(), 'Remove worktree')).not.toBeUndefined();
            expect(confirmation().textContent).toContain('1 uncommitted change will be lost');
            expect(confirmation().textContent).not.toContain('files');

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: ONE_CHANGE,
                    discard: true,
                },
            ]);
        });

        it('asks in red for a clean worktree with an initialised submodule, with no number of changes in it', async () => {
            await open();
            await askToRemove(SUBMODULES_ONLY);

            const red = textButton(confirmation(), 'Remove worktree')!;

            expect(red.dataset.color).toBe('danger');
            expect(checkbox()!.checked).toBe(false);
            expect(confirmation().textContent).toContain(
                'Checked-out submodules and any uncommitted changes in them will be removed'
            );
            expect(confirmation().textContent).not.toContain('0 uncommitted');

            await click(red);
            await settle();

            expect(removals()[0]).toMatchObject({ path: SUBMODULES_ONLY, discard: true });
        });
    });

    describe('a detached HEAD', () => {
        it('offers no branch to delete, and says nothing is lost when its commits are in the base', async () => {
            await open({ folderId: 'fld_api' });
            await askToRemove(DETACHED_MERGED);

            expect(checkbox()).toBeNull();
            expect(confirmation().textContent).not.toContain('Not merged');
            expect(confirmation().textContent).not.toContain('Delete the branch');

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                { type: 'workspace.remove', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_api', path: DETACHED_MERGED },
            ]);
        });

        it('warns that its commits are not in the base and may be in no branch, with no branch box either', async () => {
            await open();
            await askToRemove(STRANDED);

            expect(checkbox()).toBeNull();
            expect(confirmation().textContent).not.toContain('Not merged');
            expect(confirmation().textContent).toContain('Commits that aren’t on a branch may be lost');

            await confirm('Remove worktree');

            expect(removals()).toEqual([
                { type: 'workspace.remove', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path: STRANDED },
            ]);
        });

        it('shows both warnings for a detached worktree with local changes and keeps the confirmation label short', async () => {
            const data = dataWithKinds();

            data.worktrees![CAR_RENTAL]!.find(worktree => worktree.path === STRANDED)!.changes = 12;
            await open({ data });
            await askToRemove(STRANDED);

            const window = confirmation();

            expect(textButton(window, 'Remove worktree')!.dataset.color).toBe('danger');
            expect(window.textContent).toContain('12 uncommitted changes will be lost');
            expect(window.textContent).toContain('Commits that aren’t on a branch may be lost');
            expect(window.textContent).not.toContain('Not merged');
            expect(checkbox()).toBeNull();

            await confirm('Remove worktree');

            expect(removals()[0]).toMatchObject({ path: STRANDED, discard: true });
        });
    });

    describe('a worktree whose folder is gone', () => {
        it('removes its record, in the same command with no discard, and offers its branch as the others', async () => {
            await open();
            await askToRemove(MISSING_WORKTREE);

            const window = confirmation();

            expect(window.textContent).toContain('Remove worktree record old-pricing');
            expect(window.textContent).toContain('The worktree folder is missing. This removes its record from Git.');
            expect(checkbox()!.getAttribute('aria-label')).toBe('Delete the branch old-pricing');
            expect(checkbox()!.checked).toBe(false);
            expect(textButton(window, 'Remove record')).not.toBeUndefined();

            await confirm('Remove record');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: MISSING_WORKTREE,
                },
            ]);
            expect(row(MISSING_WORKTREE)).toBeNull();
        });
    });

    describe('a worktree that cannot be removed', () => {
        it('refuses a working chat and names its blocker', async () => {
            const data = dataWithKinds();
            data.runs.find(run => run.chatId === 'c-9')!.status = 'running';
            await open({ data });
            await click(await removeItem(CLOWDY_WORKTREE));
            await settle();
            expect(confirmation().querySelector('[role=alert]')?.textContent).toContain('still working');
            expect(removals()).toEqual([]);
        });

        it('explains that linked chats will be archived, and updates that consequence when deletion is chosen', async () => {
            await open();
            await askToRemove(CLOWDY_WORKTREE);

            expect(confirmation().textContent).toContain('2 linked chats will be archived');
            expect(deleteChats()!.checked).toBe(false);
            expect(deleteChats()!.getAttribute('role')).toBe('switch');
            await click(deleteChats()!);
            expect(confirmation().textContent).toContain('2 linked chats will be permanently deleted');
            expect(deleteChats()!.checked).toBe(true);
            await click(deleteChats()!);
            expect(confirmation().textContent).toContain('2 linked chats will be archived');
        });

        it.each(['archive', 'delete'] as const)(
            'removes linked chats with %s, including archived chats and an outside thread',
            async disposition => {
                const data = dataWithKinds();
                const child = {
                    ...data.chats.find(chat => chat.id === 'c-9')!,
                    id: 'c-outside',
                    parentChatId: 'c-9',
                    workspace: undefined,
                    orchestratorRunId: undefined,
                };
                data.chats.push(child);
                await open({ data });
                store.ui.forProject(FIXTURE_PROJECT_ID).openChat('c-9');
                await askToRemove(CLOWDY_WORKTREE);
                expect(confirmation().textContent).toContain('including 1 thread in other worktrees');
                if (disposition === 'delete') await click(deleteChats()!);
                await confirm('Remove worktree');
                const snapshot = await store.transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
                expect({
                    commands: removals().map(input => ({
                        ...input,
                        expectedChatIds: input.type === 'workspace.remove' ? input.expectedChatIds?.sort() : undefined,
                    })),
                    remaining: snapshot.chats
                        .filter(chat => ['c-9', 'c-10', 'c-outside'].includes(chat.id))
                        .map(chat => [chat.id, Boolean(chat.archivedAt)]),
                    selected: store.ui.forProject(FIXTURE_PROJECT_ID).chatId,
                }).toEqual({
                    commands: [
                        {
                            type: 'workspace.remove',
                            projectId: FIXTURE_PROJECT_ID,
                            folderId: 'fld_car_rental',
                            path: CLOWDY_WORKTREE,
                            chatDisposition: disposition,
                            expectedChatIds: ['c-10', 'c-9', 'c-outside'],
                            discard: true,
                        },
                    ],
                    remaining:
                        disposition === 'archive'
                            ? [
                                  ['c-9', true],
                                  ['c-10', true],
                                  ['c-outside', true],
                              ]
                            : [],
                    selected: null,
                });
            }
        );
    });

    describe('cancelling', () => {
        it('closes with the keyboard without removing anything', async () => {
            await open();
            await askToRemove(CLEAN_MERGED);

            const button = confirmation().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
            await act(async () => {
                button.focus();
                button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
            });
            await settle();

            expect(isConfirming()).toBe(false);
            expect(removals()).toEqual([]);
        });

        it('sends nothing and leaves the list as it was, for each kind of confirmation', async () => {
            await open();

            for (const path of [
                CLEAN_MERGED,
                CLEAN_UNMERGED,
                FOUND_WORKTREE,
                STRANDED,
                MISSING_WORKTREE,
                SUBMODULES_ONLY,
            ]) {
                await askToRemove(path);
                await click(confirmation().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
                await settle();

                expect(isConfirming(), path).toBe(false);
                expect(row(path), path).not.toBeNull();
            }

            expect(removals()).toEqual([]);
            expect(getProjectWorktrees).toHaveBeenCalledTimes(7);
        });
    });

    describe('a refusal', () => {
        it("shows the daemon's refusal and requires reopening", async () => {
            const refuse = vi.fn(
                async (): Promise<CommandResult> => ({
                    ok: false,
                    requestId: 'r',
                    error: { code: 'conflict', message: 'The chat "Fix the login" works in this worktree' },
                })
            );

            await open({ overrides: { command: refuse } });
            await askToRemove(CLEAN_MERGED);
            await confirm('Remove worktree');

            expect(refuse).toHaveBeenCalledTimes(1);
            expect(confirmation().querySelector('[role="alert"]')?.textContent).toContain(
                'The chat "Fix the login" works in this worktree'
            );
            expect(textButton(confirmation(), 'Remove worktree')!.disabled).toBe(true);
            expect(isConfirming()).toBe(true);
            expect(getProjectWorktrees).toHaveBeenCalledTimes(4);
            expect(row(CLEAN_MERGED)).not.toBeNull();
        });

        it('shows a refusal and reads changed state after reopening', async () => {
            const data = dataWithKinds();

            await open({ data });
            // The tree got a change after the list was read: the plain confirmation is refused, as the daemon does.
            await askToRemove(CLEAN_MERGED);
            data.worktrees![CAR_RENTAL]!.find(worktree => worktree.path === CLEAN_MERGED)!.changes = 2;
            await confirm('Remove worktree');

            expect(confirmation().querySelector('[role="alert"]')?.textContent).toContain(
                'The worktree has changes that are not committed'
            );
            expect(textButton(confirmation(), 'Remove worktree')!.disabled).toBe(true);
            await click(confirmation().querySelector<HTMLElement>('button[aria-label="Close"]')!);
            await settle();
            expect(isConfirming()).toBe(false);
            expect(row(CLEAN_MERGED)!.textContent).toContain('2 changes');

            await askToRemove(CLEAN_MERGED);

            expect(textButton(confirmation(), 'Remove worktree')!.dataset.color).toBe('danger');
            expect(confirmation().textContent).toContain('2 uncommitted changes will be lost');
            expect(removals()).toHaveLength(1);
        });
    });

    it('refuses a new descendant added after the chat disposition was confirmed', async () => {
        const data = dataWithKinds();
        await open({ data });
        await askToRemove(CLOWDY_WORKTREE);
        data.chats.push({
            ...data.chats.find(chat => chat.id === 'c-9')!,
            id: 'late-thread',
            parentChatId: 'c-9',
            workspace: undefined,
            orchestratorRunId: undefined,
        });
        await confirm('Remove worktree');
        const snapshot = await store.transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        expect({
            present: !!row(CLOWDY_WORKTREE),
            archived: snapshot.chats.find(chat => chat.id === 'c-9')?.archivedAt,
            expected: removals()[0]?.type === 'workspace.remove' && removals()[0].expectedChatIds,
        }).toEqual({ present: true, archived: undefined, expected: ['c-9', 'c-10'] });
    });

    it('does not reset a different chat selected during removal', async () => {
        await open();
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat('c-9');
        await askToRemove(CLOWDY_WORKTREE);
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat('c-4');
        await confirm('Remove worktree');
        expect(store.ui.forProject(FIXTURE_PROJECT_ID).chatId).toBe('c-4');
    });

    it('does not remove a previously unused worktree if an archived chat was attached after preview', async () => {
        const data = dataWithKinds();
        await open({ data });
        await askToRemove(CLEAN_MERGED);
        data.chats.push({
            ...data.chats.find(chat => chat.id === 'c-10')!,
            id: 'late-archive',
            workspace: {
                id: 'late-workspace',
                folderId: 'fld_car_rental',
                path: CLEAN_MERGED,
                ready: true,
                managed: false,
            },
            orchestratorRunId: undefined,
        });
        await confirm('Remove worktree');
        expect({ commands: removals(), present: Boolean(row(CLEAN_MERGED)) }).toEqual({ commands: [], present: true });
    });

    it('never deletes a different branch that was checked out after the deletion checkbox was shown', async () => {
        const data = dataWithKinds();
        await open({ data });
        await askToRemove(CLEAN_MERGED);
        expect(checkbox()?.checked).toBe(true);
        data.worktrees![CAR_RENTAL]!.find(worktree => worktree.path === CLEAN_MERGED)!.branch = 'another-branch';
        await confirm('Remove worktree');
        expect({ commands: removals(), present: Boolean(row(CLEAN_MERGED)) }).toEqual({ commands: [], present: true });
    });

    it('does not discard a newly added change without another preview', async () => {
        const data = dataWithKinds();
        await open({ data });
        await askToRemove(ONE_CHANGE);
        data.worktrees![CAR_RENTAL]!.find(worktree => worktree.path === ONE_CHANGE)!.changes = 2;
        await confirm('Remove worktree');
        expect({ commands: removals(), present: Boolean(row(ONE_CHANGE)) }).toEqual({ commands: [], present: true });
    });

    it('tidies selected clean unused trees only, refusing one that acquired changes after preview', async () => {
        const data = dataWithKinds();
        const second = '/Users/dev/worktrees/car-rental/second';
        const kept = '/Users/dev/worktrees/car-rental/kept';
        data.worktrees![CAR_RENTAL]!.push(
            { path: second, branch: 'second', head: 'abcd123' },
            { path: kept, branch: 'kept', head: 'defg123' }
        );
        await open({ data });
        await click(textButton(confirmation(), 'Tidy up…')!);
        await settle();
        const list = confirmation().querySelector('ul[aria-label="Worktrees to remove"]')!;
        expect(
            [...list.querySelectorAll('li')].map(row => [
                row.textContent,
                row.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
            ])
        ).toEqual([
            ['feature/doneMerged', true],
            ['secondMerged', true],
            ['keptMerged', true],
        ]);
        expect(confirmation().querySelectorAll('input[type="checkbox"]')).toHaveLength(4);
        const choices = [...confirmation().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(choices.map(choice => choice.getAttribute('aria-label')).filter(Boolean)).toEqual([
            `Remove feature/done: ${CLEAN_MERGED}`,
            `Remove second: ${second}`,
            `Remove kept: ${kept}`,
        ]);
        await click(
            [...list.querySelectorAll('li')]
                .find(item => item.textContent?.startsWith('kept'))!
                .querySelector<HTMLElement>('[title]')!
        );
        data.worktrees![CAR_RENTAL]!.find(row => row.path === second)!.changes = 1;
        await confirm('Remove 2 workspaces');
        expect(confirmation().textContent).toContain(second);
        expect({
            commands: removals(),
            present: [CLEAN_MERGED, second, kept].map(path => Boolean(row(path))),
            readCount: getProjectWorktrees.mock.calls.length,
        }).toEqual({
            commands: [
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_MERGED,
                    tidy: true,
                    deleteBranch: true,
                },
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: second,
                    tidy: true,
                    deleteBranch: true,
                },
            ],
            present: [false, true, true],
            readCount: 3,
        });
    });

    it('disables removal when nothing is selected and closes without removing', async () => {
        await open({ data: dataWithKinds() });
        await click(textButton(confirmation(), 'Tidy up…')!);
        await settle();
        const choice = confirmation().querySelector<HTMLInputElement>(
            `input[aria-label="Remove feature/done: ${CLEAN_MERGED}"]`
        )!;
        await click(choice);
        expect(textButton(confirmation(), 'Remove 0 workspaces')?.disabled).toBe(true);
        await click(confirmation().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!);
        await settle();
        expect(removals()).toEqual([]);
        expect(row(CLEAN_MERGED)).not.toBeNull();
    });

    it('tidies an archived-only worktree without disposing of its history or an unarchived thread elsewhere', async () => {
        const data = dataWithKinds();
        const archived = data.chats.find(chat => chat.id === 'c-10')!;
        archived.workspace = {
            id: 'archived-only',
            path: CLEAN_MERGED,
            folderId: 'fld_car_rental',
            ready: true,
            managed: false,
        };
        const outside = {
            ...archived,
            id: 'outside-thread',
            parentChatId: archived.id,
            workspace: undefined,
            archivedAt: undefined,
            orchestratorRunId: undefined,
        };
        data.chats.push(outside);
        await open({ data });
        await click(textButton(confirmation(), 'Tidy up…')!);
        await settle();
        expect(
            confirmation().querySelector<HTMLInputElement>(`input[aria-label="Remove feature/done: ${CLEAN_MERGED}"]`)
                ?.checked
        ).toBe(true);
        await confirm('Remove 1 workspace');
        const snapshot = await store.transport.getProjectSnapshot(FIXTURE_PROJECT_ID);
        expect({
            commands: removals(),
            present: Boolean(row(CLEAN_MERGED)),
            archived: snapshot.chats.find(chat => chat.id === archived.id),
            outside: snapshot.chats.find(chat => chat.id === outside.id),
        }).toEqual({
            commands: [
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: CLEAN_MERGED,
                    tidy: true,
                    deleteBranch: true,
                },
            ],
            present: false,
            archived,
            outside,
        });
    });

    describe('a list that cannot be read after the removal', () => {
        it('says so beside a Try again, so the removed row does not stay on screen unmarked', async () => {
            const data = dataWithKinds();
            const base = new FixtureTransport({ data });
            const read = vi.fn(async (projectId: string) => {
                if (read.mock.calls.length === 4) throw new Error('git did not answer');

                return base.getProjectWorktrees(projectId);
            });

            await open({
                data,
                overrides: { getProjectWorktrees: read, command: (input: CommandInput) => base.command(input) },
            });
            await askToRemove(CLEAN_MERGED);
            await confirm('Remove worktree');

            const manage = document.body.querySelector<HTMLElement>('[data-modal-window]')!;

            expect(manage.textContent).toContain("Couldn't refresh the list");
            // The list on screen is the earlier one: the row it still shows is the one that was removed.
            expect(row(CLEAN_MERGED)).not.toBeNull();

            await click(textButton(manage, 'Try again')!);
            await settle();

            expect(manage.textContent).not.toContain("Couldn't refresh the list");
            expect(row(CLEAN_MERGED)).toBeNull();
        });
    });
});
