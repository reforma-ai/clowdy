# Docs into the side panel

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** Documents stop being a screen of their own with a second editor shell. Docs becomes a tab of the side panel's right rail that shows the same file manager as Files (the same tabs, the same editor area, the same buffers and conflicts), with a different sidebar tree: the project folder's `.clowdy/docs`, as a tree drawn like the file tree. The old Docs code is deleted.

**Approach:** One `FileManager` per project folder, as today. The Files tab and the Docs tab both draw `FileManagerView` over that manager; only the sidebar differs. The explorer gets a `scope` (a root path and a filter) so it can draw the manager's own entries below `.clowdy/docs`, Markdown files and their folders only, whatever the hidden globs say. The host keeps one component mounted for both tabs, so switching between them moves nothing in the editor. What the daemon's docs service did that `fs` already does (atomic writes, versions, watching) goes with it; the listing the composer's `@doc` mentions and Cmd+K need stays.

**Research:** `a812b789c3baa10e8`'s report (this session): both screens use `packages/components` `MarkdownEditor`; the daemon's Docs service duplicates `fs`; nothing about documents is in the database; the daemon never writes task doc artifacts; agents write documents straight to the files, there is no `clowdy docs` command.

**Decisions** (the owner's, from the chat)

- Docs is a tab of the side panel (rail item **Docs**), no longer a section of the left rail. Opening a document reuses the Files UI whole: the tab strip, the editor area, the buffers. Only the sidebar tree differs.
- The same file opened from the file tree or from the docs tree is the same tab, with the same behaviour on a conflict (Reload / Overwrite, as Files has it). There is one file manager per folder, not two.
- The docs tree is the file tree's own rows (the same explorer, not a custom layout), with a structure close to the file system: `.clowdy/docs`, Markdown files and the folders that hold them. A custom navigation (research and plans in groups, whatever the folders say) comes later; nothing is done for it now.
- The panel shows one folder, as Files and Terminal do (`currentFolder`): the all-folders view of the old Docs screen goes. Accepted.
- Not needed now, though Files has them already or the old Docs had them: rename, delete, move (Files' row menu has them), the three-way conflict view with a line diff, the read-only Preview.
- `@doc` mentions stay. Cmd+K probably gets a **Docs** tab: the files tab keeps leaving out `.clowdy`, the docs tab returns what is hidden in it.
- The old Docs code is deleted: the screen, its store, the left rail item and its chord, the history and UI state of a document, the daemon's docs read, write, watch, command, route and event, the task doc artifacts that nothing writes, their tests.

**Defaults I took** (the owner may change them)

- The rail order is Info, Files, Docs, Terminal. The key of Docs is `Cmd+3` (`Ctrl+3`), and Terminal keeps `Cmd+2`.
- New document is an item of the docs tree's menus: an inline row, `.md` added when the name has none, in the folder under the row (or the docs root).
- The docs tree's filter field filters the tree's own rows by name (not through the daemon, whose search leaves `.clowdy` out).
- A path chip in a message that points below `.clowdy/docs` opens in the Docs tab, any other path in Files.

## Out of scope

- A custom docs navigation, a folder switch for the docs of another folder of the project, text search in documents.
- The look of the docs tree beyond what the file tree has.
- Anything about the agents' documents skill beyond its wording where it names "the Documents screen".

## Stage 1 — The explorer draws a scope

**Depends on:** None.

**This stage:** `FileTree` can say the children of a path without the hidden and excluded rules (`entriesOf`), and the explorer takes a `scope` (`root`, `include`) that makes its rows the entries below `root` that pass `include`, with creating, pasting and dropping defaulting to the root. `FileManagerView` takes the same `scope` for its sidebar, with the filter's placeholder and the empty state as props, and filters the scoped rows by name itself.

- [x] Complete
  - [x] `FileTree.entriesOf(parent)`: every entry whose parent is `parent`, sorted as `children` is, hidden or not (and `loadDeep`, which lists a scope whole)
  - [x] `Explorer` `scope`: rows from `entriesOf(scope.root)` filtered by `scope.include`, folders kept, and the root in place of `''` for a new row, a paste and a drop
  - [x] `FileManagerView` `scope`, `filterPlaceholder` and `emptyText`: the scoped filter by name, the empty state of a root with no entries
  - [x] tests: the tree's `entriesOf` and `loadDeep`, and a view over `.clowdy/docs/a.md`, `.clowdy/docs/plans/b.md`, `.clowdy/docs/x.png` and `src/a.ts` that shows the two documents, filters its own rows and opens in the manager's tabs (creating below the root is not driven by a test: the explorer's draft row has none)

**Done when:** a test renders `FileManagerView` with a docs scope and finds exactly the two Markdown files under a root that the hidden globs would hide, a new row creates `.clowdy/docs/<name>.md` territory (below the root), and the unscoped view still lists everything.
**Verify:** `cd packages/file-manager && bun run test && bun run typecheck && bunx eslint src specs`; `cd apps/desktop && bunx vitest run src/renderer/features/files`
**Commits:** `359881d` feat(file-manager): draw a part of the tree by rules of its own, with a filter of its own

## Stage 2 — The Docs tab

**Depends on:** Stage 1.

**This stage:** the side panel gets a Docs tab on its rail. `FilesTab` takes a `variant` (`files` or `docs`) and draws the same `FileManagerView` over the same manager, with the docs scope for `docs`, so switching tabs moves no editor. A New document item, the `Cmd+3` key and the fixtures' documents (in the fixture file system, under `.clowdy/docs`) come with it. The old Docs section stays until Stage 4, so both exist for now.

- [x] Complete
  - [x] `SIDE_PANEL_TABS` and its label, key and command for `docs`; `UiStore` keeps and restores it; the rail item, with the `File` icon, after Files
  - [x] `SidePanel` keeps one `FilesTab` mounted for `files` and `docs`
  - [x] the docs tree's New file item and the `.md` rule (the tree's own New file, with `scope.fileName`)
  - [x] the fixtures' documents are also files below `.clowdy/docs` in the fixture file system (`getDocsTree` still reads the old fixture data until the old code goes)
  - [x] tests for the tab, the key, the shared view that stays built, the scope and the stored tab

**Done when:** in the fixtures page the Docs tab shows the fixture documents as a tree beside the same editor and tabs as Files, a document opened there is still open when the Files tab is chosen, and `Cmd+3` toggles the tab.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/sidePanel src/renderer/features/files src/renderer/shell src/renderer/stores && bun run typecheck`, and a screenshot of the Docs tab.
**Commits:** `0e7e8e9` feat(desktop): add a Docs tab to the side panel that is the Files view over a folder of documents; `674359b` fix(desktop): let the Docs tab's plate fill the panel as Files' does (the plate's rule named only `files` and `terminal`, so the height collapsed once the tree was hidden)

## Stage 3 — Chips, mentions and Cmd+K reach the Docs tab

**Depends on:** Stage 2.

**This stage:** a path chip below `.clowdy/docs` opens in the Docs tab; `@doc` mentions read the daemon's docs listing as they do now, and Cmd+K gets a Docs tab (names from the same listing, opening a document in the Docs tab).

- [ ] Complete
  - [x] `openInFiles` picks the tab by the path; the chip, the row menu and the palette's results follow (`showFilesTab` takes the tab)
  - [ ] the palette's Docs tab, its model, source, keys and tests (not done: the owner said "possibly"; it is a follow-up, nothing breaks without it, since the palette never found documents)
  - [x] `@doc` mentions keep working: they read the daemon's docs listing, which stays

**Done when:** a chip to `.clowdy/docs/decisions/pricing.md` opens the document in the Docs tab, Cmd+K's Docs tab finds a document by its name, and `@` still offers documents.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features/quickSearch src/renderer/features/chats src/renderer/features/files src/renderer/stream`
**Commits:** `6f4501f` feat(desktop): open a document from a chip or the palette on the Docs tab

## Stage 4 — Delete the old Docs

**Depends on:** Stage 3.

**This stage:** everything the inventory lists goes.

- [ ] Complete
  - [x] renderer: `features/docs/`, the left rail item and `Shell`'s screen, `nav.docs` and the `g d` chord, `SECTIONS` 'docs', `docPath`, `docFolderId`, `openDoc`, `NavHistory` and `ProjectState.lastDocsChange` (commit `163a1b3`)
  - [ ] renderer, with the protocol: `getDocFile` in the transports, the fixture `docs.write`, the `docs.changed` case that `ProjectState` still ignores
  - [x] tasks: kept, not deleted (scope change): a doc result and `O D` open the document on the Docs tab (`openDocument`), so the task model's own feature is not touched
  - [ ] daemon and protocol: the `docs.write` command, `GET docs/file`, the docs read, write, announce and watcher code, `docs.changed`, `DocFile`; `realPathBelow` moves to where `projectIcon` can reach it; the listing stays
  - [ ] the tests of all of it, the skill's and prompts' wording, the README, both `AGENTS.md`
  - [ ] stored state: a stored `section: 'docs'` falls back to Agents (already covered); `clowdy:sidebar-width:docs` is left alone

**Done when:** no reference to the removed names is left (`grep`), the daemon's tests and the app's pass, and a project with documents shows them in the Docs tab.
**Verify:** `bunx turbo run build lint typecheck test --affected`

## Stage 5 — Review and docs

**Depends on:** Stage 4.

- [ ] Complete
  - [ ] `briefback review` of the whole change
  - [ ] `apps/desktop/AGENTS.md` and `packages/file-manager/AGENTS.md` describe the scope and the Docs tab, and the Docs bullet is gone
