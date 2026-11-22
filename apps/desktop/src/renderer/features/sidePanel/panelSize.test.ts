import { describe, expect, it } from 'vitest';

import { currentPanelSize, panelIconState, panelSizes } from './panelSize';

describe('currentPanelSize', () => {
    it('is hide while the panel is shut, whatever size it comes back in', () => {
        expect(currentPanelSize({ open: false, expanded: false })).toBe('hide');
        expect(currentPanelSize({ open: false, expanded: true })).toBe('hide');
    });

    it('is wide when the open panel is in the chat\'s place, and half when it is beside the chat', () => {
        expect(currentPanelSize({ open: true, expanded: true })).toBe('wide');
        expect(currentPanelSize({ open: true, expanded: false })).toBe('half');
    });
});

describe('panelSizes', () => {
    it('lists wide, half and hide', () => {
        expect(panelSizes(false)).toEqual(['wide', 'half', 'hide']);
    });

    it('leaves out half for a tab that is always in the chat\'s place', () => {
        expect(panelSizes(true)).toEqual(['wide', 'hide']);
    });
});

describe('panelIconState', () => {
    it('draws wide as the large panel, half as the small one, and hide as none', () => {
        expect(['wide', 'half', 'hide'].map(size => panelIconState(size as 'wide' | 'half' | 'hide'))).toEqual(['large', 'small', 'none']);
    });
});
