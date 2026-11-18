# Native menu accelerators versus page `keydown`: what wins, what the role menu owns, and a manual probe

Research for Stage 2 of the task hotkeys plan. Nothing here was run: no app was started and no key was injected into the desktop. Every claim says where it comes from. Sources were read on 2026-11-17. "Documented" means an Electron docs page says it. "Source" means Electron or Chromium code read at the named ref. "Undocumented" means neither a docs page nor a maintainer statement covers it, so it is an inference from code or a gap, and the probe at the end settles it.

## Headline

1. Electron's docs do not say whether a menu accelerator or the page's `keydown` goes first, on any platform. The keyboard-shortcuts tutorial and the `MenuItem` page are silent on the order. Undocumented.
2. Electron's source, at the exact tag Clowdy pins (`v45.2.1`), implements the menu as the receiver of keyboard events the page did not handle. On Windows, Linux and macOS the menu runs in `WebContents::HandleKeyboardEvent`, which Chromium documents as "unhandled keyboard messages coming back from the renderer". So the page sees the key first, and a `preventDefault()` on `keydown` stops the menu item. This matches the only macOS bug report on the subject (electron/electron#11116, 2017, closed upstream): a `window` `keydown` listener that called `preventDefault()` stopped a menu item with a Space accelerator from firing. Source-derived, not behavior-verified.
3. The Clowdy dispatcher claims keys with `preventDefault()` in the capture phase, so for `Cmd/Ctrl+A` and `Cmd/Ctrl+Z` the page should win whenever a command takes the key. In text fields the dispatcher takes nothing, so the Edit menu's Select All and Undo keep working there. No change to `menu.ts` is needed on this reading. If the probe contradicts it, the remedies are listed per chord below.
4. `MenuItem.registerAccelerator: false` is Windows and Linux only (documented). On macOS it does nothing: the menu controller sets the key equivalent from the accelerator unconditionally (source), and the 2019 report was closed "wontfix" (#18295).
5. A correction to the brief's list: Clowdy's macOS menu has no `Cmd+W`. `role: 'appMenu'` has no Close item and the macOS Window menu is minimize, zoom, front. Only Windows and Linux get `Ctrl+W` (the Window menu's `close`).

## Sources

| Source | Date read | What it says |
| --- | --- | --- |
| Electron docs, `docs/api/menu-item.md` (main) | 2026-11-17 | `registerAccelerator`: "(Linux and Windows only) If false, the accelerator won't be registered with the system, but it will still be displayed. Defaults to true." `acceleratorWorksWhenHidden` (macOS only): default true, and "accelerators always work when items are hidden on Windows and Linux." Silent on order versus page key events and on role accelerators. |
| Electron docs, `docs/tutorial/keyboard-shortcuts.md` (main) | 2026-11-17 | "Local keyboard shortcuts are triggered only when the application is focused." Names `acceleratorWorksWhenHidden: false` (macOS) and `registerAccelerator: false` (Windows, Linux) as the opt-outs. `before-input-event` "is emitted before dispatching `keydown` and `keyup` events in the renderer process." Silent on menu versus page `keydown`. |
| Electron docs, `docs/api/web-contents.md` (main) | 2026-11-17 | `before-input-event`: emitted before the page's `keydown`/`keyup`; `event.preventDefault()` "will prevent the page keydown/keyup events and the menu shortcuts"; `input` has `key`, `code`, `isAutoRepeat`, `isComposing`, `shift`, `control`, `alt`, `meta`. `contents.setIgnoreMenuShortcuts(ignore)`: "Ignore application menu shortcuts while this web contents is focused." No platform notes. |
| Electron source at tag `v45.2.1` (the version in `apps/desktop/package.json`): `shell/browser/api/electron_api_web_contents.cc` | 2026-11-17 | `PreHandleKeyboardEvent` emits `before-input-event` and returns HANDLED when it was prevented. `HandleKeyboardEvent` (the unhandled-events path) calls `PlatformHandleKeyboardEvent`, which returns early when `ShouldIgnoreMenuShortcutsFor(source)`. Non-macOS: hands the event to `owner_window()->HandleKeyboardEvent`. |
| Same tag, `shell/browser/api/electron_api_web_contents_mac.mm` | 2026-11-17 | macOS: for a `keyDown` that reached this path, `[[NSApp mainMenu] performKeyEquivalent:ns_event]`. Its comment says a key that is a system shortcut was "already sent to the NSMenu" earlier. |
| Same tag, `shell/browser/native_window_views.cc` | 2026-11-17 | Windows and Linux: `NativeWindowViews::HandleKeyboardEvent` passes the event to the Views keyboard handler and focus manager, which run the menu accelerators. |
| Same tag, `shell/browser/api/electron_api_menu_roles.cc` (identical to `main`, diffed) | 2026-11-17 | The role table: default accelerators, `register_accelerator`, `non_native_mac`, the default `editMenu`, `viewMenu`, `windowMenu` contents, and what each role does on Windows and Linux (`wc->Undo()`, `wc->SelectAll()`, `Reload()`, `window->Close()`, ...). "macOS handles all roles natively except for these" (reload, forceReload, toggleDevTools, resetZoom, zoomIn, zoomOut, toggleSpellChecker). |
| Electron `main`, `shell/browser/ui/cocoa/electron_menu_controller.mm` | 2026-11-17 | macOS sets `item.keyEquivalent` and the modifier mask from the accelerator with no check of `registerAccelerator`; it sets `allowsKeyEquivalentWhenHidden` from `WorksWhenHidden`. |
| Chromium `main`, `content/public/browser/web_contents_delegate.h` | 2026-11-17 | `PreHandleKeyboardEvent`: "Allows delegates to handle keyboard events before sending to the renderer." `HandleKeyboardEvent`: "Allows delegates to handle unhandled keyboard messages coming back from the renderer." Chromium `main` is newer than the Chromium inside Electron 45; the contract is long-standing but this exact revision is not what ships. |
| Chromium `main`, `content/app_shim_remote_cocoa/render_widget_host_view_cocoa.mm` | 2026-11-17 | `performKeyEquivalent:`: "Command key combinations are sent via performKeyEquivalent rather than keyDown:. We just forward this on and if WebCore doesn't want to handle it, we let the WebContentsView figure out how to reinject it." Events "reserved by the system" skip the renderer. Another comment: "web pages are allowed to hijack keyboard shortcuts". |
| electron/electron#11116, "preventDefault() in render thread will also cause propagation to stop" (opened 2017-11-14, Electron 1.7.9, macOS 10.12.6, closed 2018-01-23 as an upstream issue) | 2026-11-17 | A `window` `keydown` listener calling `preventDefault()` stopped a Space-accelerator menu item from firing. Evidence that on macOS a prevented page `keydown` keeps the menu quiet. Old Electron; the code path above still reads the same. |
| electron/electron#19279, "preventDefault on webContents before-input-event also prevents menu accelerators" (2019-07-16, closed) | 2026-11-17 | A maintainer called it expected: `before-input-event` runs before the menu and blocks it. The workaround offered was to call the item's `click` from the handler. |
| electron/electron#18295, "MenuItem registerAccelerator does not work" (2019-05-14, macOS, closed wontfix 2019-06-24) | 2026-11-17 | On macOS, setting the accelerator both fires it and shows its label, and `NSMenuItem` has no way to split the two. The property is documented as Linux and Windows only since then (clarified again by PR #53172, merged 2026-08-26). |
| Reforma commit `d77bc0607` (2026-11-12), `apps/desktop/src/main.ts` | 2026-11-17 | Reforma left Reload and Close Window out of its menu so the web layer can use `Cmd+R`, and kept Force Reload. The message does not claim the page wins; it removed the items to be safe. |

## What the Clowdy role menu owns

`apps/desktop/src/main/menu.ts` builds: macOS `appMenu`, `editMenu`, a custom `viewMenu` (reload, forceReload, toggleDevTools, resetZoom, zoomIn, zoomOut, togglefullscreen), `windowMenu`. Windows and Linux use `fileMenu` instead of `appMenu`. Accelerators below are the role defaults from the `v45.2.1` role table. No item sets its own `accelerator`, and `before-input-event` is not used anywhere in `apps/desktop/src/main`.

| Chord (macOS / Windows) | Role | Notes |
| --- | --- | --- |
| `Cmd+Z` / `Ctrl+Z` | `undo` | Native selector on macOS; `wc->Undo()` on Windows and Linux. `registerAccelerator` true. |
| `Shift+Cmd+Z` / `Ctrl+Y` | `redo` | Windows redo is `Ctrl+Y`, not `Ctrl+Shift+Z`. |
| `Cmd+X`, `Cmd+C`, `Cmd+V`, `Opt+Shift+Cmd+V` / `Ctrl+X`, `Ctrl+C`, `Ctrl+V`, `Ctrl+Shift+V` | `cut`, `copy`, `paste`, `pasteAndMatchStyle` | The role table sets `register_accelerator = false` for these four, so on Windows and Linux the page's native handling owns them. On macOS the key equivalent is set regardless. |
| `Cmd+A` / `Ctrl+A` | `selectAll` | Native selector on macOS; `wc->SelectAll()` on Windows and Linux. `registerAccelerator` true. |
| `Cmd+R` / `Ctrl+R` | `reload` | Run by Electron on every platform (`non_native_mac`). |
| `Shift+Cmd+R` / `Ctrl+Shift+R` | `forceReload` | |
| `Opt+Cmd+I` / `Ctrl+Shift+I` | `toggleDevTools` | |
| `Cmd+0`, `Cmd+Plus`, `Cmd+-` / `Ctrl+0`, `Ctrl+Plus`, `Ctrl+-` | `resetZoom`, `zoomIn`, `zoomOut` | |
| `Ctrl+Cmd+F` / `F11` | `togglefullscreen` | |
| `Cmd+M` / `Ctrl+M` | `minimize` | In `windowMenu` on both. |
| `Cmd+Q` (macOS only), `Ctrl+Q` (Linux only) | `quit` | Windows `quit` has no accelerator. In `appMenu` on macOS, in `fileMenu` elsewhere. |
| `Cmd+H`, `Opt+Cmd+H` (macOS only) | `hide`, `hideOthers` | In `appMenu`. |
| none / `Ctrl+W` | `close` | In the Window menu on Windows and Linux only. macOS has no Close item in this menu, so `Cmd+W` is unowned there. Check in the probe. |

The brief listed `Cmd/Ctrl+W` for both platforms; the table above corrects it.

## Which plan chords collide, and what each finding says

The keymap table in `plan.md` binds these chords with a modifier. Only two are owned by a role.

| Plan chord | Stage | Owned by | Does the page see it? | Who wins on the source reading | Remedy |
| --- | --- | --- | --- | --- | --- |
| `$mod+a` (`tasks.select.all`) | 4 | `selectAll` on both platforms | Yes, first (source). Undocumented in the docs. | The page, when the dispatcher claims the key and calls `preventDefault()`. In a text field the dispatcher takes nothing, so the menu's Select All runs there. | None needed on this reading. Keep the command off in text targets (the guard already does). If the probe shows the menu fires anyway: Windows, set `registerAccelerator: false` on an explicit `selectAll` item (documented, Windows and Linux only); then Blink's own `Ctrl+A` in editable fields applies (inference). macOS: `registerAccelerator` does nothing; use `before-input-event` with `setIgnoreMenuShortcuts` for this chord only (below), or replace the role with a plain item with no accelerator and confirm text fields still select all. Do not remove the item on macOS: macOS text fields rely on the menu's `selectAll:` (inference, as Chromium without an Edit menu loses `Cmd+A/C/V`). |
| `$mod+z` (`tasks.undo`) | 7 | `undo` on both platforms | Same as above | The page, when claimed outside text fields; in text fields the menu's Undo runs, which is what a person typing expects. | Same as above. The toast Undo button needs no key. If the probe says the menu wins on a platform, Stage 7 ships the toast path and records the `menu.ts` follow-up, as the plan already says. `Shift+$mod+z` is redo on macOS; the plan does not bind it. |
| `$mod+b` (`tasks.view.toggle`) | 6 | none (Electron has no role on `Cmd+B`) | Yes | The page; nothing competes. In the chat composer and the docs editor `Cmd+B` is a TipTap bold key, and the dispatcher takes nothing in a text target. | None. |
| `$mod+.` (`tasks.copy.key`) | 6 | none | Yes | The page. | None. On macOS `Cmd+.` is a system "cancel" convention in some dialogs, with no menu item behind it here. |
| `$mod+Enter`, `$mod+Backspace` (`Ctrl+Delete` on Windows), `$mod+/`, `$mod+Shift+'`, `Opt+Left/Right` (`Ctrl+Left/Right` on Windows) | 3 to 6 | none | Yes | The page. | None. These collide with nothing in the role menu. `Ctrl+Left/Right` on Windows and `Opt+Left/Right` on macOS are word jumps inside text fields, where the dispatcher stays out. |
| `$mod+k` | reserved | none | | | Stays unbound. |

The role menu also owns `Cmd/Ctrl+R`, `Shift+Cmd/Ctrl+R`, `Cmd/Ctrl+0/+/-`, `Cmd/Ctrl+M`, `Cmd+Q`, `Cmd+H`, `Opt+Cmd+H`, `Ctrl+W` (Windows) and the DevTools chord. The plan binds none of them, so they stay with the menu. Do not give a task command any of them.

## Remedies, in the order to try them

1. Nothing. On the source reading the page's `preventDefault()` already beats the menu, and the dispatcher does that for every command it claims.
2. Windows and Linux: an explicit role item with `registerAccelerator: false` (documented). The chord is still shown in the menu and no longer registered.
3. Any platform, one chord: in `webContents.on('before-input-event', ...)`, call `contents.setIgnoreMenuShortcuts(true)` for that chord and `false` for everything else. The flag is read on the unhandled-key path (`PlatformHandleKeyboardEvent` returns false when it is set, on macOS and elsewhere), so a key the page leaves alone no longer reaches the menu. The docs' own example toggles the flag from the `control` and `meta` fields of `input`. Calling `event.preventDefault()` in that handler instead blocks the page as well and is the wrong tool (#19279). Undocumented: on macOS, whether Chromium's own re-dispatch of an unhandled `Cmd` chord still reaches `NSMenu` after this flag turns Electron's menu call off. Test it before relying on it.
4. Remove the role item, as Reforma did for Reload and Close. Not for the Edit roles on macOS (see the `$mod+a` row). Reasonable for `reload` and `close`.
5. macOS has no per-item switch to keep the label and drop the binding (#18295, wontfix). A role item cannot show a key it does not bind there.

## Two-minute manual probe

Run it yourself on each platform. It needs a dev run (`./clowdy dev`), no repo edit and nothing committed. It logs from the page and reads the effect of the native menu. Use a real keyboard, with the Clowdy window focused and nothing else typing.

Open DevTools (`Opt+Cmd+I` on macOS, `Ctrl+Shift+I` on Windows). Paste this into the Console and press Enter:

```js
window.__probe = { prevent: false };
addEventListener('keydown', (e) => {
    if (!e.metaKey && !e.ctrlKey) return;
    console.log(`keydown key=${e.key} meta=${e.metaKey} ctrl=${e.ctrlKey} shift=${e.shiftKey} prevent=${__probe.prevent}`);
    if (__probe.prevent) e.preventDefault();
}, true);
addEventListener('pagehide', () => sessionStorage.setItem('probe', `page unloaded at ${new Date().toISOString()}`));
```

Then click an empty area of the page (so no text field has focus) and press each chord twice. Run the first pass with `__probe.prevent = false`, then set `__probe.prevent = true` in the Console and run the second pass. Click an empty area again after typing in the Console.

| Chord to press (macOS / Windows) | Menu effect to look for with `prevent = false` | Same chord with `prevent = true` |
| --- | --- | --- |
| `Cmd+A` / `Ctrl+A` | Page text becomes selected (`getSelection().toString().length` in the Console is above 0, or you see the highlight). | Selection stays empty. |
| `Cmd+R` / `Ctrl+R` | The window reloads. Afterwards read `sessionStorage.probe`; it names the unload time. Paste the snippet again. | No reload. |
| `Cmd+M` / `Ctrl+M` | The window minimizes. Restore it. | The window stays. |
| `Cmd+Z` / `Ctrl+Z` | Open the Chats section, click the composer, type `abc`, press the chord: the text shrinks or disappears. | Text stays. Press `Cmd/Ctrl+Z` once more with `prevent = false` to confirm undo works at all. |
| `Cmd+W` (macOS) | Nothing should happen: the menu has no Close item. If the window closes, the menu owns it after all. | |
| `Ctrl+W` (Windows) | The window closes and the app quits. Do this last. | The window stays. |

How to read each row:

- keydown line printed, effect happens with `prevent = false`, effect does not happen with `prevent = true`: the page goes first and wins when it claims the key. This is the source reading. No change to `menu.ts`.
- keydown line printed, and the effect happens even with `prevent = true`: the menu fires in parallel. Use remedy 2 (Windows) or 3 (macOS) for that chord and report which one.
- No keydown line printed, effect happens: the menu consumed the key before the page. Same remedies, and `Cmd/Ctrl+Z` in Stage 7 then relies on the toast.
- No keydown line and no effect: the chord belongs to something else (the OS or the keyboard layout). Note the chord.

Optional second step, needs a temporary local edit that you do not commit: in `apps/desktop/src/main/index.ts`, log `before-input-event` (`input.type`, `input.key`, `input.meta`, `input.control`) with `console.log` for the same chords and compare its timestamps with the page's. Per the docs it fires before both. It tells you nothing about page versus menu, so skip it unless a row above is confusing.

Write the result in `plan.md` Stage 7 ("The probe outcome for Cmd/Ctrl+Z is noted here when the user reports it") and, if any row shows the menu winning, as a `menu.ts` follow-up.

## Not verified

- No Electron docs page states the order of menu accelerators and page `keydown`. The ordering above is read from Electron `v45.2.1` and Chromium `main` source plus one 2017 macOS report; it was not run. Chromium `main` is newer than the Chromium bundled with Electron 45.
- Whether Blink handles `Ctrl+A` and `Ctrl+Z` in editable fields by itself on Windows when the accelerator is not registered: inference from the role table's `register_accelerator = false` for `cut`, `copy` and `paste` only.
- Whether macOS text fields still get Select All and Undo if the Edit role items lose their key equivalents: inference.
- macOS keys reserved by the system (for example `Cmd+Space`, `Cmd+Tab`) skip the page (Chromium source). The plan binds none of them.
- Nothing has been run on Windows by the agent. Linux follows the Windows code path and is not a target.
