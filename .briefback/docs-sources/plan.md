# Docs sources

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** The Docs tab shows the folders where a project's work is written down, not one fixed folder: Clowdy's own `.briefback` (plans, research, handoffs, the pages the work is done from) and the folders of the other spec-driven tools it finds (Spec Kit, OpenSpec, Kiro). Each source found is a gray label with its file tree under it.

**Approach:** A source is a root folder of the project folder (`{ id, label, root }`). One registry, shared by the daemon and the app (`packages/protocol`), says which roots a project can have and what has to exist for one to count; a pure function takes "does this path exist" and answers the sources, so the daemon runs it on the disk (for the `@` mentions and the palette's list) and the app runs it on the file tree it already holds (so a root that an agent creates a minute later shows up through the file manager's watch, with no new request). Paths stay real project paths everywhere (tabs, chips, the palette), so nothing is translated: the explorer's scope grows from one root to a list of roots, each drawn under a gray label row. No source-specific grouping or reading of formats yet: a source is its Markdown file tree.

**Research:** `.briefback/docs-sources/research/spec-formats.md` (commit `0d4c1b8`): layouts, noise and detection of Spec Kit, OpenSpec, Kiro, BMAD, Taskmaster, Tessl, with sources and UNVERIFIED marks.

**Decisions** (the owner's, from the chat)

- `.briefback` is Clowdy's in-house format and its files are what the Docs tab is for: plans, research and handoffs, not only `.briefback/docs/` (the `document` step is the most optional one; about 90% of a `.briefback` is research and plans). The whole `.briefback` is a source.
- A source that is found is drawn as a gray label with its tree under it.
- The tree of a source is its file tree for now. A grouping by feature (`.briefback/<slug>` as a folder `<slug>` that holds its research, plan and handoff) and any format-specific grouping come later.
- The other tools' sources are their own folders as a file tree. The in-house format is to be settled later (inherited from `.briefback` or the same), and the Docs tab will follow it.
- `.clowdy/docs` need not be supported, since its format was never settled.
- The Docs tab has its own tabs and its own file manager (an earlier decision, stays).

**Defaults I took** (the owner may change them)

- `.clowdy/docs` stays as one more source, labeled Documents, found when the folder exists. The agents' skills (`docs`, `semi-manual`, `scaffold`, `orchestrate`, `thread`, `autopilot`) and the daemon's prompts send agents there, so dropping the source now would hide what they write; removing the convention is a separate piece of work (rewrite those, move the `@doc` path). One entry in the registry, and it can go with a line when the format is settled.
- Sources are roots only, never a tool's whole folder: Spec Kit `specs`, `.specify/memory`, `.specify/bugs`, `.specify/assessments` (found with `.specify/`); OpenSpec `openspec/specs` and `openspec/changes`; Kiro `.kiro/specs` and `.kiro/steering`. That keeps templates, scripts, schemas and agent files out without any exclude rule.
- A source shows only while its root holds a Markdown file. Nothing found: the tab says `No documents found`.
- Order is the registry's: Briefback, Documents, Spec Kit, OpenSpec, Kiro. Labels carry the tool name.
- New file works in every source (it is a file tree) and adds `.md` when the name has no Markdown extension; from the empty area it goes to the first source, from a row's menu into that row's folder.
- BMAD (its folder is read from `_bmad/config.toml`, and v7 is an alpha), Taskmaster, Tessl, Cursor rules and `AGENTS.md`/`CLAUDE.md` are not sources in this version.
- A path is a document when it is Markdown below a root of the registry (a static rule, so the routing of a path to the Docs tab stays synchronous): `specs/x.md` in a project that has no `.specify/` opens in the Docs tab's tabs but is not drawn in its tree.

## Out of scope

- Grouping the tree by feature, status or tool; reading task checkboxes or status lines; the YAML front matter of Kiro steering (how the editor shows it is not checked).
- BMAD, Taskmaster, Tessl; nested projects (`apps/web/.specify`); a folder switch.
- A provider rooted at the sources, which would stop the Docs file manager from listing the whole folder (a later cost cut, the owner's idea).
- Removing `.clowdy/docs` from the agents' skills and prompts.

## Stage 1 — The registry, the protocol and the daemon

**Depends on:** None.

**This stage:** `packages/protocol` gets `DOC_SOURCES` and `docSourcesOf(has)` (and `isDocumentPath`, the static rule); `DocsFolder` answers `sources: [{ id, label, root, nodes }]` in place of `nodes`; the daemon's `docsTree` runs the registry on the disk and lists each source whole (a root that leads out of the folder, or is a file, is left out as today's docs folder is).

- [x] Complete
  - [x] the registry and `docSourcesOf` (`packages/protocol/src/docSources.ts`: `DOC_SOURCES`, `docSourcesOf`, `docSourceOf`, the static `isDocumentPath`), with tests
  - [x] `DocsFolder.sources`, the daemon's `docsTree`, its tests. Scope change: a source whose root leads out of the folder, is a file or has no Markdown is left out and does not take the others down (a symlinked `specs` to a shared folder is common, and an error would blank every `@doc` mention); only a missing main folder is `unavailable`; `listDocs` skips a folder it cannot read
  - [x] the consumers of `getDocsTree`: `@` mentions (the real project path), the palette's Docs list (`matchDocs` keeps the tree's order on ties, so Briefback comes first), the fixtures (a `weekend-pricing` feature under `.briefback`)

**Done when:** `GET docs` for a folder with `.briefback/` and `.specify/` answers both, each with its Markdown tree, and `@` offers the files of every source.
**Verify:** `cd packages/protocol && bun run test && bun run typecheck`; `cd apps/daemon && bun test test/docs.test.ts`; `cd apps/desktop && bunx vitest run src/renderer/features/chats src/renderer/daemon`

## Stage 2 — The explorer draws several roots

**Depends on:** None (the explorer takes a list of roots; the app feeds it in Stage 3).

**This stage:** `ExplorerScope.root` becomes `roots: [{ id, label, root }]`; the explorer draws, for each, a gray label row (not selectable, no menu of its own beyond New file) and the root's entries under it at the first level; the scoped name filter, `loadDeep`, new file, paste and drop work per root.

- [x] Complete
  - [x] `ExplorerScope.roots` (`ExplorerScopeRoot { id, label, root }`, may be a getter over observable state), label rows in the explorer's data (`/root:<id>`, `role="presentation"`, not selectable, openable, renamable or draggable), their look (gray, small, no chevron)
  - [x] `scopeFilter` and the deep listing over several roots; create, paste, drop and the area menu default to the first root that has rows, a row's menu to its folder, a label's own menu offers New file, New folder and Paste into its root; a row dropped at the top level lands in the root whose label is nearest above
  - [x] tests (`specs/scope-rows.test.ts`, the desktop `FileManagerView.test.tsx` section): two roots drawn with their labels, a filter across both, a label that cannot be selected, a root with no entry hidden. Not driven by a test: a real drag between roots (only the pure `rootAtIndex`), the Delete key on a label (guarded in code: a label has no targets)

**Done when:** a view over a tree with `.briefback` and `specs` entries shows two labels, each with its Markdown files, and the filter finds a file in either.
**Verify:** `cd packages/file-manager && bun run test && bun run typecheck && bunx eslint src specs`; `cd apps/desktop && bunx vitest run src/renderer/features/files`

## Stage 3 — The Docs tab follows the sources

**Depends on:** Stages 1 and 2.

**This stage:** the Docs tab's scope is built from the tree it holds (`docSourcesOf` over `manager.tree`), live; `isDocumentPath` and `tabOf` use the registry's static rule; `openDocument`, chips, task results and the palette open a path in the Docs tab by it; the empty state and the labels.

- [x] Complete
  - [x] the scope from the tree, observed (`docsScopeOf(manager)`: a `roots` getter over `docSourcesOf` and the tree's entries; a root that appears through the watch shows up, tested with a mobx reaction)
  - [x] `docsScope.ts` (the static `isDocumentPath` of the protocol, `DOCS_ROOT` kept for a task's document result), `openInFiles` and the palette follow by `tabOf`; `openDocument` and `tasksScope` unchanged (they name `.clowdy/docs`)
  - [x] the fixture's `.briefback` tree (Stage 1), a screenshot of the Docs tab: Briefback and Documents as two gray labels with their trees
  - Known, left: a root that holds only empty or non-Markdown folders is still drawn (the tree cannot tell before it lists the root); the empty text is `No documents found`

**Done when:** in the fixtures page the Docs tab shows Briefback and Documents as two gray labels with their trees, a plan opened from it is a tab of the Docs tab only, and Cmd+K's Docs tab finds a file of `.briefback`.
**Verify:** `cd apps/desktop && bunx vitest run src/renderer/features && bun run typecheck`, and a screenshot.

## Stage 4 — Docs and review

**Depends on:** Stage 3.

- [x] Complete
  - [x] `apps/desktop/AGENTS.md`, `apps/daemon/AGENTS.md`, `packages/file-manager/AGENTS.md`, the `docs` skill's note on where the Docs tab looks
  - [x] `briefback review` of the whole change (an independent read-only reviewer: findings below)

**Review findings, fixed:**
- A folder with no source could not get its first document from the Docs tab (no root, so no area menu, drop or draft): the scope answers `.clowdy/docs` alone where there is no source, a root that is not drawn while it is empty but can host the new file.
- A resync failed for good when a folder opened or listed deep was gone since (a branch checkout overflows the watcher into a bare `resync` with no delete events): `FileTree` forgets a folder that is NotFound instead of failing the whole refresh, and lists a folder that `loadDeep` listed once, whole, on a resync, not every folder below it one by one.
- `@` suggestions: the list is ranked by name before it is cut (`compareDocs`, also the palette's order: the name that starts with the word, the one that has it, the one only the path has, the shorter name first), and no source gives more than four, so a source with many plans does not take the menu from the others.
- A walk of every source on each key: `.git` and `node_modules` are never listed, a source is listed up to 20 000 entries, and the palette reads the documents once while it is open.
- `docSourceOf` was dead code (no two roots nest): deleted. Stale comments in the protocol, `FileManagerView`, the AGENTS notes and the docs skill.

**Review findings, left:** an outside drag over the first root tints the whole tree though the drop lands in that root only (cosmetic); the `@` menu still asks the daemon for the documents on each key (bounded now, not cached: a cache would hide a document made a second ago from the menu).

**Commits:** `fab398e`, `12f8899`, `8698655`; the review fixes in the commit that follows them.
