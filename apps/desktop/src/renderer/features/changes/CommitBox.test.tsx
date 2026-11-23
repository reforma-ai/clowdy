// @vitest-environment happy-dom
import { observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createFixtureData,
    FIXTURE_PERSONAL_PROJECT_ID,
    FIXTURE_PROJECT_ID,
    type FixtureData,
    withFixtureWorkspace,
} from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { type Transport, TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openEffects } from '../openWith';
import { CommitBox } from './CommitBox';
import { CommitDraft, commitDraftOf } from './CommitDraft';
import { type GitPlaceKey, gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { type RemoteOutcome, remoteActionsOf } from './RemoteActions';

import type { GitChangedFile, GitStatus } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';
import type { Place } from '../sidePanel/currentPlace';
import type { RemoteActionId } from './changesActions';
import type { PlaceChanges } from './PlaceChanges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
const PLACE = { folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };

// The babel plugin that makes the app's components observers does not run under Vitest: the box is one here, to follow the model it reads.
const Box = observer(CommitBox);

let container: HTMLDivElement;
let root: Root;
let store: RootStore;
let transport: FixtureTransport;
let model: PlaceChanges;
let stop: () => void;

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

const box = () => container.querySelector('[aria-label="Commit"]');
const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const tickOf = (path: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${path}"]`)!;
const everyTick = () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Tick every file"]')!;
const message = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
const buttonOf = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === label
    );
/** The Commit button, which names the files and the branch (`Commit 3 files to clowdy/ab12cd34`). */
const commitButton = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate =>
        candidate.textContent?.trim().startsWith('Commit')
    );
const alert = () => container.querySelector('[role="alert"]');

async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message(), text);
        message().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** A place in a worktree with three uncommitted files, on the fixtures, the box drawn once the files were read. */
async function start({
    tweak,
    gitWrites,
    key = KEY,
}: {
    tweak?: (data: FixtureData) => void;
    gitWrites?: FixtureGitWritesOptions;
    key?: GitPlaceKey;
} = {}) {
    const data = withFixtureWorkspace(createFixtureData());

    tweak?.(data);
    transport = new FixtureTransport({ data, gitWrites });
    store = new RootStore(transport);
    await store.load();
    store.selectProject(FIXTURE_PROJECT_ID);

    const facts = gitFactsOf(transport);

    stop = facts.observe(key);
    model = placeChangesOf(transport, facts.of(key));
    await settle();
    await draw();
}

/** The place the box is drawn for: the folder's checkout, or the chat's worktree. */
function placeOf(key: GitPlaceKey): Place {
    const project = store.selectedProject!;
    const folder = project.project.folders.find(candidate => candidate.id === key.folderId)!;

    return key.workspaceId ? { folder, workspace: project.chats.get('c-9')!.workspace! } : { folder };
}

async function draw() {
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Box
                    model={model}
                    place={placeOf(model.facts.key)}
                    projectId={FIXTURE_PROJECT_ID}
                    git={{ remoteUrl: 'git@github.com:acme/car-rental.git' }}
                />
            </RootStoreProvider>
        )
    );
    await settle();
    await settle();
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stop?.();
    store.dispose();
});

describe('the commit box', () => {
    it('lists the uncommitted files with every one ticked, whatever scope the tab shows, and has a message box and the two buttons', async () => {
        await start();

        expect(model.effectiveScope).toBe('all');
        expect(checkboxes().filter(tick => tick.checked)).toHaveLength(4);
        expect(tickOf('notes.md').checked).toBe(true);
        expect(tickOf('src/booking/price.ts').checked).toBe(true);
        expect(tickOf('src/limits.ts').checked).toBe(true);
        expect(box()?.textContent).toContain('3 of 3');
        expect(message().placeholder).toBe('Message');
        expect(commitButton()?.disabled).toBe(true);
        // Offered because the fixtures' Codex is signed in with Commit messages on.
        expect(buttonOf('Generate')?.disabled).toBe(false);
    });

    it('commits only the files that are ticked, with the message as typed, clears the box, and reads the place again', async () => {
        await start();

        const commit = vi.spyOn(transport, 'commitGit');
        const reads = vi.spyOn(transport, 'getGitChanges');

        await press(tickOf('src/limits.ts'));
        expect(box()?.textContent).toContain('2 of 3');
        await type('fix(booking): add the surcharge\n\nWith a body');
        expect(commitButton()?.disabled).toBe(false);

        reads.mockClear();
        await press(commitButton()!);
        await settle();

        expect(commit).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            PLACE,
            ['notes.md', 'src/booking/price.ts'],
            'fix(booking): add the surcharge\n\nWith a body'
        );
        expect(message().value).toBe('');
        // The place is read again, and the files that went are not listed any more; the one that was not ticked is still there, ticked as any file of the list is.
        expect(reads).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, 'uncommitted');
        expect(
            checkboxes()
                .filter(tick => tick.getAttribute('aria-label') !== 'Tick every file')
                .map(tick => tick.getAttribute('aria-label'))
        ).toEqual(['src/limits.ts']);
        expect(tickOf('src/limits.ts').checked).toBe(false);
        expect(container.textContent).toContain('Committed c0ffee0');
    });

    it('writes a message for the ticked files into an empty box, and replaces it only while it is what Generate wrote', async () => {
        await start();

        const generate = vi.spyOn(transport, 'generateGitMessage');

        await press(tickOf('notes.md'));
        await press(buttonOf('Generate')!);
        await settle();

        expect(generate).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, ['src/booking/price.ts', 'src/limits.ts']);
        expect(message().value).toBe('feat(booking): add the weekend surcharge');
        // What Generate wrote may be written again.
        expect(buttonOf('Generate')?.disabled).toBe(false);

        // What the person typed is theirs: the button waits, and says why.
        await type('feat(booking): my own words');
        expect(buttonOf('Generate')?.disabled).toBe(true);

        await press(buttonOf('Generate')!);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(message().value).toBe('feat(booking): my own words');

        await type('');
        expect(buttonOf('Generate')?.disabled).toBe(false);
    });

    it('keeps what is put in the box while a message is being written, and holds the buttons meanwhile', async () => {
        let release: () => void = () => undefined;

        await start();
        vi.spyOn(transport, 'generateGitMessage').mockImplementation(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ message: 'feat: generated' });
                })
        );

        await press(buttonOf('Generate')!);
        expect(buttonOf('Generate')?.disabled).toBe(true);
        expect(commitButton()?.disabled).toBe(true);
        expect(message().placeholder).toBe('Writing the message');

        // The box is read only while the agent works; a text that gets in by another way is the person's, and stays.
        act(() =>
            commitDraftOf(
                model,
                transport,
                () => undefined,
                remoteActionsOf(model.facts, transport, () => undefined)
            ).setMessage('typed meanwhile')
        );
        release();
        await settle();
        await draw();

        expect(message().value).toBe('typed meanwhile');
        expect(commitButton()?.disabled).toBe(false);
    });

    it('leaves the box as it was and says so when the message could not be written', async () => {
        await start({ gitWrites: { message: 'failed' } });
        await press(buttonOf('Generate')!);
        await settle();

        expect(message().value).toBe('');
        expect(alert()?.textContent).toBe("Couldn't write the message");
        expect(buttonOf('Generate')?.disabled).toBe(false);

        // The line goes when the person acts again.
        await type('x');
        expect(alert()).toBeNull();
    });

    it('does not commit with Enter alone, which is a new line', async () => {
        await start();

        const commit = vi.spyOn(transport, 'commitGit');

        await type('chore: notes');
        await act(async () => {
            message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(commit).not.toHaveBeenCalled();
    });

    it.each(['metaKey', 'ctrlKey'] as const)(
        'commits with Enter and the %s held in the message box',
        async modifier => {
            await start();

            const commit = vi.spyOn(transport, 'commitGit');
            const push = vi.spyOn(transport, 'pushGit');

            await type('chore: notes');
            await act(async () => {
                message().dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true })
                );
            });
            await settle();

            expect(commit).toHaveBeenCalledWith(
                FIXTURE_PROJECT_ID,
                PLACE,
                ['notes.md', 'src/booking/price.ts', 'src/limits.ts'],
                'chore: notes'
            );
            // The shortcut is Commit and no more: the branch is sent only from the menu's entry.
            expect(push).not.toHaveBeenCalled();
        }
    );

    it("shows git's own line with the hint when the signing agent could not be reached, keeps the box and the ticks, and commits when it is tried again", async () => {
        await start({ gitWrites: { commit: 'signing' } });
        await press(tickOf('notes.md'));
        await type('feat: add');
        await press(commitButton()!);
        await settle();

        expect(alert()?.textContent).toContain('error: No private key found for public key');
        expect(alert()?.textContent).toContain("The signing agent couldn't be reached");
        expect(message().value).toBe('feat: add');
        expect(tickOf('notes.md').checked).toBe(false);
        expect(commitButton()?.disabled).toBe(false);
    });

    it("shows a hook's line without a hint", async () => {
        await start({ gitWrites: { commit: 'hook' } });
        await type('feat: add');
        await press(commitButton()!);
        await settle();

        expect(alert()?.textContent).toBe('pre-commit: 2 problems in src/limits.ts');
    });

    it("commits nothing and writes nothing with no file ticked, and ticks every file again from the box's own tick", async () => {
        await start();
        await type('feat: add');
        await press(everyTick());

        expect(box()?.textContent).toContain('0 of 3');
        expect(commitButton()?.disabled).toBe(true);
        expect(buttonOf('Generate')?.disabled).toBe(true);

        await press(tickOf('notes.md'));
        expect(everyTick().indeterminate).toBe(true);
        expect(commitButton()?.disabled).toBe(false);

        await press(everyTick());
        expect(checkboxes().every(tick => tick.checked)).toBe(true);
    });

    it('has no Generate button while no agent has Commit messages on and is signed in', async () => {
        await start({
            tweak: data => {
                const codex = data.agents.find(agent => agent.id === 'codex')!;

                codex.settings = codex.settings!.map(setting => ({ ...setting, value: false }));
            },
        });

        expect(buttonOf('Generate')).toBeUndefined();
        expect(commitButton()).toBeDefined();
    });

    it('has the Generate button while Claude Code alone has Commit messages on and is signed in, and not once it is off too', async () => {
        const setting = (data: FixtureData, id: string, value: boolean) => {
            const agent = data.agents.find(candidate => candidate.id === id)!;

            agent.settings = agent.settings!.map(entry => (entry.id === 'commitMessage' ? { ...entry, value } : entry));
        };

        await start({
            tweak: data => {
                setting(data, 'codex', false);
                setting(data, 'claude', true);
            },
        });
        expect(buttonOf('Generate')).toBeDefined();

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({
            tweak: data => {
                setting(data, 'codex', false);
                setting(data, 'claude', true);
                data.agents.find(agent => agent.id === 'claude')!.signIn = { status: 'signed-out', checkedAt: 1 };
            },
        });
        expect(buttonOf('Generate')).toBeUndefined();
    });

    it('has no Generate button for an agent that is signed out', async () => {
        await start({
            tweak: data => {
                data.agents.find(agent => agent.id === 'codex')!.signIn = { status: 'signed-out', checkedAt: 1 };
            },
        });

        expect(buttonOf('Generate')).toBeUndefined();
    });

    it('says that the list holds only the first files when the daemon cut it, since the rest cannot be ticked', async () => {
        const original = FixtureTransport.prototype.getGitChanges;
        const cut = vi.spyOn(FixtureTransport.prototype, 'getGitChanges').mockImplementation(async function (
            this: FixtureTransport,
            ...args: Parameters<typeof original>
        ) {
            const changes = await original.apply(this, args);

            return changes.isRepository && args[2] === 'uncommitted'
                ? { ...changes, truncated: true as const }
                : changes;
        });

        try {
            await start();

            expect(box()?.textContent).toContain('Showing the first 3 files');
        } finally {
            cut.mockRestore();
        }
    });

    it('does not say so for a list that is whole', async () => {
        await start();

        expect(box()?.textContent).not.toContain('Showing the first');
    });

    it('says what the commit was when it took every file, and that there is nothing to commit for a place that is clean', async () => {
        await start();
        await press(buttonOf('Generate')!);
        await settle();
        await press(commitButton()!);
        await settle();
        await draw();

        expect(box()?.textContent).toContain('Committed c0ffee0');
        expect(box()?.textContent).toContain('No local changes');
        expect(checkboxes()).toHaveLength(0);
    });

    it("says there are no local changes in the folder's own checkout, which is clean", async () => {
        await start({ key: { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' } });

        expect(box()?.textContent).toContain('No local changes');
        expect(box()?.textContent).not.toContain('Nothing to commit');
    });

    it('draws nothing for a folder that is no repository', async () => {
        const personal = createFixtureData().projects.find(project => project.id === FIXTURE_PERSONAL_PROJECT_ID)!
            .folders[0]!;

        await start({ key: { projectId: FIXTURE_PERSONAL_PROJECT_ID, folderId: personal.id } });

        expect(box()).toBeNull();
    });

    it('keeps the ticks and the text for the place when the box is drawn again', async () => {
        await start();
        await press(tickOf('notes.md'));
        await type('feat: kept');

        act(() => root.unmount());
        root = createRoot(container);
        await draw();

        expect(tickOf('notes.md').checked).toBe(false);
        expect(message().value).toBe('feat: kept');
    });
});

describe('Commit & Push', () => {
    const more = () => container.querySelector<HTMLButtonElement>('button[aria-label="More ways to commit"]')!;
    const entry = () =>
        [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(item =>
            item.textContent?.includes('Commit & Push')
        );

    /** Opens the menu beside Commit. */
    async function openMenu() {
        await press(more());
        await settle();
    }

    it('is an entry of the menu beside Commit, which is off with no message, and commits and then publishes a branch that is not on origin', async () => {
        await start();

        expect(more().disabled).toBe(true);
        await type('feat: surcharge');
        expect(more().disabled).toBe(false);

        const commit = vi.spyOn(transport, 'commitGit');
        const push = vi.spyOn(transport, 'pushGit');

        await openMenu();
        expect(entry()?.getAttribute('aria-disabled')).not.toBe('true');
        await press(entry()!);
        await settle();
        await settle();

        expect(commit).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            PLACE,
            ['notes.md', 'src/booking/price.ts', 'src/limits.ts'],
            'feat: surcharge'
        );
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE);
        // Nothing was left to commit, so the box says what was done; the branch is on origin now.
        expect(box()?.textContent).toContain('Committed c0ffee0 and published');
        expect(alert()).toBeNull();
        expect(await transport.getGitStatus(FIXTURE_PROJECT_ID, PLACE)).toMatchObject({
            upstream: { name: 'origin/clowdy/ab12cd34', ahead: 0, behind: 0 },
        });
    });

    it('pushes, and does not publish, a branch that is on origin', async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await type('feat: surcharge');

        const push = vi.spyOn(transport, 'pushGit').mockResolvedValue({ state: 'done', action: 'push' });

        await openMenu();
        await press(entry()!);
        await settle();
        await settle();

        expect(push).toHaveBeenCalledTimes(1);
        expect(box()?.textContent).toContain('Committed c0ffee0 and pushed');
    });

    it("says the commit stands when the push fails, with git's own line, clears the box and leaves the branch to be pushed again", async () => {
        await start({ gitWrites: { remote: 'rejected' } });
        await type('feat: surcharge');
        await openMenu();
        await press(entry()!);
        await settle();
        await settle();

        expect(alert()?.textContent).toContain(
            'Committed c0ffee0, push failed: ! [rejected] clowdy/ab12cd34 -> clowdy/ab12cd34 (fetch first)'
        );
        // The commit was made and the box is clear, and the branch has the commit to push.
        expect(box()?.textContent).toContain('No local changes');
        expect(await transport.getGitStatus(FIXTURE_PROJECT_ID, PLACE)).toMatchObject({
            upstream: { ahead: 2, behind: 0 },
        });
        expect(gitFactsOf(transport).of(KEY).status.value).toMatchObject({ upstream: { ahead: 2 } });
    });

    it('shows the hint of the signing agent under the line of a push that failed on it', async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await type('feat: surcharge');
        await openMenu();
        await press(entry()!);
        await settle();
        await settle();

        expect(alert()?.textContent).toContain('Committed c0ffee0, push failed: error: No private key found');
        expect(alert()?.textContent).toContain("The signing agent couldn't be reached");
    });

    it('is not offered where the push after the commit would not be taken, and says why under the entry', async () => {
        await start({ gitWrites: { remote: 'diverged' } });
        await type('feat: surcharge');

        const commit = vi.spyOn(transport, 'commitGit');

        await openMenu();
        expect(entry()?.getAttribute('aria-disabled')).toBe('true');
        expect(entry()?.textContent).toContain('Diverged: 1 ahead, 2 behind');
        await press(entry()!);
        await settle();
        expect(commit).not.toHaveBeenCalled();
    });

    it('commits as Commit does when it is the Commit button that is pressed', async () => {
        await start();
        await type('feat: surcharge');

        const push = vi.spyOn(transport, 'pushGit');

        await press(commitButton()!);
        await settle();

        expect(push).not.toHaveBeenCalled();
        expect(box()?.textContent).toContain('Committed c0ffee0');
    });
});

describe('the commit button and the line under the box', () => {
    const reasonStop = () => container.querySelector<HTMLElement>('[role="button"][aria-disabled="true"]');

    it('names the files that are ticked and the branch: Commit 3 files to clowdy/ab12cd34, Commit 1 file to it, and Commit to it with none', async () => {
        await start();

        expect(commitButton()?.textContent).toBe('Commit 3 files to clowdy/ab12cd34');
        await press(tickOf('src/limits.ts'));
        expect(commitButton()?.textContent).toBe('Commit 2 files to clowdy/ab12cd34');
        await press(tickOf('notes.md'));
        expect(commitButton()?.textContent).toBe('Commit 1 file to clowdy/ab12cd34');
        await press(tickOf('src/booking/price.ts'));
        expect(commitButton()?.textContent).toBe('Commit to clowdy/ab12cd34');
    });

    it('cuts a long branch name in its middle and keeps the whole of it in the tooltip', async () => {
        await start({
            tweak: data => {
                data.chats.find(chat => chat.workspace)!.workspace!.branch =
                    'maksim-kachurin/feat/a-very-long-branch-name';
            },
        });

        expect(commitButton()?.textContent).toBe('Commit 3 files to maksim-kachu…branch-name');
    });

    it("says why it cannot be pressed in GitHub Desktop's words: the summary first, then the files", async () => {
        await start();

        const draft = commitDraftOf(
            model,
            transport,
            () => undefined,
            remoteActionsOf(model.facts, transport, () => undefined)
        );

        expect(commitButton()?.disabled).toBe(true);
        expect(draft.commitReason).toBe('A commit summary is required to commit');
        // The stop that stands for the disabled button carries the tooltip.
        expect(reasonStop()).not.toBeNull();
        expect(reasonStop()?.contains(commitButton()!)).toBe(true);
        // One tab stop that reads out what the button is, and the reason is its description.
        expect(reasonStop()?.getAttribute('tabindex')).toBe('0');
        expect(reasonStop()?.getAttribute('aria-label')).toBe('Commit 3 files to clowdy/ab12cd34');

        await type('feat: surcharge');
        expect(draft.commitReason).toBeUndefined();
        expect(commitButton()?.disabled).toBe(false);
        expect(reasonStop()).toBeNull();

        for (const path of ['notes.md', 'src/booking/price.ts', 'src/limits.ts']) await press(tickOf(path));
        expect(draft.commitReason).toBe('Select one or more files to commit');
        expect(commitButton()?.disabled).toBe(true);
        expect(reasonStop()).not.toBeNull();
    });

    it('says it is committing to the branch when that is the branch the work is compared with, and says nothing on a feature branch', async () => {
        await start();
        expect(box()?.textContent).not.toContain('Committing to');

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({
            tweak: data => {
                data.chats.find(chat => chat.workspace)!.workspace!.branch = 'main';
            },
        });

        expect(commitButton()?.textContent).toBe('Commit 3 files to main');
        expect(container.querySelector('[role="note"]')?.textContent).toBe('Committing to main, the base branch');
    });
});

describe('the empty box, No local changes', () => {
    const noPullRequest = (data: FixtureData) => {
        data.pullRequests['/Users/dev/car-rental'] = { checkout: 'none', worktree: 'none' };
    };
    const stepButton = () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Commit"] button[class*="stepButton"]');
    const quietButtons = () => [
        ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Commit"] button[class*="quietButton"]'),
    ];
    let opened: string[];

    beforeEach(() => {
        opened = [];
        vi.spyOn(openEffects, 'openUrl').mockImplementation(url => {
            opened.push(url);
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
        window.desktop = undefined;
    });

    it('has the title, and for a worktree that is not on origin the first step: Publish your branch, which publishes it', async () => {
        await start({ gitWrites: { clean: true } });

        expect(box()?.textContent).toContain('No local changes');
        expect(stepButton()?.textContent).toBe('Publish your branch');

        const push = vi.spyOn(transport, 'pushGit');

        await press(stepButton()!);
        await settle();
        await settle();

        expect(push).toHaveBeenCalledTimes(1);
        expect(await transport.getGitStatus(FIXTURE_PROJECT_ID, PLACE)).toMatchObject({
            upstream: { name: 'origin/clowdy/ab12cd34' },
        });
    });

    it('has Pull N commits from the origin remote for a branch that is behind, and a press pulls', async () => {
        await start({ gitWrites: { clean: true, remote: 'behind' } });

        expect(stepButton()?.textContent).toBe('Pull 2 commits from the origin remote');

        const pull = vi.spyOn(transport, 'pullGit');

        await press(stepButton()!);
        await settle();
        await settle();

        expect(pull).toHaveBeenCalledTimes(1);
        // What it pulled is said, and the step is the next one: nothing to pull, nothing to push, and the open pull request.
        expect(stepButton()).toBeNull();
    });

    it('has Push N commits to the origin remote for a branch that is ahead, and a press pushes', async () => {
        await start({ gitWrites: { clean: true, remote: 'ahead' } });

        expect(stepButton()?.textContent).toBe('Push 2 commits to the origin remote');

        const push = vi.spyOn(transport, 'pushGit');

        await press(stepButton()!);
        await settle();
        await settle();

        expect(push).toHaveBeenCalledTimes(1);
    });

    it('has Create a Pull Request from your current branch for a branch that is published and level and has none, which opens the compare page as Create PR does', async () => {
        await start({ tweak: noPullRequest, gitWrites: { clean: true, remote: 'level' } });

        expect(stepButton()?.textContent).toBe('Create a Pull Request from your current branch');
        await press(stepButton()!);
        expect(opened).toEqual(['https://github.com/acme/car-rental/compare/main...clowdy/ab12cd34?expand=1']);
    });

    it('has no step for a branch that has a pull request, one that diverged, and the base branch itself', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });
        expect(stepButton()).toBeNull();

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({ tweak: noPullRequest, gitWrites: { clean: true, remote: 'diverged' } });
        expect(stepButton()).toBeNull();

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({ tweak: noPullRequest, key: { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' } });
        expect(box()?.textContent).toContain('No local changes');
        expect(stepButton()).toBeNull();
    });

    it('holds the step while another action runs, and shows it working while its own does', async () => {
        await start({ gitWrites: { clean: true, remote: 'slow' } });

        let release: () => void = () => undefined;

        vi.spyOn(transport, 'pushGit').mockImplementation(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ state: 'done', action: 'push', published: true });
                })
        );
        await press(stepButton()!);
        expect(stepButton()?.hasAttribute('data-pending')).toBe(true);
        release();
        await settle();
        await settle();
    });

    it("has the repository on GitHub as a quiet way out, whatever the computer has, and the editor and the file manager where it has them, in the open menu's own words", async () => {
        const openPath = vi.fn(async () => undefined);

        window.desktop = {
            getOpenApps: async () => ({
                editors: [{ id: 'cursor', name: 'Cursor' }],
                terminals: [],
                fileManagers: [{ id: 'finder', name: 'Finder' }],
            }),
            openPath,
        } as never;
        await start({ gitWrites: { clean: true, remote: 'level' } });

        expect(quietButtons().map(button => button.textContent)).toEqual([
            'Open in Cursor',
            'Show in Finder',
            'Open in GitHub',
        ]);

        await press(quietButtons()[0]!);
        await press(quietButtons()[1]!);
        await press(quietButtons()[2]!);

        expect(openPath).toHaveBeenNthCalledWith(1, '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental', {
            kind: 'editor',
            id: 'cursor',
        });
        expect(openPath).toHaveBeenNthCalledWith(2, '/Users/dev/Clowdy/workspaces/car-rental/ab12cd34/car-rental', {
            kind: 'fileManager',
            id: 'finder',
        });
        expect(opened).toEqual(['https://github.com/acme/car-rental']);
    });

    it('has only what this computer has: no editor and no file manager in a page that is not the desktop app', async () => {
        await start({ gitWrites: { clean: true, remote: 'level' } });

        expect(quietButtons().map(button => button.textContent)).toEqual(['Open in GitHub']);
    });

    it('says what the last commit was above the step, and keeps the step after a commit that took every file', async () => {
        await start();
        await type('feat: surcharge');
        await press(commitButton()!);
        await settle();
        await settle();
        await draw();

        expect(box()?.textContent).toContain('No local changes');
        expect(box()?.textContent).toContain('Committed c0ffee0');
        expect(stepButton()?.textContent).toBe('Publish your branch');
    });
});

describe('a push that origin turned down for newer commits, after a commit', () => {
    it("has a Fetch origin button beside git's line, which fetches and takes the line away; the sidebar's button then says what to do", async () => {
        await start({ gitWrites: { remote: 'rejected' } });
        await type('feat: surcharge');
        await press(container.querySelector<HTMLButtonElement>('button[aria-label="More ways to commit"]')!);
        await settle();
        await press(
            [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(item =>
                item.textContent?.includes('Commit & Push')
            )!
        );
        await settle();
        await settle();

        const fetchButton = () =>
            [...container.querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
                candidate => candidate.textContent === 'Fetch origin'
            );

        expect(alert()?.textContent).toContain(
            'push failed: ! [rejected] clowdy/ab12cd34 -> clowdy/ab12cd34 (fetch first)'
        );
        expect(fetchButton()).toBeDefined();

        const fetch = vi.spyOn(transport, 'fetchGit');

        await press(fetchButton()!);
        await settle();
        await settle();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(alert()).toBeNull();
        expect(box()?.textContent).toContain('Committed c0ffee0');
    });

    it('has no Fetch origin button beside a push that failed for another cause', async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await type('feat: surcharge');
        await press(container.querySelector<HTMLButtonElement>('button[aria-label="More ways to commit"]')!);
        await settle();
        await press(
            [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(item =>
                item.textContent?.includes('Commit & Push')
            )!
        );
        await settle();
        await settle();

        expect(alert()?.textContent).toContain('push failed: error: No private key found');
        expect(alert()?.querySelector('button')).toBeNull();
    });
});

describe('the draft of a commit', () => {
    const file = (path: string): GitChangedFile => ({
        path,
        kind: 'modified',
        additions: 1,
        deletions: 0,
        revision: path,
    });

    /**
     * A draft over a list the test changes, and a transport that records what it is asked. The place is on a branch with an upstream, and its moves to origin are a stand-in whose
     * runs the test can see and make fail.
     */
    function draftOver(paths: string[], status: Partial<Extract<GitStatus, { isRepository: true }>> = {}) {
        const listed = observable({ files: paths.map(file) });
        const repository: GitStatus = {
            isRepository: true,
            head: { kind: 'branch', name: 'feature', commit: 'a'.repeat(40) },
            origin: true,
            entries: [],
            upstream: { name: 'origin/feature', ahead: 0, behind: 0 },
            base: { state: 'unborn' },
            ...status,
        };
        const fakeModel = {
            facts: { key: KEY, status: { value: repository } },
            get uncommitted() {
                return { isRepository: true as const, files: listed.files };
            },
        } as unknown as PlaceChanges;
        const commitGit = vi.fn(async (_project: string, _place: unknown, commitPaths: string[], text: string) => ({
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            subject: text,
            paths: commitPaths,
        }));
        const generateGitMessage = vi.fn(async () => ({ message: 'feat: written' }));
        const refresh = vi.fn();
        const remote = {
            busy: false,
            run: vi.fn(
                async (action: RemoteActionId, _options?: { report?: boolean }): Promise<RemoteOutcome> => ({
                    ok: true,
                    result: { state: 'done', action: action === 'publish' ? 'push' : action },
                })
            ),
        };
        const draft = new CommitDraft(
            fakeModel,
            { commitGit, generateGitMessage } as unknown as Pick<Transport, 'commitGit' | 'generateGitMessage'>,
            refresh,
            remote
        );

        return { draft, listed, commitGit, generateGitMessage, refresh, remote };
    }

    it('ticks a file that appears, and forgets an unticked file that goes, so it is ticked again when it comes back', () => {
        const { draft, listed } = draftOver(['a.ts', 'b.ts']);

        draft.setTicked('a.ts', false);
        expect(draft.ticked.map(entry => entry.path)).toEqual(['b.ts']);

        listed.files = ['a.ts', 'b.ts', 'c.ts'].map(file);
        expect(draft.ticked.map(entry => entry.path)).toEqual(['b.ts', 'c.ts']);

        listed.files = ['b.ts', 'c.ts'].map(file);
        draft.reconcile();
        listed.files = ['a.ts', 'b.ts', 'c.ts'].map(file);
        expect(draft.isTicked('a.ts')).toBe(true);
    });

    it("commits the ticked files in the list's order, refreshes the place after a commit and after one that failed, and keeps the message of the one that failed", async () => {
        const { draft, commitGit, refresh } = draftOver(['a.ts', 'b.ts', 'c.ts']);

        draft.setTicked('b.ts', false);
        draft.setMessage('feat: add');
        await draft.commit();

        expect(commitGit).toHaveBeenCalledWith(KEY.projectId, PLACE, ['a.ts', 'c.ts'], 'feat: add');
        expect(draft.message).toBe('');
        expect(draft.committed?.shortSha).toBe('aaaaaaa');
        expect(refresh).toHaveBeenCalledTimes(1);

        commitGit.mockRejectedValueOnce(new TransportError('lint failed', 409));
        draft.setMessage('feat: again');
        await draft.commit();

        expect(draft.message).toBe('feat: again');
        expect(draft.failure).toEqual({ what: 'commit', message: 'lint failed' });
        expect(draft.committed).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('sends the branch after the commit (a push when it is on origin, its publishing when it is not), and says so', async () => {
        const pushed = draftOver(['a.ts']);

        pushed.draft.setMessage('feat: add');
        await pushed.draft.commit(true);

        expect(pushed.remote.run).toHaveBeenCalledWith('push', { report: false });
        expect(pushed.draft.sent).toBe('push');
        expect(pushed.draft.failure).toBeUndefined();
        expect(pushed.draft.message).toBe('');
        expect(pushed.refresh).toHaveBeenCalledTimes(1);

        const published = draftOver(['a.ts'], { upstream: undefined });

        published.draft.setMessage('feat: add');
        await published.draft.commit(true);
        expect(published.remote.run).toHaveBeenCalledWith('publish', { report: false });
        expect(published.draft.sent).toBe('publish');

        // The line is about the last request: it goes with the next thing the person does.
        published.draft.setMessage('next');
        expect(published.draft.sent).toBeUndefined();
        expect(published.draft.committed).toBeUndefined();
    });

    it("says the commit was made and the push was not, with git's own line and its hint, keeps the commit, and refreshes the place", async () => {
        const { draft, remote, refresh, commitGit } = draftOver(['a.ts']);

        remote.run.mockResolvedValueOnce({
            ok: false,
            failure: { action: 'push', message: '! [rejected] main -> main (fetch first)', hint: 'Pull first' },
        });
        draft.setMessage('feat: add');
        await draft.commit(true);

        expect(commitGit).toHaveBeenCalledTimes(1);
        expect(draft.failure).toEqual({
            what: 'push',
            message: 'Committed aaaaaaa, push failed: ! [rejected] main -> main (fetch first)',
            hint: 'Pull first',
        });
        expect(draft.committed?.shortSha).toBe('aaaaaaa');
        expect(draft.sent).toBeUndefined();
        expect(draft.message).toBe('');
        expect(draft.busy).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does not push a commit that failed, and holds the box while the push is on its way', async () => {
        const failed = draftOver(['a.ts']);

        failed.commitGit.mockRejectedValueOnce(new TransportError('lint failed', 409));
        failed.draft.setMessage('feat: add');
        await failed.draft.commit(true);
        expect(failed.remote.run).not.toHaveBeenCalled();
        expect(failed.draft.failure).toEqual({ what: 'commit', message: 'lint failed' });

        const slow = draftOver(['a.ts']);
        let release: () => void = () => undefined;

        slow.remote.run.mockImplementationOnce(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ ok: true, result: { state: 'done', action: 'push' } });
                })
        );
        slow.draft.setMessage('feat: add');

        const running = slow.draft.commit(true);

        await Promise.resolve();
        await Promise.resolve();
        expect(slow.draft.busy).toBe('push');
        expect(slow.draft.writing).toBe(true);
        release();
        await running;
        expect(slow.draft.busy).toBeUndefined();
    });

    it('does not commit and push where the push would not be taken, and while another action of the place runs', async () => {
        const behind = draftOver(['a.ts'], { upstream: { name: 'origin/feature', ahead: 0, behind: 2 } });

        behind.draft.setMessage('feat: add');
        expect(behind.draft.pushBlock).toBe('2 commits to pull first');
        await behind.draft.commit(true);
        expect(behind.commitGit).not.toHaveBeenCalled();

        // A plain commit is still there.
        await behind.draft.commit();
        expect(behind.commitGit).toHaveBeenCalledTimes(1);

        const busy = draftOver(['a.ts']);

        busy.draft.setMessage('feat: add');
        expect(busy.draft.canCommitAndPush).toBe(true);
        busy.remote.busy = true;
        expect(busy.draft.pushBlock).toBe('An action is running');
        await busy.draft.commit(true);
        expect(busy.commitGit).not.toHaveBeenCalled();
    });

    it('does nothing when it may not: no message, nothing ticked, or while something is going on', async () => {
        const { draft, commitGit, generateGitMessage } = draftOver(['a.ts']);

        await draft.commit();
        expect(commitGit).not.toHaveBeenCalled();

        draft.setMessage('x');
        draft.setAll(false);
        await draft.commit();
        await draft.generate();
        expect(commitGit).not.toHaveBeenCalled();
        expect(generateGitMessage).not.toHaveBeenCalled();
        expect(draft.generateBlock).toBe('Tick a file first');

        draft.setAll(true);
        expect(draft.generateBlock).toBe('Clear the message to have one written');

        const running = draft.commit();

        // A second press while the first is on its way is nothing.
        await draft.commit();
        await running;
        expect(commitGit).toHaveBeenCalledTimes(1);
    });
});
