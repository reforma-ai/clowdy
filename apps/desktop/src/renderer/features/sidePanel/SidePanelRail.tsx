import { Terminal } from '@clowdy/icons/14';
import { Folder, Info } from '@clowdy/icons/16';

import { commandTooltip } from '../../hotkeys';
import { RailItem } from '../../shared/RailItem';
import { SIDE_PANEL_TAB_LABELS, sidePanelTabCommand } from './commands';
import styles from './SidePanelRail.module.css';
import { useSidePanel } from './useSidePanel';

import type { SidePanelTab } from '../../stores';

/** The tabs of the rail, in order. Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const TABS: ReadonlyArray<{ tab: SidePanelTab; icon: typeof Info; size: number }> = [
    { tab: 'info', icon: Info, size: 16 },
    { tab: 'files', icon: Folder, size: 16 },
    { tab: 'terminal', icon: Terminal, size: 14 },
];

/**
 * The rail at the right edge of the window, whether the side panel is open or not, as the sections are at the left: an item for each tab of the panel. A click opens
 * the panel on the tab, or shuts it when that tab is the one it shows, and the key of the tab does the same (`ProjectUi.toggleSidePanelTab`; `Cmd+Esc` shuts or opens
 * the panel whatever tab it shows). Only the tab the panel shows is current, and none is while the panel is shut. Not drawn where the window shows no project.
 */
export function SidePanelRail() {
    const { available, open, tab: shown, toggleTab } = useSidePanel();

    if (!available) return null;

    return (
        <nav className={ styles.rail } aria-label="Panel tabs">
            { TABS.map(({ tab, icon, size }) => (
                <RailItem
                    key={ tab }
                    label={ SIDE_PANEL_TAB_LABELS[tab] }
                    icon={ icon }
                    size={ size }
                    current={ open && tab === shown }
                    tooltip={ commandTooltip(SIDE_PANEL_TAB_LABELS[tab], sidePanelTabCommand(tab)) }
                    tooltipPlacement="left"
                    onPress={ () => toggleTab(tab) }
                />
            )) }
        </nav>
    );
}
