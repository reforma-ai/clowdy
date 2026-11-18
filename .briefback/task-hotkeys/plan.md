# Task hotkeys

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** Give Tasks a Linear-grade keyboard system (cursor, selection, single-key actions, chords, key hints, help overlay) on a hotkey architecture that every section can use later.

**Approach:** A small hotkey layer in the renderer (`apps/desktop/src/renderer/hotkeys/`) holds a command registry, a scope stack, a chord state machine and the input guards. tinykeys supplies only the key parsing and matching. The Tasks screen gets a keyboard cursor and a selection set that are separate from the open task, and its commands register into the layer. The help overlay, the chord HUD and every key hint read from the same registry.

**Research:** `.briefback/task-hotkeys/research/index.md`. The full Linear keymap with a confidence mark on every key is `research/linear-hotkeys.md`. Read it again whenever a key is added or changed.

**Decisions**

- Copy Linear's keys and interaction model. Keep Clowdy's own visual language (DESIGN.md forbids cloning Linear's chrome, not its behavior).
- The first piece builds the hotkey layer and binds it to the task actions that exist today. Each new task field (priority, assignee, labels, estimate, due date) comes later in its own stage, together with its Linear key.
- The architecture is section-agnostic so every section and action can get hotkeys later. The first delivery binds only Tasks, the `G` section chords, the help overlay and key hints. List navigation in Chats, Agents and Docs is Stage 8, authorized together with the rest.
- A keyboard cursor is separate from the open task, and a selection set is separate from both. Hover moves the cursor only on real pointer movement. `Enter` opens the detail panel. While the panel is open it follows the cursor. `Esc` closes the panel, and a second `Esc` clears the selection. A command acts on the selection when it is not empty, else on the cursor task. Bulk actions send one command per task.
- The list view keeps the React Aria `Table`, and the board uses the same cursor and selection.
- tinykeys 4.x (`parseKeybinding`, `matchKeybindingPress`) is the matcher. The registry, scope stack, chord state machine, input guards and conflict checks are our code in `apps/desktop/src/renderer/hotkeys/`, plain TypeScript with no decorators so Vitest can run it. One capture-phase `keydown` listener on `document` feeds the dispatcher, which resolves scope and priority itself (tinykeys alone resolves conflicts by declaration order).
- The registry is a module singleton, so content rendered by `Modal.create` (a separate React root with no context) can read it.
- A command is `id, title, group, keys, scope, when?, inInputs?, repeat?, handler`. Keys can differ per platform. Commands are off while the target is a text field, a combobox or an IME composition, unless the command sets `inInputs`. Commands outside an open dialog or overlay are off while it is open. `Tab` and `Shift+Tab` stay for focus movement.
- The keymap is data. The help overlay, the tooltip and menu hints and the chord HUD all read the registry. There is no rebinding for now.
- The command menu is deferred. Cmd/Ctrl+K stays unbound and reserved.
- The Electron application menu stays role-based and unchanged. Stage 2 writes up whether a menu accelerator or a page `keydown` wins, with a manual probe for the user to run on macOS and Windows.
- The dead engine `packages/lib/src/hotkeys.ts` is deleted, and its two consumers (`useRunner`, `UnitInput`) read modifier keys from the events instead.
- Reserved keys for later fields, which nothing else may use: `A`, `I`, `P`, `L`, `Shift+E`, `Shift+D`, `Shift+C`, `Shift+P`, `Shift+S`, `M R`, `M M`, Cmd/Ctrl+K.
- `Cmd/Ctrl+Enter` starts the task with an agent. It acts on the cursor task only and never on the selection, because it spends subscription quota. A task whose `startBlockedReason` is set does not offer the command or its hint. `O` then `C` opens the task's linked chat, and `O` then `D` opens its newest document result.
- `Cmd+Backspace` (Windows: `Ctrl+Delete`) deletes with a confirm dialog, one dialog for the whole selection, until a trash exists.
- Undo is the last stage and best effort. It keeps the previous values in the renderer, shows a toast with Undo, and Cmd/Ctrl+Z reverses the last change by sending the inverse command. It ships only if its go condition holds.

**Reuse:** `packages/components/src/Hotkey` (`Hotkey`, `tooltipWithHotkey`), `@clowdy/components/Popover`, `Autocomplete`, `Tooltip`, `Toast` (`toast`, with an `action`), `Modal.create`, `openConfirmModal` (`packages/components/src/modals/ConfirmModal.tsx`), `sendCommand` (`features/tasks/commands.ts`), `startBlockedReason`, `dependencyCandidates`, `filterTasks` (`features/tasks/taskView.ts`), `ProjectUi.openTask|openChat|openDoc|setTasksView` and `UiStore.showSection` (`stores/UiStore.ts`), `ProjectState.chatsOfTask`, `FixtureTransport` and the `?fixtures` route for checks without a person.

## Out of scope

- The command menu (Cmd/Ctrl+K). The registry is built to feed it later, and the key stays reserved.
- Key rebinding and any settings page for it.
- New task fields (priority, assignee, labels, estimate, due date, parent) and their keys. Also archive, trash, duplicate, a daemon batch command and daemon-side undo.
- Shortcuts in the native application menu.
- A peek or preview key (`Space`) and a keyboard way to reorder cards inside a column.
- `Cmd+,` for Settings, and project-switch keys.
- Windows runtime verification by the agent. Nothing has been run on Windows, so the user runs the Windows manual checks.

## Keymap (first delivery)

Windows swaps Cmd for Ctrl and Option for Alt unless a row says otherwise. "Conf" is the Linear confidence from `research/linear-hotkeys.md`. The Clowdy-only rows have none.

| Command id | Keys | Scope | Conf | Stage |
| --- | --- | --- | --- | --- |
| `nav.chats` `nav.tasks` `nav.agents` `nav.docs` | `G` then `C` / `T` / `A` / `D` | app | Clowdy | 3 |
| `help.open` | `?`, `Cmd+/` | app | M | 3 |
| `tasks.cursor.down` `tasks.cursor.up` | `↓` `J` / `↑` `K` | tasks | H | 4 |
| `tasks.cursor.left` `tasks.cursor.right` | `←` / `→` (board columns) | tasks | Clowdy | 4 |
| `tasks.cursor.first` `tasks.cursor.last` | `Home` / `End` | tasks | M | 4 |
| `tasks.open` | `Enter` | tasks | L | 4 |
| `tasks.escape` | `Esc` (closes the panel, then clears the selection) | tasks | H | 4 |
| `tasks.select.toggle` | `X` | tasks | H | 4 |
| `tasks.select.extend` | `Shift+↓` / `Shift+↑` | tasks | H | 4 |
| `tasks.select.all` | `Cmd+A` | tasks | H | 4 |
| `tasks.status.pick` | `S` | tasks | H | 5 |
| `tasks.status.next` `tasks.status.prev` | `Opt+→` / `Opt+←` (Windows `Ctrl+→` / `Ctrl+←`) | tasks | M | 5 |
| `tasks.deps.blockedBy` `tasks.deps.blocking` | `M` then `B` / `M` then `X` | tasks | H | 5 |
| `tasks.rename` | `Shift+R` | tasks | M | 5 |
| `tasks.start` | `Cmd+Enter` | tasks | Clowdy | 5 |
| `tasks.delete` | `Cmd+Backspace` (Windows `Ctrl+Delete`) | tasks | H | 5 |
| `tasks.create` | `C` | tasks | H | 6 |
| `tasks.view.toggle` | `Cmd+B` | tasks | H | 6 |
| `tasks.filter` | `F` | tasks | H | 6 |
| `tasks.search` | `/` | tasks | H | 6 |
| `tasks.copy.key` `tasks.copy.title` | `Cmd+.` / `Cmd+Shift+'` | tasks | M | 6 |
| `tasks.chat.open` `tasks.doc.open` | `O` then `C` / `O` then `D` | tasks | Clowdy | 6 |
| `tasks.undo` | `Cmd+Z` | tasks | H | 7 |

## Stage 1 — Retire the dead hotkey engine

**Depends on:** None. It can run alongside Stage 2 because the two touch different files.

**This stage:** `packages/lib/src/hotkeys.ts` is a MobX singleton copied from Reforma. Nothing registers with it, so its flags never change. Only `useRunner` (the pointer scrubbing behind numeric inputs) and `UnitInput` read it. Delete it and make those two read modifier keys from the events they already receive. A side effect is that the design-system `Input` stops importing decorator code, so the desktop Vitest config can render components that use it. The Alt-drag and Shift-step scrubbing in numeric inputs, which never worked in Clowdy, will start working as designed.

- [x] Complete
  - [x] `useRunner` takes the step and the Alt gate from the pointer events and follows Shift during a drag through window `keydown` and `keyup`, not through the singleton
  - [x] `UnitInput`'s `shouldRun` gets the pointer event and checks `altKey` on it
  - [x] `hotkeys.ts` is deleted, and no source file imports `@clowdy/lib/hotkeys` or `./hotkeys`
  - [x] The workaround mock of `@clowdy/components/Select` in `Composer.test.tsx` is removed if the real component now loads

**Files**

- `packages/lib/src/useRunner.ts` — `useRunner`: modifier reads from the events; `shouldRun` signature gains the event
- `packages/components/src/Input/UnitInput.tsx` — `shouldRun`: read `altKey` from the event
- `packages/lib/src/hotkeys.ts` — delete
- `apps/desktop/src/renderer/features/chats/Composer.test.tsx` — drop the `Select` mock if it is no longer needed
- `packages/lib/specs/useRunner.test.ts` — create: six tests of the modifier handling (added in the stage; `useRunner` had none)

**Done when:** `rg "lib/hotkeys|from './hotkeys'" packages apps` finds nothing, and a desktop test can import `@clowdy/components/Select` without a parse error.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/lib --filter=@clowdy/components --filter=@clowdy/desktop`
**Commits:**

- `51b2367` refactor(lib): replace the unused hotkey engine with pointer event modifiers

Note: `bunx turbo run lint test --filter=@clowdy/components` already fails on files this stage did not touch (8 lint errors and 2 tests in `HexColorEditor`, `GradientStopThumb`, `Resizable`, `RichInputMentionNodeView`, `ScrollChromeRoot`, `colorValue.test.ts`, `shouldYieldRichInputAutofocus.test.ts`). Its typecheck passes.

## Stage 2 — Hotkey core and the menu probe

**Depends on:** None.

**This stage:** Build the engine the rest of the plan stands on, with no UI. A module-singleton registry holds commands. A scope stack decides which commands are live. A dispatcher listens once on `document` in the capture phase, matches with tinykeys' `parseKeybinding` and `matchKeybindingPress`, and tracks pending chords with a timeout and `Esc` to cancel. The input guards and the open-overlay rule decide when keys are ignored. The chord state is observable so a HUD can show it. A dev-time conflict check rejects two live commands on the same keys, and rejects a key that is both a chord prefix and a single key in the same scope. The stage begins with a note on whether the native menu's role accelerators (Cmd+R, Cmd+W, Cmd+A and Cmd+Z, which the Edit and View roles own) or the page `keydown` fire first, built from Electron's documentation and issues, with a manual probe procedure for the person to run.

- [x] Complete
  - [x] `research/menu-accelerator-probe.md` records what Electron documents about menu accelerators versus page `keydown`, which chords the role menu owns, the remedy for each, and a two-minute manual probe procedure. Scope change: the runtime probe is left to the user, because injecting real key presses would hit whatever app is in front on the user's desktop
  - [x] `tinykeys` 4.0.1 added to `apps/desktop`
  - [x] Registry with `defineCommand`, per-platform keys, the scope stack and `when`
  - [x] Dispatcher with chords and their timeout, the guards (text targets, combobox roles, IME composition, key repeat, open overlays), and conflict detection
  - [x] React hooks `useHotkeyScope(scope)` and `useCommands(scope, commands)` that register on mount and dispose on unmount
  - [x] The dispatcher is installed once from `Shell`
  - [x] Pure tests of the dispatcher, the guards and the conflict check

**Files**

- `apps/desktop/package.json` — add `tinykeys` 4.0.1 (published 2026-09-25, older than the repo's 3-day release gate)
- `apps/desktop/src/renderer/hotkeys/registry.ts` — create: no existing home. Holds the command table, scope stack and observable chord state
- `apps/desktop/src/renderer/hotkeys/dispatcher.ts` — create: the listener, matching, chord state machine and guards, kept apart from the registry so they test without a DOM
- `apps/desktop/src/renderer/hotkeys/react.ts` — create: the hooks need React, so they stay out of the plain-TS registry
- `apps/desktop/src/renderer/hotkeys/index.ts` — create: the module's public entry, like `stores/index.ts`
- `apps/desktop/src/renderer/hotkeys/dispatcher.test.ts`, `registry.test.ts` — create
- `apps/desktop/src/renderer/shell/Shell.tsx` — `Shell`: install and dispose the dispatcher
- `.briefback/task-hotkeys/research/menu-accelerator-probe.md` — create: the probe result

**Done when:** a test dispatches `g` then `c` through the dispatcher and gets one handler call, an IME composition, a text field and an open dialog each block single keys, a conflicting registration throws, and the probe note names the documented winner for Cmd+R, Cmd+W, Cmd+A and Cmd+Z, or says it is undocumented, and lists the manual steps.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Landed API** (header comment of `hotkeys/index.ts`): `hotkeys` singleton and `createRegistry`, `defineCommand`, `listCommands`, `commandPresses`, `commandSequences`, `findKeyConflicts`, `installDispatcher`, `useHotkeyScope`, `useCommands`, observable `pending`.

**Decisions made inside the stage**

- Key names are `KeyboardEvent.key` names (`ArrowDown`, `Escape`, `Enter`, `Backspace`), and `code` names work too (`Quote`, `Slash`). Write `Cmd+Shift+'` in Stage 6 as `$mod+Shift+Quote`, because Shift turns `'` into `"` on a US layout.
- A symbol key (`?`, `/`, `.`) also accepts Shift, so `?` can match.
- A letter key matches its physical key when the layout types a non-Latin letter (Cyrillic, Greek). Dvorak and AZERTY match by the letter they type.
- Held keys that a command claims are swallowed without running the handler.
- Conflicts are checked across both platforms' keys, and duplicate ids and unknown modifiers throw.
- Overlay guard: `[data-modal-overlay]`, `[data-modal-clickout-layer]`, `dialog` and `alertdialog`. An in-page list box is not an overlay.
- Scope order follows mount order, so a later-mounted scope (a picker, a dialog) wins and gives the key back on unmount. A scope pushed by a child that mounts together with its parent sits below the parent's.
- Menu accelerators: Electron's docs are silent. Electron 45.2.1 and Chromium source say the menu only receives keys the page left unhandled, so `preventDefault()` should win for Cmd+A and Cmd+Z. Not run. `research/menu-accelerator-probe.md` has the manual probe.

**Commits:**

- `c6f355c` feat(desktop): hotkey registry, dispatcher and scope stack

## Stage 3 — Help overlay, chord HUD, key hints and section chords

**Depends on:** Stage 2.

**This stage:** Make the registry visible and give it its first real commands. `Hotkey` learns to show a sequence ("G then C") and the keys it cannot show today (`Esc`, `Space`, `Tab`, punctuation). A chord HUD shows a pending chord and its completions. `?` and Cmd/Ctrl+/ open a searchable help overlay generated from the registry. The `G` chords switch sections, and the Rail shows its chord in a tooltip. This is the first thing a person can try, and it proves chords end to end before Tasks depends on them.

- [x] Complete
  - [x] `Hotkey` renders a `sequence` as separate capsules joined by "then", and shows Esc, Space, Tab and the punctuation keys
  - [x] `commandHint(id)` returns the current display keys for a command, for `tooltipWithHotkey` and `MenuItem endAffix`
  - [x] `ChordHud` appears while a chord is pending and disappears on completion, `Esc` or timeout
  - [x] `HelpOverlay` opens from `?` and Cmd/Ctrl+/ through `Modal.create`, lists the commands registered for the app and the current screen, grouped, and filters as the person types (commands of an unmounted screen are not listed, which Linear's contextual help does too)
  - [x] `nav.chats`, `nav.tasks`, `nav.agents`, `nav.docs` registered in the app scope and shown as Rail tooltips

**Files**

- `packages/components/src/Hotkey/Hotkey.tsx`, `hotkeysToSymbols.ts` — `sequence` prop, extra key symbols
- `packages/components/src/Hotkey/hotkeysToSymbols.test.ts` — create: the Hotkey components have no test today
- `apps/desktop/src/renderer/hotkeys/react.ts` — `commandHint`
- `apps/desktop/src/renderer/hotkeys/ChordHud.tsx`, `ChordHud.module.css` — create: a component with its own styles, which `Shell.tsx` only mounts
- `apps/desktop/src/renderer/hotkeys/HelpOverlay.tsx`, `HelpOverlay.module.css` — create: same reason, and it is opened imperatively
- `apps/desktop/src/renderer/shell/Shell.tsx` — `Shell`: register the app commands, mount `ChordHud`
- `apps/desktop/src/renderer/shell/Rail.tsx` — `Rail`: wrap each item in the design-system `Tooltip` with `tooltipWithHotkey`

**Done when:** pressing `G` shows the HUD, then `T` switches to Tasks and the HUD goes away, and `?` shows a help overlay listing the section chords.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/components --filter=@clowdy/desktop`, then check with `bun scripts/screenshot.ts` on `?fixtures=static`, using `--eval` to dispatch the keys, that the overlay and HUD render in light and dark
**Landed in the stage**

- `Hotkey` `sequence` prop, `tooltipWithSequence`, `commandHint`, `commandTooltip`, `CommandHotkey`, `ChordHud`, `HelpOverlay`, `openHelp` (split from the overlay because `Modal` cannot load under the desktop Vitest), `shellCommands` (`help.open`, `nav.*`).
- Command titles read "Go to Tasks" and so on.
- Fixed in `registry.ts`: the disposers of `defineCommand` and `pushScope` now run in `runInAction`.
- The help overlay searches `+`-joined keys, scrolls with the arrow and page keys while the search field has focus, and cannot stack.

**Follow-ups** (not done in this stage)

- `Modal.focus()` in `packages/components/src/Modal/Modal.ts` does not save the previously focused element when a child autofocuses first, so focus lands on `body` after Esc. Fixed in Stage 5, where the delete confirm makes it matter.
- Cmd/Ctrl+/ is dead inside text fields and the composer because it shares the `help.open` command with `?`. A second command with `inInputs: true` would fix it.
- The chord HUD is centered on the window and covers the composer; the sync banner has a higher z-index.

**Commits:** None yet.

## Stage 4 — Task cursor, selection and navigation

**Depends on:** Stages 1 and 2.

**This stage:** Today "selected", "open" and "focused" are one field. Build a generic `ListCursor` (a cursor, an anchor and a selection set over columns of ids, with its own move, range and select-all logic) that Tasks uses on the board (one column per status) and in the list (one column). It is generic so Stage 8 can reuse it. Wire it into the Tasks screen. Opening a task moves the panel, and an open panel follows the cursor. Hover moves the cursor on real pointer movement. The keys come from the keymap table. The commands live in a builder, `taskCommands`, so they can be tested without the screen.

- [ ] Complete
  - [ ] `ListCursor` with movement across columns, `Home` and `End`, toggle, range extend, select all, clear, and reconciliation when ids disappear (a filter or a delete)
  - [ ] Tasks `Screen` owns one `ListCursor` and builds its grid from the visible tasks
  - [ ] Board cards and list rows show three distinct states: cursor (the existing focus ring), selected (a tonal fill), open (the existing primary border)
  - [ ] List rows and cards carry `data-task-id`, and the cursor moves real DOM focus to the matching element
  - [ ] Our commands claim their keys before the React Aria `Table` type-ahead and arrow handling, and keys no command claims still reach React Aria
  - [ ] `Enter`, the panel following the cursor, the two-step `Esc`, and hover-moves-cursor behave as in Decisions
  - [ ] Row and card click, Cmd/Ctrl-click and Shift-click act on the cursor, selection and open task consistently with the keys
  - [ ] `tasks.cursor.*`, `tasks.open`, `tasks.escape` and `tasks.select.*` registered in the `tasks` scope, which `Screen` pushes while mounted

**Files**

- `apps/desktop/src/renderer/hotkeys/listCursor.ts`, `listCursor.test.ts` — create: reused by Stage 8, so it cannot live in `features/tasks`
- `apps/desktop/src/renderer/features/tasks/taskCommands.ts`, `taskCommands.test.ts` — create: a builder of the Tasks commands from state, extended by Stages 5 to 7. It cannot live in `Screen.tsx` because of size and so it can be tested against fakes
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — `Screen`: owns the cursor, the scope, and the `visible` grid
- `apps/desktop/src/renderer/features/tasks/Board.tsx`, `TaskCard.tsx` and their `.module.css` — cursor, selection and `data-task-id`, hover
- `apps/desktop/src/renderer/features/tasks/TaskList.tsx`, `TaskList.module.css` — `selectionMode="multiple"`, the same states, `data-task-id`
- `apps/desktop/src/renderer/features/tasks/taskView.ts`, `taskView.test.ts` — a pure `taskGrid` for board and list order

**Done when:** on `?fixtures=static&section=tasks`, `J` and `K` move a visible cursor in both views, `X` and `Shift+↓` select, `Enter` opens the panel, moving with the panel open changes the panel, and `Esc` closes then clears.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`, then screenshots of both views with `--eval` key dispatch, and a manual check with real keys of the Table type-ahead case (typing `c` on a list row must not jump rows)
**Commits:** None yet.

**Risk:** The React Aria `Table` may not allow the cursor to drive its row focus and multi-selection this way. If it does not, replace `TaskList`'s `Table` with rows built from the same cell components. The cursor model does not change. Record that as a scope change before leaving the stage.

## Stage 5 — Property pickers and task actions

**Depends on:** Stages 3 and 4.

**This stage:** Give the cursor and the selection their actions. A shared searchable picker popover, anchored to the cursor's card or row, drives the status picker and the two dependency pickers. Actions apply to the selection when there is one, else to the cursor, by sending one command per task and showing one toast for any refusals. The keys and hints follow the keymap table. Nothing new is needed from the daemon.

- [ ] Complete
  - [ ] `PickerPopover`: a search field, a keyboard-navigable list, `Enter` to pick, `Esc` to close, current value marked
  - [ ] `S` opens the status picker listing every status of the project, and picking sets `statusId` on each target
  - [ ] `Opt+←` and `Opt+→` move each target to the previous or next status in workflow order (Windows `Ctrl+←` and `Ctrl+→`), and do nothing at the ends
  - [ ] `M B` picks tasks this one depends on, and `M X` picks tasks that depend on this one, with toggle semantics and the existing cycle protection from `dependencyCandidates`
  - [ ] `Shift+R` opens the detail panel for the cursor task and focuses its title editor
  - [ ] `Cmd+Enter` starts the cursor task with `task.start`, and is unavailable, with no hint, when `startBlockedReason` is set
  - [ ] `Cmd+Backspace` (Windows `Ctrl+Delete`) confirms through `openConfirmModal`, then deletes every target, and moves the cursor to the nearest remaining task

**Files**

- `apps/desktop/src/renderer/shared/PickerPopover.tsx`, `PickerPopover.module.css` — create: used by three pickers here and by later field pickers, so it cannot live in `features/tasks`. It is built on `@clowdy/components/Popover` and `Autocomplete`
- `apps/desktop/src/renderer/features/tasks/taskCommands.ts`, `taskCommands.test.ts` — status, move, dependencies, rename, start and delete commands
- `apps/desktop/src/renderer/features/tasks/commands.ts` — `sendCommand`: add `sendEach` to run one command per target and report refusals once
- `apps/desktop/src/renderer/features/tasks/taskView.ts`, `taskView.test.ts` — `adjacentStatus` and a dependency-toggle helper
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx`, `EditableText.tsx` — a way for the rename command to focus the title editor
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — pass the picker anchor and the actions to the commands

**Done when:** with the cursor on a task, `S` then `Enter` changes its status in the fixture daemon, `Opt+→` moves it one column, with three tasks selected `Cmd+Backspace` asks once and deletes three, and every case shows the new state after the `task.upserted` event.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop` (store-level tests through `FixtureTransport` for each command, including partial refusal)
**Commits:** None yet.

## Stage 6 — View, create and linked-item keys, and hints in the Tasks UI

**Depends on:** Stages 3, 4 and 5 (it edits `TasksHeader` and `DetailPanel` after Stage 5 does).

**This stage:** Finish the first keymap and teach it in place. `C` opens the create dialog. The view toggle, the filter popover and the search field get keys. Copy keys put the task key or title on the clipboard with a toast. `O C` and `O D` jump from a task to its chat or its newest document. Every Tasks button and menu that has a key shows it, and a button that is unavailable shows no hint, as the spec says no non-working buttons.

- [ ] Complete
  - [ ] `C` opens the create dialog through `openCreateTask`
  - [ ] `Cmd+B` toggles board and list, `F` opens the filter popover, `/` focuses the search field
  - [ ] `Cmd+.` copies the task key and `Cmd+Shift+'` copies the title (several lines for a selection), each with a toast
  - [ ] `O C` opens the cursor task's newest chat and `O D` its newest document result, through `ProjectUi` and `getTaskDetail`, and both say so in a toast when there is none
  - [ ] Hints through `commandHint` on `TasksHeader` buttons, the `DetailPanel` foot buttons and the picker rows
  - [ ] Every Tasks command appears in the help overlay under its group

**Files**

- `apps/desktop/src/renderer/features/tasks/taskCommands.ts` — create, view, copy and open commands
- `apps/desktop/src/renderer/features/tasks/TasksHeader.tsx`, `FilterPopover.tsx` — controlled open state for `F`, a focusable search for `/`, hints
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx` — hints on Start and Delete
- `apps/desktop/src/renderer/features/tasks/CreateTaskDialog.tsx` — `openCreateTask`: reused as is
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — lift what `F` and `/` need

**Done when:** from a fresh Tasks screen, the keys `C`, `F`, `/`, `Cmd+B`, `Cmd+.`, `O C` and `O D` each do their thing, and each button with a key shows it in its tooltip.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`, then a screenshot pass of the tooltips and the help overlay with all Tasks groups
**Commits:** None yet.

## Stage 7 — Undo for reversible task edits (optional)

**Depends on:** Stage 5.

**This stage:** Scope change: the runtime probe is left to the user, so the stage ships on two paths. The toast Undo action always works. The Cmd/Ctrl+Z key is registered as well and works wherever the page `keydown` arrives before the native Edit-menu Undo, which the user's manual probe settles. If the probe says the menu wins on macOS, the fix is in `menu.ts` and is recorded as a follow-up, not guessed here. Every status, title, description and dependency change made by the hotkeys or the panel records the previous values in a renderer undo stack and shows a toast with an Undo action. Cmd/Ctrl+Z reverses the latest entry by sending the inverse `task.update`. Delete is not undoable until a trash exists, and its confirm dialog stays.

- [ ] Complete
  - [ ] The probe outcome for Cmd/Ctrl+Z is noted here when the user reports it
  - [ ] An undo stack of `{ label, undo }` entries, capped in length
  - [ ] Status, title, description and dependency edits record an entry and show a toast with an Undo action
  - [ ] `Cmd+Z` in the `tasks` scope undoes the latest entry and is off in text fields

**Files**

- `apps/desktop/src/renderer/hotkeys/undo.ts`, `undo.test.ts` — create: a generic stack that later sections can use, so it cannot live in `features/tasks`
- `apps/desktop/src/renderer/features/tasks/commands.ts`, `taskCommands.ts` — record entries when a change succeeds
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx` — record title and description edits
- `apps/desktop/src/main/menu.ts` — only if the probe says the Edit-menu Undo must be released to the page

**Done when:** changing a status and pressing the toast's Undo restores it in the fixture daemon, and a dispatched Cmd/Ctrl+Z does the same in a test.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.

## Stage 8 — List navigation in Chats, Agents and Docs

**Depends on:** Stages 3 and 4.

**This stage:** It tests the architecture against more than one section. Each section pushes its own scope, registers `J` and `K` as aliases of the arrows, `Enter` and `Esc`, and shows hints, built on `ListCursor` where the list is ours and on the existing keys where the list is an ARIA tree. Re-read each file's current key handling when the stage starts.

- [ ] Complete
  - [ ] Chats list, Agents run tree and Docs tree each register a scope with their movement, open and close commands
  - [ ] Existing local keys (the tree keys, `Mod+S` in Docs, the composer's Enter) keep working and do not collide with the registry
  - [ ] Hints and the help overlay show the new commands

**Files**

- `apps/desktop/src/renderer/features/chats/ChatList.tsx` — scope and commands
- `apps/desktop/src/renderer/features/agents/RunList.tsx` — scope and commands next to its tree `onKeyDown`
- `apps/desktop/src/renderer/features/docs/DocsTree.tsx`, `Screen.tsx` — scope and commands, and the window `Mod+S` handler moves to the registry

**Done when:** `J`, `K`, `Enter` and `Esc` work in the three lists as in Tasks.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Commits:** None yet.
