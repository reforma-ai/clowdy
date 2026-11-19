// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LayerStack } from './LayerStack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const draw = (node: React.ReactNode) => act(() => root.render(node));
const inertTexts = () => [...container.querySelectorAll('[inert]')].map(layer => layer.textContent);

beforeEach(() => {
    // As a person who asked for reduced motion: the layers move at once, and no animation is running when a test ends.
    window.matchMedia = ((query: string) => ({ matches: query.includes('prefers-reduced-motion'), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('LayerStack', () => {
    it('shows the base view, in reach, when nothing is open over it', () => {
        draw(<LayerStack>base</LayerStack>);

        expect(container.textContent).toBe('base');
        expect(inertTexts()).toEqual([]);
    });

    it('puts a layer over the base and leaves the base mounted, out of reach', () => {
        draw(<LayerStack layers={ [{ id: 'one', content: 'first layer' }] }>base</LayerStack>);

        expect(container.textContent).toBe('basefirst layer');
        expect(inertTexts()).toEqual(['base']);
    });

    it('covers every layer but the deepest', () => {
        draw(<LayerStack layers={ [{ id: 'one', content: 'first layer' }, { id: 'two', content: 'second layer' }] }>base</LayerStack>);

        expect(inertTexts()).toEqual(['base', 'first layer']);
    });

    it('gives the base back, as it was, when the layer goes', () => {
        draw(<LayerStack layers={ [{ id: 'one', content: 'first layer' }] }><input defaultValue="kept" /></LayerStack>);

        const input = container.querySelector('input')!;

        input.value = 'typed';
        draw(<LayerStack layers={ [] }><input defaultValue="kept" /></LayerStack>);

        expect(container.querySelector('input')).toBe(input);
        expect(input.value).toBe('typed');
        expect(inertTexts()).toEqual([]);
        expect(container.textContent).toBe('');
    });
});
