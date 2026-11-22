import { Terminal } from '@clowdy/icons/14';
import { Folder, Info } from '@clowdy/icons/16';
import { useRef } from 'react';

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
 * The rail at the right edge of the window, whether the side panel is open or not, as the sections are at the left: an item for each tab of the panel. A click
 * opens the panel on the tab (and a key of the tab does the same), and a double click opens a shut panel or shuts an open one (`Cmd+Esc` does the same): a
 * click never shuts the panel, so the double click's first click cannot undo the opening that the second would not. Only the tab the panel shows is current,
 * and none is while the panel is shut. Not drawn where the window shows no project.
 */
export function SidePanelRail() {
    const { available, open, tab: shown, toggle, openTab } = useSidePanel();
    // Whether the panel was open when the click that may be the first of a double click came: that one only decides which way the second goes.
    const wasOpen = useRef(false);

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
                    onPress={ () => {
                        wasOpen.current = open;
                        openTab(tab);
                    } }
                    // A shut panel the first click opened stays open; an open one is shut.
                    onDoublePress={ () => {
                        if (wasOpen.current) toggle();
                    } }
                />
            )) }
        </nav>
    );
}
