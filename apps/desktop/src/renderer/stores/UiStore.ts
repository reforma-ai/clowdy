import { makeAutoObservable, observableRef, reaction } from 'mobx';

import { readStored, removeStored, writeStored, type KeyValueStorage } from './storage';

import type { ChatId, FolderId, ProjectId, RunId, TaskId } from '@clowdy/protocol';

export const SECTIONS = ['agents', 'tasks', 'docs'] as const;

export type Section = typeof SECTIONS[number];

/** The pages of the global Settings window, in the order they appear in its sidebar. */
export const SETTINGS_PAGES = ['appearance', 'chat', 'projects', 'providers', 'skills'] as const;

export type SettingsPage = typeof SETTINGS_PAGES[number];
export type TasksView = 'board' | 'list';
/** The order of the chats in the Agents list, newest first: by the last thing that happened in the chat, or by when it was made. */
export type ChatSort = 'activity' | 'created';

/** Where a project's window is: the section and what is open in it. History walks these; the view options of a section are not places. */
export interface ProjectView {
    section: Section;
    chatId: ChatId | null;
    taskId: TaskId | null;
    runId: RunId | null;
    docPath: string | null;
    /** The folder of the project whose docs folder holds `docPath`; `null` is the main folder. */
    docFolderId: FolderId | null;
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
    docFolderId: FolderId | null;
    showFinished: boolean;
    showSubthreads: boolean;
    chatSort: ChatSort;
    tasksView: TasksView;
}

const uiKey = (projectId: ProjectId) => `clowdy:ui:${ projectId }`;

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a page URL may preselect in fixtures mode, for screenshots and demos: `?section=tasks&task=t-24&view=list`. */
export type InitialProjectUi = Partial<Pick<StoredProjectUi, 'section' | 'chatId' | 'taskId' | 'runId' | 'docPath' | 'docFolderId' | 'showFinished' | 'showSubthreads' | 'chatSort' | 'tasksView'>>;

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

    if (params.has('docFolder')) initial.docFolderId = params.get('docFolder');

    if (params.has('finished')) initial.showFinished = params.get('finished') !== '0';

    if (params.has('subthreads')) initial.showSubthreads = params.get('subthreads') !== '0';

    if (params.get('sort') === 'activity' || params.get('sort') === 'created') initial.chatSort = params.get('sort') as ChatSort;

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
    /** The folder whose docs folder holds `docPath`; `null` is the main folder, which is also where a document opened by its path alone is. */
    docFolderId: FolderId | null = null;
    /** Agents: the new-chat row is selected, and the chat it starts does not exist until its first message is sent. Not kept between sessions. */
    draft = false;
    /** Agents: list the runs below each chat, the chat's subthreads. */
    showSubthreads = true;
    /** Agents: list a subthread that has finished. */
    showFinished = true;
    /** Agents: the order of the chats. Last activity, which is where a chat that just got a message goes up to the top, until the person picks the order they were made in. */
    chatSort: ChatSort = 'activity';
    tasksView: TasksView = 'board';
    /** Agents: files that a hand-off from another chat left for the new-chat page, which takes them once it is open. Not kept between sessions. */
    pendingFiles: readonly File[] = [];

    constructor(readonly projectId: ProjectId, storage?: KeyValueStorage, initial: InitialProjectUi = {}) {
        const key = uiKey(projectId);
        const stored = readStored(storage, key) as Partial<Record<keyof StoredProjectUi, unknown>> | undefined;

        if (stored && typeof stored === 'object') {
            this.section = SECTIONS.find(section => section === stored.section) ?? this.section;
            this.chatId = idOrNull(stored.chatId);
            this.taskId = idOrNull(stored.taskId);
            this.runId = idOrNull(stored.runId);
            this.docPath = idOrNull(stored.docPath);
            this.docFolderId = idOrNull(stored.docFolderId);
            this.showFinished = stored.showFinished !== false;
            this.showSubthreads = stored.showSubthreads !== false;
            this.chatSort = stored.chatSort === 'created' ? 'created' : 'activity';
            this.tasksView = stored.tasksView === 'list' ? 'list' : 'board';
        }

        Object.assign(this, initial);
        makeAutoObservable(this, { projectId: false, pendingFiles: observableRef });
        reaction(
            (): StoredProjectUi => ({
                section: this.section,
                chatId: this.chatId,
                taskId: this.taskId,
                runId: this.runId,
                docPath: this.docPath,
                docFolderId: this.docFolderId,
                showFinished: this.showFinished,
                showSubthreads: this.showSubthreads,
                chatSort: this.chatSort,
                tasksView: this.tasksView,
            }),
            value => writeStored(storage, key, value)
        );
    }

    /** The place the window shows, as a value that can be kept and shown again with `show`. */
    get view(): ProjectView {
        return { section: this.section, chatId: this.chatId, taskId: this.taskId, runId: this.runId, docPath: this.docPath, docFolderId: this.docFolderId, draft: this.draft };
    }

    /** Shows a place kept from `view`, as one change. */
    show({ section, chatId, taskId, runId, docPath, docFolderId, draft }: ProjectView): void {
        this.section = section;
        this.chatId = chatId;
        this.taskId = taskId;
        this.runId = runId;
        this.docPath = docPath;
        this.docFolderId = docFolderId;
        this.draft = draft;
    }

    /** Shows the chat, in the Agents section; `null` leaves none selected. */
    openChat(chatId: ChatId | null): void {
        this.section = 'agents';
        this.chatId = chatId;
        this.runId = null;
        this.draft = false;
    }

    /**
     * Shows the new-chat row of the Agents section: a chat that is only made when its first message is sent. `attach` are files for
     * its message box (a hand-off brings the old conversation this way): the page picks them up with `takePendingFiles`.
     */
    openDraft(attach: readonly File[] = []): void {
        this.section = 'agents';
        this.runId = null;
        this.draft = true;

        if (attach.length > 0) this.pendingFiles = [...this.pendingFiles, ...attach];
    }

    /** The files `openDraft` was given, handed over once: the next call finds none. */
    takePendingFiles(): readonly File[] {
        const files = this.pendingFiles;

        this.pendingFiles = [];

        return files;
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

    /** Shows a document in the Documents section: its path under the docs folder of `folderId`, the main folder's when none is named. */
    openDoc(path: string | null, folderId: FolderId | null = null): void {
        this.section = 'docs';
        this.docPath = path;
        this.docFolderId = folderId;
    }

    setShowFinished(show: boolean): void {
        this.showFinished = show;
    }

    setShowSubthreads(show: boolean): void {
        this.showSubthreads = show;
    }

    setChatSort(sort: ChatSort): void {
        this.chatSort = sort;
    }

    setTasksView(view: TasksView): void {
        this.tasksView = view;
    }
}

/** Window state: one `ProjectUi` per project, and the global Settings page that sits over the sections. */
export class UiStore {
    settingsOpen = false;
    settingsPage: SettingsPage = 'appearance';
    /** The project whose own page is open inside Settings > Projects; `null` shows the list of projects. */
    settingsProjectId: ProjectId | null = null;
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

    /** Leaves Settings for the section that is under it. */
    closeSettings(): void {
        this.settingsOpen = false;
    }

    /** Opens Settings, on `page` when given and else on the page last shown. */
    openSettings(page?: SettingsPage): void {
        this.settingsOpen = true;

        if (page) this.settingsPage = page;
    }

    /** Opens Settings > Projects, on the page of `projectId` or, without one, on the list. */
    openProjectSettings(projectId: ProjectId | null = null): void {
        this.settingsOpen = true;
        this.settingsPage = 'projects';
        this.settingsProjectId = projectId;
    }

    /** Another page of Settings always starts from its top: Projects shows its list again. */
    showSettingsPage(page: SettingsPage): void {
        this.settingsPage = page;
        this.settingsProjectId = null;
    }

    /** The project was removed: its window state goes with it, kept or not. */
    forgetProject(projectId: ProjectId): void {
        this.#projects.delete(projectId);

        if (this.settingsProjectId === projectId) this.settingsProjectId = null;

        removeStored(this.storage, uiKey(projectId));
    }
}
