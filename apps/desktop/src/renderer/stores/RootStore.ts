import { makeAutoObservable, observableRef, runInAction } from 'mobx';

import { NavHistory } from './NavHistory';
import { ProjectState } from './ProjectState';
import { browserStorage, readStored, writeStored, type KeyValueStorage } from './storage';
import { StreamStore } from './StreamStore';
import { UiStore, type InitialProjectUi } from './UiStore';

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

export interface RootStoreOptions {
    storage?: KeyValueStorage;
    /** Shows a daemon notice to the person. */
    notify?: (notice: Notice) => void;
    /** Section and selections every project's window starts with (fixtures mode reads them from the page URL). */
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

    constructor(readonly transport: Transport, { storage = browserStorage(), notify, initialUi }: RootStoreOptions = {}) {
        this.#storage = storage;
        this.#notify = notify;
        this.ui = new UiStore(storage, initialUi);
        this.streams = new StreamStore(transport);
        makeAutoObservable<RootStore, 'transport'>(this, { transport: false, ui: false, streams: false, history: false, projects: observableRef, agents: observableRef });
        // After `makeAutoObservable`: the history watches `selectedProjectId`, which is not observable before it.
        this.history = new NavHistory(this);
    }

    /** The selected project, once it has a state (it may still be loading). */
    get selectedProject(): ProjectState | undefined {
        return this.selectedProjectId ? this.#states.get(this.selectedProjectId) : undefined;
    }

    /** A project's state, once the project was selected. */
    projectState(projectId: ProjectId): ProjectState | undefined {
        return this.#states.get(projectId);
    }

    /** Fetches the project list and follows the event feed. Called at start and by the retry button. */
    async load(): Promise<void> {
        this.phase = 'loading';

        try {
            const snapshot = await this.transport.getRootSnapshot();

            runInAction(() => {
                this.projects = snapshot.projects;
                this.phase = 'ready';
                this.loadError = '';
            });
            this.#follow(snapshot.cursor);
            void this.refreshAgents();

            const stored = readStored(this.#storage, SELECTED_PROJECT_KEY);
            const first = snapshot.projects.find(project => project.id === stored) ?? snapshot.projects[0];

            if (first) this.selectProject(first.id);
        }
        catch (error) {
            runInAction(() => {
                this.phase = 'unreachable';
                this.loadError = error instanceof Error ? error.message : String(error);
            });
        }
    }

    selectProject(projectId: ProjectId): void {
        const project = this.projects.find(candidate => candidate.id === projectId);

        if (!project) return;

        if (!this.#states.has(projectId)) {
            const state = new ProjectState(this.transport, project);

            this.#states.set(projectId, state);
            void state.load();
        }

        this.selectedProjectId = projectId;
        writeStored(this.#storage, SELECTED_PROJECT_KEY, projectId);
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
        }
        catch (error) {
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
        }
        catch (error) {
            return { ok: false, requestId: 'unsent', error: { code: 'unavailable', message: error instanceof Error ? error.message : 'The daemon cannot be reached' } };
        }
    }

    /** Creates a project, in a new folder or at `path`, and switches to it. */
    createProject(name: string, path?: string): Promise<CommandResult> {
        return this.#addProject({ type: 'project.create', name, path }, path);
    }

    /** Opens the repository at `path` as a project, and switches to it. */
    openProject(path: string, name?: string): Promise<CommandResult> {
        return this.#addProject({ type: 'project.open', path, name }, path);
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
            clearTimeout(this.#bannerTimer);
            this.syncStatus = 'connected';
            this.bannerVisible = false;

            // A fetch that failed while the daemon was away is asked again by no event: nothing may have changed since.
            if (this.agentsStatus === 'failed') void this.refreshAgents();

            return;
        }

        if (this.syncStatus === 'connected') {
            this.syncStatus = 'reconnecting';
            this.#bannerTimer = setTimeout(() => runInAction(() => {
                this.bannerVisible = true;
            }), BANNER_DELAY_MS);
        }

        if (status === 'resync') void this.#resync();
    }

    handleEvent(event: ClowdyEvent): void {
        const { data } = event;

        if (data.type === 'project.upserted') {
            const known = this.projects.some(project => project.id === data.project.id);

            this.projects = known ? this.projects.map(project => (project.id === data.project.id ? data.project : project)) : [...this.projects, data.project];

            // The first project to appear, opened from another client or by the daemon, is the one to show.
            if (!known && !this.selectedProjectId) this.selectProject(data.project.id);
        }
        else if (data.type === 'stream.item') {
            this.streams.applyItem(data.item);
        }
        else if (data.type === 'chat.deleted') {
            this.streams.forget(data.runIds);
        }
        else if (data.type === 'notice') {
            this.#notify?.({ level: data.level, text: data.text });
        }
        else if (data.type === 'skills.changed') {
            this.skillsRevision++;
        }
        else if (data.type === 'agents.changed') {
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
        });
    }

    #follow(cursor: number): void {
        this.#unsubscribe?.();
        this.#unsubscribe = this.transport.subscribe(cursor, event => this.handleEvent(event), status => this.handleFeedStatus(status));
    }

    /** The daemon no longer holds the events after our cursor: take every snapshot again, then follow from there. */
    async #resync(): Promise<void> {
        this.#unsubscribe?.();

        try {
            const snapshot = await this.transport.getRootSnapshot();
            const loaded = await Promise.all([...this.#states.values()].map(state => state.load()));

            if (loaded.includes(false)) throw new Error('A project did not reload');

            await this.streams.reloadAll();
            runInAction(() => {
                this.projects = snapshot.projects;
            });
            this.#follow(snapshot.cursor);
            void this.refreshAgents();
        }
        catch {
            this.#resyncTimer = setTimeout(() => void this.#resync(), RESYNC_RETRY_MS);
        }
    }

    async #addProject(input: CommandInput, path: string | undefined): Promise<CommandResult> {
        const known = new Set(this.projects.map(project => project.id));
        const result = await this.command(input);

        if (!result.ok) return result;

        try {
            const { projects } = await this.transport.getRootSnapshot();

            runInAction(() => {
                this.projects = projects;

                const added = projects.find(project => !known.has(project.id)) ?? projects.find(project => project.path === path);

                if (added) this.selectProject(added.id);
            });
        }
        catch {
            // The command went through; the `project.upserted` event adds the project.
        }

        return result;
    }
}
