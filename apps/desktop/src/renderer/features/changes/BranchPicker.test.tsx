// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFixtureData, FIXTURE_PROJECT_ID, withFixtureWorkspace } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { TransportError } from '../../daemon/transport';
import { RootStore, RootStoreProvider } from '../../stores';
import { openEffects } from '../openWith';
import { ChangesSidebar } from './ChangesSidebar';
import { gitFactsOf, type GitPlaceKey } from './gitFacts';
import { placeChangesOf } from './PlaceChanges';

import type { GitSwitchResult } from '@clowdy/protocol';
import type { FixtureBranchScript } from '../../daemon/fixtureGitBranches';
import type { Place } from '../sidePanel/currentPlace';
import type { PlaceChanges } from './PlaceChanges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest: the parts of the picker are, to follow the model they read.
vi.mock('./BranchPicker', async importOriginal => ({ BranchPicker: observer((await importOriginal<typeof import('./BranchPicker')>()).BranchPicker) }));
vi.mock('./BranchList', async importOriginal => ({ BranchList: observer((await importOriginal<typeof import('./BranchList')>()).BranchList) }));
vi.mock('./NewBranchForm', async importOriginal => ({ NewBranchForm: observer((await importOriginal<typeof import('./NewBranchForm')>()).NewBranchForm) }));
vi.mock('./SwitchReasons', async importOriginal => ({ SwitchReasons: observer((await importOriginal<typeof import('./SwitchReasons')>()).SwitchReasons) }));

const WORKTREE: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental', workspaceId: 'wks_ab12cd34' };
const CHECKOUT: GitPlaceKey = { projectId: FIXTURE_PROJECT_ID, folderId: 'fld_car_rental' };

const Sidebar = observer(ChangesSidebar);

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
const keyOn = (target: Element, key: string) => act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
});
const type = (input: HTMLInputElement, text: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
});

/** The button (or, for a worktree, the stand-in of the off button) that names the branch in the sidebar's header. */
const trigger = () => container.querySelector<HTMLElement>('button[aria-label^="Current branch"], [role="button"][aria-label^="Current branch"]');
const popover = () => document.querySelector<HTMLElement>('[data-modal-clickout-layer]');
const search = () => document.querySelector<HTMLInputElement>('input[placeholder="Filter branches"]')!;
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="option"][data-key]')];
const row = (name: string) => rows().find(candidate => candidate.dataset.key === name)!;
const headings = () => [...document.querySelectorAll('[role="listbox"] header, [role="listbox"] [role="presentation"] > div')].map(heading => heading.textContent);
const alert = () => document.querySelector('[role="alert"]');
const fieldNamed = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${ label }"]`)!;
const buttonOf = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent?.trim() === text);
const radios = () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];

let currentPlace: Place;

async function draw(place = currentPlace) {
    currentPlace = place;
    act(() => root.render(<RootStoreProvider value={ store }><Sidebar model={ model } place={ place } projectId={ FIXTURE_PROJECT_ID } onOpenFile={ () => undefined } toggle={ null } /></RootStoreProvider>));
    await settle();
    await settle();
}

/** The sidebar of the folder's own checkout (or, with `key`, of the chat's worktree) on the fixtures, with the scripts of `&branches=` the test says. */
async function start({ branches, key = CHECKOUT, worktree = key.workspaceId !== undefined }: { branches?: FixtureBranchScript[]; key?: GitPlaceKey; worktree?: boolean } = {}) {
    transport = new FixtureTransport({ data: worktree ? withFixtureWorkspace(createFixtureData()) : createFixtureData(), branches });
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

async function open() {
    // A press in a window focuses the button it is on, which is where the popover gives the focus back to.
    trigger()!.focus();
    await press(trigger()!);
    await settle();
    await settle();
}

beforeEach(() => {
    vi.spyOn(openEffects, 'openUrl').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stop?.();
    store.dispose();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('the branch of the Changes sidebar, for the folder\'s own checkout', () => {
    it('is a button that names the branch the checkout is on, and opens nothing until it is pressed', async () => {
        await start();

        expect(trigger()?.tagName).toBe('BUTTON');
        expect(trigger()?.textContent).toBe('main');
        expect(trigger()?.getAttribute('aria-label')).toBe('Current branch: main');
        expect(popover()).toBeNull();
    });

    it('opens a popover titled Current branch, with a filter and the groups, the current branch checked, and reads the branches when it opens', async () => {
        await start({ branches: ['remote'] });

        const read = vi.spyOn(transport, 'getGitBranches');

        await open();

        expect(read).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' });
        expect(popover()?.textContent).toContain('Current branch');
        expect(search()).not.toBeNull();
        expect(document.activeElement).toBe(search());
        expect(rows().map(candidate => candidate.dataset.key)).toEqual(['main', 'dev', 'feature/search', 'release/2.1', 'chore/deps']);
        expect(popover()?.textContent).toMatch(/Default.*main.*Recent.*dev.*Remote.*feature\/search/s);
        expect(row('main').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(row('dev').querySelector('[aria-label="Current"]')).toBeNull();
        expect(buttonOf('New branch…')).toBeDefined();
    });

    it('shows a branch that a worktree has as a row that is off and says where, and picks nothing from it', async () => {
        await start({ branches: ['held'] });

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await open();

        const held = row('clowdy/ab12cd34');

        expect(held.getAttribute('aria-disabled')).toBe('true');
        expect(held.textContent).toContain('Checked out in ~/…/ab12cd34/car-rental');
        expect(row('feature/payments').getAttribute('aria-disabled')).toBe('true');

        await press(held);
        await settle();
        expect(switchTo).not.toHaveBeenCalled();

        // Enter on a filter that leaves only that row does not switch to it either.
        await type(search(), 'ab12cd');
        await keyOn(search(), 'Enter');
        await settle();
        expect(switchTo).not.toHaveBeenCalled();
        expect(popover()).not.toBeNull();
    });

    it('filters as the person types, on every word in any order', async () => {
        await start({ branches: ['remote'] });
        await open();

        await type(search(), 'search feat');
        expect(rows().map(candidate => candidate.dataset.key)).toEqual(['feature/search']);

        await type(search(), 'zzz');
        expect(rows()).toHaveLength(0);
        expect(popover()?.textContent).toContain('Nothing found');
    });

    it('switches on a press: the popover shuts, the button names the new branch, and the status, the changes and the folder\'s branch are read again', async () => {
        await start();

        const info = vi.spyOn(transport, 'getProjectsInfo');
        const status = vi.spyOn(transport, 'getGitStatus');

        await open();
        info.mockClear();
        status.mockClear();
        await press(row('dev'));
        await settle();
        await settle();

        expect(popover()).toBeNull();
        expect(trigger()?.textContent).toBe('dev');
        expect(status).toHaveBeenCalled();
        expect(info).toHaveBeenCalled();
    });

    it('takes a branch that only origin has by its name, and the next time it is a local branch under Local', async () => {
        await start({ branches: ['remote'] });

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await open();
        await press(row('feature/search'));
        await settle();
        await settle();

        expect(switchTo).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' }, 'feature/search', undefined);
        expect(trigger()?.textContent).toBe('feature/search');

        await open();
        expect(row('feature/search').querySelector('[aria-label="Current"]')).not.toBeNull();
        expect(rows().map(candidate => candidate.dataset.key)).not.toContain('release/2.1-gone');
    });

    it('picks with the arrows and Enter', async () => {
        await start();
        await open();
        await keyOn(search(), 'ArrowDown');
        await keyOn(search(), 'ArrowDown');
        await keyOn(search(), 'Enter');
        await settle();
        await settle();

        expect(trigger()?.textContent).toBe('dev');
        expect(popover()).toBeNull();
    });

    it('shuts on Escape without switching', async () => {
        await start();

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await open();
        await keyOn(search(), 'Escape');
        await settle();

        expect(popover()).toBeNull();
        expect(switchTo).not.toHaveBeenCalled();
    });

    it('says why a switch was refused inside the popover, with the line the daemon adds, and shuts nothing', async () => {
        await start({ branches: ['dirty'] });
        await open();
        await press(row('dev'));
        await settle();
        await settle();

        expect(popover()).not.toBeNull();
        expect(alert()?.textContent).toBe('Commit or discard the changes firstthree files changed'.replace('three', '3'));
        expect(trigger()?.textContent).toBe('main');
        // Another try is possible, and what is said goes with the next press.
        await press(row('dev'));
        await settle();
        await settle();
        expect(alert()?.textContent).toContain('Commit or discard the changes first');
        expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    });

    it('says the chats working there as the daemon says them', async () => {
        await start({ branches: ['refused'] });
        await open();
        await press(row('dev'));
        await settle();
        await settle();

        expect(alert()?.textContent).toBe('2 chats are working hereStop them or wait until they finish');
    });

    it('shows the spinner on the button and the branch in the popover while a switch runs, and no second press goes out', async () => {
        await start({ branches: ['slow'] });

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await open();
        // The switch the fixture takes 2.5 s over is waited for with a clock the test moves.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await press(row('dev'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(500);
        });

        expect(trigger()?.querySelector('[data-size]')).not.toBeNull();
        expect(popover()?.querySelector('[role="status"]')?.textContent).toBe('Switching to dev');

        await press(row('dev'));
        expect(switchTo).toHaveBeenCalledTimes(1);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(3000);
        });
        vi.useRealTimers();
        await settle();
        expect(popover()).toBeNull();
        expect(trigger()?.textContent).toBe('dev');
    });

    it('keeps the popover open on a hook\'s complaint after a switch that was made, and says both', async () => {
        await start();

        const result: GitSwitchResult = { head: { kind: 'branch', name: 'dev', commit: 'a'.repeat(40) }, warning: 'post-checkout: the install failed' };

        vi.spyOn(transport, 'switchGitBranch').mockResolvedValue(result);
        await open();
        await press(row('dev'));
        await settle();
        await settle();

        expect(popover()).not.toBeNull();
        expect(popover()?.querySelector('[role="status"]')?.textContent).toBe('Switched to devpost-checkout: the install failed');
    });

    it('says why the branches could not be read, and offers no list', async () => {
        await start();
        vi.spyOn(transport, 'getGitBranches').mockRejectedValue(new TransportError('git did not answer', 503));
        await open();

        expect(alert()?.textContent).toBe('git did not answer');
        expect(rows()).toHaveLength(0);
        expect(buttonOf('New branch…')?.disabled).toBe(true);
    });
});

describe('the form of a new branch in the popover', () => {
    async function openForm(branches?: FixtureBranchScript[]) {
        await start({ branches });
        await open();
        await press(buttonOf('New branch…')!);
        await settle();
    }

    it('asks for a name and, in GitHub Desktop\'s words, what the branch is based on, the default branch chosen', async () => {
        await openForm();

        expect(popover()?.textContent).toContain('Create a branch');
        expect(popover()?.textContent).toContain('Create branch based on…');
        expect(popover()?.textContent).toContain('The default branch (main)');
        expect(popover()?.textContent).toContain('The current branch (main)');
        expect(popover()?.textContent).toContain('The default branch in your repository. Pick this to start on something new that\'s not dependent on your current branch.');
        expect(popover()?.textContent).toContain('The currently checked out branch. Pick this if you need to build on work done on this branch.');
        expect(radios().map(radio => radio.checked)).toEqual([true, false]);
        expect(buttonOf('Create branch')?.disabled).toBe(true);
    });

    it('makes the branch from the default branch with the name typed, shuts, and names it in the button', async () => {
        await openForm();

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await type(fieldNamed('Name'), 'feature/weekend');
        expect(buttonOf('Create branch')?.disabled).toBe(false);
        await press(buttonOf('Create branch')!);
        await settle();
        await settle();

        expect(switchTo).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' }, 'feature/weekend', { start: 'default' });
        expect(popover()).toBeNull();
        expect(trigger()?.textContent).toBe('feature/weekend');
    });

    it('makes it from the current branch when that is chosen, and Enter in the field creates it', async () => {
        await openForm();

        const switchTo = vi.spyOn(transport, 'switchGitBranch');

        await press(radios()[1]!);
        await settle();
        expect(radios().map(radio => radio.checked)).toEqual([false, true]);
        await type(fieldNamed('Name'), 'wip');
        await act(async () => {
            fieldNamed('Name').form!.requestSubmit();
        });
        await settle();
        await settle();

        expect(switchTo).toHaveBeenCalledExactlyOnceWith(FIXTURE_PROJECT_ID, { folderId: 'fld_car_rental' }, 'wip', { start: 'current' });
        expect(trigger()?.textContent).toBe('wip');
    });

    it('shows what the daemon refused under the choices, keeps what was typed and shuts nothing', async () => {
        await openForm();
        await type(fieldNamed('Name'), 'dev');
        await press(buttonOf('Create branch')!);
        await settle();
        await settle();

        expect(popover()).not.toBeNull();
        expect(alert()?.textContent).toBe('A branch called dev exists already');
        expect(fieldNamed('Name').value).toBe('dev');

        await type(fieldNamed('Name'), 'a b');
        await press(buttonOf('Create branch')!);
        await settle();
        await settle();
        expect(alert()?.textContent).toBe('a b is not a branch name');
    });

    it('goes back to the list with the arrow, and the reason of the form does not follow it there', async () => {
        await openForm(['dirty']);
        await type(fieldNamed('Name'), 'x');
        await press(buttonOf('Create branch')!);
        await settle();
        await settle();
        expect(alert()?.textContent).toContain('Commit or discard the changes first');

        await press(document.querySelector('button[aria-label="Back to the branches"]')!);
        await settle();
        expect(search()).not.toBeNull();
        expect(alert()).toBeNull();
    });

    it('shuts on Escape from the form', async () => {
        await openForm();
        await keyOn(fieldNamed('Name'), 'Escape');
        await settle();

        expect(popover()).toBeNull();
    });
});

describe('the branch of the Changes sidebar, for a chat\'s worktree', () => {
    it('shows the branch the worktree is on and is off: a stand-in that names the button and says why in its tooltip, and nothing opens', async () => {
        await start({ key: WORKTREE });

        const stand = trigger()!;

        expect(stand.getAttribute('role')).toBe('button');
        expect(stand.getAttribute('aria-disabled')).toBe('true');
        expect(stand.getAttribute('aria-label')).toBe('Current branch: clowdy/ab12cd34');
        expect(stand.textContent).toBe('clowdy/ab12cd34');
        expect(stand.querySelector('button')?.disabled).toBe(true);
        expect(stand.querySelector('svg:last-of-type[class*="chevron"]')).toBeNull();

        const read = vi.spyOn(transport, 'getGitBranches');

        await press(stand);
        await settle();
        expect(popover()).toBeNull();
        expect(read).not.toHaveBeenCalled();
    });

    it('says why on hover and on focus', async () => {
        await start({ key: WORKTREE });

        const stand = trigger()!;

        await act(async () => {
            stand.focus();
            stand.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 1600));
        });

        expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('A chat\'s worktree keeps its branch');
    });
});

describe('the title of the Changes sidebar where there is no branch to change', () => {
    it('is the name alone for a branch that has no commit, and nothing to press', async () => {
        await start();
        vi.spyOn(transport, 'getGitStatus').mockResolvedValue({ isRepository: true, head: { kind: 'unborn', name: 'main' }, origin: false, entries: [], base: { state: 'unborn' } });
        await act(async () => gitFactsOf(transport).refresh(CHECKOUT));
        await settle();
        await settle();

        expect(trigger()).toBeNull();
        expect(container.textContent).toContain('main');
    });
});
