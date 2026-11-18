// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Loader } from './Loader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Loader', () => {
    it('is a status region named Loading, in the size asked for', async () => {
        await act(async () => root.render(<Loader size="xxl" className="mine" />));

        const region = container.querySelector('[role="status"]');

        expect(region?.getAttribute('aria-label')).toBe('Loading');
        expect(region?.getAttribute('data-size')).toBe('xxl');
        expect(region?.className).toContain('mine');
    });

    it('stays an empty region, and breaks nothing, when the animation cannot start (no canvas here)', async () => {
        await act(async () => root.render(<Loader />));
        // The player and the animation load on first use.
        await act(async () => {
            await new Promise(resolve => setTimeout(resolve, 100));
        });

        expect(container.querySelector('[role="status"]')).not.toBeNull();
    });
});
