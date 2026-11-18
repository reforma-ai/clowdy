# ACP agents

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** the daemon drives any coding agent the user has installed and logged in (Claude Code, Codex, Cursor, OpenCode, Gemini CLI, a custom command), and ships none of them.

**Approach:** Hybrid, as bb does it (the owner liked it when they saw bb's own build). Claude Code keeps its own engine on the Claude Agent SDK, now started on the user's installed `claude`, because the SDK reports sub-agents, quota signals and mid-turn messages that ACP carries only in part. Every other agent runs through one generic ACP engine. An agent is data (an id, how to detect it, how to launch it), not a class: a catalog of known agents plus custom ones from a JSON file in the data dir. The ACP engine spawns the agent as a process group, speaks ACP over stdio with `@agentclientprotocol/sdk`, maps `session/update` onto the existing `EngineEvent`s, so `runs/` is unchanged, and hands the runtime's tools to the agent as a stdio MCP server that calls back into the daemon. The owner builds the UI that connects and lists agents later; this plan only gives it the daemon surface (`GET /v1/agents` and commands).

**Decisions** (owner: decide alone, old code may be deleted, "it must work")

- Two engine kinds. `claude` is the Claude Agent SDK engine (kept, with its tests), pointed at the user's own `claude` found by the registry (`CLOWDY_CLAUDE_BIN` still overrides). Everything else is ACP. `fake` stays for demos and tests. The owner first asked for ACP everywhere, then said they like bb's split of native for Claude and Codex and ACP for the rest; research shows the same split in Orca. Later the owner weighed one ACP path for everything (one implementation, even behavior) against the split and settled on: Claude and Codex are the most used, so they get the best integration; every other agent is best effort over ACP. The Claude engine now applies the user's own Claude Code settings (`user,project,local` setting sources, as in a terminal); `CLOWDY_CLAUDE_SETTING_SOURCES` still narrows them.
- No agent is shipped. The SDK stays a dependency of the daemon but its bundled `claude` is never run; a packaged build must leave the SDK's optional platform package out (about 350 MB). The new dependency is `@agentclientprotocol/sdk` (pinned 2.7.0, `/unstable` entrypoint because per-turn `usage` is unstable and the engine advertises no unstable capability).
- An agent has a **launch** and a **detect**. ACP agents run their own binary (`cursor-agent acp`, `opencode acp`, `gemini --acp`, `copilot --acp`, `grok agent stdio`, `omp acp`, `hermes acp`). Codex has no ACP mode of its own, so it runs through the official adapter (`@agentclientprotocol/codex-acp`, version pinned in the catalog) started by `npx` with `CODEX_PATH` set to the user's installed binary and optional dependencies omitted, so no bundled agent is downloaded. The adapter is fetched on first use; that needs network and a package runner, and `AgentInfo` says so. A native Codex engine on `codex app-server`, as bb and Orca do, is Stage 6 and replaces the adapter. The adapter's own Claude counterpart (`@agentclientprotocol/claude-agent-acp`) is not used: Claude has its native engine.
- Installed means found: the login-shell `PATH` (snapshot taken once, cached), common install folders, then a per-agent path override. A version probe (30 s cache) feeds `AgentInfo`. Logged-in state is not probed for every agent; a login failure at run time becomes a readable `not_logged_in` error that names the agent's own login command.
- Engine id and agent id are the same string. `EngineId` becomes `string`; the DB, `Run.engine`, `ProjectSettings.engine` and `run_spawn.engine` keep their names. A run on an agent that is missing fails with `engine_missing` and a message that says what to install.
- Permissions are answered by the daemon: every `session/request_permission` takes the first allow option (policy `allow`, the old `bypassPermissions` default); `CLOWDY_AGENT_PERMISSIONS=reject` refuses all.
- The runtime's tools reach the agent as an MCP server in `mcpServers`, stdio only (mandatory for every agent). The daemon runs a loopback bridge listener with a per-session token; the MCP server is `mcp-stdio.ts` started with the daemon's own `process.execPath` (so it works from source under Bun; a packaged daemon needs an `mcp-bridge` subcommand, not built) and forwards `tools/list` and `tools/call` to the listener. The agent's own `tool_call` for the runtime's tools is renamed to their bare name (`task_create`, not `mcp__clowdy__task_create`).
- The role's entry system skill (`orchestrate`, `executor`, `verify`) is inlined into the system prompt of every agent with the folder of the others, so any agent can read them as files; the first message loses its `/clowdy:` slash prefix and says `Follow clowdy:<skill>. Mode: ...`. The Claude engine still loads the system and user skills as plugins. Project and user skills are whatever each other agent discovers itself.
- On ACP, `send()` mid-turn queues the text and sends it as the next `session/prompt` after the current one; the turn ends (`done`) only when the queue is empty. No `_session/steering`. The Claude engine keeps streaming input.
- Native sub-agent events over ACP (unstable) are not requested: there a sub-agent is an ordinary tool call in the parent's stream. `NativeAgents` serves the Claude and fake engines.
- ACP usage: tokens from `PromptResponse.usage` when present; cost from the cumulative `usage_update.cost` (USD) minus the baseline kept per session in memory, none on the first turn of a resumed session. ACP limits: Claude's `_meta["_claude/rateLimit"]` on `usage_update` is read if an adapter sends it; every other ACP agent only has the reactive path through errors. The Claude engine keeps its own usage and rate limit events.
- An ACP agent's environment is the daemon's minus `CLOWDY_*` (the daemon token and old secrets), `ELECTRON_*`, `NODE_OPTIONS`, `CLAUDECODE`-style markers, plus the resolved login-shell `PATH`. The Codex entry also scrubs its provider keys (`OPENAI_API_KEY`, `CODEX_API_KEY`) so billing never silently leaves the login; a key the owner wants goes in that agent's own `env` setting. The Claude engine keeps its strict allowlist (`buildClaudeEnv`).
- Process control is the old ladder: leader of its own group, `session/cancel`, stdin close, SIGTERM, SIGKILL; the `process` event is synthesized from the spawn.
- Resume: `session/resume` when advertised, else `session/load` with replayed updates swallowed, else a fresh session. A failed resume also falls back to a fresh session with a warning.

**Reuse:** `runs/` unchanged (`RunDriver.consume`, `EngineLimits`, scheduler, wake-ups), `killProcessGroup` (now in `engine/process.ts`, shared), the Claude engine (`engine/claude/`) with a new `locate`, the `classifyFailure` helpers (copied and generalized in `engine/acp/failure.ts`), `parseLimit` (`runs/limits.ts`), the SQLite layout (no migration: `engine` is TEXT).

## Out of scope

- The settings UI for connecting and showing agents (the owner's next step), a login flow inside Clowdy, probing each agent's login state, the ACP registry download, MCP over ACP and HTTP MCP, `_session/steering`, native sub-agent events over ACP, ACP fs and terminal client methods, worktrees, cross-agent messaging, reading other tools' credential stores for quotas, shipping or bundling Node, Bun or any agent, and the native Codex (`codex app-server`) engine, which is the next step.
- Agents that ignore `mcpServers` (Pi) get no runtime tools; they can run but not orchestrate. Cursor needs its MCP approval file; not written here.

## Stage 1 — Open the engine set

**Depends on:** None.

**This stage:** `claude | codex | fake` is hard-coded in seven places, which cannot hold "any agent". This stage turns the engine id into a string and the caps and display names into data with defaults, keeping the Claude engine working so every test still passes.

- [ ] Complete
  - [x] `EngineId` is `string` in the protocol; commands, `run_spawn` and settings accept any id
  - [x] `engineCaps` has a default for engines without an entry; limits and names work for unknown ids
  - [x] `SkillEngine` stops being derived from `EngineId`

**Files**

- `packages/protocol/src/domain.ts` — `EngineId`
- `packages/protocol/src/commands.ts` — `engine` zod enum becomes a string
- `packages/protocol/src/skills.ts` — `SkillEngine` literal union
- `apps/daemon/src/config.ts` — `engineCaps`, `ENGINES` check, `defaultEngineCap`
- `apps/daemon/src/runs/limits.ts` — `NAMES`, `EngineLimits` caps lookup
- `apps/daemon/src/runs/run-tools.ts` — `engine` enum in `run_spawn`
- `apps/daemon/src/daemon.ts`, `runs/driver.ts`, `runs/service.ts`, `engine/types.ts` — engine registry type
- `apps/desktop/src/renderer/features/settings/EnginePage.tsx` — `ENGINE_NAMES` lookup

**Done when:** an unknown engine id is accepted end to end and the existing suite passes.
**Verify:** `bun run typecheck` and `bun run test` in `apps/daemon`, `bun run typecheck` in `apps/desktop`
**Commits:** None yet. Implemented, verified and staged in the working tree; the commit is blocked because the SSH signing agent (Secretive) refuses without the owner. Planned split: this stage alone.

## Stage 2 — ACP engine

**Depends on:** Stage 1.

**This stage:** the ACP engine under `apps/daemon/src/engine/acp/` (it also gained `probe.ts` and `bun run probe`, a no-prompt check of an agent): the process-group spawn, the agent catalog with discovery, the ACP client session and its event mapper, the failure classifier, the permission policy and the stdio tool bridge. A scripted fake ACP agent (a separate Bun script using the SDK's agent side, which also acts as an MCP client against the bridge) drives the tests, so the whole chain runs without a real agent or network.

- [ ] Complete
  - [x] Process spawn in its own group, environment build, login-shell `PATH`, command resolution with version probe
  - [x] Catalog of known agents plus custom agents file; `AgentRegistry.list()` with detection
  - [x] `AcpEngine` / `AcpSession`: initialize, new/resume/load, model, prompt queue, cancel, close
  - [x] `session/update` mapping: text, tool, usage, limit, `done`, errors, plan/thought dropped
  - [x] Tool bridge listener, `mcp-stdio` MCP server, bare names for the runtime's own tools in the stream
  - [x] Tests on the fake ACP agent

**Files**

- `apps/daemon/src/engine/process.ts` — create: generic spawn-in-own-group, shared with the Claude engine
- `apps/daemon/src/engine/acp/env.ts`, `discovery.ts`, `catalog.ts`, `registry.ts` — create
- `apps/daemon/src/engine/acp/engine.ts`, `session.ts`, `mapper.ts`, `failure.ts` — create
- `apps/daemon/src/engine/acp/bridge.ts`, `mcp-stdio.ts` — create: listener and the MCP stdio server entry
- `apps/daemon/test/acp-*.test.ts`, `test/fake-acp-agent.ts` — create

**Done when:** a run of the real run runtime on the fake ACP agent streams text and tool calls, calls the daemon's tools through the bridge, resumes a session, and is cancelled with its process group gone.
**Verify:** `bun test` in `apps/daemon`
**Commits:** None yet. Implemented, verified and staged in the working tree; the commit is blocked because the SSH signing agent (Secretive) refuses without the owner. Planned split: this stage alone.

## Stage 3 — Wire in the engines

**Depends on:** Stage 2.

**This stage:** `createEngines` returns the engines (lazily, one per agent id the registry knows: the Claude engine for `claude`, an ACP engine for the rest, programs found at run start), the Claude engine starts the user's own `claude`, prompts inline the entry skill, and the docs describe the new engines.

- [ ] Complete
  - [x] `createEngines` and `CLOWDY_ENGINE` select any agent id; the fake engine stays registered
  - [x] `prompts.ts` builds the system prompt with the inlined entry skill; first message loses `/clowdy:`
  - [x] The Claude engine finds the user's `claude` (`locate`) and still passes its tests
  - [x] `apps/daemon/AGENTS.md` describes the engines, the agents and their settings

**Files**

- `apps/daemon/src/engine/index.ts` — `createEngines`
- `apps/daemon/src/runs/prompts.ts`, `runs/driver.ts` — `systemPrompt`, `firstMessage`
- `apps/daemon/src/engine/claude/*` — kept; gains `locate` so it starts the user's `claude`
- `apps/daemon/package.json`, `bun.lock` — dependency
- `apps/daemon/AGENTS.md`, `apps/desktop/scripts/dev.ts` — docs and the dev default

**Done when:** `CLOWDY_ENGINE=claude` starts a daemon whose Claude engine starts the owner's installed `claude`, and `CLOWDY_ENGINE=cursor` one that runs `cursor-agent acp`.
**Verify:** `bun test` in `apps/daemon`; a live handshake (no model call) against each agent installed here
**Commits:** None yet. Implemented, verified and staged in the working tree; the commit is blocked because the SSH signing agent (Secretive) refuses without the owner. Planned split: this stage alone.

## Stage 4 — Agents API

**Depends on:** Stage 3.

**This stage:** the surface the owner's UI will use: `GET /v1/agents` returning each agent with its state, and commands to add a custom agent, set a path or arguments, enable or disable and refresh, with an `agents.changed` event.

- [ ] Complete
  - [x] Protocol types `AgentInfo`, route and commands
  - [x] Daemon route and handlers over `AgentRegistry`
  - [x] `agents.changed` event

**Files**

- `packages/protocol/src/{domain,api,commands,events}.ts` — types, route, commands, event
- `apps/daemon/src/http/routes.ts`, `commands/*` — handlers
- `apps/daemon/test/agents-api.test.ts` — create

**Done when:** a client lists the agents installed on this machine and adds a custom one that then runs.
**Verify:** `bun test` in `apps/daemon`
**Commits:** None yet. Implemented, verified and staged in the working tree; the commit is blocked because the SSH signing agent (Secretive) refuses without the owner. Planned split: this stage alone.

## Stage 5 — Review and live check

**Depends on:** Stage 4.

**This stage:** a subagent review of the whole branch, fixes, and a live check of the real adapters on this machine (initialize and session setup without a model call; one trivial prompt only if the setup passes).

- [ ] Complete
  - [x] Review findings fixed or reported (below)
  - [x] Live probe notes recorded in the research folder (`research/live-probe.md`)

**Review outcome.** A subagent reviewed the whole branch and fixed: a process leak when a run was cancelled while the agent was being found or spawned; `session/cancel` written after stdin was closed (now delivered, then stdin close, 1 s, SIGTERM, SIGKILL after 2 s); bridge calls with bad bodies (400 now) and calls left running at session end; `agent.update` wiping stored `enabled` and `env` with `undefined` fields; `agents.json` read strictly (now per entry, mode 0600, rolled back when it cannot be written, relative programs refused); version probe running with the daemon's secrets; a login shell holding its pipe hanging run start for ever; duplicated error-text code (`engine/error-text.ts`); unreachable `sessionMeta`; test hermeticity (`testAgents`) and three sleep-based tests. Then in the parent: a deadline of 120 s on `initialize`, `agent.update` refusing `env` for Claude (it runs with an environment of its own), a looser deadline in the login shell test (macOS was slow to run a script it had just written), and the default setting sources of the Claude engine.

**Left open, with how to fix:** the stdio MCP server needs the daemon to run from source under Bun (add an `mcp-bridge` subcommand to `main.ts` when packaging lands); `npx` for the Codex adapter runs in the project folder so its `.npmrc` applies (start it from a neutral folder once `codex-acp` is confirmed to accept that); Windows paths (`npx.cmd`, `taskkill`) are not checked; no real adapter or model call was run (see `research/live-probe.md`).

**Files**

- `.briefback/acp/research/live-probe.md` — create: results of the live check
- `apps/daemon/src/probe.ts`, `engine/acp/probe.ts` — create: `bun run probe`, so the owner can repeat the check on any agent

**Done when:** every unfixed finding is in front of the owner and the probe results are written down.
**Verify:** `bunx turbo run lint typecheck test --affected`
**Commits:** None yet.

## Stage 6 — Native Codex engine

**Depends on:** Stage 5.

**This stage:** Codex gets an engine of its own on `codex app-server`, as bb and Orca have, so the most used agents are both integrated first-hand. The adapter entry stays in the catalog until this lands, and a live `bun run probe codex` of the adapter tells what the native engine must at least match.

- [ ] Complete
  - [ ] Research: the app-server protocol (handshake, turns, approvals, usage and rate limits, resume, MCP tools) read from its schema, with bb's `plugins/provider-codex` and Orca's `src/main/codex/app-server/` as references
  - [ ] `engine/codex/` engine on the user's `codex`, events mapped onto `EngineEvent`, process group and cancel as for the others
  - [ ] Runtime tools reach Codex (MCP stdio through the bridge, or app-server dynamic tools if they are the better fit)
  - [ ] Tests on a scripted app-server; `AGENTS.md` and the catalog updated; adapter entry removed

**Done when:** a run on Codex streams text and tools, calls the daemon's tools, resumes, reports usage and limits, and is cancelled with its process group gone, without `npx`.
**Verify:** `bun test` in `apps/daemon`; a live handshake against the installed `codex` (no model call)
**Commits:** None yet.
