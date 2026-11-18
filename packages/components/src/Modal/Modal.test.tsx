// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Modal from './Modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let opener: HTMLButtonElement;

/** The modal draws on the next animation frame and its content mounts a little later. */
async function settle() {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
    });
}

function open(component: React.ReactNode) {
    return Modal.create({ component, animate: false, closeOnEscape: true, clickOut: false, type: 'overlay' });
}

beforeEach(() => {
    opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.append(opener);
    opener.focus();
});

afterEach(async () => {
    for (const modal of Modal.opened) await modal.close(false);

    document.body.innerHTML = '';
});

describe('Modal focus', () => {
    it('hands focus back to the element that had it when the content focuses itself first', async () => {
        const modal = open(<button id="confirm" autoFocus>Confirm</button>);

        await settle();

        expect(document.activeElement?.id).toBe('confirm');

        await act(async () => modal.cancel());
        await settle();

        expect(document.activeElement).toBe(opener);
    });

    it('hands focus back when nothing inside takes it', async () => {
        const modal = open(<p>Nothing to focus</p>);

        await settle();

        expect(document.activeElement).not.toBe(opener);

        await act(async () => modal.cancel());
        await settle();

        expect(document.activeElement).toBe(opener);
    });

    it('does not restore focus when asked not to', async () => {
        const modal = open(<button id="confirm" autoFocus>Confirm</button>);

        await settle();
        await act(async () => modal.cancel({ restoreFocus: false }));
        await settle();

        expect(document.activeElement).not.toBe(opener);
    });
});
