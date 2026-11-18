# Building a Linear-grade hotkey system in React 19 + Electron + React Aria + MobX: options

Snapshot date: 2026-11-17. Versions and dates come from the npm registry and the GitHub API on that day. Sizes were measured here (see "Method"). Findings, not decisions.

## Summary

- A Linear-style system needs six things (derived from Part A, `linear-hotkeys.md`): a **command registry** that feeds menus, tooltips, help and palette; **single-key shortcuts with target resolution** (hover or highlight or selection or open item); **two-key chords** with pending-state feedback; a **context/scope stack** (modal over list over app); **guards** for text inputs, IME, AltGr and non-US layouts; and **display** of the same keys everywhere.
- React Aria already supplies the **inside-a-list** keys (arrows, Shift+arrows range select, Mod+A, Esc clears selection, type-ahead) and its own `useKeyboard({ shortcuts })`, but it has **no global registry, no sequences and no cross-component scope**. Type-ahead in collections competes with single-letter shortcuts.
- Of the key-engine libraries, only **TanStack Hotkeys** (beta, `0.x`) covers sequences, nested/exclusive scopes, IME, AltGr, layouts, input guarding, formatting, customisation and devtools in one package; it ships roughly 20 releases a month and removed a hook in `0.14.0`. **tinykeys** (about 1 KB gzip, `4.0.1`) covers sequences, `$mod`, IME, AltGraph and an input guard, and nothing else. **react-hotkeys-hook** (`5.4.0`) is React-idiomatic with flat scopes and `>` sequences but matches `event.code` by default and shows no IME guard. Mousetrap and hotkeys-js are `keyCode` era.
- In Electron, the **renderer `keydown`** is the right home for app shortcuts. **Menu accelerators** are for native menu display and OS-owned actions and, via role items, **reserve keys** (Clowdy's `menu.ts` uses reload, devtools, zoom, window roles). **`before-input-event`** is the first look at every key and can block both page and menu; **`globalShortcut`** is only for out-of-focus capture.
- Prior art converges on the same shape: stable command ids, keymap as data (default plus user override), `when`/scope contexts, chord state machine, and one source feeding every surface.

## Method

- npm metadata: `registry.npmjs.org` (latest, publish dates, deps, peers, unpacked size). GitHub metadata: `api.github.com` (last push, stars, open issues).
- Bundle size: installed each library in a scratch directory and ran `bun build --minify --target=browser` (Bun 1.4.4) on an entry exporting only the stated API, `react` and `react-dom` external, then `gzip -9`. These are indicative numbers for the exports named, not whole-package weights.
- Behaviour claims were checked in READMEs, official docs, or installed source (`tinykeys@4.0.1`, `react-hotkeys-hook@5.4.0`, `react-aria@3.53.1`, `react-aria-components@1.22.1`, `@codemirror/view` and `prosemirror-keymap` source on GitHub, Electron docs on `main`). I did not run any of this in a browser or in Electron.

## 1. What the system must do (from Part A)

| Need | Why (Linear evidence) |
| --- | --- |
| One registry feeding menu, tooltip, overlay, palette | Same actions in keys, command menu, right-click, bulk toolbar |
| Target resolution | Hover = highlight = target; selection overrides; open issue otherwise |
| Single keys plus chords | `P`, `L`, `A` versus `G I`, `O P`, `M B`; `C` versus `G C` must not collide |
| Pending-chord feedback | "Hints highlight whichever key is pressed" (2026-01-22) |
| Scope stack | Modal property keys; peek off while palette open; `Esc` semantics layered |
| Input guards | Create-issue key fired while adding members (fixed 2026-04-16); date fields (2024-08-08) |
| IME and layouts | Fixes in 2025-12, 2026-02, 2026-03, 2026-04, 2026-05 |
| Undo and toasts | Fast keys need cheap mistakes |
| Customisation | Not offered by Linear (official evidence); worth not precluding |

## 2. Library survey

### 2.1 tinykeys

- `4.0.1`, published 2026-09-25; repo pushed 2026-09-25; 4.1k stars; 7 open issues; MIT; ESM, ships `.d.mts`; requires Node `>=22` (engines). Earlier: `3.1.0` 2026-05-19, `4.0.0` 2026-05-20, so a major bump this year.
- API: `tinykeys(target, { 'g i': fn, '$mod+k': fn }, { timeout, ignore, event, capture })`, plus `createKeybindingsHandler`, `parseKeybinding`, `matchKeybindingPress`. No React binding; use in an effect.
- **Sequences**: space-separated presses, 1000 ms default `timeout`. Declaration-order priority: an earlier `g` binding shadows a later `g a`; `"g a"` before `"a"` means typing `g a` fires only the sequence. [README]
- **Matching**: `KeyboardEvent.key` or `KeyboardEvent.code` (case-insensitive), `$mod` = Meta on macOS and Control elsewhere, optional modifiers `[Shift]`, regex keys. README recommends `code` for letters with AltGr combos. If both a `key` and a `code` binding match, only the first fires.
- **Guards**: default `ignore` skips `event.repeat`, `event.isComposing`, and events whose target matches `[contenteditable],input,select,textarea` unless the target is the listener's own target. Extensible. AltGraph is normalised (`getModifierState` aliases). [source, dist/tinykeys.mjs]
- **Scopes/registry**: none. Scope = which element you bind to and when you unsubscribe.
- Size measured: about **1.0 KB gzip** (all exports).

### 2.2 react-hotkeys-hook

- `5.4.0`, published 2026-11-09; repo pushed 2026-11-16; 3.5k stars; 17 open issues; MIT; typed; peer `react >=16.8`. Repo also has docs at react-hotkeys-hook.vercel.app.
- API: `useHotkeys(keys, cb, options)`; `HotkeysProvider` with `initiallyActiveScopes`; `useHotkeysContext()` returns `hotkeys` list, `activeScopes`, `enableScope`/`disableScope`/`toggleScope`; `useRecordHotkeys`; `isHotkeyPressed`.
- **Sequences**: `'g>h>i'` with `sequenceSplitKey` and `sequenceTimeoutMs` (default 1000 ms per docs).
- **Matching**: from the shipped `dist/index.js`, matches `event.code` by default and `event.key` when `useKey: true`. The docs page I read states only that key strings are case-insensitive. The d.ts has `ignoreModifiers`, `splitKey`, `keydown`/`keyup`, `ignoreEventWhen`, `description`, `metadata`.
- **Guards**: `enableOnFormTags` (list of tags and roles), `enableOnContentEditable`. `AltGraph` appears once in dist; **no `isComposing` string in dist** (not found).
- **Scopes**: flat named scopes toggled from context, no nesting precedence. Per-hotkey `description` and `metadata` plus the context list can seed a help list.
- Size measured: about **2.8 KB gzip** (`useHotkeys` + `HotkeysProvider`).

### 2.3 TanStack Hotkeys (`@tanstack/hotkeys` and `@tanstack/react-hotkeys`)

- `@tanstack/react-hotkeys 0.27.0` and `@tanstack/hotkeys 0.32.0`, both published 2026-11-16. Repo created 2026-01-21, pushed 2026-11-16, 764 stars, 3 open issues, MIT. **Docs state it is beta and the API may change.** 54 versions of core and 57 of the React adapter since 2026-02-10; **20 releases in the 31 days before the snapshot**. Peer `react >=18`. Adapters exist for several frameworks.
- **Breaking-change evidence**: `useHotkeySequence`, `useHotkeySequences`, `useHotkeySequenceRecorder` were removed in `@tanstack/react-hotkeys v0.14.0`; sequences now go through `useHotkey`/`useHotkeys`. [docs: sequences]
- **Sequences**: arrays of chords, `timeout` 1000 ms default, each sequence tracks its own progress; a key that continues a sequence belongs to the sequence (`C` single versus `['G','C']`); `G` plus `['G','G']` run on the first and second press; progress exposed as `matchedStepCount` for a pending-keys UI; app hotkeys and the recorder report prefix conflicts. [docs: sequences]
- **Matching**: logical bindings (`Mod+S`, `?`) match `event.key`, with documented fallbacks to key position for non-Latin layouts, macOS Option dead keys, AZERTY digit row and Shift symbols; physical bindings `[KeyS]` match `event.code`. Modifiers match **exactly** (`K` does not fire for `Shift+K`; `Mod+Z` and `Mod+Shift+Z` coexist). Documented gotcha: Cmd+Shift+/ arrives as `/` with Shift, so write `Mod+Shift+/` for Cmd+?. [docs: sensible-defaults]
- **AltGr**: a character typed with AltGr matches only itself, never a `Control+Alt` shortcut; on Windows AltGr is reported as Control+Alt, so `Control+Alt` shortcuts fire there (documented), and the docs advise avoiding `Control+Alt` with letters on Windows. [docs: sensible-defaults]
- **IME**: while composing, no hotkey fires, including the Enter Safari sends after composition. **Input guard**: `ignoreInputs: 'auto'` ignores single keys and Shift/Alt chords in text fields, lets Control/Meta chords and `Escape` fire; also skips keys that focused ARIA widgets own (listbox arrows, menu typeahead, grid keys), which is directly relevant to React Aria collections. [docs]
- **Scopes**: `HotkeysProvider scope="..."`, nested scopes win, an **exclusive scope** suspends the rest (dialogs); scope follows the React tree including portals, `target` follows the DOM. Default `capture` is false, so hotkeys run **after** widget handlers; `ignoreDefaultPrevented` default false (hotkeys still fire when another listener prevented default). [docs: hotkeys-provider-and-scopes, sensible-defaults]
- **Registry and customisation**: `defineAppHotkeys({ 'task.status': { hotkey: 'S', meta: { name, group }, scope } })` declares id, default key, metadata and options without callbacks; users can rebind or unbind via `customHotkeys` and `onCustomHotkeysChange`; conflicts checked across declarations; `HotkeyRecorder` for a settings UI; `useHotkeyRegistrations()` for live registrations; formatting with `formatForDisplay` (`sequenceSeparator`), devtools panel. [docs: app-hotkeys, formatting-display]
- Accessibility note in docs: single-character shortcuts need an off switch, remap, or focus-only (WCAG 2.1.4).
- Size measured: about **12 KB gzip** for `useHotkey`, `useHotkeys`, `HotkeysProvider`, `defineAppHotkeys` (core included); about **15 KB** for the whole core `export *`.

### 2.4 @github/hotkey

- `3.1.4`, published 2026-03-16; pushed 2026-11-05; MIT; typed. Attribute-driven: `data-hotkey="g c"` on elements, trigger `click()` or `focus()`. Matches `event.key`; `Mod` modifier; two-key sequences where, after the prefix key (`g`), a single-key hotkey on the second key (`c`) is unavailable for 1500 ms, and a single `g` hotkey cannot coexist with `g c` (README). About **2.4 KB gzip**. Fits server-rendered pages more than a registry in a React store.

### 2.5 Mousetrap and hotkeys-js

- **Mousetrap** `1.6.5`, published 2020-01-23; repo last pushed 2023-03-15; 235 open issues; no bundled types. `e.which`/`keyCode` mapping, `mod` alias, sequences supported. About 2.7 KB gzip. Effectively unmaintained.
- **hotkeys-js** `4.1.2`, published 2026-11-06 (very active: four releases between 2026-11-02 and 2026-11-06); typed; README shows `keyCode` APIs, one active scope plus `all`, default filter skipping `INPUT`/`SELECT`/`TEXTAREA`; no sequence feature in the README. About 3.7 KB gzip.

### 2.6 cmdk (palette UI, no key binding)

- `1.1.1`, published 2025-03-14; repo pushed 2025-10-29; 13k stars; 86 open issues. Depends on Radix Dialog, Id, Primitive, Compose Refs. Peer `react ^18 || ^19`. Composable combobox/listbox: `Command`, `Command.Input`, `Command.List`, `Command.Item` with `keywords`, custom `filter`, `shouldFilter={false}` for your own ranking, `loop`. No shortcut model. About **18 KB gzip** (includes Radix Dialog primitives).

### 2.7 kbar (palette UI with an action model)

- `1.0.0`, published 2026-08-10 (first stable after betas); pushed 2026-08-10. Dependencies: `@tanstack/react-virtual`, `fuse.js`, `fast-equals`, Radix Portal. Actions carry `shortcut: ['g','h']`, `keywords`, `section`, `parent` (nested), `priority`, `perform`; it vendors a tinykeys copy for the toggle shortcut and `shortcutsMap` for action keys. About **35 KB gzip** for the main exports.

### 2.8 React Aria (already in the app)

- `react-aria 3.53.1` (2026-10-09), `react-aria-components 1.22.1` (2026-10-09). Docs moved to react-aria.adobe.com.
- **`useKeyboard`** supports `{ shortcuts: { 'Mod+s': handler } }`, `allowRepeats`, `allowComposing` (both default false), `isDisabled`. Matching is on `event.key` lower-cased with a modifier set (source); `Mod` is Meta on macOS and Control elsewhere. Handlers **stop propagation by default** unless the handler returns `true`/an object or calls `continuePropagation()`; a handler that returns nothing prevents default. Ignores events that reach it through a React portal. No sequences, no scopes, no registry, no global listener. [docs: useKeyboard; source `createKeyboardShortcutHandler.mjs`, `useKeyboard.mjs`]
- **Inference** from source: because matching is on lower-cased `event.key`, `Shift+1` would see `!` on a US layout; shifted symbols need care.
- **Collections** (`useSelectableCollection`, used by ListBox, GridList, Menu, Table): handlers built with `useKeyboard({ shortcuts })` for arrows, PageUp/Down, `Home`/`End`, `Mod+A` (select all when `selectionMode='multiple'` and not `disallowSelectAll`), `Escape` (clears selection only when something is selected and returns "not handled" otherwise, so an outer `Escape` handler still runs on an empty selection), `Tab`. Shift+arrow **extends** selection when multiple. Toggle behaviour: Space/Enter toggles; Ctrl (Windows) or Option (macOS) plus arrows moves focus without changing selection. [source, docs: selection]
- **Type-ahead is on by default** and can be turned off with `disallowTypeAhead` on `GridList` and `Table` (exposed in RAC `GridList.mjs` and `Table.mjs`); I did not find the prop on `ListBox` or `Menu` in 1.22.1. A printable-key shortcut (`S`, `P`, `L`) on a focused collection therefore competes with type-select. TanStack's guard table treats listbox/menu/tree typed characters as owned by the widget; that avoids the clash by not firing the hotkey.
- `useGridList` accepts `isVirtualized`, `keyboardDelegate`, `layoutDelegate` (source) so virtualized lists can plug in their own delegate.
- `useFilter` offers `startsWith`, `endsWith`, `contains` via `Intl.Collator` (source); no fuzzy ranking. The repo's own `Autocomplete` wrapper notes Enter needs `useAutocompleteEnterAction` because RAC "often skips ListBox `onAction`" (project `AGENTS.md`; not re-verified here).
- `Keyboard` in RAC is a display element, not a binder; `packages/components/src/Hotkey/Hotkey.tsx` wraps it.

### 2.9 Hand-rolled registry

Everything in section 4 plus the guards in the libraries above. Order-of-magnitude of the guard logic, from open source: tinykeys is about 200 lines; CodeMirror's and ProseMirror's keymap modules each contain key-name tables, a keyCode fallback and a Windows Ctrl+Alt guard. The libraries' own docs list the edge cases (AltGr, dead keys, AZERTY digit row, Dvorak, Turkish dotless i, Safari post-composition Enter, NumLock numpad, held-key repeat, stuck modifier after window switch).

## 3. Electron specifics

Electron in the repo is `45.2.1` (`apps/desktop/package.json`); latest on npm is `45.3.3` (2026-11-16).

| Mechanism | Where it runs | What it sees | Right for | Watch out |
| --- | --- | --- | --- | --- |
| Renderer `keydown` (capture or bubble) | Renderer | Every key that reaches the page; `key`, `code`, `isComposing`, `repeat` | App shortcuts, chords, context-aware keys | Menu accelerators and `before-input-event` may act first or in parallel; browser-reserved keys |
| Application menu accelerators | Main | Keys matched to menu items | Native menu bar, standard edit/window roles, key hints in menus on macOS | "Local" shortcut; fire even when hidden (Windows/Linux always; macOS unless `acceleratorWorksWhenHidden:false`); roles reserve keys; `registerAccelerator:false` (Windows/Linux) shows without binding |
| `webContents` `before-input-event` | Main | Every `keyDown`/`keyUp` **before** the page and before menu shortcuts: `key`, `code`, `isAutoRepeat`, `isComposing`, modifiers | Stealing a key from menu or page; shortcuts that must work regardless of renderer state | `preventDefault()` blocks page events and menu shortcuts; renderer must be told via IPC; `setIgnoreMenuShortcuts` blocks only menus |
| `globalShortcut` | Main | OS-wide, app unfocused | Quick-capture hotkeys | Silently fails if another app owns the key; macOS bug with non-QWERTY layouts (documented, electron/electron#19747); Wayland uses a portal |

Sources: Electron docs on `main`: `tutorial/keyboard-shortcuts.md`, `api/web-contents.md`, `api/menu-item.md`, `api/global-shortcut.md`, `api/base-window.md`.

- **Menu accelerators fire in parallel with the page and can conflict.** The docs state that `before-input-event` fires before page `keydown`/`keyup` and before menu shortcuts. They do **not** document the order between page `keydown` and menu accelerators, and my search found nothing authoritative; treat "which one wins when both match" as unverified and test on both OSes.
- **Reserved by role**: Electron docs say `label` and `accelerator` default to platform values when a `role` is used. Clowdy's `createAppMenu()` includes `appMenu` (macOS) or `fileMenu`, `editMenu`, `viewMenu` with reload, forceReload, toggleDevTools, zoom and fullscreen, and `windowMenu`. Windows hides the menu bar behind the custom title bar so "only the shortcuts matter there" (comment in `apps/desktop/src/main/menu.ts`). Effect: whatever accelerators those roles carry stay live. The default accelerator values (Cmd/Ctrl+R, Shift+R, I, 0, +/-, W, M, Q) are general Electron knowledge and not listed in the docs pages I fetched; verify against the running app.
- **Windows**: `Ctrl` replaces `Cmd`, `Alt` replaces `Option`. `win.autoHideMenuBar` makes a single `Alt` press show the menu bar on Windows/Linux (docs). AltGr arrives as Ctrl+Alt on Windows, so `Ctrl+Alt+letter` shortcuts can collide with typed characters on layouts with AltGr (TanStack docs; CodeMirror and ProseMirror source both special-case it).
- **macOS**: Option changes the typed character (`Option+S` types `ß`); Cmd+Shift+/ reports `/` with Shift, so a "show shortcuts" binding needs `Mod+Shift+/` for Cmd+? and `Mod+/` is a separate key. [TanStack docs]
- **Renderer-first is simplest**: the renderer already receives `key` and `code`; the main process only needs `before-input-event` for keys that must beat the menu or page.
- **Mirror to native menus** (keys shown in the menu bar): requires the registry in main or an IPC sync; a menu item with `registerAccelerator:false` (Windows/Linux) displays a key without binding it; on macOS there is no equivalent in the docs I read. Linear's desktop app is Electron too (changelog 2019-10-08: "Upgraded to Electron 6") and uses an in-app command menu and overlay for key display; whether it mirrors native menus is not documented.
- **Key-event reliability in editors**: both ProseMirror (TipTap's engine; `@tiptap/pm` is imported in `packages/components/src/RichInput/composerKeymap.ts`) and CodeMirror 6 handle `keydown` on their own contenteditable and `preventDefault` when a binding runs. They match by `event.key` with a `keyCode` fallback when a modifier is held, skip the fallback for Windows Ctrl+Alt (AltGr) and for Alt combos on macOS, and use `Mod-`. CodeMirror also supports **multi-stroke** bindings written with spaces. [source: `@codemirror/view` `keymap.ts`, `prosemirror-keymap` `keymap.ts`] A document-level hotkey layer therefore sees events **after** the editor has acted and possibly prevented them; whether it should react depends on its `ignoreDefaultPrevented` setting (TanStack default: hotkeys still fire) and on guarding contenteditable targets (tinykeys default: ignored). The repo's `composerKeymap.ts` already checks `event.isComposing` for Enter.
- Existing app-owned chords in editors (bold, link, code) are `Mod` chords. A global `Mod` hotkey (for example an app-level undo) would fire in text fields under TanStack's default (`Control`/`Meta` chords fire in inputs) and can shadow editor undo; Linear resolves the same type of clash by focus context (Cmd+Shift+C is inline code in the editor and copy-URL elsewhere, changelog 2023-03-10).

## 4. Prior-art design patterns that fit

### 4.1 Central command registry

Shape seen across VS Code, TanStack app hotkeys, kbar, cmdk and Linear's command menu:

```ts
type Command = {
  id: string;            // stable; keymap overrides and saved settings key on it
  title: string;
  group: string;         // palette section and help section
  keywords?: string[];   // palette ranking (cmdk, kbar)
  keys?: Keys | null;    // default binding: chord or sequence; null = palette only
  when?: Context;        // scope or context expression (VS Code "when", TanStack scope)
  target?: 'item' | 'selection' | 'view' | 'global'; // what the command acts on
  run: (ctx: Ctx) => void;
};
```

- Surfaces read from it: key display in tooltips (`tooltipWithHotkey` exists), menu rows, shortcut overlay, palette rows, settings. TanStack docs make the same argument: cheat sheets built from mounted registrations miss unmounted routes, so declarations should be separate from callbacks.
- VS Code: `keybindings.json` rules `{ key, command, when, args }`, evaluated bottom to top, first match on key and `when` wins, user rules appended after defaults, `-command` removes a default, chords are `"ctrl+k ctrl+c"`. Scan-code bindings like `[KeyA]` ignore layout. [code.visualstudio.com/docs/configure/keybindings, page shows 11/11/2026]

### 4.2 Keymap as data

Keep `defaults` (shipped) and `overrides` (user) as JSON-serialisable objects keyed by command id; compute the effective map; render help and palette from the effective map; detect conflicts when building it. TanStack's `customHotkeys` and VS Code's rule list are both this. The existing `Hotkey` display takes a string or a string array and splits strings on `+`, `_`, whitespace.

### 4.3 Focus-scope stack

Linear evidence: palette disables peek, modal accepts property keys, `Esc` clears selection first and then navigates. TanStack: nested scopes win, an exclusive scope suspends others. React Aria: overlays manage focus; its `Escape` in a collection returns "not handled" on an empty selection, so an outer handler can take it. A stack of scope ids (app, view, list, overlay) with `exclusive` flags is the common denominator.

### 4.4 Chord state machine

States: idle, pending(prefix, deadline). Rules visible in the libraries: next key within the timeout (1000 ms in tinykeys, TanStack, react-hotkeys-hook; 1500 ms in @github/hotkey) advances; a non-continuing key resets and, if it is a first step, starts a new attempt; modifier-only presses do not reset; a key that continues a sequence belongs to the sequence rather than to a single-key binding; holding a key is not a second press; first step decides whether the sequence is allowed inside text inputs. Expose pending state (observable) for a hint HUD, as Linear's "hints highlight whichever key is pressed" and TanStack's `matchedStepCount` suggest.

### 4.5 Target resolution

Not provided by any library. Linear's rule (selection, else highlighted, else open item) needs app state: hovered id, keyboard-focused id, selected ids, plus input modality so pointer movement does not steal a keyboard-driven cursor (React Aria exposes interaction modality). In MobX terms (inference): a small `UiFocus` store with observable ids, derived `targets`, read by command `run`.

### 4.6 Display and teaching

One formatter turns the canonical key string into symbols per platform (TanStack `formatForDisplay`, repo `hotkeysToSymbols`). Observations on the repo's component: `HotkeyValue = string | readonly string[]`; array entries render joined by a space, so a chord `['mod','k']` and a sequence `['g','i']` look alike; `meta` renders as `Ctrl` on Windows; no separator concept for "then"; names `mod`, `cmd`, `alt`, `shift`, `ctrl`, `enter`, `backspace`, arrows are mapped. Sequence display needs a separator decision.

## 5. Comparison table

Key engines (can bind keys). Facts are from section 2; "n/f" = not found in the sources I read.

| | tinykeys 4.0.1 | react-hotkeys-hook 5.4.0 | TanStack Hotkeys 0.27/0.32 (beta) | React Aria `useKeyboard` | @github/hotkey 3.1.4 | Mousetrap 1.6.5 | hotkeys-js 4.1.2 | Hand-rolled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Last release | 2026-09-25 | 2026-11-09 | 2026-11-16 (20 in 31 days) | 2026-10-09 (react-aria) | 2026-03-16 | 2020-01-23 | 2026-11-06 | n/a |
| Sequences | yes, 1000 ms | yes (`>`), 1000 ms | yes, 1000 ms, progress state | no | yes (`g n`), 1500 ms | yes | not in README | build |
| Scope / context | none (element + unsubscribe) | flat named scopes via provider | nested scopes, exclusive scope, per-target | DOM subtree only | DOM attribute | none | one active scope + `all` | build |
| Matches | `key` or `code` | `code` default, `useKey` for `key` | logical `key` with layout fallbacks; physical `[Code]` | `key` lower-cased | `key` | `keyCode`/`which` | `keyCode` | choose |
| Non-US layouts | `code` bindings; README guidance | `code` default is layout-independent for position, not for typed character | documented fallbacks (non-Latin, Option, AZERTY, Dvorak, Turkish) | layout-dependent `key` | `key` | weak | weak | build |
| AltGr | AltGraph aliases | `AltGraph` string present | documented | n/f | n/f | n/f | n/f | build |
| IME | skips `isComposing` | n/f in dist | skips during composition | `allowComposing` default false | n/f | n/f | n/f | build |
| Input guard | default ignore of contenteditable/form targets, configurable | `enableOnFormTags`, `enableOnContentEditable` | `ignoreInputs: 'auto'`, widget-key awareness | n/a (element-scoped) | focuses/clicks target | default filter | default filter | build |
| `Mod` | `$mod` | `mod` | `Mod` | `Mod` | `Mod` | `mod` | n/f | build |
| Registry / data for help | none | `description`, `metadata`, context list | `defineAppHotkeys`, registrations, recorder, formatting, devtools | none | attribute scan | none | `getAllKeyCodes` | build |
| TS quality | typed, string keys | typed options, string keys | template-literal typed keys, module augmentation for ids | typed, string keys | typed | no bundled types | typed | yours |
| React 19 | framework-agnostic | peer `>=16.8` | peer `>=18` | peer includes 19 | framework-agnostic | n/a | n/a | yes |
| Size, min+gzip (measured) | 1.0 KB | 2.8 KB | 12 KB (15 KB full core) | already bundled | 2.4 KB | 2.7 KB | 3.7 KB | project code |
| Maintenance | active | active | very active, pre-1.0 | active (Adobe) | active, slower | stale | very active | yours |

Palette UIs (no key binding engine of their own except where noted):

| | RAC `Autocomplete` + `Menu`/`ListBox` in `Modal` | cmdk 1.1.1 | kbar 1.0.0 |
| --- | --- | --- | --- |
| Already in repo | yes (design-system `Autocomplete`, `Select showSearch`) | no | no |
| Last release | with react-aria 2026-10-09 | 2025-03-14 | 2026-08-10 |
| Action model | none; you supply items | none; items with `keywords` | yes: `shortcut`, `keywords`, `section`, `parent`, `priority` |
| Filtering | `useFilter` (contains/startsWith, no fuzzy) | built-in ranker or `shouldFilter={false}` | Fuse.js |
| Size (gzip, measured) | already bundled | 18 KB | 35 KB |
| A11y / theming | consistent with app components | Radix-based, own styling | own animator and components |

## 6. Options that fit best (findings, with tradeoffs)

### Option A: TanStack Hotkeys as the engine, with an app-level command table and React Aria for in-list keys

- **Covers out of the box**: sequences with pending state, nested and exclusive scopes, IME, AltGr and layout handling, input and widget-key guards, display formatting, customisation, recorder, conflict checks, devtools. `defineAppHotkeys` is close to the registry shape in 4.1 and 4.2.
- **Costs**: beta and `0.x` with a visible churn rate (20 releases in a month, a hook removed in `0.14.0`); pinning and an upgrade budget are needed. About 12 to 15 KB gzip. Its scope model follows the React tree and must be reconciled with RAC overlays and the repo's modals. It does not resolve targets, show a palette, or handle undo; those stay app code. Default `Mod`-chords-fire-in-inputs needs per-command review against editors.
- **Fit with the repo**: peer `react >=18` includes 19; keys already use `mod`-style names the `Hotkey` component understands; sequence display needs a separator decision.

### Option B: tinykeys plus a small in-repo registry, scope stack and chord HUD (MobX-backed)

- **Covers**: sequences, `$mod`, `key`/`code`, AltGraph, IME and repeat skip, default input guard, about 1 KB.
- **Costs**: you build the registry, scope precedence, pending-chord state, conflict detection, formatting hook-ups and customisation. Its priority rule is declaration order, so a shared dispatcher with its own priority is advisable (the prefix-versus-single-key collision is documented in its README). It binds to an element, so one document-level binding with an in-app dispatcher is the natural use.
- **Fit**: smallest dependency surface, stable matching code; most of Option A's features become project code.

### Option C: Hand-rolled dispatcher on top of React Aria `useKeyboard` for local keys and one document listener for global ones

- **Covers**: exact control of target resolution, MobX state, Electron IPC, hover rules and chord feedback, no third-party churn; React Aria already supplies list navigation and shortcuts-with-propagation semantics.
- **Costs**: you own layout, AltGr, IME, dead-key, held-key and stuck-modifier handling and their tests. The open-source docs enumerate roughly a dozen such cases. React Aria `useKeyboard` has no sequences, no scopes and matches lower-cased `event.key`, so global concerns still need a separate listener.
- **Fit**: most flexible; highest correctness risk and the largest test surface.

**Also seen, weaker fit for this app**: react-hotkeys-hook (React-idiomatic, flat scopes, `code`-default matching, no IME guard found) is a reasonable smaller alternative to A if sequences and rebinding are not needed early; Mousetrap and hotkeys-js are `keyCode`-era; @github/hotkey is attribute-driven; cmdk and kbar are palette UIs, not key engines.

**Palette**: the repo already has RAC `Autocomplete` and `Select showSearch`; a command palette on those avoids a new dependency and styling island but has no fuzzy ranker and must handle Enter via `useAutocompleteEnterAction`. cmdk adds a ranker and a small API at about 18 KB gzip; kbar brings its own action model at about 35 KB.

## Sources (accessed 2026-11-17)

npm registry metadata: https://registry.npmjs.org/ for `tinykeys`, `react-hotkeys-hook`, `@tanstack/react-hotkeys`, `@tanstack/hotkeys`, `@github/hotkey`, `mousetrap`, `hotkeys-js`, `cmdk`, `kbar`, `react-aria`, `react-aria-components`, `@react-aria/interactions`, `electron`.
GitHub API: `jamiebuilds/tinykeys`, `JohannesKlauss/react-hotkeys-hook`, `TanStack/hotkeys`, `pacocoursey/cmdk`, `timc1/kbar`, `jaywcjlove/hotkeys-js`, `ccampbell/mousetrap`, `github/hotkey`.
Docs and READMEs:
- TanStack Hotkeys: https://tanstack.com/hotkeys/latest/docs/overview and repo docs at https://github.com/TanStack/hotkeys/tree/main/docs (`guides/sensible-defaults.md`, `framework/react/guides/sequences.md`, `hotkeys-provider-and-scopes.md`, `app-hotkeys.md`).
- tinykeys README (installed `4.0.1`): https://github.com/jamiebuilds/tinykeys
- react-hotkeys-hook docs: https://react-hotkeys-hook.vercel.app/docs/documentation/useHotkeys/basic-usage and shipped typings `5.4.0`.
- React Aria: https://react-aria.adobe.com/useKeyboard, https://react-aria.adobe.com/selection, and source of `react-aria@3.53.1` (`useKeyboard.mjs`, `createKeyboardShortcutHandler.mjs`, `useSelectableCollection.mjs`, `useFilter.mjs`) and `react-aria-components@1.22.1`.
- Electron: https://github.com/electron/electron/tree/main/docs (`tutorial/keyboard-shortcuts.md`, `api/web-contents.md`, `api/menu-item.md`, `api/global-shortcut.md`, `api/base-window.md`, `tutorial/menus.md`).
- CodeMirror view keymap source: https://github.com/codemirror/view/blob/main/src/keymap.ts; ProseMirror: https://github.com/ProseMirror/prosemirror-keymap/blob/master/src/keymap.ts
- VS Code keybindings: https://code.visualstudio.com/docs/configure/keybindings
- cmdk and kbar READMEs (installed `cmdk 1.1.1`, `kbar 1.0.0`); Mousetrap and hotkeys-js packages as installed.
- Repo files read: `packages/components/src/Hotkey/Hotkey.tsx`, `hotkeysToSymbols.ts`, `apps/desktop/src/main/menu.ts`, `packages/components/src/RichInput/composerKeymap.ts` (header), `AGENTS.md`, `packages/components/AGENTS.md`.

## Open questions

1. Order of precedence between a renderer `keydown` handler and a native menu accelerator on macOS versus Windows in Electron 45 (not documented; needs a quick experiment).
2. Whether RAC `ListBox` and `Menu` expose a way to disable type-ahead (only `GridList` and `Table` found).
3. TanStack Hotkeys stability: whether a pre-1.0 pin is acceptable, and how its scope model interacts with RAC `Modal`/`Popover` focus handling.
4. Whether keys must also appear in native menus, which decides if the registry needs to exist in the main process.
5. How the existing task list is built (RAC `GridList`, `Table`, or custom rows); that decides how much of the in-list keyboard model comes for free. The parent's `current-*.md` notes cover it.
6. Target of "hover as focus": whether pointer hover should set shortcut target in a RAC collection that tracks its own focus.

## Assumptions and limits

- Library numbers are a 2026-11-17 snapshot; TanStack Hotkeys changes almost daily.
- Sizes are for specific exports with Bun's bundler, not production-tuned; Radix and Fuse are included where they are hard dependencies.
- I did not execute any library in a browser or Electron. Behaviour for non-US layouts, IME, AltGr and menu-versus-page order is taken from documentation and source reading, not from tests.
- `docs.tiptap.dev` and the TipTap keyboard-shortcut API were not fetched; the TipTap statement rests on ProseMirror source plus the repo importing `@tiptap/pm`.
- `react-hotkeys-hook` docs index pages were partially unreadable in the fetcher; its option list comes from the shipped type declarations.
- Several web fetches were summarised by a small model; where it mattered (Linear, TanStack, tinykeys, React Aria, Electron) I read primary text or source directly.
