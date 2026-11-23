// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Terminal } from './Terminal';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('Terminal', () => {
    it('renders HTML in command output as text', () => {
        const output = '<script>alert(1)</script>\n<img src=x onerror="alert(2)">';

        act(() => root.render(<Terminal output={output} />));

        const pre = host.querySelector('pre')!;

        expect(pre.querySelector('script, img')).toBeNull();
        expect(pre.textContent).toContain(output);
    });

    it('keeps ANSI colors while escaping the colored text', () => {
        act(() => root.render(<Terminal output={'\u001b[31m<b onclick="x">red</b>\u001b[0m'} />));

        const colored = host.querySelector('pre span span')!;

        expect(colored.getAttribute('style')).toContain('color');
        expect(colored.querySelector('b')).toBeNull();
        expect(colored.textContent).toBe('<b onclick="x">red</b>');
    });
});
