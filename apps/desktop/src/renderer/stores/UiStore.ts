import { makeAutoObservable, observableRef, reaction } from 'mobx';

import { readStored, removeStored, writeStored, type KeyValueStorage } from './storage';

import type { ChatId, FolderId, ProjectId, RunId, TaskId } from '@clowdy/protocol';

export const SECTIONS = ['agents', 'tasks', 'docs'] as const;

export type Section = typeof SECTIONS[number];

/** The pages of the global Settings window, in the order they appear in its sidebar. */
export const SETTINGS_PAGES = ['appearance', 'chat', 'files', 'shortcuts', 'projects', 'providers', 'skills'] as const;

export type SettingsPage = typeof SETTINGS_PAGES[number];
export type TasksView = 'board' | 'list';

/** The tabs of the side panel's header, in the order they appear there. */
export const SIDE_PANEL_TABS = ['info', 'files'] as const;

export type SidePanelTab = typeof SIDE_PANEL_TABS[number];

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
    /** Agents: the folder the new chat is for, `null` for the main folder. Meaningful only with `draft`. */
    draftFolderId: FolderId | null;
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
    expandedChats: ChatId[];
    groupByFolder: boolean;
    collapsedFolders: FolderId[];
    agentsFolded: boolean;
    sidePanelOpen: boolean;
    sidePanelTab: SidePanelTab;
    tasksView: TasksView;
}

const uiKey = (projectId: ProjectId) => `clowdy:ui:${ projectId }`;

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a page URL may preselect in fixtures mode, for screenshots and demos: `?section=tasks&task=t-24&view=list`. */
export type InitialProjectUi = Partial<Pick<StoredProjectUi, 'section' | 'chatId' | 'taskId' | 'runId' | 'docPath' | 'docFolderId' | 'expandedChats' | 'groupByFolder' | 'collapsedFolders' | 'agentsFolded' | 'sidePanelOpen' | 'sidePanelTab' | 'tasksView'>>;

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

    if (params.get('expand')) initial.expandedChats = params.get('expand')!.split(',').filter(Boolean);

    if (params.has('group')) initial.groupByFolder = params.get('group') !== '0';

    if (params.get('collapsed')) initial.collapsedFolders = params.get('collapsed')!.split(',').filter(Boolean);

    if (params.has('agents')) initial.agentsFolded = params.get('agents') === 'folded';

    if (params.has('panel')) initial.sidePanelOpen = params.get('panel') === 'open';

    const panelTab = SIDE_PANEL_TABS.find(candidate => candidate === params.get('panelTab'));

    if (panelTab) initial.sidePanelTab = panelTab;

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
    /** Agents: the folder the new-chat page is for, `null` for the main folder. Not kept between sessions. */
    draftFolderId: FolderId | null = null;
    /** Agents: the chats whose threads the person opened in the list. A chat that is not here is folded, which is how every chat starts. */
    expandedChats: readonly ChatId[] = [];
    /**
     * Agents: the list has a group for each folder of the project, each with a new-chat button that starts a chat in that folder. On until the person turns
     * it off (a project that kept no choice groups); off, the list is flat and a new chat starts in the main folder. Only a project with several folders
     * groups, whatever is kept here.
     */
    groupByFolder = true;
    /** Agents: the folders whose group is folded in the list. A folder that is not here is open, which is how every group starts. */
    collapsedFolders: readonly FolderId[] = [];
    /** Chats: the strip of running agents over the message box shows its line only, with the rows folded away. Kept for every chat of the project. */
    agentsFolded = false;
    /** The side panel at the right of the window is open for this project. Closed until the person opens it, and kept for the project, whichever chat or section is on show. */
    sidePanelOpen = false;
    /** The tab the side panel shows, kept for the project: the one it was left on. */
    sidePanelTab: SidePanelTab = 'info';
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
            this.expandedChats = Array.isArray(stored.expandedChats) ? stored.expandedChats.filter(id => typeof id === 'string') : [];
            this.groupByFolder = stored.groupByFolder !== false;
            this.collapsedFolders = Array.isArray(stored.collapsedFolders) ? stored.collapsedFolders.filter(id => typeof id === 'string') : [];
            this.agentsFolded = stored.agentsFolded === true;
            this.sidePanelOpen = stored.sidePanelOpen === true;
            this.sidePanelTab = SIDE_PANEL_TABS.find(tab => tab === stored.sidePanelTab) ?? this.sidePanelTab;
            this.tasksView = stored.tasksView === 'list' ? 'list' : 'board';
        }

        Object.assign(this, initial);
        makeAutoObservable(this, { projectId: false, pendingFiles: observableRef, expandedChats: observableRef, collapsedFolders: observableRef });
        reaction(
            (): StoredProjectUi => ({
                section: this.section,
                chatId: this.chatId,
                taskId: this.taskId,
                runId: this.runId,
                docPath: this.docPath,
                docFolderId: this.docFolderId,
                expandedChats: [...this.expandedChats],
                groupByFolder: this.groupByFolder,
                collapsedFolders: [...this.collapsedFolders],
                agentsFolded: this.agentsFolded,
                sidePanelOpen: this.sidePanelOpen,
                sidePanelTab: this.sidePanelTab,
                tasksView: this.tasksView,
            }),
            value => writeStored(storage, key, value)
        );
    }

    /** The place the window shows, as a value that can be kept and shown again with `show`. */
    get view(): ProjectView {
        return { section: this.section, chatId: this.chatId, taskId: this.taskId, runId: this.runId, docPath: this.docPath, docFolderId: this.docFolderId, draft: this.draft, draftFolderId: this.draftFolderId };
    }

    /** Shows a place kept from `view`, as one change. */
    show({ section, chatId, taskId, runId, docPath, docFolderId, draft, draftFolderId }: ProjectView): void {
        this.section = section;
        this.chatId = chatId;
        this.taskId = taskId;
        this.runId = runId;
        this.docPath = docPath;
        this.docFolderId = docFolderId;
        this.draft = draft;
        this.draftFolderId = draftFolderId;
    }

    /** Shows the chat, in the Agents section; `null` leaves none selected. */
    openChat(chatId: ChatId | null): void {
        this.section = 'agents';
        this.chatId = chatId;
        this.runId = null;
        this.draft = false;
        this.draftFolderId = null;
    }

    /**
     * Shows the new-chat row of the Agents section: a chat that is only made when its first message is sent. `attach` are files for
     * its message box (a hand-off brings the old conversation this way): the page picks them up with `takePendingFiles`. `folderId` is the folder
     * of the project the chat is made for, `null` for the main folder.
     */
    openDraft(attach: readonly File[] = [], folderId: FolderId | null = null): void {
        this.section = 'agents';
        this.runId = null;
        this.draft = true;
        this.draftFolderId = folderId;

        if (attach.length > 0) this.pendingFiles = [...this.pendingFiles, ...attach];
    }

    /** Changes the folder the new-chat page is for, `null` for the main folder. Only with that page open: the folder is no part of any other place. */
    setDraftFolder(folderId: FolderId | null): void {
        if (!this.draft) return;

        this.draftFolderId = folderId;
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
        this.draftFolderId = null;
    }

    /** Shows a document in the Documents section: its path under the docs folder of `folderId`, the main folder's when none is named. */
    openDoc(path: string | null, folderId: FolderId | null = null): void {
        this.section = 'docs';
        this.docPath = path;
        this.docFolderId = folderId;
    }

    /** Opens or folds the threads of a chat in the list. */
    toggleChatExpanded(chatId: ChatId): void {
        this.expandedChats = this.expandedChats.includes(chatId) ? this.expandedChats.filter(id => id !== chatId) : [...this.expandedChats, chatId];
    }

    /** Opens the threads of these chats, for a chat below them that was opened from elsewhere. Nothing changes when all are open already. */
    expandChats(chatIds: readonly ChatId[]): void {
        const closed = chatIds.filter(id => !this.expandedChats.includes(id));

        if (closed.length > 0) this.expandedChats = [...this.expandedChats, ...closed];
    }

    setGroupByFolder(group: boolean): void {
        this.groupByFolder = group;
    }

    /** Folds the group of a folder in the list, or opens it again. */
    toggleFolderCollapsed(folderId: FolderId): void {
        this.collapsedFolders = this.collapsedFolders.includes(folderId) ? this.collapsedFolders.filter(id => id !== folderId) : [...this.collapsedFolders, folderId];
    }

    /** Opens the group of a folder, for a chat in it that was opened from elsewhere. Nothing changes when it is open already. */
    expandFolder(folderId: FolderId): void {
        if (this.collapsedFolders.includes(folderId)) this.collapsedFolders = this.collapsedFolders.filter(id => id !== folderId);
    }

    /** Folds the rows of the running-agents strip under its line, or shows them again. */
    toggleAgentsFolded(): void {
        this.agentsFolded = !this.agentsFolded;
    }

    /** Opens the side panel at the right of the window, or shuts it. */
    toggleSidePanel(): void {
        this.sidePanelOpen = !this.sidePanelOpen;
    }

    /** Shows a tab of the side panel. */
    showSidePanelTab(tab: SidePanelTab): void {
        this.sidePanelTab = tab;
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
