// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PanelIcon, type PanelIconState } from './PanelIcon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const draw = (state: PanelIconState, next: PanelIconState) => act(() => root.render(<PanelIcon state={ state } next={ next } />));
const svg = () => container.querySelector('svg')!;
const vars = () => Object.fromEntries(['from-x', 'from-width', 'from-rx', 'to-x', 'to-width', 'to-rx'].map(name => [name, svg().style.getPropertyValue(`--${ name }`)]));

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('PanelIcon', () => {
    it('is one 14px icon in the colour of the text, hidden from assistive technology, with a frame and the panel in it', () => {
        draw('small', 'large');

        expect(svg().getAttribute('width')).toBe('14');
        expect(svg().getAttribute('aria-hidden')).toBe('true');
        expect(svg().classList.contains('clowdy-icon')).toBe(true);
        expect(svg().querySelectorAll('path')).toHaveLength(1);
        expect(svg().querySelector('path')?.getAttribute('fill')).toBe('currentColor');
        expect(svg().querySelectorAll('rect')).toHaveLength(1);
    });

    it('draws the state it is in and the one it moves to, by the left edge, the width and the radius of the panel', () => {
        draw('none', 'small');

        expect([svg().dataset.state, svg().dataset.next]).toEqual(['none', 'small']);
        expect(vars()).toEqual({ 'from-x': '10px', 'from-width': '1px', 'from-rx': '0.5px', 'to-x': '7px', 'to-width': '4px', 'to-rx': '1px' });

        draw('small', 'large');
        expect(vars()).toEqual({ 'from-x': '7px', 'from-width': '4px', 'from-rx': '1px', 'to-x': '4px', 'to-width': '7px', 'to-rx': '1px' });

        draw('large', 'none');
        expect(vars()).toEqual({ 'from-x': '4px', 'from-width': '7px', 'from-rx': '1px', 'to-x': '10px', 'to-width': '1px', 'to-rx': '0.5px' });
    });

    it('keeps the right edge of the panel where it was in the three states, so it grows and shrinks to the left', () => {
        for (const state of ['none', 'small', 'large'] as const) {
            draw(state, state);

            expect(Number.parseFloat(vars()['from-x']) + Number.parseFloat(vars()['from-width'])).toBe(11);
        }
    });
});
