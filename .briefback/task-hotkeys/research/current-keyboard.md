# Keyboard handling today: components, renderer, Electron, focus, libraries, Reforma

Research for the Task hotkey work. Facts are from the source as of branch `kachurun/feat/mvp` (HEAD `8b90309`) and the read-only sibling repo `/Users/bionic/WORK/Reforma/reforma` (HEAD `6ecaae32d`). Inferences are marked.

## Summary

- There is no global hotkey registry, no focus-scope concept, no command palette, and no shortcut help in Clowdy's running app. Each key behavior is local: a component `onKeyDown`, a window or document listener added by one component, or React Aria's built-in collection keys.
- A hotkey engine already exists in the repo but is dead code: `packages/lib/src/hotkeys.ts` (a MobX singleton `hotkeys` with `register`, selector-based exclusion, capture or bubble phase, modifier tracking). It is a byte-for-byte copy of Reforma's (only the import path differs). Nothing in Clowdy calls `register` or `init`, so its listeners were never attached. Its limits matter: no key sequences (needed for `G` then `I`), matches physical keys through `e.code`, no IME guard, no scope stack.
- Reforma uses that engine for exactly the target pattern (contextual single-key actions on the selection, `cmd_slash` for a help modal): `apps/front/src/editor/hotkeys/EditorHotkeys.tsx`, `shortcutsCatalog.ts`, `KeyboardShortcutsModal.tsx`. It has no command palette.
- Display is supported: `Hotkey` capsule, `tooltipWithHotkey(label, hotkey)` for `Button tooltip`, and `MenuItem endAffix={<Hotkey …/>}`. Three places use these today (MarkdownToolbar, SettingsLayout save, chat Composer send). No tooltip or menu in the Tasks UI shows a hint.
- The Electron main process has no `before-input-event`, no `globalShortcut`, and no custom accelerators; the menu is Electron role-based, so it already owns Cmd or Ctrl+R, W, M, Q, H, 0, +, -, Z/X/C/V/A, and DevTools. The bridge has no key IPC.
- Hazards for a hotkey layer: React Aria stops propagation of keys it handles and swallows printable keys for type-ahead in Table, ListBox, Menu, GridList; `Modal.create` renders in a separate React root (no context) without a focus trap or `inert`; `useCellEditMode` installs a window capture listener that stops propagation; the desktop Vitest config cannot parse `@clowdy/lib/hotkeys` (decorators).

## How it works

### Libraries installed (from `bun.lock` and `package.json`)

- `react` 19.3.1 and `react-dom` 19.3.1; `react-aria` 3.53.1; `react-aria-components` 1.22.1; `react-stately` 3.51.0 (dependencies of `packages/components` only; `apps/desktop` imports them through `@clowdy/components`).
- `mobx` 7.1.7, `mobx-react-lite` 5.1.3 (renderer components are wrapped by `babel-plugin-observing-components`); `lodash` (the hotkey engine imports `lodash/debounce` and `lodash/throttle`); `motion` 13.
- `@dnd-kit/react` 0.5.0 (used by `SortableList`, not by the Tasks board, which uses native HTML5 drag). TipTap 3.32.2 and CodeMirror 6 (own keymaps inside the editors).
- Test: `vitest` 5.1.0, `happy-dom` 21.0.4, `electron` 45.2.1.
- Searched `bun.lock` for hotkey, tinykeys, cmdk, mousetrap, react-hotkeys, kbar, ninja-keys, @tanstack, hotkeys-js, keybinding: none present. There is no command-menu library either. React Aria has no shortcut-binding API (it has `useKeyboard`, `Keyboard` for display, and `useLandmark` for F6; `useLandmark` is not used in Clowdy).

### The Hotkey display layer (`packages/components/src/Hotkey/`)

- `Hotkey.tsx`: `<Hotkey hotkey size="xs|sm|md" />` renders RAC `Keyboard` as one capsule; all keys are joined with a space inside the single capsule (not one capsule per key). `tooltipWithHotkey(label, hotkey)` returns `label + <Hotkey size="xs">` for the `tooltip` prop of `Button` (which accepts `string | ReactNode`). Exported from `@clowdy/components/Hotkey` and the barrel.
- `hotkeysToSymbols.ts`: `HotkeyValue = string | readonly string[]`. A string longer than one character is split on `_`, whitespace, and `+` (so `'mod+s'`, `'mod s'`, `'mod_s'` all work and a literal `+` key cannot be written as a string; use the name `plus`). Known names are mapped: `up/down/left/right` (+ `arrow*`) to arrows, `plus`, `minus`, `command`, `option`, `control`, and the platform ones: `meta|mod|cmd` to `⌘` or `Ctrl`, `alt` to `⌥` or `Alt`, `shift` to `⇧` or `Shift`, `ctrl` to `⌃` or `Ctrl`, `backspace`, `delete`, `enter|return` to `Enter`, `backslash`. Anything else is lower-cased and capitalized (`escape` becomes "Escape", `k` becomes "K", `/` stays "/"). There is no symbol for Escape, Tab, Space, comma, or period. A sequence ("G then I") has no representation: an array `['g', 'i']` renders as "G I", indistinguishable from two keys of a chord.
- Mac detection is `navigator.userAgent.includes('Mac')` at module load, so it does not use `window.desktop.platform`. Two more copies of the same sniff exist: `packages/lib/src/hotkeys.ts` and `apps/desktop/src/renderer/features/docs/DocsMain.tsx` (`SAVE_SHORTCUT = '⌘S' | 'Ctrl+S'`).
- Current uses: `MarkdownToolbar.tsx` (text-style menu rows use `endAffix={<Hotkey hotkey={style.hotkey} />}`, toolbar buttons use `tooltipWithHotkey`), `SettingsLayout.tsx` (`SAVE_HOTKEY = ['mod','s']` tooltip), and `features/chats/Composer.tsx` (`tooltipWithHotkey('Send','enter')`). `MenuItem` (`List/Menu.tsx`) has `startAffix`, `icon`, `description`, and `endAffix` slots; there is no first-class `hotkey` prop, and RAC itself binds no shortcut for you.
- `Tooltip`/`TooltipTrigger` (`Tooltip/Tooltip.tsx`): wraps RAC tooltip triggers with a 500 ms open delay and 150 ms close delay; optional "warmUp". It opens on hover and on keyboard focus. It does not know about hotkeys.

### The unused engine (`packages/lib/src/hotkeys.ts`)

- Shape: class `Hotkeys`, default export `hotkeys` (module singleton). `register(...HotkeyHandlerData[])` returns a disposer; `unregister`, `disable({exclude})`, `enable`, `loose`. `init()` is called by the first `register`. Observable `pressed`, `shiftKey`, `metaKey`, `altKey`, `ctrlKey`, computed `commandKey`.
- Handler data: `hotkeys: string[]`, `handlerDown | handlerUp | handlerPress`, `shouldPrevent(e)` (true means "skip this handler and continue", the name is inverted from what it reads), and `options`: `included`/`excluded` (selectors or elements, matched against `e.target` with `closest`), `capture`, `runFirst` (default true, LIFO), `clearHandlers`, `preventDefault` (default true), `stopPropagation` (default true), `stopImmediatePropagation`, `allowRepeat`, `debounce`, `throttle`.
- Matching: the name is built from modifiers in fixed order `meta_control_shift_alt_` plus `e.code` with the `Key` prefix removed and lower-cased (`KeyK` gives `k`, `Slash` gives `slash`, `Digit1` gives `digit1`, `ArrowDown` gives `arrowdown`). So keys match by physical position, not by produced character; `?` is `shift_slash`, and a non-US layout changes what the user's `?` or `/` key is. Registered names are lower-cased and normalized (`ctrl` to `control`, `return` to `enter`, `cmd` or `command` to `meta` on Mac or `control` otherwise). The `mod` word that the display layer understands is not normalized here, and only the first `cmd`/`ctrl` occurrence is replaced.
- Gaps against the target: no multi-step sequences, no `isComposing` check (IME), no notion of scope or priority except LIFO and `clearHandlers`, no registration metadata (labels, groups) for a help screen or menus, listeners attach to `document` both in capture and bubble phase for `keydown`, `keypress`, and `keyup`, and `init()` prevents default for every Alt keydown ("avoid the window losing focus on Windows") once it is initialized. It reads `window.$document` (a jQuery-era hook) and falls back to `[document]`. It runs a catch-all `'*'` handler for modifier tracking, so every keystroke enters `handleEvent`.
- Exports: `contentEditableSelectors = ['input','textarea','[contenteditable]:focus']` is the standard text-field exclusion.
- Current Clowdy use of the singleton: only reads `hotkeys.shiftKey` and `hotkeys.altKey` from `useRunner` (pointer scrubbing in `Input` and `UnitInput`, `HexColorEditor`) and `UnitInput`'s `shouldRun`. Because nothing registers a handler, `inited` stays false and those flags never change (inference: scrub-with-Alt and Shift-step do nothing in Clowdy today).
- Importability: the file uses decorators (`@observable accessor`). `apps/desktop/vitest.config.ts` has no Babel plugin, so a Vitest test that imports it, directly or through `@clowdy/components/Input`, would not parse. `Composer.test.tsx` already works around this by mocking `@clowdy/components/Select`, with the comment "its Input does not parse there". `packages/components/vitest.config.ts` does enable `@babel/plugin-proposal-decorators`. Inference for the engine itself; not reproduced.

### Where keys are handled today

Components package (`packages/components/src/`):

| Where | Behavior | Scope and phase |
| --- | --- | --- |
| `List/ListBox.tsx`, `Menu.tsx`, `GridList.tsx` | RAC collections: arrows, Home/End, Enter/Space, type-ahead. `useListHoverHighlight` listens to `keydown` on the list only to move its highlight plate to the keyboard row | Local, React synthetic |
| `List/useCellEditMode.ts` | Window-level capture `keydown` that calls `event.stopPropagation()` while an embedded editable is focused (workaround for react-spectrum#4674). Used by `ChatList` `RenameField` | Window, capture, global while flagged |
| `Autocomplete/Autocomplete.tsx`, `useAutocompleteEnterAction.ts` | Search field in a popover; the hook runs Enter on the highlighted option because RAC often skips `onAction` | Local `onKeyDown` |
| `Select/Select.tsx` | RAC Select; `showSearch` overlays an `Autocomplete`. `DependencyList` uses it | Local |
| `Input/Input.tsx` | `bindGridCaret`: one document capture `keydown` for ArrowLeft/Right inside registered inputs so list navigation does not eat the caret (has an `isComposing` guard) | Document, capture |
| `Input/SearchInput.tsx` | Escape clears a non-empty field and calls `preventDefault`; otherwise passes `onKeyDown` through | Local |
| `Panel/PanelSearch.tsx` | Forwards `onKeyDown` to `SearchInput`; `autoFocus` prop | Local |
| `RichInput/composerKeymap.ts` | ProseMirror `handleComposerKeyDown`: Escape closes the mention menu, Enter submits with an `isComposing` check, Mod+Enter, Shift+Enter in lists. The desktop `Composer` does not use `RichInput` | Editor-local |
| `modals/ConfirmModal.tsx` | Enter confirms unless focus is on a button or link | Local, bubbling `onKeyDown` |
| `Modal/Modal.ts` (~L805) | `overlay.addEventListener('keydown')` closes on Escape if `closeOnEscape`; calls `preventDefault` and `stopImmediatePropagation`. Only fires when focus is inside the overlay | Overlay element |
| `ConfirmButton/ConfirmButton.tsx` | While armed, a `document` `keydown` handles Escape (disarms, `stopPropagation`) | Document, bubble |
| `SettingsLayout/SettingsLayout.tsx` | While dirty, a `window` capture `keydown` handles Mod+S (`preventDefault`, `stopPropagation`) so portaled panes still save | Window, capture |
| `MarkdownEditor`, `CodeInput`, `AngleControl`, `ColorInput`, `LayoutGridControl`, `GradientStopRange`, `useStickToBottom` | Their own local keys | Local |
| `Hotkey/` | Display only (above) | None |

Desktop renderer (`apps/desktop/src/renderer/`):

| Where | Behavior |
| --- | --- |
| `features/tasks/TaskList.tsx` | Only a `stop` handler on the agents cell. Row navigation is RAC Table |
| `features/tasks/Board.tsx`, `TaskCard.tsx` | No key handling; cards are buttons, native drag |
| `features/tasks/EditableText.tsx` | Escape drops the edit (sets a `dropped` ref, blurs, no save); Enter in the title variant blurs, which saves; no `isComposing` check; no shortcut to save the body |
| `features/chats/Composer.tsx`, `composerKeys.ts` | Enter sends, Shift+Enter is a newline; `isSendKey` returns false while `isComposing` (IME). Test: `composerKeys.test.ts`, `Composer.test.tsx` |
| `features/chats/ChatList.tsx` | `RenameField`: Enter commits, Escape cancels, `useCellEditMode`, `autoFocus` |
| `features/agents/RunList.tsx` | ARIA tree: `onKeyDown` on the `role="tree"` container for Arrow, Home, End, Enter, Space on `treeitem` rows; moves selection and DOM focus with `.focus()` |
| `features/docs/DocsTree.tsx` | The same pattern for the docs tree |
| `features/docs/Screen.tsx` | `window` `keydown` (bubble): Mod+S saves the open document, `preventDefault`. Active only while the Docs section is mounted. No editable-target guard |
| `features/settings/AppearancePage.tsx` | Theme cards: Enter and Space |
| `shell/Rail.tsx`, `ProjectSelect.tsx` | Plain buttons; `ProjectSelect` is an RAC `MenuTrigger` + `Menu`. No section shortcuts, no project switch key |

There is no number-key section switching, no `Cmd+K`, no `?`, no `Esc` to close the task panel, and no shortcut help anywhere.

### Electron main, preload, shared

- `src/main/menu.ts` (`createAppMenu`): role-based. macOS: `appMenu`, `editMenu`, a `viewMenu` with `reload`, `forceReload`, `toggleDevTools`, `resetZoom`, `zoomIn`, `zoomOut`, `togglefullscreen`, and `windowMenu`. Other platforms use `fileMenu` instead of `appMenu`. The comment says Windows hides the menu bar behind the custom title bar "so only the shortcuts matter there". No item sets its own `accelerator`; the roles supply the platform defaults. In practice that covers Cmd or Ctrl plus R, Shift+R, 0, +, -, M, W, Q (mac), H (mac), Z, X, C, V, A, and the DevTools combo.
- `src/main/index.ts`: `Menu.setApplicationMenu(createAppMenu())`. Searched `apps/desktop/src` for `before-input-event`, `globalShortcut`, and `accelerator`: nothing except the comment in `menu.ts`. `src/shared/bridge.ts` and `src/preload/index.ts` expose `platform`, `material`, `setThemeSource`, `chooseDirectory`, and `daemon`; no key or shortcut IPC. `window.desktop.platform` exists and is not used for key display.
- Sibling lesson (Reforma commit `d77bc0607`, "route cmd+r to preview"): Reforma's menu leaves out Reload and Close Window so that the web layer can use Cmd+R, and keeps Force Reload (Cmd+Shift+R); it adds `Settings…` with `CmdOrCtrl+,`. Clowdy's menu keeps Reload and the window menu's Close, so Cmd or Ctrl+R and Cmd or Ctrl+W act on the window. Whether a menu accelerator pre-empts a page `keydown` (macOS in particular, where Edit roles like Undo/Redo and Select All also live) was not verified here. It matters for an app-level Cmd+Z.

### Shell and focus structure

- Mount: `main.tsx` calls `initTheme()` then mounts `App` (`RootStoreProvider`, `Shell`, `ToastRegion`). `Shell.tsx`: `TitleBand` (project select), `Rail`, and `<main>` with `Outlet`. `Outlet` picks Loading, Unreachable, `SettingsScreen` (when `root.ui.settingsOpen`), `NoProject`, or `ProjectScreen`, which renders `SCREENS[ui.section]` (`chats`, `tasks`, `agents`, `docs`). Settings replaces the outlet; it is not a modal, so the section screen unmounts while Settings is open.
- Switching: Rail buttons call `root.ui.showSection(ui, section)`; `ui.openTask|openChat|openRun|openDoc` switch the section and select in one step; `root.ui.openSettings(page?)`. Screens remount on every switch, so any `useState` inside a screen (the Tasks filter, the Agents query and folds) resets.
- Where focus is when a section mounts: Tasks sets no focus. After a mouse click on a Rail button, that button is the active element (inference: Chromium focuses buttons on click) and survives the screen swap, so a key event's `target` would be a `<button>` in the Rail. A global handler must therefore not treat "focus is on a button" as "typing". Chats `Composer` has `autoFocus={ !chat.orchestratorRunId }` (a fresh chat steals focus into the textarea). `RenameField` and every dialog's first `Input` use `autoFocus`.
- Focus-stealing layers:
  - `Modal.create` (`packages/components/src/Modal/Modal.ts`): imperative; appends a container to `document.body` and renders `ModalRoot` with `createRoot` in a separate React root. React context from `App` (`RootStoreProvider`) does not reach modal content, which is why `openCreateTask` and the project dialogs take `root` and friends as arguments. The overlay is `<div data-modal-overlay tabIndex>` focused on open (`focus()` does not steal when something inside already has focus); on close it restores focus to the previously focused element. There is no `aria-modal`, no `inert` on the rest of the app, and no Tab trap (not verified in a running app; read from source). Nested overlays get increasing `tabIndex`.
  - RAC overlays (`Popover`, `Select`, `MenuTrigger`, `DialogTrigger`): portal to `body`, React Aria hides the rest of the page from assistive tech (`ariaHideOutside`) while a modal popover is open, and handle Escape themselves. `Popover` sets `data-modal-clickout-layer`, which `Modal` uses to avoid closing itself on a click in a popover.
  - `ConfirmButton` (Delete) and `ToastRegion`: not focus traps.
- How React Aria interacts with a global layer (verified against `node_modules/react-aria` 3.53.1):
  - `useKeyboard`/`createEventHandler` calls `stopPropagation()` by default when a handler runs, unless the handler calls `continuePropagation()`.
  - `useSelectableCollection` (Table, ListBox, GridList, Menu, Tree) calls `stopPropagation` for the keys it handles.
  - `useTypeSelect` consumes any printable key without Ctrl, Meta, or Alt when the collection finds an item whose text starts with the typed characters (`preventDefault` and, when the event has no `continuePropagation`, `stopPropagation`). For the Tasks list this is read from `TableKeyboardDelegate.getKeyForSearch` (react-aria `table/`): it compares the typed text with the row's `textValue` and with the cells of the row-header columns, and `TaskList` marks the Key column `isRowHeader`. So with focus on a row, `c` can jump to a row whose key starts with "C" (the project prefix, e.g. `CLW-12`) instead of reaching a "create task" handler. Not reproduced in the running app.
  - Since React 17 events are delegated at the React root, a native `stopPropagation()` in a React handler stops `document` and `window` bubble listeners. A `document` or `window` capture listener sees every key first and has to filter by itself; Reforma's `capture: true` options reflect that.
  - `FocusScope` (inside RAC Dialog and Popover) contains and restores focus; a global layer should not run actions while one of those is open unless it opts in.
- Text-input and IME guarding that exists: `composerKeys.isSendKey`, `composerKeymap` (`event.isComposing`), `Input.arrowMovesCaret` (`isComposing`), `useCellEditMode`, `SearchInput` Escape, `EditableText` Escape and Enter (local). No shared helper decides "the user is typing", and `EditableText`, `RenameField`, and the Docs Mod+S handler have no `isComposing` check.

### Existence checks (asked in the brief)

- Global hotkey registry: no (dead engine in `packages/lib` only).
- Focus-scope concept (a stack of active contexts): no.
- Command palette or Cmd+K: no. The nearest parts: RAC `Autocomplete` + `ListBox` (`Autocomplete` component, `Select showSearch`), `Modal.create`, `useAutocompleteEnterAction`.
- Shortcut help: no.
- Section, project, or task keys: none.

### Sibling repo reuse (Reforma, read-only; same author)

- `packages/lib/src/hotkeys.ts`: identical to Clowdy's copy except the first import line (`@reforma/lib` vs `@clowdy/lib`). Nothing new to take from it.
- `packages/components/src/Hotkey/*`: identical except the import path.
- `apps/front/src/editor/hotkeys/EditorHotkeys.tsx` (591 lines): a React component rendering `null` whose `useEffect`s call `hotkeys.register([...])` and return the disposer, with dependencies on runtime state. Patterns worth knowing before designing:
  - Option presets by context: `EDITOR_HOTKEY_OPTIONS` (`capture: true`, `clearHandlers`, `stopImmediatePropagation`, excluded selectors: the three `contentEditableSelectors`, `[role="listbox"]`, `[role="menu"]`, `[role="dialog"]`, `[data-modal-overlay]`), `TYPING_OK_HOTKEY_OPTIONS` (drops the text-field exclusion for modifier shortcuts), `LAYER_ACTION_HOTKEY_OPTIONS` (text fields and listboxes excluded, but not menus or dialogs, because the layer popover is a dialog), `UNDO_HOTKEY_OPTIONS`.
  - Contextual single keys on the current selection: `s`, `p`, `c`, `enter`, `backspace`, `delete`, with `shouldPrevent` returning true when there is nothing selected or the action does not apply, so the key falls through. A `read()` closure returns the current surface or `null` per registration.
  - Registrations are grouped per context (canvas mode, code mode, design-system mode) and re-registered when state changes.
  - `cmd_slash` opens the shortcut help; `escape` has layered meaning (comment mode, text edit, leave component).
  - Platform notes in comments: off Mac `cmd` is Ctrl and the terminal must keep Ctrl+C or D; `⌘R` is registered only when `window.desktop` is set.
- `apps/front/src/editor/hotkeys/shortcutsCatalog.ts` (107 lines): `SHORTCUT_SECTIONS` array of `{ id, title, shortcuts: { id, label, hotkey } }` and `filterShortcutSections(query)` matching label, key names, or rendered symbols. The comment calls it the "single source of truth for registered editor shortcuts", but registration objects are separate (inference: the two are kept in sync by hand).
- `KeyboardShortcutsModal.tsx` (85 lines): `Modal.create({ id, name, type: 'window', position: ['end','start'], reuseExisting: true, duplicate: false, ... })` with a `SearchInput`, sections, and `<Hotkey size="sm">`. Clowdy's `Modal` supports those options (`typings.ts`).
- Tests: `apps/front/src/specs/editor/editor-hotkeys.test.ts` mocks `@reforma/lib/hotkeys` (`register` pushes batches; the test finds live handlers by key name and calls `handlerDown` and `shouldPrevent`). That pattern avoids dispatching DOM events.
- Command palette: none. `Omnibox.tsx` is a preview-URL and page combobox built from `Autocomplete`, `ListBox`, `Popover`, `useAutocompleteEnterAction` (the same pieces Clowdy has). No Cmd+K anywhere in Reforma.
- Ownership: the code is the same author's. Reforma's desktop `package.json` says `"license": "UNLICENSED"` and author "Reforma, Inc.", and the repo is `private`. AGENTS.md says Clowdy "forked" the design system from Reforma. Nothing was copied here.

## Relevant files

- `packages/lib/src/hotkeys.ts` — unused singleton engine (register, exclusion selectors, capture)
- `packages/lib/src/useRunner.ts` — only reader of `hotkeys.shiftKey/altKey`
- `packages/components/src/Hotkey/Hotkey.tsx`, `hotkeysToSymbols.ts` — display capsule, `tooltipWithHotkey`, symbol mapping
- `packages/components/src/Tooltip/Tooltip.tsx`, `useTooltipTriggerState.ts` — tooltip trigger, no hotkey awareness
- `packages/components/src/Button/Button.tsx` — `tooltip` prop takes a node
- `packages/components/src/List/Menu.tsx`, `ListBox.tsx`, `GridList.tsx`, `useCellEditMode.ts`, `useListHoverHighlight.ts` — collections, `MenuItem endAffix`, capture workaround
- `packages/components/src/Autocomplete/Autocomplete.tsx`, `useAutocompleteEnterAction.ts`, `Select/Select.tsx` — searchable list pieces for a palette
- `packages/components/src/Input/Input.tsx`, `SearchInput.tsx`; `Panel/PanelSearch.tsx` — input key handling, Escape clear
- `packages/components/src/RichInput/composerKeymap.ts` — IME-aware Enter handling in TipTap
- `packages/components/src/Modal/Modal.ts`, `Modal/views/ModalRoot.tsx`, `Modal/typings.ts` — imperative modal, own React root, Escape, focus
- `packages/components/src/modals/ConfirmModal.tsx`, `ConfirmButton/ConfirmButton.tsx`, `SettingsLayout/SettingsLayout.tsx` — local Enter, Escape, and Mod+S handlers
- `packages/components/src/Table/Table.tsx` — RAC Table wrapper used by the task list
- `apps/desktop/src/main/menu.ts`, `main/index.ts`, `shared/bridge.ts`, `preload/index.ts` — Electron menu and bridge
- `apps/desktop/src/renderer/shell/Shell.tsx`, `Rail.tsx`, `TitleBand.tsx`, `ProjectSelect.tsx`, `projectDialogs.tsx` — layout, section switching, dialogs
- `apps/desktop/src/renderer/features/tasks/TaskList.tsx`, `EditableText.tsx`, `Board.tsx`, `TaskCard.tsx` — key behavior in Tasks
- `apps/desktop/src/renderer/features/chats/Composer.tsx`, `composerKeys.ts`, `ChatList.tsx` — Enter-to-send with IME guard, rename field
- `apps/desktop/src/renderer/features/agents/RunList.tsx`, `features/docs/DocsTree.tsx`, `features/docs/Screen.tsx` — tree keys, window Mod+S
- `/Users/bionic/WORK/Reforma/reforma/apps/front/src/editor/hotkeys/EditorHotkeys.tsx`, `shortcutsCatalog.ts`, `KeyboardShortcutsModal.tsx` — sibling hotkey layer and help modal
- `/Users/bionic/WORK/Reforma/reforma/apps/front/src/specs/editor/editor-hotkeys.test.ts` — test pattern for registrations
- `/Users/bionic/WORK/Reforma/reforma/apps/desktop/src/main.ts` — menu with `Settings…` accelerator, Reload removed

## Constraints and gotchas

1. The engine matches `e.code`, not `e.key`. `?` is Shift+`/` on US layouts only; `G` then `I` is physical. Any design that shows a literal character must decide whether to match by `key` or `code`.
2. Single-letter hotkeys must not fire in `input`, `textarea`, `[contenteditable]`, `role="textbox"`, `role="combobox"` fields, RAC `Select` or `Autocomplete` search inputs, or while an IME is composing. None of this is shared code today.
3. RAC type-ahead and `useSelectableCollection` swallow keys inside Table, ListBox, GridList, Menu, and Select. A layer in the bubble phase will not see them. A capture-phase layer sees them first but then has to decide which keys it may take.
4. A `Modal.create` dialog is a separate React root: context-based registries or providers will not be visible inside it. A module singleton or DOM-attribute checks (`[data-modal-overlay]`) cross the boundary. The modal does not make the rest of the app inert, so keys typed with focus outside the overlay still reach the page behind it (inference from source; not run).
5. `useCellEditMode` installs a window capture listener that calls `stopPropagation()` for every keydown while a flagged editable is focused. In the capture phase, that precedes a document capture listener and the editable's own React handlers. Whether `RenameField`'s Enter and Escape still reach their handlers was not checked.
6. The menu roles already own several Cmd or Ctrl chords, and the app-level Edit roles (Undo, Redo, Select All) are native text commands, not task undo. Check them before assigning Cmd+Z or Cmd+R to tasks.
7. `hotkeys.init()` would add document-level capture and bubble listeners for three key event types plus pointer listeners, and prevent default for every Alt press. It is a global behavior change the first time anything registers.
8. The engine cannot be imported in the desktop Vitest config as is (decorators; see above); `packages/components` Vitest can.
9. The Mac sniff is repeated in three places and ignores `window.desktop.platform`; `Hotkey` shows words (`Ctrl`, `Alt`) on Windows and symbols on Mac.
10. `Hotkey` renders one capsule for the whole combination and has no sequence form.
11. `Docs` Mod+S and `SettingsLayout` Mod+S are window listeners that do not check the target. They apply only while their screen is mounted, so they do not collide with Tasks.
12. DESIGN.md sets visual rules for focus and hover; see `design-intent-and-tests.md`.

## Open questions

- Reuse or replace `packages/lib/src/hotkeys.ts`? It supports single chords with selector exclusion and capture, but not sequences, scopes, IME, labels, or logical keys. Deciding needs the owner's view; this research only lists what it does.
- Where should the registry live so that `Modal.create` content and the main-process menu can participate: a module singleton, a MobX store on `RootStore`, or both?
- Do menu accelerators pre-empt page keydown on macOS and on Windows in this Electron version (45.2.1)? Needs a quick manual probe.
- Should Cmd+K be a `Modal.create` window, a RAC `Popover`, or a new overlay? Each has a different focus story (above).
- Does the project want Tab and Shift+Tab to stay for focus movement (accessibility) while single keys are added? Not decided in any document.

## Assumptions and limits

- Read in full or in the relevant part: `Hotkey/*`, `lib/hotkeys.ts`, `useRunner.ts` (call sites), `Tooltip.tsx`, `useTooltipTriggerState.ts`, `Menu.tsx`, `listRowItemContent.tsx`, `useCellEditMode.ts`, `useListHoverHighlight.ts` (key listener), `useAutocompleteEnterAction.ts`, `Autocomplete.tsx`, `SearchInput.tsx`, `PanelSearch.tsx`, `Input.tsx` (key code), `composerKeymap.ts`, `ConfirmModal.tsx`, `ConfirmButton.tsx`, `SettingsLayout.tsx` (save hotkey), `Table.tsx`, `Modal.ts` (focus, Escape, root creation), `ModalRoot.tsx`, `main/menu.ts`, `main/index.ts`, `shared/bridge.ts`, `preload/index.ts`, the shell and Tasks files, `Composer.tsx`, `composerKeys.ts`, `ChatList.tsx` (rename), `RunList.tsx`, `DocsTree.tsx`, `docs/Screen.tsx`, and React Aria's `createEventHandler`, `useTypeSelect`, and `useSelectableCollection` in `node_modules/react-aria` 3.53.1.
- Not read: `ListBox.tsx` and `GridList.tsx` bodies beyond the grep for key handlers, `Select.tsx` beyond the search and placement parts, the other component-local key handlers listed in the table (`CodeInput`, `AngleControl`, `ColorInput`, `LayoutGridControl`, `GradientStopRange`, `useStickToBottom`, MarkdownEditor/TipTap), `windowChrome.ts`, and the helper modules `EditorHotkeys.tsx` imports (`runLayerMenuAction`, `chatHotkey`, `PanZoom.tsx`, which also calls `hotkeys.register`). `EditorHotkeys.tsx`, `shortcutsCatalog.ts`, and `KeyboardShortcutsModal.tsx` were read in full.
- Not run: nothing was launched. Claims marked "inference" or "not verified" need a manual probe: Chromium button focus on click, menu accelerator versus keydown order, `RenameField` Enter, Table type-ahead collision with `C`, Modal focus behavior in the running app.
- No CodeGraph index exists in this repo; all lookups used Read, Grep, and shell.
