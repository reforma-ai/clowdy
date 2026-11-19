# Reforma: shell auto-update and front OTA at runtime

Read on 2026-11-18 from `/Users/bionic/WORK/Reforma/reforma/apps/desktop` (source and tests listed, not run). The publishing side is in [reforma-ci.md](reforma-ci.md).

## Summary

Two independent updaters live in the Electron main process:

- **Shell** (`src/updater.ts`): electron-updater 6.8.x with a **generic** feed at `<release host>/desktop`. Checks at launch and hourly, downloads in the background, asks with a native "Restart to update" dialog, installs on quit otherwise. No rollback.
- **Front** (`src/ota.ts`): custom code. Starts the newest verified front on disk without touching the network, checks a signed manifest at launch and hourly, downloads into staging, verifies every file, swaps a pointer file atomically, runs the new front from the next launch, and rolls back a front that does not report `ready()` within 30 seconds.

Both are wired in `src/main.ts`. The only build-time inputs are the release host and the front public key, baked into the main bundle by `scripts/build.ts` and read through `src/config.ts`.

## Shell updater (`src/updater.ts`, `createUpdater`)

- Enabled only when `app.isPackaged && releaseHost` (`main.ts`), and only after `installedWhereUpdatesWork()`: on macOS, outside an Applications folder, it offers `app.moveToApplicationsFolder()` and does not check (Squirrel.Mac cannot replace an app on a disk image or a translocated copy).
- `autoDownload = false`, `setFeedURL('<host>/desktop')`, `setInterval(check, 1 h)` plus a check at start.
- `check()`: `checkForUpdates()` → if available, `download()`; on macOS it waits for **both** electron-updater's `downloadUpdate()` and Electron's own `autoUpdater` (`squirrel`) `update-downloaded`, because Squirrel.Mac verifies the code signature after the download and electron-updater's own event fires earlier. Then a two-button native dialog ("Restart to update" / "Later"); accept → `quitAndInstall()`. After the first completed download it clears the interval (installs on quit, no repeated prompts).
- `checkNow()`: behind the menu item **Check for Updates…**; on "current" it falls through to the front check (`main.ts` `checkForUpdates`), which re-offers a waiting front or says "up to date".
- `app-update.yml` (electron-updater's config inside the app) is only written by release builds (`bun run release` passes `-c.publish.provider=generic -c.publish.url=...`; win/linux get `publish` only when `DESKTOP_RELEASES_URL` is set).
- Windows: after an NSIS update the installer starts the app with `--updated`; `hasLaunchSwitches()` in `src/security.ts` allows exactly that switch (the packaged app refuses every other switch).
- Linux deb: electron-updater runs `pkexec dpkg -i`, so the user gets a password prompt.
- Integrity: electron-updater checks the SHA-512 from the feed; Squirrel.Mac requires the same Developer ID signature as the running app; Windows builds are unsigned so only hash + HTTPS host vouch for them.

## Front OTA (`src/ota.ts`, `createOta`)

**State on disk:** `userData/fronts/` holds at most two front folders named by integer version, plus `current.json` = `{ current, previous, unconfirmed, rejected[] }`, written via `current.json.tmp` + `rename` (atomic). Staging folders are `.staging-<version>-<random>` and are pruned.

**Startup (`chooseFront`):** reads the bundled front's manifest (`app.asar/front/manifest.json`, unsigned, covered by the app signature; a dev build has none → version 0). For `current` then `previous`: skip if not newer than bundled or rejected; `installedFront()` re-verifies the signed manifest against the pinned key, checks `minShell <= app.getVersion()`, and **rehashes every file** (about 80 ms for the whole front). First match wins, else the bundled front. The choice is fixed for the process lifetime, so lazy chunks never mix versions. `main.ts` then passes `front.root` and `front.files` to the `app://reforma` protocol handler.

**Serving (`src/protocol.ts`, `serveFile`):** for an installed front, each served file's SHA-256 must match the manifest or it is refused; paths are resolved with `realpath` and must stay inside the root; unknown extension-less paths fall back to `index.html`.

**Check (`check`):** skipped when key or host is empty, while a front is on trial, or while another check runs. Fetch `<host>/front/manifest.json` with `net.fetch` (body capped at 1 MB), `openManifest()` verifies the Ed25519 signature over the exact `body` string (`{ body, signature }` JSON, see `src/front-manifest.ts`), then refuses if version ≤ max(running, current), rejected before, or `minShell` above the shell. `install()`: download every file from `<host>/front/<version>/<path>` 8 at a time, cap each body at the manifest size, check size + SHA-256, write into staging, write the signed manifest, `rename` staging → `<version>`. Then write state `{ current: new, previous: running if it was an installed front else null, unconfirmed: true }`, prune everything else, call `onInstalled(version)` → IPC `frontInstalled` → page toast.

**Trial and rollback:** a front that took over at this launch (`unconfirmed`) starts a 30 s timer (`watchReady`). `window.desktop.ready()` (called by `apps/front/src/common/DesktopReady.tsx` after first render) clears it, marks confirmed, and triggers a check. On timeout: mark the version rejected, make `previous` current (itself unconfirmed), prune, `relaunch()` (stops local controllers, flushes cookies and storage, `app.relaunch(); app.exit(0)`). If the previous one fails too, the bundled front runs. While on trial nothing is installed over it.

**Restart to update:** `restartToUpdate` (bridge) → `ota.restart()` relaunches the same way. `onFrontUpdate` replays the waiting version to a page that subscribes late, so a reload keeps the offer. UI: `apps/front/src/common/DesktopUpdatePrompt.tsx` ("New version ready" toast with Restart).

**After a shell update:** an installed front not newer than the new bundled front is ignored, so channels can land in either order.

## Compatibility rule

One number: the shell version. A front's `minShell` is the shell version at its build commit; the app installs only fronts with `minShell <= app.getVersion()`; the publisher publishes only when a shell ≥ `minShell` is live; `check-shell-version.ts` forces a version bump when shell-shipped files change. The bridge (`packages/types/src/desktop/bridge.ts`) is additive only; front code feature-detects bridge functions instead of comparing versions. There is no separate API/protocol axis because the backend API is a hosted service that is always current.

## Dev-mode behavior

- `desktopConfig()` in a dev run reads `REFORMA_API_URL`, `DESKTOP_RELEASES_URL`, `DESKTOP_FRONT_PUBLIC_KEY` from the environment; front OTA runs only with both of the last two. The dev bundled root is `apps/front/dist/desktop`.
- The shell updater never runs unpackaged; the menu item is absent.
- A packaged app never reads its environment and refuses to start without the baked constants.

## Relevant files

- `apps/desktop/src/updater.ts` — shell update schedule, Squirrel wait, prompt, move-to-Applications. Tests: `updater.test.ts` (electron-updater faked).
- `apps/desktop/src/ota.ts` — front choice, check, install, trial, rollback, prune. Tests: `ota.test.ts`.
- `apps/desktop/src/front-manifest.ts` — `FrontManifest`, `signManifest`, `openManifest`, `parseManifest` (path safety: no absolute, `..`, backslash, colon, NUL), `hashFront`.
- `apps/desktop/src/protocol.ts` — `app://reforma` handler; per-file hash check for OTA fronts.
- `apps/desktop/src/config.ts` — baked constants vs dev environment.
- `apps/desktop/src/main.ts` (lines ~135–275) — wiring: `createOta` before `protocol.handle`, `createUpdater` after the window, `checkForUpdates` for the menu, hourly front checks.
- `packages/types/src/desktop/bridge.ts` — `ready`, `onFrontUpdate`, `restartToUpdate`.
- `apps/front/src/common/DesktopReady.tsx`, `DesktopUpdatePrompt.tsx` — page side.

## Known limits (from Reforma's docs)

- No shell rollback; a shell that cannot launch never reaches its updater.
- `ready()` proves only the first render; a front broken later stays until a newer one ships.
- One channel; no staged rollout or beta.
- A front signing key change needs a shell release; a lost key means a full shell release.
- Empty `DESKTOP_FRONT_PUBLIC_KEY` silently ships an app that never updates its front.

## Assumptions and limits

- Behavior is read from source and Reforma's docs. Reforma reports one real front OTA on a Mac (13 Nov 2026, front 942 → 943) and one real shell update on Windows (0.2.1 → 0.2.3 by 16 Nov 2026); signed macOS shell updates were not yet exercised.
