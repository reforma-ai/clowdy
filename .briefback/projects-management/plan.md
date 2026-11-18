# Personal space and project management

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** the person can chat with an agent without any repository (a personal space, always first in the project select), and can reorder, rename, re-point, configure and remove projects from Settings.

**Approach:** the daemon owns everything: the personal space is a real project row with a `personal` flag, made at start in a folder inside the daemon's data dir, so chats, runs, tasks and docs work in it with no special case. Removing, moving, renaming and ordering projects are daemon commands that emit whole-entity events (`project.upserted`, new `project.deleted`). The renderer adds the personal space and a "Manage projects…" entry to the select, and a Settings > Projects page (list with drag to reorder, one page per project) that talks to those commands.

**Decisions**

- The personal space is a project with `personal: true`, created by the daemon at start (`<dataDir>/personal`, named "Personal", `git init` best effort so worktrees work), one per daemon. It is listed first always, cannot be renamed, moved, removed or reordered, and its Tasks and Docs sections stay as in any project.
- With the personal space always present, a window with nothing remembered opens on the first project of the person's own and on the personal space only when there is none (an upgrading user does not land on an empty space); removing the open project moves the window to the first project, which is the personal space. "Create or open a project" is only the fallback when the daemon has no projects at all.
- The select stays a pure switcher: Personal on top, a separator, the projects in the person's order, a separator, then Create project, Open existing project…, and a new Manage projects… that opens Settings > Projects. No per-row menu in the dropdown.
- Settings gets a Workspace group with a Projects page. The list is Personal (pinned) and then the projects, draggable by a grip; a row opens the project's page; a row menu has Open and Remove….
- A project's page (inside the Projects page, with a back link, not a new settings page) has: name (rename on blur or Enter), folder (path, a warning when it no longer exists, Change folder…), Git (the origin remote as a link when it is an https or ssh address of a web host, the branch), New chats (agent and mode, from `ProjectSettings.engine` and `chatMode`; "Default" clears the field), and a Danger zone (Remove project). The personal space shows a note, its folder (read only) and New chats.
- Order is stored as `Project.position` (1..n, personal 0); `project.reorder` rewrites it and emits `project.upserted` per changed project, so no new event type is needed. Clients sort by personal first, then position, then creation time.
- Removing a project deletes its chats, tasks, runs, streams, artifacts and attachments for good and leaves the folder and every file in it on disk. It is refused while any run of the project is unfinished, and for the personal space. The confirmation names the counts.
- Changing a project's folder uses the checks of `project.open` (exists, is a repository root, not used by another project), is refused while runs are unfinished, and re-points the docs and skills watchers. An agent session that cannot be resumed from the new folder starts a new one (already how resume failure behaves), and the dialog says earlier agent memory may not carry over.
- `GET /v1/projects/info` answers, for every project, whether its folder exists, its git remote and branch, and its chat, task and unfinished-run counts. The Projects page reads it when it opens; nothing announces it.
- `project.update` settings fields take `null` to clear.
- The personal space's system prompt says it has no repository, instead of "repository at …".
- The migration is version 7: the chat-model (5) and context (6) migrations landed on `main` first, so this branch renumbered its own when it was rebased.

**Reuse:** `createProject`/`openProject`/`updateProject` and `requireProject` (`apps/daemon/src/domain/projects.ts`), `git()` (`apps/daemon/src/domain/git.ts`), `deleteChat` and `AttachmentsService.removeOfChat` as the model for cleanup, `FolderWatchers` and `DocsService` watchers, `perform` (`features/chats/commands.ts`), `openConfirmModal` (`@clowdy/components/modals`), `SortableList`, `SettingsField`, `isUsableProvider` and the provider names (`features/settings/providers/providerView.ts`), `openCreateProject`/`openExistingProject` (`shell/projectDialogs.tsx`).

## Out of scope

- Opening or revealing a project folder in Finder or an IDE (the Files item in `TODO.md`), a native menu bridge.
- A model setting per project (the model picker of the chat-model work owns it); `maxParallelRuns` stays unexposed in the UI.
- "Thread defaults" as remembered last options, project id and created-date rows, counts per machine.
- Hiding Tasks or Docs in the personal space; deleting a project's folder from disk; one project on several machines.
- Back and forward history entries for a project's page inside Settings.

## Stage 1 — Contract and daemon

**Depends on:** None.

**This stage:** the daemon is the producer of everything the UI needs, so the protocol and the daemon land together. A personal project is made at start; projects get an order; they can be deleted, moved and reordered; their git remote and counts can be read. Settings fields can be cleared with `null`. The renderer only gets the minimal edits that keep it compiling against the new `Project` shape.

- [x] Complete
  - [x] Protocol: `Project.position`, `Project.personal`, `ProjectInfo`, `project.deleted`, `project.delete`, `project.reorder`, `project.update` `path` and nullable settings, `ROUTES.projectsInfo`
  - [x] Migration 5 adds `personal` (one at most) and `position` to `projects`; existing projects keep their creation order
  - [x] `ensurePersonalProject` runs at start, survives a missing git, and recreates a deleted folder
  - [x] `project.delete` with cascade, watcher and attachment cleanup, refused for personal and while runs are unfinished
  - [x] `project.update` re-points a folder and clears settings with `null`; `project.reorder` rewrites positions; both refuse what the decisions say
  - [x] `GET /v1/projects/info`
  - [x] The personal space's system prompt
  - [x] Daemon tests, `apps/daemon/AGENTS.md`, and the renderer compile fixes

**Files**

- `packages/protocol/src/domain.ts`, `events.ts`, `commands.ts`, `api.ts` — the contract (written)
- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 5
- `apps/daemon/src/db/projects.ts` — `toProject`, `listProjects` order, `upsertProject` (path, position, personal), `deleteProjectRow`, `projectCounts`, `nextPosition`
- `apps/daemon/src/domain/projects.ts` — `insertProject` position, `ensurePersonalProject`, `deleteProject`, `updateProject` (path, null settings, personal guards), `reorderProjects`, `projectsInfo`
- `apps/daemon/src/commands/project.ts` — handlers for `project.delete`, `project.reorder`, `project.update` path
- `apps/daemon/src/daemon.ts` — `startDaemon`: ensure the personal project before the watchers
- `apps/daemon/src/http/routes.ts` — `createRoutes`: `GET /v1/projects/info`
- `apps/daemon/src/docs/service.ts` — `DocsService.forget(projectId)`
- `apps/daemon/src/skills/service.ts`, `skills/watch.ts` — `SkillsService.forgetProject`, `FolderWatchers.unwatch`
- `apps/daemon/src/attachments/service.ts`, `db/attachments.ts` — `removeOfProject`
- `apps/daemon/src/runs/prompts.ts` — `systemPrompt`: the personal space
- `apps/daemon/test/projects.test.ts` — create: the new behavior needs its own file, `commands.test.ts` is about command plumbing
- `apps/daemon/test/commands.test.ts`, `storage.test.ts`, `native.test.ts`, `http.test.ts` — expectations that assumed no personal project
- `apps/daemon/AGENTS.md` — the new commands, the route and the personal space
- `apps/desktop/src/renderer/daemon/fixtureData.ts`, `stores/RootStore.test.ts` — `position` on project literals

**Done when:** a daemon started on an empty data dir lists the personal project first, and the new commands and route behave as the decisions say.
**Verify:** `bun run --cwd apps/daemon test`, `bun run typecheck`, `bun run lint`
**Commits:**

- `03ba940` feat(daemon): add the personal space and let projects be removed, moved and reordered (protocol and daemon; the renderer's compile fixes for the new `Project` shape landed in Stage 2's commit, since they share `fixtureData.ts`, so the desktop typecheck passes from `e9a72be` on)
- test(daemon): start the reset clock of the race test after the daemon is up (the daemon now makes the personal space at start, which made a clock taken before it too early)

## Stage 2 — Renderer state, transport and fixtures

**Depends on:** Stage 1 (the protocol types; the daemon itself is not needed).

**This stage:** the stores and transports learn the new contract so the UI stages only draw. The project list is kept sorted (personal first, then position); a deleted project leaves every store, and a window that was on it moves to the first project; reorder and delete are store methods; the fixture daemon behaves like the real one so screenshots and tests work without a daemon.

- [x] Complete
  - [x] `Transport.getProjectsInfo` over HTTP and in the fixtures
  - [x] `RootStore` keeps `projects` sorted, handles `project.deleted` (drops its state, streams and remembered UI, falls back to the first project; a resync drops projects removed meanwhile), and has `reorderProjects`; with nothing remembered it opens on the first project of the person's own and on the personal space when there is none
  - [x] `UiStore` has the Projects settings page and the project open inside it, and forgets a deleted project
  - [x] The fixture daemon has a personal project and understands `project.delete`, `project.reorder`, `project.update` with `path` and `null`

**Files**

- `apps/desktop/src/renderer/daemon/transport.ts` — `Transport`: `getProjectsInfo`
- `apps/desktop/src/renderer/daemon/httpTransport.ts` — `HttpTransport`: `getProjectsInfo`
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — the personal project, the new commands, `getProjectsInfo`
- `apps/desktop/src/renderer/stores/RootStore.ts` — `load`, `handleEvent`, `#resync`, `#addProject`, new methods
- `apps/desktop/src/renderer/stores/UiStore.ts` — `SETTINGS_PAGES`, `settingsProjectId`, `forgetProject`
- `apps/desktop/src/renderer/stores/ProjectState.ts`, `storage.ts` — `project.deleted` is a no-op there; `removeStored`
- `NavHistory` needs no change: it already skips entries whose project is gone
- tests beside each (`RootStore.test.ts`, `UiStore.test.ts`, `fixtureTransport.test.ts`, `httpTransport.test.ts`)

**Done when:** a fixture-backed `RootStore` lists Personal first, drops a deleted project and moves off it, and reorders optimistically.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`
**Commits:**

- `e9a72be` feat(desktop): keep the personal space first and drop removed projects in the stores and fixtures

## Stage 3 — Project select

**Depends on:** Stage 2.

**This stage:** the title band's select shows the personal space on top and gets the Manage projects… entry. It is a switcher only.

- [x] Complete
  - [x] Personal first with its own mark, a separator, the projects, a separator, Create, Open existing, Manage projects…
  - [x] Manage projects… opens Settings on the Projects page

**Files**

- `apps/desktop/src/renderer/shell/ProjectSelect.tsx` — `ProjectSelect`
- `apps/desktop/src/renderer/shell/ProjectSelect.test.tsx` — create: no test of the select exists
- `apps/desktop/src/renderer/shell/NoProject.tsx` — wording stays; it is the fallback only

**Done when:** the dropdown shows Personal above the projects and Manage projects… lands on Settings > Projects.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, a screenshot in fixtures mode
**Commits:**

- `e34747c` feat(desktop): show the personal space and Manage projects in the project select

## Stage 4 — Settings > Projects

**Depends on:** Stage 2.

**This stage:** the page the select points at: the list with drag to reorder and the page of one project with rename, folder, git, new-chat defaults and removal. All confirmation and failure copy lives here.

- [x] Complete
  - [x] Workspace group and Projects page in the Settings sidebar
  - [x] List: Personal pinned, the rest sortable, a row opens its page, the row menu has Open and Remove…, an Add project menu
  - [x] Project page: name, folder (missing warning, Change folder…), git link and branch, new-chat agent and mode, Danger zone
  - [x] Remove and Change folder confirm with the facts (counts, memory note) and say why when agents are working

**Files**

- `apps/desktop/src/renderer/features/settings/Screen.tsx` — `GROUPS`: the Workspace group
- `apps/desktop/src/renderer/features/settings/projects/` — create `ProjectsPage.tsx`, `ProjectRow.tsx`, `ProjectDetail.tsx`, `projectView.ts` (remote to link, counts wording), `useProjectsInfo.ts`, `projectActions.ts` (confirm dialogs and commands), with CSS modules and tests: one folder per settings page, like `providers/` and `skills/`
- `apps/desktop/src/renderer/shell/projectDialogs.tsx` — `pickFolder` (system dialog, or a path form in a browser) for Change folder…
- `apps/desktop/src/renderer/stores/UiStore.ts` — `closeSettings`

**Done when:** from Settings > Projects a project can be reordered, renamed, re-pointed, given defaults and removed, and the personal space shows only what it allows.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, screenshots in fixtures mode of the list and a project page
**Commits:**

- `9d8d6ff` feat(desktop): add the Projects page to Settings

## Stage 5 — Docs and the checklist

**Depends on:** Stages 1–4.

**This stage:** the guides say how it works now, and the TODO items are checked.

- [x] Complete
  - [x] `apps/desktop/AGENTS.md` describes the select, the personal space and the Projects page
  - [x] `TODO.md`: Remove project, Sort projects, Personal space checked

**Files**

- `apps/desktop/AGENTS.md` — layout line for `shell/` and `features/settings`, a Projects paragraph
- `TODO.md` — the three items (the file is not tracked: it is ticked in the main checkout, outside the commits)

**Done when:** the guides match the code.
**Verify:** `bun run lint`
**Commits:** this commit.
