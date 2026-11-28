import { makeAutoObservable, observableRef, runInAction } from 'mobx';

import { branchPrefix } from '../features/chats/branchPrefix';
import { homeFolder } from '../shared/homeFolder';
import { ModelsStore } from './ModelsStore';
import { NavHistory } from './NavHistory';
import { ProjectIconsStore } from './ProjectIconsStore';
import { ProjectState } from './ProjectState';
import { StreamStore } from './StreamStore';
import { browserStorage, type KeyValueStorage, readStored, writeStored } from './storage';
import { type InitialProjectUi, type ProjectUi, UiStore } from './UiStore';

import type { AgentInfo, ClowdyEvent, CommandResult, Project, ProjectId } from '@clowdy/protocol';
import type { CommandInput, FeedStatus, Transport } from '../daemon/transport';

/** How long the feed must stay down before the person is told. A reconnect inside this time is invisible. */
export const BANNER_DELAY_MS = 3000;
const RESYNC_RETRY_MS = 2000;
const SELECTED_PROJECT_KEY = 'clowdy:selected-project';

export type RootPhase = 'loading' | 'ready' | 'unreachable';
export type SyncStatus = 'connected' | 'reconnecting';

export interface Notice {
    level: 'info' | 'warn' | 'error';
    text: string;
}

/** The person's order: the personal space first, then by `position`, then by when the project was added. */
function sortProjects(projects: readonly Project[]): Project[] {
    return [...projects].sort(
        (a, b) =>
            Number(b.personal === true) - Number(a.personal === true) ||
            a.position - b.position ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id)
    );
}

/** What `project.add` answers: the project added, or the one that already had the same folders (`existing`). */
export interface AddedProject {
    project: Project;
    existing: boolean;
}

export interface RootStoreOptions {
    storage?: KeyValueStorage;
    /** Shows a daemon notice to the person. */
    notify?: (notice: Notice) => void;
    /** Selections every project's window starts with (fixtures mode reads them from the page URL). */
    initialUi?: InitialProjectUi;
}

/** The app's state: the daemon connection, the project list, and the loaded projects. */
export class RootStore {
    /** `unreachable` when the first snapshot could not be fetched. */
    phase: RootPhase = 'loading';
    loadError = '';
    projects: Project[] = [];
    selectedProjectId: ProjectId | null = null;
    syncStatus: SyncStatus = 'connected';
    /** True once the feed has been down for `BANNER_DELAY_MS`. */
    bannerVisible = false;
    /** Counts `skills.changed` events; the Skills settings refetch the catalog when it changes. */
    skillsRevision = 0;
    /** The agents the daemon knows, with who is signed in to each, their usage and settings. Loaded at start, and again on every `agents.changed`. */
    agents: AgentInfo[] = [];
    /** `loading` until the first answer; `failed` when the last fetch failed (`agents` then keeps what was known). */
    agentsStatus: 'loading' | 'ready' | 'failed' = 'loading';
    agentsError = '';
    readonly ui: UiStore;
    readonly streams: StreamStore;
    /** The models each agent offers, read when a model picker first asks. */
    readonly models: ModelsStore;
    /** The pictures the projects show in place of the folder icon. */
    readonly projectIcons: ProjectIconsStore;
    /** Back and forward through what the window showed. */
    readonly history: NavHistory;
    readonly #states = new Map<ProjectId, ProjectState>();
    readonly #storage: KeyValueStorage | undefined;
    readonly #notify: ((notice: Notice) => void) | undefined;
    #unsubscribe: (() => void) | undefined;
    #agentsSeq = 0;
    #agentsInflight: Promise<void> | undefined;
    #agentsScheduled = false;
    #bannerTimer: ReturnType<typeof setTimeout> | undefined;
    #resyncTimer: ReturnType<typeof setTimeout> | undefined;
    #spaceSwitch: ((apply: () => void) => void) | undefined;

    constructor(
        readonly transport: Transport,
        { storage = browserStorage(), notify, initialUi }: RootStoreOptions = {}
    ) {
        this.#storage = storage;
        this.#notify = notify;
        this.ui = new UiStore(storage, initialUi, projectId => this.projectState(projectId)?.tasks);
        this.streams = new StreamStore(transport);
        this.models = new ModelsStore(transport);
        this.projectIcons = new ProjectIconsStore(transport);
        makeAutoObservable<RootStore, 'transport'>(this, {
            transport: false,
            ui: false,
            streams: false,
            models: false,
            projectIcons: false,
            history: false,
            projects: observableRef,
            agents: observableRef,
        });
        // After `makeAutoObservable`: the history watches `selectedProjectId`, which is not observable before it.
        this.history = new NavHistory(this);
    }

    /** The selected project, once it has a state (it may still be loading). */
    get selectedProject(): ProjectState | undefined {
        return this.selectedProjectId ? this.#states.get(this.selectedProjectId) : undefined;
    }

    /** The window's state of the selected project, `undefined` while none is selected. */
    get selectedProjectUi(): ProjectUi | undefined {
        return this.selectedProjectId ? this.ui.forProject(this.selectedProjectId) : undefined;
    }

    /** A project's own screen can be drawn, with its side panel: the projects are loaded and the selected project has arrived. Settings is a window over it and does not end that. */
    get projectScreenReady(): boolean {
        return this.phase === 'ready' && this.selectedProject?.status === 'ready';
    }

    /** A project's own screen is the one in use: it is ready, and Settings is shut, so the keys of the screen and of its panel act. */
    get showsProjectScreen(): boolean {
        return this.projectScreenReady && !this.ui.settingsOpen;
    }

    /** A project's state, once the project was selected. */
    projectState(projectId: ProjectId): ProjectState | undefined {
        return this.#states.get(projectId);
    }

    /** Fetches the project list and follows the event feed. Called at start and by the retry button. */
    async load(): Promise<void> {
        this.phase = 'loading';

        try {
            const prefixRevision = branchPrefix.revision;
            const snapshot = await this.transport.getRootSnapshot();

            homeFolder.set(snapshot.home);
            runInAction(() => {
                this.projects = sortProjects(snapshot.projects);
                this.phase = 'ready';
                this.loadError = '';
            });
            this.#connectBranchPrefix(snapshot.branchPrefix, prefixRevision);
            this.#follow(snapshot.cursor);
            void this.refreshAgents();

            const stored = readStored(this.#storage, SELECTED_PROJECT_KEY);
            // Nothing remembered: the first project of the person's own, and the personal space when there is none.
            const first =
                this.projects.find(project => project.id === stored) ??
                this.projects.find(project => !project.personal) ??
                this.projects[0];

            if (first) this.selectProject(first.id);
        } catch (error) {
            runInAction(() => {
                this.phase = 'unreachable';
                this.loadError = error instanceof Error ? error.message : String(error);
            });
        }
    }

    prepareProject(projectId: ProjectId): ProjectState | undefined {
        const project = this.projects.find(candidate => candidate.id === projectId);

        if (!project) return;

        if (!this.#states.has(projectId)) {
            const state = new ProjectState(this.transport, project);

            this.#states.set(projectId, state);
            void state.load();
        }

        return this.#states.get(projectId);
    }

    /**
     * Shows another project. A switch from one project to another goes through the window's space switch when one is set
     * (`setSpaceSwitch`), which may apply it a frame later, after it has captured what the window shows; `after` runs with
     * it. `instant` applies it at once, for a gesture that already moved the content to the new project.
     */
    selectProject(
        projectId: ProjectId,
        { instant = false, after }: { instant?: boolean; after?: () => void } = {}
    ): void {
        if (!this.prepareProject(projectId)) return;

        const apply = () => {
            runInAction(() => {
                this.selectedProjectId = projectId;
            });
            writeStored(this.#storage, SELECTED_PROJECT_KEY, projectId);
            after?.();
        };
        const from = this.selectedProjectId;

        if (instant || !this.#spaceSwitch || from === null || from === projectId) apply();
        else this.#spaceSwitch(apply);
    }

    /** How the window shows a switch of project (a fade of the content); without one, a switch applies at once. */
    setSpaceSwitch(spaceSwitch: ((apply: () => void) => void) | undefined): void {
        this.#spaceSwitch = spaceSwitch;
    }

    /**
     * Fetches the agents again. The newest request wins, so a slow answer never replaces a newer one, and the promise ends
     * only when the newest request has: a caller that waits for the list to change (a switch that stays pending until then)
     * must not be released by an answer that was already replaced. Never rejects: a failure is `agentsStatus` and
     * `agentsError`, and the list keeps what it had.
     */
    async refreshAgents(): Promise<void> {
        const fetched = this.#fetchAgents(++this.#agentsSeq);
        let waited = fetched;

        this.#agentsInflight = fetched;
        await fetched;

        // A newer request started meanwhile: its answer is the one that counts, so wait for it as well.
        while (this.#agentsInflight !== waited) {
            waited = this.#agentsInflight!;
            await waited;
        }
    }

    async #fetchAgents(request: number): Promise<void> {
        try {
            const agents = await this.transport.getAgents();

            if (request !== this.#agentsSeq) return;

            runInAction(() => {
                this.agents = agents;
                this.agentsStatus = 'ready';
                this.agentsError = '';
            });
        } catch (error) {
            if (request !== this.#agentsSeq) return;

            runInAction(() => {
                this.agentsStatus = 'failed';
                this.agentsError = error instanceof Error ? error.message : String(error);
            });
        }
    }

    /** Sends a command. A daemon that cannot be reached comes back as an `unavailable` result, like any refusal. */
    async command(input: CommandInput): Promise<CommandResult> {
        try {
            return await this.transport.command(input);
        } catch (error) {
            return {
                ok: false,
                requestId: 'unsent',
                error: {
                    code: 'unavailable',
                    message: error instanceof Error ? error.message : 'The daemon cannot be reached',
                },
            };
        }
    }

    /**
     * Adds a project of `folders` (the first is the main one; none makes a new folder named after `name`) and switches to it. The daemon
     * answers a project that already has exactly these folders instead of adding one, and the window switches to that: `existing` says so.
     */
    async addProject(input: { name?: string; folders: string[] }): Promise<CommandResult<AddedProject>> {
        const result = await this.command({
            type: 'project.add',
            ...(input.name && { name: input.name }),
            ...(input.folders.length > 0 && { folders: input.folders }),
        });

        if (!result.ok) return result;

        const { project, existing } = result.data as { project: Project; existing?: boolean };

        try {
            const { projects } = await this.transport.getRootSnapshot();

            runInAction(() => {
                this.projects = sortProjects(projects);

                if (projects.some(candidate => candidate.id === project.id)) this.selectProject(project.id);
            });
        } catch {
            // The command went through; the `project.upserted` event adds the project.
        }

        return { ...result, data: { project, existing: existing === true } };
    }

    /**
     * Puts the projects in the order given (the personal space stays first, a project that is not named keeps its place after the named ones),
     * at once, and tells the daemon. A refusal puts the order back.
     */
    async reorderProjects(projectIds: readonly ProjectId[]): Promise<CommandResult> {
        const before = this.projects;
        const named = projectIds.flatMap(id => before.find(project => project.id === id && !project.personal) ?? []);
        const rest = before.filter(project => !project.personal && !named.includes(project));

        this.projects = [
            ...before.filter(project => project.personal),
            ...[...named, ...rest].map((project, index) => ({ ...project, position: index + 1 })),
        ];

        const result = await this.command({ type: 'project.reorder', projectIds: [...projectIds] });

        if (!result.ok) this.projects = before;

        return result;
    }

    /** Ends the feed and the timers: for a replaced store (hot reload) and for tests. */
    dispose(): void {
        this.history.dispose();
        this.#unsubscribe?.();
        clearTimeout(this.#bannerTimer);
        clearTimeout(this.#resyncTimer);
    }

    /** What the feed reports. Public for tests and for the dev console. */
    handleFeedStatus(status: FeedStatus): void {
        if (status === 'connected') {
            void branchPrefix.flush();
            clearTimeout(this.#bannerTimer);
            this.syncStatus = 'connected';
            this.bannerVisible = false;

            // A fetch that failed while the daemon was away is asked again by no event: nothing may have changed since.
            if (this.agentsStatus === 'failed') void this.refreshAgents();

            return;
        }

        if (this.syncStatus === 'connected') {
            this.syncStatus = 'reconnecting';
            this.#bannerTimer = setTimeout(
                () =>
                    runInAction(() => {
                        this.bannerVisible = true;
                    }),
                BANNER_DELAY_MS
            );
        }

        if (status === 'resync') void this.#resync();
    }

    handleEvent(event: ClowdyEvent): void {
        const { data } = event;

        if (data.type === 'project.upserted') {
            const known = this.projects.some(project => project.id === data.project.id);

            this.projects = sortProjects(
                known
                    ? this.projects.map(project => (project.id === data.project.id ? data.project : project))
                    : [...this.projects, data.project]
            );

            // The first project to appear, opened from another client or by the daemon, is the one to show.
            if (!known && !this.selectedProjectId) this.selectProject(data.project.id);
        } else if (data.type === 'project.deleted') {
            this.#dropProject(event.projectId);
        } else if (data.type === 'stream.item') {
            this.streams.applyItem(data.item);
        } else if (data.type === 'stream.truncated') {
            this.streams.applyTruncation(data.runId, data.fromSeq);
            // The sub-agent runs the dropped part started are gone; `ProjectState` drops their rows.
            this.streams.forget(data.removedRunIds);
        } else if (data.type === 'chat.deleted') {
            this.streams.forget(data.runIds);
        } else if (data.type === 'notice') {
            this.#notify?.({ level: data.level, text: data.text });
        } else if (data.type === 'skills.changed') {
            this.skillsRevision++;
        } else if (data.type === 'agents.changed') {
            // The daemon announces it once per project: one fetch answers them all.
            this.#scheduleAgents();
        }

        this.#states.get(event.projectId)?.applyEvent(event);
    }

    #scheduleAgents(): void {
        if (this.#agentsScheduled) return;

        this.#agentsScheduled = true;
        queueMicrotask(() => {
            this.#agentsScheduled = false;
            void this.refreshAgents();
            // The model lists the UI opened follow the agents: a sign-in or a switch changes what an agent offers.
            void this.models.reloadOpened();
        });
    }

    /** Reconciles the branch prefix with the daemon's in the background: the window does not wait for the command. */
    #connectBranchPrefix(prefix: string | undefined, revision: number): void {
        void branchPrefix.connect(
            prefix,
            async next => {
                try {
                    return (await this.transport.command({ type: 'settings.setBranchPrefix', prefix: next })).ok
                        ? 'ok'
                        : 'refused';
                } catch {
                    return 'unreachable';
                }
            },
            revision
        );
    }

    #follow(cursor: number): void {
        this.#unsubscribe?.();
        this.#unsubscribe = this.transport.subscribe(
            cursor,
            event => this.handleEvent(event),
            status => this.handleFeedStatus(status)
        );
    }

    /** The daemon no longer holds the events after our cursor: take every snapshot again, then follow from there. */
    async #resync(): Promise<void> {
        this.#unsubscribe?.();

        try {
            const prefixRevision = branchPrefix.revision;
            const snapshot = await this.transport.getRootSnapshot();

            this.#connectBranchPrefix(snapshot.branchPrefix, prefixRevision);
            homeFolder.set(snapshot.home);
            // A project removed while the feed was away has no snapshot to load.
            runInAction(() => {
                for (const id of [...this.#states.keys()]) {
                    if (!snapshot.projects.some(project => project.id === id)) this.#dropProject(id);
                }
            });

            const loaded = await Promise.all([...this.#states.values()].map(state => state.load()));

            if (loaded.includes(false)) throw new Error('A space did not reload');

            await this.streams.reloadAll();
            runInAction(() => {
                this.projects = sortProjects(snapshot.projects);
            });
            this.#follow(snapshot.cursor);
            void this.refreshAgents();
            // An `agents.changed` may have been lost in the gap, and the lists that were opened follow it.
            void this.models.reloadOpened();
        } catch {
            this.#resyncTimer = setTimeout(() => void this.#resync(), RESYNC_RETRY_MS);
        }
    }

    /** The project is gone from the daemon: its state, streams and remembered window go, and a window that was on it moves to the first project. */
    #dropProject(projectId: ProjectId): void {
        const state = this.#states.get(projectId);

        if (state) this.streams.forget([...state.runs.keys()]);

        this.#states.delete(projectId);
        this.projects = this.projects.filter(project => project.id !== projectId);
        this.ui.forgetProject(projectId);

        if (this.selectedProjectId !== projectId) return;

        this.selectedProjectId = null;

        const next = this.projects[0];

        if (next) this.selectProject(next.id);
    }
}
