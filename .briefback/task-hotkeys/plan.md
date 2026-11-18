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
- Back and forward (added after the first plan, by the owner): every change of what the window shows is a history entry: the selected project, the section, the open chat, task, run or document, and Settings with its page. Cmd/Ctrl+[ goes back and Cmd/Ctrl+] goes forward, and two header buttons do the same. The history is in memory, capped at 100, and a new entry drops the forward entries. Moving the cursor with the panel open replaces the current entry instead of adding one, so holding `J` does not flood the history. An entry whose chat, task or run no longer exists is skipped. View toggles, filters, the cursor and the selection are not entries.
- Undo is the last stage and best effort. It keeps the previous values in the renderer, shows a toast with Undo, and Cmd/Ctrl+Z reverses the last change by sending the inverse command. It ships only if its go condition holds.

**Reuse:** `packages/components/src/Hotkey` (`Hotkey`, `tooltipWithHotkey`), `@clowdy/components/Popover`, `Autocomplete`, `Tooltip`, `Toast` (`toast`, with an `action`), `Modal.create`, `openConfirmModal` (`packages/components/src/modals/ConfirmModal.tsx`), `sendCommand` (`features/tasks/commands.ts`), `startBlockedReason`, `dependencyCandidates`, `filterTasks` (`features/tasks/taskView.ts`), `ProjectUi.openTask|openChat|openDoc|setTasksView` and `UiStore.showSection` (`stores/UiStore.ts`), `ProjectState.chatsOfTask`, `FixtureTransport` and the `?fixtures` route for checks without a person.

## Out of scope

- The command menu (Cmd/Ctrl+K). The registry is built to feed it later, and the key stays reserved.
- Key rebinding and any settings page for it.
- New task fields (priority, assignee, labels, estimate, due date, parent) and their keys. Also archive, trash, duplicate, a daemon batch command and daemon-side undo.
- Shortcuts in the native application menu.
- Mouse side buttons and Cmd/Ctrl+←/→ for back and forward, and saving the history across restarts.
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
| `nav.back` `nav.forward` | `Cmd+[` / `Cmd+]` | app | M | 9 |

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

**Commits:**

- `6ef40d5` feat(desktop): help overlay, chord HUD, key hints and section chords

## Stage 4 — Task cursor, selection and navigation

**Depends on:** Stages 1 and 2.

**This stage:** Today "selected", "open" and "focused" are one field. Build a generic `ListCursor` (a cursor, an anchor and a selection set over columns of ids, with its own move, range and select-all logic) that Tasks uses on the board (one column per status) and in the list (one column). It is generic so Stage 8 can reuse it. Wire it into the Tasks screen. Opening a task moves the panel, and an open panel follows the cursor. Hover moves the cursor on real pointer movement. The keys come from the keymap table. The commands live in a builder, `taskCommands`, so they can be tested without the screen.

- [x] Complete
  - [x] `ListCursor` with movement across columns, `Home` and `End`, toggle, range extend, select all, clear, and reconciliation when ids disappear (a filter or a delete)
  - [x] Tasks `Screen` owns one `ListCursor` and builds its grid from the visible tasks
  - [x] Board cards and list rows show three distinct states: cursor (the existing focus ring), selected (a tonal fill), open (the existing primary border)
  - [x] List rows and cards carry `data-task-id`, and the cursor moves real DOM focus to the matching element
  - [x] Our commands claim their keys before the React Aria `Table` type-ahead and arrow handling, and keys no command claims still reach React Aria
  - [x] `Enter`, the panel following the cursor, the two-step `Esc`, and hover-moves-cursor behave as in Decisions
  - [x] Row and card click, Cmd/Ctrl-click and Shift-click act on the cursor, selection and open task consistently with the keys
  - [x] `tasks.cursor.*`, `tasks.open`, `tasks.escape` and `tasks.select.*` registered in the `tasks` scope, which `Screen` pushes while mounted

**Files**

- `apps/desktop/src/renderer/hotkeys/listCursor.ts`, `listCursor.test.ts` — create: reused by Stage 8, so it cannot live in `features/tasks`
- `apps/desktop/src/renderer/features/tasks/taskCommands.ts`, `taskCommands.test.ts` — create: a builder of the Tasks commands from state, extended by Stages 5 to 7. It cannot live in `Screen.tsx` because of size and so it can be tested against fakes
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — `Screen`: owns the cursor, the scope, and the `visible` grid
- `apps/desktop/src/renderer/features/tasks/Board.tsx`, `TaskCard.tsx` and their `.module.css` — cursor, selection and `data-task-id`, hover
- `apps/desktop/src/renderer/features/tasks/TaskList.tsx`, `TaskList.module.css` — `selectionMode="multiple"`, the same states, `data-task-id`
- `apps/desktop/src/renderer/features/tasks/taskView.ts`, `taskView.test.ts` — a pure `taskGrid` for board and list order

**Done when:** on `?fixtures=static&section=tasks`, `J` and `K` move a visible cursor in both views, `X` and `Shift+↓` select, `Enter` opens the panel, moving with the panel open changes the panel, and `Esc` closes then clears.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`, then screenshots of both views with `--eval` key dispatch, and a manual check with real keys of the Table type-ahead case (typing `c` on a list row must not jump rows)
**Landed in the stage**

- `ListCursor` (`hotkeys/listCursor.ts`): `columns`, `cursorId`, `anchorId`, observable `selected`; `setGrid(columns, prefer?)`, `setCursor`, `move`, `toggle`, `anchorAt`, `extend`, `extendTo`, `selectAll`, `clearSelection`, `targets`, and the pure `stepTo`, `rangeBetween`, `survivingCursor`, `locate`, `sameGrid`. Nothing in it mentions tasks, so Stage 8 reuses it.
- `taskCommands(deps)` takes a `focusZone()` (`list` | `nav` | `other`, from `focusZoneOf`) so arrows, `Enter` and `X` never take a key from the header toggle, a panel control, an agent chip or the Rail. `tasks.select.extend` is two commands, `.down` and `.up`.
- A key that acts on an unfocused cursor first reveals it. Cursor moves are pure DOM focus (`data-task-id`), so a `J` does not re-render the table.
- Hover moves the cursor and focus, never the open panel. `J` and `K` stay off inside the detail panel, where `Esc` returns to the list. Both settled in the stage review.
- `aria-pressed` (selected) and `aria-current` (open) on board cards. The open list row is not exposed, because React Aria strips `aria-current` there.
- The RAC `Table` type-ahead survives: real keys `c a r - 2 6` on a row still reach CAR-26. The Risk fallback was not needed. The `Table` passes `data-*` through, so nothing in `packages/components/src/Table` changed.

**Follow-ups**

- Holding `J` with the panel open remounts `DetailPanel` and refetches `getTaskDetail` about 30 times a second. Fixed in Stage 5 by debouncing the fetch in `useTaskArtifacts`.
- `Space` does nothing in the list and opens the task on the board. It is the out-of-scope peek key.
- With the panel open every move still rebuilds the rows (300 rows took about 250 ms in happy-dom). Revisit only if lists reach hundreds.

**Commits:**

- `4dcd6de` feat(desktop): keyboard cursor and multi-select for tasks

**Risk:** The React Aria `Table` may not allow the cursor to drive its row focus and multi-selection this way. If it does not, replace `TaskList`'s `Table` with rows built from the same cell components. The cursor model does not change. Record that as a scope change before leaving the stage.

## Stage 5 — Property pickers and task actions

**Depends on:** Stages 3 and 4.

**This stage:** Give the cursor and the selection their actions. A shared searchable picker popover, anchored to the cursor's card or row, drives the status picker and the two dependency pickers. Actions apply to the selection when there is one, else to the cursor, by sending one command per task and showing one toast for any refusals. The keys and hints follow the keymap table. Nothing new is needed from the daemon.

- [x] Complete
  - [x] `PickerPopover`: a search field, a keyboard-navigable list, `Enter` to pick, `Esc` to close, current value marked
  - [x] `S` opens the status picker listing every status of the project, and picking sets `statusId` on each target
  - [x] `Opt+←` and `Opt+→` move each target to the previous or next status in workflow order (Windows `Ctrl+←` and `Ctrl+→`), and do nothing at the ends
  - [x] `M B` picks tasks this one depends on, and `M X` picks tasks that depend on this one, with toggle semantics and the existing cycle protection from `dependencyCandidates`
  - [x] `Shift+R` opens the detail panel for the cursor task and focuses its title editor
  - [x] `Cmd+Enter` starts the cursor task with `task.start`, and is unavailable, with no hint, when `startBlockedReason` is set
  - [x] `Cmd+Backspace` (Windows `Ctrl+Delete`) confirms through `openConfirmModal`, then deletes every target, and moves the cursor to the nearest remaining task

**Files**

- `apps/desktop/src/renderer/shared/PickerPopover.tsx`, `PickerPopover.module.css` — create: used by three pickers here and by later field pickers, so it cannot live in `features/tasks`. It is built on `@clowdy/components/Popover` and `Autocomplete`
- `apps/desktop/src/renderer/features/tasks/taskCommands.ts`, `taskCommands.test.ts` — status, move, dependencies, rename, start and delete commands
- `apps/desktop/src/renderer/features/tasks/commands.ts` — `sendCommand`: add `sendEach` to run one command per target and report refusals once
- `apps/desktop/src/renderer/features/tasks/taskView.ts`, `taskView.test.ts` — `adjacentStatus` and a dependency-toggle helper
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx`, `EditableText.tsx` — a way for the rename command to focus the title editor
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — pass the picker anchor and the actions to the commands

**Done when:** with the cursor on a task, `S` then `Enter` changes its status in the fixture daemon, `Opt+→` moves it one column, with three tasks selected `Cmd+Backspace` asks once and deletes three, and every case shows the new state after the `task.upserted` event.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop` (store-level tests through `FixtureTransport` for each command, including partial refusal)
**Landed in the stage**

- `PickerPopover` (`shared/`): `{ anchor, options, selectedIds, 'aria-label', placeholder, onPick, onClose }`, anchored to the cursor's card or row, counts as an overlay for the dispatcher, ignores the Enter that ends an IME composition, and hands focus back when it closes.
- Dependencies, rename and start act on the cursor task only. Status, move and delete act on `targets()`. Windows delete is `$mod+Delete`.
- `sendEach(root, inputs)` runs the commands in order and shows one toast for refusals. `startTask(root, id)` is shared by the Start button and `Cmd+Enter` with a per-task in-flight guard and a press-time `startBlockedReason` check.
- `Screen` remembers the card or row that last had focus. After a render, if that element left the DOM and focus fell to `body`, the cursor takes it, so a move, a delete, a drag or a slow daemon event all keep keyboard focus without a timer. Focus never leaves a field the person moved to.
- `Modal` captures the previously focused element when it is created, so closing a dialog restores focus even when a child autofocused first.
- `useTaskArtifacts` waits 120 ms before fetching, so a held `J` with the panel open no longer refetches 30 times a second. The first fetch also waits 120 ms because the panel remounts per task.

**Follow-ups**

- `EditableText` blurs on `Esc` and `Enter`, so focus lands on `body` and the next key only reveals the cursor. Returning it to the cursor would make rename smoother. It touches the panel and `EditableText` flow.
- The design-system `Autocomplete` drops the input `aria-label` when a placeholder is set (pre-existing). `Select showSearch` does the same.

**Commits:**

- `5d0ebdd` feat(desktop): status, dependency, rename, start and delete keys for tasks

## Stage 6 — View, create and linked-item keys, and hints in the Tasks UI

**Depends on:** Stages 3, 4 and 5 (it edits `TasksHeader` and `DetailPanel` after Stage 5 does).

**This stage:** Finish the first keymap and teach it in place. `C` opens the create dialog. The view toggle, the filter popover and the search field get keys. Copy keys put the task key or title on the clipboard with a toast. `O C` and `O D` jump from a task to its chat or its newest document. Every Tasks button and menu that has a key shows it, and a button that is unavailable shows no hint, as the spec says no non-working buttons.

- [x] Complete
  - [x] `C` opens the create dialog through `openCreateTask`
  - [x] `Cmd+B` toggles board and list, `F` opens the filter popover, `/` focuses the search field
  - [x] `Cmd+.` copies the task key and `Cmd+Shift+'` copies the title (several lines for a selection), each with a toast
  - [x] `O C` opens the cursor task's newest chat and `O D` its newest document result, through `ProjectUi` and `getTaskDetail`, and both say so in a toast when there is none
  - [x] Hints through `commandHint` on `TasksHeader` buttons, the `DetailPanel` foot buttons and the picker rows
  - [x] Every Tasks command appears in the help overlay under its group

**Files**

- `apps/desktop/src/renderer/features/tasks/taskCommands.ts` — create, view, copy and open commands
- `apps/desktop/src/renderer/features/tasks/TasksHeader.tsx`, `FilterPopover.tsx` — controlled open state for `F`, a focusable search for `/`, hints
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx` — hints on Start and Delete
- `apps/desktop/src/renderer/features/tasks/CreateTaskDialog.tsx` — `openCreateTask`: reused as is
- `apps/desktop/src/renderer/features/tasks/Screen.tsx` — lift what `F` and `/` need

**Done when:** from a fresh Tasks screen, the keys `C`, `F`, `/`, `Cmd+B`, `Cmd+.`, `O C` and `O D` each do their thing, and each button with a key shows it in its tooltip.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`, then a screenshot pass of the tooltips and the help overlay with all Tasks groups
**Landed in the stage**

- `tasks.create` (`c`), `tasks.view.toggle` (`$mod+b`), `tasks.filter` (`f`), `tasks.search` (`/`), `tasks.copy.key` (`$mod+.`), `tasks.copy.title` (`$mod+Shift+Quote`), `tasks.chat.open` (`o c`), `tasks.doc.open` (`o d`). `o c` and `o d` are available for any cursor task and toast "CAR-30 has no chat yet" or "… has no document yet" when there is nothing to open.
- `Command.focus?: () => boolean`: the dispatcher checks it together with `when`, while the help overlay and the hints ignore it, so the overlay no longer dims every focus-dependent command while its search field has focus. The zone checks of Tasks, Chats, Agents and Docs moved from `when` to `focus`. `focusZoneOf` delegates to `listFocusOf`.
- The dispatcher keeps claiming the repeats of a key it claimed on press until another key goes down, so a held `c` does not type "ccc" into the New task dialog.
- Cursor-follow overwrites the current history entry through `replacing`, so holding `J` with the panel open leaves one entry; `Enter` pushes its own.
- `Enter` in the search field leaves it, as does `Esc` on an empty field; `TasksHeader` takes that `Enter` so it does not open the first card.
- The view toggle's tooltip reads "Switch view ⌘B" on both items, because a hint on only the inactive item remounted the pressed button.
- After a rename ends, focus returns to the cursor's card or row through Screen's focus restoration.
- Clipboard refusals show an error toast.

**Follow-ups**

- `ConfirmButton` still shows the Delete tooltip on its armed "Confirm" label. Dropping it while armed rebuilds the button, so the fix belongs in `ConfirmButton`.
- Hovering another card moves the cursor but not the open panel, and `Cmd+Enter` starts the cursor task, so the panel's Start hint could name a key that starts a different task than the panel shows. Fixed by the parent after the stage: with the panel open, `Cmd+Enter` starts the open task.
- `c`, `f` and `/` still work with a panel control focused, such as a closed Select. That is deliberate and tested.
- Chord abort: a second key that matches no continuation still starts a fresh command. Swallowing it would either break `Tab` and `Cmd+C` or let a row's type-ahead take it, and the `o c` case that exposed it is gone.

**Commits:**

- `1d48e83` feat(desktop): create, view, copy and open keys for tasks, with hints
- `5c092d7` fix(desktop): smaller chord HUD, square hotkey capsules, wider gap before tooltip hints (owner feedback on the Stage 3 HUD and tooltips)
- `fb5708e` fix(desktop): list every shortcut in the help overlay without dimming (owner feedback: the dimming and its footnote were never asked for)
- `0ea0270` fix(desktop): start the task the panel shows, not the one under the pointer

## Stage 7 — Undo for reversible task edits (optional)

**Depends on:** Stage 5.

**This stage:** Scope change: the runtime probe is left to the user, so the stage ships on two paths. The toast Undo action always works. The Cmd/Ctrl+Z key is registered as well and works wherever the page `keydown` arrives before the native Edit-menu Undo, which the user's manual probe settles. If the probe says the menu wins on macOS, the fix is in `menu.ts` and is recorded as a follow-up, not guessed here. Every status, title, description and dependency change made by the hotkeys or the panel records the previous values in a renderer undo stack and shows a toast with an Undo action. Cmd/Ctrl+Z reverses the latest entry by sending the inverse `task.update`. Delete is not undoable until a trash exists, and its confirm dialog stays.

- [x] Complete
  - [x] The probe outcome for Cmd/Ctrl+Z is noted here when the user reports it
  - [x] An undo stack of `{ label, undo }` entries, capped in length
  - [x] Status, title, description and dependency edits record an entry and show a toast with an Undo action
  - [x] `Cmd+Z` in the `tasks` scope undoes the latest entry and is off in text fields

**Files**

- `apps/desktop/src/renderer/hotkeys/undo.ts`, `undo.test.ts` — create: a generic stack that later sections can use, so it cannot live in `features/tasks`
- `apps/desktop/src/renderer/features/tasks/commands.ts`, `taskCommands.ts` — record entries when a change succeeds
- `apps/desktop/src/renderer/features/tasks/DetailPanel.tsx` — record title and description edits
- `apps/desktop/src/main/menu.ts` — only if the probe says the Edit-menu Undo must be released to the page

**Done when:** changing a status and pressing the toast's Undo restores it in the fixture daemon, and a dispatched Cmd/Ctrl+Z does the same in a test.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Landed in the stage**

- `UndoStack` (`hotkeys/undo.ts`): `push`, `undoLatest()`, `undoEntry(entry)`, observable `canUndo`, `clear()`, capped at 50, undos run one at a time; the `undoStack` singleton and `createUndoStack(limit?)` for tests.
- `sendWithUndo(root, project, inputs)` (`features/tasks/taskUndo.ts`) is the one place that records. The `s` picker, `Alt+←/→`, the dependency pickers, drag and drop (`Screen.move`) and the panel's `update` (title, description, status, dependencies) all go through it. It records only a `task.update` the daemon accepted, with the previous values read before sending; a bulk change is one entry and one toast. Delete, start, create, refused changes and no-op changes record nothing, and an undo is not recorded, so there is no redo.
- Stale and refused undo: a task that no longer holds what the change set shows "CAR-12 changed since, so this cannot be undone", nothing is sent and the offer toast closes. In a bulk change the tasks that still match are restored and the stale ones are named. A refused inverse shows the daemon's own toast.
- Toasts: "CAR-12 moved to In progress" with an Undo action for 5 s; the next change closes the previous offer; "Undone: …" follows a successful undo.
- `tasks.undo` (`$mod+z`, scope `tasks`, `when: canUndo`) is not claimed in text fields, pickers or dialogs, and `Cmd+Shift+Z` is left alone. It does nothing in Chats or Docs, which matches Tasks-only scope.
- The toast is a two-row grid, so its Close button no longer covers the Undo button, and the Close button is visible in light mode (the `.close[data-variant]` override lost on specificity).
- `menu.ts` is untouched. The page should see Cmd+Z before the native Edit menu, which is source-derived and not run: the manual probe in `research/menu-accelerator-probe.md` settles it. The toast's Undo button works regardless.

**Follow-ups**

- Undo restores fields, not daemon side effects: a task moved to Done can unblock a waiting run that then starts, and undoing the move does not stop it. A fix would leave moves into the done category out of undo, or add a warning to the toast.
- Fixed by the parent after the stage, on the owner's call that a shared stack is wrong: an undo entry carries a `scope` (the project it was made in), `canUndo(scope)` and `undoLatest(scope)` look only at that scope, the cap of 50 is per scope, and the Tasks screen asks about its own project. Cmd+Z in project B never touches project A. The toast's Undo button still undoes its own change, whichever project is open.
- The stale check reads project state, which changes through the event feed. If the feed ever lags, two undos within one round trip could say "changed since" falsely.
- The panel Select recording uses the shared helper but has no test of its own.

**Commits:**

- `6631313` feat(desktop): undo for status, title, description and dependency edits

## Stage 8 — List navigation in Chats, Agents and Docs

**Depends on:** Stages 3 and 4.

**This stage:** It tests the architecture against more than one section. Each section pushes its own scope, registers `J` and `K` as aliases of the arrows, `Enter` and `Esc`, and shows hints, built on `ListCursor` where the list is ours and on the existing keys where the list is an ARIA tree. Re-read each file's current key handling when the stage starts.

- [x] Complete
  - [x] Chats list, Agents run tree and Docs tree each register a scope with their movement, open and close commands
  - [x] Existing local keys (the tree keys, `Mod+S` in Docs, the composer's Enter) keep working and do not collide with the registry
  - [x] Hints and the help overlay show the new commands

**Files**

- `apps/desktop/src/renderer/features/chats/ChatList.tsx` — scope and commands
- `apps/desktop/src/renderer/features/agents/RunList.tsx` — scope and commands next to its tree `onKeyDown`
- `apps/desktop/src/renderer/features/docs/DocsTree.tsx`, `Screen.tsx` — scope and commands, and the window `Mod+S` handler moves to the registry

**Done when:** `J`, `K`, `Enter` and `Esc` work in the three lists as in Tasks.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Landed in the stage**

- `J` and `K` (`chats.cursor.*`, `agents.cursor.*`, `docs.cursor.*`) in the list that has focus, built by `listMoveCommands` in `hotkeys/listNavigation.ts` (`listFocusOf` decides the zone: a row's own controls, search inputs, the composer, the editor and dialogs never lose their keys). Each section pushes its scope and registers its commands in `chatCommands`, `runCommands`, `docCommands`.
- `Home`, `End`, `Enter` and `Space` already work natively in all three lists (React Aria `GridList`, the two ARIA trees), and no section has a panel or selection that `Esc` would close, so none of them got a command.
- The Docs `Mod+S` window listener moved into `docs.save` (`$mod+s`, `inInputs: true`, live only while the document is dirty with no conflict). The Save tooltip shows its key through `commandTooltip`.
- `useListHoverHighlight` follows keyboard focus with a `focusin` handler, so the Chats highlight no longer depends on a `keydown` the dispatcher claims.
- `keymap.test.ts` registers the app, tasks, chats, agents and docs commands together and asserts no conflicts on both platforms.

**Follow-ups**

- The help overlay dims every focus-gated command, because `when()` reads `document.activeElement` and the overlay's search field has focus. Fixed in Stage 6 with a separate `focus` gate that the dispatcher checks and the overlay ignores.
- `focusZoneOf` in `taskCommands.ts` can delegate to `listFocusOf`. One behavior change: focusable elements in the region but outside a task (column header buttons) become `other`.

**Commits:**

- `8a3024c` feat(desktop): J and K in the chats, agents and docs lists

## Stage 9 — Back and forward history

**Depends on:** Stage 3 (the `app` scope commands and the title band hint), and Stage 4 for the cursor-follow rule. It touches different files from Stages 5 and 6, so it can run alongside them. The one-line change in `taskCommands.ts` that makes cursor-follow replace the entry is made by the parent after Stage 6.

**This stage:** The window has no way back. Add a `NavHistory` store that watches the navigation state (selected project, section, open chat, task, run and document, Settings and its page) and records a snapshot whenever it changes, so any action that changes what the window shows is covered without each call site knowing. Going back or forward applies a snapshot, which must not record a new entry (an applied snapshot equals the current entry). Header buttons and `Cmd/Ctrl+[` and `Cmd/Ctrl+]` drive it. A keyboard icon button at the right of the title band opens the help overlay, as the owner asked. The buttons sit at the left of the title band, before the project select, like the reference image the owner gave (chevrons next to the window controls).

- [x] Complete
  - [x] `NavHistory` with `back`, `forward`, `canGoBack`, `canGoForward`, a `replacing(fn)` wrapper for changes that should overwrite the current entry, a cap of 100, and skipping entries whose chat, task or run is gone
  - [x] `root.history` owned by `RootStore`, applying a snapshot through `selectProject`, the `ProjectUi` fields and the Settings state
  - [x] `nav.back` (`$mod+[`) and `nav.forward` (`$mod+]`) in the `app` scope, available only when there is somewhere to go, with hints
  - [x] Back and forward buttons in `TitleBand`, disabled when unavailable, with tooltips showing the keys
  - [x] A keyboard shortcuts button at the right of `TitleBand` that opens the help overlay (`openHelp`), with a new `keyboard` glyph in the 16px icon pack. Cmd+? is `$mod+/`, which already matches Cmd+Shift+/ because a symbol key accepts Shift
  - [x] Tests for push, truncate on a new entry, replace, the cap, skipping stale entries, applying snapshots across projects and Settings, and no entry recorded by going back

**Files**

- `apps/desktop/src/renderer/stores/NavHistory.ts`, `NavHistory.test.ts` — create: a store of its own, not part of `UiStore` because it spans projects and Settings
- `apps/desktop/src/renderer/stores/RootStore.ts`, `index.ts` — `RootStore`: owns and exposes `history`
- `apps/desktop/src/renderer/stores/UiStore.ts` — a way to apply a snapshot to `ProjectUi` and the Settings state
- `apps/desktop/src/renderer/shell/shellCommands.ts`, `shellCommands.test.ts` — `nav.back` and `nav.forward`
- `apps/desktop/src/renderer/shell/TitleBand.tsx`, `TitleBand.module.css` — the two buttons, and the shortcuts button on the right
- `packages/icons/src/16/keyboard.svg` — create: no keyboard glyph exists in the packs. The generated `dist/` is rebuilt with `bun run build` in `packages/icons`

**Done when:** after opening a chat, a task, then Documents, `Cmd+[` returns through them in reverse and `Cmd+]` forward again, and the buttons do the same and disable at the ends.
**Verify:** `bunx turbo run lint typecheck test --filter=@clowdy/desktop`
**Landed in the stage**

- `NavHistory` (`stores/NavHistory.ts`): `back()`, `forward()`, `canGoBack`, `canGoForward`, `replacing(fn)`, `dispose()`, `HISTORY_LIMIT` (100). Recording starts when the first project is selected. Going back or forward sets the index and applies the snapshot in one action, so the reaction sees state equal to the current entry and records nothing; no flag is needed. Entries are skipped when the project, chat, task or run of the entry's own section is gone, and also when they show the same place as the current entry. `canGoBack` and `canGoForward` follow the same rule. `RootStore` owns `history` and gained `projectState(id)`; `ProjectUi` and `UiStore` gained `view`, `show`, `settingsView` and `restore`.
- Keys are `$mod+BracketLeft` and `$mod+BracketRight`, so they also work on non-Latin layouts. They are off in text fields, where `Cmd+[` outdents in the editors.
- `help.open` gained `$mod+?`, because Cmd+Shift+/ reports the key `?` and did not match `$mod+/`.
- `TitleBand`: back and forward at the left, the keyboard shortcuts button at the right, all `variant="filling"` as DESIGN.md prescribes for toolbars, `no-drag` through the global button rule. New `keyboard` glyph in the 16px pack.
- The Agents screen's first-visit auto-select runs inside `root.history.replacing(...)`, because it recorded two entries and dropped the forward history. Chats, Docs and Tasks write no selection from effects.

**Follow-ups**

- Tasks cursor-follow must call `root.history.replacing(...)` from a plain handler. Inside another MobX action the overwrite is silently lost and the change becomes an entry. Done by the parent after Stage 6.
- A stale stored id at startup (a task or chat deleted since the last run) makes the first entry unreachable once the project snapshot arrives. A fix would rewrite entry 0 to what the window actually shows when the first project is ready.
- Mouse side buttons, Cmd+←/→ and a history that survives a restart are out of scope.

**Commits:**

- `80d7d3c` feat(desktop): back and forward history with title band buttons
