// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { busyEnter } from '../chats/busyEnter';
import { ChatPage } from './ChatPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const LABEL = 'Send a message while the agent is working';
const choice = (label: string) => [...container.querySelectorAll<HTMLElement>(`[aria-label="${ LABEL }"] [role="radio"]`)].find(item => item.textContent === label)!;

beforeEach(() => {
    busyEnter.setMode('steer');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ChatPage />));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    busyEnter.setMode('steer');
});

describe('ChatPage', () => {
    it('offers how a message sent while the agent works goes, steering by default', () => {
        expect(container.querySelector(`[aria-label="${ LABEL }"]`)).not.toBeNull();
        expect(choice('Steer').getAttribute('aria-checked')).toBe('true');
        expect(choice('Queue').getAttribute('aria-checked')).toBe('false');
        expect(container.textContent).toContain('Steer it into the current turn, or queue it for the next one. Press Ctrl+Enter to use the other option.');
        // The tips of the choices are tooltips, not text under the row.
        expect(container.textContent).not.toContain('Steer sends your message');
    });

    it('keeps the choice for the message box', () => {
        act(() => choice('Queue').click());

        expect(busyEnter.mode).toBe('queue');

        // The app's components observe the store; a test draws again by hand.
        act(() => root.render(<ChatPage />));

        expect(choice('Queue').getAttribute('aria-checked')).toBe('true');
    });
});
