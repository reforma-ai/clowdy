// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileChip } from './FileChip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

const press = async (path: string) => {
    await act(async () => root.render(<FileChip path={ path } />));
    await act(async () => container.querySelector('button')!.click());
};

describe('FileChip', () => {
    it('shows the name of the file, with the whole path on hover', async () => {
        await act(async () => root.render(<FileChip path="./src/booking/price.ts" lines="12-20" />));

        const chip = container.querySelector('button')!;

        expect(chip.textContent).toBe('price.ts (12-20)');
        expect(chip.title).toBe('src/booking/price.ts');
    });

    it('copies the path when it is pressed', async () => {
        await press('./src/booking/price.ts');

        expect(writeText).toHaveBeenCalledExactlyOnceWith('src/booking/price.ts');
    });

    it('copies an absolute path as it was written', async () => {
        await press('/Users/me/project/src/a.ts');

        expect(writeText).toHaveBeenCalledExactlyOnceWith('/Users/me/project/src/a.ts');
    });
});
