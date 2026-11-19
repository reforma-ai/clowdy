// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Fade } from './Fade';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const draw = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
    // As a person who asked for reduced motion: what goes is gone at once, and no animation is running when a test ends.
    window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('Fade', () => {
    it('draws its children in an element of its own, with the class it is given', () => {
        draw(<Fade className="slot">Add</Fade>);

        expect(container.querySelector('.slot')?.textContent).toBe('Add');
    });

    it('draws nothing for no children', () => {
        draw(<Fade className="slot">{ false }</Fade>);

        expect(container.innerHTML).toBe('');
    });

    it('takes the element away once the children are', () => {
        draw(<Fade className="slot">Add</Fade>);
        draw(<Fade className="slot">{ undefined }</Fade>);

        expect(container.querySelector('.slot')).toBeNull();
    });
});
