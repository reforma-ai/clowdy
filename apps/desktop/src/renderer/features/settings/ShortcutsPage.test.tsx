// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ShortcutsPage } from './ShortcutsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const sections = () => [...container.querySelectorAll('section[aria-label]')];
const sectionNamed = (name: string) => sections().find(section => section.getAttribute('aria-label') === name)!;
/** A row is the block that holds a command's title and its keys. */
const rowOf = (title: string) => [...container.querySelectorAll('div')].find(element => element.children.length === 2 && element.firstElementChild?.textContent === title && element.querySelector('[data-hotkey]'))!;
const keysOf = (row: Element) => [...row.querySelectorAll('[data-hotkey]')].map(element => element.textContent);

beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(<ShortcutsPage />));
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('ShortcutsPage', () => {
    it('says what it is for, at the top of the page: the window draws its title', () => {
        expect(container.textContent).toContain('The keys that run commands in Clowdy');
    });

    it('has a section for each group, General and Navigation first', () => {
        const names = sections().map(section => section.getAttribute('aria-label'));

        expect(names.slice(0, 2)).toEqual(['General', 'Navigation']);
        expect(names).toEqual(expect.arrayContaining(['Agents', 'Tasks']));
        expect(names).not.toContain('Documents');
    });

    it('lists the commands of the sections that are not mounted, which the registry does not hold while Settings is open', () => {
        expect(sectionNamed('Tasks').textContent).toContain('New task');
        expect(sectionNamed('Navigation').textContent).toContain('Go back');
    });

    it('shows the way to ask for these shortcuts among the general ones', () => {
        const row = rowOf('Show keyboard shortcuts');

        expect(sectionNamed('General').contains(row)).toBe(true);
        expect(keysOf(row)[0]).toBe('?');
        // Each alternative is a capsule of its own, with a quiet "or" between two.
        expect(keysOf(row)).toHaveLength(3);
        expect(row.textContent).toContain('or');
    });

    it('writes a chord as its presses in a row', () => {
        const row = rowOf('Open sub-tasks');

        expect(keysOf(row)).toEqual(['O', 'S']);
        expect(row.querySelector('[data-hotkey-sequence]')?.textContent).toBe('OthenS');
    });

    it('only informs: it has no field, switch or button', () => {
        expect(container.querySelector('input, button, [role="switch"], [role="button"]')).toBeNull();
    });
});
