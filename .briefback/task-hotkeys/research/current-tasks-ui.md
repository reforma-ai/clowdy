# Tasks today: UI, domain model, and what Linear-style actions are missing

Research for the Task hotkey work. Facts are from the source as of branch `kachurun/feat/mvp` (HEAD `8b90309`). Inferences are marked.

## Summary

- The Tasks section is one screen (`features/tasks/Screen.tsx`) with two views of the same filtered list (Board or List), a right-hand detail panel, and a "New task" modal. There are no keyboard shortcuts of its own: selection and navigation come only from the browser (tab stops on board cards) and from React Aria's Table (list view).
- "Selected", "open", and "focused" are not separate ideas. One store field, `ProjectUi.taskId`, means both "the highlighted card or row" and "the task shown in the detail panel". Selecting a task opens it. There is no multi-select and no separate keyboard cursor.
- Every mutation is one `root.command(...)` call through `sendCommand` (`features/tasks/commands.ts`). The UI does not update optimistically. It waits for the daemon's `task.upserted` event on the SSE feed, which replaces the whole task in `ProjectState.tasks`. `EditableText` is the only local-draft exception.
- The task model is small: title, description, `statusId` (5 default statuses, each with a category), `dependsOn`, `createdBy`, optional `external`, timestamps. `task.update` can patch only title, description, statusId, and dependsOn. There is no priority, assignee, label, estimate, due date, parent, archive, duplicate, bulk command, reorder, or undo. Section "Gap list" lists them.
- For hotkeys, the existing mutations that already work are: set status (any status id), edit title, edit description, set dependencies, delete, start (assign to an agent by opening a chat and an orchestrator run), and create.

## How it works

### Data flow and selection model

1. `RootStore` (`stores/RootStore.ts`) holds the project list and one `ProjectState` per loaded project. It follows one SSE feed and routes each event to its project (`handleEvent` → `ProjectState.applyEvent`).
2. `ProjectState` (`stores/ProjectState.ts`) keeps `tasks: Map<TaskId, Task>` (replaced whole, never edited), `statuses: TaskStatus[]`, `runs`, and the two link maps. `taskList` is the tasks sorted by `number`. `tasksByStatus` groups them in workflow order. Events at or before the cursor are skipped.
3. `ProjectUi` (`stores/UiStore.ts`) is per-project UI state, persisted in `localStorage` under `clowdy:ui:<projectId>` through a MobX `reaction`. Fields: `section` (`chats|tasks|agents|docs`), `chatId`, `taskId`, `runId`, `docPath`, `showFinished`, `tasksView` (`board|list`). Methods: `openTask(id|null)` (also sets `section = 'tasks'`), `openChat`, `openRun`, `openDoc`, `setTasksView`, `setShowFinished`. `UiStore.showSection(ui, section)` also leaves Settings; `openSettings(page?)` shows the global Settings screen over the sections.
4. Hooks: `useProjectState()`, `useProjectUi()`, `useRootStore()` (`stores/hooks.ts`). All throw without a selected project; screens render only after a project is loaded.
5. The page URL can preselect state in fixtures mode only: `?fixtures=static&section=tasks&task=t-24&view=list` (`initialUiFromSearch`).

`Screen` (Tasks) derives everything per render:

- `runsOfTask = runsByTask(project.runTaskLinks.values(), project.runs)` (`taskView.ts`), only `assigned` and `verifies` links count.
- `visible = filterTasks(project.taskList, filter, runsOfTask)`, with `filter` held in `useState` inside `Screen`. It is not in `ProjectUi`, so leaving the section (or any remount) resets it.
- `columns` = one entry per status in workflow order, each with its tasks sorted by number.
- `selected = ui.taskId ? project.tasks.get(ui.taskId) : undefined`. A stored id for a task that no longer exists silently yields no selection and no panel; the stale id stays in the store until something calls `openTask`.
- If `visible.length === 0` neither the board nor the list is rendered; a centered message with "Clear filters" replaces both.
- The detail panel renders `{ selected && <DetailPanel key={ selected.id } … /> }`. It is not filtered: a selected task that a filter hides still shows in the panel.

### Views

**Board** (`Board.tsx`, `TaskCard.tsx`)

- One `<section aria-label=status.name>` per status. The column head is a `StatusPill` with a count. Cards are `<article draggable>` with the key, a full-card `<button>` for the title (`::after` covers the card; `aria-pressed` mirrors selection), and `AgentChip`s for active executors.
- Selection: click on the title button calls `onSelect(task.id)`, which is `ui.openTask(id)`. The selected card has a primary-colored border (`data-selected`). Keyboard focus shows a ring through `.card:has(.title:focus-visible)`.
- Keyboard: every card title is a tab stop. There are no arrow keys, no column-to-column keys, no Enter/Space behavior beyond the button's own.
- Drag and drop is the native HTML5 API with a custom MIME type `application/x-clowdy-task` (not `@dnd-kit`, even though the package is installed). Dropping on a column calls `onMove(taskId, statusId)`, which `Screen.move` turns into `task.update { taskId, statusId }` when the status differs. There is no keyboard path to move a card between columns, and no within-column order (cards follow task number).

**List** (`TaskList.tsx`)

- The design system `Table` (RAC `Table`) with `selectionMode="single"`, `disallowEmptySelection`, `selectedKeys=[selectedId]`, and `onSelectionChange` calling `onSelect`. Columns: Key, Title, Status (`StatusPill`), Agents (chips; the cell stops pointer, click, and key events so chip presses do not select the row).
- Rows are flat, sorted by number, with no grouping, no sort controls, and no column options.
- Inference (React Aria default behavior, not exercised here): arrow keys move RAC's own row focus, and selection changes on click or Space/Enter, so focus and selection can differ in the list while they are the same thing on the board. Printable keys are consumed by RAC type-ahead, see `current-keyboard.md`.

### Header, filter, search

- `TasksHeader.tsx`: title, subtitle (`tasksSource(tasks) · project name`), `ToggleButtonGroup` Board|List (`ui.setTasksView`), `SearchInput` (`filter.query`), `FilterPopover`, and a primary "+ Task" button calling `openCreateTask({ root, project, ui })`. No button shows a shortcut hint.
- `FilterPopover.tsx`: RAC popover with status and agent checkboxes and "Clear filters".
- `taskView.ts#filterTasks`: client-side only. The query is a case-insensitive substring over `key + title + description`; statuses and agents are "any of" sets. There is no sort, group-by, saved view, or server-side filtering.

### Detail panel

`DetailPanel.tsx` (`aside`, keyed by task id so it remounts on every selection change):

- Head: key chip and a Close button (`ui.openTask(null)`). Nothing else closes it; Escape does nothing.
- `EditableText variant="title"` and `variant="body"` for title and description, a `Select` for status (`task.update.statusId`), executors, `DependencyList` (add through a searchable `Select`, remove through an X button, open through `ui.openTask`), related chats, results (`useTaskArtifacts` → `getTaskDetail`), latest activity (derived from runs, not stored).
- Foot: `Start` (`task.start`; disabled with a reason when an executor is active; the stage notes record that it still shows on a Done task), `Open in {provider}` when `task.external.url` is a web URL, and `ConfirmButton` Delete (arm, then confirm, `task.delete`, then `ui.openTask(null)`).
- `update(changes)` sends `task.update` and returns `result.ok`. `EditableText` uses that to keep or revert its draft.

### Create dialog

`CreateTaskDialog.tsx` exports `openCreateTask({ root, project, ui })`, which calls `Modal.create(...)`. The modal renders in its own React root (see `current-keyboard.md`), so it receives `root`, `project`, and `ui` as props instead of hooks. Fields: title (autofocus), description, status (default: first `todo` category status), dependencies. It submits `task.create { projectId, title, description?, statusId, dependsOn? }`, then closes and calls `ui.openTask(createdTaskId(result.data))`. Escape and click-outside close it; Enter in the title submits through the `<form>`.

### Commands and mutations

`sendCommand(root, input)` (`features/tasks/commands.ts`): `root.command(input)` then a toast on refusal; returns the `CommandResult`. `RootStore.command` never throws (an unreachable daemon is `{ ok: false, error.code: 'unavailable' }`). `HttpTransport.command` makes the `requestId` once per call and reuses it across its own retries; the daemon returns the first result for a repeated id.

| Action in the UI | Command | Where it is sent |
| --- | --- | --- |
| Change status (select, drag) | `task.update { taskId, statusId }` | `DetailPanel.update`, `Screen.move` |
| Edit title, description | `task.update { taskId, title }` / `{ description }` | `DetailPanel` via `EditableText.onCommit` |
| Add or remove dependency | `task.update { taskId, dependsOn: <whole list> }` | `DetailPanel` |
| Create | `task.create { projectId, title, description?, statusId?, dependsOn?, chatId? }` | `CreateTaskForm` |
| Delete | `task.delete { taskId }` | `DetailPanel.remove` |
| Start work | `task.start { taskId, engine?, force? }` | `DetailPanel.start` |

Command results (the `data` field) are never applied to the store. `task.create|update` return `{ task }`, `task.delete` returns `{ taskId }`, `task.start` returns `{ runId, chatId }` (the UI ignores it and does not navigate to the new chat).

**Optimistic updates: none.** Evidence: `RootStore.command` returns the result only; `ProjectState` changes only in `applySnapshot` and `#apply` (events); no `optimistic`-style code exists in the renderer. Consequences:

- A status change shows after the SSE round trip. The status `Select` is controlled by `task.statusId`, so it keeps the old value until the event arrives. The board card jumps columns only then.
- `EditableText` keeps a local draft and reverts it if `onCommit` resolves `false`.
- There is no undo, no "pending" visual, and no rollback for non-text edits.
- Inference: for repeated single-key actions (move through statuses, mark done on several tasks), the latency of one loopback command per press is small but a second press can race the first event.

### Task domain model (`packages/protocol`, `apps/daemon`)

`Task` (`protocol/src/domain.ts`): `id`, `projectId`, `number` (per-project sequence), `key` (`<taskPrefix>-<number>`), `title`, `description` (plain text), `statusId`, `dependsOn: TaskId[]`, `createdBy: Actor` (`user | run | provider`), `external?: { provider, externalId, url? }`, `createdAt`, `updatedAt`.

`TaskStatus`: `{ id, name, category }`, category one of `backlog | todo | active | review | done | canceled`. The daemon creates five per project (`domain/projects.ts`, `DEFAULT_STATUSES`): To do (todo), In progress (active), Review (review), Done (done), Canceled (canceled). No command adds, renames, or reorders statuses (`project.update` takes only `name` and `settings`).

Task commands (`protocol/src/commands.ts`, handlers in `daemon/src/commands/task.ts`, logic in `daemon/src/domain/tasks.ts`):

- `task.create { projectId, title, description?, statusId?, dependsOn?, chatId? }`. Default status is the first `todo`-category status. Title is trimmed and must not be empty. Dependencies are validated (same project, no repeats, no cycle).
- `task.update { taskId, title?, description?, statusId?, dependsOn? }`. All four fields are optional; an update that changes nothing returns the task without emitting an event. `external` is not patchable.
- `task.delete { taskId }`. A hard delete; removes chat and run links; dependents lose the dependency. No undo, no archive.
- `task.start { taskId, engine?, force? }`. Creates a chat titled after the task, an orchestrator run bound to it, and launches it. Refused with `already_running` when a run is active unless `force`.

Daemon-side behavior that bears on actions:

- Status follows runs: assigned tasks move to the first `active` status when a run starts, to `review` when it succeeds, and back to `todo` when it ends otherwise with no other active run. A run waiting on a dependency starts by itself when the dependency reaches a `done`-category status, by any path. So a human status change can trigger agent work.
- Agent tools (`runs/task-tools.ts`) mirror the same fields; workers cannot set `done` or `canceled`, only the orchestrator can. The UI has no such restriction for the user.
- Events: `task.upserted` (whole task), `task.deleted`, `link.chatTask`, `link.runTask`, `artifact.added`. A snapshot carries the whole task list.
- `GET /v1/tasks/:id/detail` returns `{ taskId, chatIds, runIds, artifacts }` (artifacts are read-only; nothing creates them yet per `apps/daemon/AGENTS.md`).
- The fixture daemon (`renderer/daemon/fixtureTransport.ts`) implements the same four task commands in memory. It does not validate status ids or dependency cycles, and `task.start` is scripted. Its default workflow has six statuses (Backlog, To do, In progress, Review, Done, Canceled; `fixtureData.ts#DEFAULT_STATUSES`, ids `backlog|todo|active|review|done|canceled`) while the real daemon creates five (no Backlog) with generated ids, so status-by-id assumptions can pass in fixtures and fail against the daemon. UI work against `?fixtures` therefore cannot show a daemon refusal for a bad status.

### Gap list: what Linear-style actions need that does not exist

Facts (no design). "Client-only" means the data exists and the gap is only UI.

Fields on `Task`: priority; assignee (the only analog is a run linked `assigned`; there is no user assignee and Clowdy is single-user); labels or tags; estimate; due date; parent task or sub-tasks; sort rank or manual order; archived or trashed flag; completed, started, or canceled timestamps; project, cycle, or milestone; subscribers or favorites; comments; attachments (only read-only `Artifact`s and a single `external` ref); a saved "branch name" or URL (the key exists, so "copy key" is client-only).

Commands: set priority, set assignee, add or remove labels, set estimate, set due date; add or remove one dependency (today the whole list is replaced); `task.duplicate`; `task.archive` and restore; `task.reorder`; bulk update or delete (every command takes one `taskId`, so multi-select needs N commands or a new batch command); move to another project; undo (nothing records previous state; delete is permanent); status CRUD; label CRUD; server-side saved views or filters. Relation types beyond "depends on" (related, duplicate-of) do not exist.

Client-only gaps (data exists): multi-select; a focus cursor separate from the open task; keyboard movement through the board or list; Escape to close the detail panel; a "next/previous task" move; "copy key" or "copy title"; open the linked chat or run from a task (the detail panel lists them; no key); jump to a status from the keyboard; filter hotkey and a way to persist filters; list sort and group-by; peek or preview without opening the panel; toasts that offer undo; command menu; shortcut help.

Useful analogs already present: "assign to an agent" is `task.start`; "mark done" is `task.update.statusId` with the first `done`-category status (logic exists server-side in `statusOfCategory`, but the UI must pick the status itself from `project.statuses`); "move to next status" is index math over `project.statuses`.

## Relevant files

- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — owns filter state, derives columns, selection, `move`; renders header, board or list, detail panel
- `apps/desktop/src/renderer/features/tasks/TasksHeader.tsx` — view toggle, search, filter, "+ Task"
- `apps/desktop/src/renderer/features/tasks/Board.tsx` — columns, native drag and drop, `onMove`
- `apps/desktop/src/renderer/features/tasks/TaskCard.tsx` — card with full-card title button and selected state
- `apps/desktop/src/renderer/features/tasks/TaskList.tsx` — RAC Table, single selection
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx` — title, status, description, dependencies, start, delete; `update` helper
- `apps/desktop/src/renderer/features/tasks/DetailSections.tsx` — executors, related chats, results, activity sections
- `apps/desktop/src/renderer/features/tasks/EditableText.tsx` — draft-then-commit text; Escape drops, Enter blurs (title)
- `apps/desktop/src/renderer/features/tasks/FilterPopover.tsx` — status and agent facets
- `apps/desktop/src/renderer/features/tasks/CreateTaskDialog.tsx` — `openCreateTask`, `CreateTaskForm`
- `apps/desktop/src/renderer/features/tasks/DependencyList.tsx` — dependency rows and add `Select`
- `apps/desktop/src/renderer/features/tasks/commands.ts` — `sendCommand` (toast on refusal)
- `apps/desktop/src/renderer/features/tasks/taskView.ts` — pure helpers: `filterTasks`, `groupByStatus`, `dependencyCandidates`, `startBlockedReason`, `createdTaskId`, `taskActivity`; tested by `taskView.test.ts`
- `apps/desktop/src/renderer/features/tasks/status.tsx`, `Pill.tsx` — `StatusIcon` per category, `StatusPill`
- `apps/desktop/src/renderer/stores/UiStore.ts` — `ProjectUi` selection and view state, persisted per project
- `apps/desktop/src/renderer/stores/ProjectState.ts`, `RootStore.ts`, `hooks.ts` — state, `command`, hooks
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts` — `CommandInput`, HTTP retry, in-memory daemon and its data
- `packages/protocol/src/domain.ts`, `commands.ts`, `events.ts`, `api.ts` — `Task`, `TaskStatus`, command schemas, events, routes
- `apps/daemon/src/commands/task.ts`, `domain/tasks.ts`, `domain/projects.ts`, `db/tasks.ts`, `runs/task-tools.ts` — handlers, validation, default statuses, SQL, agent tools
- `apps/daemon/AGENTS.md` — status-follows-run rules, command result shapes

## Constraints and gotchas

1. Selected equals open. A keyboard cursor that moves without opening the panel needs a new piece of state, or the list's RAC focus must be used for that (see Table below).
2. `Screen` rebuilds `columns` and `visible` on every render from `project.taskList`; the selection is only an id. A hotkey layer must resolve "the current task" from `ui.taskId` plus the visible order (board order is column by column, list order is by number), and handle a missing task and a task hidden by a filter.
3. The filter lives in `Screen` `useState`, so a hotkey layer that is not under `Screen` cannot see it. It would have to move to `ProjectUi` or to a context.
4. `DetailPanel` is keyed by task id, so each selection change remounts it and resets `EditableText` drafts and `isStarting`.
5. Create is an imperative `Modal.create` in a separate React root: no context inside, so `openCreateTask` needs `{ root, project, ui }` passed in.
6. Status changes from a person have side effects in the daemon: reaching a `done` category releases dependent blocked runs; moving a task out of `active` does not stop its run. `task.update` accepts any status id of the project, including from the keyboard.
7. `task.update` with `dependsOn` replaces the whole list, so concurrent edits to dependencies race (last write wins).
8. `task.start` is refused with `already_running` for a task with an active run. The UI computes `startBlockedReason` from `runsOfTask`; a `Start` hotkey should reuse it. The panel currently shows `Start` on Done tasks (noted in `.briefback/mvp/stage-5-6-notes.md`).
9. `description` is plain text in a `Textarea`, not the markdown editor.
10. Board columns are hidden together with the list when `visible` is empty, so "no task to focus" is a normal state.
11. Native HTML5 drag makes every card `draggable`; no keyboard drag exists.
12. Statuses are looked up by id in `project.statuses`; a task whose status was removed shows as "Unknown" and sits in no board column (documented on `ProjectState.tasksByStatus`).

## Open questions

- Should "focused task" (keyboard cursor) and "open task" (`ui.taskId`) be separate state? This research found no precedent in Clowdy. Linear separates them (inference from the product brief; not researched here).
- Which statuses should "mark done", "cancel", and "next status" hotkeys target when a project has custom statuses or several statuses of one category? The daemon picks the first of a category (`statusOfCategory`); the UI has no equivalent helper yet.
- Is multi-select in scope? It requires either N commands per action or a new batch command.
- Should assigning to an agent be exposed as a hotkey, given `task.start` opens a new chat and launches an orchestrator?
- Should `task.start`'s result (`chatId`) navigate to the new chat? Today it does not.
- Delete is permanent with no undo; is a hotkey for it acceptable without an archive or an undo?

## Assumptions and limits

- Read in full: every file under `features/tasks/` except CSS (CSS skimmed for selected and focus styles), `UiStore.ts`, `ProjectState.ts`, `RootStore.ts`, `hooks.ts`, `transport.ts`, protocol `domain.ts`, `commands.ts`, `events.ts`, `api.ts`, daemon `commands/task.ts`, `domain/tasks.ts`, `db/tasks.ts`, `runs/task-tools.ts`, and the part of `fixtureTransport.ts` that handles task commands.
- Read only partly: `fixtureData.ts` (type and a header), daemon `db/migrations.ts` (grep for the status table), `apps/daemon/AGENTS.md` (as supplied by the hook, not re-read line by line).
- Not run: no app, daemon, test, or screenshot was started. React Aria behavior for the Table (focus vs selection, type-ahead) is inferred from library behavior and the `useTypeSelect` source, not observed in this app.
- The callers of `ui.openTask(` were checked by search: `Screen` (board and list select), `CreateTaskForm` (after create), `DetailPanel` (close, delete, open a dependency), and the shared `TaskChip` (from chats and agents). No other code sets `taskId`.
