// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixtureTransport } from '../../daemon/fixtureTransport';
import { RootStore, RootStoreProvider } from '../../stores';
import { HALF_MIN_WINDOW_WIDTH } from './panelWidth';
import { useWindowFitsHalf } from './useWindowFitsHalf';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
    useWindowFitsHalf();

    return null;
}

/** A window of this width, as `matchMedia` of a min-width query sees it, that can be resized. */
function fakeWindow(width: number) {
    const listeners = new Set<() => void>();
    const queries: string[] = [];
    const matchMedia = (query: string) => {
        queries.push(query);
        const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1]);

        return {
            get matches() {
                return width >= min;
            },
            addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
            removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
        };
    };

    vi.stubGlobal('matchMedia', matchMedia);

    return {
        queries,
        listeners,
        resize(next: number) {
            width = next;
            act(() => listeners.forEach(listener => listener()));
        },
    };
}

let container: HTMLDivElement;
let root: Root;
let store: RootStore;

beforeEach(() => {
    store = new RootStore(new FixtureTransport());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.dispose();
    vi.unstubAllGlobals();
});

const mount = () =>
    act(() =>
        root.render(
            <RootStoreProvider value={store}>
                <Probe />
            </RootStoreProvider>
        )
    );

describe('useWindowFitsHalf', () => {
    it('asks for the width from which a tree fits beside the chat, and tells the window state at once', () => {
        const window = fakeWindow(HALF_MIN_WINDOW_WIDTH - 1);

        mount();

        expect(window.queries).toEqual([`(min-width: ${HALF_MIN_WINDOW_WIDTH}px)`]);
        expect(store.ui.windowFitsHalf).toBe(false);
    });

    it('follows the window as it grows past that width and shrinks under it', () => {
        const window = fakeWindow(1000);

        mount();
        expect(store.ui.windowFitsHalf).toBe(false);

        window.resize(HALF_MIN_WINDOW_WIDTH);
        expect(store.ui.windowFitsHalf).toBe(true);

        window.resize(HALF_MIN_WINDOW_WIDTH - 1);
        expect(store.ui.windowFitsHalf).toBe(false);
    });

    it('stops listening when the shell is gone', () => {
        const window = fakeWindow(2000);

        mount();
        expect(window.listeners.size).toBe(1);

        act(() => root.render(<RootStoreProvider value={store}>{null}</RootStoreProvider>));
        expect(window.listeners.size).toBe(0);
    });
});
