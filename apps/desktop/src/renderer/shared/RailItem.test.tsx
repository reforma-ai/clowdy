// @vitest-environment happy-dom
import { Folder } from '@clowdy/icons/16';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RailItem, type RailItemProps } from './RailItem';

let host: HTMLDivElement;
let root: Root;

function draw(props: Partial<RailItemProps> = {}) {
    act(() => {
        root.render(<RailItem label="Files" icon={ Folder } size={ 16 } current={ false } onPress={ () => {} } { ...props } />);
    });

    return host.querySelector('button')!;
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
});
