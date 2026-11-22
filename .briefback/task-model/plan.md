# Task model: hierarchy, comments, archive

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a task can contain tasks (an epic is a task, a stage is a task), tasks carry Markdown comments, and a finished piece of work, with everything under it, can be thrown into an archive. Backend, protocol, agent commands, skills and docs first (Stages 1 to 4), then the desktop UI (Stage 5, authorized by the owner on 2026-11-21). Every shape follows what Linear, GitHub and Jira already do, so an integration later loses nothing (Linear first, its own grill after Stage 4).

**Approach:** Stage 1 adds the hierarchy and the read model that any board or list can be drawn from. Stage 2 adds comments. Stage 3 adds the archive. Stage 4 moves skills, prompts and docs to the new vocabulary and removes what comments replace. Stage 5 draws the views of "UI shape" on the desktop, on top of the finished protocol, in four sub-stages. Each stage is verified, reviewed and committed on its own; Stages 2 and 3 touch the same files as Stage 1, so they run in order; Stage 4 (daemon and skills) and Stage 5 (desktop) share no files and may run side by side once Stage 3 has landed.

**Decisions** (settled with the owner in chat on 2026-11-21 unless marked "default": a detail the agent chose, which the owner may overrule)

- **A task is recursive.** `Task.parentId` (absent for a root). There are no levels or types in the data; "epic", "task", "stage" are naming conventions for skills (an epic does not run, a task is what one orchestrator does, a stage is what is delegated to a thread or sub-agent). The store has no depth limit, only a guard against a cycle in the parent chain. Creating or moving a task through the daemon's commands and tools stops at `MAX_TASK_DEPTH = 8` levels (a root is level 1; GitHub's limit, so an import of any tracker fits), and moving a task with a subtree checks the deepest descendant. The constant lives in `packages/protocol` so the interface can use it.
- **`dependsOn` stays** for ordering between tasks (blocked by / blocks in Linear, GitHub and Jira). "A parent waits for its children" is no longer a dependency: the orchestrator skill uses `--parent`.
- **A closed dependency is resolved: `done` and `canceled` both release the tasks waiting on it** (what GitLab does and what Linear's "resolved" most likely means; the owner agreed). One helper (`isClosedCategory`) serves the list's `ready` and `blocked` filters and the run start gate (`unfinishedDependencies`).
- **`Task.closedAt`** (epoch ms, absent while open): set when the task enters `done` or `canceled`, cleared when it leaves. Linear has `completedAt` and `canceledAt`, and its views have a "Completed issues: past day" option; a future view needs the real closing time, because `updatedAt` moves with every edit. Existing closed tasks get `updatedAt` as their `closedAt`.
- **Deleting a task keeps its children:** they attach to the deleted task's own parent (a root's children become roots), so the structure stays and no depth can grow (default).
- **Parent status is manual, with no auto-close either way** (Linear has both as opt-in team settings; the orchestrator verifies the whole before it sets the parent `done`) (default). A parent shows a roll-up: `children` is the count of its direct children by category (only the non-zero ones), `descendants` the same for the whole subtree (only in `task get`); archived tasks are not counted.
- **Checklists are Markdown in the description, nothing more.** Lines `- [ ]` and `- [x]` (also `*` and `+`, outside fenced code) count: `checklist: { done, total }` appears on a list row and in `task get` when there is at least one. No table, no command to tick an item: an agent edits the description, the UI will toggle the line. The rule for skills: a checklist for the steps one owner takes; a child task for a stage that is delegated, reviewed or blocked on its own and should show on a board.
- **`task list` and `task get` learn the hierarchy.** A row has `parent` (key, absent for a root), `children` and `checklist`. Filters: `parent` (a key: direct children), `under` (a key: every descendant), `roots` (no parent). They narrow the structural scope; `counts` describes that scope (the project when none is given), before the status scope hides anything. The default status scope (open work) and the other filters apply on top, so `--parent CLW-3` lists the open children and `--parent CLW-3 --all` all of them. `task get` lists its direct children as `{ key, title, status }` (at most 50, with a total) and names its parent as `{ key, title }`.
- **`task create` and `task update` take `--parent KEY`.** `update` can also detach (a root again); how the flag is spelled is the implementer's call within the CLI parser's rules, and `--help` says it. Parent in another project, the task itself, a descendant of the task and too deep a result are refused with a message that names the reason.
- **Comments** (`TaskComment`): Markdown `body`, `author` (an `Actor`), `createdAt`, `editedAt` (absent until edited). Agents add and list them (`clowdy task comment KEY <text or stdin>`, `clowdy task comments KEY`, paged like `task list`); the UI will also edit and delete (commands exist from Stage 2, no agent tool for them). `task get` shows the comment count and the latest three, cut short. Comments are not in the project snapshot (they can grow without bound): a read route loads them on demand, an event announces a change. They map one to one to Linear's issue comments. `--append` stays until Stage 4 and is removed there.
- **Archive** (`Task.archivedAt`, epoch ms, absent when not archived):
  - Only closed tasks (`done`, `canceled`). A task that is not closed is refused, unless the call says `cancel`: then it and every open descendant move to the project's first `canceled` status and are archived with it. A task with an active run, or with a descendant that has one, is refused whatever `cancel` says (stop the run first).
  - Archiving a task archives its whole subtree, with one shared `archivedAt`. Every descendant must be closed (or be closed by `cancel`).
  - `task.unarchive` restores a task and the descendants that went with it (the ones with the same `archivedAt`); it is refused while the task's parent is archived (restore the parent).
  - Archived tasks leave the snapshot, `task list` (default and `all`), `counts` and the roll-ups; `task list --archived` shows only them. They stay resolvable by key (`task get`, mentions, dependencies; a dependency on an archived task is resolved). `task list` carries `archived`, the number of archived tasks, beside `counts`. `task.start` refuses an archived task. The snapshot excludes them; a read route pages them for an archive view.
  - No automatic archive and no time window now (the owner will define "ready to archive" later). Agents archive with `clowdy task archive KEY... [--cancel]` and restore with `unarchive`.
  - In a project bound to Linear later, archive is a local flag over the cached row: nothing is sent to Linear (Linear has no manual issue archive, only an automatic one).
- **Review stays as it is:** the `review` category and the automatic move of a finished run's task into it remain; named reviews are lines of the checklist; nothing blocks `done`. No review entity, no labels.
- **Out of the Linear shape on purpose:** initiatives, cycles, milestones and issue types. A Linear Project is not a task: a Clowdy project will bind to a Linear team plus a project (decided, built later).

## UI shape (Stage 5, not built; settled with the owner in chat on 2026-11-21, recorded so the backend stays enough)

One view is drawn from a **scope**: a task, or nothing for the project root. The same component serves the project screen and the page of any task, so any task with children becomes a "project" of its own when the person wants it, and all view logic is reused. Views:

- **Through board:** every task of the scope flattened onto one board (Linear's board with "show sub-issues" on, every descendant whatever its depth); rows by parent are an option. Data: `under`.
- **Board of one level:** only the direct children of the scope (Linear with "show sub-issues" off); a card with children carries a roll-up chip (`2/5`) from `children`. The project root is the board of root tasks and exists even when no task has children, so a root card appears once, with no "No parent" group and no duplicate. Data: `parent` or `roots`.
- **List as a tree:** roots with their children indented, a status label on each row, children sorted by status within their parent. Data: the same tasks with `parent`.
- **Task page:** a task with children shows its own children as a board or a list (the person chooses), the same views as above scoped to that task, with breadcrumbs to its ancestors.

Also from the data: a "completed in the last N days" view option from `closedAt`; checkbox toggling from the checklist lines; an archive drop target and a menu action from `task.archive`; the archive view from the archived-tasks route. The desktop treats only `done` as resolved in `features/tasks/DependencyList.tsx` (`isDone`): Stage 5a makes it follow `isClosedCategory`, and `taskUndo.ts` learns `parentId`. `features/chats/progress.ts` already leaves canceled tasks out of the total, so it stays.

**Reuse:** `createsCycle` and `checkDependencies` (`domain/tasks.ts`) as the model for the parent-chain guard; `queryTasks` and `TaskQueryContext` (`domain/taskQuery.ts`); `describeTask`, `resolveStatus`, tool schemas (`runs/task-tools.ts`); `ToolDefinition.cli` and `cli.stdin` (comments take text from stdin like `thread tell`); `store.tx` and `store.emit`; migrations in `db/migrations.ts`; the `task.upserted` event for field changes.

## Out of scope

- A "completed in the last N days" view option and swimlane rows by parent (the data supports them; the first UI does not draw them).
- The Linear provider (binding, sync, mapping of statuses, keys, comments; asking what to do with local tasks when a project is bound): its own research and grill after Stage 4.
- Editing a project's statuses, labels, priority, estimates, assignees, due dates, time windows for closed tasks, automatic archiving, a review entity or review gates.

## Stage 1 — Hierarchy, closing time, resolved dependencies

**Depends on:** none.

- [x] Migration: `tasks.parent_id` (nullable, same table, index on it), `tasks.closed_at` (nullable), backfill `closed_at` from `updated_at` for tasks in a `done` or `canceled` status. Row mapping and `upsertTask` in `db/tasks.ts`.
- [x] Protocol: `Task.parentId?`, `Task.closedAt?`, `MAX_TASK_DEPTH`; `task.create` takes `parentId`, `task.update` takes `parentId` (nullable to detach). A test of the schemas.
- [x] Domain: `createTask` and `updateTask` validate and set the parent (same project, not itself or a descendant, depth limit with the subtree's height) and maintain `closedAt` when the category changes; `deleteTask` re-attaches children to the deleted task's parent and emits their updates; `isClosedCategory` replaces the `done`-only checks (`taskQuery.ts`, `runs/service.ts`).
- [x] Read model: `checklist` parser, `parent`, `children` on rows; `parent`, `under`, `roots` filters; `counts` over the structural scope; `task get` with parent, children, `descendants`, `checklist`.
- [x] Tools and CLI: `parent` on `task_create` and `task_update` (detach spelled by the implementer), `parent`, `under`, `roots` on `task_list`, help text and `EXAMPLES` in `cli/clowdy.ts`, prompt length caps if the `Tasks:` line grows.
- [x] Tests: unit tests of the parent rules (cycle, depth, other project, reparent a subtree over the limit), `closedAt` on every way into and out of a closed status, delete re-attaches, the new filters and `counts`, a cancelled dependency releasing its dependents (list `ready`/`blocked`, run start gate), checklist parsing (code fences, nested bullets), the tools' output shape.

**Done when:** `clowdy task create --parent`, `task list --parent|--under|--roots` and `task get` behave as specified against a real database in tests; `bun test` in `apps/daemon`, `bun run typecheck` and `bun run lint` pass for the files touched; the desktop still typechecks (new fields are optional there).

**Landed:** `05976f4` feat(daemon): let tasks contain tasks, record when they close, and release dependents on cancel (reviewed by a separate agent; no defects, two tests and three stale "Done" statements fixed). Choices made in the stage: detach is `--clear-parent`; `task get` has `children` (list, at most 50) with `childrenTotal`, `descendants` and `checklist`; `parent`, `under` and `roots` are given one at a time; a task created in a closed status gets `closedAt = createdAt`; parent validation runs only when the parent changes.

## Stage 2 — Comments

**Depends on:** Stage 1 (it edits the same migration, protocol and task-tools files).

- [x] Migration: `task_comments` (`id`, `task_id` with `ON DELETE CASCADE`, `author` JSON, `body`, `created_at`, `edited_at`, index on `task_id, created_at`). `db/taskComments.ts`.
- [x] Protocol: `TaskComment`, commands `task.comment.add`, `task.comment.edit`, `task.comment.delete`, an event for a comment changing, a read route for a task's comments (paged); names follow the neighbouring commands and routes.
- [x] Domain: add (author from the caller: the person, or the run), edit (sets `editedAt`), delete; a deleted task takes its comments with it; the comment count and the latest three in `task get`.
- [x] Tools and CLI: `task_comment` (add; text as the positional words, `--body-file -` or stdin for a heredoc) and `task_comments` (paged list, oldest first with a cursor); examples and help.
- [x] Tests: every command, authorship by the person and by a run, paging, cascade on task delete, the shape in `task get`, the stdin path.

**Done when:** an agent can leave and read comments through the shell command and the UI-facing commands exist and are tested; checks as in Stage 1.

**Landed:** `bede769` feat(daemon): add Markdown comments to tasks, for the person and for agents (reviewed by a separate agent; no defects, one test added; the two skills-vocabulary tests were kept green by naming `task comment` and `task comments` in the validator and the orchestrate skill, the rest of the skills pass is Stage 4). Choices made in the stage: events `task.comment.upserted` and `task.comment.deleted` (a task delete emits only `task.deleted`); edit and delete take `taskId` and `commentId`, the person may edit or delete any comment; a body is kept less trailing whitespace; the route is `GET /v1/tasks/:id/comments` oldest first, cursor `<createdAt>.<id>`; `task_get` shows `commentCount` and `latestComments` (last three, 300 characters); the fixture transport answers `unavailable` for the comment commands until Stage 5a; a comment does not touch `Task.updatedAt` (revisit with the Linear mapping). For Stage 5: a long thread may want a newest-first or end-anchored read (an `order` parameter on the route), and an agent comment's run may be gone, so its link can dangle.

## Stage 3 — Archive

**Depends on:** Stage 1 (parents and subtrees), Stage 2 only for the shared files.

- [x] Migration: `tasks.archived_at` (nullable). `listTasks` excludes archived rows; a function pages the archived ones.
- [x] Protocol: `Task.archivedAt?`, commands `task.archive` (`taskId`, `cancel?`) and `task.unarchive` (`taskId`), a read route for archived tasks (paged). A change reaches clients as `task.upserted` carrying `archivedAt`; a client treats a task with `archivedAt` as off the board.
- [x] Domain: archive and unarchive with the rules above (closed only, `cancel`, active runs refuse, subtree with one `archivedAt`, restore with the same `archivedAt`, refuse under an archived parent); `task.start` refuses an archived task; archived tasks do not count in `children`, `descendants` or `counts`, and an archived dependency is resolved.
- [x] Tools and CLI: `task_archive` (`taskId` list, `cancel`) and `task_unarchive`; `task_list --archived` and the `archived` number in the answer; `task_get` works on an archived task and says so.
- [x] Tests: each rule, the batch restore, a refused unarchive, `cancel` over a subtree, the active-run refusal, exclusion from snapshot, list and counts, a dependency on an archived task, `--archived`.

**Done when:** a finished tree can be archived and restored through the commands and the shell, with the exclusions above verified; checks as in Stage 1.

**Landed:** `0747ba3` feat(daemon): archive finished task trees, and restore them (reviewed by a separate agent: one defect fixed, a restore reached a task that had been moved under another archived task; weak tests rewritten). Choices made in the stage: `--archived` swaps the base set to archived tasks, shows every status by default, and `parent`/`under`/`roots` pick among archived tasks (`roots` there is the top of an archived piece: no parent, or a parent that stayed on the board); the route is `GET /v1/projects/:id/archived-tasks` newest archived first, `TaskArchivePage { tasks, total, nextCursor? }`, cursor `<archivedAt>.<number>`; `task.archive` answers `{ task, archived, canceled }`, `task.unarchive` `{ task, restored }`, both idempotent; `archivedAt = max(now, latest in the project + 1)` so no two batches share a value, and a restore follows only tasks that carry the batch value, reached through batch members; the tools exempt the calling run from the active-run refusal (an orchestrator cannot stop its own run first), the person's command has no exemption; several keys in one tool call run in one transaction, nearest the root first; a board task cannot be created or moved under an archived parent, an archived task cannot be reopened by `task.update`, and `thread_spawn` refuses an archived task; archive and unarchive keep `updatedAt` (except tasks `cancel` changes); roll-ups count the same side (board tasks count board descendants); a positional field of array type in the CLI takes all remaining bare words; `task_get` on an archived task says `archived: true`. For Stage 5: the snapshot still carries chat and run links to archived tasks (ids with no task row), `ProjectInfo.tasks` still counts archived tasks (right for "what deleting the project removes"), and a client has no way yet to read one archived task by id: Stage 4b adds `task` to `TaskDetail`.

## Stage 4 — Skills, prompt, docs, and what the desktop needs from the daemon

**Depends on:** Stages 1 to 3.

- [x] `packages/system-skills`: the orchestrate skill splits work with `--parent` (not `--add-depends-on` on the bound task), says when a checklist beats a child task, leaves notes as comments (`task comment`) instead of `--append`, and says when to archive (when the manager says the work is finished and will not be revisited; never open work without `--cancel` and a reason). The other skills that mention `--append` follow, and so does the README (it lists only four task commands and says `--ready` means dependencies Done). Validator `TASK_COMMANDS`, the vocabulary test.
- [x] Remove `append` from `task_update` (strict schema, so a stale call errors) once nothing in skills or prompts uses it; its tests and help go with it.
- [x] `Tasks:` prompt line and `taskMessage` if they need a word about parents, comments or archive; prompt length caps.
- [x] `apps/daemon/AGENTS.md`: read the Tools, task model, comments and archive paragraphs as one piece and make them consistent (Stages 1 to 3 each added a bullet), and the depth limit.
- [x] Stage 4b, for the desktop: `TaskDetail` (`GET /v1/tasks/:id/detail`) carries the `task` itself, archived tasks included, so a client can open one it does not hold; the checklist parser (`apps/daemon/src/domain/checklist.ts` with its test) moves to `packages/lib` (consumed as source) and the daemon imports it from there, so the daemon and the desktop share one.
- [x] `.briefback/task-cli/plan.md` stays as history; this plan records the commits.

**Done when:** no skill, prompt or doc names a removed or replaced command; the skills vocabulary test passes against the real tools; `TaskDetail.task` and the shared parser are tested; the daemon tests pass.

**Landed:** `f40368f` feat(skills): teach the task hierarchy, comments and archive, and drop task append (reviewed by a separate agent: five wording defects fixed, bundle and lockfile checked). Choices made in the stage: `--append` is also forbidden by the skills validator; `taskMessage` unchanged (`task get` carries the parent, children and latest comments); the `TASKS` prompt line grew by 46 characters inside the caps; the daemon imports `@clowdy/lib/checklist` by subpath only (the root index pulls in React and DOM code) through a new `workspace:*` dependency; the fixture's `getTaskDetail` answers 404 for an unknown task like the daemon; the autopilot blocker still goes at the top of the description. Open small items: `apps/desktop/scripts/dev.ts` watches whole folders, so an edit to `packages/lib/src/checklist.ts` does not restart a dev daemon; a lint rule against importing the `@clowdy/lib` root in the daemon would catch a bundling mistake early; an agent ticks a checklist line by sending the whole description, which can race a person's edit once the UI toggles checkboxes (revisit if it shows up).

## Stage 5 — Desktop UI

Facts about the desktop that shape the work (mapped 2026-11-21; `R` = `apps/desktop/src/renderer`, `T` = `R/features/tasks`): the store changes only when the daemon's event arrives (no optimistic updates), tasks live in `R/stores/ProjectState.ts`, the view mode is `ProjectUi.tasksView` in `R/stores/UiStore.ts`, a task opens in the inline `DetailPanel`, the board is hand-written HTML5 drag and drop, the list is a flat RAC `Table`, `ListCursor` walks `taskGrid`, commands are hotkeys in `T/taskCommands.ts` (a new key must not collide: `R/hotkeys/keymap.test.ts`), tests are vitest with `// @vitest-environment happy-dom` and the `FixtureTransport` (no testing-library), and `FixtureTransport` currently ignores `parentId` and applies updates blindly. `MarkdownEditor` (`packages/components`) supports GFM task lists and toggles a checkbox in place when editable; the read-only viewer `R/stream/Markdown.tsx` has no toggle. Read `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md` before any UI work; `DESIGN.md` is the visual language. The sub-stages run in order (they share `Screen.tsx`, `DetailPanel.tsx` and `taskCommands.ts`). Visual checks are the owner's: the stages are verified by tests with the fixture transport, typecheck and lint.

**Depends on:** Stages 1 to 3.

### Stage 5a — Data layer and view logic

- [x] Use the shared checklist parser of `packages/lib` and `TaskDetail.task` (Stage 4b); the store ignores chat and run links whose task it does not hold (archived tasks).
- [x] `ProjectState`: a task with `archivedAt` leaves the `tasks` map (the snapshot has none); transport methods for a task's comments and for archived tasks in `HttpTransport`, `FixtureTransport` and the test override helper; comment events reach whoever shows them (the revision pattern of `useTaskArtifacts`).
- [x] `FixtureTransport` parity with the daemon: `parentId` on create and update (same-project, self, descendant, depth) with `null` detaching, `closedAt` set and cleared, delete re-attaching children, archive and unarchive with the subtree rules, comment commands and the read route; demo data with a parent, children and a grandchild (`fixtureData.ts`).
- [x] `taskView.ts`: pure functions for a scope (a task id or none): direct children, all descendants, the visible rows of a tree (collapsed ids, children sorted by workflow status order then number), roll-up of descendants (`done` counts as done, `canceled` is left out of the total, as `chats/progress.ts` does), checklist progress of a task, depth-aware parent candidates (not itself, not a descendant, `MAX_TASK_DEPTH`), the ancestors of a task for breadcrumbs; the filter applies in every view.
- [x] `DependencyList.isDone` follows `isClosedCategory`; `taskUndo.ts` carries `parentId` (`null` detaches) and `sameValue` handles it; `UiStore`: the scope of the Tasks screen, `tasksSubtasks` (show sub-tasks flattened), the task page's own mode, all persisted per project like `tasksView`; `NavHistory` records the scope so back and forward restore it.
- [x] Tests for all of the above (pure logic, store handling of archived and comment events, fixture rules, undo, ui persistence and history).

**Done when:** the pure logic and the stores are tested, the fixture daemon behaves as the real one on every new rule, nothing on screen changed yet except `DependencyList`; `bun run test`, typecheck and lint of `apps/desktop` and `packages/lib` pass.

**Landed:** `b7a95a3` feat(desktop): give the app the data layer for sub-tasks, comments and the archive (reviewed by a separate agent: the fixture's task numbers no longer reuse a deleted one, paged reads clamp `limit` like the daemon, a quadratic tree build fixed, vacuous tests removed). That commit also carries three deletions staged by another agent (`packages/file-manager/src/react/Highlighted.tsx` and `search/SearchView.tsx`, `SearchView.module.css`): `git commit` took the whole index; until that agent commits its `FileManagerView.tsx` (no longer importing them) the committed file manager does not compile. Choices made in the stage: the pure tree logic is in the new `features/tasks/taskTree.ts` (not `taskView.ts`); new demo tasks are CAR-31 to CAR-40 (next key CAR-41); the fixture answers `{ task }` and `{ taskId }` like the daemon; `resolveTasksScope` is read-time and writes nothing; `NavHistory` skips entries whose scope is gone; `taskTree.rows` moves a kept task whose parent is filtered out to the nearest kept parent; `commentsRevision` also changes for every task when a snapshot is taken in again; `tasksCollapsed` is capped at 200. Open items carried on: 5b must write the resolved scope (`replacing(() => ui.setTasksScope(null))`) when the screen finds its scope gone and the person then acts, or Back cannot return to that place; `NavHistory.#exists` and the dependency row need `getTaskDetail(id).task` for archived tasks (5d); `openTask` leaves the scope alone, so 5b decides what a task opened from elsewhere does when it sits outside the scope; the fixture's `#startTask` moves any task to Active and Review (the daemon moves only todo or backlog, and only active); `Screen.test.tsx` still says "CAR-20 to CAR-30".

### Stage 5b — Views

- [ ] The Tasks screen takes a scope: breadcrumbs (project, then the ancestors), a compact scope header (key, title, status, roll-up, buttons "New sub-task" and "Details") and the same board or list below. The project root is the board of root tasks (a card appears once; no "No parent" group).
- [ ] Modes: board of one level (default), through board (the "show sub-tasks" toggle: every descendant flattened onto the scope's board), list as a tree (roots with children indented, chevrons to fold, status label on each row, children sorted by status within a parent). The header controls: Board or List, and the sub-tasks toggle for the board. `taskGrid` returns the visible rows of the tree so `ListCursor` and the keys work in every mode.
- [ ] Cards and rows: a roll-up chip (`2/5`) when a task has descendants, a checklist chip (`3/8`) when its description has items; clicking the roll-up chip, or `Enter` on the row with the scope key (see `taskCommands.ts`), or "Open sub-tasks" in the details, opens the task's own scope; breadcrumbs and a "go up" key return.
- [ ] The empty states for an empty scope, and when a filter hides everything; the new keys are added to `taskCommands.ts` and pass the keymap collision test.
- [ ] Tests through `Screen.test.tsx` and new view tests (scope, each mode, toggles, chips, keys, persistence, history).

**Done when:** every view of "UI shape" works against the fixture transport in tests and survives a project switch and a reload (persistence); checks as in 5a.

### Stage 5c — Task details: parent, sub-tasks, checklist, comments

- [ ] `DetailPanel`: a "Parent" row with a picker (depth-aware candidates, "No parent" to detach) sending `task.update` with `parentId` through `sendWithUndo`; a "Sub-tasks" section listing the direct children with status and the roll-up, each opening its own details; "New sub-task" opens `CreateTaskDialog` with `parentId` (the dialog also shows and can change its parent); `c` on a scoped screen creates a task in that scope.
- [ ] The description becomes a `MarkdownEditor` so checklist lines are checkable in place (saved on change, like the old textarea on blur); a progress bar or chip under the title from the checklist.
- [ ] A "Comments" section: the comments in Markdown (viewer), a composer with a Markdown editor, edit and delete on the person's own comments, an author label (the person, or the agent run with a link), time and an "edited" mark; loaded on demand and refreshed by the comment event.
- [ ] Tests for the parent picker and undo, the sub-task section, the dialog with a parent, checklist toggling writing the description, comment add, edit and delete.

**Done when:** a person can build and reshape a tree, tick a checklist and comment, all through the UI against the fixture transport in tests; checks as in 5a.

### Stage 5d — Archive

- [ ] A context menu (and a details-panel menu) on cards and rows: "Archive" for a closed task (its subtree goes with it), "Cancel and archive" for an open one with a confirmation naming how many open tasks it cancels, "Restore" in the archive view; a key for archive that passes the keymap test.
- [ ] Drag a card onto an "Archive" target that appears while dragging (hand-written drag and drop like the columns); the same confirmation for open tasks.
- [ ] An archive view of the Tasks screen (a header toggle): the archived tasks paged from the read route, as a tree with restore, read-only otherwise; archived tasks show nowhere else, and a mention or dependency on one still resolves by key and opens it.
- [ ] Archive and restore are undoable through the toast like other task changes; errors from the daemon (a run is active, an unrestorable child) are shown as the toast the app already uses.
- [ ] Tests: the menu, the drop target, confirmation, the archive view with paging and restore, undo, exclusion from every other view.

**Done when:** a finished tree can be archived by menu and by drag, found in the archive and restored, with the daemon's refusals surfaced; checks as in 5a. The owner then looks at the result.

## Later (not authorized by this plan)

- Stage 6, the Linear provider: its own research (relation behavior of a cancelled blocker, archived issues in the API, OAuth scopes for creating a project, a native redirect URI), a grill, and a plan.
