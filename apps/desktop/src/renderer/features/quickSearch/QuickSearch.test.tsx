// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FIXTURE_PROJECT_ID } from '../../daemon/fixtureData';
import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore } from '../../stores';
import { filesStoreOf } from '../files/useFilesStore';
import { openQuickSearch } from './openQuickSearch';
import { TYPING_DELAY } from './QuickSearchModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: RootStore;

const memoryStorage = () => {
    const data: Record<string, string> = {};

    return { getItem: (key: string) => data[key] ?? null, setItem: (key: string, value: string) => void (data[key] = value) };
};

/** The window draws on the next animation frame and its content mounts a little later; a search waits out the pause of typing and a round trip. */
async function settle(ms = 60) {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, ms));
    });
}

const field = () => document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
const names = () => rows().map(row => row.textContent);
const note = () => document.body.querySelector('[role="status"], [role="alert"]')?.textContent;
const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"], button[aria-pressed]')].filter(button => ['All', 'Files', 'Text'].includes(button.textContent ?? ''));
const selected = () => rows().find(row => row.hasAttribute('data-active'));

function type(value: string) {
    act(() => {
        field().focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
        field().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

const press = (key: string, init: KeyboardEventInit = {}) => act(() => {
    field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
});

async function search(value: string) {
    type(value);
    await settle(TYPING_DELAY + 100);
}

async function open(tab: Parameters<typeof openQuickSearch>[1]) {
    act(() => openQuickSearch(store, tab));
    await settle();
}

const manager = () => {
    const project = store.selectedProject!;

    return filesStoreOf(store).managerOf(project.project.id, project.project.folders[0]!.id);
};

beforeEach(async () => {
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));

    store = new RootStore(new FixtureTransport(), { storage: memoryStorage() });
    await store.load();
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    store.dispose();
    document.body.innerHTML = '';
});

describe('the quick search palette', () => {
    it('opens on the tab it was asked for, with the field focused and a hint for it', async () => {
        await open('files');

        expect(document.activeElement).toBe(field());
        expect(field().placeholder).toBe('Search files by name');
        expect(note()).toBe('Type the name of a file, or a part of its path');
        expect(tabs().find(tab => tab.getAttribute('aria-pressed') === 'true' || tab.getAttribute('aria-checked') === 'true' || tab.getAttribute('aria-selected') === 'true')?.textContent).toBe('Files');
    });

    it('lists the files whose names have what was typed, the best first, and marks the part that matched', async () => {
        await open('files');
        await search('price');

        expect(names()).toEqual(['price.tssrc/booking', 'price.test.tssrc/booking']);
        expect(rows()[0]!.querySelector('mark')?.textContent).toBe('price');
        expect(selected()).toBe(rows()[0]);
    });

    it('finds the lines of files that have the words, with where they are, and tells when there is nothing', async () => {
        await open('text');
        await search('weekend');

        expect(rows().map(row => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('price.ts:1')]));
        expect(rows().every(row => row.querySelector('mark'))).toBe(true);

        await search('no such words in any file');

        expect(rows()).toEqual([]);
        expect(note()).toBe('No matches');
    });

    it('shows the chats, the files and the lines in one list on the All tab, with a heading for each', async () => {
        await open('all');
        await search('booking');

        const headings = [...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map(group => group.getAttribute('aria-label'));

        expect(headings).toEqual(['Chats', 'Docs', 'Files', 'Text']);
    });

    it('lists the latest chats of the project before anything is typed, and finds the ones whose title has the words', async () => {
        await open('chats');

        const latest = [...store.selectedProject!.chats.values()].filter(chat => chat.archivedAt === undefined && chat.parentChatId === undefined).toSorted((a, b) => b.updatedAt - a.updatedAt).map(chat => chat.title);

        expect(names()).toEqual(latest);
        expect(field().placeholder).toBe('Search chats by title');

        await search('architecture');

        expect(names()).toEqual(['Architecture questions']);
        expect(rows()[0]!.querySelector('mark')?.textContent).toBe('Architecture');

        await search('no chat has these words');

        expect(rows()).toEqual([]);
        expect(note()).toBe('No chats found');
    });

    it('lists an archived chat that answers under its own heading, after the chats in use, with no note on its row', async () => {
        const project = store.selectedProject!;
        const archived = [...project.chats.values()].find(chat => chat.title === 'First version')!;

        act(() => void project.chats.set(archived.id, { ...archived, title: 'Booking first version', archivedAt: Date.now() }));
        await open('chats');
        await search('booking');

        const groups = [...document.body.querySelectorAll('[role="listbox"] [role="group"]')];

        expect(groups.map(group => group.getAttribute('aria-label'))).toEqual(['Chats', 'Archived chats']);
        expect([...groups[1]!.querySelectorAll('[role="option"]')].map(row => row.textContent)).toEqual(['Booking first version']);
    });

    it('shows the latest chats on the All tab while nothing is typed, and nothing of the files', async () => {
        await open('all');

        expect(names().length).toBeGreaterThan(0);
        expect([...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map(group => group.getAttribute('aria-label'))).toEqual(['Recent chats']);
    });

    it('opens the chat of the row on Enter, in the Agents section, and leaves the side panel as it was', async () => {
        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);
        const target = [...store.selectedProject!.chats.values()].find(chat => chat.title === 'Architecture questions')!;

        act(() => store.ui.showSection(ui, 'tasks'));
        await open('chats');
        await search('architecture');
        press('Enter');
        await settle(200);

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();
        expect(ui.chatId).toBe(target.id);
        expect(ui.section).toBe('agents');
        expect(ui.sidePanelOpen).toBe(false);
    });

    it('moves the row with the arrows, and opens the file of the row on Enter in the side panel\'s Files tab, which it shows', async () => {
        await open('files');
        await search('price');
        press('ArrowDown');

        expect(selected()).toBe(rows()[1]);
        expect(field().getAttribute('aria-activedescendant')).toBe(rows()[1]!.id);

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        expect(ui.sidePanelOpen).toBe(false);

        press('Enter');
        await settle(200);

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();
        expect(ui.sidePanelOpen).toBe(true);
        expect(ui.sidePanelTab).toBe('files');
        expect(manager().tabs.active?.path).toBe('src/booking/price.test.ts');
    });

    it('opens a line of text with its match selected', async () => {
        await open('text');
        await search('weekendRate');
        press('Enter');
        await settle(200);

        const active = manager().tabs.active;

        expect(active?.path).toBe('src/booking/price.ts');
        expect(manager().tabs.active?.state?.selection.main.empty).toBe(false);
    });

    it('opens a row that is pressed', async () => {
        await open('files');
        await search('schema');

        await act(async () => rows()[0]!.click());
        await settle(200);

        expect(manager().tabs.active?.path).toBe('src/db/schema.ts');
    });

    it('changes the tab with Tab and Shift+Tab, keeping the focus in the field, and goes to the tab it is asked for when it is open already', async () => {
        await open('all');
        await search('price');
        press('Tab');
        await settle();

        expect(field().placeholder).toBe('Search chats by title');

        press('Tab');
        await settle();

        expect(field().placeholder).toBe('Search documents by name');

        press('Tab');
        await settle();

        expect(field().placeholder).toBe('Search files by name');
        expect(document.activeElement).toBe(field());
        expect(document.body.querySelectorAll('[role="listbox"] [role="group"]')).toHaveLength(1);

        press('Tab', { shiftKey: true });
        press('Tab', { shiftKey: true });
        press('Tab', { shiftKey: true });
        press('Tab', { shiftKey: true });
        await settle();

        expect(field().placeholder).toBe('Search the text in files');

        await open('files');

        expect(field().placeholder).toBe('Search files by name');
        expect(document.body.querySelectorAll('input[role="combobox"]')).toHaveLength(1);
    });

    it('finds the documents below .clowdy/docs, which the file names leave out, and opens one in the Docs tab', async () => {
        await open('files');
        await search('pricing');

        expect(rows()).toEqual([]);

        await open('docs');

        expect(field().placeholder).toBe('Search documents by name');

        await search('pricing');

        expect(names()).toEqual(['pricing.mddecisions']);
        expect(rows()[0]!.querySelector('mark')?.textContent).toBe('pricing');

        const ui = store.ui.forProject(FIXTURE_PROJECT_ID);

        press('Enter');
        await settle(200);

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();
        expect(ui.sidePanelOpen).toBe(true);
        expect(ui.sidePanelTab).toBe('docs');
        expect(manager().tabs.active?.path).toBe('.clowdy/docs/decisions/pricing.md');
    });

    it('finds a file the tree shows although the project\'s list of files leaves it out, as it does one that git ignores', async () => {
        // The fixture's list has no tsconfig.json, its folder has.
        await open('files');
        await search('tsconfig');

        expect(names()).toEqual(['tsconfig.json']);
    });

    it('does not show the hidden files until the tree does, and not the ones of another folder', async () => {
        await open('files');
        await search('gitignore');

        expect(rows()).toEqual([]);
        expect(note()).toBe('No files found');
    });

    it('closes with Escape, and opens again afterwards', async () => {
        await open('files');
        act(() => void field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await settle();

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();

        await open('text');

        expect(field().placeholder).toBe('Search the text in files');
    });

    it('does not open over another dialog, which the keys would otherwise reach', async () => {
        act(() => void Modal.create({ id: 'other', component: <p>Another dialog</p> }));
        await settle();
        await open('files');

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();
        expect(document.body.textContent).toContain('Another dialog');
    });

    it('is not opened where there is no project', async () => {
        store.selectedProjectId = null;
        await open('all');

        expect(document.body.querySelector('[role="combobox"]')).toBeNull();
    });
});
