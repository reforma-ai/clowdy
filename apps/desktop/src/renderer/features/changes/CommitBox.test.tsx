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
import { CommitBox } from './CommitBox';
import { CommitDraft, commitDraftOf } from './CommitDraft';
import { type GitPlaceKey, gitFactsOf } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';
import { type RemoteOutcome, remoteActionsOf } from './RemoteActions';
import { sourceControlPreferences } from './sourceControlPreferences';

import type { GitChangedFile, GitStatus } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';
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
const press = (target: Element, shiftKey = false) =>
    act(async () => {
        target.dispatchEvent(
            new PointerEvent('pointerdown', {
                bubbles: true,
                pointerType: 'mouse',
                button: 0,
                isPrimary: true,
                shiftKey,
            })
        );
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey }));
        target.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true, shiftKey })
        );
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, shiftKey }));
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
    });

const box = () => container.querySelector('[aria-label="Commit"]');
const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const tickOf = (path: string) =>
    container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${path}"]`)!;
const everyTick = () =>
    container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Tick every file"]')!;
const message = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
const generateButton = () =>
    message().parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Generate commit message"]');
const stopButton = () =>
    message().parentElement?.querySelector<HTMLButtonElement>('button[aria-label="Stop generating commit message"]');
const buttonOf = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === label
    );
/** The Commit button, which counts the selected files. */
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

async function draw() {
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Box model={model} />
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
    sourceControlPreferences.setAutoPush(true);
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
        expect(generateButton()?.disabled).toBe(false);
    });

    it('asks the diff list to bring a file up on a press on its row, and ticks it only on its tick', async () => {
        await start();

        const row = tickOf('src/limits.ts').closest('[role="row"]')!;

        await press(row);
        expect(model.revealRequest).toBe('src/limits.ts');
        expect(tickOf('src/limits.ts').checked).toBe(true);
        expect(box()?.textContent).toContain('3 of 3');

        await press(tickOf('src/limits.ts'));
        expect(tickOf('src/limits.ts').checked).toBe(false);
        expect(box()?.textContent).toContain('2 of 3');
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
        expect(container.textContent).not.toContain('Committed c0ffee0');
    });

    it('writes a message for the ticked files into an empty box, and replaces it only while it is what Generate wrote', async () => {
        await start();

        const generate = vi.spyOn(transport, 'generateGitMessage');

        await press(tickOf('notes.md'));
        await press(generateButton()!);
        await settle();

        expect(generate).toHaveBeenCalledWith(
            FIXTURE_PROJECT_ID,
            PLACE,
            ['src/booking/price.ts', 'src/limits.ts'],
            expect.any(AbortSignal)
        );
        expect(message().value).toBe('feat(booking): add the weekend surcharge');
        // What Generate wrote may be written again.
        expect(generateButton()?.disabled).toBe(false);

        // What the person typed is theirs: the button waits, and says why.
        await type('feat(booking): my own words');
        expect(generateButton()?.disabled).toBe(true);

        await press(generateButton()!);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(message().value).toBe('feat(booking): my own words');

        await type('');
        expect(generateButton()?.disabled).toBe(false);
    });

    it('keeps what is put in the box while a message is being written, and holds Commit meanwhile', async () => {
        let release: () => void = () => undefined;

        await start();
        vi.spyOn(transport, 'generateGitMessage').mockImplementation(
            () =>
                new Promise(resolve => {
                    release = () => resolve({ message: 'feat: generated' });
                })
        );

        await press(generateButton()!);
        expect(stopButton()?.disabled).toBe(false);
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

    it('aborts generation and ignores its late answer while the next request is running', async () => {
        const first = Promise.withResolvers<{ message: string }>();
        const second = Promise.withResolvers<{ message: string }>();

        await start();
        const generate = vi
            .spyOn(transport, 'generateGitMessage')
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise);

        await press(generateButton()!);
        await press(stopButton()!);

        expect(generate.mock.calls[0]?.[3]?.aborted).toBe(true);
        expect(message().readOnly).toBe(false);
        expect(message().value).toBe('');
        expect(alert()).toBeNull();

        await press(generateButton()!);
        await act(async () => first.resolve({ message: 'feat: stale result' }));

        expect(stopButton()?.disabled).toBe(false);
        expect(message().value).toBe('');
        await act(async () => second.resolve({ message: 'feat: new result' }));
        expect(message().value).toBe('feat: new result');
    });

    it('leaves the box as it was and says so when the message could not be written', async () => {
        await start({ gitWrites: { message: 'failed' } });
        await press(generateButton()!);
        await settle();

        expect(message().value).toBe('');
        expect(alert()?.textContent).toBe("Couldn't write the message");
        expect(generateButton()?.disabled).toBe(false);

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
        'commits and pushes with Enter and the %s held in the message box',
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
            expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, {
                branch: 'clowdy/ab12cd34',
                commit: expect.stringMatching(/^[0-9a-f]{40}$/),
            });
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
        expect(generateButton()?.disabled).toBe(true);

        await press(tickOf('notes.md'));
        expect(everyTick().indeterminate).toBe(true);
        expect(commitButton()?.disabled).toBe(false);

        await press(everyTick());
        expect(checkboxes().every(tick => tick.checked)).toBe(true);
    });

    it('opens Source Control from Generate when the provider is off', async () => {
        await start({
            tweak: data => {
                const codex = data.agents.find(agent => agent.id === 'codex')!;

                codex.settings = codex.settings!.map(setting => ({ ...setting, value: false }));
            },
        });

        const generate = vi.spyOn(transport, 'generateGitMessage');

        await press(generateButton()!);

        expect([store.ui.settingsOpen, store.ui.settingsPage]).toEqual([true, 'source-control']);
        expect(generate).not.toHaveBeenCalled();
        expect(commitButton()).toBeDefined();
    });

    it('generates a message when Claude Code is the only provider with Commit messages on', async () => {
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
        await press(generateButton()!);
        await settle();

        expect(message().value).not.toBe('');
        expect(store.ui.settingsOpen).toBe(false);
    });

    it('opens Source Control from Generate when the selected provider is signed out', async () => {
        await start({
            tweak: data => {
                data.agents.find(agent => agent.id === 'codex')!.signIn = { status: 'signed-out', checkedAt: 1 };
            },
        });

        const generate = vi.spyOn(transport, 'generateGitMessage');

        await press(generateButton()!);

        expect([store.ui.settingsOpen, store.ui.settingsPage]).toEqual([true, 'source-control']);
        expect(generate).not.toHaveBeenCalled();
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

    it('keeps an editable message and a disabled commit button after committing every file', async () => {
        await start();
        await press(generateButton()!);
        await settle();
        await press(commitButton()!);
        await settle();
        await draw();

        expect(box()?.textContent).toContain('0 changed files');
        expect(box()?.textContent).not.toContain('Committed c0ffee0');
        expect(message().value).toBe('');
        expect(message().readOnly).toBe(false);
        expect(checkboxes()).toEqual([everyTick()]);
        expect(everyTick().disabled).toBe(true);
        expect(commitButton()?.textContent).toBe('Commit 0 files');
        expect(commitButton()?.disabled).toBe(true);
    });

    it('accepts a draft in a clean checkout and keeps the button and shortcut disabled', async () => {
        await start({ key: { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' } });
        const commit = vi.spyOn(transport, 'commitGit');

        expect(box()?.textContent).toContain('0 changed files');
        await type('Draft for the next change');
        expect(message().value).toBe('Draft for the next change');
        expect(commitButton()?.textContent).toBe('Commit 0 files');
        expect(commitButton()?.disabled).toBe(true);
        expect(generateButton()?.disabled).toBe(true);

        act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
        expect(commitButton()?.textContent).toBe('Commit 0 files');
        act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
        await act(async () => {
            message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
        });
        expect(commit).not.toHaveBeenCalled();
    });

    it('allows a resolved merge to finish without changed files', async () => {
        const readStatus = FixtureTransport.prototype.getGitStatus;
        const status = vi.spyOn(FixtureTransport.prototype, 'getGitStatus').mockImplementation(async function (
            this: FixtureTransport,
            ...args: Parameters<typeof readStatus>
        ) {
            const result = await readStatus.apply(this, args);

            return result.isRepository ? { ...result, merging: { conflicts: 0, subject: 'Merge main' } } : result;
        });

        try {
            await start({ key: { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' } });

            expect(box()?.textContent).toContain('No staged files');
            expect(message().value).toBe('Merge main');
            expect(buttonOf('Complete merge & Push')?.disabled).toBe(false);
        } finally {
            status.mockRestore();
        }
    });

    it('separates unmerged files from the index and prevents completing the merge until resolved', async () => {
        const read = FixtureTransport.prototype.getGitStatus;
        let resolved = false;
        let truncated = false;
        const status = vi.spyOn(FixtureTransport.prototype, 'getGitStatus').mockImplementation(async function (
            this: FixtureTransport,
            ...args: Parameters<typeof read>
        ) {
            const result = await read.apply(this, args);

            if (!result.isRepository) return result;

            if (truncated) {
                return {
                    ...result,
                    merging: { conflicts: 2, subject: 'Merge main' },
                    truncated: true,
                    entries: [{ path: 'src/limits.ts', unstaged: 'conflicted' }],
                };
            }

            return {
                ...result,
                merging: { conflicts: resolved ? 0 : 1, subject: 'Merge main' },
                entries: [
                    { path: 'notes.md', untracked: true },
                    { path: 'src/booking/price.ts', staged: 'modified' },
                    resolved
                        ? { path: 'src/limits.ts', staged: 'modified' }
                        : { path: 'src/limits.ts', unstaged: 'conflicted' },
                ],
            };
        });

        try {
            await start();
            const commit = vi.spyOn(transport, 'commitGit');
            const list = (label: string) => box()?.querySelector(`[role="grid"][aria-label="${label}"]`);
            const conflictTick = tickOf('src/limits.ts');
            const stagedTick = tickOf('src/booking/price.ts');
            const conflictRow = conflictTick.closest('[role="row"]')!;
            const stagedRow = stagedTick.closest('[role="row"]')!;

            expect(list('Conflicting files')?.contains(conflictRow)).toBe(true);
            expect(list('Files to commit')?.contains(stagedRow)).toBe(true);
            expect(list('Files to commit')?.textContent).not.toMatch(/limits\.ts|notes\.md/);
            expect(conflictRow.textContent).toContain('limits.ts');
            expect(box()?.querySelector('details')).toBeNull();
            expect(buttonOf('Abort merge')).toBeDefined();
            expect(checkboxes()).toHaveLength(3);
            expect(conflictTick.checked).toBe(false);
            expect(stagedTick.checked).toBe(true);
            await press(conflictTick);
            await press(stagedTick);
            expect(conflictTick.checked).toBe(false);
            expect(stagedTick.checked).toBe(true);
            await press(stagedRow);
            expect(model.revealRequest).toBe('src/booking/price.ts');
            await press(conflictRow);
            expect(model.effectiveScope).toBe('uncommitted');
            expect(model.revealRequest).toBe('src/limits.ts');
            await type('Merge both changes');
            expect(buttonOf('Complete merge')?.disabled).toBe(true);
            await act(async () => {
                message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
            });
            expect(commit).not.toHaveBeenCalled();

            truncated = true;
            act(() => gitFactsOf(transport).refresh(KEY));
            await settle();
            expect(box()?.textContent).toContain('1 of 2');
            expect(box()?.textContent).toContain('Showing merge files from the first 1 changed files');
            expect(box()?.textContent).not.toContain('No staged files');
            expect(buttonOf('Complete merge')?.disabled).toBe(true);

            truncated = false;
            resolved = true;
            act(() => gitFactsOf(transport).refresh(KEY));
            await settle();
            expect(list('Conflicting files')).toBeNull();
            expect(list('Files to commit')?.textContent).toContain('limits.ts');
            expect(tickOf('src/limits.ts').checked).toBe(true);
            expect(box()?.textContent).not.toContain('Conflicts resolved');
            expect(buttonOf('Abort merge')).toBeUndefined();
            expect(buttonOf('Complete merge & Push')?.disabled).toBe(false);
            const push = vi.spyOn(transport, 'pushGit');
            await press(buttonOf('Complete merge & Push')!);
            await settle();
            expect(commit).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, expect.any(Array), 'Merge both changes', {
                conclude: true,
            });
            expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, {
                branch: 'clowdy/ab12cd34',
                commit: expect.stringMatching(/^[0-9a-f]{40}$/),
            });
        } finally {
            status.mockRestore();
        }
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
        act(() => sourceControlPreferences.setAutoPush(false));
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
        expect(push).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, {
            branch: 'clowdy/ab12cd34',
            commit: expect.stringMatching(/^[0-9a-f]{40}$/),
        });
        expect(message().value).toBe('');
        expect(commitButton()?.textContent).toBe('Commit 0 files');
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
        expect(message().value).toBe('');
        expect(alert()).toBeNull();
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
        expect(message().value).toBe('');
        expect(commitButton()?.disabled).toBe(true);
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
        expect(entry()?.textContent).toContain('Pull first');
        await press(entry()!);
        await settle();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each(['Shift', 'menu'])('allows a one-time local commit through %s with automatic push on', async control => {
        await start();
        await type('feat: surcharge');

        const push = vi.spyOn(transport, 'pushGit');

        if (control === 'Shift') {
            act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
            expect(commitButton()?.textContent).toBe('Commit 3 files');
            await press(commitButton()!, true);
            act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
        } else {
            await press(more());
            const local = [...document.querySelectorAll('[role="menuitem"]')].find(
                item => item.textContent?.trim() === 'Commit locally'
            );
            expect(local).toBeDefined();
            await press(local!);
        }
        await settle();

        expect(push).not.toHaveBeenCalled();
        expect(message().value).toBe('');
        expect(sourceControlPreferences.autoPush).toBe(true);
    });

    it('commits locally when automatic push is off', async () => {
        sourceControlPreferences.setAutoPush(false);
        await start();
        await type('feat: surcharge');

        const push = vi.spyOn(transport, 'pushGit');

        await press(commitButton()!);
        await settle();

        expect(push).not.toHaveBeenCalled();
        expect(commitButton()?.textContent).toBe('Commit 0 files');
    });
});

describe('the commit button and the line under the box', () => {
    const reasonStop = () => container.querySelector<HTMLElement>('[role="button"][aria-disabled="true"]');

    it('counts the selected files for a local commit', async () => {
        sourceControlPreferences.setAutoPush(false);
        await start();

        expect(commitButton()?.textContent).toBe('Commit 3 files');
        await press(tickOf('src/limits.ts'));
        expect(commitButton()?.textContent).toBe('Commit 2 files');
        await press(tickOf('notes.md'));
        expect(commitButton()?.textContent).toBe('Commit 1 file');
        await press(tickOf('src/booking/price.ts'));
        expect(commitButton()?.textContent).toBe('Commit 0 files');
    });

    it('switches the contrast button to Commit & Push while Shift is held and automatic push is off', async () => {
        sourceControlPreferences.setAutoPush(false);
        await start();
        await type('feat: surcharge');
        const commit = vi.spyOn(transport, 'commitGit');
        const push = vi.spyOn(transport, 'pushGit');

        expect(commitButton()?.getAttribute('data-color')).toBe('contrast');
        act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
        expect(commitButton()?.textContent).toBe('Commit & Push');
        act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })));
        expect(commitButton()?.textContent).toBe('Commit 3 files');
        act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
        await press(commitButton()!, true);
        await settle();
        await settle();

        expect(commit).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledTimes(1);
    });

    it('disables Commit & Push when the remote blocks pushing and clears the modifier on blur', async () => {
        await start({ gitWrites: { remote: 'no_origin' } });
        await type('feat: surcharge');

        act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })));
        expect(commitButton()?.textContent).toBe('Commit & Push');
        expect(commitButton()?.disabled).toBe(true);

        act(() => window.dispatchEvent(new Event('blur')));
        expect(commitButton()?.textContent).toBe('Commit 3 files');
        expect(commitButton()?.disabled).toBe(false);
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
        expect(reasonStop()?.getAttribute('aria-label')).toBe('Commit & Push');

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

        expect(container.querySelector('[role="note"]')?.textContent).toBe('Committing to main, the base branch');
    });
});

describe('a push that origin turned down for newer commits, after a commit', () => {
    it("has a Fetch origin button beside git's line, which fetches and takes the line away; the sidebar's button then says what to do", async () => {
        await start({ gitWrites: { remote: 'rejected' } });
        await type('feat: surcharge');
        await press(commitButton()!);
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
        expect(commitButton()?.textContent).toBe('Commit 0 files');
    });

    it('has no Fetch origin button beside a push that failed for another cause', async () => {
        await start({ gitWrites: { remote: 'signing' } });
        await type('feat: surcharge');
        await press(commitButton()!);
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
        expect(refresh).toHaveBeenCalledTimes(1);

        commitGit.mockRejectedValueOnce(new TransportError('lint failed', 409));
        draft.setMessage('feat: again');
        await draft.commit();

        expect(draft.message).toBe('feat: again');
        expect(draft.failure).toEqual({ what: 'commit', message: 'lint failed' });
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('pushes the branch after the commit or publishes it when it has no upstream', async () => {
        const pushed = draftOver(['a.ts']);

        pushed.draft.setMessage('feat: add');
        await pushed.draft.commit(true);

        expect(pushed.remote.run).toHaveBeenCalledWith('push', {
            report: false,
            expectedHead: { branch: 'feature', commit: 'a'.repeat(40) },
        });
        expect(pushed.draft.failure).toBeUndefined();
        expect(pushed.draft.message).toBe('');
        expect(pushed.refresh).toHaveBeenCalledTimes(1);

        const published = draftOver(['a.ts'], { upstream: undefined });

        published.draft.setMessage('feat: add');
        await published.draft.commit(true);
        expect(published.remote.run).toHaveBeenCalledWith('publish', {
            report: false,
            expectedHead: { branch: 'feature', commit: 'a'.repeat(40) },
        });
        expect(published.draft.failure).toBeUndefined();
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
