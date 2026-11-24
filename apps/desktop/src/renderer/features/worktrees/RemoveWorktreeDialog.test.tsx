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
const FOUND_WORKTREE = '/Users/dev/orca/car-rental/search-filters';
const MISSING_WORKTREE = '/Users/dev/car-rental-old';
const DETACHED_MERGED = '/Users/dev/orca/car-rental-api/readme';
const CLEAN_MERGED = '/Users/dev/orca/car-rental/done';
const CLEAN_UNMERGED = '/Users/dev/orca/car-rental/wip';
const ONE_CHANGE = '/Users/dev/orca/car-rental/one';
const SUBMODULES_ONLY = '/Users/dev/orca/car-rental/vendor';
const STRANDED = '/Users/dev/orca/car-rental/scratch';

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
const checkbox = () => confirmation().querySelector<HTMLInputElement>('input[type="checkbox"]');
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
    describe('a clean worktree', () => {
        it('asks plainly, with the branch ticked when its work is in the base, and removes the worktree and the branch', async () => {
            await open();
            await askToRemove(CLEAN_MERGED);

            const window = confirmation();

            expect(window.textContent).toContain('Remove the worktree?');
            expect(window.textContent).toContain('feature/done');
            expect(window.textContent).toContain('orca/car-rental/done');
            expect(checkbox()!.checked).toBe(true);
            expect(window.textContent).toContain('Delete branch feature/done');
            expect(window.textContent).not.toContain('Not merged');
            // Plain, not the red button of a changed tree.
            expect(textButton(window, 'Remove')!.dataset.color).not.toBe('danger');
            // Nothing is sent until the person presses it.
            expect(removals()).toEqual([]);

            await confirm('Remove');

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

        it('keeps the branch when its box is ticked off, and sends no word of it', async () => {
            await open();
            await askToRemove(CLEAN_MERGED);
            await act(async () => checkbox()!.click());

            expect(checkbox()!.checked).toBe(false);

            await confirm('Remove');

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
            await confirm('Remove');

            expect(getProjectWorktrees).toHaveBeenCalledTimes(2);
            expect(isConfirming()).toBe(false);
            expect(Modal.opened).toHaveLength(1);
            expect(row(CLEAN_MERGED)).toBeNull();
            // The rest of the list is still there.
            expect(row(FOUND_WORKTREE)).not.toBeNull();
        });
    });

    describe('while the command runs', () => {
        it('sends it once for two presses, and keeps Cancel off until it answers', async () => {
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

            const button = textButton(confirmation(), 'Remove')!;

            await click(button);
            await click(button);

            expect(slow).toHaveBeenCalledTimes(1);
            expect(textButton(confirmation(), 'Cancel')!.disabled).toBe(true);
            expect(isConfirming()).toBe(true);

            await act(async () => answer());
            await settle();

            expect(isConfirming()).toBe(false);
        });
    });

    describe('a branch that is not merged', () => {
        it('has its box off, says `Not merged` and what is lost with the branch, and removes the worktree alone by default', async () => {
            await open();
            await askToRemove(CLEAN_UNMERGED);

            const window = confirmation();

            expect(window.textContent).toContain('Delete branch wip/pricing');
            expect(window.textContent).toContain('Not merged');
            expect(window.textContent).toContain('Its unmerged commits are lost with the branch');
            expect(checkbox()!.checked).toBe(false);
            // The warning is the box's description, so a screen reader hears it with the box.
            expect(
                window.querySelector(`#${CSS.escape(checkbox()!.getAttribute('aria-describedby')!)}`)?.textContent
            ).toBe('Its unmerged commits are lost with the branch');

            await confirm('Remove');

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
            await confirm('Remove');

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

        it('leaves the box off for the base branch itself, whose work is "in the base" by being it, and says so', async () => {
            const data = dataWithKinds();

            // The fixture's base is `origin/main`: a worktree on the local `main` is merged into it, and deleting `main` keeps nothing of it anywhere else.
            data.worktrees![CAR_RENTAL]!.push({
                path: '/Users/dev/orca/car-rental/trunk',
                branch: 'main',
                head: 'fff7777',
            });
            await open({ data });
            await askToRemove('/Users/dev/orca/car-rental/trunk');

            expect(confirmation().textContent).toContain('Delete branch main');
            expect(confirmation().textContent).toContain('It is the base branch itself');
            expect(confirmation().textContent).not.toContain('Not merged');
            expect(checkbox()!.checked).toBe(false);

            await confirm('Remove');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: '/Users/dev/orca/car-rental/trunk',
                },
            ]);
        });

        it('offers the branch whatever it is called, one the person made as well as the one Clowdy named', async () => {
            const data = dataWithKinds();

            data.worktrees![CAR_RENTAL]!.push({
                path: '/Users/dev/orca/car-rental/release',
                branch: 'release/1.0',
                head: 'fff6666',
            });
            await open({ data });
            await askToRemove('/Users/dev/orca/car-rental/release');

            expect(confirmation().textContent).toContain('Delete branch release/1.0');
            expect(checkbox()!.checked).toBe(true);
        });
    });

    describe('a worktree with changes', () => {
        it('asks in red, says how many changes go, and is not sent until the red button is pressed', async () => {
            await open();
            await askToRemove(FOUND_WORKTREE);

            const window = confirmation();
            const red = textButton(window, 'Discard 2 changes and remove')!;

            expect(red.dataset.color).toBe('danger');
            expect(window.textContent).toContain('Discard changes and remove?');
            expect(window.textContent).toContain('2 uncommitted changes will be deleted for good');
            // An initialised submodule is said as well.
            expect(window.textContent).toContain('Its checked-out submodules are removed with it');
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

            expect(textButton(confirmation(), 'Discard 1 change and remove')).not.toBeUndefined();
            expect(confirmation().textContent).toContain('1 uncommitted change will be deleted for good');
            expect(confirmation().textContent).not.toContain('files');

            await confirm('Discard 1 change and remove');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: ONE_CHANGE,
                    discard: true,
                    deleteBranch: true,
                },
            ]);
        });

        it('asks in red for a clean worktree with an initialised submodule, with no number of changes in it', async () => {
            await open();
            await askToRemove(SUBMODULES_ONLY);

            const red = textButton(confirmation(), 'Remove with submodules')!;

            expect(red.dataset.color).toBe('danger');
            expect(confirmation().textContent).not.toContain('Discard 0');

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
            expect(confirmation().textContent).not.toContain('Delete branch');

            await confirm('Remove');

            expect(removals()).toEqual([
                { type: 'workspace.remove', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_api', path: DETACHED_MERGED },
            ]);
        });

        it('warns that its commits are not in the base and may be in no branch, with no branch box either', async () => {
            await open();
            await askToRemove(STRANDED);

            expect(checkbox()).toBeNull();
            expect(confirmation().textContent).toContain('Not merged');
            expect(confirmation().textContent).toContain(
                'Its commits may be in no branch, so they can be lost with the worktree'
            );

            await confirm('Remove');

            expect(removals()).toEqual([
                { type: 'workspace.remove', projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', path: STRANDED },
            ]);
        });
    });

    describe('a worktree whose folder is gone', () => {
        it('removes its record, in the same command with no discard, and offers its branch as the others', async () => {
            await open();
            await askToRemove(MISSING_WORKTREE);

            const window = confirmation();

            expect(window.textContent).toContain('Remove the record?');
            expect(window.textContent).toContain('Git still lists it, but its folder is gone from the disk');
            expect(window.textContent).toContain('Delete branch old-pricing');
            expect(textButton(window, 'Remove record')).not.toBeUndefined();

            await confirm('Remove record');

            expect(removals()).toEqual([
                {
                    type: 'workspace.remove',
                    projectId: FIXTURE_PROJECT_ID,
                    folderId: 'fld_car_rental',
                    path: MISSING_WORKTREE,
                    deleteBranch: true,
                },
            ]);
            expect(row(MISSING_WORKTREE)).toBeNull();
        });
    });

    describe('a worktree that cannot be removed', () => {
        it('has no Remove to choose while a chat works in it and counts archived chats in the row', async () => {
            await open();

            const remove = await removeItem(CLOWDY_WORKTREE);

            expect(remove.getAttribute('aria-disabled')).toBe('true');
            expect(remove.textContent).toContain('A chat works in it');
            expect(row(CLOWDY_WORKTREE)!.textContent).toContain('2 chats');

            await click(remove);
            await settle();

            expect(isConfirming()).toBe(false);
            expect(removals()).toEqual([]);
        });
    });

    describe('cancelling', () => {
        it('sends nothing, reads nothing and leaves the list as it was, for each kind of confirmation', async () => {
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
                await click(textButton(confirmation(), 'Cancel')!);
                await settle();

                expect(isConfirming(), path).toBe(false);
                expect(row(path), path).not.toBeNull();
            }

            expect(removals()).toEqual([]);
            expect(getProjectWorktrees).toHaveBeenCalledTimes(1);
        });
    });

    describe('a refusal', () => {
        it("toasts the daemon's own reason, reads the list again since the row may have changed, and closes the confirmation", async () => {
            const error = vi.spyOn(toast, 'error').mockReturnValue('' as never);
            const refuse = vi.fn(
                async (): Promise<CommandResult> => ({
                    ok: false,
                    requestId: 'r',
                    error: { code: 'conflict', message: 'The chat "Fix the login" works in this worktree' },
                })
            );

            await open({ overrides: { command: refuse } });
            await askToRemove(CLEAN_MERGED);
            await confirm('Remove');

            expect(refuse).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith({
                title: "Couldn't remove the worktree",
                message: 'The chat "Fix the login" works in this worktree',
            });
            expect(isConfirming()).toBe(false);
            expect(Modal.opened).toHaveLength(1);
            expect(getProjectWorktrees).toHaveBeenCalledTimes(2);
            expect(row(CLEAN_MERGED)).not.toBeNull();
        });

        it('toasts what the daemon says of a folder that changed since the list was read, and the next Remove asks the red question about the row as it is now', async () => {
            const error = vi.spyOn(toast, 'error').mockReturnValue('' as never);
            const data = dataWithKinds();

            await open({ data });
            // The tree got a change after the list was read: the plain confirmation is refused, as the daemon does.
            data.worktrees![CAR_RENTAL]!.find(worktree => worktree.path === CLEAN_MERGED)!.changes = 2;
            await askToRemove(CLEAN_MERGED);
            await confirm('Remove');

            expect(error).toHaveBeenCalledWith({
                title: "Couldn't remove the worktree",
                message: 'The worktree has changes that are not committed',
            });
            expect(isConfirming()).toBe(false);
            expect(row(CLEAN_MERGED)!.textContent).toContain('2 changes');

            await askToRemove(CLEAN_MERGED);

            expect(textButton(confirmation(), 'Discard 2 changes and remove')).not.toBeUndefined();
            expect(removals()).toHaveLength(1);
        });
    });

    describe('a list that cannot be read after the removal', () => {
        it('says so beside a Try again, so the removed row does not stay on screen unmarked', async () => {
            const data = dataWithKinds();
            const base = new FixtureTransport({ data });
            const read = vi.fn(async (projectId: string) => {
                if (read.mock.calls.length === 2) throw new Error('git did not answer');

                return base.getProjectWorktrees(projectId);
            });

            await open({
                data,
                overrides: { getProjectWorktrees: read, command: (input: CommandInput) => base.command(input) },
            });
            await askToRemove(CLEAN_MERGED);
            await confirm('Remove');

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
