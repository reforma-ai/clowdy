import { PanelLoadingState } from '@clowdy/components/Panel';
import { lazy, Suspense } from 'react';

import { useProjectUi } from '../../stores';
import { SIDE_PANEL_TAB_LABELS } from './commands';
import { InfoTab } from './InfoTab';
import styles from './SidePanel.module.css';

// Its own chunk, loaded when the Files tab is first shown: the editor and the file tree are the heaviest part of the panel.
const FilesTab = lazy(() => import('../files/FilesTab'));
// Likewise for the terminal: xterm is loaded when the tab is first shown.
const TerminalTab = lazy(() => import('../terminal/TerminalTab'));

/**
 * The column at the right of the window, beside the page, as a second sidebar: a paper plate on the window's chrome that shows the tab that is chosen, which the
 * project keeps. The tabs are the items of the rail at the window's right edge (`SidePanelRail`), so a tool the panel is to have later (changes, and perhaps tasks
 * and docs) becomes an item of that rail.
 */
export function SidePanel() {
    const { sidePanelTab: chosen } = useProjectUi();

    return (
        <aside className={ styles.panel } aria-label="Panel" data-side-panel="">
            <section className={ styles.plate } data-tab={ chosen } aria-label={ SIDE_PANEL_TAB_LABELS[chosen] }>
                { chosen === 'files' && <Suspense fallback={ <PanelLoadingState /> }><FilesTab /></Suspense> }
                { chosen === 'terminal' && <Suspense fallback={ <PanelLoadingState /> }><TerminalTab /></Suspense> }
                { chosen === 'info' && <InfoTab /> }
            </section>
        </aside>
    );
}
