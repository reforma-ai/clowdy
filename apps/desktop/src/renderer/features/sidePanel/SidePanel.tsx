import { Button } from '@clowdy/components/Button';
import { PanelLoadingState } from '@clowdy/components/Panel';
import { Terminal } from '@clowdy/icons/14';
import { Folder, Info } from '@clowdy/icons/16';
import { lazy, Suspense } from 'react';

import { commandTooltip } from '../../hotkeys';
import { useProjectUi } from '../../stores';
import { SIDE_PANEL_TAB_LABELS, sidePanelTabCommand } from './commands';
import { InfoTab } from './InfoTab';
import styles from './SidePanel.module.css';
import { SidePanelToggle } from './SidePanelToggle';

import type { SidePanelTab } from '../../stores';

// Its own chunk, loaded when the Files tab is first shown: the editor and the file tree are the heaviest part of the panel.
const FilesTab = lazy(() => import('../files/FilesTab'));
// Likewise for the terminal: xterm is loaded when the tab is first shown.
const TerminalTab = lazy(() => import('../terminal/TerminalTab'));

/** The tabs of the header, in order. */
const TABS: ReadonlyArray<{ tab: SidePanelTab; label: string; icon: typeof Info }> = [
    { tab: 'info', label: SIDE_PANEL_TAB_LABELS.info, icon: Info },
    { tab: 'files', label: SIDE_PANEL_TAB_LABELS.files, icon: Folder },
    { tab: 'terminal', label: SIDE_PANEL_TAB_LABELS.terminal, icon: Terminal },
];

/**
 * The column at the right of the window, with the window's chrome behind its header and a paper plate under it, as a second sidebar. The tabs are in the
 * header, with the button that shuts the panel at the window's right edge; the plate shows the tab that is chosen, which the project keeps. A tool the
 * panel is to have later (changes) becomes a tab of its own beside these.
 */
export function SidePanel() {
    const ui = useProjectUi();
    const { sidePanelTab: chosen } = ui;

    return (
        <aside className={ styles.panel } aria-label="Panel" data-side-panel="">
            <header className={ styles.header }>
                <div className={ styles.tabs } role="group" aria-label="Panel tabs">
                    { TABS.map(({ tab, label, icon: Icon }) => (
                        <Button key={ tab } variant="filling" size="sm" isPressed={ tab === chosen } tooltip={ commandTooltip(label, sidePanelTabCommand(tab)) } tooltipPlacement="bottom" onPress={ () => ui.showSidePanelTab(tab) }>
                            <Icon aria-hidden="true" />
                            { label }
                        </Button>
                    )) }
                </div>
                <div className={ styles.end }>
                    <SidePanelToggle />
                </div>
            </header>
            <section className={ styles.plate } data-tab={ chosen } aria-label={ TABS.find(({ tab }) => tab === chosen)?.label }>
                { chosen === 'files' && <Suspense fallback={ <PanelLoadingState /> }><FilesTab /></Suspense> }
                { chosen === 'terminal' && <Suspense fallback={ <PanelLoadingState /> }><TerminalTab /></Suspense> }
                { chosen === 'info' && <InfoTab /> }
            </section>
        </aside>
    );
}
