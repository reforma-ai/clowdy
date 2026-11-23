// @vitest-environment happy-dom
import { observer } from 'mobx-react-lite';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChordHud } from './ChordHud';
import { installDispatcher } from './dispatcher';
import { createRegistry, type HotkeyRegistry } from './registry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The babel plugin that makes the app's components observers does not run under Vitest.
const Hud = observer(ChordHud);

let container: HTMLDivElement;
let root: Root;
let registry: HotkeyRegistry;
let uninstall: () => void;

const press = (key: string) =>
    act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
const hud = () => container.querySelector('[role="status"]');
const capsules = () => Array.from(container.querySelectorAll('[data-hotkey]'), element => element.textContent);

beforeEach(() => {
    registry = createRegistry('darwin');

    for (const [id, title, keys] of [
        ['nav.tasks', 'Go to Tasks', 'g t'],
        ['nav.chats', 'Go to Chats', 'g c'],
        ['tasks.type', 'Type a note', 'o n x'],
    ]) {
        registry.defineCommand({ id, title, group: 'Navigation', keys, scope: 'app', handler: () => undefined });
    }

    uninstall = installDispatcher(registry);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<Hud registry={registry} />));
});

afterEach(() => {
    act(() => root.unmount());
    uninstall();
    container.remove();
});

describe('ChordHud', () => {
    it('shows nothing while no chord waits', () => {
        expect(hud()).toBeNull();
        expect(container.innerHTML).toBe('');
    });

    it('shows the keys typed so far and what each next key does', () => {
        press('g');

        expect(hud()).not.toBeNull();
        expect(capsules()).toEqual(['G', 'T', 'C']);
        expect(hud()?.textContent).toContain('Go to Tasks');
        expect(hud()?.textContent).toContain('Go to Chats');
        expect(hud()?.textContent).not.toContain('Type a note');
    });

    it('shows the rest of a longer chord as a sequence, and the keys typed grow with it', () => {
        press('o');

        expect(capsules()).toEqual(['O', 'N', 'X']);
        expect(hud()?.textContent).toBe('ONthenXType a note');

        press('n');

        expect(capsules()).toEqual(['O', 'N', 'X']);
        expect(hud()?.textContent).toBe('OthenNXType a note');
    });

    it('goes away when the chord completes', () => {
        press('g');
        press('t');

        expect(hud()).toBeNull();
    });

    it('goes away on Escape', () => {
        press('g');
        press('Escape');

        expect(hud()).toBeNull();
    });

    it('goes away when a key that continues nothing breaks the chord', () => {
        press('g');
        press('z');

        expect(hud()).toBeNull();
    });

    it('goes away when the chord times out', () => {
        vi.useFakeTimers();

        try {
            press('g');

            expect(hud()).not.toBeNull();

            act(() => {
                vi.advanceTimersByTime(1000);
            });

            expect(hud()).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
