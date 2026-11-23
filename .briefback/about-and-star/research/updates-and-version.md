# Updates, version, and what reaches the renderer

## Summary

The main process owns everything about versions and updates, and none of it reaches the renderer except one signal: "an OTA bundle is installed, restart". No renderer UI shows the app version, the bundle version, or an update state. Shell updates are driven by native sheets (dialogs) and the macOS-only "Check for Updates…" menu item. In a development run, and in a local `package` build, the release repo is empty, so there is no updater, no OTA, no update menu item, and nothing to link to.

## How it works today

**Config baked into a release build** (`apps/desktop/src/main/releaseConfig.ts`, `releaseConfig(packaged, env)`):

- `repo` (`owner/name`, from `CLOWDY_RELEASE_REPO`), `signed`, `otaPublicKey`, `otaFeed` (`https://github.com/<repo>/releases/download/ota`, empty without a repo).
- `scripts/build.ts` (`releaseConstants()`) validates `owner/name` and passes the values as `define` literals to `scripts/main-bundle.ts` (`buildMain`, `Bun.build`). The workflow `release-shell.yml` passes `github.repository`.
- Not packaged: `repo` is `''`, `signed` false; OTA only against a test feed (`CLOWDY_UPDATE_FEED` and `CLOWDY_UPDATE_PUBLIC_KEY`, `scripts/ota-local.ts`).
- A packaged build made locally (`bun run package`) has no repo either: same as dev.
- The repo name is available only in main. It is not exposed through the preload, and the renderer has no `define` of its own (`vite.config.ts` bakes nothing).

**Shell updater** (`src/main/updater.ts`, `createUpdater`, electron-updater GitHub provider):

- `start()` checks at launch and hourly; `checkNow(onFound)` backs the menu item. Outcomes are native sheets built by `showSheet` in `src/main/index.ts` (`startUpdates`): "Clowdy X is ready to install" (Restart to update / Later), "Clowdy X is available" with Download for builds that cannot self-update (ad-hoc signed macOS), "Clowdy is up to date" (shows `app.getVersion()` and the bundle number), "Couldn't update Clowdy".
- `openReleasePage` is a closure in `startUpdates`: `shell.openExternal('https://github.com/<repo>/releases/latest')`. It is not exposed to the renderer.
- The state (`downloaded`, `offered`, `running`) is private to the closure. Nothing reports "checking", "downloading", "ready", or "up to date" to a window. `checkNow` throws "Clowdy can update itself only from the Applications folder" when `start()` bailed out (macOS outside Applications).

**OTA bundles** (`src/main/ota.ts`, `createOta`; bundle info in `src/main/bundle.ts` and `bundleManifest.ts`):

- `ota.enabled` is `Boolean(publicKey && feed)`. `choose()` fixes the running bundle for the process (`RunningBundle.version`; `0` for a development run's own sources). `check()` installs a newer one for the next launch and calls `options.onInstalled`, which sends `IPC_CHANNELS.updateReady` with the bundle number to every window. `pending()` returns the installed-but-not-running version. `restart()` relaunches.
- The bundle number is the first-parent commit count (`scripts/bundle.ts`, `bundleVersion`). A shell and an OTA bundle built from the same commit share it. `bundle.json` in the app carries `{ version, minShell, protocol }` (`readBundleInfo`).

**Version reading**:

- Shell version: `app.getVersion()`. A packaged app's `package.json` is written by `scripts/build.ts` from `apps/desktop/package.json` `version` (`0.1.1` today). A development run reads the same file (`productName` is `Clowdy Dev`). It is passed to the OTA code as `shellVersion` and shown in the "up to date" sheet.
- Bundle version: `bundle.version` in `index.ts`. On macOS `app.setAboutPanelOptions({ version: 'Bundle N' })` makes the native About panel read "Version 0.1.1 (Bundle N)". The macOS template has `role: 'about'`; the Windows template has no About item at all.
- Daemon version: `Health.version` (the bundle version the daemon runs), from `GET /v1/health` (`ROUTES.health`, `packages/protocol/src/api.ts`). No `Transport` method wraps it and no renderer code reads it. The app's own `src/main/daemon.ts` reads it.

**What reaches the renderer** (`src/shared/bridge.ts` `DesktopBridge`, `src/preload/index.ts`):

- Fields and calls: `platform`, `material`, `daemon` (`url`, `token`; set by a synchronous `sendSync` before the page's scripts), `onDaemonChange`, `setThemeSource`, `chooseDirectories`, `ready`, `onUpdateReady(listener(version: number))`, `restartToUpdate`, find-in-page calls, `getOpenApps`, `openPath`, and the clipboard-file calls.
- The only update UI is in `src/renderer/root.ts`: `onUpdateReady` shows a sticky toast "Update ready / Restart Clowdy to use the new version" with a Restart action. `main` replays the version on every `did-finish-load` (`openWindow`), so a window opened later still gets it.
- Static values can reach the preload without IPC: `windowOptions(...)` adds `additionalArguments: [WINDOW_MATERIAL_ARGUMENT]` and the preload reads `process.argv` (`material`). This is a precedent for baking a repo or version into the bridge cheaply.

## What a Settings page can read today (no main change)

- `window.desktop.platform`, `.material`, `.daemon`.
- The daemon's health by plain `fetch(daemon.url + ROUTES.health)`: `/v1/health` needs no token, the daemon allows the origin `app://clowdy` (`apps/daemon/src/http/guard.ts`) and the CSP `connect-src` allows `http://127.0.0.1:*`. This gives the daemon's bundle version, protocol, pid, and start time. It is not the shell version.
- Agent CLI versions (`AgentInfo.version`, shown as `v1.2.3` in `settings/providers/ProviderCard.tsx`). This is the only version string in the UI today.

## What is missing for an About page

- A bridge value for the shell version, the running bundle number, and the release repo (or the repo-derived URLs). New `DesktopBridge` fields (and in the dev run `repo` stays `''`).
- Any update status and a "Check for updates" action for the renderer: `checkForUpdates` is a closure inside `startUpdates` (it also disables the menu item while it runs); to reach a button it must become an IPC action in `src/main/ipc.ts` (`IpcActions`, `assertTrustedSender`) plus a status event or return value.
- A way for the renderer to ask main to open a URL (see `native-menu-and-external-links.md`: `https:` links already work from anchors, so this may not be needed).

## Constraints

- **Shell coupling.** `scripts/publish-ota.ts` `SHELL_PATHS` lists `apps/desktop/src/main`, `src/preload`, `src/shared`, `build`, `electron-builder.ts`, `package.json`, `scripts/build.ts`, `bun-runtime.ts`, `ripgrep.ts`, `main-bundle.ts`, `packages/protocol/src/paths.ts`, `packages/constants/src/theme.ts`. A change in any of them since `v<minShell>` makes the OTA bundle wait until the shell version is raised and released. Renderer-only work (`src/renderer`, `packages/components`, `vite.config.ts`) ships over the air. A new bridge field, a menu item, or an IPC action is a shell change.
- **Old shell, new renderer.** An OTA bundle is only installed on a shell `>= minShell`, and the publish step refuses a bundle when the shell changed, so a renderer using a new bridge field never meets a shell without it through OTA. In dev and in a plain browser (screenshot harness, `?fixtures=static`) `window.desktop` is absent or partial: every use is `window.desktop?.`.
- Updates start working only once the repo is public (`apps/desktop/AGENTS.md` Releases): until then OTA gets a 404 ("no update") and electron-updater cannot read the releases anonymously. A status line must tolerate "never checked" and "check failed".
- `app://clowdy` is a standard, secure origin. An `<a href="https://…" target="_blank">` goes through `setWindowOpenHandler` to the system browser (one open per second).

## Relevant files

- `apps/desktop/src/main/releaseConfig.ts` — baked repo, signed flag, OTA key and feed
- `apps/desktop/src/main/updater.ts` — shell updater and its sheets (`createUpdater`)
- `apps/desktop/src/main/ota.ts` — OTA bundles (`createOta`, `RunningBundle`, `pending`, `enabled`)
- `apps/desktop/src/main/index.ts` — `startUpdates`, `showSheet`, `setAboutPanelOptions`, `openWindow` (replays `updateReady`)
- `apps/desktop/src/main/bundle.ts` — `BundleInfo`, `readBundleInfo`
- `apps/desktop/src/shared/bridge.ts`, `src/preload/index.ts` — the bridge
- `apps/desktop/src/renderer/root.ts` — the "Update ready" toast
- `apps/desktop/scripts/build.ts`, `main-bundle.ts` — baking `__CLOWDY_RELEASE_REPO__`
- `.briefback/releases-updates/research/` and `plan.md` — earlier research and plan of the update system (repo `kachurun/clowdy`, public later)

## Open questions

- Should the About page show update state at all, or only the version and a link to the release page? Showing state needs new main to renderer plumbing; a link needs only the repo name.
- Does "version" mean shell only, or "0.1.1 (bundle N)" as the macOS About panel and the "up to date" sheet do? The bundle number can change without a shell release.

## Assumptions and limits

- Not run: the packaged app, the updater, OTA against a real feed (the repo is private, nothing is published).
- `app.getVersion()` in a development run was inferred from `apps/desktop/package.json` and Electron's behavior, not observed.
