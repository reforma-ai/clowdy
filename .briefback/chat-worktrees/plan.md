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
- Under the message box there are three chips: folder, mode, branch. The mode menu is one list: `Project checkout`, `New worktree`, `Existing worktree…` (bb's separate Reuse item is dropped). The branch chip depends on the mode: Project checkout shows the checked out branch, read only; New worktree shows `Branch from: <ref>` with a searchable list of branches; Existing worktree has no branch chip, the worktree's own branch is its label. After the first message the same chips stay, read only, and a press opens the folder's menu (`OpenWithMenu`: Open in Finder, the editor, copy path), which for a worktree chat acts on the worktree.
- The base of a new worktree is the folder's default branch: `origin/HEAD` (`main`, `master`, `next`…), else `origin/main` or `origin/master`, else a local `main` or `master`, else the current HEAD. A remote ref is fetched first; a failed fetch is not fatal when the ref was fetched before, and the log says it uses the last fetched one. A per-folder setting for the base (an input in the folder's git settings) comes later, in the one function that resolves the base.
- Branch changes in Project checkout (New branch, Checkout) are not offered: changing the branch of a checkout other chats work in is the person's or the agent's own git. Whoever wants another branch takes a worktree.
- Several chats may work in one worktree, with no block and no warning: the owner runs several agents in one branch at once, each committing after every change. The list of existing worktrees says which chats use each (information only).
- Existing worktrees are what `git worktree list --porcelain` says for the chat's folder (agents' own worktrees and hand-made ones too), not a registry of Clowdy's. Clowdy removes only the worktrees it made (under `workspacesDir`), never one it merely found.
- A worktree is made as the first step of the chat's first turn: a tool item of the chat's stream, `Prepare workspace`, running while it fetches and checks out, its log (git's own lines) inside, an error if it fails. A failure fails the turn with that reason, and the next message tries again. The step makes the worktree again whenever a Clowdy-made one is missing (a branch that exists is checked out as it is, a new one is made from the base).
- The chat's cwd for every turn is the worktree. The chat's own main checkout is left out of the agent's additional folders and the system prompt names the worktree, its branch and the main checkout, so an agent does not wander back into it. The project's other folders reach the agent as before.
- A thread works in its parent's workspace by default; an own worktree only on request (`clowdy thread spawn --worktree`), branched from the parent's branch. A fork of a chat shares its workspace, since an agent keeps its sessions by working directory and the fork resumes a copy of the session.
- Files, Docs, Terminal and Cmd+K follow the chat's place. Documents and files are the worktree's (a plan an agent wrote there is not in the main checkout, so only the worktree has it); a project-wide search or `@` mention lists the main checkouts only and never a sibling worktree of the same repository.
- Releasing: archiving or deleting a chat removes a Clowdy-made worktree when no other chat that is not archived uses it and the tree has no uncommitted or untracked changes; otherwise it stays and the chat keeps it. The branch is kept (commits are never lost, and a later message to the chat makes the worktree again from it), and deleting the chat deletes the branch only when it is contained in its base.
- Setup runs inside Prepare workspace: files listed in the project's settings are copied from the main checkout when they exist there (`.env` files), then one command runs in the worktree (`bun install`), its output in the log.
- A folder that is not a git repository (the personal space, any plain folder) has no worktree mode: the mode chip offers Project checkout only.
- Getting the work back to the base branch is git's and the agent's; the app shows the branch and whether an existing worktree has changes, with no merge button.
- UI text without a closing period, as `AGENTS.md` asks.

**Defaults I took** (the owner may change them)

- Setup is a project setting, not a folder setting: a folder has no settings of its own (`ProjectFolder` is `{ id, path }`, rewritten by `upsertProject`), so the per-folder base branch and the per-folder setup come together later.
- The release rule is weaker than "clean and merged", which was floated: the branch is kept, so an unmerged but clean worktree loses nothing by being removed (only ignored files, which Setup makes again).
- The branch chip of a started chat shows the branch the workspace was made with (`ChatWorkspace.branch`), not a live read: a worktree whose branch the agent switched shows the old name until a read is added.
- The id of a workspace is `wks_…` (a new `IdPrefix`); `<project-slug>` is the project's name in kebab case at the time of the first worktree and is stored in the row's path, so renaming the project moves nothing.

**Reuse:** `git`, `gitLine` (`apps/daemon/src/domain/git.ts`); `folderHead`, `projectsInfo` (`apps/daemon/src/domain/projects.ts`); `createChat`, `saveChat`, `setChatArchived`, `deleteChat` (`apps/daemon/src/domain/chats.ts`); `appendItem`, `updateItem` (`apps/daemon/src/domain/items.ts`); `workingFolder`, `additionalFolders`, `surroundings` (`apps/daemon/src/runs/driver.ts`); `prepareFork` (`apps/daemon/src/runs/fork.ts`); `folderNames`, `mainFolder` (`packages/protocol/src/domain.ts`); `DraftFolderSelect`, `FolderTrigger`, `ChatFolder`, `OpenWithMenu`, `useFolderGit` (desktop); `FilesStore`, `docsScopeOf`.

## Out of scope

- Switching or creating a branch in Project checkout.
- A per-folder git setting (base branch input) and a per-folder setup; a project default for "new chats start in a worktree".
- A merge, a pull request or ahead and behind in the app; managing worktrees that agents made (they are listed and can be picked, never removed).
- One tree with all the folders of a project (VS Code's), and a folder switcher in the side panel's tabs.
- A worktree for the project's other folders (only the chat's own folder gets one; the rest reach the agent as additional folders).
- `@` suggestions of a file that exists only in a worktree (the project's list reads the main checkouts).
- A live read of the branch of a worktree after it was made; Windows (paths are short and `core.longpaths` is not set, nothing was run there).

## Stage 1 — What git says about a folder

**Depends on:** None.

**This stage:** the daemon learns to read a folder's branches and worktrees, and says so over one endpoint, which the draft's chips and `chat.create`'s checks use. The default-branch rule lives in one function. Nothing is created or removed yet.

- [ ] Complete
  - [ ] `GET /v1/projects/:id/git?folderId=` answers `{ isRepository, branch, detached?, defaultBranch?, branches: [{ name, remote }], worktrees: [{ path, branch?, head, main, dirty }] }` (the checked out branch of the folder, its branches local and remote without `origin/HEAD`, and `git worktree list --porcelain`, the folder's own checkout flagged `main`, `dirty` from `git status --porcelain`); a folder that is not a repository answers `isRepository: false` and nothing else
  - [ ] `defaultBranchOf(folder)`: `origin/HEAD`, else `origin/main`, `origin/master`, else local `main`, `master`, else the current HEAD; no network
  - [ ] Reads do not hold the daemon up (the async `gitLine` style, with its timeout), and a folder gone from the disk is `unavailable`
  - [ ] Protocol types and the app's transport method (`getFolderGit`), with the fixture transport answering a repository with branches and two worktrees
  - [ ] Tests on real repositories in a temp folder, with a bare `origin` for the remote refs and `origin/HEAD`

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
**Commits:** None yet.

## Stage 2 — A chat's workspace in the daemon

**Depends on:** Stage 1.

**This stage:** a chat gets a workspace and its turns run there. `chat.create` takes the choice (a new worktree from a base, or an existing worktree), the daemon records the workspace row and points the chat at it, and the chat's first turn makes the worktree as the `Prepare workspace` item before the agent's session opens. Threads and forks share their parent's workspace. This is the decision-heavy stage: the layout of `workspacesDir`, the branch name, that a missing Clowdy-made worktree is made again, and what the agent is told.

- [ ] Complete
  - [ ] Protocol: `ChatWorkspace { id, path, branch?, managed, ready }`, `Chat.workspace?`, `chat.create.workspace?: { mode: 'new', base?: string } | { mode: 'existing', path: string }`, a `wks` id prefix
  - [ ] Migration 24: `workspaces` (id, project_id, folder_id, path, branch, base, managed, created_at) and `chats.workspace_id`, with no foreign keys (a project update rewrites the folder rows); `toChat` embeds the workspace, so it is published with the chat
  - [ ] `workspacesDir` in the config; `domain/workspaces.ts` makes the row and the path `<workspacesDir>/<project-slug>/<chat-id8>/<folder-name>` and the branch `clowdy/<chat-id8>`
  - [ ] `chat.create` with a workspace: `invalid` for a folder that is not a repository, a base that is not a ref of it, an existing path that `git worktree list` of the folder does not name, and for a workspace with `chat.folderId` of another folder
  - [ ] The first turn (and any later turn while the Clowdy-made worktree is missing) runs `Prepare workspace`: a `tool` item of the orchestrator run (`name: 'workspace'`) with the git lines as its output as they arrive, `fetch` of a remote base (a failure with the ref fetched before is a log line, not an error), `git worktree add` (`-b` from the base, or the existing branch as it is), `ready` set and published; a failure ends the turn with the reason and leaves the next message to try again
  - [ ] `workingFolder` returns the workspace path; `additionalFolders` leaves out the chat's own folder when it works in a workspace; the system prompt names the worktree, its branch and the main checkout
  - [ ] A thread takes its parent's workspace (`threads.ts`), a fork its source's (`fork.ts`); the same row, not a copy
  - [ ] Daemon tests with the fake engine reporting its `cwd`, on real repositories

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
**Commits:** None yet.

## Stage 3 — Places: the file system, terminals and documents in a worktree

**Depends on:** Stage 2.

**This stage:** every request that names a folder to read or run something in may also name a workspace of that folder, and the daemon uses the worktree in place of the main checkout. One resolver judges it (the workspace has to belong to the folder and the project), so no request can reach a path the project does not own.

- [ ] Complete
  - [ ] `placeOf(store, project, folderId, workspaceId?)` gives the folder and the root to read, `unavailable` while the workspace is not made (`ready` false) or gone from the disk
  - [ ] The file system routes (list, find, read, write, make folder, move, copy, delete, watch, search) take `workspaceId` (query, or body for the posts) and use `placeOf`; the watch of a worktree is its own
  - [ ] A terminal made with a `workspaceId` starts in the worktree; `TerminalInfo` carries it, and a project's list of terminals tells them apart by place
  - [ ] `GET /v1/projects/:id/docs?workspaceId=` lists the document sources of that worktree for its folder, the other folders as before
  - [ ] Tests: a worktree's file read and written, a workspace of another folder or project refused, a terminal's cwd, the docs of a worktree having a plan the main checkout lacks

**Files**

- `apps/daemon/src/domain/workspaces.ts` — `placeOf`
- `apps/daemon/src/fs/service.ts` — `folderOf`, `open` (and the methods that pass the folder on)
- `apps/daemon/src/http/fs-routes.ts` — `place`, `moveBody`, `copyBody`, `deleteBody`, `searchBody`, `location`
- `apps/daemon/src/terminals/service.ts`, `apps/daemon/src/http/terminals.ts` — the create request
- `apps/daemon/src/docs/tree.ts`, `apps/daemon/src/http/routes.ts` — `docsTree`, the `docs` route
- `packages/protocol/src/api.ts` — `TerminalCreate`, `TerminalInfo`: `workspaceId`
- `apps/daemon/test/fs-service.test.ts`, `fs-http.test.ts`, `terminals.test.ts`, `docs.test.ts` — the worktree cases
- `apps/daemon/AGENTS.md` — the places and the line "no per-chat or per-worktree terminal" updated

**Done when:** over HTTP, the same `folderId` with a `workspaceId` lists, reads and writes the worktree's files, opens a terminal in it and lists its documents, and with another folder's workspace answers `not_found`.
**Verify:** `cd apps/daemon && bun test test/fs-service.test.ts test/fs-http.test.ts test/terminals.test.ts test/docs.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`
**Commits:** None yet.

## Stage 4 — Releasing a worktree

**Depends on:** Stage 2.

**This stage:** a worktree Clowdy made does not pile up. Archiving or deleting a chat releases its workspace: the checkout is removed when it is safe (no other live chat uses it, nothing uncommitted), and the branch is deleted with the chat when it is merged. A message to an archived chat makes the worktree again, which Stage 2's step already does.

- [ ] Complete
  - [ ] `releaseWorkspace(store, workspaceId)`: a managed workspace with no other chat that is not archived, a clean tree (`git status --porcelain` empty, untracked included) is removed with `git worktree remove` and its directories pruned, then `ready` is false; a dirty, shared or unmanaged workspace is left as it is and the chat keeps it
  - [ ] Archiving calls it; deleting calls it and then removes the workspace row when no chat points at it, and deletes the branch (`branch -D`) only when it is an ancestor of the row's base
  - [ ] A chat that is un-archived by a message gets its worktree back (Stage 2's Prepare, on the kept branch) with the item in its stream
  - [ ] Tests: removed when clean, kept when dirty, kept while another chat uses it, kept when unmanaged, the branch kept on archive, deleted with an archived-and-merged chat, a message to the archived chat making it again

**Files**

- `apps/daemon/src/domain/workspaces.ts` — `releaseWorkspace`
- `apps/daemon/src/domain/chats.ts` — `setChatArchived`, `deleteChat`
- `apps/daemon/src/db/workspaces.ts` — the users of a workspace, the row's removal
- `apps/daemon/test/chat-workspaces.test.ts`, `chat-archive.test.ts`, `chat-delete.test.ts` — the release cases
- `apps/daemon/AGENTS.md` — the release rule

**Done when:** archiving the only chat of a clean Clowdy-made worktree removes its directory and keeps its branch, a message to that chat makes the directory again, and deleting a chat whose branch is merged removes the branch too; a dirty or shared worktree stays.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/chat-archive.test.ts test/chat-delete.test.ts`
**Commits:** None yet.

## Stage 5 — Setup of a new worktree

**Depends on:** Stage 2.

**This stage:** a new worktree is made ready to run. The project's settings list files to copy from the main checkout and one command to run in the worktree, and `Prepare workspace` does both after the checkout, its output in the same log. The settings page gets the two fields.

- [ ] Complete
  - [ ] `ProjectSettings.workspaceSetup?: { files: string[]; command?: string }`, validated by `project.update` (relative paths without `..`, glob-free names or simple `*` patterns, a command up to a line)
  - [ ] `Prepare workspace` copies each listed file that exists in the main checkout (and is not tracked by the worktree already) into the same relative place, then runs the command in the worktree with the project's environment; a failing command makes the step an error, with its output in the log, and the next message runs only what is missing (the worktree exists, so only the setup runs again)
  - [ ] Settings > Projects: a Workspace setup block on a project's page, `Files to copy` (one per line) and `Command`, kept through `project.update`
  - [ ] Tests: a copied `.env`, a command that writes a file, a failing command, and a project with no setup unchanged

**Files**

- `packages/protocol/src/domain.ts` — `ProjectSettings`: `workspaceSetup`
- `packages/protocol/src/commands.ts` — `project.update`: the `settings` schema takes `workspaceSetup` (`null` clears it)
- `apps/daemon/src/domain/projects.ts` — `updateProject`: the check
- `apps/daemon/src/domain/workspaces.ts` — `prepareWorkspace`: the setup after the checkout
- `apps/desktop/src/renderer/features/settings/projects/ProjectDetail.tsx` — draws the block
- `apps/desktop/src/renderer/features/settings/projects/WorkspaceSetup.tsx` — create: the two fields; they cannot join `ProjectDefaults.tsx`, which is the choices of a new chat
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — `setProjectDefaults`: takes `workspaceSetup` too
- `apps/daemon/test/chat-workspaces.test.ts`, `projects.test.ts`, `apps/desktop/src/renderer/features/settings/projects/ProjectsPage.test.tsx`
- `apps/desktop/AGENTS.md`, `apps/daemon/AGENTS.md`

**Done when:** a project with `.env` listed and the command `touch ready` gives a chat whose new worktree has the `.env` copied and `ready` made, both in the `Prepare workspace` log, and the settings page edits the two fields.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/projects.test.ts`, `cd apps/desktop && bunx vitest run src/renderer/features/settings && bun run typecheck`
**Commits:** None yet.

## Stage 6 — The chips and the Prepare workspace row

**Depends on:** Stages 1 and 2.

**This stage:** the person chooses where a chat works. The draft has the three chips (folder, mode, branch) with the lists decided above, the first message sends the choice, a started chat keeps the chips read only with the folder menu on a press, `Prepare workspace` is drawn as a tool row with its log, and a chat row in the Agents list shows it works in a worktree.

- [ ] Complete
  - [ ] `ProjectUi`: the draft's choice (`draftWorkspace`: checkout, new with a base, existing with a path), reset with the draft and kept with back and forward as `draftFolderId` is
  - [ ] The mode chip: `Project checkout`, `New worktree`, `Existing worktree…` (the third opens the list: branch, the chats that use it, a changes marker), only for a repository; the branch chip as decided (read only label / `Branch from: <ref>` with search / none); the lists come from `getFolderGit`, read when the draft opens and when the window gets focus again
  - [ ] The composer sends `workspace` with `chat.create`; the chips follow the folder chip when the folder changes, and the choice resets to Project checkout for a folder that is no repository
  - [ ] The started chat's chips: folder, mode (`Project checkout` or `Worktree`) and the recorded branch, read only, the folder chip's menu opening on the worktree's path
  - [ ] `toolView` draws the `workspace` tool as `Preparing workspace` / `Prepared workspace` with its log folded under it; its error shows the reason
  - [ ] The Agents list's row shows a branch icon, with the branch in its title, for a chat that works in a worktree
  - [ ] Tests, and a screenshot of the draft with each mode's menu and of a started worktree chat in the fixtures

**Files**

- `apps/desktop/src/renderer/stores/UiStore.ts` — `ProjectUi`: `draftWorkspace`
- `apps/desktop/src/renderer/features/agents/DraftChat.tsx` — the chips; `start.workspace`
- `apps/desktop/src/renderer/features/agents/WorkspaceChips.tsx` — create: the mode and branch chips and their menus; they cannot join `DraftFolderSelect.tsx`, which is the folder select and is used on its own for one-folder projects
- `apps/desktop/src/renderer/features/agents/ChatFolder.tsx` — the started chat's chips, the menu on the worktree path
- `apps/desktop/src/renderer/features/agents/Screen.tsx` — the chips' props
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `start.workspace` in the `chat.create`
- `apps/desktop/src/renderer/stream/toolView.ts` — the `workspace` tool
- `apps/desktop/src/renderer/features/agents/AgentList.tsx` — the branch icon
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — `chat.create` keeps the workspace; a fixture chat in a worktree
- `apps/desktop/src/renderer/features/agents/ChatFolder.test.tsx`, `Screen.test.tsx`, `agentTree.test.ts`, `apps/desktop/src/renderer/stream/toolView.test.ts`, `UiStore.test.ts` — the cases
- `apps/desktop/AGENTS.md` — the chips, the draft's choice, the row's icon

**Done when:** in the fixtures page the draft's mode chip offers the three modes, `New worktree` shows `Branch from: origin/main` with a searchable list, the first message makes a chat whose chips are read only with the branch, and its stream starts with a `Prepare workspace` row that unfolds to its log.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/agents src/renderer/stream src/renderer/stores && bun run typecheck && bun run lint`, and a screenshot
**Commits:** None yet.

## Stage 7 — The side panel follows the chat's worktree

**Depends on:** Stages 3 and 6.

**This stage:** Files, Docs, Terminal and Cmd+K work in the place of the open chat. The place is the folder, or the folder with the chat's workspace, and every store that is keyed by a folder is keyed by the place, so a worktree has its own tabs, tree, documents and terminals, shared by the chats that share it.

- [ ] Complete
  - [ ] `currentFolder` becomes `currentPlace` (the folder, the workspace when the chat has a ready one); a chat whose workspace is not ready shows the tabs' empty state, not an error
  - [ ] `FilesStore.managerOf` and the stored tabs' keys use the place (`clowdy:files:<project>:<folder or workspace id>`); `httpFileSystem` sends `workspaceId`; the Files and Docs tabs, the clipboard bridge's `folderPath`, `openInFiles` and `openDocument` follow
  - [ ] The terminals are the place's (`TerminalsStore`, the tab, `openInTerminal` with the place)
  - [ ] Cmd+K: the names and the text of the worktree through its file manager, the documents through `getDocsTree(projectId, workspaceId?)`; the project-wide list (`getProjectFiles`) stays the main checkouts', and the merge with the tree keeps a file only the worktree has
  - [ ] The folder menu (`OpenWithMenu`) and Open in Terminal act on the worktree's path
  - [ ] Tests for the keys and the place, and a screenshot of the Files tab over a worktree chat in the fixtures

**Files**

- `apps/desktop/src/renderer/features/sidePanel/currentFolder.ts` — `currentFolder` → `currentPlace`
- `apps/desktop/src/renderer/features/files/FilesStore.ts`, `FilesTab.tsx`, `useFilesStore.ts`, `openInFiles.ts`, `openDocument.ts` — the key, the manager
- `apps/desktop/src/renderer/daemon/httpFileSystem.ts`, `transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureFiles.ts`, `fixtureTerminals.ts` — `workspaceId`
- `apps/desktop/src/renderer/features/terminal/TerminalsStore.ts`, `TerminalTab.tsx`, `openInTerminal.ts` — the place
- `apps/desktop/src/renderer/features/quickSearch/quickSearchSource.ts`, `QuickSearch.tsx` — the place and the docs call
- `apps/desktop/src/renderer/features/files/FilesStore.test.ts`, `openInFiles.test.ts`, `apps/desktop/src/renderer/features/terminal/TerminalsStore.test.ts`, `apps/desktop/src/renderer/features/quickSearch/*.test.ts`
- `apps/desktop/AGENTS.md` — the place, the keys

**Done when:** in the fixtures page a chat in a worktree shows that worktree's files in the Files tab, its plan in the Docs tab and a terminal in its path, and Cmd+K finds a file and a document that only the worktree has.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features && bun run typecheck && bun run lint`, and a screenshot
**Commits:** None yet.

## Stage 8 — A thread with a worktree of its own

**Depends on:** Stage 2.

**This stage:** the way an orchestrator runs work in parallel without sharing a branch. `thread_spawn` and `clowdy thread spawn` take `worktree`, the daemon makes a workspace for the new thread from the parent's branch (the default branch when the parent has no worktree), and the thread's first turn prepares it as any chat does. A thread without it inherits as in Stage 2.

- [ ] Complete
  - [ ] `thread_spawn`: `worktree: boolean`, refused together with `cwd`; the thread's workspace is a new one on `clowdy/<thread-id8>` from the parent's branch
  - [ ] The CLI flag `--worktree` and the thread skill's text say what it does and that merging the branch back is the parent's job, with git
  - [ ] Tests: a thread with `worktree` runs in its own path on its own branch, one without runs in the parent's, `worktree` with `cwd` is refused

**Files**

- `apps/daemon/src/runs/thread-tools.ts` — `thread_spawn`
- `apps/daemon/src/runs/threads.ts` — `spawn`
- `apps/daemon/src/cli/clowdy.ts`, `apps/daemon/src/cli/args.ts` — the flag
- `packages/system-skills/skills/thread/SKILL.md` — the option
- `apps/daemon/test/threads.test.ts`, `cli.test.ts`, `cli-args.test.ts`
- `apps/daemon/AGENTS.md` — the option

**Done when:** a thread spawned with `worktree` has its own worktree on its own branch based on the parent's, and its agent's `cwd` is that path.
**Verify:** `cd apps/daemon && bun test test/threads.test.ts test/cli.test.ts test/cli-args.test.ts`
**Commits:** None yet.
