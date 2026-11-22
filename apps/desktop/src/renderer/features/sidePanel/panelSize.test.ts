import { describe, expect, it } from 'vitest';

import { currentPanelSize, panelIconState, panelSizeOptions } from './panelSize';

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

describe('panelSizeOptions', () => {
    it('lists wide, half and hide, all of them to choose', () => {
        expect(panelSizeOptions(null)).toEqual([{ size: 'wide' }, { size: 'half' }, { size: 'hide' }]);
    });

    it('keeps half, with the reason it cannot be chosen, for a tab that is always wide and for a window too narrow', () => {
        expect(panelSizeOptions('tab')).toEqual([{ size: 'wide' }, { size: 'half', unavailable: 'This tab is always wide' }, { size: 'hide' }]);
        expect(panelSizeOptions('window')).toEqual([{ size: 'wide' }, { size: 'half', unavailable: 'The window is too narrow for this tab beside the chat' }, { size: 'hide' }]);
    });
});

describe('panelIconState', () => {
    it('draws wide as the large panel, half as the small one, and hide as none', () => {
        expect(['wide', 'half', 'hide'].map(size => panelIconState(size as 'wide' | 'half' | 'hide'))).toEqual(['large', 'small', 'none']);
    });
});
