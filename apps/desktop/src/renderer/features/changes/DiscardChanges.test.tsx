// @vitest-environment happy-dom
import { toast } from '@clowdy/components/Toast';
import { commitScope } from '@clowdy/protocol';
import { observer } from 'mobx-react-lite';
import { act, useState } from 'react';
import { createPortal } from 'react-dom';
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
import { kindOnDisk } from '../files/openInFiles';
import ChangesTab from './ChangesTab';
import { DiscardButton } from './DiscardButton';
import { gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { changesSidebarLayout } from './sidebarLayout';

import type { GitChanges, GitDiscardResult, GitScope } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLACE = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };

// A path is a file on the disk unless a test says the disk has nothing there.
vi.mock('../files/openInFiles', async importOriginal => ({
    ...(await importOriginal<typeof import('../files/openInFiles')>()),
    kindOnDisk: vi.fn(async () => 'file'),
}));
// happy-dom has no layout: the view builds its resizable group once its box has a width, which it is told.
vi.mock('./useBoxWidth', () => ({
    useBoxWidth: () => [() => undefined, 900],
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
// The card no longer exposes discard. Mount its retained dialog trigger only for the discard flow tests.
const discardHarness = vi.hoisted(() => ({ enabled: true }));
vi.mock('./DiffCard', async importOriginal => {
    const Original = (await importOriginal<typeof import('./DiffCard')>()).DiffCard;
    const Harness = observer((props: Parameters<typeof Original>[0]) => {
        const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null);
        const header = wrapper?.querySelector<HTMLElement>('[data-card] > div');
        const file = discardHarness.enabled ? props.model.discardable.get(props.file.path) : undefined;

        return (
            <div ref={setWrapper}>
                <Original {...props} />
                {header && file && createPortal(<DiscardButton model={props.model} file={file} />, header)}
            </div>
        );
    });

    return { DiffCard: Harness };
});
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
const discardButtons = (inside: ParentNode = container) => [
    ...inside.querySelectorAll<HTMLButtonElement>('button[data-discard]'),
];
const discardPathsIn = (inside: ParentNode) => discardButtons(inside).map(item => item.dataset.discard);
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
    discardHarness.enabled = true;
    vi.mocked(kindOnDisk).mockReset();
    vi.mocked(kindOnDisk).mockResolvedValue('file');
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

it('does not offer discard on diff cards', async () => {
    discardHarness.enabled = false;
    await start();
    expect(cardPaths()).toHaveLength(6);
    expect(discardButtons()).toHaveLength(0);
});

describe('discarding from the commit checklist', () => {
    const tick = (path: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${path}"]`)!;
    const row = (path: string) => tick(path).closest('[role="row"]')!;
    const menuItem = () => document.querySelector<HTMLElement>('[role="menuitem"][data-key="discard"]');
    const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent);

    it('discards only the right-clicked file, even when unchecked and showing committed changes', async () => {
        discardHarness.enabled = false;
        await start();
        await chooseScope('branch');
        const discard = vi.spyOn(transport, 'discardGit');
        const path = 'src/limits.ts';
        await press(tick(path));
        expect(tick(path).checked).toBe(false);
        expect(tick('notes.md').checked).toBe(true);

        await act(async () => {
            row(path).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
        });
        await settle();
        expect(menuItem()?.textContent).toContain('Discard changes…');
        await press(menuItem()!);
        await settleDialog();

        expect(dialogText()).toContain('Discard changes to limits.ts?');
        expect(discard).not.toHaveBeenCalled();
        await press(dialogButton('Discard changes'));
        await settleDialog();
        await untilClosed();

        expect(discard).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, PLACE, [path]);
        expect(tick(path)).toBeNull();
        expect(tick('notes.md').checked).toBe(true);
        expect(tick('src/booking/price.ts').checked).toBe(true);
    });

    it('opens the menu of the path of any row, with Discard changes… as its last item for a file that can be discarded', async () => {
        discardHarness.enabled = false;
        await start();
        await act(async () => {
            row('notes.md').dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
            );
        });
        await settle();

        expect(menuItems()).toEqual([
            'Open in Files',
            'Copy path',
            'Copy relative path',
            'Open in…',
            'Discard changes…',
        ]);
    });

    it('keeps Discard changes… in the menu of a deleted file, under the copies of its path, and discards it', async () => {
        discardHarness.enabled = false;
        vi.mocked(kindOnDisk).mockReturnValue(new Promise(() => undefined));
        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository) return answer;

                        return {
                            ...answer,
                            files: answer.files.map(file =>
                                file.path === 'src/limits.ts' ? { ...file, kind: 'deleted' as const } : file
                            ),
                        };
                    },
                }),
        });
        const discard = vi.spyOn(transport, 'discardGit');

        await act(async () => {
            row('src/limits.ts').dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
            );
        });

        // At once, before the disk has answered.
        expect(menuItems()).toEqual(['Copy path', 'Copy relative path', 'Discard changes…']);
        expect(document.body.textContent).toContain("This file doesn't exist");

        await press(menuItem()!);
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();
        await untilClosed();

        expect(discard).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, PLACE, ['src/limits.ts']);
    });

    it('offers the focused row through the keyboard and preserves files when the dialog is cancelled', async () => {
        discardHarness.enabled = false;
        await start();
        const discard = vi.spyOn(transport, 'discardGit');
        await act(async () => {
            row('notes.md').dispatchEvent(
                new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
            );
        });
        await settle();
        expect(menuItem()).not.toBeNull();
        await press(menuItem()!);
        await settleDialog();

        expect(dialogText()).toContain('Delete notes.md?');
        await press(dialogButton('Cancel'));
        await untilClosed();
        expect(discard).not.toHaveBeenCalled();
        expect(tick('notes.md').checked).toBe(true);
    });
});

describe('the retained discard trigger in the test harness', () => {
    it('is on the diff cards of the uncommitted files in All changes, and not on the files that are only committed', async () => {
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
        expect(discardPathsIn(container)).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(discardPathsIn(container.querySelector('[data-card="notes.md"]')!)).toEqual(['notes.md']);
        expect(discardPathsIn(card('assets/logo.png'))).toEqual([]);

        const button = cardButton('notes.md');

        expect(button.getAttribute('aria-label')).toBe('Discard changes to notes.md');
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('tabindex')).not.toBe('-1');
        expect(button.getAttribute('data-variant')).toBe('filling');
    });

    it('is on the same files in Uncommitted, and on none in Branch or in a commit', async () => {
        await start();
        await chooseScope('uncommitted');

        expect(discardPathsIn(container)).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(cardPaths()).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(discardButtons()).toHaveLength(3);

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

        expect(cardPaths()).toContain('src/both.ts');
        expect(cardPaths()).toContain('vendor/sub');
        expect(discardPathsIn(container)).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);

        for (const path of ['src/both.ts', 'vendor/sub']) {
            const row = container.querySelector(`input[aria-label="${path}"]`)?.closest('[role="row"]');
            expect(row).toBeDefined();
            await act(async () => {
                row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
            });
            // The menu of the path is there all the same: only the discard is not.
            expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toContain(
                'Copy path'
            );
            expect(document.querySelector('[role="menuitem"][data-key="discard"]')).toBeNull();
        }
    });

    it('is taken away while the branch is being changed, and comes back when it is done', async () => {
        await start();

        expect(discardButtons()).toHaveLength(3);

        act(() => {
            model().facts.switching = true;
        });
        await settle();

        expect(discardButtons()).toHaveLength(0);

        act(() => {
            model().facts.switching = false;
        });
        await settle();

        expect(discardButtons()).toHaveLength(3);
    });
});

describe('the confirmation', () => {
    it('names the file and what happens to it, has Discard changes and Cancel, and starts on Cancel with nothing sent', async () => {
        await start();

        const discard = vi.spyOn(transport, 'discardGit');

        await press(cardButton('src/booking/price.ts'));
        await settleDialog();

        expect(dialogText()).toContain('Discard changes to price.ts?');
        expect(dialogText()).toContain('src/booking/price.ts');
        expect(dialogText()).toContain('The file goes back to the last commit');
        expect(dialogText()).not.toContain('A copy');
        expect(dialogText()).not.toContain('An agent is working here');
        expect(dialogButton('Discard changes').dataset.color).toBe('danger');
        expect(dialogButton('Cancel').dataset.variant).toBe('filled');
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
        expect(dialogText()).toContain('The file is not in git and will be deleted');
        // The path is shown only when the file has a folder to tell.
        expect(dialog()?.querySelector('[title="notes.md"]')).toBeNull();
        expect(dialogButton('Discard changes')).toBeDefined();
    });

    it("does nothing on Enter, which is Cancel's while the focus is on it", async () => {
        await start();

        const discard = vi.spyOn(transport, 'discardGit');

        await press(cardButton('notes.md'));
        await settleDialog();
        await act(async () => {
            dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settleDialog();

        expect(dialog()).not.toBeNull();
        expect(discard).not.toHaveBeenCalled();
    });

    it('does not add an agent activity warning when discarding a file', async () => {
        await start({
            tweak: data => {
                data.runs.find(run => run.id === FIXTURE_WORKSPACE_RUN_ID)!.status = 'running';
            },
        });
        await press(cardButton('notes.md'));
        await settleDialog();

        expect(dialog()?.querySelector('[role="note"]')).toBeNull();
        expect(dialogText()).not.toContain('An agent is working here');
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

        await press(cardButton('notes.md'));
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
        // The card is gone with its changes, and the others stay.
        expect(cardPaths()).toEqual([
            'assets/logo.png',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ]);
        expect(discardPathsIn(container)).toEqual(['src/booking/price.ts', 'src/limits.ts']);
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

        await press(cardButton('src/limits.ts'));
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

    it('shows a Git error in the dialog and retries only on the next press', async () => {
        let failures = 1;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    discardGit: async (project, place, paths): Promise<GitDiscardResult> => {
                        if (failures-- > 0) {
                            throw new TransportError('No space left on device', 503);
                        }

                        return base.discardGit(project, place, paths);
                    },
                }),
        });
        await press(cardButton('src/limits.ts'));
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();

        expect(dialogAlert()).toBe('No space left on device');
        expect(cardPaths()).toContain('src/limits.ts');

        await press(dialogButton('Discard changes'));
        await settleDialog();
        await settle();

        // The line is gone with the dialog, and so is the file.
        await untilClosed();

        expect(dialog()).toBeNull();
        expect(cardPaths()).not.toContain('src/limits.ts');
    });

    it.each([
        ['src/limits.ts', 'limits.ts'],
        ['notes.md', 'notes.md'],
    ])('shows a one-line filename toast after discarding %s', async (path, name) => {
        await start();

        const success = vi.spyOn(toast, 'success').mockImplementation(() => 'toast');

        try {
            await press(cardButton(path));
            await settleDialog();
            await press(dialogButton('Discard changes'));
            await settleDialog();
            await settle();
            await untilClosed();

            expect(success).toHaveBeenCalledExactlyOnceWith({ message: `${name} discarded` });
        } finally {
            success.mockRestore();
        }
    });

    it("closes and tells the line of the person's hook in a toast when the file was discarded and a post-checkout hook failed after it", async () => {
        await start({ gitWrites: { discard: 'hook' } });

        const warning = vi.spyOn(toast, 'warning').mockImplementation(() => 'toast');

        try {
            await press(cardButton('src/limits.ts'));
            await settleDialog();
            await press(dialogButton('Discard changes'));
            await settleDialog();
            await settle();
            await untilClosed();

            // A failure line in the dialog would have said the file was not discarded: it was.
            expect(dialog()).toBeNull();
            expect(cardPaths()).not.toContain('src/limits.ts');
            expect(warning).toHaveBeenCalledExactlyOnceWith({
                title: 'limits.ts discarded',
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

        await press(cardButton(file.path));
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();
        await settle();

        // The branch's own changes to the file stay, so its card does too, with what was committed.
        expect(cardPaths()).toContain(file.path);
        expect(all.changes!.files.find(item => item.path === file.path)).toMatchObject({ additions: 23, deletions: 5 });
        expect(all.isViewed(file.path)).toBe(false);
        // And the file is no longer one whose changes can be discarded.
        expect(discardPathsIn(container)).toEqual(['notes.md', 'src/limits.ts']);
    });
});

describe('the focus after a discard', () => {
    /** Discards a file through its button and the confirmation, and waits for the place to be read again and the focus to settle. */
    const discardThrough = async (button: HTMLButtonElement) => {
        await press(button);
        await settleDialog();
        await press(dialogButton('Discard changes'));
        await settleDialog();
        await settle();
        await untilClosed();
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
        });
    };
    it("goes to the next card's fold button when the file's card goes", async () => {
        await start();
        await discardThrough(cardButton('notes.md'));

        expect(cardPaths()).not.toContain('notes.md');
        expect(document.activeElement).toBe(card('src/booking/price.test.ts').querySelector('button[aria-expanded]'));
    });

    it('goes to the filter field above the cards when the card that went was the only one', async () => {
        await start();
        act(() => model().setFilter('src/limits.ts'));
        await settle();

        await discardThrough(cardButton('src/limits.ts'));

        expect(cardPaths()).toEqual([]);
        expect(document.activeElement).toBe(container.querySelector('input[aria-label="Filter files"]'));
    });

    it('returns focus to the surviving card when its discard button goes', async () => {
        await start();
        await discardThrough(cardButton('src/booking/price.ts'));

        expect(cardButton('src/booking/price.ts')).toBeNull();
        expect(document.activeElement).toBe(card('src/booking/price.ts').querySelector('button[aria-expanded]'));
    });
});
