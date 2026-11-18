# Design intent for Tasks and keyboard, and how a hotkey layer would be tested

Research for the Task hotkey work. Facts are from the repo as of branch `kachurun/feat/mvp` (HEAD `8b90309`) and, for the spec, git history. Inferences are marked.

## Summary

- No document in the repo mentions keyboard shortcuts, a command menu, or hotkeys for Tasks. The only keyboard decisions on record are two hint patterns in `.briefback/mvp/research/ui-inventory.md` (`tooltipWithHotkey('Send','enter')` and `tooltipWithHotkey('Save',['mod','s'])`), the Hotkey display component, and a few DESIGN.md rules about focus and density.
- Linear appears in the docs only as an external task provider, deliberately not built ("Linear or any other tracker is an optional external source behind a `TaskProvider` seam ... not built now"). DESIGN.md says "Don't clone Figma or Linear chrome". That is about visual chrome; it does not address keyboard behavior. This is a decision the owner should confirm, and it is listed under Open questions.
- The product spec named in `AGENTS.md` (`spec.md`) is not in the working tree (untracked in commit `9c9d743`). Its first version is in git history (`5cb724f:spec.md`, Russian). It has no keyboard section. Its Tasks section (5.4) says "Do not show non-existent working buttons", which bears on contextual actions and on shortcut hints.
- Tests are Vitest with `react-dom/client` and React's `act`, no Testing Library. Keys are simulated by dispatching `new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })` on the focused element. Pure helper tests (`taskView.test.ts`, `composerKeys.test.ts`) and store tests with the in-memory `FixtureTransport` give most of the coverage a hotkey layer would need. Component tests cannot import the design-system `Input` (and therefore `Select`, `SearchInput`) under the desktop Vitest config.
- Visual checks without a person use `bun scripts/screenshot.ts` with `?fixtures=static&section=tasks&task=t-24&view=list`; `--eval` runs untrusted synthetic events in the page.

## How it works

### Design intent found (quoted decisions)

`DESIGN.md` (visual language; several sections are Reforma carry-over, for example the variable galleries):

- "Confirmed rejections: generic AI-saas (purple gradients, Inter, glassmorphism); Figma/Linear chrome clones; playful or illustration-led product UI." (Overview) and, under Don'ts, "**Don't** clone Figma or Linear chrome."
- Navigation: "Active is tonal or Terracotta text, not a pill nav copied from Linear."
- Density: "**The Density Rule.** Chrome body is 13px. Do not 'fix' it to 16px for readability. This is an editor, not a marketing page." and "Density is compact: `md` controls are 36px tall (`--spacing-36`); `sm` 30px; `xs` 24px; `lg` 56px."
- Focus: "**Focus:** 1px Terracotta border (`:focus-within`). No extra glow." and "**The Terracotta Rule.** ... One filled primary (or one focus ring) per region." and "**Do** keep Terracotta rare: one filled primary or one focus per region."
- Hover: "muted stone border, not a fill change." Cards: "**Don't** put drop shadows on cards, buttons, or rails."
- Selection versus keyboard focus has one precedent: for the variable color cards, "Selection and keyboard focus use a neutral outline on this surface, overriding the generic Terracotta active-card rule." (Reforma-inherited section; not a Clowdy surface.)
- Modal: "Float plate ... This is the only place large radius + shadow stack by default." Relevant to a command menu or help overlay: it would be a modal-style float.

`.briefback/mvp/ui-wireframes.md` (Tasks):

- "Header: 'Tasks' in bold with a subtitle ... Toolbar on the right: segmented **Board | List**, a search field ('Search tasks…'), an outlined **Filter** button, and a **+ Task** button."
- Board: "Cards are white rounded cards ... The selected card has an accent outline." List: "the same tasks as rows (key, title, status pill, agent chips)." Detail panel: "about 400px, opens on the right inside the section when a card is selected".
- No keyboard, focus, shortcut, or density statements for Tasks. "Spec overrides" lists nothing about Tasks.

`.briefback/mvp/research/ui-inventory.md`:

- Hint pattern for Send: "`isPending`, `tooltip={tooltipWithHotkey('Send','enter')}` (`/Hotkey`)" and for Save: "`tooltip={tooltipWithHotkey('Save',['mod','s'])}`". These are the sanctioned way to show a hotkey in a tooltip.
- Tasks filter: "`Button variant="bordered"` with 14/`Sliders` opening `Popover`+`Menu`" (the implementation uses checkboxes in a popover instead).
- Drag between columns: "`@dnd-kit/react` directly ... skip in the MVP and change status from the detail panel" (the implementation shipped native HTML5 drag, not dnd-kit).
- Kanban card: "`Card variant="filled" hoverable isActive={selected}`" (the implementation uses its own CSS module).

`.briefback/mvp/plan.md`:

- "The task list is internal and the source of truth. Linear or any other tracker is an optional external source behind a `TaskProvider` seam (`Task.external`), not built now." and, under Out of scope, "Linear or any provider sync".
- "One task, one chat: starting a task opens a new chat whose orchestrator is bound to it."
- Stage 4: "Chats, Tasks (kanban, list, detail panel), Agents (tree, stream), Documents (tree, editor) — one owner per screen folder." Nothing about shortcuts. Verification named: "typecheck, lint, CDP walkthrough".

`.briefback/mvp/stage-5-6-notes.md`: "The task panel shows Start on a Done task." A known case of an action offered where it does not apply; relevant to which contextual actions a hotkey layer exposes.

`spec.md` (from `git show 5cb724f:spec.md`, Russian; the tracked copy was removed in `9c9d743`): section 5.4 says the board is the main view with a list switch, a card opens details in a side panel inside the section, and "Действия с задачей записываются через провайдера и отражают ошибки синхронизации. Не показывать несуществующие рабочие кнопки." (Task actions are recorded through the provider and show sync errors. Do not show buttons that do not work.) The spec makes Linear the source of truth; `plan.md` later reversed that (internal list is the source of truth). Treat the spec as stale on that point. No keyboard section.

`apps/desktop/AGENTS.md` (typography and structure): "**Typography:** the chrome's body text is 13px (`base.css` sets it); do not set 16px in a feature." Screen owners: "A stored selection can name something that is gone: fall back to the first item." (Agents implements this with `settleSelection`; Tasks does not.)

`packages/components/AGENTS.md`: "List row actions (rename, overflow menu) stay hidden until the row is hovered. Put `data-show={listBoxItemDataShow.itemHover}` on the control." Relevant to where an in-row shortcut hint could live. It also states `Autocomplete`: "Enter -> `useAutocompleteEnterAction` (RAC often skips ListBox `onAction`)".

### How tests are written today

Config:

- `apps/desktop/vitest.config.ts`: default environment `node`, include `src/**/*.test.{ts,tsx}`; DOM tests put `// @vitest-environment happy-dom` on line 1. No Babel plugin, no setup file, no Testing Library, no jsdom. `bun run test` at the root runs `turbo run test` (never bare `bun test`; the daemon is the exception and uses `bun test`).
- `packages/components/vitest.config.ts`: adds `vite-plugin-babel` with `@babel/preset-typescript` and `@babel/plugin-proposal-decorators` (2023-05), and also includes `scripts/**/*.test.ts`. This is the only place MobX decorators parse in Vitest.
- Versions: vitest 5.1.0, happy-dom 21.0.4, React 19.3.1.

DOM test pattern (`features/chats/Composer.test.tsx`, `features/settings/AppearancePage.test.tsx`):

- `(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;`, a container appended to `document.body`, `createRoot(container)`, render inside `act(() => root.render(...))`, unmount in `afterEach`.
- Wrap in `RootStoreProvider value={ { command } as unknown as RootStore }` with `command = vi.fn(async input => result)` to capture the commands sent. This is how Composer tests assert `{ type: 'chat.send', chatId, text }`.
- Keys: `await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) })`. `AppearancePage.test.tsx` shows the same for Enter and Space with a plain `act`.
- Typing into a controlled textarea: set the value through the native prototype setter and dispatch `input` (`type()` helper in `Composer.test.tsx`).
- Mocking the design system: `vi.mock('@clowdy/components/Select', () => ({ Select: () => null }))` with the comment "The design system's Select cannot be loaded by Vitest (its Input does not parse there)". Inference: the cause is `Input` → `useRunner` → `lib/hotkeys.ts` decorators under a config without Babel; not reproduced. A hotkey layer test in the desktop package must therefore avoid importing `Input`-based components, or mock them, or the desktop config must gain the decorators plugin.
- Time: `vi.useFakeTimers()` plus `await vi.advanceTimersByTimeAsync(0)` in the store and transport tests.

Pure logic tests: `features/tasks/taskView.test.ts` (task factory helper, `filterTasks`, `dependencyCandidates`, `startBlockedReason`, and so on), `features/chats/composerKeys.test.ts` (`isSendKey` with `isComposing`), `features/agents/agentTree.test.ts`, `features/docs/*.test.ts`. Their style is: small data factories, no DOM, table-like `expect` calls. A hotkey layer written as pure functions (key event data in, action out) would test the same way, including IME and modifier cases, as `composerKeys.test.ts` does with a `KeyPress` interface instead of a DOM event.

Store and transport tests: `stores/UiStore.test.ts` (in-memory `KeyValueStorage`, persistence per project, damaged storage), `stores/ProjectState.test.ts` (`FixtureTransport({ data })`, `applyEvent`), `stores/RootStore.test.ts` (`new RootStore(new FixtureTransport(), { storage })`, `overrideTransport` from `daemon/testing.ts` to stub methods), `daemon/fixtureTransport.test.ts` (commands emit events). These can assert the full command-to-event-to-state chain for status changes without a daemon.

Components package: `RichInput/composerKeymap.test.ts` builds its own happy-dom `Window` (`withDom`) and drives a ProseMirror editor with `new KeyboardEvent('keydown', { key: 'Enter', ... })`; `MarkdownEditor.test.tsx` calls `editor.view.someProp('handleKeyDown', ...)`; `CodeInput.test.tsx` dispatches keydown and keyup inside `act`; `SettingsLayout.test.tsx` renders with a fake `ModalContext` (it has no test for its Mod+S window handler: searched for `keydown` and `metaKey`, none). `List/useScrollActiveListItem.test.tsx` renders the real RAC `Autocomplete` + `ListBox` under happy-dom, which shows RAC collections do render in this environment from the components package (inference: they would in the desktop package if the Babel config were shared).

Reforma's pattern (sibling repo): mock the hotkey registry module and assert registered handlers by name (`editor-hotkeys.test.ts`), including `shouldPrevent` and the excluded selector list. It tests the registrations as data, not the DOM path.

Daemon tests (`bun test`, `apps/daemon/test/`) already cover `task.create`, `task.update`, and `task.delete` through a real harness (`startHarness`, `h.ok('task.create', ...)`), and `fake-engine.test.ts` covers tasks moved by runs. A new task command (for example priority) would add tests there.

### Checking the UI without a person

From `apps/desktop/AGENTS.md`:

- `bun scripts/screenshot.ts --url <url> --out <png> [--width 1440] [--height 900] [--wait-for <css selector>] [--eval <js>]... [--delay <ms>] [--theme light|dark|system] [--overlay] [--logs]` loads a hidden Electron window with its own temp profile and no preload, runs each `--eval` in the page in order, waits, saves a PNG, and prints page console errors. Exit code 1 means the page logged errors; 2 means a failed load, an empty capture, or the 30 s timeout. Look at the PNG with the Read tool. `scripts/shoot-main.cjs` runs `webContents.executeJavaScript` for each `--eval`; it does not call `sendInputEvent`, so keys can only be dispatched as synthetic DOM events (`isTrusted: false`). Native default actions and IME do not apply to them. Inference from reading the script.
- A dev server for it: `CLOWDY_RENDERER_PORT=5300 CLOWDY_VITE_CACHE_DIR=<dir> node ../../node_modules/vite/bin/vite.js --config vite.config.ts` from `apps/desktop`; then `--url 'http://127.0.0.1:5300/?fixtures=static'`. In dev the page exposes `window.__clowdy.root` (the `RootStore`) for `--eval` (`renderer/root.ts`).
- Fixtures route: `?fixtures` (timed events on) or `?fixtures=static`, plus the URL preselection `section`, `task`, `run`, `chat`, `doc`, `finished`, `view` read by `initialUiFromSearch`. The fixture project "Car Rental" (prefix `CAR`) has 11 tasks across Backlog, To do, In progress, Review, Done, Canceled, with dependencies, a linked-to-Linear task (`t-30`), and runs on several tasks; `FixtureTransport` implements `task.create|update|delete|start` in memory and emits `task.upserted` events.
- Real daemon check: start `apps/daemon` on a temp `CLOWDY_DATA_DIR` with `CLOWDY_ENGINE=fake`, a fixed `CLOWDY_PORT` and `CLOWDY_TOKEN`, and open `?daemon=http://127.0.0.1:<port>&token=<token>`.
- What a person must still check: real keyboard focus, IME, platform differences (nothing was run on Windows), and menu accelerators.

### What would be reused to test a hotkey layer

- `// @vitest-environment happy-dom` + `createRoot` + `act` + `RootStoreProvider` with a `command` spy (Composer test pattern), and `KeyboardEvent` dispatch for key flows.
- `FixtureTransport` + `RootStore` (`stores/RootStore.test.ts` pattern) to run a task command and see `ProjectState.tasks` change after the event, and `UiStore` with an in-memory storage for selection and view assertions.
- The `task()` factory in `taskView.test.ts` for building tasks, and the pure-function style of `composerKeys.test.ts` for "key event in, action out" and IME guards.
- `vi.mock` of the design-system modules that cannot load under the desktop config, or a Babel plugin addition to `apps/desktop/vitest.config.ts` (which would also let the real `Input` and the engine in `lib/hotkeys.ts` load; decision for the plan).
- The screenshot script with the fixtures URL for visual states (help overlay, command menu, focus ring on the board and list), and `--eval` to dispatch events or to read `window.__clowdy.root`.
- Reforma's registration-level test pattern if the engine is reused as is.
- Missing today and worth noting for the plan: no test uses the real RAC `Table` or `Select` from the desktop package, no test for `Modal.create` (it needs `document.body` and a separate React root), none for `Hotkey`/`hotkeysToSymbols`, `Menu`, `Tooltip`, `Table`, or `Select` (the components package has 17 test files and none of those), no test for the window-level Mod+S handlers, and no end-to-end Electron test (the AGENTS.md verify step for the shell is a CDP walkthrough).

## Relevant files

- `/Users/bionic/WORK/My/@kachurun/clowdy/DESIGN.md` — focus, density, hover, Linear-chrome rejection, modal float
- `/Users/bionic/WORK/My/@kachurun/clowdy/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/components/AGENTS.md` — conventions, the UI-check procedure, component rules
- `.briefback/mvp/plan.md` — decisions: internal tasks, Linear out of scope, one task one chat
- `.briefback/mvp/ui-wireframes.md` — the Tasks wireframe description
- `.briefback/mvp/research/ui-inventory.md` — component mapping, hotkey hint pattern
- `.briefback/mvp/stage-5-6-notes.md` — "Start on a Done task" note
- git history `5cb724f:spec.md` (untracked since `9c9d743`) — spec, section 5.4
- `apps/desktop/vitest.config.ts`, `packages/components/vitest.config.ts` — test configs
- `apps/desktop/src/renderer/features/chats/Composer.test.tsx`, `composerKeys.test.ts` — DOM test and pure key test
- `apps/desktop/src/renderer/features/settings/AppearancePage.test.tsx` — key events with `act`
- `apps/desktop/src/renderer/features/tasks/taskView.test.ts` — pure tasks helpers and the task factory
- `apps/desktop/src/renderer/stores/UiStore.test.ts`, `ProjectState.test.ts`, `RootStore.test.ts`; `daemon/fixtureTransport.test.ts`, `daemon/testing.ts` — store and transport tests
- `packages/components/src/RichInput/composerKeymap.test.ts`, `MarkdownEditor/MarkdownEditor.test.tsx`, `CodeInput/CodeInput.test.tsx`, `SettingsLayout/SettingsLayout.test.tsx`, `List/useScrollActiveListItem.test.tsx` — component key tests
- `apps/desktop/scripts/screenshot.ts`, `scripts/shoot-main.cjs` — screenshot harness
- `apps/desktop/src/renderer/daemon/fixtureData.ts`, `fixtureTransport.ts`, `daemon/config.ts`; `stores/UiStore.ts#initialUiFromSearch` — fixtures and URL preselection
- `apps/daemon/test/` (`helpers.ts`, `fake-engine.test.ts`) — daemon test harness
- `/Users/bionic/WORK/Reforma/reforma/apps/front/src/specs/editor/editor-hotkeys.test.ts` — sibling registration-level test

## Constraints and gotchas

1. Do not treat DESIGN.md's Linear line as a ban on Linear-style behavior without asking: it speaks of "chrome" and navigation pills. Focus styling rules are explicit (one Terracotta focus per region), which affects how a keyboard cursor on a board card or list row should look; the existing card focus ring (`box-shadow` of `--color-primary-muted-border`) and selected border (`--color-primary`) already use primary for both selection and focus.
2. The spec's "no non-working buttons" applies to hints too: a shortcut hint on an action that is unavailable (Start on a Done task, Start while a run is active) would contradict it.
3. The product spec file is not in the tree; `AGENTS.md` still points to it. Any reference to "spec §..." in `.briefback` docs resolves only through git history.
4. Desktop Vitest cannot load the design-system `Input` today; decide how to deal with it before writing a hotkey test that renders real screens.
5. Synthetic key events in the screenshot harness and in happy-dom are untrusted and skip native behavior, so IME composition and menu-accelerator ordering cannot be verified that way.
6. The fixture daemon accepts any status id and has Backlog; the real daemon has five statuses and validates ids.
7. `bun run test` (Turbo) runs `^build` first for each package; a test run needs built workspace packages (inference from `turbo.json`; not run).

## Open questions

- Does the owner want Linear's keyboard behavior only (keys, menus, help) while keeping Clowdy's visual language, as the "Don't clone Linear chrome" rule suggests? DESIGN.md does not say.
- Is a command menu a "modal float" (DESIGN.md's only large radius and shadow surface) or a lighter popover? DESIGN.md has no popover-level palette guidance.
- Where should the spec of record for shortcuts live (the plan, `DESIGN.md`, a new doc)? No convention exists.
- Should the keyboard cursor and the open task share one visual (today both use the primary border) or differ as in the neutral outline for the variable cards?
- Should the desktop Vitest config gain the decorators plugin so real design-system components can run in tests?

## Assumptions and limits

- Read: `DESIGN.md` (grep plus the density, elevation, navigation, and Do/Don't sections), `.briefback/mvp/plan.md` (first 60 and last 60 lines), `ui-wireframes.md` (Tasks and overrides sections), `ui-inventory.md` (the Tasks and shared rows), `stage-5-6-notes.md` (grep), `AGENTS.md` files, the test files named above, the two Vitest configs, `screenshot.ts` (header) and `shoot-main.cjs` (eval loop), part of `fixtureData.ts`.
- Grepped but not read in full: `DESIGN.md` (318 lines), `plan.md` stages 2, 3, 7, 8, `system-skills.md`, the other research notes under `.briefback/mvp/research/`.
- The historical `spec.md` was searched for keyboard, shortcut, hotkey, command, palette, Linear, and Cmd terms; section 5.4 was read. It is in Russian and I translated the quoted sentence.
- Nothing was run: no test, no screenshot, no dev server. The cause of the `Input` loading problem in desktop Vitest is inferred.
- No CodeGraph index exists in this repo.
