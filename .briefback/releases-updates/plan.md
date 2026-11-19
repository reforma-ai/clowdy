# Releases and updates

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** Clowdy ships as installers built on GitHub, updates its Electron shell with electron-updater, and updates its renderer and daemon over the air from GitHub Releases.

**Approach:** Port Reforma's release design (`/Users/bionic/WORK/Reforma/reforma/apps/desktop`: `updater.ts`, `ota.ts`, `front-manifest.ts`, `protocol.ts`, `scripts/{targets,toolchain,publish-shell,publish-front,check-shell-version}.ts`, `.github/workflows/build_desktop.yml`) and replace its R2 storage with GitHub Releases in `kachurun/clowdy`. A shell release is cut by raising the version in `apps/desktop/package.json`; an OTA bundle (renderer + daemon JS + system skills from one commit, signed with Ed25519) is published on every relevant push to `main`. The packaged app carries its own copy of the bundle and a Bun executable, so it starts offline; the daemon always runs from a copy outside the install folder. Research: `.briefback/releases-updates/research/index.md`.

**Decisions**

- Channel: GitHub Releases in `kachurun/clowdy`. The repo will become public later; until then releases are private, installers are downloaded by hand, and updates start working the day the repo opens. No separate releases repo.
- Port Reforma's pieces with R2 swapped for GitHub. The one new dependency is `electron-updater` (^6.8, as Reforma).
- Shell: electron-updater with the GitHub provider; semver in `apps/desktop/package.json`; a version raised on `main` triggers macOS (arm64 + x64, dmg + zip) and Windows (`nsis-web`, x64 + arm64) builds and a release `v<x.y.z>` marked Latest. Manual dispatch too.
- Signing: CI signs and notarizes when `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` are set, otherwise builds ad hoc (the Apple account is still in verification). An ad-hoc macOS shell does not update itself; it offers a Download link to the latest release. Windows stays unsigned. Untested and possibly broken builds are acceptable for now; testing comes later.
- Identity stays: `app.clowdy.desktop`, `Clowdy`. Development runs (`Clowdy Dev`) never update, except through the explicit development test feed.
- The daemon ships as JavaScript (`bun build --target=bun`) with the system skills beside it, run by a Bun executable shipped in the shell's `extraResources` (the version in the root `packageManager`, one per arch). Bun changes only with a shell release.
- One OTA bundle for every platform: renderer, daemon JS, and system skills from one commit. Version = `git rev-list --first-parent --count HEAD`; `minShell` = the shell version at that commit; the manifest also names `PROTOCOL_VERSION`. Payload is one `.tar.gz` read by our own small tar reader over `zlib`; every file is checked against the signed manifest, and the renderer is checked again file by file when served. Bundles live under the updates folder; at start the app picks the newest verified, compatible bundle, otherwise its own copy.
- Lookup: one permanent prerelease tagged `ota` holds the signed `manifest.json` and `bundle-<version>.tar.gz` files. Publishing uploads the archive, then replaces the manifest, then prunes to the newest three bundles. A 404 means "no update now".
- OTA publishing runs on every push to `main` that touches the renderer, the daemon, the protocol, the skills, or shared packages, on a Linux runner. It refuses when the shell's files changed since the last shell tag without a version bump, and when the shell version it needs is not released yet. Manual dispatch too.
- Applying: a new bundle takes effect at the next app start. A daemon from another bundle is replaced silently when `activeRuns === 0`; when runs are active, a sheet names how many and offers Restart now (they get interrupted and continue on the next message) or Wait (the app swaps it once idle). The same rule replaces an older daemon after a shell update (today the app refuses it).
- Rollback: a renderer that does not call `ready()` within 30 s is rejected and the previous bundle (or the app's own copy) runs. A bundle whose daemon does not become healthy within the start window is rejected; when that launch wrote a `clowdy.db.bak-v<n>`, the backup is restored; the previous daemon starts. Once a daemon came up healthy there is no automatic rollback: the next bundle fixes forward.
- First launch: when the best local bundle is the app's own copy (fresh install or just-updated shell), the app checks the manifest with a ~3 s budget before opening a window; a newer compatible bundle is downloaded behind a boot window with progress and started; offline, a timeout, or a failure starts the app's own copy and the check continues in the background. Other launches check in the background only.
- Testing before the repo opens: workflows run for real into private releases; the update mechanics are tested locally through a development-only feed (`CLOWDY_UPDATE_FEED` + `CLOWDY_UPDATE_PUBLIC_KEY`, honored only in an unpackaged run) served by a script with signed test bundles, plus unit tests. End-to-end runs come after the repo opens.
- Windows: `hasLaunchSwitches` accepts `--updated`, which the NSIS updater passes.
- No PR CI for now. `GITFLOW.md` drops the inherited `ci.yml`, `ci-ok`, changesets and Bugbot text and describes how shell and OTA releases are cut.

**Reuse**

- `ensureDaemon`, `findRunning`, `stopDaemon`, `daemonEnvironment`, `DaemonError` (`apps/desktop/src/main/daemon.ts`)
- `restartIfStale`, `keepDaemonFresh` (`apps/desktop/src/main/daemonKeeper.ts`); `IPC_CHANNELS.daemonChanged` (`apps/desktop/src/shared/bridge.ts`), which moves windows to a new daemon without a reload
- `showDaemonError` (`apps/desktop/src/main/daemonDialog.ts`) as the sheet pattern
- `createProtocolHandler` (`apps/desktop/src/main/protocol.ts`), `registerIpc` (`apps/desktop/src/main/ipc.ts`), `createAppMenu` (`apps/desktop/src/main/menu.ts`)
- `buildMain` (`apps/desktop/scripts/main-bundle.ts`) for build-time constants
- `daemonDataDir` (`packages/protocol/src/paths.ts`); `PROTOCOL_VERSION`, `Health` (`packages/protocol/src/api.ts`)
- `CLOWDY_SYSTEM_SKILLS_DIR` and `materializeSystemSkills` (`apps/daemon/src/skills/materialize.ts`)
- `toast` and `ToastRegion` (`@clowdy/components/Toast`)

## Out of scope

- PR CI (`ci.yml`, required checks)
- Windows code signing; Linux builds
- Beta channels, staged rollouts, shell rollback
- A separate public releases repo; GitHub Pro
- Protocol version ranges (the protocol stays one exact integer)
- End-to-end update runs against GitHub before the repo is public
- Turning on Apple signing (the pipeline is ready; secrets are added when the account is verified)

## Stage 1 — The packaged app runs its own daemon

**Depends on:** None.

**This stage:** A packaged build has no daemon today: `startDaemon` needs `CLOWDY_BUN` and `CLOWDY_DAEMON_ENTRY`, which only `./clowdy dev` sets. This stage makes `./clowdy build` produce an app that carries its bundled copy (renderer in the ASAR; daemon JS and system skills in `Resources/bundle`; a `bundle.json` naming version, `minShell`, and protocol) and a Bun executable for its arch in `Resources/bun`, and that starts the daemon from copies outside the install folder (`<updates>/bun/<bun version>/` and `<updates>/bundles/<version>/`), so a running daemon never holds files an installer must replace. The daemon reports the bundle version in `Health.version`. Development runs keep their environment variables.

- [x] Complete
  - [x] The daemon builds into `main.js` + `mcp-stdio.js` with `bun build --target=bun`, with the bundle version baked in, and finds `mcp-stdio.js` beside itself
  - [x] The release build lays out the bundled copy and `bundle.json`; the bundle version comes from the first-parent commit count
  - [x] The release build downloads the pinned Bun for each target arch (cached) and electron-builder ships it in `extraResources`, signed with the inherit entitlements
  - [x] A packaged app copies Bun and its bundled daemon into the updates folder when missing and launches from there; `CLOWDY_SYSTEM_SKILLS_DIR` points at the copied skills
  - [x] `hasLaunchSwitches` accepts `--updated`
  - [x] `apps/desktop/AGENTS.md` "Packaged app" describes the shipped shape

**Files**

- `apps/daemon/scripts/bundle.ts` — create: the daemon's own build step (entries, define, output); cannot live in `apps/desktop/scripts/build.ts` because the OTA bundle build in Stage 4 reuses it
- `apps/daemon/src/daemon.ts` — `Health.version` from the baked bundle version, falling back to `package.json`
- `apps/daemon/src/engine/acp/bridge.ts` — `MCP_ENTRY`: resolve `mcp-stdio.js` beside a bundled daemon
- `apps/daemon/package.json` — `bundle` script
- `apps/desktop/scripts/bun-runtime.ts` — create: downloads and caches Bun per platform/arch (port of the Bun part of Reforma's `toolchain.ts`); cannot live in `build.ts` because the release workflow fetches both macOS archs and both Windows archs
- `apps/desktop/scripts/build.ts` — lay out `bundle/` (daemon, system skills), `app/bundle.json`, call the Bun fetch
- `apps/desktop/electron-builder.ts` — `extraResources` (`bundle`, `bun/${arch}`), `entitlementsInherit`, `files` include `bundle.json`
- `apps/desktop/build/entitlements.mac.inherit.plist` — create: Bun's JIT entitlements plus `disable-library-validation`; cannot reuse `entitlements.mac.plist` because the app itself must not get library validation off
- `apps/desktop/scripts/bundle.ts` — create: bundle version, `bundle.json` data, daemon and skills layout; Stage 4 adds the renderer, archive, and manifest
- `apps/desktop/src/main/bundle.ts` — create: reads the bundled copy's `bundle.json`, resolves the updates folder, copies Bun and the bundled daemon out of the install folder; Stage 5's OTA chooser extends it
- `apps/desktop/src/main/daemon.ts` — `DaemonContext` carries the launch runtime (`bun`, `entry`, `skillsDir`) instead of `startDaemon` reading `CLOWDY_BUN` / `CLOWDY_DAEMON_ENTRY`; `daemonEnvironment` sets `CLOWDY_SYSTEM_SKILLS_DIR`
- `apps/desktop/src/main/index.ts` — packaged runs build the runtime from `bundle.ts`; development runs from the environment
- `apps/desktop/src/main/security.ts` — `hasLaunchSwitches`: allow exactly `--updated`
- `apps/desktop/AGENTS.md` — "Packaged app" and Traps

**Done when:** `./clowdy build mac` produces `Clowdy.app` that starts its own daemon from `~/Library/Application Support/Clowdy/updates` with no environment variables set.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`; `bun test` and `bun run typecheck` in `apps/daemon`; `./clowdy build mac`, launch the app, check `daemon.json`, the daemon's command line, and a chat.
**Commits:** None yet.

## Stage 2 — A packaged app replaces an older daemon

**Depends on:** Stage 1.

**This stage:** After a shell update (and later an OTA bundle) the running daemon can be from another bundle; today the app refuses one with another protocol and tells the person to stop it. The keeper, dev-only today, gets a packaged mode where "stale" means `health.version` differs from the bundle the app runs or the protocol differs. An idle daemon is replaced silently; a busy one gets a sheet with the number of active runs and Restart now / Wait. Wait keeps polling and swaps once idle; while protocols match the app keeps using the old daemon, otherwise the window waits on the existing "Can't reach the daemon" banner. The windows move to the new daemon through `daemonChanged`.

- [x] Complete
  - [x] `restartIfStale` takes the staleness rule, with mtimes for development and bundle version or protocol for packaged runs
  - [x] `ensureDaemon` hands a stale daemon to the keeper in a packaged run instead of throwing a protocol `DaemonError`
  - [x] A busy stale daemon raises one sheet per launch with the run count; Restart now stops it and starts the current one; Wait swaps when idle
  - [x] Unit tests cover idle swap, busy wait, forced restart, and protocol mismatch

**Files**

- `apps/desktop/src/main/daemonKeeper.ts` — `restartIfStale`, `keepDaemonFresh`: staleness rule, busy callback, forced restart
- `apps/desktop/src/main/daemon.ts` — `acceptable`, `ensureDaemon`, `attachDaemon`: packaged behavior for a stale daemon
- `apps/desktop/src/main/daemonDialog.ts` — the busy-daemon sheet next to `showDaemonError`
- `apps/desktop/src/main/index.ts` — `startKeeper`, `connectDaemon`: start the keeper in packaged runs
- `apps/desktop/src/main/daemonKeeper.test.ts`, `apps/desktop/src/main/daemon.test.ts` — cases above

Scope change (review): only a daemon from an **older** bundle (or from sources, or the same bundle on another protocol) is stale (`fromOlderBundle`); a newer one stays, because its database may be migrated past what this bundle's daemon opens. A window that loaded without a daemon reloads on `daemonChanged` (`src/renderer/root.ts`), and the sheet closes itself when the keeper swaps first.

**Done when:** a packaged app that finds a daemon from an older bundle replaces it when idle, and asks with the run count when busy.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`.
**Commits:** None yet.

## Stage 3 — Shell releases on GitHub

**Depends on:** Stage 1.

**This stage:** Adds the release pipeline and the shell updater. Raising the version in `apps/desktop/package.json` on `main` (or a manual run) builds macOS arm64 + x64 (dmg + zip, signed and notarized when the secrets exist, ad hoc otherwise) and Windows `nsis-web` x64 + arm64 (unsigned), then publishes a draft release `v<x.y.z>`, uploads every file, and marks it Latest. The app checks at launch and hourly with electron-updater's GitHub provider, asks before restarting, offers to move itself to Applications on macOS, and on an ad-hoc macOS build offers a Download link instead. Local `./clowdy build` output never self-updates (no `app-update.yml`).

- [x] Complete
  - [x] `electron-updater` added to `apps/desktop`
  - [x] electron-builder writes the GitHub publish config only for release builds; dmg and web installer names without the version for stable links (archs come from the release scripts' flags, so `--dir` builds stay host-only; no separate targets list)
  - [x] Build-time constants: release repo, signed flag
  - [x] The shell updater (port of Reforma's `updater.ts`) with the ad-hoc Download path and the menu item Check for Updates…
  - [x] `.github/workflows/release-shell.yml`: decide, macOS, Windows, publish
  - [x] `GITFLOW.md` describes the real flow; `apps/desktop/AGENTS.md` gets a Releases section with the secrets table

**Files**

- `apps/desktop/package.json` — `electron-updater` dependency; `release:mac`, `release:win` scripts
- `apps/desktop/scripts/github.ts` — create: the `gh` calls the release scripts make (Node APIs, so Vitest loads it); Stage 4 reuses it
- `apps/desktop/scripts/release-shell.ts` — create: `decideShell` (build, skip, fail) and `publish` (draft, upload, then Latest)
- `apps/desktop/scripts/release-shell.test.ts` — create
- `apps/desktop/vitest.config.ts` — runs `scripts/**/*.test.ts` too
- `apps/desktop/electron-builder.ts` — `mac.target` dmg + zip, `win.target` nsis-web, `publish` (GitHub, release builds only), `artifactName`s, `dmg.writeUpdateInfo: false`
- `apps/desktop/scripts/main-bundle.ts` — `buildMain`: `define` for release constants
- `apps/desktop/src/main/releaseConfig.ts` — create: baked constants vs development environment (port of Reforma's `config.ts`); cannot live in `index.ts` because `updater.ts` and Stage 5's `ota.ts` read it and tests replace it
- `apps/desktop/src/main/updater.ts` — create: shell update schedule, Squirrel wait, restart sheet, move to Applications, ad-hoc Download (port of Reforma's)
- `apps/desktop/src/main/updater.test.ts` — create: electron-updater faked
- `apps/desktop/src/main/menu.ts` — `createAppMenu`: Check for Updates…
- `apps/desktop/src/main/index.ts` — start the updater after the first window
- `.github/workflows/release-shell.yml` — create
- `GITFLOW.md` — remove CI, changesets, Bugbot; add Releases
- `apps/desktop/AGENTS.md` — Releases section, Traps

Scope change (review): the packaged app's own `package.json` is named `clowdy`, not `@clowdy/desktop`, because electron-builder names the Windows packages after it (`clowdy-<version>-<arch>.nsis.7z`) and GitHub renames assets with special characters. `publish` decides again before it writes, so a re-run never makes an older version Latest. The DMGs are signed (`dmg.sign`), which the workflow's DMG check needs. CI takes Bun from the root `packageManager`.

**Done when:** a push that raises the shell version produces a GitHub release with dmg, zip, nsis-web files, and `latest*.yml`, marked Latest, and a packaged app built by it checks that release.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`; a manual `workflow_dispatch` run once the owner approves (it creates a private release).
**Commits:** None yet.

## Stage 4 — OTA bundles: format, build, publish

**Depends on:** Stage 1.

**This stage:** Defines the signed bundle and publishes it. A manifest `{ version, minShell, protocol, archive: { name, sha256, size }, files: { path: { sha256, size } } }` is signed with Ed25519 as `{ body, signature }` (port of Reforma's `front-manifest.ts`). The bundle build reuses Stage 1's layout (renderer, daemon, system skills) and packs a `.tar.gz` with our own tar writer and reader. The publish script decides from GitHub: the Latest shell tag must be `v<minShell>` or newer, shell files must not have changed since `v<minShell>` without a bump, and the published manifest must be older; then it uploads the archive to the `ota` prerelease (creating it once), replaces `manifest.json`, and prunes to three bundles. The workflow runs on pushes to `main` under the bundle's paths and on manual dispatch, on Linux.

- [x] Complete
  - [x] Manifest module: parse with path safety, sign, open with a pinned key, hash a folder
  - [x] Tar writer and reader (ustar regular files and folders) over `zlib`
  - [x] Bundle build into a folder plus archive and manifest
  - [x] Publish decision and upload via `gh`; dry-run mode for local use
  - [x] Build-time OTA public key; the release build writes the bundled copy's manifest data
  - [x] `.github/workflows/release-ota.yml`
  - [x] Releases docs: key generation, secret `CLOWDY_OTA_SIGNING_KEY`, variable `CLOWDY_OTA_PUBLIC_KEY`, `GITFLOW.md` OTA paragraph

**Files**

- `apps/desktop/src/main/bundleManifest.ts` — create: manifest types, `signManifest`, `openManifest`, `parseManifest`, `hashFolder`; shared by scripts and main, so it cannot live in a script
- `apps/desktop/src/main/bundleManifest.test.ts` — create
- `apps/desktop/src/main/tar.ts` — create: `writeTar`, `readTar`; cannot live in `bundleManifest.ts` because it is a format of its own with its own tests
- `apps/desktop/src/main/tar.test.ts` — create
- `apps/desktop/scripts/bundle.ts` — create: builds the bundle folder, archive, and manifest; `build.ts` and `publish-ota.ts` call it
- `apps/desktop/scripts/publish-ota.ts` — create: `decide`, `publish`, `prune`
- `apps/desktop/scripts/publish-ota.test.ts` — create: decisions over a faked GitHub and git
- `apps/desktop/scripts/build.ts` — use `bundle.ts` for the bundled copy
- `apps/desktop/scripts/github.ts` — the asset calls (`releaseAssets`, `createPrerelease`, `uploadAssets`, `deleteAsset`, `downloadAsset`), telling a missing release from a failed call
- `apps/desktop/scripts/build.ts` — bakes `CLOWDY_OTA_PUBLIC_KEY` (re-exported from the parsed key)
- `apps/desktop/src/main/releaseConfig.ts` — OTA public key
- `.github/workflows/release-ota.yml` — create
- `apps/desktop/AGENTS.md`, `GITFLOW.md` — OTA release docs

Scope change (review): a change to `PROTOCOL_VERSION`, the daemon's data folder (`packages/protocol/src/paths.ts`), or the themes main accepts counts as a shell change, because main inlines them; `newestShell` lives once in `release-shell.ts`; `hashFolder` refuses links; `rendererFiles` waits for Stage 5. Publishing also skips when `CLOWDY_OTA_PUBLIC_KEY` is unset, since shells built without it ignore bundles.

**Done when:** a dry run produces a signed manifest and archive that `openManifest` and `readTar` accept, and the workflow publishes to the `ota` prerelease on a qualifying push.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`; `bun apps/desktop/scripts/publish-ota.ts --dry-run`.
**Commits:** None yet.

## Stage 5 — OTA in the app

**Depends on:** Stage 2, Stage 4.

**This stage:** The app picks, fetches, installs, and serves bundles (port of Reforma's `ota.ts`). At start it chooses the newest installed bundle that verifies (signature, `minShell`, every file's hash) and is not rejected, otherwise its own copy; the renderer root and the daemon runtime both come from that choice, and Stage 2's keeper swaps the daemon to it. It checks at launch and hourly, downloads the archive from `https://github.com/kachurun/clowdy/releases/download/ota/` without forwarding auth headers, verifies, extracts into staging, renames atomically, writes `state.json` (`current`, `previous`, `unconfirmed`, `rejected`), prunes (never the bundle the running daemon uses), and tells the page. The page shows a "New version ready" toast with Restart and calls `ready()` after its first render; a bundle that does not within 30 s is rejected and the previous one runs. A development run uses the test feed only when both variables are set; a script serves signed test bundles.

- [x] Complete
  - [x] Choice at start, before `protocol.handle`; daemon runtime from the chosen bundle
  - [x] Check, download, verify, install, state, prune
  - [x] Per-file hash check when serving an installed bundle's renderer
  - [x] Bridge `ready`, `onUpdateReady`, `restartToUpdate`; preload; IPC
  - [x] Renderer calls `ready()` and shows the restart toast
  - [x] Renderer trial and rollback
  - [x] Development test feed and the local feed script
  - [x] Check for Updates… also checks OTA

**Files**

- `apps/desktop/src/main/ota.ts` — create: choose, check, install, trial, prune (port of Reforma's); cannot live in `bundle.ts`, which only knows the app's own copy and the updates folder
- `apps/desktop/src/main/ota.test.ts` — create
- `apps/desktop/src/main/bundle.ts` — expose the bundled copy as a candidate for `ota.ts`
- `apps/desktop/src/main/protocol.ts` — `createProtocolHandler`: optional file hashes
- `apps/desktop/src/main/index.ts` — wiring: choose, protocol root, runtime, hourly checks, restart
- `apps/desktop/src/main/ipc.ts` — `ready`, `restartToUpdate`
- `apps/desktop/src/shared/bridge.ts` — `ready`, `onUpdateReady`, `restartToUpdate`, channels
- `apps/desktop/src/preload/index.ts` — the three bridge calls
- `apps/desktop/src/main/releaseConfig.ts` — development feed variables
- `apps/desktop/src/main/updater.ts` — `checkNow` falls through to the OTA check
- `apps/desktop/src/renderer/root.ts` — subscribe to `onUpdateReady`, restart toast
- `apps/desktop/src/renderer/main.tsx` — `ready()` after the first render
- `apps/desktop/scripts/ota-local.ts` — create: builds a bundle signed with a local test key and serves it on localhost for the development feed

Scope change (implementation and review): a bundle must speak the shell's `PROTOCOL_VERSION` (Stage 4 made a protocol change a shell change, so main keeps its compile-time constant). Bun copies are pruned too, only once the daemon is one this app started. A development run on the feed runs the bundle's daemon with the checkout's Bun, and its keeper treats a bundle's daemon as stale when it is back on its checkout. `state.json` is written inside the install's exclusive section, so a prune during a download cannot delete it; a prune is skipped while a daemon holds its lock without answering. "Check for Updates…" still checks bundles when the shell cannot update. The page's storage is flushed before every relaunch. Pages that load after an install get the toast too, and a new offer replaces the open toast.

**Done when:** a development run pointed at the local feed downloads a newer bundle, offers Restart, starts on it, and falls back when the new renderer never calls `ready()`.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`; `bun apps/desktop/scripts/ota-local.ts` plus `CLOWDY_UPDATE_FEED=… CLOWDY_UPDATE_PUBLIC_KEY=… ./clowdy dev`.
**Commits:** None yet.

## Stage 6 — Daemon trial and rollback

**Depends on:** Stage 5.

**This stage:** A bundle whose daemon is starting for the first time is on trial: if it does not write `daemon.json` and answer `/v1/health` within the start window, the bundle is rejected, a `clowdy.db.bak-v<n>` written after that launch began replaces `clowdy.db` (with its `-wal` and `-shm` removed), and the app relaunches on the previous bundle. A daemon that came up healthy confirms its bundle's daemon half; after that there is no automatic rollback.

- [x] Complete
  - [x] Trial state for the daemon half in `state.json`
  - [x] Failed start: reject, restore the backup when this launch wrote one, relaunch
  - [x] Unit tests: healthy confirm, failure before migration, failure after migration

**Files**

- `apps/desktop/src/main/ota.ts` — daemon trial, reject, restore
- `apps/desktop/src/main/ota.test.ts` — cases above
- `apps/desktop/src/main/index.ts` — `connectDaemon`: report the outcome to `ota.ts`

Scope change (implementation and review): the keeper reports a failed replacement (`{ kind: 'failed' }`, `onFailed`), and `connectDaemon` no longer starts again after one. `stopDaemon` waits for the stopped daemon's process to end (it keeps `daemon.lock` until then), up to 30 s; before, "Restart now" over a busy daemon made the new one exit as "already running", which would have rejected a good bundle. Every `state.json` change runs one at a time. `scripts/ota-local.ts --broken-daemon` serves a daemon that exits at once.

**Done when:** a bundle whose daemon cannot start leaves the person on the previous bundle with their database as it was before that launch.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`.
**Commits:** None yet.

## Stage 7 — First launch fetches the newest bundle

**Depends on:** Stage 5.

**This stage:** When the chosen bundle is the app's own copy, the app checks the manifest with a ~3 s budget before opening any window. A newer compatible bundle is downloaded behind a small boot window with progress (an inline HTML page loaded as a `data:` URL, progress pushed from main), installed, and chosen; offline, a timeout, a failure, or 60 s without progress starts the app's own copy and the regular background check continues.

- [ ] Complete
  - [ ] Bounded manifest check before the first window
  - [ ] Boot window with progress
  - [ ] Install and re-choose before `protocol.handle`; fallback on every failure

**Files**

- `apps/desktop/src/main/bootWindow.ts` — create: the boot window and its progress; cannot live in `index.ts` because it is its own window with its own page
- `apps/desktop/src/main/ota.ts` — `check` with a time budget and progress callback
- `apps/desktop/src/main/ota.test.ts` — budget and fallback cases
- `apps/desktop/src/main/index.ts` — first-launch path before `protocol.handle`

**Done when:** a fresh install with network starts directly on the newest published bundle, and without network starts on its own copy within a few seconds.
**Verify:** `bun run typecheck && bun run test` in `apps/desktop`; local feed run with an empty updates folder.
**Commits:** None yet.
