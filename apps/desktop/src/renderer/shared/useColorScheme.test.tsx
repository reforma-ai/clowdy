// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { useColorScheme } from './useColorScheme';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Example() {
    return <p>{useColorScheme()}</p>;
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    document.documentElement.classList.remove('dark');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.documentElement.classList.remove('dark');
});

it('follows the theme class on the page', async () => {
    act(() => root.render(<Example />));
    expect(host.textContent).toBe('light');

    await act(async () => {
        document.documentElement.classList.add('dark');
        await Promise.resolve();
    });
    expect(host.textContent).toBe('dark');

    await act(async () => {
        document.documentElement.classList.remove('dark');
        await Promise.resolve();
    });
    expect(host.textContent).toBe('light');
});
