import { SIDE_PANEL_COMMAND, SIDE_PANEL_EXPAND_COMMAND } from './commands';

import type { PanelIconState } from './PanelIcon';

/** What the panel is now, as the corner button sees it. */
export interface PanelStepInput {
    /** The panel is drawn. */
    open: boolean;
    /** It is drawn in the place of the chat. */
    expanded: boolean;
    /** The project's choice of the expanded size, kept while the panel is shut: it comes back in it. */
    expandedChoice: boolean;
}

/** The step the corner button takes, and how it says so. */
export interface PanelStep {
    /** The panel as it is now, for the icon. */
    state: PanelIconState;
    /** The panel as a press makes it, for the icon to glide to. */
    next: PanelIconState;
    /** What a press does, for the tooltip. */
    action: string;
    /** The command whose key does the same, for the tooltip to show. */
    command: string;
}

/** The corner button's step from the panel's state: shown from shut (in the size it was left in), expanded from beside the chat, hidden from expanded. */
export function panelStep({ open, expanded, expandedChoice }: PanelStepInput): PanelStep {
    if (!open) {
        return { state: 'none', next: expandedChoice ? 'large' : 'small', action: 'Show panel', command: SIDE_PANEL_COMMAND };
    }

    return expanded
        ? { state: 'large', next: 'none', action: 'Hide panel', command: SIDE_PANEL_COMMAND }
        : { state: 'small', next: 'large', action: 'Expand panel', command: SIDE_PANEL_EXPAND_COMMAND };
}
