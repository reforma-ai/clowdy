/**
 * What the daemon reads of a place's git: the status of its working tree, how far its branch is from its base, the files that changed in a scope, the two texts of
 * one of them, and the pull request of its branch. A place is a folder's own checkout or a worktree of it (`resolvePlace`), named by `folderId` and an optional
 * `workspaceId` as the file routes name it. The reads (status, changes, file, pull request) write nothing to a repository and take no index lock, and only the pull request
 * goes to the network, through the person's own `gh` (no token is kept or read by the daemon). The writes (`POST .../git/commit`, `.../git/fetch`, `.../git/pull` and `.../git/push`) run the
 * person's own `git` with their configuration, signing included, one at a time for a place. `POST .../git/switch` changes the checkout's branch.
 * An explicitly confirmed branch deletion can also reach `origin`.
 *
 * GET  /v1/projects/:id/git/status?folderId=&workspaceId=
 *                                      -> GitStatus. The branch (or the detached or unborn HEAD), its upstream with ahead and behind and when the repository last
 *                                         fetched (`lastFetchedAt`, the time of the newest non-empty `FETCH_HEAD`), the files that are not
 *                                         committed (one entry per path, at most `MAX_GIT_STATUS_ENTRIES`, a new file listed one by one) and `base`, the
 *                                         comparison with the branch the work is meant for (see `GitBase`). A folder that is not the root of a working tree
 *                                         answers `isRepository: false` and nothing else, as `FolderGit` does.
 * GET  /v1/projects/:id/git/changes?folderId=&workspaceId=&scope=
 *                                      -> GitChanges. The files that changed in `scope` (`all` when it is left out), each with its line counts and revision.
 *                                         `scope` is a `GitScope`; a commit the repository does not have is `not_found`, a scope that is none is `invalid`, and the scope of a run
 *                                         whose trees git has pruned is `unavailable`.
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
 * POST /v1/projects/:id/git/commit    -> GitCommitResult. Body `GitCommitRequest`: the ticked `paths` and the `message`. The daemon runs `git add -- <paths>` and then
 *                                         `git commit -m <message> -- <paths>` for the files that `GET .../git/changes?scope=uncommitted` lists as changed right now
 *                                         (a renamed file brings both its paths), so what else is changed or staged in the place is left as it is. The person's git
 *                                         configuration applies (signing, hooks: nothing is skipped). A message that is empty or over `MAX_GIT_MESSAGE_CHARS`, no paths,
 *                                         a path that is not a changed file of the place and a folder that is not a repository are `invalid`; a merge, a cherry-pick or a revert
 *                                         in progress (unless `conclude` finishes a merge that has no conflict left), a file with merge conflicts and a commit git refuses (a hook that fails, no signature, no identity) are `conflict`
 *                                         with git's first `fatal:`, `error:` or hook line as the message and, for a signing key that cannot be used, `details.hint`
 *                                         (`GitErrorDetails`); a commit that did not end in time is `unavailable`.
 * POST /v1/projects/:id/git/message   -> GitMessage. Body `GitMessageRequest`: the ticked `paths`. The first line of a Conventional Commits message for them, written by
 *                                         the agent the person turned `Commit messages` on for, in a run of its own with no tools: Codex when it is on and signed in,
 *                                         else (or when its run fails or does not end in time) Claude Code, asked once. Nothing runs unless this is called.
 *                                         `Couldn't write the message` when no agent is on and signed in, or every one that is fails or does not end in time
 *                                         (`unavailable`, or `invalid` for none on; `details.reason`: `off`, `signed_out`, `failed`, `timed_out`); the paths are judged as
 *                                         the commit judges them.
 * POST /v1/projects/:id/git/discard   -> GitDiscardResult. Body `GitDiscardRequest`: names at most `MAX_GIT_DISCARD_PATHS` changed files, never a whole tree. The paths are judged against
 *                                         what `GET .../git/changes?scope=uncommitted` lists right now (a renamed file brings its old path along) and inspected again before writing. A file git has in
 *                                         its last commit goes back to it (`git restore --source=HEAD --staged --worktree`); a file it has not (new, staged or not) is removed, only that file. No copy is kept.
 *                                         The person's own `post-checkout` hook runs as git runs it for a restore; a hook that fails after the files are back is told as `warning` of the answer.
 *                                         A path that is not a changed file or that escapes the place (`..`, an absolute path, a symbolic link in the way) or a submodule is `invalid`; a file with merge
 *                                         conflicts is `conflict` (`Resolve the conflict first`); git's own refusal is `conflict` with its first `fatal:` or `error:` line. One request at a time per place.
 *
 * POST /v1/projects/:id/git/fetch    -> GitRemoteResult. Body `GitRemoteRequest` (`folderId`, `workspaceId?`). `git fetch --no-recurse-submodules origin` and nothing else: no `--prune` of its own, no other
 *                                         remote, no submodule's. The answer carries the branch's upstream as it stands after the fetch (`upstream`, with `ahead` and `behind`), when it has one.
 * POST /v1/projects/:id/git/pull     -> GitRemoteResult. Same body. Fetches `origin`, then takes what the upstream has with `git merge --no-edit @{upstream}` (only for a branch whose upstream is the
 *                                         branch of its own name: one that tracks another, as `git switch -c feat origin/main` does, is `invalid`, since it is not published). A fast-forward when the
 *                                         branch has nothing of its own, a merge commit when it does (`merged`). A merge that stops on conflicts answers `state: 'conflicts'` (not an error): the merge
 *                                         has started and is left for the person. Nothing is rebased, reset or discarded. `pulled` says how many commits came in (0: already up to date).
 * POST /v1/projects/:id/git/update   -> GitRemoteResult. Same body. Fetches `origin`, then merges the place's base (`git merge --no-edit <base>`, the same base a comparison uses) into the branch.
 *                                         Refused when HEAD is that base branch, is detached or has no commit, and when there is no base. Already containing the base answers `pulled: 0`. Conflicts are
 *                                         `state: 'conflicts'`, as a pull's are.
 * POST /v1/projects/:id/git/abort    -> GitRemoteResult. Same body. `git merge --abort`, and only while a merge is in progress (`invalid` otherwise). Nothing else is touched.
 * POST /v1/projects/:id/git/push     -> GitRemoteResult. Same body. Sends the branch to the branch of its own name (`git push origin refs/heads/<branch>:refs/heads/<branch>`) when that is its upstream, and
 *                                         publishes it in every other case, when it has no upstream, its upstream is gone or its upstream is a branch of another name (`feat` made from `origin/main`
 *                                         is never sent to `main`): `git push -u origin refs/heads/<branch>:refs/heads/<branch>`, with `published: true` in the answer. Never forced, never with `--no-verify`, never with a tag.
 *                                         The three refuse (`invalid`) a place that is not a repository, a repository with no `origin` and, for pull and push, a detached HEAD, a branch with no
 *                                         commit and a branch whose upstream is not on `origin`. A refusal by git (a push that is rejected, a hook, no permission, no network) is `conflict`
 *                                         with git's own line as the message (the line that says what went wrong, not the summary that follows it), and a `details.hint` when it names the
 *                                         signing agent; one that does not end in about two minutes (a fingerprint that is waited for, a network that does not answer) is stopped and
 *                                         `unavailable`. They run on the place's one line of writes, so a commit and a push never overlap.
 *
 * GET  /v1/projects/:id/git/branches?folderId=&workspaceId=
 *                                      -> GitBranches. The branches of the place's repository a person may switch to: the local ones (the place's own, the default one, the upstream, the
 *                                         place that holds a branch another place has checked out, when the tip was committed), the branches of `origin` that have no local branch
 *                                         of their name, and the last few branches the place's HEAD was on (from its reflog). Read only, nothing fetched; no ahead and behind per branch.
 *                                         The merge picker also receives all fetched origin branches. A folder that is not the root of a working tree answers `isRepository: false`.
 *                                         The lists are cut at `MAX_GIT_BRANCH_ENTRIES` (`truncated`).
 * POST /v1/projects/:id/git/switch   -> GitSwitchResult. Body `GitSwitchRequest` (`folderId`, `workspaceId?`, `branch`, `create?`). Changes the branch of the checkout or worktree with
 *                                         `git switch`: to a local branch, to one that only `origin` has (a local branch of that name that tracks it), or to a new branch cut from the current
 *                                         HEAD or from the default branch (`create`). A chat worktree can switch when its current HEAD is contained in its base. A switch is refused
 *                                         while the tree has a change of any kind (tracked, staged or untracked), a merge, rebase, cherry-pick, revert or bisect is under
 *                                         way, a run is working in the place, or another worktree has the branch checked out; the person's hooks run as ever (a `post-checkout` that fails
 *                                         or hangs leaves the branch switched and is told as `warning`, as are the commits a detached HEAD left on no branch). A name that is no branch name, a branch that does not exist, one that is there already
 *                                         (`create`) and a folder that is not a repository are `invalid`; a refusal that is the repository's state and a switch git refused are `conflict`
 *                                         with a short reason as the message (and, for a change count or a way out, `details.hint`); one that did not end in time is `unavailable`.
 *
 * POST /v1/projects/:id/git/branch-delete -> GitBranchDeleteResult. Body: the place and a GitBranchDeleteRequest. Preview reports local and fetched origin tips, unmerged commits
 *                                         and a necessary checkout switch. Delete rechecks the confirmed tips, base and worktree protections. An origin deletion uses an explicit lease.
 * POST /v1/projects/:id/git/merge    -> GitBranchMergeResult. Body: the place and a GitBranchMergeRequest. Preview compares the selected source and local destination. Merge
 *                                         checks the previewed commits again, fast-forwards when possible, and otherwise merges in the destination checkout. A conflict identifies
 *                                         that checkout for resolution or abort. A separate push action sends the named destination and verifies its commit before sending.
 *
 * The first three reads answer `invalid` for no `folderId`, `not_found` for a folder or a workspace that is not the project's, and `unavailable` for a folder or a worktree
 * that is gone from the disk or not made yet and for a git that does not answer in time; the fourth and the viewed routes answer the same.
 */

/**
 * Which changes a read covers, and what each is counted against:
 * - `all`: the working tree against the merge base with the base branch, so what is committed on the branch, what is staged or edited, and what is new;
 * - `branch`: HEAD against the merge base, what is committed on the branch;
 * - `uncommitted`: the working tree against HEAD, what is staged or edited, and what is new;
 * - `commit:<sha>`: that commit alone, against its first parent (a root commit against nothing).
 * - `turn:<start>:<end>`: what a run of a chat changed, as the difference of two trees of the working directory that the daemon took when the run's turn started and when it ended
 *   (`ChatLastRun`). Nothing else decides it, so it stays what that run did whatever happens to the files, the branch and the index afterwards. In a place that other chats or the person
 *   edit too, it holds their edits of that time as well. A tree that git has pruned (it is kept as an object nothing refers to) makes a read of the scope `unavailable`.
 * With no base branch to compare with, `all` counts as `uncommitted` and `branch` is empty (`GitChanges.baseState` says so).
 */
export type GitScope = 'all' | 'branch' | 'uncommitted' | `commit:${string}` | `turn:${string}:${string}`;

/** What a commit scope's text starts with. */
export const GIT_COMMIT_SCOPE_PREFIX = 'commit:';

/** The scope of one commit, by the hash `GitCommit.sha` gives. */
export const commitScope = (sha: string): GitScope => `${GIT_COMMIT_SCOPE_PREFIX}${sha}`;

/** What a run's scope text starts with. */
export const GIT_TURN_SCOPE_PREFIX = 'turn:';

/** The scope of what one run changed: the ids of the tree it started from and the tree it ended with (`ChatLastRun.startTree`, `endTree`). */
export const turnScope = (startTree: string, endTree: string): GitScope =>
    `${GIT_TURN_SCOPE_PREFIX}${startTree}:${endTree}`;

/** The two tree ids a run's scope is made of, and nothing for any other scope. */
export function turnScopeTrees(scope: string): { startTree: string; endTree: string } | undefined {
    const found = /^turn:([0-9a-f]{40}|[0-9a-f]{64}):([0-9a-f]{40}|[0-9a-f]{64})$/.exec(scope);

    return found && found[1]!.length === found[2]!.length ? { startTree: found[1]!, endTree: found[2]! } : undefined;
}

/**
 * A scope as a route's query writes it: one of the three words, `commit:` and 7 to 64 hexadecimal digits (a hash, short or whole), or `turn:` and two whole tree ids (40 or 64
 * hexadecimal digits each, of one length) joined by `:`. Nothing for anything else.
 */
export function parseGitScope(text: string): GitScope | undefined {
    if (text === 'all' || text === 'branch' || text === 'uncommitted') return text;

    const trees = turnScopeTrees(text.toLowerCase());

    if (trees) return turnScope(trees.startTree, trees.endTree);

    return text.startsWith(GIT_COMMIT_SCOPE_PREFIX) &&
        /^[0-9a-f]{7,64}$/i.test(text.slice(GIT_COMMIT_SCOPE_PREFIX.length))
        ? commitScope(text.slice(GIT_COMMIT_SCOPE_PREFIX.length).toLowerCase())
        : undefined;
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
 * so: `origin/<name>` when the local branch of that name is equal to it, behind it or not there, the local branch when it is ahead of it or has
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
export type GitStatus =
    | { isRepository: false }
    | {
          isRepository: true;
          head: GitHead;
          /** The branch's upstream; absent on a branch that tracks nothing, on a detached HEAD and on an unborn branch. */
          upstream?: GitUpstream;
          /** The repository has a remote called `origin`, the only remote the app pushes to. */
          origin: boolean;
          /**
           * When the repository last fetched, in milliseconds: the newest `FETCH_HEAD` of the repository that has something in it, so a fetch made in any worktree of it, by the app
           * or by the person in a terminal or another program, counts (the remote-tracking refs, and with them `GitUpstream`'s counts, are shared by every worktree), or the time of the
           * daemon's own last fetch that went through, which it keeps in memory because a fetch that fails afterwards empties the files (git empties `FETCH_HEAD` before it connects). Absent
           * when nothing has fetched yet, when the repository has no `origin`, and when the only fetch since is a failed one that the daemon did not make or did before it started. A fetch of
           * another remote counts too, as the file's time.
           */
          lastFetchedAt?: number;
          /** The uncommitted paths, sorted as git lists them, at most `MAX_GIT_STATUS_ENTRIES`. Empty for a clean tree. */
          entries: GitStatusEntry[];
          /** `entries` was cut: the tree has more uncommitted paths than are listed. */
          truncated?: true;
          /**
           * A merge is in progress (`MERGE_HEAD`). `conflicts` is how many paths are still unmerged (0: they are resolved, and the merge can be committed). `subject` is the first line of the
           * message git prepared.
           */
          merging?: { conflicts: number; subject?: string };
          /** A rebase is paused in this checkout. */
          rebasing?: true;
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
export type GitChanges =
    | { isRepository: false }
    | {
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

/** Summary of the checks at a pull request’s head commit, using the latest run of each name. */
export interface GitChecks {
    /** `none` when no check ran, `failing` when one failed, else `pending` when one is not finished, else `passing`. */
    state: 'none' | 'passing' | 'failing' | 'pending';
    /** How many checks there are in each state. */
    passing: number;
    failing: number;
    pending: number;
    skipped: number;
    /** GitHub has more than `MAX_GIT_CHECKS` checks. The counts cover the first page and `state` also reflects GitHub’s total. */
    truncated?: true;
}

/** The maximum number of checks read from GitHub when computing summary counts. */
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
export type GitPullRequestInfo =
    | { isRepository: false }
    | {
          isRepository: true;
          access: GitHubAccess;
          repo?: GitHubRepo;
          pullRequest?: GitPullRequest;
      };

/**
 * A pull request opened from the branch, independent of the current checkout tip. Archive is local to Clowdy. `headCommit` is the commit its branch was at on GitHub, as the
 * history read saw it (a row kept from before the field existed has none). `movedPast` is set on the newest merged pull request, and only while no pull request is open or a draft, when the
 * branch has commits of its own since: work that is neither in that pull request's branch nor in its base, merges left out, so a squash merge, a base that moved, or a merge of the
 * base into the branch does not count. It is judged by the daemon on every answer from the branch as the repository has it, and says that this pull request is no longer the
 * state of the branch. Absent when it cannot be told (no `headCommit`, a commit the repository does not have, no local branch).
 */
export type GitPullRequestSummary = Pick<
    GitPullRequest,
    'number' | 'title' | 'url' | 'state' | 'base' | 'head' | 'updatedAt'
> & { archived?: true; headCommit?: string; movedPast?: true };

/** All pull requests from a repository's branch, newest first. A stale answer is kept when GitHub cannot be reached. */
export interface GitBranchPullRequests {
    branch: string;
    access: GitHubAccess;
    repo?: GitHubRepo;
    pullRequests: GitPullRequestSummary[];
    stale?: true;
}

export interface GitPullRequestArchiveRequest {
    folderId: string;
    branch: string;
    number: number;
    archived: boolean;
    /** The repository whose PR the user saw; a changed origin must not archive another repository's number. */
    repo: GitHubRepo;
}

/**
 * How a branch is moved. `fetch`, `pull` and `push` go to and from `origin` (publishing is a `push` of a branch that is not on origin under its own name). `update` merges the place's base into
 * the branch. `abort` undoes a merge that is in progress.
 */
export type GitRemoteAction = 'fetch' | 'pull' | 'push' | 'update' | 'abort';

/** The body of `POST /v1/projects/:id/git/fetch`, `.../pull`, `.../push`, `.../update` and `.../abort`: the place. */
export interface GitRemoteRequest {
    folderId: string;
    workspaceId?: string;
}

/** A push following a commit can require the checkout to still be on that commit and branch. */
export interface GitPushRequest extends GitRemoteRequest {
    expectedHead?: { branch: string; commit: string };
}

/** Sync uses the current checkout unless a completed merge names its destination checkout and tip. */
export type GitSyncTarget =
    | { branch: string; commit?: string; destination?: false }
    | { branch: string; commit: string; destination: true };

export type GitSyncRequest = GitRemoteRequest & GitSyncTarget;

/** The push phase identifies the tip after any incoming commits have been integrated. */
export type GitSyncProgress = { phase: 'fetch' | 'merge' } | { phase: 'push'; commit: string };

export type GitSyncResult =
    | { state: 'done'; branch: string; pulled: number; pushed: boolean }
    | { state: 'conflicts'; branch: string; path: string; conflicts: number };

/** SSE messages from POST .../git/sync in the order the operation reaches them. */
export type GitSyncEvent =
    | ({ type: 'phase' } & GitSyncProgress)
    | { type: 'result'; result: GitSyncResult }
    | { type: 'error'; status: number; message: string; hint?: string };

/**
 * What `GET /v1/git/clone-target?url=&folder=` says of where a clone would go, so the window can show the whole path before anything is cloned. `folder` is the one the
 * person chose (absent: the daemon's projects folder, where a folderless project goes). The target is `folder` itself when that is missing or an empty folder, which is
 * what the person means by "clone into this folder", and `folder/<repository>` when it holds anything: the name is the last part of `url` without `.git`.
 */
export interface GitCloneTarget {
    /** The folder the person chose, or the projects folder when none was: where the clone goes, in the person's words. */
    folder: string;
    /** The folder the repository would be cloned into, absolute. Absent while `url` names no repository (empty, or not an address git takes). */
    path?: string;
    /** Why a clone cannot go to `path` (it exists and is not an empty folder, it is a file); absent when it can. */
    blocked?: string;
}

/** The body of `POST /v1/git/clone`: the address and the absolute folder to clone into (what `GitCloneTarget.path` said). */
export interface GitCloneRequest {
    url: string;
    path: string;
}

/** SSE messages from `POST /v1/git/clone`. `progress` is git's own line (`Receiving objects`) with its percent when it gave one. Closing the request cancels the clone and removes what it made. */
export type GitCloneEvent =
    | { type: 'progress'; label: string; percent?: number }
    | { type: 'result'; path: string }
    | { type: 'error'; status: number; message: string; hint?: string };

/**
 * What a remote action did, so the client reads what it changed again. `upstream` is the branch's upstream as the action left it, with how far apart the two are (a push leaves 0
 * and 0); absent when the branch has none (a fetch on a branch that tracks nothing, a detached HEAD).
 */
export interface GitRemoteDone {
    state: 'done';
    action: GitRemoteAction;
    upstream?: GitUpstream;
    /** `pull` and `update`: how many commits came in; 0 when the branch already had them. */
    pulled?: number;
    /** `pull` and `update`: a merge commit was made, because the branch had commits of its own. Absent for a fast-forward. */
    merged?: true;
    /** `update`: the updated branch and its new tip, for a guarded follow-up sync. Absent when the base was already integrated. */
    updatedHead?: { branch: string; commit: string };
    /** `push`: the branch was not on origin under its own name (no upstream, a gone one, or another branch's), so it was published and now tracks `origin/<name>`. */
    published?: true;
}

/**
 * A pull or an update whose merge stopped on conflicts. Not an error: the merge has started (`MERGE_HEAD` is there) and is left for the person, who resolves the paths, commits the merge or
 * aborts it. `conflicts` is how many paths are still unmerged.
 */
export interface GitRemoteConflicts {
    state: 'conflicts';
    action: 'pull' | 'update';
    conflicts: number;
}

/** What `POST .../git/fetch`, `.../pull`, `.../push`, `.../update` and `.../abort` answer. */
export type GitRemoteResult = GitRemoteDone | GitRemoteConflicts;

/** The most entries each list of `GitBranches` (the local branches, the remote ones) holds: a repository with more is cut at the newest, and `truncated` says so. */
export const MAX_GIT_BRANCH_ENTRIES = 300;

/** How many of the branches the place's HEAD was on lately `GitBranches.recent` names. */
export const MAX_GIT_RECENT_BRANCHES = 5;

/** The place that has a branch checked out when it is not the one that asked: the folder's own checkout or a worktree a chat works in. */
export interface GitBranchHolder {
    /** Where the worktree is, as the machine writes it. */
    path: string;
    /** It is the folder's own checkout. */
    main?: true;
    /** The chat's worktree (`WorkspaceRecord.id`) when Clowdy keeps a record of it; absent for one that the person made. */
    workspaceId?: string;
}

/** A local branch of the place's repository. */
export interface GitLocalBranch {
    /** `feature/x`, as git names the branch (no `refs/heads/`). */
    name: string;
    /** The place's HEAD is on it. */
    current?: true;
    /** It is the default branch (`GitBranches.defaultBranch`). */
    default?: true;
    /** The branch it tracks, as git writes it (`origin/feature/x`); absent for a branch that tracks nothing. */
    upstream?: string;
    /** Another worktree has it checked out, so git would refuse a second checkout of it. Never set for the place's own branch. */
    heldBy?: GitBranchHolder;
    /** When the commit it points at was made, in milliseconds. */
    committedAt?: number;
}

/** A branch of `origin` that no local branch of the same name tracks yet: switching to it makes the local branch. */
export interface GitRemoteBranch {
    /** The branch's name on `origin`, without `origin/`: `feature/x`. */
    name: string;
    /** It is the default branch (`GitBranches.defaultBranch`), which has no local branch. */
    default?: true;
    /** When the commit it points at was made, in milliseconds. */
    committedAt?: number;
}

/** What `GET /v1/projects/:id/git/branches` says: the branches a place can switch to, or that the folder is no repository. */
export type GitBranches =
    | { isRepository: false }
    | {
          isRepository: true;
          /** The branch the folder's default branch is, without `origin/`: the base a new worktree starts from (`FolderGit.defaultBranch`), as a branch name. Absent in a repository with no commit. */
          defaultBranch?: string;
          /** Newest commit first. */
          local: GitLocalBranch[];
          /** Newest commit first; the branches of `origin` that have no local branch of their name. */
          remote: GitRemoteBranch[];
          /** All fetched branches of origin, including those with local counterparts. */
          origin?: GitRemoteBranch[];
          /** The branches the place's HEAD was on lately, newest first, at most `MAX_GIT_RECENT_BRANCHES`: local branches that still exist, the current one left out. */
          recent: string[];
          /** A list was cut at `MAX_GIT_BRANCH_ENTRIES`. */
          truncated?: true;
      };

/** The branch name is unqualified. A remote-only choice is previewed with remote: true. */
export type GitBranchDeleteRequest =
    | { action: 'preview'; branch: string; remote?: true }
    | {
          action: 'delete';
          branch: string;
          /** Delete only the local ref shown at this commit. */
          localCommit?: string;
          /** The confirmation showed a warning about unmerged local commits. */
          localUnmerged?: true;
          /** Delete the same-named branch on origin only if its tip is still this commit. */
          originCommit?: string;
          /** The confirmation showed a warning about unmerged commits on origin. */
          originUnmerged?: true;
          /** Switch away from the current branch to this destination before deleting. */
          switchTo?: string;
      };

export interface GitBranchDeletePreview {
    state: 'preview';
    branch: string;
    localCommit?: string;
    originCommit?: string;
    localUnmerged?: boolean;
    originUnmerged?: boolean;
    switchTo?: string;
    /** A reason the requested deletion cannot proceed. */
    blocked?: string;
}

export type GitBranchDeleteResult =
    | GitBranchDeletePreview
    | { state: 'done'; localDeleted: boolean; originDeleted: boolean; switchedTo?: string; warning?: string };

export const GIT_BRANCH_MERGE_STRATEGIES = ['merge', 'fast-forward-only', 'squash', 'rebase'] as const;
export type GitBranchMergeStrategy = (typeof GIT_BRANCH_MERGE_STRATEGIES)[number];

export interface GitBranchMergeSelection {
    direction: 'from' | 'into';
    /** The branch checked out when the dialog opened. */
    current: string;
    branch: string;
    /** The selected source is a ref on origin. The destination is always local. */
    remote?: true;
    /** Defaults to a regular merge with the destination's fast-forward policy. */
    strategy?: GitBranchMergeStrategy;
}

/** The body of POST /v1/projects/:id/git/merge, together with the place. */
export type GitBranchMergeRequest =
    | (GitBranchMergeSelection & { action: 'preview' })
    | (GitBranchMergeSelection & {
          action: 'merge';
          sourceCommit: string;
          targetCommit: string;
          expectedMode?: GitBranchMergePreview['mode'];
      })
    | { action: 'push'; target: string; commit: string }
    | { action: 'abort'; target: string; commit: string; sourceCommit: string; operation?: 'rebase' };

export interface GitBranchMergePreview {
    state: 'preview';
    source: string;
    target: string;
    sourceCommit: string;
    targetCommit: string;
    commits: number;
    mode: 'up-to-date' | 'fast-forward' | 'merge-commit' | 'squash' | 'rebase';
    /** The destination's Git configuration allows only fast-forward merges. */
    fastForwardOnly?: true;
    /** Destination commits that would be replayed in a rebase. */
    replayCommits?: number;
    /** Existing checkout of the destination, when there is one. */
    targetPath?: string;
    /** Preflight for a squash or outgoing merge in the existing destination checkout. */
    conflictCheck?: 'clean' | 'conflicts';
}

export type GitBranchMergeResult =
    | GitBranchMergePreview
    | { state: 'done'; target: string; commit: string; canPush: boolean }
    | {
          state: 'conflicts';
          target: string;
          commit: string;
          sourceCommit: string;
          targetPath: string;
          conflicts: number;
          operation?: 'rebase';
      }
    | { state: 'pushed'; target: string }
    | { state: 'aborted'; target: string; operation?: 'rebase' };

/** Where a new branch starts: at the place's HEAD, or at the repository's default branch. */
export type GitSwitchStart = 'current' | 'default';

/** The body of `POST /v1/projects/:id/git/switch`. */
export interface GitSwitchRequest {
    folderId: string;
    /** The ready chat worktree to switch, or omitted for the folder’s own checkout. */
    workspaceId?: string;
    /** The branch to be on: an existing one (local, or one that only `origin` has) or, with `create`, the name of the new one. */
    branch: string;
    /** Makes the branch from `start` and switches to it. It tracks nothing, so a push of it never goes to the branch it was cut from. */
    create?: { start: GitSwitchStart };
}

/** What a switch did: where the place's HEAD is now, so the client reads the rest again. */
export interface GitSwitchResult {
    head: GitHead;
    /** The branch's upstream: set when the branch was made from one on `origin`. */
    upstream?: GitUpstream;
    /** The branch was made by this switch (a new one, or a local one made for a branch of `origin`). */
    created?: true;
    /**
     * What the person is told of a switch that was made: what their `post-checkout` hook said when it failed after the switch (git reports its exit status as the switch's, though the branch has
     * changed) or that it did not finish in time, and the commits a detached HEAD left on no branch. Several are joined with `; `.
     */
    warning?: string;
}

/** The most paths a commit takes: the files `GitChanges.files` lists, which are what the person ticks from. */
export const MAX_GIT_COMMIT_PATHS = MAX_GIT_CHANGED_FILES;

/** The most characters of a commit message. */
export const MAX_GIT_MESSAGE_CHARS = 10_000;

/** The body of `POST /v1/projects/:id/git/commit`. */
export interface GitCommitRequest {
    folderId: string;
    workspaceId?: string;
    /** The files to commit, as `GitChangedFile.path` writes them: at most `MAX_GIT_COMMIT_PATHS`, each a changed file of the place's uncommitted changes. Ignored when `conclude` is set. */
    paths: string[];
    /** The whole message; its first line is the subject. At most `MAX_GIT_MESSAGE_CHARS`. */
    message: string;
    /** Finish the merge that is in progress, once no path is still unmerged. The commit is not limited to `paths`. */
    conclude?: true;
}

/** The commit that was made. */
export interface GitCommitResult {
    /** In full. */
    sha: string;
    /** The first 7 characters. */
    shortSha: string;
    /** The first line of the message. */
    subject: string;
}

/**
 * The most files one discard names. Discarding deletes work, so the route takes the files one by one and never a whole list; this is the largest handful the sidebar may send
 * (a renamed file counts once, though it brings its old path along).
 */
export const MAX_GIT_DISCARD_PATHS = 50;

/** The body of `POST /v1/projects/:id/git/discard`. */
export interface GitDiscardRequest {
    folderId: string;
    workspaceId?: string;
    /** The files to discard, as `GitChangedFile.path` writes them: at most `MAX_GIT_DISCARD_PATHS`, each a changed file of the place's uncommitted changes. */
    paths: string[];
}

/** One file a discard dealt with. */
export interface GitDiscardedFile {
    /** The path as `GitChangedFile.path` writes it. */
    path: string;
    /** `restored`: the file is back as the last commit has it (its staged and edited versions are gone); `removed`: git had no such file in the last commit, so it is deleted (and no longer staged). */
    action: 'restored' | 'removed';
}

/** What `POST /v1/projects/:id/git/discard` answers once the files are discarded. */
export interface GitDiscardResult {
    /** In the order they were sent; a renamed file is its new path, and its old one is not listed (it is back too). */
    discarded: GitDiscardedFile[];
    /** What the person is told besides: the line of their `post-checkout` hook, which failed (or did not end in time) after the files were put back. Every file is discarded all the same. */
    warning?: string;
}

/** The body of `POST /v1/projects/:id/git/message`. */
export interface GitMessageRequest {
    folderId: string;
    workspaceId?: string;
    /** The files that are about to be committed. */
    paths: string[];
}

/** A commit message the daemon had an agent write: one line, a Conventional Commits subject of at most 72 characters. */
export interface GitMessage {
    message: string;
}

/** Why `POST .../git/message` could not answer: no agent has `Commit messages` on, the one that has is not signed in, its run failed, or it did not end in time. */
export type GitMessageFailure = 'off' | 'signed_out' | 'failed' | 'timed_out';

/** What a failed git write may carry in `error.details`. */
export interface GitErrorDetails {
    /** A short sentence for the person, beside git's own line: `The signing agent couldn't be reached` when the line names the signing key. */
    hint?: string;
    /** For `POST .../git/message`. */
    reason?: GitMessageFailure;
}
