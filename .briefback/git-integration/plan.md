# Git and GitHub in Clowdy

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a person sees the branch, its pull request and what changed in the place a chat works in, reviews the changed files with marks that a later edit clears, commits, publishes the branch and starts the PR from the app, without opening GitHub Desktop.

**Approach:** the daemon runs the person's own `git` and `gh` for a place (`resolvePlace`: a folder's checkout or a chat's worktree) and answers a few read routes (status, changes, the two sides of a file, the pull request) and a few writes (commit, fetch, pull, push). The renderer shows the result in three spots: a strip above the composer, rows in the Info tab, and a new Changes tab (diff cards on `@codemirror/merge` beside a source control sidebar). Stage 1 is the foundation every other stage reads.

**Research:** `.briefback/git-integration/research/index.md` (bb: `bb-git.md`, Orca: `orca-git.md`, the official apps: `app-docs.md`, Clowdy today: `clowdy-state.md`). Reforma's `apps/sandbox/src/core/git` (runner, commit, push, pull, fetch, publish, sync, status) is a source to port from; it was only listed, not read, so read it at the start of Stage 1 and Stage 7.

**Decisions** (the owner's, from the chat of 2026-11-22)

- The daemon runs `git` and `gh`; the renderer is a client through the transport (interface, HTTP, fixture and `unconfigured`, each with tests). Every query is keyed by place: `resolvePlace(store, project, folderId, workspaceId?)`.
- GitHub is reached only through the person's `gh` (as bb and Orca do), with no token stored. Without `gh` or a login the PR surfaces are hidden with a hint, and everything local still works. Only `origin` counts; enterprise hosts work through `gh --hostname`. Nothing fetches by itself: Fetch is a button, and a push is the other thing that moves refs.
- Clowdy writes to the repository itself: commit, publish and push, pull with `--ff-only`, fetch. Commits and pushes use the person's git config, signing included (SSH signing through Secretive asks for Touch ID). Nothing turns signing off. The lines "git only reads" in `apps/daemon/AGENTS.md` and "pull request, merge, ahead and behind are out of scope" in the worktrees plan and the MVP plan are revised when the code lands.
- The base of a comparison is the base branch of the linked PR when there is one, else the workspace's recorded base, else `baseOf` of the folder. The ref is picked by bb's rule: `origin/<name>` when the local branch is equal to it, behind it or missing, the local branch when it is ahead or diverged. Files and commits are counted locally: `merge-base`, `rev-list --left-right`, `diff <merge-base>` of the head. There is no squash-merge detector (the repository merges with merge commits, so a fetch moves the merge base and the list clears).
- The pull request of a branch is found by the branch through one `gh api graphql` read: an open PR first, else the newest one. A merged or closed PR that HEAD has moved past (`merge-base --is-ancestor HEAD <PR head>` says no) counts as no PR, so Create PR is offered again, and a new open PR for the branch is picked up by the next read. The PR's own file counts are shown only in its row, never in the changes list.
- The diff has four scopes: All, Branch (against the base), Uncommitted, and one commit. Last turn is the last stage and may be cut.
- The strip above the composer shows the PR chip (number, state, a dot for the checks, a click opens GitHub, the chip opens a read-only list of the checks with their names, states and links) and `Files changed N +a −d` against the base. A dot beside it says the tree is dirty. The Info tab gets rows for the base, ahead and behind, the PR and Files changed.
- The PR chip stays at the level of GitHub Desktop: no comments, no re-run, no merge, no list beyond the checks. It is read when the window gets focus, when a turn ends, and every 60 seconds while a check is pending.
- The new Changes tab is a tree-and-view tab like Files: beside the chat, in the chat's place when the window is narrow, `Cmd+5`. The left side is the reading area: scope menu, totals, a filter input above the cards (substring or glob, `!` excludes, one input for the cards and the sidebar list), a "hide viewed" toggle, expand and collapse all, and one card per file with its diff, expanded when the tab opens. The right side is a sidebar of 220 to 250 px, resizable and hideable like Files': the PR, the branch to its base with ahead and behind, an open-on-GitHub button and the Fetch, Pull, Push, Publish menu; the checklist of changed files (a click scrolls to the card, a tick shows a viewed file); the message box with a Generate button; Commit with a Commit & Push variant; Committed on branch; the list of commits, where a click sets the scope to that commit. The diff is unified only.
- The diff is drawn by `@codemirror/merge` 6.12.3 (MIT, published 2026-10-19), the one new dependency, in `packages/file-manager` beside the editor whose theme and languages it shares. A card reads both sides of the file as text (bb and Orca do the same), mounts its editor when it is near the screen and caps the size it loads.
- Viewed marks are the person's own, kept in the daemon's database and never sent to GitHub. A mark is keyed by (project, folder, workspace, scope, path) and holds the file's revision `<oldMode>:<oldBlob>:<newMode>:<newBlob>`; a file counts as viewed only while its revision is the one stored, so any later edit clears it.
- A commit takes only the files ticked in the sidebar (all ticked at first): `git add -- <paths>` then `git commit -m <message> -- <paths>`. The index is not a concept of the UI, and a neighbour chat's files in the same place stay out.
- The commit message is written by a provider the person chose, as bb lets one pick a service or none: a `Commit messages` switch on the provider's card in Settings (an `AgentSettingSpec` that only the daemon reads, as the chat title switch is, off by default), offered by Codex only for now. The Generate button is there only while a provider with the switch on is signed in; otherwise there is no button. The run is separate (`codex exec`, the person's config ignored, model `gpt-6-luna` at low effort, every optional tool and context block off, a one-line instructions file the daemon writes once, an empty temporary folder as the working directory, the prompt on stdin, about 30 s as the limit), so the request does not take an agent's whole toolset: Stage 0 measured 6.3K input tokens and 4.1 s against 21.5K and 7.4 s for the defaults, and the exact argv is in `research/spikes.md`. Codex's `exec` and `wait` schemas stay (the model catalog forces code mode), which is the floor of about 3.3K tokens. Nothing runs on its own, and a failed run leaves the box as it was and says `Couldn't write the message`. There is no template text instead.
- Create PR opens GitHub's compare page (`/compare/<base>...<branch>?expand=1`) in the browser, as GitHub Desktop does, and `gh pr create` is not used. On a branch that is not published the button says Publish first (`push -u origin HEAD`). On the default branch it is disabled with "Switch to a feature branch".
- Fetch, Pull (`--ff-only`), Push and Publish are in the sidebar's menu. A branch that diverged from its upstream is shown as Diverged and left alone.
- Add to chat: a floating button over selected text, `⌘I`, as Reforma's `CodeView` has it (a CodeMirror `showTooltip` extension). It works in the Files editor and in the diff cards and puts a quote with the path, the line range and the selected text into the open chat's composer, as Reply quotes words. The Docs editor (tiptap) is later, and is cut if it is hard.
- Last turn records the tree of the working directory when a turn starts (a temporary index and `git write-tree`, the repository's index untouched), keeps its id in the database, and diffs it against the tree now. A shared place shows the neighbours' edits of that time too. When git has pruned the object, the scope says it is unavailable. Codex does it differently (`TurnDiffTracker` in `codex-rs/core` keeps the text of what `apply_patch` touched and misses shell edits); the daemon drops the ACP diff text, so that path is not taken.
- Every git write the daemon runs (commit, fetch, pull, push) gets the signing agent's socket in its environment, because a signed commit from an app opened in Finder fails with `No private key found` when `SSH_AUTH_SOCK` is launchd's own (SSH itself works through `IdentityAgent` in `~/.ssh/config`; signing does not read it). The socket is taken from `ssh -G <origin host>` (its `identityagent` line when it is an absolute path), else from the login shell as `PATH` is taken, else the inherited value, and it replaces an inherited one; the first answer is cached and found again after a failure that names the signing key. Git's own line is shown with a hint that the signing agent was not reachable. Timeouts: about 120 s for a commit and 60 to 120 s for the network actions (a person may need to reach the sensor; no wait was observed).
- Work is committed on `next` in small slices by path and pushed after each commit (`GITFLOW.md`). Only `@codemirror/merge` is added; any other dependency is asked first.

**Reuse:** `resolvePlace`, `Place` (`apps/daemon/src/domain/places.ts`); `gitRead`, `gitOutput`, `gitLine` (`apps/daemon/src/domain/git.ts`); `baseOf`, `folderGit`, `defaultBranchOf`, `parseWorktrees` (`apps/daemon/src/git/state.ts`); `runProgram` (`apps/daemon/src/providers/exec.ts`); `exclusive` (`apps/daemon/src/domain/workspaces.ts`); `WorkspaceRecord.base`; the `FolderWatch` stream as the model for volatile signals (`apps/daemon/src/fs/watcher.ts`); the four transport places (`apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `config.ts`) and `projectsTransport.test.ts`; `currentPlace` (`apps/desktop/src/renderer/features/sidePanel/currentPlace.ts`); `useFolderGit` and `githubLink` (`apps/desktop/src/renderer/features/openWith/`); `ComposerBanner`, `ComposerBannerStatus` (`apps/desktop/src/renderer/features/chats/ComposerBanner.tsx`); `ComposerHandle.quote` (`apps/desktop/src/renderer/features/chats/Composer.tsx`); the side panel registration points (`UiStore.ts`, `commands.ts`, `SidePanelRail.tsx`, `SidePanel.tsx`); `FileManagerView`'s `editorExtensions` and the layout constants (`packages/file-manager/src/react/layout.ts`); `test/helpers.ts` (`makeRepo`, `git`) for real-repository tests.

## Out of scope

- Review by an agent and line comments on the diff (the owner has not thought the agent review through; the line reference is Add to chat).
- A Checks tab, PR comments, merge, auto-merge, re-run of checks, the full GitHub PR page.
- `gh pr create`, generated PR title and body, PR templates.
- Sync, rebase from the base, force push, merge of a diverged branch.
- A split diff view, a filter by file extension, hiding whitespace, wrapped lines.
- A squash-merge detector, forks and remotes other than `origin`, GitLab, Bitbucket.
- Chat titles: they come from the agent's own session (`apps/daemon/src/runs/titles.ts`), and the tool-free run of this plan may serve them later. The owner's note about the tools in context is for BACKLOG.
- A git index or staging UI, hunk-level stage and revert.

## Stage 0 — Spikes: text without tools, and signing and push from the daemon

**Depends on:** None.

**This stage:** two questions decide how Stage 7 and Stage 8 are built, and nobody has run either. The commit message comes from Codex, so its cheapest run is needed: one that carries as few tools and MCP servers as `codex exec` allows, so the request is not the 90 tools of a chat (`codex exec` has `-c` overrides, `--ephemeral` and a read-only sandbox; whether its built-in tools can be dropped is not known). A commit or a push from the daemon must work with the person's SSH signing and agent. The stage runs both on the owner's machine, with the owner's subscription and Touch ID, and writes down what works. It writes no production code.

- [x] Complete
  - [x] Codex: the command line of the cheapest run that answers a commit-message prompt, its latency and token count, what its tools and MCP servers cost in that run, and a comparison with an ephemeral ACP session if the `exec` run cannot drop its tools
  - [x] A commit and a read of `origin` over SSH made by a process started the way the daemon starts (an app opened from Finder, and a daemon started from a terminal) succeed or fail, with `SSH_AUTH_SOCK` seen or not
  - [x] The findings are in `.briefback/git-integration/research/spikes.md` and the plan's Decisions are updated where they change the stages

**Files**

- `.briefback/git-integration/research/spikes.md` — create: a new page of this research, which no existing page covers
- `.briefback/git-integration/plan.md` — Decisions, Stage 7 and Stage 8 updated with the outcomes

**Done when:** `spikes.md` states, for Claude and Codex, the exact command of a tool-free run with its latency and tokens, and whether a signed commit and an SSH push work from the daemon's environment.
**Verify:** none (the owner reads `spikes.md`).
**Scope changes:** the ACP comparison was not run (`exec` already reaches the floor, about 3.3K tokens and 3.6 s). Claude was measured afterwards, at the owner's request: a tool-free `claude -p` takes 2.1K input tokens and about 2.9 s (spikes.md, Spike A2); whether it becomes a second provider for commit messages is the owner's call. No Touch ID prompt appeared, so its wait is unmeasured and the timeouts in Decisions are suggestions. Only `ls-remote` ran against the network.
**Commits:** `4306fed` docs: record the Codex and signing spikes and what they change in the plan; `a75e033` docs: add the Claude spike, a tool-free run takes 2.1K tokens.

## Stage 1 — The daemon reads a place's git: status, changes and the sides of a file

**Depends on:** None.

**This stage:** every surface needs the same facts: what branch the place is on, how far it is from its base, which files changed in which scope, and the two texts of one file. The daemon computes them with the person's `git`, read only, for a place that `resolvePlace` judged, and the renderer reaches them through the transport. This stage settles the base rule, the scopes and the per-file revision (the blob ids that Viewed marks rely on) and tests them on real repositories.

- [x] Complete
  - [x] `gitRead` takes a timeout and a size cap per call (a diff needs more than 5 s and 8 MiB), and the git reads use `-z`, a pinned English locale and no colour or prefix surprises from the person's config
  - [x] A status read: branch or detached head, upstream, ahead and behind the upstream, the dirty files with their kinds, one `status --porcelain=v2 --branch -z` call, untracked files capped
  - [x] A compare read: the base ref picked by the rule in Decisions, the merge base, ahead and behind the base, the commits ahead (newest first, with author and time)
  - [x] A changes read per scope (All, Branch, Uncommitted, one commit): the files with status, old path, additions, deletions, binary, too large, and the revision `<oldMode>:<oldBlob>:<newMode>:<newBlob>`, capped with a `truncated` flag
  - [x] A file read: the original and the modified text of one path in a scope, with binary and too-large answers carrying no text
  - [x] `GET /v1/projects/:id/git/status`, `.../git/changes` and `.../git/file`, each taking `folderId` and `workspaceId` (`not_found`, `unavailable` and `invalid` as the other place routes answer), with the protocol types and the four transport places and their fixtures
  - [x] Tests on real repositories: dirty and clean, detached, no upstream, no remote, an unborn branch, ahead and behind, a rename, a binary file, an untracked file, each scope, the worktree of a chat

**Files**

- `apps/daemon/src/domain/git.ts` — `gitRead`: timeout and cap options; `git`: unchanged
- `apps/daemon/src/git/state.ts` — `baseOf`, `defaultBranchOf`: reused by the compare read, not changed
- `apps/daemon/src/git/status.ts` — create: status and compare reads; `state.ts` is the branch and worktree listing and is already 270 lines of its own rules
- `apps/daemon/src/git/changes.ts` — create: the scopes' file lists, revisions and the two sides of a file, which the status read does not share a rule with
- `apps/daemon/src/http/routes.ts` — the three routes beside `projectGit`
- `packages/protocol/src/git.ts` — create: `GitStatus`, `GitCommit`, `GitChangedFile`, `GitChanges`, `GitFileSides`, `GitScope`; `api.ts` holds routes and `fs.ts` and `terminals.ts` are the precedent for a file per area
- `packages/protocol/src/api.ts` — `ROUTES`: `projectGitStatus`, `projectGitChanges`, `projectGitFile`; the route list comment
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts` — `getGitStatus`, `getGitChanges`, `getGitFile`
- `apps/daemon/test/git-changes.test.ts` — create: real-repository cases; `git-state.test.ts` covers the listing only
- `apps/desktop/src/renderer/daemon/projectsTransport.test.ts` — the new methods over HTTP and in the fixture
- `apps/daemon/AGENTS.md` — the git section: reads, caps, the place keying; the line "git only reads" becomes accurate again for this stage and is updated in Stage 7

**Done when:** over HTTP, for a repository with a dirty tree and a branch ahead of its base, the three routes return the status, the files of each scope with revisions and the two texts of a file, and a chat's worktree gives its own answer.
**Verify:** `cd apps/daemon && bun test test/git-changes.test.ts test/git-state.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/daemon`
**Scope changes:** `gitRead` also sets `LANGUAGE=C` and `LC_ALL=C` for every caller and has `parsed`, `input` options and a streaming sibling `gitRecords` that kills git at a record cap; scopes are the strings `all`, `branch`, `uncommitted`, `commit:<hex>`; the file route takes an extra `oldPath` (a renamed file); `PlaceRef { folderId, workspaceId? }` is the renderer's argument for the three reads; untracked line counts are made in the daemon with no temporary index (budget 200 files, 16 MiB, 5 s, `statsComplete` false past it); the working-tree id git cannot hash in time is `stat-<size>-<mtime>`; a submodule's revision is the commit its own checkout is at. `BaseOptions.base` takes the PR's base branch; no route passes it until Stage 2. `workingTreeRoot` in `git/state.ts` is the one rule for "is this folder the root of a working tree".
**Review findings, fixed:** a submodule's revision did not change when a commit was made inside it, so a Viewed mark would have survived; "is a working-tree root" existed twice. Added tests: the submodule revision, non-ASCII branch and worktree names under the fixed locale, a tag named like the branch, a file named `--stat.txt`, a folder swapped for a link out of the place, the 5000-file cap. Left (follow-ups): `GET .../git/file` repeats the base lookup per call (about 12 git processes; 30 cards start about 360), so Stage 4 passes the list's `from` and base state to it or caches `mergeBaseOf` for about 2 s per place and HEAD; the working-tree hashing runs the person's clean and smudge filters (a Git LFS user's clean step writes into `.git/lfs`), and each untracked symlink among the first 500 files gets its own `hash-object`; status reads HEAD twice and probes refs more than once (about 4 processes). Not checked: Windows, Git LFS, SHA-256 repositories. `apps/daemon` typecheck keeps its 7 errors from before this stage.
**Commits:** `a54edaf` feat(daemon): read a place's git status, changes per scope and the sides of a file; `6075984` feat(desktop): add the git status, changes and file reads to the transport.

## Stage 2 — The pull request of a branch through `gh`

**Depends on:** Stage 1.

**This stage:** the PR chip needs to know whether `gh` is there and signed in, which PR belongs to the branch, and how its checks stand. The daemon asks `gh` once per read and rolls the answer up. It carries the rule that makes a merged PR let go of a branch that has moved on, which is what the owner is tired of in other apps.

- [x] Complete
  - [x] `gh` is found (the login shell's `PATH`, then the usual install paths on macOS and Windows) and its login for the remote's host is read; the answer says `ready`, `no_gh`, `not_signed_in` or `no_remote`
  - [x] One `gh api graphql` read per branch: the base repository chosen as `gh pr view` does (the remote `gh` resolved, else `upstream`, `github`, `origin`), the PRs of the head branch, the last commit's check rollup with the name, state and link of each check
  - [x] The choice among PRs: open first, else the newest; a merged or closed one that HEAD has moved past is dropped; a fork head is matched by its owner
  - [x] The rollup: PR state (open, draft, merged, closed), checks passing, failing and pending with the list, the review decision, its base branch and head commit
  - [x] `GET /v1/projects/:id/git/pull-request` with `folderId` and `workspaceId`, a short cache against several windows asking at once, the protocol type and the four transport places
  - [x] A remote URL with a credential is never logged or sent back; the host is the only part that leaves the daemon's own use
  - [x] Tests with a stand-in `gh` on `PATH`: no `gh`, not signed in, no remote, an open PR, a draft, a merged PR with the branch ahead of it, a merged PR with nothing new, a failed check

**Files**

- `apps/daemon/src/git/pullRequest.ts` — create: the `gh` lookup and rollup; it spawns `gh` through `runProgram`, which `state.ts` (git reads) is not built for
- `apps/daemon/src/providers/exec.ts` — `runProgram`: reused
- `apps/daemon/src/git/status.ts` — the base branch of the linked PR feeds the compare read (Stage 1's rule gets its first input)
- `apps/daemon/src/http/routes.ts` — the route
- `packages/protocol/src/git.ts` — `GitPullRequest`, `GitCheck`, `GitHubAccess`
- `packages/protocol/src/api.ts` — `ROUTES`: `projectGitPullRequest`
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts` — `getGitPullRequest`
- `apps/daemon/test/git-pull-request.test.ts` — create: the stand-in `gh` cases
- `apps/daemon/AGENTS.md` — `gh` as the one GitHub door, no token

**Done when:** over HTTP, a branch with an open PR returns its number, state and checks, a branch whose PR merged and has new commits returns no PR, and a machine without `gh` returns `no_gh` while Stage 1's routes still answer.
**Verify:** `cd apps/daemon && bun test test/git-pull-request.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`
**Scope changes:** the answer is `{ isRepository: false }` or `{ isRepository: true, access, repo?: { host, owner, name }, pullRequest? }`; a detached HEAD or an unborn branch answers `ready` with no PR and runs no `gh`; presence and login are cached 60 s when positive and 5 s when negative; the base hint is wired into the `file` route too and is kept with the branch and head it was read for; `gh auth status` is asked with `--active` (a stale second account of the host made it exit 1) and again without it for an older `gh`; only `http(s)` links are kept for the PR and its checks; `gh`'s own error text is never passed on. `PullRequestsOptions.keep` bounds the cache (default 200).
**Review findings, fixed:** the base hint followed the place and not the branch, so after a `git switch` the compare used the previous branch's PR base for up to 10 minutes; `gh auth status` without `--active` read as not signed in when any account of the host had a bad token; a check's `javascript:`, `file:` or custom-scheme link could reach the app. The query was run once through the real `gh` against this repository and a public one: GitHub accepted every field. Left: a GitLab, Bitbucket or SSH-alias remote answers `not_signed_in` with `repo.host` set (Stage 3 words the hint from the host: `Sign in with gh` for github.com, `gh isn't signed in to <host>` for another, and softly, since offline reads the same for 5 s); a renamed owner or org with a stale `origin` hides its PR as a fork; `https://github.com:443/...` keeps its port; no paging past 100 checks (`truncated`), no global limit on `gh` calls, no rate-limit pause. Not checked: Windows, Git LFS, SHA-256 repositories, an old server's error for a field it lacks.
**Commits:** `0126f57` feat(daemon): read the pull request of a place's branch through gh; `0e3b09e` feat(desktop): add the pull request read to the transport.

## Stage 3 — The strip above the composer and the Info rows

**Depends on:** Stage 1, Stage 2.

**This stage:** the person sees the PR and the size of the branch's work without opening anything. One shared store keeps the git facts of a place and refreshes them on the triggers in Decisions, so the strip, the Info rows and later the Changes tab read one answer instead of three.

- [ ] Complete
  - [ ] A store of git facts per place (status, the branch's changes summary, the PR), shared across components by the transport, refreshed on window focus, on the end of a turn, and every 60 s while a check is pending, and not read while the window is hidden
  - [ ] The strip: the PR chip (number, state, check dot, a click opens the PR's own link), its popover with the checks, and `Files changed N +a −d`, with a dirty dot; nothing for a folder that is not a repository; without `gh` or a login a soft hint worded from the host (`Sign in with gh` for github.com, `gh isn't signed in to <host>` for another host, since offline reads the same for a few seconds and GitLab or an SSH alias reads as not signed in)
  - [ ] The Info tab rows: base, ahead and behind, PR, Files changed
  - [ ] The branch the chips under the composer show and the strip agree on one read
  - [ ] UI text ends without a period; tests for the strip's states (no repo, no `gh`, no PR, open, draft, merged, checks failing, dirty)

**Files**

- `apps/desktop/src/renderer/features/changes/gitFacts.ts` — create: the shared store; `useFolderGit` reads only the head and the `origin` and is not the place for status, changes and PR
- `apps/desktop/src/renderer/features/chats/GitStrip.tsx` — create: the strip over `ComposerBanner`; no existing strip draws git
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — the composer column: the strip beside `RunningAgents`
- `apps/desktop/src/renderer/features/chats/ComposerBanner.tsx` — reused; extended only if the chip needs a slot
- `apps/desktop/src/renderer/features/sidePanel/InfoTab.tsx` — the new rows
- `apps/desktop/src/renderer/features/openWith/openTarget.ts` — `githubLink`: the PR link is built from the same remote parsing
- `apps/desktop/src/renderer/features/chats/GitStrip.test.tsx` — create: the states above
- `apps/desktop/AGENTS.md` — the strip, the store and its triggers

**Done when:** in the fixtures page the strip shows each state of the PR and the file counts, and in the running app on a branch with an open PR the chip opens it on GitHub.
**Verify:** `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/chats src/renderer/features/sidePanel`, `bun run lint`
**Commits:** None yet.

## Stage 4 — The Changes tab: diff cards, scopes and filter

**Depends on:** Stage 1, Stage 3.

**This stage:** the person reads what changed. A diff view for two texts goes into `packages/file-manager` on `@codemirror/merge`, sharing the editor's theme and language support, and a new tab composes it: the reading area with the scope menu, totals, filter and cards on the left, and the sidebar with the file list and the commits on the right. Nothing in this stage changes the repository or stores anything.

- [ ] Complete
  - [x] `@codemirror/merge` 6.12.3 is added to `packages/file-manager` (the lockfile checked against `minimumReleaseAge`) (`669d0a6`)
  - [x] A read-only unified diff view of two texts for a path, with the editor's theme and the language of the path, unchanged lines collapsed and mounted lazily (`669d0a6`: `DiffView`, observer rooted at the nearest scroll container, diff timeout 200 ms); the card for binary and too-large files with no text is the tab's, not the view's
  - [ ] The tab is registered (`changes`, a `TREE_TABS` member, `Cmd+5`, rail button, label) and keeps its choice per project; the fixtures page can open it with `?panelTab=changes`
  - [ ] The reading area: scope menu (All, Branch, Uncommitted, a commit), totals, the filter input above the cards (substring, glob, `!`), hide viewed (inert until Stage 5), expand and collapse all, cards expanded when the tab opens, a card per file with path, counts and copy path
  - [ ] The sidebar, hideable and resizable like Files': the PR row, the branch to its base with ahead and behind, an open-on-GitHub button, the changed-file list (a click scrolls to the card), and the list of commits whose click sets the scope
  - [ ] A card passes `estimatedLines` from the file's added and removed counts to `DiffView` (its own guess is 16 lines for two-sided diffs, real cards measured 526 to 5752 px), and the list does not set `overflow-anchor: none`
  - [ ] A card reads its file with the list's own base (`GET .../git/file` takes the list's `from` and base state, as a hex commit checked on the daemon), so thirty cards do not repeat the base lookup and a card cannot be diffed against another base than the list was
  - [ ] An empty state for a clean tree and for a folder that is not a repository; the tab follows `currentPlace`
  - [ ] Tests for the filter's patterns, the scope switch, the empty states, and the diff view in the file-manager's specs

**Files**

- `packages/file-manager/package.json` — dependencies: `@codemirror/merge`
- `packages/file-manager/src/react/diff/DiffView.tsx` — create: the diff view; `CodeEditor.tsx` edits one document and has no two-text mode
- `packages/file-manager/src/react/editor/extensions.ts` — the theme and language helpers the view reuses
- `packages/file-manager/src/react/index.ts` — export `DiffView`
- `apps/desktop/src/renderer/features/changes/ChangesTab.tsx` — create: the tab, its folder as the Tasks and Terminal tabs have
- `apps/desktop/src/renderer/features/changes/ChangesToolbar.tsx`, `DiffCard.tsx`, `ChangesSidebar.tsx`, `changeFilter.ts` — create: the parts of the tab; the filter is a pure function the tests drive
- `apps/daemon/src/git/changes.ts`, `packages/protocol/src/git.ts`, `apps/daemon/src/http/routes.ts` — `placeFile` and the file route take the list's base; the four transport places and `projectsTransport.test.ts` follow
- `apps/desktop/src/renderer/stores/UiStore.ts` — `SIDE_PANEL_TABS`, `TREE_TABS`
- `apps/desktop/src/renderer/features/sidePanel/commands.ts` — `SIDE_PANEL_TAB_KEYS`, `SIDE_PANEL_TAB_LABELS`
- `apps/desktop/src/renderer/features/sidePanel/SidePanelRail.tsx` — `TABS`; `SidePanel.tsx` — the lazy chunk
- `packages/file-manager/src/react/layout.ts` — the least widths the tab holds, or the tab's own constants beside them
- `apps/desktop/AGENTS.md`, `packages/file-manager/AGENTS.md` — the tab and the diff view

**Done when:** opening the Changes tab on a chat with a dirty worktree and commits ahead of the base shows a card per changed file with its diff, the scope menu changes the list, the filter narrows it, and a click on a commit shows only that commit.
**Verify:** `cd packages/file-manager && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/changes src/renderer/features/sidePanel`, `bun run lint`
**Commits:** None yet.

## Stage 5 — Viewed marks bound to the file's content

**Depends on:** Stage 4.

**This stage:** the person ticks files as reviewed and the tick survives a reload and clears itself when the file changes. The mark's value is the revision that Stage 1 computes, so no timestamp or polling decides whether it still holds. It is the daemon's table, since the browser's storage would lose it.

- [ ] Complete
  - [ ] Migration 26 adds `viewed_files` (project, folder, workspace or empty, scope key, path, revision, time); the scope key is `uncommitted`, `branch:<base ref>`, `all:<base ref>` or `commit:<sha>`
  - [ ] Routes to list the marks of a place and scope, set a mark with a revision, and clear it; a mark is returned as viewed only while its revision equals the file's current one
  - [ ] The protocol types and the four transport places with fixtures
  - [ ] The card's header has the Viewed checkbox and the sidebar list shows the tick; "hide viewed" works; a viewed card folds
  - [ ] Marks of a removed workspace go with it
  - [ ] Tests: a mark holds, an edited file loses it, another scope or place does not share it, a removed worktree drops its marks

**Files**

- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 26
- `apps/daemon/src/db/viewed.ts` — create: the table's reads and writes, as `db/workspaces.ts` is for its table
- `apps/daemon/src/git/viewed.ts` — create: the revision comparison against a changes read; it joins neither the table module nor Stage 1's reads
- `apps/daemon/src/domain/workspaces.ts` — the workspace's removal also clears its marks
- `apps/daemon/src/http/routes.ts` — the viewed routes
- `packages/protocol/src/git.ts`, `api.ts` — `GitViewedMark`, `ROUTES`
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts` — the three methods
- `apps/desktop/src/renderer/features/changes/DiffCard.tsx`, `ChangesToolbar.tsx`, `ChangesSidebar.tsx` — the checkbox, the toggle, the tick
- `apps/daemon/test/git-viewed.test.ts` — create: the cases above
- `apps/daemon/AGENTS.md` — the table and the revision rule

**Done when:** a file ticked as viewed stays ticked after a reload, and after it is edited in the worktree its card is unticked.
**Verify:** `cd apps/daemon && bun test test/git-viewed.test.ts test/storage.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/changes`
**Commits:** None yet.

## Stage 6 — Add to chat from the editor and the diffs

**Depends on:** Stage 4.

**This stage:** words selected in code go to the chat as a reference. One CodeMirror extension shows the button and answers `⌘I`, and both the Files editor and the diff cards take it, so the work is done once. The composer has no door from the side panel today (`ComposerHandle.quote` is reached only from the chat's own view), so a small bridge gives it one.

- [ ] Complete
  - [ ] A CodeMirror extension that shows "Add to chat" with `⌘I` (bound with `Prec.high`, since `defaultKeymap` binds `Mod-i` to select the parent syntax and host extensions come after it) over a non-empty selection and calls a host callback with the path, the line range and the text; in a diff card it covers the lines of the new text only, because `unifiedMergeView` draws removed lines as widgets that are not part of the document (the owner's call on this is open: the alternative is a renderer of our own over an interleaved document)
  - [ ] The Files editor gets it through `editorExtensions`; the diff cards get it from the diff view
  - [ ] A bridge in the renderer: the open chat's composer registers its `quote` while mounted, and the side panel calls it; a quote carries `path:from–to` and the selected text; with no chat open the button is not shown
  - [ ] The Docs editor (tiptap) takes the same button, or the stage records that it was cut
  - [ ] Tests: the extension's visibility and callback, the bridge's registration and removal, a quote reaching the composer's draft

**Files**

- `packages/file-manager/src/react/editor/selectionAction.ts` — create: the extension; `extensions.ts` holds the theme and language and has no selection logic
- `packages/file-manager/src/react/diff/DiffView.tsx` — takes the extension
- `packages/file-manager/src/react/FileManagerView.tsx` — `editorExtensions`: reused by the host
- `apps/desktop/src/renderer/features/chats/composerBridge.ts` — create: a module-level registry like `filesStoreOf`; `Composer.tsx` is a component the side panel must not import
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `ComposerHandle.quote`: registered with the bridge; `ChatView.tsx` — the registration
- `apps/desktop/src/renderer/features/files/FilesTab.tsx` — passes the extension to `FileManagerView`
- `apps/desktop/src/renderer/features/changes/DiffCard.tsx` — passes the callback
- `packages/file-manager/AGENTS.md`, `apps/desktop/AGENTS.md` — the extension and the bridge

**Done when:** selecting lines in a file or in a diff card shows Add to chat, and pressing it or `⌘I` puts a quote with the path and lines in the open chat's message box.
**Verify:** `cd packages/file-manager && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/chats src/renderer/features/changes`, `bun run lint`
**Commits:** None yet.

## Stage 7 — Commit the ticked files, with a generated message

**Depends on:** Stage 0, Stage 1, Stage 4.

**This stage:** the person commits from the sidebar. The daemon adds and commits exactly the paths sent, one commit at a time per place, with the person's git config (signing included), and Codex's tool-free run writes the message when Generate is pressed, if the person turned the `Commit messages` switch on for it and it is signed in. This is the first stage in which Clowdy changes a repository, so the daemon's rules in `AGENTS.md` change with it.

- [ ] Complete
  - [ ] The environment of the daemon's git writes: `GIT_TERMINAL_PROMPT=0` and the signing agent's socket as the Decisions say (`ssh -G` first, then the login shell), cached; a failure that names the signing key is shown with git's line and a hint
  - [ ] `POST /v1/projects/:id/git/commit` (`folderId`, `workspaceId?`, `paths`, `message`): `git add -- <paths>` then `git commit -m <message> -- <paths>`, one at a time per place (`exclusive`), about 120 s as the limit for a signing prompt, the answer carrying the new commit's id, or git's first `fatal:` or hook line as the error
  - [ ] Paths are judged against the place's changes (a renamed file brings both paths; a path outside the place is `invalid`); a commit with no paths or no message is refused
  - [ ] The `Commit messages` switch (`commitMessageSetting`, an `AgentSettingSpec` beside `chatTitleSetting`, off by default) on Codex's card; the daemon says whether a provider with the switch on is signed in, and the sidebar shows Generate only then
  - [ ] `POST /v1/projects/:id/git/message`: Codex's tool-free run as Stage 0 settled, with the file list and an excerpt of the diff (capped) and the repository's recent subjects for style, bounded in time; a failure is an error the box shows as `Couldn't write the message`, with no template text
  - [ ] The sidebar: the checklist with ticks (all ticked at first, untracked files included), the message box with Generate (when offered), Commit, Commit & Push (Push comes with Stage 8 and the button is added there), an error shown with git's own line, the list refreshed after a commit
  - [ ] The protocol types and the four transport places with fixtures
  - [ ] Tests on real repositories: a path-limited commit leaves another file's change in the tree, a new file and a deleted file are committed, a hook failure is reported, two commits in one place run one after the other; the message route refuses when no provider has the switch on

**Files**

- `apps/daemon/src/git/commit.ts` — create: the commit write; `changes.ts` is read-only by design
- `apps/daemon/src/git/writeEnv.ts` — create: the environment and the signing agent's socket for every git write (Stage 8 uses it too); `domain/git.ts` is the read runner and sets no agent
- `apps/daemon/src/engine/acp/catalog.ts` — `commitMessageSetting` beside `chatTitleSetting`, added to Codex's `settings`
- `apps/daemon/src/providers/generate.ts` — create: Codex's tool-free run; `exec.ts` is the provider-agnostic process runner and the catalog describes interactive sessions
- `apps/daemon/src/git/message.ts` — create: the prompt and the caps
- `apps/daemon/src/providers/exec.ts` — `runProgram`: reused
- `apps/daemon/src/domain/workspaces.ts` — `exclusive`: reused
- `apps/daemon/src/http/routes.ts` — the two routes
- `packages/protocol/src/git.ts`, `api.ts` — `GitCommitRequest`, `GitCommitResult`, `GitMessage`, `ROUTES`
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts` — `commitGit`, `generateGitMessage`
- `apps/desktop/src/renderer/features/changes/ChangesSidebar.tsx` — the commit area; `CommitBox.tsx` — create: the box, its button and states, which the sidebar's lists do not share
- `apps/daemon/test/git-commit.test.ts`, `git-message.test.ts` — create
- `apps/daemon/AGENTS.md` — the line "git only reads a folder it is given" replaced by the writes' rules; `.briefback/chat-worktrees/plan.md` and `.briefback/mvp/plan.md` — the out-of-scope lines revised

**Done when:** in the Changes tab, ticking two of three changed files, pressing Generate and Commit makes one commit of those two files with the generated message and leaves the third in the tree.
**Verify:** `cd apps/daemon && bun test test/git-commit.test.ts test/git-message.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/changes`, `bun run lint`
**Commits:** None yet.

## Stage 8 — Fetch, pull, push, publish and Create PR

**Depends on:** Stage 2, Stage 7.

**This stage:** the person moves the branch to GitHub and starts the PR without leaving the app. The four network actions are routes that wait on git, so they run outside any transaction with long timeouts, and Create PR is not a request at all: it opens GitHub's compare page once the branch is on the remote.

- [ ] Complete
  - [ ] `POST /v1/projects/:id/git/fetch`, `/pull`, `/push` (publish is a push with `-u origin HEAD` when there is no upstream), each one at a time per place, with git's own error line; pull is `--ff-only` and a diverged branch is answered as `diverged` and left alone
  - [ ] The sidebar's menu: Fetch, Pull, Push, Publish, each with a reason when disabled; Commit & Push in the commit box; the ahead and behind and the PR re-read after each action
  - [ ] Create PR: disabled on the default branch ("Switch to a feature branch"), Publish first on a branch with no upstream or with unpushed commits, else it opens `/compare/<base>...<branch>?expand=1` of the remote through the app's `openUrl`; once a PR exists the button becomes the PR chip's link
  - [ ] The branch is published before the compare page opens, and the page's URL never carries a credential from the remote
  - [ ] Tests on real repositories with a bare `origin`: fetch, a fast-forward pull, a diverged pull refused, push, publish with upstream, a rejected push reported

**Files**

- `apps/daemon/src/git/remote.ts` — create: the four network writes; `commit.ts` is local and the timeouts and errors differ
- `apps/daemon/src/http/routes.ts` — the routes
- `packages/protocol/src/git.ts`, `api.ts` — `GitRemoteAction`, `GitRemoteResult`, `ROUTES`
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts` — `fetchGit`, `pullGit`, `pushGit`
- `apps/desktop/src/renderer/features/openWith/openTarget.ts` — `githubLink`'s neighbour `compareLink`, from the same remote parsing
- `apps/desktop/src/renderer/features/changes/ChangesSidebar.tsx` — the menu and Create PR; `CommitBox.tsx` — Commit & Push
- `apps/daemon/test/git-remote.test.ts` — create
- `apps/desktop/src/renderer/features/changes/changesActions.ts` — create: the pure rule that names each action's state and reason, which the tests drive
- `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md` — the network actions and the Create PR rule

**Done when:** on a feature branch with commits, Publish pushes it with an upstream and Create PR opens the compare page of the branch against its base on GitHub.
**Verify:** `cd apps/daemon && bun test test/git-remote.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd apps/desktop test src/renderer/features/changes`, `bun run lint`
**Commits:** None yet.

## Stage 9 — Last turn (optional, cut if it costs more than it is worth)

**Depends on:** Stage 1, Stage 4.

**This stage:** the person asks what the last turn changed. A tree id taken when the turn starts is compared with the tree now. If this proves bigger than a stage's worth of code, or git's pruning makes it unreliable, the stage is dropped and recorded as cut.

- [ ] Complete
  - [ ] When a run's turn starts, the daemon makes a tree of the place's working directory with a temporary index (`GIT_INDEX_FILE`, `add -A`, `write-tree`), bounded in time, and keeps its id with the turn; a failure keeps nothing
  - [ ] A `turn` scope: the changes read and the file sides compare that tree with the tree of the working directory now; a missing object answers `unavailable`
  - [ ] The scope menu offers Last turn for the open chat when a snapshot exists
  - [ ] Tests: a turn that edits and adds files, a shell-made change, a pruned tree, two chats in one place

**Files**

- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: the next version; `apps/daemon/src/db/runs.ts` — the snapshot's id with the turn
- `apps/daemon/src/runs/driver.ts` — the start of a turn takes the snapshot
- `apps/daemon/src/git/snapshot.ts` — create: the temporary-index tree; `changes.ts` reads an existing scope and does not write objects
- `apps/daemon/src/git/changes.ts` — the `turn` scope
- `packages/protocol/src/git.ts` — `GitScope`
- `apps/desktop/src/renderer/features/changes/ChangesToolbar.tsx` — the menu entry
- `apps/daemon/test/git-snapshot.test.ts` — create
- `apps/daemon/AGENTS.md` — the snapshot and its limits

**Done when:** after a turn that edits two files, the Last turn scope lists those two files and not the ones changed before the turn began.
**Verify:** `cd apps/daemon && bun test test/git-snapshot.test.ts test/git-changes.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`
**Commits:** None yet.
