# Native application menu and external links

## Summary

There is a native menu, built in one pure function (`createAppMenu` in `apps/desktop/src/main/menu.ts`), with no Help menu. A "Star Clowdy on GitHub" item is a small change there, and it needs no renderer round trip because main can call `shell.openExternal` itself, as `openReleasePage` already does. It would be a shell change (OTA waits for a shell release), visible only on macOS in practice, and absent in a development run if it is gated on the baked repo. The renderer cannot ask main to open a URL by IPC, but any `https:` anchor with `target="_blank"` or `window.open(url, '_blank')` already opens the system browser, at most once a second.

## The menu today

- `createAppMenu({ checkForUpdates }?)` returns `Menu.buildFromTemplate(template)`. Template: macOS `appMenu` (About, optional "Check for Updates…", Services, Hide…, Quit); other platforms `fileMenu` (optional "Check for Updates…", separator, Quit); then Edit (with Find, Find Next, Find Previous, which have ids `find`, `find-next`, `find-previous` and `CmdOrCtrl+F/G/Shift+G`; on macOS also Speech); View (reload, force reload, DevTools, `resetZoom` on `CmdOrCtrl+Alt+0`, zoom, fullscreen); `role: 'windowMenu'`.
- The doc comment says it is "Electron's default menu without its Help entry (it links to Electron's own site)". No `help` role exists today.
- It is set twice in `src/main/index.ts`: at the top of `app.whenReady()` as `createAppMenu()` (before `releaseConfig` is computed), and again in `startUpdates` with `checkForUpdates` only when a shell updater or OTA exists. So in a dev run the menu is the first one, with no update item, and `release.repo` is not yet known at the first call: a repo-gated item needs `releaseConfig` computed first, or the second call to be unconditional.
- Windows: the comment in `menu.ts` says the menu bar is hidden behind the custom title bar (`titleBarStyle: 'hidden'` with an overlay; no `autoHideMenuBar` or `setMenuBarVisibility` anywhere in `src/main`), so only the accelerators matter. That includes the Windows "Check for Updates…", which sits in the File menu. A Help item is effectively macOS only. Not verified on Windows.
- Menu items reach the renderer by IPC only for Find: `sendFind` does `webContents.send(IPC_CHANNELS.findCommand, 'open' | 'next' | 'previous')`; the preload `onFindCommand` validates the string; `src/renderer/shell/FindBar.tsx` subscribes. The renderer's hotkey registry (`src/renderer/hotkeys`, `shell/shellCommands.ts`, `keymap.ts`) is separate: its commands run on keyboard events inside the page, not from the native menu. Nothing in the menu calls into it, and the menu has no "Settings…" item (Settings opens from the rail button, `Cmd+,`, or `?`).
- Tests: `src/main/menu.test.ts` mocks `electron` with only `Menu.buildFromTemplate` (returns the template array) and `BrowserWindow`, and finds items by `id`. New items should follow that: an `id`, an injected callback (as `checkForUpdates` is injected) so the test does not need `shell`.

## Where "Star Clowdy on GitHub" would go

- Add `{ role: 'help', submenu: [...] }` after `windowMenu` (the usual last position on macOS; on macOS the `help` role also adds the system search field). It could hold "Star Clowdy on GitHub" and, optionally, "Clowdy on GitHub", release notes, "Keyboard shortcuts" (the renderer command `help.open` exists but is not in the native menu).
- Gate: `release.repo` (empty in dev, in `package` builds without `CLOWDY_RELEASE_REPO`). Without the gate the item must be hidden or disabled in dev; with it, a dev run should have no Help menu at all (leave the whole role out when it has no items rather than show an empty one).
- Click handler in main: `shell.openExternal('https://github.com/<repo>')`. This path does not pass `lockNavigation` and is not throttled; `openReleasePage` in `startUpdates` is the existing precedent for a main-initiated open with a fixed URL.
- If the menu click should also dismiss the card ("never again once clicked"), main must tell the renderer, because the card's flag lives in the renderer's `localStorage` (see `agent-list-and-card-trigger.md`). The channel pattern is `webContents.send` to every window plus a preload `on…` and a `DesktopBridge` member, exactly like `updateReady`. Otherwise the card stays after a menu click.
- "Star" is a GitHub action done on the website: the app can only open `https://github.com/<repo>`. There is no API call (it would need a token).
- Naming per platform is open: macOS Help conventions, Windows File or Help. Both go through the same function and `process.platform` is already read there (`mac`).

## Opening external URLs today

- `src/main/security.ts`: `lockNavigation(contents, trustedOrigin, openExternal)` is wired for every web contents in `index.ts` (`app.on('web-contents-created')`, `openExternal = url => void shell.openExternal(url)`).
  - `will-navigate` to a non-trusted URL: `https:` goes to `openOutside`, anything else (`http:`, `mailto:`, `file:`) is denied.
  - `setWindowOpenHandler` does the same and always returns `deny`, so no new window is ever created.
  - `openOutside` keeps `lastExternalOpen` per web contents on a monotonic clock (`performance.now()`) and drops a second open within `EXTERNAL_OPEN_INTERVAL_MS` (1000 ms). A second click within a second is silently ignored.
  - `will-attach-webview` is prevented.
- Renderer ways to open a link, all through the above:
  - `<Button href=… target="_blank" rel="noreferrer">` (the design system `Button`): `features/settings/projects/ProjectFolders.tsx` (`RemoteButton`: "Open in GitHub", with the `Github` icon), `features/settings/providers/Account.tsx` (sign-in link, guarded by `url.startsWith('https://')`), `features/tasks/DetailPanel.tsx`.
  - Markdown links: `stream/markdown/components/Link.tsx` renders only `https:` links as buttons (`opensInBrowser`), anything else as plain text.
  - `window.open(url, '_blank', 'noopener')`: `features/openWith/openApps.ts` (`openEffects.openUrl`), terminal links in `features/terminal/TerminalView.ts`.
- There is no bridge call to open a URL (`DesktopBridge` has `openPath` for local files only; main's `openWith` uses `shell.openPath`, not `openExternal`).
- The renderer's CSP (`src/main/protocol.ts`, `CONTENT_SECURITY_POLICY`) does not block anchors. Its `img-src` is `'self' data: blob:`: a remote image (a GitHub star badge, an avatar) cannot load, so the card and the page must use local icons.
- Opening a local file (for example a license file) is `shell.openPath` in main, with the path chosen in main. The renderer must not pass a path (see `third-party-notices.md`).

## Constraints

- The menu, an IPC action, and any bridge member are shell code (`SHELL_PATHS`): they ship with a shell release, not OTA.
- The one-second throttle is per web contents and shared by every external link; two quick presses on two different links lose the second.
- macOS `role: 'about'` and `app.setAboutPanelOptions` (`index.ts`) already give a native About panel (`version: 'Bundle N'`). Electron's `credits` option works on macOS and Windows; `website` is Linux only (`node_modules/electron/electron.d.ts`, `AboutPanelOptionsOptions`). A custom About page in Settings would not replace it unless the About menu item is rewired to open Settings (no main to renderer channel for opening a Settings page exists).

## Relevant files

- `apps/desktop/src/main/menu.ts`, `menu.test.ts` — the menu and its test
- `apps/desktop/src/main/index.ts` — both `Menu.setApplicationMenu` calls, `startUpdates` (`openReleasePage`), `web-contents-created` hook
- `apps/desktop/src/main/security.ts`, `security.test.ts` — `lockNavigation`, `navigationDecision`, the 1 s throttle
- `apps/desktop/src/shared/bridge.ts` (`IPC_CHANNELS.findCommand`, `FindCommand`), `src/preload/index.ts` (`onFindCommand`)
- `apps/desktop/src/renderer/shell/FindBar.tsx` — the menu-to-renderer consumer

## Open questions

- Does a menu click count as "clicked" for the card (needs a main to renderer message)?
- One item or two ("Clowdy on GitHub" and "Star Clowdy on GitHub")? Which platform label?
- Should the Windows menu bar stay hidden, making the item macOS only, or should Windows get another entry point (the About page already covers it)?

## Assumptions and limits

- Not run: the menu on Windows or macOS (no UI session); the claims come from the code and its comments.
- Electron 45.2.1 (`apps/desktop/package.json`); `role: 'help'` behavior on macOS is from Electron's documented roles, not tried here.
