# Clowdy

Working name. A local desktop app for running software work through agents: you chat with an orchestrator, it plans tasks and runs many agents in parallel, and you watch tasks, agents and project documents. Product spec: [`spec.md`](./spec.md) (older, partly superseded by [`.briefback/mvp/plan.md`](./.briefback/mvp/plan.md)); visual language: [`DESIGN.md`](./DESIGN.md).

How it fits together:

- **Daemon** (`apps/daemon`, Bun + SQLite) owns projects, chats, tasks, agent runs and documents. It runs on its own, outlives the app, and serves an HTTP + SSE API on loopback (`packages/protocol`).
- **Desktop app** (`apps/desktop`, Electron + React + Vite) is a client of the daemon. It starts or attaches to the daemon on launch.
- **Engine**: agents are Claude Code sessions through the Claude Agent SDK, on your own Claude login (no API key). Codex is planned.
- **System skills** (`packages/system-skills`) teach agents the delivery loop, scaffolding, and the autopilot and semi-manual modes.

## Requirements

- [Bun](https://bun.sh) 1.4+ and Node 22.12+
- Claude Code logged in with your subscription: run `claude auth login` once in a terminal. Clowdy never reads or stores the token. Without a login a run fails with a message that says so.
- `git` on your PATH (agents use it themselves).

## Start

```sh
bun install
./clowdy dev      # the app, rebuilt and reloaded as you edit (starts the daemon with the Claude engine)
./clowdy build    # unpacked app for this OS in apps/desktop/release/
```

`./clowdy build win` builds the Windows apps (x64, arm64) from any OS; a macOS build needs a Mac. Builds are unpacked and unsigned (ad-hoc signed on macOS). Where `./clowdy` cannot run, use `bun run clowdy dev`.

## Develop Clowdy with Clowdy

Run the app from `main` or `next`. Do the work in a worktree, then merge that branch back into the checkout the app is running from. That merge is what refreshes the open window.

1. Check out `main` or `next` and start the app from that folder: `./clowdy dev`.

2. In the app, select the Clowdy project (this folder). If it is not there yet: project select (top left) → **Add project…** → **Add folders…** → this folder → **Add project**.
3. On a new chat, open the menu under the message box and choose **New worktree**, or pick a worktree that already exists. One shared worktree is fine, and so is a separate one per task.
4. Work there, not in the folder `./clowdy dev` is running from. Describe the change in the chat. Pick *Semi-manual* in the composer if you want a question before a significant decision. Watch **Tasks**, **Agents**, and the **Docs** tab (`.clowdy/docs/`).
5. In the main folder, merge the worktree's branch into `main` or `next`. The renderer rebuilds and the window reloads a few seconds later. A change under `apps/desktop/src/main` restarts the window but not the daemon. A change to the daemon (`apps/daemon/src`, `packages/protocol/src`) replaces it when no run is in progress, and the window reconnects without a reload; while a run is in progress it waits. `CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop` stops it by hand (live runs then show as *Interrupted*; send a message in the chat to resume).

`CLOWDY_ENGINE=fake ./clowdy dev` plays a scripted demo without spending any quota. A daemon that is already running keeps the engine it started with, so stop it first (step 5) or the app attaches to it and its agents run on your subscription.

## Daemon

```sh
bun run --cwd apps/daemon start    # standalone, listens on 127.0.0.1 (random port, see daemon.json)
CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop
```

Data lives in `~/Library/Application Support/Clowdy[ Dev]/daemon` (macOS; `%LOCALAPPDATA%` on Windows): `clowdy.db`, `daemon.json` (port and token), `daemon.log`. Settings are environment variables; see [`apps/daemon/AGENTS.md`](./apps/daemon/AGENTS.md) for the list (engine, caps, permission mode, skills).

## Layout

```
apps/daemon           Daemon: HTTP + SSE API, SQLite, run runtime, engines, skills catalog, documents
apps/desktop          Electron app: src/main, src/preload, src/renderer, src/shared
packages/protocol     The contract between daemon and clients
packages/system-skills  The skills that ship with Clowdy (plugin "clowdy")
packages/components   Design system components
packages/styles       Tokens, reset, fonts
packages/icons        Icon packs
packages/lib, constants
```

Checks: `bun run lint`, `bun run typecheck`, `bun run test` (daemon tests run with `bun test`). The design system package has known failing tests inherited from Reforma.

Lint, formatting and import order are Biome (`biome.json`); `bun run lint:fix` in a package applies them. The repository was reformatted in one commit, which `git blame` skips once you run `git config blame.ignoreRevsFile .git-blame-ignore-revs` (GitHub reads the file by itself).

## License

Clowdy is licensed under the [Apache License 2.0](./LICENSE); see [`NOTICE`](./NOTICE) for what it is derived from and [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md) for the open source it is built with (`./clowdy licenses` writes that file). The name and the logo are not licensed: see [`TRADEMARKS.md`](./TRADEMARKS.md).

## Known limits

- macOS is the tested platform; Windows builds but was never run.
- Subscription login is for personal use on your own machine; shipping Clowdy to other people with subscription login needs Anthropic's approval (see `.briefback/mvp/research/claude-agent-sdk.md`).
- Many parallel agents share your plan's limits (five-hour and weekly windows, shared with your own Claude use). The scheduler caps live agents (default 6 Claude) and backs off when the engine reports limits.
