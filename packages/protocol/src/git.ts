/**
 * What the daemon reads of a place's git: the status of its working tree, how far its branch is from its base, the files that changed in a scope, the two texts of
 * one of them, and the pull request of its branch. A place is a folder's own checkout or a worktree of it (`resolvePlace`), named by `folderId` and an optional
 * `workspaceId` as the file routes name it. Every route is a read: nothing here writes to a repository or takes its index lock, and only the pull request goes to the
 * network, through the person's own `gh` (no token is kept or read by the daemon).
 *
 * GET  /v1/projects/:id/git/status?folderId=&workspaceId=
 *                                      -> GitStatus. The branch (or the detached or unborn HEAD), its upstream with ahead and behind, the files that are not
 *                                         committed (one entry per path, at most `MAX_GIT_STATUS_ENTRIES`, a new file listed one by one) and `base`, the
 *                                         comparison with the branch the work is meant for (see `GitBase`). A folder that is not the root of a working tree
 *                                         answers `isRepository: false` and nothing else, as `FolderGit` does.
 * GET  /v1/projects/:id/git/changes?folderId=&workspaceId=&scope=
 *                                      -> GitChanges. The files that changed in `scope` (`all` when it is left out), each with its line counts and revision.
 *                                         `scope` is a `GitScope`; a commit the repository does not have is `not_found`, a scope that is none is `invalid`.
 * GET  /v1/projects/:id/git/file?folderId=&workspaceId=&scope=&path=&oldPath=&from=
 *                                      -> GitFileSides. The text of one changed file before and after, for a diff to be drawn from. `path` is the file as it is
 *                                         after the change and `oldPath` the one it had before when the change renamed it (`GitChangedFile.oldPath`). A path
 *                                         that did not change in the scope is `not_found`; a path that is none (empty, absolute, with `.`, `..` or an empty part,
 *                                         or ending in `/`) and a folder that is not the root of a working tree are `invalid`. `from` is the `GitChanges.from` of
 *                                         the list the file comes from (a hash, 7 to 64 hexadecimal digits): the scope then starts at that commit and the daemon
 *                                         looks up no base, merge base or parent, so a file is never drawn against another start than its list was counted from
 *                                         (the list sends none for a root commit or an unborn branch, and the read computes it as before). A `from` that is not a
 *                                         hash is `invalid`, and one that is no commit of the repository is `not_found`.
 * GET  /v1/projects/:id/git/pull-request?folderId=&workspaceId=
 *                                      -> GitPullRequestInfo. Whether GitHub can be asked about the place (`gh` found and signed in for the host of `origin`) and
 *                                         the pull request of the branch checked out, with its checks. Read by one `gh` call per branch and kept for a few
 *                                         seconds, so several windows asking at once cost one. A branch with no pull request is `access: 'ready'` and no
 *                                         `pullRequest`; a `gh` call that fails (it timed out, GitHub is out of reach or answers an error, the rate limit)
 *                                         is `unavailable` with a short reason, never an empty answer.
 * GET  /v1/projects/:id/git/viewed?folderId=&workspaceId=&scope=
 *                                      -> GitViewedMark[]. The files the person marked as viewed in `scope` of the place (`all` when it is left out), each with the
 *                                         revision it had when it was marked, in path order. The daemon only keeps them, in its own database (not in the repository, and
 *                                         never sent to GitHub): whether a file still counts as viewed is for the client to say, by comparing the mark's revision with
 *                                         the file's own in the list (`GitChangedFile.revision`), so an edit clears the mark with no read.
 * POST /v1/projects/:id/git/viewed     -> GitViewedMark. Body `GitViewedSet` (`folderId`, `workspaceId?`, `scope`, `path`, `revision`): marks one file, replacing the
 *                                         mark it had.
 * DELETE /v1/projects/:id/git/viewed?folderId=&workspaceId=&scope=&path=
 *                                      -> { ok: true }. Clears the mark of one file; a file with none is cleared all the same.
 *                                         The key a mark is kept under is never taken from the client: the daemon builds it from `scope` and, for `all` and `branch`,
 *                                         the base the place is compared with (`GitViewedMark`). `path` is checked as the file route checks it (and is at most
 *                                         `MAX_GIT_VIEWED_PATH_LENGTH` characters), `revision` is at most `MAX_GIT_REVISION_LENGTH` characters of a revision's alphabet, and a
 *                                         place keeps at most `MAX_GIT_VIEWED_MARKS` marks over all its scopes, the newest. A folder that is not the root of a working tree is
 *                                         `invalid`, as for the file route, and a commit scope the repository does not have is `not_found`.
 *
 * The first three answer `invalid` for no `folderId`, `not_found` for a folder or a workspace that is not the project's, and `unavailable` for a folder or a worktree
 * that is gone from the disk or not made yet and for a git that does not answer in time; the fourth and the viewed routes answer the same.
 */

/**
 * Which changes a read covers, and what each is counted against:
 * - `all`: the working tree against the merge base with the base branch, so what is committed on the branch, what is staged or edited, and what is new;
 * - `branch`: HEAD against the merge base, what is committed on the branch;
 * - `uncommitted`: the working tree against HEAD, what is staged or edited, and what is new;
 * - `commit:<sha>`: that commit alone, against its first parent (a root commit against nothing).
 * With no base branch to compare with, `all` counts as `uncommitted` and `branch` is empty (`GitChanges.baseState` says so).
 */
export type GitScope = 'all' | 'branch' | 'uncommitted' | `commit:${ string }`;

/** What a commit scope's text starts with. */
export const GIT_COMMIT_SCOPE_PREFIX = 'commit:';

/** The scope of one commit, by the hash `GitCommit.sha` gives. */
export const commitScope = (sha: string): GitScope => `${ GIT_COMMIT_SCOPE_PREFIX }${ sha }`;

/** A scope as a route's query writes it: one of the three words, or `commit:` and 7 to 64 hexadecimal digits (a hash, short or whole). Nothing for anything else. */
export function parseGitScope(text: string): GitScope | undefined {
    if (text === 'all' || text === 'branch' || text === 'uncommitted') return text;

    return text.startsWith(GIT_COMMIT_SCOPE_PREFIX) && /^[0-9a-f]{7,64}$/i.test(text.slice(GIT_COMMIT_SCOPE_PREFIX.length)) ? commitScope(text.slice(GIT_COMMIT_SCOPE_PREFIX.length).toLowerCase()) : undefined;
}

/** The most entries `GitStatus.entries` lists: a working tree with more is cut, and `truncated` says so. */
export const MAX_GIT_STATUS_ENTRIES = 1000;

/** The most files `GitChanges.files` lists: a scope with more is cut at the first paths, and `truncated` says so; `fileCount` and the totals still count them all. */
export const MAX_GIT_CHANGED_FILES = 500;

/** The most commits `GitBase.commits` lists, newest first; `ahead` says how many there are. */
export const MAX_GIT_COMMITS = 100;

/** The most bytes of a file's text, on either side, that `GET .../git/file` sends: a file with a side over it is `too_large`, and sends no text. */
export const MAX_GIT_SIDE_BYTES = 512 * 1024;

/** The most lines a file may change to be drawn: a file that changes more is `tooLarge`, and sends no text. */
export const MAX_GIT_DIFF_LINES = 20_000;

/** How git names what happened to a path. A new file git does not track yet is `added` too (`untracked` says it is not in the index). `conflicted` is what a status says of an unmerged path; a diff says `modified` of it. */
export type GitChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'conflicted';

/** Where HEAD is: on a branch, on a commit that no branch holds, or on a branch with no commit yet. */
export type GitHead =
    | { kind: 'branch'; name: string; commit: string }
    | { kind: 'detached'; commit: string }
    | { kind: 'unborn'; name: string };

/** The branch a branch is set to track, and how far apart they are as last fetched (nothing here fetches). */
export interface GitUpstream {
    /** As git writes it: `origin/main`. */
    name: string;
    /** Commits the branch has that the upstream does not. */
    ahead: number;
    /** Commits the upstream has that the branch does not. */
    behind: number;
    /** The upstream is configured, but the branch it names is not in the repository (deleted on the remote and pruned): `ahead` and `behind` are 0. */
    gone?: true;
}

/** One path that is not committed. A path that is staged and edited again has both `staged` and `unstaged`. */
export interface GitStatusEntry {
    /** Relative to the root of the working tree, with `/` separators. */
    path: string;
    /** Where a renamed or copied path came from. */
    oldPath?: string;
    /** What the index holds against HEAD; absent when the index is as HEAD. */
    staged?: GitChangeKind;
    /** What the working tree has against the index; absent when it is as the index. An unmerged path is `conflicted`, here only. */
    unstaged?: GitChangeKind;
    /** A new file that git does not track; it has no `staged` and no `unstaged`. */
    untracked?: true;
}

/** One commit of the branch's own work. */
export interface GitCommit {
    /** In full. */
    sha: string;
    /** The first 7 characters. */
    shortSha: string;
    /** The first line of the message. */
    subject: string;
    /** The author's name. */
    author: string;
    /** When it was committed, in milliseconds. */
    committedAt: number;
}

/**
 * How the branch stands against the branch it is meant for: the base of its worktree when it has one, else the folder's base (`FolderGit.defaultBranch`). The ref is picked
 * as GitHub Desktop and bb do: `origin/<name>` when the local branch of that name is equal to it, behind it or not there, the local branch when it is ahead of it or has
 * diverged. A name that already says its remote (`origin/main`) or is a full ref is taken as it is. Everything is read from the refs the repository has: nothing is fetched,
 * so a base that moved on the remote shows when the person fetches.
 */
export type GitBase =
    | {
        state: 'ready';
        /** The ref compared with, short: `origin/main`, or `main`. */
        name: string;
        /** The commit it is at. */
        commit: string;
        /** The last commit that HEAD and the base have in common. */
        mergeBase: string;
        /** Commits HEAD has that the base does not: the branch's own work. */
        ahead: number;
        /** Commits the base has that HEAD does not. */
        behind: number;
        /** The branch's own work, newest first, at most `MAX_GIT_COMMITS`: shorter than `ahead` when it was cut. */
        commits: GitCommit[];
    }
    /** HEAD has no commit yet, so there is nothing to compare. */
    | { state: 'unborn' }
    /** The repository has no ref to compare with (no other branch, no remote); `name` is the branch that was asked for and is not there. */
    | { state: 'no_base'; name?: string }
    /** HEAD and the base share no history. */
    | { state: 'no_merge_base'; name: string; commit: string };

/** What `GitBase.state` can be. */
export type GitBaseState = GitBase['state'];

/** What `GET /v1/projects/:id/git/status` says of a place: its branch, its uncommitted files and how far it is from its base, or that it is no repository. */
export type GitStatus = { isRepository: false } | {
    isRepository: true;
    head: GitHead;
    /** The branch's upstream; absent on a branch that tracks nothing, on a detached HEAD and on an unborn branch. */
    upstream?: GitUpstream;
    /** The repository has a remote called `origin`, the only remote the app pushes to. */
    origin: boolean;
    /** The uncommitted paths, sorted as git lists them, at most `MAX_GIT_STATUS_ENTRIES`. Empty for a clean tree. */
    entries: GitStatusEntry[];
    /** `entries` was cut: the tree has more uncommitted paths than are listed. */
    truncated?: true;
    base: GitBase;
};

/** One file that changed in a scope. */
export interface GitChangedFile {
    /** Relative to the root of the working tree, with `/` separators; the path after the change. */
    path: string;
    /** The path before the change, for a renamed or copied file. */
    oldPath?: string;
    kind: GitChangeKind;
    /** A new file that git does not track (a part of `all` and `uncommitted`); its `kind` is `added`. */
    untracked?: true;
    /** Lines added and removed. Absent for a binary file and for a file whose lines were not counted (`GitChanges.statsComplete`). */
    additions?: number;
    deletions?: number;
    /** Git takes it for a binary file: it has no lines and sends no text. */
    binary?: true;
    /** Too big to draw (`MAX_GIT_DIFF_LINES` changed lines, or a side over `MAX_GIT_SIDE_BYTES`): it sends no text. */
    tooLarge?: true;
    /**
     * `<oldMode>:<oldBlob>:<newMode>:<newBlob>`: the mode and the content id of the file on each side, with zeros where a side is not there. The id of a file in the working
     * tree is the one git would give it (`git hash-object`), so any edit changes the revision. Two reads that find the file the same give the same string, which is what
     * a mark of "viewed" is kept against.
     */
    revision: string;
}

/** What `GET /v1/projects/:id/git/changes` says: the files that changed in a scope, or that the place is no repository. */
export type GitChanges = { isRepository: false } | {
    isRepository: true;
    scope: GitScope;
    /** The commit the changes are counted from: the merge base for `all` and `branch`, HEAD for `uncommitted`, the parent for one commit. Absent when it is counted from nothing (a root commit, an unborn branch, no base). */
    from?: string;
    /** For `all` and `branch`: how the base stood. Anything but `ready` means there was no merge base to count from. */
    baseState?: GitBaseState;
    /** Sorted by path, at most `MAX_GIT_CHANGED_FILES`. */
    files: GitChangedFile[];
    /** Files that changed, whether or not they are listed. At least the number listed. */
    fileCount: number;
    /** Lines added and removed in all of them. */
    additions: number;
    deletions: number;
    /** False when some file's lines were not counted (a new file past the budget the daemon spends on those, or one too big to read), so the totals are a lower bound. */
    statsComplete: boolean;
    /** `files` was cut, or the new files were more than the daemon lists: there are more changed files than `fileCount` says. */
    truncated?: true;
};

/** What `GET /v1/projects/:id/git/file` says of one file: its text before and after, or why it sends none. */
export type GitFileSides =
    | {
        state: 'text';
        /** The file before the change; null when it was not there (a new file). On a working-tree scope it has gone through git's checkout filters, so its line endings match the file on disk. */
        original: string | null;
        /** The file after the change; null when it is not there any more (a deleted file). For a working-tree scope, the file on disk. */
        modified: string | null;
        /** The file's `GitChangedFile.revision`. */
        revision: string;
    }
    /** Git takes it for a binary file, or it is a submodule or a link to nothing git can read: no text. */
    | { state: 'binary'; revision: string }
    /** A side is over `MAX_GIT_SIDE_BYTES`, or the file changes more than `MAX_GIT_DIFF_LINES` lines: no text. */
    | { state: 'too_large'; revision: string };

/**
 * The most marks of viewed files the daemon keeps for a place, over all its scopes: when a mark is set past it, the oldest are dropped, so the table of a person who marks for
 * months stays small. A scope lists at most a list's worth of files (`MAX_GIT_CHANGED_FILES`), so nobody reaches it by reading.
 */
export const MAX_GIT_VIEWED_MARKS = 5000;

/** The most characters of a revision a mark takes: `<mode>:<id>:<mode>:<id>` is 143 characters of a SHA-256 repository's, and the working-tree stand-in `stat-<size>-<mtime>` less. */
export const MAX_GIT_REVISION_LENGTH = 256;

/** The most characters of a path a mark takes. */
export const MAX_GIT_VIEWED_PATH_LENGTH = 4096;

/**
 * One file the person marked as viewed, with the revision it had then (`GitChangedFile.revision`). A file counts as viewed only while its revision in the list is the one stored,
 * so any later edit clears the mark by itself. The daemon keeps the marks under the place, the file's path and a key it makes of the scope: `uncommitted`, `branch:<base>`,
 * `all:<base>` (`<base>` is the ref the place is compared with, `GitBase.name`, such as `origin/main`; empty when the place has none) or `commit:<full hash>`. A mark is therefore
 * the person's own for that comparison: another scope, another base, another worktree and another folder have their own, and a worktree that is removed takes its marks along.
 */
export interface GitViewedMark {
    path: string;
    revision: string;
}

/** The body of `POST /v1/projects/:id/git/viewed`: the place, the scope and the file with the revision to keep. */
export interface GitViewedSet {
    folderId: string;
    workspaceId?: string;
    scope: GitScope;
    path: string;
    revision: string;
}

/** Whether GitHub can be asked about a place: `gh` is found and signed in for the host of the place's `origin` (`ready`), is not installed (`no_gh`), has no login for the host (`not_signed_in`), or the place has no `origin` that names a repository as `host/owner/repo` (`no_remote`). */
export type GitHubAccess = 'ready' | 'no_gh' | 'not_signed_in' | 'no_remote';

/** The repository a place's `origin` names, as `host/owner/name`: nothing else of the remote's address (a credential in it, a port of ssh) is kept. */
export interface GitHubRepo {
    /** `github.com`, or a GitHub Enterprise server's name (with its port when a web address of `origin` has one); lower case. */
    host: string;
    owner: string;
    name: string;
}

/** Where a pull request stands: `draft` is an open one not ready for review. */
export type GitPullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** How one check ended: `skipped` is a check that was not run on purpose (it does not count against the pull request); an unfinished one, or one that GitHub has not said how it ended, is `pending`. */
export type GitCheckState = 'passing' | 'failing' | 'pending' | 'skipped';

/** One check of the pull request's head commit: a check run or a commit status. */
export interface GitCheck {
    /** The check run's name, or the status's context. */
    name: string;
    state: GitCheckState;
    /** Where the check's own page is. */
    url?: string;
}

/** The checks of a pull request's head commit, one for each name (the latest run of it), and what they add up to. */
export interface GitChecks {
    /** `none` when no check ran, `failing` when one failed, else `pending` when one is not finished, else `passing`. */
    state: 'none' | 'passing' | 'failing' | 'pending';
    /** How many checks there are in each state. */
    passing: number;
    failing: number;
    pending: number;
    skipped: number;
    /** Failing first, then pending, passing and skipped; by name within a state. At most `MAX_GIT_CHECKS` (the first that GitHub lists). */
    items: GitCheck[];
    /** GitHub has more checks than `MAX_GIT_CHECKS`: `items` and the counts cover the first ones, and `state` is the worse of what they say and what GitHub says of all of them. */
    truncated?: true;
}

/** The most checks `GitChecks` lists: GitHub's first page of them. */
export const MAX_GIT_CHECKS = 100;

/** What reviewers have decided, when the repository asks for a review. */
export type GitReviewDecision = 'approved' | 'changes_requested' | 'review_required';

/** Whether an open pull request can be merged as it stands: `conflicts` with its base, `blocked` by a rule (a review, a check, a branch that is behind), else `mergeable`. Absent for a merged or closed one and while GitHub has not worked it out. */
export type GitMergeability = 'mergeable' | 'blocked' | 'conflicts';

/** The pull request of the place's branch, as far as the app shows it. */
export interface GitPullRequest {
    number: number;
    title: string;
    /** Its page on GitHub. */
    url: string;
    state: GitPullRequestState;
    /** The branch it is to be merged into (`main`), as GitHub names it, not a ref of the place's repository. */
    base: string;
    /** The branch it comes from, which is the branch the place has checked out. */
    head: string;
    /** The commit its branch is at on GitHub. */
    headCommit: string;
    /** When GitHub last changed it, in milliseconds. */
    updatedAt: number;
    reviewDecision?: GitReviewDecision;
    mergeability?: GitMergeability;
    checks: GitChecks;
}

/**
 * What `GET /v1/projects/:id/git/pull-request` says of a place: that it is no repository, or whether GitHub can be asked and the pull request of its branch. `repo` is there
 * whenever `origin` names one, also when `access` says `gh` is missing or not signed in (the app tells the person which host to sign in to). A branch with no pull request,
 * or with a merged or closed one that its HEAD has moved past, has none: `pullRequest` is absent. A detached HEAD and a branch with no commit have nothing to look up, so
 * `gh` is not run for them: `access` is `ready` (nothing known is in the way) and there is no `pullRequest`.
 */
export type GitPullRequestInfo = { isRepository: false } | {
    isRepository: true;
    access: GitHubAccess;
    repo?: GitHubRepo;
    pullRequest?: GitPullRequest;
};
