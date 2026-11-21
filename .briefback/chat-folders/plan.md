# Chats grouped by folder

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** in a project of several folders, the Agents list can be grouped by folder, and a chat started from a group works in that folder instead of the main one.

**Approach:** a chat gets an optional `folderId`, set when it is made from a group that is not the main folder and fixed from then on; the daemon resolves the folder to the run's working directory on every turn (a thread inherits its parent's), and a folder that leaves the project hands its chats back to the main folder. The desktop app adds a "Group by folder" switch to the Agents list, folder headings with their own new-chat button, and a draft that knows its folder. Everything about the grouping itself (the switch, the folds) is a per-project view preference kept on this machine.

**Decisions**

- The switch is an entry "Group by folder" in the `⋯` menu of the Agents heading, beside Show and Sort by. It is kept per project on this machine (`ProjectUi`, like the sort), shown only when the project has two or more folders, and off by default: a flat list, and a new chat in the main folder.
- With the switch on, the list is a group per folder, in the project's folder order (main first), headed by the folder's name (`folderNames`). A group is shown even when it is empty (a muted `No chats` row), so a chat can be made in a folder that has none.
- Every group folds, by its chevron (shown after the name on hover and focus) and by a press on the heading; folded groups are remembered per project on this machine, and every group starts open.
- On hover or focus a heading shows a button, `New chat in <folder>`, with the icon of a chat and a plus. It opens a draft in that folder. A group's heading has no `⋯` menu in this version.
- A folder that is missing on disk is shown with a warning, and its new-chat button is off.
- The row "New chat" and the shortcut ⌘N stay as they are and start a chat in the main folder. A draft shows its folder in a line under the heading, `in <folder name>`, while the switch is on, the main folder's draft included. The "New chat" row is the selected row for any draft.
- Inside a group the chosen sort applies. The threads of a chat stay below it, in the group of their parent. The archive's list stays flat.
- `Chat.folderId` is a new optional field, set by `chat.create` when the chat is made from a folder other than the main one. A chat without it follows the main folder, as every chat does today, and counts as a chat of whichever folder is main.
- The folder is fixed from the chat's creation: a chat is never moved to another folder. The run works in the chat's folder, and the project's other folders reach the agent as before (`additionalDirectories`, the system prompt marking the folder it works in).
- When a folder leaves the project, its chats go back to the main folder: the daemon clears their `folderId`, and their next turn starts a new conversation, as it does today when the main folder changes. The confirmation of removing a folder that chats work in says how many chats there are; a folder with none is removed at once, as now.
- A thread inherits its parent's `folderId`. An explicit `cwd` of `thread_spawn` still decides the working folder of its run.
- UI text without a closing period, as `AGENTS.md` asks.

**Reuse:** `createChat`, `saveChat`, `requireChat` (`apps/daemon/src/domain/chats.ts`); `updateProject`, `projectsInfo` (`apps/daemon/src/domain/projects.ts`); `getRunWork`, `additionalFolders`, `promptChat` (`apps/daemon/src/runs/driver.ts`); `folderNames`, `mainFolder` (`packages/protocol/src/domain.ts`); `agentRows`, `visibleChats` (`apps/desktop/src/renderer/features/agents/agentTree.ts`); `GridList`, `GridListItem`, `Menu`, `MenuSection`, `listBoxItemDataShow` (`@clowdy/components/List`); `openConfirmModal` (`@clowdy/components/modals`); `perform` (`apps/desktop/src/renderer/features/chats/commands.ts`); `plural` (`apps/desktop/src/renderer/features/settings/projects/projectView.ts`).

## Out of scope

- Moving a chat to another folder after it was made.
- A `⋯` menu on a group heading.
- Grouping the archive's list, and grouping by anything other than the folder.
- The current worktree and branch of a chat (`BACKLOG.md`, Projects).

## Stage 1 — Contract and daemon: a chat works in its folder

**Depends on:** None.

**This stage:** a chat learns which folder of its project it works in. `chat.create` takes a folder, the chat keeps it, and every turn of the chat's orchestrator works there (the main folder when it has none); a thread inherits its parent's. When a project loses a folder, the chats that worked in it fall back to the main folder, and `ProjectInfo` counts the chats of each folder so the app can warn before a removal. The desktop app only gets what keeps it compiling and its fixture daemon like the real one.

- [ ] Complete
  - [x] Protocol: `Chat.folderId`, `folderId` on `chat.create`, `ProjectFolderInfo.chats`
  - [x] Migration 17: `chats.folder_id`, with no foreign key (`upsertProject` rewrites the folder rows, which would clear it)
  - [x] `chat.create` with a `folderId` that is not a folder of the project is `invalid`; a valid one is stored on the chat
  - [x] A turn's working folder is the run's own `cwd` when it has one, else the chat's folder, else the main folder; the other folders reach the agent as additional folders, and a chat whose folder is gone from the project (it was cleared) works in the main folder, and a folder gone from disk fails the turn with `The folder <path> no longer exists`
  - [x] `thread_spawn` gives the thread its parent's `folderId`; an explicit `cwd` still decides the run's folder
  - [x] `project.update` clears the `folderId` of every chat whose folder left the project and publishes those chats
  - [x] `projectsInfo` counts, per folder, the chats that have it as their `folderId`
  - [x] Daemon tests, `apps/daemon/AGENTS.md`, and the fixture daemon edits that keep the desktop app compiling and its tests passing

**Files**

- `packages/protocol/src/domain.ts` — `Chat`: `folderId`; `ProjectFolderInfo`: `chats`
- `packages/protocol/src/commands.ts` — `chat.create`: `folderId`
- `apps/daemon/src/db/migrations.ts` — `MIGRATIONS`: version 17
- `apps/daemon/src/db/chats.ts` — `ChatRow`, `toChat`, `upsertChat` (writes `folder_id`, which a project update may clear), a count of the chats per folder
- `apps/daemon/src/domain/chats.ts` — `createChat`: `folderId`, checked against the project's folders
- `apps/daemon/src/domain/projects.ts` — `updateProject`: chats of a removed folder go back to the main folder; `projectsInfo`: `chats` per folder
- `apps/daemon/src/runs/driver.ts` — the turn's `cwd`: run, chat's folder, main folder
- `apps/daemon/src/runs/threads.ts` — `spawn`: the thread's `folderId`
- `apps/daemon/test/projects.test.ts`, `chat-archive.test.ts` (patterns), `threads.test.ts`, `orchestration.test.ts` or a new `chat-folders.test.ts` — create only if none fits: the whole behavior is one subject, a chat and its folder, and no existing file is about it
- `apps/daemon/AGENTS.md` — a chat's folder, the order that decides a turn's working folder, `ProjectInfo.folders[].chats`; the sentence that says no command sets `NewRun.cwd` is out of date
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — `chat.create` keeps `folderId`, `getProjectsInfo` reports `chats` per folder, a project of several folders has chats in more than one

**Done when:** a chat made with a folder of its project runs its turns in that folder (the fake engine reports its `cwd`), a thread of it does too, and removing the folder through `project.update` leaves the chat without a folder and its next turn in the main folder.
**Verify:** `bun run --cwd apps/daemon test`, `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`
**Commits:** None yet.

## Stage 2 — Desktop: the grouped Agents list

**Depends on:** Stage 1.

**This stage:** the Agents list can be grouped by folder. The `⋯` menu gets the switch (only for a project with several folders), the list shows a heading per folder with its chats below, a fold and a button that opens a draft in that folder, and the draft says which folder it is for and creates its chat there. Removing a folder that chats work in asks first and says how many.

- [ ] Complete
  - [ ] `ProjectUi`: `groupByFolder` and `collapsedFolders` kept per project, a draft that carries its folder (`openDraft` takes it, `ProjectView` keeps it for back and forward)
  - [ ] `agentGroups`: the root chats split into one group per folder of the project in order, a chat with no folder, or one whose folder the project no longer has, in the main folder's group
  - [ ] `AgentList` draws a heading row per group (name, the chevron after it, the new-chat button on hover and focus, a warning when the folder is missing and the button off), the group's chats below it unless it is folded, `No chats` in an empty open group; the arrows, J and K, Right and Left keep working across headings
  - [ ] The "Group by folder" entry in the heading's `⋯` menu, offered only when the project has two or more folders; with the switch off the list is the flat one it is today
  - [ ] The draft shows `in <folder name>` while the switch is on, and its first message sends `chat.create` with that folder, none for the main folder
  - [ ] Removing a folder that has chats asks first, with how many chats go back to the main folder
  - [ ] Tests, `apps/desktop/AGENTS.md`, and the fixture project that has several folders and chats in them

**Files**

- `apps/desktop/src/renderer/stores/UiStore.ts` — `ProjectUi`: `groupByFolder`, `collapsedFolders`, `draftFolderId`, `openDraft`, `view`/`show`; `StoredProjectUi`, `InitialProjectUi`
- `apps/desktop/src/renderer/features/agents/agentTree.ts` — `agentGroups`: the groups, from the roots, the project's folders and the main folder
- `apps/desktop/src/renderer/features/agents/AgentList.tsx` — the heading rows, the fold, the group's new-chat button, `FilterMenu`'s entry, the keyboard commands' ids
- `apps/desktop/src/renderer/features/agents/AgentList.module.css` — the heading row: its buttons shown on hover and focus, the empty-group row
- `apps/desktop/src/renderer/features/agents/DraftChat.tsx` — the folder line, `start.folderId`
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `start.folderId` in the `chat.create` it sends
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — `removeFolder`: asks first when the folder has chats (`info.folders[].chats`), says how many go to the main folder
- `apps/desktop/src/renderer/features/settings/projects/projectView.ts` — the message of that confirmation, beside `newMainMessage`
- `apps/desktop/src/renderer/features/settings/projects/ProjectFolders.tsx` — hands `removeFolder` the folder's chat count from `info`
- `apps/desktop/src/renderer/features/agents/agentTree.test.ts`, `Screen.test.tsx`, `apps/desktop/src/renderer/stores/UiStore.test.ts` (or the store's existing test file), `apps/desktop/src/renderer/features/settings/projects/ProjectsPage.test.tsx` — the groups, the list, the switch and folds, the draft's folder, the removal confirmation
- `apps/desktop/AGENTS.md` — the Agents list's grouping, the draft's folder, the removal confirmation
- `BACKLOG.md` — tick "Group chats by folders"

**Done when:** with the switch on in a project of two folders, the list shows a group per folder, the button of the second group opens a draft that says `in <folder>`, and its first message makes a chat whose agent works in that folder.
**Verify:** `bun run --cwd apps/desktop test`, `bun run typecheck`, `bun run lint`, then the app on a real daemon with the fake engine (`apps/desktop/AGENTS.md`, fixtures and real-daemon checks)
**Commits:** None yet.
