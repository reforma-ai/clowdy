# Giving agents the runtime's tools over ACP (MCP transports, quirks, what bb and Orca do)

Snapshot 2026-11-17. Clowdy side: `apps/daemon/src/engine/types.ts` (`ToolDefinition`), `engine/claude/tools.ts`, `runs/{tools,tool-kit,run-tools,task-tools}.ts`. ACP side: `docs/protocol/v1/session-setup.mdx` and the two Zed adapters (`claude-agent-acp@3205f0b`, `codex-acp@b9503ae`). References: bb `packages/provider-bridge-acp/src/bridge/{tool-proxy-mcp,bridge,cursor-mcp-approval}.ts@f1c5304`; Orca `src/main/acp/**@cbc8119e` and `skill-guides/orchestration.md@cbc8119e`. Observed = read in source; inferred = my reading; nothing here was run against a live agent.

## Summary

- Over ACP the only agent-agnostic way to hand an agent callable tools is **an MCP server named in `session/new.mcpServers`**. ACP itself has no tool-registration method. Per the spec: **stdio is mandatory for every agent**; HTTP and SSE are optional and advertised as `agentCapabilities.mcpCapabilities.http|sse`; `type: "acp"` (MCP over the ACP connection) is unstable.
- Today's tools are **run-scoped closures** (`toolsFor(deps, run, mode)` captures the run) and results are text. Any MCP endpoint must therefore carry a per-run identity (token) and answer for exactly that run's tool set.
- The three ways to host the server differ in what each agent must support, in extra processes, and in secrets exposure (table below). **bb uses the stdio route with a loopback callback.** **Orca injects no tools** (passes `mcpServers: []`) and gives agents a CLI plus a skill instead. bb also uses a CLI plus skill for cross-thread messaging.
- Not every agent connects to MCP servers it is handed: the Pi adapter accepts the list and does nothing with it (adapter README, fetched 2026-11-17); Cursor needs the server approved on disk; Codex starts MCP servers after `session/new` returns unless told to wait.

## What has to be exposed

`ToolDefinition { name, description, inputSchema (JSON Schema), schema (zod), execute(input, signal) }`. Tools by role (`apps/daemon/AGENTS.md` "Tools"): orchestrator `task_create`, `task_update`, `task_list`, `task_get`, `run_spawn`, `run_inspect`, `run_wait`, `run_cancel`, `ask_user` (semi-manual chats only); executor and verifier `task_get`, `task_list`, `task_update`, `report_result`. `run_wait` blocks up to 60 s; `report_result` ends the run's work and triggers the close ladder. Results go to the model as text (non-string results as JSON, `undefined` as "ok"); a thrown error becomes an `isError` result with the message (`engine/claude/tools.ts` `callTool`, `resultText`).

## Hosting options

| Option | What the agent connects to | Agents that can use it | Extra process? | Per-run identity | Secrets exposure | Costs and risks |
| --- | --- | --- | --- | --- | --- | --- |
| **stdio bridge** | `{ command: <absolute path>, args, env[] }` in `mcpServers`; the agent spawns it and speaks MCP on its stdin/stdout. The bridge forwards each call to the daemon (loopback HTTP or socket). | All ACP agents by spec (mandatory) **[subject to the agent actually wiring it: Pi does not]** | Yes: one small process per agent session | Token and run id in the bridge's `env` | `env` values are credentials in the spec's words; agents may put them on a command line (claude-agent-acp does when the user's own CLI is used via `CLAUDE_CODE_EXECUTABLE`: "MCP servers on its command line, where other users of the machine can read their `env` and `headers`") | A launchable executable is needed (a compiled binary, or the daemon re-invoked as `bun <script> --mcp-stdio`); Windows path and quoting; one more process to clean up in the kill ladder; agent has to start it (startup race, see quirks) |
| **loopback HTTP MCP** (daemon route) | `{ type: "http", url, headers[{name,value}] }` pointing at the daemon | Agents advertising `mcpCapabilities.http` (Claude adapter yes, Codex adapter yes per READMEs; Cursor, Gemini, others not verified) | No | Per-run token in a header or in the URL path | Header value is a credential; spec says agents should send headers only to the configured origin and not log them | The daemon already has a loopback HTTP server with host/origin/bearer guards (`src/http/`); the MCP route needs its own auth (per-run token, not the app bearer). Must speak the MCP version the agent expects: Claude Code 2.1.325 and Codex may send `server/discover` first (see below). |
| **MCP over ACP** (`type: "acp"`) | Nothing the client hosts: MCP requests arrive as `mcp/message` requests on the ACP connection; the **adapter** runs a loopback HTTP listener with a bearer token for its own agent | Only agents advertising `mcpCapabilities.acp`: both Zed adapters today (claude-agent-acp README; codex-acp `docs/mcp-over-acp.md`) | No | The `serverId` plus the connection itself (one connection per run if one process per run) | Token stays inside the adapter | **Unstable** in spec and SDK (`@agentclientprotocol/sdk/unstable`, `experimental/mcp-http`); targets MCP spec 2026-07-28 only ("does not accept legacy `initialize`"); the Codex adapter advertises it only if the running Codex binary reports the `mcp_2026_07_28` feature. Fewer agents than the other two options. |
| **CLI + skill** (bb and Orca for orchestration) | No MCP at all; the agent's shell tool runs `bb ...` or `orca ...`; a skill teaches it | Any agent with a shell tool and skill/instruction loading, including agents that ignore `mcpServers` | No | Env vars set when the daemon spawns the agent (`BB_THREAD_ID`, `BB_ENVIRONMENT_ID`; `ORCA_AGENT_LAUNCH_TOKEN`) | Env of one process | Needs shell permission; no schema validation by the agent runtime; tool results are text on stdout; the CLI must be on the agent's PATH; one-process-per-run keeps the env unambiguous. |

**[inferred]** The options combine: a daemon-hosted HTTP route for agents that advertise `http`, the stdio bridge as the fallback, MCP-over-ACP as an optimization later. The cost is carrying more than one path and testing each per agent.

## How bb does it (observed)

- `packages/provider-bridge-acp/src/bridge/tool-proxy-mcp.ts` builds one stdio MCP server entry, name `bb-bridge`: `command = process.execPath`, `args = [...process.execArgv, <bridge file>, "--mcp-stdio"]` (`bridge.ts` `resolveBridgeProcessArgsForMcpServer`), so the bridge re-executes itself as an MCP stdio server. Its `env` holds `BB_ACP_DYNAMIC_TOOL_HOST/PORT/TOKEN/THREAD_ID/TOOLS_FILE`; the tool list is a JSON file written `0600` into a temp directory and hashed by content.
- The parent bridge listens on `127.0.0.1` on a random port with a random 32-byte token (`ensureDynamicToolBridge`); the stdio proxy opens a TCP connection per call, sends `{ kind: "toolCall", tool, arguments, callId, threadId, token }` and reads one line back. A wrong token gets `Invalid dynamic tool request`.
- The proxy implements `tools/list` and `tools/call`, sends MCP progress notifications every 15 s (`TOOL_CALL_PROGRESS_INTERVAL_MS`) while a call runs, and imports a tool-call cancellation message (`PROVIDER_TOOL_CALL_CANCELLED_METHOD`), so it handles cancels (I did not read that code path).
- For Claude Code bb does **not** use this: `plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts` builds an SDK in-process server (`McpSdkServerConfigWithInstance`) and allows `mcp__bb-bridge__<tool>`.
- Matching an agent's `tool_call` to a bb tool is heuristic: `delta-translation.ts` `injectedToolNamedBy` checks whether the call `title` contains the tool name, else binds by the proxy's own "a call arrived" note (`noteInjectedToolCall`), else takes the next pending injected call. ACP gives no stable server/tool identity on `tool_call`.

## How Orca does it (observed)

- `mcpServers: []` in every ACP session start (`acp-structured-handshake.ts`, `acp-session-runtime.ts`, `acp-text-task.ts`). No tools are injected.
- Everything an agent can ask of Orca is an `orca ...` command: `orca orchestration worker-start|send|check|reply`, `orca worktree create`, `orca terminal ...`, browser and desktop control. The `orca-cli` and `orchestration` skills (`skills/`, `skill-guides/`) teach it. See `orca-source.md`.

## Per-agent quirks relevant to tools

| Agent | Quirk | Source |
| --- | --- | --- |
| Claude Code (adapter) | MCP tools show up to the model as `mcp__<server>__<tool>`. Permission for them most likely goes through the normal `session/request_permission` **[inferred; the adapter maps Claude's `canUseTool` to it]**. HTTP servers: the adapter's own MCP-over-ACP bridge note says Claude Code 2.1.325 sends `server/discover` to an HTTP MCP server first (an MCP 2026-07-28 behavior) unless `MCP_PROTOCOL_NEGOTIATION=legacy`; a legacy `type: http` server that does not answer discovery may be handled by falling back to `initialize` **[not verified for ordinary HTTP servers]**. | `claude-agent-acp/src/mcp-servers.ts`, README |
| Codex (adapter) | `session/new`, `session/resume` and `session/fork` do **not** wait for MCP servers to finish starting; the experimental `_meta.mcpStartupAwaitTimeoutMs` makes the request wait up to N ms. "Codex may try `server/discover` on ordinary HTTP servers too. A legacy server that answers `Method not found` can then use `initialize`; an unresponsive discovery request may fail instead." | `codex-acp/docs/mcp-startup-await-timeout.md`, `docs/mcp-over-acp.md` |
| Cursor | MCP servers need approval. bb writes an entry `<serverName>-<16-hex fingerprint of project path + server config>` into Cursor's `~/.cursor/projects/<slug>/mcp-approvals.json` (or `$CURSOR_DATA_DIR`), with a lock file, and removes it at session end if it installed it. Cursor's ACP docs say ACP supports servers from project or user `.cursor/mcp.json` and that team servers from the dashboard are unsupported. | bb `cursor-mcp-approval.ts`; cursor.com/docs/cli/acp |
| OpenCode | bb disables its native question tool (`OPENCODE_ENABLE_QUESTION_TOOL=false`) so agents use the injected `AskUserQuestion`; sets `OPENCODE_CLIENT=acp`; permission rules via `OPENCODE_PERMISSION` (1.x) or an API patch on the session (2.x). | bb `bridge.ts` `dialectLaunchEnv`, skill `acp-provider` |
| Pi (adapter `pi-acp`) | "MCP servers are accepted in ACP params and stored in session state, but not wired through to pi." | github.com/svkozak/pi-acp README |
| Gemini CLI | ACP docs page says the client's MCP server details come in the `initialize` handshake; this contradicts the ACP spec (servers are in `session/new`). Treat as unverified. | geminicli.com/docs/cli/acp-mode (page updated 2026-04-10) |
| Others (Grok, Hermes, omp, Copilot, Kimi, Antigravity, Devin) | not read | |

## Constraints that apply whichever route is used

- Long calls: `run_wait` holds a tool call open up to 60 s with a session slot; agents have their own MCP tool timeouts (not collected). bb's 15 s progress notifications are one mitigation.
- Cancel: when a run is cancelled the daemon's `signal` aborts running tool `execute`s today; over MCP the agent sends a cancellation notification (or the transport drops), which the hosting side must map to the `signal`.
- `report_result` ends the run: today the engine gives the session `killGraceMs` to end its turn, then closes it. With ACP the daemon would `session/cancel` or `session/close` after the tool returns.
- The tool descriptions and schema are what the model reads; names must be valid for each agent's tool naming (Claude prefixes with `mcp__<server>__`; the system skills (`packages/system-skills`) refer to bare names such as `run_spawn`). The skills are read by agents that may see the prefixed name; this exists today too (`runtimeToolName`).
- A tool server must not outlive its run; the per-run token must stop working when the run ends.

## Sources

- https://github.com/agentclientprotocol/agent-client-protocol at `ecd1765`: `docs/protocol/v1/session-setup.mdx` ("MCP servers"), `docs/rfds/mcp-over-acp.mdx` (2026-11-17)
- claude-agent-acp at `3205f0b`: `src/mcp-servers.ts`, `src/claude-cli.ts`, README; codex-acp at `b9503ae`: `README.md`, `docs/mcp-over-acp.md`, `docs/mcp-startup-await-timeout.md`
- bb at `f1c5304`: `packages/provider-bridge-acp/src/bridge/{tool-proxy-mcp.ts,bridge.ts,cursor-mcp-approval.ts}`, `packages/provider-bridge-acp/src/delta-translation.ts`, `plugins/provider-claude-code/src/bridge/tool-proxy-mcp.ts`, `plugins/provider-acp/skills/acp-provider/SKILL.md`
- Orca at `cbc8119e`: `src/main/acp/session/start/acp-structured-handshake.ts`, `skill-guides/orchestration.md`
- https://github.com/svkozak/pi-acp, https://cursor.com/docs/cli/acp, https://geminicli.com/docs/cli/acp-mode/ (fetched 2026-11-17)

## Open questions

- Which agents advertise `mcpCapabilities.http`/`sse` in a real `initialize` reply (unverified for Cursor, Gemini, OpenCode, Grok, Copilot).
- Whether an ordinary (legacy) HTTP MCP server works unchanged with Claude Code 2.1.325+ and Codex 0.166+ when launched through the adapters.
- Per-agent MCP tool-call timeouts and whether MCP progress notifications extend them.
- Whether the daemon's already-present `@modelcontextprotocol/sdk` 1.32.2 (a devDependency used by `test/claude-tools.test.ts`) supports the MCP spec revisions the adapters speak.

## Assumptions and limits

- I did not start any MCP server or agent. `agentCapabilities` per agent is unverified; the table is from adapter docs and source.
