# Mapping Clowdy's engine seam onto ACP

Snapshot 2026-11-17. Clowdy side read in the working tree on branch `kachurun/feat/task-hotkeys` (no CodeGraph index exists in the repo, so I read files directly): `apps/daemon/src/engine/{types.ts,index.ts,fake.ts}`, `engine/claude/{mapper,session,tools,failure,env,process,config,index}.ts`, `apps/daemon/src/runs/{driver,limits,service,native}.ts`, `apps/daemon/src/config.ts`, `packages/protocol/src/{domain,commands}.ts`, `apps/daemon/AGENTS.md`. ACP side from `acp-protocol.md`, `agents-and-adapters.md`. This page lists what maps, what has no ACP equivalent, and the options for each gap with their costs. It does not pick one.

## Summary

- The seam (`AgentEngine`, `EngineSession`, `EngineEvent` in `engine/types.ts`) is already agent-neutral in shape. An ACP engine would implement the same `start(options)` and yield the same events, so `runs/` (driver, scheduler, limits, wake-ups, native agents) is unchanged in principle.
- **Maps cleanly**: session id, text, tool calls, done/cancel, errors by code, cwd, model, resume, system prompt (capability-gated).
- **Maps with loss or agent-by-agent work**: per-turn usage (tokens: present in the two Zed adapters via an unstable field), sub-agent events with `agentId`, subscription `limit` signals, mid-turn `send`, the runtime's own tools (an MCP server the daemon must host), skills and slash-command dispatch.
- **No stable ACP equivalent**: subscription rate-limit status (only vendor `_meta`), account identity ("who pays": `apiKeySource`, plan; the unstable `auth/status` and a Claude-adapter extension cover part of it), process pid (not needed: the daemon spawns the process).
- **Hard-coded closed set today**: `EngineId = 'claude' | 'codex' | 'fake'` appears in seven places (below). Any "add an agent in Settings" model must open it.

## Current seam, as consumed

`apps/daemon/src/runs/driver.ts` `consume()` (lines ~385-440) is the only consumer of `EngineEvent`s:

| Event | Consumer action |
| --- | --- |
| `session` | `runs.setSessionId` (stored; later turns pass it back as `resumeSessionId`) |
| `process` | `runs.setProcess` with pid, pgid, start time (read from `ps`), cleared when the session closes; used for the kill ladder and for killing survivors at daemon start |
| `text` | no `agentId`: `TurnWriter.text(delta, done)`; with `agentId`: `NativeAgents.stream` |
| `tool` | same split; `ask_user` is rendered as a question card instead |
| `subagent` | `NativeAgents.state`: child run with `origin: 'native'`, no process, no slot |
| `limit` | `parseLimit` then `EngineLimits` (warning halves the cap 10 min; rejected pauses the engine until reset, stored in `engine_pauses`) |
| `usage` | `runs.addUsage` (sum per run; protocol `RunUsage { inputTokens, outputTokens, costUsd? }`) |
| `done` | ends the turn; `result` is the final report text |
| `error` | `EngineFailure(message, retryable)`; `code` is a stable id (`not_logged_in`, `usage_limit`, ...) used by the retry/backoff logic |

`EngineStartOptions`: `cwd`, `prompt`, `systemPrompt?`, `resumeSessionId?`, `model?`, `tools: ToolDefinition[]`, `signal`. `EngineSession`: async iterable plus `send(text)` and `close()`.

## Event-by-event mapping

| EngineEvent | ACP equivalent | Fidelity and notes |
| --- | --- | --- |
| `session { sessionId }` | `sessionId` in the `session/new` result; for resume the id the client passed | Direct. Resume = `session/resume` if `sessionCapabilities.resume`, else `session/load` if `loadSession` (agent **replays history** as updates, the engine must swallow them as bb does with `beginReplay/endReplay`), else new session. Failure behavior differs by agent; bb falls back to a fresh session and warns. Today's `session_not_found` code (`failure.ts`) maps to ACP `-32002` "resource not found" **[inferred: the schema defines it, not every agent uses it]**. Claude transcripts need the same `cwd` on resume today; the ACP spec requires the request `cwd` to match for additional directories. |
| `text { delta, done, agentId? }` | `agent_message_chunk` with `content.type: "text"` and optional `messageId` | `delta` direct. `done` has no event: derive it when `messageId` changes, when a `tool_call` arrives, or when the turn ends. `agentId`: only via unstable child sessions (see `subagent`). `agent_thought_chunk` exists in stable ACP; Clowdy's Claude engine drops thinking today, so dropping it again loses nothing new. |
| `tool { toolCallId, name, input, state, output?, error?, agentId? }` | `tool_call` then `tool_call_update` (`status` pending / in_progress / completed / failed, `rawInput`, `rawOutput`, `content[]`, `title`, `kind`, optional `name`) | Maps to `ToolState` `running`, `done`, `error` (`pending` and `in_progress` become `running`, `failed` becomes `error`). `name` is optional and informational, `title` is human text, `rawInput/rawOutput` are agent-specific JSON, `content` may be diffs or terminal ids. The mapper must build `output` text from `content`/`rawOutput` (today: text blocks joined, cut at 20,000 chars in `claude/mapper.ts` `clip`). For the daemon's own tools there is a shortcut: the daemon executes them, so it knows the call and the arguments from the MCP side and can emit the `tool` event itself (bb has to guess from titles because its proxy is out of process; see `tools-and-mcp.md`). Today's `runtimeToolName` strips `mcp__clowdy__`; ACP agents name MCP tools their own way. |
| `subagent { agentId, name, state, summary, parentToolCallId }` | Unstable `subagent_update` on the parent session (child `sessionId`, title, description, state `running`/`requires_action`/`idle`, stop reason), child traffic as normal `session/update`s with the child's `sessionId`; client must advertise `clientCapabilities.subagents: {}` | Implemented by `claude-agent-acp` and `codex-acp` only. Cursor exposes `cursor/task` notifications (extension), Grok a `spawn_subagent` tool call, OpenCode child sessions (Orca `acp-dialects/opencode-child-sessions.ts`), most others nothing. Where no signal exists the sub-agent is just a tool call (`Agent`/`Task`) in the parent's stream. The `agentId` of today's `text`/`tool` events would become the child `sessionId`. |
| `usage { inputTokens, outputTokens, costUsd? }` | Stable: `usage_update { used, size, cost? }` (context size and **session-cumulative** cost, not input/output tokens). Unstable but sent by both Zed adapters: `PromptResponse.usage { inputTokens, outputTokens, cachedReadTokens?, cachedWriteTokens?, totalTokens }` for the prompt, plus `_meta.quota { token_count, model_usage[] }` on the same response. | Per-prompt tokens exist for the Claude and Codex adapters (accumulators reset per user turn: `claude-agent-acp` `turnOutcome`, `codex-acp` `buildPromptUsage`). Claude's `usage_update` carries `cost.amount` = the SDK's `total_cost_usd` (`src/v1/acp-agent.ts` ~5838), cumulative like today, so the existing baseline subtraction in `claude/mapper.ts` `usage()` is still needed for cost. Codex has no cost. Other agents: not verified. The unstable field means parsing the raw JSON or importing `@agentclientprotocol/sdk/unstable`. Cost basis is the agent's own (list-price estimates for Claude, per the existing research note). |
| `limit { status, kind, utilization, resetsAt }` | **None in the spec.** Claude adapter: `_meta["_claude/rateLimit"]` on `usage_update` carrying the SDK's `rate_limit_info` (`status`, `rateLimitType`, `utilization`, `resetsAt`) and `data.rateLimit` on a rate-limit failure. Codex adapter: reads Codex's rate-limit snapshots internally; reaching the client was not verified. Others: nothing. | For Claude the same fields `parseLimit` reads today arrive under a vendor key. Everything else loses the proactive `warning` stage (cap halving) and only has the reactive `rejected` stage through errors. See options below. |
| `process { pid, pgid, startedAt }` | Not an ACP concept; the daemon spawns the agent, so it knows pid/pgid | The engine synthesizes the event from `child.pid` right after spawn, with the child as leader of its own process group (as `spawnInOwnGroup` does). The group now contains the adapter, the agent CLI and its tool shells. |
| `done { result }` | `session/prompt` response `{ stopReason: "end_turn" }` | ACP has no `result` field; the final report text is the last message accumulated from `agent_message_chunk`s. Other stop reasons: `cancelled` (not an error; end quietly, as `claude/mapper.ts` does when its `interrupted` flag is set), `refusal`, `max_tokens`, `max_turn_requests` have no current Clowdy counterpart (probably `error` or `blocked`). The Claude mapper's special rule "a `result` while a background sub-agent still runs only reports usage" (`mapper.ts` `result()`, `working()`) belongs to the SDK stream; what the adapter does for such turns on the ACP side was not checked. |
| `error { message, retryable, code }` | JSON-RPC error response of `session/prompt` (or of `session/new`): `-32000` auth required, `-32002` resource not found, `-32602` invalid params, `-32800` cancelled, `-32603` internal, with optional `data` | Adapters add structure in `data`: Claude `{ errorKind, rateLimit? }`, plus an opt-in session-failure extension. `failure.ts` `classifyFailure` is keyed on the SDK's `kind` strings (`authentication_failed`, `rate_limit`, `billing_error`, `overloaded`, ...) and on CLI wording; `data.errorKind` carries the same strings for Claude. For other agents classification is text-only. |

ACP events with no `EngineEvent` today: `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update` (title), `notice`, compaction, `agent_thought_chunk`, permission requests, elicitation. None is required for the runtime to work; `plan` and `session_info_update` could feed the UI later.

## Inputs

| `EngineStartOptions` | ACP form |
| --- | --- |
| `cwd` | `session/new.cwd` (absolute) and the process cwd; `additionalDirectories` is capability-gated |
| `prompt` | `session/prompt` content blocks. The runtime's first message is `/clowdy:orchestrate Mode: ...` (a Claude plugin slash command, `runs/prompts.ts`). Slash-command handling is agent-specific: Claude adapter supports custom slash commands, Codex adapter names skills `$name`, others unknown. See `skills.md`. |
| `systemPrompt` | `systemPrompt { mode: "append", content }` on `session/new`, `session/load` and `session/resume` when the agent advertises `sessionCapabilities.systemPrompt`. Otherwise bb's approach: wrap in a tagged text block at the start of the first prompt. Today's Claude engine uses the `claude_code` preset plus `append`. |
| `resumeSessionId` | as above |
| `model` | a `session/set_config_option` on the option with category `model` after `session/new`; option ids and values are agent-specific; legacy `models` state and `session/set_model` on older agents |
| `tools` | MCP server in `mcpServers`; see `tools-and-mcp.md` |
| `signal` | `session/cancel` then wait for `stopReason: cancelled`, then `session/close` (if supported), close stdin, SIGTERM the group after `killGraceMs`, SIGKILL after as long again (the existing ladder in `runs/service.ts`) |
| `session.send(text)` | No stable equivalent. Options: the `_session/steering` extension (both Zed adapters, `_meta.steering.supported`), or hold the text and send it as the next `session/prompt` after the turn. A second concurrent `session/prompt` is unspecified. |
| `session.close()` | `session/close` + process stop |

## What survives of the Claude engine, what goes

| Piece | Verdict | Why |
| --- | --- | --- |
| `claude/process.ts` `spawnInOwnGroup`, `killProcessGroup` | **Survives almost verbatim** (generalize to any command) | ACP agents are subprocesses; leader-of-own-group plus group SIGTERM/SIGKILL is what bb (`managed-process.ts`) and Orca (`provider-process`) also do. Process group is what reaches tool shells. |
| `runs/processes.ts`, `service.ts` cancel ladder, `process` event, start-time check at daemon start | **Survives** | Agent-neutral. Orca's ownership journal is a stricter version of the same idea. |
| `claude/env.ts` `buildClaudeEnv` | **The idea survives, the content changes** | Env allowlist and explicit secrets are good hygiene for any agent. But "use what the user has logged in" needs each agent's login-relevant variables and home dirs to pass (HOME, XDG_*, `CODEX_HOME`, `CURSOR_*`, `OPENCODE_*`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, keychain access), so the list becomes per-agent. The Claude-specific lines (strip `ANTHROPIC_*`/`CLAUDE_CODE_*`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, sub-agent caps, `CLAUDE_AGENT_SDK_CLIENT_APP`) become that agent's launch profile, applied if the adapter passes its environment on to the CLI (**not verified**). |
| `claude/failure.ts` `classifyFailure`, `readableMessage`, `unwrapBody`, `classifyThrown` | **Partly survives** | The generic helpers (JSON body unwrapping, status extraction, usage-limit and "resets at" phrase parsing, retryable flags, stable `FailureCode`s) are agent-neutral. The `auth` branches (`CLOWDY_CLAUDE_*` messages) are Claude-specific. Needs new inputs: ACP error `code`/`data`, adapter stderr tail, spawn failures (ENOENT = "engine_missing" becomes "agent not installed"). |
| `engine/types.ts`, `engine/fake.ts`, `test/helpers.ts` (`GateEngine`, `ScriptEngine`) | **Survive** | The seam stays; add an ACP fake agent for tests (bb has `fake-acp-agent.mjs`, the ACP SDK ships example agents). |
| `claude/mapper.ts` | **Replaced** | It maps SDK messages; ACP `session/update` is a different vocabulary. The reusable ideas: baseline subtraction for cumulative cost, per-stream open-text tracking, 20,000-char clip. |
| `claude/session.ts` (streaming input `Inbox`, `query()` options, `BUILT_IN_TOOLS`, `plugins`, `settingSources`) | **Replaced** | Becomes an ACP client session. `BUILT_IN_TOOLS` and `settingSources` become adapter-specific `_meta.claudeCode.options` or are given up. |
| `claude/tools.ts` (`createSdkMcpServer`) | **Replaced** | In-process SDK servers do not exist over ACP. The daemon must host an MCP server (HTTP, stdio bridge, or MCP-over-ACP). |
| `claude/config.ts` (`CLOWDY_CLAUDE_AUTH` subscription / api-key / oauth-token, `CLOWDY_CLAUDE_BIN`, `CLOWDY_PERMISSION_MODE`, `CLOWDY_CLAUDE_SETTING_SOURCES`) | **Mostly replaced** | Auth and binary choice move to per-agent settings (path override, optional API key env). Permission mode becomes the ACP session mode / config option plus Clowdy's answer policy for `session/request_permission`. |
| `claude/index.ts` `ClaudeEngine.diagnostics` (`apiKeySource`, plan) | **No stable equivalent** | Stable ACP has no account or billing-source report. The Claude adapter reports its auth identity through the unstable `auth/status` request / `auth/status_update` notification and its own `_auth/status_update` extension (see "Account identity" below); other agents unknown. |
| `runs/limits.ts` `EngineLimits`, `engine_pauses`, `Scheduler`, `engineCaps` | **Survive**, keyed by agent id | Logic is generic; inputs (`limit` events, `usage_limit`/`rate_limited`/`overloaded` codes) arrive for fewer agents. |
| `runs/native.ts` `NativeAgents` | **Survives only where a sub-agent signal exists** | Needs the unstable subagent capability or per-agent dialects. |
| `runs/wake.ts`, `reports.ts`, mailbox, `tools.ts` (task tools) | **Survive** | Independent of engines. |
| `packages/system-skills`, `src/skills/*` | **Survive as content; delivery changes** | `systemSkillsDir` / `extraPluginDirs` are Claude plugin directories; see `skills.md`. |

## Where "claude | codex | fake" is hard-coded

`packages/protocol/src/domain.ts:37` (`EngineId`), `packages/protocol/src/commands.ts:10` (zod enum), `apps/daemon/src/config.ts:63` (`ENGINES`) and `engineCaps`, `apps/daemon/src/runs/limits.ts:51` (`NAMES`), `apps/daemon/src/runs/run-tools.ts:21` (`run_spawn` `engine` enum, "never `fake`"), `apps/daemon/src/engine/index.ts` (registers only the selected real engine), `apps/daemon/src/skills/{catalog,service}.ts` (`SkillEngine`, `.claude/skills` vs `.agents/skills` roots), `apps/desktop/.../EnginePage.tsx` (`ENGINE_NAMES`), per-engine env `CLOWDY_MAX_RUNS_CLAUDE|CODEX|FAKE`, and the protocol's `ProjectSettings.engine` / `Run.engine`. Opening the set touches protocol, daemon, desktop and tests.

## Options for each gap (costs only; no recommendation)

**Token/cost usage.**
1. Read `PromptResponse.usage` / `_meta.quota` and `usage_update.cost` where present. Cost: unstable field and a de-facto `_meta` convention; agents other than the two Zed adapters may report nothing.
2. Use only the stable `usage_update` (context size, cumulative cost). Cost: no input/output token totals per turn.
3. Drop usage for agents that do not report it; keep `Run.usage` optional (already optional in the protocol).

**Subscription limit signals.**
1. Parse `_meta["_claude/rateLimit"]` for Claude only and rely on errors for everyone else. Cost: no early warning for others; error text parsing per agent.
2. Add vendor probes (Orca and bb call Anthropic's OAuth usage endpoint, Codex's `wham/usage`, Cursor's dashboard API using tokens read from the keychain). Cost: reads other programs' credential stores; see `policy.md`.
3. Query each agent's own CLI for account status (bb uses `claude` account probes and `claude doctor`). Cost: process spawn per probe, parsing CLI output.
4. Drop limit-aware scheduling; keep `retryable` backoff only.

**Native sub-agents.**
1. Advertise `clientCapabilities.subagents: {}` and map `subagent_update` to `NativeAgents`. Cost: unstable; only two adapters; new routing of `sessionId` to `agentId`.
2. Treat sub-agent calls as ordinary tool calls. Cost: UI loses child runs; no `agentId` streams.
3. Turn native sub-agents off (bb ships `subagentsDisabled`: "hide native Agent, Task, and ListAgents tools so the agent delegates through bb") so delegation always goes through Clowdy's `run_spawn`. Cost: per-agent switch; only possible where the agent offers one.

**Mid-turn `send`.**
1. `_session/steering` where `_meta.steering.supported`. Cost: pre-standard.
2. Queue until the turn ends and send as the next prompt (Orca's `steering: 'queue'`). Cost: no interruption of a wrong direction.

**Final report text / `done`.** Accumulate the last agent message. Cost: segmenting messages without `messageId` is heuristic.

**Account identity and billing source.** Not in stable ACP. Options: (1) the unstable `auth/status` request and `auth/status_update` notification (RFD `get-auth-state`), which `claude-agent-acp` implements together with its older `_auth/status_update` extension advertised as `agentCapabilities._meta.authStatus`; it reports whether the agent uses a Claude subscription, API key, gateway or external cloud credentials, refreshed at `initialize`, after `authenticate`/`logout`, at each `session/new`, and at the start of each prompt (`src/auth-status.ts`, `src/auth-status-reporter.ts`). This is the closest ACP-side counterpart of `ClaudeEngine.diagnostics` / `apiKeySource`. Cost: unstable, Claude adapter only so far (other agents not checked). (2) A CLI probe per agent (`claude auth status --json`). (3) Give up the "billed through API, not subscription" warning.

## Sources

- Clowdy files listed at the top; `apps/daemon/AGENTS.md` sections Runtime, Claude engine, API decisions.
- `.briefback/mvp/research/claude-agent-sdk.md` and `.briefback/mvp/research/codex-sdk.md` (existing notes, dated 2026-11-17).
- ACP facts: `acp-protocol.md` and `agents-and-adapters.md` in this folder; bb `packages/provider-bridge-acp/src/bridge/bridge.ts@f1c5304`; claude-agent-acp `src/v1/acp-agent.ts`, `src/session-usage.ts`, `docs/subagent-sessions.md` at `3205f0b`; codex-acp `docs/steering.md`, `src/QuotaMeta.ts` at `b9503ae`.

## Open questions

- Which stop reason and turn boundary the Claude adapter reports when a turn ends while a background sub-agent still runs.
- Whether the adapters pass the daemon's environment through to the CLI they spawn (matters for the env allowlist and `ENABLE_CLAUDEAI_MCP_SERVERS`).
- How the adapters report a login that has expired mid-run (error code and `data`).

## Assumptions and limits

- No ACP code was run. The mapping is built from specs, adapter source and bb/Orca source; nothing was tested against a live agent.
- I did not read `engine/fake.ts` in full, `runs/service.ts` beyond the engine-related parts, or the desktop app beyond `EnginePage.tsx` and the grep for `engine`.
