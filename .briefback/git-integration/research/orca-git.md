# Research: how Orca builds its Source Control and GitHub surfaces

Source studied: `stablyai/orca` at commit `de67267a` (2026-11-20), a shallow clone read as text only. Nothing was installed or run. MIT licensed (`LICENSE`, "Copyright (c) 2026 Lovecast Inc."), so code can be ported with the notice. Paths below are relative to the Orca repo root. Research only: no plan, no design for Clowdy. Facts are what I read in the source or its docs; anything marked "inference" is my reading of it.

Screenshots studied: `6.png` (Source Control tab) and `7.png` (Checks tab), both in the session's `images/` folder.

## Summary

- **Orca has no GitHub API client of its own.** Every GitHub call is the user's `gh` CLI (`gh api`, `gh api graphql`, `gh pr ...`). It stores no GitHub token and has no OAuth app. Auth is whatever `gh auth` holds on the machine that runs the call. Without `gh`, GitHub surfaces show an error or empty state; local git still works. GitLab uses `glab`; Bitbucket, Azure DevOps and Gitea use REST with a stored credential or `ORCA_*` environment tokens.
- **Git is the user's `git` binary**, spawned per action (no libgit2, no isomorphic-git). Status is `git status --porcelain=v2 --branch` streamed and capped at 1000 rows. A scheduler, a file watcher, window focus and agent-turn-end signals decide when to re-run it. There is no periodic `git fetch`: the "Pull (106)" count in the screenshot comes from the last fetched remote ref.
- **The Source Control tab's main button is a small state machine** (Stage All, Commit, Publish, Push, Pull, Sync, Force Push, Create PR) in `src/shared/source-control/decisions/`. The dropdown shows every action all the time, with a reason when one is disabled.
- **The purple Create PR button is a one-click pipeline**: stage everything, ask an agent CLI for a commit message, commit, push or publish, ask an agent CLI for the PR title and body, then `gh pr create`. Each step can stop with a notice.
- **Commit messages and PR text come from the user's own agent CLI** (`claude -p`, `codex exec`, and about a dozen others) spawned as a read-only subprocess with the prompt on stdin. No Orca-hosted model and no API key. Default Claude model is `sonnet` with `--effort low`.
- **Checks and comments are GraphQL first, REST second, `gh pr checks` last.** Reads are cached by PR head SHA, coalesced, and paced. REST reads use ETag revalidation through `gh api --include`. Rate-limit handling (a per-bucket circuit breaker, a 4-slot `gh` limiter, a quota probe) is a large part of the code.
- **PR polling is host-owned.** App windows report which PRs are on screen; the host (Electron main, or the headless `orcad`) decides when to re-read and pushes results back. Selected PR: 60 s. Other PRs: 120 s. No PR on a branch: 15 min (60 s if selected). Closed: 15 min. A user setting stretches this 5x or 10x or turns it off.
- **Git and GitHub both run on the machine that owns the workspace.** The renderer calls `window.api.git.*` for a local workspace and `git.*` / `github.*` runtime RPC methods for a remote Orca server. The client names a worktree by id; the host maps it to a path and refuses unregistered paths. Phones use the same RPC.
- **The code is big.** Roughly 130k to 140k non-test lines across git, GitHub, shared logic, text generation and the renderer panels (the folders also hold some non-source-control code, see the sizes below), plus about 9k for the other four forges. Most of it is Windows/WSL/SSH routing, caches, rate-limit care, and failure copy, not the visible behavior. See "What it would cost".
- **Worktrees are the unit.** Every git surface is keyed by worktree id. Orca's own docs say "Don't assume every workspace is a git worktree": folder workspaces get no git surfaces.

## How it works

### 0. The layers

1. **Renderer panels** (`src/renderer/src/components/right-sidebar/`): `source-control/` (214 files), `checks-panel/` (78), `hosted-review/` (42). State lives in a Zustand store (`useAppStore`, slices under `src/renderer/src/store/slices/editor/git/`).
2. **Transport choice in the renderer.** Small clients in `src/renderer/src/runtime/source-control/git/runtime-git-*-client.ts` pick by target: `target.kind === 'local'` calls `window.api.git.*` (Electron IPC), anything else calls `callRuntimeRpc(target, 'git.fetch', { worktree: selector })`. GitHub does the same (`src/renderer/src/runtime/repository-github/`: `target.kind === 'environment' ? runtimeApi : window.api.gh`).
3. **Preload** (`src/preload/api/source-control/git-bridge.ts`, `src/preload/api/github/`, `src/preload/api/hosted-review/`): thin `ipcRenderer.invoke('git:status', args)` wrappers. Types in `git-inspection-api.ts` and `git-operation-api.ts`.
4. **Main handlers.** Electron IPC handlers in `src/main/ipc/filesystem/source-control/*` (status, diff, history, commit, generation) and `src/main/ipc/filesystem/git-remote/*` (push, pull, fetch, rebase, compare). GitHub in `src/main/ipc/source-control/github-pr-*-handlers.ts`. Runtime RPC handlers in `src/main/runtime/rpc/methods/source-control/{git,github,gitlab,reviews}/`, backed by `src/main/runtime/integrations/git/*`. Parameter schemas are zod, in `src/shared/rpc-contract/source-control/` and `.../github/`.
5. **Runners.** `src/main/git/` (command runner, source-control reads and writes, remotes, refs, worktrees) and `src/main/github/` (client, PR refresh, PR watch, accounts).
6. **Shared logic** in `src/shared/git/`, `src/shared/github/`, `src/shared/source-control/`: parsers, decision functions, prompts, polling policy. These are pure and used by renderer, main and relay alike.

Execution hosts (`src/main/providers/execution-host-provider-dispatch.ts`): `local`, `ssh:<connection>` (git and files go through an Orca relay on the SSH machine), and `runtime:<environment>` (a paired Orca server). Unknown hosts fail closed ("Refusing to fall back to this machine").

### 1. Source Control tab and its main button

Screenshot `6.png`, mapped to code:

- **Panel shell**: `source-control/panel/SourceControl.tsx` -> `panel.tsx` -> `panel-ready.tsx` / `panel-content.tsx`. `use-panel-model.ts` and `use-panel-state.ts` compose the hooks.
- **Header**: `panel/header-toolbar.tsx` (Create PR button, file-filter search icon, "..." menu); `panel/header-review-actions.tsx` (`CreatePrHeaderButton`); `panel/header-overflow-menu.tsx` ("View as tree", "Change Base Ref...", "Refresh branch compare"); `panel/branch-context-row.tsx` (`main` over `-> origin/main`, line-total chip).
- **Commit box**: `commit/commit-message-composer.tsx` (placeholder "Message"), `commit/commit-area.tsx`, `commit/commit-action-menu.tsx`, `commit/use-commit-action.ts`. Cmd/Ctrl-Enter commits when the primary action is Commit.
- **Split button and dropdown**: label and enabled state come from `src/shared/source-control/decisions/source-control-primary-action-decision.ts`; menu rows from `src/shared/source-control/dropdown/source-control-dropdown-{commit,remote}-items.ts` via `panel/source-control-dropdown-items.ts`. Rows seen in the screenshot: Commit, Commit & Push, Commit & Sync, Push, Force Push, Create PR (hint "Switch to a feature branch"), Push before PR, Pull (106), Fast-forward (106), Sync (down 106, up 0), Rebase from origin/main, Fetch, Publish Branch. When a merge or rebase is in progress, Abort merge / Abort rebase rows are added.
- **Changes list**: `listing/*` (staged, unstaged, untracked, conflict sections; tree or flat; per-row line counts; "too many changes" banner; submodule rows).
- **Run actions**: `sync/use-remote-action-runner.ts` maps a kind (`push`, `force_push`, `pull`, `fast_forward`, `sync`, `fetch`, `publish`, `rebase`) to store actions in `store/slices/editor/git/git-remote-push-pull.ts` and `git-remote-sync.ts`. Failures are stored per worktree and shown as notices with recovery (for example "Fix with AI").

The primary-action ladder (observed in `resolveSourceControlPrimaryActionDecision`), in order: Create PR intent running (disabled) -> committing (disabled) -> remote op running -> unresolved conflicts (disabled Commit) -> Create PR intent eligible -> staged and message (Commit) -> staged, no message (disabled) -> unstaged changes (Stage All) -> no upstream info (disabled) -> no upstream (Publish, or Create PR) -> ahead and behind (Force Push if every remote-only commit is patch-equivalent to a local one, else Sync) -> behind only (Pull) -> ahead only (Push) -> PR can be created (Create PR) -> nothing to do (disabled Commit).

### 2. Git commands behind each action

All through `gitExecFileAsync` (buffered) or `gitStreamStdout` (streamed) in `src/main/git/command-runner/`. Observed commands:

| Action | Git invoked | Where |
| --- | --- | --- |
| Status | `git -c core.quotePath=false status --porcelain=v2 --branch` plus `--untracked-files=all` (or a cheaper configured scan, then expanded by listing untracked dirs); `--ignored=matching` when asked. Env `GIT_OPTIONAL_LOCKS=0`. Streamed, stops reading at 1000 rows (`DEFAULT_GIT_STATUS_LIMIT`). Waits for `index.lock` to clear first. | `src/main/git/source-control/status/status-read.ts`, `status-porcelain-stream.ts` |
| Per-file line counts | `git diff [--cached] --numstat`, reused while HEAD, index, config and stamped files are unchanged | `status/status-line-stats.ts` |
| Conflict or sequencer state | Not a git command: checks for `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, rebase dirs in the git dir | `mutations/git-conflict-operation.ts` |
| File diff | Not `git diff`. Reads each side with `git cat-file blob`, `--textconv` or `--filters` (index `:path` versus `HEAD:path`), and the renderer diffs the two texts. Large or binary sides return metadata only. | `diffs/file-diff.ts`, `diffs/git-blob-read.ts` |
| Stage one | `git add -- <literal pathspec>` | `mutations/staging.ts` |
| Stage many | `git add --pathspec-from-file=- --pathspec-file-nul` with paths on stdin (no argv limit) | same |
| Stage All | Host-side, so a capped list cannot hide files: `git diff --name-only --relative -z --diff-filter=U` to find unresolved paths, then `git add --all -- .` (or `--update` for tracked only); special cases for conflicts and Orca's shared symlinks | `src/shared/git/paths/git-stage-worktree-scope.ts` |
| Unstage | `git reset --quiet -- <pathspec>` (bulk with pathspec-from-file) | `staging.ts` |
| Discard | Tracked: `git restore --worktree -- <path>`. Untracked: `git clean -ffdx -- <paths>`. Confirmation dialog first. | `mutations/discard-changes.ts` |
| Commit | `git commit -m <message>`. Hooks run as usual (no `--no-verify`); stderr or stdout is returned on failure. Finishing a merge: `git commit --no-edit --cleanup=strip`. | `mutations/commit-changes.ts` |
| Push, Publish | `git push [--force-with-lease] --set-upstream <remote> <refspec>`. Default `origin HEAD`; a worktree with a configured fork target pushes `HEAD:<branch>` to that remote. The `publish` flag is accepted but unused (the code always sets upstream). | `src/main/git/remotes/remote.ts` `gitPush` |
| Force Push | Same with `--force-with-lease` (no explicit expected value). Offered only when the remote has just older copies of local commits. | same, `shouldForcePushWithLeaseForUpstream` |
| Pull | `git pull`. If git refuses a divergent pull for lack of a configured strategy, retry `git pull --no-rebase`. | `remote.ts`, `src/shared/git/remotes/git-remote-error.ts` |
| Fast-forward | `git pull --ff-only` | `remote.ts` |
| Fetch | `git fetch --prune` (or `--prune <fork remote>` with stale-refspec repair) | `remote.ts` |
| Sync | Renderer sequence: fetch -> read upstream status -> force-with-lease push if patch-equivalent, else pull -> push only if still ahead. Push-stage failures are labeled as Sync failures. | `store/slices/editor/git/git-remote-sync.ts` |
| Rebase from origin/main | `git remote`; `git check-ref-format --branch`; `git merge-base --fork-point refs/remotes/<r>/<b> HEAD`; `git fetch --no-write-fetch-head <remote> +refs/heads/<b>:refs/orca/rebase/<uuid> +refs/heads/<b>:refs/remotes/<r>/<b>` (60 s timeout; falls back without the flag on old git); `git rebase --onto <tmp ref> <fork point>` (or `git rebase <tmp ref>`; `merge --ff-only` on an unborn HEAD); then `git update-ref -d` on the temp ref. | `remotes/remote-rebase.ts`, `src/shared/git/remotes/git-rebase-source.ts` |
| Abort merge or rebase, finish merge, cherry-pick, revert, create branch from commit | Wired through `git:abortMerge`, `git:abortRebase`, `git:completeMerge`, `git:cherryPick`, `git:revert`, `git:createBranch`, `git:sequencerAbort`, `git:sequencerContinue` (command lines not read) | `src/shared/git/commands/git-commit-action.ts` |
| Upstream, ahead/behind | Mostly from the status record's branch header (comment: "avoid two extra refresh subprocesses"). Otherwise `git rev-parse --symbolic-full-name HEAD@{u} --abbrev-ref HEAD@{u}` and a `rev-list` count. Patch-equivalence of behind commits: `git log --cherry-mark --right-only --format=%m HEAD...<upstream>`. | `source-control/upstream/*`, `src/shared/git/remotes/git-effective-upstream.ts` |
| Default base ref | `git for-each-ref` on `origin/HEAD` (symref), `origin/main`, `origin/master`, `main`, `master`, in that order | `src/shared/git/refs/git-default-base-ref.ts` |

Process hygiene on every call (`src/main/git/command-runner/git-environment/`, `src/shared/git/commands/`): English output pinned (`LANGUAGE=en`, `LC_ALL=en_US.UTF-8`) because error parsing matches text; credential prompts off (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, empty askpass); read-only calls set `GIT_OPTIONAL_LOCKS=0`; offline reads set `GIT_NO_LAZY_FETCH` and `GIT_ALLOW_PROTOCOL=none`. A fair scheduler (`src/shared/git/admission/`) limits concurrent git processes by tier (`interactive` over `status` over `background`) and by class (general, network, checkout) and per route. Mutations take a per-worktree lock (`runWithGitWorktreeOperationLock`), pause repository ref maintenance, and invalidate read caches before and after.

### 3. Status refresh and large repositories

- **Who asks.** The renderer, not the host. `sync/use-worktree-git-status-observation.ts` builds a scheduler (`git-status-refresh-scheduler.ts`): activity-triggered runs debounced 125 ms with a 3 s minimum gap, a 60 s safety poll, spacing stretched after slow scans (up to 5 min), paused while the window is hidden, slower while unfocused, caught up on reveal or focus.
- **Triggers.** Worktree file changes (`@parcel/watcher` in a child process, `src/main/ipc/filesystem/watcher-process/`), agent turn end (`sync/use-git-status-turn-completion.ts`), a push signal, a ref watch on the upstream ref (`src/main/ipc/worktrees/git/worktree-git-status-ref-watch.ts`), user refresh, and mutation completion.
- **Which worktrees.** Only the active one and only while the panel is visible (comments such as "Avoid Git subprocesses while the sidebar is hidden").
- **Size limits.** 1000 status rows, then a "too many changes" banner; Stage All still works host-side. A helper finds huge folders and offers to append them to `.gitignore` (`git:findHugeFoldersToIgnore`, `git:appendGitignore`). Status reads share a lease so concurrent callers join one read. Branch change lists are cached (16 entries, 16M characters) and reused until HEAD, index, config or attributes change. History is capped at 50 per page, 200 maximum, with a token that pins the revision set so paging stays consistent.
- **Windows or WSL cost control.** Background polls never wake a stopped WSL distro; only user acts carry `wakeWslDistro`.

### 4. Branch compare, ahead/behind and the base ref

- **What is compared.** The branch's HEAD against a base ref, using the merge base: `git branch --show-current`, `git rev-parse --verify --end-of-options <ref>` for both tips, `git merge-base <base> <head>`, `git rev-list --left-right --count <base>...<head>` (ahead and behind in one walk), and `git diff --raw --numstat -z -M -C <merge-base> <head> --` for the "Committed on Branch" list. Result states: `loading`, `ready`, `invalid-base`, `unborn-head`, `no-merge-base`, `error`. Files: `src/main/git/source-control/comparisons/branch-compare.ts`, `compare-ref-oids.ts`, `src/shared/git/diff/git-change-list.ts`.
- **The line-total chip** next to the branch is one ranged diff from the merge base to the working tree (`branchLineTotalMergeBase` on the status call), with path-heuristic buckets for source, tests and generated files.
- **How the base ref is chosen** (`src/shared/source-control/decisions/source-control-base-ref-resolution.ts`): the worktree's own `baseRef` meta; else the repo's `worktreeBaseRef` setting; else the default from the probe above. For the compare pane, the pinned base wins, else the branch's upstream, else the default. When a linked PR names a different base branch, that branch name is used with the same remote prefix.
- **How it changes.** "Change Base Ref..." opens `components/source-control/BaseRefPicker.tsx` (searches refs on the repo's host, needs 2+ characters). The choice is saved either on the worktree (`updateWorktreeMeta(id, { baseRef })`) or on the repo (`updateRepo(id, { worktreeBaseRef })`), or cleared (`panel/panel-dialogs.tsx`).
- **No fetch here.** I found no fetch in branch compare or in the status loop. Base refs only move when the user runs Fetch, Pull or Sync, or when worktree creation or a PR start point fetches. "Refresh branch compare" re-reads local refs.

### 5. Commits section and the graph

- Data: `git log --no-show-signature --no-color --format=%H%n%aN%n%aE%n%at%n%ct%n%P%n<decorations>%n%B -z --topo-order --decorate=full -n<limit+1> [--skip=N]` over HEAD (or `--stdin` with a list of revisions when other refs are included); refs from `git for-each-ref` on heads, remotes and tags, with annotated tags peeled by `git cat-file --batch-check`. Files: `src/shared/git/history/git-history-execution.ts`, `git-history-log-parser.ts`, `git-history-revisions.ts`.
- Incoming and outgoing rows: upstream tip versus HEAD with `git merge-base`; if the upstream tip is not the merge base there are incoming changes (the dotted "Incoming Changes" row in the screenshot).
- Graph: lane layout computed from parent ids in `src/shared/git/history/git-history-graph.ts` (types `inputSwimlanes`, `outputSwimlanes`, kinds `HEAD`, `node`, `incoming-changes`, `outgoing-changes`) and drawn as SVG in `source-control/sync/git-history-graph-svg.tsx`. The naming matches VS Code's source control graph (inference; no comment says so). Branch pills come from decorations.
- Rows expand to files (`git-history-commit-files.tsx`, `git:commitCompare` using `git diff-tree --root --no-commit-id -r --raw --numstat -z -M -C`), with a context menu for cherry-pick, revert and branch-from-commit (`use-git-history-commit-actions.ts`).
- Git floor: the decoration format has a fallback to `%D` because `%(decorate:...)` is only expanded from git 2.43.

### 6. Create PR (the purple button)

- **Eligibility** (`src/shared/source-control/hosted-review/hosted-review-contracts.ts`): `blockedReason` is one of `dirty`, `detached_head`, `default_branch`, `no_upstream`, `needs_push`, `needs_sync`, `auth_required`, `fork_head_unsupported`, `unsupported_provider`, `existing_review`, `base_not_on_remote`. A `nextAction` (`commit`, `publish`, `push`, `sync`, `authenticate`, `open_existing_review`) goes with it. This is why the menu says "Switch to a feature branch" on `main`.
- **The intent run** (`source-control/review/use-create-pr-intent-run.ts`, `create-pr-intent-branch-prep.ts`, `create-pr-intent-review-step.ts`): token pinned to the worktree and branch -> optional early fast-forward when only behind -> stage all -> commit message from the box or generated by the agent CLI -> `handleCommit` -> publish, push or sync as needed -> re-read eligibility -> generate PR fields -> create. If the branch, base or worktree drifts mid-run, it aborts and clears the notice. A failed commit surfaces hook output with a "Fix with AI" button.
- **Composer path**: "Create PR" from the dropdown opens `hosted-review/creation/CreateHostedReviewComposer.tsx` (base picker, title, body, draft, "Generate pull request details with AI", optional "Stack this PR above #N" for GitHub stacks).
- **Create call** (`src/main/github/client/create/create-github-pull-request.ts`): `gh pr create --repo <o/r> --base <base> --title <t> --body-file <temp file> [--head <h>] [--draft]`, 60 s timeout, marked non-idempotent (never retried). Body falls back to the repo's PR template (`pull-request-template.ts`). If the call fails or the output cannot be parsed, it looks up an open PR by head and base: found means success or "already exists"; not found means "creation unconfirmed, refreshing". Errors are classified in `create-pr-error-classification.ts`. After success the PR number is stored on the worktree (`updateWorktreeMeta`).
- **Provider switch**: GitHub via `gh`, GitLab via `glab`, Bitbucket, Azure DevOps and Gitea via REST (`src/main/{gitlab,bitbucket,azure-devops,gitea}/pull-request-creation.ts`). Bitbucket has no draft.
- **Manual fallback**: `review/manual-review-url.ts` builds a browser compare URL from the remote when no provider route works.

### 7. Checks tab (screenshot `7.png`)

- **Shell**: `checks-panel/ChecksPanel.tsx` is a chain of about 20 hooks that each add to one model object (polling, review data, comments, AI queue, create review, git status). No PR or a folder workspace shows `presentation/empty-content.tsx` (with Create PR); otherwise `presentation/active-content.tsx`.
- **Header**: `presentation/review-header.tsx` (PR number, state badge, refresh, title, "PR updated" time) and the merge split button `hosted-review/provider-actions/HostedReviewActions.tsx` ("Enable auto-merge", or the repo's merge method). A triage strip and a conflict summary sit under it (`triage-strip.tsx`, `conflict-summary.tsx`; the conflict summary is computed locally with `git merge-tree` in `src/main/github/pull-requests/conflicts/conflict-summary.ts`).
- **PR lookup for the branch** (`src/main/github/client/lookup/pr-branch-lookup.ts`): `gh api repos/<o>/<r>/pulls?head=<owner>:<branch>&state=all&per_page=10` revalidated with ETag (`src/main/github/api/github-rest-revalidation.ts` sends `gh api <endpoint> --include -H "If-None-Match: ..."`; a 304 costs no primary quota), then an exact read by number (`gh pr view <n> --json number,title,state,url,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid,...`). Fallbacks: `gh pr list --head <branch> --state ...`, then `gh pr view <branch>`. A saved link on the worktree (linked PR number) wins over the branch lookup. Fork heads are matched by head owner.
- **Checks list** (`src/main/github/client/check/get-pr-checks.ts`): one GraphQL query on the PR's last commit (`statusCheckRollup.contexts(first: 100)` for check runs and legacy status contexts, plus `checkSuites(first: 100)` to catch suites waiting for approval). If GraphQL is blocked or fails: REST `check-runs`, `commit statuses` and `check-suites` for the head SHA. Last resort: `gh pr checks <n> --json name,state,link,startedAt,completedAt` (retries without times on old `gh`). The panel groups into "N passing / failing / pending" and sorts by severity.
- **Check details** (the expand arrow, `get-pr-check-details.ts`): `gh api repos/<o>/<r>/check-runs/<id>` (or `actions/jobs/<id>`), annotations (`per_page=20`), jobs of the workflow run (`actions/runs/<id>/jobs?per_page=100`), and a log tail from `actions/jobs/<id>/logs` (`check-job-log-download.ts`, `check-job-log-tails.ts`). The external-link icon opens the check URL.
- **Rerun**: `POST actions/runs/<id>/rerun-failed-jobs` or `/rerun`, or `check-runs/<id>/rerequest` (`rerun-pr-checks.ts`). Orca's docs call it "Rerun failed checks".
- **Polling** (`src/shared/source-control/hosted-review/review-refresh-policy.ts`, `src/shared/github/checks/checks-detail-polling-policy.ts`): PR state 60 s selected / 120 s not selected / 15 min closed or when no PR (60 s if selected); merged PRs only while checks are pending. Checks details back off from 60 s to 120 s while unchanged; failures back off 60 s up to 15 min. Cadence setting: default x1, reduced x5, minimal x10, off. A manual refresh and a push always read now; foreground return rereads data older than the interval; 10 s cooldown. After a push the first read waits 2.5 s (`POST_PUSH_DELAY_MS`). The host's background queue (`src/main/github/pull-requests/refresh/pr-refresh-pacing.ts`) allows at most 20 background reads per 5 min with 10 s spacing, and a burst cap for the active PR.
- **Checks tab dot**: derived from the cached PR checks status (`checks-panel/status/active-checks-status.ts`), not a separate poll.

### 8. Comments (the section under the checks)

- **Fetch** (`src/main/github/client/fetch/get-pr-comments.ts`, `pr-review-threads-query.ts`, `pr-conversation-pagination.ts`): one GraphQL query for `reviewThreads(first:100)`, issue `comments(first:100)` and `reviews(first:100)` with author type, avatar, body, `viewerDidAuthor`, reaction groups, thread `isResolved`, line range and diff side, then pagination until complete. If a source fails the others are kept; REST pages of issue comments, review comments and reviews (`.../pulls/<n>/reviews?per_page=100` among them) are the fallback. An incomplete conversation is an error, not a partial list.
- **Threads versus conversation**: inline review comments carry `threadId`, `path`, `line`, `startLine`, `isOutdated`, `diffHunk`; conversation comments and review summaries are standalone. Grouped sections sort newest first (docs).
- **Bots filter** (`src/shared/source-control/review-comments/pr-comment-audience.ts`): a comment is a bot when GitHub says the author type is `Bot`, the login ends with `[bot]`, matches a list of known review services (coderabbit, qodo, codecov, greptile, snyk, and others) or a few name patterns, or the user marked that author as a bot. The tabs are All, Humans, Bots with counts.
- **Writes**: add comment `gh api repos/<o>/<r>/issues/<n>/comments`; reply to a thread `pulls/<n>/comments/<id>/replies`; new inline comment `pulls/<n>/comments`; resolve or unresolve via GraphQL `resolveReviewThread` / `unresolveReviewThread`; reactions (the eight GitHub reactions). "Mark as bot" is a local override, not a GitHub setting.
- **The sparkle button and "Queue for agent"** send selected comment groups to an agent (see section 10). After launch Orca posts a reply on GitHub: "Fixing. Will be in the next commit" (or a bulleted batch version) and can resolve threads.

### 9. Merge and auto-merge

- **Manual merge**: `gh pr merge <n> --merge|--squash|--rebase` (`src/main/github/client/merge/merge-pr.ts`).
- **Auto-merge** (`pr-auto-merge.ts`): enable through the GraphQL `enablePullRequestAutoMerge` mutation (not `gh pr merge --auto`, which can merge at once) with the PR's node id, the chosen method and `expectedHeadOid`; disable with `gh pr merge <n> --disable-auto`. Repository metadata (`squashMergeAllowed`, `autoMergeAllowed`, `mergeQueue(branch:)`) comes from a GraphQL query (`client/detect/repository-merge-metadata.ts`), which decides which methods are listed and whether the button reads "Merge when ready" for merge queues.
- **When the control shows** (`src/shared/github/pull-requests/merge/pull-request-auto-merge-availability.ts`): PR open; hidden when conflicting, unstable, draft, or the repo disallows auto-merge; shown when already enabled, when a queue is required, or when the review or merge state is blocked or behind.
- **Stacked PRs** (GitHub Stacks) have their own create and merge-through flows (`src/main/github/pull-requests/stacks/`). I did not read them.

### 10. AI: commit messages, PR text, and fix-with-agent

Two families, both in `src/shared/source-control/ai/` and `src/main/text-generation/`:

- **Text generation (background, no UI of its own)**: commit message, PR details, branch name (also conversation names). The host spawns the user's agent CLI as a subprocess in the worktree, prompt on stdin, output parsed from stdout. For Claude: `claude -p --output-format text --model <m> --tools Read,Grep,Glob --allowedTools ... --permission-mode dontAsk --strict-mcp-config --settings {"disableAllHooks":true} [--effort low]`, with a legacy tool-policy variant for CLIs 1.0.69 to 2.0.42 (`src/shared/text-generation/launch/claude-background-run-isolation.ts`). For Codex: `codex exec --ephemeral --skip-git-repo-check -s read-only --model <m> [-c model_reasoning_effort=...]`. Specs for about a dozen agents are in `src/shared/source-control/ai/generation/commit-message-agent-specs-{primary,secondary}.ts`; models are discovered by asking the CLI (`list_models` for Claude, the app-server for Codex), with a built-in fallback list; the Claude default is `sonnet` (the Codex default was not read). Which agent runs: the Source Control AI setting, falling back to the user's default agent (inferred from the settings payload `commitMessageAi`, `sourceControlAi`, `defaultTuiAgent` that clients send with each call). Per-repo overrides exist ("action recipes").
- **Prompts**: commit message prompt in `src/shared/source-control/ai/generation/commit-message-prompt.ts` (imperative first line of at most 72 chars, optional wrapped body explaining why, output only the message, no trailers; staged diff up to 200,000 characters, shared fairly across files so one huge file cannot starve the rest). PR prompt in `pull-request-generation.ts` (compact JSON `{base,title,body,draft}`; body starts with `## Problem` then `## Solution` in simple language; linked-issue rule `Fixes #N` versus `Refs #N`; keeps template sections; commits up to 8k characters, changed files 8k, patch under the same budget). User text can be appended ("Additional user prompt"). Templates support variables such as `{basePrompt}`, `{branch}`, `{stagedFiles}`, `{stagedPatch}`, `{linkedIssue}`.
- **Staged context for commits** (`src/main/git/source-control/mutations/staged-commit-context.ts`): `git branch --show-current`, `git diff --cached --name-status`, `git diff --cached --patch --minimal --no-color --no-ext-diff` with a byte cap; an oversized patch degrades to the file summary.
- **Launch actions (open a real agent session)**: `fixCommitFailure`, `fixPushFailure`, `fixChecks`, `resolveConflicts`, `resolveComments` (`src/shared/source-control/ai/recipes/source-control-ai-actions.ts`). Each starts the chosen agent as a chat or a terminal in the worktree with a built prompt. Examples: fix checks (`src/shared/source-control/checks/pr-checks-fix-prompt.ts`) includes up to 5 broken checks with name, status, ids, URL and the last 150 log lines each; comments prompt (`pr-comments-resolution-prompt.ts`) embeds the selected threads as JSON marked untrusted, and tells the agent not to push, commit, rewrite history, or touch review state on the host, to run `git diff --check` and focused tests, and to report files changed and validation.
- **Local review loop**: "Annotate AI Diff" (`docs/site/content/docs/review/annotate-ai-diff.mdx`) is a separate, local feature: line notes in the diff that are sent to an agent as one prompt. It does not touch GitHub.

### 11. CI results fed back to agents (PR watch)

`src/main/github/pr-watch/`: when a chat's agent has opened or pushed to a PR (verified through its own commands), the host keeps a watch on that PR for 14 days (`ACTION_WINDOW_MS`), reads it through the same refresh queue, and on each new final CI result on a head appends one status line to that chat's transcript: `CI failing on <repo>#<n> at <sha7>` or `CI green on ...`. Lines are inserted between turns, never into one, and keyed by head SHA and occurrence so they are not duplicated. State is in SQLite (`pr-watch-storage.ts`). Observed: the line is a transcript notice (`presentation: 'pull-request-event'`); I found no code that turns it into an agent prompt. Turning failures into work is the user's "Fix broken checks" click.

### 12. Worktrees and these surfaces

- **Keying**: every panel is keyed by worktree id; `WorktreeSelector` in RPC and `resolveRegisteredWorktreePath(...)` in IPC map the id to a path and reject paths that are not registered worktrees.
- **Create** (`src/main/git/worktrees/creation/worktree-add.ts`): `git worktree add --no-track -b <branch> <path> <base>` (existing branch variant without `-b`), base resolved to a qualified ref with an optional local-base refresh, progress read from git's stderr. The start-from ref becomes the worktree's `baseRef`. Branch name comes from the workspace name, a linked PR, a Linear or Jira issue, or an explicit field. Listing: `git worktree list --porcelain [-z]`.
- **Fork PRs**: a worktree can carry a `pushTarget` (`remoteName`, `branchName`) so push, pull and status use the fork's remote; `fork-push-notice.tsx` and `syncFork` exist for this. The panel passes `activeWorktree.pushTarget` to every remote call.
- **"Rebase from origin/main"** (the base shown in the menu) is the temp-ref rebase in section 2, using the worktree's effective base.
- **When the branch is merged**: the Checks tab and sidebar show the merged state. A merged PR keeps a timed refresh (60 s) only while its checks are still pending; otherwise the timer stops. The worktree keeps its saved PR link, but if the worktree's HEAD later moves on to commits the merged PR did not contain (new work on the same branch), the link is cleared so Checks does not stay pinned to the old PR (`src/shared/github/pull-requests/refresh/linked-pr-staleness.ts`, `shouldClearDivergedLinkedMergedPR`). Containment is proved with `GET repos/<o>/<r>/commits/<sha>/pulls` (up to 5 pages of 100) in `src/main/github/pull-requests/refresh/merged-pr-commit-membership.ts`. A saved link is also cleared when the worktree switches to a branch that matches neither the PR's head nor its push target.
- **Cleanup** (`src/main/git/worktrees/removal/`): `git worktree remove [--force]`, then `git branch -d` (safe delete); if git refuses, a check whether the branch is already merged (including squash and rebase merges) before giving up; otherwise the branch is preserved and a toast "Review N Branches" lets the user force-delete. Merge proof (`src/shared/git/branches/git-branch-cleanup.ts`): `git merge-tree --write-tree`, `git cherry`, `git patch-id --stable`, `git merge-base --is-ancestor`, all offline. Automatic cleanup rules (`src/shared/workspace-cleanup/workspace-cleanup-policy.ts`): merged (off by default, uses local refs and the cached PR), unchanged for N days, inactive for N days, keep-when rules. Archive is not supported yet (`WORKSPACE_ARCHIVE_SUPPORTED = false`).
- **Detached HEAD**: `DetachedHeadBadge.tsx`; Create PR is blocked with `detached_head`; history shows the short hash as the current ref.
- **Folder workspaces** (no git): panels return empty states (`!activeWorktree || isFolder || !activeReview`); Orca's `AGENTS.md` lists "Folder Workspaces: Don't assume every workspace is a git worktree" as a first-class rule.

### 13. Remote, mobile and runtime split

- **Same code, three doors.** The runtime RPC method names mirror the IPC ones (`git.status`, `git.push`, `git.history`, `github.prChecks`, `github.mergePR`, `github.setPRAutoMerge`, and so on). Handlers are `defineMethod({ name, permission: 'workspace', params, handler })` in `src/main/runtime/rpc/methods/source-control/`; the handler resolves the worktree on the host and calls the same `src/main/git` code. Mobile uses the same methods (`src/main/runtime/rpc/server/runtime-rpc-mobile-method-routing.ts`); a browser build has its own preload shim (`src/renderer/src/web/preload-api/git/web-git-api.ts`).
- **No streaming for git or GitHub.** The streaming RPC methods in the registry are terminals, layout, agent sessions, accounts, Jira, browser and client events; every `git.*` and `github.*` method is plain request and response. Each call carries its own timeout (15 s for upstream status, 30 s for abort, about 2 min for rebase, derived from the host's own bounds). Freshness comes from polling plus triggers: the renderer schedules git status refreshes; the host schedules GitHub PR refreshes and pushes results to windows.
- **Where `gh` runs.** For a local workspace: the desktop machine. For a paired Orca server: the server (docs: log in with `gh auth login` on the server; settings show a server-side GitHub budget). For a plain SSH workspace: a code comment in `create-github-pull-request.ts` says "`gh` runs on this client whatever the host; only the git reads under it are routed", while `docs/site/content/docs/github-errors.mdx` says GitHub auth is per host and to log in on the SSH machine. These disagree (see Open questions).
- **Capability negotiation.** Clients and hosts of different versions are handled with explicit capabilities and receipts (for example, Stage All with `scope` requires a `stagedScope` receipt, else "update Orca on that host"). The cost is carried in many "older host" branches.
- **Version skew in settings.** The PR refresh cadence is a per-host setting, remembered per paired host, and a client never lets its own setting speed or slow another host's timers.

## Relevant files and modules

Renderer, `src/renderer/src/components/right-sidebar/`:

- `source-control/panel/*` — shell, header, branch row, dialogs, dropdown items, panel state
- `source-control/commit/*` — message box, commit action, discard dialog, failure notices
- `source-control/listing/*` — changes list, selection, file filter, conflict cards, submodules
- `source-control/sync/*` — status scheduler and observers, branch compare, history panel and graph SVG, remote action runner
- `source-control/review/*` — Create PR intent, eligibility, composer glue, manual review URL
- `source-control/ai/*` — AI action dialogs, recipes, generation hooks
- `checks-panel/*` — Checks tab: controller hooks, presentation, comments, logs, refresh
- `hosted-review/*` — create composer, provider actions (merge, state, stack), folder checks
- `components/source-control/BaseRefPicker.tsx` — base ref dialog
- `src/renderer/src/store/slices/editor/git/*` — store actions for status, remote ops, sync, branch compare
- `src/renderer/src/runtime/source-control/git/*` — local-or-RPC git clients

Shared (pure logic, `src/shared/`):

- `source-control/decisions/*` — primary action, create-review intent, base ref resolution, commit eligibility
- `source-control/dropdown/*` — menu rows and disabled reasons
- `source-control/hosted-review/*` — creation contracts, refresh policy
- `source-control/ai/*` — prompts, agent specs, recipes, settings
- `source-control/checks/*`, `source-control/review-comments/*` — fix prompt, bot filter, comment grouping
- `git/status/*`, `git/history/*`, `git/remotes/*`, `git/refs/*`, `git/diff/*`, `git/admission/*` — parsers and policies
- `github/checks/*`, `github/comments/*`, `github/pull-requests/*` — types and policies
- `rpc-contract/source-control/*`, `rpc-contract/github/*` — zod schemas for the wire

Main, `src/main/`:

- `git/command-runner/*` — exec, stream, environment, admission, WSL routing, process capture, `gh` and `glab` runners (`hosted-cli/`)
- `git/source-control/*` — status, upstream, compare, history, diffs, staging, commit, discard, blame, submodules
- `git/remotes/*` — push, pull, fetch, rebase, fork sync, push targets
- `git/refs/*`, `git/worktrees/*` — ref search and snapshots, worktree create, list, move, remove
- `github/client/*` — lookup, check, fetch, create, merge, update, list
- `github/pull-requests/refresh/*` — host-owned refresh queue, pacing, visibility, retry
- `github/pr-watch/*` — CI lines for chats
- `github/accounts/*`, `github/api/*` — `gh` auth inventory, bound-account tokens, rate-limit probe, ETag revalidation
- `text-generation/*` — spawning agent CLIs for commit and PR text
- `ipc/filesystem/{source-control,git-remote}/*`, `ipc/source-control/*` — IPC handlers
- `runtime/rpc/methods/source-control/*`, `runtime/integrations/git/*` — RPC handlers and the runtime git surface
- `providers/execution-host-provider-dispatch.ts` — local, SSH, runtime routing
- `gitlab/`, `bitbucket/`, `gitea/`, `azure-devops/` — other forges

User docs worth reading: `docs/site/content/docs/review/commit-push.mdx`, `review/github.mdx`, `github-errors.mdx`, `model/worktrees.mdx`, `remote-servers.mdx`, `settings.mdx`; engineering rules: `docs/agents-md-refs/git-workflow.md`, `docs/agents-md-refs/cross-platform-support.md`, root `AGENTS.md`.

## Constraints and gotchas for reproducing

Git:

- **Git floor is 2.25** (`docs/agents-md-refs/git-workflow.md`). Newer features are guarded by capability probes with fallbacks: `fetch --no-write-fetch-head` (2.29), `%(decorate:...)` (2.43), `merge-tree --write-tree` (2.38, used for conflict preview and merged proof). Capability caches are per execution host (`git-capability-state.ts`).
- **Error text is parsed**, so Orca pins English output and strips credentials and ANSI from messages (`normalizeGitErrorMessage`). Missing this makes divergence, no-upstream and auth errors unrecognizable on non-English systems.
- **Never fan out.** Orca's rule: do not enumerate every ref and run `ls-tree` or `show` per ref; no unbounded `--all` scans; bound output and cap rows.
- **Index lock friction**: reads set `GIT_OPTIONAL_LOCKS=0`, status waits for `index.lock`, mutations are serialized per worktree, and background polls use a lower admission tier than clicks.
- **Hooks and signing**: commits run hooks and GPG as normal; failures return stderr to the UI. No `--no-verify` anywhere in the commit path.
- **Divergent pull**: git 2.27+ refuses without a strategy; Orca retries `--no-rebase`. Force push is `--force-with-lease` and only for patch-equivalent divergence.
- **Windows**: long-path args on `worktree`/`add`, a process runner that pins `windowsHide` and refuses `shell: true`, `GIT_ASK_YESNO` removed, line-ending checks for WSL-hosted checkouts on Windows git. See `docs/agents-md-refs/cross-platform-support.md`.
- **WSL** (`src/main/git/command-runner/host-routing/wsl-*`): repositories on WSL paths run git inside the distro via `wsl.exe --exec` (never `--`, which expands `$vars`); output is fenced because login shells print banners; UNC paths are translated; drive checkouts and linked worktrees need route probing; polls must not start a stopped distro. `src/wsl-guest/` is for agent-hook and browser relays, not git.
- **Detached HEAD, unborn HEAD, no merge base, invalid base, no upstream, no remote**: all are explicit states in compare, status and eligibility, each with copy.
- **Submodules**: status, diff and restore have dedicated code (`source-control/submodules/`).
- **Huge repos**: 1000-row cap, untracked-directory expansion, ignore suggestions; branch-change list caches stamped by file mtimes.

GitHub:

- **`gh` is required** for every GitHub surface. Install and login are the user's job; Orca expects scopes `repo`, `read:org`, `project` (`auth-diagnose.ts`). Missing `gh`, bad auth, 403, 404 and rate limits are classified from stderr text (`gh-error-classification.ts`, `code-host-failure-copy.ts`), which is brittle across `gh` versions (example: retry without `startedAt` when `gh` says "unknown json field").
- **Token handling**: none stored. For multi-account, `gh auth token --user <u> --hostname <h>` is run and the token is placed in the child's environment only, cached 5 min in memory (30 s negative), with ambient `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `GH_REPO` stripped (`github/accounts/gh-account-token.ts`). Environment tokens override the keyring and cannot be refreshed by `gh auth refresh`; the docs call this out as the top footgun.
- **Enterprise hosts**: a remote is treated as GitHub Enterprise only when `gh auth status` lists that host as logged in (15 min cache; 60 s negative); `--hostname` is added to calls; SSH host aliases are resolved (`ssh -G`). GitLab, Bitbucket, Azure DevOps and Gitea are recognized by public host name (`src/shared/git/remotes/public-forge-host.ts`) or by configuration.
- **Rate limits**: three buckets (core, graphql, search). A primary 403 trips a per-bucket, per-host, per-runtime breaker (fallback blocks 5 min for core and graphql, 70 s for search) until a reset probe learns the real reset; reads then serve the last known status with a banner. `gh api rate_limit` is quota-exempt and cached 30 s. Client-side spend is tracked (`noteRepositoryRateLimitSpend`) and a guard refuses calls near exhaustion. All `gh` work goes through a 4-slot limiter (`github-operation-slots.ts`) with retry for transient failures (HTTP 5xx, connection resets, 429 without `Retry-After`; backoffs of 250 ms then 1 s; idempotent calls only; an explicit `Retry-After` is honored up to 30 s). Default `gh` timeout 30 s.
- **Checks need head SHA keys.** Orca disabled `gh`'s own disk cache for checks because its key ignored the PR head and served the previous head's checks after a push. Reads are keyed by repo, PR, head SHA and a review generation that increments on any PR mutation.
- **Create PR is not idempotent**: verify by lookup after any ambiguous failure.
- **Fork PRs, stacked PRs, merge queues**: each adds a path; fork heads are matched by head owner and may be unsupported for creation (`fork_head_unsupported`).
- **GitLab and Bitbucket**: supported with the same flow through `glab` and REST. GitLab adds pipelines, bridge and child jobs and traces; Bitbucket has no drafts and keeps an encrypted credential file; Azure DevOps and Gitea use environment tokens only (`ORCA_AZURE_DEVOPS_TOKEN`, `ORCA_GITEA_TOKEN`).

AI generation:

- Needs the user's agent CLI installed and signed in on the host. Windows, WSL and SSH each have launch variants (`source-control-wsl-launch`, `source-control-remote-generation`). Prompts are sized to avoid argv limits by using stdin. Claude CLI flag drift is real (legacy tool-policy variant for 1.0.69 to 2.0.42, enterprise MCP refusal retry, `dontAsk` mode refusal retry). Generation runs in lanes with cancellation, and failures have per-agent copy (`failures/`).

Behavioral:

- No automatic `git fetch` anywhere I looked. Behind counts and compare results reflect the last fetch.
- Polling only for what is visible: the active worktree's git status, the PRs windows report as visible, the selected PR for checks.
- Comments from GitHub are untrusted text when put into agent prompts; Orca labels the JSON as data.

## What it would cost to reproduce

Observed sizes (non-test TypeScript lines, `wc -l` over the folders): `src/main/git` 25.1k (223 files), of which command runner 6.2k, source-control reads and writes plus remotes plus refs 10.5k, and worktree lifecycle, cloning and objects 8.3k; `src/main/github` 29.9k (213 files), of which PR, checks, comments, accounts, refresh and watch 23.9k and GitHub Projects, issues and work items 5.7k (not source control); `src/main/text-generation` 4.4k; `src/shared/git` 10.3k; `src/shared/github` 3.9k; `src/shared/source-control` 13.1k; renderer `source-control` 29.5k (214 files), `checks-panel` 15.3k (78), `hosted-review` 6.2k (42); runtime clients 1.8k; runtime RPC methods and git integration 3.2k. Excluding the 5.7k of Projects and issues, that is roughly 130k lines for git, GitHub and the panels, plus GitLab 5.5k, Bitbucket 1.2k, Azure DevOps 1.2k, Gitea 1.0k. It is built by a large team over many months with real-repo tests for most git behavior.

What the two screenshots need as raw material (observed from the code above):

- about 25 distinct git invocations (status, numstat, cat-file, add, reset, restore, clean, commit, push, pull, fetch, rebase with fork point and temp ref, merge-base, rev-list count, diff raw numstat, log with graph format, for-each-ref, rev-parse, symbolic-ref, worktree add, list, remove, branch -d, and the merged-proof set);
- about 12 `gh` shapes (`pr create`, REST `pulls?head=` with ETag, `pr view --json`, GraphQL checks rollup, GraphQL review threads, GraphQL resolve and unresolve, REST check-runs and annotations and job logs, rerun endpoints, `pr merge` and the auto-merge GraphQL, issue-comment and reply REST, `auth status` and `auth token`, `api rate_limit`);
- one agent CLI spawn per text task.

Inference (not measured): a straight port of only the visible behavior, GitHub-only, local-only, `gh` required, no WSL or SSH routing, no stacks or merge queues, no GitLab family, would be on the order of 8k to 12k lines plus tests: roughly 2k in the git layer, 2k in the GitHub layer, and 4k to 8k in panels (the Source Control tab with graph, the Checks tab with comments). That is about a tenth of Orca's size. The unmeasured part is the cost of the careful parts below, which a straight port skips and later pays for in bug reports.

Where Orca's size comes from, so the choice of what to copy is deliberate (inference from file names and comments):

- caches and coalescing keyed by HEAD, index, config, SHA and review generation (status leases, numstat reuse, branch change cache, checks reads);
- Windows, WSL and SSH routing and wake rules;
- rate-limit breaker, spend tracking, probe, pacing, and failure copy per error class;
- capability and version-skew handling between clients and hosts (receipts, "older host" branches);
- recovery flows (Fix with AI for commit, push, checks, conflicts, comments) and the action-recipe settings behind them;
- per-forge parallel implementations.

Cheap and high-leverage ideas Orca shows (observed): host-side Stage All with a scope instead of passing a capped list; porcelain v2 `--branch` for branch, upstream and ahead/behind in one call; paths on stdin for bulk staging; a decision function that picks the one primary button; showing every menu action with a disabled reason; `--force-with-lease` offered only when remote-only commits are patch-equivalent; rebase through a temporary ref so concurrent fetches cannot swap the target; ETag revalidation for the PR-by-branch lookup; reading checks as one GraphQL query keyed by head SHA; host-owned polling with window-reported demand; commit and PR text from the user's agent CLI (no key management).

## Open questions

1. **Where does `gh` run for a plain SSH workspace?** Code (`create-github-pull-request.ts`) says on the client; docs (`github-errors.mdx`) say on the host. I did not trace `resolveGitHubRepoExecution` end to end. Matters for any design where one process owns both git and `gh`.
2. **Do the CI lines ever wake an agent?** Code only appends a transcript notice; I found no path from it to a prompt. The user path is "Fix broken checks".
3. **Is there any deliberate background fetch?** None found in the status loop, compare or Checks code. I did not search the sidebar workspace list or the PR refresh code for a fetch.
4. **How does a launch action choose between an agent chat and a terminal** (`surface: 'chat' | 'terminal'` in the recipe type)? I only read the recipe types, not the launcher (`source-control/ai/runSourceControlAgentActionStart.ts`).
5. **Cherry-pick, revert, create-branch-from-commit, sequencer continue** command lines are not read (`git-commit-action.ts`).
6. **How does the SSH relay run git** (the relay's own binary and protocol)? Not read.
7. **Real-world cost of the CLI-driven text generation**: latency and failure rate of spawning `claude -p` per commit message are not measured anywhere in the source. Orca keeps a `--effort low` default and a cancel path, which suggests it is slow enough to need both (inference).
8. **Auth UX without `gh`**: I read the error classification and docs, not the empty-state components in full, so the exact first-run copy and any "install gh" action are unconfirmed.

## Assumptions and limits

- Static reading of a shallow clone at `de67267a`; no build, no run, no network calls. Tests were mostly skipped (a few names noted). Behavior may differ from the shipped app of the same date.
- Read closely: status, staging, commit, remotes (push, pull, fetch, rebase), upstream, branch compare, history, base ref resolution, primary action and dropdown decisions, Create PR intent, create PR call, PR lookup, checks, check details and rerun entry points, comments fetch and prompts, merge and auto-merge entry points, text generation specs and prompts, PR watch, worktree add and removal, accounts and rate-limit code, execution-host routing, user docs.
- Skimmed only: renderer presentation components (`checks-panel/presentation`, `comments/*`), stacks, GitLab, Bitbucket, Azure DevOps, Gitea, SSH relay, WSL path translation, mobile app (`mobile/`), web build (`src/renderer/src/web`), `cloud/`, Linear and Jira links, plugin surfaces.
- Line counts are `wc -l` over `.ts` and `.tsx` files excluding names matching `.test.`, `.fixture.`, `test-harness` and `test-mocks` in the listed folders; folders may overlap slightly through shared imports but not in file counts.
- "Cost to reproduce" figures in the last section are my estimates from command and screen counts, not measurements.
