import { Checkbox, Commit, Terminal } from '@clowdy/icons/14';
import { File, Folder, Settings } from '@clowdy/icons/16';

import { commandTooltip } from '../../hotkeys';
import { RailItem } from '../../shared/RailItem';
import { useRootStore } from '../../stores';
import { SETTINGS_COMMAND } from '../settings/commands';
import { SIDE_PANEL_TAB_LABELS, sidePanelTabCommand } from './commands';
import { panelOrder } from './panelOrder';
import { SidePanelCorner } from './SidePanelCorner';
import styles from './SidePanelRail.module.css';
import { useSidePanel } from './useSidePanel';

import type { SidePanelTab } from '../../stores';

/** The tab icons of the rail. Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const TABS = {
    files: { icon: Folder, size: 16 },
    changes: { icon: Commit, size: 14 },
    docs: { icon: File, size: 16 },
    terminal: { icon: Terminal, size: 14 },
    tasks: { icon: Checkbox, size: 14 },
} satisfies Record<SidePanelTab, { icon: typeof Folder; size: number }>;

/**
 * The rail at the right edge of the window, as tall as the window and there whether the side panel is open or not: the button that steps the panel first (`SidePanelCorner`,
 * where the title band's height is, so it is the first thing the Windows caption buttons leave room for), then an item for each tab of the panel, and Settings
 * pinned at the bottom. A click on a tab opens the panel on it, or shuts it when that tab is the one it shows,
 * and the key of the tab does the same (`ProjectUi.toggleSidePanelTab`; `Cmd+Esc` shuts or opens the panel whatever tab it shows). Only the tab the panel shows is
 * current (in the primary colour, as the open chat is in Reforma's rail), and none is while the panel is shut. The button and the tabs are not drawn where the window shows
 * no project; Settings, which is the window's and not a project's, always is.
 */
export function SidePanelRail() {
    const root = useRootStore();
    const { available, railShown, open, tab: shown, toggleTab } = useSidePanel();

    if (!railShown) return null;

    return (
        <div className={styles.rail}>
            <SidePanelCorner />
            {available && (
                <nav className={styles.tabs} aria-label="Panel tabs">
                    {panelOrder.order.map(tab => (
                        <RailItem
                            key={tab}
                            label={SIDE_PANEL_TAB_LABELS[tab]}
                            icon={TABS[tab].icon}
                            size={TABS[tab].size}
                            current={open && tab === shown}
                            accent
                            tooltip={commandTooltip(SIDE_PANEL_TAB_LABELS[tab], sidePanelTabCommand(tab))}
                            tooltipPlacement="left"
                            onPress={() => toggleTab(tab)}
                        />
                    ))}
                </nav>
            )}

            <RailItem
                className={styles.bottom}
                label="Settings"
                icon={Settings}
                size={16}
                current={root.ui.settingsOpen}
                accent
                tooltip={commandTooltip('Settings', SETTINGS_COMMAND)}
                tooltipPlacement="left"
                onPress={() => root.ui.openSettings()}
            />
        </div>
    );
}
