// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearancePage } from './AppearancePage';

const theme = vi.hoisted(() => ({ current: 'system', set: vi.fn() }));

vi.mock('../../theme', () => ({
    getTheme: () => theme.current,
    setTheme: (next: string) => {
        theme.current = next;
        theme.set(next);
    },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const card = (label: string) => container.querySelector<HTMLElement>(`[role="button"][aria-label="${label}"]`)!;

beforeEach(() => {
    theme.current = 'system';
    theme.set.mockClear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<AppearancePage />));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('AppearancePage', () => {
    it('offers light, dark and system, with the current one pressed', () => {
        expect(['Light', 'Dark', 'System'].map(label => card(label).getAttribute('aria-pressed'))).toEqual([
            'false',
            'false',
            'true',
        ]);
    });

    it('applies a theme on click and presses its card', () => {
        act(() => card('Dark').click());

        expect(theme.set).toHaveBeenCalledWith('dark');
        expect(['Light', 'Dark', 'System'].map(label => card(label).getAttribute('aria-pressed'))).toEqual([
            'false',
            'true',
            'false',
        ]);
    });

    it('applies a theme from the keyboard with Enter or Space', () => {
        act(() => card('Light').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        act(() => card('Dark').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));

        expect(theme.set.mock.calls).toEqual([['light'], ['dark']]);
    });
});
