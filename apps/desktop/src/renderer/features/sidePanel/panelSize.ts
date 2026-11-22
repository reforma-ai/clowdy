import type { SidePanelSize } from '../../stores';
import type { PanelIconState } from './PanelIcon';

/** The sizes in the order the corner button's menu lists them, and what each is called there. */
export const PANEL_SIZE_LABELS: Record<SidePanelSize, string> = { wide: 'Wide', half: 'Half', hide: 'Hide' };

/** The size the panel is in now: not drawn, in the chat's place, or beside the chat. The Tasks tab is in the chat's place whenever it is drawn. */
export function currentPanelSize({ open, expanded }: { open: boolean; expanded: boolean }): SidePanelSize {
    if (!open) return 'hide';

    return expanded ? 'wide' : 'half';
}

/** The sizes the menu offers: the Tasks tab has no beside-the-chat size, so it is shown (wide) or hidden. */
export function panelSizes(tabIsFull: boolean): SidePanelSize[] {
    return tabIsFull ? ['wide', 'hide'] : ['wide', 'half', 'hide'];
}

/** The icon of the corner button draws the panel as the size is. */
export function panelIconState(size: SidePanelSize): PanelIconState {
    if (size === 'wide') return 'large';

    return size === 'half' ? 'small' : 'none';
}
