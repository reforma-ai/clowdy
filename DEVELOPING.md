# Developing Clowdy

See the [README](./README.md) for an overview of the product and the source setup. See [AGENTS.md](./AGENTS.md) and [GITFLOW.md](./GITFLOW.md) for repository conventions and [DESIGN.md](./DESIGN.md) for the visual language.

## Architecture

- **Daemon** (`apps/daemon`, Bun + SQLite) owns projects, chats, tasks, agent runs and documents. It runs independently of the desktop app and serves an HTTP + SSE API on loopback (`packages/protocol`).
- **Desktop app** (`apps/desktop`, Electron + React + Vite) starts or attaches to the daemon on launch.
- **Engine** (`apps/daemon/src/engine`) connects to installed agents over ACP, using adapters for Claude Code and Codex and native ACP where supported.
- **System skills** (`packages/system-skills`) teach agents the delivery loop, scaffolding, thread coordination and Hands-off and Hands-on modes.

## Build

```sh
bun install
./clowdy dev
./clowdy build
```

`./clowdy build win` builds the Windows apps (x64 and arm64) from any OS; a macOS build needs a Mac. Local builds are unpacked and unsigned (ad-hoc signed on macOS). Where `./clowdy` cannot run, use `bun run clowdy` with the same command. See [RELEASING.md](./apps/desktop/RELEASING.md) for installer distribution and signing.

## Develop Clowdy with Clowdy

Use a separate worktree when developing changes that should not affect the checkout running the app until they are ready.

1. Start the app from the checkout you want to run: `./clowdy dev`.
2. Select the Clowdy project. If it is missing, use the project selector to add this repository as a project folder.
3. In a new chat, select **New worktree** or pick an existing worktree from the composer.
4. Describe the change. Pick **Hands-on** if you want the agent to ask about significant decisions. Follow Tasks, Agents and Docs (`.clowdy/docs/`).
5. Merge the worktree's branch into the checkout the app runs from, following [GITFLOW.md](./GITFLOW.md). The renderer rebuilds and the window reloads a few seconds later. A change under `apps/desktop/src/main` restarts the window but not the daemon. A daemon or protocol change replaces the daemon when no run is in progress; the window reconnects.

Run `CLOWDY_ENGINE=fake ./clowdy dev` for a scripted demo without consuming model quota. A daemon that is already running keeps the engine it started with. To change the engine, stop the dev daemon first; stopping it interrupts active runs. Send a message in an interrupted chat to resume it.

## Daemon

```sh
bun run --cwd apps/daemon start
CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop
```

The standalone daemon listens on `127.0.0.1` on a random port (recorded in `daemon.json`). Data lives in `~/Library/Application Support/Clowdy[ Dev]/daemon` on macOS or under `%LOCALAPPDATA%` on Windows: `clowdy.db`, `daemon.json` (port and token) and `daemon.log`. See [daemon configuration](./apps/daemon/AGENTS.md) for environment variables and runtime settings.

## Repository layout

```text
apps/daemon             HTTP + SSE API, SQLite, run runtime, engines and documents
apps/desktop            Electron main, preload, renderer and shared code
packages/protocol       Contract between daemon and clients
packages/system-skills  Skills shipped with Clowdy
packages/components     Design system components
packages/file-manager   File tree and editor
packages/styles         Tokens, reset and fonts
packages/icons          Icon packs
packages/lib            Shared helpers
packages/constants      Shared constants
```

Run `bun run lint`, `bun run typecheck` and `bun run test`. Daemon tests use `bun test` from `apps/daemon` because they require Bun's runtime. Biome handles lint, formatting and import order; use `bun run lint:fix` in the relevant package to apply fixes, keeping edits limited to your own changes.

The repository was reformatted in one commit. To exclude it from blame locally, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

Parallel agent runs share the limits of the account they use. Concurrency and provider capabilities are described in [daemon configuration](./apps/daemon/AGENTS.md).

Regenerate the third-party credits with `./clowdy licenses` when production dependencies change.
