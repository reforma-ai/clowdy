// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { toast } from '@clowdy/components/Toast';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PROJECT_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport, type FixtureTransportOptions } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openEffects } from '../openWith';
import { ChangesSidebar } from './ChangesSidebar';
import { type GitPlaceKey, gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitRemoteResult } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the sidebar are, to follow the models they read.
vi.mock('./RemoteMenu', async importOriginal => ({
    RemoteMenu: observer((await importOriginal<typeof import('./RemoteMenu')>()).RemoteMenu),
}));
vi.mock('./CreatePullRequest', async importOriginal => ({
    CreatePullRequest: observer((await importOriginal<typeof import('./CreatePullRequest')>()).CreatePullRequest),
}));
vi.mock('./CommitBox', async importOriginal => ({
    CommitBox: observer((await importOriginal<typeof import('./CommitBox')>()).CommitBox),
}));
vi.mock('./PullRequestChip', async importOriginal => ({
    PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip),
}));

const CAR_RENTAL = '/Users/dev/car-rental';
const WORKTREE: GitPlaceKey = {
    projectId: FIXTURE_PROJECT_ID,
    folderId: 'fld_car_rental',
    workspaceId: 'wks_ab12cd34',
};
const CHECKOUT: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' };

const Sidebar = observer(ChangesSidebar);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: FixtureTransport;
let model: PlaceChanges;
let stop: () => void;
let opened: string[];

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

const sidebar = () => container.querySelector('[aria-label="Changes sidebar"]')!;
const buttonOf = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label
    );
/** The sync button: the one that names the next action. */
const createPRButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="Create PR"]') ?? undefined;
const syncButton = () => container.querySelector<HTMLButtonElement>('button[data-sync]')!;
const syncCopy = () => syncButton().querySelector('[data-sync-copy]')?.textContent;
/** The dropdown beside it, which keeps every action. */
const dropdown = () => container.querySelector<HTMLButtonElement>('button[aria-label="More source control actions"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const item = (label: string) => items().find(candidate => candidate.textContent?.startsWith(label))!;
const isOff = (label: string) => item(label).getAttribute('aria-disabled') === 'true';
const alert = () => container.querySelector('[role="alert"]');
const status = () => container.querySelector('[role="status"]:not([aria-label])');
const updateLabel = 'Update from main';
const mergeLabels = ['Merge from branch…', 'Merge into branch…'];

async function openMenu() {
    await press(dropdown());
    await settle();
}

/** The sidebar of the chat in a worktree (or of the checkout, with `key`) on the fixtures, `tweak` having its say about them first. */
async function start({
    tweak,
    gitWrites,
    branches,
    key = WORKTREE,
}: {
    tweak?: (data: FixtureData) => void;
    gitWrites?: FixtureGitWritesOptions;
    branches?: FixtureTransportOptions['branches'];
    key?: GitPlaceKey;
} = {}) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);
    transport = new FixtureTransport({ data, gitWrites, branches });
    store = new RootStore(transport);
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);

    const facts = gitFactsOf(transport);
    const project = store.selectedProject!;
    const folder = project.project.folders.find(candidate => candidate.id === key.folderId)!;
    const place: Place = key.workspaceId ? { folder, workspace: project.chats.get('c-9')!.workspace! } : { folder };

    stop = facts.observe(key);
    model = placeChangesOf(transport, facts.of(key));
    await settle();
    await draw(place);
}

let currentPlace: Place;

async function draw(place = currentPlace) {
    currentPlace = place;
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Sidebar model={model} place={place} projectId={FIXTURE_PROJECT_ID} toggle={null} />
            </RootStoreProvider>
        )
    );
    await settle();
    await settle();
}

/** The worktree's branch has no pull request. */
const noPullRequest = (data: FixtureData) => {
    data.pullRequests[CAR_RENTAL] = { checkout: 'none', worktree: 'none' };
};

beforeEach(() => {
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
    opened = [];
    vi.spyOn(openEffects, 'openUrl').mockImplementation(url => {
        opened.push(url);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(async () => {
    for (const modal of [...Modal.opened].reverse()) await act(async () => modal.close(false));

    act(() => root.unmount());
    container.remove();
    stop?.();
    store.dispose();
    sourceControlPreferences.setAutoPush(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the sync button in the sidebar', () => {
    it('says Publish branch for a branch that is not on origin, with the dropdown listing Fetch origin, Pull origin disabled, and Publish branch', async () => {
        await start();

        expect(syncButton().getAttribute('data-sync')).toBe('publish');
        expect(syncButton().textContent).toBe('Publish branchPublish this branch to origin');
        expect(syncButton().disabled).toBe(false);
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Publish branch',
            updateLabel,
            ...mergeLabels,
        ]);
        expect(isOff('Fetch origin')).toBe(false);
        expect(isOff('Pull origin')).toBe(true);
        expect(isOff('Publish branch')).toBe(false);
    });

    it('publishes without a notice and then offers to update from the base', async () => {
        await start();

        const push = vi.spyOn(transport, 'pushGit');

        await press(syncButton());
        await settle();
        await settle();

        expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, {
            folderId: 'fld_car_rental',
            workspaceId: 'wks_ab12cd34',
        });
        expect(status()).toBeNull();
        expect(syncButton().getAttribute('data-sync')).toBe('update');
        expect(syncButton().textContent).toContain('Update from main');
        expect(syncButton().querySelector('[data-commit-count="down"]')?.textContent).toBe('1');

        await openMenu();
        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Push origin',
            updateLabel,
            ...mergeLabels,
        ]);
    });

    it('is Fetch origin for a branch that is level, a press updates its timestamp without a separate notice, and Never fetched appears where the repository has not', async () => {
        await start({ key: CHECKOUT });

        expect(syncButton().textContent).toBe('Fetch originLast fetched 3 minutes ago');
        expect(syncButton().disabled).toBe(false);

        const fetch = vi.spyOn(transport, 'fetchGit');

        await press(syncButton());
        await settle();
        await settle();

        expect(fetch).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' });
        expect(status()).toBeNull();
        expect(syncCopy()).toBe('Fetch originLast fetched just now');

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({ key: CHECKOUT, gitWrites: { remote: 'never' } });
        expect(syncButton().textContent).toBe('Fetch originNever fetched');
    });

    it('moves its line on by itself while the window stays open: the clock ticks every 30 s and no new read is made', async () => {
        // Only the clock and its interval are faked, so the fixtures and the settling that the page waits on keep their own timers.
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });

        try {
            await start({ key: CHECKOUT });

            const reads = vi.spyOn(transport, 'getGitStatus');

            expect(syncButton().textContent).toBe('Fetch originLast fetched 3 minutes ago');

            act(() => {
                vi.advanceTimersByTime(29_000);
            });
            expect(syncButton().textContent).toBe('Fetch originLast fetched 3 minutes ago');

            act(() => {
                vi.advanceTimersByTime(2 * 60_000);
            });
            expect(syncButton().textContent).toBe('Fetch originLast fetched 5 minutes ago');
            expect(reads).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('is Publish branch, with what it tracks, for a branch made from another one, and a press publishes it under its own name: it is level with that upstream afterwards, and nothing was pulled or sent to main', async () => {
        await start({ gitWrites: { remote: 'renamed' } });

        expect(syncButton().getAttribute('data-sync')).toBe('publish');
        expect(syncButton().textContent).toBe('Publish branchTracks origin/main');
        expect(syncButton().disabled).toBe(false);

        const push = vi.spyOn(transport, 'pushGit');
        const pull = vi.spyOn(transport, 'pullGit');

        await press(syncButton());
        await settle();
        await settle();

        expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, {
            folderId: 'fld_car_rental',
            workspaceId: 'wks_ab12cd34',
        });
        expect(pull).not.toHaveBeenCalled();
        expect(status()).toBeNull();
        expect(syncButton().getAttribute('data-sync')).toBe('update');
        expect(
            await transport.getGitStatus(FIXTURE_PROJECT_ID, {
                folderId: 'fld_car_rental',
                workspaceId: 'wks_ab12cd34',
            })
        ).toMatchObject({ upstream: { name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 } });
    });

    it('lists Pull origin off with what the branch tracks, and Publish branch as the one that works, for a branch made from another one', async () => {
        await start({ gitWrites: { remote: 'renamed' } });
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Publish branch',
            updateLabel,
            ...mergeLabels,
        ]);
        expect(isOff('Pull origin')).toBe(true);
        expect(isOff('Publish branch')).toBe(false);
    });

    it('keeps an update from the base available beside an upstream pull, with the base count', async () => {
        await start({ gitWrites: { clean: true, remote: 'behind' } });
        const update = vi.spyOn(transport, 'updateGit');
        const pull = vi.spyOn(transport, 'pullGit');
        const updateButton = sidebar().querySelector<HTMLButtonElement>('button[aria-label="Update from main"]')!;

        expect(syncButton().getAttribute('data-sync')).toBe('pull');
        expect(updateButton.querySelector('[data-commit-count="down"]')?.textContent).toBe('1');
        await press(updateButton);
        await settle();

        expect(update).toHaveBeenCalledTimes(1);
        expect(pull).not.toHaveBeenCalled();
        expect(status()).toBeNull();
    });

    it('is Pull origin with the count for a branch that is behind, and a press pulls and reads the place again, so the counts and the pull request are the ones it left', async () => {
        await start({ gitWrites: { remote: 'behind' } });

        const reads = {
            status: vi.spyOn(transport, 'getGitStatus'),
            pullRequest: vi.spyOn(transport, 'getGitPullRequest'),
        };
        const pull = vi.spyOn(transport, 'pullGit');

        expect(syncButton().getAttribute('data-sync')).toBe('pull');
        expect(syncButton().textContent).toBe('Pull originLast fetched 3 minutes ago2');
        expect(syncButton().querySelector('svg')).not.toBeNull();
        await openMenu();
        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin2 commits',
            'Push origin',
            updateLabel,
            ...mergeLabels,
        ]);
        await press(item('Pull origin'));
        await settle();
        await settle();

        expect(pull).toHaveBeenCalledTimes(1);
        expect(reads.status).toHaveBeenCalled();
        expect(reads.pullRequest).toHaveBeenCalled();
        expect(status()).toBeNull();
        expect(syncButton().getAttribute('data-sync')).toBe('update');
    });

    it('is Push origin with the count for a branch that is ahead, and a press pushes it', async () => {
        await start({ gitWrites: { remote: 'ahead' } });

        const push = vi.spyOn(transport, 'pushGit');

        expect(syncButton().getAttribute('data-sync')).toBe('push');
        expect(syncButton().textContent).toBe('Push originLast fetched 3 minutes ago2');
        await press(syncButton());
        await settle();
        await settle();

        expect(push).toHaveBeenCalledTimes(1);
        expect(status()).toBeNull();
        expect(syncButton().getAttribute('data-sync')).toBe('update');
    });

    it('is Pull origin for a branch that diverged, which merges, and holds Push until the pull', async () => {
        await start({ gitWrites: { remote: 'diverged' } });

        const pull = vi.spyOn(transport, 'pullGit');
        const push = vi.spyOn(transport, 'pushGit');

        expect(syncButton().getAttribute('data-sync')).toBe('pull');
        expect(syncButton().textContent).toBe('Pull originLast fetched 3 minutes ago12');
        expect(syncButton().disabled).toBe(false);
        expect(syncButton().textContent).not.toMatch(/Force push/);

        await openMenu();
        expect(isOff('Fetch origin')).toBe(false);
        expect(isOff('Pull origin')).toBe(false);
        expect(isOff('Push origin')).toBe(true);
        expect(item('Push origin').textContent).toBe('Push origin1 commit');
        expect(item('Pull origin').textContent).toBe('Pull origin2 commits');
        await press(item('Pull origin'));
        await settle();
        expect(pull).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();
    });

    it('says a pull that stopped on conflicts as a warning', async () => {
        await start({ gitWrites: { remote: 'behind' } });
        vi.spyOn(transport, 'pullGit').mockResolvedValue({
            state: 'conflicts',
            action: 'pull',
            conflicts: 2,
        } satisfies GitRemoteResult);

        await press(syncButton());
        await settle();

        expect(status()?.textContent).toBe('2 conflicts');
        expect(alert()).toBeNull();
    });

    it.each([
        ['detached', 'blocked', 'HEAD is detached'],
        ['unborn', 'blocked', 'No commits yet'],
        ['no_origin', 'no_origin', 'Nothing to sync with'],
    ] as const)(
        'is off with its reason where the branch cannot be synced (%s), and its stop carries the tooltip',
        async (script, kind, line) => {
            await start({ gitWrites: { remote: script } });

            expect(syncButton().getAttribute('data-sync')).toBe(kind);
            expect(syncButton().disabled).toBe(true);
            expect(syncButton().textContent).toContain(line);
            // The stop that carries the tooltip of a button that cannot be pressed.
            const stand = syncButton().closest('[role="button"][aria-disabled="true"]');

            expect(stand).not.toBeNull();
            expect(stand?.getAttribute('tabindex')).toBe('0');
            expect(stand?.getAttribute('aria-label')).toBe(
                syncButton().textContent?.startsWith('No origin') ? 'No origin' : 'Publish branch'
            );
            // Fetch origin is in the dropdown, except where there is no origin to fetch from.
            await openMenu();
            expect(isOff('Fetch origin')).toBe(script === 'no_origin');
        }
    );

    it("shows git's own line when an action fails, selectable, with the hint under it, and goes when the person acts again", async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await press(syncButton());
        await settle();
        await settle();

        expect(alert()?.textContent).toContain('error: No private key found for public key');
        expect(alert()?.textContent).toContain("The signing agent couldn't be reached");
        // Not a push turned down for newer commits: no Fetch origin beside it.
        expect(alert()?.querySelector('button')).toBeNull();

        await openMenu();
        await press(item('Fetch origin'));
        await settle();
        await settle();
        expect(alert()).toBeNull();
        expect(status()).toBeNull();
    });

    it('shows a push that origin rejected by its line with a Fetch origin button beside it, which fetches and takes the line away', async () => {
        await start({ gitWrites: { remote: 'rejected' } });
        await press(syncButton());
        await settle();
        await settle();

        expect(alert()?.textContent).toBe('! [rejected] clowdy/ab12cd34 -> clowdy/ab12cd34 (fetch first)Fetch origin');
        expect(syncButton().getAttribute('data-sync')).toBe('push');

        const fetch = vi.spyOn(transport, 'fetchGit');

        await press(alert()!.querySelector('button')!);
        await settle();
        await settle();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(alert()).toBeNull();
        expect(status()).toBeNull();
    });

    it('shows sync progress while the menu keeps other actions available', async () => {
        await start({ key: CHECKOUT });

        let release: () => void = () => undefined;

        vi.spyOn(transport, 'fetchGit').mockImplementation(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ state: 'done', action: 'fetch' });
                })
        );
        const button = syncButton();
        await press(button);

        expect(syncButton()).toBe(button);
        expect(syncButton().getAttribute('data-sync')).toBe('running');
        expect(syncCopy()).toBe('Fetching origin');
        expect(syncButton().hasAttribute('data-pending')).toBe(true);
        await openMenu();
        expect(isOff('Fetch origin')).toBe(true);
        expect(isOff('Merge from branch…')).toBe(false);
        expect(isOff('Merge into branch…')).toBe(false);

        release();
        await settle();
        await settle();
        expect(syncButton()).toBe(button);
        expect(syncButton().getAttribute('data-sync')).toBe('fetch');
        expect(status()).toBeNull();
    });

    it('names each action by what it is doing: Pulling origin, Pushing origin, Publishing branch', async () => {
        await start();

        let release: () => void = () => undefined;

        vi.spyOn(transport, 'pushGit').mockImplementation(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ state: 'done', action: 'push', published: true });
                })
        );
        await press(syncButton());
        expect(syncCopy()).toBe('Publishing branch');
        release();
        await settle();
        await settle();
    });

    it('disables actions that need origin and keeps branch merges available', async () => {
        await start({ gitWrites: { remote: 'no_origin' } });
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            'Push origin',
            updateLabel,
            ...mergeLabels,
        ]);
        expect(items().map(candidate => candidate.getAttribute('aria-disabled') === 'true')).toEqual([
            true,
            true,
            true,
            true,
            false,
            false,
        ]);
    });

    it('updates from the main button, keeps Fetch in the menu, and offers Push when the merge adds a commit', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const readStatus = transport.getGitStatus.bind(transport);
        let updated = false;
        vi.spyOn(transport, 'getGitStatus').mockImplementation(async (projectId, place) => {
            const current = await readStatus(projectId, place);

            if (updated && current.isRepository && current.base.state === 'ready' && current.upstream) {
                current.base.behind = 0;
                current.upstream.ahead = 1;
            }

            return current;
        });
        let finish: (result: GitRemoteResult) => void = () => undefined;
        const update = vi.spyOn(transport, 'updateGit').mockImplementation(
            () =>
                new Promise(resolve => {
                    finish = resolve;
                })
        );

        expect(syncButton().textContent).toContain(updateLabel);
        await openMenu();
        expect(isOff('Fetch origin')).toBe(false);
        expect(isOff(updateLabel)).toBe(false);
        await press(item('Fetch origin'));
        await settle();
        await press(syncButton());
        await settle();

        expect(update).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, {
            folderId: WORKTREE.folderId,
            workspaceId: WORKTREE.workspaceId,
        });
        expect(syncCopy()).toBe('Updating');
        await openMenu();
        expect(isOff(updateLabel)).toBe(true);

        updated = true;
        finish({ state: 'done', action: 'update', pulled: 1 });
        await settle();
        await settle();
        expect(status()).toBeNull();
        expect(syncButton().getAttribute('data-sync')).toBe('push');
    });
});

describe('merging branches from the sync menu', () => {
    const dialog = () => document.querySelector<HTMLElement>('[data-modal-window] [role="dialog"]')!;
    const heading = () => dialog().querySelector('h2')?.textContent;
    const options = () => [...dialog().querySelectorAll<HTMLElement>('[role="option"]')];
    const option = (name: string) => options().find(candidate => candidate.textContent?.trim() === name)!;
    const button = (name: string) =>
        [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === name)!;
    const open = async (label: string) => {
        await openMenu();
        await press(item(label));
        await settle();
    };
    const conflict = async () => {
        await open('Merge from branch…');
        await press(option('origin/feature/search'));
        await settle();
        await press(button('Create merge commit & Push'));
        await settle();
    };
    const confirmButton = (name: string) =>
        vi.waitFor(async () => {
            await settle();
            const confirmation = [...document.querySelectorAll('[data-modal-window]')].find(panel =>
                panel.textContent?.includes('Abort merge?')
            );
            const button = [...(confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
                element => element.textContent === name
            );

            expect(button, `Abort confirmation button: ${name}`).toBeDefined();
            return button!;
        });

    it('lets the user preview a local branch while a fetch is pending and then adds remote branches', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const reply = Promise.withResolvers<GitRemoteResult>();
        const fetch = vi.spyOn(transport, 'fetchGit').mockReturnValueOnce(reply.promise);
        await openMenu();
        await press(item('Fetch origin'));
        await settle();
        expect(syncCopy()).toBe('Fetching origin');

        await open('Merge from branch…');
        expect(heading()).toBe('Merge … to clowdy/ab12cd34');
        expect(option('origin/feature/search')).toBeUndefined();
        await press(option('main'));
        await settle();
        expect(heading()).toBe('Merge main to clowdy/ab12cd34');
        expect(button('Fast-forward & Push').disabled).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);

        reply.resolve({ state: 'done', action: 'fetch' });
        await settle();
        expect(option('origin/feature/search')).toBeDefined();
        expect(heading()).toBe('Merge main to clowdy/ab12cd34');
    });

    it('lets the user open the destination picker during a push', async () => {
        await start({ gitWrites: { clean: true, remote: 'ahead' } });
        const reply = Promise.withResolvers<GitRemoteResult>();
        vi.spyOn(transport, 'pushGit').mockReturnValueOnce(reply.promise);

        await press(syncButton());
        expect(syncCopy()).toBe('Pushing origin');
        await openMenu();
        expect(isOff('Fetch origin')).toBe(false);
        await press(item('Merge into branch…'));
        await settle();
        await press(option('main'));
        await settle();

        expect(heading()).toBe('Merge clowdy/ab12cd34 to main');
        expect(button('Fast-forward & Push').disabled).toBe(false);
        reply.resolve({ state: 'done', action: 'push' });
        await settle();
    });

    it('keeps local branches when the branch list cannot be refreshed after a pending fetch', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const reply = Promise.withResolvers<GitRemoteResult>();
        vi.spyOn(transport, 'fetchGit').mockReturnValueOnce(reply.promise);
        const branches = vi.spyOn(transport, 'getGitBranches');

        await openMenu();
        await press(item('Fetch origin'));
        await open('Merge from branch…');
        expect(option('main')).toBeDefined();

        branches.mockRejectedValueOnce(new TransportError("Couldn't read branches", 503));
        reply.resolve({ state: 'done', action: 'fetch' });
        await settle();

        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn't read branches");
        expect(option('main')).toBeDefined();
        expect(option('origin/feature/search')).toBeUndefined();
    });

    it('fetches origin before listing source branches and previews the selected ref before merging', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const success = vi.spyOn(toast, 'success').mockReturnValue('');
        const fetch = vi.spyOn(transport, 'fetchGit');
        const branches = vi.spyOn(transport, 'getGitBranches');
        const merge = vi.spyOn(transport, 'branchMergeGit');

        await open('Merge from branch…');

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(branches).toHaveBeenCalledTimes(1);
        expect(fetch.mock.invocationCallOrder[0]!).toBeLessThan(branches.mock.invocationCallOrder[0]!);
        expect(merge).not.toHaveBeenCalled();
        expect(button('Merge').disabled).toBe(true);
        expect(heading()).toBe('Merge … to clowdy/ab12cd34');
        expect(option('origin/main')).toBeUndefined();
        expect(option('origin/dev')).toBeUndefined();

        await press(option('main'));
        await settle();

        expect(heading()).toBe('Merge main to clowdy/ab12cd34');
        expect(dialog().textContent).toContain('Fast-forward');
        expect(merge).toHaveBeenCalledTimes(1);
        expect(merge.mock.calls[0]?.[2]).toEqual({
            action: 'preview',
            direction: 'from',
            current: 'clowdy/ab12cd34',
            branch: 'main',
        });

        await press(button('Fast-forward & Push'));
        await settle();

        expect(merge.mock.calls[1]?.[2]).toMatchObject({
            action: 'merge',
            direction: 'from',
            current: 'clowdy/ab12cd34',
            branch: 'main',
            sourceCommit: expect.stringMatching(/^[0-9a-f]+$/),
            targetCommit: expect.stringMatching(/^[0-9a-f]+$/),
        });
        expect(dialog()).toBeNull();
        expect(merge.mock.calls[2]?.[2]).toMatchObject({ action: 'push', target: 'clowdy/ab12cd34' });
        expect(success).toHaveBeenCalledWith({ message: 'Pushed clowdy/ab12cd34 to origin' });
    });

    it('filters the destination branches with text entered while they were loading', async () => {
        await start();
        const place = { folderId: WORKTREE.folderId, workspaceId: WORKTREE.workspaceId };
        const listing = await transport.getGitBranches(FIXTURE_PROJECT_ID, place);
        let finish = () => {};
        vi.spyOn(transport, 'getGitBranches').mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    finish = () => resolve(listing);
                })
        );

        await open('Merge into branch…');
        const filter = () => dialog().querySelector<HTMLInputElement>('input[placeholder="Filter branches"]')!;
        const spinner = () => dialog().querySelector('[role="status"][aria-label="Loading branches"]');
        const input = filter();

        expect(spinner()).not.toBeNull();
        expect(button('Merge').disabled).toBe(true);
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'main');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            finish();
        });
        await settle();

        expect(spinner()).toBeNull();
        expect(filter()).toBe(input);
        expect(input.value).toBe('main');
        expect(options().map(row => row.textContent?.trim())).toEqual(['main']);
    });

    it('selects a merge mode without executing it and refreshes its preview for the selected branch', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const chooseMode = async (mode: string) => {
            const trigger = dialog().querySelector('button[aria-label="Choose merge mode"]')!;
            await press(trigger);
            await settle();
            const choice = [...document.querySelectorAll('[role="menuitemradio"]')].find(row =>
                row.textContent?.startsWith(mode)
            )!;
            await press(choice);
            await settle();
        };

        await open('Merge from branch…');
        await press(option('origin/feature/search'));
        await settle();
        expect(button('Create merge commit & Push').disabled).toBe(false);
        const originalPreview = await merge.mock.results[0]!.value;

        await chooseMode('Fast-forward only');
        expect(button('Fast-forward only').disabled).toBe(true);
        expect(dialog().textContent).toContain('the branches have diverged');

        merge.mockResolvedValueOnce(originalPreview);
        await chooseMode('Squash and merge');
        expect(button('Squash and merge').disabled).toBe(true);
        expect(dialog().textContent).toContain('Update Clowdy to use Squash and merge');

        await chooseMode('Rebase');
        expect(merge.mock.calls.every(call => call[2].action === 'preview')).toBe(true);
        expect(merge.mock.calls.at(-1)?.[2]).toMatchObject({ strategy: 'rebase', branch: 'feature/search' });
        expect(dialog().textContent).toContain('Replay 2 commits from clowdy/ab12cd34 on top of origin/feature/search');
        await press(button('Rebase & Push'));
        await settle();
        expect(merge.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'merge', strategy: 'rebase' });
        expect(button('Abort rebase')).toBeDefined();

        await press(button('Done'));
        await settle();
        expect(sidebar().querySelector('[aria-label="Commit"]')?.textContent).toContain('Rebase paused');
    });

    it('pushes only the merge destination by default without changing the source checkout', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const push = vi.spyOn(transport, 'pushGit');

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Fast-forward & Push'));
        await settle();

        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge', 'push']);
        const applied = await merge.mock.results[1]?.value;
        expect(applied).toMatchObject({ state: 'done', commit: expect.any(String) });
        expect(merge.mock.calls[2]?.[2]).toEqual({
            action: 'push',
            target: 'main',
            commit: applied?.state === 'done' ? applied.commit : undefined,
        });
        expect(push).not.toHaveBeenCalled();
        expect(dialog()).toBeNull();
        expect(
            await transport.getGitStatus(FIXTURE_PROJECT_ID, {
                folderId: WORKTREE.folderId,
                workspaceId: WORKTREE.workspaceId,
            })
        ).toMatchObject({ head: { name: 'clowdy/ab12cd34' }, upstream: { ahead: 0 } });
    });

    it('keeps a completed merge available to push again when automatic push is rejected', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const original = transport.branchMergeGit.bind(transport);
        const merge = vi.spyOn(transport, 'branchMergeGit').mockImplementation((project, place, request) => {
            if (request.action === 'push') {
                merge.mockImplementation(original);
                return Promise.reject(new TransportError('Network is offline', 503));
            }

            return original(project, place, request);
        });

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Fast-forward & Push'));
        await settle();

        expect(dialog().textContent).toContain('Merged into main');
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Push failed: Network is offline');
        await press(button('Push main'));
        await settle();

        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge', 'push', 'push']);
        expect(merge.mock.calls[2]?.[2]).toEqual(merge.mock.calls[3]?.[2]);
        expect(dialog()).toBeNull();
    });

    it('offers a separate push for outgoing merges when automatic push is off', async () => {
        sourceControlPreferences.setAutoPush(false);
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const success = vi.spyOn(toast, 'success').mockReturnValue('');
        const fetch = vi.spyOn(transport, 'fetchGit');
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const push = vi.spyOn(transport, 'pushGit');

        await open('Merge into branch…');
        expect(fetch).not.toHaveBeenCalled();
        expect(option('origin/main')).toBeUndefined();
        expect(option('origin/feature/search')).toBeUndefined();
        expect(heading()).toBe('Merge clowdy/ab12cd34 to …');

        await press(option('main'));
        await settle();
        expect(heading()).toBe('Merge clowdy/ab12cd34 to main');

        await press(button('Fast-forward'));
        await settle();
        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge']);
        expect(push).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();

        const current = await transport.getGitStatus(FIXTURE_PROJECT_ID, {
            folderId: WORKTREE.folderId,
            workspaceId: WORKTREE.workspaceId,
        });

        expect(current).toMatchObject({ head: { name: 'clowdy/ab12cd34' } });
        await press(button('Push main'));
        await settle();
        expect(merge.mock.calls[2]?.[2]).toMatchObject({ action: 'push', target: 'main' });
        expect(dialog()).toBeNull();
        expect(success).toHaveBeenCalledWith({ message: 'Pushed main to origin' });
    });

    it('closes an outgoing merge that has no push action and shows a toast', async () => {
        await start({ gitWrites: { clean: true, remote: 'no_origin' } });
        const success = vi.spyOn(toast, 'success').mockReturnValue('');
        const merge = vi.spyOn(transport, 'branchMergeGit');

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Fast-forward'));
        await settle();

        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge']);
        expect(dialog()).toBeNull();
        expect(success).toHaveBeenCalledWith({ message: 'Merged into main' });
    });

    it('explains why an outgoing merge is blocked before the person can start it', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['merge-conflict'] });
        const merge = vi.spyOn(transport, 'branchMergeGit');

        await open('Merge into branch…');
        await press(option('main'));
        await settle();

        let alert = dialog().querySelector('[role="alert"]');
        expect(alert?.textContent).toContain("Can't merge into main because the branches conflict");
        expect(alert?.textContent).toContain('In a chat on main, use Merge from branch to merge clowdy/ab12cd34');
        expect(dialog().textContent).toContain('3 commits');
        expect(dialog().textContent).not.toContain('Creates a merge commit');
        expect(button('Create merge commit').disabled).toBe(true);

        await press(option('dev'));
        await settle();

        alert = dialog().querySelector('[role="alert"]');
        expect(alert?.textContent).toBe('Check out dev before merging into it');
        expect(button('Create merge commit').disabled).toBe(true);
        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'preview']);
    });

    it('still lists local branches after an automatic fetch fails', async () => {
        await start();
        vi.spyOn(transport, 'fetchGit').mockRejectedValueOnce(new TransportError('Network is offline', 503));

        await open('Merge from branch…');

        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Network is offline');
        expect(option('main')).toBeDefined();
        expect(option('origin/main')).toBeUndefined();
    });

    it('rechecks a refused merge when the selected branch is chosen again', async () => {
        await start({ gitWrites: { clean: true } });
        const merge = vi.spyOn(transport, 'branchMergeGit');

        await open('Merge into branch…');
        await press(option('main'));
        await settle();

        merge.mockRejectedValueOnce(new TransportError('The branches moved since the preview', 409));
        await press(button('Fast-forward & Push'));
        await settle();

        const alert = dialog().querySelector('[role="alert"][data-color="danger"]');
        expect(alert?.textContent).toContain('The branches moved');
        expect(button('Merge').disabled).toBe(true);
        expect(
            [...dialog().querySelectorAll('button')].map(button => button.textContent?.trim()).filter(Boolean)
        ).toEqual(['Merge', 'Cancel']);
        await press(option('main'));
        await settle();

        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge', 'preview']);
        expect(dialog().querySelector('[role="alert"]')).toBeNull();
        expect(button('Fast-forward & Push').disabled).toBe(false);
    });

    it('identifies the destination checkout after a conflict and aborts only that merge', async () => {
        // The nested confirmation needs a visible parent window. Happy DOM has no layout.
        vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 640, 480));
        vi.stubGlobal('desktop', {
            openPath: vi.fn(),
            getOpenApps: async () => ({
                editors: [{ id: 'cursor', name: 'Cursor' }],
                terminals: [],
                fileManagers: [],
            }),
        });
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const info = vi.spyOn(toast, 'info').mockReturnValue('');

        await conflict();

        expect(heading()).toBe('Merge origin/feature/search to clowdy/ab12cd34');
        expect(merge.mock.calls[0]?.[2]).toMatchObject({ branch: 'feature/search', remote: true });
        expect(dialog().querySelector('[role="status"]')?.textContent).toContain('1 conflict in clowdy/ab12cd34');
        expect(dialog().querySelector('[role="status"]')?.textContent).toContain(currentPlace.workspace?.path);
        expect(button('Done')).toBeDefined();
        expect(button('Open clowdy/ab12cd34')).toBeUndefined();

        await press(button('Abort merge'));
        const cancel = await confirmButton('Cancel');
        expect(cancel.dataset.variant).toBe('filled');
        expect(merge).toHaveBeenCalledTimes(2);
        await press(cancel);
        await settle();
        expect(dialog().querySelector('[role="status"]')?.textContent).toContain('1 conflict in clowdy/ab12cd34');
        expect(merge).toHaveBeenCalledTimes(2);

        await press(button('Abort merge'));
        await press(await confirmButton('Abort merge'));
        await settle();

        expect(merge.mock.calls[2]?.[2]).toMatchObject({
            action: 'abort',
            target: 'clowdy/ab12cd34',
            commit: expect.stringMatching(/^[0-9a-f]+$/),
            sourceCommit: expect.stringMatching(/^[0-9a-f]+$/),
        });
        expect(dialog()).toBeNull();
        expect(info).toHaveBeenCalledWith({ message: 'Merge into clowdy/ab12cd34 aborted' });
    });

    it('asks before aborting from the sidebar and leaves conflicts alone on Cancel', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const abort = vi.spyOn(transport, 'abortGit').mockResolvedValue({ state: 'done', action: 'abort' });

        await conflict();
        await press(button('Done'));
        await settle();
        expect(dialog()).toBeNull();
        expect(abort).not.toHaveBeenCalled();
        await press(buttonOf('Abort merge')!);
        const cancel = await confirmButton('Cancel');
        expect(cancel.dataset.variant).toBe('filled');
        expect(abort).not.toHaveBeenCalled();
        await press(cancel);
        await settle();
        expect(abort).not.toHaveBeenCalled();
        expect(buttonOf('Abort merge')).toBeDefined();

        await press(buttonOf('Abort merge')!);
        await press(await confirmButton('Abort merge'));
        await settle();
        expect(abort).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, {
            folderId: WORKTREE.folderId,
            workspaceId: WORKTREE.workspaceId,
        });
    });
});

describe('Create PR in the sidebar', () => {
    it('shows one standard pull request button with failed and passed check counts', async () => {
        await start();

        const pr = container.querySelector('button[aria-label^="Open pull request 128"]')!;
        expect(pr.textContent).toBe('PR #12813');
        expect(pr.getAttribute('data-size')).toBe('sm');
        expect(pr.querySelector('svg[data-state="open"]')).not.toBeNull();
        expect(pr.getAttribute('aria-label')).toContain('1 failed, 3 passed');
        expect(pr.querySelector('[data-check="failed"]')?.textContent).toBe('1');
        expect(pr.querySelector('[data-check="passed"]')?.textContent).toBe('3');
        expect(pr.hasAttribute('aria-haspopup')).toBe(false);
        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });

    it('shows a merged pull request without a failure counter', async () => {
        await start({
            tweak: data => {
                data.pullRequests[CAR_RENTAL] = { worktree: 'merged' };
            },
        });

        const pr = container.querySelector('button[aria-label^="Open pull request 31"]')!;

        expect(pr.querySelector('svg[data-state="merged"]')).not.toBeNull();
        expect(pr.getAttribute('aria-label')).toContain('3 passed');
        expect(pr.querySelector('[data-check="failed"]')).toBeNull();
        expect(pr.querySelector('[data-check="passed"]')?.textContent).toBe('3');
    });

    it('omits CI counts until a check passes or fails', async () => {
        await start({
            tweak: data => {
                data.pullRequests[CAR_RENTAL] = { worktree: 'draft' };
            },
        });

        const pr = container.querySelector('button[aria-label^="Open pull request 54"]')!;

        expect(pr.textContent).toBe('PR #54Draft');
        expect(pr.querySelector('[data-check]')).toBeNull();
    });

    it('shows a single Publish action for a clean unpublished branch and offers Create PR after publishing', async () => {
        await start({ tweak: noPullRequest, gitWrites: { clean: true } });

        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Commit 0 files')?.disabled).toBe(true);
        expect(
            [...sidebar().querySelectorAll('button')].filter(button => /publish/i.test(button.textContent ?? ''))
        ).toEqual([syncButton()]);

        await press(syncButton());
        await settle();
        await settle();

        // The branch is on origin now, and nothing was opened: the page is the second step.
        expect(createPRButton()?.querySelector('[data-commit-count="up"]')?.textContent).toBe('2');
        expect(opened).toEqual([]);
        expect(buttonOf('Publish first')).toBeUndefined();
        expect(createPRButton()?.disabled).toBe(false);

        await press(createPRButton()!);
        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it("never opens the page for a branch GitHub does not have: a failed publish leaves it where it was, with git's line", async () => {
        await start({ tweak: noPullRequest });
        vi.spyOn(transport, 'pushGit').mockRejectedValue(
            new TransportError('git@github.com: Permission denied (publickey).', 409)
        );
        await press(syncButton());
        await settle();
        await settle();

        expect(opened).toEqual([]);
        expect(syncButton().textContent).toContain('Publish branch');
        expect(createPRButton()).toBeUndefined();
        expect(alert()?.textContent).toBe('git@github.com: Permission denied (publickey).');
    });

    it('offers Create PR after pushing the remaining commits through the sync button', async () => {
        await start({ tweak: noPullRequest, gitWrites: { clean: true, remote: 'ahead' } });

        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Push first')).toBeUndefined();
        expect(syncButton().getAttribute('data-sync')).toBe('push');

        await press(syncButton());
        await settle();
        await settle();

        expect(opened).toEqual([]);
        expect(createPRButton()?.disabled).toBe(false);
    });

    it('opens the page for a branch that is level with its upstream, or only behind it', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'behind' } });
        await press(createPRButton()!);

        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it('offers Create PR once a branch tracking another branch is published under its own name', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'behind' } });

        const read = transport.getGitStatus.bind(transport);
        // What `git switch -c feat origin/main` leaves: the branch tracks `origin/main`.
        const renamed = vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
            const value = await read(...args);

            return value.isRepository && value.upstream
                ? { ...value, upstream: { ...value.upstream, name: 'origin/main' } }
                : value;
        });

        gitFactsOf(transport).refresh(WORKTREE);
        await settle();
        await settle();
        expect(createPRButton()).toBeUndefined();
        expect(syncCopy()).toBe('Publish branchTracks origin/main');

        const push = vi.spyOn(transport, 'pushGit');

        await press(syncButton());
        await settle();
        await settle();
        expect(push).toHaveBeenCalledTimes(1);
        expect(opened).toEqual([]);

        // Published under its own name, the branch has its own upstream, and GitHub has it.
        renamed.mockRestore();
        gitFactsOf(transport).refresh(WORKTREE);
        await settle();
        await settle();
        await press(createPRButton()!);

        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it('hides Create PR when a branch diverged from origin', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'diverged' } });

        expect(createPRButton()).toBeUndefined();
    });

    it('hides Create PR on the base branch', async () => {
        await start({ tweak: noPullRequest, key: CHECKOUT });

        expect(createPRButton()).toBeUndefined();
    });

    it('is the page of a GitHub Enterprise server the person is signed in to, and nothing for another site', async () => {
        await start({
            tweak: data => {
                noPullRequest(data);
                data.git[CAR_RENTAL] = { ...data.git[CAR_RENTAL], remoteUrl: 'git@ghe.example.com:team/service.git' };
            },
            gitWrites: { remote: 'behind' },
        });

        await press(createPRButton()!);
        expect(opened).toEqual(['https://ghe.example.com/team/service/compare/main...clowdy/ab12cd34?expand=1']);

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        // `gh` is signed in only to the GitHub hosts: for another site it says it is not.
        await start({
            tweak: data => {
                data.pullRequests[CAR_RENTAL] = { checkout: 'none', worktree: 'not_signed_in' };
                data.git[CAR_RENTAL] = { ...data.git[CAR_RENTAL], remoteUrl: 'git@gitlab.com:acme/app.git' };
            },
            gitWrites: { remote: 'behind' },
        });

        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });

    it('is not drawn for a folder with no remote', async () => {
        await start({
            tweak: data => {
                noPullRequest(data);
                delete data.git[CAR_RENTAL]!.remoteUrl;
            },
        });

        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });
});
