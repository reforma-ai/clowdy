import { compareStructural, makeAutoObservable, observableShallow, reaction, when } from 'mobx';

import type { Project, ProjectId } from '@clowdy/protocol';
import type { ProjectState } from './ProjectState';
import type { ProjectView, UiStore } from './UiStore';

/** The oldest entries fall off past this many. */
export const HISTORY_LIMIT = 100;

/**
 * Everything the window shows, as one history entry: the selected project and its place (section and the chat or run open in it). Settings is a window over a
 * place, not a place, so it is not part of it, and neither is the side panel with what it shows (the open task and the scope of the Tasks tab among it). The
 * options of a section (finished runs, filters, the cursor and the selection) are not part of it either.
 */
interface NavSnapshot extends ProjectView {
    projectId: ProjectId;
}

/** What the history needs of the root store. */
interface NavHost {
    readonly projects: readonly Project[];
    readonly selectedProjectId: ProjectId | null;
    readonly ui: UiStore;
    selectProject: (projectId: ProjectId) => void;
    /** A project's state once it was selected; the history looks into projects that are not showing. */
    projectState: (projectId: ProjectId) => ProjectState | undefined;
}

/**
 * Back and forward through what the window showed, in memory only.
 *
 * One reaction watches the navigation state, so every action that changes what the window shows is an entry without its call site knowing:
 * a new one drops the entries ahead of the current one. Going back or forward applies the entry and moves the position, in one action. When the reaction
 * then looks, the state equals the current entry and records nothing, so applying needs no flag of its own. That holds as long as nothing else changes
 * the state in response: a screen that picks another selection when it mounts would make a new entry and drop the way forward.
 * Recording starts at the first selected project, so loading the app does not leave a pile of entries.
 */
export class NavHistory {
    private entries: NavSnapshot[] = [];
    /** The entry the window is on; `-1` before recording starts. */
    private index = -1;
    #disposers: Array<() => void> = [];

    constructor(private readonly host: NavHost) {
        makeAutoObservable<NavHistory, 'host' | 'entries'>(this, { host: false, entries: observableShallow });
        this.#disposers.push(
            when(
                () => host.selectedProjectId !== null,
                () => this.#start()
            )
        );
    }

    get canGoBack(): boolean {
        return this.#find(-1) !== undefined;
    }

    get canGoForward(): boolean {
        return this.#find(1) !== undefined;
    }

    back(): void {
        this.#go(-1);
    }

    forward(): void {
        this.#go(1);
    }

    dispose(): void {
        this.#disposers.forEach(dispose => dispose());
        this.#disposers = [];
    }

    #start(): void {
        const first = this.#observe();

        if (first) this.#push(first);

        this.#disposers.push(
            reaction(
                () => this.#observe(),
                snapshot => snapshot && this.#record(snapshot),
                { equals: compareStructural }
            )
        );
    }

    #observe(): NavSnapshot | undefined {
        const { selectedProjectId, ui } = this.host;

        if (selectedProjectId === null) return undefined;

        return { projectId: selectedProjectId, ...ui.forProject(selectedProjectId).view };
    }

    #record(snapshot: NavSnapshot): void {
        const current = this.entries[this.index];

        // Going back or forward just made this the current entry.
        if (current && compareStructural(current, snapshot)) return;

        this.entries.splice(this.index + 1);
        this.#push(snapshot);
    }

    #push(snapshot: NavSnapshot): void {
        this.entries.push(snapshot);

        if (this.entries.length > HISTORY_LIMIT) this.entries.splice(0, this.entries.length - HISTORY_LIMIT);

        this.index = this.entries.length - 1;
    }

    /** The nearest entry in the direction that can still be shown, and that shows something else than the window does now (a button that does nothing is worse than none). */
    #find(direction: -1 | 1): number | undefined {
        const current = this.entries[this.index];

        for (let at = this.index + direction; at >= 0 && at < this.entries.length; at += direction) {
            const entry = this.entries[at];

            if (this.#exists(entry) && !compareStructural(entry, current)) return at;
        }

        return undefined;
    }

    /** Whether what the entry shows is still there: its project, and the chat or run it had open. */
    #exists({ projectId, chatId, runId }: NavSnapshot): boolean {
        if (!this.host.projects.some(project => project.id === projectId)) return false;

        const state = this.host.projectState(projectId);

        // A project that has not delivered its snapshot yet cannot say what it holds.
        if (state?.status !== 'ready') return true;

        return (chatId === null || state.chats.has(chatId)) && (runId === null || state.runs.has(runId));
    }

    #go(direction: -1 | 1): void {
        const target = this.#find(direction);

        if (target === undefined) return;

        const entry = this.entries[target];
        const { host } = this;

        this.index = target;

        if (host.selectedProjectId !== entry.projectId) host.selectProject(entry.projectId);

        host.ui.restore(host.ui.forProject(entry.projectId), entry);
    }
}
