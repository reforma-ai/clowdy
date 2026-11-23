# Chat worktrees

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a chat can work in its own git worktree, made by Clowdy under `~/Clowdy/workspaces` or picked from the folder's existing ones, and the side panel's Files, Docs and Terminal tabs, Cmd+K and the chat's folder chips all follow the place the chat's agent works in.

**Approach:** a worktree is a *workspace*: a row the daemon keeps per worktree (`workspaces`), which chats point at (`chats.workspace_id`), so several chats can share one. A chat's workspace is chosen once in the draft and is fixed from the first message; it replaces the chat's folder as the turn's working directory. The worktree itself is made at the chat's first turn as a daemon-written tool item (`Prepare workspace`, with its log), so the person sees the fetch and the checkout and a failure stops the chat with a reason. Everything that took a `folderId` to read or run something in a folder (the file system, terminals, documents) learns an optional `workspaceId` that swaps the folder's main checkout for the worktree; the app calls the pair a *place*. Git is the source of truth for what worktrees exist (`git worktree list --porcelain`); Clowdy's rows only add who uses them and which ones Clowdy made and may remove.

**Research:** none written. The owner's bb screenshots (chat start: folder, mode and branch chips; a Worktree mode with New and Existing; a Reuse list) and the earlier worktree notes in `.briefback/mvp/research/daemon-runtime.md` ("Where to keep worktrees") are the inputs. bb's own source is at the clone in `reference-bb-source-clone` (memory), read-only.

**Decisions** (the owner's, from the chat of 2026-11-22; the memory `clowdy-worktree-design` holds them too)

- Worktrees live in `~/Clowdy/workspaces/<project-slug>/<chat-id8>/<folder-name>/` (`workspacesDir` in the daemon's config, next to `projectsDir`, `CLOWDY_WORKSPACES_DIR` overrides it), on the branch `clowdy/<chat-id8>`. `<chat-id8>` is the last 8 characters of the chat's id (the random end of the ULID, the front of which is time), `<folder-name>` is the folder's own name from `folderNames`, so a shell prompt and a window title read as the project does. Outside the repository: no gitignore, no indexer walks N copies.
- A worktree is a property of the chat, not a level of the tree and not a project folder. It is chosen in the draft, once, and is read only from the first message on, as the chat's folder is.
- Under the message box there are three chips: folder, mode, branch. The mode menu is one list: `Project checkout`, `New worktree`, `Existing worktree…` (bb's separate Reuse item is dropped). The branch chip depends on the mode: Project checkout shows the checked out branch, read only; New worktree shows `Branch from: <ref>` with a searchable list of branches; Existing worktree has no branch chip, the worktree's own branch is its label. After the first message the same chips stay, read only, and a press opens the folder's menu (`OpenWithMenu`: Open in Finder, the editor, copy path), which for a worktree chat acts on the worktree. *(Superseded by the last follow-up: the mode and the branch are one control.)*
- The branch chip of a started chat shows the branch the tree has checked out now, not the one it was made with: an agent switches branches inside a worktree, and a chip that kept the first name would be wrong from then on. It is read from the daemon as the folder's chip is (when it is drawn and when the window gets focus again, with `projectsInfo`), and shows nothing until the read answers; only while the worktree is not made yet does it show the branch it will be made on. The same read serves a chat in Project checkout. *(Superseded by the last follow-up: the mode and the branch are one control.)*
- The base of a new worktree is the folder's default branch: `origin/HEAD` (`main`, `master`, `next`…), else `origin/main` or `origin/master`, else a local `main` or `master`, else the current HEAD. A remote ref is fetched first; a failed fetch is not fatal when the ref was fetched before, and the log says it uses the last fetched one. A folder may set its own base branch in its settings, which comes before that list (Stage 5); a configured branch the repository does not have is skipped.
- Branch changes in Project checkout (New branch, Checkout) are not offered: changing the branch of a checkout other chats work in is the person's or the agent's own git. Whoever wants another branch takes a worktree.
- Several chats may work in one worktree, with no block and no warning: the owner runs several agents in one branch at once, each committing after every change. The list of existing worktrees says which chats use each (information only).
- Existing worktrees are what `git worktree list --porcelain` says for the chat's folder (agents' own worktrees and hand-made ones too), not a registry of Clowdy's. Clowdy removes only the worktrees it made (under `workspacesDir`), never one it merely found.
- A worktree is made as the first step of the chat's first turn: a tool item of the chat's stream, `Prepare workspace`, running while it fetches and checks out, its log (git's own lines) inside, an error if it fails. A failure fails the turn with that reason, and the next message tries again. The step makes the worktree again whenever a Clowdy-made one is missing (a branch that exists is checked out as it is, a new one is made from the base).
- Preparing never touches a tree that is there: a path that git lists as a worktree of the folder's repository is left exactly as it is (no checkout, reset, clean or stash, no `--force`), whatever its branch or changes; a path that exists and is not such a worktree is an error and is left alone; a branch that another worktree has checked out is an error, not a takeover. Only a path that is not there is made, from the stored branch when the repository has it, else from the base.
- The chat's cwd for every turn is the worktree. The chat's own main checkout is left out of the agent's additional folders and the system prompt names the worktree, its branch and the main checkout, so an agent does not wander back into it. The project's other folders reach the agent as before.
- A thread works in its parent's workspace by default; an own worktree only on request (`clowdy thread spawn --worktree`), branched from the parent's branch. A fork of a chat shares its workspace, since an agent keeps its sessions by working directory and the fork resumes a copy of the session.
- Files, Docs, Terminal, Cmd+K and the `@` mentions of the message box all work over the same files: the ones the Files tab shows for the chat's place. For the chat's own folder that is its worktree (a file or a plan an agent wrote there is not in the main checkout, so only the worktree has it), for the project's other folders their main checkouts; a sibling worktree of the same repository (another chat's) is never listed.
- Removing a worktree is the person's choice, made when a chat is deleted, never when it is archived. The delete dialog of a chat offers a checkbox, `Also remove the worktree and its branch`, off by default, only when the daemon says it can be done: Clowdy made the worktree, no chat besides the deleted one and the threads below it (which go with it) uses it, nothing in it is uncommitted (a new file counts), and its branch is contained in its base ref as last fetched. Ticked, the worktree is removed and its branch deleted with the chat; unticked, or when it cannot be done, the worktree and the branch stay (a worktree that stays is still listed among the folder's existing worktrees). A branch that was squash-merged or merged on the remote and not fetched yet is not recognised as merged.
- Folders of one project are different repositories (a monorepo with the code, one with the infrastructure, one with marketing materials), so what a new worktree needs is a setting of each folder, not of the project: the folder's settings hold its base branch and its setup, and the same path in two projects has two sets (they belong to the project's row of the folder). Setup runs inside Prepare workspace after the checkout: the listed files are copied from the folder's main checkout when they exist there (`.env` files), then one command runs in the worktree (`bun install`, `bun run build:shared`), its output in the log. The command sees `CLOWDY_ROOT_PATH` (the main checkout), `CLOWDY_WORKSPACE_PATH` and `CLOWDY_BRANCH`, and is stopped after ten minutes.
- A folder that is not a git repository (the personal space, any plain folder) has no worktree mode: the mode chip offers Project checkout only.
- Getting the work back to the base branch is git's and the agent's; the app shows the branch and whether an existing worktree has changes, with no merge button.
- Everything is written for Windows as much as for macOS from the first line, though nothing is run there until the owner tries the whole app: paths go through `node:path` and are never built or split on `/` (git prints `C:/Users/…` there, and its paths are normalised to the machine's own before they are compared or sent), places are compared by `realpath`, the setup script goes through `cmd /c` where `sh -c` is not, the worktree is made with `core.longpaths` on and the ids in its path stay short, and nothing assumes a symbolic link or a shell that Windows may not have.
- UI text without a closing period, as `AGENTS.md` asks.

**Defaults I took** (the owner may change them)

- A setup command is a script for the system's shell (`sh -c`; `cmd /c` on Windows), several lines allowed, stopped after ten minutes; the files to copy are exact relative paths or a `*` in the last segment (`.env*`), none outside the folder.
- The id of a workspace is `wks_…` (a new `IdPrefix`); `<project-slug>` is the project's name in kebab case at the time of the first worktree and is stored in the row's path, so renaming the project moves nothing.

**Reuse:** `git`, `gitLine` (`apps/daemon/src/domain/git.ts`); `folderHead`, `projectsInfo` (`apps/daemon/src/domain/projects.ts`); `createChat`, `saveChat`, `setChatArchived`, `deleteChat` (`apps/daemon/src/domain/chats.ts`); `appendItem`, `updateItem` (`apps/daemon/src/domain/items.ts`); `workingFolder`, `additionalFolders`, `surroundings` (`apps/daemon/src/runs/driver.ts`); `prepareFork` (`apps/daemon/src/runs/fork.ts`); `folderNames`, `mainFolder` (`packages/protocol/src/domain.ts`); `DraftFolderSelect`, `FolderTrigger`, `ChatFolder`, `OpenWithMenu`, `useFolderGit` (desktop); `FilesStore`, `docsScopeOf`.

## Out of scope

- Switching or creating a branch in Project checkout.
- A project default for "new chats start in a worktree"; a setup file committed to the repository (a team's shared one): the settings are the person's own.
- A Workspaces page in Settings that lists a project's worktrees (Clowdy's and found ones, with the chats that use them and their state) and removes them: not a page but the Manage worktrees dialog, planned in `.briefback/worktree-followups/plan.md` (squash merges stay out of it).
- A merge, a pull request or ahead and behind in the app (**changed on 2026-11-23 by `.briefback/git-integration/plan.md`: the app shows how far a place's branch is from its base and its pull request, and commits, fetches, pulls and pushes from the Changes tab; a merge of a pull request is still out**); managing worktrees that agents made (they are listed and can be picked; removing them is `.briefback/worktree-followups/plan.md`'s, through the Manage worktrees dialog).
- One tree with all the folders of a project (VS Code's), and a folder switcher in the side panel's tabs.
- A worktree for the project's other folders (only the chat's own folder gets one; the rest reach the agent as additional folders).

## Stage 1 — What git says about a folder

**Depends on:** None.

**This stage:** the daemon learns to read a folder's branches and worktrees, and says so over one endpoint, which the draft's chips and `chat.create`'s checks use. The default-branch rule lives in one function. Nothing is created or removed yet.

- [x] Complete
  - [x] `GET /v1/projects/:id/git?folderId=` (the worktrees' paths in the machine's own form) answers `{ isRepository, branch, detached?, defaultBranch?, branches: [{ name, remote }], worktrees: [{ path, branch?, head, main, dirty }] }` (the checked out branch of the folder, its branches local and remote without `origin/HEAD`, and `git worktree list --porcelain`, the folder's own checkout flagged `main`, `dirty` from `git status --porcelain`); a folder that is not a repository answers `isRepository: false` and nothing else
  - [x] `defaultBranchOf(folder)`: `origin/HEAD`, else `origin/main`, `origin/master`, else local `main`, `master`, else the current HEAD; no network
  - [x] Reads do not hold the daemon up (the async `gitLine` style, with its timeout), and a folder gone from the disk is `unavailable`
  - [x] Protocol types and the app's transport method (`getFolderGit`), with the fixture transport answering a repository with branches and two worktrees
  - [x] Tests on real repositories in a temp folder, with a bare `origin` for the remote refs and `origin/HEAD`

**Files**

- `apps/daemon/src/domain/git.ts` — `git`, `gitLine`: a `gitLines` reader that returns every line (the worktree list and the ref list are many lines)
- `apps/daemon/src/git/state.ts` — create: `folderGit`, `defaultBranchOf`, `parseWorktrees`; it cannot join `domain/git.ts`, which is the thin process layer, and `domain/projects.ts` is about projects
- `apps/daemon/src/http/routes.ts` — the `git` route
- `packages/protocol/src/api.ts` — `FolderGit` (the answer), `GitBranch`, `GitWorktree`
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts` — `getFolderGit`
- `apps/daemon/test/git-state.test.ts` — create: a new subject, nothing else tests git beyond `projects.test.ts`'s branch read
- `apps/daemon/AGENTS.md` — the endpoint and the base-branch rule

**Done when:** for a repository with a bare `origin`, two local branches and a second worktree, the endpoint lists the branches, the default branch and both worktrees with the main one flagged, and for a plain folder says it is no repository.
**Verify:** `cd apps/daemon && bun test test/git-state.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/daemon && bun run typecheck`
**Review findings, fixed:** `dirty` hid a new file under the person's `status.showUntrackedFiles=no` (the status now sets `--untracked-files=normal` and `--ignore-submodules=none`); a repository that keeps its git directory apart from the checkout got the git directory as a worktree and no own checkout (entries must be working trees, the folder's own entry is made when git lists none); a locked worktree whose folder is gone was listed as dirty; a git that timed out or was not installed read as "no repository" or as an empty list (`gitRead` tells git's own no from a git that could not be asked, and the route answers `unavailable` for the second); a branch name is short and not always a ref git takes bare (a tag called `main`), so Stage 2 resolves a base through `refs/heads/` and `refs/remotes/`; the default branch is picked from the one list of refs already read instead of a git run per candidate. Left: a worktree path with a newline in it is cut (`-z` needs git 2.36), a `core.fsmonitor` configured in a repository would run under `status`.
**Commits:** `5b74638` feat(daemon): read a folder's branches, default branch and worktrees from git.

## Stage 2 — A chat's workspace in the daemon

**Depends on:** Stage 1.

**This stage:** a chat gets a workspace and its turns run there. `chat.create` takes the choice (a new worktree from a base, or an existing worktree), the daemon records the workspace row and points the chat at it, and the chat's first turn makes the worktree as the `Prepare workspace` item before the agent's session opens. Threads and forks share their parent's workspace. This is the decision-heavy stage: the layout of `workspacesDir`, the branch name, that a missing Clowdy-made worktree is made again, and what the agent is told.

- [x] Complete
  - [x] Protocol: `ChatWorkspace { id, path, branch?, managed, ready }`, `Chat.workspace?`, `chat.create.workspace?: { mode: 'new', base?: string } | { mode: 'existing', path: string }`, a `wks` id prefix
  - [x] Migration 24: `workspaces` (id, project_id, folder_id, path, branch, base, managed, created_at) and `chats.workspace_id`, with no foreign keys (a project update rewrites the folder rows); `toChat` embeds the workspace, so it is published with the chat
  - [x] `workspacesDir` in the config; `domain/workspaces.ts` makes the row and the path `<workspacesDir>/<project-slug>/<chat-id8>/<folder-name>` and the branch `clowdy/<chat-id8>`
  - [x] A base is resolved as `refs/heads/<name>`, then `refs/remotes/<name>`, never as a bare name (a tag called `main` would make it ambiguous), and a detached HEAD's short hash is taken as a commit; `worktree add` is given the resolved commit
  - [x] `chat.create` with a workspace: `invalid` for a folder that is not a repository, a base that is not a ref of it, an existing path that `git worktree list` of the folder does not name, and for a workspace with `chat.folderId` of another folder
  - [x] The first turn (and any later turn while the Clowdy-made worktree is missing) runs `Prepare workspace`: a `tool` item of the orchestrator run (`name: 'workspace'`) with the git lines as its output as they arrive, `fetch` of a remote base (a failure with the ref fetched before is a log line, not an error), `git worktree add` (`-b` from the base, or the existing branch as it is), `ready` set and published; a failure ends the turn with the reason and leaves the next message to try again
  - [x] `workingFolder` returns the workspace path; `additionalFolders` leaves out the chat's own folder when it works in a workspace; the system prompt names the worktree, its branch and the main checkout
  - [x] A thread takes its parent's workspace (`threads.ts`), a fork its source's (`fork.ts`); the same row, not a copy
  - [x] Daemon tests with the fake engine reporting its `cwd`, on real repositories, among them: a second turn and a second chat on a worktree with uncommitted and committed work leave every file and the branch as they were, a path that exists but is no worktree and a branch checked out elsewhere are refused with nothing changed

**Files**

- `packages/protocol/src/domain.ts` — `Chat`: `workspace`; `ChatWorkspace`
- `packages/protocol/src/commands.ts` — `chat.create`: `workspace`
- `apps/daemon/src/ids.ts` — `IdPrefix`: `wks`
- `apps/daemon/src/config.ts` — `workspacesDir`, `CLOWDY_WORKSPACES_DIR`
- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 24
- `apps/daemon/src/db/chats.ts` — `ChatRow`, `toChat`, `upsertChat`: `workspace_id`
- `apps/daemon/src/db/workspaces.ts` — create: the rows and the join; `db/projects.ts` and `db/chats.ts` are other tables
- `apps/daemon/src/domain/workspaces.ts` — create: the layout, `createWorkspace`, `prepareWorkspace`, `ensureWorktree`; it cannot join `domain/chats.ts`, which is the chat rows
- `apps/daemon/src/domain/chats.ts` — `createChat`: `workspace`
- `apps/daemon/src/commands/chat.ts` — `chat.create` passes it on
- `apps/daemon/src/runs/driver.ts` — `workingFolder`, `additionalFolders`, `surroundings`, and where a turn opens its session (the loop above `surroundings`): the Prepare step before it
- `apps/daemon/src/runs/prompts.ts` — `systemPrompt`: the workspace lines (it takes the chat's workspace beside `cwd`)
- `apps/daemon/src/runs/threads.ts`, `apps/daemon/src/runs/fork.ts` — the workspace is inherited
- `apps/daemon/test/chat-workspaces.test.ts` — create: a chat and its workspace is one subject no existing file is about (`chat-folders.test.ts` is the pattern)
- `apps/daemon/AGENTS.md` — workspaces, the layout, Prepare workspace, what a turn's cwd is now (the order: run's own `cwd`, workspace, chat's folder, main folder)

**Done when:** a chat made with `workspace: { mode: 'new' }` in a temp repository has, after its first message, a worktree at `<workspacesDir>/<slug>/<id8>/<folder>` on `clowdy/<id8>` made from the default branch, a finished `Prepare workspace` item with git's lines, and the fake engine's `cwd` is that path; a thread and a fork of it run in the same path; an existing worktree is used as it is.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/chat-folders.test.ts test/threads.test.ts test/fork.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`
**Scope changes:** `chat.create` is synchronous, so it reads the repository with sync git (a 10 s timeout each; `parseBranches` and `pickDefaultBranch` are exported from `git/state.ts`) and Stage 5's base setting needs a sync twin of `baseOf` there; a chat with a workspace has `Chat.folderId` pinned to the workspace's folder (the main folder's id too), so a later change of the main folder cannot separate the two; chats that pick one existing worktree share its row; `chatsOfWorkspace` gives ids; `domain/lines.ts` (`runLines`, the line-by-line process runner that kills the tree and works on POSIX and Windows) is what Stage 5's setup command runs through; migration 25 (24 is the folder settings). A turn in a worktree gets the repository's git directory (`git rev-parse --git-common-dir`) among its additional folders, so a sandboxed agent can commit in it; whether a real Claude or Codex can with only that handed over is not checked. The personal space is a repository too, so it can have a worktree.
**Review findings, fixed:** a Stop or a fetch timeout did not bound the step (the process group is killed, the wait for its pipes is capped); a missing path is re-checked right before `git worktree remove` and before the checkout; a worktree git still has locked as `initializing` is refused; a base is an exact ref (`show-ref --verify`); a failure shows git's first `fatal:` line; the engine is checked before the worktree is made.
**Commits:** `a3a76b2` feat(daemon): let a chat work in a git worktree, made by its first turn; `64a2822` fix(daemon): bound a stopped workspace step and refuse a worktree that was cut off while it was made; `1af80f2` feat(daemon): hand an agent in a worktree the repository's git directory, in place of the main checkout.


## Stage 3 — Places: the file system, terminals and documents in a worktree

**Depends on:** Stage 2.

**This stage:** every request that names a folder to read or run something in may also name a workspace of that folder, and the daemon uses the worktree in place of the main checkout. One resolver judges it (the workspace has to belong to the folder and the project), so no request can reach a path the project does not own.

- [x] Complete
  - [x] `placeOf(store, project, folderId, workspaceId?)` gives the folder and the root to read, `unavailable` while the workspace is not made (`ready` false) or gone from the disk
  - [x] The file system routes (list, find, read, write, make folder, move, copy, delete, watch, search) take `workspaceId` (query, or body for the posts) and use `placeOf`; the watch of a worktree is its own
  - [x] A terminal made with a `workspaceId` starts in the worktree; `TerminalInfo` carries it, and a project's list of terminals tells them apart by place
  - [x] `GET /v1/projects/:id/docs?workspaceId=` lists the document sources of that worktree for its folder, the other folders as before
  - [x] `GET /v1/projects/:id/files?workspaceId=` (the `@` mentions' and Cmd+K's list of names) lists the worktree's files in place of its folder's main checkout, the other folders as before; the worktree's own tracked and unignored files, a file only the worktree has included
  - [x] `projectsInfo` reports each workspace of the project (`ProjectInfo.workspaces`: `workspaceId`, `exists`, and the checked out branch or short hash with `detached`, read as a folder's head is), which the app's live read of a chat's branch uses
  - [x] Tests: a worktree's file read and written, a workspace of another folder or project refused, a terminal's cwd, the docs of a worktree having a plan the main checkout lacks

**Files**

- `apps/daemon/src/domain/workspaces.ts` — `placeOf`
- `apps/daemon/src/fs/service.ts` — `folderOf`, `open` (and the methods that pass the folder on)
- `apps/daemon/src/http/fs-routes.ts` — `place`, `moveBody`, `copyBody`, `deleteBody`, `searchBody`, `location`
- `apps/daemon/src/terminals/service.ts`, `apps/daemon/src/http/terminals.ts` — the create request
- `apps/daemon/src/docs/tree.ts`, `apps/daemon/src/http/routes.ts` — `docsTree`, the `docs` and `files` routes
- `apps/daemon/src/files/service.ts` — `FilesService.search`: the workspace's path in place of its folder's
- `apps/daemon/src/domain/projects.ts` — `projectsInfo`: the workspaces' heads (`folderHead`, now in `git/state.ts`)
- `packages/protocol/src/domain.ts` — `ProjectInfo`: `workspaces`; `ProjectWorkspaceInfo`
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — `getProjectsInfo` reports the fixture's workspaces
- `packages/protocol/src/api.ts` — `TerminalCreate`, `TerminalInfo`: `workspaceId`
- `apps/daemon/test/fs-service.test.ts`, `fs-http.test.ts`, `terminals.test.ts`, `docs.test.ts`, `files.test.ts`, `projects.test.ts` — the worktree cases, the workspaces' heads
- `apps/daemon/AGENTS.md` — the places and the line "no per-chat or per-worktree terminal" updated

**Done when:** over HTTP, the same `folderId` with a `workspaceId` lists, reads and writes the worktree's files, opens a terminal in it lists its documents and its file names, and with another folder's workspace answers `not_found`.
**Verify:** `cd apps/daemon && bun test test/fs-service.test.ts test/fs-http.test.ts test/terminals.test.ts test/docs.test.ts test/files.test.ts test/projects.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `bun run --cwd apps/desktop typecheck`
**Scope changes:** the resolver is `resolvePlace` in `domain/places.ts` (not `placeOf`, which is Stage 2's path normaliser); `FsService` methods take `FolderId | Place`; the worktree cases are in `test/places.test.ts`; `FsLocation` and `FsSearchRequest` carry `workspaceId`; `projectsInfo` reads only the workspaces some chat points at. Answers carry the folder's id and name, never the workspace's. A worktree's `.git` is a file and shows in `list`.
**Review findings, fixed:** `projectsInfo` ran git on every workspace row ever made; `FsService.search` ignored a `workspaceId` given directly; a `Place` handed to a service was trusted (`ownsPlace` now refuses a foreign one). Left: a worktree directory replaced by a symlink after creation becomes the root, as for a folder; the watcher of a removed worktree restarts with back-off until its clients leave.
**Commits:** `2b21049` feat(daemon): read and run in a chat's worktree through a workspaceId on the file system, terminals, documents and file names; `756d467` fix(daemon): refuse a place that is not the project's, read only the worktrees a chat points at, and pin the worktree cases the review named. Merged as `ffa3db7`.


## Stage 4 — Removing a worktree with its chat

**Depends on:** Stage 2.

**This stage:** a worktree Clowdy made does not have to pile up, and nothing is removed without the person saying so. The delete dialog of a chat asks whether the worktree and its branch go too, when that is safe: the daemon answers per chat whether it can be removed and `chat.delete` takes the choice. Archiving never touches a worktree.

- [x] Complete
  - [x] `GET /v1/chats/:id/workspace` answers `ChatWorkspaceRemoval { removable: boolean; path; branch? }`, `removable` only for a workspace that Clowdy made, that exists on disk, that no chat outside the chat and the threads below it points at (archived chats count), whose tree has nothing uncommitted (`git status --porcelain`, untracked included) and whose branch is an ancestor of the workspace's base ref (`merge-base --is-ancestor`, no fetch); a chat with no workspace is `removable: false`
  - [x] `chat.delete` takes `removeWorkspace?: boolean`: with it the daemon checks the same conditions again inside the delete (a refusal is `conflict` with the reason, and the chat stays), removes the worktree (`git worktree remove`, its empty parent folders pruned) and deletes the branch (`branch -D`, which is safe once it is an ancestor of the base); without it the worktree and the branch stay, and the workspace row is dropped only when no chat points at it any more (the worktree itself stays on disk, listed by git as any other)
  - [x] The delete dialog (`deleteChat`) reads the answer and, when `removable`, shows the checkbox in its message and sends the choice; a chat that never ran still deletes at once, since no worktree was made for it
  - [x] Tests: removable for a clean merged Clowdy-made worktree, not removable when dirty, unmerged, shared with another chat, made by someone else (an existing worktree), or already gone; the threads below the chat do not count as sharing; `removeWorkspace` removes the directory and the branch with the chat, and is refused when a condition fails in between; without it both stay; archiving changes nothing

**Files**

- `packages/protocol/src/api.ts` — `ChatWorkspaceRemoval`, `ROUTES.chatWorkspace`
- `packages/protocol/src/commands.ts` — `chat.delete`: `removeWorkspace`
- `apps/daemon/src/http/routes.ts` — the `workspace` route of a chat
- `apps/daemon/src/domain/workspaces.ts` — `workspaceRemoval`, `removeWorkspace`
- `apps/daemon/src/domain/chats.ts` — `deleteChat`: the choice, the row's drop
- `apps/daemon/src/commands/chat.ts` — `chat.delete` passes it on
- `apps/daemon/src/db/workspaces.ts` — the chats that use a workspace, the row's removal
- `apps/desktop/src/renderer/features/chats/deleteChat.ts` — the checkbox in the confirmation
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts` — `getChatWorkspaceRemoval`
- `apps/daemon/test/chat-workspaces.test.ts`, `chat-delete.test.ts`, `apps/desktop/src/renderer/features/chats/deleteChat.test.ts`
- `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md` — the removal rule and the dialog

**Done when:** deleting a chat whose clean, merged, Clowdy-made worktree nobody else uses offers `Also remove the worktree and its branch`, and with it ticked the directory and the branch are gone with the chat; a dirty, unmerged or shared one gets no checkbox and stays.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/chat-delete.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/features/chats src/renderer/daemon && bun run typecheck`
**Scope changes:** `chat.delete` has an async path only when `removeWorkspace` is set (`SometimesAsyncCommandType`, `waitsWhen`); the dialog is `deleteChat.tsx`; the tests are in `test/chat-workspace-removal.test.ts`; a worktree with an initialised submodule is not offered (git refuses it), `core.longpaths` is set on the removal and the status read, both the checked out HEAD and the row's branch must be contained in the base, and a base stored as a bare hash is never removable. A failed `git worktree remove` marks the row not ready and says to delete the folder by hand; the next turn refuses a dead folder. The Screen test of the delete confirmation now reads the message element's `text`.
**Review findings, fixed:** a failed removal left a dangling `.git` file and the next turn started inside it; a turn could start while the removal ran (the workspace is marked as being removed and the turn waits on the same lock). Left: ignored files (`.env`, build output) go with the tree and the dialog does not say so; the row of a worktree whose folder left the project is still leaked (Stage 2 behaviour).
**Commits:** `a049bb8` feat(daemon): remove a chat's worktree and its branch when the chat is deleted, if it is safe; `291a870` feat(desktop): offer to remove a chat's worktree and its branch in the delete confirmation; `b603d0a` fix(daemon): keep a turn out of a worktree that is being removed, and say what a failed removal left. Merged as `1c8de87`.


## Stage 5 — Settings of a folder's workspaces: base branch and setup

**Depends on:** Stage 2.

**This stage:** each folder of a project gets settings of its own for the worktrees made from it: the branch they start from and a setup that makes a new one ready to run. They belong to the project's row of the folder, since the folders of a project are different repositories. `Prepare workspace` copies the listed files and runs the command after the checkout, with the output in the same log, and the base branch settles the default of the draft's branch chip. The Folders block of Settings > Projects gets the dialog that edits them.

- [x] Complete
  - [x] Protocol: `FolderSettings { baseBranch?: string; setup?: WorkspaceSetup }`, `WorkspaceSetup { files: string[]; command?: string }`, `ProjectFolder.settings?`, and a command `project.updateFolder { projectId, folderId, settings }` (a field set to `null` is cleared) that answers `{ project }`; `files` are relative paths or a `*` in the last segment, none absolute or with `..`, at most 50; `command` at most 4000 characters; `invalid` otherwise, `not_found` for a folder the project does not have, `conflict` for the personal space
  - [x] Migration 24 (25 is the workspaces now): `project_folders.settings` (JSON); `toFolder` and `upsertProject` carry it, so a reorder, a rename of the project or an update of another folder keeps it
  - [x] `baseOf(folder)` (the sync twin `createWorkspace` needs is part of the rest below): the folder's `baseBranch` when the repository has it, else `defaultBranchOf`; the git endpoint's `defaultBranch` and the new worktree's base both use it
  - [x] `Prepare workspace` after the checkout copies each listed file that exists in the main checkout into the same relative place (an existing file in the worktree is left alone), then runs the command in the worktree with `CLOWDY_ROOT_PATH`, `CLOWDY_WORKSPACE_PATH` and `CLOWDY_BRANCH` set, its output in the log; a command that fails or runs over ten minutes (its process group is stopped) makes the step an error, `ready` stays false and the next message runs the step again
  - [x] Settings > Projects: each folder's row has a `Workspace` button (not in the personal space) that opens a dialog with `Base branch` (the detected default as its placeholder), `Files to copy` (one per line) and `Command`; Save sends `project.updateFolder`
  - [x] Tests: a copied `.env` and a `.env*` pattern, a command that writes a file and sees the three variables, a failing command and a timeout, settings kept through `project.update` (reorder, another folder), a configured base branch used and a missing one skipped, a project with no settings unchanged

**Files**

- `packages/protocol/src/domain.ts` — `ProjectFolder`: `settings`; `FolderSettings`, `WorkspaceSetup`
- `packages/protocol/src/commands.ts` — `project.updateFolder`
- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 25
- `apps/daemon/src/db/projects.ts` — `FolderRow`, `toFolder`, `upsertProject`: `settings`
- `apps/daemon/src/domain/projects.ts` — `updateProjectFolder`: the check and the save (`nextFolders` keeps a folder's settings with its id)
- `apps/daemon/src/commands/project.ts` — the `project.updateFolder` handler
- `apps/daemon/src/git/state.ts` — `baseOf`; `projectFolderGit` answers `defaultBranch` through it
- `apps/daemon/src/domain/workspaces.ts` — `createWorkspace` takes the base through `baseOf`; `prepareWorkspace`: the setup after the checkout
- `apps/desktop/src/renderer/features/settings/projects/ProjectFolders.tsx` — `renderActions`: the `Workspace` button
- `apps/desktop/src/renderer/features/settings/projects/FolderWorkspaceDialog.tsx` — create: the dialog; it cannot join `ProjectFolders.tsx`, which is the list, or `ProjectDefaults.tsx`, which is the choices of a new chat
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — `setFolderSettings`
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — `project.updateFolder`
- `apps/daemon/test/chat-workspaces.test.ts`, `projects.test.ts`, `git-state.test.ts`, `apps/desktop/src/renderer/features/settings/projects/ProjectsPage.test.tsx`
- `apps/desktop/AGENTS.md`, `apps/daemon/AGENTS.md`

**Done when:** a folder whose settings list `.env` and the command `touch ready` gives a chat whose new worktree has the `.env` copied and `ready` made, both in the `Prepare workspace` log, a folder with a base branch of its own starts its worktrees there, and the Workspace dialog of a folder edits the three fields.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/projects.test.ts test/git-state.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/features/settings src/renderer/daemon && bun run typecheck`
**Scope changes:** the schema holds shapes only and the daemon enforces the limits (`.git`, `..`, control marks and a leading dash are refused); the setup runs through `domain/workspaceSetup.ts` and `runLines`; `Timings.setupMs` and `PrepareOptions.setupTimeoutMs` carry the injectable ten-minute limit; the sync twin of `baseOf` for `chat.create` shares `pickBase` (`baseOfSync`); the setup runs again for a Clowdy-made worktree that is made again after it went from the disk (`ready` goes false first, so a failure is retried).
**Review findings, fixed:** a destination conflict or a source read error aborted the whole copy (now a log line); the log was written ten times a second (now once a second after five seconds, lines cut at 400 characters); a backtracking glob (now a linear matcher); two defaults for the timeout.
**Commits:** the settings half `5e7c4ba`, `a5585f9`, `46a75c6` (merged as `d577302`); the setup half `6b2d4b0` feat(daemon): set a new worktree up from its folder's settings, and start it from the folder's base branch, `0cf208e` fix(daemon): keep a setup's copy going past what the worktree already holds, and bound its log (merged as `b8b24e1`).

## Stage 6 — The chips and the Prepare workspace row

**Depends on:** Stages 1 and 2.

**This stage:** the person chooses where a chat works. The draft has the three chips (folder, mode, branch) with the lists decided above, the first message sends the choice, a started chat keeps the chips read only with the folder menu on a press, `Prepare workspace` is drawn as a tool row with its log, and a chat row in the Agents list shows it works in a worktree.

- [x] Complete
  - [x] `ProjectUi`: the draft's choice (`draftWorkspace`: checkout, new with a base, existing with a path), reset with the draft and kept with back and forward as `draftFolderId` is
  - [x] The mode chip: `Project checkout`, `New worktree`, `Existing worktree…` (the third opens the list: branch, the chats that use it, a changes marker), only for a repository; the branch chip as decided (read only label / `Branch from: <ref>` with search / none); the lists come from `getFolderGit`, read when the draft opens and when the window gets focus again
  - [x] The composer sends `workspace` with `chat.create`; the chips follow the folder chip when the folder changes, and the choice resets to Project checkout for a folder that is no repository
  - [x] The started chat's chips: folder, mode (`Project checkout` or `Worktree`) and the branch the tree has checked out now (`useFolderGit` reads the workspace's head from `projectsInfo` beside the folder's, again when the window gets focus), read only, the folder chip's menu opening on the worktree's path
  - [x] `toolView` draws the `workspace` tool as `Preparing workspace` / `Prepared workspace` with its log folded under it; its error shows the reason
  - [x] The Agents list's row shows a branch icon, with the branch in its title, for a chat that works in a worktree
  - [x] Tests, and a screenshot of the draft with each mode's menu and of a started worktree chat in the fixtures

**Files**

- `apps/desktop/src/renderer/stores/UiStore.ts` — `ProjectUi`: `draftWorkspace`
- `apps/desktop/src/renderer/features/agents/DraftChat.tsx` — the chips; `start.workspace`
- `apps/desktop/src/renderer/features/agents/WorkspaceChips.tsx` — create: the mode and branch chips and their menus; they cannot join `DraftFolderSelect.tsx`, which is the folder select and is used on its own for one-folder projects
- `apps/desktop/src/renderer/features/agents/ChatFolder.tsx` — the started chat's chips, the menu on the worktree path
- `apps/desktop/src/renderer/features/openWith/useFolderGit.ts` — `useFolderGit`: takes the chat's workspace and answers its head in place of the folder's
- `apps/desktop/src/renderer/features/agents/Screen.tsx` — the chips' props
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `start.workspace` in the `chat.create`
- `apps/desktop/src/renderer/stream/toolView.ts` — the `workspace` tool
- `apps/desktop/src/renderer/features/agents/AgentList.tsx` — the branch icon
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — `chat.create` keeps the workspace; a fixture chat in a worktree
- `apps/desktop/src/renderer/features/agents/ChatFolder.test.tsx`, `Screen.test.tsx`, `agentTree.test.ts`, `apps/desktop/src/renderer/stream/toolView.test.ts`, `UiStore.test.ts` — the cases
- `apps/desktop/AGENTS.md` — the chips, the draft's choice, the row's icon

**Done when:** in the fixtures page the draft's mode chip offers the three modes, `New worktree` shows `Branch from: origin/main` with a searchable list, the first message makes a chat whose chips are read only with the branch, and its stream starts with a `Prepare workspace` row that unfolds to its log.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/agents src/renderer/stream src/renderer/stores && bun run typecheck && bun run lint`, and a screenshot
**Scope changes:** the live branch needs Stage 3's `ProjectInfo.workspaces` from the daemon; until then a ready worktree chat shows no branch (the fixtures show it). The hand-off from a worktree chat now opens its draft in the same worktree (`openDraft`'s third argument; `503a1bd`) and a fork works in its source's worktree (the daemon since Stage 2, the fixtures since `503a1bd`). Left: the draft keeps its choice when its folder goes, checked against what it finds when it is sent.
**Commits:** `c27b60f`, `76b4933`, `b3127c8`, `6a72c04` (the last: shut the mode menu on Space, read the worktrees again once one is made, hold the first message while a choice waits for its read).


## Stage 7 — The side panel follows the chat's worktree

**Depends on:** Stages 3 and 6.

**This stage:** Files, Docs, Terminal and Cmd+K work in the place of the open chat. The place is the folder, or the folder with the chat's workspace, and every store that is keyed by a folder is keyed by the place, so a worktree has its own tabs, tree, documents and terminals, shared by the chats that share it.

- [x] Complete
  - [x] `currentFolder` becomes `currentPlace` (the folder, the workspace when the chat has a ready one); a chat whose workspace is not ready shows the tabs' empty state, not an error
  - [x] `FilesStore.managerOf` and the stored tabs' keys use the place (`clowdy:files:<project>:<folder or workspace id>`); `httpFileSystem` sends `workspaceId`; the Files and Docs tabs, the clipboard bridge's `folderPath`, `openInFiles` and `openDocument` follow
  - [x] The terminals are the place's (`TerminalsStore`, the tab, `openInTerminal` with the place)
  - [x] Cmd+K and the `@` mentions: the names come from `getProjectFiles(projectId, query, limit, workspaceId?)` and the tree of the worktree's file manager, the documents from `getDocsTree(projectId, workspaceId?)`, the text from the file manager, so all three list what the Files and Docs tabs show; the mention's path is the one the agent reads from its cwd
  - [x] The folder menu (`OpenWithMenu`) and Open in Terminal act on the worktree's path
  - [x] Tests for the keys and the place, and a screenshot of the Files tab over a worktree chat in the fixtures

**Files**

- `apps/desktop/src/renderer/features/sidePanel/currentFolder.ts` — `currentFolder` → `currentPlace`
- `apps/desktop/src/renderer/features/files/FilesStore.ts`, `FilesTab.tsx`, `useFilesStore.ts`, `openInFiles.ts`, `openDocument.ts` — the key, the manager
- `apps/desktop/src/renderer/daemon/httpFileSystem.ts`, `transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureFiles.ts`, `fixtureTerminals.ts` — `workspaceId`
- `apps/desktop/src/renderer/features/terminal/TerminalsStore.ts`, `TerminalTab.tsx`, `openInTerminal.ts` — the place
- `apps/desktop/src/renderer/features/quickSearch/quickSearchSource.ts`, `QuickSearch.tsx` — the place, the files and docs calls
- `apps/desktop/src/renderer/features/chats/useMentionTriggers.ts` — the `@` menu's file and document calls take the chat's workspace
- `apps/desktop/src/renderer/features/files/FilesStore.test.ts`, `openInFiles.test.ts`, `apps/desktop/src/renderer/features/terminal/TerminalsStore.test.ts`, `apps/desktop/src/renderer/features/quickSearch/*.test.ts`
- `apps/desktop/AGENTS.md` — the place, the keys

**Done when:** in the fixtures page a chat in a worktree shows that worktree's files in the Files tab, its plan in the Docs tab and a terminal in its path, and Cmd+K finds a file and a document that only the worktree has.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features && bun run typecheck && bun run lint`, and a screenshot
**Scope changes:** `currentFolder` became `currentPlace` (`Place = { folder, workspace? }`, `placeKey`, `isPlaceReady`) with `PlaceWaiting` for a worktree that is not made yet; terminal APIs keep `folderId` and take `workspaceId` as a trailing optional argument; `mentionItems` paths are relative to the chat's own folder (the daemon's `workingFolder`), absolute for other folders; the Info tab shows a Worktree row. The route docs in `packages/protocol` were written by Stage 3.
**Left, for a decision:** (done since: `FilesStore` keeps the managers of only the last three places, `MAX_OPEN_PLACES`, commit `a68493e`, so the watch streams are bounded; the owner dropped the `openDocument` fallback to the folder's own checkout as an invented problem, do not build it) the new-chat page with a worktree chosen lists the folder's own checkout in the Files tab and the `@` menu because no workspace row exists before the first message (an existing worktree has been solved since, see the follow-up at the end; a new one stays so); the palette captures its place when it opens.
**Commits:** `198a6fd` feat(desktop): make the side panel, the palette and the @ menu follow the open chat's worktree; `3c570f1` docs(desktop): describe the place the side panel, the palette and the mentions work in; `1405a14` refactor(desktop): tidy the place helpers and tell a worktree's missing document from a missing file. Merged as `d629a57`.


## Stage 8 — A thread with a worktree of its own

**Depends on:** Stage 2.

**This stage:** the way an orchestrator runs work in parallel without sharing a branch. `thread_spawn` and `clowdy thread spawn` take `worktree`, the daemon makes a workspace for the new thread from the parent's branch (the default branch when the parent has no worktree), and the thread's first turn prepares it as any chat does. A thread without it inherits as in Stage 2.

- [x] Complete
  - [x] `thread_spawn`: `worktree: boolean`, refused together with `cwd`; the thread's workspace is a new one on `clowdy/<thread-id8>` from the parent's branch
  - [x] The CLI flag `--worktree` and the thread skill's text say what it does and that merging the branch back is the parent's job, with git
  - [x] Tests: a thread with `worktree` runs in its own path on its own branch, one without runs in the parent's, `worktree` with `cwd` is refused

**Files**

- `apps/daemon/src/runs/thread-tools.ts` — `thread_spawn`
- `apps/daemon/src/runs/threads.ts` — `spawn`
- `apps/daemon/src/cli/clowdy.ts`, `apps/daemon/src/cli/args.ts` — the flag
- `packages/system-skills/skills/thread/SKILL.md` — the option
- `apps/daemon/test/threads.test.ts`, `cli.test.ts`, `cli-args.test.ts`
- `apps/daemon/AGENTS.md` — the option

**Done when:** a thread spawned with `worktree` has its own worktree on its own branch based on the parent's, and its agent's `cwd` is that path.
**Verify:** `cd apps/daemon && bun test test/threads.test.ts test/cli.test.ts test/cli-args.test.ts`
**Scope changes:** the base is the branch the parent's worktree has checked out now, read live (the recorded branch only when its path is gone); a parent whose worktree is not made yet gives its recorded base, and a detached HEAD or a branch the repository no longer has is refused; worktrees of one repository are added one at a time (`ensureWorktree`'s `serialize`: six parallel adds failed about 2% of the time with `commondir`); `sendMessage` puts the unsent first prompt in front of a message to a run that has no session yet (a failed Prepare no longer loses a thread's brief). The thread starts at the parent branch's tip when its first turn makes the worktree, not at spawn.
**Commits:** `ec72b6f` feat(daemon): let a thread have a git worktree of its own, started from its parent's branch; `336f3f1` docs(system-skills): teach threads and their parents the worktree option of thread spawn; `782a6b5` fix(daemon): base a thread's worktree on the parent's live branch, add worktrees one at a time and keep an unsent brief; `411b8f8` docs(system-skills): say where a worktree thread starts and that a shared worktree is not its own. Merged as `ac7a067`.


## Follow-up — The new-chat page's place when it chose an existing worktree

**Why:** Stage 7 left the page in the folder's own checkout until the chat exists, so the tree, the palette and `@` jumped to the worktree after the first message. The owner asked that an **existing** worktree, once chosen, be the page's place at once. A **new** worktree stays as it was: it has no row and no files until the first message makes it.

- [x] Complete
  - [x] `workspace.open { projectId, folderId?, path }` → `{ workspace }`: the row of a worktree `git worktree list` names (the checks and the sharing of `chat.create`'s existing branch, one code path: `openExistingWorkspace`), made if there is none; `chat.create` with the same path then gets the same `workspace.id`
  - [x] Rows nobody uses, not made by Clowdy and older than a day (`IDLE_WORKSPACE_MS`) are dropped by each `workspace.open`, so abandoned pages leave nothing for good
  - [x] `ProjectUi.draftWorkspaceRow`, set by `useDraftWorkspaceRow` (mounted by `DraftChat`), and `currentPlace` returns the worktree for the page when the row is the one the choice names; `Composer`'s `@` reads it as `start.workspaceRow`; the palette, the side panel tabs and the terminal already read `currentPlace`
  - [x] The fixture daemon answers `workspace.open`, and the places read its row
  - [x] A row goes with the last chat that points at it (`deleteChat`), so a page that holds a row some chat shared asks again once the chat is deleted (`useDraftWorkspaceRow`), and the page and its first message still share one row; the fixture daemon drops rows the same way
  - [x] Tests: protocol schema, daemon (shared row by path, same id after `chat.create`, the refusals, the sweep, repeated request), `UiStore`, `currentPlace`, the page's chips flow (incl. a stale answer and a refusal), `Composer`'s `@`, the fixture transport, and `features/files/draftPlace.test.ts` (the same file manager and tabs across the first message)

**Scope changes:** the command is protocol-level (a `Command` of the union), not a new HTTP route; an answer that fails (refused, daemon unreachable) is silent and leaves the folder's own checkout.
**Left, for a decision:** a page held open for more than a day with a worktree chosen loses its row (the next `workspace.open` of any page sweeps it): its places answer `not_found` until the page asks again (a new choice or reopening); a worktree git lists but that is not on disk is refused at the chat's creation as before; the page and the places match the row to the choice by `samePath`, so a workspaces folder under a symlink (the row records `join(workspacesDir, …)`, git lists the real path) leaves the page in the folder's own checkout, as `chatsUsing` already does for the list of users; a repeated `workspace.open` does not renew a row's age; `workspace.open` reads git synchronously as `chat.create` does.
**Commits:** `e16040f` feat(daemon): answer the row of an existing worktree before a chat works there with workspace.open; `b749b16` feat(desktop): answer workspace.open in the fixture daemon; `93febd8` feat(desktop): show the worktree a new chat chose in the side panel, the palette and the @ list before the chat exists; and a docs commit for `AGENTS.md` and this section.


## Follow-up — The mode chip and the branch chip become one control

**Why:** the owner found two chips (mode, branch) ugly, read only above all. One control in the new-chat page and one label in a started chat replace them (this supersedes the three-chip line of the decisions and of Stage 6; the behaviour of the choices is unchanged).

- [x] Complete
  - [x] Read only (`WorkspaceLabel`, used by `ChatFolder`): the git mark and the branch, `Worktree` in a dimmer tone before the branch for a chat in a worktree (its path on hover); no word for the folder's own checkout
  - [x] New-chat page (`WorkspaceChips`): one `ChipTrigger` (new dim `lead`/`trail`) and one menu: `Current checkout` (branch at the end), `New worktree` with its base as a button at the end of the row (opens the branch list; the row chooses; the right arrow on the row does the same as the base), a separator when there are other worktrees, then one row per worktree (branch, users, `Changes`); the check at the start of the row
  - [x] Nothing for a folder that is no repository or whose read is on its way; a dim `Project checkout` with the reason on hover when git could not be asked
  - [x] Tests rewritten (`WorkspaceChips`, `ChatFolder`, `Screen`), `apps/desktop/AGENTS.md` updated

**Scope changes:** react-aria's menu row takes the release of a press that began on the base button as its own press, so the row's action checks a `baseHeld` flag the button sets and opens the list in place of choosing; a worktree chat whose branch is not known yet shows `Worktree` alone; the dim `Project checkout` of a failed read has no git mark.
**Commits:** `4fe71a9` feat(desktop): merge the mode and branch chips of where a chat works into one control; `fb4fa98` docs: describe the one control of where a chat works; `434c2d8` fix(desktop): keep the detached HEAD cue in the one control of a chat's place, drop dead code and level the menu rows (the review's fixes: the pill and the label say a detached HEAD again, the dead `modeOf` is gone, the menu rows are one height).


## Follow-up — The menu of the one control, as the owner reworked it

**Why:** the owner found the compact rows squeezed and the extra pieces noisy once they used the control with dozens of agent-made worktrees.

- [x] Complete
  - [x] The folder's own checkout is named `Main worktree` in the control (menu row, label, aria text, hover); the three places to work in are rows of two lines (an icon, the name, what it is), with no check marks: the selected row is the one the menu highlights
  - [x] `New worktree` stays a row that chooses; the base at its end opens the searchable branch list **beside** the menu, which stays open under it (a child of the menu's popover; `shouldCloseOnInteractOutside` + cleared popover contexts), and a pick shuts both
  - [x] `Existing worktree` is a plain submenu (no default to choose): flat rows, no icon, no `Changes` mark; the worktrees a chat works in first, the ones none works in after them under `Not in use`
  - [x] The branch list is in two groups, `Local` and `Remote` (no headings with one kind)
  - [x] Tests rewritten; checked with a real mouse, touch and keys in Electron (menu stays open under the list, Escape closes the list alone, a pick shuts both)

**Left, for a decision:** the owner would rather see only local branches and have Clowdy fetch and fast-forward by itself. That needs the daemon to resolve a local base name to its remote counterpart when the local branch is equal to it, behind it or missing (fetched first), and the local branch only when it is ahead or diverged, which is the rule the git-integration plan already names for comparisons; the default would then read `main`, not `origin/main`. Until then both kinds are listed, grouped.
**Commits:** `c5e597c` feat(desktop): name the folder's own checkout Main worktree and give the first two menu rows their descriptions back; `1c284fd` feat(desktop): fly the branches of a new worktree out beside the menu and make Existing worktree a submenu; `163a720` feat(desktop): give the menu of a chat's place icons and no checks, group the branches and the worktrees, and drop the Changes mark.

## Follow-up — a thread's worktree: its base and its name

- `clowdy thread spawn --worktree` takes `--base <branch>` and `--branch <name>`. The default base is the branch the parent has checked out now, in its worktree or in the folder's own checkout (a parent on `feature-x` in the project's folder used to give the thread a branch of `main`); on a detached HEAD, the default branch. The branch is `clowdy/<name>`, the name from `--branch`, else made of `--title` (ASCII words, `-xxxx` of the id on a clash, the id8 for a title with none, which Russian titles are), and is refused when taken.
- The folder is still named by the id8 and is never renamed: agents keep sessions by folder, and `claude-agent-acp` says a resume under another `cwd` can fail with `-32002`. `ownsWorktree` reads the folder, not the branch. Looked at in bb (`update_environment_directory`): it moves a thread to another directory for the *next* turn (the agent ends its turn, bb starts the next one there with a system message) and does not deal with that session problem; not taken.
- Not done: a pretty branch name for a chat the person starts (the id8 stays). The idea is a `clowdy worktree name <words>` the agent runs once, which does `git branch -m` (it works while the worktree is checked out, and moves no folder); it needs the record's `branch` kept in step, since a chat's removal reads it.
- The review of this slice found, and it was fixed: a branch below the new name (`clowdy/fix/login` against `clowdy/fix`) and a pending row above or below it blocked the first turn's `worktree add` after spawn had answered, so `branchTaken` looks at both; device names Windows keeps (`con`) are not branch names; an empty `base` or `branch` is read as left out; the skills (`orchestrate`) and tool texts said the old default base. Not done: two projects over one repository can pick the same name before either first turn, and a branch someone makes by hand between spawn and the first turn is taken as it is by `ensureWorktree`.
