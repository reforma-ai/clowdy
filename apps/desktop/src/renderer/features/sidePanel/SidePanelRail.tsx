import { Checkbox, Commit, Terminal } from '@clowdy/icons/14';
import { File, Folder, Info, Settings } from '@clowdy/icons/16';

import { commandTooltip } from '../../hotkeys';
import { RailItem } from '../../shared/RailItem';
import { useRootStore } from '../../stores';
import { SETTINGS_COMMAND } from '../settings/commands';
import { SIDE_PANEL_TAB_LABELS, sidePanelTabCommand } from './commands';
import { SidePanelCorner } from './SidePanelCorner';
import styles from './SidePanelRail.module.css';
import { useSidePanel } from './useSidePanel';

import type { SidePanelTab } from '../../stores';

/** The tabs of the rail, in order: the tools from the top, and Info at the bottom beside Settings. Each icon is drawn at its own size: the 16 pack where it has the glyph, else the 14 pack, never scaled. */
const TABS: ReadonlyArray<{ tab: SidePanelTab; icon: typeof Info; size: number }> = [
    { tab: 'files', icon: Folder, size: 16 },
    { tab: 'changes', icon: Commit, size: 14 },
    { tab: 'docs', icon: File, size: 16 },
    { tab: 'terminal', icon: Terminal, size: 14 },
    { tab: 'tasks', icon: Checkbox, size: 14 },
    { tab: 'info', icon: Info, size: 16 },
];

/** The place of the tab in the rail: Info is the last of the tabs, and goes to the bottom with Settings under it. */
const AT_BOTTOM: SidePanelTab = 'info';

/**
 * The rail at the right edge of the window, as tall as the window and there whether the side panel is open or not: the button that steps the panel first (`SidePanelCorner`,
 * where the title band's height is, so it is the first thing the Windows caption buttons leave room for), then an item for each tab of the panel, and Settings
 * pinned at the bottom (Info, the one tab that is not a tool, goes down with it). A click on a tab opens the panel on it, or shuts it when that tab is the one it shows,
 * and the key of the tab does the same (`ProjectUi.toggleSidePanelTab`; `Cmd+Esc` shuts or opens the panel whatever tab it shows). Only the tab the panel shows is
 * current (in the primary colour, as the open chat is in Reforma's rail), and none is while the panel is shut. The button and the tabs are not drawn where the window shows
 * no project; Settings, which is the window's and not a project's, always is.
 */
export function SidePanelRail() {
    const root = useRootStore();
    const { available, railShown, open, tab: shown, toggleTab } = useSidePanel();

    if (!railShown) return null;

    return (
        <div className={ styles.rail }>
            <SidePanelCorner />
            { available && (
                <nav className={ styles.tabs } aria-label="Panel tabs">
                    { TABS.map(({ tab, icon, size }) => (
                        <RailItem
                            key={ tab }
                            className={ tab === AT_BOTTOM ? styles.bottom : undefined }
                            label={ SIDE_PANEL_TAB_LABELS[tab] }
                            icon={ icon }
                            size={ size }
                            current={ open && tab === shown }
                            accent
                            tooltip={ commandTooltip(SIDE_PANEL_TAB_LABELS[tab], sidePanelTabCommand(tab)) }
                            tooltipPlacement="left"
                            onPress={ () => toggleTab(tab) }
                        />
                    )) }
                </nav>
            ) }

            <RailItem
                className={ available ? undefined : styles.bottom }
                label="Settings"
                icon={ Settings }
                size={ 16 }
                current={ root.ui.settingsOpen }
                accent
                tooltip={ commandTooltip('Settings', SETTINGS_COMMAND) }
                tooltipPlacement="left"
                onPress={ () => root.ui.openSettings() }
            />
        </div>
    );
}
