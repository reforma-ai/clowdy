# Clowdy Desktop (`@clowdy/desktop`)

The Electron app: main process, preload, and the React + Vite renderer. The renderer is only a client of the daemon (`apps/daemon`, contract in `packages/protocol`). Run commands from the repository root with `./clowdy`, or from this folder with Bun.

## Layout

```
src/main/        Main process: window, menu, security, app:// protocol, IPC, finding or starting the daemon
src/preload/     The bridge exposed as `window.desktop`
src/shared/      Contract between main, preload, and renderer (bridge type, IPC channel names)
src/renderer/    React app (index.html, main.tsx), served by Vite; see "The renderer" below
scripts/         dev.ts, build.ts, main-bundle.ts, screenshot.ts (+ shoot-main.cjs)
vite.config.ts   Renderer build and dev server
vitest.config.ts Unit tests (`src/**/*.test.{ts,tsx}`; node by default, `// @vitest-environment happy-dom` per file)
electron-builder.ts, build/   Packaging config, icon, macOS entitlements
```

## Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Builds the workspace packages (Turbo), starts the Vite dev server for the renderer, bundles main and preload, and starts Electron on it. Renderer edits hot-replace; a change under `src/main`, `src/preload`, or `src/shared` restarts the app, and after a crash the next such save starts it again. Quitting the app ends the session. Arguments go to Electron. `CLOWDY_RENDERER_PORT` (default 5273) moves the dev server; a taken port stops the run with a message. |
| `bun run test` | Vitest: the stores, the transports (SSE parsing, reconnect, command retries), the fixture daemon, the stream helpers. |
| `bun scripts/screenshot.ts --url <url> --out <png>` | Loads a page in a hidden Electron window and saves a PNG; see "Checking the UI without a person". |
| `bun run build:app` | Release build into `app/`: the renderer (`app/renderer`), main and preload (`app/dist`), and the packaged app's own `package.json`. |
| `bun run package` | `build:app`, then an unpacked `Clowdy.app` with an ad-hoc signature, which runs only on the Mac that built it: `release/mac-arm64/` on Apple silicon, `release/mac/` on Intel. Needs a Mac. |
| `bun run package:win` | `build:app`, then unpacked, unsigned apps in `release/win-unpacked/` (x64) and `release/win-arm64-unpacked/`. Works on any OS. |

## How it fits together

- **Dev:** the window loads `CLOWDY_RENDERER_URL` (the Vite server). A packaged app ignores it. The origin the window trusts for navigation, permissions, and IPC is that URL's origin in dev and `app://clowdy` when packaged.
- **Packaged:** `src/main/protocol.ts` serves `app/renderer` from `app://clowdy` with a CSP header. `app.getAppPath()` is the root of `app/`, so the preload is `dist/preload/index.cjs` and the renderer `renderer/`.
- **Window chrome:** `src/main/security.ts` (`windowChrome`) gives macOS `vibrancy: 'under-window'` and Windows 11 22H2+ Mica, with a 48px hidden title bar and a clear background. The preload reports the material to the page (`window.desktop.material`); `src/renderer/windowChrome.ts` mirrors the window controls onto `<html>` (`data-window-material`, `data-window-buttons-leading`), and `base.css` reads them for the drag region and the tinted body.
- **Theme:** `src/renderer/theme.ts` applies the appearance chosen in Settings (system, light, dark; kept in `localStorage`) as `.dark` on `<html>`. `window.desktop.setThemeSource` sets `nativeTheme.themeSource`, so the native material matches a forced light or dark page. On Windows main recolors the caption button symbols when the appearance changes. The tokens are scoped by `:root, .light` and `.dark`, so any element can carry either class to show its subtree in that theme whichever one the app is in; Settings > Appearance uses it to draw the theme previews from the real tokens.

## The renderer

`src/renderer/` is a client of the daemon and nothing more; it never reaches past the protocol.

```
daemon/     Transport interface; HttpTransport (fetch + SSE over a stream reader), FixtureTransport (a daemon in memory), config resolution
stores/     MobX stores (RootStore, ProjectState, StreamStore, UiStore), run tree, hooks
shell/      Window layout: title band, project select, rail, outlet, empty and error states, project dialogs
features/   One folder per section (chats, tasks, agents, docs) exporting `Screen`; settings is global (its Skills section, `settings/skills/`, lists the daemon's skill catalog and switches the user's own skills)
stream/     StreamView and the pieces a run's stream is made of (shared by Chats and Agents)
shared/     RunStatusPill, StatusDot, TaskChip, AgentChip, time helpers
root.ts     The one RootStore; starts loading on import
```

- **Where data comes from** (`daemon/config.ts`): `window.desktop.daemon`, else `?daemon=<url>&token=<token>`, else `?fixtures` (scripted data in memory; `?fixtures=static` leaves out the timed events, which suits screenshots), else a "Cannot reach the daemon" screen with Retry.
- **Data flow:** `RootStore.load()` fetches the root snapshot and follows the one event feed from its cursor. Events go to the project that owns them (`ProjectState.applyEvent`, applied only past that project's snapshot cursor) or, for `stream.item`, to the opened streams. A dropped feed reconnects with 0.5 s to 10 s backoff and resumes from the last cursor; HTTP 410 reloads every snapshot and follows again. The banner "Can't reach the daemon. Retrying…" shows after 3 s of failure and never when healthy.
- **Commands:** `root.command(input)` never throws; an unreachable daemon is an `unavailable` result. The transport makes the `requestId` once per call and keeps it across its own retries.
- **For screen owners:** read state with `useProjectState()` (chats, tasks, runs, `tasksByStatus`, `runTree(showFinished)`, `runsOfTask`, `tasksOfRun`, `tasksOfChat`, `chatsOfTask`, `linksOfRun`, `lastDocsChange`, `artifactsRevision`), UI state with `useProjectUi()` (section and selections, remembered per project; change them through its methods, `openTask`, `openRun`, `openChat`, `openDoc`, `setTasksView`, `setShowFinished`), a run's items with `useRunStream(runId)` or `useChatStream(chat)`. Fetch the rest through `useRootStore().transport` (`getTaskDetail`, `getDocsTree`, `getDocFile`). Screens render only while a project is selected and loaded. A stored selection can name something that is gone: fall back to the first item.
- **No `observer()`:** `babel-plugin-observing-components` wraps every component (capitalized function with JSX) in the renderer. MobX 7 has no `observable.ref`; use `observableRef` and `observableShallow` in `makeAutoObservable` overrides.
- **Tool calls** in a stream are shown from whatever the engine reports (`stream/toolView.ts`): Claude Code's tool names and inputs are recognised, other tools fall back to their name. Edit tools show `+N −M` from `output.added/removed` or from the `old_string`/`new_string` of the input.
- **Typography:** the chrome's body text is 13px (`base.css` sets it); do not set 16px in a feature.

## Daemon

The app starts or attaches to the standalone daemon (`apps/daemon`, a Bun process) and gives its address to the renderer. It never stops it: the daemon keeps running when the app quits or restarts (dev restarts Electron on every main change), and stopping it is the person's decision.

- **Data folder:** `daemonDataDir` (`packages/protocol/src/paths.ts`, pure) is used by the daemon (`apps/daemon/src/config.ts`) and by the app, so the app finds `<data dir>/daemon.json` without asking. macOS `~/Library/Application Support/Clowdy/daemon`, Windows `%LOCALAPPDATA%\Clowdy\daemon`, Linux `~/.local/share/clowdy/daemon`; `CLOWDY_PROFILE=dev` (set by `bun run dev`) uses `Clowdy Dev` / `clowdy-dev`; `CLOWDY_DATA_DIR` overrides everything. `src/main/dataDir.test.ts` checks that both sides agree. The daemon writes `daemon.json` (pid, port, token, protocol), `daemon.lock`, `clowdy.db`, and the app appends the daemon's output to `daemon.log` there.
- **Start-up (`src/main/daemon.ts`, `ensureDaemon`)**, before the window opens: read `daemon.json`, `GET /v1/health` (plain `node:http` to 127.0.0.1 with an 800 ms timeout, so proxies play no part), and attach when the health answer names the same pid and protocol major. Otherwise start `$CLOWDY_BUN $CLOWDY_DAEMON_ENTRY` detached (own session, `unref()`, stdio to `daemon.log`, `windowsHide`) with the daemon's folder as cwd, and wait up to 15 s for a healthy `daemon.json`. Two apps starting together end with one daemon: the daemon's own lock makes the loser exit, and the loser then attaches to the winner (it waits 3 s for it). A running daemon of another protocol major is not attached and not replaced: the dialog says to stop it.
- **Environment of the child:** the app's own, minus `ELECTRON_*` and `CHROME_DESKTOP`, with `CLOWDY_DATA_DIR` pinned to the folder the app computed. When the app was started from Finder (a PATH of only `/usr/bin:/bin:/usr/sbin:/sbin`), PATH comes from the login shell, `$SHELL -ilc 'printf %s "$PATH"'` with a 3 s timeout, cached; if that fails the app's PATH stays. Agents inherit it, so they find git, node, and the user's toolchain.
- **Failure:** `ensureDaemon` throws `DaemonError`; main logs it, opens the window anyway, and shows a native sheet with the message and the last 20 lines of `daemon.log`. The renderer then shows its "Cannot reach the daemon" screen because `window.desktop.daemon` is unset.
- **Handing it to the renderer:** the preload calls `ipcRenderer.sendSync('desktop:get-daemon')` and sets `window.desktop.daemon = { url: 'http://127.0.0.1:<port>', token }` before the page's scripts run (the token is not in argv). Main answers only the app's own top-level frame (`isTrustedSender`), everyone else gets `null`. It re-reads `daemon.json` and probes on every page load, never starts a daemon there, so reloading the window finds a daemon the person restarted (new port and token), and finds none quickly when it is gone. A daemon that died while the app runs is started again only by the next app start. The "Cannot reach the daemon" screen's Retry reloads the window in the desktop app (the address is handed over only at load), so it finds a daemon that came up or moved since.
- **CORS:** the daemon allows the origins `app://clowdy` and `http://127.0.0.1:<any port>` (`apps/daemon/src/http/guard.ts`) and the headers `Authorization`, `Content-Type`, `x-clowdy-protocol`, `Last-Event-ID`; the CSP's `connect-src` allows `http://127.0.0.1:*`. Checked from a page on `app://clowdy` (with the app's CSP) and from the dev server's origin.
- **Dev:** `scripts/dev.ts` sets `CLOWDY_PROFILE=dev`, `CLOWDY_BUN` (the Bun running the script), and `CLOWDY_DAEMON_ENTRY` (`apps/daemon/src/main.ts`) for Electron, and `CLOWDY_ENGINE` (`claude` unless set). The engine reaches only a daemon this run starts: one that is already running keeps its own (the script warns when `CLOWDY_ENGINE` is set and one is). Nothing watches the daemon's sources, so editing them (agents do) never restarts it; restart it by hand: `CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop` (or stop the process named by `pid` in `daemon.json`), then start the app again or run the daemon yourself and reload the window.
- **Standalone daemon:** `bun run --cwd apps/daemon start` (`dev` adds `--watch`, which restarts it on every edit; do not use it for the daemon you depend on) with the same `CLOWDY_DATA_DIR`/`CLOWDY_PROFILE` as the app, so the app attaches to it. Use another `CLOWDY_DATA_DIR` for a throwaway one.
- **Packaged app (not built yet):** `ensureDaemon` works unchanged when `CLOWDY_BUN` and `CLOWDY_DAEMON_ENTRY` are set, and shows "Daemon is not bundled in this build" when they are not. A packaged build would ship a `bun` executable and the daemon's sources in electron-builder `extraResources` (outside the ASAR, signed with the JIT entitlements Bun needs) and main would set the two variables from `process.resourcesPath` before `ensureDaemon`. Shipping the daemon as a `bun build --compile` binary instead (see `.briefback/mvp/research/daemon-runtime.md`) means launching it without an entry argument, which `ensureDaemon` does not do yet.

## Checking the UI without a person

`bun scripts/screenshot.ts --url <url> --out <png> [--width 1440] [--height 900] [--wait-for <css selector>] [--eval <js>]... [--delay <ms>] [--theme light|dark|system] [--overlay] [--logs]`

It opens a hidden Electron window (own temp profile, no single-instance lock, no preload, background throttling off), waits for the selector (default `#root > *`), runs each `--eval` in the page in order (an expression that returns a promise is awaited, wrap `await` code in an async IIFE; a returned value is printed), waits `--delay`, saves the PNG at device scale, and prints page console errors and warnings. Exit code 1 means the page logged errors, 2 a failed load, an empty capture, or the 30 s timeout. `--overlay` gives the window the hidden title bar and its window controls overlay, as on this OS, so `--titlebar-inset` has the real values (the controls themselves are not in a capture). Look at the PNG with the Read tool.

A dev server for it: `CLOWDY_RENDERER_PORT=5300 CLOWDY_VITE_CACHE_DIR=<dir> node ../../node_modules/vite/bin/vite.js --config vite.config.ts` from this folder; `CLOWDY_VITE_CACHE_DIR` gives each concurrent Vite its own dependency cache. Then, for example, `--url 'http://127.0.0.1:5300/?fixtures=static'`. In dev the page exposes `window.__clowdy.root` (the `RootStore`) for `--eval`. To check against a real daemon, start `apps/daemon` on a temp `CLOWDY_DATA_DIR` with `CLOWDY_ENGINE=fake` and a fixed `CLOWDY_PORT` and `CLOWDY_TOKEN`, and use `?daemon=http://127.0.0.1:<port>&token=<token>`.

## Security invariants

- The renderer is untrusted: context isolation, process sandbox, no Node, no webviews. Every permission is denied except clipboard writes from the app's own top-level page.
- Navigation stays on the trusted origin; `https:` links open in the system browser, at most one a second.
- Every IPC call is checked against the sender frame (`assertTrustedSender`). Keep the bridge minimal: domain logic goes through the daemon's versioned contract, not Electron IPC.
- A packaged app refuses to start with command-line switches (`-x`, and `/x` on Windows), and one instance runs at a time.
- Fuses in `electron-builder.ts` turn off `runAsNode`, `NODE_OPTIONS`, and inspect arguments, and require the app to load from the ASAR.

## Traps

- `Bun.build` inlines `__dirname` as the source directory. Build paths from `app.getAppPath()`.
- `URL.origin` is the string `"null"` for the custom `app:` scheme. Compare origins with `originOf` in `security.ts`.
- `ELECTRON_RUN_AS_NODE` (set by VS Code's extension host, for one) starts Electron as plain Node. `scripts/dev.ts` removes it; unset it yourself when launching a binary by hand. The daemon's child environment drops it too.
- An unparented `dialog.showMessageBox` on macOS stalls the main process's event loop (remote debugging included) until it is dismissed; show dialogs as a sheet on a window, like `showDaemonError`.
- The renderer imports design system parts by subpath (`@clowdy/components/Text`), not the package barrel, which pulls in every component and its dependencies (TipTap, CodeMirror, Shiki).
- Windows paths break code written for POSIX ones: use `fileURLToPath`, not `new URL(...).pathname`.
- electron-builder needs an exact Electron version, so `electron` is pinned. Upgrade it on purpose.
- The app icon (`build/icon.png`) is a placeholder. There are no installers, signing, or notarization yet: `package` signs ad hoc and Windows builds are unsigned.
- One instance runs at a time, and dev runs share the `Clowdy Dev` user data folder and port 5273. A second `./clowdy dev` (another worktree, say) stops on the taken port; with `CLOWDY_RENDERER_PORT` set it gets past that, but its Electron finds the first one running and quits.
- `appId` (`app.clowdy.desktop`) and the `Clowdy` / `Clowdy Dev` user data folders follow the working name. Settle them before a first release: updates and stored data depend on them.

## Not verified

macOS (arm64) is built, launched, and checked in dev and packaged form. The Windows apps build, but nothing was run on Windows, so Mica and the caption-button overlay are untested there.
