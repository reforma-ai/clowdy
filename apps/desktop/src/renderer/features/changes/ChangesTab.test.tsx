// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_LAST_RUN_CHAT_ID,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    FIXTURE_QUIET_CHAT_ID,
    FIXTURE_RUN_FILES,
    FIXTURE_RUN_SCOPE,
    FIXTURE_WORKSPACE_CHAT_ID,
    type FixtureData,
    withFixtureLastRun,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { type Transport, TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { chatFolder } from '../agents/agentTree';
import { kindOnDisk } from '../files/openInFiles';
import { chatPlace } from '../sidePanel/currentPlace';
import ChangesTab from './ChangesTab';
import { gitFactsOf } from './gitFacts';
import { openRunInChanges } from './openRunInChanges';
import { changesSidebarLayout } from './sidebarLayout';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitChanges, GitFileSides } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    DiffView: ({
        path,
        original,
        modified,
        estimatedLines,
    }: {
        path: string;
        original: string | null;
        modified: string | null;
        estimatedLines?: number;
    }) => (
        <pre
            data-diff={path}
            data-lines={estimatedLines}
        >{`${original === null ? '(none)' : original}=>${modified === null ? '(none)' : modified}`}</pre>
    ),
    // What a card asks for once a message box is mounted (`useAddToChat`).
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
vi.mock('./DiffCard', async importOriginal => ({
    DiffCard: observer((await importOriginal<typeof import('./DiffCard')>()).DiffCard),
}));
vi.mock('./PullRequestChip', async importOriginal => ({
    PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip),
}));

/** What watches elements for the scroller's edge: it says nothing until the test says what came near. */
const watchers = new Set<{ callback: IntersectionObserverCallback; targets: Set<Element> }>();

class FakeIntersectionObserver {
    readonly #entry: { callback: IntersectionObserverCallback; targets: Set<Element> };

    constructor(callback: IntersectionObserverCallback) {
        this.#entry = { callback, targets: new Set() };
        watchers.add(this.#entry);
    }

    observe(target: Element) {
        this.#entry.targets.add(target);
    }

    disconnect() {
        watchers.delete(this.#entry);
    }

    unobserve() {}
    takeRecords() {
        return [];
    }
}

/** Tells the cards that `select` says that they came near the scroller's edge, or went far from it. */
const moveCards = (isIntersecting: boolean, select: (card: Element) => boolean) =>
    act(async () => {
        for (const { callback, targets } of [...watchers]) {
            const moved = [...targets].filter(select);

            if (moved.length > 0)
                callback(
                    moved.map(
                        target =>
                            ({
                                isIntersecting,
                                target,
                                boundingClientRect: target.getBoundingClientRect(),
                            }) as IntersectionObserverEntry
                    ),
                    {} as IntersectionObserver
                );
        }
    });

/** Brings the cards that `select` says are near the scroller's edge into reach. */
const bringNear = (select: (card: Element) => boolean = () => true) => moveCards(true, select);

/** Takes the cards that `select` says out of reach of the scroller's edge, as a scroll past them does. */
const sendAway = (select: (card: Element) => boolean) => moveCards(false, select);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: Transport;
let scrolled: HTMLElement[];

const Tab = observer(ChangesTab);

const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
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

const cards = () => [...container.querySelectorAll<HTMLElement>('[data-card]')];
const cardPaths = () => cards().map(card => card.dataset.card);
const card = (path: string) => cards().find(element => element.dataset.card === path)!;
const scopeTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
const options = () => [...document.querySelectorAll('[role="option"]')];
const filter = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;
const summary = () => container.querySelector('[aria-label="Summary of the changes"]')?.textContent;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter(), text);
        filter().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Starts the store on the fixtures, with a chat in a worktree open on the Changes tab, `tweak` having its say about the data first and `wrap` about the transport. */
async function start({
    tweak,
    wrap,
    chat = FIXTURE_WORKSPACE_CHAT_ID,
}: {
    tweak?: (data: FixtureData) => void;
    wrap?: (base: FixtureTransport) => Transport;
    chat?: string | null;
} = {}) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);

    const base = new FixtureTransport({ data });

    transport = wrap ? wrap(base) : base;
    store = new RootStore(transport);
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);

    if (chat) store.ui.forProject(FIXTURE_PROJECT_ID).openChat(chat);
}

async function draw() {
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

beforeEach(() => {
    // Diff content scenarios opt into expanded cards. The default is covered separately below.
    localStorage.clear();
    sourceControlPreferences.setCollapseDiffs(false);
    watchers.clear();
    scrolled = [];
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
        scrolled.push(this);
    };

    if (!changesSidebarLayout.open) changesSidebarLayout.toggle();

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.unstubAllGlobals();
    localStorage.clear();
});

describe('the Changes tab of a chat in a worktree', () => {
    it('starts with folded cards and reveals the diffs on demand', async () => {
        sourceControlPreferences.setCollapseDiffs(true);
        await start();
        await draw();
        await bringNear();
        await settle();

        expect(cards()).toHaveLength(6);
        expect(cards().some(element => element.hasAttribute('data-open'))).toBe(false);

        await press(button('Unfold notes.md'));
        expect(card('notes.md').hasAttribute('data-open')).toBe(true);
        expect(cards().filter(element => element.hasAttribute('data-open'))).toHaveLength(1);

        await press(button('Collapse all files'));
        await press(button('Expand all files'));
        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
    });

    it('shows file diffs and totals without a duplicate list in the sidebar', async () => {
        localStorage.setItem('clowdy:changes-commits-open', 'true');
        localStorage.setItem('clowdy:changes-commits-height', '200');
        await start();
        await draw();

        expect(cardPaths()).toEqual([
            'assets/logo.png',
            'notes.md',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ]);
        expect(summary()).toBe('6 files+112−8');
        expect(scopeTrigger().textContent).toContain('All changes');
        expect(container.querySelector('[aria-label="Changed files"]')).toBeNull();
        expect(container.querySelector('[aria-label="Changes sidebar"]')?.textContent).not.toContain(
            'Commits on branch'
        );
        expect(container.querySelector('[aria-label="Changes sidebar"]')?.textContent).toContain('clowdy/ab12cd34');
        const sidebar = container.querySelector('[aria-label="Changes sidebar"]');

        expect(sidebar?.textContent).not.toContain('Base:');
        expect(sidebar?.querySelector('[data-sync] button')?.getAttribute('aria-label')).toBe('Publish branch');
        expect(sidebar?.querySelector('button[aria-label="Update from main"]')).toBeNull();
        expect(container.querySelector('[role="row"][aria-label^="Open pull request 128"]')?.textContent).toContain(
            'PR #128'
        );
    });

    it("opens every card, and reads a file's texts only once its card is near the scroller's edge", async () => {
        await start();

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();

        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
        expect(read).not.toHaveBeenCalled();

        await bringNear(element => element === card('src/booking/price.ts'));
        await settle();

        expect(read).toHaveBeenCalledTimes(1);
        // With the list's own start, which saves the daemon the lookup of the base.
        expect(read).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            'all',
            'src/booking/price.ts',
            undefined,
            '3'.repeat(40)
        );
        expect(card('src/booking/price.ts').querySelector('[data-diff]')?.textContent).toContain('=>');
        expect(card('notes.md').querySelector('[data-diff]')).toBeNull();
    });

    it("opens and brings up a file's card on a press on its row in the commit box, through a filter that left it out, and leaves its tick as it was", async () => {
        sourceControlPreferences.setCollapseDiffs(true);
        await start();
        await draw();
        await bringNear();
        await type('*.md');

        expect(cardPaths()).not.toContain('src/limits.ts');

        const tick = container.querySelector<HTMLInputElement>(
            '[aria-label="Commit"] input[aria-label="src/limits.ts"]'
        )!;

        await press(tick.closest('[role="row"]')!);
        await vi.waitFor(() => expect(scrolled).toEqual([card('src/limits.ts')]));

        expect(filter().value).toBe('');
        expect(card('src/limits.ts').hasAttribute('data-open')).toBe(true);
        expect(tick.checked).toBe(true);
    });

    it('keeps a card that went far from the edge as an empty box in its place, and builds it again when it comes near', async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        expect(card('notes.md').querySelector('button')).not.toBeNull();

        await sendAway(element => element === card('notes.md'));

        // The box keeps its place in the list, its path and whether it is open, so a press on the last run plate still finds it.
        expect(cardPaths()).toContain('notes.md');
        expect(card('notes.md').querySelector('button')).toBeNull();
        expect(card('notes.md').hasAttribute('data-open')).toBe(true);
        expect(card('src/limits.ts').querySelector('button')).not.toBeNull();

        await bringNear(element => element === card('notes.md'));
        expect(button('Fold notes.md')).not.toBeNull();
    });

    it('keeps a card that holds the focus built while it is far, and empties it once the focus leaves', async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        await act(async () => button('Fold notes.md').focus());
        await sendAway(element => element === card('notes.md'));

        expect(document.activeElement).toBe(button('Fold notes.md'));

        await act(async () => button('Fold src/limits.ts').focus());

        expect(card('notes.md').querySelector('button')).toBeNull();
    });

    it("draws a file's diff with the two texts the daemon read, and a box of the lines its list counted before they come", async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        const diff = card('src/limits.ts').querySelector<HTMLElement>('[data-diff]')!;

        expect(diff.textContent).toBe('export const MAX_DAYS = 30;\n=>export const MAX_DAYS = 28;\n');
        // `src/limits.ts` changes one line and removes one: the guess is those two, the context, and never fewer than a dozen.
        expect(diff.dataset.lines).toBe('12');
        expect(card('src/booking/weekend.ts').querySelector('[data-diff]')?.textContent?.startsWith('(none)=>')).toBe(
            true
        );
    });

    it('says a binary file is binary, and a file too large to show is, without reading either', async () => {
        await start({
            tweak: () => undefined,
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: answer.files.map(file =>
                                file.path === 'src/limits.ts'
                                    ? { ...file, tooLarge: true as const, additions: 30_000, deletions: 5 }
                                    : file
                            ),
                        };
                    },
                }),
        });

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();
        await bringNear();
        await settle();

        expect(card('assets/logo.png').textContent).toContain('Binary file');
        expect(card('src/limits.ts').textContent).toContain('Too large to show');
        expect(read.mock.calls.map(call => call[3]).sort()).toEqual([
            'notes.md',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
        ]);
    });

    it('says a file whose text could not be read could not be, and reads it again on a press', async () => {
        let failures = 1;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitFile: async (project, place, scope, path, oldPath, from) => {
                        if (path === 'notes.md' && failures-- > 0)
                            throw new TransportError('The daemon answered 503', 503);

                        return base.getGitFile(project, place, scope, path, oldPath, from);
                    },
                }),
        });
        await draw();
        await bringNear();
        await settle();

        expect(card('notes.md').textContent).toContain("Couldn't read this file");

        const retry = [...card('notes.md').querySelectorAll('button')].find(
            element => element.textContent === 'Try again'
        )!;

        await press(retry);
        await settle();

        expect(card('notes.md').textContent).not.toContain("Couldn't read this file");
        expect(card('notes.md').querySelector('[data-diff]')?.textContent).toContain('# Notes');
    });

    it("says a file the daemon takes for binary or too large after its list did not is, with the daemon's word", async () => {
        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitFile: async (project, place, scope, path, oldPath, from): Promise<GitFileSides> => {
                        const sides = await base.getGitFile(project, place, scope, path, oldPath, from);

                        if (path === 'notes.md') return { state: 'binary', revision: sides.revision };

                        return path === 'src/limits.ts' ? { state: 'too_large', revision: sides.revision } : sides;
                    },
                }),
        });
        await draw();
        await bringNear();
        await settle();

        expect(card('notes.md').textContent).toContain('Binary file');
        expect(card('src/limits.ts').textContent).toContain('Too large to show');
    });

    it('shows what a file is: added, modified or deleted, with its lines, and the old path of a rename', async () => {
        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: [
                                ...answer.files,
                                {
                                    path: 'src/gone.ts',
                                    kind: 'deleted',
                                    additions: 0,
                                    deletions: 9,
                                    revision: `100644:${'6'.repeat(40)}:000000:${'0'.repeat(40)}`,
                                },
                                {
                                    path: 'src/renamed.ts',
                                    oldPath: 'src/old-name.ts',
                                    kind: 'renamed',
                                    additions: 1,
                                    deletions: 1,
                                    revision: `100644:${'7'.repeat(40)}:100644:${'8'.repeat(40)}`,
                                },
                            ],
                        } satisfies GitChanges;
                    },
                }),
        });
        await draw();

        const kinds = (path: string) => card(path).querySelector('[title]')?.getAttribute('title');

        expect(kinds('notes.md')).toBe('Added');
        expect(kinds('src/booking/price.ts')).toBe('Modified');
        expect(kinds('src/gone.ts')).toBe('Deleted');
        expect(kinds('src/renamed.ts')).toBe('Renamed');
        expect(card('src/renamed.ts').textContent).toContain('Renamed from src/old-name.ts');
        expect(card('src/booking/price.ts').textContent).not.toContain('Renamed from');
        expect(card('src/gone.ts').textContent).toContain('−9');
        expect(card('src/gone.ts').textContent).toContain('+0');
    });

    it('sets a path right to left so it is cut at its start, in a run of its own that reads left to right, so dots and brackets stay and a name in an RTL script is not turned round', async () => {
        await start();
        await draw();

        const label = card('src/booking/price.ts').querySelector('[dir="rtl"]')!;

        expect(label.textContent).toBe('src/booking/price.ts');
        expect(label.getAttribute('title')).toBe('src/booking/price.ts');
        // An isolate, not an override: `bdo` would draw the letters of a Hebrew name backwards.
        expect([...label.children].map(child => `${child.tagName.toLowerCase()}:${child.getAttribute('dir')}`)).toEqual(
            ['bdi:ltr']
        );
        expect(label.querySelector('bdo')).toBeNull();
    });

    describe('the menu of a file', () => {
        const items = () =>
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(row => row.textContent);
        const item = (text: string) =>
            [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
                row => row.textContent === text
            )!;
        const header = (path: string) => card(path).firstElementChild!;
        const rightClick = (target: Element) =>
            act(async () => {
                target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
            });
        // Where the file is on the disk: the chat's worktree.
        const ABSOLUTE = '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental/src/booking/price.ts';

        beforeEach(() => {
            vi.mocked(kindOnDisk).mockReset();
            vi.mocked(kindOnDisk).mockResolvedValue('file');
        });

        it('opens from the More button of a card with what the other menus of a path have, and copies the path from it', async () => {
            const write = vi.fn().mockResolvedValue(undefined);

            vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
            await start();
            await draw();

            expect(container.querySelector('button[aria-label^="Copy the path of"]')).toBeNull();

            await press(button('More for src/booking/price.ts'));
            await settle();

            expect(items()).toEqual(['Open in Files', 'Copy path', 'Copy relative path', 'Open in…']);
            expect(items()).not.toContain('Discard changes…');

            await press(item('Copy path'));

            expect(write).toHaveBeenCalledExactlyOnceWith(ABSOLUTE);
        });

        it('copies the path inside the folder from its second copy', async () => {
            const write = vi.fn().mockResolvedValue(undefined);

            vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
            await start();
            await draw();
            await press(button('More for src/booking/price.ts'));
            await settle();
            await press(item('Copy relative path'));

            expect(write).toHaveBeenCalledExactlyOnceWith('src/booking/price.ts');
        });

        it('opens at a right-click anywhere on the header, the same menu, and for the file that was clicked', async () => {
            await start();
            await draw();
            await rightClick(header('notes.md'));
            await settle();

            expect(items()).toEqual(['Open in Files', 'Copy path', 'Copy relative path', 'Open in…']);
            expect(kindOnDisk).toHaveBeenCalledWith(store, FIXTURE_PROJECT_ID, expect.anything(), 'notes.md');
        });

        it('says a deleted file is not there at once, and keeps only the copies of its path', async () => {
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
                                    file.path === 'notes.md' ? { ...file, kind: 'deleted' as const } : file
                                ),
                            };
                        },
                    }),
            });
            await draw();
            await rightClick(header('notes.md'));

            // At once, before the disk has answered.
            expect(items()).toEqual(['Copy path', 'Copy relative path']);
            expect(document.body.textContent).toContain("This file doesn't exist");
        });

        it('shows the full menu of a deleted file when the disk says it is there', async () => {
            await start({
                wrap: base =>
                    overrideTransport(base, {
                        getGitChanges: async (project, place, scope) => {
                            const answer = await base.getGitChanges(project, place, scope);

                            if (!answer.isRepository) return answer;

                            return {
                                ...answer,
                                files: answer.files.map(file =>
                                    file.path === 'notes.md' ? { ...file, kind: 'deleted' as const } : file
                                ),
                            };
                        },
                    }),
            });
            await draw();
            await rightClick(header('notes.md'));
            await settle();

            expect(items()).toEqual(['Open in Files', 'Copy path', 'Copy relative path', 'Open in…']);
        });

        it('marks the header while its menu is open, so the button stays on show', async () => {
            await start();
            await draw();
            await press(button('More for src/booking/price.ts'));

            expect(header('src/booking/price.ts').hasAttribute('data-menu-open')).toBe(true);
        });
    });

    it('folds individual cards and uses one button to collapse a mixed list or expand a folded list', async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        await press(button('Fold src/booking/price.ts'));
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(false);
        expect(card('src/booking/price.ts').querySelector('[data-diff]')).toBeNull();

        await press(button('Unfold src/booking/price.ts'));
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(true);

        await press(button('Fold src/booking/price.ts'));
        const foldAll = button('Collapse all files');

        expect(foldAll.disabled).toBe(false);
        expect(button('Expand all files')).toBeNull();
        await press(foldAll);
        expect(cards().some(element => element.hasAttribute('data-open'))).toBe(false);
        expect(button('Collapse all files')).toBeNull();
        expect(button('Expand all files')).toBe(foldAll);

        await press(foldAll);
        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
        expect(button('Expand all files')).toBeNull();
        expect(button('Collapse all files')).toBe(foldAll);
    });
});

const filterRows = [
    'All changesBranch commits and uncommitted changes',
    'BranchCommitted changes against the base',
    'UncommittedStaged, unstaged and untracked changes',
];
const commitRows = [
    expect.stringMatching(/^Charge a weekend surcharge(?:\d{1,2} Nov(?: 2026)?, )?\d{2}:\d{2} \(b744444\)$/),
    expect.stringMatching(/^Price a booking by the day(?:\d{1,2} Nov(?: 2026)?, )?\d{2}:\d{2} \(a155555\)$/),
];

describe('the scope', () => {
    it('has the entries of the scope menu: all changes, the branch, what is not committed and each commit of the branch, newest first', async () => {
        await start();
        await draw();
        await press(scopeTrigger());
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));

        expect(options().map(option => option.textContent)).toEqual([...filterRows, ...commitRows]);
        const group = document.querySelector('[role="group"][aria-label="Commits"]');
        expect(group?.textContent?.startsWith('Commits')).toBe(true);
        expect(group?.querySelectorAll('[role="option"]')).toHaveLength(2);
    });

    it('changes the list with the scope chosen from the menu', async () => {
        await start();
        await draw();
        await press(scopeTrigger());
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
        await press(options().find(option => option.textContent?.startsWith('Uncommitted'))!);
        await settle();

        expect(scopeTrigger().textContent).toContain('Uncommitted');
        expect(cardPaths()).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(summary()).toBe('3 files+10−3');
    });

    it('shows the selected commit in both file lists and returns to all changes from the toolbar', async () => {
        await start();
        await draw();

        const selectScope = async (label: string) => {
            await press(scopeTrigger());
            await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
            await press(options().find(option => option.textContent?.startsWith(label))!);
            await settle();
        };

        await selectScope('Price a booking by the day');

        expect(scopeTrigger().textContent).toBe('Price a booking by the day');
        expect(cardPaths()).toEqual(['assets/logo.png', 'src/booking/price.test.ts', 'src/booking/price.ts']);

        await selectScope('All changes');

        expect(scopeTrigger().textContent).toContain('All changes');
        expect(cards()).toHaveLength(6);
    });

    it('has the commit box in the sidebar whichever scope is shown, with the uncommitted files read for it and the commit sent from the scope that is not theirs', async () => {
        await start();

        const read = vi.spyOn(transport, 'getGitChanges');
        const commit = vi.spyOn(transport, 'commitGit');

        await draw();

        const commitBox = () => container.querySelector('[aria-label="Commit"]');
        const ticks = () =>
            [...container.querySelectorAll<HTMLInputElement>('[aria-label="Commit"] input[type="checkbox"]')].map(
                tick => tick.getAttribute('aria-label')
            );

        // The scope is all changes, six files, and the box lists the three that are not committed, from a read of its own.
        expect(cards()).toHaveLength(6);
        expect(ticks()).toEqual(['Tick every file', 'notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(read.mock.calls.filter(call => call[2] === 'uncommitted')).toHaveLength(1);

        // Another scope changes the cards and the files above it, and not the box.
        await act(async () => {
            scopeTrigger().click();
        });
        await act(async () => {
            options()
                .find(option => option.textContent?.startsWith('Branch'))!
                .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await settle();
        expect(scopeTrigger().textContent).toContain('Branch');
        expect(ticks()).toEqual(['Tick every file', 'notes.md', 'src/booking/price.ts', 'src/limits.ts']);

        await act(async () => {
            const text = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;

            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
                text,
                'feat: from the branch scope'
            );
            text.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await press(
            [...commitBox()!.querySelectorAll('button')].find(candidate => candidate.textContent?.startsWith('Commit'))!
        );
        await settle();
        await settle();

        expect(commit).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            ['notes.md', 'src/booking/price.ts', 'src/limits.ts'],
            'feat: from the branch scope'
        );
        expect(commitBox()?.textContent).toContain('No changed files');
        expect(ticks()).toEqual([]);
        expect(commitBox()?.textContent).toContain('Commit 0 files');
        expect(commitBox()?.textContent).not.toContain('Committed c0ffee0');
    });

    it("reads again only when the facts start a round of reads: a refresh of the store and the window's focus reach it, and nothing else does", async () => {
        await start();

        const read = vi.spyOn(transport, 'getGitChanges');

        await draw();

        const allReads = () => read.mock.calls.filter(call => call[2] === 'all').length;

        expect(allReads()).toBe(1);

        await settle();
        await settle();
        expect(allReads()).toBe(1);

        const facts = gitFactsOf(transport);

        await act(async () => {
            facts.refresh({ projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' });
        });
        await settle();

        expect(allReads()).toBe(2);

        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await settle();

        expect(allReads()).toBe(3);
    });

    it("reads a refreshed list's files again only where their revision changed", async () => {
        let edited = false;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!edited || !answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: answer.files.map(file =>
                                file.path === 'src/limits.ts'
                                    ? { ...file, revision: `100644:${'d'.repeat(40)}:100644:${'9'.repeat(40)}` }
                                    : file
                            ),
                        };
                    },
                }),
        });

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();
        await bringNear();
        await settle();

        expect(read).toHaveBeenCalledTimes(5);

        edited = true;
        read.mockClear();
        await act(async () => {
            gitFactsOf(transport).refresh({
                projectId: FIXTURE_PROJECT_ID,
                folderId: 'fld_car_rental',
                workspaceId: 'wks_ab12cd34',
            });
        });
        await settle();
        await bringNear();
        await settle();

        expect(read.mock.calls.map(call => call[3])).toEqual(['src/limits.ts']);
    });
});

describe('the filter', () => {
    it('narrows the cards by what is typed, and says how many of the files are shown', async () => {
        await start();
        await draw();

        expect(filter().placeholder).toBe('Filter files, e.g. *.md, docs/**, !*.test.ts');

        await type('src/**, !*.test.ts');

        expect(cardPaths()).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts', 'src/limits.ts']);
        expect(summary()).toBe('3 of 6 files+72−8');

        await type('*.md');
        expect(cardPaths()).toEqual(['notes.md']);

        await type('');
        expect(cards()).toHaveLength(6);
    });

    it('says no file matches, and clears the filter from the button that says so', async () => {
        await start();
        await draw();
        await type('*.rs');

        expect(cards()).toHaveLength(0);
        expect(button('Collapse all files').disabled).toBe(true);
        expect(button('Expand all files')).toBeNull();
        expect(container.textContent).toContain('No files match the filter');

        await press(
            [...container.querySelectorAll('button')].find(element => element.textContent === 'Clear the filter')!
        );

        expect(cards()).toHaveLength(6);
    });
});

describe('the sidebar', () => {
    it('copies the full current branch name without opening the branch picker', async () => {
        const write = vi.fn().mockResolvedValue(undefined);

        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
        await start();
        await draw();

        const branch = button('Current branch: clowdy/ab12cd34');
        await press(button('Copy branch name'));

        expect(write).toHaveBeenCalledExactlyOnceWith('clowdy/ab12cd34');
        expect(branch.getAttribute('aria-expanded')).toBe('false');
    });

    it('offers a base update and the pull request, and opens the repository on GitHub', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await start();
        await draw();

        const sidebar = container.querySelector('[aria-label="Changes sidebar"]')!;

        await press(sidebar.querySelector('button[aria-label="Open the repository on GitHub"]')!);
        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental', '_blank', 'noopener');

        const pullRequest = sidebar.querySelector('[role="row"][aria-label^="Open pull request 128"]')!;
        const checks = pullRequest.querySelector('[data-check="failed"]')!;

        open.mockClear();
        await press(checks);
        expect(open).toHaveBeenCalledExactlyOnceWith(
            'https://github.com/acme/car-rental/pull/128',
            '_blank',
            'noopener'
        );
        expect(document.querySelector('ul[aria-label="Checks"]')).toBeNull();
    });

    it('is hidden by a press on its button, which is then in the toolbar of the diffs, and comes back on a second press', async () => {
        await start();
        await draw();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).not.toBeNull();
        expect(button('Source control').getAttribute('aria-pressed')).toBe('true');

        await press(button('Source control'));
        await settle();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).toBeNull();
        expect(container.querySelectorAll('[data-sidebar-toggle]')).toHaveLength(1);
        expect(button('Source control').getAttribute('aria-pressed')).toBe('false');
        expect(changesSidebarLayout.open).toBe(false);
        expect(JSON.parse(localStorage.getItem('clowdy:changes-sidebar-open') ?? 'null')).toBe(false);

        await press(button('Source control'));
        await settle();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).not.toBeNull();
    });
});

describe('the viewed files', () => {
    const tickOf = (path: string) => card(path).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const tick = (path: string) =>
        act(async () => {
            tickOf(path).click();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
    const hideViewed = () => button('Hide viewed');
    /** The fixture's own transport, which holds the marks: the tab is drawn again over it, the way a window is over the daemon. */
    let shared: FixtureTransport | undefined;
    const share = (base: FixtureTransport) => {
        shared = base;

        return overrideTransport(base, {});
    };

    it('gives every card a Viewed checkbox, and ticking one shuts its card, counts it in the summary', async () => {
        await start();
        await draw();

        expect(cards().map(element => tickOf(element.dataset.card!).checked)).toEqual([
            false,
            false,
            false,
            false,
            false,
            false,
        ]);
        expect(cards().every(element => element.textContent?.includes('Viewed'))).toBe(true);
        // Each checkbox is named by its file as well as by `Viewed`, so a list of them is not fifty of the same name.
        expect(cards().map(element => tickOf(element.dataset.card!).getAttribute('aria-label'))).toEqual(
            cards().map(element => `Viewed ${element.dataset.card}`)
        );
        expect(summary()).toBe('6 files+112−8');

        const write = vi.spyOn(transport, 'setGitViewed');

        await tick('notes.md');

        expect(write).toHaveBeenCalledExactlyOnceWith(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            'all',
            'notes.md',
            expect.stringMatching(/^000000:0+:100644:b+$/)
        );
        expect(tickOf('notes.md').checked).toBe(true);
        expect(card('notes.md').hasAttribute('data-open')).toBe(false);
        expect(card('src/limits.ts').hasAttribute('data-open')).toBe(true);
        expect(summary()).toBe('6 files, 1 viewed+112−8');
    });

    it("opens the card and takes the tick, the row's tick and the count away when the checkbox is unticked", async () => {
        await start();
        await draw();
        await tick('src/limits.ts');
        await tick('notes.md');

        expect(summary()).toContain('2 viewed');

        const clear = vi.spyOn(transport, 'clearGitViewed');

        await tick('notes.md');

        expect(clear).toHaveBeenCalledExactlyOnceWith(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            'all',
            'notes.md'
        );
        expect(tickOf('notes.md').checked).toBe(false);
        expect(card('notes.md').hasAttribute('data-open')).toBe(true);
        expect(summary()).toContain('1 viewed');
    });

    it('opens a viewed card again on a press on its header', async () => {
        await start();
        await draw();
        await tick('notes.md');
        await tick('src/limits.ts');

        await press(button('Unfold notes.md'));
        expect(card('notes.md').hasAttribute('data-open')).toBe(true);
        // Still viewed: opening a card does not take the mark away.
        expect(tickOf('notes.md').checked).toBe(true);

        await press(button('Fold notes.md'));
        expect(card('notes.md').hasAttribute('data-open')).toBe(false);
    });

    it('shows the tick and the shut card before the daemon has answered, and takes both back quietly when it refuses', async () => {
        let refuse: (reason: unknown) => void = () => undefined;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    setGitViewed: () =>
                        new Promise((_resolve, reject) => {
                            refuse = reject;
                        }),
                }),
        });
        await draw();
        await tick('notes.md');

        expect(tickOf('notes.md').checked).toBe(true);
        expect(card('notes.md').hasAttribute('data-open')).toBe(false);
        expect(summary()).toContain('1 viewed');

        await act(async () => {
            refuse(new TransportError('The worktree is missing', 503));
            await new Promise(resolve => setTimeout(resolve, 0));
        });

        expect(tickOf('notes.md').checked).toBe(false);
        expect(card('notes.md').hasAttribute('data-open')).toBe(true);
        expect(summary()).not.toMatch(/\d+ viewed/);
        // A phrase in the summary line with the daemon's reason on it, no dialog and no toast.
        expect(summary()).toContain("Couldn't save the viewed mark");
        expect(container.querySelector('[title="The worktree is missing"]')?.textContent).toBe(
            "Couldn't save the viewed mark"
        );
        expect(document.querySelector('[role="alertdialog"], [role="alert"]')).toBeNull();
    });

    it('keeps the ticks for the next time the tab is drawn from the daemon, with the viewed cards shut and the rest open', async () => {
        await start({ wrap: share });
        await draw();
        await tick('src/limits.ts');
        await tick('src/booking/weekend.ts');

        // The window is made again over the same daemon: nothing of the tab's own state is left.
        act(() => root.unmount());
        store.dispose();
        transport = overrideTransport(shared!, {});
        store = new RootStore(transport);
        await store.load();
        store.selectProject(FIXTURE_PROJECT_ID);
        store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_WORKSPACE_CHAT_ID);
        root = createRoot(container);
        await draw();

        expect(tickOf('src/limits.ts').checked).toBe(true);
        expect(tickOf('notes.md').checked).toBe(false);
        expect(
            cards()
                .filter(element => element.hasAttribute('data-open'))
                .map(element => element.dataset.card)
        ).toEqual(['assets/logo.png', 'notes.md', 'src/booking/price.test.ts', 'src/booking/price.ts']);
        expect(summary()).toContain('2 viewed');
    });

    it('keeps the ticks of one scope out of another, and of the files that are in both', async () => {
        await start();
        await draw();
        await tick('src/limits.ts');

        await press(scopeTrigger());
        await press(options().find(option => option.textContent?.includes('Uncommitted'))!);
        await settle();

        expect(cardPaths()).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(tickOf('src/limits.ts').checked).toBe(false);
        expect(card('src/limits.ts').hasAttribute('data-open')).toBe(true);
        expect(summary()).not.toContain('viewed');

        await tick('notes.md');
        await press(scopeTrigger());
        await press(options().find(option => option.textContent?.includes('All changes'))!);
        await settle();

        expect(tickOf('src/limits.ts').checked).toBe(true);
        expect(tickOf('notes.md').checked).toBe(false);
    });

    it('shows a file whose mark is not its revision any more as not viewed, with its card open, and no count', async () => {
        let edited = false;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!edited || !answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: answer.files.map(file =>
                                file.path === 'src/limits.ts'
                                    ? { ...file, revision: `100644:${'d'.repeat(40)}:100644:${'9'.repeat(40)}` }
                                    : file
                            ),
                        };
                    },
                }),
        });
        await draw();
        await tick('src/limits.ts');
        await tick('notes.md');

        expect(summary()).toContain('2 viewed');

        edited = true;
        await act(async () => {
            gitFactsOf(transport).refresh({
                projectId: FIXTURE_PROJECT_ID,
                folderId: 'fld_car_rental',
                workspaceId: 'wks_ab12cd34',
            });
        });
        await settle();

        expect(tickOf('src/limits.ts').checked).toBe(false);
        expect(card('src/limits.ts').hasAttribute('data-open')).toBe(true);
        expect(tickOf('notes.md').checked).toBe(true);
        expect(summary()).toContain('1 viewed');
    });

    it('reads the marks again with the next round of the store, so a mark made in another window shows', async () => {
        await start({ wrap: share });
        await draw();

        const notes = (
            (await shared!.getGitChanges(
                FIXTURE_PROJECT_ID,
                { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
                'all'
            )) as { files: Array<{ path: string; revision: string }> }
        ).files.find(file => file.path === 'notes.md')!;

        await shared!.setGitViewed(
            FIXTURE_PROJECT_ID,
            { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
            'all',
            'notes.md',
            notes.revision
        );
        await act(async () => {
            gitFactsOf(transport).refresh({
                projectId: FIXTURE_PROJECT_ID,
                folderId: 'fld_car_rental',
                workspaceId: 'wks_ab12cd34',
            });
        });
        await settle();

        expect(card('notes.md').hasAttribute('data-open')).toBe(false);
    });

    it('has a Hide viewed toggle that is pressed or not, hides the viewed cards and rows, and brings them back', async () => {
        await start();
        await draw();

        // Hiding viewed files may be enabled before any are marked.
        expect(hideViewed().disabled).toBe(false);
        await press(hideViewed());
        expect(hideViewed().getAttribute('aria-pressed')).toBe('true');
        await press(hideViewed());
        expect(hideViewed().getAttribute('aria-pressed')).toBe('false');

        await tick('notes.md');
        await tick('src/limits.ts');

        expect(hideViewed().disabled).toBe(false);

        await press(hideViewed());

        expect(hideViewed().getAttribute('aria-pressed')).toBe('true');
        expect(cardPaths()).toEqual([
            'assets/logo.png',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
        ]);
        // The count is of the list, so it says what was read.
        expect(summary()).toContain('2 viewed');
        expect(summary()).toContain('6 files');

        await press(hideViewed());

        expect(hideViewed().getAttribute('aria-pressed')).toBe('false');
        expect(cards()).toHaveLength(6);
    });

    it('takes a card out of the list when it is ticked while viewed files are hidden, and says every file is viewed when none is left', async () => {
        await start();
        await draw();
        await tick('notes.md');
        await press(hideViewed());

        for (const path of [
            'assets/logo.png',
            'src/booking/price.test.ts',
            'src/booking/price.ts',
            'src/booking/weekend.ts',
            'src/limits.ts',
        ])
            await tick(path);

        expect(cards()).toHaveLength(0);
        expect(container.textContent).toContain('Every file is viewed');
        expect(summary()).toContain('6 viewed');

        await press(
            [...container.querySelectorAll('button')].find(element => element.textContent === 'Show viewed files')!
        );

        expect(hideViewed().getAttribute('aria-pressed')).toBe('false');
        expect(cards()).toHaveLength(6);
        expect(cards().every(element => !element.hasAttribute('data-open'))).toBe(true);
    });

    it('opens every card, the viewed ones too, on Expand all, and shuts them on Collapse all', async () => {
        await start();
        await draw();
        await tick('notes.md');

        expect(button('Expand all files')).toBeNull();
        await press(button('Collapse all files'));
        expect(cards().every(element => !element.hasAttribute('data-open'))).toBe(true);

        await press(button('Expand all files'));
        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
        expect(button('Collapse all files').disabled).toBe(false);
    });

    it('does not read the texts of a file because it was ticked: the state of the tick is out of the cache and the diff', async () => {
        await start();

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();
        await bringNear();
        await settle();

        const reads = read.mock.calls.length;

        await tick('notes.md');
        await tick('notes.md');

        expect(read.mock.calls.length).toBe(reads);
    });
});

describe('the states instead of the cards', () => {
    it('says a clean checkout has no changes, against what it is clean, and has no totals', async () => {
        await start({ chat: null });
        await draw();

        expect(cards()).toHaveLength(0);
        expect(container.textContent).toContain('No changes');
        expect(container.textContent).toContain('Nothing differs from origin/main');
        expect(summary()).toBeUndefined();
    });

    it('says a folder that is no repository is none', async () => {
        await start({ chat: null });
        store.selectProject(FIXTURE_PERSONAL_PROJECT_ID);
        store.ui.forProject(FIXTURE_PERSONAL_PROJECT_ID).showSidePanelTab('changes');
        await draw();

        expect(container.textContent).toContain('Not a git repository');
        expect(container.textContent).toContain('Changes show here once the folder is one');
        expect(cards()).toHaveLength(0);
    });

    it('says the list could not be read when it cannot, and reads it again on a press', async () => {
        let fails = true;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        if (fails && scope === 'all') throw new TransportError('The daemon answered 503', 503);

                        return base.getGitChanges(project, place, scope);
                    },
                }),
        });
        await draw();

        expect(container.textContent).toContain("Couldn't read the changes");
        expect(cards()).toHaveLength(0);

        fails = false;
        await press([...container.querySelectorAll('button')].find(element => element.textContent === 'Try again')!);
        await settle();

        expect(cards()).toHaveLength(6);
    });

    it('keeps the cards when a later read fails, and says nothing loud', async () => {
        let fails = false;

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        if (fails && scope === 'all') throw new TransportError('The daemon answered 503', 503);

                        return base.getGitChanges(project, place, scope);
                    },
                }),
        });
        await draw();

        fails = true;
        await act(async () => {
            gitFactsOf(transport).refresh({
                projectId: FIXTURE_PROJECT_ID,
                folderId: 'fld_car_rental',
                workspaceId: 'wks_ab12cd34',
            });
        });
        await settle();

        expect(cards()).toHaveLength(6);
        expect(container.textContent).not.toContain("Couldn't read");
    });

    it('says a branch with no base has nothing to compare with, and that all changes are then what is not committed', async () => {
        await start({
            chat: null,
            wrap: base =>
                overrideTransport(base, {
                    getGitStatus: async (project, place) => {
                        const status = await base.getGitStatus(project, place);

                        return status.isRepository ? { ...status, base: { state: 'no_base' as const } } : status;
                    },
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        return answer.isRepository ? { ...answer, baseState: 'no_base' as const } : answer;
                    },
                }),
        });
        await draw();

        expect(container.textContent).toContain('No changes');
        expect(container.textContent).toContain('There is no base branch to compare with yet');
        expect(container.querySelector('[data-commits-bar]')).toBeNull();
    });

    it('says a worktree that is not made yet is not, and reads nothing of it', async () => {
        await start({
            tweak: data => {
                const chat = data.chats.find(entry => entry.id === FIXTURE_WORKSPACE_CHAT_ID)!;

                chat.workspace = { ...chat.workspace!, ready: false };
            },
        });

        const read = vi.spyOn(transport, 'getGitChanges');

        await draw();

        expect(container.textContent).toContain('The worktree is not made yet');
        expect(read).not.toHaveBeenCalled();
    });

    it('says the list is cut when the daemon cut it, and keeps the rest working', async () => {
        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        return answer.isRepository && scope === 'all'
                            ? { ...answer, fileCount: 731, truncated: true as const }
                            : answer;
                    },
                }),
        });
        await draw();

        expect(container.textContent).toContain('Showing the first 6 files');
        expect(summary()).toContain('731 files');
        expect(cards()).toHaveLength(6);
    });
});

describe('the reads of the texts', () => {
    it('runs at most four at a time, and the rest wait for a place', async () => {
        let running = 0;
        let most = 0;
        const release: Array<() => void> = [];
        const names: string[] = [];

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: Array.from({ length: 10 }, (_, index) => ({
                                path: `src/f${index}.ts`,
                                kind: 'modified' as const,
                                additions: 1,
                                deletions: 1,
                                revision: `100644:${'a'.repeat(40)}:100644:${String(index).repeat(40)}`,
                            })),
                        };
                    },
                    getGitFile: async (_project, _place, _scope, path) => {
                        running++;
                        most = Math.max(most, running);
                        names.push(path);
                        await new Promise<void>(resolve => release.push(resolve));
                        running--;

                        return { state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' };
                    },
                }),
        });
        await draw();
        await bringNear();
        await settle();

        expect(running).toBe(4);
        expect(names).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts']);

        for (let round = 0; round < 3; round++) {
            await act(async () => {
                release.splice(0).forEach(resolve => resolve());
                await new Promise(resolve => setTimeout(resolve, 0));
            });
        }

        expect(names).toHaveLength(10);
        expect(most).toBe(4);
    });

    /** Ten files whose reads wait for the test, four of them running and six waiting for a place once every card is near. */
    async function startWithTenReads() {
        const release: Array<() => void> = [];
        const names: string[] = [];

        await start({
            wrap: base =>
                overrideTransport(base, {
                    getGitChanges: async (project, place, scope) => {
                        const answer = await base.getGitChanges(project, place, scope);

                        if (!answer.isRepository || scope !== 'all') return answer;

                        return {
                            ...answer,
                            files: Array.from({ length: 10 }, (_, index) => ({
                                path: `src/f${index}.ts`,
                                kind: 'modified' as const,
                                additions: 1,
                                deletions: 1,
                                revision: `100644:${'a'.repeat(40)}:100644:${String(index).repeat(40)}`,
                            })),
                        };
                    },
                    getGitFile: async (_project, _place, _scope, path) => {
                        names.push(path);
                        await new Promise<void>(resolve => release.push(resolve));

                        return { state: 'text', original: 'a\n', modified: 'b\n', revision: 'r' };
                    },
                }),
        });
        await draw();
        await bringNear();
        await settle();

        return {
            names,
            finishAll: () =>
                act(async () => {
                    release.splice(0).forEach(resolve => resolve());
                    await new Promise(resolve => setTimeout(resolve, 0));
                }),
        };
    }

    it('does not read the files of the cards that were scrolled past or shut before their turn, and reads them when they are near and open again', async () => {
        const { names, finishAll } = await startWithTenReads();

        expect(names).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts']);

        // A scroll past f6 to f9, and a press that folds f4, while the first four are still on their way.
        await sendAway(element =>
            ['src/f6.ts', 'src/f7.ts', 'src/f8.ts', 'src/f9.ts'].includes((element as HTMLElement).dataset.card!)
        );
        await press(button('Fold src/f4.ts'));
        await finishAll();
        await finishAll();

        expect(names).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f5.ts']);

        // They come back: what they need is read, and what is read is not read again.
        await bringNear(element => (element as HTMLElement).dataset.card === 'src/f6.ts');
        await press(button('Unfold src/f4.ts'));
        await finishAll();
        await finishAll();

        expect(names).toEqual([
            'src/f0.ts',
            'src/f1.ts',
            'src/f2.ts',
            'src/f3.ts',
            'src/f5.ts',
            'src/f6.ts',
            'src/f4.ts',
        ]);
    });

    it('does not read the files that the filter takes out of the list', async () => {
        const { names, finishAll } = await startWithTenReads();

        await type('f0, f1, f2, f3, f4');
        await finishAll();
        await finishAll();

        // f5 to f9 were waiting, and are not in the list any more.
        expect(names).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts']);
    });

    it('does not read any file once the tab is gone', async () => {
        const { names, finishAll } = await startWithTenReads();

        act(() => root.render(null));
        await finishAll();
        await finishAll();

        expect(names).toEqual(['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts']);
    });
});

describe('the last run of the open chat', () => {
    const withRuns = (data: FixtureData) => void withFixtureLastRun(data);
    const run = { tweak: withRuns, chat: FIXTURE_LAST_RUN_CHAT_ID };
    const openMenu = async () => {
        await press(scopeTrigger());
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
    };
    const optionLabels = () => options().map(option => option.textContent);

    it('is a scope of the menu after what is not committed, with a line that says the edits of others are in it, while the open chat has one', async () => {
        await start(run);
        await draw();
        await openMenu();

        expect(optionLabels()).toEqual([
            ...filterRows,
            'Last runEdits of others in the place are in it too',
            ...commitRows,
        ]);
    });

    it('is not offered for a chat whose latest run changed nothing, or for one with no run in the place', async () => {
        await start({ ...run, chat: FIXTURE_QUIET_CHAT_ID });
        await draw();
        await openMenu();
        expect(optionLabels()).toEqual([...filterRows, ...commitRows]);
    });

    it("is not offered while the new-chat page is shown, whose place is not a chat's", async () => {
        await start(run);
        store.ui.forProject(FIXTURE_PROJECT_ID).openDraft();
        await draw();
        await openMenu();
        expect(optionLabels()).not.toContain('Last runEdits of others in the place are in it too');
    });

    it('lists the files the run changed when it is picked, with their totals and the tooltip that says what the list is, and goes back to all changes', async () => {
        await start(run);
        await draw();
        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Last run'))!);
        await settle();

        expect(scopeTrigger().textContent).toContain('Last run');
        expect(scopeTrigger().closest('[title]')?.getAttribute('title')).toContain(
            'What the latest run of this chat changed'
        );
        expect(cardPaths()).toEqual(FIXTURE_RUN_FILES.map(file => file.path));
        expect(summary()).toBe('7 files+178−29');
        // The two ends of a run are trees: no commit, no base.

        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('All changes'))!);
        await settle();
        expect(scopeTrigger().textContent).toContain('All changes');
        expect(scopeTrigger().closest('[title]')).toBeNull();
        expect(cards()).toHaveLength(6);
    });

    it("reads the texts of the files of the run from the run's own scope, with no start of the list", async () => {
        await start(run);
        await draw();

        const read = vi.spyOn(transport, 'getGitFile');

        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Last run'))!);
        await settle();
        await bringNear();
        await settle();

        expect(read).toHaveBeenCalled();
        expect(read.mock.calls.every(call => call[2] === FIXTURE_RUN_SCOPE && call[5] === undefined)).toBe(true);
        expect(card('src/booking/price.ts').querySelector('[data-diff]')?.textContent).toContain('weekend');
    });

    it('opens on the run with the card of the pressed file brought up and opened, when it was asked for before the tab was drawn', async () => {
        await start(run);

        const project = store.selectedProject!;
        const chat = project.chats.get(FIXTURE_LAST_RUN_CHAT_ID)!;
        const place = chatPlace(
            project.project.folders,
            chat,
            chatFolder(project.chats, project.project.folders, chat.id)?.folder
        );

        expect(
            openRunInChanges(store, FIXTURE_PROJECT_ID, place, chat.id, FIXTURE_RUN_SCOPE, 'src/booking/weekend.ts')
        ).toBe(true);
        expect(store.ui.forProject(FIXTURE_PROJECT_ID).sidePanelTab).toBe('changes');
        expect(store.ui.forProject(FIXTURE_PROJECT_ID).sidePanelOpen).toBe(true);

        await draw();
        await vi.waitFor(() => expect(scrolled).toEqual([card('src/booking/weekend.ts')]));

        expect(scopeTrigger().textContent).toContain('Last run');
        expect(cardPaths()).toEqual(FIXTURE_RUN_FILES.map(file => file.path));
        expect(card('src/booking/weekend.ts').hasAttribute('data-open')).toBe(true);
        // The request is answered once: the tab does not scroll again to the file on a later round of reads.
        gitFactsOf(transport).refresh({
            projectId: FIXTURE_PROJECT_ID,
            folderId: place.folder.id,
            workspaceId: place.workspace!.id,
        });
        await settle();
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(scrolled).toEqual([card('src/booking/weekend.ts')]);
    });

    it('opens a viewed card of the run when its file is the one that was pressed, and keeps its mark', async () => {
        await start(run);
        await draw();
        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Last run'))!);
        await settle();

        const tick = (path: string) => container.querySelector<HTMLInputElement>(`input[aria-label="Viewed ${path}"]`)!;

        await press(tick('src/booking/price.ts'));
        await settle();
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(false);
        expect(summary()).toContain('1 viewed');
        expect(
            (
                await transport.getGitViewed(
                    FIXTURE_PROJECT_ID,
                    { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
                    FIXTURE_RUN_SCOPE
                )
            ).map(mark => mark.path)
        ).toEqual(['src/booking/price.ts']);
        // Another scope has none of it.
        expect(
            await transport.getGitViewed(
                FIXTURE_PROJECT_ID,
                { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' },
                'all'
            )
        ).toEqual([]);
    });

    it('says the changes of the run are gone when git has pruned its trees, with a way to try again, and the other scopes still work', async () => {
        await start({
            ...run,
            tweak: data => {
                withRuns(data);
                data.chats.find(chat => chat.id === FIXTURE_LAST_RUN_CHAT_ID)!.lastRun = {
                    startTree: 'c'.repeat(40),
                    endTree: 'd'.repeat(40),
                    seq: 2,
                    at: 1,
                };
            },
        });
        await draw();
        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Last run'))!);
        await settle();

        expect(container.textContent).toContain("Couldn't read the changes");
        expect(container.textContent).toContain('The changes of that run are no longer in the repository');
        expect(cards()).toHaveLength(0);

        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Uncommitted'))!);
        await settle();
        expect(cards()).toHaveLength(3);
    });

    it('is not followed to another chat of the place: the tab is back on all changes', async () => {
        await start(run);
        await draw();
        await openMenu();
        await press(options().find(option => option.textContent?.startsWith('Last run'))!);
        await settle();
        expect(cards()).toHaveLength(7);

        act(() => store.ui.forProject(FIXTURE_PROJECT_ID).openChat(FIXTURE_QUIET_CHAT_ID));
        await draw();
        await settle();

        expect(scopeTrigger().textContent).toContain('All changes');
        expect(cards()).toHaveLength(6);
    });
});
