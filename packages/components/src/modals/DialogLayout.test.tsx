// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import Modal from '../Modal/Modal';
import { DialogLayout } from './DialogLayout';
import { openFormDialog } from './openFormDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The modal draws on the next animation frame and its content mounts a little later. */
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
    });

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)!;
const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
        document.activeElement!.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        );
    });

async function open() {
    const modal = openFormDialog({
        width: 400,
        animate: false,
        component: (
            <DialogLayout
                title="New worktree"
                actions={
                    <>
                        <button type="button">Cancel</button>
                        <button type="button">Create</button>
                    </>
                }
            >
                <input aria-label="Branch" />
            </DialogLayout>
        ),
    });

    await settle();

    return modal;
}

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    document.body.innerHTML = '';
});

describe('a form dialog', () => {
    it('is a modal dialog named by its title', async () => {
        await open();

        const title = document.getElementById(dialog().getAttribute('aria-labelledby')!);

        expect([dialog().getAttribute('aria-modal'), title?.tagName, title?.textContent]).toEqual([
            'true',
            'H2',
            'New worktree',
        ]);
    });

    it('takes Tab from its last control back to its first', async () => {
        await open();
        button('Create').focus();

        await press('Tab');

        expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    });

    it('takes Shift+Tab from its first control to its last', async () => {
        await open();
        document.querySelector<HTMLElement>('[aria-label="Close"]')!.focus();

        await press('Tab', { shiftKey: true });

        expect(document.activeElement).toBe(button('Create'));
    });

    it('stays open on Escape while it is not dismissable', async () => {
        const modal = await open();
        modal.setDismissable(false);
        button('Create').focus();

        await press('Escape');
        await settle();

        expect(Modal.opened).toContain(modal);
    });
});
