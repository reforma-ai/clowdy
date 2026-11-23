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

1. `./clowdy dev`, then in the app: project select (top left) → **Add project…** → **Add folders…** → choose this repository → **Add project**.
2. **Chats** → **New chat**, and describe what you want changed. The orchestrator reads the repo and the docs, answers questions without touching anything, and for real work creates tasks and runs agents in parallel. Pick *Semi-manual* in the composer if you want it to ask you about significant decisions first.
3. Watch **Tasks** (board), **Agents** (the run tree and each agent's stream) and the **Docs** tab of the side panel (`.clowdy/docs/`, plain Markdown in the repo).
4. The renderer is rebuilt as agents edit it and the window reloads a few seconds later. A change under `apps/desktop/src/main` restarts the app window but not the daemon, so running work continues. A change to the daemon (`apps/daemon/src`, `packages/protocol/src`) is picked up by the app itself: when the daemon has no runs in progress it is replaced and the window reconnects without a reload; while runs are in progress it waits, so nothing is interrupted. `CLOWDY_PROFILE=dev bun run --cwd apps/daemon stop` stops it by hand (live runs then show as *Interrupted*; send a message in the chat to resume).
5. Agents edit this checkout directly unless they decide to work in a copy. The system skills tell them to use a copy for changes to Clowdy itself.

`CLOWDY_ENGINE=fake ./clowdy dev` plays a scripted demo without spending any quota. A daemon that is already running keeps the engine it started with, so stop it first (step 4) or the app attaches to it and its agents run on your subscription.

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

Checks: `bun run lint`, `bun run typecheck`, `bun run test` (daemon tests run with `bun test`). The design system package has known failing tests and lint errors inherited from Reforma.

## License

Clowdy is licensed under the [Apache License 2.0](./LICENSE); see [`NOTICE`](./NOTICE) for what it is derived from and [`THIRD-PARTY-LICENSES.md`](./THIRD-PARTY-LICENSES.md) for the open source it is built with (`./clowdy licenses` writes that file). The name and the logo are not licensed: see [`TRADEMARKS.md`](./TRADEMARKS.md).

## Known limits

- macOS is the tested platform; Windows builds but was never run.
- Subscription login is for personal use on your own machine; shipping Clowdy to other people with subscription login needs Anthropic's approval (see `.briefback/mvp/research/claude-agent-sdk.md`).
- Many parallel agents share your plan's limits (five-hour and weekly windows, shared with your own Claude use). The scheduler caps live agents (default 6 Claude) and backs off when the engine reports limits.
