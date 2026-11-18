import { makeAutoObservable, reaction } from 'mobx';

import { readStored, writeStored, type KeyValueStorage } from './storage';

import type { ChatId, ProjectId, RunId, TaskId } from '@clowdy/protocol';

export const SECTIONS = ['agents', 'tasks', 'docs'] as const;

export type Section = typeof SECTIONS[number];

/** The pages of the global Settings window, in the order they appear in its sidebar. */
export const SETTINGS_PAGES = ['appearance', 'providers', 'skills'] as const;

export type SettingsPage = typeof SETTINGS_PAGES[number];
export type TasksView = 'board' | 'list';

/** Where a project's window is: the section and what is open in it. History walks these; the view options of a section are not places. */
export interface ProjectView {
    section: Section;
    chatId: ChatId | null;
    taskId: TaskId | null;
    runId: RunId | null;
    docPath: string | null;
    /** Agents: the new-chat row is selected, and no chat exists yet. */
    draft: boolean;
}

/** Whether Settings covers the window, and on which page. The page is `null` while Settings is closed, because it does not show then. */
export interface SettingsView {
    open: boolean;
    page: SettingsPage | null;
}

interface StoredProjectUi {
    section: Section;
    chatId: ChatId | null;
    taskId: TaskId | null;
    runId: RunId | null;
    docPath: string | null;
    showFinished: boolean;
    showSubthreads: boolean;
    showArchived: boolean;
    tasksView: TasksView;
}

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a page URL may preselect in fixtures mode, for screenshots and demos: `?section=tasks&task=t-24&view=list`. */
export type InitialProjectUi = Partial<Pick<StoredProjectUi, 'section' | 'chatId' | 'taskId' | 'runId' | 'docPath' | 'showFinished' | 'showSubthreads' | 'showArchived' | 'tasksView'>>;

export function initialUiFromSearch(search: string): InitialProjectUi {
    const params = new URLSearchParams(search);
    const section = SECTIONS.find(candidate => candidate === params.get('section'));
    const view = params.get('view');
    const initial: InitialProjectUi = {};

    if (section) initial.section = section;

    if (params.has('chat')) initial.chatId = params.get('chat');

    if (params.has('task')) initial.taskId = params.get('task');

    if (params.has('run')) initial.runId = params.get('run');

    if (params.has('doc')) initial.docPath = params.get('doc');

    if (params.has('finished')) initial.showFinished = params.get('finished') !== '0';

    if (params.has('subthreads')) initial.showSubthreads = params.get('subthreads') !== '0';

    if (params.has('archived')) initial.showArchived = params.get('archived') !== '0';

    if (view === 'board' || view === 'list') initial.tasksView = view;

    return initial;
}

/** What a project's window shows, remembered per project. The `open*` actions are how one section links to another. */
export class ProjectUi {
    section: Section = 'agents';
    chatId: ChatId | null = null;
    taskId: TaskId | null = null;
    runId: RunId | null = null;
    docPath: string | null = null;
    /** Agents: the new-chat row is selected, and the chat it starts does not exist until its first message is sent. Not kept between sessions. */
    draft = false;
    /** Agents: list the runs below each chat, the chat's subthreads. */
    showSubthreads = true;
    /** Agents: list a subthread that has finished. */
    showFinished = true;
    /** Agents: list the chats that were archived. */
    showArchived = false;
    tasksView: TasksView = 'board';

    constructor(readonly projectId: ProjectId, storage?: KeyValueStorage, initial: InitialProjectUi = {}) {
        const key = `clowdy:ui:${ projectId }`;
        const stored = readStored(storage, key) as Partial<Record<keyof StoredProjectUi, unknown>> | undefined;

        if (stored && typeof stored === 'object') {
            this.section = SECTIONS.find(section => section === stored.section) ?? this.section;
            this.chatId = idOrNull(stored.chatId);
            this.taskId = idOrNull(stored.taskId);
            this.runId = idOrNull(stored.runId);
            this.docPath = idOrNull(stored.docPath);
            this.showFinished = stored.showFinished !== false;
            this.showSubthreads = stored.showSubthreads !== false;
            this.showArchived = stored.showArchived === true;
            this.tasksView = stored.tasksView === 'list' ? 'list' : 'board';
        }

        Object.assign(this, initial);
        makeAutoObservable(this, { projectId: false });
        reaction(
            (): StoredProjectUi => ({
                section: this.section,
                chatId: this.chatId,
                taskId: this.taskId,
                runId: this.runId,
                docPath: this.docPath,
                showFinished: this.showFinished,
                showSubthreads: this.showSubthreads,
                showArchived: this.showArchived,
                tasksView: this.tasksView,
            }),
            value => writeStored(storage, key, value)
        );
    }

    /** The place the window shows, as a value that can be kept and shown again with `show`. */
    get view(): ProjectView {
        return { section: this.section, chatId: this.chatId, taskId: this.taskId, runId: this.runId, docPath: this.docPath, draft: this.draft };
    }

    /** Shows a place kept from `view`, as one change. */
    show({ section, chatId, taskId, runId, docPath, draft }: ProjectView): void {
        this.section = section;
        this.chatId = chatId;
        this.taskId = taskId;
        this.runId = runId;
        this.docPath = docPath;
        this.draft = draft;
    }

    /** Shows the chat, in the Agents section; `null` leaves none selected. */
    openChat(chatId: ChatId | null): void {
        this.section = 'agents';
        this.chatId = chatId;
        this.runId = null;
        this.draft = false;
    }

    /** Shows the new-chat row of the Agents section: a chat that is only made when its first message is sent. */
    openDraft(): void {
        this.section = 'agents';
        this.runId = null;
        this.draft = true;
    }

    /** Shows the task in the Tasks section; `null` closes its detail panel. */
    openTask(taskId: TaskId | null): void {
        this.section = 'tasks';
        this.taskId = taskId;
    }

    /** Shows the run in the Agents section, below its chat; a root run is its chat. */
    openRun(runId: RunId | null): void {
        this.section = 'agents';
        this.runId = runId;
        this.draft = false;
    }

    openDoc(path: string | null): void {
        this.section = 'docs';
        this.docPath = path;
    }

    setShowFinished(show: boolean): void {
        this.showFinished = show;
    }

    setShowSubthreads(show: boolean): void {
        this.showSubthreads = show;
    }

    setShowArchived(show: boolean): void {
        this.showArchived = show;
    }

    setTasksView(view: TasksView): void {
        this.tasksView = view;
    }
}

/** Window state: one `ProjectUi` per project, and the global Settings page that sits over the sections. */
export class UiStore {
    settingsOpen = false;
    settingsPage: SettingsPage = 'appearance';
    readonly #projects = new Map<ProjectId, ProjectUi>();

    constructor(private readonly storage?: KeyValueStorage, private readonly initial?: InitialProjectUi) {
        makeAutoObservable<UiStore, 'storage' | 'initial'>(this, { storage: false, initial: false });
    }

    forProject(projectId: ProjectId): ProjectUi {
        let ui = this.#projects.get(projectId);

        if (!ui) {
            ui = new ProjectUi(projectId, this.storage, this.initial);
            this.#projects.set(projectId, ui);
        }

        return ui;
    }

    get settingsView(): SettingsView {
        return { open: this.settingsOpen, page: this.settingsOpen ? this.settingsPage : null };
    }

    /** Shows a place of the project and the Settings state that went with it, as one change: what back and forward do. */
    restore(ui: ProjectUi, view: ProjectView, settings: SettingsView): void {
        ui.show(view);
        this.settingsOpen = settings.open;

        if (settings.page) this.settingsPage = settings.page;
    }

    /** Rail navigation: shows a section of the project and leaves Settings. */
    showSection(ui: ProjectUi, section: Section): void {
        this.settingsOpen = false;
        ui.section = section;
    }

    /** Opens Settings, on `page` when given and else on the page last shown. */
    openSettings(page?: SettingsPage): void {
        this.settingsOpen = true;

        if (page) this.settingsPage = page;
    }

    showSettingsPage(page: SettingsPage): void {
        this.settingsPage = page;
    }
}
