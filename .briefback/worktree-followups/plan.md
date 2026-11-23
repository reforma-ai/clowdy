# Manage worktrees and the Fork menu

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** a person sees every worktree of a project's folders in one dialog, opened from wherever they meet a worktree, and removes the ones they no longer need with the branch as a separate choice; the branch prefix is theirs to set; and the Fork icon on an answer opens a menu that forks the session or hands the conversation to another agent.

**Approach:** the daemon learns to describe a project's worktrees (what git lists, with the chats that work in each, how many files are changed, whether the work is in the base) and to remove one by path, with the chat's own removal sharing that routine. The renderer gets one dialog, `openManageWorktrees`, an imperative opener like `openFolderWorkspace`, and four small entry points that call it. The Fork menu is renderer work on top of today's `chat.fork` and the existing hand-off draft.

**Research:** none written. Grill: `.briefback/worktree-followups/handoff.md` (rounds 1 to 3 are settled in this chat; this plan's Decisions are the result). Background: `.briefback/chat-worktrees/plan.md` (the finished feature) and `.briefback/git-integration/plan.md` (another chat's work, in progress, which reads the same worktrees).

**Decisions** (the owner's, from the chat of 2026-11-23)

- Worktree management is one dialog, **Manage worktrees**, not a page and not a tab in the right panel. One function opens it for every entry point: `openManageWorktrees({ root, projectId, folderId? })`, a `Modal.create` like `openFolderWorkspace`.
- Entry points: a label of the current place on top of the Files tab (a click and a Manage button open the dialog); a "Manage worktrees" item in the menu of a folder's title in the left sidebar when chats are grouped by folder; a Manage button in the Info tab's Worktree row; a Manage button in the new-chat page's worktree picker.
- The dialog shows the worktrees of **all folders of the project**, grouped by folder (a folder that is not a git repository has no group). A group starts with the **folder's own checkout**: its current branch, whether it is clean, and no Remove.
- Below it, a row for **every worktree git lists** for that folder, found ones (Orca, by hand) included: branch (or detached), the chats that work in it (archived ones too, a click opens the chat), clean or the number of changed files, merged or `not merged`, and the path. No disk size.
- **Merged** is the ancestor check of the chat-worktrees plan: HEAD and the branch are in the worktree's base (the folder's default branch when it has no recorded base) as last fetched. A squash merge shows as `not merged`, and the tip of the label says so.
- Row actions: Open in Finder, Terminal and the editor (`OpenWithMenu`), **New chat in this worktree** (a new-chat draft in that worktree, whose tree switches as it does when a worktree is picked on the new-chat page), and Remove. The folder's own checkout has the same actions with **New chat in this folder** and no Remove.
- The side panel's place always matches the chat or the draft that is open. There is no "Open here", no folder switcher in the tabs and no tree of several roots: to look at folder B, start or open a chat there.
- A worktree that git lists but whose folder is gone from the disk is marked `missing on disk` and has **Remove record** (that worktree's record only, nothing else git has stale).
- **Remove** works on any worktree except the folder's own checkout and a locked one, with a confirmation, whoever made it. It is unavailable while a chat (an archived one included) works in the worktree, and the row lists those chats. A worktree with uncommitted changes (a new file counts, and so does an initialised submodule) is removed only through a red confirmation, `Discard N changed files and remove`, which runs `git worktree remove --force`.
- The branch is a separate checkbox, `Delete branch N`, for any branch whatever its name. It is on by default when the branch is merged and off when it is not; an unmerged branch carries a `not merged` label with a tip that its changes are lost when the branch goes. A detached HEAD whose commits are on no branch gets the same warning. Removing the worktree and keeping the branch loses no commit.
- The removal check moves from the chat to the worktree. The chat delete dialog keeps its checkbox and what it allows (Clowdy made it, clean, merged, no other chat) and shares the removal routine; the `managed` flag no longer decides anything for the Manage dialog.
- The branch prefix is **one app-wide setting**, `clowdy` by default, that only new worktrees use. Branches are never renamed. The daemon has no app-wide settings (all are renderer-only, in `localStorage`), so the app sends the prefix with `chat.create`.
- The Fork icon on an answer opens, **on click and not on hover**, a menu of two items: `Fork` (the session copy, as today) and `Fork to another agent…`, which opens a list of the other available agents.
- A choice in that list opens a **new-chat draft** on that agent with its default model, as hand-off does today: the text filled in, the conversation up to and including that answer attached as a markdown file, the worktree kept, the folder kept. The person changes the model, the worktree or the prompt in the draft, sends it, or closes it and nothing is left. The hand-off of a read-only chat's notice stays and shares the code.
- UI text has no closing period (`AGENTS.md`).

**Defaults I took** (the owner may change them)

- A thread's own worktree (`clowdy thread spawn --worktree`) is made by the daemon with no renderer in the way, so it keeps the default prefix `clowdy`.
- The dialog reads when it opens and when the window gets focus again, and does not poll. Git is asked with bounded concurrency and timeouts, as `folderGit` is.
- Info shows Manage only in the Worktree row, which a chat in Project checkout does not have; the Files label covers that chat.
- `Fork to another agent…` lists only agents that are signed in and not the chat's own.

**Reuse:** `parseWorktrees`, `ListedWorktree`, `folderGit`, `baseOf`, `defaultBranchOf` (`apps/daemon/src/git/state.ts`); `gitRead`, `gitOutput`, `gitLine` (`apps/daemon/src/domain/git.ts`); `listWorkspacesOfProject`, `getWorkspace`, `chatsOfWorkspace`, `deleteWorkspace` (`apps/daemon/src/db/workspaces.ts`); `openWorkspace`, `exclusive`, `mustGit`, `samePlace`, `pathKey`, `workspaceLayout` (`apps/daemon/src/domain/workspaces.ts`); `markRemoving`, `isBeingRemoved`, `pruneEmptyParents`, `checkRemoval`, `removeChatWorkspace` (`apps/daemon/src/domain/workspaceRemoval.ts`); `workspace.open` (`packages/protocol/src/commands.ts`, `apps/daemon/src/commands/workspace.ts`); `chat.fork`, `prepareFork` (`apps/daemon/src/runs/fork.ts`); `openFolderWorkspace` (`features/settings/projects/FolderWorkspaceDialog.tsx`) and `openConfirmModal` (`features/chats/deleteChat.tsx`) for the dialog pattern; `OpenWithMenu` (`features/openWith/OpenWithMenu.tsx`), `useFolderGit`, `currentPlace`, `ui.openDraft` (`stores/UiStore.ts`), `startHandoff` (`features/chats/handoff.ts`), `forkChat`, `useFork`; `Menu`, `MenuTrigger`, `SubmenuTrigger` (`packages/components/src/List/Menu.tsx`, the model is `List/AppearanceSubmenu.tsx`); `swipeReplyPreference.ts` as the shape of an app-wide preference. Desktop paths are under `apps/desktop/src/renderer/`.

## Out of scope

- "Open here", a folder switcher in the Files and Docs tabs, a tree with several roots.
- Disk size of a worktree.
- Recognising squash merges and merges on the remote that are not fetched (a `gh` or fetch based check).
- `Fork into new worktree`; Fork or hand-off from the chat's menu (only from an answer, besides the read-only notice).
- A per-folder branch prefix and a daemon-side app-wide settings store.
- Renaming existing branches when the prefix changes.
- A Manage button for a chat in Project checkout inside Info.
- A Workspaces page in Settings.

## Execution

Each stage runs in its own worktree (GITFLOW, Worktrees) and is merged into `next` by the coordinator when its review is done. The shared tree holds another agent's uncommitted git-integration work in `routes.ts`, `domain/git.ts`, `protocol/src/api.ts`, `protocol/src/index.ts` and the desktop `daemon/*Transport*.ts`, so a merge that touches them waits until those files are committed. Stages 1, 3 and 8 start together. Stage 4 starts from Stage 1's first commit (the contract), not from its end. Stages 2 and 6 start when their dependency lands, and Stage 5 needs both 2 and 4. Stage 7 also waits for the "one control" branch (`worktree-agent-ab7b3603ed54da2a6`, `4fe71a9`, `fb4fa98`) to be merged into `next`: until then do not edit `WorkspaceChips.tsx`, `ChatFolder.tsx`, `ChipTrigger.tsx` or `DraftChat.tsx`.

## Stage 1 — What the daemon knows about a project's worktrees

**Depends on:** None.

**This stage:** the Manage dialog needs, per folder, the folder's own checkout and every worktree git lists, with who works in each and how far it is from the base. `GitWorktree` from `folderGit` drops prunable entries and says nothing about locks or chat use, so this stage adds one read for the whole project. Its first commit is the contract (types, the route, the transport method and the fixture), so Stage 4 can start from it.

- [ ] Complete
  - [ ] The contract commit: `ROUTES.projectWorktrees` (`GET /v1/projects/:id/worktrees`), `FolderWorktrees { folderId, name, isRepository, worktrees: WorktreeInfo[] }` with the folder's own checkout first, `WorktreeInfo { path, branch?, head, main, missing, locked?, changes, submodules, merged?, base?, workspaceId?, managed, chats: { id, title, archived }[], blocked?: 'main' | 'locked' | 'chats' }` (`changes` is the number of uncommitted files, a new file counted, 0 when clean; `merged` is absent when no base resolves); `getProjectWorktrees(projectId)` on the transport interface, the HTTP transport, the `unconfigured` stub and the fixture, with fixture data for a project of two repositories (a Clowdy-made worktree with a chat, a found dirty one, a locked one, a missing one) and a plain folder
  - [ ] The daemon answers it from `git worktree list --porcelain` (prunable and locked kept), the project's `workspaces` rows and their chats, per-worktree `status` and ancestor checks run with bounded concurrency and timeouts, and a folder gone from the disk or not a repository answered as such
  - [ ] `isMerged` and `commitOf` become shared (exported from `git/state.ts`), so removal and this read use one definition of merged
  - [ ] Tests on real repositories: main checkout first, a found worktree, a Clowdy-made one with two chats (one archived), a locked one, one whose folder was deleted, a dirty one with a new file, a merged and an unmerged branch, a detached HEAD, a plain folder

**Files**

- `packages/protocol/src/api.ts` — `ROUTES.projectWorktrees`, `WorktreeInfo`, `FolderWorktrees` (beside `FolderGit`)
- `apps/daemon/src/domain/worktrees.ts` — create: `projectWorktrees`, `inspectWorktree`; it cannot join `workspaceRemoval.ts` (the chat's removal, a write path) or `git/state.ts` (git facts with no database or chats)
- `apps/daemon/src/git/state.ts` — `parseWorktrees`, `ListedWorktree` reused; `isMerged`, `commitOf` moved here from `workspaceRemoval.ts` and exported; a changed-files count beside `isDirty`
- `apps/daemon/src/domain/workspaceRemoval.ts` — imports `isMerged`, `commitOf` from `git/state.ts`
- `apps/daemon/src/http/routes.ts` — the route
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts`, `fixtureData.ts`, `config.ts`, `projectsTransport.test.ts` — `getProjectWorktrees`
- `apps/daemon/test/worktrees.test.ts` — create: a new subject (`git-state.test.ts` is about one folder's git)
- `apps/daemon/AGENTS.md` — the route and what a row carries

**Done when:** for a project with a repository holding a Clowdy-made worktree used by two chats, a dirty found worktree, a locked one and one whose folder is gone, and a plain folder, the route lists the main checkout first and each worktree with its chats, changed-file count, merged flag and blocked reason, and the plain folder has no group.
**Verify:** `cd apps/daemon && bun test test/worktrees.test.ts test/git-state.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/daemon && bun run typecheck`
**Commits:** None yet.

## Stage 2 — Remove a worktree

**Depends on:** Stage 1.

**This stage:** a worktree is removed by path, not through a chat. `checkRemoval` is built on a chat; this stage pulls the worktree's own rules out of it and adds the command the dialog calls. The rules differ from the chat's: uncommitted changes and unmerged work are no longer refusals but choices (`discard`, `deleteBranch`), while a locked worktree, the folder's own checkout and a worktree a chat works in still refuse. The chat delete dialog's checkbox keeps what it allows today and goes through the same routine.

- [ ] Complete
  - [ ] `checkWorkspaceRemoval` takes a worktree (a record or a path git lists) and the chat ids that are allowed to use it; `checkRemoval` becomes the strict chat-delete caller of it
  - [ ] `workspace.remove { projectId, folderId, path, discard?, deleteBranch? }`: finds or opens the row (`openWorkspace`) so a turn is kept out by `markRemoving` as it is for a chat's removal, runs under `exclusive` by path, `git worktree remove` with `--force` only when `discard` is true and the tree is changed, `branch -D` when `deleteBranch` is true and the branch is not checked out in another worktree, `pruneEmptyParents` below `workspacesDir`, deletes the row
  - [ ] Refusals with a reason: the folder's own checkout, a locked worktree, a worktree a chat (an archived one included) works in, a changed tree without `discard`, a path git does not list for that folder
  - [ ] A worktree whose folder is gone: the command removes that worktree's record only, and another stale record of the repository is still there afterwards
  - [ ] The fixture transport answers the command; `chat.delete` with `removeWorkspace` behaves as before

**Files**

- `apps/daemon/src/domain/workspaceRemoval.ts` — `checkRemoval`, `removeChatWorkspace`: `checkWorkspaceRemoval`, `removeWorktree`
- `packages/protocol/src/commands.ts` — `commandSchema`: `workspace.remove`
- `apps/daemon/src/commands/workspace.ts` — the async handler; `apps/daemon/src/commands/index.ts` — `AsyncHandlers`; `apps/daemon/src/commands/context.ts` — `AsyncCommandType`
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — answers `workspace.remove` beside `workspace.open`
- `apps/daemon/test/worktree-removal.test.ts` — create: removal by path is a new subject; `chat-workspace-removal.test.ts` is about a chat's delete
- `apps/daemon/AGENTS.md` — the command and the rules
- `.briefback/chat-worktrees/plan.md` — Out of scope: the lines that say agents' worktrees are never removed and that a Workspaces page is later now point here

**Done when:** `workspace.remove` removes a found, clean worktree and keeps its branch, removes the branch too with `deleteBranch`, removes a dirty one only with `discard`, and refuses the folder's own checkout, a locked worktree and one a chat works in; the chat delete tests still pass.
**Verify:** `cd apps/daemon && bun test test/worktree-removal.test.ts test/chat-workspace-removal.test.ts test/chat-workspaces.test.ts test/worktrees.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/daemon && bun run typecheck`
**Commits:** None yet.

## Stage 3 — Branch prefix

**Depends on:** None.

**This stage:** the branch of a new worktree is `clowdy/<chat-id8>`, hard-coded in `workspaceLayout`. The prefix becomes an app-wide setting kept in the renderer like the other app-wide preferences and sent with `chat.create`. The daemon validates it as a ref name. One place reads the old name back: a thread owns its worktree when the branch is exactly `clowdy/<chat-id8>`; that test must follow the new naming.

- [ ] Complete
  - [ ] `chat.create`'s new workspace takes `branchPrefix?`; `workspaceLayout` builds `<prefix>/<chat-id8>`; an empty or absent prefix means `clowdy`; a prefix git would not accept as part of a branch name (spaces, `..`, `~^:?*[\`, a leading or trailing `/` or `.`, `.lock`) is `invalid`
  - [ ] The check in `driver.ts` that decides whether a thread's workspace is its own worktree no longer assumes `clowdy/`: the workspace is Clowdy's own when it is `managed` and its branch ends with `/<chat-id8>`
  - [ ] `BranchPrefixPreference` (key `clowdy:branch-prefix`, default `clowdy`), a field in Settings beside the new-chat defaults with the validation message, and the value sent when a new chat is created in a new worktree
  - [ ] Tests: a chat made with `max` gets `max/<id8>`, an invalid prefix is refused, a thread of such a chat is still recognised as sharing or owning its worktree

**Files**

- `packages/protocol/src/commands.ts` — `chat.create`: `workspace.branchPrefix`
- `apps/daemon/src/domain/workspaces.ts` — `workspaceLayout`, `createNewWorkspace`
- `apps/daemon/src/runs/driver.ts` — the thread-owns-worktree test near `worktreeBase`
- `apps/daemon/src/commands/chat.ts`, `apps/daemon/src/domain/chats.ts` — `createChat` passes it on
- `apps/desktop/src/renderer/features/chats/branchPrefix.ts` — create: the preference class and its singleton in the shape of `swipeReplyPreference.ts`; it cannot join `newChatDefaults.ts`, whose values the daemon's project settings also follow
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — where `chat.create` is built: sends the prefix
- `apps/desktop/src/renderer/features/settings/ChatPage.tsx` — the field beside `NewChatChoices`
- `apps/daemon/test/chat-workspaces.test.ts` — the prefix cases
- `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md` — the prefix

**Done when:** with the setting `max`, a chat started in a new worktree is on `max/<id8>`; with it unset it is on `clowdy/<id8>`; a prefix with a space is refused with a message in Settings.
**Verify:** `cd apps/daemon && bun test test/chat-workspaces.test.ts test/threads.test.ts test/worktree-flow.test.ts`, `cd packages/protocol && bun run test && bun run typecheck`, `cd apps/desktop && bunx vitest run src/renderer/features/chats src/renderer/features/settings && bun run typecheck`
**Commits:** None yet.

## Stage 4 — The Manage worktrees dialog

**Depends on:** Stage 1 (starts from its contract commit).

**This stage:** the dialog and its non-destructive parts. One opener, `openManageWorktrees`, draws the groups the daemon describes and offers the actions that change nothing: open in Finder, Terminal and the editor, and a new chat in a worktree or in the folder's checkout. Remove is Stage 5's, so a row's Remove button is drawn disabled here and wired there. The new-chat actions close the dialog and open a draft with `ui.openDraft([], folderId, workspace)`, which is how the draft already shows an existing worktree's files.

- [ ] Complete
  - [ ] `openManageWorktrees({ root, projectId, folderId? })` opens a modal (`Modal.create`); with a `folderId` that group is scrolled into view
  - [ ] One group per git folder, its own checkout first (branch, clean or changed, no Remove), then a row per worktree: branch or detached, chats (a click closes the dialog and opens the chat), clean or `N changed`, merged or `not merged` with its tip, path, `missing on disk`, `locked`
  - [ ] Row actions: `OpenWithMenu` for the worktree's path, `New chat in this worktree`, `New chat in this folder` on the checkout row
  - [ ] The list reads when the dialog opens and when the window gets focus again; a loading and an error state; a project with no git folder says so
  - [ ] Component tests on the fixture transport: groups and rows, the draft opening in the right place, the missing and locked marks

**Files**

- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.tsx` — create: `ManageWorktrees`, `openManageWorktrees`; no existing feature is about listing a project's worktrees (`FolderWorkspaceDialog.tsx` is one folder's settings)
- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.module.css`, `ManageWorktrees.test.tsx` — create
- `apps/desktop/src/renderer/features/worktrees/useProjectWorktrees.ts` — create: the read on open and on focus; it cannot join `openWith/useFolderGit.ts`, which answers one folder
- `apps/desktop/src/renderer/features/openWith/OpenWithMenu.tsx` — reused as it is
- `apps/desktop/AGENTS.md` — the dialog

**Done when:** against the fixture, `openManageWorktrees` shows the fixture project's two repositories with the main checkout first and a row per worktree, and `New chat in this worktree` opens a draft whose place is that worktree.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/worktrees && bun run typecheck && bun run lint`
**Commits:** None yet.

## Stage 5 — Remove in the dialog

**Depends on:** Stage 2, Stage 4.

**This stage:** the destructive half of the dialog. A row's Remove opens a confirmation whose content follows the row: a plain confirm for a clean worktree, a red `Discard N changed files and remove` for a changed one, the `Delete branch N` checkbox with its default and its `not merged` warning, no button while chats work in it (they are listed), and `Remove record` for a missing one.

- [ ] Complete
  - [ ] The confirmation shows the path and the branch; `Delete branch N` is on when merged and off when not, with the `not merged` label and its tip beside it; a detached HEAD with commits on no branch shows the same warning
  - [ ] A changed worktree (submodules included) needs the red confirmation and sends `discard: true`; a clean one does not
  - [ ] A worktree with chats has no Remove and lists them; the main checkout has none; a locked one says why
  - [ ] `Remove record` for a missing worktree; the list reloads after a removal and a failure shows the daemon's reason
  - [ ] Tests on the fixture transport for each variant, including that nothing is sent when the person cancels

**Files**

- `apps/desktop/src/renderer/features/worktrees/RemoveWorktreeDialog.tsx` — create: the confirmation is its own flow with its own state; it cannot join `ManageWorktrees.tsx`, which lists
- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.tsx` — the Remove button
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — `perform` reused for the command (or the dialog's own call if the file has no fit)
- `apps/desktop/src/renderer/features/worktrees/RemoveWorktreeDialog.test.tsx` — create

**Done when:** against the fixture, removing a clean merged worktree sends `workspace.remove` with `deleteBranch: true`, a changed one is not sent until the red confirmation, an unmerged one defaults the branch checkbox off with its label, and a worktree with chats cannot be removed.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/worktrees && bun run typecheck && bun run lint`
**Commits:** None yet.

## Stage 6 — Entry points: Files, the sidebar, Info

**Depends on:** Stage 4.

**This stage:** the three entry points that sit in files nobody else is changing. The Files tab has no header, so a thin bar above the file manager shows where the panel is (the worktree's branch, or the folder's name and branch for a checkout) and opens the dialog, without touching the forked `file-manager` package.

- [ ] Complete
  - [ ] A place bar on top of `FilesTab`: an icon, the worktree branch or `<folder> · <branch>`, a click and a Manage button that call `openManageWorktrees` with the project and the place's folder
  - [ ] `Manage worktrees` as the first item of the folder title's menu in the sidebar group (`GroupFolderMenu`), when the folder is a repository
  - [ ] A Manage button in Info's Worktree row
  - [ ] Tests for each entry point calling the opener with the right folder

**Files**

- `apps/desktop/src/renderer/features/files/FilesTab.tsx`, `FilesTab.module.css` — `PlaceFiles`: the bar
- `apps/desktop/src/renderer/features/agents/GroupFolderName.tsx` — `GroupFolderMenu`: the item
- `apps/desktop/src/renderer/features/sidePanel/InfoTab.tsx`, `InfoTab.module.css` — the Worktree row
- the tests beside each

**Done when:** each of the three calls `openManageWorktrees` with its folder, and the Files bar names the worktree or the checkout the panel shows.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/files src/renderer/features/agents src/renderer/features/sidePanel && bun run typecheck && bun run lint`
**Commits:** None yet.

## Stage 7 — Entry point: the new-chat worktree picker

**Depends on:** Stage 4, and the "one control" branch merged into `next`.

**This stage:** the picker of existing worktrees on the new-chat page gets a Manage button. It waits for the merge that turns the mode and branch chips into one control, since that branch rewrites `WorkspaceChips.tsx`, and the button belongs in the control as it ends up.

- [ ] Complete
  - [ ] A Manage button in the existing-worktree picker (a footer of `PickerPopover` or an item of the control's menu, wherever the merged control keeps the list) that opens the dialog for the draft's folder
  - [ ] A test that it opens the dialog for that folder

**Files**

- `apps/desktop/src/renderer/features/agents/WorkspaceChips.tsx` — the existing-worktree picker (after the one-control merge)
- `apps/desktop/src/renderer/features/agents/WorkspaceChips.test.tsx`

**Done when:** on the new-chat page, the existing-worktree picker has a Manage button that opens the dialog on the draft's folder.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/agents && bun run typecheck && bun run lint`
**Commits:** None yet.

## Stage 8 — The Fork menu

**Depends on:** None.

**This stage:** the Fork icon on an answer becomes a click menu. `Fork` does what the icon does now. `Fork to another agent…` opens the list of other signed-in agents; a pick opens a new-chat draft on that agent with the conversation up to that answer attached, which is today's hand-off draft with two additions: a cut at an answer and a preset agent. The read-only notice's hand-off keeps working through the same function.

- [ ] Complete
  - [ ] The Fork icon opens a `Menu` on click, not on hover, with `Fork` and a `SubmenuTrigger` `Fork to another agent…` listing the signed-in agents other than the chat's own; with no other agent the item is disabled with a hint
  - [ ] `startHandoff` takes the answer's item id and attaches the transcript up to and including it, and the agent to open the draft on; the draft opens with that agent and its default model, the worktree and the folder kept, the text filled in
  - [ ] Closing the draft leaves no chat behind; the read-only notice's hand-off is unchanged in behaviour
  - [ ] Tests for the menu, the cut transcript and the preset agent

**Files**

- `apps/desktop/src/renderer/stream/MessageActions.tsx` — `MessageActions`, `MessageActionsConfig`: the menu in place of the icon button
- `apps/desktop/src/renderer/stream/StreamView.tsx` — wires the second action for an answer that can fork
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — passes the hand-off action beside `useFork`
- `apps/desktop/src/renderer/features/chats/handoff.ts` — `startHandoff`: the cut at an item and the preset agent
- `apps/desktop/src/renderer/stores/UiStore.ts` — `openDraft`: the agent preset, kept where the draft's own choice lives (`composerDrafts.ts`, `useModelChoice.ts`); if it can only be done in `DraftChat.tsx` keep that diff to a few lines, because the one-control branch edits that file
- `apps/desktop/src/renderer/features/chats/ReadOnlyNotice.tsx` — the caller, adjusted to the new signature
- the tests beside each (`Handoff.test.tsx` in `features/agents`)

**Done when:** a click on the Fork icon shows the two items, `Fork` forks as before, and picking another agent opens a draft on it with the conversation up to that answer attached and the chat's worktree kept.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/stream src/renderer/features/chats src/renderer/features/agents && bun run typecheck && bun run lint`
**Commits:** None yet.
