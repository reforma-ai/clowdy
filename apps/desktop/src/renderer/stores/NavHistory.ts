import { compareStructural, makeAutoObservable, observableShallow, reaction, runInAction, when } from 'mobx';

import type { Project, ProjectId } from '@clowdy/protocol';
import type { ProjectState } from './ProjectState';
import type { ProjectView, SettingsPage, UiStore } from './UiStore';

/** The oldest entries fall off past this many. */
export const HISTORY_LIMIT = 100;

/**
 * Everything the window shows, as one history entry: the selected project, its place (section and what is open in it, the scope of the Tasks screen
 * among it) and Settings. The options of a section (the Tasks view and its sub-tasks toggle, finished runs, filters, the cursor and the selection) are not part of it.
 */
interface NavSnapshot extends ProjectView {
    projectId: ProjectId;
    settingsOpen: boolean;
    /** `null` while Settings is closed: the page does not show then, and two entries that differ only there would look the same. */
    settingsPage: SettingsPage | null;
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
 * the state in response: a screen that picks another selection when it mounts (a screen that finds its remembered selection gone) does it in
 * `replacing`, or the pick would be a new entry and drop the way forward.
 * Recording starts at the first selected project, so loading the app does not leave a pile of entries.
 */
export class NavHistory {
    private entries: NavSnapshot[] = [];
    /** The entry the window is on; `-1` before recording starts. */
    private index = -1;
    #replace = false;
    #disposers: Array<() => void> = [];

    constructor(private readonly host: NavHost) {
        // `replacing` must stay a plain function: as an action it would hold the reaction back until after its flag is reset.
        makeAutoObservable<NavHistory, 'host' | 'entries'>(this, { host: false, entries: observableShallow, replacing: false });
        this.#disposers.push(when(() => host.selectedProjectId !== null, () => this.#start()));
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

    /**
     * Runs `change`, which changes the navigation state, and lets that change overwrite the current entry instead of adding one:
     * for a change that follows another (the open task following the Tasks cursor), so that holding a key does not fill the history.
     * The next change after it is recorded as usual. Called inside another action the overwrite is lost, and the change is an entry.
     */
    replacing(change: () => void): void {
        this.#replace = true;

        try {
            runInAction(change);
        }
        finally {
            this.#replace = false;
        }
    }

    dispose(): void {
        this.#disposers.forEach(dispose => dispose());
        this.#disposers = [];
    }

    #start(): void {
        const first = this.#observe();

        if (first) this.#push(first);

        this.#disposers.push(reaction(() => this.#observe(), snapshot => snapshot && this.#record(snapshot), { equals: compareStructural }));
    }

    #observe(): NavSnapshot | undefined {
        const { selectedProjectId, ui } = this.host;

        if (selectedProjectId === null) return undefined;

        const { open, page } = ui.settingsView;

        return { projectId: selectedProjectId, ...ui.forProject(selectedProjectId).view, settingsOpen: open, settingsPage: page };
    }

    #record(snapshot: NavSnapshot): void {
        const current = this.entries[this.index];

        // Going back or forward just made this the current entry.
        if (current && compareStructural(current, snapshot)) return;

        if (this.#replace && current) {
            this.entries[this.index] = snapshot;

            return;
        }

        // The window is leaving this place. Whatever caused it (the rail, a shortcut) may not have settled a scope that is gone, and Back skips an entry whose
        // scope is gone, so the place is kept as the roots the screen was showing.
        if (current) this.entries[this.index] = this.#withoutGoneScope(current);

        this.entries.splice(this.index + 1);
        this.#push(snapshot);
    }

    /** The entry with the roots of the Tasks screen in place of a scope that has left the board; the entry itself when the scope is there, or the entry is not a Tasks one. */
    #withoutGoneScope(entry: NavSnapshot): NavSnapshot {
        if (entry.section !== 'tasks' || entry.tasksScope === null || entry.settingsOpen) return entry;

        const state = this.host.projectState(entry.projectId);

        return state?.status === 'ready' && !state.tasks.has(entry.tasksScope) ? { ...entry, tasksScope: null } : entry;
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

    /**
     * Whether what the entry shows is still there: its project, and the chat, task or run of its section, and for the Tasks screen the task whose insides it
     * showed (a scope that is gone or archived is not a place to go back to), and a task it had open, which may be an archived one the window has read
     * (`ProjectState.archivedKnown`, bounded: one let go of is no longer a place). Documents are always there, the tree may list them again.
     */
    #exists({ projectId, section, chatId, taskId, runId, tasksScope, settingsOpen }: NavSnapshot): boolean {
        if (!this.host.projects.some(project => project.id === projectId)) return false;

        const state = this.host.projectState(projectId);

        // Settings covers the section, and a project that has not delivered its snapshot yet cannot say what it holds.
        if (settingsOpen || state?.status !== 'ready') return true;

        switch (section) {
            case 'agents': return (chatId === null || state.chats.has(chatId)) && (runId === null || state.runs.has(runId));
            // An archived task the window has read is a place too, and a scope is never one (the screen shows the roots for it).
            case 'tasks': return (taskId === null || state.tasks.has(taskId) || state.archivedKnown.has(taskId)) && (tasksScope === null || state.tasks.has(tasksScope));
            case 'docs': return true;
        }
    }

    #go(direction: -1 | 1): void {
        const target = this.#find(direction);

        if (target === undefined) return;

        const entry = this.entries[target];
        const { host } = this;

        this.index = target;

        if (host.selectedProjectId !== entry.projectId) host.selectProject(entry.projectId);

        host.ui.restore(host.ui.forProject(entry.projectId), entry, { open: entry.settingsOpen, page: entry.settingsPage });
    }
}
