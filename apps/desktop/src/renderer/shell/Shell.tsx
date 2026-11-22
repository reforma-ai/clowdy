import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';
import { useEffect } from 'react';

import { Screen as AgentsScreen } from '../features/agents';
import { openQuickSearch, quickSearchCommands } from '../features/quickSearch';
import { SettingsDialog } from '../features/settings';
import { SidePanelLayout, SidePanelRail, useSidePanel } from '../features/sidePanel';
import { ChordHud, hotkeys, installDispatcher, useCommands } from '../hotkeys';
import { useRootStore } from '../stores';
import { FindBar } from './FindBar';
import { NoProject } from './NoProject';
import { Rail } from './Rail';
import styles from './Shell.module.css';
import { shellCommands } from './shellCommands';
import { SyncBanner } from './SyncBanner';
import { TitleBand } from './TitleBand';
import { Unreachable } from './Unreachable';

/**
 * The window: one title band across the top, and under it the rail on the left, the Agents screen, the side panel beside it while a project's panel
 * is open, and the rail at the right edge (the panel's tabs, Info and Settings), which is there whether the panel is open or not. Settings is a window over all this.
 */
export function Shell() {
    const root = useRootStore();
    const panel = useSidePanel();

    useEffect(() => installDispatcher(hotkeys), []);
    useCommands('app', shellCommands(root));
    useCommands('app', quickSearchCommands({ available: () => root.showsProjectScreen, open: tab => openQuickSearch(root, tab) }));

    return (
        <div className={ styles.shell }>
            <TitleBand />
            <div className={ styles.body }>
                { root.phase === 'ready' && <Rail /> }
                <SidePanelLayout>
                    <main className={ cn(styles.outlet, root.phase !== 'ready' && styles.bare, panel.railShown && !panel.open && styles.railed) }>
                        <Outlet />
                    </main>
                </SidePanelLayout>
                <SidePanelRail />
            </div>
            <SyncBanner />
            <ChordHud />
            <FindBar />
            <SettingsDialog />
        </div>
    );
}

function Outlet() {
    const root = useRootStore();
    const project = root.selectedProject;

    if (root.phase === 'loading') return <Loading />;

    // The desktop shell hands over the daemon's address once, while the page loads: only a reload finds a daemon that started or moved since.
    if (root.phase === 'unreachable') return <Unreachable message={ root.loadError } onRetry={ () => (window.desktop ? location.reload() : void root.load()) } />;

    if (!project) return <NoProject />;

    if (project.status === 'loading') return <Loading />;

    if (project.status === 'failed') return <Unreachable message={ project.error } onRetry={ () => void project.load() } />;

    return <ProjectScreen />;
}

function ProjectScreen() {
    return <AgentsScreen />;
}

function Loading() {
    return (
        <div className={ styles.center }>
            <Loader size="xs" />
            <Text color="secondary">Loading…</Text>
        </div>
    );
}
