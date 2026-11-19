# Clowdy OTA: what Reforma's model covers and what the daemon adds

Facts are from the Clowdy source at `b1560d0` (see [clowdy-current.md](clowdy-current.md)) and Reforma's OTA (see [reforma-updates.md](reforma-updates.md)). Lines marked **Inference** are reasoning from those facts, not observed behavior. Options are listed as a decision space for the grill, not as a plan.

## Summary

- **Renderer OTA ports almost directly** from Reforma's front OTA: Clowdy already serves one renderer folder from `app://clowdy` chosen at startup. The new parts are the download shape (one archive instead of thousands of files), the lookup on GitHub, and a second compatibility axis: the renderer is a client of the **local daemon** (`PROTOCOL_VERSION`) as well as of the shell bridge.
- **Daemon OTA has no Reforma precedent.** Reforma's only runtime (the compiled bun "controller") ships inside the shell. Clowdy's daemon is a long-lived detached process that outlives the app, may be running agent work, owns a forward-only SQLite schema, and today is not shipped in a packaged app at all.
- **The building blocks for a daemon swap already exist** in dev: `daemonKeeper.restartIfStale()` (replace only when `activeRuns === 0`), `POST /v1/shutdown`, `ensureDaemon()`, and the `desktop:daemon-changed` IPC that moves open windows to the new daemon without a reload.

## Three parts and how they couple

| Part | Ships today | Talks to | Contract |
| --- | --- | --- | --- |
| Shell (Electron, main, preload) | unpacked app only | renderer via `window.desktop`; daemon via `daemon.json` + `/v1/health` | `DesktopBridge` (`src/shared/bridge.ts`), spawn contract `CLOWDY_BUN <entry>` (`daemon.ts`, `daemonHost.ts`) |
| Renderer (React, Vite) | inside the ASAR (`app/renderer`) | shell bridge; daemon over HTTP + SSE | bridge shape; `PROTOCOL_VERSION` (exact integer) and the routes/commands in `packages/protocol` |
| Daemon (Bun) | not shipped; dev runs `bun apps/daemon/src/main.ts` | agents (ACP adapters via `bun x`), SQLite, its own HTTP | `PROTOCOL_VERSION`; DB `user_version` (10 migrations, forward-only); needs a Bun runtime; reads system skills from a folder |

**Inference:** Reforma needed one compatibility number (shell version) because its backend API is always current. Clowdy has two runtime contracts that can drift on a user's machine: shell ↔ renderer (bridge) and renderer ↔ daemon (protocol), plus shell ↔ daemon (spawn contract, Bun version, data folder).

## Renderer OTA: mapping Reforma's pieces

| Reforma piece | Clowdy today | What carries over |
| --- | --- | --- |
| `ota.chooseFront()` before `protocol.handle` | `rendererRoot` is a module constant in `src/main/index.ts` | Same insertion point: choose the root in `whenReady` before `createProtocolHandler(root)` |
| Bundled manifest in ASAR (`front/manifest.json`, version + `minShell`) | none; `build.ts` writes only `app/package.json` | Build step writes it |
| Signed `front/manifest.json`, per-file SHA-256 | — | Signed manifest stays; payload becomes one archive (1,000-asset cap; dev renderer is 1,822 files), so either hash the archive and extract into staging, or hash per file after extraction (needed anyway if the protocol handler keeps checking each served file as Reforma's does) |
| `ready()` + 30 s rollback | bridge has no such call | Needs a bridge addition (a shell change) and a page call after first render |
| `onFrontUpdate` / `restartToUpdate` toast | — | Bridge additions plus renderer UI |
| `current.json` with `current/previous/rejected` | — | Same, under Electron `userData` |
| `minShell` gate | no shell version gate; `check-shell-version.ts` equivalent absent | Same rule, plus a CI check that shell-shipped files bump the shell version |
| Base URL `<host>/front/...` | — | GitHub lookup, see [github-releases-channel.md](github-releases-channel.md) |

New for Clowdy: a renderer built against protocol N cannot talk to a daemon on protocol M (the daemon rejects a mismatched `x-clowdy-protocol` major; the app refuses to attach). **Inference:** a renderer update must not land before the daemon it needs, and vice versa, unless both move together or the protocol becomes a range.

## Daemon OTA: constraints

**Process model**

- The daemon is spawned detached by main (`daemonHost.launch`, `setsid`, `unref`) and survives app quit and restarts; the app never stops it. Only the next app start launches a daemon that died (`index.ts`, `connectDaemon`).
- Stopping it: `POST /v1/shutdown` aborts live engines; their runs come back `interrupted` at the next start (`api.ts` route comment). Interrupted chats resume when the person sends a message (README).
- `Health.activeRuns` counts runs queued, running, waiting or blocked. The dev keeper swaps only at `activeRuns === 0` and re-asks every 5 s.
- **Inference:** a daemon update can only be applied while the app is running (nothing else would launch the new one), and only at an idle moment, or by explicit consent to interrupt work. An agent run can last hours, so "idle" may not come during a session.

**Shell update vs. running daemon (already a gap today)**

- After a shell update that changes `PROTOCOL_VERSION`, the new app finds the old daemon, refuses to attach, and shows a dialog telling the person to stop it (`acceptable()` in `daemon.ts`). Nothing replaces it. **Inference:** any release flow needs the app to replace an older daemon (keeper logic generalized beyond dev), whether or not the daemon is also updated OTA.

**Runtime and payload shape (options)**

| Shape | What an OTA download is | Facts that bear on it |
| --- | --- | --- |
| Bun executable shipped in the shell (`extraResources`) + daemon as bundled JS (`bun build --target=bun`, entries `main` and `mcp-stdio`) + system skills folder | JS + skills archive, small | `desktop/AGENTS.md` already sketches this ("ship a `bun` executable and the daemon's sources in `extraResources`"); `ensureDaemon` works unchanged with `CLOWDY_BUN` + entry; `process.execPath` stays a real bun, so `bun x` adapters and the MCP bridge keep working; Bun version changes only with the shell |
| `bun build --compile` daemon binary | an executable per OS/arch (85–90 MB) | `process.execPath` is the daemon itself; `bun x` and the MCP bridge need `BUN_BE_BUN=1` and an `mcp-bridge` subcommand; `ensureDaemon` launches with an entry argument today; macOS: the binary must be signed (see below) |
| Daemon sources + `node_modules` | a tree | Large, many files; no advantage found |

macOS signing of a downloaded executable (**inference, unverified**): files written by the app with `net.fetch` + `fs` do not get a quarantine attribute unless the app opts into `LSFileQuarantineEnabled`, so Gatekeeper's notarization check would not run on them; Apple silicon still requires every executable to carry a valid signature (ad-hoc at least), and a CI-built binary can be signed with the Developer ID in the workflow. Needs a test on a clean Mac before choosing the compiled shape for OTA. The JS-bundle shape avoids the question because nothing executable is downloaded.

**Data and rollback**

- Migrations are forward-only. `db/connection.ts` refuses a DB newer than the daemon ("Update the daemon") and writes `clowdy.db.bak-v<old>` before migrating.
- **Inference:** a Reforma-style automatic rollback to the previous daemon works only if the new daemon fails before migrating, or if rollback restores the backup and loses everything written since. A rollback trigger could be the new daemon not becoming healthy (writing `daemon.json` and answering `/v1/health`) within the existing 15 s start window.
- System skills are copied to `<dataDir>/system-skills/<hash>` at daemon start (`skills/materialize.ts`), so shipping skills with the daemon payload makes skill updates follow daemon updates. `CLOWDY_SYSTEM_SKILLS_DIR` is the override a packaged daemon would set.

**Other update paths already in the daemon**

- ACP adapters (`@agentclientprotocol/claude-agent-acp`, `codex-acp`) are fetched from npm by `bun x` at pinned versions in `engine/acp/catalog.ts`; changing a pin is a daemon change. The agent programs themselves (`claude`, `codex`, `cursor-agent`) are the user's own installs and update on their own.

**Where things live**

- Electron `userData` on macOS is `~/Library/Application Support/Clowdy`, and the daemon's data folder is `~/Library/Application Support/Clowdy/daemon` (`packages/protocol/src/paths.ts`), so on macOS the daemon folder sits inside `userData`. On Windows `userData` is `%APPDATA%\Clowdy` (Roaming) while the daemon uses `%LOCALAPPDATA%\Clowdy\daemon`. Linux: `~/.local/share/clowdy/daemon`. Installed OTA bundles need a home on each OS; Reforma used `userData/fronts/`.
- Dev runs use `Clowdy Dev` folders and must not install OTA payloads (Reforma turns OTA off without baked host and key).

## Compatibility designs to choose between (decision space)

1. **One OTA bundle** (renderer + daemon JS + skills from the same commit, one version number like Reforma's commit count) gated by `minShell`. Protocol skew between renderer and daemon disappears for OTA; the swap must happen at one moment (daemon idle, then app relaunch or renderer reload).
2. **Two OTA streams** with their own versions; the renderer manifest declares the protocol it needs, the daemon manifest the protocol it serves; the app installs only matching pairs. More moving parts; protocol is an exact integer today.
3. **Renderer OTA only**, daemon updated with the shell (as Reforma does with its toolchain), with the shell replacing an older daemon when idle. Smallest; daemon fixes wait for a shell release.

Each needs the same shell-side additions: a release host/feed baked at build, a pinned manifest key, an update state folder, a startup choice, a "restart to update" path, and a CI check that the shell version rises when shell-shipped files change.

## Open questions

- Is a daemon swap that interrupts runs ever acceptable, or must it wait for `activeRuns === 0` (possibly never during a long session)? Who is asked?
- Should the shell replace an older daemon automatically after a shell update (today it refuses and tells the person to stop it)?
- Is downloading an executable acceptable (compiled daemon, or Bun itself), or must executables only arrive inside the signed shell?
- Should the renderer keep Reforma's per-file hash check at serve time (needs per-file hashes in the manifest even if the payload is one archive)?
- Should `PROTOCOL_VERSION` become a range (min/max) to allow skew, or stay exact?
- What is the trial signal for a new daemon (health within N seconds? first successful snapshot?), and is DB-backup restore part of rollback?

## Assumptions and limits

- Nothing here was run. The daemon has never been bundled or compiled with its current ACP code; whether adapters run under a shipped Bun from another working directory is unverified (daemon AGENTS.md says the same).
- macOS behavior of executables written by the app (quarantine, signature checks) is from general platform knowledge, not tested here.
