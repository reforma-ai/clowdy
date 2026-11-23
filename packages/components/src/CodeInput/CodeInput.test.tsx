// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeInput } from './CodeInput';

let host: HTMLDivElement;
let root: Root;

function Harness({ onSubmit }: { onSubmit?: () => void }) {
    const [value, setValue] = useState('');

    return <CodeInput aria-label="Authentication code" value={value} onChange={setValue} onSubmit={onSubmit} />;
}

const input = () => host.querySelector<HTMLInputElement>('input[aria-label="Authentication code"]')!;
const boxes = () => [...host.querySelectorAll('[aria-hidden="true"]')].map(box => box.textContent);
const activeBoxes = () =>
    [...host.querySelectorAll('[aria-hidden="true"]')].flatMap((box, index) =>
        box.hasAttribute('data-active') ? [index] : []
    );

async function type(value: string) {
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
        input().dispatchEvent(new Event('input', { bubbles: true }));
    });
}

beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

describe('CodeInput', () => {
    it('should be one field that the browser can fill with a one-time code', async () => {
        await act(async () => root.render(<Harness />));

        expect(host.querySelectorAll('input')).toHaveLength(1);
        expect(input().autocomplete).toBe('one-time-code');
        expect(input().inputMode).toBe('numeric');
        expect(boxes()).toHaveLength(6);
    });

    it('should keep the digits of a pasted code, up to six, one per box', async () => {
        await act(async () => root.render(<Harness />));
        await type(' 123 4567\n');

        expect(input().value).toBe('123456');
        expect(boxes()).toEqual(['1', '2', '3', '4', '5', '6']);

        await type('12a');

        expect(boxes()).toEqual(['1', '2', '', '', '', '']);
    });

    it('should let the caret move back into the code and show its box', async () => {
        await act(async () => root.render(<Harness />));
        await act(async () => input().focus());
        await type('123456');
        await act(async () => {
            input().setSelectionRange(2, 2);
            // As after an arrow key: React reads the selection on key release.
            input().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
        });

        // Left where the user put it, so an earlier digit can be fixed.
        expect(input().selectionStart).toBe(2);
        expect(activeBoxes()).toEqual([2]);

        await act(async () => {
            input().setSelectionRange(1, 4);
            // As after an arrow key: React reads the selection on key release.
            input().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
        });

        expect(activeBoxes()).toEqual([1, 2, 3]);
    });

    it('should submit on Enter', async () => {
        const onSubmit = vi.fn();

        await act(async () => root.render(<Harness onSubmit={onSubmit} />));
        await act(async () => input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));

        expect(onSubmit).toHaveBeenCalledOnce();
    });
});
