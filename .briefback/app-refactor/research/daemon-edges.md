# Daemon edges: git, file system, terminals, providers, skills, commands, CLI, attachments, docs

## Summary

These modules are carefully written and well commented. Argument handling is safe: there is no shell anywhere, request strings sit behind `--`, `--literal-pathspecs` or `-e`, branch names go through `check-ref-format`, and clone refuses `ext::` and leading dashes. The file routes walk links one component at a time. No option-injection or path-traversal hole was found. The problems are elsewhere:

- **Event-loop stalls.** The sync `git()` runs with no timeout inside a SQLite transaction and on each turn in a worktree. The docs tree is walked synchronously on every keystroke of the `@` menu. A busy terminal rewrites its log synchronously after every output batch. On Windows, every child process ends with two blocking `taskkill` runs.
- **Too many git processes per request.** One status request spawns 8 to 19 processes, a single "viewed" tick spawns 6 to 14, and `GET /git` runs a full `git status` per worktree, one after another.
- **Duplicated plumbing.** There are four process runners, three Windows tree-kill copies, four copies of the environment filter, seven path-containment helpers and six copies of the atomic settings write. Six git write services each carry their own runner, error check and stopper. In-progress detection, worktree listing, branch-name checks and ref lookups exist in 3 to 6 versions each. The shared process runner lives in `providers/`.
- **Correctness edges.** `gitLine` turns "git did not answer" into "no", so a timeout becomes a wrong diff. Commit argv can exceed the Windows command-line limit. File manager routes can write into `.git` or delete it permanently. Ripgrep drops results whose path starts with `..`.
- **Dead code.** The skills "user plugin" mirror is still built although nothing reads it.

## Findings

### F1. The sync `git()` runs with no timeout inside a SQLite transaction and on every turn in a worktree
- Where: `apps/daemon/src/domain/git.ts:21-43` (`git`: `timeoutMs` optional, no output cap, full `process.env`). Callers with no timeout: `apps/daemon/src/domain/projects.ts:231-249` (`initRepository`: `git init`, two `git config`, `git commit --allow-empty`), `domain/projects.ts:268` (`rev-parse --show-toplevel`), `apps/daemon/src/runs/driver.ts:146-156` (`commonGitDir`, reached from `additionalFolders` at `driver.ts:175` at each session start in a worktree).
- Problem (observed): `project.add` with no folders goes to `newFolderProject` (`projects.ts:198-224`) and then `initRepository`. It is a synchronous command, so it runs inside `store.tx` (`commands/index.ts:53-60`, `settle`). The initial commit passes `-c commit.gpgsign=false` but still runs the person's global `core.hooksPath`/`init.templateDir` hooks. A hook that waits, or a disk that does not answer, freezes the whole daemon (HTTP, SSE, terminals, runs) with the write transaction open, and no timeout ends it. `commonGitDir` blocks the event loop the same way. (Observed) The safe pattern already exists: `domain/workspaces.ts:62,65` passes a 10 s `SYNC_READ_TIMEOUT_MS` to every sync read.
- Fix: make `timeoutMs` required in `git()`, export `SYNC_READ_TIMEOUT_MS` from `domain/git.ts` and pass it everywhere. Make `commonGitDir` async (`gitLine`, 5 s) and await it in its caller. Ask the owner about `--no-verify` for the initial commit, which is Clowdy's own empty commit and not the person's work.
- Category: correctness | perf
- Effort: S. Risk: low

### F2. The docs tree is walked synchronously, uncached, on every keystroke of the `@` menu
- Where: `apps/daemon/src/docs/tree.ts:25-50` (`listDocs`: recursive `readdirSync`, up to `MAX_DOC_ENTRIES` = 20,000 per source), `docs/tree.ts:70-110` (`sourcesOf`, `docsTree`: per folder, per source, plus `realpathSync.native` in `docs/paths.ts:14-16`), `apps/daemon/src/http/routes.ts:837`. Caller: `apps/desktop/src/renderer/features/chats/useMentionTriggers.ts:57-66` (`onSearch` calls `getDocsTree` for every query).
- Problem (observed): each character typed after `@` makes the daemon walk every document source of every project folder with sync I/O, and nothing is cached. The file's own comment (`tree.ts:14`) names the "every key of the `@` menu" case but only caps it. (Inferred) A large `.briefback` or `specs` folder, or a slow disk, stalls all HTTP, SSE and terminal traffic once per keystroke. The file list in the same menu is cached for 5 s (`files/service.ts:12`).
- Fix: cache the tree per checkout for 5 s as `FilesService.list` does (see F26 for a shared TTL cache), and make `listDocs` async (`readdir` from `fs/promises`). The renderer should fetch once when the menu opens and filter locally (cross-area).
- Category: perf
- Effort: S. Risk: low

### F3. Every status, changes and viewed request rebuilds the base with 8-19 git processes
- Where: `apps/daemon/src/git/status.ts:326-368` (`placeStatus`), `status.ts:115-150` (`mergeBaseOf`), `status.ts:69-103` (`resolveRef`: 3 parallel `rev-parse` plus `merge-base --is-ancestor`), `status.ts:178-206` (`readBase`), `status.ts:315` (`hasOrigin`); `apps/daemon/src/git/state.ts:192-200` (`baseOf`: `symbolic-ref`, `for-each-ref`, `branch --show-current`, `rev-parse --short`); `git/viewed.ts:58`; `git/changes.ts:257`; `apps/daemon/src/http/routes.ts:232-236` (`gitBaseOf`, then `pullRequest.ts:380` `baseHint`, one more `branch --show-current`). Duplicate reads: `git/switch.ts:203-208` runs `baseOf(folder)` and `defaultBranchOf(cwd)` in one `Promise.all`, so the same refs are read twice. `git/branches.ts:195-201` enumerates refs again beside `baseOf`.
- Problem (observed, counted from the code): one `GET .../git/status` spawns about 13 processes for a worktree with a recorded base, and up to about 19 for a folder checkout (`resolveRef` runs twice). The changes route runs `mergeBaseOf` again. Each mark or unmark of a viewed file spawns 6 to 14 processes only to build a key string, although `viewedScopeKey` needs just the base's name. `headCommit` re-reads what `# branch.oid` in the status output already says. (Inferred) Ticking 20 files as viewed costs about 200 git spawns, and every spawn counts on Windows.
- Fix: add one `readRefs(cwd)` to `state.ts`: a single `for-each-ref --format=%(refname)%00%(objectname)%00%(symref) refs/heads refs/remotes` that returns branches, tips and `origin/HEAD`. Make `baseOf`, `defaultBranchOf`, `pickBase` and `resolveRef` pure functions over it, leaving only `merge-base --is-ancestor` as a process. Add `baseNameOf(place)` for `viewed.ts` (no merge base, no HEAD). Take HEAD from the status records in `placeStatus`. Optionally add a 2-5 s cache keyed by place path + HEAD (`Cache` in `pullRequest.ts:156`).
- Category: perf
- Effort: M. Risk: medium (the choice of base is visible to the person; `test/git-status*`, `git-changes`, `git-viewed` cover it)

### F4. `gitLine` turns "git did not answer" into "no", which yields wrong diffs instead of `unavailable`
- Where: `apps/daemon/src/git/status.ts:34-36` (`commitAt` uses `gitLine`), `status.ts:49-51` (`headCommit`), `status.ts:79-83` (`resolveRef`), `status.ts:117-119` (`mergeBaseOf`: no head means `unborn`); `git/changes.ts:244-247,265-268,278`; `apps/daemon/src/domain/git.ts:226-228` (`gitLine`) versus `domain/git.ts:234-244` (`gitAnswer`).
- Problem (observed code path; the timing is inferred): when `rev-parse HEAD` times out (5 s) or cannot start, `mergeBaseOf` returns `{ state: 'unborn' }`. The `uncommitted` plan then diffs from the empty tree (`changes.ts:278`), so every tracked file shows as added, and `selectChanged` validates a commit selection against that list. A timed-out `resolveRef` read counts as a missing ref and can silently pick another base. The header comments of `placeStatus` (`status.ts:324`) and `folderGit` promise "unavailable, never an empty answer".
- Fix: make `commitAt` tri-state like `state.ts:265` `commitOf` (`null` for absent, a throw of `unavailable` when git did not answer), or switch `commitAt` and `headCommit` to `gitAnswer`. Then audit the other `gitLine` callers whose "no" changes behavior.
- Category: correctness
- Effort: S. Risk: medium

### F5. Commit and commit-message argv exceed the Windows command-line limit
- Where: `apps/daemon/src/git/commit.ts:140` (`add -- ...toAdd`), `commit.ts:142` (`commit -m <message> -- ...gitPaths`), `commit.ts:148` (`reset`), `commit.ts:164-170` (`ls-files -- :(literal)...`), `commit.ts:192` (`diff --cached -- :(literal)...`); `git/message.ts:188` (`diff HEAD -- ...`, from `selectChanged` at `message.ts:381`). Cap: `MAX_GIT_COMMIT_PATHS` = `MAX_GIT_CHANGED_FILES` = 500 (`packages/protocol/src/git.ts:168,768`).
- Problem (observed): renames double `gitPaths`, so one commit can pass up to 1,000 paths, each with a 10-character `:(literal)` prefix in the reads. `CreateProcess` caps a command line at 32,767 characters, so a commit of about 500 files with paths of 50+ characters fails to start on Windows. `git/changes.ts:38-41` already chunks `hash-object` for exactly this reason; commit and message do not. `git/changes.ts:466-470` (`hashWorking`) also spawns one process per symlink with unbounded concurrency.
- Fix: for `add`, `commit` and `reset`, pass the paths on stdin with `--pathspec-from-file=- --pathspec-file-nul` (`runProgram` and `gitRead` already take `input`). For `ls-files` and `diff`, move the chunking of `changes.ts:449-458` into a shared `chunkArgs(paths)` in `domain/git.ts`, or drop the pathspec and filter the `-z` output in code. Use `hash-object --stdin-paths` in `hashWorking`, which is one process with no argv limit.
- Category: correctness
- Effort: M. Risk: low

### F6. On Windows, `runProgram` runs two synchronous `taskkill /T /F` after every program, against a pid that has already exited
- Where: `apps/daemon/src/providers/exec.ts:136-142` (`killGroup` calls `killProcessGroup`), `exec.ts:192-194` (`exit`: `spare` is always false on Windows, so `killGroup()` runs), `exec.ts:215-220` (`close`: `leftover === undefined`, so `killGroup()` again), `apps/daemon/src/engine/process.ts:12-16` (`spawnSync('taskkill', ...)`).
- Problem (observed in code; not run on Windows, which `AGENTS.md` lists as untested): on win32 every git write, provider account or model read and text generation ends with two blocking `taskkill` runs. Each stops the event loop for tens of milliseconds. They target a pid that has already exited, which Windows may have handed to another process, and `/T /F` force-kills that process's tree. The comment at `exec.ts:36-37` states the opposite intent ("the tree of a pid that is gone is not worth a `taskkill` ... when the pid may be another process's").
- Fix: after a normal exit, call `killGroup` only on POSIX, and keep the Windows kill for the deadline and abort paths. Make the Windows branch of `killProcessGroup` async and fire-and-forget (`Bun.spawn`), as `domain/lines.ts:105` already does. This fits into F10's `process/kill.ts`.
- Category: perf | correctness
- Effort: S. Risk: low (Windows only)

### F7. File manager routes can write into `.git` and delete it permanently
- Where: `apps/daemon/src/fs/service.ts:179-242` (`write`, `makeFolder`, `move`, `copy`, `remove`), `apps/daemon/src/fs/paths.ts:39-59` (`normalizeFsPath`), `apps/daemon/src/fs/batch.ts:229` (`rm(target.real, { recursive: true, force: true })`). The `.git` test that exists elsewhere: `apps/daemon/src/domain/workspaceSetup.ts:40-54` (`isGitName`, `reachesGit`).
- Problem (observed): `normalizeFsPath` refuses `..`, absolute paths, drive letters, backslashes and NUL, but no write path refuses a `.git` segment. `CUTOFF_NAMES` (`fs/paths.ts:10`) is used only by listing, find, watch and search. So `PUT .../fs/file?path=.git/config`, a hook under `.git/hooks/`, or a delete of `.git` all succeed. The listing does show `.git`, as a cutoff folder, and a delete is a permanent `rm -rf`: one wrong click in the file manager destroys a repository's unpushed history. (Inferred, weaker as an attack) An untrusted renderer could set `core.fsmonitor`, which the daemon's background `git status` reads would then run. But the renderer can already run commands through terminals and `agent.add` (custom command and args), so the boundary in `apps/daemon/AGENTS.md` ("the renderer is untrusted") does not hold either way. The value of the fix is protection against accidents and an honest boundary.
- Fix: in `fs/paths.ts`, add `refuseGitPath(rel)`, using `isGitName` moved there from `domain/workspaceSetup.ts:40` (it already matches `.GIT`, `.git.` and `git~1`). Call it in `write`, `makeFolder`, `remove`, and for both sides of `transfer`. Reads and listings stay. Product question: whether the person may still edit `.git/info/exclude` from the file manager (recommended: no). Reword the "untrusted renderer" claim in `AGENTS.md`: the token holder is trusted, and the path checks guard against mistakes.
- Category: safety | docs
- Effort: S. Risk: low

### F8. A busy terminal rewrites its log file synchronously after every output batch
- Where: `apps/daemon/src/terminals/session.ts:265-288` (`#flush` calls `#scheduleLog` per batch), `session.ts:362-415` (`#writeLog`: `plainBuffer` over up to 500 scrollback rows plus the screen, then `writeFileSync` and `renameSync`).
- Problem (observed): a batch is one event-loop turn of output (at most 64 KiB), and `#logScheduled` only merges the batches that arrive while xterm is still parsing. Under steady output (a build, `npm install`, `tail -f`), the daemon converts the whole buffer to text and replaces the file with sync I/O about once per turn, per terminal. (Inferred) That means hundreds of file replacements per second on the daemon's only thread.
- Fix: throttle `#scheduleLog` with a trailing timer (about 1 s; the log is for agents to read), and use `writeFile`/`rename` from `fs/promises`. Keep the last write on exit and the removal on dispose.
- Category: perf
- Effort: S. Risk: low

### F9. Git write plumbing is copied across six services, and `commit.ts` is the grab-bag that holds the shared parts
- Where: `apps/daemon/src/git/commit.ts:43-80` (exports `printedLines`, `shownLine`, `failureLine`, `writeLine`, `GitWritesOptions`, imported by switch, remote, discard, branchMerge and clone); `git/remote.ts:88-127` (`runGitWrite`, `checkGitWrite`); copies of that run+check: `git/commit.ts:258-292` (`#git`, `#check`), `git/discard.ts:313-336`, `git/switch.ts:153-166,342-358,512-520`. `MAX_PRINTED_CHARS = 256 * 1024` exists at `commit.ts:22`, `discard.ts:23`, `switch.ts:45` and `remote.ts:36`. A stopper per class: `commit.ts:88`, `discard.ts:74`, `switch.ts:99`, `remote.ts:162`, `branchMerge.ts:269`, `clone.ts:322`, `pullRequest.ts:357`, stopped one by one in `daemon.ts:205-213`. Misuse: `git/branchMerge.ts:353-378` reads `git config --get merge.ff` through `runGitWrite` (SIGTERM, the write environment) although it is a pure read.
- Problem (observed): the same options object (`--literal-pathspecs`, SIGTERM, `LEFTOVER_GRACE_MS`, the signal, the char cap) and the same error ladder ("daemon is stopping", "did not finish in time", "git is not installed", conflict with the first `fatal:` line) are written out four times. They have already drifted: `switch.ts:342` (`#runDeletion`) omits `leftoverGraceMs`, which every other write passes to avoid leaving `maintenance.lock`.
- Fix: create `git/write.ts` holding `runGitWrite`, `checkGitWrite`, `failureLine`, `printedLines`, `shownLine`, `writeLine`, `MAX_PRINTED_CHARS` and `GitWritesOptions`, with one daemon-wide stop `AbortSignal` passed in options. Delete each class's `#git`, `#check` and `stop()`. Read `merge.ff` with `gitRead`.
- Category: reuse | structure
- Effort: M. Risk: low

### F10. Four process runners and three Windows tree-kill copies; the shared runner lives in `providers/`
- Where:
  - Runners: `apps/daemon/src/providers/exec.ts:70` (`runProgram`, used by five `git/` files, `git/writeEnv.ts` and every provider); `apps/daemon/src/fs/search-ripgrep.ts:116-195` (a second, private `runProgram` with the same name: line streaming, its own kill timer); `apps/daemon/src/domain/lines.ts:80` (`runLines`, `Bun.spawn`, line streaming, group kill); `apps/daemon/src/domain/git.ts:21,101,144` (`git` with `spawnSync`, `gitRead` with `execFile`, `gitRecords` with `spawn`); `apps/daemon/src/files/list.ts:5,18` (its own `execFile` git runner).
  - Windows tree kill: `apps/daemon/src/engine/process.ts:12-23` (`spawnSync taskkill`), `apps/daemon/src/runs/processes.ts:72-76` (`Bun.spawnSync taskkill`), `apps/daemon/src/domain/lines.ts:102-118` (`Bun.spawn taskkill`).
- Problem (observed): every runner reimplements the same lifecycle: deadline, abort, SIGTERM then SIGKILL grace, group kill, output caps and "could not start". The Windows kill exists three times, as two sync variants and one async. `gitRead`'s `execFile` timeout kills git alone, not its process group, so a timed-out read leaves filter children such as git-lfs running. `git/*` imports its runner from `providers/exec.ts`, which reverses the dependency direction and hides the runner from anyone looking for one. A fix such as F6 lands in one runner only.
- Fix: create `src/process/` with `run.ts` (today's `runProgram`, same API), `lines.ts` (`runLines`, plus an `onStdoutLine` mode so `search-ripgrep.ts` drops its private runner) and `kill.ts` (`killTree(pid, signal)`, `processGroupAlive`, one async Windows `taskkill`). Run `gitRead` on `process/run.ts` with a group (detached) so its timeout takes children too. Delete `providers/exec.ts` or keep it as a re-export, and move `files/list.ts` to `gitRecords` (F21). `domain/git.ts` stays the only git reader.
- Category: reuse | structure
- Effort: M. Risk: medium (touches every child process; `providers-exec.test.ts`, `git-*.test.ts` and `fs-search.test.ts` cover the behavior)

### F11. The child-process environment filter exists four times, and five spawn sites skip it
- Where:
  - Copies of the `NEVER_INHERITED` filter: `apps/daemon/src/engine/acp/env.ts:37-56` (`buildAgentEnv`), `apps/daemon/src/git/writeEnv.ts:44-51` (`inherited`), `apps/daemon/src/terminals/shell.ts:69-79` (`terminalEnvironment`), `apps/daemon/src/domain/workspaceSetup.ts:352-367` (`setupEnvironment`).
  - Spawns with the raw `process.env`: `apps/daemon/src/domain/git.ts:27,52-54` (`git`, `gitRead`, `gitRecords`, which run filters and `core.fsmonitor` during status and the snapshot's `add -A` at `git/snapshot.ts:124`), `apps/daemon/src/domain/workspaces.ts:1070` (`runGit` for `git worktree add`, which runs the person's `post-checkout` hook), `apps/daemon/src/files/list.ts:19` (the `execFile` default), `apps/daemon/src/fs/search-ripgrep.ts:132`.
- Problem (observed): the same loop is written four times, and the unfiltered sites hand `CLOWDY_*`, `ELECTRON_*` and `NODE_OPTIONS` to git hooks and filters while writes filter them. (Observed) The impact is limited today: the desktop app does not put `CLOWDY_TOKEN` in the daemon's environment (`apps/desktop/src/main/daemon.ts:120-140`; the daemon generates it, `config.ts:142`). It does reach hooks whenever a developer or a test sets it, and a `NODE_OPTIONS` aimed at the daemon reaches every Node-based hook.
- Fix: one `inheritedEnv(env = process.env)` in `src/process/env.ts`, the base of `buildAgentEnv`, `WriteEnvironment.of`, `terminalEnvironment`, `setupEnvironment`, `readEnvironment()` and `git()` in `domain/git.ts`, `domain/workspaces.ts:1070`, and the ripgrep and `ls-files` spawns.
- Category: safety | reuse
- Effort: S. Risk: low

### F12. Seven "is this path below that folder" checks with different semantics; one drops real search results
- Where: `apps/daemon/src/fs/paths.ts:72-73` (`isInside`, string prefix), `apps/daemon/src/docs/paths.ts:12-20` (`realPathBelow`, string prefix, sync), `apps/daemon/src/domain/workspaceRemoval.ts:344-348` (`isBelow`), `apps/daemon/src/domain/workspaces.ts:167-170` (`withinPath`), `apps/daemon/src/domain/workspaceSetup.ts:47-51` (`leavesFolder`), `apps/daemon/src/git/changes.ts:698-707` (inline in `workingText`), `apps/daemon/src/fs/search-ripgrep.ts:197-201` (`relativePath`: `rel.startsWith('..')`). Relative-path validators: `fs/paths.ts:39` (`normalizeFsPath`), `git/changes.ts:658` (`checkPath`, which does not refuse `\`), `domain/workspaceSetup.ts:148-153`.
- Problem (observed): the string-prefix variants are case-sensitive, while `path.win32.relative` compares case-insensitively, so on Windows the same pair of paths can be inside by one helper and outside by another. The ripgrep variant is a confirmed defect: `relative('/r', '/r/..env')` is `'..env'` (checked with Bun), so results in any top-level file or folder whose name starts with `..` are dropped silently, while the daemon's own scan keeps them.
- Fix: keep one `isBelow(root, path, { allowSelf })` in `fs/paths.ts`, built on `relative()`, and replace the other six. `realPathBelow` becomes `realpath` plus `isBelow`, and the ripgrep `relativePath` uses it. Make `checkPath` call `normalizeFsPath` and compare the result.
- Category: reuse | correctness
- Effort: S. Risk: low

### F13. Detection of an operation under way (merge, rebase, cherry-pick, revert) is written six ways
- Where: `apps/daemon/src/git/switch.ts:54-61,730-743` (`operationUnderWay`, `--git-path` plus stat), `git/state.ts:213-225` (`rebaseUnderWay`), `git/status.ts:371-384` (`mergeUnderWay`), `git/remote.ts:699-705` (`#conflictCount`, the same as `mergeUnderWay`), `git/commit.ts:203-209,236-243` (three `rev-parse -q --verify MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD` plus `rebaseUnderWay`), `git/branchMerge.ts:152-195` (`mergeHead`, `conflictResult`, `isRebaseAt`). The unmerged-path count (`diff --name-only --diff-filter=U -z`) appears at `status.ts:377`, `remote.ts:702`, `commit.ts:242` and `branchMerge.ts:171`.
- Problem (observed): each copy has its own semantics: only switch detects a bisect, and commit spawns 4-5 processes where one `rev-parse --git-path` with all names would do.
- Fix: one `repositoryState(cwd)` in `state.ts`: a single `rev-parse --git-path` call for the six marker files, a stat of each, and a lazy conflict count. Callers pick the fields they need.
- Category: reuse
- Effort: S-M. Risk: low

### F14. `git worktree list` is read at 11 sites, 7 without `-z`, and "who holds this branch" is written three times
- Where: with `-z`: `git/state.ts:30`, `git/switch.ts:716`, `domain/workspaceRemoval.ts:488,838`. Without: `git/state.ts:290`, `git/branches.ts:147`, `domain/worktrees.ts:249`, `domain/workspaces.ts:907` (sync), `domain/workspaces.ts:1108`, `domain/workspaceRemoval.ts:183,399`. Holder lookups: `state.ts:29` (`checkoutOf`), `switch.ts:715` (`heldBy`), `branches.ts:146` (`heldBranches`).
- Problem (observed): `state.ts:28` documents `-z` as the way to read worktree paths that contain a line break, yet most readers skip it, so the same worktree can be parsed differently by different endpoints.
- Fix: `listWorktrees(cwd)` (always `-z`, throws `unavailable` on failure) and `holderOf(cwd, branch)` next to `parseWorktrees` in `state.ts`; make `parseWorktrees` private.
- Category: reuse | correctness
- Effort: S. Risk: low

### F15. Branch-name validation, ref-to-commit lookup and ahead/behind parsing are duplicated
- Where: name validation: `git/switch.ts:387-411` (`#nameOf`, `MAX_BRANCH_CHARS` at `:48`), `git/branchMerge.ts:54-73` (`checkName`), `git/pullRequest.ts:250-266` (`checkHistoryBranch`, the same with a literal 250). Ref to commit: `git/state.ts:265` (`commitOf`, tri-state), `switch.ts:583` (`branchTip`), `switch.ts:706` (`refExists`), `branchMerge.ts:45` (`branchCommit`), `status.ts:34` (`commitAt`), inline at `remote.ts:342,487`. `rev-list --left-right --count` parsing: `status.ts:186-201`, `remote.ts:260-275`, `remote.ts:674-685`, `branchMerge.ts:95-99`, each handling NaN differently.
- Problem (observed): three name checkers can drift on what a valid branch is, and the lookups differ on what "missing" means versus "git did not answer" (see F4).
- Fix: `git/refs.ts` with `checkBranchName(cwd, name, { expandPrevious })`, `commitOf` (tri-state) plus a throwing `requireCommitOf`, and `aheadBehind(cwd, range)`.
- Category: reuse
- Effort: S. Risk: low

### F16. `GET /git` runs a full `git status` per worktree, one after another
- Where: `apps/daemon/src/git/state.ts:250` (`isDirty`: `status --untracked-files=normal --ignore-submodules=none`), called sequentially at `state.ts:307,320` inside the worktree loop of `state.ts:285-325`.
- Problem (observed): N chat worktrees mean N sequential full statuses, each allowed 5 s, only to compute a boolean. (Inferred) A repository with 20 worktrees can take tens of seconds to answer.
- Fix: stop at the first record (`gitRecords` with `maxRecords: 1`), run with bounded concurrency (2-4), and optionally cache per worktree path + index mtime for a few seconds.
- Category: perf
- Effort: S. Risk: low

### F17. Status timeouts disagree: `countChanges` gets 5 s, the Changes panel 15 s
- Where: `apps/daemon/src/git/state.ts:231-242` (`countChanges` through `gitOutput`, the default `READ_TIMEOUT_MS` of `domain/git.ts:9`) versus `git/status.ts:22,332` (15 s). Users: `git/switch.ts:481,500`, `git/branchMerge.ts:442-449`, the worktree list at `state.ts:245,250`.
- Problem (observed): in a large repository whose `git status` takes 5 to 15 s, the Changes panel works, but switch and branch merge refuse with "git did not answer", and the worktree list marks every worktree dirty.
- Fix: export one `STATUS_TIMEOUT_MS` and use it in `countChanges` and `isDirty`. Consider `gitRecords` with a cap, since only a count is needed.
- Category: correctness
- Effort: S. Risk: low

### F18. Pull request history pagination has no page cap
- Where: `apps/daemon/src/git/pullRequest.ts:741-801` (`do ... while (cursor !== undefined)`, 100 per page, 30 s per call), concurrency 4 (`pullRequest.ts:62`); fork PRs are dropped only afterwards in `summaryOf` (`pullRequest.ts:291`).
- Problem (observed): `pullRequests(headRefName:)` is paged to the end before forks are filtered out. (Inferred) For a head named `main` in a popular repository, thousands of fork PRs turn into dozens of sequential `gh` calls holding a history slot, then one large DB write. The renderer refreshes this every 60 s (`apps/desktop/src/renderer/features/changes/branchPullRequests.ts:21`, `REFRESH_MS`).
- Fix: cap at about 5 pages, mark the result truncated or `stale`, and keep the stored history.
- Category: perf
- Effort: S. Risk: low

### F19. The skills "user plugin" mirror is still built although nothing reads it
- Where: `apps/daemon/src/skills/mirror.ts` (whole file), `apps/daemon/src/skills/service.ts:184-203` (`syncUser`, `rebuildMirror`), `service.ts:91-93,145-147,206-212`, `apps/daemon/src/config.ts:55` (`extraPluginDirs`), tests `apps/daemon/test/skills-api.test.ts:135,167-193,241,265,298,307,428,457`.
- Problem (observed): the Skills table of `apps/daemon/AGENTS.md` says of `extraPluginDirs`: "No consumer since Claude Code runs through its ACP adapter". A grep of `src` finds no reader outside `skills/service.ts`. Every catalog request that sees a change, and every switch, still builds a hashed folder of symlinks (on Windows `cpSync` copies each skill folder whole) and prunes old ones: sync disk work, more than ten tests, and a misleading model of how skills reach agents. (Observed, product) The user-skill "enabled" switch therefore changes only the catalog; an agent still loads a switched-off skill. `setEnabled` also accepts `clowdy:` system names (`service.ts:113-131`), while the Skills section says that only user skills can be switched (doc drift).
- Fix: delete `mirror.ts`, `rebuildMirror`, the mirror part of `syncUser` (keep the fingerprint that drives `skills.changed`), `Config.extraPluginDirs` and the tests. Keep `hashDirs.ts`, which `materialize.ts` uses. Raise the switch semantics with the owner (hide it for user skills, or label it as catalog-only), and update the Skills section.
- Category: dead-code | docs
- Effort: S. Risk: low

### F20. The attachments sweep lists the whole folder and every row before each upload
- Where: `apps/daemon/src/attachments/service.ts:98` (`upload` calls `this.sweep()`), `service.ts:318-338` (`sweep`: `allAttachmentIds` loads every id, `readdirSync(this.root)`).
- Problem (observed): each upload starts with a full read of the attachment ids and a sync listing of `<dataDir>/attachments`. Both grow with every file ever sent, because sent files stay. (Inferred) After months of use, every paste stalls the event loop for O(all attachments). Only the stale-row part, an indexed `unsentAttachmentIdsBefore`, needs to run that often.
- Fix: keep the stale-row deletion in `upload`, and run the stray-folder pass at start plus on an hourly timer that does not keep the process alive (`uploading` already protects live uploads).
- Category: perf
- Effort: S. Risk: low

### F21. `@`-mention file listing: its own git runner, a fallback that hides git failures, and two rankers for one list
- Where: `apps/daemon/src/files/list.ts:18-42` (its own `execFile` git, 10 s, 64 MB), `files/list.ts:79-83` (`gitFiles(root).catch(() => walkedFiles(root))`), `files/list.ts:45-68` (`walkedFiles`: a second walker beside `fs/walk.ts` `walkTree`, sequential `readdir`, cap checked only per level); `apps/daemon/src/files/rank.ts:26-41` (`searchPaths`) and `apps/daemon/src/fs/find.ts:27-71` (`matchPaths`), which rank the same `FilesService.list` output with the same rules.
- Problem (observed): any git failure falls back to a walk that ignores `.gitignore`, timeouts and output overflow included. For a big repository the `@` menu and `fs/find` then offer `dist/` and `target/` files, after a 10 s wait. The runner also lacks the read environment of `domain/git.ts` (`LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`). With two rankers, the palette and the `@` menu can order one query differently, and a scoring fix lands in one only.
- Fix: use `gitRecords(cwd, ['ls-files', '-z', ...], { maxRecords, timeoutMs: 10_000 })`. Walk only on `reason: 'failed'` (not a repository); on `'unavailable'`, return an error or an empty list. Merge the rankers into one `rankPaths(paths, query)` in `files/rank.ts`, keeping the glob support of `find.ts`.
- Category: reuse | correctness
- Effort: S. Risk: low

### F22. The atomic write and JSON read of small settings files is written six times
- Where: atomic write: `apps/daemon/src/power.ts:90-92`, `apps/daemon/src/skills/settings.ts:51-57`, `apps/daemon/src/engine/acp/registry.ts:620-623`, `apps/daemon/src/instance.ts:86-89`, `apps/daemon/src/cli/shim.ts:50-58`, `apps/daemon/src/terminals/session.ts:406-411`. JSON read with schema and fallback: `power.ts:75-80`, `skills/settings.ts:20-33`, `engine/acp/registry.ts:585-596`, `apps/daemon/src/providers/cursor/account.ts:27-37`.
- Problem (observed): each copy picks its own temp name (a fixed `${file}.tmp` in three, pid-suffixed in two), its own mode (0600 or the umask) and its own policy for an unreadable file. `SkillSettings.setEnabled` reads a damaged file as empty and then overwrites it, silently dropping the person's earlier switches (`skills/settings.ts:27-33,38,53`).
- Fix: `writeFileAtomicSync(path, text, { mode })` (unique temp name, then rename) and `readJsonFile(path, schema)` returning `{ value } | { missing } | { damaged }`, in one daemon module (for example `src/files/json.ts`). Port the six writers and four readers. In `setEnabled`, refuse to overwrite a damaged file, or keep a `.bak` copy.
- Category: reuse | correctness
- Effort: S. Risk: low

### F23. Four git files over 700 lines mix responsibilities
- Where and split (from the git audit, line ranges checked against file sizes):
  - `apps/daemon/src/git/pullRequest.ts` (828 lines): a generic TTL plus in-flight `Cache` (`:156-206`), `gh` discovery and auth (`:217-233,620-664`), GraphQL queries and error mapping, history pagination with DB writes, and the "moved past" logic. Split into `git/gh.ts` (locate, auth, run, `failureOf`), `pullRequestQuery.ts` and the service; move `Cache` to a shared helper (F26).
  - `git/changes.ts` (769): diff plans (`:186-272`), working-tree hashing and sizing (`:376-555`), file sides (`:640-769`) and `checkPath` (`:658`, imported by `selection.ts` and `viewed.ts`). Split into `diffPlan.ts`, `workingTree.ts` and `changes.ts`; move `checkPath` next to `normalizeFsPath` (F12).
  - `git/switch.ts` (743): switch, branch creation, branch deletion (`:195-358`), and `switchRepositoryKey` and `operationUnderWay`, which `remote.ts` and `branchMerge.ts` import from it. Move deletion to `branchDelete.ts` and the shared helpers to `state.ts`/`refs.ts` (F13, F15).
  - `git/remote.ts` (748): fetch, pull, update, abort, push, a separate Sync workflow (`:367-617`) and the write helpers of F9. Move Sync to `sync.ts`.
  - `git/branchMerge.ts` (709) is cohesive. But `protectLocalFilesForRebase` (`:203-260`) reads the whole `ls-tree -r` under the default 8 MiB cap, so a tree of roughly 150k paths cannot be rebased ("Couldn't check local files"). Use `gitRecords` or a raised `maxBytes`.
- Category: structure
- Effort: L in total, M per file. Risk: low (move-only, after F9/F13/F15)

### F24. Two keyed serial queues, so file manager writes and git writes in one folder never wait for each other
- Where: `apps/daemon/src/fs/service.ts:72-73,349-370` (`FsService.exclusive`, keyed by the real root), `apps/daemon/src/domain/workspaces.ts:1391-1414` (`exclusive(store, key, signal, work)`, used by every git write as `git:<real path>` through `writeLine`).
- Problem (observed): the same promise-chain queue is implemented twice, with different keys, so a file manager save, move or delete and a git discard, switch or pull in the same place run concurrently. (Inferred) A save that lands during `git switch`, or between a discard's check and its `unlink`, becomes a conflict or a lost edit. `git/discard.ts` catches some of these cases after the fact with stamps.
- Fix: keep the `domain/workspaces.ts` version (it supports abort), move it to a small shared module, and have `FsService` mutations take the same `writeLine(place)` key as git writes.
- Category: reuse | correctness
- Effort: M. Risk: medium (a long copy would delay a commit, and the reverse)

### F25. Sync file-system calls on request paths, and two different exported `placeOf` functions
- Where: `apps/daemon/src/git/clone.ts:76-100,358-378` (`statSync`/`opendirSync` in `target()`, a GET route), `git/status.ts:391` (`readFileSync` in `placeStatus`), `git/pullRequest.ts:226` (`statSync`), `git/commit.ts:80` (`writeLine` calls `realpathSync.native`, recursive on missing paths), `apps/daemon/src/terminals/service.ts:217-244` (`directoryIn`, sync `realpathSync`/`statSync`), `apps/daemon/src/skills/scan.ts:77-112` (a sync `readdirSync`/`realpathSync`/`statSync` of every root on every catalog request). Two `placeOf`s: `git/state.ts:80` (async, `undefined` when missing) and `domain/workspaces.ts:107` (sync, falls back to the nearest existing parent). Commit, clone and message import one; branchMerge, branches and lastFetch import the other.
- Problem (observed): each call is small, but together they put disk latency on the event loop, which matters for folders on network disks (the case `domain/git.ts:8` names). The two same-named functions answer differently for a missing path.
- Fix: switch to the `fs/promises` versions; rename the two to `realPlaceOf` and `placeKeyOf`.
- Category: simplify | perf
- Effort: S. Risk: low

### F26. Five hand-rolled TTL caches
- Where: `apps/daemon/src/git/pullRequest.ts:156-206` (`Cache`: TTL plus in-flight sharing, the most complete), `apps/daemon/src/files/service.ts:16,59-80` (5 s list cache), `apps/daemon/src/fs/search-ripgrep.ts:13,26-53` (`RipgrepLocator`, 30 s negative cache), `apps/daemon/src/engine/acp/registry.ts:35` (`INFO_TTL_MS`, detection cache), `apps/daemon/src/providers/models.ts:10` (`FRESH_MS`, 10-minute model cache).
- Problem (observed): each cache has its own expiry, in-flight sharing and failure policy (some keep failures, some drop them), and the cache F2 needs would be the sixth.
- Fix: move `pullRequest.ts`'s `Cache` to a shared module (for example `src/lib/cache.ts`), use it for the docs tree (F2) and the file list, and port the others when their files are touched.
- Category: reuse
- Effort: S. Risk: low

## Cross-area notes

- **Renderer, docs tree (F2).** `apps/desktop/src/renderer/features/chats/useMentionTriggers.ts:57-66` should load `getDocsTree` once per open `@` menu and filter on the client. Debouncing `getProjectFiles` would also save daemon work.
- **Security boundary (F7).** `apps/daemon/AGENTS.md` calls the renderer untrusted, but terminals (`/v1/terminals`) and `agent.add` (any command, args and env) give a bearer-token holder code execution. Decide on one stated model. Either the token holder is trusted and path checks only prevent accidents, or terminals and custom agents need a confirmation that does not live in the renderer.
- **Protocol.** `MAX_GIT_COMMIT_PATHS` (500, `packages/protocol/src/git.ts:768`) is what makes F5 reachable. Keep it, and pass paths on stdin as described in F5. Lowering it would only hide the problem.
- **Login URL.** `parseSignInOutput` (`providers/login.ts:34-49`) accepts any OSC-8 hyperlink target, not only `https?:`. The renderer should open `AgentSignInSession.url` only when it is https.
- **Shared daemon modules to create.** The fixes above converge on a few modules that later agents can find:
  - `src/process/`: run, lines, kill and env (F6, F10, F11);
  - `git/write.ts` (F9);
  - `git/refs.ts` (F15);
  - `state.ts` gains `readRefs`, `repositoryState` and `listWorktrees` (F3, F13, F14);
  - one `isBelow` and `refuseGitPath` in `fs/paths.ts` (F7, F12);
  - one JSON/atomic-file helper (F22);
  - one TTL `Cache` (F26);
  - one keyed queue (F24).
  
  None of these belong in `packages/lib`, since the daemon may import only its subpaths, and they are Node/Bun-only.
- **Shell lookup (low).** `terminals/shell.ts:31-62` (`resolveShell`, with existence checks), `git/writeEnv.ts:160-161` (`$SHELL` or zsh/sh, no existence check), `domain/workspaceSetup.ts:330-345` (Windows `cmd /d /s /c`) and the desktop's `main/loginShell.ts` each pick a shell differently. A shared `resolveShell` would keep their fallbacks consistent.

## Not inspected / limits

- **Split of the work.** The `git/` folder (20 files, about 7,400 lines) was audited by a parallel pass of this agent and folded in here. I re-checked its key claims in the source: the 500-path cap, commit argv, `commitAt` through `gitLine`, the `worktree list` sites, the double `baseOf`/`defaultBranchOf` read, `isDirty` and the pagination loop. Its process counts (F3) are counted from the code, not measured. It found no confirmed dead code in `git/`; `#removeLegacyTemporary` (`branchMerge.ts:674`) and `discardCopies.ts` are legacy cleanup that is still wired in.
- **Partly read.** `git/message.ts` (prompt flow), `git/pullRequestRollup.ts`, `git/snapshot.ts:160-295`, the progress parsing in `git/clone.ts`, `fs/batch.ts`, `fs/walk.ts`, `fs/search-scan.ts`, `fs/search-collect.ts`, `cli/args.ts`, `providers/service.ts`, `providers/models.ts`, the provider model parsers and `commands/chat.ts`/`task.ts`/`context.ts` were skimmed or read only in part. `commands/` holds no OS access beyond what reaches `domain/` (F1).
- **Out of scope.** `domain/*.ts` was read only where `git/`, `fs/` or `terminals/` depend on it: `domain/git.ts`, `lines.ts`, `projects.ts`, `workspaces.ts`, `workspaceSetup.ts`, `workspaceRemoval.ts`. `engine/` and `http/` were not reviewed beyond the call sites cited.
- **No code was run.** Nothing was executed except one Bun check of `path.relative` (F12). Every Windows claim (F5, F6, F12) comes from reading the code; Windows was not run. The frequency estimates in F3, F8, F16 and F20 are inferred, not measured.
