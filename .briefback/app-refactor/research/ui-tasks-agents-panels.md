# Renderer UI quality: tasks, agents and the side panels

## Summary

Scope: `apps/desktop/src/renderer/features/{tasks,agents,sidePanel,quickSearch,files,openWith,terminal,worktrees}`, compared against `packages/components`, `packages/styles`, `DESIGN.md` and `apps/desktop/AGENTS.md` ("The renderer").

These features build on the design system for the big pieces: `GridList`, `Menu`, `Popover`, `Select`, `Table`, `TabStrip`, `Alert`, `Breadcrumb`, `ToggleButtonGroup`, `ConfirmButton`, `Badge` and `Shimmer`. `files`, `openWith`, `terminal` and `worktrees` are mostly clean. Most of the debt is in the small pieces between those components, and the tasks detail panel and the agents list are where it piles up:

- **Rows written by hand.** The same "row that opens something" button (hover plate, focus outline, negative inline margin) is copied 7 times in the task panels. The "key + title" task reference is copied 5 times.
- **Chips and pills.** There are 4 chip implementations, 2 pill implementations and 3 separate tone maps for one `StatusTone` type.
- **Fold and stop-propagation helpers.** The fold/chevron control and the wrapper that stops a control's events from reaching its row are each copied across 5 files.
- **Empty, loading and error states.** These are rebuilt inline instead of using `PanelEmptyState` / `PanelLoadingState` / `PanelEmptyRow`.
- **`AgentList.tsx` (1190 lines).** It derives the whole list model inside render, so the model is rebuilt on every `run.upserted`, and the daemon sends that event for every 1% change in a run's context usage. The list is not virtualized, although the code itself notes that a workflow can list hundreds of sub-agent rows.
- **Confirmed design-system defect.** `--color-focus-ring` is not defined anywhere, so 5 focus rings fall back to `currentcolor`.
- **Worktree dialogs.** They keep JSX and mutable objects in state and re-implement `ConfirmModal`'s pending, lock and error flow.
- **Dead code and lint gaps.** Unused locals and imports exist, and nothing catches them: Biome's `noUnusedVariables` / `noUnusedImports` rules and `noUnusedLocals` are all off.

## Findings

### F1. The task detail panel hand-rolls the same "row that opens something" seven times, and the "key + title" reference five times
- Where:
  - Row buttons (TSX): `features/tasks/DetailSections.tsx:52-66` (Executors), `:83-90` (Related chats), `:157-169` (Results); `SubtasksSection.tsx:53-67`; `ParentRow.tsx:46-55`; `ArchivedPanel.tsx:112-122`; `DependencyList.tsx:61-98`; `ArchiveView.tsx:166-197`.
  - The same CSS each time (flex, gap md, padding sm/xs md, `radius-md` squircle, hover `--color-secondary-muted-light`, `outline: var(--spacing-2) solid var(--color-primary-muted-border)`, `margin-inline: calc(var(--spacing-md) * -1)`): `DetailSections.module.css:22-63`, `SubtasksSection.module.css:4-35`, `ParentRow.module.css:11-36`, `ArchivedPanel.module.css:16-40`, `DependencyList.module.css:9-48`, `ArchiveView.module.css:71-91,133-148`.
  - "Key (xs, muted, 500) + truncated title": `ParentRow.module.css:38-51`, `SubtasksSection.module.css:44-57`, `DependencyList.module.css:50-63`, `ArchivedPanel.module.css:42-55`, `ArchiveView.module.css:150-164`.
- Problem (observed): about 250 lines of near-identical CSS spread over 6 modules. They have already drifted: padding is `sm` in some and `xs` in others, `ArchivedPanel.parent` bleeds on both sides while `ParentRow.open` bleeds only at the start, and focus rings differ (see F6). A change to the panel's row look has to be made in 6 places.
- Fix: add `features/tasks/DetailRow.tsx` with `DetailRow({ icon?, children, meta?, end?, onPress?, title? })`. It renders a `<button>` when `onPress` is set and a `<div>` otherwise, and owns the bleed, hover and focus once. Add `TaskRef({ task, status? })`: a `StatusIcon`, then the key, then a truncated `Text`. Use them in Executors, RelatedChats, Results, SubtasksSection, ParentRow, ArchivedPanel's parent, DependencyList and ArchiveView. Delete the per-module `.row/.open/.key/.title` blocks. Use `Text truncate` instead of hand-written ellipsis.
- Category: reuse
- Effort: M. Risk: low (visual only; tests select by role and label)

### F2. Four chips, two pills and three tone maps for one visual
- Where:
  - Chips (20px, `radius-sm` squircle, muted stone plate, 12px 500): `shared/Chip.module.css:4-22` (AgentChip, TaskChip, MentionChip, PullRequestChip); `features/tasks/TaskChips.module.css:4-38` (its own comment says it is "the chat chip of the app"); `features/tasks/DetailPanel.module.css:20-32` (`.key`, also used by `ArchivedPanel.tsx:66`); and `@clowdy/components` `Badge`, an RAC TagGroup used at `features/worktrees/WorktreeRow.tsx:91`.
  - Pills (20px, `radius-full`, tone): `features/tasks/Pill.module.css:3-18` (+ `StatusTone.module.css`) and `shared/RunStatusPill.module.css:3-38`, which has its own tone block.
  - Tone maps for `StatusTone`: `shared/StatusTone.module.css`, `shared/RunStatusPill.module.css:22-40`, `shared/StatusDot.module.css:11-25`.
  - Plain "Box icon + key" lines: `TaskCard.module.css:39-47`, `ScopeHeader.module.css:18-27` (and the JSX at `TaskCard.tsx:57-63`, `ScopeHeader.tsx:35-38`, `DetailPanel.tsx:102-105`, `ArchivedPanel.tsx:66-69`).
- Problem (observed): DESIGN.md defines one chat chip (20px, `sm` squircle, muted stone, 12px), but it is implemented 3 times plus `Badge`. Hover, focus and done colours differ by copy: only `TaskChips` has a focus ring, and only `Chip.module.css` has tone hover. A tone change has to be made in 3 files.
- Fix: one `Chip` component (`shared/Chip.tsx` for now; promote it to `packages/components` if Reforma's `Tag` is not wanted for non-collection chips) with props `tone?: StatusTone`, `rounded?` (pill), `icon?`, `onPress?` (renders a `<button>` with the shared focus ring), `title?` (through `Tooltip`). `Pill` and `RunStatusPill` become `Chip rounded`. `RollUpChip`, `ChecklistChip` and the panel key chip become `Chip`. Keep one tone map (`StatusTone.module.css`) and make `StatusDot` read `--clowdy-status-color` from it. Add a `TaskKey` (icon + key) for the four key lines.
- Category: design-system
- Effort: M. Risk: low

### F3. `AgentList.tsx` derives the list model in render, so every run update rebuilds it
- Where:
  - `features/agents/AgentList.tsx:211-373`: cards, draft cards, main cards, sorting, entries, navigation ids and the selected id, all inline in the component body.
  - `:280-301`: `nativeAgentsByRoot` over all runs, plus `rowsOf` building `new Set(ui.expandedChats)` on every call.
  - Linear lookups: `:446-463` (`foldOf` → `entries.find`) and `:495`; `navigationIds.includes` at `:366,371`.
  - Per row: `threadsBelow` called twice (`:197-203`, `:714`), plus `groupFolderOf` and two `chatWorktreeKey` (`:785-793`).
  - Trigger: `features/agents/Screen.tsx:28-29,51,58-64` reads `project.runs.values()` and passes a new `missing` Set and a new `selection` object on every render.
- Problem:
  - Observed: `ProjectState.ts:251-252` replaces the run on every `run.upserted`. The daemon sends one for every 1% step in a run's context usage (`apps/daemon/src/runs/service.ts:1258-1267`), and for status, summary and background changes. Screen and AgentList read `project.runs`, so each event re-renders the screen and rebuilds the whole model.
  - Observed: only `SubagentItem` is memoised. Chat rows are rebuilt each time.
  - Observed: the comment at `:897-898` already says a workflow can list "hundreds" of sub-agent rows, and the `GridList` is not virtualized.
  - Inferred: with several active runs and a large list, this is the main source of jank in the sidebar.
  - Readability: this is a 160-line derivation with no tests of its own. `agentTree.ts` and `worktreeCards.ts` are tested; this composition is not.
- Fix:
  - Move lines 211-373 into a pure `agentListEntries({ chats, project, ui, actual, projectInfo, missing, preferences })` in `agentTree.ts` (or a new `agentListModel.ts`). It should return `{ entries, cards, visibleRows: Map, entryByKey: Map, navigationIds, selectedId }`, with unit tests.
  - Better still, make it a MobX `computed` on a small per-project model, so a context-only run change does not recompute the list.
  - Memoise the chat row like `SubagentItem`, with stable handlers.
  - Replace `entries.find` and `includes` with the returned maps.
  - Once rows are stable, evaluate RAC `Virtualizer` for the `GridList` (Select already uses it).
- Category: perf
- Effort: L. Risk: medium (keyboard and fold behaviour is covered by `AgentListWorking.test.tsx` and `Screen.test.tsx`)

### F4. The fold/chevron control is copied: an exact JSX duplicate, and two identical raw buttons
- Where:
  - `features/agents/AgentList.tsx:963-997` (`Fold`, not exported) and `features/agents/WorktreeCardHeader.tsx:106-135` (the same `foldIcon/restIcon/fold` spans and the same `Button` with chevrons, inlined).
  - `features/tasks/TaskList.tsx:92-111` with `TaskList.module.css:58-90`, and `features/tasks/ArchiveView.tsx:174-186` with `ArchiveView.module.css:93-130`: the same raw 16px `<button className={styles.chevron}>` and byte-identical CSS.
  - `@clowdy/components` `TreeChevron` (`Panel/TreeChevron.tsx`) exists but is an `aria-hidden` span with no button semantics.
- Problem (observed): two fold implementations in agents and two in tasks. The raw buttons skip `Button`'s focus ring, press scale and tokens.
- Fix: export `Fold` from `AgentList.tsx`, or better move it to `shared/FoldIcon.tsx`, and use it in `WorktreeCardHeader`. Add a `FoldButton({ isExpanded, label, onToggle, size })` to `packages/components/src/Panel` next to `TreeChevron`. It should wrap `Button iconOnly variant="filling"` with `aria-expanded` and use the 8px chevrons. Use it in TaskList and ArchiveView and delete both `.chevron` blocks.
- Category: reuse
- Effort: S. Risk: low

### F5. The wrapper that stops row events, and the row action button, are copied across files
- Where:
  - Event isolation: `features/agents/AgentList.tsx:125-131` (`ownEvents`, spread 8 times), `features/agents/ArchiveButton.tsx:138-144`, `features/agents/WorktreeCardHeader.tsx:100,111-116,150`, `features/tasks/TaskList.tsx:16,101-102,134-136`, `features/tasks/TaskChips.tsx:51-56`.
  - Button prop set `variant="filling" color="secondary" size="xs" iconOnly preventFocusOnPress`: 12 copies (AgentList ×8, WorktreeCardHeader ×3, ArchiveButton ×1).
- Problem (observed): every row with controls re-learns that RAC rows take their children's events. The handled event sets already differ: AgentList stops 5 events, WorktreeCardHeader 3, TaskList 3, and TaskChips stops click, pointerdown and keydown. A missed `onDoubleClick` or `onContextMenu` becomes a row bug.
- Fix: export a `RowControls` span from `packages/components/src/List` (or make `GridListItem`'s `endAffix`/`icon` slot isolate these events itself), plus `RowActionButton({ icon, label, ...ButtonProps })` that sets `aria-label` and `tooltip` from `label`. Use them in agents and tasks. `TaskList`'s cell and `RollUpChip` keep their `data-task-control` marker.
- Category: reuse
- Effort: S. Risk: low

### F6. `--color-focus-ring` is undefined, and focus rings come in three styles
- Where:
  - Undefined token, falls back to `currentcolor`: `features/worktrees/ManageWorktrees.module.css:140`, `shared/CardRow.module.css:44`, `shell/FolderList.module.css:80`, `features/settings/projects/ProjectDetail.module.css:42,83`. `rg color-focus-ring packages` finds no definition.
  - 2px outline: `tasks/DetailSections.module.css:62`, `DependencyList.module.css:47`, `SubtasksSection.module.css:34`, `CommentsSection.module.css:39`, `ArchiveView.module.css:125`, `ArchivedPanel.module.css:39`, `ParentRow.module.css:35`.
  - 4px box-shadow ring: `TaskCard.module.css:81`, `TaskChips.module.css:37`.
- Problem (observed): DESIGN.md requires a 4px Terracotta-muted ring with no offset. The worktree "New worktree" row, the project cards and the folder list draw a text-coloured 2px outline instead, because the variable resolves to nothing. Tasks use a 2px muted outline. Only two places follow the spec.
- Fix: replace the 5 `var(--color-focus-ring, currentcolor)` uses with the Button's ring (`box-shadow: 0 0 0 var(--spacing-4) var(--color-primary-muted-border)`). Better: add a shared `focus-ring` ruleset or uno shortcut in `@clowdy/styles` and use it in all 14 places. Most of them disappear with F1, F2 and F4.
- Category: design-system
- Effort: S. Risk: low

### F7. Empty, loading and error states rebuilt instead of `PanelEmptyState` / `PanelLoadingState` / `PanelEmptyRow`
- Where:
  - `features/tasks/ScopeEmpty.tsx:30-68` (three copies of "heading-4 + secondary + optional button", plus `ScopeEmpty.module.css`).
  - `ArchiveView.tsx:82-118` (Loader + text; heading + text) with `ArchiveView.module.css:4-13`.
  - `OpeningTask.tsx:47-51`; `CommentsSection.tsx:103-108`.
  - `DetailSections.tsx:39` (`None`); `Board.tsx:122` ("No tasks", `Board.module.css:59-65`); `worktrees/FolderWorktreesList.tsx:141-145` (`.message`); `quickSearch/QuickSearch.tsx:250-252` (`.empty`).
  - "Failed + Retry" rows: `DetailSections.tsx:143-150` and `CommentsSection.tsx:110-117,140-147`, with the same `.failed` CSS in both modules.
- Problem (observed): `PanelEmptyState` (icon, title, description, action), `PanelLoadingState` and `PanelEmptyRow` exist, and Changes, Terminal and SidePanel use them. Tasks rebuilt the same layouts with their own spacing.
- Fix: `ScopeEmpty` and ArchiveView's empty state become `PanelEmptyState` with an `action`. Loading becomes `PanelLoadingState`, or a small inline `Spinner` + text for in-section loads. `None` and Board's "No tasks" become `PanelEmptyRow`. Add `InlineRetry({ message, onRetry })` for the three failed rows, either in the tasks feature or as `PanelEmptyRow` with an action.
- Category: design-system
- Effort: S. Risk: low

### F8. The task panel frame is copied, and its stylesheet is borrowed by two other components
- Where: `features/tasks/DetailPanel.tsx:100-116` (head: key chip + Close), `ArchivedPanel.tsx:64-80` (same JSX, imports `DetailPanel.module.css` as `panelStyles`), `OpeningTask.tsx:38-44` (same head, also imports `DetailPanel.module.css`). The footers are also parallel (`DetailPanel.tsx:217-259`, `ArchivedPanel.tsx:146-166`).
- Problem (observed): three components depend on another component's private class names. A change to the panel's width or head breaks the other two without any type error.
- Fix: `TaskPanelFrame({ label, taskKey?, onClose, footer?, children, busy? })` in `features/tasks`. It owns `.panel/.head/.body/.foot`, and the three panels compose it.
- Category: structure
- Effort: S. Risk: low

### F9. Tasks Screen recomputes a join the store already caches; two `runsByTask` with different meanings; no status map
- Where:
  - `features/tasks/Screen.tsx:94` and `:213-214` call `taskView.runsByTask(project.runTaskLinks.values(), project.runs)` twice per render. `taskView.ts:27-39` counts only `assigned` links, including links of tasks not held in the store.
  - `stores/ProjectState.ts:509-516` is a MobX computed `runsByTask` that keeps every relation and only tasks the store holds.
  - `statuses.find(...)` is called per row and per panel at 17 sites, for example `tasks/TaskList.tsx:128`, `ArchiveView.tsx:199`, `SubtasksSection.tsx:50`, `DependencyList.tsx:57`, `DetailPanel.tsx:71`, `ArchivedPanel.tsx:45,48`, `Screen.tsx:367`, `shared/TaskChip.tsx:33`, `chats/TasksBanner.tsx:51`.
  - `Board.tsx:104-121` passes new inline callbacks to an unmemoised `TaskCard`.
- Problem (observed): any `run.upserted` re-renders the Tasks screen, rebuilds this join twice and re-renders every card. Two exported functions share one name with different semantics, so a later caller will pick the wrong one.
- Fix: add `ProjectState.assignedRunsByTask` (computed; rename or delete `taskView.runsByTask`) and `ProjectState.statusById` (computed `Map`, or `statusOf(id)`). Pass `statusById` to the list, board and panels. Memoise `TaskCard` with stable `onOpenScope`, `onDragStart` and `onDragEnd` (the parent passes task ids).
- Category: perf
- Effort: S. Risk: low

### F10. Worktree dialogs keep JSX and mutable objects in state, and re-implement `ConfirmModal`
- Where:
  - `features/worktrees/RemoveWorktreeDialog.tsx`:
    - JSX held in state: `:217` (`useState<ReactNode>`) and `:284-349` (`setContent(<RemoveMessage …/>)`).
    - A mutable `choice` object, mutated in handlers and re-rendered through a `redraw` counter: `:73,146-148,164-166,232-240,275-282`.
    - A 145-line effect that mixes reading, diffing the preview against the current state, and the remove command (`:241-362`).
    - Its own pending, lock and error flow: `:191-208`.
    - Its own absolutely positioned close button (`:86-98`, `RemoveWorktreeDialog.module.css:1-5`) where the other dialogs use `closeButton: true`.
    - A hard-coded `zIndex: 101100` (`:397`).
  - `features/worktrees/TidyWorktreesDialog.tsx`:
    - `selected` and `deleteBranches` live both in React state and in a mutable `choice` that the opener reads (`:20-23,37-38,60,77,138,152-155`).
    - The same pending, lock and error flow (`:85-100`) and the same `zIndex: 101100` (`:142`).
  - `packages/components/src/modals/ConfirmModal.tsx:38` (private `CONFIRM_MODAL_Z_INDEX`) and `:118-140` (the same flow, with `errorIn: 'dialog'`).
- Problem (observed): state lives outside React and is synchronised by hand, and data and view are mixed. The drift-check logic, which decides whether a branch delete is still authorised, is buried in a component and cannot be unit-tested apart from the DOM. The z-index duplicates a private constant, which in turn duplicates `--z-confirm`.
- Fix:
  - Move `worktreeDrift(preview, current, previewChats, chats)` and `removeWorktree(target, worktree, plan, choice)` into `worktreeActions.ts` (pure parts in `worktreeView.ts`) with tests.
  - Keep `{ worktree, plan, chats, changed }` in state and render `RemoveMessage` from it. Keep `choice` in `useState`.
  - Add `isConfirmDisabled` (and optional `confirmColor`) to `ConfirmModalContent` and render both dialogs through it, or extract a `usePendingModalAction` hook from it.
  - Export the confirm z-index from `@clowdy/components`, use `closeButton: true`, and delete `.close`.
- Category: structure
- Effort: M. Risk: medium (destructive flow; `RemoveWorktreeDialog.test.tsx` is 1076 lines and covers it)

### F11. New-chat draft identity and predicates are rebuilt by hand
- Where:
  - The key literal `` `@new-chat:${projectId}:${draftId}` `` appears at `features/agents/AgentList.tsx:606,612`, `DraftChat.tsx:64,67,128,140,149` and `stores/UiStore.ts:500`, although `newChatDraftKey(projectId)` exists (`features/chats/composerDrafts.ts:16`) and `chats/handoff.ts:346,385` build the same key from it.
  - "Draft is locked": `DraftChat.tsx:65`, `UiStore.ts:493-501`, `chats/handoff.ts:349-353`.
  - "Draft is pristine" (no close button): `AgentList.tsx:606-613`.
  - Persist filter: 3 copies in `stores/NewChatDrafts.ts:~212,~252,~281`.
  - "Main folder → `null`" before `ui.openDraft`: `agents/openNewChat.ts:19,43`, `WorktreeCardHeader.tsx:92`, `ChatFolder.tsx:102`, `DraftChat.tsx:169`, `worktrees/FolderWorktreesList.tsx:79`.
- Problem (observed): a change to the key format or to what counts as a sent draft has to be found in 4-8 places, and a miss means a draft that is shown as closable or is not restored (inferred).
- Fix: `newChatDraftKey(projectId, draftId?)`; `NewChatDrafts.isLocked(draft, sending)`, `isPristine(...)` and one `hasContent(draft)` used by persist; `ProjectUi.openDraftIn(folderId, workspace?)`, which normalises the main folder itself. Also move DraftChat's `journalFor` adapter (`DraftChat.tsx:66-88`, which has 5 inline `import('…')` types) into `NewChatDrafts`.
- Category: reuse
- Effort: S. Risk: low

### F12. Dead code that no tool reports
- Where: `tsc --noUnusedLocals -p apps/desktop` (run for this report) lists, in scope: `features/agents/AgentList.tsx:91` (`RunId`), `quickSearch/quickSearchSource.ts:47` (`first`), `tasks/Screen.tsx:95` (`const tasks = project.taskList`, which also subscribes the screen to the task list for nothing), `worktrees/CreateWorktreeDialog.tsx:2` (`Box`), `worktrees/WorktreeMenu.tsx:5` (`Copy`). There are 20 app-wide, including `chats/Composer.tsx:3`, `chats/handoff.ts:8`, `stores/ProjectState.ts:11` and tests. `biome.json:106-107` turns off `noUnusedImports` and `noUnusedVariables`, and `packages/config-typescript/base.json:14` sets `noUnusedLocals: false`.
- Problem (observed): unused code piles up silently in a codebase that several agents edit at once.
- Fix: delete the 5 in-scope items now, then turn on Biome `noUnusedImports` (autofixable) and `noUnusedVariables` (both are repo-wide decisions for the coordinator).
- Category: dead-code
- Effort: S. Risk: low

### F13. The composer pill trigger is copied three times, and its static stand-in twice
- Where:
  - `[data-open]` plate block and `.triggerContent`: `features/agents/ChipTrigger.module.css:13-37`, `features/chats/ModelPicker.module.css:27-42`, `features/chats/ModePicker.module.css:7-22`.
  - Static "chip with nothing to press": `features/agents/ChatFolder.module.css:4-17` and `features/agents/WorkspaceChips.module.css:7-21`, identical apart from the class name.
- Problem (observed): the composer row's pill lives in `agents` while the chat pickers copy its CSS. A change to the pressed look needs 3 edits.
- Fix: move `ChipTrigger` to `shared/` (it is a composer-row primitive used by agents and chats) and use it, or at least its stylesheet, in ModelPicker and ModePicker. Add a `ChipLabel` (static variant) next to it for ChatFolder and WorkspaceChips. Alternatively, add an `isExpanded` look to `Button` in `packages/components` so a trigger needs no CSS at all.
- Category: reuse
- Effort: S. Risk: low

### F14. The "Add to chat" floating button is duplicated between the editor and the terminal, with raw shadows
- Where: `packages/file-manager/src/react/editor/selectionAction.ts:118-138` with `selectionAction.module.css:5-13`, and `features/terminal/TerminalView.ts:365-394` with `TerminalTab.module.css:49-63`. Both render `Button filling sm` + `Message` + label + `Hotkey ['mod','i']` in a plate with `box-shadow: 0 var(--spacing-16) var(--spacing-32) 0 var(--color-dark-a10)` (and `black-a50` in dark). The terminal also uses `z-index: 2` and an unsquircled `radius-md`.
- Problem (observed): two copies of one control. The shadow is not a `--shadow-*` token (DESIGN.md: floats use the shadow scale) and the z-index is not `--z-raised`.
- Fix: add `SelectionActionButton({ label, onPress })` plus a float-plate class in `packages/components`, which file-manager may import, and use it in both. Switch to `--shadow-lg` or `--shadow-xl` and `--z-raised`.
- Category: design-system
- Effort: S. Risk: low

### F15. Shared code imports feature code
- Where: `shared/TaskChip.tsx:4` imports `../features/tasks/status`; `shared/runLabel.ts:1` imports `../features/chats/runningAgentRows`.
- Problem (observed): the dependency direction is inverted, so `shared` cannot be reused or tested without pulling in features. The task status view (`CATEGORY_VIEW`, `StatusIcon`, `statusTone`, `StatusPill`) is the counterpart of `shared/runStatus.ts` (`RUN_STATUS_VIEW`) but lives in a feature.
- Fix: move `features/tasks/status.tsx` (and `Pill`, once F2 is done) to `shared/taskStatus.tsx`, and move `agentRowLabel` next to `runLabel`.
- Category: structure
- Effort: S. Risk: low

### F16. Explicit `observer()` in app components, against the renderer's documented rule
- Where: `features/agents/ProjectMenu.tsx:20`, `features/quickSearch/QuickSearch.tsx:159`, `features/agents/AgentList.tsx:1090` (in scope); also `changes/ChangesToolbar.tsx:25`, `settings/SourceControlPage.tsx:29`, `settings/SettingsDialog.tsx:12`, `settings/SettingsWindow.tsx:60`.
- Problem (observed): `apps/desktop/AGENTS.md` ("No `observer()`") says `babel-plugin-observing-components` wraps every component. These files double-wrap, or at least contradict the convention that agents copy from.
- Fix: remove the `observer(...)` wrappers and the `mobx-react-lite` imports.
- Category: simplify
- Effort: S. Risk: low

### F17. Hover-revealed actions written by hand outside lists, with different rules each time
- Where: `features/tasks/Comment.module.css:34-46`, `DependencyList.module.css:78-85`, `ArchiveView.module.css:179-187`, `worktrees/ManageWorktrees.module.css:159-164,222-238`. In `features/agents/AgentList.module.css:98-125,291-303` the reveal is custom because `data-show` can only fade and cannot free the title's room, and it selects a button by `[aria-label='Archive']` (`:117`).
- Problem (observed): only ManageWorktrees handles `@media (hover: none)`, so touch screens cannot reach Comment's Edit and Delete, the dependency Remove or Restore without focusing first. Only some copies handle `data-open`. The aria-label selector breaks if the label is reworded.
- Fix: add a reveal utility to `@clowdy/styles` or components (`[data-reveal-group]` / `[data-reveal]`) that covers hover, focus-within, `data-open` and `hover: none`. In components, add a `data-show` mode that collapses (so `AgentList` can drop its custom rules), and replace the aria-label selector with a class.
- Category: design-system
- Effort: S. Risk: low

### F18. Async read hooks and error-message extraction are re-invented
- Where:
  - Hooks that each hand-roll `loading | ready | failed`, an `isCurrent` guard, a delay and retry: `features/tasks/useTaskArtifacts.ts:22-53`, `useTaskComments.ts:65-124`, `useArchivedTasks.ts`, `useTaskReadings.ts`, `features/files/useKindOnDisk.ts:16-39`.
  - `error instanceof Error ? error.message : String(error)` 10 times in scope (`tasks/useTaskComments.ts:89`, `useTaskArtifacts.ts:36`, `useArchivedTasks.ts:63`, `useTaskReadings.ts:51`, `taskCommands.ts:666`, `worktrees/RemoveWorktreeDialog.tsx:206,353`, `TidyWorktreesDialog.tsx:98,207`, `files/systemClipboard.ts:31`) and 19 in the renderer, although `errorMessage(error, fallback)` exists in `@clowdy/lib` (`packages/lib/src/errors.ts:13`) and is already used 17 times.
- Problem (observed): each copy handles empty or object errors differently.
- Fix: use `errorMessage` everywhere (S). Optionally add `useDaemonRead({ key, read, delayMs, revision })` in `stores/hooks.ts` and fold the five hooks into it (M).
- Category: reuse
- Effort: S. Risk: low

### F19. CSS that bypasses tokens
- Where:
  - Raw `150ms ease-out` 14 times (`tasks/Board.module.css:50-51`, `ArchivedPanel.module.css:31`, `ArchiveView.module.css:80`, `Comment.module.css:40`, `ArchiveDropTarget.module.css:23-25,42`, `TaskChips.module.css:22`, `DetailSections.module.css:54`, `ParentRow.module.css:27`, `TaskCard.module.css:16-17`, `SubtasksSection.module.css:26`, `sidePanel/SidePanelSizes.module.css:64`), against `--transition-duration-fast`; also `agents/AgentList.module.css:40` (`160ms cubic-bezier(...)`) and `sidePanel/PanelIcon.module.css:10-12` (`260ms`).
  - Type set through spacing tokens: `sidePanel/SidePanelSizes.module.css:16-18,27-28,79-81` (`font-size: var(--spacing-14)` and so on), where DESIGN.md says to use `Text` variants or rulesets.
  - Radius set through a spacing token, without the squircle factor: `agents/AgentList.module.css:246` (`var(--spacing-16)` with `corner-shape` set), `terminal/TerminalTab.module.css:55`.
  - 15 hand-written ellipsis blocks in scope, against `Text truncate`.
- Problem (observed): retuning motion or type means grepping literals. DESIGN.md's Squircle Rule and Token File Rule are broken.
- Fix: replace the literals with tokens and rulesets. Move the side panel menu's title and labels to `Text variant`. Most ellipsis blocks go away with F1 and F2.
- Category: design-system
- Effort: S. Risk: low

### F20. Visually-hidden CSS copied four times
- Where: `features/tasks/TaskList.module.css:37-47`, `features/worktrees/ManageWorktrees.module.css:73-80`, `features/chats/ConversationHeader.module.css:69`, `features/changes/BranchMergeDialog.module.css:57`.
- Problem (observed): no shared utility exists, so each copy differs slightly (some include `margin: -1px` and `border: 0`, some do not).
- Fix: use `VisuallyHidden` from react-aria (already a dependency through RAC), re-exported from `@clowdy/components`, or add an `sr-only` shortcut to `packages/styles/uno.config.ts`.
- Category: reuse
- Effort: S. Risk: low

### F21. Time helpers duplicated or misplaced
- Where: `features/tasks/DetailSections.tsx:179-189` (a local `useNow`) duplicates `shared/useNow.ts`. `formatAgo` lives in `features/tasks/taskView.ts:338-357`, while every other time formatter is in `shared/time.ts`. `ArchiveView.tsx:155,158` and `ArchivedPanel.tsx:95` call `formatAgo(…, Date.now())` in render, so "Archived 2 minutes ago" never updates.
- Problem (observed): two clocks, and a formatter that other features cannot find.
- Fix: delete the local `useNow` and use `shared/useNow`. Move `formatAgo` to `shared/time.ts` and export it from `shared/index.ts`. Read `useNow()` in ArchiveView and ArchivedPanel.
- Category: reuse
- Effort: S. Risk: low

### F22. `WorkspaceChip` is a 355-line component mixing derivation, menu and focus plumbing
- Where:
  - `features/agents/WorkspaceChips.tsx:181-536`.
  - The trigger's text and aria label come from a 4-branch nested ternary (`:284-325`).
  - Three separate focus-restore mechanisms: `:202-221` (`wasOpen` effect), `:615-626` (`restoreRef`), `:627-633` (`pickFolder` rAF).
  - Two "held" refs that work around RAC press propagation (`:254-256`).
- Problem (observed): the trigger copy and its screen-reader label (the core of what the person reads) cannot be unit-tested without rendering the menu. The focus logic is spread across two components in one file.
- Fix: move `workspaceTrigger({ choice, git, chosen, main, placePath, base })`, which returns `{ lead, label, trail, ariaLabel, tooltip, missing }`, into `workspaceChoice.ts` with tests. Fold the focus restore into one hook (`useRestoreFocusOnClose(ref, isOpen)`). Split the main-branch and base pickers into their own components.
- Category: structure
- Effort: M. Risk: medium (`WorkspaceChips.test.tsx` and `MainBranchChoice.test.tsx` cover it)

### F23. QuickSearch hand-builds a combobox
- Where: `features/quickSearch/QuickSearch.tsx:199-253`: a raw `<input role="combobox">` with `aria-activedescendant`, a manual `role="listbox"` / `role="option"` list with mouse-move activation, and its own row CSS (`QuickSearch.module.css:17-46,77-92`). The tabs are a row of `Button isPressed` (`:256-272`) rather than a `ToggleButtonGroup`.
- Problem: observed, it duplicates what `Autocomplete` + `ListBox` (with `useScrollActiveListItem` and `useListHoverHighlight`) provide. Inferred, it is kept custom for async results and Tab cycling, which is defensible, but the input and row styles could still come from `SearchInput variant="transparent"` and the shared `ListBoxItem` look.
- Fix: at minimum, render the field with `Input`/`SearchInput` (transparent variant) and the tabs with `ToggleButtonGroup`. Evaluate RAC `Autocomplete` with `filter={undefined}` and a controlled `ListBox` for the list. Keep `QuickSearchModel` as it is.
- Category: design-system
- Effort: M. Risk: medium

### F24. Local path normalisation copied three times, one of them inconsistent
- Where: `features/agents/worktreeCards.ts:9-10` (`worktreeKey`), `features/agents/workspaceChoice.ts:13-20` (`samePath`), `features/worktrees/RemoveWorktreeDialog.tsx:388-391` (dedupe key). The dedupe key lowercases every path; the other two lowercase only Windows drive paths.
- Problem (observed): three rules for "the same worktree path". The dialog's dedupe would treat `/Repo/a` and `/repo/a` as one target on a case-sensitive volume (inferred edge case).
- Fix: add one `normalizeLocalPath(path)` in `packages/protocol/src/paths.ts`, which already has trailing-slash trimming at `:36`, and use it in all three.
- Category: reuse
- Effort: S. Risk: low

### F25. Small cleanups in the side panel
- Where:
  - `features/sidePanel/SidePanel.tsx:35-54`: four identical `<Suspense fallback={<PanelLoadingState />}>` blocks.
  - `SidePanel.tsx:19-20`: the doc comment says the tabs "changes, and perhaps tasks and docs" are still to come, but all three exist.
  - `SidePanelSizes.tsx:67-78`: an exclusive choice drawn as raw `<button aria-pressed>` tiles, where radio semantics would be correct.
- Problem (observed): repetition and a misleading comment, plus a minor accessibility mismatch.
- Fix: use a `TAB_VIEWS: Record<SidePanelTab, LazyExoticComponent>` map with one `Suspense`, and update the comment. Use RAC `RadioGroup` (or `ToggleButtonGroup` with single selection) for the size tiles, keeping the SVG previews.
- Category: simplify
- Effort: S. Risk: low

## Cross-area notes

- **`packages/components` additions:**
  - `FoldButton` next to `TreeChevron` (F4).
  - `RowControls` and `RowActionButton`, or event isolation built into `GridListItem` slots (F5).
  - A collapsing `data-show` mode (F17).
  - `SelectionActionButton` and a float-plate style, for both file-manager and terminal (F14).
  - A re-exported `VisuallyHidden` (F20).
  - An exported confirm z-index constant and `isConfirmDisabled` on `ConfirmModalContent` (F10).
  - Possibly a lightweight non-collection `Chip`/`Pill`: `Badge` is an RAC TagGroup with grid semantics, heavy for a status pill (F2).
  - An `isExpanded` look on `Button` for triggers (F13).
  - A `ContextMenuPopover` wrapper for the repeated `<Show when={contextMenu.isOpen}><Popover {...contextMenu.popoverProps} placement="bottom start" spacing="xs">` (AgentList ×2, WorktreeCardHeader, WorktreeRow, ArchiveMenu).
- **`packages/components` bug:** `FormField` + `Textarea` passes `isDisabled` / `isInvalid` to the DOM. `features/tasks/CreateTaskDialog.tsx:117` works around it with a hand-built label, so fix `Textarea` to consume the slot context.
- **`packages/styles`:** a `focus-ring` ruleset (F6), a reveal utility (F17), an `sr-only` shortcut (F20). `--color-focus-ring` is used in `shell/` and `settings/` too, so that area's research should pick up the same fix.
- **`packages/protocol`:** `normalizeLocalPath` in `paths.ts` (F24).
- **`stores/` (ProjectState, UiStore, NewChatDrafts):** `assignedRunsByTask`, `statusById` (F9), `openDraftIn`, the draft predicates and the journal adapter (F11). The 3 copies of the persist filter in `NewChatDrafts.ts` belong to the stores area.
- **Tooling (repo-wide):** turn on Biome `noUnusedImports` / `noUnusedVariables` (F12). `useExhaustiveDependencies` is also off, which hides stale-closure bugs in effect-heavy files like `WorktreeCardHeader.tsx` and `RemoveWorktreeDialog.tsx`.
- **Daemon ↔ renderer contract:** `run.upserted` carries the whole run for context-percent ticks (F3). A narrower event (for example `run.context`), or a renderer store that keeps context apart from the run map, would stop list re-renders at the source. This belongs to the daemon events area.
- **`shared/` layering** (F15) affects chats (`MentionChip` uses `TaskChipContents`) and stream (`TaskKeyChip`).

## Not inspected / limits

- Read in full: all non-test UI files of tasks, agents (except `GroupFolderName`, `DraftFolderSelect`, `MainBranchPicker`, `BranchPickerWithCreate`, `useChatListOrder`, `useMainBranch`, `mainBranch.ts`, which were only skimmed or not opened), sidePanel, quickSearch (`QuickSearchModel.ts` and `quickSearchSource.ts` skimmed), files, openWith (`openTarget.ts`, `useFolderGit.ts` not read), terminal (`TerminalsStore.ts`, `terminalSelection.ts`, `shellKeys.ts` not read) and worktrees (`worktreeView.ts`, `worktreeActions.ts`, `WorktreeMenu.tsx` only grepped).
- Tests were not reviewed for quality; their sizes were noted only (for example `Screen.test.tsx` in agents is 2869 lines and `taskCommands.test.ts` is 2212).
- `taskCommands.ts`, `taskUndo.ts`, `archiveActions.ts`, `taskTree.ts` and `agentTree.ts` were outlined, not audited: they are pure and tested, and appear well structured.
- The perf claims in F3 and F9 are structural: the event frequency comes from daemon code, and no profiling was done. Virtualization value depends on real list sizes.
- The app was not run, so visual effects (for example the `currentcolor` focus ring) are inferred from CSS resolution, not seen.
- `apps/desktop/AGENTS.md` was grepped for the renderer rules (`observer`, layout), not read in full.
