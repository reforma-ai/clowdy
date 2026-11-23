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
- The new Changes tab is a tree-and-view tab like Files: beside the chat, in the chat's place when the window is narrow, `Cmd+5`. The left side is the reading area: scope menu, totals, a filter input above the cards (substring or glob, `!` excludes, one input for the cards and the sidebar list; globs are matched by `minimatch`, which replaces the hand-written matchers everywhere, as the owner asked), a "hide viewed" toggle, expand and collapse all, and one card per file with its diff, expanded when the tab opens. The right side is a sidebar of 220 to 250 px, resizable and hideable like Files': the PR, the branch to its base with ahead and behind, an open-on-GitHub button and the Fetch, Pull, Push, Publish menu; the checklist of changed files (a click scrolls to the card, a tick shows a viewed file); the message box with a Generate button; Commit with a Commit & Push variant; Committed on branch; the list of commits, where a click sets the scope to that commit. The diff is unified only.
- The diff is drawn by `@codemirror/merge` 6.12.3 (MIT, published 2026-10-19), the one new dependency, in `packages/file-manager` beside the editor whose theme and languages it shares. A card reads both sides of the file as text (bb and Orca do the same), mounts its editor when it is near the screen and caps the size it loads.
- Viewed marks are the person's own, kept in the daemon's database and never sent to GitHub. A mark is keyed by (project, folder, workspace, scope, path) and holds the file's revision `<oldMode>:<oldBlob>:<newMode>:<newBlob>`; a file counts as viewed only while its revision is the one stored, so any later edit clears it.
- A commit takes only the files ticked in the sidebar (all ticked at first): `git add -- <paths>` then `git commit -m <message> -- <paths>`. The index is not a concept of the UI, and a neighbour chat's files in the same place stay out.
- The commit message is written by a provider the person chose, as bb lets one pick a service or none: a `Commit messages` switch on the provider's card in Settings (an `AgentSettingSpec` that only the daemon reads, as the chat title switch is, off by default), offered by Codex and by Claude. Codex is tried first and Claude is the fallback: the first provider in that order whose switch is on and that is signed in runs, and when its run fails or times out the next available one is tried once. The Generate button is there only while some provider with the switch on is signed in; otherwise there is no button. The run is separate (`codex exec`, the person's config ignored, model `gpt-6-luna` at low effort, every optional tool and context block off, a one-line instructions file the daemon writes once, an empty temporary folder as the working directory, the prompt on stdin, about 30 s as the limit; Claude's run is `claude -p` with every tool, MCP server, hook and memory off, the model `haiku` at low effort and every `CLAUDE*` and `ANTHROPIC*` variable removed from the child's environment, 2.1K input tokens and about 2.9 s in Spike A2), so the request does not take an agent's whole toolset: Stage 0 measured 6.3K input tokens and 4.1 s against 21.5K and 7.4 s for the defaults, and the exact argv is in `research/spikes.md`. Codex's `exec` and `wait` schemas stay (the model catalog forces code mode), which is the floor of about 3.3K tokens. Nothing runs on its own, and a failed run leaves the box as it was and says `Couldn't write the message`. There is no template text instead.
- Create PR opens GitHub's compare page (`/compare/<base>...<branch>?expand=1`) in the browser, as GitHub Desktop does, and `gh pr create` is not used. On a branch that is not published the button says Publish first (`push -u origin HEAD`). On the default branch it is disabled with "Switch to a feature branch".
- Fetch, Pull (`--ff-only`), Push and Publish are in the sidebar's menu. A branch that diverged from its upstream is shown as Diverged and left alone.
- Add to chat (the owner confirmed the diff cards cover the new text's lines only): a floating button over selected text, `⌘I`, as Reforma's `CodeView` has it (a CodeMirror `showTooltip` extension). It works in the Files editor and in the diff cards and puts a quote with the path, the line range and the selected text into the open chat's composer, as Reply quotes words. The Docs editor (tiptap) is later, and is cut if it is hard.
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

- [x] Complete
  - [x] A store of git facts per place (status, the branch's changes summary, the PR), shared across components by the transport, refreshed on window focus, on the end of a turn, and every 60 s while a check is pending, and not read while the window is hidden
  - [x] The strip: the PR chip (number, state, check dot, a click opens the PR's own link), its popover with the checks, and `Files changed N +a −d`, with a dirty dot; nothing for a folder that is not a repository; without `gh` or a login a soft hint worded from the host (`Sign in with gh` for github.com, `gh isn't signed in to <host>` for another host, since offline reads the same for a few seconds and GitLab or an SSH alias reads as not signed in)
  - [x] The Info tab rows: base, ahead and behind, PR, Files changed
  - [x] The branch the chips under the composer show and the strip agree on one read
  - [x] UI text ends without a period; tests for the strip's states (no repo, no `gh`, no PR, open, draft, merged, checks failing, dirty)

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
**Scope changes:** the chip is two buttons in one chip (the PR's own link, and a dot that opens the read-only checks menu) since one click cannot do both; `gh` not installed says `Install gh to see pull requests`; the strip shows no branch of its own, so nothing has to agree with the chips under the composer; the first draw waits for the status and the changes, not for `gh`; the run-end signal is `GitStrip` seeing its chat's orchestrator run leave a busy status (no daemon event); the store keeps the latest 8 places nobody observes; the Info label column is 8.25rem wide. `GitFacts.refresh(key)` is ready for the commit and pull stages.
**Review findings, fixed:** the 60 s PR poll was lost when an observer left and another came back within a second; the focus ring of the chip's buttons was clipped; a dead helper and an export were removed; tests added for Escape returning focus and for the dimmed stale chip. Left (follow-ups): `gitFacts.ts` and `UsageStatus.tsx` each carry a copy of the focus-and-visibility coalescing (a shared `onWindowReturn` helper would serve both and the Changes tab); a first observer that arrives while a slow `gh` read is in flight skips the status and changes refresh until it ends (a few seconds). Not checked: the real app with a real daemon, Windows.
**Commits:** `6bd75b1` feat(desktop): show the branch's pull request and changed files above the message box and in Info.

## Stage 4 — The Changes tab: diff cards, scopes and filter

**Depends on:** Stage 1, Stage 3.

**This stage:** the person reads what changed. A diff view for two texts goes into `packages/file-manager` on `@codemirror/merge`, sharing the editor's theme and language support, and a new tab composes it: the reading area with the scope menu, totals, filter and cards on the left, and the sidebar with the file list and the commits on the right. Nothing in this stage changes the repository or stores anything.

- [x] Complete
  - [x] `@codemirror/merge` 6.12.3 is added to `packages/file-manager` (the lockfile checked against `minimumReleaseAge`) (`669d0a6`)
  - [x] A read-only unified diff view of two texts for a path, with the editor's theme and the language of the path, unchanged lines collapsed and mounted lazily (`669d0a6`: `DiffView`, observer rooted at the nearest scroll container, diff timeout 200 ms); the card for binary and too-large files with no text is the tab's, not the view's
  - [x] The tab is registered (`changes`, a `TREE_TABS` member, `Cmd+5`, rail button, label) and keeps its choice per project; the fixtures page can open it with `?panelTab=changes`
  - [x] The reading area: scope menu (All, Branch, Uncommitted, a commit), totals, the filter input above the cards (substring, glob, `!`), hide viewed (left out until Stage 5 adds it: no inert control ships), expand and collapse all, cards expanded when the tab opens, a card per file with path, counts and copy path
  - [x] The sidebar, hideable and resizable like Files': the PR row, the branch to its base with ahead and behind, an open-on-GitHub button, the changed-file list (a click scrolls to the card), and the list of commits whose click sets the scope
  - [x] A card passes `estimatedLines` from the file's added and removed counts to `DiffView` (its own guess is 16 lines for two-sided diffs, real cards measured 526 to 5752 px), and the list does not set `overflow-anchor: none`
  - [x] A card reads its file with the list's own base (`GET .../git/file` takes the list's `from` and base state, as a hex commit checked on the daemon), so thirty cards do not repeat the base lookup and a card cannot be diffed against another base than the list was
  - [x] An empty state for a clean tree and for a folder that is not a repository; the tab follows `currentPlace`
  - [x] Tests for the filter's patterns, the scope switch, the empty states, and the diff view in the file-manager's specs

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
**Scope changes:** a card reads its file with the list's `from` (the transport is `getGitFile(projectId, place, scope, path, oldPath?, from?)`; a card costs about 6 git processes, not 13); the glob matcher is the author's own automaton (`compileGlob`), not `minimatch`, which `@clowdy/desktop` does not declare; the fixtures page has a `worktree` switch (`?fixtures=static&worktree&chat=c-9&panel=open&panelTab=changes`) for a chat in a dirty worktree; the GitHub button opens the repository page; `PlaceFacts.generation` counts the store's rounds of reads and `PlaceChanges.sync(generation)` is what refreshes the tab, with no timer of its own; the least width of the tab is `TREE_PANEL_MIN_WIDTH` (the widest of the file manager's and the Changes tab's, both 500 plus the frame, so `HALF_MIN_WINDOW_WIDTH` stays 1140); the sides cache holds 150 entries and 16 million characters per place, 4 places are kept.
**Review findings, fixed:** the filter's regex could freeze the window (`*a*a*a*a*a*b` took 4.6 s on a 100-character path, `a*a*a*a*b` over 8 s on 2000), now an automaton at 1 to 8 ms; reads of file texts were not cancelled for a card scrolled past, folded, filtered out or unmounted; the cache was unbounded in bytes; Hebrew and Arabic names read backwards in a card header (`bdi dir="ltr"`); the sidebar's lines ran past its edge at 150 px; stale comments and docs. Left (follow-ups): a card for `branch` or a commit scope is read against the current HEAD while the list pinned only its start, so a commit made in between can make it `not_found` until the list is read again (the fix is a `to` on `GitChanges` and the file route: a contract change, to do if it shows up); a typed plain pattern with a backslash (`src\\main`) searches for the literal backslash. Not checked: Windows, Git LFS, sticky header and RTL truncation outside Electron's Chromium, the summary line below the 504 px panel minimum.
**Later change (owner's request, `0633130`):** the glob matcher is `minimatch` (10.2.6 in the lockfile, declared by `@clowdy/desktop` as `^10.2.4` like `@clowdy/file-manager`): `fb393c4` the Changes filter, `cc1d263` the wildcard folders of the open-with search in the main process; kept: `workspaceSetup.ts` `matcherOf` in the daemon (a star-only matcher that was written to avoid backtracking, and `minimatch` backtracks), `Bun.Glob` in the daemon's file find, `@clowdy/file-manager`'s own use. `minimatch` is polynomial in the name's length with the number of star runs as the exponent (`*a*a*a*a*a*b` on 100 characters took 2.2 s, `a*a*a*a*b` on 2000 characters over 30 s), so a glob with more than three runs of stars in one part between slashes (`MAX_STAR_RUNS`) is read as plain text; behaviour changes forced by the swap: `src/**.ts` acts as `src/*.ts`, `[z-a]` matches nothing, braces and `+(a|b)` stay literal; the tests bound every case at 250 ms; `bun audit` reports GHSA-g3hv-75wg-m249 for `optimizationLevel` 2 and over, which nothing here sets. Bumping `minimatch` (11.0.9 exists) would also mean `file-manager` and `icons`.
**Commits:** `1a7c3f1` feat(daemon): read a file against the start of the list it belongs to; `a323b84` feat(desktop): count the rounds of git reads of a place and keep the status of a failed one; `40fefe8` refactor(desktop): move the pull request chip out of the strip to share it with the changes sidebar; `72c12cd` feat(desktop): add the filter, the scopes and the file texts cache of the changes tab; `3978b3e` feat(desktop): add the model of the changes tab; `aa0b6ab` feat(desktop): add the changes tab to the side panel; `30d9137` feat(desktop): add a chat in a dirty worktree to the fixtures page; `1a9170f` docs(desktop): describe the changes tab; review: `b010921` filter automaton, `0d272a9` cancelled reads and the byte bound of the cache, `131f405` right-to-left names and the sidebar's edge, `c8b65e7` docs; merged into `next` as `87b351c` (`632bb82` merged `next` into the branch, one conflict in `apps/desktop/AGENTS.md`).

## Stage 5 — Viewed marks bound to the file's content

**Depends on:** Stage 4.

**This stage:** the person ticks files as reviewed and the tick survives a reload and clears itself when the file changes. The mark's value is the revision that Stage 1 computes, so no timestamp or polling decides whether it still holds. It is the daemon's table, since the browser's storage would lose it.

- [x] Complete
  - [x] Migration 26 adds `viewed_files` (project, folder, workspace or empty, scope key, path, revision, time); the scope key is `uncommitted`, `branch:<base ref>`, `all:<base ref>` or `commit:<sha>`
  - [x] Routes to list the marks of a place and scope, set a mark with a revision, and clear it; a mark is returned as viewed only while its revision equals the file's current one
  - [x] The protocol types and the four transport places with fixtures
  - [x] The card's header has the Viewed checkbox and the sidebar list shows the tick; "hide viewed" works; a viewed card folds
  - [x] Marks of a removed workspace go with it
  - [x] Tests: a mark holds, an edited file loses it, another scope or place does not share it, a removed worktree drops its marks

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
**Scope changes:** the daemon keeps the revision the client sent and never judges it: the list answers `{ path, revision }` and the client calls a file viewed only while its revision in the current scope's list is the stored one (an edit clears the mark with no read, putting the text back brings it back); the daemon makes the scope key itself (`viewedScopeKey`, a short commit hash resolves to the full one), and `branch` and `all` carry the base's name as the changes read picks it (`origin/main`, or `main` while the local branch is ahead); a place keeps its newest 5000 marks over all its scopes; the routes are `GET`, `POST` and `DELETE .../git/viewed`; a viewed card starts shut when the tab opens and an edited file opens by itself; Hide viewed is disabled only while it is off with nothing viewed, and the all-viewed empty state offers `Show viewed files`; the sidebar's row press and the card's chevron open a viewed card and keep its mark.
**Review findings, fixed:** `deleteViewedOfWorkspace` scanned the whole table (SQLite cannot prove a bound parameter is non-empty, so the partial index was never used; the query now says `workspace_id <> ''`, which also means an empty id never deletes the checkout's marks); every Viewed checkbox was named just `Viewed` for a screen reader (now `Viewed <path>`); a real-repository test for the revision of an untracked file, a staged rename and a binary file, and for a `commit:` mark that holds after the branch moves on. Left (follow-ups): `GET .../git/viewed` repeats the base lookup of the changes read (about 42 ms of git against 86 ms for the whole read), fixed either by dropping the base's name from the `all` and `branch` keys (the revision already holds the base-side blob, so a mark would mean "I saw exactly this diff" whatever the base is called, and the `main` to `origin/main` flip would go; a contract change) or by returning the marks inside the changes read; the cap trim sorts the place's 5000 rows on every write (about 14 ms at the cap; a `LIMIT` trim of the oldest `count - 5000` rows is cheaper); a read that began during a write and is answered from before it, arriving after it, needs out-of-order answers over separate connections. Not checked: the real app with a real daemon, Windows.
**Commits:** `f408281` feat(daemon): keep the files a person marked as viewed, bound to the file's revision; `b2a2607` feat(desktop): add the viewed marks of a place to the transport; `9666483` feat(desktop): keep the viewed marks of the changes tab in a model bound to the file's revision; `fb6f0f8` feat(desktop): add the Viewed checkbox, the sidebar tick and the Hide viewed toggle to the changes tab; `a5ab2d4` docs: describe the viewed marks of the changes tab and the daemon's routes for them; `2a29fa1`, `ebc34a9`, `bf72f85`, `3153014` review fixes; merged by `5fab9a5`.

## Stage 6 — Add to chat from the editor and the diffs

**Depends on:** Stage 4.

**This stage:** words selected in code go to the chat as a reference. One CodeMirror extension shows the button and answers `⌘I`, and both the Files editor and the diff cards take it, so the work is done once. The composer has no door from the side panel today (`ComposerHandle.quote` is reached only from the chat's own view), so a small bridge gives it one.

- [x] Complete
  - [x] A CodeMirror extension that shows "Add to chat" with `⌘I` (bound with `Prec.high`, since `defaultKeymap` binds `Mod-i` to select the parent syntax and host extensions come after it) over a non-empty selection and calls a host callback with the path, the line range and the text; in a diff card it covers the lines of the new text only, because `unifiedMergeView` draws removed lines as widgets that are not part of the document (the owner's call on this is open: the alternative is a renderer of our own over an interleaved document)
  - [x] The Files editor gets it through `editorExtensions`; the diff cards get it from the diff view
  - [x] A bridge in the renderer: the open chat's composer registers its `quote` while mounted, and the side panel calls it; a quote carries `path:from–to` and the selected text; with no chat open the button is not shown
  - [x] The Docs editor (tiptap) takes the same button, or the stage records that it was cut
  - [x] Tests: the extension's visibility and callback, the bridge's registration and removal, a quote reaching the composer's draft

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
**Scope changes:** the composer registers with the bridge from inside `Composer` (`useRegisterComposer`), not from `ChatView`: the edit-frame box and a read-only chat register nothing, and the new-chat page's box does; `useAddToChat(pathOf)` returns no extension while no box is mounted; the quote is `` `path:from-to` `` then the text in a fenced block named by the file extension, inside the composer's `> ` quote, capped at 100,000 characters (cut at a whole line, the header names the lines actually quoted); after a quote `ui.showChat()` shuts a side panel that covers the chat so the box can be typed in (the author's addition, kept: a panel beside the chat is untouched); the Docs rich (tiptap) view is cut (a selection in rendered Markdown cannot be traced to source lines), a Markdown document in its source view has the button; removed lines of a diff cannot be quoted (the owner confirmed); Escape does not dismiss the button, several selection ranges quote only the main one.
**Review findings, fixed:** `quoteOf` dropped blank lines between lines starting with `>` inside code (two blockquotes in a Markdown file were corrupted): it keeps them inside fenced blocks now; a quote had no cap (a 1.7 MB lockfile took 1.1 s to quote and each keystroke after 0.4 s) and a huge count of backtick runs could throw a `RangeError`; an unused export; fixed 20 ms pauses in specs. Left (follow-ups): `docToPlainText` writes hard breaks as two spaces and a newline, so the agent receives every line of a quoted code block with two trailing spaces (Reply quotes too): harmless to read, wrong for whitespace-sensitive code, and the fix reaches the shared message serializer; a path with a backtick breaks the inline code span on the quote's first line. Not checked: Windows, a real mouse drag in Electron.
**Commits:** `0b8866f` feat(file-manager): add a selection button that hands the selected lines to the host; `ab7d218` feat(desktop): let the side panel quote code into the message box; `865bfe9` feat(desktop): offer Add to chat over words selected in the Files editor and the diff cards; `e335fc6`, `29347a1`, `866a39b`, `6841c9b` fixes, tests and docs by the author; review: `67193ba` fenced quotes keep blank lines, `6d30d8d` quote cap, `905fcae` export and specs, `9f97ec6` the `ChangesTab.test.tsx` mock, `1155c9e` docs; merged into `next` as `5de1a2f` (two conflicts resolved on the branch: `FilesTab.tsx` and its test after the place bar was removed on `next`, and long bullets of `apps/desktop/AGENTS.md`).

## Stage 7 — Commit the ticked files, with a generated message

**Depends on:** Stage 0, Stage 1, Stage 4.

**This stage:** the person commits from the sidebar. The daemon adds and commits exactly the paths sent, one commit at a time per place, with the person's git config (signing included), and Codex's tool-free run writes the message when Generate is pressed, if the person turned the `Commit messages` switch on for it and it is signed in. This is the first stage in which Clowdy changes a repository, so the daemon's rules in `AGENTS.md` change with it.

- [x] Complete
  - [x] The environment of the daemon's git writes: `GIT_TERMINAL_PROMPT=0` and the signing agent's socket as the Decisions say (`ssh -G` first, then the login shell), cached; a failure that names the signing key is shown with git's line and a hint
  - [x] `POST /v1/projects/:id/git/commit` (`folderId`, `workspaceId?`, `paths`, `message`): `git add -- <paths>` then `git commit -m <message> -- <paths>`, one at a time per place (`exclusive`), about 120 s as the limit for a signing prompt, the answer carrying the new commit's id, or git's first `fatal:` or hook line as the error
  - [x] Paths are judged against the place's changes (a renamed file brings both paths; a path outside the place is `invalid`); a commit with no paths or no message is refused
  - [x] The `Commit messages` switch (`commitMessageSetting`, an `AgentSettingSpec` beside `chatTitleSetting`, off by default) on Codex's and Claude's cards; the daemon says whether a provider with the switch on is signed in, and the sidebar shows Generate only then
  - [x] `POST /v1/projects/:id/git/message`: Codex's tool-free run, then Claude's as the fallback, as Stages 0 and A2 of the spikes settled, with the file list and an excerpt of the diff (capped) and the repository's recent subjects for style, bounded in time; a failure is an error the box shows as `Couldn't write the message`, with no template text
  - [x] The sidebar: the checklist with ticks (all ticked at first, untracked files included), the message box with Generate (when offered), Commit, Commit & Push (Push comes with Stage 8 and the button is added there), an error shown with git's own line, the list refreshed after a commit
  - [x] The protocol types and the four transport places with fixtures
  - [x] Tests on real repositories: a path-limited commit leaves another file's change in the tree, a new file and a deleted file are committed, a hook failure is reported, two commits in one place run one after the other; the message route refuses when no provider has the switch on

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
**Scope changes:** the write environment (`git/writeEnv.ts`) takes the signing agent from `ssh -G -- <origin host>` (an absolute `identityagent` line only; an alias with an underscore works), then the login shell (3 s, cached, with markers round the value), then the inherited socket, replaces the inherited one, is cached per host and found again after a failure that names the signing key, and drops the daemon's own variables (`CLOWDY_*`, `ELECTRON_*`, `NODE_OPTIONS`, Claude session markers) from what hooks see; `process.env` is never changed. A commit runs `git --literal-pathspecs add -- <paths>` then `git commit -m <message> -- <paths>`, one per place (`exclusive`, key `git:<real path>`), 120 s then SIGTERM so git removes `index.lock` itself (`runProgram` got a `stopSignal` option; its answer comes when the signal is sent, not when git is gone). Paths are judged against the place's own `uncommitted` list (a rename brings both paths, a path past the 500-file cut is refused as not changed); a merge, cherry-pick or revert in progress and an unmerged file are `conflict`; nothing skips hooks or signing, and a test rejects `--no-verify` and any signing bypass. The message route runs the first of `[codex, claude]` that has the switch on and is signed in, and once the next one when its run fails, times out or says nothing (Codex by the argv of the spike, Claude's with `CLAUDE*` and `ANTHROPIC*` scrubbed and `MAX_THINKING_TOKENS=0`, both in an empty temporary folder with the prompt on stdin, 30 s); the prompt carries the file list, up to 32 KB of diff shared between the files (binary and too large ones are only named) and the last 10 subjects, says the diff is data, and the answer is cut at a word to 72 characters; errors are `Couldn't write the message` with `details.reason` `off`, `signed_out`, `failed` or `timed_out`. Generate is offered by the renderer from `AgentInfo` (some agent is on, ready and signed in), with no new endpoint. The commit box sits between `Changed files` and `Committed on branch` (a checklist with a select-all tick, up to nine rows then scroll; a message field; Generate; one filled primary Commit; Cmd/Ctrl+Enter); Commit & Push is added in Stage 8; the fixtures page has `&commit=signing|hook|slow` and `&message=failed|slow`. The switch is on Codex's and Claude's cards, off by default; a person who gives Claude its login through `CLAUDE*` or `ANTHROPIC*` variables (a config dir, an API key, Bedrock, Vertex) gets Codex's message, not Claude's (documented).
**Review findings, fixed:** a failed commit (a hook, signing, no identity) left the ticked paths staged, so a later `git commit` in the terminal or by another chat would have taken them: the daemon now records which paths were already staged and runs `git reset -q --` for the others only (a path the person had partly staged is widened by the add and cannot be restored: documented); `remoteHost` refused an ssh alias with an underscore; `cleanSubject` returned the line of a code fence when a model wrapped its answer; the prompt did not say the diff is data (a real `codex exec` and `claude -p` each ignored an injected "write PWNED" line); the box did not say when the list was cut at 500 (`Showing the first N files`); the `runProgram` stop test was a race of its own making (300 ms timeout, a ready file that exists before its text; now waits for the text, 60 of 60 solo runs); added tests for a path or a message starting with `-`. Wording after the merge: the switch says `Send the changed files to Codex to write commit messages`, because the prompt carries the text of the ticked files (a ticked `.env` too). Left (follow-ups): after the 120 s limit `commit()` returns while git may still hold `index.lock` for a few milliseconds (wait about 2.5 s for the lock to go before leaving the `exclusive` line if it ever shows); no named secret file is left out of the excerpt; `runProgram` kills the process group when git exits, so a `post-commit` hook that backgrounds work loses it (existing behaviour); `apps/daemon/test/fs-service.test.ts` "writes that follow each other in one folder never mix" fails about one run in four alone (the order of two `Promise.allSettled` writes is not guaranteed; not from this stage). Not checked: a real Touch ID or Secretive wait (the 120 s and 30 s limits are suppositions), Windows.
**Commits:** `f7ce848` feat(protocol): add the git commit and message routes and their types; `0ee2ea7` feat(daemon): find the signing agent for the git writes; `e6c9aa1` feat(protocol): say which agents can write commit messages; `5a7432e` feat(daemon): commit the ticked files with the person's git and write their message with Codex or Claude; `cc5e01b` feat(desktop): add the commit and the commit message to the transport; `e8bb5db` feat(desktop): commit the ticked files from the Changes sidebar; `088fe7d` docs: say the daemon writes to a repository now, and describe the commit box; review fixes `175fb6b`, `6f7bfcc`, `d6220df`, `73bbf7d`, `f8874d8`, `ef39299`, `b379428`; `e164ee1` the switch's wording; merged by `f59d4cf`.

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
