import { mainFolder } from '@clowdy/protocol';
import { createContext, use, useEffect } from 'react';

import type { AgentInfo, Chat, Project, RunId } from '@clowdy/protocol';
import type { AgentModelList } from './ModelsStore';
import type { ProjectState } from './ProjectState';
import type { RootStore } from './RootStore';
import type { RunStream } from './StreamStore';
import type { ProjectUi } from './UiStore';

const RootStoreContext = createContext<RootStore | null>(null);
const ProjectContext = createContext<ProjectState | null>(null);

export const RootStoreProvider = RootStoreContext.Provider;
export const ProjectProvider = ProjectContext.Provider;

export function useRootStore(): RootStore {
    const root = use(RootStoreContext);

    if (!root) throw new Error('useRootStore needs a RootStoreProvider');

    return root;
}

/** The selected project. Screens render only while one is selected and loaded, so this does not return nothing. */
export function useProjectState(): ProjectState {
    const override = use(ProjectContext);
    const root = useRootStore();
    const project = override ?? root.selectedProject;

    if (!project) throw new Error('No project is selected');

    return project;
}

/** What the selected project's window shows: the section, and what is selected in it. */
export function useProjectUi(): ProjectUi {
    const root = useRootStore();
    const override = use(ProjectContext);

    const projectId = override?.id ?? root.selectedProjectId;
    if (!projectId) throw new Error('No project is selected');

    return root.ui.forProject(projectId);
}

/** A run's stream, fetched on first use and kept current by the event feed while the component shows it. */
export function useRunStream(runId: RunId | undefined): RunStream | undefined {
    const streams = useRootStore().streams;
    const runStream = runId ? streams.of(runId) : undefined;

    useEffect(() => {
        if (!runStream) return;

        const release = streams.hold(runStream);

        void runStream.load();

        return release;
    }, [streams, runStream]);

    return runStream;
}

/** A chat's stream: the stream of its orchestrator run. Nothing until the first message starts the run. */
export function useChatStream(chat: Chat | undefined): RunStream | undefined {
    return useRunStream(chat?.orchestratorRunId);
}

/** The agents the daemon knows, kept current by the event feed. `status` is `loading` until the first answer and `failed` when the last fetch failed. */
export function useAgents(): {
    agents: AgentInfo[];
    status: RootStore['agentsStatus'];
    error: string;
    refresh: () => Promise<void>;
} {
    const root = useRootStore();

    return {
        agents: root.agents,
        status: root.agentsStatus,
        error: root.agentsError,
        refresh: () => root.refreshAgents(),
    };
}

/** The models an agent offers, read the first time a component asks. */
export function useAgentModels(agentId: string | undefined): AgentModelList | undefined {
    const models = useRootStore().models;
    const list = agentId ? models.of(agentId) : undefined;

    useEffect(() => {
        void list?.load();
    }, [list]);

    return list;
}

/**
 * The picture a project shows in place of the folder icon (`ProjectIconsStore.src`), or `undefined` for the folder icon. Asks the daemon
 * for the icon of the main folder the first time a component needs it.
 */
export function useProjectIcon(project: Project): string | undefined {
    const icons = useRootStore().projectIcons;
    const folder = mainFolder(project).path;
    const wanted = icons.wantsFound(project);

    useEffect(() => {
        if (wanted) void icons.load(project.id, folder);
    }, [icons, project.id, folder, wanted]);

    return icons.src(project);
}
