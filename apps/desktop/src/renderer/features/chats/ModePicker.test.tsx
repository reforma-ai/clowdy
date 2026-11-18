// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModePicker } from './ModePicker';

import type { ChatMode } from '@clowdy/protocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const pill = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!;
const rows = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')];

/** A press with a mouse: what React Aria opens a menu on. */
async function open(trigger: HTMLElement) {
    await act(async () => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        trigger.click();
    });
}

const draw = (mode: ChatMode, onPick = vi.fn(), isDisabled = false) => act(async () => root.render(<ModePicker mode={ mode } onPick={ onPick } isDisabled={ isDisabled } />));

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
});

describe('ModePicker', () => {
    it('is a pill that names the mode', async () => {
        await draw('autopilot');

        expect(pill().textContent).toBe('Autopilot');

        await draw('semi');
        expect(pill().textContent).toBe('Semi-manual');
    });

    it('opens both modes, each with what it does, the chosen one ticked', async () => {
        await draw('semi');
        await open(pill());

        expect(rows().map(row => row.textContent)).toEqual([
            expect.stringContaining('Autopilot'),
            expect.stringContaining('Semi-manual'),
        ]);
        expect(rows()[0].textContent).toContain('Decides on its own');
        expect(rows()[1].textContent).toContain('Asks you before a significant fork');
        expect(rows().map(row => row.getAttribute('aria-checked'))).toEqual(['false', 'true']);
        expect(rows()[1].querySelector('svg')).not.toBeNull();
        expect(rows()[0].querySelector('svg')).toBeNull();
    });

    it('picks the other mode, and says nothing when the chosen one is picked again', async () => {
        const onPick = vi.fn();

        await draw('autopilot', onPick);
        await open(pill());
        await act(async () => rows()[0].click());
        expect(onPick).not.toHaveBeenCalled();

        await open(pill());
        await act(async () => rows()[1].click());
        expect(onPick).toHaveBeenCalledWith('semi');
    });

    it('stays shut when the mode cannot change', async () => {
        await draw('autopilot', vi.fn(), true);
        await open(pill());

        expect(pill().disabled).toBe(true);
        expect(rows()).toHaveLength(0);
    });
});
