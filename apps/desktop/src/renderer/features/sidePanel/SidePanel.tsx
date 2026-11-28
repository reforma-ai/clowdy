import { PanelLoadingState } from '@clowdy/components/Panel';
import { lazy, Suspense } from 'react';

import { useProjectUi } from '../../stores';
import { SIDE_PANEL_TAB_LABELS } from './commands';
import styles from './SidePanel.module.css';

// Its own chunk, loaded when the Files or the Docs tab is first shown (they are one view): the editor and the file tree are the heaviest part of the panel.
const FilesTab = lazy(() => import('../files/FilesTab'));
// Likewise for the terminal: xterm is loaded when the tab is first shown.
const TerminalTab = lazy(() => import('../terminal/TerminalTab'));
// And for the tasks, whose screen is the heaviest after the editor.
const TasksTab = lazy(() => import('../tasks').then(({ Screen }) => ({ default: Screen })));
// And for the changes: the diff view and the editor's languages come with it.
const ChangesTab = lazy(() => import('../changes/ChangesTab'));

/**
 * The column at the right of the window, beside the page, as a second sidebar: a paper plate on the window's chrome that shows the tab that is chosen, which the
 * project keeps. The tabs are the items of the rail at the window's right edge (`SidePanelRail`), so a tool the panel is to have later (changes, and perhaps tasks
 * and docs) becomes an item of that rail. Expanded, it is drawn over the chat of the Agents screen as well as in its own column, from the chat's left edge to the column's
 * right one and as tall as the column (CSS anchors): the layout does not change, so the chat keeps its width, its scroll and its draft under it, and the column keeps its
 * width for the panel to come back to.
 */
export function SidePanel() {
    const { sidePanelTab: chosen, sidePanelCoversChat } = useProjectUi();

    return (
        <aside
            className={styles.panel}
            aria-label="Panel"
            data-side-panel=""
            data-expanded={sidePanelCoversChat || undefined}
        >
            <section className={styles.plate} data-tab={chosen} aria-label={SIDE_PANEL_TAB_LABELS[chosen]}>
                <div className={styles.content}>
                    {(chosen === 'files' || chosen === 'docs') && (
                        <Suspense fallback={<PanelLoadingState />}>
                            <FilesTab variant={chosen} />
                        </Suspense>
                    )}
                    {chosen === 'terminal' && (
                        <Suspense fallback={<PanelLoadingState />}>
                            <TerminalTab />
                        </Suspense>
                    )}
                    {chosen === 'tasks' && (
                        <Suspense fallback={<PanelLoadingState />}>
                            <TasksTab />
                        </Suspense>
                    )}
                    {chosen === 'changes' && (
                        <Suspense fallback={<PanelLoadingState />}>
                            <ChangesTab />
                        </Suspense>
                    )}
                </div>
            </section>
        </aside>
    );
}
