import { createContext, use, useEffect } from 'react';

import type { Chat, RunId } from '@clowdy/protocol';
import type { ProjectState } from './ProjectState';
import type { RootStore } from './RootStore';
import type { RunStream } from './StreamStore';
import type { ProjectUi } from './UiStore';

const RootStoreContext = createContext<RootStore | null>(null);

export const RootStoreProvider = RootStoreContext.Provider;

export function useRootStore(): RootStore {
    const root = use(RootStoreContext);

    if (!root) throw new Error('useRootStore needs a RootStoreProvider');

    return root;
}

/** The selected project. Screens render only while one is selected and loaded, so this does not return nothing. */
export function useProjectState(): ProjectState {
    const project = useRootStore().selectedProject;

    if (!project) throw new Error('No project is selected');

    return project;
}

/** What the selected project's window shows: the section, and what is selected in it. */
export function useProjectUi(): ProjectUi {
    const root = useRootStore();

    if (!root.selectedProjectId) throw new Error('No project is selected');

    return root.ui.forProject(root.selectedProjectId);
}

/** A run's stream, fetched on first use and kept current by the event feed. */
export function useRunStream(runId: RunId | undefined): RunStream | undefined {
    const stream = useRootStore().streams;
    const runStream = runId ? stream.of(runId) : undefined;

    useEffect(() => {
        void runStream?.load();
    }, [runStream]);

    return runStream;
}

/** A chat's stream: the stream of its orchestrator run. Nothing until the first message starts the run. */
export function useChatStream(chat: Chat | undefined): RunStream | undefined {
    return useRunStream(chat?.orchestratorRunId);
}
