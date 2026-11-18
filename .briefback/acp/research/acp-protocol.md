# ACP protocol: lifecycle, message set, MCP transports, SDK

Snapshot 2026-11-17. Everything here is read from primary sources: the spec docs and schemas in a shallow clone of `agentclientprotocol/agent-client-protocol` at `ecd1765` (commit dated 2026-11-17), the official TypeScript SDK at `1bdba77`, and the spec site (agentclientprotocol.com, page `protocol/overview` fetched 2026-11-17). Facts marked **[inferred]** are my reading, not source text.

## Summary

- ACP is JSON-RPC 2.0 between a **client** (an editor, or Clowdy's daemon) and an **agent** (a coding agent program). The only standard transport is **stdio**: the client launches the agent as a subprocess, one JSON message per line (`docs/protocol/v1/transports.mdx`). A remote transport (Streamable HTTP + WebSocket) is an RFD, not standard.
- Stable protocol is **v1** (`protocolVersion: 1`). A **v2 draft** exists next to it and both adapters already serve it experimentally. The v1 schema crate is at 1.32.0 (2026-11-14, `schema/v1/CHANGELOG.md`). The repo's own `CHANGELOG.md` top entry is a separate 1.18.0 (2026-11-14) stream; I did not resolve why two version numbers exist.
- The official TypeScript SDK is **`@agentclientprotocol/sdk` 2.7.0** (changelog date 2026-11-14, `package.json` at `1bdba77`). Default import is stable v1; `/unstable` adds draft v1 features; `/experimental/v2*` is the v2 draft.
- Things Clowdy's runtime relies on that are **stable** in v1: text streaming, tool calls with status, permission requests, cancel, session new/load/resume/close/list/delete, config options (model, mode, reasoning), stdio MCP servers, `usage_update` (context size + cumulative cost), elicitation, client system prompt.
- Things it relies on that are **not stable or not in the spec**: per-turn token usage (`PromptResponse.usage` is unstable, though both Zed adapters send it), sub-agents as child sessions (unstable), mid-turn steering (extension `_session/steering`), subscription rate-limit signals (only vendor `_meta`), process pid/pgid (none), thinking is a chunk kind but adapters differ on whether they send it.

## Transport

- stdio only in the standard. The agent must write nothing but ACP messages to stdout; stderr is free for logs. The client closes stdin and terminates the subprocess to end it (`transports.mdx`).
- Remote: `docs/rfds/streamable-http-websocket-transport.mdx` proposes one `/acp` endpoint (POST + long-lived GET streams, WebSocket upgrade). The TS SDK ships `experimental/http-client`, `ws-client`, `server` entrypoints; not part of v1.
- JSON-RPC cancellation: `$/cancel_request` notification exists (`cancellation.mdx`); optional, answered with `-32800`.

## Lifecycle (v1 stable)

| Step | Method | Notes |
| --- | --- | --- |
| 1 | `initialize` | Client sends `protocolVersion` (integer), `clientCapabilities`, `clientInfo`. Agent replies with chosen version, `agentCapabilities`, `agentInfo`, `authMethods`. Omitted capability means unsupported. |
| 2 | `authenticate` | Only when the agent advertised an `agent`-type method and `session/new` failed with `auth_required`. A `terminal`-type method is not sent over ACP: the client re-runs the agent program interactively with the method's `args`/`env`, then reconnects. Needs client capability `auth.terminal`. `logout` is optional. |
| 3 | `session/new` | `cwd` (absolute) and `mcpServers`. Returns `sessionId`, optional `modes`, `configOptions`, legacy `models`. |
| 3 alt | `session/load` | Needs `agentCapabilities.loadSession`. Agent **replays the whole history** as `session/update` notifications, then answers. |
| 3 alt | `session/resume` | Needs `agentCapabilities.sessionCapabilities.resume`. Same restore but **no replay**. |
| 3 opt | `session/close`, `session/list`, `session/delete` | Each behind a `sessionCapabilities.*` entry. `session/close` cancels work and frees the session; idempotent. |
| 4 | `session/prompt` | `prompt` is a `ContentBlock[]` (text and `resource_link` mandatory; image, audio, embedded `resource` behind `promptCapabilities`). Request stays open for the whole turn; response is `{ stopReason }`. |
| 4 | `session/update` (notification, agent to client) | See the kinds table below. |
| 4 | `session/cancel` (notification, client to agent) | Client should mark unfinished tool calls cancelled, **must** answer pending `session/request_permission` with outcome `cancelled`. Agent must stop and answer the prompt with `cancelled` (not an error). It may still send updates before that answer. |
| any | `session/set_mode`, `session/set_config_option` | Mode and config changes. Config options are the preferred form; modes "will be removed in a future version". |

Other session-setup facts (`session-setup.mdx`):

- `mcpServers` and `cwd` are sent again on `session/load` and `session/resume`; the agent reconnects to them.
- `sessionCapabilities.additionalDirectories` lets the client add extra workspace roots. Without the capability the client must not send the field.
- `sessionCapabilities.systemPrompt` (stable since the repo's `CHANGELOG.md` release 1.16.0, 2026-11-09, "stabilize client system prompt"): `session/new|load|resume` accept `systemPrompt { mode: "append" | "override", content: text[] }`. `append` is baseline; `override` only if the agent advertises `mode.override`.
- Session ids are opaque agent-owned strings. A transcript lives wherever the agent keeps it; ACP does not say where.

### session/update kinds (stable v1, `prompt-turn.mdx`)

`user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice` (needs client capability `session.notices`), `compaction_update` and `compaction_summary_chunk` (need `session.compaction`).

- Message chunks may carry an opaque `messageId`; a changed id means a new message. There is no explicit "message done" event; a message ends when the id changes, a tool call starts, or the turn ends **[inferred from the doc text]**.
- `tool_call` fields: `toolCallId`, `title`, optional `name` (the programmatic tool name; optional and informational), `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`), `status` (`pending`, `in_progress`, `completed`, `failed`), `content[]` (text/image, `diff`, `terminal`), `locations[]`, `rawInput`, `rawOutput`. Updates send only changed fields (`tool-calls.mdx`).
- `plan`: list of entries with `content`, `priority`, `status`.
- `usage_update`: `used` and `size` (context tokens) and optional `cost { amount, currency }`, cumulative for the session (`prompt-turn.mdx` "Session usage updates").
- Stop reasons: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.

### Permission requests

`session/request_permission` (agent to client request): `toolCall` (a `ToolCallUpdate`), `options[]` each `{ optionId, name, kind }` with kind `allow_once`, `allow_always`, `reject_once`, `reject_always`. Response outcome is `cancelled` or `selected { optionId }`. The spec says clients "MAY automatically allow or reject permission requests according to the user settings" and that the **agent owns remembered decisions** (an `allow_always` choice is stored and applied by the agent, not the client) (`tool-calls.mdx`).

### Client-side methods the agent may call

- `fs/read_text_file`, `fs/write_text_file` (need `clientCapabilities.fs.*`; agent must not call them otherwise).
- `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` (need `clientCapabilities.terminal`).
- `elicitation/create` (form and URL modes, advertised under `clientCapabilities.elicitation`). This is the stable way for an agent to ask the person a structured question.
- **[inferred]** A headless client such as the daemon can advertise none of fs, terminal, and rely on the agent's own tools. Orca does exactly this (`fs: false, terminal: false`, `src/main/acp/protocol/acp-session-runtime.ts@cbc8119e`); bb advertises fs read/write and `terminal: false` (`packages/provider-bridge-acp/src/bridge/agent-connection.ts@f1c5304`, `acpClientCapabilities`).

### Modes, models, reasoning

- `configOptions[]`: `{ id, name, category?, type: select|boolean, currentValue, options }`. Categories reserved by the spec: `mode`, `model`, `model_config`, `thought_level`; `_`-prefixed names are custom (`session-config-options.mdx`). Changed with `session/set_config_option { sessionId, configId, value }`; agent may push `config_option_update`.
- Older form still in the wild: `models` state in `session/new` results and a model-switch method (Gemini docs list `unstable_setSessionModel`; Orca generates its schema from the spec release plus a "legacy model API" `v0.11.6`, `config/scripts/acp/generate-protocol.mjs@cbc8119e`). Which agents use which form is not documented in one place.
- Boolean config options need client capability `session.configOptions.boolean`.

## MCP servers over ACP

From `session-setup.mdx` ("MCP servers") and `initialization.mdx`:

| Transport | Who must support it | How the client declares it |
| --- | --- | --- |
| **stdio** | **Every agent MUST** | `{ name, command (absolute path), args[], env[{name,value}] }`, no `type` field |
| **http** | Optional, advertised as `agentCapabilities.mcpCapabilities.http` | `{ type: "http", name, url, headers[{name,value}] }` |
| **sse** | Optional (`mcpCapabilities.sse`), deprecated by MCP | `{ type: "sse", name, url, headers[] }` |
| **acp** (MCP-over-ACP) | **Unstable** draft; adapters advertise `mcpCapabilities.acp` | `{ type: "acp", name, serverId }`; MCP requests then travel as `mcp/message` over the ACP connection. Targets MCP spec 2026-07-28 only (`docs/rfds/mcp-over-acp.mdx`). Both Zed adapters implement it (see `agents-and-adapters.md`). |

- New agents "SHOULD support the HTTP transport". The client must check `mcpCapabilities` before sending http/sse.
- The spec says clients "MAY use this ability to provide tools directly to the underlying language model by including their own MCP server" and that agents "SHOULD connect to all MCP servers specified".
- Security text: `env` and `headers` values are credentials; agents should not log or persist them; clients should not send a stdio server taken from workspace files without approval.
- Nothing in ACP names the tools an agent exposes from an MCP server, or how they are named to the model. Tool names and prefixing (for example Claude's `mcp__<server>__<tool>`) are agent-specific.

## Usage, limits, thinking, sub-agents

| Need | Stable v1 | Draft / extension |
| --- | --- | --- |
| Context size and cumulative cost | `usage_update` | none needed |
| Per-turn input/output/cached tokens | **absent** from `PromptResponse` (stable shape is `{ stopReason, _meta? }`) | `PromptResponse.usage { totalTokens, inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens? }` in the **unstable** v1 schema (`schema/v1/schema.unstable.json`); the RFD `end-turn-token-usage.mdx` is still Draft and the schema text says "across all turns". **Both Zed adapters fill it per prompt in practice**: claude-agent-acp `turnOutcome` returns `usage: sessionUsage(session)` from accumulators that are reset when a user turn activates (`src/v1/acp-agent.ts` ~10960-10980, 3512), codex-acp `buildPromptUsage` from `promptTokenUsage` (`src/CodexAcpServer.ts` ~5700-5730). Both also put `_meta.quota { token_count, model_usage[] }` on the same response. |
| Subscription / rate-limit signal | **none** | vendor `_meta` only: claude-agent-acp puts the SDK's `rate_limit_info` under `_meta["_claude/rateLimit"]` on a `usage_update` and under `data.rateLimit` in the error of a `rate_limit` failure (`src/v1/acp-agent.ts` ~7076-7090, `src/result-end.ts` at `3205f0b`). Both adapters put `_meta.quota { token_count, model_usage[] }` on the turn response (`src/session-usage.ts`; codex `src/QuotaMeta.ts` at `b9503ae`). |
| Thinking | `agent_thought_chunk` | adapters may or may not send it |
| Sub-agents with their own transcript | **absent** | unstable `subagent_update`, `session_message`, `session_message_chunk`, client capability `subagents: {}`; implemented by claude-agent-acp (`docs/subagent-sessions.md`) and codex-acp (README "Subagent sessions") when the client opts in |
| Process pid / pgid | **none** (the client spawned the process, so it knows the pid) | n/a |
| Mid-turn steering (a message into a running turn) | **absent**; a second `session/prompt` during a turn is not specified | `_session/steering` pre-standard extension in both adapters (`codex-acp/docs/steering.md`, PR #1261 in the protocol repo); advertised as `_meta.steering.supported` in `initialize` |
| Session fork | absent | unstable `session/fork` |
| Auth status | absent | unstable `auth/status` + `auth/status_update` |
| Custom LLM endpoints | absent | unstable `providers/list`, `providers/set`, `providers/disable` |

## Official TypeScript SDK

- Package `@agentclientprotocol/sdk`, version **2.7.0**, Apache-2.0, repo `agentclientprotocol/typescript-sdk` at `1bdba77` (2026-11-17). Peer dependencies: `zod` (`^3.25.76 || ^4`), optional `@modelcontextprotocol/server`. No `engines` field; Bun compatibility not tested by me.
- Entrypoints: `.` (stable v1), `./unstable`, `./experimental/v2`, `./experimental/v2/unstable`, plus `experimental/http-client|ws-client|server|node|mcp-http|mcp-server`. README warns to use one entrypoint consistently and that selecting `/unstable` does not advertise capabilities.
- API shape (README): agent side `agent({ name })` + `onRequest(methods.agent.*, handler)` + `connect(stream)`; client side `client({ name })` + `connectWith(stream, async ctx => ctx.request(methods.agent.session.new, params))`. Examples in `src/examples/` (`client.ts` spawns an agent as a subprocess).
- Both adapters and bb depend on it (`claude-agent-acp` pins `@agentclientprotocol/sdk` 2.7.0; bb's `agent-connection.ts` imports `RequestError` from it). Orca does **not** use the SDK: it generates its own zod types from the schema JSON (`src/main/acp/generated/acp-protocol.generated.ts`, pinned to `schema-v1.21.0`).

## v2 draft (not stable)

`docs/protocol/v2/` exists. Visible differences from the RFD set: `session/load` is replaced by a `replayFrom` option on `session/resume` with a `replay_complete` update, sub-agents are included without an unstable flag, background work and idempotency keys are added, the `mcpCapabilities` become `capabilities.session.mcp.*`. A client asking for protocol version 2 gets v2 from claude-agent-acp; others get v1. **[inferred]** Targeting v1 stable now is the safe choice; v2 can change incompatibly ("The v2 wire protocol and these SDK APIs may change incompatibly in any release", SDK README).

## Relevant files

- `docs/protocol/v1/{initialization,session-setup,prompt-turn,tool-calls,file-system,terminals,session-modes,session-config-options,authentication,cancellation,transports,elicitation}.mdx` in the protocol clone: the normative text.
- `schema/v1/schema.json`, `schema/v1/schema.unstable.json`, `schema/v1/meta.json` (method list): exact shapes.
- `docs/rfds/*.mdx`: design status of every non-stable feature (usage, subagents, mcp-over-acp, agent-skills, registry, streamable HTTP).

## Sources

- https://agentclientprotocol.com/protocol/overview (fetched 2026-11-17)
- https://github.com/agentclientprotocol/agent-client-protocol at `ecd1765` (2026-11-17): `docs/protocol/v1/*`, `schema/v1/*`, `CHANGELOG.md`, `docs/rfds/*`
- https://github.com/agentclientprotocol/typescript-sdk at `1bdba77` (2026-11-17): `package.json`, `README.md`, `CHANGELOG.md`
- https://cursor.com/docs/cli/acp and https://geminicli.com/docs/cli/acp-mode/ (fetched 2026-11-17) for the model-switch method names

## Open questions

- Whether any agent honors a second `session/prompt` while a turn is running. The spec is silent; adapters ship `_session/steering` instead.
- Whether agents other than the two Zed adapters fill `PromptResponse.usage` (unstable) and with which meaning: the schema text says "across all turns", the RFD says semantics are still being refined, the two adapters report per prompt.
- Which agents actually advertise `mcpCapabilities.http` / `sse`. Not collected; each agent's `initialize` reply is the authority.

## Assumptions and limits

- I read the docs and schemas, I did not run any ACP agent or the SDK. I did not read `docs/protocol/v1/terminals.mdx`, `content.mdx`, `slash-commands.mdx`, `session-list.mdx` in detail.
- "Stable" is the repo's own label (non-`draft` docs and `schema.json` without `unstable`).
