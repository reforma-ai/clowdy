// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { busyEnter } from '../chats/busyEnter';
import { ChatPage } from './ChatPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const choice = (label: string) => [...container.querySelectorAll<HTMLElement>('[aria-label="Enter while the agent works"] [role="radio"]')].find(item => item.textContent === label)!;

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
    it('offers what Enter does while the agent works, steering by default', () => {
        expect(container.querySelector('[aria-label="Enter while the agent works"]')).not.toBeNull();
        expect(choice('Steer the current turn').getAttribute('aria-checked')).toBe('true');
        expect(choice('Queue for the next turn').getAttribute('aria-checked')).toBe('false');
    });

    it('keeps the choice for the message box', () => {
        act(() => choice('Queue for the next turn').click());

        expect(busyEnter.mode).toBe('queue');

        // The app's components observe the store; a test draws again by hand.
        act(() => root.render(<ChatPage />));

        expect(choice('Queue for the next turn').getAttribute('aria-checked')).toBe('true');
    });
});
