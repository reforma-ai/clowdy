// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Scrollable } from './Scrollable';

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

describe('Scrollable', () => {
    it('draws a thumb, and leaves it out when scrollbar is off', async () => {
        await act(async () =>
            root.render(
                <Scrollable>
                    <div>Notes</div>
                </Scrollable>
            )
        );

        const withThumb = container.firstElementChild;

        expect(withThumb?.childElementCount).toBe(2);

        await act(async () =>
            root.render(
                <Scrollable scrollbar={false}>
                    <div>Notes</div>
                </Scrollable>
            )
        );

        expect(container.firstElementChild?.childElementCount).toBe(1);
        expect(container.textContent).toContain('Notes');
    });
});
