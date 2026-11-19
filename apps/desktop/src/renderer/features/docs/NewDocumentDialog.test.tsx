// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openNewDocument } from './NewDocumentDialog';

import type { DocsStore } from './DocsStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FOLDERS = [{ folderId: 'f1', name: 'app', path: '/work/app' }, { folderId: 'f2', name: 'api', path: '/work/api' }];

/** What the dialog reads from the store: the folders, where a new document goes by default, and the call that makes it. */
function fakeStore(folderCount = 2) {
    return {
        folders: FOLDERS.slice(0, folderCount),
        multiFolder: folderCount > 1,
        newDocumentFolder: 'f1',
        createDocument: vi.fn(async (input: string) => ({ ok: true as const, path: `${ input }.md` })),
    };
}

/** The modal draws on the next animation frame and its content mounts a little later. */
const settle = () => act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60));
});

const pointer = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, width: 1, height: 1, pressure: 0.5, detail: 1 };

const press = (element: Element) => act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', pointer));
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new PointerEvent('pointerup', pointer));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
});

const form = () => document.querySelector<HTMLFormElement>('[data-modal-window] form');
const folderField = () => form()?.querySelector<HTMLButtonElement>('button[aria-label="Folder"]') ?? null;
const option = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(candidate => candidate.textContent?.includes(name))!;

async function open(store: ReturnType<typeof fakeStore>, folderId?: string) {
    act(() => openNewDocument(store as unknown as DocsStore, folderId));
    await settle();
}

async function create(name: string) {
    const input = form()!.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;

    act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
        form()!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
}

beforeEach(() => {
    // The modal animates by itself, whatever the motion setting; a test that ends while it moves leaves a cancelled animation behind.
    const create = Modal.create.bind(Modal);

    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('New document dialog', () => {
    it('has no Folder field in a project of one folder', async () => {
        const store = fakeStore(1);

        await open(store);

        expect(form()).not.toBeNull();
        expect(folderField()).toBeNull();

        await create('pricing');
        expect(store.createDocument).toHaveBeenCalledWith('pricing', 'f1');
    });

    it('starts on the folder the store names, and makes the document in the folder picked instead', async () => {
        const store = fakeStore();

        await open(store);

        expect(folderField()?.textContent).toContain('app');

        await press(folderField()!);
        await press(option('api'));

        expect(folderField()?.textContent).toContain('api');

        await create('endpoints');
        expect(store.createDocument).toHaveBeenCalledWith('endpoints', 'f2');
    });

    it('starts on the folder of the row it was opened from', async () => {
        const store = fakeStore();

        await open(store, 'f2');

        expect(folderField()?.textContent).toContain('api');

        await create('limits');
        expect(store.createDocument).toHaveBeenCalledWith('limits', 'f2');
    });
});
