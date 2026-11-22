// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tab, TabStrip } from './TabStrip';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    // happy-dom has no layout: the scroll into view is only observed.
    Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const closeButton = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${ name }"]`)!;

describe('TabStrip', () => {
    it('lists the tabs under a named tab list, with the end after it', () => {
        act(() => root.render(
            <TabStrip aria-label="Terminals" end={ <button type="button">Add</button> }>
                <Tab label="one" closeLabel="Close one" onSelect={ () => undefined } onClose={ () => undefined } />
                <Tab label="two" active closeLabel="Close two" onSelect={ () => undefined } onClose={ () => undefined } />
            </TabStrip>
        ));

        const list = host.querySelector('[role="tablist"]')!;

        expect(list.getAttribute('aria-label')).toBe('Terminals');
        expect(tabs().map(tab => tab.textContent)).toEqual(['one', 'two']);
        expect(tabs().map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
        expect(list.contains(host.querySelector('[aria-label="Close one"]'))).toBe(true);
        expect(list.contains([...host.querySelectorAll('button')].find(button => button.textContent === 'Add')!)).toBe(false);
    });

    it('selects with the name and closes with the cross or the middle button', () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();

        act(() => root.render(
            <TabStrip>
                <Tab label="one" icon={ <i data-icon /> } closeLabel="Close one" onSelect={ onSelect } onClose={ onClose } />
            </TabStrip>
        ));

        expect(tabs()[0].querySelector('[data-icon]')).not.toBeNull();

        act(() => tabs()[0].click());
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();

        const tab = tabs()[0].parentElement!;
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });

        act(() => void tab.dispatchEvent(down));
        // The middle button must not start the browser's autoscroll.
        expect(down.defaultPrevented).toBe(true);

        act(() => void tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })));
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => void tab.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 })));
        expect(onClose).toHaveBeenCalledTimes(1);

        act(() => {
            const cross = closeButton('Close one');

            cross.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
            cross.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', button: 0, isPrimary: true }));
            cross.click();
        });
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('marks a tab that is chosen, unsaved or gone, and scrolls the chosen one into view', () => {
        const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
        const noop = () => undefined;
        const strip = (active: boolean) => (
            <TabStrip>
                <Tab label="one" active={ active } dirty deleted closeLabel="Close one" onSelect={ noop } onClose={ noop } />
            </TabStrip>
        );

        act(() => root.render(strip(false)));

        const tab = tabs()[0].parentElement!;

        expect(tab.hasAttribute('data-active')).toBe(false);
        expect(tab.hasAttribute('data-dirty')).toBe(true);
        expect(tab.hasAttribute('data-deleted')).toBe(true);
        expect(scroll).not.toHaveBeenCalled();

        act(() => root.render(strip(true)));
        expect(tab.hasAttribute('data-active')).toBe(true);
        expect(scroll).toHaveBeenCalledTimes(1);
    });
});
