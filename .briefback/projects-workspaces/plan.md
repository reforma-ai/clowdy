# Projects as workspaces of several folders

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a project is a workspace of one or more folders, so work that spans several repositories (or folders that are not repositories at all) lives in one project with one set of chats, tasks and docs.

**Approach:** `Project.path` becomes an ordered list of folders with stable ids; the first is the main folder and stays the agent's working directory, the others reach the agent as ACP `additionalDirectories` (or as absolute paths in the system prompt for agents that do not advertise them). The daemon owns the list: one `project.add` command replaces create and open, `project.update` takes the whole folder list, docs, file search and project skills work per folder. The renderer gets one Add project form, a Folders block on the project's settings page, a docs tree grouped by folder, and `@` mentions across folders.

**Decisions**

- A project is an ordered list of folders: `Project.folders: ProjectFolder[]` (`{ id, path }`) replaces `Project.path`. A migration moves each project's current path into the list as its first folder. No compatibility with the old shape.
- The first folder is the main one: the agent's working directory, whose `CLAUDE.md`, `AGENTS.md` and agent settings the agent reads as its own. The other folders go to the agent as ACP `additionalDirectories` when it advertises `sessionCapabilities.additionalDirectories`, otherwise as absolute paths in the system prompt. The system prompt lists every folder of the project and marks the main one.
- Any existing folder can be added. Git is neither required nor touched: the repository-root rule (`requireRepositoryRoot`) goes away.
- A folder can belong to any number of projects. Adding a project with exactly the same set of folders (order does not matter) as an existing one opens that project and says so in a toast (`Opened <name>, it has the same folders`).
- Within one project a folder cannot appear twice or inside another of its folders. A project has at least one folder. `project.update` refuses to give a project exactly the set of folders another project has (`conflict`), so the same-set answer of `project.add` stays unambiguous (found in the Stage 2 review).
- The personal space stays one folder: no folders can be added to it.
- Adding or removing a folder other than the main one is allowed at any time and takes effect from the agent's next turn; the session continues (ACP lets the list change on resume while the working directory stays).
- Changing the main folder (removing it, or dragging another folder to the top) behaves as Change folder does today: refused while the project has unfinished runs, and the agent starts a new session when it cannot resume from the new folder.
- Without its main folder a project cannot work, as today. A missing additional folder is left out of the agent's folders and shown with a warning.
- One Add project… action replaces Create project and Open existing project… in the project select, on Settings > Projects and on the no-project screen. It always opens a form, even for one folder: a name (filled with the main folder's name until the person edits it), the folder list (the first marked Main, drag to reorder, remove per folder) and Add folders…, which opens the system picker with several folders selectable and can be pressed any number of times. In a plain browser a path field replaces the picker.
- Add project with no folders makes a new folder `<projectsDir>/<kebab-name>` and runs `git init` in it, as Create project does today; a hint under the empty list says so (`A new folder is made when none is added`).
- One protocol command, `project.add`, replaces `project.create` and `project.open`.
- On a project's settings page the Folder block becomes Folders: the list with the Main mark, drag to reorder, Add folders…, Remove per folder, and per folder its missing warning and its git remote.
- The project select shows the main folder's path under the project name, followed by `+N` when there are more folders.
- `@` searches files in every folder. A file of the main folder reaches the agent as a relative path, a file of another folder as an absolute path; the suggestion shows it as `<folder name>/<path>`.
- Project skills are collected from every folder of the project.
- Every folder has its own `.clowdy/docs`. With one folder the docs tree looks as today; with several its top level is the folders, main first, each shown even when it has no docs yet so a document can be created there.
- `.clowdy/docs` is created only on the first write into that folder (a new document from the app, or a file from the agent), never just because the tree was opened.
- A new document made in the app goes to the folder of the tree it was made under. An agent puts a document about one folder into that folder's `.clowdy/docs` and a document about several folders or the whole project into the main folder's: the system prompt and the `clowdy:docs` system skill say so.
- Claude runs with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. The system prompt tells every agent that each folder may have its own `AGENTS.md` or `CLAUDE.md` to read before changing files there.
- The first step is research into each agent's options: whether Codex reads `AGENTS.md` from additional folders, whether Cursor lets the agent work outside its working directory, and how OpenCode, Gemini, Copilot, Grok, omp and Hermes handle additional folders (`research/index.md`).
- Every agent stays selectable in a project of several folders. An agent that does not advertise `sessionCapabilities.additionalDirectories` gets the folders through the system prompt only; all of them reach absolute paths. The launch flags some of them have (Gemini `--include-directories`, Copilot `--add-dir`, omp `--add-dir`) and a note in the agent picker wait until someone can verify them on a machine that has those agents. (Taken by the agent while the person was away, on their instruction to finish the work: the research's recommendation minus the parts nobody can test here.)

**Facts this plan rests on**

- ACP (SDK 2.7, stable schema) has `additionalDirectories` on `session/new`, `session/load` and `session/resume`, behind `sessionCapabilities.additionalDirectories`. The list may differ on resume as long as `cwd` is the same.
- `@agentclientprotocol/claude-agent-acp@0.107.0` advertises it and passes it to the Claude SDK; `@agentclientprotocol/codex-acp@2.6.0` advertises it, adds the folders to the sandbox's writable roots and loads skills from them. `cursor-agent acp` does not advertise it (its `sessionCapabilities` has only `list`).
- Claude Code reads `CLAUDE.md` from additional directories only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` (the variable is in the shipped binary). It already loads skills from additional directories.

**Reuse:** `realDirectory`, `initRepository`, `insertProject`, `publishProject`, `requireProject` (`apps/daemon/src/domain/projects.ts`); `git`/`gitLine` (`apps/daemon/src/domain/git.ts`); `FolderWatchers` (`apps/daemon/src/skills/watch.ts`); `listProjectFiles` (`apps/daemon/src/files/list.ts`) and `searchPaths` (`apps/daemon/src/files/rank.ts`); `DocsWatcher` (`apps/daemon/src/docs/watcher.ts`); `perform` (`apps/desktop/src/renderer/features/chats/commands.ts`); `SortableList`, `Modal`, `FormField`, `Input`, `toast`, `openConfirmModal` (`@clowdy/components`); `SettingsRow` (`apps/desktop/src/renderer/features/settings/ui/SettingsRow.tsx`); `projectView.ts` remote-to-link helpers (`apps/desktop/src/renderer/features/settings/projects/projectView.ts`).

## Left for later

- Agents that take neither a system prompt nor additional folders (Cursor) hear about a folder change only in a new session: the prompt reaches them on the first turn only (Stage 3 review). Fix: tell the next turn when the folder list changed.
- Launch flags for Gemini (`--include-directories`), Copilot (`--add-dir`) and omp (`--add-dir`), and a picker note for prompt-only agents, once someone can run those agents (`research/index.md`).
- Reordering folders from the keyboard: `SortableList` has only a pointer sensor (Stages 5 and 6 reviews).
- The Modal animates even with reduced motion on, which is why dialog tests turn its animation off (Stage 5 review).

## Out of scope

- A working directory of its own for one chat (a chat choosing which folder of the workspace it runs in).
- The current worktree and branch (`TODO.md`, Projects).
- Opening a folder in Finder or an IDE.
- Folders in the personal space.

## Stage 1 — Research: agents and additional folders

**Depends on:** None.

**This stage:** the daemon will send `additionalDirectories` to every agent that advertises them and list the folders in the prompt for the rest, but we do not yet know how each agent behaves around folders outside its working directory. This stage finds out, so Stage 3 wires what each agent needs and the person can decide what an agent that cannot reach the other folders should do. No production code.

- [x] Complete
  - [x] Codex: whether `AGENTS.md` (and project config) in additional folders is read, with the source or a run as evidence
  - [x] Cursor: whether a session can read and write files outside its working directory, and whether any `_meta` or config adds roots
  - [x] OpenCode, Gemini, Copilot, Grok, omp, Hermes: from their sources or docs, whether they advertise `additionalDirectories` and how they treat paths outside `cwd`
  - [x] Claude: confirm the adapter forwards `additionalDirectories` on `session/resume` and `session/load` as well as `session/new`
  - [x] The findings are put to the person with a recommendation for agents that cannot reach the other folders; their answer is added to **Decisions**

**Files**

- `.briefback/projects-workspaces/research/index.md` — create: the map, summary and open questions
- `.briefback/projects-workspaces/research/agents.md` — create: the findings, one section per agent
- `apps/daemon/src/engine/acp/catalog.ts` — read only: the agent list and how each is launched
- `apps/daemon/src/engine/acp/probe.ts` — read only: `probeAgent` shows an installed agent's capabilities

**Done when:** every agent in the catalog has a recorded answer, and the person has decided what happens with agents that cannot reach additional folders.
**Verify:** the research file covers every `id` in `KNOWN_AGENTS`; the decision is in **Decisions**.
**Commits:** None yet.

## Stage 2 — Contract and daemon: projects made of folders

**Depends on:** None.

**This stage:** the daemon learns that a project is a list of folders and stops caring about git. `project.add` replaces create and open (empty list makes a new folder with `git init`; the same set of folders returns the existing project), `project.update` takes the whole ordered folder list and enforces the rules about the main folder, duplicates, nesting and the personal space. Project info, file search and project skills work per folder. Docs keep reading the main folder until Stage 4. The renderer gets only the edits that keep it compiling and its fixture daemon behaving like the real one.

- [x] Complete
  - [x] Protocol: `ProjectFolder`, `Project.folders` (no `path`), `project.add` (`name?`, `folders: string[]`, answered with the project and whether it already existed), `project.update` `folders: { id?: string; path: string }[]` in place of `path`, `ProjectInfo.folders` (`folderId`, exists, remote) in place of `folderExists` and `remoteUrl`, `GET /v1/projects/:id/files` answering `{ folderId, path }[]`
  - [x] Migration 11: a `project_folders` table (id, project, path, position, unique per project and path), the current paths moved into it, and `projects` rebuilt without its unique `path` column
  - [x] `project.add`: any existing folder, real paths, no duplicates or nesting, the same set returns the existing project, no folders makes `<projectsDir>/<kebab-name>` with `git init`, the name defaults to the main folder's name
  - [x] `project.update` with `folders`: keeps ids of folders it already has, refuses an empty list, duplicates, nesting and any change to the personal space, refuses a new main folder while runs are unfinished, re-points the skills watchers
  - [x] `projectsInfo` reports every folder; file search spans every existing folder, counting the folder's name as part of the path when ranking
  - [x] Project skills come from `.claude/skills` and `.agents/skills` of every folder, labelled with the folder's name when there are several; a folder shared by two projects is watched once and refreshes both
  - [x] Daemon tests, `apps/daemon/AGENTS.md`, and the renderer and fixture edits that keep the desktop app compiling and its tests passing

**Files**

- `packages/protocol/src/domain.ts` — `Project`, `ProjectFolder`, `ProjectInfo`
- `packages/protocol/src/commands.ts` — `project.add` in place of `project.open` and `project.create`; `project.update` `folders`
- `packages/protocol/src/api.ts` — the files route's answer, `ProjectFileMatch`
- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 11
- `apps/daemon/src/db/projects.ts` — `toProject`, `upsertProject`, `getProjectByPath` (becomes a lookup by folder set), folder rows
- `apps/daemon/src/domain/projects.ts` — `addProject` in place of `openProject` and `createProject`, `requireRepositoryRoot` removed, `updateProject` folders, `ensurePersonalProject`, `projectsInfo`
- `apps/daemon/src/commands/project.ts` — `projectHandlers`: `project.add`, `project.update` folders
- `apps/daemon/src/config.ts` — `projectsDir` comment names `project.add`
- `apps/daemon/src/files/service.ts` — `FilesService.search` over folders
- `apps/daemon/src/skills/service.ts` — `PROJECT_ROOTS` per folder: `forgetProject`, project scans, watchers
- `apps/daemon/src/skills/watch.ts` — `FolderWatchers`: one watch serving several projects
- `apps/daemon/src/http/routes.ts` — `createRoutes`: the files route answer
- `apps/daemon/src/docs/service.ts` — `DocsService.root`: read the main folder (until Stage 4)
- `apps/daemon/src/runs/driver.ts`, `apps/daemon/src/runs/prompts.ts` — use the main folder where `project.path` was read (until Stage 3)
- `apps/daemon/test/projects.test.ts`, `files.test.ts`, `skills-folders.test.ts`, `commands.test.ts`, `http.test.ts`, `storage.test.ts`, `helpers.ts` — the new behavior and the expectations that used `path`, `project.open` or `project.create`
- `apps/daemon/AGENTS.md` — projects are folders, `project.add`
- `apps/desktop/src/renderer/stores/RootStore.ts` — `createProject`, `openProject` send `project.add`; the added project is found by id
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — `project.add`, `project.update` folders, `folders` on project literals
- `apps/desktop/src/renderer/shell/ProjectSelect.tsx`, `apps/desktop/src/renderer/features/settings/projects/ProjectRow.tsx`, `ProjectFolder.tsx`, `projectActions.ts`, `useProjectsInfo.ts` — read the main folder and the new `ProjectInfo`
- `apps/desktop/src/renderer/features/chats/useMentionTriggers.ts`, `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts` — the files route's new answer, main-folder matches only (until Stage 6)

**Done when:** a daemon accepts `project.add` with several folders (git or not), returns the existing project for the same set, refuses duplicates, nesting and a new main folder during a run, and reports info, files and skills for every folder.
**Verify:** `bun run --cwd apps/daemon test`, `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`
**Commits:** None yet.

## Stage 3 — Agents see every folder

**Depends on:** Stage 1, Stage 2.

**This stage:** a run works in the main folder and gets the others: through ACP `additionalDirectories` when the agent advertises them, and always in the system prompt, which lists the folders, marks the main one, tells the agent to read each folder's `AGENTS.md` or `CLAUDE.md` before changing files there, and says where documents go. Claude also reads the other folders' `CLAUDE.md`. Whatever Stage 1 found that an agent needs (a flag, a `_meta` field) and whatever the person decided for agents that cannot reach the folders lands here.

- [x] Complete
  - [x] `EngineStartOptions.additionalDirectories`: the project's existing folders except the run's working directory
  - [x] The ACP session sends `additionalDirectories` on `session/new`, `session/load` and `session/resume` when the agent advertises the capability, and never otherwise
  - [x] Claude's catalog entry sets `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`
  - [x] `systemPrompt`: the folders with the main one marked, the instructions line, and the documents rule (one folder's documents in its `.clowdy/docs`, shared ones in the main folder's)
  - [x] The `clowdy:docs` system skill says the same about where documents go
  - [x] Per-agent changes from Stage 1 and the person's decision for agents that cannot reach the folders
  - [x] Tests with the fake ACP agent: the list is sent when advertised, left out when not, and changes on resume without a new session

**Files**

- `apps/daemon/src/engine/types.ts` — `EngineStartOptions`: `additionalDirectories`
- `apps/daemon/src/engine/acp/session.ts` — the shared `NewSessionRequest`: `additionalDirectories` behind `sessionCapabilities.additionalDirectories`
- `apps/daemon/src/engine/acp/catalog.ts` — `KNOWN_AGENTS`: Claude's `env`, and the Stage 1 findings
- `apps/daemon/src/engine/fake.ts` — accepts the new option
- `apps/daemon/src/runs/driver.ts` — the turn's `engine.start`: working directory and `additionalDirectories`
- `apps/daemon/src/runs/prompts.ts` — `systemPrompt`: the folders, instructions and documents lines
- `packages/system-skills/skills/docs/SKILL.md` — where documents go in a project of several folders
- `apps/daemon/test/fake-acp-agent.ts`, `acp-session.test.ts`, `runs.test.ts` — the capability, the list on new and resumed sessions, the prompt
- `apps/daemon/AGENTS.md` — how runs get the folders

**Done when:** a run in a project of three folders starts in the main folder, an agent that advertises the capability receives the other two in `additionalDirectories`, and the prompt names all three.
**Verify:** `bun run --cwd apps/daemon test`, `bun run typecheck`, `bun run lint`
**Commits:** None yet. Reviewed: one-folder projects are told as `folder at <path>`; `systemPrompt` marks the folder the run works in (`you work here`) apart from the main one; `clowdy:docs` keeps one `index.md` per docs folder.

## Stage 4 — Docs in every folder

**Depends on:** Stage 2.

**This stage:** documents stop being the main folder's alone: every folder has its own `.clowdy/docs`, the API addresses a document by folder and path, and the docs tree shows the folders at its top level when there are several (one folder looks as today). `.clowdy/docs` is made only by the first write, so adding someone else's repository to a workspace leaves no trace in it. A folder shared by two projects shares its documents with both. `@` document mentions follow the same path rule as files: relative for the main folder, absolute for the others. Daemon and renderer land together because the contract changes under both; after the protocol is written they can be done by two workers in parallel.

- [x] Complete
  - [x] Protocol: the docs tree answers one entry per folder (`folderId`, nodes); reading, `docs.write` and `docs.changed` carry `folderId`
  - [x] `DocsService`: a root and a watcher per folder, created on first write only, reading a folder with no `.clowdy/docs` as empty, announcing a change to every project that has the folder
  - [x] `DocsStore` and the tree: documents keyed by folder and path; one folder shows the tree as today, several show the folders first (main first, empty ones too)
  - [x] New document goes to the folder it was made under; conflict handling, reveal and selection work per folder
  - [x] `@` document mentions: relative path for the main folder, absolute for others, the folder name in the suggestion when there are several
  - [x] Daemon and desktop tests; fixture daemon serves documents per folder

**Files**

- `packages/protocol/src/domain.ts` — `DocNode`, `DocFile`, a folder entry of the tree
- `packages/protocol/src/events.ts` — `DocsTree`, `docs.changed` `folderId`
- `packages/protocol/src/commands.ts` — `docs.write` `folderId`
- `packages/protocol/src/api.ts` — the docs routes take the folder
- `apps/daemon/src/docs/service.ts` — `DocsService`: roots, watchers, lazy creation, `forget`
- `apps/daemon/src/docs/watcher.ts`, `tree.ts`, `paths.ts` — per folder
- `apps/daemon/src/commands/docs.ts` — `docsHandlers`: `folderId`, emit to every project with the folder
- `apps/daemon/src/http/routes.ts` — `createRoutes`: docs routes
- `apps/daemon/test/docs.test.ts` — per folder, lazy creation, shared folder
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts` — docs calls with the folder
- `apps/desktop/src/renderer/features/docs/DocsStore.ts`, `DocBuffer.ts`, `tree.ts`, `DocsTree.tsx`, `DocsSidebar.tsx`, `NewDocumentDialog.tsx`, `docCommands.ts` — folder-aware tree, buffers and creation
- `apps/desktop/src/renderer/stores/ProjectState.ts` — `docs.changed` with the folder
- `apps/desktop/src/renderer/features/chats/mentionItems.tsx`, `composerMentions.ts`, `useMentionTriggers.ts` — document mentions per folder
- tests beside each (`DocsStore.test.ts`, `DocsTree.test.tsx`, `tree.test.ts`, `docCommands.test.ts`, `mentionItems.test.tsx`, `fixtureTransport.test.ts`, `httpTransport.test.ts`)

**Done when:** in a project of two folders the tree shows both, a document created under the second lands in its `.clowdy/docs` (made at that moment), and a project of one folder shows the tree as before.
**Verify:** `bun run --cwd apps/daemon test`, `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, a screenshot of the docs tree in fixtures mode with two folders
**Commits:** None yet. Reviewed: a `.clowdy` or docs folder that links out of its folder is refused before anything is made; a non-main folder whose documents cannot be read is left out of the tree; the folder rows' New document button is reachable by keyboard; `ProjectUi.docFolderId` (`?docFolder=`) remembers the open document's folder. The fixtures screenshot of a two-folder tree was not taken.

## Stage 5 — Add project

**Depends on:** Stage 2. Runs after Stage 4 when both are in progress: both edit `fixtureTransport.ts` and `fixtureData.ts`.

**This stage:** creating and opening a project become one action with one form. The select, Settings > Projects and the no-project screen show Add project…; the form takes a name and a folder list built with a multi-select system picker (a path field in a browser), with the first folder marked Main and the order set by dragging. No folders makes a new one. The same set as an existing project opens it with a toast.

- [x] Complete
  - [x] The desktop bridge asks for several folders at once (`chooseDirectories`, an empty list on cancel)
  - [x] `RootStore.addProject` replaces `createProject` and `openProject`, and reports whether the project already existed
  - [x] The Add project form: name filled from the main folder until edited, the folder list with Main, drag and remove, Add folders… any number of times, the empty-list hint, errors from the daemon inline
  - [x] Add project… in the select (with Manage projects…), a single Add project button on Settings > Projects and on the no-project screen
  - [x] The same-set toast

**Files**

- `apps/desktop/src/shared/bridge.ts` — `IPC_CHANNELS`, `DesktopBridge`: `chooseDirectories`
- `apps/desktop/src/main/ipc.ts` — the dialog with `multiSelections`
- `apps/desktop/src/preload/index.ts` — `chooseDirectories`
- `apps/desktop/src/renderer/stores/RootStore.ts` — `addProject`
- `apps/desktop/src/renderer/shell/projectDialogs.tsx` — `openAddProject` and its form in place of `openCreateProject`, `openExistingProject`, `ProjectForm`; `pickFolders` in place of `pickFolder`
- `apps/desktop/src/renderer/shell/ProjectSelect.tsx`, `NoProject.tsx` — Add project…
- `apps/desktop/src/renderer/features/settings/projects/ProjectsPage.tsx` — Add project button
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — `project.add` answers whether the project existed
- `apps/desktop/src/renderer/theme.test.ts` — the bridge stub
- tests: `ProjectSelect.test.tsx`, `ProjectsPage.test.tsx`, `RootStore.test.ts`, and `projectDialogs.test.tsx` (create: no test of the dialogs exists)
- `apps/desktop/AGENTS.md` — Add project replaces Create and Open

**Done when:** from the select a person adds a project of two folders picked in one dialog, reorders them, and lands in it; adding the same two folders again opens it with the toast.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, screenshots of the form in fixtures mode (empty and with folders)
**Commits:** None yet. Reviewed: removing a folder moves focus to its neighbour; a typed drive root keeps its separator; dialog tests turn off the Modal's animation instead of mocking `motion`. Screenshots: the form empty, with two folders, and after a real drag in Electron.

## Stage 6 — A project's folders in Settings, the select and `@`

**Depends on:** Stage 5.

**This stage:** the person manages a project's folders after it exists and sees them where the project shows up. The Folder block on the project's settings page becomes Folders (Main mark, drag, Add folders…, Remove, missing warning and git remote per folder), changing the main folder confirms like Change folder did and is refused during runs, the select shows `+N`, and `@` file suggestions come from every folder with the right path for the agent.

- [x] Complete
  - [x] The Folders block: list from `ProjectInfo.folders`, drag to reorder, Add folders…, Remove; the personal space shows its one folder read only
  - [x] A new main folder (by dragging or by removing the current one) asks for confirmation with the memory note and explains a refusal during runs; other folder changes apply without a dialog
  - [x] The select's description: the main folder's path and `+N`
  - [x] `@` files: matches from every folder, relative for the main folder and absolute for others, `<folder name>/<path>` in the suggestion when there are several folders
  - [x] `TODO.md`: Workspace checked

**Files**

- `apps/desktop/src/renderer/features/settings/projects/ProjectFolder.tsx` — becomes the Folders block
- `apps/desktop/src/renderer/features/settings/projects/ProjectDetail.tsx`, `ProjectDetail.module.css` — the block and per-folder git rows
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — folder changes and the main-folder confirmation in place of Change folder
- `apps/desktop/src/renderer/features/settings/projects/projectView.ts` — per-folder remote link and missing warning
- `apps/desktop/src/renderer/shell/ProjectSelect.tsx` — the description
- `apps/desktop/src/renderer/features/chats/mentionItems.tsx`, `composerMentions.ts`, `useMentionTriggers.ts` — file mentions per folder
- tests: `ProjectsPage.test.tsx`, `projectView.test.ts`, `ProjectSelect.test.tsx`, `mentionItems.test.tsx`, `composerMentions.test.ts`
- `apps/desktop/AGENTS.md` — the Folders block
- `TODO.md` — Workspace (not tracked: ticked in the main checkout, outside the commits)

**Done when:** on a project's page a person adds a second folder, drags it to the top after confirming, and `@` in a chat of that project suggests files from both folders.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, screenshots in fixtures mode of the Folders block and of `@` suggestions from two folders
**Commits:** None yet. Reviewed: the new-main dialog applies its change to the folders the project has when the person confirms, so a folder added meanwhile is kept; the Danger zone copy speaks of folders; the guard that keeps the main row in place while agents work is tested. The rows of Settings > Projects still show only the main folder's path.
