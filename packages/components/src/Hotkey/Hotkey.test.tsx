// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Hotkey } from './Hotkey';
import { tooltipWithSequence } from './tooltips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const render = (element: React.ReactNode) => act(() => root.render(element));
const capsules = () => Array.from(container.querySelectorAll('[data-hotkey]'), element => element.textContent);

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Hotkey', () => {
    it('shows one press in one capsule', () => {
        render(<Hotkey hotkey={['shift', 'r']} />);

        expect(capsules()).toHaveLength(1);
        expect(container.querySelector('[data-hotkey-sequence]')).toBeNull();
    });

    it('shows a sequence as one capsule per press, joined by "then"', () => {
        render(<Hotkey sequence={[['g'], ['t']]} />);

        expect(capsules()).toEqual(['G', 'T']);
        expect(container.querySelector('[data-hotkey-sequence]')?.textContent).toBe('GthenT');
    });

    it('says its size on the capsule and on a sequence, which whatever holds one places it by', () => {
        render(<Hotkey hotkey="k" size="sm" />);

        expect(container.querySelector('[data-hotkey]')?.getAttribute('data-size')).toBe('sm');

        render(<Hotkey sequence={[['g'], ['t']]} />);

        expect(container.querySelector('[data-hotkey-sequence]')?.getAttribute('data-size')).toBe('xs');
    });

    it('shows a press with modifiers inside a sequence as one capsule', () => {
        render(<Hotkey sequence={[['shift', 'm'], ['b']]} />);

        expect(capsules()).toHaveLength(2);
        expect(capsules()[1]).toBe('B');
    });

    it('shows a single press of a sequence without a "then"', () => {
        render(<Hotkey sequence={[['escape']]} />);

        expect(capsules()).toEqual(['Esc']);
        expect(container.textContent).not.toContain('then');
    });

    it('puts a label and its sequence in a tooltip', () => {
        render(<div>{tooltipWithSequence('Tasks', [['g'], ['t']])}</div>);

        expect(container.textContent).toBe('Tasks GthenT');
        expect(capsules()).toEqual(['G', 'T']);
    });
});
