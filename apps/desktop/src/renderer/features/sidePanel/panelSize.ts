import type { NoHalfReason, SidePanelSize } from '../../stores';
import type { PanelIconState } from './PanelIcon';

/** The sizes in the order the corner button's menu lists them, and what each is called there. */
export const PANEL_SIZE_LABELS: Record<SidePanelSize, string> = { wide: 'Wide', half: 'Half', hide: 'Hide' };

/** The size the panel is in now: not drawn, in the chat's place, or beside the chat. A panel that cannot be beside the chat is in the chat's place whenever it is drawn. */
export function currentPanelSize({ open, expanded }: { open: boolean; expanded: boolean }): SidePanelSize {
    if (!open) return 'hide';

    return expanded ? 'wide' : 'half';
}

/** One size of the menu: `unavailable` is the reason it cannot be chosen, which a tooltip on its grey tile says. */
export interface PanelSizeOption {
    size: SidePanelSize;
    unavailable?: string;
}

/** What the grey tile of Half says when the pointer is over it: a tab that is always wide, and a window too narrow for the tab beside the chat. */
const NO_HALF_HINTS: Record<NoHalfReason, string> = {
    tab: 'This tab is always wide',
    window: 'The window is too narrow for this tab beside the chat',
};

/** The sizes the menu draws, wide, half and hide: half stays where it is, grey and saying why on hover, for a panel that cannot be beside the chat. */
export function panelSizeOptions(noHalf: NoHalfReason | null): PanelSizeOption[] {
    return [
        { size: 'wide' },
        noHalf ? { size: 'half', unavailable: NO_HALF_HINTS[noHalf] } : { size: 'half' },
        { size: 'hide' },
    ];
}

/** The icon of the corner button draws the panel as the size is. */
export function panelIconState(size: SidePanelSize): PanelIconState {
    if (size === 'wide') return 'large';

    return size === 'half' ? 'small' : 'none';
}
