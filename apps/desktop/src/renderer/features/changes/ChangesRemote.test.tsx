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
import { openEffects, refreshFolderGit } from '../openWith';
import { branchPullRequestsOf } from './branchPullRequests';
import { ChangesSidebar } from './ChangesSidebar';
import { type GitPlaceKey, gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitPullRequestSummary, GitRemoteResult, GitSyncProgress, GitSyncResult } from '@clowdy/protocol';
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
const syncDetail = () => document.getElementById(syncButton().getAttribute('aria-describedby') ?? '')?.textContent;
/** The dropdown beside it, which keeps every action. */
const dropdown = () => container.querySelector<HTMLButtonElement>('button[aria-label="More source control actions"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const item = (label: string) => items().find(candidate => candidate.textContent?.startsWith(label))!;
const isOff = (label: string) => item(label).getAttribute('aria-disabled') === 'true';
const alert = () => container.querySelector('[role="alert"]');
const status = () => container.querySelector('[role="status"]:not([aria-label])');
const updateLabel = 'Update from main';
const mergeLabels = ['Merge from branch…', 'Merge into branch…', 'Merge into main worktree…'];

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

const historyBranch = 'clowdy/ab12cd34';
const historyPr = (number: number, state: GitPullRequestSummary['state'], title: string): GitPullRequestSummary => ({
    number,
    state,
    title,
    url: `https://github.com/acme/car-rental/pull/${number}`,
    head: historyBranch,
    base: 'main',
    updatedAt: Date.UTC(2026, 10, 22, 9, 30),
});

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
    sourceControlPreferences.setAutoSync(true);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('the sync button in the sidebar', () => {
    const place = { folderId: WORKTREE.folderId, workspaceId: WORKTREE.workspaceId };
    const branch = 'clowdy/ab12cd34';
    const read = () => transport.getGitStatus(FIXTURE_PROJECT_ID, place);

    it('uses Sync to publish an unpublished branch and keeps Update from the base available', async () => {
        await start();
        const sync = vi.spyOn(transport, 'syncGit');

        expect(syncCopy()).toBe('Publish branchPublish this branch to origin');
        expect(syncButton().disabled).toBe(false);
        expect(buttonOf(updateLabel)).toBeUndefined();
        await openMenu();
        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            updateLabel,
            ...mergeLabels,
        ]);
        expect(isOff('Fetch origin')).toBe(false);
        expect(isOff('Pull origin')).toBe(true);
        await press(dropdown());
        await settle();

        await press(syncButton());
        await settle();
        expect(sync).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, place, { branch }, expect.any(Function));
        expect(await read()).toMatchObject({ upstream: { name: `origin/${branch}`, ahead: 0, behind: 0 } });
        expect(status()).toBeNull();
        expect(syncButton()).toBe(buttonOf(updateLabel));
    });

    it('fetches when the branch is even and refreshes the clock without a separate success notice', async () => {
        await start({ key: CHECKOUT });

        expect(syncCopy()).toBe('Fetch originLast fetched 3 minutes ago');
        expect(syncDetail()).toBe('Last fetched 3 minutes ago');
        await press(syncButton());
        await settle();

        expect(status()).toBeNull();
        expect(syncCopy()).toBe('Fetch originLast fetched just now');
        expect(syncDetail()).toBe('Last fetched just now');

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({ key: CHECKOUT, gitWrites: { remote: 'never' } });
        expect(syncCopy()).toBe('Fetch originNever fetched');
    });

    it('moves its line while the window stays open without a new read', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });

        try {
            await start({ key: CHECKOUT });
            const reads = vi.spyOn(transport, 'getGitStatus');

            expect(syncCopy()).toBe('Fetch originLast fetched 3 minutes ago');
            act(() => {
                vi.advanceTimersByTime(29_000);
            });
            expect(syncCopy()).toBe('Fetch originLast fetched 3 minutes ago');
            act(() => {
                vi.advanceTimersByTime(2 * 60_000);
            });
            expect(syncCopy()).toBe('Fetch originLast fetched 5 minutes ago');
            expect(reads).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('syncs a branch that tracks another name with its own name on origin', async () => {
        await start({ gitWrites: { remote: 'renamed' } });

        expect(syncCopy()).toBe('Publish branchTracks origin/main');
        expect(syncDetail()).toBe(`Publish as origin/${branch}`);
        await openMenu();
        expect(isOff('Pull origin')).toBe(true);
        await press(dropdown());
        await settle();

        await press(syncButton());
        await settle();
        expect(await read()).toMatchObject({ upstream: { name: `origin/${branch}`, ahead: 0, behind: 0 } });
    });

    it.each([
        ['ahead', 'Push origin', 2, 0, '2 commits to push'],
        ['behind', 'Pull origin', 0, 2, '2 commits to pull'],
        ['diverged', 'Sync', 1, 2, '2 commits to pull and 1 commit to push'],
    ] as const)(
        'recommends the upstream action before updating the base for a branch that is %s',
        async (remote, label, ahead, behind, detail) => {
            await start({ gitWrites: { clean: true, remote } });
            const sync = vi.spyOn(transport, 'syncGit');
            const pull = vi.spyOn(transport, 'pullGit');
            const pr = vi.spyOn(transport, 'getGitPullRequest');

            expect(syncCopy()).toBe(`${label}Last fetched 3 minutes ago`);
            expect(syncDetail()).toBe(detail);
            expect(buttonOf(updateLabel)).toBeUndefined();

            await press(syncButton());
            await settle();

            expect(sync).toHaveBeenCalledTimes(1);
            expect(await sync.mock.results[0]?.value).toMatchObject({
                state: 'done',
                pulled: behind,
                pushed: ahead > 0,
            });
            expect(pull).not.toHaveBeenCalled();
            expect(await read()).toMatchObject({ upstream: { ahead: 0, behind: 0 } });
            expect(syncButton()).toBe(buttonOf(updateLabel));
            expect(pr).toHaveBeenCalled();
            expect(status()).toBeNull();
        }
    );

    it('keeps the explicit Pull and its incoming count in the menu', async () => {
        await start({ gitWrites: { clean: true, remote: 'behind' } });
        const pull = vi.spyOn(transport, 'pullGit');
        const sync = vi.spyOn(transport, 'syncGit');

        await openMenu();
        expect(item('Pull origin').textContent).toBe('Pull origin2 commits');
        await press(item('Pull origin'));
        await settle();

        expect(pull).toHaveBeenCalledTimes(1);
        expect(sync).not.toHaveBeenCalled();
        expect(await read()).toMatchObject({ upstream: { behind: 0 } });
    });

    it('shows conflicts as a warning while the status refresh catches up', async () => {
        await start({ gitWrites: { clean: true, remote: 'diverged' } });
        vi.spyOn(transport, 'syncGit').mockResolvedValue({
            state: 'conflicts',
            branch,
            path: currentPlace.workspace!.path,
            conflicts: 2,
        });

        await press(syncButton());
        await settle();

        expect(status()?.textContent).toBe('2 conflicts');
        expect(alert()).toBeNull();
    });

    it.each([
        ['detached', 'blocked', 'HEAD is detached'],
        ['unborn', 'blocked', 'No commits yet'],
        ['no_origin', 'no_origin', 'Nothing to sync with'],
    ] as const)('holds Sync where it cannot run (%s) with an accessible reason', async (script, kind, line) => {
        await start({ gitWrites: { remote: script } });

        expect(syncButton().getAttribute('data-sync')).toBe(kind);
        expect(syncButton().disabled).toBe(true);
        expect(syncCopy()).toContain(line);
        const stand = syncButton().closest('[role="button"][aria-disabled="true"]');
        expect(stand?.getAttribute('tabindex')).toBe('0');
        expect(stand?.getAttribute('aria-label')).toBe(script === 'no_origin' ? 'No origin' : 'Sync');
        await openMenu();
        expect(isOff('Fetch origin')).toBe(script === 'no_origin');
    });

    it("shows git's own line and hint when Sync fails", async () => {
        await start({ gitWrites: { remote: 'signing' } });

        await press(syncButton());
        await settle();
        expect(alert()?.textContent).toContain('error: No private key found for public key');
        expect(alert()?.textContent).toContain("The signing agent couldn't be reached");

        await openMenu();
        await press(item('Fetch origin'));
        await settle();
        expect(alert()).toBeNull();
        expect(status()).toBeNull();
    });

    it('offers to retry the whole Sync when a push is rejected because origin moved', async () => {
        await start({ gitWrites: { remote: 'ahead' } });
        const sync = vi
            .spyOn(transport, 'syncGit')
            .mockRejectedValueOnce(new TransportError(`! [rejected] ${branch} -> ${branch} (fetch first)`, 409));

        await press(syncButton());
        await settle();
        expect(alert()?.textContent).toContain('(fetch first)');
        expect(alert()?.querySelector('button')?.textContent).toBe('Retry Sync');

        await press(alert()!.querySelector('button')!);
        await settle();

        expect(sync).toHaveBeenCalledTimes(2);
        expect(alert()).toBeNull();
        expect(await read()).toMatchObject({ upstream: { ahead: 0, behind: 0 } });
    });

    it('shows each phase without replacing the button or blocking merge choices', async () => {
        await start({ key: CHECKOUT, gitWrites: { remote: 'ahead' } });
        const reply = Promise.withResolvers<GitSyncResult>();
        let progress: (step: GitSyncProgress) => void = () => undefined;

        vi.spyOn(transport, 'syncGit').mockImplementationOnce((_project, _place, _target, onProgress) => {
            progress = onProgress ?? progress;
            progress({ phase: 'fetch' });
            return reply.promise;
        });
        const button = syncButton();
        await press(button);

        expect(syncButton()).toBe(button);
        expect(syncCopy()).toBe('Fetching origin');
        expect(button.hasAttribute('data-pending')).toBe(true);
        await openMenu();
        expect(isOff('Merge from branch…')).toBe(false);
        expect(isOff('Merge into branch…')).toBe(false);

        act(() => progress({ phase: 'merge' }));
        expect(syncCopy()).toBe('Merging from origin');
        act(() => progress({ phase: 'push', commit: 'a'.repeat(40) }));
        expect(syncCopy()).toBe('Pushing origin');
        reply.resolve({ state: 'done', branch: 'main', pulled: 1, pushed: true });
        await settle();

        expect(syncButton()).toBe(button);
        expect(button.hasAttribute('data-pending')).toBe(false);
        expect(button.dataset.sync).toBe('push');
        expect(status()).toBeNull();
    });

    it('disables only actions that require origin when the repository has none', async () => {
        await start({ gitWrites: { remote: 'no_origin' } });
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual([
            'Fetch origin',
            'Pull origin',
            updateLabel,
            ...mergeLabels,
        ]);
        expect(items().map(candidate => candidate.getAttribute('aria-disabled') === 'true')).toEqual([
            true,
            true,
            true,
            false,
            false,
            false,
        ]);
    });

    it('follows Push with Update and syncs the update before recommending Fetch', async () => {
        await start({ gitWrites: { clean: true, remote: 'ahead' } });
        const sync = vi.spyOn(transport, 'syncGit');
        const applySync = transport.syncGit.bind(transport);
        const update = vi.spyOn(transport, 'updateGit');
        const primary = syncButton();

        expect(primary.getAttribute('aria-label')).toBe('Push origin');
        expect(buttonOf(updateLabel)).toBeUndefined();
        await press(primary);
        await settle();
        expect(syncButton()).toBe(primary);
        expect(primary.getAttribute('aria-label')).toBe(updateLabel);
        expect(primary.querySelector('[data-commit-count="down"]')?.textContent).toBe('1');
        expect(syncDetail()).toBe('1 commit to merge from main');

        const release = Promise.withResolvers<void>();
        sync.mockImplementationOnce(async (project, place, target, progress) => {
            progress?.({ phase: 'fetch' });
            await release.promise;
            return applySync(project, place, target, progress);
        });
        await press(primary);
        await settle();

        expect(update).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, place);
        const result = await update.mock.results[0]?.value;
        expect(result).toMatchObject({ state: 'done', updatedHead: { branch, commit: expect.any(String) } });
        expect(sync).toHaveBeenLastCalledWith(
            FIXTURE_PROJECT_ID,
            place,
            result.state === 'done' ? result.updatedHead : undefined,
            expect.any(Function)
        );
        expect(syncCopy()).toBe('Fetching origin');
        await openMenu();
        expect(isOff(updateLabel)).toBe(true);
        expect(isOff('Fetch origin')).toBe(false);

        release.resolve();
        await settle();
        expect(syncButton()).toBe(primary);
        expect(primary.getAttribute('aria-label')).toBe('Fetch origin');
        expect(await read()).toMatchObject({ upstream: { ahead: 0 }, base: { behind: 0 } });
        expect(alert()).toBeNull();
    });

    it('leaves the update local when automatic sync is off', async () => {
        sourceControlPreferences.setAutoSync(false);
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const sync = vi.spyOn(transport, 'syncGit');

        expect(syncButton().getAttribute('aria-label')).toBe(updateLabel);
        await press(syncButton());
        await settle();

        expect(sync).not.toHaveBeenCalled();
        expect(syncButton().getAttribute('aria-label')).toBe('Push origin');
    });

    it('keeps the local update and recommends Push when its sync fails', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        vi.spyOn(transport, 'syncGit').mockRejectedValueOnce(new TransportError('Network is offline', 503));

        await press(syncButton());
        await settle();

        expect(await read()).toMatchObject({ upstream: { ahead: 1 }, base: { behind: 0 } });
        expect(syncButton().getAttribute('aria-label')).toBe('Push origin');
        expect(alert()?.textContent).toContain('Updated locally, sync failed: Network is offline');
    });

    it.each([
        { state: 'conflicts', action: 'update', conflicts: 2 },
        { state: 'done', action: 'update', pulled: 0 },
    ] as const)('does not sync an update that never made a commit ($state)', async outcome => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        vi.spyOn(transport, 'updateGit').mockResolvedValueOnce(outcome);
        const sync = vi.spyOn(transport, 'syncGit');

        await press(syncButton());
        await settle();

        expect(sync).not.toHaveBeenCalled();
    });
});

describe('merging branches from the sync menu', () => {
    const dialog = () => document.querySelector<HTMLElement>('[data-modal-window] [role="dialog"]')!;
    const heading = () => dialog().querySelector('h2')?.textContent;
    const modeTrigger = () => dialog().querySelector<HTMLButtonElement>('button[aria-label="Choose merge mode"]')!;
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
        await press(button('Merge'));
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
        expect(heading()).toBe('Merge … into clowdy/ab12cd34');
        expect(option('origin/feature/search')).toBeUndefined();
        await press(option('main'));
        await settle();
        expect(heading()).toBe('Merge main into clowdy/ab12cd34');
        expect(button('Merge').disabled).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);

        reply.resolve({ state: 'done', action: 'fetch' });
        await settle();
        expect(option('origin/feature/search')).toBeDefined();
        expect(heading()).toBe('Merge main into clowdy/ab12cd34');
    });

    it('lets the user open the destination picker during the push phase of Sync', async () => {
        await start({ gitWrites: { clean: true, remote: 'ahead' } });
        const reply = Promise.withResolvers<GitSyncResult>();
        vi.spyOn(transport, 'syncGit').mockImplementationOnce((_project, _place, _target, progress) => {
            progress?.({ phase: 'push', commit: 'a'.repeat(40) });
            return reply.promise;
        });

        await press(syncButton());
        expect(syncCopy()).toBe('Pushing origin');
        await openMenu();
        expect(isOff('Fetch origin')).toBe(false);
        await press(item('Merge into branch…'));
        await settle();
        await press(option('main'));
        await settle();

        expect(heading()).toBe('Merge clowdy/ab12cd34 into main');
        expect(button('Merge').disabled).toBe(false);
        reply.resolve({ state: 'done', branch: 'clowdy/ab12cd34', pulled: 0, pushed: true });
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

    it('fetches origin before listing source branches and confirms the preview outcome before merging', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const success = vi.spyOn(toast, 'success').mockReturnValue('');
        const fetch = vi.spyOn(transport, 'fetchGit');
        const branches = vi.spyOn(transport, 'getGitBranches');
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const sync = vi.spyOn(transport, 'syncGit');

        await open('Merge from branch…');

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(branches).toHaveBeenCalledTimes(1);
        expect(fetch.mock.invocationCallOrder[0]!).toBeLessThan(branches.mock.invocationCallOrder[0]!);
        expect(merge).not.toHaveBeenCalled();
        expect(button('Select a branch').disabled).toBe(true);
        expect(modeTrigger().disabled).toBe(true);
        expect(heading()).toBe('Merge … into clowdy/ab12cd34');
        expect(option('origin/main')).toBeUndefined();
        expect(option('origin/dev')).toBeUndefined();

        await press(option('main'));
        await settle();

        expect(heading()).toBe('Merge main into clowdy/ab12cd34');
        expect(dialog().textContent).toContain('Fast-forward without a merge commit');
        expect(merge).toHaveBeenCalledTimes(1);
        expect(merge.mock.calls[0]?.[2]).toEqual({
            action: 'preview',
            direction: 'from',
            current: 'clowdy/ab12cd34',
            branch: 'main',
        });

        await press(button('Merge'));
        await settle();

        expect(merge.mock.calls[1]?.[2]).toMatchObject({
            action: 'merge',
            direction: 'from',
            current: 'clowdy/ab12cd34',
            branch: 'main',
            sourceCommit: expect.stringMatching(/^[0-9a-f]+$/),
            targetCommit: expect.stringMatching(/^[0-9a-f]+$/),
            expectedMode: 'fast-forward',
        });
        expect(dialog()).toBeNull();
        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge']);
        expect(sync.mock.calls[0]?.[2]).toMatchObject({ branch: 'clowdy/ab12cd34', destination: true });
        expect(success).toHaveBeenCalledWith({ message: 'Pushed clowdy/ab12cd34 to origin' });
    });

    it('puts comparison and up-to-date states on the disabled merge button', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const readPreview = transport.branchMergeGit.bind(transport);
        let finish = () => {};
        const merge = vi.spyOn(transport, 'branchMergeGit').mockImplementationOnce(async (...args) => {
            const preview = await readPreview(...args);
            if (preview.state !== 'preview') throw new Error('Expected a merge preview');

            return new Promise(resolve => {
                finish = () => resolve({ ...preview, mode: 'up-to-date', commits: 0 });
            });
        });

        await open('Merge from branch…');
        await press(option('main'));
        await settle();

        expect(button('Comparing branches…').disabled).toBe(true);
        expect(dialog().querySelectorAll('[role="status"]')).toHaveLength(1);

        await act(async () => finish());
        await settle();

        expect(button('Already up to date').disabled).toBe(true);
        expect(dialog().querySelectorAll('[role="status"]')).toHaveLength(1);
        expect(modeTrigger().disabled).toBe(false);
        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview']);

        await press(option('main'));
        await settle();
        expect(button('Merge').disabled).toBe(false);
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
        expect(button('Select a branch').disabled).toBe(true);
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
        const modes = () => [...document.querySelectorAll('[role="menuitemradio"]')];
        const openModes = async () => {
            await press(modeTrigger());
            await settle();
        };
        const chooseMode = async (mode: string) => {
            const choice = modes().find(row => row.textContent?.startsWith(mode))!;
            await press(choice);
            await settle();
        };

        await open('Merge from branch…');
        await press(option('origin/feature/search'));
        await settle();
        expect(button('Merge').disabled).toBe(false);
        expect(dialog().textContent).toContain('Creates a merge commit');
        const originalPreview = await merge.mock.results[0]!.value;

        if (originalPreview.state !== 'preview') throw new Error('Expected a merge preview');
        merge.mockResolvedValueOnce({ ...originalPreview, fastForwardOnly: true });
        await press(option('origin/feature/search'));
        await settle();
        expect(button('Merge').disabled).toBe(true);
        expect(modeTrigger().disabled).toBe(false);
        expect(dialog().textContent).toContain('Git is configured to require a fast-forward');

        await openModes();
        expect(modes()).toHaveLength(3);
        expect(modes()[0]?.textContent).toMatch(/^Merge/);
        expect(modes()[1]?.textContent).toMatch(/^Squash and merge/);
        expect(modes()[2]?.textContent).toMatch(/^Rebase/);
        merge.mockResolvedValueOnce(originalPreview);
        await chooseMode('Squash and merge');
        expect(button('Squash and merge').disabled).toBe(true);
        expect(dialog().textContent).toContain('Update Clowdy to use Squash and merge');

        await openModes();
        await chooseMode('Rebase');
        expect(merge.mock.calls.every(call => call[2].action === 'preview')).toBe(true);
        expect(merge.mock.calls.at(-1)?.[2]).toMatchObject({ strategy: 'rebase', branch: 'feature/search' });
        expect(heading()).toBe('Rebase clowdy/ab12cd34 onto origin/feature/search');
        expect(dialog().textContent).toContain('2 commits to replay');
        await press(button('Rebase'));
        await settle();
        expect(merge.mock.calls.at(-1)?.[2]).toMatchObject({ action: 'merge', strategy: 'rebase' });
        expect(button('Abort rebase')).toBeDefined();

        await press(button('Done'));
        await settle();
        expect(sidebar().querySelector('[aria-label="Commit"]')?.textContent).toContain('Rebase paused');
    });

    it('syncs only the destination at the tip returned by Merge into', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const sync = vi.spyOn(transport, 'syncGit');

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Merge'));
        await settle();

        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge']);
        const applied = await merge.mock.results[1]?.value;
        expect(applied).toMatchObject({ state: 'done', commit: expect.any(String) });
        expect(sync.mock.calls[0]?.[2]).toEqual({
            branch: 'main',
            commit: applied?.state === 'done' ? applied.commit : undefined,
            destination: true,
        });
        expect(dialog()).toBeNull();
        expect(
            await transport.getGitStatus(FIXTURE_PROJECT_ID, {
                folderId: WORKTREE.folderId,
                workspaceId: WORKTREE.workspaceId,
            })
        ).toMatchObject({ head: { name: 'clowdy/ab12cd34' }, upstream: { ahead: 0 } });
    });

    it('opens the main checkout branch directly even when it differs from the default branch', async () => {
        await start({
            gitWrites: { clean: true, remote: 'level' },
            tweak: data => {
                data.git[CAR_RENTAL]!.branch = 'next';
            },
        });
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const sync = vi.spyOn(transport, 'syncGit');

        await open('Merge into main worktree…');

        expect(heading()).toBe('Merge clowdy/ab12cd34 into next');
        expect(dialog().querySelector('input[placeholder="Filter branches"]')).toBeNull();
        expect(dialog().querySelector(`[title="${CAR_RENTAL}"]`)).not.toBeNull();
        expect(merge.mock.calls.map(call => call[2])).toEqual([
            { action: 'preview', direction: 'into', current: 'clowdy/ab12cd34', branch: 'next' },
        ]);
        expect(sync).not.toHaveBeenCalled();

        await press(button('Merge'));
        await settle();

        expect(merge.mock.calls[1]?.[2]).toMatchObject({ action: 'merge', direction: 'into', branch: 'next' });
        expect(sync.mock.calls[0]?.[2]).toMatchObject({ branch: 'next', destination: true });
        expect(dialog()).toBeNull();
    });

    it('reads the checkout branch again when the shortcut is pressed', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const merge = vi.spyOn(transport, 'branchMergeGit');

        await openMenu();
        expect(item('Merge into main worktree…')).toBeDefined();
        await transport.switchGitBranch(FIXTURE_PROJECT_ID, { folderId: CHECKOUT.folderId }, 'dev');
        await press(item('Merge into main worktree…'));
        await settle();

        expect(heading()).toBe('Merge clowdy/ab12cd34 into dev');
        expect(merge.mock.calls[0]?.[2]).toMatchObject({ action: 'preview', branch: 'dev' });
        expect(merge).toHaveBeenCalledTimes(1);
    });

    it('does not offer merging into the main checkout from the main checkout itself', async () => {
        await start({ key: CHECKOUT });
        await openMenu();

        expect(item('Merge into main worktree…')).toBeUndefined();
        expect(item('Merge into branch…')).toBeDefined();
    });

    it('does not offer the shortcut when the main checkout is detached', async () => {
        await start({
            tweak: data => {
                data.git[CAR_RENTAL]!.detached = true;
            },
        });
        await openMenu();

        expect(item('Merge into main worktree…')).toBeUndefined();
        expect(item('Merge into branch…')).toBeDefined();
    });

    it('retries sync from the post-integration tip after a rejected push', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        const tip = 'c'.repeat(40);
        const sync = vi
            .spyOn(transport, 'syncGit')
            .mockImplementationOnce(async (_project, _place, _target, progress) => {
                progress?.({ phase: 'push', commit: tip });
                throw new TransportError('Network is offline', 503);
            })
            .mockResolvedValueOnce({ state: 'done', branch: 'main', pulled: 0, pushed: true });

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Merge'));
        await settle();

        expect(dialog().textContent).toContain('Merged into main');
        expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Sync failed: Network is offline');
        await press(button('Sync main'));
        await settle();

        expect(sync).toHaveBeenCalledTimes(2);
        expect(sync.mock.calls[1]?.[2]).toEqual({ branch: 'main', commit: tip, destination: true });
        expect(dialog()).toBeNull();
    });

    it('points to the destination checkout when Sync stops on incoming conflicts', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        vi.spyOn(transport, 'syncGit').mockResolvedValueOnce({
            state: 'conflicts',
            branch: 'main',
            path: CAR_RENTAL,
            conflicts: 1,
        });

        await open('Merge into branch…');
        await press(option('main'));
        await settle();
        await press(button('Merge'));
        await settle();

        expect(dialog().querySelector('[role="status"]')?.textContent).toContain('1 conflict in main');
        expect(dialog().querySelector('[role="status"]')?.textContent).toContain(CAR_RENTAL);
        expect(dialog().textContent).toContain('complete the merge to resume sync');
        expect(button('Sync main')).toBeUndefined();
        await press(button('Done'));
        await settle();
        expect(dialog()).toBeNull();
    });

    it('offers explicit Sync after an outgoing merge with automatic sync off', async () => {
        sourceControlPreferences.setAutoSync(false);
        await start({ gitWrites: { clean: true, remote: 'level' }, branches: ['remote'] });
        const success = vi.spyOn(toast, 'success').mockReturnValue('');
        const fetch = vi.spyOn(transport, 'fetchGit');
        const merge = vi.spyOn(transport, 'branchMergeGit');
        const sync = vi.spyOn(transport, 'syncGit');

        await open('Merge into branch…');
        expect(fetch).not.toHaveBeenCalled();
        expect(option('origin/main')).toBeUndefined();
        expect(option('origin/feature/search')).toBeUndefined();
        expect(heading()).toBe('Merge clowdy/ab12cd34 into …');

        await press(option('main'));
        await settle();
        expect(heading()).toBe('Merge clowdy/ab12cd34 into main');

        await press(button('Merge'));
        await settle();
        expect(merge.mock.calls.map(call => call[2].action)).toEqual(['preview', 'merge']);
        expect(sync).not.toHaveBeenCalled();
        expect(success).not.toHaveBeenCalled();

        await press(button('Sync main'));
        await settle();
        expect(sync.mock.calls[0]?.[2]).toMatchObject({ branch: 'main', destination: true });
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
        await press(button('Merge'));
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
        expect(button('Merge').disabled).toBe(true);

        await press(option('dev'));
        await settle();

        alert = dialog().querySelector('[role="alert"]');
        expect(alert?.textContent).toBe('Check out dev before merging into it');
        expect(button('Merge').disabled).toBe(true);
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
        await press(button('Merge'));
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
        expect(button('Merge').disabled).toBe(false);
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

        expect(heading()).toBe('Merge origin/feature/search into clowdy/ab12cd34');
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
    it('stacks the branch history and archives or restores only completed PRs', async () => {
        await start({
            tweak: data => {
                data.branchPullRequests = {
                    [CAR_RENTAL]: {
                        [historyBranch]: [
                            historyPr(128, 'open', 'Charge a weekend surcharge'),
                            historyPr(125, 'merged', 'Release booking form'),
                            historyPr(124, 'closed', 'Try a new booking flow'),
                        ],
                    },
                };
            },
        });
        const row = (number: number) =>
            container.querySelector(`[role="row"][aria-label^="Open pull request ${number} "]`);

        expect(row(128)?.querySelector('[data-check="passed"]')?.textContent).toBe('3');
        expect(row(125)?.textContent).toContain('Release booking form');
        expect(row(125)?.querySelector('svg[data-state="merged"]')).not.toBeNull();
        expect(row(124)?.querySelector('svg[data-state="closed"]')).not.toBeNull();
        expect(buttonOf('Archive PR #128')).toBeUndefined();
        expect(row(125)?.contains(buttonOf('Archive PR #125')!)).toBe(true);
        expect(buttonOf('Archive PR #125')?.getAttribute('data-show')).toBe('item-both');
        expect(buttonOf('Archive PR #124')).toBeDefined();

        await press(row(124)!);
        expect(opened).toEqual(['https://github.com/acme/car-rental/pull/124']);
        const archive = vi.spyOn(transport, 'setGitPullRequestArchived');
        await press(buttonOf('Archive PR #125')!);
        await settle();
        expect(archive).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, {
            folderId: WORKTREE.folderId,
            branch: historyBranch,
            number: 125,
            archived: true,
            repo: { host: 'github.com', owner: 'acme', name: 'car-rental' },
        });
        expect(row(125)).toBeNull();
        expect(row(124)).not.toBeNull();
        expect(opened).toEqual(['https://github.com/acme/car-rental/pull/124']);

        await press(buttonOf('Archived (1)')!);
        await settle();
        expect(row(125)).not.toBeNull();
        await press(buttonOf('Restore PR #125')!);
        await settle();
        expect(row(125)).not.toBeNull();
        expect(buttonOf('Archived (1)')).toBeUndefined();
        expect(archive.mock.calls[1]?.[1]).toMatchObject({ number: 125, archived: false });
    });

    it('shares the current open PR before the branch history includes it', async () => {
        await start({
            tweak: data => {
                data.branchPullRequests = {
                    [CAR_RENTAL]: { [historyBranch]: [historyPr(125, 'merged', 'Previous release')] },
                };
            },
        });
        const fact = branchPullRequestsOf(transport).of({
            projectId: FIXTURE_PROJECT_ID,
            folderId: WORKTREE.folderId,
            branch: historyBranch,
        });
        expect(fact.value?.pullRequests.map(pr => pr.number)).toEqual([125]);
        expect(fact.pullRequests.map(pr => pr.number)).toEqual([125, 128]);
    });

    it('still offers Create PR when the branch moved past completed pull requests', async () => {
        await start({
            tweak: data => {
                noPullRequest(data);
                data.branchPullRequests = {
                    [CAR_RENTAL]: { [historyBranch]: [historyPr(125, 'merged', 'Previous release')] },
                };
            },
            gitWrites: { clean: true, remote: 'level' },
        });

        expect(container.querySelector('[role="row"][aria-label^="Open pull request 125 "]')).not.toBeNull();
        expect(createPRButton()).toBeDefined();
    });

    it('keeps the last checked-out branch history when its worktree disappears', async () => {
        await start({
            tweak: data => {
                data.branchPullRequests = {
                    [CAR_RENTAL]: {
                        [historyBranch]: [historyPr(125, 'merged', 'Original branch release')],
                        'feature/switched': [
                            { ...historyPr(190, 'merged', 'New branch release'), head: 'feature/switched' },
                        ],
                    },
                };
            },
            gitWrites: { clean: true, remote: 'level' },
        });
        const place = { folderId: WORKTREE.folderId, workspaceId: WORKTREE.workspaceId };
        const original = await transport.getGitStatus(FIXTURE_PROJECT_ID, place);
        if (!original.isRepository) throw new Error('Fixture is not a repository');
        const info = await transport.getProjectsInfo();
        let exists = true;
        vi.spyOn(transport, 'getProjectsInfo').mockImplementation(async projectId =>
            info
                .filter(project => !projectId || project.projectId === projectId)
                .map(project => ({
                    ...project,
                    workspaces: project.workspaces?.map(workspace =>
                        workspace.workspaceId === WORKTREE.workspaceId
                            ? { ...workspace, exists, branch: exists ? 'feature/switched' : undefined }
                            : workspace
                    ),
                }))
        );
        const readStatus = vi.spyOn(transport, 'getGitStatus').mockResolvedValue({
            ...original,
            head: { kind: 'branch', name: 'feature/switched', commit: 'f'.repeat(40) },
        });

        await act(async () => {
            refreshFolderGit(FIXTURE_PROJECT_ID, WORKTREE.folderId);
            await model.facts.status.refresh();
        });
        await vi.waitFor(() =>
            expect(container.querySelector('[role="row"][aria-label^="Open pull request 190 "]')).not.toBeNull()
        );
        expect(
            branchPullRequestsOf(transport).workspaceHistoryBranch(FIXTURE_PROJECT_ID, currentPlace.workspace!, {
                gone: true,
            })
        ).toBe('feature/switched');

        exists = false;
        readStatus.mockRejectedValue(new TransportError('The worktree is missing', 503));
        await act(async () => {
            refreshFolderGit(FIXTURE_PROJECT_ID, WORKTREE.folderId);
            await model.facts.status.refresh();
        });
        await settle();

        expect(container.querySelector('[role="row"][aria-label^="Open pull request 190 "]')).not.toBeNull();
        expect(container.querySelector('[role="row"][aria-label^="Open pull request 125 "]')).toBeNull();
        expect(container.querySelector('[role="row"][aria-label^="Open pull request 128 "]')).toBeNull();
        expect(syncButton()).toBeNull();
        expect(createPRButton()).toBeUndefined();
        expect(buttonOf('Archive PR #190')).toBeDefined();
    });

    it('shows a pull request row with its title, number and check counts', async () => {
        await start();

        const pr = container.querySelector('[role="row"][aria-label^="Open pull request 128"]')!;
        expect(pr.textContent).toContain('Charge a weekend surcharge');
        expect(pr.textContent).toContain('PR #128');
        expect(pr.closest('[role="grid"]')?.getAttribute('data-size')).toBe('sm');
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

        const pr = container.querySelector('[role="row"][aria-label^="Open pull request 31"]')!;

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

        const pr = container.querySelector('[role="row"][aria-label^="Open pull request 54"]')!;

        expect(pr.textContent).toContain('PR #54Draft');
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
        vi.spyOn(transport, 'syncGit').mockRejectedValue(
            new TransportError('git@github.com: Permission denied (publickey).', 409)
        );
        await press(syncButton());
        await settle();
        await settle();

        expect(opened).toEqual([]);
        expect(syncCopy()).toContain('Publish this branch to origin');
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
        await start({ tweak: noPullRequest, gitWrites: { remote: 'renamed' } });
        expect(createPRButton()).toBeUndefined();
        expect(syncCopy()).toBe('Publish branchTracks origin/main');

        await press(syncButton());
        await settle();
        expect(opened).toEqual([]);
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
