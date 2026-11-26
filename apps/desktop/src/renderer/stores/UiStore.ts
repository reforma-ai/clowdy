import { makeAutoObservable, observable, observableRef, reaction } from 'mobx';

import { type KeyValueStorage, readStored, removeStored, writeStored } from './storage';
import { type RevealTasks, revealTask } from './taskReveal';

import type {
    ChatId,
    ChatWorkspace,
    ChatWorkspaceChoice,
    FolderId,
    ProjectId,
    Run,
    RunId,
    Task,
    TaskId,
} from '@clowdy/protocol';

/** The pages of the global Settings window, in the order they appear in its sidebar. */
export const SETTINGS_PAGES = [
    'appearance',
    'power',
    'chat',
    'files',
    'source-control',
    'shortcuts',
    'projects',
    'providers',
    'skills',
    'about',
] as const;

export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export type TasksView = 'board' | 'list';

/** The tabs of the side panel's header, in the order they appear there. */
export const SIDE_PANEL_TABS = ['files', 'changes', 'docs', 'terminal', 'tasks'] as const;

export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number];

/** The sizes of the side panel the corner button offers: not shown, beside the chat, and in the chat's place. */
export type SidePanelSize = 'hide' | 'half' | 'wide';

/** Why the panel cannot be beside the chat: the tab is always in the chat's place (Tasks), or the window is too narrow for the tab beside it (Files, Docs, Changes). */
export type NoHalfReason = 'tab' | 'window';

/** The tabs whose view is always the size of the chat's place, whatever the project chose for the others (`ProjectUi.sidePanelIsFull`). */
const FULL_TABS: readonly SidePanelTab[] = ['tasks'];

/** The tabs that are a list beside a view (Files and Docs: the tree and the editor; Changes: the sidebar and the diffs): they need more room beside the chat than the others, and where the window has none they are in the chat's place (`ProjectUi.sidePanelTabIsFull`). */
const TREE_TABS: readonly SidePanelTab[] = ['files', 'docs', 'changes'];

/** Where a project's window is: the chat or run open in it. History walks these; the view options of the Tasks tab, the side panel and what it shows are not places. */
export interface ProjectView {
    chatId: ChatId | null;
    runId: RunId | null;
    /** Agents: the new-chat row is selected, and no chat exists yet. */
    draft: boolean;
    /** Agents: the folder the new chat is for, `null` for the main folder. Meaningful only with `draft`. */
    draftFolderId: FolderId | null;
    /** Agents: where the new chat works in its folder, `null` for the folder's own checkout. Meaningful only with `draft`. */
    draftWorkspace: ChatWorkspaceChoice | null;
    /** Agents: the agent the new chat starts on when the page was opened for one (a hand-off to another agent), `null` for the one the project and the last pick say. Meaningful only with `draft`. */
    draftEngine: string | null;
}

interface StoredProjectUi {
    chatId: ChatId | null;
    taskId: TaskId | null;
    runId: RunId | null;
    expandedChats: ChatId[];
    chatOrder: ChatId[];
    groupByFolder: boolean;
    collapsedFolders: FolderId[];
    agentsFoldedByChat: Record<ChatId, boolean>;
    sidePanelOpen: boolean;
    sidePanelTab: SidePanelTab;
    sidePanelExpanded: boolean;
    tasksView: TasksView;
    tasksScope: TaskId | null;
    tasksSubtasks: boolean;
    taskPageView: TasksView;
    tasksCollapsed: TaskId[];
}

interface StoredChatCompletions {
    since: number;
    seen: Record<RunId, number>;
}

/** The most folded tasks a project keeps: the newest folds stay, so a project that folded tasks for months does not carry them all. */
export const COLLAPSED_TASKS_LIMIT = 200;

/** The most tasks a project holds an unsent comment for: past it, the draft written longest ago goes. */
export const COMMENT_DRAFTS_LIMIT = 20;

const uiKey = (projectId: ProjectId) => `clowdy:ui:${projectId}`;
const completionsKey = (projectId: ProjectId) => `${uiKey(projectId)}:chat-completions`;

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** What a page URL may preselect in fixtures mode, for screenshots and demos: `?panel=open&panelTab=tasks&task=t-24&view=list`. */
export type InitialProjectUi = Partial<
    Pick<
        StoredProjectUi,
        | 'chatId'
        | 'taskId'
        | 'runId'
        | 'expandedChats'
        | 'groupByFolder'
        | 'collapsedFolders'
        | 'sidePanelOpen'
        | 'sidePanelTab'
        | 'tasksView'
    > & { agentsFolded: boolean }
>;

export function initialUiFromSearch(search: string): InitialProjectUi {
    const params = new URLSearchParams(search);
    const view = params.get('view');
    const initial: InitialProjectUi = {};

    if (params.has('chat')) initial.chatId = params.get('chat');

    if (params.has('task')) initial.taskId = params.get('task');

    if (params.has('run')) initial.runId = params.get('run');

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

/** What a project's window shows, remembered per project. The `open*` actions are how one place links to another. */
export class ProjectUi {
    chatId: ChatId | null = null;
    taskId: TaskId | null = null;
    runId: RunId | null = null;
    /** Agents: the new-chat row is selected, and the chat it starts does not exist until its first message is sent. Not kept between sessions. */
    draft = false;
    /** Agents: the folder the new-chat page is for, `null` for the main folder. Not kept between sessions. */
    draftFolderId: FolderId | null = null;
    /**
     * Agents: where the new-chat page's chat works in that folder: `null` is Project checkout, the folder itself; `{ mode: 'new' }` a worktree the chat's first turn makes (from `base`,
     * the folder's default branch when it has none), `{ mode: 'existing' }` one of the folder's worktrees. It is a choice about one folder, so it goes back to Project checkout when the
     * folder changes. Not kept between sessions.
     */
    draftWorkspace: ChatWorkspaceChoice | null = null;
    /**
     * Agents: the daemon's row of the worktree `draftWorkspace` names, when it names an existing one (`workspace.open`): what makes the worktree the place of the new-chat page, so
     * its files, shells and `@` list are the worktree's before the chat exists, and the chat's first message finds the same row. Set by the page once the daemon has answered, and
     * gone whenever the choice, the folder or the page changes. Not kept between sessions.
     */
    draftWorkspaceRow: ChatWorkspace | null = null;
    /**
     * Agents: the agent the new-chat page's chat starts on, when the page was opened for one (a hand-off to another agent): the message box starts its picker there, on that
     * agent's default model, as long as the agent can be used and until the person picks something else. `null` leaves the choice to the project's settings and the last pick.
     * Not kept between sessions.
     */
    draftEngine: string | null = null;
    /** Agents: the chats whose threads the person opened in the list. A chat that is not here is folded, which is how every chat starts. */
    expandedChats: readonly ChatId[] = [];
    /** Agents: the most recent manual order of the project's root chats. New chats go above these. */
    chatOrder: readonly ChatId[] = [];
    /**
     * Agents: the list has a group for each folder of the project, each with a new-chat button that starts a chat in that folder. On until the person turns
     * it off (a project that kept no choice groups); off, the list is flat and a new chat starts in the main folder. Only a project with several folders
     * groups, whatever is kept here.
     */
    groupByFolder = true;
    /** Agents: the folders whose group is folded in the list. A folder that is not here is open, which is how every group starts. */
    collapsedFolders: readonly FolderId[] = [];
    /** The side panel at the right of the window is open for this project. Closed until the person opens it, and kept for the project, whichever chat is on show. */
    sidePanelOpen = false;
    /** The tab the side panel shows, kept for the project: the one it was left on. */
    sidePanelTab: SidePanelTab = 'files';
    /**
     * The side panel takes the place of the chat, and only the list of chats stays beside it. It is the project's choice, kept for it and apart from whether the panel is open:
     * a shut panel shows the chat in full and brings the panel back expanded. Choosing a chat while the panel covers it shuts the panel and leaves the choice (`showChat`).
     */
    sidePanelExpanded = false;
    tasksView: TasksView = 'board';
    /**
     * Tasks: the task whose insides the screen shows, `null` for the project's roots. It names a task the project may no longer hold, which is why the screen
     * reads it through `resolveTasksScope` and not as it is.
     */
    tasksScope: TaskId | null = null;
    /** Tasks: the board shows every task of the scope at any depth, flattened onto it, and not only the tasks directly inside it. */
    tasksSubtasks = false;
    /** Tasks: the view a task's own scope is drawn in, whatever the project's `tasksView` is. */
    taskPageView: TasksView = 'board';
    /** Tasks: the tasks whose insides are folded in the tree list, the newest folds last. A task that is not here is open, which is how every task starts. */
    tasksCollapsed: readonly TaskId[] = [];
    /**
     * Tasks: the screen shows the project's archive in place of the scope (the scope and the view stay as they were, and come back when it is left). Not kept between
     * sessions, and not a place in the history: it is an option of the screen, as the view is.
     */
    tasksArchive = false;
    /** Agents: files that a hand-off from another chat left for the new-chat page, which takes them once it is open. Not kept between sessions. */
    pendingFiles: readonly File[] = [];

    /** The tasks the project holds, for `openTask` to reveal a task in. Read when a task is opened, not kept. */
    readonly #tasks: (() => RevealTasks | undefined) | undefined;
    /** The window is wide enough for a panel with a tree beside the chat (`UiStore.windowFitsHalf`), read when the panel's size is asked for. */
    readonly #windowFitsHalf: () => boolean;
    /** Tasks: the comment each task's composer holds and has not sent, the one written last at the end. Not kept between sessions, and no place of the history. */
    readonly #commentDrafts = new Map<TaskId, string>();
    /** Chats: the running-agents strip starts folded and remembers only that chat's choice. */
    readonly #agentsFoldedByChat = observable.map<ChatId, boolean>();
    readonly #agentsFoldedByDefault: boolean;
    readonly #chatCompletionsSince: number;
    readonly #seenChatCompletions = observable.map<RunId, number>();

    constructor(
        readonly projectId: ProjectId,
        storage?: KeyValueStorage,
        initial: InitialProjectUi = {},
        tasks?: () => RevealTasks | undefined,
        windowFitsHalf: () => boolean = () => true
    ) {
        const key = uiKey(projectId);
        const completionKey = completionsKey(projectId);
        const completions = readStored(storage, completionKey) as Partial<StoredChatCompletions> | undefined;
        const since = completions?.since;
        const tracksCompletions = typeof since === 'number' && Number.isFinite(since);

        const { agentsFolded, ...initialView } = initial;
        this.#agentsFoldedByDefault = agentsFolded !== false;
        this.#tasks = tasks;
        this.#windowFitsHalf = windowFitsHalf;
        // On upgrade there is no read history. Start with the old completions already seen.
        this.#chatCompletionsSince = tracksCompletions ? since : Date.now();
        if (tracksCompletions && completions?.seen && typeof completions.seen === 'object') {
            this.#seenChatCompletions.merge(
                Object.entries(completions.seen).filter(([, finishedAt]) => Number.isFinite(finishedAt))
            );
        }
        const stored = readStored(storage, key) as Partial<Record<keyof StoredProjectUi, unknown>> | undefined;

        if (stored && typeof stored === 'object') {
            this.chatId = idOrNull(stored.chatId);
            this.taskId = idOrNull(stored.taskId);
            this.runId = idOrNull(stored.runId);
            this.expandedChats = Array.isArray(stored.expandedChats)
                ? stored.expandedChats.filter(id => typeof id === 'string')
                : [];
            this.chatOrder = Array.isArray(stored.chatOrder)
                ? [...new Set(stored.chatOrder.filter(id => typeof id === 'string'))]
                : [];
            this.groupByFolder = stored.groupByFolder !== false;
            this.collapsedFolders = Array.isArray(stored.collapsedFolders)
                ? stored.collapsedFolders.filter(id => typeof id === 'string')
                : [];
            // A project-wide choice from an older version cannot identify which chat was opened.
            if (
                agentsFolded === undefined &&
                stored.agentsFoldedByChat &&
                typeof stored.agentsFoldedByChat === 'object' &&
                !Array.isArray(stored.agentsFoldedByChat)
            ) {
                for (const [chatId, folded] of Object.entries(stored.agentsFoldedByChat)) {
                    if (typeof folded === 'boolean') this.#agentsFoldedByChat.set(chatId, folded);
                }
            }
            this.sidePanelOpen = stored.sidePanelOpen === true;
            this.sidePanelTab = SIDE_PANEL_TABS.find(tab => tab === stored.sidePanelTab) ?? this.sidePanelTab;
            this.sidePanelExpanded = stored.sidePanelExpanded === true;
            this.tasksView = stored.tasksView === 'list' ? 'list' : 'board';
            this.tasksScope = idOrNull(stored.tasksScope);
            this.tasksSubtasks = stored.tasksSubtasks === true;
            this.taskPageView = stored.taskPageView === 'list' ? 'list' : 'board';
            this.tasksCollapsed = Array.isArray(stored.tasksCollapsed)
                ? [...new Set(stored.tasksCollapsed.filter(id => typeof id === 'string'))].slice(-COLLAPSED_TASKS_LIMIT)
                : [];
        }

        Object.assign(this, initialView);
        makeAutoObservable(this, {
            projectId: false,
            pendingFiles: observableRef,
            draftWorkspace: observableRef,
            draftWorkspaceRow: observableRef,
            expandedChats: observableRef,
            chatOrder: observableRef,
            collapsedFolders: observableRef,
            tasksCollapsed: observableRef,
        });
        reaction(
            (): StoredProjectUi => ({
                chatId: this.chatId,
                taskId: this.taskId,
                runId: this.runId,
                expandedChats: [...this.expandedChats],
                chatOrder: [...this.chatOrder],
                groupByFolder: this.groupByFolder,
                collapsedFolders: [...this.collapsedFolders],
                agentsFoldedByChat: Object.fromEntries(this.#agentsFoldedByChat),
                sidePanelOpen: this.sidePanelOpen,
                sidePanelTab: this.sidePanelTab,
                sidePanelExpanded: this.sidePanelExpanded,
                tasksView: this.tasksView,
                tasksScope: this.tasksScope,
                tasksSubtasks: this.tasksSubtasks,
                taskPageView: this.taskPageView,
                tasksCollapsed: [...this.tasksCollapsed],
            }),
            value => writeStored(storage, key, value)
        );
        reaction(
            (): StoredChatCompletions => ({
                since: this.#chatCompletionsSince,
                seen: Object.fromEntries(this.#seenChatCompletions),
            }),
            value => writeStored(storage, completionKey, value),
            { fireImmediately: !tracksCompletions }
        );
    }

    hasUnreadCompletion(run: Run | undefined): boolean {
        return (
            run?.status === 'succeeded' &&
            run.finishedAt !== undefined &&
            run.finishedAt > (this.#seenChatCompletions.get(run.id) ?? this.#chatCompletionsSince)
        );
    }

    markCompletionSeen(run: Run): void {
        if (run.finishedAt !== undefined && this.hasUnreadCompletion(run)) {
            this.#seenChatCompletions.set(run.id, run.finishedAt);
        }
    }

    /** The place the window shows, as a value that can be kept and shown again with `show`. */
    get view(): ProjectView {
        return {
            chatId: this.chatId,
            runId: this.runId,
            draft: this.draft,
            draftFolderId: this.draftFolderId,
            draftWorkspace: this.draftWorkspace,
            draftEngine: this.draftEngine,
        };
    }

    /** Shows a place kept from `view`, as one change. */
    show({ chatId, runId, draft, draftFolderId, draftWorkspace, draftEngine }: ProjectView): void {
        if (chatId !== this.chatId || runId !== this.runId || draft !== this.draft) this.showChat();

        this.chatId = chatId;
        this.runId = runId;
        this.draft = draft;
        this.draftFolderId = draftFolderId;
        this.draftWorkspace = draftWorkspace;
        this.draftEngine = draftEngine;
        // The row was the answer for the choice that was on show; the page asks again for the one it is given.
        this.draftWorkspaceRow = null;
    }

    /** Shows the chat; `null` leaves none selected. */
    openChat(chatId: ChatId | null): void {
        this.showChat();
        this.chatId = chatId;
        this.runId = null;
        this.draft = false;
        this.draftFolderId = null;
        this.draftWorkspace = null;
        this.draftWorkspaceRow = null;
        this.draftEngine = null;
    }

    /**
     * Shows the new-chat row: a chat that is only made when its first message is sent. `attach` are files for
     * its message box (a hand-off brings the old conversation this way): the page picks them up with `takePendingFiles`. `folderId` is the folder
     * of the project the chat is made for, `null` for the main folder, and `workspace` where it works in that folder (a hand-off from a chat in a worktree keeps working in it),
     * `null` for the folder's own checkout. `engine` is the agent the chat starts on (a hand-off to another agent names one), `null` for the one the project and the last pick say.
     */
    openDraft(
        attach: readonly File[] = [],
        folderId: FolderId | null = null,
        workspace: ChatWorkspaceChoice | null = null,
        engine: string | null = null
    ): void {
        this.showChat();
        this.runId = null;
        this.draft = true;
        this.draftFolderId = folderId;
        this.draftWorkspace = workspace;
        this.draftWorkspaceRow = null;
        this.draftEngine = engine;

        if (attach.length > 0) this.pendingFiles = [...this.pendingFiles, ...attach];
    }

    /**
     * Changes the folder the new-chat page is for, `null` for the main folder. Only with that page open: the folder is no part of any other place. Another folder is another
     * repository, so what was chosen for the first (its base branch, its worktree) goes back to Project checkout.
     */
    setDraftFolder(folderId: FolderId | null): void {
        if (!this.draft) return;

        if (folderId !== this.draftFolderId) {
            this.draftWorkspace = null;
            this.draftWorkspaceRow = null;
        }

        this.draftFolderId = folderId;
    }

    /** Changes where the new chat works in its folder, `null` for the folder's own checkout. Only with the new-chat page open. */
    setDraftWorkspace(choice: ChatWorkspaceChoice | null): void {
        if (!this.draft) return;

        // The row answers for one worktree: it stays only while the choice is that same worktree again.
        const same =
            choice?.mode === 'existing' &&
            this.draftWorkspace?.mode === 'existing' &&
            choice.path === this.draftWorkspace.path;

        if (!same) this.draftWorkspaceRow = null;

        this.draftWorkspace = choice;
    }

    /** Keeps the daemon's row of the worktree the new-chat page chose (`draftWorkspaceRow`), or drops it with `null`. Only with the new-chat page open. */
    setDraftWorkspaceRow(row: ChatWorkspace | null): void {
        if (!this.draft) return;

        this.draftWorkspaceRow = row;
    }

    /** The files `openDraft` was given, handed over once: the next call finds none. */
    takePendingFiles(): readonly File[] {
        const files = this.pendingFiles;

        this.pendingFiles = [];

        return files;
    }

    /**
     * Shows the task in the Tasks tab of the side panel, which it opens; `null` closes the task's detail, and leaves the panel as it is. The task is made visible in one change with the opening:
     * the scope stays when the task is inside it and moves to the task's parent when it is not (`revealTask`), and the folds above the task open.
     * `reveal: false` is for the Tasks screen opening a task it draws already (a click on a card, a key on the cursor task): with a filter on, a card can be drawn away
     * from its parent, and opening it must not move the screen. `madeIn` is for a task that was just made inside a task (`null`: a root) and may not have reached the
     * project yet, since the daemon's event can come after the reply to the command: the screen is put where the task will show, and not left where it is.
     */
    openTask(
        taskId: TaskId | null,
        { reveal = true, madeIn }: { reveal?: boolean; madeIn?: TaskId | null } = {}
    ): void {
        this.taskId = taskId;

        if (taskId !== null) this.openSidePanelTab('tasks');

        if (taskId !== null && reveal) this.#reveal(taskId, madeIn);
    }

    /** Puts the screen where the task shows: its scope, and its folds. Nothing changes without the project's tasks, or for a task they do not hold. */
    #reveal(taskId: TaskId, madeIn: TaskId | null | undefined): void {
        const tasks = this.#tasks?.();

        if (!tasks) return;

        const scope = this.resolveTasksScope(tasks);
        const view = scope === null ? this.tasksView : this.taskPageView;
        const reveal = revealTask(tasks, scope, taskId, { oneLevel: view === 'board' && !this.tasksSubtasks, madeIn });

        if (!reveal) return;

        // A task of the board, opened from elsewhere, is not in the archive: the screen goes where it shows.
        this.tasksArchive = false;
        this.tasksScope = reveal.scope;
        this.expandTasks(reveal.unfold);
    }

    /** Shows the run, below its chat; a root run is its chat. */
    openRun(runId: RunId | null): void {
        this.showChat();
        this.runId = runId;
        this.draft = false;
        this.draftFolderId = null;
        this.draftWorkspace = null;
        this.draftWorkspaceRow = null;
        this.draftEngine = null;
    }

    /** Opens or folds the threads of a chat in the list. */
    toggleChatExpanded(chatId: ChatId): void {
        this.expandedChats = this.expandedChats.includes(chatId)
            ? this.expandedChats.filter(id => id !== chatId)
            : [...this.expandedChats, chatId];
    }

    /** Opens the threads of these chats, for a chat below them that was opened from elsewhere. Nothing changes when all are open already. */
    expandChats(chatIds: readonly ChatId[]): void {
        const closed = chatIds.filter(id => !this.expandedChats.includes(id));

        if (closed.length > 0) this.expandedChats = [...this.expandedChats, ...closed];
    }

    setGroupByFolder(group: boolean): void {
        this.groupByFolder = group;
    }

    setChatOrder(order: readonly ChatId[], visibleChatId?: ChatId): void {
        this.chatOrder = order;
        // The first listed chat can be on screen without a remembered selection.
        if (!this.draft && visibleChatId !== undefined) this.chatId = visibleChatId;
    }

    /** Folds the group of a folder in the list, or opens it again. */
    toggleFolderCollapsed(folderId: FolderId): void {
        this.collapsedFolders = this.collapsedFolders.includes(folderId)
            ? this.collapsedFolders.filter(id => id !== folderId)
            : [...this.collapsedFolders, folderId];
    }

    /** Opens the group of a folder, for a chat in it that was opened from elsewhere. Nothing changes when it is open already. */
    expandFolder(folderId: FolderId): void {
        if (this.collapsedFolders.includes(folderId))
            this.collapsedFolders = this.collapsedFolders.filter(id => id !== folderId);
    }

    /** Whether a chat's running-agents strip is folded. Other chats do not share its choice. */
    agentsFolded(chatId: ChatId): boolean {
        return this.#agentsFoldedByChat.get(chatId) ?? this.#agentsFoldedByDefault;
    }

    /** Folds the rows of this chat's running-agents strip under its line, or shows them again. */
    toggleAgentsFolded(chatId: ChatId): void {
        const folded = !this.agentsFolded(chatId);

        if (folded === this.#agentsFoldedByDefault) this.#agentsFoldedByChat.delete(chatId);
        else this.#agentsFoldedByChat.set(chatId, folded);
    }

    /** Opens the side panel at the right of the window, or shuts it. */
    toggleSidePanel(): void {
        this.sidePanelOpen = !this.sidePanelOpen;
    }

    /** Makes the open side panel take the place of the chat, or gives the place back. */
    toggleSidePanelExpanded(): void {
        this.sidePanelExpanded = !this.sidePanelExpanded;
    }

    /**
     * Sets the panel to one of the three sizes the corner button's menu offers: hidden, beside the chat (`half`), or in the chat's place (`wide`). Hiding keeps the choice of
     * the expanded size, so the panel comes back in it by the keys. The Tasks tab has no size of its own to choose: any size but hidden shows it, in the chat's place, and the
     * project's choice for the other tabs is left as it was.
     */
    setSidePanelSize(size: SidePanelSize): void {
        this.sidePanelOpen = size !== 'hide';

        if (size !== 'hide' && !this.sidePanelTabIsFull) this.sidePanelExpanded = size === 'wide';
    }

    /**
     * The tab the panel shows is the size of the chat's place, so it has no expanded size to choose: the Tasks tab always is, and a tab with a tree beside a view (Files, Docs, Changes) is
     * where the window is too narrow for it beside the chat (`UiStore.windowFitsHalf`). Nothing is kept for it: in a wider window the project's own choice is back.
     */
    get sidePanelTabIsFull(): boolean {
        return this.sidePanelNoHalf !== null;
    }

    /** Why the tab the panel shows cannot be beside the chat, or `null` when it can: it is the Tasks tab, or the window is too narrow for a tree beside the chat. */
    get sidePanelNoHalf(): NoHalfReason | null {
        if (FULL_TABS.includes(this.sidePanelTab)) return 'tab';

        return TREE_TABS.includes(this.sidePanelTab) && !this.#windowFitsHalf() ? 'window' : null;
    }

    /** The tab the panel shows is a list beside a view (Files, Docs, Changes), which needs more room than the other tabs do while it is beside the chat. */
    get sidePanelTabHasTree(): boolean {
        return TREE_TABS.includes(this.sidePanelTab);
    }

    /** The panel is, or comes back, in the place of the chat: the project has it expanded, or the tab is a full one. */
    get sidePanelIsFull(): boolean {
        return this.sidePanelExpanded || this.sidePanelTabIsFull;
    }

    /** The panel is drawn in the place of the chat: it is open, and full. */
    get sidePanelCoversChat(): boolean {
        return this.sidePanelOpen && this.sidePanelIsFull;
    }

    /**
     * The chat is wanted on screen: a panel that covers it is shut, and the choice of the expanded size stays as the person made it, so the panel comes back in it. A panel
     * beside the chat, or a shut one, is left as it is. Every way of choosing a chat does this; so does a press on the row of the chat that is open already, which the list
     * does not report as a selection.
     */
    showChat(): void {
        if (this.sidePanelCoversChat) this.sidePanelOpen = false;
    }

    /** Shuts the side panel; nothing when it is shut. */
    closeSidePanel(): void {
        this.sidePanelOpen = false;
    }

    /** Shows a tab of the side panel. */
    showSidePanelTab(tab: SidePanelTab): void {
        this.sidePanelTab = tab;
    }

    /** Opens the side panel on a tab, whether it is shut or shows another tab: what a click on the tab's item in the rail does, and the key of the tab. It never shuts the panel. */
    openSidePanelTab(tab: SidePanelTab): void {
        this.sidePanelOpen = true;
        this.sidePanelTab = tab;
    }

    /** Opens the side panel on a tab, or shuts the panel when it already shows that tab: one key to get a tool and to get rid of it (the terminal's). */
    toggleSidePanelTab(tab: SidePanelTab): void {
        if (this.sidePanelOpen && this.sidePanelTab === tab) {
            this.sidePanelOpen = false;
        } else {
            this.sidePanelOpen = true;
            this.sidePanelTab = tab;
        }
    }

    setTasksView(view: TasksView): void {
        this.tasksView = view;
    }

    /**
     * Shows the insides of a task on the Tasks screen, or the project's roots with `null`. Only the scope: the panel stays as it is, and so does the open task.
     * Not a place of the history: the side panel's state is not.
     */
    setTasksScope(scope: TaskId | null): void {
        this.tasksScope = scope;
    }

    /**
     * The scope the screen shows, given the tasks the project holds: the remembered one while that task is on the board, the roots when it is gone, deleted
     * or archived. Nothing is written, so the remembered scope comes back with a task that is restored, and no history entry is made by the screen finding it gone.
     */
    resolveTasksScope(tasks: ReadonlyMap<TaskId, Pick<Task, 'archivedAt'>>): TaskId | null {
        const task = this.tasksScope === null ? undefined : tasks.get(this.tasksScope);

        return task && task.archivedAt === undefined ? this.tasksScope : null;
    }

    /** Shows the project's archive in place of the scope, or the scope again. */
    setTasksArchive(show: boolean): void {
        this.tasksArchive = show;
    }

    /** Shows the sub-tasks of the scope flattened onto the board, or only the tasks directly inside it. */
    setTasksSubtasks(show: boolean): void {
        this.tasksSubtasks = show;
    }

    /** Sets the view a task's own scope is drawn in. */
    setTaskPageView(view: TasksView): void {
        this.taskPageView = view;
    }

    /** Folds the insides of a task in the tree list, or opens them again. */
    toggleTaskCollapsed(taskId: TaskId): void {
        this.tasksCollapsed = this.tasksCollapsed.includes(taskId)
            ? this.tasksCollapsed.filter(id => id !== taskId)
            : [...this.tasksCollapsed, taskId].slice(-COLLAPSED_TASKS_LIMIT);
    }

    /** The comment the person started on the task and has not sent, `''` when there is none. */
    commentDraft(taskId: TaskId): string {
        return this.#commentDrafts.get(taskId) ?? '';
    }

    /**
     * Keeps the unsent text of a task's composer, so it is in the composer again when the task's panel opens again. Text with nothing in it (a comment that was sent, or a
     * draft the person emptied) forgets the draft, and past `COMMENT_DRAFTS_LIMIT` the draft written longest ago goes.
     */
    setCommentDraft(taskId: TaskId, text: string): void {
        this.#commentDrafts.delete(taskId);

        if (text.trim() === '') return;

        this.#commentDrafts.set(taskId, text);

        for (const oldest of this.#commentDrafts.keys()) {
            if (this.#commentDrafts.size <= COMMENT_DRAFTS_LIMIT) break;

            this.#commentDrafts.delete(oldest);
        }
    }

    /** Opens the insides of these tasks, for a task below them that was opened from elsewhere. Nothing changes when all are open already. */
    expandTasks(taskIds: readonly TaskId[]): void {
        if (taskIds.some(id => this.tasksCollapsed.includes(id)))
            this.tasksCollapsed = this.tasksCollapsed.filter(id => !taskIds.includes(id));
    }

    /** Lets go of the folds of tasks the project no longer holds (deleted ones, archived ones), so what is kept stays as small as the folds that matter. */
    forgetCollapsedTasks(tasks: ReadonlyMap<TaskId, unknown>): void {
        if (this.tasksCollapsed.some(id => !tasks.has(id)))
            this.tasksCollapsed = this.tasksCollapsed.filter(id => tasks.has(id));
    }
}

/** Window state: one `ProjectUi` per project, and the global Settings window that opens over the window. */
export class UiStore {
    settingsOpen = false;
    settingsPage: SettingsPage = 'appearance';
    /** The project whose own page is open inside Settings > Projects; `null` shows the list of projects. */
    settingsProjectId: ProjectId | null = null;
    readonly #projects = new Map<ProjectId, ProjectUi>();
    /** The window is wide enough for the side panel with a tree (Files, Docs, Changes) beside the chat, which the shell reads from the window's width. Wide enough until it says it is not. */
    windowFitsHalf = true;

    /** `tasksOf` gives the tasks a project holds, which `ProjectUi.openTask` needs to reveal a task: the root store hands them over, a test of the window state alone has none. */
    constructor(
        private readonly storage?: KeyValueStorage,
        private readonly initial?: InitialProjectUi,
        private readonly tasksOf?: (projectId: ProjectId) => RevealTasks | undefined
    ) {
        makeAutoObservable<UiStore, 'storage' | 'initial' | 'tasksOf'>(this, {
            storage: false,
            initial: false,
            tasksOf: false,
        });
    }

    forProject(projectId: ProjectId): ProjectUi {
        let ui = this.#projects.get(projectId);

        if (!ui) {
            ui = new ProjectUi(
                projectId,
                this.storage,
                this.initial,
                () => this.tasksOf?.(projectId),
                () => this.windowFitsHalf
            );
            this.#projects.set(projectId, ui);
        }

        return ui;
    }

    /** Shows a place of the project, as back and forward do. Settings is a window over a place, not one: going to a place shuts it. */
    restore(ui: ProjectUi, view: ProjectView): void {
        ui.show(view);
        this.settingsOpen = false;
    }

    /** Tells whether the window is wide enough for the side panel with a tree beside the chat; the panels of Files, Docs and Changes are in the chat's place while it is not. */
    setWindowFitsHalf(fits: boolean): void {
        this.windowFitsHalf = fits;
    }

    /** Shuts the Settings window, which shows the page that is under it again. */
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

    /** Shows the page of a project over Settings > Projects, or the list again with `null`: the Settings window's stack of nested pages, which the window asks to change. */
    setSettingsProject(projectId: ProjectId | null): void {
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
        removeStored(this.storage, completionsKey(projectId));
    }
}
