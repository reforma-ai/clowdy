// @vitest-environment happy-dom
import { ArrowDown, ArrowUp } from '@clowdy/icons/14';
import { Folder } from '@clowdy/icons/16';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RailItem, type RailItemProps } from './RailItem';

let host: HTMLDivElement;
let root: Root;

function draw(props: Partial<RailItemProps> = {}) {
    act(() => {
        root.render(<RailItem label="Files" icon={Folder} size={16} current={false} onPress={() => {}} {...props} />);
    });

    return host.querySelector('button')!;
}

/** The count pill of an item, which is hidden from a reader of it. */
const pill = (button: HTMLButtonElement) => button.querySelector('[aria-hidden="true"]:not(svg)');
const arrowOf = (button: HTMLButtonElement) => pill(button)?.querySelector('svg')?.outerHTML;

/** The markup of an arrow icon as the pill draws it. */
function markupOf(Arrow: typeof ArrowUp) {
    const arrowHost = document.createElement('div');
    const arrowRoot = createRoot(arrowHost);

    act(() => arrowRoot.render(<Arrow size={10} />));
    const markup = arrowHost.querySelector('svg')?.outerHTML;

    act(() => arrowRoot.unmount());

    return markup;
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    host.remove();
});

describe('RailItem', () => {
    it('marks the item the rail shows now as the current page, and no other', () => {
        expect(draw({ current: true }).getAttribute('aria-current')).toBe('page');
        expect(draw({ current: false }).getAttribute('aria-current')).toBeNull();
    });

    it('is neutral unless the rail asks for the accent, which the current item then wears in the primary colour', () => {
        expect(draw({ current: true }).className).not.toContain('accent');
        expect(draw({ current: true, accent: true }).className).toContain('accent');
    });

    it('draws a badge only when it is given one, and the name of the item says what it stands for after the label', () => {
        expect(draw().querySelector('[data-tone]')).toBeNull();
        expect(draw().getAttribute('aria-label')).toBeNull();

        const button = draw({ badge: { kind: 'dot', tone: 'warning', label: '3 uncommitted files' } });

        expect(button.querySelector('[data-tone="warning"]')).not.toBeNull();
        // A badge read from the content would be the first words of the name.
        expect(button.getAttribute('aria-label')).toBe('Files, 3 uncommitted files');
        expect(button.querySelector('[role="img"]')).toBeNull();
        expect(button.textContent).toBe('Files');
    });

    it('draws a count with the arrow of the way the commits go, apart from the name of the item', () => {
        expect(markupOf(ArrowUp)).not.toBe(markupOf(ArrowDown));

        const button = draw({ badge: { kind: 'count', arrow: 'up', count: 3, label: '3 commits to push' } });

        expect(button.querySelector('[data-tone]')).toBeNull();
        expect(button.getAttribute('aria-label')).toBe('Files, 3 commits to push');
        expect(pill(button)?.textContent).toBe('3');
        expect(arrowOf(button)).toBe(markupOf(ArrowUp));
        // The label under the glyph is still the text of the button: the count is hidden from a reader of it.
        expect(button.lastElementChild?.textContent).toBe('Files');

        draw({ badge: { kind: 'count', arrow: 'down', count: 17, label: '17 commits to pull' } });

        expect(pill(button)?.textContent).toBe('17');
        expect(arrowOf(button)).toBe(markupOf(ArrowDown));
    });
});
