// @vitest-environment happy-dom
import { Modal } from '@clowdy/components/Modal';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../daemon/fixtureTransport';
import { openAddFolderDialog } from './AddFolderDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settle = () => act(async () => void (await new Promise(resolve => setTimeout(resolve, 60))));
const button = (name: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === name)!;
const press = async (name: string) => {
    await act(async () => button(name).click());
    await settle();
};
const open = async (onAdd: (paths: string[]) => void) => {
    act(() => openAddFolderDialog(new FixtureTransport(), onAdd));
    await settle();
};

beforeEach(() => {
    const create = Modal.create.bind(Modal);
    vi.spyOn(Modal, 'create').mockImplementation(options => create({ ...options, animate: false }));
});

afterEach(async () => {
    for (const modal of [...Modal.opened].reverse()) await act(async () => modal.close(false));
    vi.restoreAllMocks();
    delete (window as { desktop?: unknown }).desktop;
    document.body.innerHTML = '';
});

describe('Add to project', () => {
    it('lets a browser add a typed path and closes the dialog', async () => {
        const onAdd = vi.fn();
        await open(onAdd);
        await press('Choose folder on computer');
        const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Folder path"]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '/work/project/');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await press('Add folder');

        expect(onAdd).toHaveBeenCalledExactlyOnceWith(['/work/project']);
        expect(Modal.opened).toHaveLength(0);
    });

    it('keeps the dialog usable when the picker is cancelled or fails', async () => {
        const choose = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('unavailable'));
        (window as { desktop?: unknown }).desktop = { chooseDirectories: choose };
        const onAdd = vi.fn();
        await open(onAdd);
        await press('Choose folder on computer');
        await press('Choose folder on computer');

        expect(onAdd).not.toHaveBeenCalled();
        expect(button('Choose folder on computer').disabled).toBe(false);
        expect(button('Clone Git repository').disabled).toBe(false);
    });

    it('returns focus to the original button after opening and closing the clone form', async () => {
        const trigger = document.createElement('button');
        document.body.append(trigger);
        trigger.focus();
        await open(vi.fn());
        await press('Clone Git repository');
        expect(document.body.querySelector('input[aria-label="Repository address"]')).not.toBeNull();
        await act(async () => Modal.opened.at(-1)!.cancel());
        await settle();

        expect(document.activeElement).toBe(trigger);
    });

    it('ignores the picker result if the dialog was dismissed before it arrived', async () => {
        let resolve!: (paths: string[]) => void;
        const choose = vi.fn(
            () =>
                new Promise<string[]>(done => {
                    resolve = done;
                })
        );
        (window as { desktop?: unknown }).desktop = { chooseDirectories: choose };
        const onAdd = vi.fn();
        await open(onAdd);
        await press('Choose folder on computer');
        expect(button('Clone Git repository').disabled).toBe(true);
        await act(async () => Modal.opened.at(-1)!.cancel());
        await act(async () => resolve(['/work/late']));

        expect(onAdd).not.toHaveBeenCalled();
    });
});
