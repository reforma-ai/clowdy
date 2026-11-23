// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, FIXTURE_WORKSPACE_CHAT_ID, fixtureGitChanges, fixtureGitPullRequest, withFixtureWorkspace, type FixtureData, type FixturePullRequestScript } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { gitFactsOf } from '../changes/gitFacts';
import { GitStrip } from './GitStrip';

import type { GitChanges, GitPullRequestInfo, Run } from '@clowdy/protocol';
import type { KeyValueStorage } from '../../stores/storage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The strip over the message box. `c-3` works in Car Rental's own checkout (on `main`, clean, level with `origin/main`), and the chat of `withFixtureWorkspace` in its worktree (two
 * commits ahead of the base, a file edited and one that is new, an open pull request #128 whose checks are one failing, two pending, three passing and one skipped).
 * The test build has no MobX observer plugin, so the view is drawn again by hand once the reads have come.
 */

const CHECKOUT_CHAT_ID = 'c-3';
const CAR_RENTAL = '/Users/dev/car-rental';

const memoryStorage = (): KeyValueStorage => {
    const data: Record<string, string> = {};

    return { getItem: key => data[key] ?? null, setItem: (key, value) => void (data[key] = value) };
};

const Strip = observer(GitStrip);

let container: HTMLDivElement;
let reactRoot: Root;
let store: RootStore;
let transport: FixtureTransport;

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

/** Starts the store on the fixtures, with `tweak` having its say about them first. */
async function start(tweak?: (data: FixtureData) => void) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);
    transport = new FixtureTransport({ data });
    store = new RootStore(transport, { storage: memoryStorage() });
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);
}

const chatOf = (id: string) => store.selectedProject!.chats.get(id)!;
const runOf = (id: string): Run | undefined => store.selectedProject!.runs.get(chatOf(id).orchestratorRunId ?? '');
const render = (chatId: string, run: Run | undefined = runOf(chatId)) => act(async () => {
    reactRoot.render(<RootStoreProvider value={ store }><Strip chat={ chatOf(chatId) } run={ run } /></RootStoreProvider>);
});

/** Draws the strip, then again once the reads have been answered. */
async function draw(chatId = FIXTURE_WORKSPACE_CHAT_ID, run?: Run) {
    await render(chatId, run);
    await settle();
    await settle();
    await render(chatId, run);
}

const strip = () => container.querySelector<HTMLElement>('[aria-label="Pull request and changes"]');
const chip = () => strip()?.querySelector<HTMLElement>('[aria-label="Pull request"]');
const checksButton = () => chip()?.querySelector<HTMLButtonElement>('button[aria-label^="Checks:"]');
const dot = () => checksButton()?.querySelector<HTMLElement>('[data-tone]')?.getAttribute('data-tone');
const text = () => strip()?.textContent;
const dirtyDot = () => strip()?.querySelector('[aria-label="Uncommitted changes"]');
const menuItems = () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];

/** The chat of the checkout with `script` as what `gh` says of its branch, and the chat's own `git` as `git` makes it. */
const withScript = (script: FixturePullRequestScript, git?: (data: FixtureData) => void) => (data: FixtureData) => {
    data.pullRequests[CAR_RENTAL] = { checkout: script, worktree: script };
    git?.(data);
};

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
});

afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
    vi.restoreAllMocks();
    store.dispose();
});

describe('the strip over the message box', () => {
    describe('a chat in a worktree with an open pull request', () => {
        it('shows the pull request, the size of the branch and that the tree is dirty', async () => {
            await start();
            await draw();

            expect(chip()?.textContent).toBe('PR #128Open');
            expect(strip()?.textContent).toContain('Files changed4+102−5');
            expect(dirtyDot()).not.toBeNull();
        });

        it('colours the numbers of the files as the tool cards do, and an open pull request\'s state as success', async () => {
            await start();
            await draw();

            const colours = (word: string) => [...strip()!.querySelectorAll('span')].find(span => span.textContent === word)?.className ?? '';

            expect(colours('+102')).toMatch(/success/);
            expect(colours('−5')).toMatch(/danger/);
            expect(colours('Open')).toMatch(/success/);
            expect(colours('Files changed')).not.toMatch(/success|danger/);
        });

        it('opens the pull request\'s own page in the browser from the chip', async () => {
            const open = vi.spyOn(window, 'open').mockReturnValue(null);

            await start();
            await draw();
            await press(chip()!.querySelector('button')!);

            expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/pull/128', '_blank', 'noopener');
        });

        it('has a dot for what the checks add up to, which is danger while one fails', async () => {
            await start();
            await draw();

            expect(dot()).toBe('danger');
            expect(checksButton()?.getAttribute('aria-label')).toBe('Checks: 1 failing, 2 pending, 3 passing, 1 skipped');
        });

        it('lists the checks read only, failing first, and opens a check\'s page from its row', async () => {
            const open = vi.spyOn(window, 'open').mockReturnValue(null);

            await start();
            await draw();
            await press(checksButton()!);
            await vi.waitFor(() => expect(menuItems().length).toBeGreaterThan(0));

            expect(menuItems().map(item => item.textContent)).toEqual([
                'unit (windows)Failing',
                'e2ePending',
                'unit (ubuntu)Pending',
                'ci/deploy-previewPassing',
                'lintPassing',
                'typecheckPassing',
                'docsSkipped',
            ]);
            // A check with no page of its own cannot be opened.
            expect(menuItems().at(-1)?.getAttribute('aria-disabled')).toBe('true');

            await press(menuItems()[0]!);

            expect(open).toHaveBeenCalledExactlyOnceWith('https://github.com/acme/car-rental/actions/runs/101/job/2', '_blank', 'noopener');
        });

        it('closes the list on Escape and gives the focus back to the dot', async () => {
            await start();
            await draw();
            await press(checksButton()!);
            await vi.waitFor(() => expect(menuItems().length).toBeGreaterThan(0));

            await act(async () => {
                document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
            await vi.waitFor(() => expect(menuItems()).toHaveLength(0));

            expect(document.activeElement).toBe(checksButton());
        });

        it('lists the checks of the pull request first when the daemon did not sort them', async () => {
            await start();
            vi.spyOn(transport, 'getGitPullRequest').mockImplementation(async () => {
                const info = fixtureGitPullRequest({ remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'x' }, { worktree: 'open' }, { branch: 'x' }) as Extract<GitPullRequestInfo, { isRepository: true }>;

                info.pullRequest!.checks.items.reverse();

                return info;
            });
            await draw();
            await press(checksButton()!);
            await vi.waitFor(() => expect(menuItems().length).toBeGreaterThan(0));

            expect(menuItems().map(item => item.textContent?.replace(/Failing|Pending|Passing|Skipped/, ''))[0]).toBe('unit (windows)');
            expect(menuItems().at(-1)?.textContent).toBe('docsSkipped');
        });
    });

    describe('the states of a pull request', () => {
        it.each<[FixturePullRequestScript, string, string, string]>([
            ['open', 'PR #128Open', 'danger', 'success'],
            ['draft', 'PR #54Draft', 'warning', 'secondary'],
            ['merged', 'PR #31Merged', 'success', 'secondary'],
            ['closed', 'PR #19Closed', 'danger', 'secondary'],
        ])('says %s in words, and colours only an open one', async (script, words, tone, state) => {
            await start(withScript(script));
            await draw();

            expect(chip()?.textContent).toBe(words);
            expect(dot()).toBe(tone);

            const stateSpan = [...chip()!.querySelectorAll('span')].find(span => span.textContent === words.replace(/^PR #\d+/, ''));

            expect(stateSpan?.className).toMatch(new RegExp(state === 'secondary' ? '^(?!.*(success|danger|warning))' : state));
        });

        it('has no dot when there are no checks', async () => {
            await start();
            vi.spyOn(transport, 'getGitPullRequest').mockImplementation(async () => {
                const info = fixtureGitPullRequest({ remoteUrl: 'git@github.com:acme/car-rental.git', branch: 'x' }, { worktree: 'open' }, { branch: 'x' }) as Extract<GitPullRequestInfo, { isRepository: true }>;

                info.pullRequest!.checks = { state: 'none', passing: 0, failing: 0, pending: 0, skipped: 0, items: [] };

                return info;
            });
            await draw();

            expect(chip()?.textContent).toBe('PR #128Open');
            expect(checksButton()).toBeNull();
        });

        it('has a dot that is only success when every check passed', async () => {
            await start(withScript('merged'));
            await draw(CHECKOUT_CHAT_ID);

            expect(dot()).toBe('success');
        });
    });

    describe('when GitHub cannot be asked', () => {
        it('says to sign in with gh for github.com, softly, as words and not as a button', async () => {
            await start(withScript('not_signed_in'));
            await draw(CHECKOUT_CHAT_ID);

            expect(text()).toBe('Sign in with gh');
            expect(strip()?.querySelector('button')).toBeNull();
        });

        it('names the host when it is another one', async () => {
            await start(withScript('not_signed_in', (data) => {
                data.git[CAR_RENTAL] = { remoteUrl: 'git@git.example.internal:acme/car-rental.git', branch: 'main' };
            }));
            await draw(CHECKOUT_CHAT_ID);

            expect(text()).toBe('gh isn\'t signed in to git.example.internal');
        });

        it('says gh is not installed when it is not', async () => {
            await start(withScript('no_gh'));
            await draw(CHECKOUT_CHAT_ID);

            expect(text()).toBe('Install gh to see pull requests');
        });

        it('keeps the hint beside the numbers of a branch that has work', async () => {
            await start(withScript('not_signed_in'));
            await draw();

            expect(chip()).toBeNull();
            expect(text()).toContain('Sign in with gh');
            expect(text()).toContain('Files changed4');
        });

        it('says nothing when the remote names no repository, or when gh could not read', async () => {
            await start(withScript('no_remote'));
            await draw(CHECKOUT_CHAT_ID);

            expect(strip()).toBeNull();

            act(() => reactRoot.unmount());
            store.dispose();
            reactRoot = createRoot(container);
            await start(withScript('unavailable'));
            await draw(CHECKOUT_CHAT_ID);

            expect(strip()).toBeNull();
        });
    });

    describe('nothing to say', () => {
        it('draws nothing for a folder that is not a repository', async () => {
            await start((data) => {
                delete data.git[CAR_RENTAL];
            });
            await draw(CHECKOUT_CHAT_ID);

            expect(strip()).toBeNull();
            expect(container.innerHTML).toBe('');
        });

        it('draws nothing for a branch with no pull request, no work and a clean tree', async () => {
            await start();
            await draw(CHECKOUT_CHAT_ID);

            expect(strip()).toBeNull();
        });

        it('has no Files changed when the base is not known, and says the tree is dirty and no more', async () => {
            await start();
            vi.spyOn(transport, 'getGitChanges').mockImplementation(async (): Promise<GitChanges> => ({ ...fixtureGitChanges({ branch: 'x' }, true, 'branch')!, baseState: 'no_base' } as GitChanges));
            vi.spyOn(transport, 'getGitPullRequest').mockResolvedValue({ isRepository: true, access: 'no_remote' });
            await draw();

            expect(text()).toBe('');
            expect(dirtyDot()).not.toBeNull();
        });

        it('draws a clean branch that has work with the numbers and no dirty dot', async () => {
            await start();
            const base = transport.getGitStatus.bind(transport);

            vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
                const status = await base(...args);

                return status.isRepository ? { ...status, entries: [] } : status;
            });
            await draw();

            expect(text()).toContain('Files changed4');
            expect(dirtyDot()).toBeNull();
        });

        it('draws a dirty tree on a branch that has no work, as a dot alone', async () => {
            await start();
            const base = transport.getGitStatus.bind(transport);

            vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
                const status = await base(...args);

                return status.isRepository ? { ...status, entries: [{ path: 'notes.md', untracked: true }] } : status;
            });
            await draw(CHECKOUT_CHAT_ID);

            expect(text()).toBe('');
            expect(dirtyDot()).not.toBeNull();
        });

        it('draws nothing for a worktree that is not made yet', async () => {
            await start((data) => {
                const chat = data.chats.find(candidate => candidate.id === FIXTURE_WORKSPACE_CHAT_ID)!;

                chat.workspace = { ...chat.workspace!, ready: false };
            });
            const read = vi.spyOn(transport, 'getGitStatus');

            await draw();

            expect(strip()).toBeNull();
            expect(read).not.toHaveBeenCalled();
        });
    });

    describe('while it loads', () => {
        it('draws nothing until the first answer, then draws the row, and nothing of another place meanwhile', async () => {
            await start();

            let answer: (() => void) | undefined;
            const held = new Promise<void>((resolve) => {
                answer = resolve;
            });
            const statusRead = transport.getGitStatus.bind(transport);

            vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
                await held;

                return statusRead(...args);
            });
            await render(FIXTURE_WORKSPACE_CHAT_ID);
            await settle();

            expect(strip()).toBeNull();

            // The answer comes: the row is there.
            answer?.();
            await settle();
            await settle();
            await render(FIXTURE_WORKSPACE_CHAT_ID);

            expect(chip()?.textContent).toBe('PR #128Open');
        });

        it('never shows the pull request of the chat that was open before, while the next chat\'s place has not answered', async () => {
            await start();
            await draw();
            expect(chip()).not.toBeNull();

            let answer: (() => void) | undefined;
            const held = new Promise<void>((resolve) => {
                answer = resolve;
            });
            const statusRead = transport.getGitStatus.bind(transport);

            vi.spyOn(transport, 'getGitStatus').mockImplementation(async (...args) => {
                await held;

                return statusRead(...args);
            });
            await render(CHECKOUT_CHAT_ID);
            await settle();

            expect(strip()).toBeNull();

            answer?.();
            await settle();
            await render(CHECKOUT_CHAT_ID);

            expect(strip()).toBeNull();
        });

        it('shows the row at once, from what was read, for a place that was on show a moment ago', async () => {
            await start();
            await draw();
            await act(async () => reactRoot.unmount());
            reactRoot = createRoot(container);
            await render(FIXTURE_WORKSPACE_CHAT_ID);

            expect(chip()?.textContent).toBe('PR #128Open');
        });
    });

    describe('reading again', () => {
        it('reads the place again when the chat\'s run ends, and not before', async () => {
            await start();

            const busy = { ...runOf('c-1')!, status: 'running' as const };
            const atRest = { ...busy, status: 'succeeded' as const };

            await draw(FIXTURE_WORKSPACE_CHAT_ID, busy);

            const read = vi.spyOn(transport, 'getGitStatus');

            await render(FIXTURE_WORKSPACE_CHAT_ID, { ...busy, summary: 'still going' });
            expect(read).not.toHaveBeenCalled();

            await new Promise(resolve => setTimeout(resolve, 0));
            await render(FIXTURE_WORKSPACE_CHAT_ID, atRest);
            await settle();

            expect(read).toHaveBeenCalledTimes(1);

            // A run that is at rest and stays so is not a reason to read.
            await render(FIXTURE_WORKSPACE_CHAT_ID, { ...atRest, summary: 'done' });
            await settle();

            expect(read).toHaveBeenCalledTimes(1);
        });

        it('draws the pull request dimmed from the last answer when the newest read of it failed, and plain again when one succeeds', async () => {
            await start();
            await draw();

            const { folderId, id: workspaceId } = chatOf(FIXTURE_WORKSPACE_CHAT_ID).workspace!;
            const place = { projectId: FIXTURE_PROJECT_ID, folderId, workspaceId };
            const read = vi.spyOn(transport, 'getGitPullRequest').mockRejectedValue(new TransportError('GitHub didn\'t answer', 503));
            // A new object for the same run, since the test build draws a changed prop again and nothing more.
            const again = () => render(FIXTURE_WORKSPACE_CHAT_ID, { ...runOf(FIXTURE_WORKSPACE_CHAT_ID)! });

            expect(chip()?.hasAttribute('data-stale')).toBe(false);

            gitFactsOf(transport).refresh(place);
            await settle();
            await again();

            expect(chip()?.textContent).toBe('PR #128Open');
            expect(chip()?.hasAttribute('data-stale')).toBe(true);

            read.mockRestore();
            gitFactsOf(transport).refresh(place);
            await settle();
            await again();

            expect(chip()?.hasAttribute('data-stale')).toBe(false);
        });

        it('shares one read with everything else that observes the place', async () => {
            await start();

            const read = vi.spyOn(transport, 'getGitStatus');
            const place = { projectId: FIXTURE_PROJECT_ID, folderId: chatOf(FIXTURE_WORKSPACE_CHAT_ID).workspace!.folderId, workspaceId: chatOf(FIXTURE_WORKSPACE_CHAT_ID).workspace!.id };
            const stop = gitFactsOf(transport).observe(place);

            await draw();

            expect(read).toHaveBeenCalledTimes(1);
            stop();
        });
    });
});
