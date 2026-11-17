import { makeAutoObservable, reaction } from 'mobx';

import { readStored, writeStored, type KeyValueStorage } from './storage';

import type { ChatId, ProjectId, RunId, TaskId } from '@clowdy/protocol';

export const SECTIONS = ['chats', 'tasks', 'agents', 'docs'] as const;

export type Section = typeof SECTIONS[number];

/** The pages of the global Settings window, in the order they appear in its sidebar. */
export const SETTINGS_PAGES = ['appearance', 'engine', 'skills'] as const;

export type SettingsPage = typeof SETTINGS_PAGES[number];
export type TasksView = 'board' | 'list';

interface StoredProjectUi {
    section: Section;
    chatId: ChatId | null;
    taskId: TaskId | null;
    runId: RunId | null;
    docPath: string | null;
    showFinished: boolean;
    tasksView: TasksView;
}

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a page URL may preselect in fixtures mode, for screenshots and demos: `?section=tasks&task=t-24&view=list`. */
export type InitialProjectUi = Partial<Pick<StoredProjectUi, 'section' | 'chatId' | 'taskId' | 'runId' | 'docPath' | 'showFinished' | 'tasksView'>>;

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

    if (view === 'board' || view === 'list') initial.tasksView = view;

    return initial;
}

/** What a project's window shows, remembered per project. The `open*` actions are how one section links to another. */
export class ProjectUi {
    section: Section = 'chats';
    chatId: ChatId | null = null;
    taskId: TaskId | null = null;
    runId: RunId | null = null;
    docPath: string | null = null;
    /** Agents: also list finished runs. */
    showFinished = false;
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
            this.showFinished = stored.showFinished === true;
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
                tasksView: this.tasksView,
            }),
            value => writeStored(storage, key, value)
        );
    }

    /** Shows the chat, in the Chats section; `null` leaves none selected. */
    openChat(chatId: ChatId | null): void {
        this.section = 'chats';
        this.chatId = chatId;
    }

    /** Shows the task in the Tasks section; `null` closes its detail panel. */
    openTask(taskId: TaskId | null): void {
        this.section = 'tasks';
        this.taskId = taskId;
    }

    openRun(runId: RunId | null): void {
        this.section = 'agents';
        this.runId = runId;
    }

    openDoc(path: string | null): void {
        this.section = 'docs';
        this.docPath = path;
    }

    setShowFinished(show: boolean): void {
        this.showFinished = show;
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
