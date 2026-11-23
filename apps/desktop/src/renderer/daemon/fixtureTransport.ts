import { MemoryFileSystem } from '@clowdy/file-manager/memory';
import { folderNames, isBusyRunStatus, isTerminalRunStatus, mainFolder, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_BYTES_PER_MESSAGE, STOPPED_TOOL, writesCommitMessages } from '@clowdy/protocol';

import {
    catalogTokens,
    createFixtureData,
    DEFAULT_STATUSES,
    docsSources,
    FIXTURE_LIVE_RUN_ID,
    FIXTURE_LIVE_TEXT_ID,
    FIXTURE_LIVE_TOOL_ID,
    FIXTURE_PULL_REQUEST_UNAVAILABLE,
    fixtureChatWorkspace,
    fixtureFolderGit,
    fixtureGitChanges,
    fixtureGitFile,
    fixtureGitPullRequest,
    fixtureGitStatus,
    fixtureHasCommit,
    fixtureProjectWorktrees,
    fixtureWorkspaceLog,
    type FixtureData,
} from './fixtureData';
import { fixtureFileContents } from './fixtureFiles';
import { applyFolderSettings } from './fixtureFolderSettings';
import { FixtureGitWrites, type FixtureGitWritesOptions } from './fixtureGitWrites';
import { fail, ok, type Outcome } from './fixtureOutcome';
import { FixtureTasks } from './fixtureTasks';
import { FixtureTerminals } from './fixtureTerminals';
import { TransportError, type CommandInput, type FeedStatus, type PageQuery, type PlaceRef, type ProjectFileSystem, type StreamTarget, type Transport } from './transport';

import type {
    AgentInfo,
    AgentModels,
    AgentOverrides,
    ApprovalDecision,
    Attachment,
    Chat,
    ChatId,
    ChatWorkspace,
    ChatWorkspaceRemoval,
    ClowdyEvent,
    CommandResult,
    DocsTree,
    EventData,
    FolderGit,
    FolderId,
    FolderWorktrees,
    GitChanges,
    GitCommitResult,
    GitFileSides,
    GitMessage,
    GitPullRequestInfo,
    GitScope,
    GitStatus,
    Project,
    ProjectFileMatch,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    ProjectWorkspaceInfo,
    QueuedMessage,
    QueuedMessageMode,
    RootSnapshot,
    Run,
    RunId,
    SkillCatalog,
    StreamItem,
    StreamItemBody,
    Task,
    TaskArchivePage,
    TaskCommentsPage,
    TaskDetail,
    TaskId,
    TerminalCreate,
    TerminalId,
    TerminalInfo,
    ThreadNotice,
    WorkspaceId,
} from '@clowdy/protocol';
import type { TerminalStream, TerminalStreamHandlers } from './terminalStream';

export interface FixtureTransportOptions {
    /** Starts from other data. Tests use this. */
    data?: FixtureData;
    /** Events nobody asked for (a tool finishing, text streaming in) after the first subscription. */
    timeline?: boolean;
    /** How a commit and a request for a commit message end (`fixtureGitWrites.ts`): they go through unless a script says otherwise. */
    gitWrites?: FixtureGitWritesOptions;
}

/** What the fixture keeps of a file: its bytes, and whether a message carries it already. */
interface StoredFile {
    projectId: ProjectId;
    attachment: Attachment;
    blob: Blob;
    sent: boolean;
}

/** Where the fixture's programs are found when a path override is cleared. */
const FIXTURE_PROGRAMS: Record<string, string> = {
    claude: '/Users/dev/.local/bin/claude',
    codex: '/opt/homebrew/bin/codex',
    cursor: '/Users/dev/.local/bin/cursor-agent',
};

/** The sign-in link each fixture agent prints, and when the scripted sign-in prints it and ends. */
const FIXTURE_SIGN_IN_LINKS: Record<string, string> = {
    claude: 'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code',
    codex: 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73',
    cursor: 'https://cursor.com/loginDeepControl?challenge=3f9c1e&mode=login',
};
const SIGN_IN_LINK_MS = 400;
const SIGN_IN_DONE_MS = 4000;
/** How long a turn the fixture starts lasts, and how long its agent takes to take a steer. */
const TURN_MS = 1400;
const STEER_MS = 800;
/** How long the fixture's agent takes to compact its context, and what the queue shows for a Compact pressed while it works. */
const COMPACT_MS = 1200;
const COMPACT_TEXT = 'Compact the conversation';

const isCompact = (item: QueuedMessage) => item.command === 'compact';

/** The agents whose chats offer Fork and Edit, as the daemon's catalog flags them (`AgentSpec.fork`): Claude Code only. */
const FORKABLE_ENGINES: ReadonlySet<string> = new Set(['claude']);
const REPLY = 'Got it. I will split this into tasks, start the independent ones in parallel, and report back here.';
/** What the fixture's agent says when it is told that threads stopped. */
const NOTICE_REPLY = 'Noted. I will look at what the thread found and carry on.';
/** How much of a thread's last words its parent is told. */
const NOTICE_TEXT_MAX = 600;

/** The words of a notice's outcome, as the queue's summary says them. */
const OUTCOME_SUMMARY: Record<ThreadNotice['outcome'], string> = { finished: 'finished', failed: 'failed', interrupted: 'was interrupted' };

/** The one line a queued notice shows: `Thread "Fix login" finished`, or how many threads stopped. */
function noticeSummary(threads: readonly ThreadNotice[]): string {
    if (threads.length === 1) return `Thread "${ threads[0].title }" ${ OUTCOME_SUMMARY[threads[0].outcome] }`;

    return `${ threads.length } threads stopped`;
}

/** The stream item a queued message becomes when the agent gets it: a notice has no words of its own, a thread's message keeps its sender. */
function userBody(item: QueuedMessage): StreamItemBody {
    const text = item.from?.kind === 'threadNotice' ? '' : item.text;

    return { kind: 'user', text, ...(item.attachments && { attachments: item.attachments }), ...(item.from && { from: item.from }) };
}

/** Puts a message at the end of its own kind (or at `index` in it), the steers before the next turns, as the daemon does. */
function placeQueued(queue: readonly QueuedMessage[], item: QueuedMessage, index?: number): QueuedMessage[] {
    const others = queue.filter(entry => entry.id !== item.id);
    const steers = others.filter(entry => entry.mode === 'steer');
    const turns = others.filter(entry => entry.mode !== 'steer');
    const part = item.mode === 'steer' ? steers : turns;

    part.splice(Math.min(index ?? part.length, part.length), 0, item);

    return [...steers, ...turns];
}

/** The overrides of an agent without the parts that are not set, or none at all when nothing is left. */
function withoutEmpty(overrides: AgentOverrides): AgentOverrides | undefined {
    const { path, env } = overrides;

    return path === undefined && env === undefined ? undefined : { ...(path !== undefined && { path }), ...(env !== undefined && { env }) };
}

/** The title of a fork: `foo` becomes `(1) foo` and `(1) foo` becomes `(2) foo`, as the daemon numbers it; a chat with no title of its own keeps none. */
function forkTitle(title: string): string {
    const text = title.trim();

    if (!text || text === 'New chat') return 'New chat';

    const numbered = /^\((\d{1,6})\) (\S.*)$/s.exec(text);

    return numbered ? `(${ Number(numbered[1]) + 1 }) ${ numbered[2] }` : `(1) ${ text }`;
}

/** What a field becomes when a command may name it: the value it names, nothing for `null`, and `kept` when the command leaves it out. */
const named = <T>(change: T | null | undefined, kept: T | undefined): T | undefined => (change === undefined ? kept : change ?? undefined);

/**
 * A daemon in memory: scripted data in the shape of the protocol, and commands that change it and announce the
 * change as events, so the UI is interactive without a daemon. Not a model of the real daemon's rules, except for the
 * tasks, their tree, their archive and their comments, which follow the daemon's (`fixtureTasks.ts`).
 */
export class FixtureTransport implements Transport {
    readonly #data: FixtureData;
    readonly #timeline: boolean;
    readonly #log: ClowdyEvent[] = [];
    readonly #subscribers = new Set<(event: ClowdyEvent) => void>();
    #cursor = 1000;
    #idCounter = 100;
    #timelineStarted = false;
    readonly #files = new Map<string, StoredFile>();
    /** The file system of each folder, made when the file manager first asks and kept, so what the person edits stays for the session. */
    readonly #fileSystems = new Map<string, MemoryFileSystem>();
    /** The turn each run is on, so the end of an older turn does not end a newer one. */
    readonly #turns = new Map<RunId, number>();
    /** The ref each worktree that is not made yet starts from, by the workspace's id: what the step that makes it logs. */
    readonly #bases = new Map<string, string>();
    /** The worktrees `workspace.open` answered that no chat works in (yet), by the workspace's id: the places read them as they read a chat's. */
    readonly #opened = new Map<string, { projectId: ProjectId; workspace: ChatWorkspace }>();
    /** How many times an edit rewrote each run's stream: an item written after one gets an id of its own, as the daemon's items do, though it takes the freed number. */
    readonly #rewrites = new Map<RunId, number>();
    /** The daemon's rules for tasks, their archive and their comments. */
    readonly #tasks: FixtureTasks;
    /** The shells, which run nothing: see `fixtureTerminals.ts`. */
    readonly #terminals = new FixtureTerminals();
    /** What the commits made here took out of each place's uncommitted files. */
    readonly #gitWrites: FixtureGitWrites;

    constructor({ data = createFixtureData(), timeline = false, gitWrites }: FixtureTransportOptions = {}) {
        this.#data = data;
        this.#timeline = timeline;
        this.#gitWrites = new FixtureGitWrites(gitWrites);
        this.#tasks = new FixtureTasks(data, { emit: (projectId, event) => this.#emit(projectId, event), id: prefix => this.#id(prefix) });

        for (const { projectId, attachment, content } of data.attachments) {
            this.#files.set(attachment.id, { projectId, attachment, blob: new Blob([content], { type: attachment.mediaType }), sent: true });
        }
    }

    async getRootSnapshot(): Promise<RootSnapshot> {
        return structuredClone({ cursor: this.#cursor, projects: this.#listed(), home: '/Users/dev' });
    }

    async getProjectsInfo(projectId?: ProjectId): Promise<ProjectInfo[]> {
        const { chats, tasks, git } = this.#data;

        return structuredClone(this.#listed().filter(project => projectId === undefined || project.id === projectId).map((project) => {
            // The worktrees the project's chats work in, and those `workspace.open` answered that no chat works in (yet), as the daemon reads them: whether each is made, and the branch it
            // has (the fixture's worktrees keep the branch they were made with).
            const workspaces = new Map<string, ProjectWorkspaceInfo>();
            const rows = [...chats.filter(chat => chat.projectId === project.id).flatMap(chat => (chat.workspace ? [chat.workspace] : [])), ...[...this.#opened.values()].filter(entry => entry.projectId === project.id).map(entry => entry.workspace)];

            for (const workspace of rows) {
                workspaces.set(workspace.id, { workspaceId: workspace.id, exists: workspace.ready, ...(workspace.ready && workspace.branch !== undefined && { branch: workspace.branch }) });
            }

            return {
                projectId: project.id,
                folders: project.folders.map(folder => ({ folderId: folder.id, exists: true, ...git[folder.path], chats: chats.filter(chat => chat.projectId === project.id && chat.folderId === folder.id).length })),
                chats: chats.filter(chat => chat.projectId === project.id).length,
                tasks: tasks.filter(task => task.projectId === project.id).length,
                activeRuns: this.#activeRuns(project.id),
                ...(workspaces.size > 0 && { workspaces: [...workspaces.values()] }),
            };
        }));
    }

    async getFolderGit(projectId: ProjectId, folderId: FolderId): Promise<FolderGit> {
        const folder = this.#project(projectId).folders.find(candidate => candidate.id === folderId);

        if (!folder) throw new TransportError(`No such folder: ${ folderId }`, 404);

        return structuredClone(fixtureFolderGit(folder.path, this.#data.git[folder.path], folder.settings?.baseBranch, this.#data.removed?.[folder.path]));
    }

    async getProjectWorktrees(projectId: ProjectId): Promise<FolderWorktrees[]> {
        return structuredClone(fixtureProjectWorktrees(this.#project(projectId), this.#data));
    }

    async getGitStatus(projectId: ProjectId, place: PlaceRef): Promise<GitStatus> {
        const { head, workspace } = this.#gitPlace(projectId, place);

        return structuredClone(fixtureGitStatus(head, workspace, this.#gitWrites.committedOf(place.workspaceId ?? '')));
    }

    async getGitChanges(projectId: ProjectId, place: PlaceRef, scope: GitScope): Promise<GitChanges> {
        const { head, workspace } = this.#gitPlace(projectId, place);
        const changes = fixtureGitChanges(head, workspace !== undefined, scope, this.#gitWrites.committedOf(place.workspaceId ?? ''));

        if (!changes) throw new TransportError(`Commit ${ scope.slice('commit:'.length) } does not exist`, 404);

        return structuredClone(changes);
    }

    async getGitFile(projectId: ProjectId, place: PlaceRef, scope: GitScope, path: string, _oldPath?: string, from?: string): Promise<GitFileSides> {
        const { head, workspace } = this.#gitPlace(projectId, place);

        if (!head?.branch) throw new TransportError('The folder is not the root of a git repository', 400);

        // The fixture draws no diff of its own, so a start is only judged as the daemon judges it: a hash, of a commit the repository has.
        if (from !== undefined && !/^[0-9a-f]{7,64}$/i.test(from)) throw new TransportError('The start of the comparison is not a hash', 400);

        if (from !== undefined && !fixtureHasCommit(from)) throw new TransportError(`Commit ${ from } does not exist`, 404);

        const sides = workspace && fixtureGitFile(scope, path);

        if (!sides) throw new TransportError(`Changed file ${ path } does not exist`, 404);

        return structuredClone(sides);
    }

    async commitGit(projectId: ProjectId, place: PlaceRef, paths: string[], message: string): Promise<GitCommitResult> {
        return structuredClone(await this.#gitWrites.commit(place.workspaceId ?? '', this.#uncommitted(projectId, place), paths, message));
    }

    async generateGitMessage(projectId: ProjectId, place: PlaceRef, paths: string[]): Promise<GitMessage> {
        // The daemon asks the agents' settings; so does the fixture, of the agents it lists.
        if (!this.#data.agents.some(writesCommitMessages)) throw new TransportError('Couldn\'t write the message', 400);

        return structuredClone(await this.#gitWrites.message(place.workspaceId ?? '', this.#uncommitted(projectId, place), paths));
    }

    /** The paths the place's uncommitted changes list now (the fixture's checkout is clean; the worktree has files, less what was committed). */
    #uncommitted(projectId: ProjectId, place: PlaceRef): string[] {
        const { head, workspace } = this.#gitPlace(projectId, place);
        const changes = fixtureGitChanges(head, workspace !== undefined, 'uncommitted', this.#gitWrites.committedOf(place.workspaceId ?? ''));

        return changes?.isRepository ? changes.files.map(file => file.path) : [];
    }

    async getGitPullRequest(projectId: ProjectId, place: PlaceRef): Promise<GitPullRequestInfo> {
        const { folder, head, workspace } = this.#gitPlace(projectId, place);
        const answer = fixtureGitPullRequest(head, this.#data.pullRequests[folder.path], workspace);

        if (!answer) throw new TransportError(FIXTURE_PULL_REQUEST_UNAVAILABLE, 503);

        return structuredClone(answer);
    }

    /** The folder a git read names and what the fixture's git says of it, and the worktree when the read names one (judged as the daemon judges a place). */
    #gitPlace(projectId: ProjectId, { folderId, workspaceId }: PlaceRef) {
        const project = this.#project(projectId);
        const folder = project.folders.find(candidate => candidate.id === folderId);

        if (!folder) throw new TransportError(`Folder ${ folderId } does not exist`, 404);

        return { folder, head: this.#data.git[folder.path], workspace: workspaceId === undefined ? undefined : this.#workspaceOf(project, workspaceId, folderId) };
    }

    async getChatWorkspaceRemoval(chatId: ChatId): Promise<ChatWorkspaceRemoval> {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);

        if (!chat) throw new TransportError(`No such chat: ${ chatId }`, 404);

        return this.#removal(chat);
    }

    /**
     * What the daemon says of a chat's worktree: removable when Clowdy made it and it is on the disk (`ready`), and no chat outside this one and the threads below it (archived ones
     * count) works in it. The fixtures keep no files, so what the daemon reads from the tree (changes, merged work) is taken as fine.
     */
    #removal(chat: Chat): ChatWorkspaceRemoval {
        const { workspace } = chat;

        if (!workspace) return { removable: false };

        const below = new Set([chat.id, ...this.#threadsBelow(chat).map(thread => thread.id)]);
        const shared = this.#data.chats.some(other => other.workspace?.id === workspace.id && !below.has(other.id));

        return { removable: workspace.managed && workspace.ready && !shared, path: workspace.path, ...(workspace.branch !== undefined && { branch: workspace.branch }) };
    }

    /**
     * `workspace.remove` as the daemon answers it, from what `getProjectWorktrees` describes: a worktree the folder's repository lists goes, and the reads then answer as if git no
     * longer had it (`FixtureData.removed`). Refused, in the daemon's words, for the folder's own checkout, a locked worktree, one a chat works in and a changed tree without
     * `discard`; the branch goes only with `deleteBranch` and otherwise stays as a local branch. A row `workspace.open` answered for it goes with it. The fixtures keep no files, so
     * a changed tree is what `changes` and `submodules` say.
     */
    #removeWorktree(command: Extract<CommandInput, { type: 'workspace.remove' }>): Outcome {
        const data = this.#data;
        const project = data.projects.find(candidate => candidate.id === command.projectId);

        if (!project) return fail('not_found', `Project ${ command.projectId } does not exist`);

        const folder = project.folders.find(candidate => candidate.id === command.folderId);

        if (!folder) return fail('invalid', `Folder ${ command.folderId } does not belong to project ${ command.projectId }`);

        if (!command.path.startsWith('/')) return fail('invalid', 'The path of a worktree must be absolute');

        const group = fixtureProjectWorktrees(project, data).find(candidate => candidate.folderId === folder.id);

        if (!group?.isRepository) return fail('invalid', 'A worktree needs the root of a git repository, and this folder is not one');

        const worktree = group.worktrees.find(candidate => candidate.path === command.path);

        if (!worktree) return fail('conflict', 'Git does not list it as a worktree of the folder');

        if (worktree.chats.length > 0) return fail('conflict', `The chat "${ worktree.chats[0].title }" works in this worktree`);

        if (worktree.main) return fail('conflict', 'That is the folder\'s own checkout');

        if (worktree.locked !== undefined) return fail('conflict', 'The worktree is locked');

        if (!worktree.missing && command.discard !== true && (worktree.changes > 0 || worktree.submodules)) {
            return fail('conflict', worktree.changes > 0 ? 'The worktree has changes that are not committed' : 'The worktree has submodules checked out');
        }

        const removals = data.removed?.[folder.path] ?? { worktrees: [], deleted: [], kept: [] };
        const deleted = command.deleteBranch === true && worktree.branch !== undefined;

        removals.worktrees.push(worktree.path);

        if (worktree.branch !== undefined) (deleted ? removals.deleted : removals.kept).push(worktree.branch);

        data.removed = { ...data.removed, [folder.path]: removals };

        for (const [id, opened] of this.#opened) {
            if (opened.workspace.path === worktree.path) this.#opened.delete(id);
        }

        return ok({ path: worktree.path, branchDeleted: deleted });
    }

    async getProjectSnapshot(projectId: ProjectId): Promise<ProjectSnapshot> {
        const project = this.#project(projectId);
        const data = this.#data;
        const chatIds = new Set(data.chats.filter(chat => chat.projectId === projectId).map(chat => chat.id));
        const runIds = new Set(data.runs.filter(run => run.projectId === projectId).map(run => run.id));

        return structuredClone({
            cursor: this.#cursor,
            project,
            statuses: data.statuses[projectId] ?? DEFAULT_STATUSES,
            chats: data.chats.filter(chat => chat.projectId === projectId),
            // Like the daemon, which leaves the archive out: `getArchivedTasks` pages it.
            tasks: data.tasks.filter(task => task.projectId === projectId && task.archivedAt === undefined),
            runs: data.runs.filter(run => run.projectId === projectId),
            chatTaskLinks: data.chatTaskLinks.filter(link => chatIds.has(link.chatId)),
            runTaskLinks: data.runTaskLinks.filter(link => runIds.has(link.runId)),
        });
    }

    subscribe(cursor: number, onEvent: (event: ClowdyEvent) => void, onStatus: (status: FeedStatus) => void): () => void {
        let active = true;
        // Events arrive on their own turn, as they would over the network.
        const deliver = (event: ClowdyEvent) => queueMicrotask(() => active && onEvent(event));

        this.#subscribers.add(deliver);
        this.#log.filter(event => event.cursor > cursor).forEach(deliver);
        queueMicrotask(() => active && onStatus('connected'));

        if (this.#timeline && !this.#timelineStarted) {
            this.#timelineStarted = true;
            this.#runTimeline();
        }

        return () => {
            active = false;
            this.#subscribers.delete(deliver);
        };
    }

    async command(command: CommandInput): Promise<CommandResult> {
        const requestId = crypto.randomUUID();
        const outcome = this.#apply(command);

        return outcome.ok ? { ok: true, requestId, data: outcome.data } : { ok: false, requestId, error: outcome.error };
    }

    async getItems(target: StreamTarget, afterSeq = 0): Promise<StreamItem[]> {
        const runId = 'runId' in target ? target.runId : this.#data.chats.find(chat => chat.id === target.chatId)?.orchestratorRunId;

        return structuredClone((runId ? this.#data.items[runId] ?? [] : []).filter(item => item.seq > afterSeq));
    }

    async getTaskDetail(taskId: TaskId): Promise<TaskDetail> {
        const data = this.#data;
        const task = data.tasks.find(candidate => candidate.id === taskId);

        // Like the daemon, which answers 404 for a task it does not have.
        if (!task) throw new TransportError(`No such task: ${ taskId }`, 404);

        return structuredClone({
            taskId,
            task,
            chatIds: data.chatTaskLinks.filter(link => link.taskId === taskId).map(link => link.chatId),
            runIds: data.runTaskLinks.filter(link => link.taskId === taskId).map(link => link.runId),
            artifacts: data.artifacts.filter(artifact => artifact.taskId === taskId),
        });
    }

    async getTaskDetailByKey(projectId: ProjectId, key: string): Promise<TaskDetail> {
        const project = this.#project(projectId);
        const match = /^(.+)-(\d+)$/.exec(key);
        // As the daemon reads a key: the project's own prefix in any case and a number it has, the archived tasks included; anything else is a 404.
        const task = match && match[1].toUpperCase() === project.taskPrefix.toUpperCase()
            ? this.#data.tasks.find(candidate => candidate.projectId === projectId && candidate.number === Number(match[2]))
            : undefined;

        if (!task) throw new TransportError(`No such task: ${ key }`, 404);

        return this.getTaskDetail(task.id);
    }

    async getTaskComments(taskId: TaskId, page?: PageQuery): Promise<TaskCommentsPage> {
        return this.#tasks.commentsPage(taskId, page);
    }

    async getArchivedTasks(projectId: ProjectId, page?: PageQuery): Promise<TaskArchivePage> {
        return this.#tasks.archivedPage(projectId, page);
    }

    async getDocsTree(projectId: ProjectId, workspaceId?: WorkspaceId): Promise<DocsTree> {
        const project = this.#project(projectId);
        const workspace = workspaceId === undefined ? undefined : this.#workspaceOf(project, workspaceId);

        // Every fixture folder exists; one with no source has none, and reading does not make one. The worktree's folder lists the worktree's documents.
        return project.folders.map((folder) => {
            const root = this.#rootOf(folder, workspace);

            return { folderId: folder.id, sources: docsSources({ briefback: this.#data.briefback[root] ?? this.#data.briefback[folder.path], documents: this.#data.docs[root] ?? this.#data.docs[folder.path] }) };
        });
    }

    async getProjectFiles(projectId: ProjectId, query: string, limit = 40, workspaceId?: WorkspaceId): Promise<ProjectFileMatch[]> {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const project = this.#data.projects.find(candidate => candidate.id === projectId);

        if (!project) return [];

        const workspace = workspaceId === undefined ? undefined : this.#workspaceOf(project, workspaceId);

        // Like the daemon: every folder's files (the worktree's in place of its folder's), the folder's name counting as part of the path when there are several.
        const names = folderNames(project.folders);
        const several = project.folders.length > 1;
        const found = project.folders.flatMap((folder, index) => {
            const root = this.#rootOf(folder, workspace);

            return (this.#data.files[root] ?? this.#data.files[folder.path] ?? []).map(path => ({ folderId: folder.id, path, searched: several ? `${ names[index] }/${ path }` : path }));
        });

        return found.filter(file => words.every(word => file.searched.toLowerCase().includes(word))).slice(0, limit).map(({ folderId, path }) => ({ folderId, path }));
    }

    fileSystem(projectId: ProjectId, folderId: FolderId, workspaceId?: WorkspaceId): ProjectFileSystem {
        const project = this.#project(projectId);
        const folder = project.folders.find(candidate => candidate.id === folderId);

        if (!folder) throw new TransportError(`Folder ${ folderId } does not exist`, 404);

        const workspace = workspaceId === undefined ? undefined : this.#workspaceOf(project, workspaceId, folderId);
        const key = workspaceId ?? folderId;
        let fileSystem = this.#fileSystems.get(key);

        if (!fileSystem) {
            // The folder's documents are files like the others, below the roots of their sources: `.clowdy/docs`, `.briefback`.
            const below = (root: string, files: Record<string, string> | undefined) => Object.entries(files ?? {}).map(([path, text]) => [`${ root }/${ path }`, text] as const);
            const root = this.#rootOf(folder, workspace);
            const documents = Object.fromEntries([...below('.clowdy/docs', this.#data.docs[root] ?? this.#data.docs[folder.path]), ...below('.briefback', this.#data.briefback[root] ?? this.#data.briefback[folder.path])]);

            fileSystem = new MemoryFileSystem({ ...fixtureFileContents(this.#data.files[root] ?? this.#data.files[folder.path] ?? []), ...documents });
            this.#fileSystems.set(key, fileSystem);
        }

        return fileSystem;
    }

    async uploadAttachment(projectId: ProjectId, file: File): Promise<Attachment> {
        this.#project(projectId);

        if (file.size > MAX_ATTACHMENT_BYTES) throw new TransportError(`${ file.name } is over the size limit`, 413);

        const attachment: Attachment = { id: this.#id('a'), name: file.name, mediaType: file.type || 'application/octet-stream', size: file.size };

        this.#files.set(attachment.id, { projectId, attachment, blob: file, sent: false });

        return structuredClone(attachment);
    }

    async getAttachment(projectId: ProjectId, attachmentId: string): Promise<Blob> {
        const stored = this.#files.get(attachmentId);

        if (stored?.projectId !== projectId) throw new TransportError('No such attachment', 404);

        return stored.blob;
    }

    async getProjectIcon(projectId: ProjectId): Promise<Blob | undefined> {
        const project = this.#data.projects.find(candidate => candidate.id === projectId);
        // Like the daemon: the main folder's icon, and none for the personal space.
        const svg = project && !project.personal ? this.#data.icons[mainFolder(project).path] : undefined;

        return svg === undefined ? undefined : new Blob([svg], { type: 'image/svg+xml' });
    }

    async deleteAttachment(projectId: ProjectId, attachmentId: string): Promise<void> {
        const stored = this.#files.get(attachmentId);

        if (stored?.projectId !== projectId) throw new TransportError('No such attachment', 404);

        if (stored.sent) throw new TransportError('The file was sent already', 409);

        this.#files.delete(attachmentId);
    }

    async getSkills(projectId?: ProjectId): Promise<SkillCatalog> {
        if (projectId !== undefined) this.#project(projectId);

        const entries = this.#data.skills.filter(skill => skill.projectId === undefined || skill.projectId === projectId).map(({ projectId: _projectId, ...entry }) => entry);

        return structuredClone({ entries, tokens: catalogTokens(entries), warnings: this.#data.skillWarnings });
    }

    async getAgents(): Promise<AgentInfo[]> {
        return structuredClone(this.#data.agents);
    }

    async getAgentModels(agentId: string): Promise<AgentModels> {
        return structuredClone(this.#data.agentModels[agentId] ?? { state: 'unavailable', models: [], detail: `Clowdy cannot list the models of ${ agentId }` });
    }

    async listTerminals(projectId?: ProjectId): Promise<TerminalInfo[]> {
        return this.#terminals.list(projectId);
    }

    async createTerminal(request: TerminalCreate): Promise<TerminalInfo> {
        try {
            const project = this.#project(request.projectId);

            return this.#terminals.create(project, request, request.workspaceId === undefined ? undefined : this.#workspaceOf(project, request.workspaceId, request.folderId));
        }
        catch (error) {
            throw error instanceof TransportError ? error : new TransportError((error as Error).message, 404);
        }
    }

    async closeTerminal(terminalId: TerminalId): Promise<void> {
        this.#terminals.close(terminalId);
    }

    openTerminal(terminalId: TerminalId, handlers: TerminalStreamHandlers): TerminalStream {
        return this.#terminals.open(terminalId, handlers);
    }

    /* --------------------------------- Events --------------------------------- */

    #emit(projectId: ProjectId, data: EventData): void {
        const event: ClowdyEvent = structuredClone({ cursor: ++this.#cursor, at: Date.now(), projectId, data });

        this.#log.push(event);
        this.#subscribers.forEach(deliver => deliver(event));
    }

    /** Tells every project's clients to refetch the agents, as the daemon does. */
    #agentsChanged(): void {
        this.#data.projects.forEach(project => this.#emit(project.id, { type: 'agents.changed' }));
    }

    #later(ms: number, action: () => void): void {
        setTimeout(action, ms);
    }

    #id(prefix: string): string {
        return `${ prefix }-${ ++this.#idCounter }`;
    }

    #project(projectId: ProjectId): Project {
        const project = this.#data.projects.find(candidate => candidate.id === projectId);

        if (!project) throw new TransportError(`No such project: ${ projectId }`, 404);

        return project;
    }

    /**
     * The worktree a request names, as the daemon judges it: one the project's chats work in or `workspace.open` answered, a checkout of a folder of the project (and of
     * `folderId` when the request names one), and made. `not_found` for the first two, `unavailable` while the chat's first turn has not made it yet.
     */
    #workspaceOf(project: Project, workspaceId: WorkspaceId, folderId?: FolderId): ChatWorkspace {
        const opened = this.#opened.get(workspaceId);
        const workspace = this.#data.chats.find(chat => chat.projectId === project.id && chat.workspace?.id === workspaceId)?.workspace ?? (opened?.projectId === project.id ? opened.workspace : undefined);

        if (!workspace || !project.folders.some(folder => folder.id === workspace.folderId) || (folderId !== undefined && workspace.folderId !== folderId)) throw new TransportError(`No such workspace: ${ workspaceId }`, 404);

        if (!workspace.ready) throw new TransportError('The worktree is not made yet', 503);

        return workspace;
    }

    /** Where a folder's files are read: the worktree's path when the request is for a worktree of that folder, else the folder's own. */
    #rootOf(folder: { id: FolderId; path: string }, workspace: ChatWorkspace | undefined): string {
        return workspace?.folderId === folder.id ? workspace.path : folder.path;
    }

    /** The daemon refuses an agent it does not know when a chat is made or changed; one that is switched off waits for the first message. */
    #refuseEngine(engine: string | undefined): Outcome | undefined {
        return engine && !this.#data.agents.some(agent => agent.id === engine) ? fail('unavailable', `The ${ engine } engine is not available in this daemon`) : undefined;
    }

    #saveRun(run: Run): void {
        this.#emit(run.projectId, { type: 'run.upserted', run });
    }

    #saveTask(task: Task): void {
        this.#emit(task.projectId, { type: 'task.upserted', task });
    }

    /** Adds or replaces a stream item (by id) and announces it. */
    #saveItem(run: Run, item: StreamItem): void {
        const items = this.#data.items[run.id] ??= [];
        const index = items.findIndex(candidate => candidate.id === item.id);

        if (index === -1) items.push(item);
        else items[index] = item;

        this.#emit(run.projectId, { type: 'stream.item', item });
    }

    /**
     * Appends an item, as the daemon does: a message of the person's own that starts a turn (the first item, or the one after a final answer that holds a
     * point) offers Edit, for an agent that can fork (`canEdit`).
     */
    #appendItem(run: Run, body: StreamItemBody): StreamItem {
        const items = this.#data.items[run.id] ??= [];
        const seq = (items.at(-1)?.seq ?? 0) + 1;
        const rewrites = this.#rewrites.get(run.id) ?? 0;
        const previous = items.findLast(candidate => candidate.body.kind !== 'note');
        const opens = body.kind === 'user' && body.from === undefined && FORKABLE_ENGINES.has(run.engine) && (previous === undefined || previous.canFork === true);
        const item: StreamItem = { id: `${ run.id }-${ seq }${ rewrites > 0 ? `-r${ rewrites }` : '' }`, runId: run.id, seq, at: Date.now(), body, ...(opens && { canEdit: true }) };

        this.#saveItem(run, item);

        return item;
    }

    /** The turn ended: its final answer holds a rewind point and offers Fork (`canFork`), as the daemon's driver stamps it, when the stream's story ends with it. */
    #markRewindPoint(run: Run): void {
        const last = this.#data.items[run.id]?.findLast(item => item.body.kind !== 'note');

        if (last?.body.kind === 'assistant' && FORKABLE_ENGINES.has(run.engine)) this.#saveItem(run, { ...last, canFork: true });
    }

    /** Streams a reply into one item in three steps, the way an engine's text arrives. */
    #streamReply(run: Run, text: string): void {
        const words = text.split(' ');
        const cut = (share: number) => words.slice(0, Math.ceil(words.length * share)).join(' ');
        const item = this.#appendItem(run, { kind: 'assistant', text: cut(0.3), done: false });

        this.#later(350, () => this.#saveItem(run, { ...item, body: { kind: 'assistant', text: cut(0.7), done: false } }));
        this.#later(700, () => this.#saveItem(run, { ...item, body: { kind: 'assistant', text, done: true } }));
    }

    #agent(id: string): AgentInfo | undefined {
        return this.#data.agents.find(agent => agent.id === id);
    }

    #updateAgent({ id, enabled, settings, path, env, permission }: Extract<CommandInput, { type: 'agent.update' }>): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        // A preset the agent does not offer is refused before anything changes, as the daemon does.
        if (permission && !agent.permissions?.presets.some(preset => preset.id === permission)) return fail('invalid', `${ agent.name } has no preset called "${ permission }"`);

        if (enabled !== undefined) {
            agent.enabled = enabled;

            // A program that is not there stays not there; only a ready agent and a switched-off one trade places.
            if (agent.status === 'ready' || agent.status === 'disabled') agent.status = enabled ? 'ready' : 'disabled';
        }

        for (const [settingId, value] of Object.entries(settings ?? {})) {
            const setting = agent.settings?.find(candidate => candidate.id === settingId);

            if (!setting) return fail('invalid', `${ agent.name } has no setting called "${ settingId }"`);

            setting.value = value;
        }

        // `value` is the person's choice only: `null` takes it back, and the agent runs on its provider's default.
        if (agent.permissions && permission !== undefined) {
            if (permission === null) delete agent.permissions.value;
            else agent.permissions.value = permission;
        }

        // What the person changed about how the agent starts, kept as the daemon keeps it: a path they chose (`null` goes
        // back to looking for the program) and the variables, which replace the saved set.
        if (path === null) {
            agent.path = FIXTURE_PROGRAMS[id];
            agent.overrides = withoutEmpty({ ...agent.overrides, path: undefined });
        }
        else if (path !== undefined) {
            agent.path = path;
            agent.overrides = { ...agent.overrides, path };
        }

        if (env !== undefined) agent.overrides = withoutEmpty({ ...agent.overrides, env });

        this.#agentsChanged();

        return ok({ id });
    }

    /** A sign-in that starts, prints its link, and ends a few seconds later with the agent signed in. */
    #startSignIn(id: string): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        if (!agent.canSignIn) return fail('invalid', `${ agent.name } has to be signed in from a terminal: ${ agent.login ?? 'see its documentation' }`);

        if (agent.signInSession?.step === 'starting' || agent.signInSession?.step === 'waiting') return fail('conflict', 'A sign-in is already running');

        const startedAt = Date.now();
        const session = { step: 'starting' as const, startedAt };

        agent.signInSession = session;
        this.#agentsChanged();

        const running = () => agent.signInSession?.startedAt === startedAt && (agent.signInSession.step === 'starting' || agent.signInSession.step === 'waiting');

        this.#later(SIGN_IN_LINK_MS, () => {
            if (!running()) return;

            agent.signInSession = { step: 'waiting', startedAt, url: FIXTURE_SIGN_IN_LINKS[id] ?? 'https://example.com/sign-in' };
            this.#agentsChanged();
        });
        this.#later(SIGN_IN_DONE_MS, () => {
            if (!running()) return;

            agent.signInSession = { step: 'done', startedAt };
            agent.signIn = { status: 'signed-in', account: { email: 'dev@example.com', method: 'subscription', plan: agent.signIn?.account?.plan ?? 'Pro' }, checkedAt: Date.now() };
            this.#agentsChanged();
        });

        return ok({ id });
    }

    #cancelSignIn(id: string): Outcome {
        const agent = this.#agent(id);

        if (!agent) return fail('not_found', `There is no agent called "${ id }"`);

        if (agent.signInSession?.step === 'starting' || agent.signInSession?.step === 'waiting') {
            agent.signInSession = { step: 'cancelled', startedAt: agent.signInSession.startedAt, message: 'Sign-in cancelled' };
            this.#agentsChanged();
        }

        return ok({ id });
    }

    #runTimeline(): void {
        const run = this.#data.runs.find(candidate => candidate.id === FIXTURE_LIVE_RUN_ID);
        const items = run && this.#data.items[run.id];
        const tool = items?.find(item => item.id === FIXTURE_LIVE_TOOL_ID);
        const text = items?.find(item => item.id === FIXTURE_LIVE_TEXT_ID);

        if (!run || !tool || !text || tool.body.kind !== 'tool') return;

        const toolBody = tool.body;
        const say = (message: string, done: boolean) => this.#saveItem(run, { ...text, at: Date.now(), body: { kind: 'assistant', text: message, done } });

        this.#later(2500, () => this.#saveItem(run, { ...tool, body: { ...toolBody, state: 'done', output: '0 errors, 0 warnings' } }));
        this.#later(3500, () => say('Checking confirmation handling. The confirmation view reads the saved booking', false));
        this.#later(4500, () => say('Checking confirmation handling. The confirmation view reads the saved booking, so a reload keeps it.', true));
        this.#later(6000, () => {
            const parent = this.#data.runs.find(candidate => candidate.id === run.parentRunId);
            const call = parent && this.#data.items[parent.id]?.find(item => item.body.kind === 'tool' && item.body.toolCallId === run.parentToolCallId);

            // The sub-agent is done: its run ends and the call that started it returns its report, as a session reports a sub-agent.
            if (run.status !== 'running') return;

            run.status = 'succeeded';
            run.result = 'The form is one view now, and the typecheck passes.';
            run.finishedAt = Date.now();
            this.#saveRun(run);

            if (parent && call?.body.kind === 'tool') this.#saveItem(parent, { ...call, body: { ...call.body, state: 'done', output: run.result } });
        });
    }

    /* -------------------------------- Commands -------------------------------- */

    #apply(command: CommandInput): Outcome {
        const data = this.#data;

        switch (command.type) {
            case 'project.add': {
                const paths = command.folders ?? [];

                if (paths.length === 0 && command.name === undefined) return fail('invalid', 'A project without folders needs a name: its new folder is named after it');

                if (new Set(paths).size !== paths.length) return fail('invalid', 'A folder is listed twice');

                const known = paths.length > 0 && data.projects.find(project => project.folders.length === paths.length && project.folders.every(folder => paths.includes(folder.path)));

                if (known) return ok({ project: structuredClone(known), existing: true });

                const name = command.name ?? paths[0]?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Project';

                return this.#addProject(name, paths.length > 0 ? paths : [`/Users/dev/Clowdy/projects/${ name.toLowerCase().replace(/\W+/g, '-') }`]);
            }
            case 'project.update': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                if (command.folders?.length === 0) return fail('invalid', 'A project needs at least one folder');

                // `{ id }` keeps a folder, `{ id, path }` keeps it at another place (its chats stay with it), `{ path }` adds one.
                const folders = command.folders?.map((entry) => {
                    if (!('id' in entry)) return project.folders.find(folder => folder.path === entry.path) ?? { id: this.#id('fld'), path: entry.path };

                    const kept = project.folders.find(folder => folder.id === entry.id);

                    return kept && 'path' in entry ? { id: kept.id, path: entry.path } : kept;
                });

                if (folders?.some(folder => folder === undefined)) return fail('invalid', 'A folder is not one of the project\'s');

                const nextFolders = (folders as Project['folders'] | undefined) ?? project.folders;

                if (new Set(nextFolders.map(folder => folder.path)).size !== nextFolders.length) return fail('invalid', 'A folder is listed twice');

                const renamed = command.name !== undefined && command.name !== project.name;
                const refoldered = nextFolders.map(folder => `${ folder.id }:${ folder.path }`).join('|') !== project.folders.map(folder => `${ folder.id }:${ folder.path }`).join('|');

                if (project.personal && (renamed || refoldered)) return fail('conflict', 'The personal space cannot be renamed or given other folders');

                if (project.personal && command.settings?.icon !== undefined) return fail('conflict', 'The personal space has no icon of its own');

                if ((mainFolder({ folders: nextFolders }).id !== mainFolder(project).id || mainFolder({ folders: nextFolders }).path !== mainFolder(project).path) && this.#activeRuns(project.id) > 0) return fail('conflict', 'The agents of this project are still working. Stop them first.');

                const settings: Project['settings'] = { ...project.settings };

                for (const [key, value] of Object.entries(command.settings ?? {})) {
                    if (value === null) delete settings[key as keyof Project['settings']];
                    else Object.assign(settings, { [key]: value });
                }

                Object.assign(project, { name: command.name ?? project.name, folders: nextFolders, settings });
                this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });

                if (refoldered) {
                    // Like the daemon: a chat that worked in a folder that left goes back to the main folder.
                    for (const chat of data.chats) {
                        if (chat.projectId === project.id && chat.folderId !== undefined && !nextFolders.some(folder => folder.id === chat.folderId)) {
                            delete chat.folderId;
                            this.#emit(project.id, { type: 'chat.upserted', chat: structuredClone(chat) });
                        }
                    }

                    // Like the daemon: the project's skills come from its folders.
                    this.#emit(project.id, { type: 'skills.changed' });
                }

                // Like the daemon: `{ project }`.
                return ok({ project: structuredClone(project) });
            }
            case 'project.updateFolder': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);
                const outcome = applyFolderSettings(project, command.folderId, command.settings);

                if (project && outcome.ok) this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });

                return outcome;
            }
            case 'project.delete': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', 'No such project');

                if (project.personal) return fail('conflict', 'The personal space cannot be removed');

                if (this.#activeRuns(project.id) > 0) return fail('conflict', 'The agents of this project are still working. Stop them first.');

                const runIds = new Set(data.runs.filter(run => run.projectId === project.id).map(run => run.id));

                data.projects = data.projects.filter(candidate => candidate.id !== project.id);
                data.chats = data.chats.filter(chat => chat.projectId !== project.id);
                const taskIds = new Set(data.tasks.filter(task => task.projectId === project.id).map(task => task.id));

                data.tasks = data.tasks.filter(task => task.projectId !== project.id);
                data.comments = data.comments.filter(comment => !taskIds.has(comment.taskId));
                data.runs = data.runs.filter(run => run.projectId !== project.id);
                data.runTaskLinks = data.runTaskLinks.filter(link => !runIds.has(link.runId));
                data.artifacts = data.artifacts.filter(artifact => artifact.projectId !== project.id);
                runIds.forEach(runId => delete data.items[runId]);
                delete data.statuses[project.id];
                // Not the documents and files: as with the daemon, they live in the folders, which stay (and another project may have them).
                this.#emit(project.id, { type: 'project.deleted' });

                return ok({ projectId: project.id });
            }
            case 'project.reorder': {
                const unknown = command.projectIds.find(id => !data.projects.some(project => project.id === id));

                if (unknown !== undefined) return fail('invalid', `No such project: ${ unknown }`);

                const named = [...new Set(command.projectIds)].flatMap(id => data.projects.find(project => project.id === id && !project.personal) ?? []);
                const rest = data.projects.filter(project => !project.personal && !named.includes(project));
                const ordered = [...data.projects.filter(project => project.personal), ...named, ...rest];

                data.projects = ordered;
                ordered.forEach((project, index) => {
                    if (project.personal || project.position === index) return;

                    project.position = index;
                    this.#emit(project.id, { type: 'project.upserted', project, statuses: data.statuses[project.id] ?? DEFAULT_STATUSES });
                });

                return ok({ projects: structuredClone(ordered) });
            }

            case 'workspace.open': {
                const project = data.projects.find(candidate => candidate.id === command.projectId);

                if (!project) return fail('not_found', `Project ${ command.projectId } does not exist`);

                const folder = project.folders.find(candidate => candidate.id === command.folderId) ?? (command.folderId === undefined ? mainFolder(project) : undefined);

                if (!folder) return fail('invalid', `Folder ${ command.folderId } does not belong to project ${ command.projectId }`);

                const known = [...data.chats.flatMap(chat => (chat.workspace ? [chat.workspace] : [])), ...[...this.#opened.values()].map(entry => entry.workspace)];
                const made = fixtureChatWorkspace({ mode: 'existing', path: command.path }, { projectName: project.name, folder, chatId: '', head: data.git[folder.path], known, removed: data.removed?.[folder.path] });

                if ('error' in made) return fail('invalid', made.error);

                const workspace = structuredClone(made.workspace);

                // The row is the same one `chat.create` finds by the path: the id is the worktree's, with or without a chat.
                if (!this.#opened.has(workspace.id)) this.#opened.set(workspace.id, { projectId: project.id, workspace });

                // Like the daemon: `{ workspace }`.
                return ok({ workspace });
            }
            case 'workspace.remove':
                return this.#removeWorktree(command);
            case 'chat.create': {
                const refused = this.#refuseEngine(command.engine);

                if (refused) return refused;

                // Like the daemon: a folder the project does not have is refused.
                if (command.folderId && !data.projects.find(candidate => candidate.id === command.projectId)?.folders.some(folder => folder.id === command.folderId)) {
                    return fail('invalid', `Folder ${ command.folderId } does not belong to project ${ command.projectId }`);
                }

                const project = data.projects.find(candidate => candidate.id === command.projectId);
                const id = this.#id('c');
                let workspace: Chat['workspace'];

                // Like the daemon: a worktree of the chat's folder (the main one when none is named), refused where the folder is no repository, the base is no ref or the path is no worktree.
                if (command.workspace && project) {
                    const folder = project.folders.find(candidate => candidate.id === command.folderId) ?? mainFolder(project);
                    const made = fixtureChatWorkspace(command.workspace, {
                        projectName: project.name,
                        folder,
                        chatId: id,
                        head: data.git[folder.path],
                        known: data.chats.flatMap(chat => (chat.workspace ? [chat.workspace] : [])),
                        removed: data.removed?.[folder.path],
                    });

                    if ('error' in made) return fail('invalid', made.error);

                    workspace = structuredClone(made.workspace);

                    if (command.workspace.mode === 'new') this.#bases.set(workspace.id, command.workspace.base ?? 'origin/main');
                }

                const now = Date.now();
                const chat: Chat = {
                    id,
                    projectId: command.projectId,
                    title: command.title ?? 'New chat',
                    mode: command.mode ?? 'autopilot',
                    ...(command.engine && { engine: command.engine }),
                    ...(command.model && { model: command.model }),
                    ...(command.effort && { effort: command.effort }),
                    ...(command.folderId && { folderId: command.folderId }),
                    ...(workspace && { workspace }),
                    createdAt: now,
                    updatedAt: now,
                };

                data.chats.push(chat);
                this.#emit(chat.projectId, { type: 'chat.upserted', chat });

                // Like the daemon: `{ chat }`.
                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.rename':
            case 'chat.setMode': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.type === 'chat.rename') chat.title = command.title;
                else chat.mode = command.mode;

                chat.updatedAt = Date.now();
                this.#emit(chat.projectId, { type: 'chat.upserted', chat });

                return ok();
            }
            case 'chat.setModel': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                const refused = this.#refuseEngine(command.engine);

                if (refused) return refused;

                // The daemon's rules (`setChatModel`): the provider is fixed by the first message, another provider brings its own models, a new model its own levels.
                const switched = (command.engine ?? chat.engine) !== chat.engine;

                if (switched && chat.orchestratorRunId) return fail('conflict', 'The provider of a chat is fixed once its first message was sent');

                const model = named(command.model, switched ? undefined : chat.model);
                const effort = named(command.effort, switched || model !== chat.model ? undefined : chat.effort);

                // Nothing changes silently: a call that changes nothing announces nothing and does not move the chat up the list.
                if (switched || model !== chat.model || effort !== chat.effort) {
                    delete chat.model;
                    delete chat.effort;

                    if (command.engine) chat.engine = command.engine;
                    if (model) chat.model = model;
                    if (effort) chat.effort = effort;

                    chat.updatedAt = Date.now();
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                // The orchestrator's next turn reads its own row.
                const run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

                if (run && (run.model !== chat.model || run.effort !== chat.effort)) {
                    delete run.model;
                    delete run.effort;

                    if (chat.model) run.model = chat.model;
                    if (chat.effort) run.effort = chat.effort;

                    this.#saveRun(run);
                }

                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.compact': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                const run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

                if (!run) return fail('invalid', 'This chat has no conversation to compact yet');

                // Only these agents have a command of their own to compact the conversation.
                if (run.engine !== 'claude' && run.engine !== 'codex') {
                    return fail('invalid', `${ data.agents.find(agent => agent.id === run.engine)?.name ?? run.engine } has no command to compact its conversation`);
                }

                // While the orchestrator works, Compact waits in the queue until it has finished; asking again changes nothing.
                if (!isTerminalRunStatus(run.status)) {
                    if (!chat.queue?.some(isCompact)) {
                        chat.queue = placeQueued(chat.queue ?? [], { id: this.#id('q'), mode: 'queue', command: 'compact', text: COMPACT_TEXT, content: '/compact', createdAt: Date.now() });
                        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                    }

                    return ok({ chatId: chat.id, runId: run.id });
                }

                // A compact item that waited in a held queue is this same request.
                if (chat.queue?.some(isCompact)) {
                    this.#setQueue(chat, chat.queue.filter(item => !isCompact(item)));
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                this.#startCompact(chat, run);

                return ok({ chatId: chat.id, runId: run.id });
            }
            case 'chat.setArchived': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.archived && chat.archivedAt === undefined) {
                    const threads = this.#threadsBelow(chat);

                    if (this.#isChatBusy(chat)) return fail('conflict', 'The agents of this chat are still working. Stop the chat first.');

                    if (threads.some(thread => this.#isChatBusy(thread))) return fail('conflict', 'A thread of this chat is still working. Stop it first.');

                    // Like the daemon: the threads go with it, each before its parent, so no thread is ever listed without its parent.
                    const now = Date.now();

                    for (const archived of [...threads.filter(thread => thread.archivedAt === undefined).reverse(), chat]) {
                        archived.archivedAt = now;
                        this.#emit(archived.projectId, { type: 'chat.upserted', chat: archived });
                    }
                }
                else if (!command.archived && chat.archivedAt !== undefined) {
                    delete chat.archivedAt;
                    this.#emit(chat.projectId, { type: 'chat.upserted', chat });
                }

                return ok({ chat: structuredClone(chat) });
            }
            case 'chat.delete': {
                const chat = data.chats.find(candidate => candidate.id === command.chatId);

                if (!chat) return fail('not_found', 'No such chat');

                if (command.removeWorkspace === true && !this.#removal(chat).removable) return fail('conflict', 'The worktree cannot be removed');

                // Like the daemon: the threads below go with it, archived ones too, once no agent of any of them works.
                const gone = [...this.#threadsBelow(chat).reverse(), chat];

                if (gone.some(candidate => this.#isChatBusy(candidate))) return fail('conflict', 'The agents of this chat or of its threads are still working. Stop them first.');

                for (const deleted of gone) {
                    const runIds = new Set(this.#runsOfChat(deleted).map(run => run.id));

                    data.chats = data.chats.filter(candidate => candidate.id !== deleted.id);
                    data.runs = data.runs.filter(run => !runIds.has(run.id));
                    data.chatTaskLinks = data.chatTaskLinks.filter(link => link.chatId !== deleted.id);
                    data.runTaskLinks = data.runTaskLinks.filter(link => !runIds.has(link.runId));
                    runIds.forEach(runId => delete data.items[runId]);
                    this.#emit(deleted.projectId, { type: 'chat.deleted', chatId: deleted.id, runIds: [...runIds] });
                }

                // Like the daemon: a worktree's row goes with the last chat that points at it, so a row `workspace.open` answered is made again when it is asked for.
                for (const deleted of gone) {
                    const workspaceId = deleted.workspace?.id;

                    if (workspaceId && !data.chats.some(candidate => candidate.workspace?.id === workspaceId)) this.#opened.delete(workspaceId);
                }

                return ok({ chatId: chat.id });
            }
            case 'chat.send':
                return this.#sendMessage(command.chatId, command.text, command.attachmentIds ?? [], command.mode ?? 'queue');
            case 'chat.removeQueued':
                return this.#removeQueued(command.chatId, command.itemId, command.keepFiles === true);
            case 'chat.moveQueued':
                return this.#changeQueued(command.chatId, command.itemId, (chat, item) => placeQueued(chat.queue ?? [], item, command.index));
            case 'chat.sendQueued':
                return this.#sendQueued(command.chatId, command.itemId);
            case 'chat.fork':
                return this.#forkChat(command.chatId, command.itemId);
            case 'chat.edit':
                return this.#editMessage(command.chatId, command.itemId, command.text, command.attachmentIds ?? []);

            case 'task.create':
                return this.#tasks.create(command);
            case 'task.update':
                return this.#tasks.update(command);
            case 'task.delete':
                return this.#tasks.delete(command);
            case 'task.archive':
                return this.#tasks.archive(command);
            case 'task.unarchive':
                return this.#tasks.unarchive(command);
            case 'task.start':
                return this.#startTask(command.taskId, command.force === true);
            case 'task.comment.add':
                return this.#tasks.addComment(command);
            case 'task.comment.edit':
                return this.#tasks.editComment(command);
            case 'task.comment.delete':
                return this.#tasks.deleteComment(command);

            case 'run.cancel':
                return this.#cancelRun(command.runId);
            case 'run.stopAgents':
                return this.#stopAgents(command.runId);
            case 'run.stopBackground':
                return this.#stopBackground(command.runId, command.itemId);
            case 'run.answer':
                return this.#answerQuestion(command.runId, command.questionId, command.answer);

            case 'run.decide':
                return this.#decideApproval(command.runId, command.approvalId, command.decision);

            case 'skills.setEnabled': {
                const skill = data.skills.find(candidate => candidate.name === command.name);

                if (!skill) return fail('not_found', `Skill ${ command.name } does not exist`);

                if (skill.source !== 'user') return fail('invalid', skill.source === 'system' ? 'System skills cannot be switched off' : 'Only user skills can be switched on or off');

                if (skill.enabled !== command.enabled) {
                    skill.enabled = command.enabled;
                    data.projects.forEach(project => this.#emit(project.id, { type: 'skills.changed' }));
                }

                return ok({ name: command.name, enabled: command.enabled });
            }
            case 'agent.add':
            case 'agent.remove':
                return fail('unavailable', 'The demo data cannot add or remove agents');
            case 'agent.update':
                return this.#updateAgent(command);
            case 'agent.signIn':
                return this.#startSignIn(command.id);
            case 'agent.cancelSignIn':
                return this.#cancelSignIn(command.id);
            case 'agents.refresh': {
                const now = Date.now();

                for (const agent of data.agents) {
                    if (agent.signIn) agent.signIn.checkedAt = now;

                    if (agent.usage?.state === 'ok') agent.usage.fetchedAt = now;
                }

                this.#agentsChanged();

                return ok();
            }
        }
    }

    /** The projects as the daemon lists them: the personal space first, then in the person's order. */
    #listed(): Project[] {
        return [...this.#data.projects].sort((a, b) => Number(b.personal === true) - Number(a.personal === true) || a.position - b.position);
    }

    /** Runs of the project that have not finished: what stops it from being removed or moved. */
    #activeRuns(projectId: ProjectId): number {
        return this.#data.runs.filter(run => run.projectId === projectId && !isTerminalRunStatus(run.status)).length;
    }

    /** The runs of a chat: its orchestrator and every run of its tree (native sub-agents). A thread's runs are its own chat's, not its parent's. */
    #runsOfChat(chat: Chat): Run[] {
        return this.#data.runs.filter(run => run.chatId === chat.id || (chat.orchestratorRunId !== undefined && run.rootRunId === chat.orchestratorRunId));
    }

    /** An agent of the chat still works: what the daemon refuses an archive or a delete for. */
    #isChatBusy(chat: Chat): boolean {
        return this.#runsOfChat(chat).some(run => !isTerminalRunStatus(run.status));
    }

    /** Every thread below the chat, at any depth and archived ones too, each after its parent. */
    #threadsBelow(chat: Chat): Chat[] {
        const found: Chat[] = [];
        const seen = new Set([chat.id]);

        for (let index = -1; index < found.length; index++) {
            const parentId = index < 0 ? chat.id : found[index].id;

            for (const thread of this.#data.chats.filter(candidate => candidate.parentChatId === parentId && !seen.has(candidate.id))) {
                seen.add(thread.id);
                found.push(thread);
            }
        }

        return found;
    }

    /**
     * A thread's turn ended: its parent is told, as the daemon does. A parent at rest (also one that waits for its background work) starts a turn with
     * the notice at once; a busy one, or one whose queue is held, gets it in its queue, merged with the notices already waiting there (the latest of
     * a thread wins). Nothing for a turn that said nothing, and nothing for a parent in the archive.
     */
    #notifyParent(thread: Chat, run: Run): void {
        const parent = this.#data.chats.find(candidate => candidate.id === thread.parentChatId);
        const parentRun = parent && this.#data.runs.find(candidate => candidate.id === parent.orchestratorRunId);
        const said = this.#data.items[run.id]?.findLast(item => item.body.kind === 'assistant')?.body;
        const text = said?.kind === 'assistant' ? said.text.trim().slice(0, NOTICE_TEXT_MAX) : '';

        if (!parent || !parentRun || parent.archivedAt !== undefined || text === '') return;

        const open = run.status === 'waiting_background' ? (run.background ?? []).map(item => item.title) : [];
        const notice: ThreadNotice = { chatId: thread.id, title: thread.title, outcome: 'finished', text, ...(open.length > 0 && { background: open }) };

        if (!isBusyRunStatus(parentRun.status) && !parent.queuePaused) {
            this.#startTurn(parent, parentRun, { kind: 'user', text: '', from: { kind: 'threadNotice', threads: [notice] } }, NOTICE_REPLY);

            return;
        }

        const waiting = parent.queue?.find(item => item.from?.kind === 'threadNotice');
        const earlier = waiting?.from?.kind === 'threadNotice' ? waiting.from.threads.filter(entry => entry.chatId !== thread.id) : [];
        const threads = [...earlier, notice];
        const summary = noticeSummary(threads);
        const item: QueuedMessage = { id: waiting?.id ?? this.#id('q'), mode: 'queue', text: summary, content: `${ summary }.`, from: { kind: 'threadNotice', threads }, createdAt: waiting?.createdAt ?? Date.now() };

        parent.queue = waiting ? (parent.queue ?? []).map(entry => (entry.id === item.id ? item : entry)) : placeQueued(parent.queue ?? [], item);
        this.#emit(parent.projectId, { type: 'chat.upserted', chat: parent });
    }

    #addProject(name: string, paths: readonly string[]): Outcome {
        const prefix = name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'TSK';
        const position = Math.max(0, ...this.#data.projects.map(candidate => candidate.position)) + 1;
        const folders = paths.map(path => ({ id: this.#id('fld'), path }));
        const project: Project = { id: this.#id('p'), name, folders, taskPrefix: prefix, settings: {}, createdAt: Date.now(), position };

        this.#data.projects.push(project);
        this.#data.statuses[project.id] = DEFAULT_STATUSES;
        this.#emit(project.id, { type: 'project.upserted', project, statuses: DEFAULT_STATUSES });

        // Like the daemon: `{ project }`.
        return ok({ project: structuredClone(project) });
    }

    #sendMessage(chatId: string, rawText: string, attachmentIds: string[], mode: QueuedMessageMode): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);
        const text = rawText.trim();

        if (!chat) return fail('not_found', 'No such chat');

        if (!text && attachmentIds.length === 0) return fail('invalid', 'The message is empty');

        const files: StoredFile[] = [];

        for (const id of new Set(attachmentIds)) {
            const stored = this.#files.get(id);

            if (stored?.projectId !== chat.projectId) return fail('not_found', `No such attachment: ${ id }`);

            if (stored.sent) return fail('conflict', `${ stored.attachment.name } was sent already`);

            files.push(stored);
        }

        if (files.reduce((sum, stored) => sum + stored.attachment.size, 0) > MAX_ATTACHMENTS_BYTES_PER_MESSAGE) return fail('invalid', 'The files are over the size limit of one message');

        for (const stored of files) stored.sent = true;

        const attachments = files.map(stored => structuredClone(stored.attachment));
        const existing = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

        chat.updatedAt = Date.now();

        // A busy orchestrator gets the message later: it waits in the chat's queue, and a steer is taken a moment later, as an agent would.
        if (existing && isBusyRunStatus(existing.status)) {
            const item: QueuedMessage = { id: this.#id('q'), mode, text, ...(attachments.length > 0 && { attachments }), content: text, createdAt: Date.now() };

            chat.queue = placeQueued(chat.queue ?? [], item);
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });

            if (mode === 'steer') this.#later(STEER_MS, () => this.#takeSteer(chat.id, item.id));

            return ok({ chatId: chat.id, runId: existing.id });
        }

        let run = existing;

        if (!run) {
            const number = data.runs.filter(candidate => candidate.role === 'orchestrator').length + 1;
            const id = this.#id('r-orch');

            run = {
                id,
                projectId: chat.projectId,
                rootRunId: id,
                chatId: chat.id,
                role: 'orchestrator',
                name: `Orchestrator ${ String(number).padStart(2, '0') }`,
                summary: chat.title,
                status: 'running',
                engine: chat.engine ?? 'fake',
                ...(chat.model && { model: chat.model }),
                ...(chat.effort && { effort: chat.effort }),
                createdAt: Date.now(),
                startedAt: Date.now(),
            };
            data.runs.push(run);
            this.#saveRun(run);
            chat.orchestratorRunId = id;
        }

        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
        this.#startTurn(chat, run, { kind: 'user', text, ...(attachments.length > 0 && { attachments }) });

        return ok({ chatId: chat.id, runId: run.id });
    }

    /**
     * `chat.fork` as the daemon does it, the agent's own part left out: the new chat has the history through the answer (new ids, the same numbers, time and
     * flags, a file of its own for each file a message carries, a call that still ran shown as stopped), the source's agent, model, level and mode, no queue,
     * no thread, a run at rest, and `forkedFrom`. Native sub-agents' runs are not copied. The source may be working.
     */
    #forkChat(chatId: string, itemId: string): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);

        if (!chat) return fail('not_found', 'No such chat');

        const source = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

        if (!source) return fail('invalid', 'This chat has no conversation to fork yet');

        const answer = (data.items[source.id] ?? []).find(item => item.id === itemId);

        if (!answer) return fail('not_found', `Message ${ itemId } does not exist`);

        if (!answer.canFork) return fail('invalid', 'This message cannot be forked');

        const now = Date.now();
        const id = this.#id('c');
        const runId = this.#id('r-orch');
        const number = data.runs.filter(candidate => candidate.role === 'orchestrator' && candidate.origin !== 'native').length + 1;
        const title = forkTitle(chat.title);
        const run: Run = {
            id: runId,
            projectId: chat.projectId,
            rootRunId: runId,
            chatId: id,
            role: 'orchestrator',
            name: `Orchestrator ${ String(number).padStart(2, '0') }`,
            summary: title,
            status: 'succeeded',
            engine: source.engine,
            ...(source.model && { model: source.model }),
            ...(source.effort && { effort: source.effort }),
            sessionId: this.#id('fork-session'),
            ...(answer.body.kind === 'assistant' && { result: answer.body.text }),
            createdAt: now,
            startedAt: now,
            finishedAt: now,
        };
        const copied = (data.items[source.id] ?? []).filter(item => item.seq <= answer.seq).map((item): StreamItem => {
            const copy = structuredClone(item);
            const body = copy.body;

            if (body.kind === 'user' && body.attachments) {
                body.attachments = body.attachments.map((file) => {
                    const stored = this.#files.get(file.id);

                    if (!stored) return file;

                    const own: Attachment = { ...file, id: this.#id('a') };

                    this.#files.set(own.id, { ...stored, attachment: own, sent: true });

                    return own;
                });
            }
            else if (body.kind === 'tool' && body.state === 'running') {
                Object.assign(body, { state: 'error', error: STOPPED_TOOL });
            }

            return { ...copy, id: `${ runId }-${ item.seq }`, runId };
        });
        const made: Chat = {
            id,
            projectId: chat.projectId,
            title,
            mode: chat.mode,
            ...(source.engine && { engine: source.engine }),
            ...(source.model && { model: source.model }),
            ...(source.effort && { effort: source.effort }),
            // The copy works where its source does: the same folder and the same worktree.
            ...(chat.folderId && { folderId: chat.folderId }),
            ...(chat.workspace && { workspace: structuredClone(chat.workspace) }),
            orchestratorRunId: runId,
            forkedFrom: { chatId: chat.id, atSeq: answer.seq },
            createdAt: now,
            updatedAt: now,
        };

        data.runs.push(run);
        data.items[runId] = copied;
        data.chats.push(made);
        this.#saveRun(run);
        this.#emit(made.projectId, { type: 'chat.upserted', chat: made });

        return ok({ chat: structuredClone(made) });
    }

    /**
     * `chat.edit` as the daemon does it, the agent's own part left out: a chat at rest is rewritten from a message of the person's that starts a turn. The
     * stream from it on is cut with the sub-agent runs it started and the files of its messages, except the files the new message carries on, the run takes
     * a new session (none for the first message of the chat) and forgets its context reading, `stream.truncated` is announced, and the new text goes as an
     * ordinary turn, so the new message takes the freed number under a new id. Everything is checked before anything changes.
     */
    #editMessage(chatId: string, itemId: string, rawText: string, attachmentIds: string[]): Outcome {
        const data = this.#data;
        const chat = data.chats.find(candidate => candidate.id === chatId);

        if (!chat) return fail('not_found', 'No such chat');

        const run = data.runs.find(candidate => candidate.id === chat.orchestratorRunId);

        if (!run) return fail('invalid', 'This chat has no conversation to edit yet');

        const items = data.items[run.id] ?? [];
        const edited = items.find(item => item.id === itemId);

        if (!edited) return fail('not_found', `Message ${ itemId } does not exist`);

        if (!edited.canEdit) return fail('invalid', 'This message cannot be edited');

        if (!isTerminalRunStatus(run.status)) return fail('conflict', 'Stop the agent to edit this message');

        if (!rawText.trim() && attachmentIds.length === 0) return fail('invalid', 'The message is empty');

        const dropped = items.filter(item => item.seq >= edited.seq);
        const droppedFiles = new Set(dropped.flatMap(item => (item.body.kind === 'user' ? item.body.attachments ?? [] : []).map(file => file.id)));

        // What the message carries is checked as a send checks it, except that the files of the dropped messages may go on in it.
        for (const id of new Set(attachmentIds)) {
            const stored = this.#files.get(id);

            if (stored?.projectId !== chat.projectId) return fail('not_found', `No such attachment: ${ id }`);

            if (stored.sent && !droppedFiles.has(id)) return fail('conflict', `${ stored.attachment.name } was sent already`);
        }

        const calls = new Set(dropped.flatMap(item => (item.body.kind === 'tool' ? [item.body.toolCallId] : [])));
        const started = data.runs.filter(candidate => candidate.parentRunId === run.id && (candidate.parentToolCallId !== undefined ? calls.has(candidate.parentToolCallId) : candidate.createdAt >= edited.at));
        const removed = new Set(started.map(candidate => candidate.id));

        // The sub-agents of those are theirs to go with them.
        for (const candidate of data.runs) {
            if (candidate.parentRunId !== undefined && removed.has(candidate.parentRunId)) removed.add(candidate.id);
        }

        data.items[run.id] = items.filter(item => item.seq < edited.seq);
        data.runs = data.runs.filter(candidate => !removed.has(candidate.id));
        data.runTaskLinks = data.runTaskLinks.filter(link => !removed.has(link.runId));
        removed.forEach(runId => delete data.items[runId]);
        this.#rewrites.set(run.id, (this.#rewrites.get(run.id) ?? 0) + 1);

        for (const id of droppedFiles) {
            const stored = this.#files.get(id);

            if (!stored) continue;

            if (attachmentIds.includes(id)) stored.sent = false;
            else this.#files.delete(id);
        }

        this.#emit(run.projectId, { type: 'stream.truncated', runId: run.id, fromSeq: edited.seq, removedRunIds: [...removed] });

        delete run.context;

        if (items.some(item => item.seq < edited.seq && item.body.kind !== 'note')) run.sessionId = this.#id('fork-session');
        else delete run.sessionId;

        this.#saveRun(run);

        // A fork's divider follows the last item it inherited: a cut into that history ends it where the cut begins, as the daemon moves `forkedFrom.atSeq`.
        if (chat.forkedFrom && chat.forkedFrom.atSeq >= edited.seq) chat.forkedFrom = { ...chat.forkedFrom, atSeq: edited.seq - 1 };

        return this.#sendMessage(chat.id, rawText, attachmentIds, 'queue');
    }

    /** A turn of a chat's orchestrator: the message that starts it, a canned reply, and the end of the turn, after which the queue gives the next one. */
    #startTurn(chat: Chat, run: Run, body: StreamItemBody, reply = REPLY): void {
        const turn = (this.#turns.get(run.id) ?? 0) + 1;

        this.#turns.set(run.id, turn);

        if (run.status !== 'running') {
            run.status = 'running';
            run.statusReason = undefined;
            delete run.finishedAt;
            this.#saveRun(run);
        }

        this.#appendItem(run, body);
        this.#prepareWorkspace(chat, run);
        this.#later(400, () => this.#streamReply(run, reply));
        this.#later(TURN_MS, () => {
            if (this.#turns.get(run.id) !== turn || run.status !== 'running') return;

            this.#endTurn(chat, run);
        });
    }

    /**
     * The first turn of a chat that works in a worktree makes it, as the daemon's `Prepare workspace` does: a step of the chat's stream with git's lines as its log, and the
     * worktree is ready once it is over. At once here: the fixture has no time for a step that takes seconds. Nothing for a worktree that is made, or a chat in the folder itself.
     */
    #prepareWorkspace(chat: Chat, run: Run): void {
        const { workspace } = chat;

        if (!workspace || workspace.ready) return;

        const base = this.#bases.get(workspace.id) ?? 'origin/main';

        this.#appendItem(run, {
            kind: 'tool',
            toolCallId: this.#id('tc-workspace'),
            name: 'workspace',
            state: 'done',
            input: { path: workspace.path, ...(workspace.branch && { branch: workspace.branch }), base },
            output: fixtureWorkspaceLog(workspace, base),
        });
        workspace.ready = true;
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
    }

    /**
     * The turn is over. A session that has background work open stays alive and waits for it, as the daemon's driver does, so a message
     * sent meanwhile reaches the same orchestrator; otherwise the run is done. The queue gives the next message in both cases, and the parent of a
     * thread is told when the turn `said` something.
     */
    #endTurn(chat: Chat, run: Run, said = true): void {
        this.#markRewindPoint(run);

        if ((run.background?.length ?? 0) > 0) {
            run.status = 'waiting_background';
            run.statusReason = 'Waiting for background work';
        }
        else {
            run.status = 'succeeded';
            run.finishedAt = Date.now();
        }

        this.#saveRun(run);

        if (said && chat.parentChatId !== undefined) this.#notifyParent(chat, run);

        this.#settleQueue(chat);
    }

    /**
     * A compact turn: the agent's compaction call, running, then done with what it saved and a lower reading (Claude's report), and the end of the turn,
     * after which the queue gives the next one. No bubble: the person wrote nothing.
     */
    #startCompact(chat: Chat, run: Run): void {
        const turn = (this.#turns.get(run.id) ?? 0) + 1;
        const before = run.context?.used;
        const toolCallId = this.#id('tc-compact');
        const input = { title: 'Compact conversation' };

        this.#turns.set(run.id, turn);
        run.status = 'running';
        run.statusReason = undefined;
        delete run.finishedAt;
        this.#saveRun(run);

        const item = this.#appendItem(run, { kind: 'tool', toolCallId, name: 'compact', input, state: 'running' });

        this.#later(COMPACT_MS, () => {
            if (this.#turns.get(run.id) !== turn || run.status !== 'running') return;

            const after = before === undefined ? undefined : Math.round(before / 4);
            const output = JSON.stringify({ trigger: 'manual', ...(before !== undefined && { preTokens: before, postTokens: after }), durationMs: COMPACT_MS });

            this.#saveItem(run, { ...item, body: { kind: 'tool', toolCallId, name: 'compact', input, state: 'done', output } });

            if (run.context && after !== undefined) run.context = { ...run.context, used: after };

            // A compaction says nothing, so a thread's parent is not told.
            this.#endTurn(chat, run, false);
        });
    }

    /**
     * The orchestrator rests: steers it did not take go first as next turns, and a queue that is not paused gives it its head. A compact item waits for
     * an orchestrator that has finished, and the messages behind it go first meanwhile.
     */
    #settleQueue(chat: Chat): void {
        const run = this.#data.runs.find(candidate => candidate.id === chat.orchestratorRunId);
        const queue = (chat.queue ?? []).map(item => (item.mode === 'steer' ? { ...item, mode: 'queue' as const } : item));

        if (!run || isBusyRunStatus(run.status) || queue.length === 0) return;

        chat.queue = queue;

        const next = chat.queuePaused ? undefined : queue.find(item => !isCompact(item) || isTerminalRunStatus(run.status));

        if (!next) {
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });

            return;
        }

        this.#dispatch(chat, run, next);
    }

    /** Takes a message out of the queue and makes it the orchestrator's next turn; sending a message from the queue lets a paused one flow again. */
    #dispatch(chat: Chat, run: Run, item: QueuedMessage): void {
        this.#setQueue(chat, (chat.queue ?? []).filter(entry => entry.id !== item.id));
        delete chat.queuePaused;
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });

        if (isCompact(item)) this.#startCompact(chat, run);
        else this.#startTurn(chat, run, userBody(item), item.from?.kind === 'threadNotice' ? NOTICE_REPLY : REPLY);
    }

    /** The agent took a steer: it leaves the queue, and its bubble goes where the agent got it. */
    #takeSteer(chatId: string, itemId: string): void {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const run = this.#data.runs.find(candidate => candidate.id === chat?.orchestratorRunId);
        const item = chat?.queue?.find(entry => entry.id === itemId && entry.mode === 'steer');

        if (!chat || !item || run?.status !== 'running') return;

        this.#setQueue(chat, (chat.queue ?? []).filter(entry => entry.id !== itemId));
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });
        this.#appendItem(run, userBody(item));
        this.#later(300, () => this.#streamReply(run, 'Noted. I will take that into account.'));
    }

    #setQueue(chat: Chat, queue: QueuedMessage[]): void {
        if (queue.length > 0) {
            chat.queue = queue;

            return;
        }

        delete chat.queue;
        delete chat.queuePaused;
    }

    #changeQueued(chatId: string, itemId: string, change: (chat: Chat, item: QueuedMessage) => QueuedMessage[]): Outcome {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const item = chat?.queue?.find(entry => entry.id === itemId);

        if (!chat || !item) return fail('not_found', `Queued message ${ itemId } does not exist`);

        this.#setQueue(chat, change(chat, item));
        this.#emit(chat.projectId, { type: 'chat.upserted', chat });

        return ok({ chat: structuredClone(chat) });
    }

    #removeQueued(chatId: string, itemId: string, keepFiles: boolean): Outcome {
        return this.#changeQueued(chatId, itemId, (chat, item) => {
            for (const attachment of item.attachments ?? []) {
                const stored = this.#files.get(attachment.id);

                if (stored && keepFiles) stored.sent = false;
                else this.#files.delete(attachment.id);
            }

            return (chat.queue ?? []).filter(entry => entry.id !== itemId);
        });
    }

    #sendQueued(chatId: string, itemId: string): Outcome {
        const chat = this.#data.chats.find(candidate => candidate.id === chatId);
        const item = chat?.queue?.find(entry => entry.id === itemId);
        const run = this.#data.runs.find(candidate => candidate.id === chat?.orchestratorRunId);

        if (!chat || !item || !run) return fail('not_found', `Queued message ${ itemId } does not exist`);

        // A compact item steers nothing: it keeps its place while the orchestrator works, and goes only once it has finished.
        if (isCompact(item)) {
            if (isBusyRunStatus(run.status)) return ok({ chatId: chat.id, runId: run.id });

            if (!isTerminalRunStatus(run.status)) return fail('conflict', 'The orchestrator is waiting for background work. Compact the chat when it has finished');

            this.#dispatch(chat, run, item);

            return ok({ chatId: chat.id, runId: run.id });
        }

        if (isBusyRunStatus(run.status)) {
            this.#setQueue(chat, placeQueued(chat.queue ?? [], { ...item, mode: 'steer' }));
            this.#emit(chat.projectId, { type: 'chat.upserted', chat });
            this.#later(STEER_MS, () => this.#takeSteer(chat.id, item.id));
        }
        else {
            chat.updatedAt = Date.now();
            this.#dispatch(chat, run, item);
        }

        return ok({ chatId: chat.id, runId: run.id });
    }

    #startTask(taskId: TaskId, force: boolean): Outcome {
        const data = this.#data;
        const task = data.tasks.find(candidate => candidate.id === taskId);

        if (!task) return fail('not_found', 'No such task');

        // Like the daemon: an archived task takes no new work until it is restored.
        if (task.archivedAt !== undefined) return fail('invalid', `Task ${ task.key } is archived: restore it first`);

        const runIds = new Set(data.runTaskLinks.filter(link => link.taskId === taskId && link.relation === 'assigned').map(link => link.runId));

        if (!force && data.runs.some(run => runIds.has(run.id) && !isTerminalRunStatus(run.status))) return fail('already_running', `${ task.key } already has an active run`);

        // Like the daemon: the task opens a chat named after it, and the chat's orchestrator is the run assigned to the task.
        const number = data.runs.filter(candidate => candidate.role === 'orchestrator').length + 1;
        const id = this.#id('r-orch');
        const now = Date.now();
        const chat: Chat = {
            id: this.#id('c'),
            projectId: task.projectId,
            title: task.title,
            mode: 'autopilot',
            engine: 'fake',
            orchestratorRunId: id,
            createdAt: now,
            updatedAt: now,
        };
        const run: Run = {
            id,
            projectId: task.projectId,
            rootRunId: id,
            chatId: chat.id,
            role: 'orchestrator',
            name: `Orchestrator ${ String(number).padStart(2, '0') }`,
            summary: task.title,
            status: 'running',
            engine: 'fake',
            createdAt: now,
            startedAt: now,
        };
        const link = { runId: id, taskId, relation: 'assigned' as const };
        const chatLink = { chatId: chat.id, taskId };
        const statuses = data.statuses[task.projectId] ?? DEFAULT_STATUSES;
        const categoryOf = (candidate: Task) => statuses.find(status => status.id === candidate.statusId)?.category ?? 'todo';
        const moveTo = (category: 'active' | 'review') => {
            const status = statuses.find(candidate => candidate.category === category);

            if (!status) return;

            task.statusId = status.id;
            task.updatedAt = Date.now();
            this.#saveTask(task);
        };

        data.chats.push(chat);
        data.runs.push(run);
        data.runTaskLinks.push(link);
        data.chatTaskLinks.push(chatLink);
        this.#emit(task.projectId, { type: 'chat.upserted', chat });
        this.#saveRun(run);
        this.#emit(task.projectId, { type: 'link.chatTask', link: chatLink, present: true });
        this.#emit(task.projectId, { type: 'link.runTask', link, present: true });

        // Like the daemon (`syncTasks`): a run that starts moves a task that waits, To do or Backlog, to the first active status, and no other task; a task that is closed,
        // or is in progress or in review already, stays where it is.
        if (categoryOf(task) === 'todo' || categoryOf(task) === 'backlog') moveTo('active');

        this.#appendItem(run, { kind: 'user', text: `Work on ${ task.key }: ${ task.title }.` });
        this.#later(500, () => this.#streamReply(run, `I will start on ${ task.key } by reading the code around it.`));
        this.#later(2500, () => {
            run.status = 'succeeded';
            run.result = `Finished ${ task.key }.`;
            run.finishedAt = Date.now();
            this.#saveRun(run);

            // And a run that finishes moves a task that is in progress to review, as long as someone has not moved it elsewhere meanwhile.
            if (data.tasks.includes(task) && categoryOf(task) === 'active') moveTo('review');
        });

        // Like the daemon: `{ runId, chatId }`.
        return ok({ runId: run.id, chatId: chat.id });
    }

    #cancelRun(runId: RunId): Outcome {
        const data = this.#data;
        const target = data.runs.find(candidate => candidate.id === runId);

        if (!target) return fail('not_found', 'No such run');

        // Like the daemon: a sub-agent of a session is stopped alone when its session can end it, and refused when it cannot.
        if (target.origin === 'native' && !isTerminalRunStatus(target.status)) {
            if (!target.canStopAlone) return fail('conflict', 'A sub-agent runs inside its parent run; cancel the parent run instead');

            this.#endRun(target);

            return ok({ cancelled: [runId] });
        }

        const cancelled = this.#subtree(runId);

        for (const run of data.runs.filter(candidate => cancelled.has(candidate.id) && !isTerminalRunStatus(candidate.status))) {
            this.#endRun(run);
        }

        return ok({ cancelled: [...cancelled] });
    }

    /** Like the daemon's `run.stopAgents`: the sub-agents of the orchestrator's session that can stop alone stop; the orchestrator itself goes on, and so does its queue. */
    #stopAgents(runId: RunId): Outcome {
        const data = this.#data;

        if (!data.runs.some(candidate => candidate.id === runId)) return fail('not_found', 'No such run');

        const stopped: RunId[] = [];

        for (const id of this.#subtree(runId)) {
            const run = data.runs.find(candidate => candidate.id === id)!;

            if (id !== runId && run.canStopAlone && !isTerminalRunStatus(run.status)) {
                this.#endRun(run);
                stopped.push(id);
            }
        }

        return ok({ stopped });
    }

    /**
     * Like the daemon's `run.stopBackground`: one background command that its agent lets be stopped alone leaves the run's list and the stream says it was
     * stopped; the run and its other work go on. `stopped: false` for an item that is gone, cannot be stopped alone, or belongs to a run that ended.
     */
    #stopBackground(runId: RunId, itemId: string): Outcome {
        const run = this.#data.runs.find(candidate => candidate.id === runId);

        if (!run) return fail('not_found', 'No such run');

        const item = run.background?.find(candidate => candidate.id === itemId);

        if (!item?.canStopAlone || item.kind === 'subagent' || isTerminalRunStatus(run.status)) return ok({ stopped: false });

        const rest = (run.background ?? []).filter(candidate => candidate.id !== itemId);

        if (rest.length > 0) run.background = rest;
        else delete run.background;

        this.#saveRun(run);
        this.#appendItem(run, { kind: 'note', text: `Background command stopped: ${ item.title }` });

        return ok({ stopped: true });
    }

    /** The run and every run below it. */
    #subtree(runId: RunId): Set<RunId> {
        const { runs } = this.#data;
        const found = new Set([runId]);

        for (let size = 0; size !== found.size;) {
            size = found.size;
            runs.filter(run => run.parentRunId && found.has(run.parentRunId)).forEach(run => found.add(run.id));
        }

        return found;
    }

    /** A run is cancelled: what it had open in the background ends with it, a call it left running is stopped, and a stopped orchestrator holds its chat's queue. */
    #endRun(run: Run): void {
        const data = this.#data;

        run.status = 'cancelled';
        run.statusReason = undefined;
        // A run that ended has nothing open in the background: stopping it ends that work too.
        delete run.background;
        run.finishedAt = Date.now();
        this.#saveRun(run);

        // A sub-agent that stopped leaves its parent's list of open work.
        const parent = run.origin === 'native' ? data.runs.find(candidate => candidate.id === run.parentRunId) : undefined;

        if (parent?.background && run.parentToolCallId) {
            parent.background = parent.background.filter(item => item.id !== run.parentToolCallId);
            this.#saveRun(parent);
        }

        for (const item of data.items[run.id] ?? []) {
            if (item.body.kind === 'tool' && item.body.state === 'running') this.#saveItem(run, { ...item, body: { ...item.body, state: 'error', error: STOPPED_TOOL } });
        }

        // Stop holds the queue of the chat whose orchestrator it stopped.
        const chat = data.chats.find(candidate => candidate.orchestratorRunId === run.id);

        if (chat?.queue?.length) {
            chat.queuePaused = 'stopped';
            this.#settleQueue(chat);
        }
    }

    #answerQuestion(runId: RunId, questionId: string, answer: string): Outcome {
        const run = this.#data.runs.find(candidate => candidate.id === runId);
        const item = this.#data.items[runId]?.find(candidate => candidate.body.kind === 'question' && candidate.body.questionId === questionId);

        if (!run || !item || item.body.kind !== 'question') return fail('not_found', 'No such question');

        this.#saveItem(run, { ...item, body: { ...item.body, answer } });

        // The run goes on only when no card is left to answer: a request for permission that still waits keeps it waiting, as it does in the daemon, which counts both.
        if (!this.#hasOpenCard(runId)) {
            run.status = 'running';
            run.statusReason = undefined;
            this.#saveRun(run);
            this.#later(500, () => this.#streamReply(run, `Thanks. I will go with "${ answer }" and continue.`));
        }

        return ok();
    }

    /** A question without an answer, or a request for permission that is open: what keeps a run in `waiting_user`. */
    #hasOpenCard(runId: RunId): boolean {
        return (this.#data.items[runId] ?? []).some(candidate => (candidate.body.kind === 'approval' && candidate.body.state === 'open') || (candidate.body.kind === 'question' && candidate.body.answer === undefined));
    }

    #decideApproval(runId: RunId, approvalId: string, decision: ApprovalDecision): Outcome {
        const run = this.#data.runs.find(candidate => candidate.id === runId);
        const items = this.#data.items[runId] ?? [];
        const item = items.find(candidate => candidate.body.kind === 'approval' && candidate.body.approvalId === approvalId);

        if (!run || !item || item.body.kind !== 'approval') return fail('not_found', 'No such approval');

        if (item.body.state !== 'open') return fail('conflict', 'This approval has already been decided or withdrawn');

        if (!item.body.decisions.includes(decision)) return fail('invalid', 'The agent did not offer that answer');

        this.#saveItem(run, { ...item, body: { ...item.body, state: 'decided', decision } });

        // The run goes back to work when no card is left to answer, a question's included.
        if (run.status === 'waiting_user' && !this.#hasOpenCard(runId)) {
            run.status = 'running';
            run.statusReason = undefined;
            this.#saveRun(run);
        }

        return ok({ runId });
    }
}
