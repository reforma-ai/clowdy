// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PanelIcon, type PanelIconState } from './PanelIcon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const draw = (state: PanelIconState) => act(() => root.render(<PanelIcon state={ state } />));
const svg = () => container.querySelector('svg')!;
const vars = () => Object.fromEntries(['x', 'width', 'rx'].map(name => [name, svg().style.getPropertyValue(`--${ name }`)]));

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
        draw('small');

        expect(svg().getAttribute('width')).toBe('14');
        expect(svg().getAttribute('aria-hidden')).toBe('true');
        expect(svg().classList.contains('clowdy-icon')).toBe(true);
        expect(svg().querySelectorAll('path')).toHaveLength(1);
        expect(svg().querySelector('path')?.getAttribute('fill')).toBe('currentColor');
        expect(svg().querySelectorAll('rect')).toHaveLength(1);
    });

    it('draws the state it is in, by the left edge, the width and the radius of the panel', () => {
        draw('none');

        expect(svg().dataset.state).toBe('none');
        expect(vars()).toEqual({ x: '10px', width: '1px', rx: '0.5px' });

        draw('small');
        expect(vars()).toEqual({ x: '7px', width: '4px', rx: '1px' });

        draw('large');
        expect(vars()).toEqual({ x: '4px', width: '7px', rx: '1px' });
    });

    it('keeps the right edge of the panel where it was in the three states, so it grows and shrinks to the left', () => {
        for (const state of ['none', 'small', 'large'] as const) {
            draw(state);

            expect(Number.parseFloat(vars().x) + Number.parseFloat(vars().width)).toBe(11);
        }
    });
});
