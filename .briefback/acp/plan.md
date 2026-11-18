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
- An agent has a **launch** and a **detect**. ACP agents run their own binary (`cursor-agent acp`, `opencode acp`, `gemini --acp`, `copilot --acp`, `grok agent stdio`, `omp acp`, `hermes acp`). Codex has no ACP mode of its own, so it runs through the official adapter (`@agentclientprotocol/codex-acp`, version pinned in the catalog) started by the daemon's own Bun (`bun x --bun`, so Node is not needed) with `CODEX_PATH` set to the user's installed binary and optional dependencies omitted where `bun x` honors that, so no bundled agent is downloaded. The adapter is fetched on first use; that needs network, and `AgentInfo` says so. A native Codex engine on `codex app-server`, as bb and Orca do, is Stage 6 and replaces the adapter. The adapter's own Claude counterpart (`@agentclientprotocol/claude-agent-acp`) is not used: Claude has its native engine.
- Installed means found: the login-shell `PATH` (snapshot taken once, cached), common install folders, then a per-agent path override. A version probe (30 s cache) feeds `AgentInfo`. Logged-in state is not probed for every agent; a login failure at run time becomes a readable `not_logged_in` error that names the agent's own login command.
- Engine id and agent id are the same string. `EngineId` becomes `string`; the DB, `Run.engine`, `ProjectSettings.engine` and `run_spawn.engine` keep their names. A run on an agent that is missing fails with `engine_missing` and a message that says what to install.
- Permissions are answered by the daemon: every `session/request_permission` takes the first allow option (policy `allow`, the old `bypassPermissions` default); `CLOWDY_AGENT_PERMISSIONS=reject` refuses all.
- The runtime's tools reach the agent as an MCP server in `mcpServers`, stdio only (mandatory for every agent). The daemon runs a loopback bridge listener with a per-session token; the MCP server is `mcp-stdio.ts` started with the daemon's own `process.execPath` (so it works from source under Bun; a packaged daemon needs an `mcp-bridge` subcommand, not built) and forwards `tools/list` and `tools/call` to the listener. The agent's own `tool_call` for the runtime's tools is renamed to their bare name (`task_create`, not `mcp__clowdy__task_create`).
- The role's entry system skill (`orchestrate`, `executor`, `verify`) is inlined into the system prompt of every agent with the folder of the others, so any agent can read them as files; the first message loses its `/clowdy:` slash prefix and says `Follow clowdy:<skill>. Mode: ...`. The Claude engine still loads the system and user skills as plugins. Project and user skills are whatever each other agent discovers itself.
- On ACP, `send()` mid-turn queues the text and sends it as the next `session/prompt` after the current one; the turn ends (`done`) only when the queue is empty. No `_session/steering`. The Claude engine keeps streaming input.
- Native sub-agent events over ACP (unstable) are not requested: there a sub-agent is an ordinary tool call in the parent's stream. `NativeAgents` serves the Claude and fake engines.
- ACP usage: tokens from `PromptResponse.usage` when present; cost from the cumulative `usage_update.cost` (USD) minus the baseline kept per session in memory, none on the first turn of a resumed session. ACP limits: Claude's `_meta["_claude/rateLimit"]` on `usage_update` is read if an adapter sends it; every other ACP agent only has the reactive path through errors. The Claude engine keeps its own usage and rate limit events.
- An ACP agent's environment is the daemon's minus `CLOWDY_*` (the daemon token and old secrets), `ELECTRON_*`, `NODE_OPTIONS`, `CLAUDECODE`-style markers, plus the resolved login-shell `PATH`. The Codex entry also scrubs its provider keys (`OPENAI_API_KEY`, `CODEX_API_KEY`) so billing never silently leaves the login; a key the owner wants goes in that agent's own `env` setting. The Claude engine keeps its strict allowlist (`buildClaudeEnv`).
- Direction under test (owner, later the same day): one mechanism for every agent, so Claude and Codex also go over ACP through their official adapters and an agent's own sub-agent tools are switched off wherever the agent has a switch; delegation is Clowdy's `run_spawn` for all. The split decided above stays in force until Stage 6's live check passes.
- Direction under test (owner, later the same day): one mechanism for every agent, so Claude and Codex also go over ACP through their official adapters, and delegation is Clowdy's `run_spawn` for all. An agent's own sub-agents are discouraged in the prompt, not switched off (the switches exist if that changes: Claude `disallowedTools` `Agent`, `Task`, `ListAgents`; Codex `agents.enabled=false`). The split decided above stays in force until Stage 6's live check passes.
- Nested work has two kinds, shown in two different ways. `spawned` is Clowdy's own `run_spawn`: a real run with its own session, process and slot, for any agent, and the child may be another agent. It is the only kind in the chats-and-agents tree (`Run.parentRunId`), it is the delegation mechanism for every agent, and the system prompt says so. `native` is an agent's own `Agent` or `Task` tool, with no process or slot of its own. It is never a node of that tree: it is a card on the tool call that started it, in the parent's stream, with the call's name, input and final report, and expandable to what the child did where the agent reported it. Agents are asked to keep their own sub-agents for small read-only lookups, and when one overdoes it the card stream looks noisy, which is accepted. (The owner's reasons: dozens of sub-agents nested three deep would swamp the tree, and the two kinds have different powers: a `spawned` run can be talked to, a `native` one cannot.)
- Process control is the old ladder: leader of its own group, `session/cancel`, stdin close, SIGTERM, SIGKILL; the `process` event is synthesized from the spawn.
- Resume: `session/resume` when advertised, else `session/load` with replayed updates swallowed, else a fresh session. A failed resume also falls back to a fresh session with a warning.

**Reuse:** `runs/` unchanged (`RunDriver.consume`, `EngineLimits`, scheduler, wake-ups), `killProcessGroup` (now in `engine/process.ts`, shared), the Claude engine (`engine/claude/`) with a new `locate`, the `classifyFailure` helpers (copied and generalized in `engine/acp/failure.ts`), `parseLimit` (`runs/limits.ts`), the SQLite layout (no migration: `engine` is TEXT).

## Out of scope

- The settings UI for connecting and showing agents (the owner's next step), a login flow inside Clowdy, probing each agent's login state, the ACP registry download, MCP over ACP and HTTP MCP, `_session/steering`, native sub-agent events over ACP, ACP fs and terminal client methods, worktrees, cross-agent messaging, reading other tools' credential stores for quotas, shipping or bundling Node, Bun or any agent, and the native Codex (`codex app-server`) engine, which is the next step.
- Agents that ignore `mcpServers` (Pi) get no runtime tools; they can run but not orchestrate. Cursor needs its MCP approval file; not written here.

## Stage 1 — Open the engine set

**Depends on:** None.

**This stage:** `claude | codex | fake` is hard-coded in seven places, which cannot hold "any agent". This stage turns the engine id into a string and the caps and display names into data with defaults, keeping the Claude engine working so every test still passes.

- [x] Complete
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
**Commits:** `6fc8b66` feat(protocol): open the engine id to any agent and add the agents API (with the desktop fallbacks). The runtime side of this stage is in `88aa3b1`. The stages share files, so they landed as three commits (docs, protocol, daemon) instead of one per stage.

## Stage 2 — ACP engine

**Depends on:** Stage 1.

**This stage:** the ACP engine under `apps/daemon/src/engine/acp/` (it also gained `probe.ts` and `bun run probe`, a no-prompt check of an agent): the process-group spawn, the agent catalog with discovery, the ACP client session and its event mapper, the failure classifier, the permission policy and the stdio tool bridge. A scripted fake ACP agent (a separate Bun script using the SDK's agent side, which also acts as an MCP client against the bridge) drives the tests, so the whole chain runs without a real agent or network.

- [x] Complete
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
**Commits:** `88aa3b1` feat(daemon): run any installed agent over ACP next to the Claude engine (Stages 2 to 4 together; they share `engine/index.ts`, `registry.ts`, the docs and the tests).

## Stage 3 — Wire in the engines

**Depends on:** Stage 2.

**This stage:** `createEngines` returns the engines (lazily, one per agent id the registry knows: the Claude engine for `claude`, an ACP engine for the rest, programs found at run start), the Claude engine starts the user's own `claude`, prompts inline the entry skill, and the docs describe the new engines.

- [x] Complete
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
**Commits:** in `88aa3b1`, see Stage 2.

## Stage 4 — Agents API

**Depends on:** Stage 3.

**This stage:** the surface the owner's UI will use: `GET /v1/agents` returning each agent with its state, and commands to add a custom agent, set a path or arguments, enable or disable and refresh, with an `agents.changed` event.

- [x] Complete
  - [x] Protocol types `AgentInfo`, route and commands
  - [x] Daemon route and handlers over `AgentRegistry`
  - [x] `agents.changed` event

**Files**

- `packages/protocol/src/{domain,api,commands,events}.ts` — types, route, commands, event
- `apps/daemon/src/http/routes.ts`, `commands/*` — handlers
- `apps/daemon/test/agents-api.test.ts` — create

**Done when:** a client lists the agents installed on this machine and adds a custom one that then runs.
**Verify:** `bun test` in `apps/daemon`
**Commits:** the protocol part is in `6fc8b66`, the daemon part in `88aa3b1`.

## Stage 5 — Review and live check

**Depends on:** Stage 4.

**This stage:** a subagent review of the whole branch, fixes, and a live check of the real adapters on this machine (initialize and session setup without a model call; one trivial prompt only if the setup passes).

- [x] Complete
  - [x] Review findings fixed or reported (below)
  - [x] Live probe notes recorded in the research folder (`research/live-probe.md`)

**Review outcome.** A subagent reviewed the whole branch and fixed: a process leak when a run was cancelled while the agent was being found or spawned; `session/cancel` written after stdin was closed (now delivered, then stdin close, 1 s, SIGTERM, SIGKILL after 2 s); bridge calls with bad bodies (400 now) and calls left running at session end; `agent.update` wiping stored `enabled` and `env` with `undefined` fields; `agents.json` read strictly (now per entry, mode 0600, rolled back when it cannot be written, relative programs refused); version probe running with the daemon's secrets; a login shell holding its pipe hanging run start for ever; duplicated error-text code (`engine/error-text.ts`); unreachable `sessionMeta`; test hermeticity (`testAgents`) and three sleep-based tests. Then in the parent: a deadline of 120 s on `initialize`, `agent.update` refusing `env` for Claude (it runs with an environment of its own), a looser deadline in the login shell test (macOS was slow to run a script it had just written), and the default setting sources of the Claude engine.

**Left open, with how to fix:** the stdio MCP server needs the daemon to run from source under Bun (add an `mcp-bridge` subcommand to `main.ts` when packaging lands); `bun x` for the Codex adapter runs in the project folder so its `bunfig.toml` and `.npmrc` apply (start it from a neutral folder once `codex-acp` is confirmed to accept that); Windows (`taskkill`) is not checked; no real adapter or model call was run (see `research/live-probe.md`).

**Files**

- `.briefback/acp/research/live-probe.md` — create: results of the live check
- `apps/daemon/src/probe.ts`, `engine/acp/probe.ts` — create: `bun run probe`, so the owner can repeat the check on any agent

**Done when:** every unfixed finding is in front of the owner and the probe results are written down.
**Verify:** `bun run typecheck`, `bun run lint` and `bun test` in `apps/daemon` (502 pass), typecheck in `packages/protocol` and `apps/desktop`
**Commits:** the review fixes are in `88aa3b1`; the plan and research are in `7bc41d0`.

## Stage 6 — Every agent over ACP

**Depends on:** Stage 5. Stage 7 can go before or with it.

**This stage:** the owner wants one mechanism so every agent behaves alike, which turns the earlier split (native Claude, adapter for Codex) into a single path: Claude Code and Codex run through their official ACP adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`), started on the user's own `claude` and `codex` (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). What the native Claude engine gave beyond that is the sub-agents shown as child runs, which this stage replaces with a rule: delegation goes through Clowdy's `run_spawn` for every agent, and an agent's own sub-agent tools are switched off where it has a switch. Nothing is deleted until the live check passes; if an adapter falls short, the native engine for that agent stays (Claude) or is written (Codex on `codex app-server`).

- [ ] Complete
  - [ ] Live check of both adapters on this machine with `bun run probe` (no model call), then one trivial prompt each: text, a tool call, the runtime's tool through the bridge, cancel, resume, usage, and the user's own `~/.claude` and `~/.codex` login
  - [ ] Catalog: `claude` becomes a `package` launch like `codex`, with its own scrub list and login command
  - [ ] The system prompt tells every agent to delegate real work through `run_spawn` and to use its own sub-agents only for small read-only lookups
  - [ ] A sub-agent call is a card, for every agent: the tool item is marked as a sub-agent by its tool name (`Agent`, `Task`, `spawn_subagent`, `spawnAgent`), so the UI draws a card with name, input and final report. Nothing here depends on an unstable part of ACP
  - [ ] What a child did is an optional extra on that card, after the live check. Both adapters report sub-agents in one standard shape, only when the client opts in with `clientCapabilities.subagents: {}` (unstable; the SDK's `/unstable` entrypoint has the types): without it the Codex adapter hides child traffic and shows only its collaboration calls (`spawnAgent`, `wait`, `sendInput`, `closeAgent`), and the Claude adapter flattens it with `_meta.claudeCode.parentToolUseId` on each child tool call. With the opt-in:
    - `subagent_update` on the parent (child `sessionId`, `title`, `description` = the agent's role, `state` running, requires_action, idle with a stop reason or unknown, `capabilities.cancel`, `cwd`) becomes a `subagent` event, and `NativeAgents` writes a child run with `origin: 'native'`; the child's own `session/update`s arrive with the child's `sessionId` (today `AcpSession` drops any update that is not the root's), so each child gets its own `UpdateMapper` and its events carry `agentId`; the delegated task arrives as a `session_message`
    - the log is not a dead record: the daemon receives the child's text and tool calls live and stores them, so opening it reads our own copy, which survives a restart; it is read-only (a child cannot be prompted, only cancelled with its own `session/cancel`), and a stretch the daemon was not connected for is not refetched (`session/resume` does not replay; `session/load` does)
    - a child that goes idle is not finished (Codex reuses children and keeps them past the root turn), so `NativeAgents` stops closing every child when the parent's turn ends, and a child can go back to running
    - `Run` gains the id of the tool call that started a native child (the event carries `parentToolCallId`; it is not stored today), so the UI can hang the child under its card
    - the Claude adapter's `parentToolUseId` stays as the fallback if the opt-in proves unreliable; an agent that reports nothing (Cursor, OpenCode, Grok, ...) keeps the plain card
  - [ ] The switches that turn native sub-agents off (Claude `disallowedTools`, Codex config keys that differ by Codex version) stay available for a setting later, unused by default
  - [ ] Delete the native Claude engine, `NativeAgents` and the Claude-only settings once the check passes; keep `origin: 'native'` in the protocol only if some engine still reports it
  - [ ] `AGENTS.md`, the catalog and the tests describe the single path

**Done when:** a run on Claude and a run on Codex stream text and tools, call the daemon's tools, resume, report usage and are cancelled with their process groups gone, and a native sub-agent that Claude starts appears as a child with the tools it called.
**Verify:** `bun test` in `apps/daemon`; the live check above
**Commits:** None yet.

**Open:** the adapters are fetched with `bun x --bun` on first use (network, a third-party package at run time, and an assumption that they run under Bun); installing them into the daemon's data folder with `bun install --omit=optional` at the pinned version is the alternative, which also keeps optional agent binaries out. Decide when packaging lands. The Codex switch keys differ between Codex versions. Light helper agents (search or explore) are lost for every agent; a cheap `run_spawn` role for them is the answer if they are missed.

## Stage 7 — Steer or queue a message

**Depends on:** Stage 5. It can land before Stage 6.

**This stage:** a message typed while an agent works can steer the running turn or wait for the next one. Today the Claude engine always steers and the ACP engine always queues. The engine session takes the choice, says which it supports, and the chat command carries it.

- [ ] Complete
  - [ ] `EngineSession.send(text, mode)` with `'steer' | 'queue'`, and a way for an engine to say which it can do
  - [ ] Claude engine: steer pushes into the streaming input as now; queue holds the message until the turn ends
  - [ ] ACP engine: steer through `_session/steering` when `initialize` advertises `_meta.steering.supported`; queue as the next prompt; a steer an agent cannot do falls back to queue with a note in the run
  - [ ] The chat command takes an optional `mode`; the default is steer where supported
  - [ ] Tests on the fake engines (the fake ACP agent learns steering)

**Done when:** a message sent mid-turn reaches the Claude agent before its turn ends in steer mode and after it in queue mode, and the same for an ACP agent that advertises steering.
**Verify:** `bun test` in `apps/daemon`; `bun run typecheck` in `packages/protocol` and `apps/desktop`
**Commits:** None yet.
