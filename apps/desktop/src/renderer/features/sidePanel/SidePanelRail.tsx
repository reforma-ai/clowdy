import { Checkbox, Commit, Merge, Terminal, Version, VersionWarn } from '@clowdy/icons/14';
import { File, Folder, Settings } from '@clowdy/icons/16';
import { useRef } from 'react';

import { commandTooltip } from '../../hotkeys';
import { RailItem } from '../../shared/RailItem';
import { useFileDragHover } from '../../shared/useFileDragHover';
import { useRootStore } from '../../stores';
import { type ChangesStage } from '../changes/changesStage';
import { SETTINGS_COMMAND } from '../settings/commands';
import { SIDE_PANEL_TAB_LABELS, sidePanelTabCommand } from './commands';
import { panelOrder } from './panelOrder';
import { SidePanelCorner } from './SidePanelCorner';
import styles from './SidePanelRail.module.css';
import { useChangesSummary } from './useChangesSummary';
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

/** The icon of the Changes tab by how far the place's work is: nothing to land, commits waiting, a pull request open, or a problem. The tab keeps its label, so it is the same tab whichever it draws. */
const CHANGES_ICONS = {
    clean: Commit,
    ahead: Version,
    pullRequest: Merge,
    problem: VersionWarn,
} satisfies Record<ChangesStage, typeof Folder>;

/**
 * The rail at the right edge of the window, as tall as the window and there whether the side panel is open or not: the button that steps the panel first (`SidePanelCorner`,
 * where the title band's height is, so it is the first thing the Windows caption buttons leave room for), then an item for each tab of the panel, and Settings
 * pinned at the bottom. A click on a tab opens the panel on it, or shuts it when that tab is the one it shows,
 * and the key of the tab does the same (`ProjectUi.toggleSidePanelTab`; `Cmd+Esc` shuts or opens the panel whatever tab it shows). Only the tab the panel shows is
 * current (in the primary colour, as the open chat is in Reforma's rail), and none is while the panel is shut. The button and the tabs are not drawn where the window shows
 * no project; Settings, which is the window's and not a project's, always is. The Changes tab draws the stage of the place's work in its icon, and a dot while files are uncommitted and the tab is not the one on show; its tooltip says
 * the same in words.
 */
export function SidePanelRail() {
    const root = useRootStore();
    const { available, railShown, open, tab: shown, toggleTab } = useSidePanel();
    const tabs = useRef<HTMLElement>(null);
    const changes = useChangesSummary();
    useFileDragHover(
        element => {
            const button = element.closest<HTMLElement>('[data-drag-hover-key]');
            return button && tabs.current?.contains(button) ? button.dataset.dragHoverKey : undefined;
        },
        key => {
            const tab = key as SidePanelTab;
            if (!open || tab !== shown) toggleTab(tab);
        }
    );

    if (!railShown) return null;

    return (
        <div className={styles.rail}>
            <SidePanelCorner />
            {available && (
                <nav ref={tabs} className={styles.tabs} aria-label="Panel tabs">
                    {panelOrder.order.map(tab => {
                        const label = SIDE_PANEL_TAB_LABELS[tab];
                        const current = open && tab === shown;
                        const hint = commandTooltip(label, sidePanelTabCommand(tab));
                        const details = tab === 'changes' ? [changes?.stageLine, changes?.uncommittedLine] : [];
                        const lines = details.filter(line => line !== undefined);

                        return (
                            <RailItem
                                key={tab}
                                label={label}
                                dragHoverKey={tab}
                                icon={tab === 'changes' && changes ? CHANGES_ICONS[changes.stage] : TABS[tab].icon}
                                size={TABS[tab].size}
                                current={current}
                                accent
                                dot={
                                    tab === 'changes' && changes?.uncommittedLine && !current
                                        ? { tone: 'warning', label: changes.uncommittedLine }
                                        : undefined
                                }
                                tooltip={
                                    lines.length > 0 ? (
                                        <>
                                            {hint ?? label}
                                            {lines.map(line => (
                                                <span key={line} className={styles.detail}>
                                                    {line}
                                                </span>
                                            ))}
                                        </>
                                    ) : (
                                        hint
                                    )
                                }
                                tooltipPlacement="left"
                                onPress={() => toggleTab(tab)}
                            />
                        );
                    })}
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
