import { Spinner } from '@clowdy/components/Spinner';
import { Text } from '@clowdy/components/Text';
import { cn } from '@clowdy/lib';
import { useEffect } from 'react';

import { Screen as AgentsScreen } from '../features/agents';
import { Screen as ChatsScreen } from '../features/chats';
import { Screen as DocsScreen } from '../features/docs';
import { Screen as SettingsScreen } from '../features/settings';
import { Screen as TasksScreen } from '../features/tasks';
import { hotkeys, installDispatcher } from '../hotkeys';
import { useProjectUi, useRootStore } from '../stores';
import { NoProject } from './NoProject';
import { Rail } from './Rail';
import styles from './Shell.module.css';
import { SyncBanner } from './SyncBanner';
import { TitleBand } from './TitleBand';
import { Unreachable } from './Unreachable';

import type { ComponentType } from 'react';
import type { Section } from '../stores';

const SCREENS: Record<Section, ComponentType> = {
    chats: ChatsScreen,
    tasks: TasksScreen,
    agents: AgentsScreen,
    docs: DocsScreen,
};

/** The window: title band on top, rail on the left, the selected section's screen beside it. */
export function Shell() {
    const root = useRootStore();

    useEffect(() => installDispatcher(hotkeys), []);

    return (
        <div className={ styles.shell }>
            <TitleBand />
            <div className={ styles.body }>
                { root.phase === 'ready' && <Rail /> }
                <main className={ cn(styles.outlet, root.phase !== 'ready' && styles.bare) }>
                    <Outlet />
                </main>
            </div>
            <SyncBanner />
        </div>
    );
}

function Outlet() {
    const root = useRootStore();
    const project = root.selectedProject;

    if (root.phase === 'loading') return <Loading />;

    // The desktop shell hands over the daemon's address once, while the page loads: only a reload finds a daemon that started or moved since.
    if (root.phase === 'unreachable') return <Unreachable message={ root.loadError } onRetry={ () => (window.desktop ? location.reload() : void root.load()) } />;

    if (root.ui.settingsOpen) return <SettingsScreen />;

    if (!project) return <NoProject />;

    if (project.status === 'loading') return <Loading />;

    if (project.status === 'failed') return <Unreachable message={ project.error } onRetry={ () => void project.load() } />;

    return <ProjectScreen />;
}

function ProjectScreen() {
    const Screen = SCREENS[useProjectUi().section];

    return <Screen />;
}

function Loading() {
    return (
        <div className={ styles.center }>
            <Spinner size="md" />
            <Text color="secondary">Loading…</Text>
        </div>
    );
}
