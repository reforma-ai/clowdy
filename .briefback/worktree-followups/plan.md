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
- The Fork icon on an answer opens, **on click and not on hover**, a menu of two items: `Fork` (the session copy, as today) and `Hand off to…`, which opens a list of the other available agents.
- A choice in that list opens a **new-chat draft** on that agent with its default model, as hand-off does today: the text filled in, the conversation up to and including that answer attached as a markdown file, the worktree kept, the folder kept. The person changes the model, the worktree or the prompt in the draft, sends it, or closes it and nothing is left. The hand-off of a read-only chat's notice stays and shares the code.
- UI text has no closing period (`AGENTS.md`).

**Defaults I took** (the owner may change them)

- A thread's own worktree (`clowdy thread spawn --worktree`) is made by the daemon with no renderer in the way, so it keeps the default prefix `clowdy`.
- The dialog reads when it opens and when the window gets focus again, and does not poll. Git is asked with bounded concurrency and timeouts, as `folderGit` is.
- Info shows Manage only in the Worktree row, which a chat in Project checkout does not have; the Files label covers that chat.
- `Hand off to…` lists only agents that are signed in and not the chat's own.

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

- [x] Complete
  - [x] The contract commit: `ROUTES.projectWorktrees` (`GET /v1/projects/:id/worktrees`), `FolderWorktrees { folderId, name, isRepository, worktrees: WorktreeInfo[] }` with the folder's own checkout first, `WorktreeInfo { path, branch?, head, main, missing, locked?, changes, submodules, merged?, base?, workspaceId?, managed, chats: { id, title, archived }[], blocked?: 'main' | 'locked' | 'chats' }` (`changes` is the number of uncommitted files, a new file counted, 0 when clean; `merged` is absent when no base resolves); `getProjectWorktrees(projectId)` on the transport interface, the HTTP transport, the `unconfigured` stub and the fixture, with fixture data for a project of two repositories (a Clowdy-made worktree with a chat, a found dirty one, a locked one, a missing one) and a plain folder
  - [x] The daemon answers it from `git worktree list --porcelain` (prunable and locked kept), the project's `workspaces` rows and their chats, per-worktree `status` and ancestor checks run with bounded concurrency and timeouts, and a folder gone from the disk or not a repository answered as such
  - [x] `isMerged` and `commitOf` become shared (exported from `git/state.ts`), so removal and this read use one definition of merged
  - [x] Tests on real repositories: main checkout first, a found worktree, a Clowdy-made one with two chats (one archived), a locked one, one whose folder was deleted, a dirty one with a new file, a merged and an unmerged branch, a detached HEAD, a plain folder

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
**Scope changes:** the contract added `WorktreeBlock` and `WorktreeChat`; `locked` is the reason string (`''` when git gave none); `submodules` is false when git cannot say, so a guess never reaches a forced removal; `changes` counts git status entries (a failed status counts 1, an untracked folder is one entry); `blocked: 'main'` also covers the repository's primary tree when the project's folder is itself a linked worktree; a folder that is not a repository, gone, or replaced by a file has an entry with `isRepository: false` and no worktrees; a git that does not answer makes the whole route `unavailable`; `isMerged`, `commitOf`, `changedFiles`, `countChanges`, `hasCheckedOutSubmodules`, `isOnDisk` live in `git/state.ts` (the integration kept `next`'s `workingTreeRoot` for the helper Stage 1 had called `repositoryRoot`). **Review findings, fixed:** a Clowdy-made worktree whose folder was deleted lost its record and chats when the record's path went through a symlink (`/var` vs `/private/var`); a repository with `--separate-git-dir` showed a bogus first row; a project folder replaced by a file made the whole route 503; the status call and the on-disk check each existed three times. **Left:** one folder whose git hangs blanks the dialog for every folder (as `GET /git` does); worktrees are read four at a time, so a batch waits for its slowest.
**Commits:** `b6f8d4b` feat(protocol): describe a project's worktrees for the Manage dialog; `0ce0af7` refactor(daemon): share the merged check and the changed-files count of a worktree; `960b9ba` feat(daemon): answer GET /v1/projects/:id/worktrees with every worktree of the project's folders; review: `4341c04`, `fc9fbed`, `16a0c6c`, `a0ccfb7`, `0658056`; merged into `next` with Stages 4, 6, 7 as `9c812d2`.

## Stage 2 — Remove a worktree

**Depends on:** Stage 1.

**This stage:** a worktree is removed by path, not through a chat. `checkRemoval` is built on a chat; this stage pulls the worktree's own rules out of it and adds the command the dialog calls. The rules differ from the chat's: uncommitted changes and unmerged work are no longer refusals but choices (`discard`, `deleteBranch`), while a locked worktree, the folder's own checkout and a worktree a chat works in still refuse. The chat delete dialog's checkbox keeps what it allows today and goes through the same routine.

- [x] Complete
  - [x] `checkWorkspaceRemoval` takes a worktree (a record or a path git lists) and the chat ids that are allowed to use it; `checkRemoval` becomes the strict chat-delete caller of it
  - [x] `workspace.remove { projectId, folderId, path, discard?, deleteBranch? }`: finds or opens the row (`openWorkspace`) so a turn is kept out by `markRemoving` as it is for a chat's removal, runs under `exclusive` by path, `git worktree remove` with `--force` only when `discard` is true and the tree is changed, `branch -D` when `deleteBranch` is true and the branch is not checked out in another worktree, `pruneEmptyParents` below `workspacesDir`, deletes the row
  - [x] Refusals with a reason: the folder's own checkout, a locked worktree, a worktree a chat (an archived one included) works in, a changed tree without `discard`, a path git does not list for that folder
  - [x] A worktree whose folder is gone: the command removes that worktree's record only, and another stale record of the repository is still there afterwards
  - [x] The fixture transport answers the command; `chat.delete` with `removeWorkspace` behaves as before

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
**Scope changes:** `workspace.remove` answers `{ path, branchDeleted }`; the shared checker is `checkWorkspaceRemoval(store, target, choices)` and the chat delete's `checkRemoval` is its strict caller (its words for an unreadable status are unchanged); a worktree of another folder of the project, the repository's primary tree and a worktree that has another worktree or a project folder inside it are refused (the route marks a sibling folder's checkout `blocked: 'main'`; the nested case is known only from the command's refusal); `--force` only with `discard` and a changed tree, `branch -D` only with `deleteBranch` and never for a branch another worktree has checked out (refused before anything is removed); empty parents are pruned before the branch is deleted and compared by real place. **Review findings, fixed:** a worktree hidden by `.gitignore` inside the one being removed looked clean and was deleted with its uncommitted work (now refused); the route listed a sibling folder's checkout as removable while the command refused it; the empty folders stayed when `workspacesDir` was written through a link. **Left:** no `blocked` value for the nested case (a fourth `WorktreeBlock` would grey the button up front); `chat.create` and `workspace.open` do not check `isBeingRemoved` (a chat made while git deletes fails its first turn with a clear message); the full daemon `bun test` takes about 8 minutes with long idle stretches (no deadlock found).
**Commits:** `01432b0` refactor(daemon): split the worktree's own removal rules from the chat delete's; `afa2dc0` feat(daemon): remove a worktree by its path with workspace.remove; `5dc7ef3` feat(desktop): answer workspace.remove in the fixture transport; `ef75a06`, `34f569b`, `7baf034`; review: `c1b9672`, `c29c780`, `3e9a364`, `17b9918`; merged into `next` as `08507ac`.

## Stage 3 — Branch prefix

**Depends on:** None.

**This stage:** the branch of a new worktree is `clowdy/<chat-id8>`, hard-coded in `workspaceLayout`. The prefix becomes an app-wide setting kept in the renderer like the other app-wide preferences and sent with `chat.create`. The daemon validates it as a ref name. One place reads the old name back: a thread owns its worktree when the branch is exactly `clowdy/<chat-id8>`; that test must follow the new naming.

- [x] Complete
  - [x] `chat.create`'s new workspace takes `branchPrefix?`; `workspaceLayout` builds `<prefix>/<chat-id8>`; an empty or absent prefix means `clowdy`; a prefix git would not accept as part of a branch name (spaces, `..`, `~^:?*[\`, a leading or trailing `/` or `.`, `.lock`) is `invalid`
  - [x] The check in `driver.ts` that decides whether a thread's workspace is its own worktree no longer assumes `clowdy/`: the workspace is Clowdy's own when it is `managed` and its branch ends with `/<chat-id8>`
  - [x] `BranchPrefixPreference` (key `clowdy:branch-prefix`, default `clowdy`), a field in Settings beside the new-chat defaults with the validation message, and the value sent when a new chat is created in a new worktree
  - [x] Tests: a chat made with `max` gets `max/<id8>`, an invalid prefix is refused, a thread of such a chat is still recognised as sharing or owning its worktree

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
**Scope changes:** the prefix rules live in `packages/protocol/src/domain.ts` (`DEFAULT_BRANCH_PREFIX`, `branchPrefixOf`, `branchPrefixProblem`) so Settings and the daemon share one check; `chat.create` also refuses a prefix that an existing branch of the repository blocks (a branch `max` blocks `max/<id8>`); the app sends `branchPrefix` only when it is not `clowdy` (the schema is strict, an older daemon would answer 400); `ownsWorktree(chat, workspace)` in `driver.ts` is true when the workspace is `managed` and its branch ends with `/<id8>`; `commands/chat.ts` and `domain/chats.ts` needed no change. Review (`cf06d4f`) also refuses invisible characters and `" < > |` in a prefix. **Left:** a prefix part that is a Windows device name (`con`, `aux`, `nul`) is a valid ref that Windows cannot make as a folder (fix: move `RESERVED_NAMES` from `domain/workspaces.ts` to `@clowdy/protocol` and check each part); the Settings field shows "cannot end with /" for one keystroke while typing `team/`.
**Commits:** `39e0abb` feat(protocol): add the branch prefix of a new worktree; `2fa6b98` feat(daemon): name a new worktree's branch after the prefix of the app; `bce1073` feat(desktop): set the branch prefix of new worktrees in Settings; `cf06d4f` fix(protocol): refuse invisible characters and Windows file name characters in a branch prefix; merged into `next` as `f178ccd`.

## Stage 4 — The Manage worktrees dialog

**Depends on:** Stage 1 (starts from its contract commit).

**This stage:** the dialog and its non-destructive parts. One opener, `openManageWorktrees`, draws the groups the daemon describes and offers the actions that change nothing: open in Finder, Terminal and the editor, and a new chat in a worktree or in the folder's checkout. Remove is Stage 5's, so a row's Remove button is drawn disabled here and wired there. The new-chat actions close the dialog and open a draft with `ui.openDraft([], folderId, workspace)`, which is how the draft already shows an existing worktree's files.

- [x] Complete
  - [x] `openManageWorktrees({ root, projectId, folderId? })` opens a modal (`Modal.create`); with a `folderId` that group is scrolled into view
  - [x] One group per git folder, its own checkout first (branch, clean or changed, no Remove), then a row per worktree: branch or detached, chats (a click closes the dialog and opens the chat), clean or `N changes`, merged or `not merged` with its tip, path, `missing on disk`, `locked`
  - [x] Row actions: `OpenWithMenu` for the worktree's path, `New chat in this worktree`, `New chat in this folder` on the checkout row
  - [x] The list reads when the dialog opens and when the window gets focus again; a loading and an error state; a project with no git folder says so
  - [x] Component tests on the fixture transport: groups and rows, the draft opening in the right place, the missing and locked marks

**Files**

- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.tsx` — create: `ManageWorktrees`, `openManageWorktrees`; no existing feature is about listing a project's worktrees (`FolderWorkspaceDialog.tsx` is one folder's settings)
- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.module.css`, `ManageWorktrees.test.tsx` — create
- `apps/desktop/src/renderer/features/worktrees/useProjectWorktrees.ts` — create: the read on open and on focus; it cannot join `openWith/useFolderGit.ts`, which answers one folder
- `apps/desktop/src/renderer/features/openWith/OpenWithMenu.tsx` — reused as it is
- `apps/desktop/AGENTS.md` — the dialog

**Done when:** against the fixture, `openManageWorktrees` shows the fixture project's two repositories with the main checkout first and a row per worktree, and `New chat in this worktree` opens a draft whose place is that worktree.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/worktrees && bun run typecheck && bun run lint`
**Scope changes:** beyond the plan's files: `WorktreeRow.tsx` (a group and its rows), `worktreeView.ts` (pure helpers) and an `index.ts` barrel; `OpenWithMenu` got an optional `inApp` prop (default true) that the dialog sets to false, so its menu has no Open in Files or Open in Terminal (they would act behind the dialog); leaving through `New chat in this worktree` or a chat click does not return focus to the opener. **Review findings, fixed:** a stand-in `workspace` that faked a place for `OpenWithMenu`; focus theft after the closing animation; a dead tooltip on a disabled New chat; a missing test for two reads in flight. **Left:** the `.row[data-missing]` dimming is a raw `opacity: 0.7` (DESIGN.md has `--opacity-inactive` 0.5; a visual choice).
**Commits:** `f06c5b9` feat(desktop): read a project's worktrees and label them for the Manage dialog; `7d00fe7` feat(desktop): add the Manage worktrees dialog; `b0fdd54` docs(desktop): describe the Manage worktrees dialog; review: `a5b6167`, `44264c0`, `2784e27`, `7f1b0ad`, `fadf39c`; merged into `next` as `9c812d2`.

## Stage 5 — Remove in the dialog

**Depends on:** Stage 2, Stage 4.

**This stage:** the destructive half of the dialog. A row's Remove opens a confirmation whose content follows the row: a plain confirm for a clean worktree, a red `Discard N changed files and remove` for a changed one, the `Delete branch N` checkbox with its default and its `not merged` warning, no button while chats work in it (they are listed), and `Remove record` for a missing one.

- [x] Complete
  - [x] The confirmation shows the path and the branch; `Delete branch N` is on when merged and off when not, with the `not merged` label and its tip beside it; a detached HEAD with commits on no branch shows the same warning
  - [x] A changed worktree (submodules included) needs the red confirmation and sends `discard: true`; a clean one does not
  - [x] A worktree with chats has no Remove and lists them; the main checkout has none; a locked one says why
  - [x] `Remove record` for a missing worktree; the list reloads after a removal and a failure shows the daemon's reason
  - [x] Tests on the fixture transport for each variant, including that nothing is sent when the person cancels

**Files**

- `apps/desktop/src/renderer/features/worktrees/RemoveWorktreeDialog.tsx` — create: the confirmation is its own flow with its own state; it cannot join `ManageWorktrees.tsx`, which lists
- `apps/desktop/src/renderer/features/worktrees/ManageWorktrees.tsx` — the Remove button
- `apps/desktop/src/renderer/features/settings/projects/projectActions.ts` — `perform` reused for the command (or the dialog's own call if the file has no fit)
- `apps/desktop/src/renderer/features/worktrees/RemoveWorktreeDialog.test.tsx` — create

**Done when:** against the fixture, removing a clean merged worktree sends `workspace.remove` with `deleteBranch: true`, a changed one is not sent until the red confirmation, an unmerged one defaults the branch checkbox off with its label, and a worktree with chats cannot be removed.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/worktrees && bun run typecheck && bun run lint`
**Scope changes:** the confirmation says `Discard N changes and remove` (git status entries: an untracked folder is one), `Remove with submodules` for a tree that is clean but has an initialised submodule, `Remove record` for a missing one; the seam `onRemove` is gone, the dialog opens `openRemoveWorktree` itself; `Try again` sits beside `Couldn't refresh the list`; a daemon refusal toasts its reason, reloads the list and closes the confirmation. **Review findings, fixed:** a worktree on the base branch itself counted as merged and its `Delete branch` box started ticked (it would delete the local default branch; now off with `It is the base branch itself`); the detached HEAD warning claimed a fact git was not asked (`may be in no branch`); the branch warning is now the box's `aria-describedby`. **Left:** the red count is a snapshot (the daemon still accepts `discard: true` if the tree grew meanwhile; a fix needs an expected-count field); the shared `ConfirmModalContent` autofocuses the destructive button, so Enter confirms at once (as the chat delete does); the dialog tests stub `getClientRects` because happy-dom has no layout.
**Commits:** `d8384ad` feat(desktop): remove a worktree from Manage worktrees with a confirmation that follows the worktree; `9f26805` docs(desktop): describe the removal confirmation of Manage worktrees; review: `158c53f`, `034570b`, `5f41681`; merged into `next` as `08507ac`.

## Stage 6 — Entry points: Files, the sidebar, Info

**Depends on:** Stage 4.

**This stage:** the three entry points that sit in files nobody else is changing. The Files tab has no header, so a thin bar above the file manager shows where the panel is (the worktree's branch, or the folder's name and branch for a checkout) and opens the dialog, without touching the forked `file-manager` package.

- [x] Complete
  - [x] A place bar on top of `FilesTab`: an icon, the worktree branch or `<folder> · <branch>`, a click and a Manage button that call `openManageWorktrees` with the project and the place's folder
  - [x] `Manage worktrees` as the first item of the folder title's menu in the sidebar group (`GroupFolderMenu`), when the folder is a repository
  - [x] A Manage button in Info's Worktree row
  - [x] Tests for each entry point calling the opener with the right folder

**Files**

- `apps/desktop/src/renderer/features/files/FilesTab.tsx`, `FilesTab.module.css` — `PlaceFiles`: the bar
- `apps/desktop/src/renderer/features/agents/GroupFolderName.tsx` — `GroupFolderMenu`: the item
- `apps/desktop/src/renderer/features/sidePanel/InfoTab.tsx`, `InfoTab.module.css` — the Worktree row
- the tests beside each

**Done when:** each of the three calls `openManageWorktrees` with its folder, and the Files bar names the worktree or the checkout the panel shows.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/files src/renderer/features/agents src/renderer/features/sidePanel && bun run typecheck && bun run lint`
**Scope changes:** the place bar is on both the Files and Docs tabs (one mounted component); no bar until git answers, none for a plain folder, a missing folder or a worktree not made yet; `OpenWithMenu` got an optional `onManageWorktrees` prop (the item is first, in its own section); the sidebar item shows when the folder's git read has a branch (a stand-in for "is a repository"). **Review findings, fixed:** the bar's name button and Manage were two keyboard stops (the name is now out of the tab order); a missing test for the folder menu on a missing folder; wording in the notes. **Left:** a folder inside a larger repository shows the bar and the item but the dialog has no group for it (fix: a root flag on `ProjectFolderInfo`); the bar nudges the file manager down once when git answers (fix: keep the last answer per place in `useFolderGit`); a draft in a worktree no chat works in had no bar (Stage 9).
**Commits:** `9ec3b87` feat(desktop): add a place bar to the Files and Docs tabs that opens Manage worktrees; `c73cb26` feat(desktop): add Manage worktrees to the menu of a folder group's title; `e1d9627` feat(desktop): add a Manage button to the Worktree row of the Info tab; `cc4bfde` docs; review: `497360b`, `2597e01`, `b2678ad`; merged into `next` as `9c812d2`.

## Stage 7 — Entry point: the new-chat worktree picker

**Depends on:** Stage 4, and the "one control" branch merged into `next`.

**This stage:** the picker of existing worktrees on the new-chat page gets a Manage button. It waits for the merge that turns the mode and branch chips into one control, since that branch rewrites `WorkspaceChips.tsx`, and the button belongs in the control as it ends up.

- [x] Complete
  - [x] A Manage button in the existing-worktree picker (a footer of `PickerPopover` or an item of the control's menu, wherever the merged control keeps the list) that opens the dialog for the draft's folder
  - [x] A test that it opens the dialog for that folder

**Files**

- `apps/desktop/src/renderer/features/agents/WorkspaceChips.tsx` — the existing-worktree picker (after the one-control merge)
- `apps/desktop/src/renderer/features/agents/WorkspaceChips.test.tsx`

**Done when:** on the new-chat page, the existing-worktree picker has a Manage button that opens the dialog on the draft's folder.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/agents && bun run typecheck && bun run lint`
**Scope changes:** the plan said "picker"; after the one control landed it is a last menu row `Manage worktrees…` (its own `MenuSection`, `selectionMode="none"`, a `menuitem` and not a radio) after a separator, shown whenever the pill is; `WorkspaceChips` takes a required `onManage` that `DraftChat` fills with the real folder id (the main folder's too; the dialog turns it into `null` only for `openDraft`). **Review:** no change to production code; two tests added (arrows wrap to the row, Escape returns focus to the pill) and the notes corrected. **Left:** with many worktrees the row is below the fold of the 360 px scroll box (a sticky footer would fix it).
**Commits:** `edf5cd8` feat(desktop): open Manage worktrees from the new-chat control's menu; `bf13219` chore(desktop): order the fixture transport imports after the merge; review: `ec67d9d`, `d8eccb4`; merged into `next` as `9c812d2`.

## Stage 8 — The Fork menu

**Depends on:** None.

**This stage:** the Fork icon on an answer becomes a click menu. `Fork` does what the icon does now. `Hand off to…` opens the list of other signed-in agents; a pick opens a new-chat draft on that agent with the conversation up to that answer attached, which is today's hand-off draft with two additions: a cut at an answer and a preset agent. The read-only notice's hand-off keeps working through the same function.

- [x] Complete
  - [x] The Fork icon opens a `Menu` on click, not on hover, with `Fork` and a `SubmenuTrigger` `Hand off to…` listing the signed-in agents other than the chat's own; with no other agent the item is disabled with a hint
  - [x] `startHandoff` takes the answer's item id and attaches the transcript up to and including it, and the agent to open the draft on; the draft opens with that agent and its default model, the worktree and the folder kept, the text filled in
  - [x] Closing the draft leaves no chat behind; the read-only notice's hand-off is unchanged in behaviour
  - [x] Tests for the menu, the cut transcript and the preset agent

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
**Scope changes:** the preset agent is `ProjectUi.draftEngine` (a 4th argument of `openDraft`, part of the page's view, cleared by `openChat`, `openRun` and the next `openDraft`), read by `DraftChat` into the draft's defaults; `startHandoff` takes `itemId` and `engine` and cuts the transcript at that answer by `seq` (`itemsUpTo`); a shared `useHandoff` hook serves the read-only notice and the menu; the menu is `stream/ForkMenu.tsx`, its agents come from `handoffAgents` in `chatProvider.ts` (switched on, installed, not signed out, not the chat's own); the icon's tooltip reads `Fork`. The agent's "default model" is the one last used on it, else its default, as for any new chat. **Left (the owner decides):** the menu is drawn only where the Fork icon was (an answer with `canFork`), so an answer in a chat whose agent cannot cut its session has neither Fork nor the hand-off; widening it takes `StreamView.tsx` `actionsOf`, `MessageActions.tsx`, `ForkMenu.tsx` (`onFork` optional) and tests, and a choice of a grey Fork with a reason or another label; two hand-offs from one chat before sending leave two files with the same name (a fix means moving the file removal out of `useComposerFiles.remove` into `composerFiles.ts`).
**Commits:** `b49ef2c` feat(desktop): open the new-chat page on an agent named by the caller; `18af2a1` feat(desktop): cut a hand-off at an answer and open it on another agent; `83f5e70` feat(desktop): open a menu from the Fork icon with Hand off to; `7135668` docs(desktop): describe the Fork menu and the hand-off to another agent; review: `13b2aa8` refactor: share `useHandoff`, `d05fbab` test: preset model, own pick, keyboard, `09c3853` docs; `b3ed954` refactor(desktop): hand the new-chat page its agent through the draft's defaults; merged into `next` as `27a10a7`.

## Stage 9 — A draft in an existing worktree shows its branch

**Depends on:** Stage 6.

**This stage:** found in Stage 6's review. `useFolderGit` reads the live branch of a place through `getProjectsInfo`, whose `workspaces` list only the rows a chat points at (`listWorkspacesInUse`). A new-chat draft in an existing worktree (the page's `workspace.open` row, which "New chat in this worktree" and the picker both make) has no chat yet, so the Files bar, Info's Worktree and Branch rows have no branch until the first message. The rows a draft opens must be reported too, and the renderer must read again when the draft's row appears.

- [x] Complete
  - [x] `projectsInfo` reports every worktree row of the project that is still on disk, not only those a chat points at (a row a draft opened included), without changing what the chats' own rows say
  - [x] The renderer reads `getProjectsInfo` again when the draft's row (`ProjectUi.draftWorkspaceRow`) appears or changes, as it does when a chat's worktree gets made
  - [x] On a draft in a found worktree, the Files bar and Info show that worktree's branch; the test fails without the daemon change and without the reload

**Files**

- `apps/daemon/src/domain/projects.ts` — `projectsInfo`: the workspaces it reports (`listWorkspacesInUse` → the project's rows)
- `apps/daemon/src/db/workspaces.ts` — `listWorkspacesInUse`, `listWorkspacesOfProject`
- `apps/desktop/src/renderer/features/agents/Screen.tsx` — the `reloadKey` of `useProjectsInfo` also follows the draft's row
- `apps/daemon/test/projects.test.ts` (or the nearest existing test of `projectsInfo`) and `apps/desktop/src/renderer/features/agents/Screen.test.tsx`
- `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md` — what `workspaces` of the info holds

**Done when:** on a new-chat draft in a worktree no chat works in, the Files place bar and Info's Branch row show that worktree's branch.
**Verify:** `cd apps/daemon && bun test test/projects.test.ts test/chat-workspaces.test.ts`, `cd apps/desktop && bunx vitest run src/renderer/features/agents src/renderer/features/sidePanel src/renderer/features/files && bun run typecheck && bun run lint`
**Scope changes:** `projectsInfo` reports every worktree row of the project that is on disk (`listWorkspaceUses` replaces `listWorkspacesInUse`); a chat's row is reported as before (`exists: false` when its worktree is gone), a row no chat points at only while its worktree is on disk and its folder is still one of the project's. The second task is met by `useFolderGit`, which already reads again when the draft's row appears; the `Screen.tsx` reload the plan asked for was dropped in review because nothing read it and it stopped the reload at chat creation from firing (`Screen.tsx` is not in this stage's files). **Left:** the Settings > Projects page polls `getProjectsInfo` every 10 s and now gets a git read per row it never uses (a flag to skip `workspaces` would fix it).
**Commits:** `330f39b` fix(daemon): report the worktree rows a new-chat page opened in the project info; `4aa7269` fix(desktop): show the branch of a worktree a new-chat page chose before its first message; review: `13bba8a`, `0efebb1`; merged into `next` as `08507ac`.

## Closing notes

- All nine stages are on `next` and pushed. The docs and the Info tests that were held back while the git chat had those files dirty came back in `58ccc66` and `efa8381` (merged as `297edfb`).
- After the owner's first look at the real app a polish pass narrowed the dialog (540 wide), set the row title and description to the list size (`Text` without a `variant` inherits the page's 16 px), used `--opacity-inactive` for a missing row and put the reason a Remove is off in the row itself (`05a9dbf`, merged as `94f9cb1`).
- The owner then took the reason line back out of the row (`removeNote`, the "Can't remove: ..." text): a Remove that is off says why on hover of the button (`removeHint`), and the line only repeated it.
- Then the owner took the path out of the row too: it is the tooltip of the worktree's name (the `~` form), and the Open button's menu lists the programs themselves (`OpenWithMenu`'s `programsOnly`, which replaced `inApp`), with no copy of the path and no `Open in…`.
- Then the owner reworked the row's end: New chat and a More menu (New chat, Copy path, `Open in…`, then Remove…, with its reason under it), a right-click on the row opens the same menu, the buttons are centred with the same gap to the right edge as to the top, and the row has one badge at most (`worktreeMark`: Project checkout, Missing on disk, Locked, then Merged or Not merged) and `No local changes` for a clean tree.
- The dialog's loading state is the table itself, two shimmering rows under a folder's name (`WorktreesSkeleton`), in place of a spinner and a line of text; not looked at in the real app yet.
- Then the owner asked for the row's buttons on hover only, one dim colour for the changes line, and our worktrees above the others. The order is the daemon's (`orderWorktrees` in `domain/worktrees.ts`, so any client of `GET /v1/projects/:id/worktrees` gets it): the folder's checkout, then Clowdy-made, with a chat, or the repository's own tree, then the rest, then one gone from the disk; git's order within a kind. It first lived in the dialog and moved to the daemon at the owner's word; the dialog now shows what it is given.
- The place bar on top of the Files and Docs tabs (`PlaceBar`, with its Manage button) was taken out at the owner's word: it named a place the panel already shows and only repeated the entry points the sidebar's folder menu and Info have. The dialog has those two entry points and the new-chat page's picker now.
- Settings > Projects > a project's page has a Worktrees block with a Manage worktrees button (`ProjectWorktrees`), for the whole project: the owner weighed that against a button per folder, and one window with a group per folder serves both. The dialog now works for a project the window does not show; it closes only when the project is removed, and its actions that leave select the project and shut Settings.
- The Manage worktrees button is filled. Each repository in the dialog has a **New worktree** button. It creates a standalone checkout from the configured base or the repository default, using the branch prefix from Settings > Chat. The list refreshes as soon as the checkout is created, and its row can start a chat. The standalone checkout runs Git's checkout hooks. The folder's setup files and command apply to worktrees created by chats.
- The sidebar folder menu's Manage worktrees… moved to the bottom and is always there from the first frame (it used to come in with the folder's git read and shift the menu); it is the project's dialog, which says when no folder is a repository. Grouping the Agents list by folder is allowed for a project of one folder too, and its switch is in every project's Filters menu.
- **Settled after the plan (2026-11-23):** the names are the owner's: **Fork** is a new chat from the thread, **Hand off** is a new chat with the conversation attached as a file, so the menu's second item is `Hand off to…`. Every finished turn's final answer has the one Fork button and menu. Where the agent cannot cut its session (Cursor: its `initialize` advertises neither `fork` nor `resume`, and v1 has no message ids; answers from before the points; stopped turns) **Fork is a hand-off to the chat's own agent underneath**, with the same icon and no other wording: the owner wants one Fork in the interface.
- **For the owner:** the destructive button's autofocus in the shared `ConfirmModalContent` (Enter confirms a red Discard; the chat delete behaves the same); the dialog heading is `heading-3` (18 px), `heading-4` is the next step if it still reads big.
- **Unverified:** the app was not run in a packaged Electron against a real daemon with these stages (the workers looked at the fixture in a browser and in the Electron screenshot script), nothing was run on Windows.
