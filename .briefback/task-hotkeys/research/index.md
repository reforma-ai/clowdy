# Task hotkeys: research index

Snapshot: 2026-11-17.

## Question and scope

Clowdy wants to work with Tasks the way Linear does. The first piece is a hotkey system with Linear's feel: a context-aware command menu, single-key actions on the focused or selected task, mnemonic two-key chords, keyboard list and board navigation, and shortcuts that teach themselves. This research covers three things:

- what Linear's hotkey system is;
- what Clowdy has today, in the Tasks UI, the domain model and the keyboard code;
- how to build such a system in React 19, Electron, React Aria and MobX.

It does not plan or implement anything.

## Summary

- **Clowdy has no hotkey layer.** There is no registry, focus scope, command menu or shortcut help. Tasks have no keyboard shortcuts of their own. Keys come only from React Aria's Table (list view) and from the browser's tab order on board cards.
- **Selection model.** "Selected", "open" and "focused" are one field, `ProjectUi.taskId`, so selecting a task opens the detail panel. There is no multi-select and no separate keyboard cursor. Linear separates these.
- **Mutations.** Every mutation is one `root.command(...)` call, and the UI waits for the SSE `task.upserted` event. There are no optimistic updates and no undo.
- **Delete.** Delete is permanent.
- **Domain model.** A task has title, description, `statusId` (5 default statuses with categories), `dependsOn`, `createdBy` and an optional `external` ref. There is no priority, assignee, label, estimate, due date, parent, archive, duplicate, bulk command or reorder. The gap list is in `current-tasks-ui.md`.
- **Dead engine.** `packages/lib/src/hotkeys.ts` is a byte-for-byte copy of Reforma's MobX hotkey engine. Only `packages/components/src/Input/UnitInput.tsx` imports it. It has no key sequences, matches on `e.code`, has no IME guard and has no scope stack. The desktop Vitest config cannot parse it because of its decorators.
- **Display layer.** `Hotkey`, `tooltipWithHotkey` and `MenuItem endAffix` already exist, but no Tasks tooltip or menu uses them.
- **Linear's model.**
  - Cmd/Ctrl+K is a contextual menu that doubles as the property picker.
  - Single letters act on a target: the hovered, highlighted or selected issue, or the open one.
  - Chords are mnemonic (`G` go, `O` open, `M` mark relation).
  - Modifiers are kept for heavier or destructive actions.
  - `?` and Cmd/Ctrl+/ open a searchable overlay.
  - The polish comes from hover-as-focus, bulk actions that reuse the same keys, nearly everything undoable, and careful input and IME guards.
- **Source reliability.** Linear publishes no single shortcut page, so the table in `linear-hotkeys.md` is rebuilt from feature docs and the changelog, with a confidence mark on each row. Popular third-party lists are wrong on several keys. No official source shows key rebinding in Linear.
- **Build options** (findings, not decisions):
  - **A:** TanStack Hotkeys as the engine. It is the most complete, but pre-1.0 and churning.
  - **B:** tinykeys plus an in-repo registry, scope stack and chord HUD.
  - **C:** a hand-rolled dispatcher on React Aria `useKeyboard`.
- **Electron.** Keep app shortcuts in the renderer. The Electron menu roles already own Cmd/Ctrl+R, W, M, Q, H, Z/X/C/V/A and the zoom keys. The order between a menu accelerator and a page `keydown` is undocumented and needs a quick experiment.

## Topic pages

| Page | Contents |
| --- | --- |
| [current-tasks-ui.md](current-tasks-ui.md) | Tasks screen, selection model, commands, task domain model, gap list |
| [current-keyboard.md](current-keyboard.md) | Existing key handling, the dead engine, Hotkey display, Electron menu, shell and focus structure, installed libraries, Reforma prior art |
| [design-intent-and-tests.md](design-intent-and-tests.md) | What the docs say about Tasks and keyboard, how tests simulate keys, how to check the UI without a person |
| [linear-hotkeys.md](linear-hotkeys.md) | Linear's principles, behaviour details, grouped shortcut table with confidence marks, conflicts between sources |
| [linear-beyond-hotkeys.md](linear-beyond-hotkeys.md) | Short pointer list of other Linear task-workflow strengths, for later roadmap stages |
| [implementation-options.md](implementation-options.md) | Library survey, Electron specifics, registry patterns, comparison table, options A, B and C |

## Important files

- `apps/desktop/src/renderer/features/tasks/` — the Tasks screen. Key files: `Screen.tsx`, `TaskList.tsx`, `Board.tsx`, `DetailPanel.tsx`, `commands.ts`, `taskView.ts`.
- `apps/desktop/src/renderer/stores/UiStore.ts` — `ProjectUi.taskId` and the per-project selections.
- `packages/protocol` and `apps/daemon` — the task type and the task commands.
- `packages/lib/src/hotkeys.ts` — the dead engine.
- `packages/components/src/Hotkey/` — the display layer.
- `apps/desktop/src/main/menu.ts` — the role-based Electron menu.
- `/Users/bionic/WORK/Reforma/reforma/apps/front/src/editor/hotkeys/` — the closest prior art: `EditorHotkeys.tsx`, `shortcutsCatalog.ts`, `KeyboardShortcutsModal.tsx`. Same author, read-only.

## Open questions

- **Behaviour only?** Does "don't clone Linear chrome" in DESIGN.md allow copying Linear's keyboard behaviour while keeping Clowdy's look? DESIGN.md does not say.
- **Focus and open.** Should the keyboard cursor and the open task be separate state?
- **Multi-select.** Is it in scope? It needs N commands per action or a new batch command.
- **Fields.** Which fields should come first: priority, assignee, labels, estimate, due date, parent? None exist, and Clowdy is single-user.
- **Custom statuses.** Which statuses should "mark done", "cancel" and "next status" target when a project has several of one category?
- **Delete.** Is a delete hotkey acceptable while delete is permanent and there is no undo?
- **Palette.** Is the command menu a modal float or a lighter popover? Should it use RAC `Autocomplete`, cmdk or kbar?
- **Engine.** Which option fits: A, B or C? Is a pre-1.0 pin acceptable?
- **Native menu.** Must shortcuts also appear in the native menu? That decides whether the registry exists in the main process.
- **Customisation.** Do users need to rebind keys? Linear apparently does not allow it.
- **Spec location.** Where should the spec of record for shortcuts live?
- **Unresolved by research:** the order of a menu accelerator and a renderer `keydown` in Electron 45; whether RAC `ListBox` and `Menu` can disable type-ahead; Linear's exact chord timeout; key matching on non-US layouts in Linear.

## Assumptions and coverage limits

- **Nothing was run.** No app, daemon, test or screenshot was run, and the Windows behaviour is untested.
- **Linear.** Its in-app `?` overlay was not opened, and `/docs/keyboard-shortcuts` returns 404. Every shortcut row carries a source-confidence mark, and unverified keys are labelled.
- **Specs.** `spec.md` is untracked and not in the working tree. Only its first version, in git history, was read. The MVP plan and the wireframes were read for Tasks and keyboard intent only.
- **Code not read in depth.** Daemon internals beyond the task handlers, and the Chats, Agents and Docs sections beyond their key handling.
- **Libraries.** Versions and release rates are as of 2026-11-17 and need re-checking before a pin.
