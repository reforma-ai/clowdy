// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, withFixtureWorkspace, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openEffects } from '../openWith';
import { ChangesSidebar } from './ChangesSidebar';
import { gitFactsOf, type GitPlaceKey } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';

import type { GitRemoteResult } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the sidebar are, to follow the models they read.
vi.mock('./RemoteMenu', async importOriginal => ({ RemoteMenu: observer((await importOriginal<typeof import('./RemoteMenu')>()).RemoteMenu) }));
vi.mock('./CreatePullRequest', async importOriginal => ({ ...await importOriginal<typeof import('./CreatePullRequest')>(), CreatePullRequest: observer((await importOriginal<typeof import('./CreatePullRequest')>()).CreatePullRequest) }));
vi.mock('./CommitBox', async importOriginal => ({ CommitBox: observer((await importOriginal<typeof import('./CommitBox')>()).CommitBox) }));
vi.mock('./PullRequestChip', async importOriginal => ({ PullRequestChip: observer((await importOriginal<typeof import('./PullRequestChip')>()).PullRequestChip) }));

const CAR_RENTAL = '/Users/dev/car-rental';
const WORKTREE: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
const CHECKOUT: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' };

const Sidebar = observer(ChangesSidebar);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: FixtureTransport;
let model: PlaceChanges;
let stop: () => void;
let opened: string[];

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

const sidebar = () => container.querySelector('[aria-label="Changes sidebar"]')!;
const buttonOf = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === label);
/** The row that opens the menu of Fetch, Pull and Push. */
const originRow = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Origin"], button[aria-label="Fetching origin"], button[aria-label="Pulling"], button[aria-label="Pushing"], button[aria-label="Publishing"]')!;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
const item = (label: string) => items().find(candidate => candidate.textContent?.startsWith(label))!;
const isOff = (label: string) => item(label).getAttribute('aria-disabled') === 'true';
const alert = () => container.querySelector('[role="alert"]');
const status = () => container.querySelector('[role="status"]:not([aria-label])');

async function openMenu() {
    await press(originRow());
    await settle();
}

/** The sidebar of the chat in a worktree (or of the checkout, with `key`) on the fixtures, `tweak` having its say about them first. */
async function start({ tweak, gitWrites, key = WORKTREE }: { tweak?: (data: FixtureData) => void; gitWrites?: FixtureGitWritesOptions; key?: GitPlaceKey } = {}) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);
    transport = new FixtureTransport({ data, gitWrites });
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
    act(() => root.render(<RootStoreProvider value={ store }><Sidebar model={ model } place={ place } projectId={ FIXTURE_PROJECT_ID } onOpenFile={ () => undefined } toggle={ null } /></RootStoreProvider>));
    await settle();
    await settle();
}

/** The worktree's branch has no pull request. */
const noPullRequest = (data: FixtureData) => {
    data.pullRequests[CAR_RENTAL] = { checkout: 'none', worktree: 'none' };
};

beforeEach(() => {
    opened = [];
    vi.spyOn(openEffects, 'openUrl').mockImplementation((url) => {
        opened.push(url);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stop?.();
    store.dispose();
    vi.restoreAllMocks();
});

describe('the menu of Fetch, Pull and Push in the sidebar', () => {
    it('says where the branch stands against its upstream, and lists Fetch, Pull and Publish for a branch that is not on origin, Pull off with the reason', async () => {
        await start();

        expect(originRow().textContent).toContain('Not published');
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual(['Fetch', 'PullNot published yet', 'Publish']);
        expect(isOff('Fetch')).toBe(false);
        expect(isOff('Pull')).toBe(true);
        expect(isOff('Publish')).toBe(false);
    });

    it('publishes the branch, says so, and then lists Push, with the row naming the upstream it has', async () => {
        await start();

        const push = vi.spyOn(transport, 'pushGit');

        await openMenu();
        await press(item('Publish'));
        await settle();
        await settle();

        expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' });
        expect(status()?.textContent).toBe('Published to origin');
        expect(originRow().textContent).toContain('origin/clowdy/ab12cd34');
        expect(originRow().textContent).toContain('up to date');

        await openMenu();
        expect(items().map(candidate => candidate.textContent)).toEqual(['Fetch', 'PullNothing to pull', 'PushNothing to push']);
    });

    it('reads the place again after an action, so the counts and the pull request are the ones it left', async () => {
        await start({ gitWrites: { remote: 'behind' } });

        const reads = { status: vi.spyOn(transport, 'getGitStatus'), pullRequest: vi.spyOn(transport, 'getGitPullRequest') };

        expect(originRow().textContent).toContain('2 behind');
        await openMenu();
        expect(items().map(candidate => candidate.textContent)).toEqual(['Fetch', 'Pull2', 'PushNothing to push']);
        await press(item('Pull'));
        await settle();
        await settle();

        expect(reads.status).toHaveBeenCalled();
        expect(reads.pullRequest).toHaveBeenCalled();
        expect(status()?.textContent).toBe('Pulled 2 commits');
        expect(originRow().textContent).toContain('up to date');
    });

    it('turns Pull and Push off for a branch that diverged, says it in the row, and sends nothing when they are pressed', async () => {
        await start({ gitWrites: { remote: 'diverged' } });

        const pull = vi.spyOn(transport, 'pullGit');
        const push = vi.spyOn(transport, 'pushGit');

        expect(originRow().textContent).toContain('diverged');
        await openMenu();
        expect(isOff('Pull')).toBe(true);
        expect(isOff('Push')).toBe(true);
        expect(item('Pull').textContent).toContain('Diverged: 1 ahead, 2 behind');
        await press(item('Pull'));
        await press(item('Push'));
        expect(pull).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
    });

    it('says a pull that found the branch diverged as a warning, and leaves it as it was', async () => {
        await start({ gitWrites: { remote: 'behind' } });
        vi.spyOn(transport, 'pullGit').mockResolvedValue({ state: 'diverged', upstream: { name: 'origin/clowdy/ab12cd34', ahead: 1, behind: 3 } } satisfies GitRemoteResult);

        await openMenu();
        await press(item('Pull'));
        await settle();

        expect(status()?.textContent).toBe('Diverged: 1 ahead, 3 behind, left as it was');
        expect(alert()).toBeNull();
    });

    it('shows git\'s own line when an action fails, selectable, with the hint under it, and goes when the person acts again', async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await openMenu();
        await press(item('Push'));
        await settle();
        await settle();

        expect(alert()?.textContent).toContain('error: No private key found for public key');
        expect(alert()?.textContent).toContain('The signing agent couldn\'t be reached');

        await openMenu();
        await press(item('Fetch'));
        await settle();
        await settle();
        expect(alert()).toBeNull();
        expect(status()?.textContent).toBe('Fetched origin');
    });

    it('shows a push that origin rejected by its line, and keeps the branch as it was', async () => {
        await start({ gitWrites: { remote: 'rejected' } });
        await openMenu();
        expect(item('Push').textContent).toContain('1');
        await press(item('Push'));
        await settle();
        await settle();

        expect(alert()?.textContent).toBe('! [rejected] clowdy/ab12cd34 -> clowdy/ab12cd34 (fetch first)');
        expect(originRow().textContent).toContain('1 ahead');
    });

    it('says what it is doing while an action runs, holds the others, and goes back when it ends', async () => {
        await start();

        let release: () => void = () => undefined;

        vi.spyOn(transport, 'fetchGit').mockImplementation(() => new Promise((resolve) => {
            release = () => resolve({ state: 'done', action: 'fetch' });
        }));
        await openMenu();
        await press(item('Fetch'));

        expect(originRow().getAttribute('aria-label')).toBe('Fetching origin');
        expect(originRow().textContent).toContain('Fetching origin');
        expect(originRow().hasAttribute('data-pending')).toBe(true);

        release();
        await settle();
        await settle();
        expect(originRow().getAttribute('aria-label')).toMatch(/^Origin: /);
        expect(status()?.textContent).toBe('Fetched origin');
    });

    it('lists every action off with the reason when there is no origin', async () => {
        await start();

        const read = transport.getGitStatus.bind(transport);

        vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
            const value = await read(...args);

            return value.isRepository ? { ...value, origin: false } : value;
        });
        gitFactsOf(transport).refresh(WORKTREE);
        await settle();
        await settle();
        await openMenu();

        expect(items().map(candidate => candidate.textContent)).toEqual(['FetchNo origin', 'PullNo origin', 'PublishNo origin']);
        expect(items().every(candidate => candidate.getAttribute('aria-disabled') === 'true')).toBe(true);
    });

    it('is the menu of a folder\'s own checkout too, level with its upstream', async () => {
        await start({ key: CHECKOUT });

        expect(originRow().textContent).toContain('origin/main');
        expect(originRow().textContent).toContain('up to date');
    });
});

describe('Create PR in the sidebar', () => {
    it('is the pull request chip while the branch has one, and no button', async () => {
        await start();

        expect(container.querySelector('[aria-label="Pull request"]')?.textContent).toContain('PR #128');
        expect(buttonOf('Create PR')).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });

    it('says Publish first for a branch that is not on origin, publishes it on a press, and then opens the compare page against the base of the Changes tab', async () => {
        await start({ tweak: noPullRequest });

        expect(buttonOf('Create PR')).toBeUndefined();
        expect(buttonOf('Publish first')?.disabled).toBe(false);

        await press(buttonOf('Publish first')!);
        await settle();
        await settle();

        // The branch is on origin now, and nothing was opened: the page is the second step.
        expect(opened).toEqual([]);
        expect(buttonOf('Publish first')).toBeUndefined();
        expect(buttonOf('Create PR')?.disabled).toBe(false);

        await press(buttonOf('Create PR')!);
        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it('never opens the page for a branch GitHub does not have: a failed publish leaves it where it was, with git\'s line', async () => {
        await start({ tweak: noPullRequest });
        vi.spyOn(transport, 'pushGit').mockRejectedValue(new TransportError('git@github.com: Permission denied (publickey).', 409));
        await press(buttonOf('Publish first')!);
        await settle();
        await settle();

        expect(opened).toEqual([]);
        expect(buttonOf('Publish first')).toBeDefined();
        expect(alert()?.textContent).toBe('git@github.com: Permission denied (publickey).');
    });

    it('says Push first for a branch with commits that are not on origin', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'signing' } });

        expect(buttonOf('Push first')).toBeDefined();
        expect(buttonOf('Create PR')).toBeUndefined();
    });

    it('opens the page for a branch that is level with its upstream, or only behind it', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'behind' } });
        await press(buttonOf('Create PR')!);

        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it('is off, with the reason, for a branch that diverged', async () => {
        await start({ tweak: noPullRequest, gitWrites: { remote: 'diverged' } });

        expect(buttonOf('Create PR')?.disabled).toBe(true);
        await press(buttonOf('Create PR')!);
        expect(opened).toEqual([]);
    });

    it('is off, with "Switch to a feature branch", on the folder\'s own checkout, which is on the branch the work is compared with', async () => {
        await start({ tweak: noPullRequest, key: CHECKOUT });

        expect(buttonOf('Create PR')?.disabled).toBe(true);
        await press(buttonOf('Create PR')!);
        expect(opened).toEqual([]);
    });

    it('is the page of a GitHub Enterprise server the person is signed in to, and nothing for another site', async () => {
        await start({ tweak: (data) => {
            noPullRequest(data);
            data.git[CAR_RENTAL] = { ...data.git[CAR_RENTAL], remoteUrl: 'git@ghe.example.com:team/service.git' };
        }, gitWrites: { remote: 'behind' } });

        await press(buttonOf('Create PR')!);
        expect(opened).toEqual(['https://ghe.example.com/team/service/compare/main...clowdy/ab12cd34?expand=1']);

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        // `gh` is signed in only to the GitHub hosts: for another site it says it is not.
        await start({ tweak: (data) => {
            data.pullRequests[CAR_RENTAL] = { checkout: 'none', worktree: 'not_signed_in' };
            data.git[CAR_RENTAL] = { ...data.git[CAR_RENTAL], remoteUrl: 'git@gitlab.com:acme/app.git' };
        }, gitWrites: { remote: 'behind' } });

        expect(buttonOf('Create PR')).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });

    it('is not drawn for a folder with no remote', async () => {
        await start({ tweak: (data) => {
            noPullRequest(data);
            delete data.git[CAR_RENTAL]!.remoteUrl;
        } });

        expect(buttonOf('Create PR')).toBeUndefined();
        expect(buttonOf('Publish first')).toBeUndefined();
    });
});
