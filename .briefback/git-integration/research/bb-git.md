# How bb builds its git and GitHub surfaces

Source: local shallow clone of get-bb/bb at commit `796cdcc` (2026-11-21), MIT licensed. All paths below are relative to the bb repo root. "Observed" means I read it in the code or docs. "Inference" means I reasoned from what I read and did not run it.

## Summary

- Every surface in the screenshots is a **plugin** inside bb, not core UI. Three are bundled and on by default: `plugins/git` (composer strip, Thread info rows, Diff tab, Commit action), `plugins/github-pr-status` (the `PR #34` chip, the Pull request info row, PR status and actions), and the environment plugins that supply the branch chips. The full **`GitHub PR` tab (screenshot 5) is a different plugin, `plugins/github`**. It is an "official" plugin: it ships inside the app but is not auto-installed, it is installed from the catalog with `bb plugin install github`. The owner's hunch is right: that tab is optional and separate.
- Plain `git` and `gh` CLI calls do all the work. There is no libgit2, no GitHub REST client of its own, no OAuth, no token storage. Auth is whatever `gh auth login` set up on the machine.
- Git reads run in a per-plugin "host entry" on the machine that owns the workspace. A server-side half caches and serves them. The React half renders. Clowdy has one machine, so these three halves collapse into the daemon plus the renderer.
- The Diff panel parses `git diff` patches with `@pierre/diffs` and renders them through a host-provided `Diff` component (also `@pierre/diffs`, with a worker pool). Files are loaded lazily behind a virtualized list.
- **The `Commits` list is the whole branch, as suspected.** It is `git log --left-right <base>...HEAD`, where the base is the "merge base branch" (default branch unless changed). It never consults the PR. The only filters are patch-id equivalence (cherry-picks) and a whole-branch squash-merge check. A long-lived branch such as `dev` therefore keeps old, already-shipped commits in the list.
- The composer strip shows **one section only**: Uncommitted if there are working-tree changes, otherwise Committed (the branch's files against the merge base). Showing `Files changed` instead of `Uncommitted` is a change in which section sorts first, not a new data path (the data already exists).
- A correction to the brief: the second icon on each diff file header is **"Open (file name) in editor"**, not "open on GitHub". Only the PR chip and the PR tab link out to GitHub.
- bb offers exactly one git write action, **Commit** (off by default): `git add -A` then `git commit -m <AI-written subject>`. It has no push, pull, create-PR, or comment-on-diff flow. PR actions are `gh pr ready` and `gh pr merge` (and `gh pr comment` in the optional PR tab).

## How it works

### The shape of a bb plugin (so you know what is core)

A plugin's `package.json` declares up to three entries under `bb`: `server`, `host`, `app` (see `plugins/git/package.json`).

- `server` runs in the bb server process. It registers typed RPC reads and mutations (`bb.rpc.register`, zod contracts), keeps caches, subscribes to `environment:changed`, `thread:changed`, `host:changed` events, owns a small SQLite database (`bb.storage.database()`) and settings, and can register CLI commands.
- `host` (`experimental_defineHostEntry`) runs on the machine that owns the workspace, inside the host daemon's plugin-host worker. It is the only place that spawns `git` and `gh` for workspace data. The server calls it with `bb.hosts.experimental_client`.
- `app` is React. It registers UI into named slots: `experimental_tab`, `experimental_threadContextSegment` (the strip above the composer), `experimental_threadInfoRow` and `experimental_threadInfoSection` (Thread info), `experimental_threadAction`, `experimental_appOverlay`, and commands.

Almost every hook name carries an `experimental_` prefix, so the SDK is not declared stable. Core still depends on the git plugin: `apps/server/src/services/environments/git-plugin-reads.ts` calls plugin `bb--git` for the Commit action, and the composer branch chip reads its contract. If the plugin is off, the commit route returns 409 "Turn on the Git plugin".

Registry of what ships how: `apps/server/src/services/plugins/builtin-registry.ts`. `BUILTIN_PLUGINS` (auto-installed): `git`, `github-pr-status`, `environment-project-checkout`, `environment-git-worktree`. `OFFICIAL_PLUGINS` (`autoInstall: false`): `github`, among others.

Which process runs `git`/`gh`:

| Work | Process |
| --- | --- |
| git status, diff, log, merge-base, untracked stats | git plugin host entry (`plugins/git/host.ts`) on the workspace machine |
| PR lookup, PR checks, `gh pr ready/merge` | github-pr-status host entry (`plugins/github-pr-status/host.ts`) on the workspace machine, so that machine's `gh` login applies |
| PR list sync, PR detail, PR comment, Review with agent | `plugins/github/server.ts`, in the bb server process (`gh` is spawned on the server machine) |
| File-change watching | host daemon, `apps/host-daemon/src/watch-manager.ts` plus `packages/host-watcher` (`@parcel/watcher`) |
| Commit message generation | bb server (`apps/server/src/services/ai/commit-message.ts`) |
| Commit itself | host daemon, `packages/host-workspace/src/host-workspace.ts` `commit()` |

### Surface 1: the strip above the composer (screenshot 1)

Two separate plugins contribute to the same slot (`experimental_threadContextSegment`), so the strip looks like one bar.

- `PR #34` comes from `plugins/github-pr-status/ui/PullRequestContextSegment.tsx`. It is an anchor to the PR URL (opened through `navigate.openUrl`), with a state colour, a check-status dot, a one-line "next step" label in some states, and, when mergeable, a split Merge button (merge, squash, rebase, plus Convert to draft) or Mark ready on a draft. Setting `showPullRequest` hides it.
- `Uncommitted · 3 files, +387 -0` comes from `plugins/git/ui/segment/ChangedFilesSegment.tsx`. Setting `showGitChanges` hides it. It reads the shared `status` read for the thread's environment and shows the first element of `selectWorkspaceChangedFilesSections` (`plugins/git/ui/workspace-change-summary.tsx`). That function builds a list in a fixed order: the working-tree section first (labelled `Uncommitted`, or `Untracked` when every dirty file is untracked), then the committed section (`Committed`, from the merge-base comparison). Only `[0]` is rendered. If the working tree is clean, the strip shows `Committed · N files` for the branch. The strip also hosts the merge-base branch picker.
- The status letters come from `formatWorkspaceFileStatus`: git's `??` is displayed as `A?`. Clicking a row opens the Diff tab scrolled to that file, or a file preview for added and untracked files.
- The chips under the composer (project, `Project checkout`, branch `dev`, the + button) are core's environment summary plus the `environment-project-checkout` plugin, which offers current, existing, and new branch controls and refuses a switch when the checkout is dirty or another live thread uses it (`plugins/environment-project-checkout/README.md`).

### Surface 2: Thread info panel (screenshot 2)

Core owns the panel and the Parent, Project, Environment and Directory rows. The git plugin adds `plugins/git/ui/info/GitInfoRows.tsx` (Branch, Merge base, Git status), `CommitsInfoSection.tsx` (Commits, then a `Files changed` sub-list) and `UncommittedChangesInfoSection.tsx`. The Pull request row comes from `github-pr-status/ui/PullRequestInfoRow.tsx`.

- Branch: from `status.checkout` (branch, detached with a short sha, or unborn).
- Merge base: a branch picker. Hidden when the current branch is the default branch. The chosen value is saved on the environment record in the bb server through the `setMergeBase` RPC (it calls `bb.sdk.environments.update`, and stores `null` when the pick equals the implicit default).
- Git status: `N ahead, M behind <base>`, `N ahead of <base>`, `M behind <base>`, or `Even with <base>` (`formatBranchComparison`). A small info icon appears when the squash-merge check was cut short.
- Commits: newest first in this panel (the status read stores them oldest first and the panel reverses them; the Diff scope dropdown shows them oldest first, which matches screenshots 2 and 3). Each row copies the sha or opens that commit in the Diff tab. A relative time and `<shortSha> · <author>` show on hover.
- Files changed: the committed section, with a status glyph, name, folder hint, and a five-segment +/- bar. Collapsed to five rows with `N more`.
- Uncommitted files: the working-tree section, the same list component.

### Surface 3: Diff panel (screenshots 3 and 4)

`plugins/git/ui/diff/*`, registered as a fixed side-panel tab `diff` (`Mod+D` toggles it).

- **Scope dropdown** (`gitDiffPanelHelpers.ts`): `All changes`, `Committed changes` (only if the branch has commits), `Uncommitted changes` (only if the tree is dirty), then one entry per commit from `status.mergeBase.commits`. The dropdown maps to four diff targets in `contract.ts`: `all`, `branch_committed`, `uncommitted`, `commit`.
- **Header counts** (`16 files, +491 -38`): the `files` read's totals. Here 16 = 13 committed files plus 3 untracked, and +491 = 104 + 387, which matches screenshot 2.
- **File cards** (`DiffFileCard.tsx`, shared `packages/shared-ui/src/components/git-diff/*`): collapsible, sticky header, change kind, +/- tally, a `Viewed` checkbox, copy path, "open in editor", and a diff body. With more than 10 files, cards start collapsed (`GIT_DIFF_AUTO_COLLAPSE_FILE_THRESHOLD`). Selected lines can be sent to the chat ("Add to chat").
- **Renderer**: `@pierre/diffs` (`~1.2.12`). Patch text is parsed with `parsePatchFiles` in `git-diff-parsing.ts`. The plugin renders through the SDK's `experimental_Diff` primitive, which core implements as `FileDiff` from `@pierre/diffs/react` with a shared worker pool for highlighting (`apps/app/src/components/code/BbDiff.tsx`, `apps/app/src/lib/pierre-worker-pool-*.ts`). Unified or split, wrap or scroll, and expandable context (full-file contents are fetched through the `fileSide` read, which uses `git`-ref aware file reads).
- **List virtualization**: `@tanstack/react-virtual` in `DiffFilesPanel.tsx`. Only visible rows plus overscan ask for patches, debounced 80 ms, up to 50 keys per request.
- **Filters** (`filter-diff-files.ts`, `diff-file-filters.ts`): the search box takes comma-separated patterns. A pattern with no glob characters is a case-insensitive substring match. A glob is matched with `picomatch` (case-insensitive, dotfiles included). `!pattern` excludes. A pattern with no slash matches the basename. Also: file-extension multiselect with counts, `Deleted files` and `Viewed files` toggles, and `Reset filters`. This is all client-side over the file list.
- **View settings** (`git-diff-view-preferences.ts`): unified or split and wrap lines live in the browser's `localStorage` (`bb.thread.gitDiff.*`). **Hide whitespace is not a CSS toggle**: it adds `-w` to the git commands, so the server re-reads the file list and patches (files that only differ in whitespace stay listed with +0 -0 and an empty patch).
- **Viewed persistence** (`plugins/git/server/viewed.ts`): a SQLite table in the plugin's own database on the bb server, `viewed_files(environment_id, target_key, path, revision)`. `target_key` is `uncommitted`, `branch_committed:<mergeBaseBranch>`, `all:<mergeBaseBranch>`, or `commit:<sha>`. `revision` is the file's `<oldMode>:<oldBlob>:<newMode>:<newBlob>` string. A file counts as Viewed only while its current revision equals the stored one, so any later edit un-views it automatically. Marks for deleted environments are purged at startup. It is server-side, so it survives browser clears and is shared by devices.
- **Large files** (`host/diff-tiering.ts`, `host.ts`): a file with up to 500 changed lines loads automatically (`auto`). Binary files or more than 500 changed lines load on demand (`on_demand`). More than 20,000 changed lines is never loaded (`too_large`). The first response inlines patches only when there are at most 10 files. Each patch is cut at 512 KB, and one batch at 6 MB (the rest is deferred to follow-up calls). The file list stops at 500 entries (`DIFF_MAX_FILES`) and marks itself truncated. Untracked paths are capped by the same 500 budget.

### Surface 4: PR status (the chip, the Info row, the sidebar badge)

`plugins/github-pr-status`.

- **Branch to PR**: the host entry reads the branch's remote config with `git config --null --get-regexp` for `branch.<b>.remote|merge|pushremote`, `remote.pushdefault`, and `remote.*.url|gh-resolved`, plus `git rev-parse --verify @{u}` and the current branch. It picks the base repo the way `gh pr view` does: the remote `gh` resolved with `gh repo set-default`, else `upstream`, then `github`, then `origin`, then any other remote, with `GH_REPO` overriding. Then one GraphQL query per branch: `repository { pullRequests(headRefName: "<branch>", first: 100, orderBy: {CREATED_AT, DESC}) }`. Candidates are filtered by head owner (same repo, or the fork owner). On the default branch only open PRs match. Otherwise the first **open** candidate wins, else the newest (merged or closed). That is why screenshot 2 shows `#34 Merged` for `dev`: the branch's newest PR stays attached until a new one opens. When no remote config resolves, it falls back to `gh pr view [owner:branch] --json url`.
- **How it is called**: `gh api graphql --hostname <host> --method POST --input <temp file>`. Reads on one machine are grouped by host and credential (hashed from `GH_TOKEN`/`GITHUB_TOKEN` or the gh config dir's `hosts.yml`, with a Windows branch that looks in `%APPDATA%\GitHub CLI`) into documents of at most 25 reads, with a 10 ms collection window. Rate limits pause a credential for at least a minute.
- **Fields read**: number, title, state, url, isDraft, autoMergeRequest, isInMergeQueue (dropped for GitHub Enterprise servers that lack it), base and head ref names, head oid, updatedAt, reviewDecision, review request count, mergeStateStatus, mergeable, fork info, and the last commit's `statusCheckRollup.contexts` (first 100, paged by cursor).
- **Rolled-up state** (`assemble.ts`, `ui/display.ts`): checks are de-duplicated by name (latest start wins) and counted as passed, failed, pending, or unknown. Together with review decision, conflicts, merge state, and merge queue, they produce one `attention` value (`checks_failed`, `changes_requested`, `conflicts`, `blocked`, `checks_pending`, `review_requested`, `queued`, `ready_to_merge`, `draft`, `merged`, `closed`, `none`), which drives the colour, the red cross or yellow dot, and the "next step" label.
- **Actions**: `gh pr ready <url> [--undo]` and `gh pr merge <url> --merge|--squash|--rebase`. Each re-reads the PR first and refuses unless the PR is in the right state and GitHub says mergeable. There is no create-PR action anywhere in bb.
- **Refresh** (`plugins/github-pr-status/PLUGIN_OVERVIEW.md`, `README.md`): while a view is watching, an open or draft PR with pending checks, auto-merge, a queue entry, or unknown mergeability is re-checked about every 30 seconds. Other open or draft PRs are re-checked about every 5 minutes. Merged and closed PRs never poll. App reads answer from cache at once and refresh in the background when stale: 30 s for open or draft, 1 hour for merged or closed, 5 minutes for "no PR". Opening a thread always re-checks. A branch change re-discovers immediately, and a turn on a branch with no PR re-discovers. Known PRs re-check only after a turn that ran `gh`. Ref events compare the local upstream oid and do not fetch. State survives restarts through the plugin's SQLite (`persistence.ts`); no tokens or ETags are stored.

### Surface 5: the `GitHub PR` tab (screenshot 5)

`plugins/github/app.tsx` (`PullPanelTab`, `PullDetailView`) and `plugins/github/server.ts`. It registers the tab with `availability: "action"` (the user opens it from the side panel's + launcher, unlike the Diff tab, which is `fixed`). The same plugin also has a full-page GitHub panel with Issues and Pull requests lists across tracked repos.

- It finds the thread's PR by calling the **github-pr-status plugin's RPC** from its own server (`bb.sdk.plugins.callRpc`, plugin id `bb--github-pr-status`, method `pullRequests`) and matching the URL. If that finds nothing, it falls back to links it stored when "Review with agent" started a thread.
- Detail data (`getPull`) is live, three parallel `gh` calls run by the **server** process: `gh pr view <n> -R <repo> --json number,title,body,state,isDraft,author,createdAt,updatedAt,labels,assignees,url,baseRefName,headRefName,additions,deletions,changedFiles,reviewDecision,mergeStateStatus,statusCheckRollup,comments,reviews,reviewRequests`, `gh api --paginate --slurp repos/<repo>/pulls/<n>/comments?per_page=100` (review threads), and `.../pulls/<n>/files?per_page=100`. The `Checks 1/1 passing` row comes from `statusCheckRollup`. The PR description is rendered markdown. The per-file diffs use the `patch` text from GitHub's files endpoint through the same `Diff` primitive. A file where GitHub omits the patch shows "Diff too large to inline". So this tab's `Files changed (4, +42 -0)` is the PR's own file list from GitHub, not a local git computation.
- `Leave a comment…` runs `gh pr comment <n> -R <repo> --body <text>`. It posts a conversation comment, not an inline review comment.
- `Review with agent` calls `bb.sdk.threads.spawn` in the repo's bb project with a prompt that tells the agent to run `gh pr view <n> -R <repo> --comments` and `gh pr diff <n> -R <repo>`, review for correctness, tests and design, and not push or post unless asked. The link between thread and PR is stored in the plugin's storage.
- The lists are cached from a background sync every 15 minutes (30 s retry doubling to 5 minutes on failure), one `gh api graphql` request per tracked repo (100 open and 50 closed issues, 50 open and 30 closed or merged PRs). It tracks repos whose project checkout has a GitHub `origin`, plus an `extraRepos` setting. It needs `gh auth login` and reports "needs configuration" otherwise.

### Git actions bb offers

- **Commit** (`plugins/git/ui/commit/*`, route `POST /environments/:id/actions` in `apps/server/src/routes/environments.ts`). Shown as a header button only when setting `showCommitButton` is on (default off) and the working tree has changes. The dialog has no message field. The server reads the same status and diff the UI uses (diff excerpt capped at 32,000 bytes, file list at 4,000 bytes), asks an AI service for one line, then runs on the host: `git add -A`, `git diff --cached --quiet` (to detect "nothing to commit"), `git commit -m <message>`, `git rev-parse HEAD`, `git log -1 --pretty=%s`, all under a per-checkout mutation lock. Concurrent commits for one thread are queued on the client.
- **Commit message generation**: task `commit-message` in a per-task AI-service registry (`apps/server/src/services/ai/ai-tasks.ts`, `ai-service-registry.ts`, `packages/domain/src/ai-services.ts`). Default selection is `automatic`. The prompt (`packages/templates/src/templates/generate-commit-message.md`) asks for one conventional-commit line, imperative, at most 72 characters, no body, and passes the shortstat, name-status list and a patch excerpt. The reply is stripped of quotes and extra lines and cut to 72 columns. Timeout is 8 seconds. On any failure the message is the fixed string `bb: automated commit`.
- **Branches**: creating or switching branches is the environment plugin's job, not the git plugin's. `plugins/environment-git-worktree` creates worktrees from a base (origin or local rules below). No git push or pull is run anywhere in these plugins. `git fetch --prune --quiet <remote>` runs only when a branch picker opens (and for `bb git branches`), at most once every 30 seconds per repo (`packages/environment-provider-host/src/branch-options.ts`), and when a worktree is provisioned.
- **PR**: ready, draft, merge, comment, review with agent (above). No PR creation.
- **CLI**: `bb git status|files|diff|patch|file|viewed ...`, `bb pull-request show|ready|draft|merge`, `bb github ...` mirror the same reads for agents (`plugins/git/skills/git/SKILL.md`).

### Refresh: how a view stays current

1. **File changes.** The host daemon watches each watched workspace with `@parcel/watcher`: the workspace root (ignoring `node_modules`, `.cache`, `__pycache__`, `.git` internals, and every directory that `git status --porcelain=v1 -z --ignored=matching` reported as ignored or as a nested repository, `packages/host-watcher/src/workspace-root-ignores.ts`, `watch-specs.ts`), plus the git dir and, for linked worktrees, the shared common dir (ignoring `hooks`, `info`, `logs`, `modules`, `objects`, `worktrees`). Events are debounced 75 ms (500 ms max wait). Any workspace content event emits `work-status-changed` at once. A git-dir event is checked against a fingerprint (the porcelain v2 status text plus HEAD) before emitting. A shared refs event (`refs/heads`, `refs/remotes`, `packed-refs`) is checked against a refs fingerprint and emits `git-refs-changed` or `git-branches-changed`. (`apps/host-daemon/src/watch-manager.ts`)
2. **Server side coalescing** (`plugins/git/server/invalidation.ts`). The plugin turns those events into cache tags (`status:<env>`, `files:<env>`, `refs:<env>`, `viewed:<env>`) and flushes one batch per environment: 250 ms debounce, 500 ms max wait, and never more than once per second. It only does this for environments someone is currently watching (`experimental_whileWatched` on the keyed reads), with reference counting across clients.
3. **After an agent turn.** The plugin subscribes to `thread:changed`; when a thread's status becomes `idle` or `error` it bumps the generation, drops the caches, re-reads status, and invalidates only if the serialized status changed.
4. **Freshness tokens and memo** (`server/generations.ts`, `server/reads.ts`). A "work" generation is trusted for 3 s and a "refs" generation for 30 s. Status and file reads are memoized for 3 s. The merge-base status itself is cached by (head sha, base sha, merge-base branch, file cap) in a 16 MB byte-budget cache, so identical commits are never re-analysed.
5. **PR**: timers above, plus "refetch on show" when a page becomes visible again (`github-pr-status/ui/refetch-on-show.ts`).
6. **No auto-fetch.** Status never fetches from the network. `behind` counts and squash detection use the last fetched `origin/*` refs. (Observed from code and docs; the consequence below is inference.)

### What each number means (the git commands)

All commands run with `GIT_OPTIONAL_LOCKS=0`, a sanitized environment, `LANGUAGE=C`, and config overrides that force no colour and `a/` `b/` prefixes (`packages/environment-provider-host/src/workspace-git.ts`, `MACHINE_READ_GIT_CONFIG`). Diff commands also run against a **temporary copy of the index** (`GIT_INDEX_FILE` pointed at a copy, split-index disabled), so reads never touch the repo's real index. (Inference on why: avoid `index.lock` contention with agents; the code does not say.)

| Fact on screen | How it is computed |
| --- | --- |
| Current branch, HEAD, dirty file list | `git --no-optional-locks status --porcelain=v2 --branch -z --untracked-files=all`. `# branch.head` gives the branch (`(detached)` means none), `# branch.oid` the HEAD (`(initial)` means unborn). One snapshot per freshness token, shared by every read. |
| Uncommitted file count | Number of entries in that status output, so it counts staged, unstaged, conflicted and **every untracked file** (`--untracked-files=all`). |
| Uncommitted `+/-` | `git diff --numstat -z HEAD --` for tracked changes (staged and unstaged against HEAD). On an unborn HEAD it diffs against the empty tree (`git hash-object -t tree --stdin` on empty input). |
| Untracked `+/-` | A temp index gets the untracked paths with `git add --sparse --intent-to-add --pathspec-from-file=<file> --pathspec-file-nul`. Then `git diff --raw --numstat --no-abbrev -z` on that index counts them as added files. Per-file stats are cached by (mode, size, mtime, ctime, inode) with a racy-timestamp guard. Budget: at most 50 untracked files, 8 MB in total, 10 s. Over budget, `lineStatsComplete` is false and the strip shows only `N files` without `+/-`. |
| Default branch | `git symbolic-ref --quiet refs/remotes/origin/HEAD`, else local `main`, else local `master`, else the first local branch (`for-each-ref`). |
| Merge base branch | The environment record's saved choice, else the environment's `baseBranch` (set when the environment plugin created the branch or worktree), else the default branch (`resolveEnvironmentMergeBaseBranch` in `packages/domain/src/environment.ts`). For a plain project checkout with no choice this is the default branch. |
| Comparison ref | `resolveBranchRef`: for a bare name like `main`, read `refs/heads/main` and `refs/remotes/origin/main`. Use `origin/main` when local is equal to it, behind it, or absent. Use local `main` when local is ahead or diverged. A name already like `origin/x` or `refs/...` is used as given. Then `rev-parse --verify <ref>^{commit}` for the sha. |
| `Merge base` commit | `git merge-base <comparisonSha> HEAD`. |
| Ahead, behind, Commits | `git log --left-right --format=%m%x1f%H%x1f%h%x1f%s%x1f%an%x1f%at <comparisonSha>...<headSha>`: `<` lines are behind, `>` lines are ahead. This is **symmetric difference**: ahead = commits reachable from HEAD but not from the base, with no regard to any PR. Then equivalence filtering (below). The ahead list, oldest first, becomes `Commits`. |
| `Files changed` (committed) | `git diff --no-ext-diff --name-status -z <comparisonSha>...<headSha>` plus the same with `--numstat -z`. **Three-dot** = from the merge base to HEAD. Committed work only, no working-tree changes. Shown list is capped at 200 files, the count is the total. |
| `All changes` totals (Diff header) | `git diff --numstat -z <mergeBaseSha> --` (working tree against the merge-base commit, so committed plus uncommitted tracked) plus the untracked stats. |
| `All changes` patch | `git diff <mergeBaseSha>` plus untracked via the temp index. |
| `Committed changes` patch | `git diff <mergeBaseSha>..HEAD` (two-dot against the already-computed merge base). |
| `Uncommitted changes` patch | `git diff HEAD` plus untracked via the temp index. |
| Per-commit patch | `git show --format= --no-ext-diff <sha>`. |
| Diff file list | `git diff --raw --numstat --no-abbrev -M -z [-w] <range>`, streamed and killed after 501 records (the 501st only proves truncation). Blob ids of working-tree files are filled in with `git hash-object --stdin-paths`. |

**Equivalence filtering** (`plugins/git/host/workspace-reads.ts` `computeMergeBaseStatus`, `host/commit-cache.ts`). After the `log`, a commit on the ahead side and a commit on the behind side that have the same patch id are dropped from both lists, so they count neither as ahead nor as behind. Candidates are first narrowed by their set of changed paths (`git log --no-walk=unsorted --stdin --raw`), then hashed (`git log --no-walk=unsorted --stdin -p --no-renames` piped to `git patch-id --stable`). This catches cherry-picks and rebases. Then, **only when both ahead and behind are above zero**, a squash-merge check runs with a one-second timeout: the branch's diff from the merge base to HEAD is read as raw entries. The base-side commits that touch the branch's longest changed path (at most the first 1,000 behind commits) are examined. If one base commit has exactly the same set of (path, modes, blobs), or the same `git patch-id --stable` as the whole branch diff, the branch is treated as already merged: ahead becomes 0, `Commits` becomes empty, and so do the file list and totals. If the check times out or hits the 1,000-commit limit, the counts are left as they are and `squashMergeCheckComplete` is false (the UI shows an info icon). Result status is cached and not cached when retryable.

### The two observations from the owner, answered

1. **"The commits list looks like everything on the branch."** Yes. Observed: the list is the ahead side of `<comparisonSha>...HEAD`, and the PR is never consulted. In screenshot 2 the PR has 4 files and +42 -0, while `Files changed` shows 13 files, +104 -38 and Commits shows 8. Inference: `dev` is a long-lived branch whose earlier work was already shipped by earlier PRs (the PR title equals the newest commit's subject, and the other seven commits are older, one to two weeks). Those commits stay "ahead" because bb only detects commits that match one by one (patch id) or a branch that equals one squash commit as a whole. The merged PR #34 also cannot clear the list until `origin/main` has been fetched, and even then only if the whole branch diff equals one commit on main. bb has the PR-scoped data (`gh pr view --json files` and the files endpoint feed the PR tab) but never uses it to scope `Commits`. A PR-scoped list would be a new read, not a tweak.
2. **"I would rather see Files changed above the composer than Uncommitted."** The strip has one fixed slot and picks the first section of a fixed order (uncommitted, then committed). Both numbers already exist in the same status read, so a different order, a toggle, or two segments is a front-end change. Note the committed side's count is only as meaningful as the `Commits` list (same base), so it carries the same caveat as point 1.

## Relevant files and modules

Git plugin, `plugins/git/`:

- `package.json` — declares `server`, `host`, `app` entries; bundled and on by default.
- `host.ts` — host entry: `status`, `diff`, `files`, `patches`, `branches`, `fetchRemoteBranches` handlers; caps (200 status files, 500 diff files, 512 KB per patch, 6 MB batch); per-path `WorkspaceReads` LRU (64).
- `host/workspace-reads.ts` — the core: status snapshot, numstat and untracked stats, merge-base status, squash detection, diff ranges per target, patch pages, temp index handling.
- `host/commit-cache.ts` — commit change and patch-id caches for equivalence and squash checks.
- `host/git.ts` — null-record parsers (`--raw`, `--numstat`, `--name-status`), `readMergeBaseRef`, git priority context.
- `host/diff-tiering.ts` — auto, on-demand, too-large thresholds.
- `server.ts`, `server/reads.ts`, `server/invalidation.ts`, `server/generations.ts` — RPC surface, caches, event-to-tag mapping, freshness tokens.
- `server/viewed.ts` — Viewed table.
- `contract.ts`, `rpc-contract.ts`, `status-state.ts` — zod schemas for status, targets, diff entries; the public contract core uses.
- `app.tsx` — slot registrations.
- `ui/segment/ChangedFilesSegment.tsx`, `ui/workspace-change-summary.tsx` — the composer strip and section ordering.
- `ui/info/*`, `ui/changed-files.tsx`, `ui/git-status-display.tsx` — Thread info rows and lists.
- `ui/merge-base.ts`, `ui/merge-base-branch-candidates.ts` — merge-base picker state.
- `ui/diff/*` — Diff tab: `DiffTab.tsx`, `GitDiffToolbar.tsx`, `DiffFilesPanel.tsx`, `DiffFileCard.tsx`, `diff-data.ts`, `filter-diff-files.ts`, `diff-file-filters.ts`, `gitDiffPanelHelpers.ts`, `git-diff-view-preferences.ts`.
- `ui/commit/*` — Commit dialog, queue, errors.
- `skills/git/SKILL.md`, `PLUGIN_OVERVIEW.md`, `README.md` — documented intended behavior.

PR status, `plugins/github-pr-status/`:

- `host.ts`, `host/git-host.ts` — branch config, `gh` calls, GraphQL batching, credential keys, actions.
- `server.ts`, `store.ts`, `persistence.ts` — polling timers, shared snapshots, SQLite.
- `assemble.ts`, `ui/display.ts` — rolled-up status and labels.
- `ui/PullRequestContextSegment.tsx`, `ui/PullRequestInfoRow.tsx`, `ui/PullRequestRowMetadata.tsx` — chip, Info row, sidebar badge.
- `README.md`, `PLUGIN_OVERVIEW.md`, `skills/github-pr-status/SKILL.md` — documented refresh policy.

GitHub PR tab, `plugins/github/`: `app.tsx` (`PullPanelTab`, `PullDetailView`), `server.ts` (`getPull`, `commentPull`, `pullForThread`, `startReview` which spawns the thread, list sync), `README.md`.

Shared:

- `packages/environment-provider-host/src/workspace-git.ts` — `runGit`, porcelain v2 parser, default branch and ref resolution, Windows retry for git startup crash (`STATUS_DLL_INIT_FAILED`, 3 tries).
- `packages/environment-provider-host/src/branch-options.ts` — branch lists and the throttled `git fetch --prune --quiet`.
- `packages/host-workspace/src/host-workspace.ts` — `commit()` and the local-state fingerprint.
- `packages/host-watcher/src/*`, `apps/host-daemon/src/watch-manager.ts` — file and ref watching.
- `packages/shared-ui/src/components/git-diff/*` — diff card body, header, parsing, patch text.
- `apps/app/src/components/code/BbDiff.tsx` — the `@pierre/diffs` binding.
- `apps/server/src/routes/environments.ts`, `apps/server/src/services/ai/commit-message.ts` — commit route and AI message.
- `apps/server/src/services/plugins/builtin-registry.ts` — what is bundled, auto-installed, on by default.
- `docs/vcs-process-admission.md`, `docs/worktrees.md`, `docs/platform-support.md` — admission queue, worktree behavior, platform notes.

## Rough cost to reproduce (inference from observed size)

Observed sizes (non-test TypeScript): the git plugin is about 12,000 lines (host reads about 3,200, server about 1,800, Diff UI about 3,400, other UI about 2,400), the PR-status plugin about 4,600, the `github` plugin about 4,300, and shared diff components about 1,900. Most of that is hardening, not features. A realistic version for Clowdy would be much smaller. Sizing by surface:

| Surface | What it really needs | Cost (relative) and where it grows |
| --- | --- | --- |
| Strip and Info rows from local git | One porcelain v2 status, one `diff --numstat HEAD`, branch and default-branch lookup, ahead/behind count, commit list | Small. Grows with untracked `+/-` (bb needs a temp index for it), the 200-file and 15 s caps, and squash detection (the largest single piece, about 1,000 lines with caches, and it is what makes merged branches clear). |
| Watching and refresh | A watcher on the workspace and `.git` plus coalescing, or polling | Medium. Correct ignores (gitignored dirs, nested repos), linked worktree git dirs, and debounce rules are where bb spent effort. |
| Diff panel | Parse patches, render split and unified, file list, lazy per-file load, Viewed, filters | Large. The renderer dependency (`@pierre/diffs`) is the shortcut; virtualization, size tiers, and context expansion are the rest. Adding a dependency needs the owner's yes. |
| PR chip, status and actions | `gh` lookup by branch, one GraphQL document, rolled-up state, polling policy | Medium. Branch-to-PR resolution (forks, upstream remotes, merged-vs-open choice) and rate limits are the subtle part. Needs `gh` installed and logged in. |
| `GitHub PR` tab | `gh pr view`, two paginated API calls, markdown render, comment box | Medium, optional, and independent of the rest. Everything it needs except the thread-to-PR link comes straight from `gh`. |
| Commit with generated message | `add -A`, `commit -m`, a small AI call with fallback | Small, but needs the owner's decision on whether to stage everything (bb does) and on which service writes the message. |
| Push, pull, create PR | Not in bb | No bb precedent to port. |

## Constraints and gotchas

- **Windows.** bb runs git through `spawnPortableOutputProcess`, retries a git process that dies on start with `STATUS_DLL_INIT_FAILED` (up to 3 times), uses process groups only on non-Windows, and requires Git for Windows (native Windows host is alpha per `docs/platform-support.md`). It uses `:(literal)` pathspecs, null-delimited output everywhere, and resolves the `gh` config dir under `%APPDATA%\GitHub CLI`. The `github` plugin probes `gh`, `/opt/homebrew/bin/gh`, `/usr/local/bin/gh` (no Windows path in that probe; the PR-status plugin spawns plain `gh`).
- **Parsing stability.** bb overrides user git config (colours, `diff.noprefix`, `mnemonicPrefix`, `srcPrefix`, `dstPrefix`, `diff.relative`, `log.showSignature`, submodule display) and sets `LANGUAGE=C` because it matches some stderr text (for example, missing HEAD). It uses `-z` for paths. Copy this discipline or odd configs and non-ASCII paths will break parsing.
- **Large repos.** Output is size-capped and killed early (501 records, per-file patch bytes, 16 MB default buffer), every status command has a 15 s timeout, and git subprocesses share an admission queue: local pool of `availableParallelism() - 2` slots clamped to 4 to 6, a separate pool of 4 for network work (`gh`, fetch, pull, push, clone, ls-remote), and priorities (interactive diff and actions above status above background watch, PR polling and fetch) (`docs/vcs-process-admission.md`).
- **Untracked files are the expensive part.** Counting their lines needs a temp index and `add --intent-to-add`, and bb gives up (`lineStatsComplete: false`, so no `+/-`) beyond 50 files or 8 MB or 10 s. A repo with a large untracked tree (build output not in `.gitignore`) lists every file because status runs with `--untracked-files=all`. The watcher's fingerprint uses `--untracked-files=normal`, which is cheaper.
- **No remote.** Ref resolution falls back to local branches (`resolveBranchRef` returns the local ref when `origin/<name>` is absent). The default branch falls back to `main`, then `master`, then the first local branch. PR lookup finds no remote and yields "none" or "unavailable".
- **No `gh` or not logged in.** PR reads return `unavailable` with a message and the strip simply has no PR chip. The `github` plugin shows an empty state asking for `gh auth login`. bb stores no tokens; it relies on gh's own keychain or `GH_TOKEN`.
- **Detached HEAD.** Status reports checkout kind `detached` (short sha in the Branch row), compare still works from the head oid, and PR lookup is skipped (no branch name), so no PR chip. **Unborn branch**: diffs fall back to the empty-tree sha, the merge-base status returns an empty result.
- **Many chats on one checkout.** All threads of a project checkout share one environment id, and status, caches, watchers and Viewed marks are keyed by environment, with reference counting for watchers. The project-checkout plugin refuses a branch switch while another live thread is on the checkout or the tree is dirty. Sub-threads default to fresh worktrees. Because the strip and Info show the whole checkout's changes, not "this chat's changes", two chats on one checkout see the same numbers (inference: the code has no per-thread attribution).
- **Worktrees.** Git dir discovery handles `.git` files and `commondir` (`watch-specs.ts`). `isLinkedWorktree` is detected by a `/worktrees/` substring in the git dir (`workspace-git.ts`). New worktree branches start from `origin/<base>` when local is equal or behind, from local when ahead or diverged, and have no upstream. The base is stored on the environment as its merge base, which is what makes a fresh worktree's `Commits` list accurate. A reused or long-lived branch with no recorded base falls back to the default branch, which is exactly the `dev` case.
- **Stale remote refs.** Since status never fetches, `behind` and the squash check go stale until a branch picker opens or the user fetches. A PR merged on GitHub does not clear `ahead` locally until `origin/<base>` is fetched.
- **Whitespace mode changes data.** `-w` re-runs git for the file list and patches. The Viewed key (environment, target, path) does not include the whitespace flag, and the revision is the blob-id string, so a Viewed mark carries across the toggle.
- **Experimental SDK.** Every extension point in bb is `experimental_`-prefixed. Do not copy the plugin API; copy the data layer.
- **License.** The bb repo is MIT (`LICENSE`, "Copyright (c) 2026 Michael Yong"). I did not check the license of `@pierre/diffs`.

## Open questions

- What should scope `Commits` and `Files changed` in Clowdy: the merge base branch like bb, the PR (head and base from `gh`), or the commits since the chat started? bb answers only the first. The second needs a PR lookup before the list can render. The third needs a recorded start sha per chat.
- Should the strip show Uncommitted, Committed, or both (two segments or a toggle)? bb shows one, in a fixed order.
- Is local-only `git` plus `gh` the right dependency line (bb's choice), or should Clowdy use the GitHub API with its own auth? Everything bb does is `gh`, which also means no GitHub access without `gh`.
- Should the diff renderer be `@pierre/diffs` (what bb uses), or something Clowdy or Reforma already has? I did not check what Clowdy or Reforma ship. New dependencies need the owner's approval.
- Where should Viewed live in Clowdy: the daemon's database keyed by chat or folder, target and path, with a blob-based revision like bb?
- Does Clowdy want an auto-fetch policy? bb never fetches for status, which is what causes stale `behind` numbers and uncleared merged branches.
- Commit: stage everything (`add -A`) like bb, or only chosen files? Who writes the message, and what is the fallback?

## Assumptions and limits

- I read the code and docs listed above and did not run bb, `git`, or `gh`, install anything, or execute any bb script. Screenshot behavior is explained from the code; where I say "inference" the code did not state the reason or outcome.
- I did not read the full `plugins/github/app.tsx` (2,248 lines), the full `plugins/github-pr-status/server.ts` and `store.ts`, `apps/app` layout code for the side panel and Info panel host, the Diff toolbar internals beyond the scope and filter logic, the `fileSide` full-file read path in core, `branch-options.ts` beyond its fetch calls, or the environment plugins' branch-switching code.
- The 15 s status timeout, 3 s and 30 s freshness windows, polling intervals and all size caps are the constants in this commit. They may change.
- The "Commits oldest versus newest first" order and the 13 + 3 = 16 file arithmetic are derived from the screenshots and the code together, not from running the app.
- Inference about `dev` being long-lived and earlier PRs having been squash-merged comes from the screenshots (PR #34 title equals the newest commit, PR stats differ from the branch stats) and was not checked against the actual repository.
- I did not look at Clowdy's current git support (another research file, `clowdy-state.md`, covers that).
