import { Loader } from '@clowdy/components/Loader';
import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';
import { useEffect } from 'react';

import { Screen as AgentsScreen } from '../features/agents';
import { openQuickSearch, quickSearchCommands } from '../features/quickSearch';
import { SettingsDialog } from '../features/settings';
import { SidePanelLayout, SidePanelRail, useSidePanel, useWindowFitsHalf } from '../features/sidePanel';
import { ChordHud, hotkeys, installDispatcher, useCommands } from '../hotkeys';
import { useRootStore } from '../stores';
import { FindBar } from './FindBar';
import { NoProject } from './NoProject';
import styles from './Shell.module.css';
import { SyncBanner } from './SyncBanner';
import { shellCommands } from './shellCommands';
import { spaceSwitch } from './spaceSwitch';
import { TitleBand } from './TitleBand';
import { Unreachable } from './Unreachable';

/**
 * The window: the rail at the right edge, as tall as the window (the panel's button, its tabs and Settings), which is there whether the panel is open or not, and the rest
 * of the window beside it: the title band across the top and under it the Agents screen (the list of chats and the chat beside it) with the side panel beside it while a
 * project's panel is open. Settings is a window over all this.
 */
export function Shell() {
    const root = useRootStore();
    const panel = useSidePanel();

    useWindowFitsHalf();
    useEffect(() => installDispatcher(hotkeys), []);
    useEffect(() => {
        root.setSpaceSwitch(spaceSwitch);
        return () => root.setSpaceSwitch(undefined);
    }, [root]);
    useCommands('app', shellCommands(root));
    useCommands(
        'app',
        quickSearchCommands({ available: () => root.showsProjectScreen, open: tab => openQuickSearch(root, tab) })
    );

    return (
        <div className={styles.shell}>
            <div className={styles.window}>
                <TitleBand />
                <div className={styles.body}>
                    <SidePanelLayout>
                        <main
                            className={cn(
                                styles.outlet,
                                root.phase !== 'ready' && styles.bare,
                                panel.open && styles.beside,
                                panel.expanded && styles.covered
                            )}
                        >
                            <Outlet />
                        </main>
                    </SidePanelLayout>
                </div>
            </div>
            <SidePanelRail />
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
    if (root.phase === 'unreachable')
        return (
            <Unreachable
                message={root.loadError}
                onRetry={() => (window.desktop ? location.reload() : void root.load())}
            />
        );

    if (!project) return <NoProject />;

    if (project.status === 'loading') return <Loading />;

    if (project.status === 'failed') return <Unreachable message={project.error} onRetry={() => void project.load()} />;

    return <ProjectScreen />;
}

function ProjectScreen() {
    return <AgentsScreen />;
}

function Loading() {
    return (
        <div className={styles.center}>
            <Loader size="xs" />
            <Text color="secondary">Loading…</Text>
        </div>
    );
}
