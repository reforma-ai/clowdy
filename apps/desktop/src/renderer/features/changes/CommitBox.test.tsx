// @vitest-environment happy-dom
import { observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PERSONAL_PROJECT_ID, FIXTURE_PROJECT_ID, withFixtureWorkspace, type FixtureData } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError, type Transport } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { CommitBox } from './CommitBox';
import { CommitDraft, commitDraftOf } from './CommitDraft';
import { gitFactsOf, type GitPlaceKey } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';

import type { GitChangedFile } from '@clowdy/protocol';
import type { FixtureGitWritesOptions } from '../../daemon/fixtureGitWrites';
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

const box = () => container.querySelector('[aria-label="Commit"]');
const checkboxes = () => [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
const tickOf = (path: string) => container.querySelector<HTMLInputElement>(`input[type="checkbox"][aria-label="${ path }"]`)!;
const everyTick = () => container.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Tick every file"]')!;
const message = () => container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Commit message"]')!;
const buttonOf = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === label);
const alert = () => container.querySelector('[role="alert"]');

async function type(text: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(message(), text);
        message().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

/** A place in a worktree with three uncommitted files, on the fixtures, the box drawn once the files were read. */
async function start({ tweak, gitWrites, key = KEY }: { tweak?: (data: FixtureData) => void; gitWrites?: FixtureGitWritesOptions; key?: GitPlaceKey } = {}) {
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
    act(() => root.render(<RootStoreProvider value={ store }><Box model={ model } /></RootStoreProvider>));
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
        expect(buttonOf('Commit')?.disabled).toBe(true);
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
        expect(buttonOf('Commit')?.disabled).toBe(false);

        reads.mockClear();
        await press(buttonOf('Commit')!);
        await settle();

        expect(commit).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, ['notes.md', 'src/booking/price.ts'], 'fix(booking): add the surcharge\n\nWith a body');
        expect(message().value).toBe('');
        // The place is read again, and the files that went are not listed any more; the one that was not ticked is still there, ticked as any file of the list is.
        expect(reads).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, 'uncommitted');
        expect(checkboxes().filter(tick => tick.getAttribute('aria-label') !== 'Tick every file').map(tick => tick.getAttribute('aria-label'))).toEqual(['src/limits.ts']);
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
        vi.spyOn(transport, 'generateGitMessage').mockImplementation(() => new Promise((resolve) => {
            release = () => resolve({ message: 'feat: generated' });
        }));

        await press(buttonOf('Generate')!);
        expect(buttonOf('Generate')?.disabled).toBe(true);
        expect(buttonOf('Commit')?.disabled).toBe(true);
        expect(message().placeholder).toBe('Writing the message');

        // The box is read only while the agent works; a text that gets in by another way is the person's, and stays.
        act(() => commitDraftOf(model, transport, () => undefined).setMessage('typed meanwhile'));
        release();
        await settle();
        await draw();

        expect(message().value).toBe('typed meanwhile');
        expect(buttonOf('Commit')?.disabled).toBe(false);
    });

    it('leaves the box as it was and says so when the message could not be written', async () => {
        await start({ gitWrites: { message: 'failed' } });
        await press(buttonOf('Generate')!);
        await settle();

        expect(message().value).toBe('');
        expect(alert()?.textContent).toBe('Couldn\'t write the message');
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

    it.each(['metaKey', 'ctrlKey'] as const)('commits with Enter and the %s held in the message box', async (modifier) => {
        await start();

        const commit = vi.spyOn(transport, 'commitGit');

        await type('chore: notes');
        await act(async () => {
            message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true }));
        });
        await settle();

        expect(commit).toHaveBeenCalledWith(FIXTURE_PROJECT_ID, PLACE, ['notes.md', 'src/booking/price.ts', 'src/limits.ts'], 'chore: notes');
    });

    it('shows git\'s own line with the hint when the signing agent could not be reached, keeps the box and the ticks, and commits when it is tried again', async () => {
        await start({ gitWrites: { commit: 'signing' } });
        await press(tickOf('notes.md'));
        await type('feat: add');
        await press(buttonOf('Commit')!);
        await settle();

        expect(alert()?.textContent).toContain('error: No private key found for public key');
        expect(alert()?.textContent).toContain('The signing agent couldn\'t be reached');
        expect(message().value).toBe('feat: add');
        expect(tickOf('notes.md').checked).toBe(false);
        expect(buttonOf('Commit')?.disabled).toBe(false);
    });

    it('shows a hook\'s line without a hint', async () => {
        await start({ gitWrites: { commit: 'hook' } });
        await type('feat: add');
        await press(buttonOf('Commit')!);
        await settle();

        expect(alert()?.textContent).toBe('pre-commit: 2 problems in src/limits.ts');
    });

    it('commits nothing and writes nothing with no file ticked, and ticks every file again from the box\'s own tick', async () => {
        await start();
        await type('feat: add');
        await press(everyTick());

        expect(box()?.textContent).toContain('0 of 3');
        expect(buttonOf('Commit')?.disabled).toBe(true);
        expect(buttonOf('Generate')?.disabled).toBe(true);

        await press(tickOf('notes.md'));
        expect(everyTick().indeterminate).toBe(true);
        expect(buttonOf('Commit')?.disabled).toBe(false);

        await press(everyTick());
        expect(checkboxes().every(tick => tick.checked)).toBe(true);
    });

    it('has no Generate button while no agent has Commit messages on and is signed in', async () => {
        await start({ tweak: (data) => {
            const codex = data.agents.find(agent => agent.id === 'codex')!;

            codex.settings = codex.settings!.map(setting => ({ ...setting, value: false }));
        } });

        expect(buttonOf('Generate')).toBeUndefined();
        expect(buttonOf('Commit')).toBeDefined();
    });

    it('has the Generate button while Claude Code alone has Commit messages on and is signed in, and not once it is off too', async () => {
        const setting = (data: FixtureData, id: string, value: boolean) => {
            const agent = data.agents.find(candidate => candidate.id === id)!;

            agent.settings = agent.settings!.map(entry => (entry.id === 'commitMessage' ? { ...entry, value } : entry));
        };

        await start({ tweak: (data) => {
            setting(data, 'codex', false);
            setting(data, 'claude', true);
        } });
        expect(buttonOf('Generate')).toBeDefined();

        act(() => root.unmount());
        stop();
        store.dispose();
        root = createRoot(container);
        await start({ tweak: (data) => {
            setting(data, 'codex', false);
            setting(data, 'claude', true);
            data.agents.find(agent => agent.id === 'claude')!.signIn = { status: 'signed-out', checkedAt: 1 };
        } });
        expect(buttonOf('Generate')).toBeUndefined();
    });

    it('has no Generate button for an agent that is signed out', async () => {
        await start({ tweak: (data) => {
            data.agents.find(agent => agent.id === 'codex')!.signIn = { status: 'signed-out', checkedAt: 1 };
        } });

        expect(buttonOf('Generate')).toBeUndefined();
    });

    it('says what the commit was when it took every file, and that there is nothing to commit for a place that is clean', async () => {
        await start();
        await press(buttonOf('Generate')!);
        await settle();
        await press(buttonOf('Commit')!);
        await settle();
        await draw();

        expect(box()?.textContent).toBe('Committed c0ffee0');
        expect(checkboxes()).toHaveLength(0);
    });

    it('says there is nothing to commit in the folder\'s own checkout, which is clean', async () => {
        await start({ key: { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' } });

        expect(box()?.textContent).toBe('Nothing to commit');
    });

    it('draws nothing for a folder that is no repository', async () => {
        const personal = createFixtureData().projects.find(project => project.id === FIXTURE_PERSONAL_PROJECT_ID)!.folders[0]!;

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

describe('the draft of a commit', () => {
    const file = (path: string): GitChangedFile => ({ path, kind: 'modified', additions: 1, deletions: 0, revision: path });

    /** A draft over a list the test changes, and a transport that records what it is asked. */
    function draftOver(paths: string[]) {
        const listed = observable({ files: paths.map(file) });
        const fakeModel = { facts: { key: KEY }, get uncommitted() {
            return { isRepository: true as const, files: listed.files };
        } } as unknown as PlaceChanges;
        const commitGit = vi.fn(async (_project: string, _place: unknown, commitPaths: string[], text: string) => ({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: text, paths: commitPaths }));
        const generateGitMessage = vi.fn(async () => ({ message: 'feat: written' }));
        const refresh = vi.fn();
        const draft = new CommitDraft(fakeModel, { commitGit, generateGitMessage } as unknown as Pick<Transport, 'commitGit' | 'generateGitMessage'>, refresh);

        return { draft, listed, commitGit, generateGitMessage, refresh };
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

    it('commits the ticked files in the list\'s order, refreshes the place after a commit and after one that failed, and keeps the message of the one that failed', async () => {
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
