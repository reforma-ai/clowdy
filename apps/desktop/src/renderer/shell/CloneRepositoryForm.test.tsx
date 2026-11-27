// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { overrideTransport } from '../daemon/testing';
import { type GitCloneProgress, type Transport, TransportError } from '../daemon/transport';
import { homeFolder } from '../shared/homeFolder';
import { openCloneRepository } from './CloneRepositoryForm';

import type { GitCloneRequest, GitCloneTarget } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The window draws on the next animation frame and its content mounts a little later. */
async function settle(ms = 60) {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms));
    });
}

/** Longer than the rest the address and the folder get before the daemon is asked. */
const afterDelay = () => settle(450);

const REPOSITORY = 'https://github.com/acme/booking-api.git';

let onAdd: ReturnType<typeof vi.fn<(paths: string[]) => void>>;

async function open(overrides: Partial<Transport> = {}, bridge?: { chooseDirectories: () => Promise<string[]> }) {
    if (bridge) (window as { desktop?: unknown }).desktop = bridge;

    onAdd = vi.fn();
    act(() => openCloneRepository({ transport: overrideTransport(new FixtureTransport(), overrides), onAdd }));
    await settle();
}

const dialog = () => document.body.querySelector('form');
const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === text
    );
const address = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Repository address"]')!;
const folderField = () => document.body.querySelector<HTMLInputElement>('input[aria-label="Folder"]')!;
const saveTo = () => document.body.querySelector('[aria-live="polite"]')?.textContent ?? '';
const alertText = () => document.body.querySelector('[role="alert"]')?.textContent;
const bar = () => document.body.querySelector('[role="progressbar"]');

function type(field: HTMLInputElement, value: string) {
    act(() => {
        field.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function press(element: HTMLElement | undefined) {
    await act(async () => element!.click());
    await settle();
}

/** Types the address and the folder, and waits until the daemon has said where it goes. */
async function aim(url: string, folder = '') {
    type(address(), url);

    if (folder) type(folderField(), folder);

    await afterDelay();
}

/** A clone that the test ends itself, and the request it was made with. */
function pendingClone() {
    const calls: Array<{ request: GitCloneRequest; signal?: AbortSignal; progress?: (p: GitCloneProgress) => void }> =
        [];
    let settleClone: { resolve: (path: string) => void; reject: (error: unknown) => void } | undefined;
    const cloneGit: Transport['cloneGit'] = (request, progress, signal) => {
        calls.push({ request, signal, progress });

        return new Promise<string>((resolve, reject) => {
            settleClone = { resolve, reject };
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    };

    return { calls, cloneGit, settle: () => settleClone! };
}

beforeEach(() => {
    homeFolder.set('/Users/dev');
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
    homeFolder.set(undefined);
    document.body.innerHTML = '';
});

describe('Clone repository', () => {
    it('opens with the address field focused and Clone off, naming the default folder before anything is typed', async () => {
        await open();
        await settle(200);

        expect(dialog()).not.toBeNull();
        expect(document.activeElement).toBe(address());
        expect(address().placeholder).toBe('https://github.com/owner/repo.git');
        expect(button('Clone')!.disabled).toBe(true);
        // A plain browser has a field for the folder, and its placeholder is the folder used when it stays empty.
        expect(folderField().placeholder).toBe('~/Clowdy/Projects');
        expect(saveTo()).toContain('Enter a repository address');
    });

    it('says the repository is made inside the default folder when no folder was chosen, with the whole path', async () => {
        await open({}, { chooseDirectories: async () => [] });
        await aim(REPOSITORY);

        expect(document.body.textContent).toContain('Clowdy default folder');
        expect(saveTo()).toContain('~/Clowdy/Projects/booking-api');
        // The daemon puts a repository in a folder of its own in the default folder, whether or not it holds anything: the words do not say it does.
        expect(saveTo()).toContain('A folder named booking-api will be made in the default folder');
        expect(saveTo()).not.toContain('has files');
        expect(button('Clone')!.disabled).toBe(false);
    });

    it('says the repository is the folder itself for a chosen folder that does not exist yet, and for an empty one', async () => {
        await open();

        await aim(REPOSITORY, '/Users/dev/somewhere/new');
        expect(saveTo()).toContain('~/somewhere/new');
        expect(saveTo()).not.toContain('booking-api');
        expect(saveTo()).toContain('The folder is empty or new, so the repository will be the folder itself');

        type(folderField(), '/Users/dev/empty/');
        await afterDelay();
        // The separator a copy leaves at the end is no difference.
        expect(saveTo()).toContain('~/empty');
        expect(saveTo()).toContain('so the repository will be the folder itself');
    });

    it('keeps a space typed in the folder field, and asks for the folder without the spaces around it', async () => {
        const asked: Array<string | undefined> = [];

        await open({
            getGitCloneTarget: async (url, folder) => {
                asked.push(folder);

                return { folder: folder ?? '/Users/dev/Clowdy/Projects', path: `${folder ?? ''}/${url.length}` };
            },
        });
        type(address(), REPOSITORY);
        type(folderField(), '/Users/dev/my ');

        // The field shows what was typed, so the next letter can come after the space.
        expect(folderField().value).toBe('/Users/dev/my ');
        await afterDelay();
        expect(asked.at(-1)).toBe('/Users/dev/my');
    });

    it('says a folder named after the repository is made inside a chosen folder that has files', async () => {
        await open();
        await aim(REPOSITORY, '/Users/dev/code');

        expect(saveTo()).toContain('~/code/booking-api');
        expect(saveTo()).toContain('The folder has files, so a folder named booking-api will be made inside it');
        expect(button('Clone')!.disabled).toBe(false);
    });

    it('takes the folder from the system dialog in the desktop app, and goes back to the default folder on request', async () => {
        const chooseDirectories = vi.fn(async () => ['/Users/dev/empty']);

        await open({}, { chooseDirectories });
        expect(document.body.querySelector('input[aria-label="Folder"]')).toBeNull();

        await aim(REPOSITORY);
        await press(button('Choose folder…'));
        await afterDelay();

        expect(chooseDirectories).toHaveBeenCalledOnce();
        expect(document.body.textContent).toContain('The folder you chose');
        expect(saveTo()).toContain('so the repository will be the folder itself');

        await press(button('Use default folder'));
        await afterDelay();

        expect(document.body.textContent).toContain('Clowdy default folder');
        expect(saveTo()).toContain('~/Clowdy/Projects/booking-api');
    });

    it('keeps the folder as it is when the system dialog is closed without a choice', async () => {
        await open({}, { chooseDirectories: async () => [] });
        await aim(REPOSITORY);
        await press(button('Choose folder…'));
        await afterDelay();

        expect(document.body.textContent).toContain('Clowdy default folder');
    });

    it('gives no folder for an address that names no repository, and leaves Clone off', async () => {
        await open();
        await aim('nonsense');

        expect(saveTo()).toContain('Enter a repository address');
        expect(button('Clone')!.disabled).toBe(true);
    });

    it('shows a blocked target in the danger colour and leaves Clone off', async () => {
        await open();
        await aim('https://github.com/acme/car-rental.git');

        expect(saveTo()).toContain('~/Clowdy/Projects/car-rental');
        expect(saveTo()).toContain('already exists and is not an empty folder');
        expect(document.body.querySelector('[class*="danger"]')?.textContent).toContain('already exists');
        expect(button('Clone')!.disabled).toBe(true);
    });

    it('says when the daemon cannot tell where the clone would go', async () => {
        await open({
            getGitCloneTarget: async () => {
                throw new TransportError("Couldn't read the folder", 503);
            },
        });
        await aim(REPOSITORY);

        expect(saveTo()).toContain("Couldn't read the folder");
        expect(button('Clone')!.disabled).toBe(true);
    });

    it('drops the answer to an older address that arrives after the answer to a newer one', async () => {
        const waiting = new Map<string, (target: GitCloneTarget) => void>();
        const asked: string[] = [];

        await open({
            // A daemon that answers when it likes, whatever the window has stopped waiting for.
            getGitCloneTarget: (url, _folder) =>
                new Promise<GitCloneTarget>(resolve => {
                    asked.push(url);
                    waiting.set(url, resolve);
                }),
        });
        await afterDelay();
        waiting.get('')!({ folder: '/Users/dev/Clowdy/Projects' });
        await settle();

        type(address(), 'https://github.com/acme/one.git');
        await afterDelay();
        type(address(), 'https://github.com/acme/two.git');
        await afterDelay();

        expect(asked).toEqual(['', 'https://github.com/acme/one.git', 'https://github.com/acme/two.git']);

        await act(async () =>
            waiting.get('https://github.com/acme/two.git')!({
                folder: '/Users/dev/Clowdy/Projects',
                path: '/Users/dev/Clowdy/Projects/two',
            })
        );
        await act(async () =>
            waiting.get('https://github.com/acme/one.git')!({
                folder: '/Users/dev/Clowdy/Projects',
                path: '/Users/dev/Clowdy/Projects/one',
            })
        );
        await settle();

        expect(saveTo()).toContain('~/Clowdy/Projects/two');
        expect(saveTo()).not.toContain('/one');
    });

    it('does not offer Clone while the daemon has not answered for the address and folder now in the fields', async () => {
        const base = new FixtureTransport();
        let answer: (target: GitCloneTarget) => void = () => undefined;
        let slow = false;

        await open({
            getGitCloneTarget: (url, folder, signal) =>
                slow ? new Promise(resolve => (answer = resolve)) : base.getGitCloneTarget(url, folder, signal),
        });
        await aim(REPOSITORY);
        expect(button('Clone')!.disabled).toBe(false);

        // The folder changes: until the daemon answers for it, the old path is not one to clone to.
        slow = true;
        type(folderField(), '/Users/dev/code');
        await afterDelay();
        expect(button('Clone')!.disabled).toBe(true);

        await act(async () => answer({ folder: '/Users/dev/code', path: '/Users/dev/code/booking-api' }));
        expect(button('Clone')!.disabled).toBe(false);
    });

    it("clones into the path it showed, shows git's progress with the fields locked, and adds the made folder when it is done", async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY, '/Users/dev/code');
        await press(button('Clone'));

        expect(clone.calls).toHaveLength(1);
        expect(clone.calls[0].request).toEqual({ url: REPOSITORY, path: '/Users/dev/code/booking-api' });
        // While it runs: no more changes to the address or the folder, no second Clone, and a Cancel.
        expect(address().disabled).toBe(true);
        expect(folderField().disabled).toBe(true);
        expect(button('Clone')!.disabled).toBe(true);
        expect(button('Clone')!.dataset.pending).toBe('true');
        expect(button('Cancel')).not.toBeUndefined();
        expect(document.body.textContent).toContain('Starting the clone');

        act(() => clone.calls[0].progress!({ label: 'Receiving objects', percent: 42 }));
        await settle();

        expect(document.body.textContent).toContain('Receiving objects');
        expect(document.body.textContent).toContain('42%');
        expect(bar()?.getAttribute('aria-valuenow')).toBe('42');

        act(() => clone.calls[0].progress!({ label: 'Resolving deltas' }));
        await settle();

        // A line with no percent shows the line alone.
        expect(document.body.textContent).toContain('Resolving deltas');
        expect(bar()).toBeNull();

        await act(async () => clone.settle().resolve('/Users/dev/code/booking-api'));
        await settle();

        expect(onAdd).toHaveBeenCalledExactlyOnceWith(['/Users/dev/code/booking-api']);
        expect(dialog()).toBeNull();
    });

    it('aborts the request on Cancel, keeps the dialog open and the address, and adds nothing', async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY);
        await press(button('Clone'));
        await press(button('Cancel'));

        expect(clone.calls[0].signal?.aborted).toBe(true);
        expect(dialog()).not.toBeNull();
        expect(address().value).toBe(REPOSITORY);
        expect(address().disabled).toBe(false);
        expect(button('Clone')!.disabled).toBe(false);
        expect(alertText()).toBeUndefined();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it('cancels the clone when Escape closes the dialog, with no question', async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY);
        await press(button('Clone'));

        expect(clone.calls[0].signal?.aborted).toBe(false);

        // Escape goes to what has the focus, which must be inside the window (the address and Clone are disabled by now).
        expect(dialog()!.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(button('Cancel'));
        await act(async () => {
            document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await settle();

        expect(clone.calls[0].signal?.aborted).toBe(true);
        expect(dialog()).toBeNull();
        expect(onAdd).not.toHaveBeenCalled();
    });

    it('cancels the clone when the window closes some other way', async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY);
        await press(button('Clone'));
        await act(async () => {
            for (const modal of Modal.opened) await modal.close(false);
        });
        await settle();

        expect(clone.calls[0].signal?.aborted).toBe(true);
        expect(onAdd).not.toHaveBeenCalled();
    });

    it('shows the error and its hint, keeps the dialog open and editable, and clones again from there', async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY);
        await press(button('Clone'));
        await act(async () =>
            clone.settle().reject(new TransportError("fatal: repository 'x' not found", 409, 'Check the address'))
        );
        await settle();

        expect(alertText()).toContain("fatal: repository 'x' not found");
        expect(alertText()).toContain('Check the address');
        expect(dialog()).not.toBeNull();
        expect(address().disabled).toBe(false);
        expect(button('Clone')!.disabled).toBe(false);
        expect(onAdd).not.toHaveBeenCalled();

        // Changing the address takes the old failure away.
        await aim('https://github.com/acme/other.git');
        expect(alertText()).toBeUndefined();

        await press(button('Clone'));
        expect(clone.calls).toHaveLength(2);
        expect(clone.calls[1].request).toEqual({
            url: 'https://github.com/acme/other.git',
            path: '/Users/dev/Clowdy/Projects/other',
        });
    });

    it('keeps the last answer on the card, dimmed, while the next one is on its way, and offers no Clone meanwhile', async () => {
        const base = new FixtureTransport();
        let answer: (target: GitCloneTarget) => void = () => undefined;
        let slow = false;

        await open({
            getGitCloneTarget: (url, folder, signal) =>
                slow ? new Promise(resolve => (answer = resolve)) : base.getGitCloneTarget(url, folder, signal),
        });
        await aim(REPOSITORY);
        expect(saveTo()).toContain('~/Clowdy/Projects/booking-api');

        slow = true;
        type(address(), 'https://github.com/acme/booking-ap');
        await afterDelay();

        // Not the empty message of a card that knows nothing: the path it knew, marked as not up to date.
        expect(saveTo()).toContain('~/Clowdy/Projects/booking-api');
        expect(document.body.querySelector('[aria-busy="true"]')).not.toBeNull();
        expect(button('Clone')!.disabled).toBe(true);

        await act(async () =>
            answer({ folder: '/Users/dev/Clowdy/Projects', path: '/Users/dev/Clowdy/Projects/booking-ap' })
        );

        expect(saveTo()).toContain('~/Clowdy/Projects/booking-ap');
        expect(document.body.querySelector('[aria-busy="true"]')).toBeNull();
    });

    it('shows why a folder is refused even when the daemon named no path', async () => {
        await open({
            getGitCloneTarget: async () => ({
                folder: '/Users/dev/notes.txt',
                blocked: '/Users/dev/notes.txt is a file',
            }),
        });
        await aim('nonsense');

        expect(saveTo()).toContain('/Users/dev/notes.txt is a file');
        expect(saveTo()).not.toContain('Enter a repository address');
        expect(button('Clone')!.disabled).toBe(true);
    });

    it('names the default folder again after a folder is reset, not the one that was chosen', async () => {
        const where = () =>
            [...document.body.querySelectorAll('span')].find(span => span.textContent === 'Clowdy default folder')
                ?.parentElement?.textContent;

        await open({}, { chooseDirectories: async () => ['/Users/dev/empty'] });
        await aim(REPOSITORY);
        await press(button('Choose folder…'));
        await afterDelay();
        expect(document.body.textContent).toContain('The folder you chose');

        await press(button('Use default folder'));

        // At once, before the daemon answers for the reset: the folder it named for the default folder, not the one just left.
        expect(where()).toContain('~/Clowdy/Projects');
        expect(where()).not.toContain('empty');
        // The button that was pressed is gone with the folder: the focus is in the window, on the way to choose another.
        expect(document.activeElement).toBe(button('Choose folder…'));
    });

    it('puts the focus back in the dialog when a clone stops, so Escape still closes it', async () => {
        const clone = pendingClone();

        await open({ cloneGit: clone.cloneGit });
        await aim(REPOSITORY);
        await press(button('Clone'));
        await press(button('Cancel'));

        expect(document.activeElement).toBe(address());

        await press(button('Clone'));
        await act(async () => clone.settle().reject(new TransportError('fatal: no', 409)));
        await settle();

        expect(document.activeElement).toBe(address());
    });

    it('asks again where the clone would go after it failed, and keeps the failure until the address or the folder changes', async () => {
        const clone = pendingClone();
        const asked: string[] = [];
        const base = new FixtureTransport();

        await open({
            cloneGit: clone.cloneGit,
            getGitCloneTarget: (url, folder, signal) => {
                asked.push(`${url}|${folder ?? ''}`);

                return base.getGitCloneTarget(url, folder, signal);
            },
        });
        await aim(REPOSITORY);
        await press(button('Clone'));

        const before = asked.length;

        await act(async () => clone.settle().reject(new TransportError('fatal: no', 409)));
        await settle();

        expect(asked.length).toBe(before + 1);
        expect(alertText()).toContain('fatal: no');
        // The new answer is not waited for as a typed change is, and Clone is there again.
        expect(button('Clone')!.disabled).toBe(false);

        await aim(REPOSITORY, '/Users/dev/code');
        expect(alertText()).toBeUndefined();
    });

    it('takes one folder from the system dialog and says so when it hands back several', async () => {
        await open({}, { chooseDirectories: async () => ['/Users/dev/code', '/Users/dev/empty'] });
        await aim(REPOSITORY);
        await press(button('Choose folder…'));

        expect(alertText()).toBe('Choose one folder');
        expect(document.body.textContent).toContain('Clowdy default folder');
        expect(button('Clone')!.disabled).toBe(false);
    });

    it('goes through on the fixtures: progress, then the folder made, which closes the dialog', async () => {
        await open();
        await aim(REPOSITORY, '/Users/dev/empty');
        await press(button('Clone'));
        await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce(), { timeout: 8000, interval: 100 });
        await settle();

        expect(onAdd).toHaveBeenCalledExactlyOnceWith(['/Users/dev/empty']);
        expect(dialog()).toBeNull();
    }, 15_000);
});
