# Clowdy today: build, packaging, daemon, renderer loading, versions, CI

Read on 2026-11-18 at commit `b1560d0` on `main` (clean tree). Nothing was built or run for this page; sizes come from build output already on disk.

## Summary

- **No CI exists.** There is no `.github/` directory. `GITFLOW.md` describes a `ci.yml` with a required `ci-ok` check, Cursor Bugbot, and changesets for published packages; that text was inherited from Reforma and describes nothing that exists here (Clowdy's `AGENTS.md` has no Changesets section, and there is no `.changeset/`).
- **The repository is private on a GitHub Free personal account** (`kachurun/clowdy`): `gh repo view` reports `"visibility":"PRIVATE"`, and the rulesets and branch-protection APIs answer 403 "Upgrade to GitHub Pro or make this repository public to enable this feature". No tags, no releases, no environments exist.
- **Packaging is unpacked only:** `./clowdy build [mac|win]` → `electron-builder --dir`; macOS ad-hoc signed with hardened runtime off; Windows unsigned. No installers, no `publish` config, no `electron-updater` dependency, no update code.
- **A packaged app has no daemon.** `ensureDaemon` needs `CLOWDY_BUN` and `CLOWDY_DAEMON_ENTRY` and otherwise throws "Daemon is not bundled in this build". Only `./clowdy dev` sets them. So any release build first needs the daemon (and a Bun to run it) shipped inside the app.
- **The renderer is served by main from `app://clowdy`** out of one folder chosen at startup (`app/renderer` in the ASAR, `dist/renderer` in dev). That is the same shape Reforma had before its OTA; swapping the root at startup is a small change.
- **The daemon is a separate long-lived process that outlives the app**, found through `<dataDir>/daemon.json`, version-checked by a protocol integer. A dev-only "keeper" already replaces a stale daemon when it is idle, which is the mechanism a daemon OTA would reuse.

## Build and packaging

- `./clowdy` (bash wrapper) → `scripts/cli.ts`: `dev` → `bun run dev` in `apps/desktop`; `build [mac|win]` → `bun run package` or `package:win` (mac refuses on a non-Mac host); `worktree add|remove`.
- `apps/desktop/package.json`: `productName: "Clowdy Dev"`, `version: "0.0.1"`, `main: dist/main/index.cjs`; `electron` pinned `45.2.1`, `electron-builder ^26.18.0`. Scripts: `build:app` = `bun scripts/build.ts`; `package` = build + `electron-builder --mac --dir -c.mac.identity=- -c.mac.hardenedRuntime=false`; `package:win` = build + `electron-builder --win --dir --x64 --arm64`.
- `apps/desktop/scripts/build.ts` — `turbo run build --filter=@clowdy/desktop^...` (workspace deps; only `@clowdy/icons` has a `build` script), `vite build` of the renderer into `app/renderer` (`NODE_ENV=production`), `buildMain()` into `app/dist`, then writes `app/package.json` with `productName: "Clowdy"`, the same `version`, `author: "Clowdy"`. **No build-time constants** are baked in (no release host, no keys); compare Reforma's `define` block.
- `apps/desktop/scripts/main-bundle.ts` — `buildMain(outdir)`: `Bun.build` of `src/main/index.ts` and `src/preload/index.ts` to CommonJS, `external: ['electron']`, unminified.
- `apps/desktop/electron-builder.ts` — `appId: app.clowdy.desktop`, `productName: Clowdy`, `directories.app: app`, `files: ['package.json','dist/**','renderer/**','!node_modules/**']`, `asar: true`, `npmRebuild: false`, the same fuses as Reforma (runAsNode off, ASAR integrity and only-load-from-ASAR on, cookie encryption on). `mac`: `hardenedRuntime: true`, `entitlements` and `entitlementsInherit` both `build/entitlements.mac.plist` (allow-jit, allow-unsigned-executable-memory only), `notarize: false`, **no `target`** (so only `--dir` is meaningful today), icon `build/icon.png` (placeholder). `win`: icon only. `nsis`: oneClick, per-user, no admin (ready for an installer). **No `publish`, no `extraResources`.**
- `apps/desktop/AGENTS.md` Traps: identity (`app.clowdy.desktop`, `Clowdy` / `Clowdy Dev` folders) "follow the working name. Settle them before a first release: updates and stored data depend on them."
- Measured on disk: `release/mac-arm64/Clowdy.app` is 257 MB (arm64 only; `package` builds the host arch). `app/renderer` from a 17 Nov production build was 6 files / 384 KB, but the current dev build `dist/renderer` has 1,822 files / 186 MB (unminified, many lazy chunks). The current production file count was not measured. It matters for GitHub Releases (1,000 assets per release).

## How the renderer is loaded

- `src/main/index.ts`: `rendererRoot = app.isPackaged ? <appPath>/renderer : CLOWDY_RENDERER_DIR ?? <appPath>/dist/renderer`, fixed at module load. `protocol.handle('app', createProtocolHandler(rendererRoot))` once `whenReady`.
- `src/main/protocol.ts` — `createProtocolHandler(root)`: host must be `clowdy`; resolves the file, its `index.html`, or the root `index.html` for extension-less routes; `realpath` check keeps reads inside the root; sets one CSP header (`connect-src` allows `http://127.0.0.1:*` and `ws://127.0.0.1:*` for the daemon). No per-file hash check (nothing outside the signed ASAR is served today).
- Dev: `scripts/dev.ts` runs `vite build --watch` into `dist/renderer` and writes `.dev-build`; main watches for it and reloads windows. No dev server, no HMR.
- `src/shared/bridge.ts` — `DesktopBridge`: `platform`, `material`, `setThemeSource`, `daemon?: { url, token }`, `onDaemonChange`, `chooseDirectory`. No update calls, no `ready()`. `IPC_CHANNELS` has `daemonChanged` (main → renderer), already used to move the renderer to a replaced daemon without a reload.
- `src/main/menu.ts` — role-based default menu; no "Check for Updates…".
- `src/main/security.ts` — `hasLaunchSwitches(argv)` refuses **any** `-x` (and `/x` on Windows) in a packaged app. Reforma allows `--updated`, which the NSIS updater passes after an update; Clowdy would refuse to start after an NSIS update until this is changed.

## How the daemon ships and runs

- `apps/daemon` (`@clowdy/daemon`, `version: "0.0.1"`): Bun only (`bun:sqlite`, `Bun.serve`, `Bun.spawn`). Run as `bun src/main.ts` from the checkout; dependencies resolve from the repo's `node_modules` (`@agentclientprotocol/sdk` 2.7.0, `zod`, `@clowdy/protocol` as TS source). No bundling step exists.
- Runtime path dependencies that break when bundled or compiled:
  - `src/skills/materialize.ts` defaults the system skills source to `new URL('../../../../packages/system-skills', import.meta.url)`; `CLOWDY_SYSTEM_SKILLS_DIR` overrides it. The skills are copied to `<dataDir>/system-skills/<hash>` at start, so a skills change takes effect on daemon restart.
  - `src/engine/acp/bridge.ts` starts the per-session MCP bridge as `process.execPath ./mcp-stdio.ts` (`MCP_ENTRY` from `import.meta.url`). `mcp-stdio.ts` has no imports, so it bundles as a second entry. The daemon's own AGENTS.md notes a compiled daemon "needs an `mcp-bridge` subcommand in its entry point, or the file shipped beside it".
  - `src/engine/acp/registry.ts` runs ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, pinned in `catalog.ts`) with `bun x --bun <pkg>@<version>` using `process.execPath` when the daemon runs on Bun. Adapters are fetched from npm on first use. In a `bun build --compile` binary `process.execPath` is the daemon itself, so it would need `BUN_BE_BUN=1` (Reforma's controller does exactly this for its `bun`/`bunx` wrappers).
- Startup contract (`apps/desktop/src/main/daemon.ts`): `findRunning()` reads `<dataDir>/daemon.json` and probes `GET /v1/health` (800 ms, `node:http`); attach if the pid matches and `health.protocol === PROTOCOL_VERSION`. Otherwise `startDaemon()` spawns `CLOWDY_BUN CLOWDY_DAEMON_ENTRY` detached (`setsid`, `unref`, stdio → `daemon.log`, `windowsHide`), cwd = parent of the entry's folder, env = the app's minus `ELECTRON_*`, plus `CLOWDY_DATA_DIR` and login-shell `PATH`; waits up to 15 s. A running daemon of another protocol is **neither attached nor replaced**: a `DaemonError` dialog tells the person to stop it.
- `src/main/daemonHost.ts` — `launch()` spawns `[bun, entry]`; `stop()` sends `POST /v1/shutdown`.
- `src/main/daemonKeeper.ts` — dev only (`CLOWDY_DAEMON_WATCH`): `restartIfStale()` compares source mtimes with `health.startedAt`; if stale and `health.activeRuns === 0`, `stopDaemon()` then `ensureDaemon()` and `onRestarted` → `desktop:daemon-changed` to every window, whose `HttpTransport.setAddress` resumes the SSE feed from its cursor (no reload, no lost draft). Busy daemons are re-asked every 5 s. "A packaged app never does this."
- The app never stops the daemon on quit; the daemon outlives app restarts. A daemon that dies while the app runs is restarted only by the next app start.
- `apps/desktop/AGENTS.md` "Packaged app (not built yet)" records the intended shape: ship a `bun` executable and the daemon's sources in `extraResources` (outside the ASAR, signed with Bun's JIT entitlements) and set the two variables from `process.resourcesPath`; a `bun build --compile` binary instead would need `ensureDaemon` to launch without an entry argument.
- `.briefback/mvp/research/daemon-runtime.md` (2026-11-17): Bun is the runtime; `bun build --compile` output is 85–90 MB; in a compiled binary `process.execPath` is the daemon and `spawn(process.execPath, ...)` recursed; `runAsNode: false` rules out running the daemon on Electron's Node; `utilityProcess` cannot outlive the app; Bun recommends five macOS entitlements for compiled binaries while the repo's plist has two. Written before the switch to ACP, so its SDK-binary notes are partly superseded.

## Versions and contracts

| What | Where | Value now | Used for |
| --- | --- | --- | --- |
| Desktop shell | `apps/desktop/package.json` `version` | `0.0.1` | `app.getVersion()`; copied into `app/package.json` by `build.ts` |
| Daemon | `apps/daemon/package.json` `version` | `0.0.1` | `Health.version` (imported in `src/daemon.ts`) |
| Protocol | `packages/protocol/src/api.ts` `PROTOCOL_VERSION` | `1` | `daemon.json`, `Health.protocol`, `x-clowdy-protocol` header; the daemon refuses another major (`http/guard.ts`, `http/server.ts`); the app refuses to attach to another (`daemon.ts`) |
| Database schema | `apps/daemon/src/db/migrations.ts` | 10 migrations | `PRAGMA user_version`; `db/connection.ts` refuses a DB **newer** than the daemon ("Update the daemon") and backs up to `clowdy.db.bak-v<n>` before migrating |
| Package manager | root `package.json` `packageManager` | `bun@1.4.4` | (Reforma CI pins 1.4.0) |
| Node | root `engines` | `>=22.12` | Vitest and electron-builder run on Node |
| Other packages | `@clowdy/icons` 0.2.0, `system-skills` 0.1.0, rest 0.0.0 | — | private, unpublished |

Consequences (inference): a daemon downgrade after a migration cannot open the DB; the protocol integer is all-or-nothing (no ranges), so any app/daemon skew across a major bump leaves the app unable to attach.

## Checks a CI would run

- Root scripts: `bun run lint` (`turbo run lint && eslint scripts`), `bun run typecheck` (`turbo run typecheck && tsc --noEmit -p scripts`), `bun run test` (`turbo run test`). Daemon tests are `bun test` (Bun runtime); others are Vitest.
- `turbo.json`: `test`, `lint`, `typecheck` depend on `^build`; `globalPassThroughEnv: ["*"]`; cache dir `.turbo/cache`.
- README: "The design system package has known failing tests and lint errors inherited from Reforma." Not re-checked here; a CI gate needs a skip list or a fix first (Reforma's `ci-plan.ts` has per-task skip lists).
- Root `bunfig.toml` has `minimumReleaseAge = 259200`; it does not affect `bun install --frozen-lockfile`.
- `GITFLOW.md` already names the intended local equivalent: `bunx turbo run build lint typecheck test --affected`.

## Policy context

- README "Known limits": macOS is the tested platform; Windows builds but was never run. Subscription login is personal use on your own machine; shipping Clowdy to other people with subscription login needs Anthropic's approval (`.briefback/acp/research/policy.md`).
- `.briefback/mvp/plan.md` listed "auto-update, installers and signing" as out of MVP scope.
- `spec.md` is referenced by AGENTS.md and README but is not in the tree (untracked by commit `9c9d743`).

## Relevant files

- `scripts/cli.ts` — `./clowdy` commands.
- `apps/desktop/scripts/build.ts`, `main-bundle.ts`, `dev.ts` — release build, main bundle, dev loop.
- `apps/desktop/electron-builder.ts`, `apps/desktop/build/entitlements.mac.plist`, `build/icon.png` — packaging.
- `apps/desktop/src/main/index.ts` — startup order: protocol, IPC, keeper, `ensureDaemon`, window.
- `apps/desktop/src/main/protocol.ts` — renderer serving.
- `apps/desktop/src/main/daemon.ts`, `daemonHost.ts`, `daemonKeeper.ts`, `daemonProbe.ts` — daemon find/start/stop/replace.
- `apps/desktop/src/main/security.ts` — `hasLaunchSwitches`, fuses-related invariants.
- `apps/desktop/src/shared/bridge.ts`, `src/preload/` — bridge.
- `apps/daemon/src/main.ts`, `daemon.ts`, `config.ts`, `http/routes.ts` (`/v1/health`), `db/connection.ts`, `skills/materialize.ts`, `engine/acp/{bridge,registry,catalog}.ts`.
- `packages/protocol/src/api.ts` (`PROTOCOL_VERSION`, `Health`, `DaemonInfo`), `paths.ts` (`daemonDataDir`).

## Assumptions and limits

- No build, package, lint, or test was run. The "known failing" design-system checks are taken from the README.
- The production renderer's file count today is unknown (only the stale 17 Nov build and the dev build were measured).
- Whether the ACP adapters run under a bundled or compiled Bun is unverified (the daemon's AGENTS.md says no adapter has been run there).
- The account plan is inferred from the 403 messages on the rulesets and protection APIs; `gh api user` returned `plan: null`.
