import type { FileSystemProvider, SearchService } from '@clowdy/file-manager/provider';
import type {
    AgentInfo,
    AgentModels,
    Attachment,
    ChatId,
    ChatWorkspaceRemoval,
    ClowdyEvent,
    Command,
    CommandResult,
    DocsTree,
    FolderGit,
    FolderId,
    FolderWorktrees,
    GitBranchDeleteRequest,
    GitBranchDeleteResult,
    GitBranches,
    GitBranchMergeRequest,
    GitBranchMergeResult,
    GitChanges,
    GitCommitResult,
    GitDiscardResult,
    GitFileSides,
    GitMessage,
    GitPullRequestInfo,
    GitPushRequest,
    GitRemoteResult,
    GitScope,
    GitStatus,
    GitSwitchRequest,
    GitSwitchResult,
    GitSyncProgress,
    GitSyncResult,
    GitSyncTarget,
    GitViewedMark,
    Health,
    ProjectFileMatch,
    ProjectId,
    ProjectInfo,
    ProjectSnapshot,
    RootSnapshot,
    RunId,
    SkillCatalog,
    StreamItem,
    TaskArchivePage,
    TaskCommentsPage,
    TaskDetail,
    TaskId,
    TerminalCreate,
    TerminalId,
    TerminalInfo,
    WorkspaceId,
} from '@clowdy/protocol';
import type { TerminalStream, TerminalStreamHandlers } from './terminalStream';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as the UI builds it. The transport adds the `requestId`. */
export type CommandInput = DistributiveOmit<Command, 'requestId'>;

/**
 * Which page of a paged read: how many rows (a whole number; the daemon holds it to 1 to 100 and answers 25 without one) and where to go on, the `nextCursor`
 * of the page before. Both absent is the first page.
 */
export interface PageQuery {
    limit?: number;
    cursor?: string;
}

/** A stream is read by its run, or by its chat (the chat's orchestrator run). */
export type StreamTarget = { runId: RunId } | { chatId: ChatId };

/**
 * State of the change feed.
 * - `connected`: events flow.
 * - `reconnecting`: the connection dropped; the transport keeps trying and resumes from the last cursor.
 * - `resync`: the daemon no longer holds the events after the cursor (HTTP 410). The subscription has ended;
 *   the caller reloads its snapshots and subscribes again.
 */
export type FeedStatus = 'connected' | 'reconnecting' | 'resync';

/** One folder of a project as the file manager uses it: a file system, and the search through its contents when the daemon has one (the file manager reads the files one by one without). */
export interface ProjectFileSystem extends FileSystemProvider {
    search?: SearchService;
}

/** A place by the ids the daemon takes: a folder of the project, and the worktree of it a chat works in when it has one (`workspaceId`), else the folder's own checkout. */
export interface PlaceRef {
    folderId: FolderId;
    workspaceId?: WorkspaceId;
}

/** The only way the UI talks to a daemon. */
export interface Transport {
    getRootSnapshot: () => Promise<RootSnapshot>;
    getProjectSnapshot: (projectId: ProjectId) => Promise<ProjectSnapshot>;
    /**
     * What the daemon reads about every project when asked: whether its folder is there, its git remote and branch, what it holds. In the order of the project list.
     * With a project id, that project alone.
     */
    getProjectsInfo: (projectId?: ProjectId) => Promise<ProjectInfo[]>;
    /**
     * What git says about one folder of a project: its branches, its default branch and its worktrees, or that the folder is no repository. Read when asked, never
     * pushed: a folder's branches and worktrees change in a terminal or by an agent. `unavailable` for a folder gone from the disk.
     */
    getFolderGit: (projectId: ProjectId, folderId: FolderId) => Promise<FolderGit>;
    /**
     * What git says of a place: its branch (or detached or unborn HEAD), its upstream, the files that are not committed and how far the branch is from its base
     * (`GitBase`), or that the folder is no repository. Read when asked, never pushed: a tree changes in a terminal or by an agent, and nothing is fetched from the remote.
     * Rejects with the daemon's reason: 404 for a folder or a worktree that is not the project's, 503 for one gone from the disk, not made yet, or a git that does not answer.
     */
    getGitStatus: (projectId: ProjectId, place: PlaceRef) => Promise<GitStatus>;
    /**
     * The files that changed in a scope of a place (`all`, `branch`, `uncommitted` or one commit), each with its lines, its revision and whether it is binary or too big to
     * draw. The list is cut at `MAX_GIT_CHANGED_FILES`; the count and the totals cover every file. Rejects as `getGitStatus` does, and with 404 for a commit the repository does not have.
     */
    getGitChanges: (projectId: ProjectId, place: PlaceRef, scope: GitScope) => Promise<GitChanges>;
    /**
     * The text of one changed file before and after, for a diff to be drawn from. `oldPath` is the path before a rename (`GitChangedFile.oldPath`). A binary file or one too big to
     * draw answers its state and no text. `from` is the list's own start (`GitChanges.from`): with it the file is read against that commit and the daemon looks up no base, so a
     * card cannot be drawn against another start than its list. Rejects as `getGitChanges` does, and with 404 for a path that did not change in the scope or a `from` that is no
     * commit, and 400 for a `from` that is no hash.
     */
    getGitFile: (
        projectId: ProjectId,
        place: PlaceRef,
        scope: GitScope,
        path: string,
        oldPath?: string,
        from?: string
    ) => Promise<GitFileSides>;
    /**
     * The files the person marked as viewed in a scope of a place, each with the revision (`GitChangedFile.revision`) the file had when it was marked, in path order. The daemon only
     * keeps them: a file is viewed only while its revision in the scope's list is the stored one, which the caller decides, so an edit clears the mark with no read. Read when asked,
     * never pushed. Rejects as `getGitStatus` does, with 400 for a place that is no repository and 404 for a commit the repository does not have.
     */
    getGitViewed: (projectId: ProjectId, place: PlaceRef, scope: GitScope) => Promise<GitViewedMark[]>;
    /** Marks a file as viewed at the revision the list gave it, replacing the mark it had, and answers what was kept. Rejects as `getGitViewed` does, and with 400 for a path or a revision that cannot be one. */
    setGitViewed: (
        projectId: ProjectId,
        place: PlaceRef,
        scope: GitScope,
        path: string,
        revision: string
    ) => Promise<GitViewedMark>;
    /** Clears a file's mark; a file with none is cleared all the same. Rejects as `setGitViewed` does. */
    clearGitViewed: (projectId: ProjectId, place: PlaceRef, scope: GitScope, path: string) => Promise<void>;
    /**
     * Commits the files of a place that the person ticked (`POST git/commit`): `git add` and `git commit -m <message>` of those paths alone, with the person's own git configuration, signing
     * and hooks included, so every other change of the place is left as it is. `paths` are `GitChangedFile.path`s of the place's uncommitted changes. Rejects with a `TransportError` carrying
     * the daemon's reason (git's own `fatal:`, `error:` or hook line, and `hint` when the line names the signing key): 400 for no paths, no message or a path that is not a changed file,
     * 409 for a merge in progress or a commit git refused, 503 for one that did not end in time. Not retried: a commit is not asked for twice.
     */
    commitGit: (
        projectId: ProjectId,
        place: PlaceRef,
        paths: string[],
        message: string,
        options?: { conclude?: true }
    ) => Promise<GitCommitResult>;
    /**
     * A commit message for the files of a place that the person ticked (`POST git/message`), written by the agent they turned `Commit messages` on for: one Conventional Commits subject.
     * Runs only when asked. Rejects with a `TransportError`: 400 for paths that are not changed files or when no agent has the switch on, 503 with `Couldn't write the message` when the agent
     * is signed out, its run failed or did not end in time.
     */
    generateGitMessage: (
        projectId: ProjectId,
        place: PlaceRef,
        paths: string[],
        signal?: AbortSignal
    ) => Promise<GitMessage>;
    /**
     * Discards the changes of the files of a place (`POST git/discard`): the daemon keeps a copy of what each holds now (for a few days, in its own data folder, never in the repository), and
     * then a file the last commit has goes back to it (staged and edited versions alike) while one it has not (a new file) is deleted, that file alone. `paths` are `GitChangedFile.path`s of the
     * place's uncommitted changes, at most `MAX_GIT_DISCARD_PATHS`, and the UI sends one file at a time. Answers what was discarded and where the copy is. Rejects with a `TransportError` carrying
     * the daemon's reason: 400 for a path that is not a changed file, a submodule, a file over the copy's limit, 409 for a file with merge conflicts or a git that refused (its own line), 503 when
     * the copy could not be made (nothing was discarded) or git did not end in time. Not retried: a discard is not asked for twice.
     */
    discardGit: (projectId: ProjectId, place: PlaceRef, paths: string[]) => Promise<GitDiscardResult>;
    /**
     * `git fetch origin` in a place (`POST git/fetch`, without the submodules' remotes): brings in what origin has, moves no branch and prunes nothing. Answers the branch's upstream as it stands, with how far apart the two are.
     * Rejects with a `TransportError` carrying git's own line (`conflict`, 409: no network, no permission, a hook) and `hint` when the line names the signing agent, 400 for a place that is no repository or
     * has no `origin`, 503 for one that did not end in about two minutes (a fingerprint that was waited for). Not retried.
     */
    fetchGit: (projectId: ProjectId, place: PlaceRef) => Promise<GitRemoteResult>;
    /** Fetches, integrates and publishes the chosen branch as one operation. Reports its phases while it runs. */
    syncGit: (
        projectId: ProjectId,
        place: PlaceRef,
        target: GitSyncTarget,
        onProgress?: (progress: GitSyncProgress) => void
    ) => Promise<GitSyncResult>;
    /**
     * Fetches origin and merges the place's branch with its upstream (`POST git/pull`): a fast-forward when the branch has nothing of its own, a merge commit when it does (`merged`). A merge that
     * stops on conflicts answers `{ state: 'conflicts' }`, which is not an error: the merge has started. Rejects as `fetchGit` does, and with 400 for a detached HEAD, a branch with no upstream or
     * one that tracks another remote, and 409 with git's line when an uncommitted change is in the way (nothing was started).
     */
    pullGit: (projectId: ProjectId, place: PlaceRef) => Promise<GitRemoteResult>;
    /**
     * Fetches origin and merges the place's base into the branch (`POST git/update`), the same base the Changes tab compares with. Already being that branch is 400. A merge that stops on
     * conflicts answers `{ state: 'conflicts' }`, as a pull's does. Rejects as `pullGit` does.
     */
    updateGit: (projectId: ProjectId, place: PlaceRef) => Promise<GitRemoteResult>;
    /**
     * Undoes a merge that is in progress (`POST git/abort`, `git merge --abort`). 400 when no merge is. Rejects as `fetchGit` does when git refuses.
     */
    abortGit: (projectId: ProjectId, place: PlaceRef) => Promise<GitRemoteResult>;
    /**
     * Sends the place's branch to its upstream on origin (`POST git/push`), or publishes it (`-u`, `published: true`) when it has none. Never forced, never with a tag. Rejects as `pullGit` does, and
     * with 409 and git's own line for a push that origin rejects (`! [rejected] main -> main (fetch first)`), a hook or no permission.
     */
    pushGit: (
        projectId: ProjectId,
        place: PlaceRef,
        expectedHead?: GitPushRequest['expectedHead']
    ) => Promise<GitRemoteResult>;
    /**
     * The branches a place can switch to (`GET git/branches`): the local ones with the current and the default one, the upstream and the worktree that has one checked out, the branches
     * only `origin` has, and the last few the place was on, newest first; or that the folder is no repository. Read when asked, never pushed, nothing fetched: a branch changes in a
     * terminal or by an agent. Rejects as `getGitStatus` does.
     */
    getGitBranches: (projectId: ProjectId, place: PlaceRef) => Promise<GitBranches>;

    deleteGitBranch: (
        projectId: ProjectId,
        place: PlaceRef,
        request: GitBranchDeleteRequest
    ) => Promise<GitBranchDeleteResult>;
    /**
     * Changes the branch of the folder's own checkout (`POST git/switch`): to an existing local branch, to one only `origin` has (a local branch that tracks it), or with `create` to a new branch
     * cut from the current branch or the default one. Never for a chat's worktree. Nothing is stashed or carried along: a change in the tree, a merge or rebase under way, a run working in the
     * place and a branch that another worktree has checked out are refused with the daemon's short reason. Rejects with a `TransportError`: 400 for a worktree place, a name that is no branch name, a
     * branch that does not exist or a new one that does, 409 for a refusal that is the repository's state (its `message` is the reason, and `hint` says how many files or what to do) or a switch git
     * refused, 503 for one that did not end in time. Not retried: a switch is not asked for twice. `warning` in the answer is what the person is told of a switch that was made: what a failed `post-checkout` hook said, or the commits a detached HEAD left on no branch.
     */
    switchGitBranch: (
        projectId: ProjectId,
        place: PlaceRef,
        branch: string,
        create?: GitSwitchRequest['create']
    ) => Promise<GitSwitchResult>;
    /** Previews or merges two branches of the place's repository, or finishes an action on the named destination. */
    branchMergeGit: (
        projectId: ProjectId,
        place: PlaceRef,
        request: GitBranchMergeRequest
    ) => Promise<GitBranchMergeResult>;
    /**
     * Every worktree of every folder of a project, with the chats that work in each, how many files are changed and whether its work is in the base: what the Manage worktrees
     * dialog lists. One entry per folder in the project's order, a folder that is no repository (or is gone) with no worktrees. Read when asked, never pushed: worktrees change
     * in a terminal or by an agent. Rejects with a `TransportError` of status 404 for a project the daemon does not have.
     */
    getProjectWorktrees: (projectId: ProjectId) => Promise<FolderWorktrees[]>;
    /**
     * Whether GitHub can be asked about a place (the person's `gh` found and signed in for the host of the place's `origin`: `access`) and the pull request of its branch with the
     * state of its checks, or none. Read when asked, never pushed: the daemon asks `gh` once per branch and keeps the answer for a few seconds, so several windows cost one call.
     * Rejects as `getGitStatus` does, and with 503 and the daemon's reason when `gh` could not read it (it timed out, GitHub is out of reach, the rate limit is reached): that
     * is no answer, and never "no pull request".
     */
    getGitPullRequest: (projectId: ProjectId, place: PlaceRef) => Promise<GitPullRequestInfo>;
    /**
     * Whether the chat's worktree may be removed together with the chat, which is what `chat.delete`'s `removeWorkspace` asks for: Clowdy made it, no other chat uses it, nothing in it
     * is uncommitted and its work is merged into its base. Read when the delete dialog opens, never pushed: a tree changes in a terminal or by an agent, and the daemon checks again
     * when the chat is deleted. `removable` is false for a chat with no worktree; rejects with a `TransportError` of status 404 for a chat the daemon does not have.
     */
    getChatWorkspaceRemoval: (chatId: ChatId) => Promise<ChatWorkspaceRemoval>;
    /** Follows the change feed after `cursor`. Returns what ends the subscription. */
    subscribe: (
        cursor: number,
        onEvent: (event: ClowdyEvent) => void,
        onStatus: (status: FeedStatus) => void
    ) => () => void;
    /**
     * Sends a command. The request id is made once per call and kept across the transport's own retries, so the
     * daemon acts once. A command the daemon refused resolves with `ok: false`; a daemon out of reach rejects.
     */
    command: (command: CommandInput) => Promise<CommandResult>;
    getItems: (target: StreamTarget, afterSeq?: number) => Promise<StreamItem[]>;
    getTaskDetail: (taskId: TaskId) => Promise<TaskDetail>;
    /**
     * `getTaskDetail` for the task a key such as `CAR-12` names in the project, an archived one too: how a key met in a message is read when the window does not hold the task.
     * Rejects with a `TransportError` of status 404 for what is not a key of that project (another prefix, no number, a number nobody has, an unknown project).
     */
    getTaskDetailByKey: (projectId: ProjectId, key: string) => Promise<TaskDetail>;
    /** A page of the task's comments, oldest first. Comments are not in the snapshot: read them when a task shows them, and again when `ProjectState.commentsRevision` of the task changes. */
    getTaskComments: (taskId: TaskId, page?: PageQuery) => Promise<TaskCommentsPage>;
    /** A page of the project's archived tasks, the ones the snapshot leaves out, newest archived first. */
    getArchivedTasks: (projectId: ProjectId, page?: PageQuery) => Promise<TaskArchivePage>;
    /**
     * The project's documents: one entry per folder, in the project's order, with the document sources it has (`.briefback`, `.clowdy/docs`, the roots of Spec Kit, OpenSpec and Kiro), each a Markdown tree; a folder with none has none.
     * With a `workspaceId` (a worktree of one of the folders, made) the entry of that worktree's folder lists the worktree's documents in place of the folder's own checkout's.
     */
    getDocsTree: (projectId: ProjectId, workspaceId?: WorkspaceId) => Promise<DocsTree>;
    /**
     * Files of the project's folders whose path contains every word of `query`, best match first, each with its folder and its path relative to that folder. With a `workspaceId`
     * (a worktree of one of the folders, made) the worktree's files are listed in place of its folder's own checkout's, the other folders as before.
     */
    getProjectFiles: (
        projectId: ProjectId,
        query: string,
        limit?: number,
        workspaceId?: WorkspaceId
    ) => Promise<ProjectFileMatch[]>;
    /**
     * One folder of the project as a file system, for the file manager to browse and edit; the daemon checks every path against the folder. Nothing is asked until the file system is used.
     * With a `workspaceId` (a worktree of that folder, made) it is the worktree's files, not the folder's own checkout's.
     */
    fileSystem: (projectId: ProjectId, folderId: FolderId, workspaceId?: WorkspaceId) => ProjectFileSystem;
    /** Stores a file in the project, to go with the next message of one of its chats. Rejects with a `TransportError` that carries the daemon's reason when it refuses. */
    uploadAttachment: (projectId: ProjectId, file: File) => Promise<Attachment>;
    /** The bytes of an attachment, to show it. */
    getAttachment: (projectId: ProjectId, attachmentId: string) => Promise<Blob>;
    /** Removes a file that was uploaded and not sent. */
    deleteAttachment: (projectId: ProjectId, attachmentId: string) => Promise<void>;
    /** The icon the daemon finds in the project's main folder (a favicon, an app icon), or `undefined` when there is none. */
    getProjectIcon: (projectId: ProjectId) => Promise<Blob | undefined>;
    /** The skills agents get: system and user ones, and with a project also that project's. */
    getSkills: (projectId?: ProjectId) => Promise<SkillCatalog>;
    /** What the daemon says about itself: the bundle version it runs, its protocol and since when it has been running. The request carries no token and no protocol header, so a daemon of another major answers too. */
    getHealth: () => Promise<Health>;
    /** Every agent the daemon knows, with who is signed in to it, its usage and its settings. */
    getAgents: () => Promise<AgentInfo[]>;
    /** The models an agent offers, with the reasoning levels of each. The daemon reads them from the agent's own program and keeps them for ten minutes. */
    getAgentModels: (agentId: string) => Promise<AgentModels>;
    /** The shells the daemon runs, those of one project when it is named: running ones and recently exited ones, oldest first. */
    listTerminals: (projectId?: ProjectId) => Promise<TerminalInfo[]>;
    /** Starts a shell in a folder of a project, at the given size. Rejects with a `TransportError` that carries the daemon's reason when it refuses. */
    createTerminal: (request: TerminalCreate) => Promise<TerminalInfo>;
    /** Ends the shell and forgets the terminal. */
    closeTerminal: (terminalId: TerminalId) => Promise<void>;
    /** Follows one terminal: its screen, its output and its end, and types into it. Reconnects by itself until the terminal is gone or the stream is closed. */
    openTerminal: (terminalId: TerminalId, handlers: TerminalStreamHandlers) => TerminalStream;
}

/** The daemon could not be reached, or answered something other than the contract. */
export class TransportError extends Error {
    /** `hint` is a short sentence beside the daemon's own `message`, for a failure it can explain (a git line that names the signing key). */
    constructor(
        message: string,
        readonly status?: number,
        readonly hint?: string
    ) {
        super(message);
        this.name = 'TransportError';
    }
}
