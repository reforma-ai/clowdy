// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Modal from '../Modal/Modal';
import { type OpenConfirmModalOptions, openConfirmModal } from './ConfirmModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The dialog draws on the next animation frame, and a button that asks for the focus takes it after 50 ms. */
const settle = () =>
    act(async () => {
        await new Promise(resolve => setTimeout(resolve, 120));
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

const buttonOf = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        candidate => candidate.textContent?.trim() === label
    )!;
const alert = () => document.querySelector('[role="alert"]');

/** Enter pressed where no button has the focus: on the dialog's own title. */
const enterOnTitle = () =>
    act(async () => {
        const title = [...document.querySelectorAll('*')].find(
            element => element.children.length === 0 && element.textContent === 'Discard changes to a.ts?'
        );

        expect(title).toBeDefined();
        title!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });

async function open(options: Partial<OpenConfirmModalOptions> = {}) {
    openConfirmModal(
        {
            title: 'Discard changes to a.ts?',
            message: 'The file goes back to the last commit',
            confirmLabel: 'Discard changes',
            destructive: true,
            onConfirm: () => undefined,
            ...options,
        },
        { animate: false }
    );
    await settle();
}

beforeEach(() => {
    const opener = document.createElement('button');

    opener.textContent = 'Open';
    document.body.append(opener);
    opener.focus();
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    document.body.innerHTML = '';
});

describe('the confirmation dialog', () => {
    it('puts the focus on Confirm unless the dialog says Cancel is safer', async () => {
        await open();

        expect(document.activeElement).toBe(buttonOf('Discard changes'));
    });

    it('puts the focus on Cancel when the dialog asks for it, and Enter on its body confirms nothing', async () => {
        const onConfirm = vi.fn();

        await open({ initialFocus: 'cancel', onConfirm });

        expect(document.activeElement).toBe(buttonOf('Cancel'));

        await enterOnTitle();
        await settle();

        expect(onConfirm).not.toHaveBeenCalled();
        expect(Modal.opened).toHaveLength(1);
    });

    it('confirms on Enter in the body of a dialog that starts on Confirm, which is what the check above is not', async () => {
        const onConfirm = vi.fn();

        await open({ onConfirm });
        await enterOnTitle();
        await settle();

        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('says a failure in the dialog when it asks to, keeps it open with its buttons back, and clears the line on the next try', async () => {
        const onConfirm = vi
            .fn()
            .mockRejectedValueOnce(new Error('fatal: Unable to create index.lock'))
            .mockResolvedValueOnce(undefined);

        await open({ errorIn: 'dialog', initialFocus: 'cancel', onConfirm });
        await press(buttonOf('Discard changes'));
        await settle();

        expect(alert()?.textContent).toBe('fatal: Unable to create index.lock');
        expect(buttonOf('Discard changes').disabled).toBe(false);
        expect(buttonOf('Cancel').disabled).toBe(false);

        await press(buttonOf('Discard changes'));
        await settle();

        expect(onConfirm).toHaveBeenCalledTimes(2);
        // It went through: the dialog is gone, with its line.
        expect(alert()).toBeNull();
        expect(Modal.opened).toHaveLength(0);
    });

    it('holds both buttons while it works, and closes when it is done', async () => {
        let finish: () => void = () => undefined;
        const onConfirm = () =>
            new Promise<void>(resolve => {
                finish = resolve;
            });

        await open({ errorIn: 'dialog', onConfirm });
        await press(buttonOf('Discard changes'));

        expect(buttonOf('Cancel').disabled).toBe(true);
        expect(buttonOf('Discard changes').disabled).toBe(true);

        await act(async () => finish());
        await settle();

        expect(Modal.opened).toHaveLength(0);
    });

    it('keeps saying a failure in a toast without the option, as it always did', async () => {
        await open({ onConfirm: () => Promise.reject(new Error('Not saved')) });
        await press(buttonOf('Discard changes'));
        await settle();

        expect(alert()).toBeNull();
        expect(buttonOf('Discard changes').disabled).toBe(false);
    });

    it('is an alert dialog named by its title', async () => {
        await open();

        const dialog = document.querySelector('[role="alertdialog"]')!;

        expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
            'Discard changes to a.ts?'
        );
    });

    it('keeps Confirm off and Enter idle while the confirm is disabled', async () => {
        const onConfirm = vi.fn();

        await open({ isConfirmDisabled: true, onConfirm });
        await enterOnTitle();

        expect([buttonOf('Discard changes').disabled, onConfirm.mock.calls.length]).toEqual([true, 0]);
    });
});
