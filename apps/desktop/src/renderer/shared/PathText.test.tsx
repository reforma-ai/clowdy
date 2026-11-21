// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { homeFolder } from './homeFolder';
import { PathText } from './PathText';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * happy-dom does no layout, so the width of the row and of the words is set by hand: the words are 7px a character, the row is `room` px.
 */

let container: HTMLDivElement;
let root: Root;
let room = 1000;
let resized: (() => void) | undefined;

const text = () => container.querySelector('span')!;
const draw = (path: string) => act(async () => root.render(<PathText path={ path } />));

beforeEach(() => {
    room = 1000;
    resized = undefined;
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return (this.textContent ?? '').length * 7;
        },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => room });
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) {
            resized = callback;
        }

        observe() {}
        disconnect() {}
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    homeFolder.set('/Users/me');
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    vi.unstubAllGlobals();
    homeFolder.set(undefined);
});

describe('PathText', () => {
    it('shows the home folder as ~ and tells the whole path on hover', async () => {
        await draw('/Users/me/WORK/Reforma/plugins');

        expect(text().textContent).toBe('~/WORK/Reforma/plugins');
        expect(text().getAttribute('title')).toBe('/Users/me/WORK/Reforma/plugins');
        expect(text().getAttribute('aria-label')).toBe('/Users/me/WORK/Reforma/plugins');
    });

    it('shows a path in full while the home folder is not known, and one elsewhere', async () => {
        homeFolder.set(undefined);
        await draw('/Users/me/code');

        expect(text().textContent).toBe('/Users/me/code');

        homeFolder.set('/Users/me');
        await draw('/opt/tools/code');

        expect(text().textContent).toBe('/opt/tools/code');
    });

    it('leaves the middle names out when the row is too narrow, the longest form that fits', async () => {
        room = 100;
        await draw('/Users/me/Foo/bar/baz/foo');

        // Whole: `~/Foo/bar/baz/foo` (17 characters, 119px) does not fit 100px; `~/Foo/…/baz/foo` (15, 105px) does not; `~/…/baz/foo` (11, 77px) does.
        expect(text().textContent).toBe('~/…/baz/foo');

        room = 110;
        act(() => resized?.());

        expect(text().textContent).toBe('~/Foo/…/baz/foo');
    });

    it('keeps the last form when none fits, for the ellipsis of the style to cut', async () => {
        room = 20;
        await draw('/Users/me/Foo/bar/baz/foo');

        expect(text().textContent).toBe('…/foo');
    });

    it('chooses again when the row changes its width', async () => {
        room = 100;
        await draw('/Users/me/Foo/bar/baz/foo');

        expect(text().textContent).toBe('~/…/baz/foo');

        room = 1000;
        act(() => resized?.());

        expect(text().textContent).toBe('~/Foo/bar/baz/foo');

        room = 60;
        act(() => resized?.());

        expect(text().textContent).toBe('~/…/foo');
    });

    it('shows the new path when the path changes', async () => {
        await draw('/Users/me/one');
        await draw('/Users/me/two/three');

        expect(text().textContent).toBe('~/two/three');
    });
});
