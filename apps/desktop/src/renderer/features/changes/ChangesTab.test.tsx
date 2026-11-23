// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_GIT_COMMITS, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, withFixtureWorkspace, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { overrideTransport } from '../../daemon/testing';
import { TransportError, type Transport } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import ChangesTab from './ChangesTab';
import { gitFactsOf } from './gitFacts';
import { changesSidebarLayout } from './sidebarLayout';

import type { GitChanges, GitFileSides } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no layout: the view builds its resizable group once its box has a width, which it is told.
vi.mock('./useBoxWidth', () => ({ useBoxWidth: () => [() => undefined, 900] }));
// The diff view has specs of its own (`packages/file-manager/specs`); here it only has to be given the right texts.
vi.mock('@clowdy/file-manager/react', () => ({
    DiffView: ({ path, original, modified, estimatedLines }: { path: string; original: string | null; modified: string | null; estimatedLines?: number }) => (
        <pre data-diff={ path } data-lines={ estimatedLines }>{ `${ original === null ? '(none)' : original }=>${ modified === null ? '(none)' : modified }` }</pre>
    ),
}));
// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the tab are, to follow the model they read.
vi.mock('./ChangesView', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesView')>(), ChangesView: observer((await importOriginal<typeof import('./ChangesView')>()).ChangesView) }));
vi.mock('./ChangesList', async importOriginal => ({ ChangesList: observer((await importOriginal<typeof import('./ChangesList')>()).ChangesList) }));
vi.mock('./ChangesToolbar', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesToolbar')>(), ChangesToolbar: observer((await importOriginal<typeof import('./ChangesToolbar')>()).ChangesToolbar) }));
vi.mock('./ChangesSidebar', async importOriginal => ({ ...await importOriginal<typeof import('./ChangesSidebar')>(), ChangesSidebar: observer((await importOriginal<typeof import('./ChangesSidebar')>()).ChangesSidebar) }));
vi.mock('./DiffCard', async importOriginal => ({ DiffCard: observer((await importOriginal<typeof import('./DiffCard')>()).DiffCard) }));
vi.mock('./PullRequestChip', async importOriginal => ({ PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip) }));

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

/** Brings the cards that `select` says are near the scroller's edge into reach. */
const bringNear = (select: (card: Element) => boolean = () => true) => act(async () => {
    for (const { callback, targets } of [...watchers]) {
        const near = [...targets].filter(select);

        if (near.length > 0) callback(near.map(target => ({ isIntersecting: true, target }) as IntersectionObserverEntry), {} as IntersectionObserver);
    }
});

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: Transport;
let scrolled: HTMLElement[];

const Tab = observer(ChangesTab);

const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
});
const press = (target: Element) => act(async () => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    (target as HTMLElement).click();
});

const cards = () => [...container.querySelectorAll<HTMLElement>('[data-card]')];
const cardPaths = () => cards().map(card => card.dataset.card);
const card = (path: string) => cards().find(element => element.dataset.card === path)!;
const sidebarFiles = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Changed files"] button')];
const sidebarPaths = () => sidebarFiles().map(row => row.querySelector('[class*="name"]')?.textContent);
const commitRows = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Committed on branch"] button')];
const scopeTrigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
const options = () => [...document.querySelectorAll('[role="option"]')];
const filter = () => container.querySelector<HTMLInputElement>('input[aria-label="Filter files"]')!;
const summary = () => container.querySelector('[aria-label="Summary of the changes"]')?.textContent;
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${ label }"]`)!;

async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(filter(), text);
        filter().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** Starts the store on the fixtures, with a chat in a worktree open on the Changes tab, `tweak` having its say about the data first and `wrap` about the transport. */
async function start({ tweak, wrap, chat = FIXTURE_WORKSPACE_CHAT_ID }: { tweak?: (data: FixtureData) => void; wrap?: (base: FixtureTransport) => Transport; chat?: string | null } = {}) {
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
    act(() => root.render(<RootStoreProvider value={ store }><Tab /></RootStoreProvider>));
    await settle();
    await settle();
}

beforeEach(() => {
    localStorage.clear();
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
    it('has a card for each file of all the changes, the totals of the list, and the files and commits in the sidebar', async () => {
        await start();
        await draw();

        expect(cardPaths()).toEqual(['assets/logo.png', 'notes.md', 'src/booking/price.test.ts', 'src/booking/price.ts', 'src/booking/weekend.ts', 'src/limits.ts']);
        expect(summary()).toBe('6 files,+112−8');
        expect(scopeTrigger().textContent).toContain('All changes');
        expect(sidebarPaths()).toEqual(['logo.png', 'notes.md', 'price.test.ts', 'price.ts', 'weekend.ts', 'limits.ts']);
        expect(commitRows().map(row => row.textContent)).toEqual([
            expect.stringContaining('Charge a weekend surcharge'),
            expect.stringContaining('Price a booking by the day'),
        ]);
        expect(container.querySelector('[aria-label="Changes sidebar"]')?.textContent).toContain('clowdy/ab12cd34');
        expect(container.querySelector('[aria-label="Changes sidebar"]')?.textContent).toContain('→ origin/main · 2 ahead, 1 behind');
        expect(container.querySelector('[aria-label="Pull request"]')?.textContent).toContain('PR #128');
    });

    it('opens every card, and reads a file\'s texts only once its card is near the scroller\'s edge', async () => {
        await start();

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();

        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
        expect(read).not.toHaveBeenCalled();

        await bringNear(element => element === card('src/booking/price.ts'));
        await settle();

        expect(read).toHaveBeenCalledTimes(1);
        // With the list's own start, which saves the daemon the lookup of the base.
        expect(read).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' }, 'all', 'src/booking/price.ts', undefined, '3'.repeat(40));
        expect(card('src/booking/price.ts').querySelector('[data-diff]')?.textContent).toContain('=>');
        expect(card('notes.md').querySelector('[data-diff]')).toBeNull();
    });

    it('draws a file\'s diff with the two texts the daemon read, and a box of the lines its list counted before they come', async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        const diff = card('src/limits.ts').querySelector<HTMLElement>('[data-diff]')!;

        expect(diff.textContent).toBe('export const MAX_DAYS = 30;\n=>export const MAX_DAYS = 28;\n');
        // `src/limits.ts` changes one line and removes one: the guess is those two, the context, and never fewer than a dozen.
        expect(diff.dataset.lines).toBe('12');
        expect(card('src/booking/weekend.ts').querySelector('[data-diff]')?.textContent?.startsWith('(none)=>')).toBe(true);
    });

    it('says a binary file is binary, and a file too large to show is, without reading either', async () => {
        await start({
            tweak: () => undefined,
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    const answer = await base.getGitChanges(project, place, scope);

                    if (!answer.isRepository || scope !== 'all') return answer;

                    return { ...answer, files: answer.files.map(file => (file.path === 'src/limits.ts' ? { ...file, tooLarge: true as const, additions: 30_000, deletions: 5 } : file)) };
                },
            }),
        });

        const read = vi.spyOn(transport, 'getGitFile');

        await draw();
        await bringNear();
        await settle();

        expect(card('assets/logo.png').textContent).toContain('Binary file');
        expect(card('src/limits.ts').textContent).toContain('Too large to show');
        expect(read.mock.calls.map(call => call[3]).sort()).toEqual(['notes.md', 'src/booking/price.test.ts', 'src/booking/price.ts', 'src/booking/weekend.ts']);
    });

    it('says a file whose text could not be read could not be, and reads it again on a press', async () => {
        let failures = 1;

        await start({
            wrap: base => overrideTransport(base, {
                getGitFile: async (project, place, scope, path, oldPath, from) => {
                    if (path === 'notes.md' && failures-- > 0) throw new TransportError('The daemon answered 503', 503);

                    return base.getGitFile(project, place, scope, path, oldPath, from);
                },
            }),
        });
        await draw();
        await bringNear();
        await settle();

        expect(card('notes.md').textContent).toContain('Couldn\'t read this file');

        const retry = [...card('notes.md').querySelectorAll('button')].find(element => element.textContent === 'Try again')!;

        await press(retry);
        await settle();

        expect(card('notes.md').textContent).not.toContain('Couldn\'t read this file');
        expect(card('notes.md').querySelector('[data-diff]')?.textContent).toContain('# Notes');
    });

    it('says a file the daemon takes for binary or too large after its list did not is, with the daemon\'s word', async () => {
        await start({
            wrap: base => overrideTransport(base, {
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

    it('shows what a file is: added, modified or deleted, with its lines in the colours of the tool cards, and the old path of a rename', async () => {
        await start({
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    const answer = await base.getGitChanges(project, place, scope);

                    if (!answer.isRepository || scope !== 'all') return answer;

                    return {
                        ...answer,
                        files: [
                            ...answer.files,
                            { path: 'src/gone.ts', kind: 'deleted', additions: 0, deletions: 9, revision: `100644:${ '6'.repeat(40) }:000000:${ '0'.repeat(40) }` },
                            { path: 'src/renamed.ts', oldPath: 'src/old-name.ts', kind: 'renamed', additions: 1, deletions: 1, revision: `100644:${ '7'.repeat(40) }:100644:${ '8'.repeat(40) }` },
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

        const counts = card('src/booking/price.ts').querySelectorAll('[class*="counts"] span');

        expect(counts[0]?.className).toMatch(/success/);
        expect(counts[1]?.className).toMatch(/danger/);
    });

    it('copies the path of a file from its card', async () => {
        const write = vi.fn().mockResolvedValue(undefined);

        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: write } });
        await start();
        await draw();
        await press(button('Copy the path of src/booking/price.ts'));

        expect(write).toHaveBeenCalledExactlyOnceWith('src/booking/price.ts');
    });

    it('folds a card on a press on its header, and opens it again, and has a button to fold every card and one to open them all', async () => {
        await start();
        await draw();
        await bringNear();
        await settle();

        await press(button('Fold src/booking/price.ts'));
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(false);
        expect(card('src/booking/price.ts').querySelector('[data-diff]')).toBeNull();

        await press(button('Unfold src/booking/price.ts'));
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(true);

        await press(button('Collapse all files'));
        expect(cards().some(element => element.hasAttribute('data-open'))).toBe(false);
        expect(button('Collapse all files').disabled).toBe(true);

        await press(button('Expand all files'));
        expect(cards().every(element => element.hasAttribute('data-open'))).toBe(true);
        expect(button('Expand all files').disabled).toBe(true);
    });
});

describe('the scope', () => {
    it('has the entries of the scope menu: all changes, the branch, what is not committed and each commit of the branch, newest first', async () => {
        await start();
        await draw();
        await press(scopeTrigger());
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));

        expect(options().map(option => option.textContent)).toEqual(['All changes', 'Branch', 'Uncommitted', 'b744444 Charge a weekend surcharge', 'a155555 Price a booking by the day']);
    });

    it('changes the list with the scope chosen from the menu', async () => {
        await start();
        await draw();
        await press(scopeTrigger());
        await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
        await press(options().find(option => option.textContent === 'Uncommitted')!);
        await settle();

        expect(scopeTrigger().textContent).toContain('Uncommitted');
        expect(cardPaths()).toEqual(['notes.md', 'src/booking/price.ts', 'src/limits.ts']);
        expect(sidebarPaths()).toEqual(['notes.md', 'price.ts', 'limits.ts']);
        expect(summary()).toBe('3 files,+10−3');
    });

    it('shows one commit alone when it is pressed in the sidebar, goes back to all changes on a second press on it, and on the row that says so', async () => {
        await start();
        await draw();

        const second = FIXTURE_GIT_COMMITS[1]!;

        await press(commitRows()[1]!);
        await settle();

        expect(scopeTrigger().textContent).toContain(`${ second.shortSha } ${ second.subject }`);
        expect(cardPaths()).toEqual(['assets/logo.png', 'src/booking/price.test.ts', 'src/booking/price.ts']);
        expect(commitRows()[0]!.textContent).toContain('Back to all changes');
        expect(commitRows()[2]!.getAttribute('aria-pressed')).toBe('true');

        // A second press on the same commit clears it.
        await press(commitRows()[2]!);
        await settle();
        expect(scopeTrigger().textContent).toContain('All changes');
        expect(cards()).toHaveLength(6);
        expect(commitRows().map(row => row.textContent).join('')).not.toContain('Back to all changes');

        // And so does the row that goes back.
        await press(commitRows()[0]!);
        await settle();
        expect(cards()).toHaveLength(2);
        expect(cardPaths()).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts']);
        expect(commitRows()[0]!.textContent).toContain('Back to all changes');

        await press(commitRows()[0]!);
        await settle();
        expect(cards()).toHaveLength(6);
    });

    it('reads again only when the facts start a round of reads: a refresh of the store and the window\'s focus reach it, and nothing else does', async () => {
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

    it('reads a refreshed list\'s files again only where their revision changed', async () => {
        let edited = false;

        await start({
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    const answer = await base.getGitChanges(project, place, scope);

                    if (!edited || !answer.isRepository || scope !== 'all') return answer;

                    return { ...answer, files: answer.files.map(file => (file.path === 'src/limits.ts' ? { ...file, revision: `100644:${ 'd'.repeat(40) }:100644:${ '9'.repeat(40) }` } : file)) };
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
            gitFactsOf(transport).refresh({ projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' });
        });
        await settle();
        await bringNear();
        await settle();

        expect(read.mock.calls.map(call => call[3])).toEqual(['src/limits.ts']);
    });
});

describe('the filter', () => {
    it('narrows the cards and the sidebar\'s files by what is typed, and says how many of the files are shown', async () => {
        await start();
        await draw();

        expect(filter().placeholder).toBe('Filter files, e.g. *.md, docs/**, !*.test.ts');

        await type('src/**, !*.test.ts');

        expect(cardPaths()).toEqual(['src/booking/price.ts', 'src/booking/weekend.ts', 'src/limits.ts']);
        expect(sidebarPaths()).toEqual(['price.ts', 'weekend.ts', 'limits.ts']);
        expect(summary()).toBe('3 of 6 files,+72−8');

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
        expect(container.textContent).toContain('No files match the filter');
        expect(container.querySelector('[aria-label="Changed files"]')?.textContent).toContain('No files match the filter');

        await press([...container.querySelectorAll('button')].find(element => element.textContent === 'Clear the filter')!);

        expect(cards()).toHaveLength(6);
    });
});

describe('the sidebar', () => {
    it('brings the card of a file to the top and opens it when its row is pressed', async () => {
        await start();
        await draw();
        await press(button('Fold src/booking/price.ts'));

        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(false);

        await press(sidebarFiles()[3]!);

        expect(scrolled).toEqual([card('src/booking/price.ts')]);
        expect(card('src/booking/price.ts').hasAttribute('data-open')).toBe(true);
    });

    it('has the base, how far the branch is from it and the pull request with its checks, and opens the repository on GitHub', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null);

        await start();
        await draw();

        const sidebar = container.querySelector('[aria-label="Changes sidebar"]')!;

        expect(sidebar.querySelector('[aria-label^="Checks"]')).not.toBeNull();

        await press(sidebar.querySelector('button[aria-label="Open the repository on GitHub"]')!);

        expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental', '_blank', 'noopener');
    });

    it('is hidden by a press on its button, which is then in the toolbar of the diffs, and comes back on a second press', async () => {
        await start();
        await draw();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).not.toBeNull();

        await press(container.querySelector('[data-sidebar-toggle]')!);
        await settle();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).toBeNull();
        expect(container.querySelectorAll('[data-sidebar-toggle]')).toHaveLength(1);
        expect(changesSidebarLayout.open).toBe(false);
        expect(JSON.parse(localStorage.getItem('clowdy:changes-sidebar-open') ?? 'null')).toBe(false);

        await press(container.querySelector('[data-sidebar-toggle]')!);
        await settle();

        expect(container.querySelector('[aria-label="Changes sidebar"]')).not.toBeNull();
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
        expect(container.querySelector('[aria-label="Changed files"]')?.textContent).toContain('No changed files');
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
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    if (fails && scope === 'all') throw new TransportError('The daemon answered 503', 503);

                    return base.getGitChanges(project, place, scope);
                },
            }),
        });
        await draw();

        expect(container.textContent).toContain('Couldn\'t read the changes');
        expect(cards()).toHaveLength(0);

        fails = false;
        await press([...container.querySelectorAll('button')].find(element => element.textContent === 'Try again')!);
        await settle();

        expect(cards()).toHaveLength(6);
    });

    it('keeps the cards when a later read fails, and says nothing loud', async () => {
        let fails = false;

        await start({
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    if (fails && scope === 'all') throw new TransportError('The daemon answered 503', 503);

                    return base.getGitChanges(project, place, scope);
                },
            }),
        });
        await draw();

        fails = true;
        await act(async () => {
            gitFactsOf(transport).refresh({ projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' });
        });
        await settle();

        expect(cards()).toHaveLength(6);
        expect(container.textContent).not.toContain('Couldn\'t read');
    });

    it('says a branch with no base has nothing to compare with, and that all changes are then what is not committed', async () => {
        await start({
            chat: null,
            wrap: base => overrideTransport(base, {
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
        expect(container.querySelector('[aria-label="Committed on branch"]')).toBeNull();
    });

    it('says a worktree that is not made yet is not, and reads nothing of it', async () => {
        await start({
            tweak: (data) => {
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
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    const answer = await base.getGitChanges(project, place, scope);

                    return answer.isRepository && scope === 'all' ? { ...answer, fileCount: 731, truncated: true as const } : answer;
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
            wrap: base => overrideTransport(base, {
                getGitChanges: async (project, place, scope) => {
                    const answer = await base.getGitChanges(project, place, scope);

                    if (!answer.isRepository || scope !== 'all') return answer;

                    return { ...answer, files: Array.from({ length: 10 }, (_, index) => ({ path: `src/f${ index }.ts`, kind: 'modified' as const, additions: 1, deletions: 1, revision: `100644:${ 'a'.repeat(40) }:100644:${ String(index).repeat(40) }` })) };
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
});
