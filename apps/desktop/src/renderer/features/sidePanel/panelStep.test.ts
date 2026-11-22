import { describe, expect, it } from 'vitest';

import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND } from './commands';
import { panelStep } from './panelStep';

describe('panelStep', () => {
    it('shows a shut panel in the size it was left in: beside the chat, or expanded when it was left so', () => {
        expect(panelStep({ open: false, expanded: false, expandedChoice: false })).toEqual({ state: 'none', next: 'small', action: 'Show panel', command: SIDE_PANEL_COMMAND });
        expect(panelStep({ open: false, expanded: false, expandedChoice: true })).toEqual({ state: 'none', next: 'large', action: 'Show panel', command: SIDE_PANEL_COMMAND });
    });

    it('expands a panel beside the chat, with the key that expands it', () => {
        expect(panelStep({ open: true, expanded: false, expandedChoice: false })).toEqual({ state: 'small', next: 'large', action: 'Expand panel', command: SIDE_PANEL_EXPAND_COMMAND });
    });

    it('hides an expanded panel, with the key that shuts the panel', () => {
        expect(panelStep({ open: true, expanded: true, expandedChoice: true })).toEqual({ state: 'large', next: 'none', action: 'Hide panel', command: SIDE_PANEL_COMMAND });
    });
});
