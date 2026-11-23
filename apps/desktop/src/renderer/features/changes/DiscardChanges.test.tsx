// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { commitScope } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_GIT_COMMITS,
    FIXTURE_PROJECT_ID,
    FIXTURE_WORKSPACE_CHAT_ID,
    FIXTURE_WORKSPACE_RUN_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FIXTURE_DISCARD_HOOK_LINE } from '../../daemon/fixtureGitWrites';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { type Transport, TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import ChangesTab from './ChangesTab';
import { gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { changesSidebarLayout } from './sidebarLayout';

import type { GitChanges, GitDiscardResult, GitScope } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLACE = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };

// happy-dom has no layout: the view builds its resizable group once its box has a width, which it is told.
vi.mock('./useBoxWidth', () => ({
    useBoxWidth: () => [() => undefined, 900],
    useBoxHeight: () => [() => undefined, 900],
}));
// The diff view has specs of its own (`packages/file-manager/specs`); here it only has to be given the right texts.
vi.mock('@clowdy/file-manager/react', () => ({
    DiffView: ({ path }: { path: string }) => <pre data-diff={path} />,
    selectionAction: () => [],
}));
// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the tab are, to follow the model they read.
vi.mock('./ChangesView', async importOriginal => ({
    ...(await importOriginal<typeof import('./ChangesView')>()),
    ChangesView: observer((await importOriginal<typeof import('./ChangesView')>()).ChangesView),
}));
vi.mock('./ChangesList', async importOriginal => ({
    ChangesList: observer((await importOriginal<typeof import('./ChangesList')>()).ChangesList),
}));
vi.mock('./ChangesToolbar', async importOriginal => ({
    ...(await importOriginal<typeof import('./ChangesToolbar')>()),
    ChangesToolbar: observer((await importOriginal<typeof import('./ChangesToolbar')>()).ChangesToolbar),
}));
vi.mock('./ChangesSidebar', async importOriginal => ({
    ...(await importOriginal<typeof import('./ChangesSidebar')>()),
    ChangesSidebar: observer((await importOriginal<typeof import('./ChangesSidebar')>()).ChangesSidebar),
}));
vi.mock('./CommitBox', async importOriginal => ({
    CommitBox: observer((await importOriginal<typeof import('./CommitBox')>()).CommitBox),
}));
vi.mock('./BranchCommits', async importOriginal => ({
    BranchCommits: observer((await importOriginal<typeof import('./BranchCommits')>()).BranchCommits),
}));
vi.mock('./DiffCard', async importOriginal => ({
    DiffCard: observer((await importOriginal<typeof import('./DiffCard')>()).DiffCard),
}));
vi.mock('./PullRequestChip', async importOriginal => ({
    PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip),
}));

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: Transport;

const Tab = observer(ChangesTab);

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
/** The dialog draws on the next animation frame, and the button that asks for the focus takes it after 50 ms. */
const settleDialog = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
    });
/** Waits until the dialog is gone: a dialog that closes plays its animation first. */
const untilClosed = async () => {
    for (let waited = 0; dialog() && waited < 2000; waited += 50) {
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 50));
        });
    }
};
const press = (target: Element) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        (target as HTMLElement).click();
    });

const cardPaths = () => [...container.querySelectorAll<HTMLElement>('[data-card]')].map(card => card.dataset.card);
const card = (path: string) => container.querySelector<HTMLElement>(`[data-card="${path}"]`)!;
const rowPaths = () =>
    [...container.querySelectorAll('[aria-label="Changed files"] [role="row"]')].map(
        row => row.querySelector('[class*="name"]')?.textContent
    );
/** The `Discard changes…` buttons of the sidebar's rows and of the cards, by the path of the file they name. */
const discardButtons = (inside: ParentNode = container) => [
    ...inside.querySelectorAll<HTMLButtonElement>('button[data-discard]'),
];
const discardPathsIn = (inside: ParentNode) => discardButtons(inside).map(item => item.dataset.discard);
const sidebar = () => container.querySelector('[aria-label="Changes sidebar"]')!;
const rowButton = (path: string) => sidebar().querySelector<HTMLButtonElement>(`button[data-discard="${path}"]`)!;
const cardButton = (path: string) => card(path).querySelector<HTMLButtonElement>('button[data-discard]')!;

/** The dialog the discard opens, and its parts. */
const dialog = () => document.querySelector<HTMLElement>('[data-modal-window]');
const dialogText = () => dialog()?.textContent ?? '';
const dialogButton = (label: string) =>
    [...(dialog()?.querySelectorAll('button') ?? [])].find(item => item.textContent?.trim() === label)!;
const dialogAlert = () => dialog()?.querySelector('[role="alert"]')?.textContent;

/** The model the tab shows, which the tests read and move (the scope). */
const model = () =>
    placeChangesOf(
        transport,
        gitFactsOf(transport).of({
            projectId: FIXTURE_PROJECT_ID,
            folderId: PLACE.folderId,
            workspaceId: PLACE.workspaceId,
        })
    );

/** Starts the store on the fixtures, with the chat in the worktree open on the Changes tab. */
async function start({
    tweak,
    wrap,
    gitWrites,
}: {
    tweak?: (data: FixtureData) => void;
    wrap?: (base: FixtureTransport) => Transport;
    gitWrites?: FixtureGitWritesOptions;
} = {}) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);

    const base = new FixtureTransport({ data, gitWrites });

    transport = wrap ? wrap(base) : base;
    store = new RootStore(transport);
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
    store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);

    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Tab />
            </RootStoreProvider>
        )
    );
    await settle();
    await settle();
}

const chooseScope = async (scope: GitScope) => {
    act(() => model().setScope(scope));
    await settle();
    await settle();
};

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            observe() {}
            disconnect() {}
            unobserve() {}
            takeRecords() {
                return [];
            }
        }
    );
    HTMLElement.prototype.scrollIntoView = () => undefined;

    if (!changesSidebarLayout.open) changesSidebarLayout.toggle();

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    // A dialog that a test left open is closed, so it does not stay over the next.
    await act(async () => {
        for (const item of document.querySelectorAll('button')) {
            if (item.textContent?.trim() === 'Cancel') item.click();
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    });
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.unstubAllGlobals();
    localStorage.clear();
    document.body.innerHTML = '';
});

describe('Discard changes… on the rows and the cards', () => {
    it('is on the rows and the cards of the uncommitted files in All changes, and not on the files that are only committed', async () => {
        await start();

        expect(cardPaths()).toEqual([
            'assets/logo.png',
            'notes.md',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ]);
        // The three the worktree has uncommitted; the others were committed with the branch.
        expect(discardPathsIn(sidebar())).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(discardPathsIn(container.querySelector('[data-card="notes.md"]')!)).toEqual(['notes.md']);
        expect(discardPathsIn(card('assets/logo.png'))).toEqual([]);
        expect(rowPaths()).toHaveLength(6);

        const button = rowButton('notes.md');

        expect(button.getAttribute('aria-label')).toBe('Discard changes to notes.md');
        // Reachable with Tab, shown by the CSS when the row has the focus.
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('tabindex')).not.toBe('-1');
    });

    it('is on the same files in Uncommitted, and on none in Branch or in a commit', async () => {
        await start();
        await chooseScope('uncommitted');

        expect(discardPathsIn(sidebar())).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(cardPaths()).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(discardButtons()).toHaveLength(6);

        await chooseScope('branch');

        expect(cardPaths()).toHaveLength(4);
        expect(discardButtons()).toHaveLength(0);

        await chooseScope(commitScope(FIXTURE_GIT_COMMITS[0]!.sha));

        expect(cardPaths()).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts']);
        expect(discardButtons()).toHaveLength(0);
    });

    it('is not on a file with merge conflicts or on a submodule, which the daemon refuses', async () => {
        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository || scope !== 'uncommitted') return answer;

                        return {
                            ...answer,
                            files: [
                                ...answer.files,
                                {
                                    path: 'src/both.ts',
                                    kind: 'conflicted',
                                    revision: `100644:${'5'.repeat(40)}:100644:${'6'.repeat(40)}`,
                                },
                                {
                                    path: 'vendor/sub',
                                    kind: 'modified',
                                    revision: `160000:${'7'.repeat(40)}:160000:${'8'.repeat(40)}`,
                                },
                            ],
                        } satisfies GitChanges;
                    },
                }),
        });
        await chooseScope('uncommitted');

        expect(rowPaths()).toContain('both.ts');
        expect(rowPaths()).toContain('sub');
        expect(discardPathsIn(sidebar())).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
    });

    it('is taken away while the branch is being changed, and comes back when it is done', async () => {
        await start();

        expect(discardButtons(sidebar())).toHaveLength(3);

        act(() => {
            model().facts.switching = true;
        });
        await settle();

        expect(discardButtons()).toHaveLength(0);

        act(() => {
            model().facts.switching = false;
        });
        await settle();

        expect(discardButtons(sidebar())).toHaveLength(3);
    });
});

describe('the confirmation', () => {
    it('names the file and what happens to it, has Discard changes and Cancel, and starts on Cancel with nothing sent', async () => {
        await start();

        const discard = vi.spyOn(transport, 'discardGit');

        await press(rowButton('src/booking/price.ts'));
        await settleDialog();

        expect(dialogText()).toContain('Discard changes to price.ts?');
        expect(dialogText()).toContain('src/booking/price.ts');
        expect(dialogText()).toContain(
            'The file goes back to the last commit. A copy of what it holds now is kept for 7 days.'
        );
        expect(dialogText()).not.toContain('An agent is working here');
        expect(dialogButton('Discard changes').dataset.color).toBe('danger');
        expect(document.activeElement).toBe(dialogButton('Cancel'));
        expect(discard).not.toHaveBeenCalled();

        await press(dialogButton('Cancel'));
        await settleDialog();

        await untilClosed();

        expect(dialog()).toBeNull();
        expect(discard).not.toHaveBeenCalled();
        expect(cardPaths()).toContain('src/booking/price.ts');
    });

    it('says Delete for a file that is not in git, from a card as from a row', async () => {
        await start();
        await press(cardButton('notes.md'));
        await settleDialog();

        expect(dialogText()).toContain('Delete notes.md?');
        expect(dialogText()).toContain('The file is not in git. A copy of it is kept for 7 days.');
        // The path is shown only when the file has a folder to tell.
        expect(dialog()?.querySelector('[title="notes.md"]')).toBeNull();
        expect(dialogButton('Discard changes')).toBeDefined();
    });

    it("does nothing on Enter, which is Cancel's while the focus is on it", async () => {
        await start();

        const discard = vi.spyOn(transport, 'discardGit');

        await press(rowButton('notes.md'));
        await settleDialog();
        await act(async () => {
            dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settleDialog();

        expect(dialog()).not.toBeNull();
        expect(discard).not.toHaveBeenCalled();
    });

    it("warns that an agent is working in the place, as a note and no more, and the discard is still the person's", async () => {
        await start({
            tweak: data => {
                data.runs.find(run => run.id === FIXTURE_WORKSPACE_RUN_ID)!.status = 'running';
            },
        });
        await press(rowButton('notes.md'));
        await settleDialog();

        expect(dialog()?.querySelector('[role="note"]')?.textContent).toBe('An agent is working here');
        expect(dialogButton('Discard changes').disabled).toBe(false);
    });

    it('discards the file when Discard changes is pressed, holds both buttons while it works, closes, and reads the place again so the file is gone', async () => {
        let finish: () => void = () => undefined;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    discardGit: async (project, place, paths) => {
                        await new Promise<void>(resolve => {
                            finish = resolve;
                        });

                        return base.discardGit(project, place, paths);
                    },
                }),
        });

        const changes = vi.spyOn(transport, 'getGitChanges');
        const status = vi.spyOn(transport, 'getGitStatus');

        await press(rowButton('notes.md'));
        await settleDialog();
        await press(dialogButton('Discard changes'));

        // Working: nothing can be pressed again, and nothing is read yet.
        expect(dialogButton('Discard changes').disabled).toBe(true);
        expect(dialogButton('Cancel').disabled).toBe(true);
        expect(cardPaths()).toContain('notes.md');

        const reads = changes.mock.calls.length;
        const statuses = status.mock.calls.length;

        await act(async () => finish());
        await settleDialog();
        await settle();

        await untilClosed();

        expect(dialog()).toBeNull();
        // The facts' next round: the status, and the lists of the scope that is shown and of the uncommitted files.
        expect(status.mock.calls.length).toBeGreaterThan(statuses);
        expect(changes.mock.calls.length).toBeGreaterThan(reads);
        // The card and the row of the file are gone with its changes, and the others stay.
        expect(cardPaths()).toEqual([
            'assets/logo.png',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ]);
        expect(rowPaths()).not.toContain('notes.md');
        expect(discardPathsIn(sidebar())).toEqual(['src/booking/price.ts', 'src/limits.ts']);
    });

    it('asks the daemon for that one file, in the place of the tab', async () => {
        await start();

        const discard = vi.spyOn(transport, 'discardGit');

        await press(cardButton('src/limits.ts'));
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();

        expect(discard).toHaveBeenCalledTimes(1);
        expect(discard).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, ['src/limits.ts']);
    });

    it("says the daemon's own line inside the dialog when it refuses, closes nothing, and reads the place again all the same", async () => {
        await start({ gitWrites: { discard: 'refused' } });

        const status = vi.spyOn(transport, 'getGitStatus');

        await press(rowButton('src/limits.ts'));
        await settleDialog();

        const before = status.mock.calls.length;

        await press(dialogButton('Discard changes'));
        await settleDialog();

        expect(dialog()).not.toBeNull();
        expect(dialogAlert()).toBe('Resolve the conflict first');
        expect(dialogButton('Discard changes').disabled).toBe(false);
        expect(dialogButton('Cancel').disabled).toBe(false);
        // A discard that failed may have done a part of what it was asked: the place is read again.
        expect(status.mock.calls.length).toBeGreaterThan(before);
        expect(cardPaths()).toContain('src/limits.ts');
    });

    it('says a copy that could not be kept as the daemon says it, and goes through on the next press when the daemon does', async () => {
        let failures = 1;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    discardGit: async (project, place, paths): Promise<GitDiscardResult> => {
                        if (failures-- > 0) {
                            throw new TransportError(
                                "Couldn't keep a copy of the files, so nothing was discarded: ENOSPC: no space left on device",
                                503
                            );
                        }

                        return base.discardGit(project, place, paths);
                    },
                }),
        });
        await press(rowButton('src/limits.ts'));
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();

        expect(dialogAlert()).toContain('nothing was discarded');
        expect(cardPaths()).toContain('src/limits.ts');

        await press(dialogButton('Discard changes'));
        await settleDialog();
        await settle();

        // The line is gone with the dialog, and so is the file.
        await untilClosed();

        expect(dialog()).toBeNull();
        expect(cardPaths()).not.toContain('src/limits.ts');
    });

    it('closes and says in a toast where the copy of what it discarded is kept', async () => {
        await start();

        const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');

        try {
            await press(rowButton('src/limits.ts'));
            await settleDialog();
            await press(dialogButton('Discard changes'));
            await settleDialog();
            await settle();
            await untilClosed();

            expect(success).toHaveBeenCalledExactlyOnceWith({
                title: 'Changes discarded',
                message: expect.stringMatching(/^A copy is in \//),
                timeout: 8000,
            });
        } finally {
            success.mockRestore();
        }
    });

    it("closes and tells the line of the person's hook in a toast when the file was discarded and a post-checkout hook failed after it", async () => {
        await start({ gitWrites: { discard: 'hook' } });

        const warning = vi.spyOn(toast, 'warning').mockImplementation(() => 'toast');

        try {
            await press(rowButton('src/limits.ts'));
            await settleDialog();
            await press(dialogButton('Discard changes'));
            await settleDialog();
            await settle();
            await untilClosed();

            // A failure line in the dialog would have said the file was not discarded: it was.
            expect(dialog()).toBeNull();
            expect(cardPaths()).not.toContain('src/limits.ts');
            expect(warning).toHaveBeenCalledExactlyOnceWith({
                title: 'Changes discarded',
                message: FIXTURE_DISCARD_HOOK_LINE,
                timeout: 8000,
            });
        } finally {
            warning.mockRestore();
        }
    });

    it('leaves a file that the branch had changed in All changes, as the branch left it, and a mark of viewed it had does not count', async () => {
        await start();

        const file = { path: 'src/booking/price.ts', revision: '' };

        const all = model();

        file.revision = all.changes!.files.find(item => item.path === file.path)!.revision;
        await act(async () => {
            await all.setViewed(file, true);
        });

        expect(all.isViewed(file.path)).toBe(true);

        await press(rowButton(file.path));
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();
        await settle();

        // The branch's own changes to the file stay, so its card and its row do too, with what was committed.
        expect(cardPaths()).toContain(file.path);
        expect(all.changes!.files.find(item => item.path === file.path)).toMatchObject({ additions: 23, deletions: 5 });
        expect(all.isViewed(file.path)).toBe(false);
        // And the file is no longer one whose changes can be discarded.
        expect(discardPathsIn(sidebar())).toEqual(['notes.md', 'src/limits.ts']);
    });
});
