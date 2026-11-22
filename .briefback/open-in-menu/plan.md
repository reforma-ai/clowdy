# Open in menu

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** One menu that opens, shows and copies a file or a folder of the project, from the folder pill under the composer, from a file chip in the chat, and from the Files tree.

**Approach:** The main process learns to open a file as well as a folder (`openFolder` becomes `openPath`). The daemon adds the current git branch to what it already reads about a folder (`ProjectFolderInfo`, with the remote). The renderer builds the list of actions for a target (a folder of the project, a path, file or directory) in one place, `features/openWith`, and three surfaces draw it: the pill's popover, a context menu on the chip, and the Files tree's row menu (as a submenu).

**Decisions**

- One universal menu takes a target: the project folder, the path, and its kind (file or directory). Items show when they apply.
- Order: Open in Files, the editor, the file manager (`Open in Finder` for a folder, `Show in Finder` for a file), the terminal (folder only), GitHub, a separator, `Copy path`, `Copy relative path`. A folder's root has no `Copy relative path`.
- A file has no terminal item.
- The editor opens the file itself. The system's file manager shows the file in its folder (`shell.showItemInFolder`); Path Finder and ForkLift get the folder the file is in.
- `Open in GitHub` is GitHub only, and shows whenever the folder's `origin` is a GitHub repository, even for a local branch that was never pushed or a file git does not track (the link may then be a 404, accepted). It links to the current branch: a file `/blob/<branch>/<path>`, a folder `/tree/<branch>/<subfolder>`, the root the repository page. On a detached HEAD the ref is the short commit hash. Other hosts get no item.
- The daemon reads the git facts (remote and branch) with one request; the browser is opened by the existing external link handling (`window.open` is routed to `shell.openExternal` for http and https in the main process).
- Errors of a launch stay toasts.
- The folder pill's menu gets `Open in Files`, `Open in GitHub` and `Copy path`. Right after the folder's name the pill shows the current branch as plain text (styling comes later); the branch is read when the screen opens and when the window gets focus again. A detached HEAD shows the short hash, a folder that is not a repository shows nothing.
- The Info tab gets a `Branch` row under `Folder`, with the same branch.
- A file chip in the chat opens the file in the built-in file manager on a press (the side panel opens and switches to Files if it was closed), and opens this menu on a right-click. A path that cannot be opened there (the file is not on the disk, or it is in no folder of the project, or in a folder the window is not on) opens the same menu, as the right-click does. A press no longer copies the path: `Copy path` is an item of the menu.
- A relative chip path is read against the folder of the open chat; an absolute path is looked up in the folders of the project.
- The Files tree's row menu gets an `Open in…` submenu (editor, `Show in Finder`, terminal for a folder, GitHub) and the flat items `Copy path` and `Copy relative path`. There is no `Open in Files` there. A selection of several rows gets none of them.
- `FileMenuItem` of `packages/file-manager` gains `children`, which draws a submenu.

**Reuse:** `remoteLink`, `siteName` (`features/settings/projects/projectView.ts`); `chosenApp`, `useOpenApps`, `AppIcon`, `openWithPreferences` (`features/openWith`); `currentFolder` (`features/sidePanel/currentFolder.ts`); `useFilesStore().managerOf/startedManagerOf` (`features/files`); `FileManager.open/reveal/close` (`packages/file-manager/src/FileManager.ts`); `useContextMenu` (`packages/components/src/Popover/useContextMenu.ts`); `SubmenuTrigger`, `MenuSeparator` (`packages/components/src/List/Menu.tsx`); `gitLine` (`apps/daemon/src/domain/git.ts`); `UiStore.showSidePanelTab`.

## Out of scope

- Hosts other than GitHub, a check that the branch is pushed or the file tracked.
- The settings of projects and the tasks panel (the menu is built so they can plug in later).
- Running a command (`vim file`) in a terminal.
- The look of the branch label (the owner will refine it).

## Stage 1 — Open a file in the main process

**Depends on:** None.

**This stage:** `openFolder` accepts a folder only. It becomes `openPath` and accepts a file too, with the rules of the decisions: an editor opens the file, the system's file manager shows it in its folder, another file manager gets the folder the file is in, and a terminal refuses a file. It reaches the page through the bridge as `openPath`, and the renderer helper that calls it is renamed with it.

- [x] Complete
  - [x] `openPath(path, app)` in the main process handles a file and a folder, and the rules above are covered by tests
  - [x] the bridge, the preload and the IPC channel say `openPath`; the renderer helper is `openPathIn` and `ChatFolder` calls it

**Files**

- `apps/desktop/src/main/openWith.ts` — `openFolder` → `openPath`, `OpenWithDeps.showItem`, `isFolder` stays for the kind
- `apps/desktop/src/main/openWith.test.ts` — the file cases
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/ipc.test.ts` — pass `showItemInFolder`, register `openPath`
- `apps/desktop/src/preload/index.ts`, `apps/desktop/src/shared/bridge.ts` — `openFolder` → `openPath`, channel `openPath`
- `apps/desktop/src/renderer/features/openWith/openApps.ts`, `index.ts` — `openFolderIn` → `openPathIn`, `canOpenFolders` → `canOpenPaths`
- `apps/desktop/src/renderer/features/agents/ChatFolder.tsx` — the renamed calls

**Done when:** a test opens a file in an editor, shows it in the system's file manager, hands its folder to Path Finder, and is refused by a terminal.
**Verify:** `cd apps/desktop && bun run test -- src/main/openWith.test.ts && bun run typecheck`
**Commits:** `100cf6e` feat(desktop): open a file as well as a folder in an editor or a file manager. The type `OpenFolderApp` is `OpenPathApp` now, and the toast says `Couldn't open it in <app>`.

## Stage 2 — The branch of a folder

**Depends on:** None.

**This stage:** The page that manages projects already gets each folder's remote from `GET /v1/projects/info`. The same answer now carries the folder's current branch (or the short hash on a detached HEAD), and the request can be limited to one project, so a screen that wants one folder's git facts does not read every project.

- [x] Complete
  - [x] `ProjectFolderInfo` has `branch?` and `detached?`; the daemon reads them with `gitLine` for a folder that exists
  - [x] `GET /v1/projects/info?project=<id>` answers only that project (404 for an unknown id, as the project snapshot route does); the transports pass the id

**Files**

- `packages/protocol/src/domain.ts` — `ProjectFolderInfo.branch`, `.detached`
- `packages/protocol/src/api.ts` — the route's doc line (the `project` query)
- `apps/daemon/src/domain/projects.ts` — `projectsInfo(store, projectId?)` reads the branch
- `apps/daemon/src/http/routes.ts` — the `info` route passes the query
- `apps/daemon/test/projects.test.ts` — branch, detached HEAD, not a repository, the filter
- `apps/desktop/src/renderer/daemon/transport.ts`, `httpTransport.ts`, `fixtureTransport.ts` — `getProjectsInfo(projectId?)`

**Done when:** a daemon test reads a branch name, a short hash on a detached HEAD, nothing outside a repository, and one project's info alone.
**Verify:** `cd apps/daemon && bun test test/projects.test.ts`, then `cd apps/desktop && bun run typecheck`
**Commits:**
- `7f49a1c` feat(daemon): read the current branch of a project folder (also `projectsTransport.test.ts`, `fixtureData.ts` with branches `main`, `next`, `feature/payments`)

## Stage 3 — The menu and the pill

**Depends on:** Stage 1, Stage 2.

**This stage:** The list of actions for a target is built in one place and drawn by the pill. The pill gets `Open in Files`, `Open in GitHub` and `Copy path`, the branch beside the folder's name, and the Info tab gets the `Branch` row. The same builder serves the chip and the tree in the next stages.

- [x] Complete
  - [x] a target and its actions: kinds, order and labels of the decisions, tested as pure functions (the GitHub link, the relative path, which items show)
  - [x] `useFolderGit` reads the remote and branch of a folder on mount and when the window regains focus
  - [x] `Open in Files` opens the side panel on Files and opens the path in the folder's manager
  - [x] the pill's popover is drawn from the actions; the branch is next to the name; the Info tab has the `Branch` row

**Files**

- `apps/desktop/src/renderer/features/openWith/openTarget.ts` — create: the target, `githubLink`, `openActions`; pure, so Vitest runs it without React, and `openApps.ts` is about programs
- `apps/desktop/src/renderer/features/openWith/openTarget.test.ts` — create
- `apps/desktop/src/renderer/features/openWith/useFolderGit.ts` — create: a hook with its own state and focus listener, which `useOpenApps` has no place for
- `apps/desktop/src/renderer/features/openWith/OpenWithMenu.tsx` — create: the menu content shared by the pill and the chip; `ChatFolder.tsx` is one pill, the chip is elsewhere
- `apps/desktop/src/renderer/features/openWith/index.ts` — exports
- `apps/desktop/src/renderer/features/agents/ChatFolder.tsx` — the pill uses `OpenWithMenu`, shows the branch
- `apps/desktop/src/renderer/features/agents/ChatFolder.module.css` — the branch label
- `apps/desktop/src/renderer/features/agents/ChatFolder.test.tsx` — the new items and the branch
- `apps/desktop/src/renderer/features/sidePanel/InfoTab.tsx` — the `Branch` row

**Done when:** the pill's menu lists Open in Files, the editor, Finder, the terminal, GitHub and the two copies for a folder with a GitHub remote, and the branch shows beside its name and in Info.
**Verify:** `cd apps/desktop && bun run test -- src/renderer/features && bun run typecheck && bun run lint`
**Commits:**

- `ef4650e` feat(desktop): one menu to open, show and copy a folder, with the branch beside it (`openTarget.ts`, `useFolderGit.ts`, `OpenWithMenu.tsx`, `openInFiles.ts`, the pill, the Info row; the quick search takes its Files helpers from `openInFiles.ts`)
- `95fdb55` refactor(desktop): share the icon of a menu item between the menu and the tree (`actionIcon`)

## Stage 4 — The file chip

**Depends on:** Stage 3.

**This stage:** A chip in a message opens its file in the Files tab on a press, and the menu of Stage 3 on a right-click, or on a press that cannot open anything. The chip's path is resolved against the folder of the open chat, or the folders of the project when it is absolute.

- [x] Complete
  - [x] `resolveChipTarget` turns a chip's path into a target, or nothing for a path outside the project
  - [x] a press opens the file in Files; a missing file or an unresolved path opens the menu at the pointer
  - [x] a right-click opens the menu; the press no longer copies

**Files**

- `apps/desktop/src/renderer/features/openWith/openTarget.ts` — `resolveChipTarget`
- `apps/desktop/src/renderer/stream/markdown/FileChip.tsx` — press, `useContextMenu`, the menu
- `apps/desktop/src/renderer/stream/markdown/FileChip.test.tsx` — the three behaviours

**Done when:** a test presses a chip and the file opens in the manager, presses one of a missing file and gets the menu, and right-clicks one and gets the menu.
**Verify:** `cd apps/desktop && bun run test -- src/renderer/stream && bun run typecheck && bun run lint`
**Commits:**

- `fef6760` feat(desktop): open a file chip in the Files tab, and its menu on a right-click. `resolveChipTarget` lives in `stream/markdown/chipTarget.ts` (with its test), next to `chipPath.ts`, not in `openTarget.ts`: it reads the chip's own path form, and `openWith` should not know the stream. The three tests that draw a chip without a project (`Markdown`, `UserBubble`, `FileChip`) now draw it in a window that has one.

## Stage 5 — The Files tree

**Depends on:** Stage 3.

**This stage:** The tree's row menu gets the `Open in…` submenu and the two copy items for a single row. This needs `FileMenuItem` to carry children, which is a change to the shared file manager package.

- [x] Complete
  - [x] `FileMenuItem.children` draws a submenu in the row menu
  - [x] the Files tab passes `menuItems`: `Open in…` (editor, Show in Finder, terminal for a folder, GitHub), `Copy path`, `Copy relative path`; none for several rows

**Files**

- `packages/file-manager/src/react/explorer/ExplorerMenu.tsx` — `FileMenuItem.children`, `SubmenuTrigger`
- `packages/file-manager/src/react/index.ts` — only if the type needs a new export
- `apps/desktop/src/renderer/features/files/FilesTab.tsx` — `menuItems`
- `apps/desktop/src/renderer/features/files/openInMenuItems.ts` — create: the pure builder of the tree's items, which `FilesTab.tsx` (a component) calls; with `openInMenuItems.test.ts`
- `apps/desktop/src/renderer/features/files/FileManagerView.test.tsx` — the submenu drawn, opened and run (the package has no browser tests, and this file has the harness that draws the tree)

**Done when:** a right-click on a file row shows `Open in…` with its items and the copy items, and a selection of several rows shows neither.
**Verify:** `cd packages/file-manager && bun run test && bun run typecheck`, then `cd apps/desktop && bun run test -- src/renderer/features/files && bun run typecheck`
**Commits:**

- `dcc489a` feat(file-manager): let a host item of the row menu open a submenu (`FileMenuItem.children`, the test in `FileManagerView.test.tsx`)
- `64ddbb1` feat(desktop): open a file or a folder of the tree in an editor, the file manager or GitHub, and copy its path (`openInMenuItems`, `FilesTab`)

## Review

One review of the five stages, by a reviewer apart from the implementers. Fixed after it:

- `a307ebb` an app bundle (a folder `X.app`, also through a symlink) is shown in its parent folder by the system file manager instead of being started by `shell.openPath`
- `9d3265c` `openInFiles` checks that the path is there before it opens a tab, so a chip of a missing file no longer changes the active tab or pushes one out; `openInFiles.test.ts`
- `440d87a` `useFolderGit` ties its answer to the folder it was read for and drops stale answers; `useFolderGit.test.tsx`
- `f42f040` unused barrel exports removed
- `f9cf6d9` `apps/desktop/AGENTS.md` and `apps/daemon/AGENTS.md` describe `openPath`, the menu of a path, the branch and `?project=`

Left as follow-ups, none blocking:

- The read of every project (Settings > Projects poll, the agents screen) now also runs `git branch --show-current` for each folder. Read the branch only with `?project=` if it ever matters.
- The chip menu fills in late: the programs (IPC) and the git facts (HTTP) are read when it opens. A small cache of the last answers would remove the growth of the popover.
- Done in 482b510: a chip for a folder written without a trailing slash (`src/booking`) was taken for a file, so its menu said `Show in` and its GitHub link was a `/blob/`. `useKindOnDisk` now reads the kind from the tree or the listing of the folder when the menu opens. The chip's icon still follows the written path, since reading the disk for every chip would load the file manager for each one.
- Done in 482b510: in the Files tree's row menu, Copy path is a submenu (Absolute path, Relative path) and Open in… has an icon; both go after the row's own items, before Delete. The folder pill's and the chip's menus keep their flat Copy path and Copy relative path.
- Not checked on a real machine: launching Finder, an editor and a terminal on macOS and Windows, and the menus in the running app.
