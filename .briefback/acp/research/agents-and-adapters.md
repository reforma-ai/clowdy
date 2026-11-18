# Agents and adapters: how each agent is started over ACP

Snapshot 2026-11-17. Sources: the official ACP registry (`agentclientprotocol/registry` at `df2ae8a`, commit 2026-11-17), the two Zed/JetBrains adapters read in source (`claude-agent-acp` at `3205f0b`, `codex-acp` at `b9503ae`), each vendor's own ACP doc where I could fetch it, and the launch tables inside bb and Orca (cross-checked). Observed = read in a file; inferred = my reading.

## Summary

- **Three launch shapes exist.** (1) A native subcommand or flag on the agent's own CLI: Cursor, OpenCode, Gemini CLI, Copilot CLI, Grok Build, omp, Hermes, Kimi. (2) A separate **adapter** that wraps the agent: Claude Code and Codex (official adapters), Pi (community). (3) Agents that are only distributed through the registry as a downloadable binary or npm/uvx package.
- **The two flagship adapters are not thin shims, and both bundle the agent.** `claude-agent-acp` is built on `@anthropic-ai/claude-agent-sdk` and by default spawns the SDK's platform binary (about 350 MB, pulled as an optional dependency); `codex-acp` depends on `@openai/codex` and drives `codex app-server`. Each has an environment override to run the **user's installed** binary instead (`CLAUDE_CODE_EXECUTABLE`, `CODEX_PATH`). So "use ACP" alone does not meet "do not ship agents as dependencies"; the override is what does.
- **The registry describes fetch-and-run, not "find what is installed".** An entry's `distribution` is `binary` (download archive per platform), `npx` or `uvx`. There is no "command on PATH" form. bb and Orca solve discovery themselves (see `bb-source.md`, `orca-source.md`).
- **Neither bb nor Orca runs Claude Code or Codex over ACP.** bb drives Claude through the Agent SDK pointed at the user's `claude`, and Codex through `codex app-server`; Orca does the same. Both use ACP only for the other agents. See "What bb and Orca do for Claude and Codex" below.

## Per-agent table

| Agent | ACP launch | Adapter needed? | Bundles an agent? | Login reuse | MCP (`mcpServers`) |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `@agentclientprotocol/claude-agent-acp` 0.108.0 via `npx`, or a per-platform release archive that holds `claude-agent-acp` plus the `claude` CLI (registry `claude-acp`) | Yes | Yes: SDK 0.3.326 + platform binary by default; `CLAUDE_CODE_EXECUTABLE` swaps in the user's `claude` | Uses the Claude CLI's own credential store (the SDK runs the real `claude`). Advertises terminal-auth methods that run `claude /login`. | stdio, http, sse, and `acp` (MCP-over-ACP) |
| Codex | `@agentclientprotocol/codex-acp` 2.7.0 via `npx` (registry `codex-acp`) | Yes | Yes: dependency `@openai/codex ^0.166.0`; `CODEX_PATH` swaps in another binary | ChatGPT login (Codex's own `~/.codex/auth.json` or keyring), API key via `CODEX_API_KEY` / `OPENAI_API_KEY`, or a client-provided gateway | stdio, http, and `acp` per its README |
| Cursor | `cursor-agent acp` (registry binary entry, `args: ["acp"]`); Cursor's docs write `agent acp` | No | n/a (separate download from `downloads.cursor.com`) | `agent login` credentials reused; `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`; ACP auth method `cursor_login` | Docs: servers from project or user `.cursor/mcp.json`; team servers unsupported in ACP mode. bb pre-approves its injected server by writing Cursor's `mcp-approvals.json` (see `tools-and-mcp.md`) |
| OpenCode | `opencode acp` (registry `opencode` and `opencode-v2`, binary + `args: ["acp"]`) | No | n/a | `opencode auth login`; bb notes it for usage reads | accepted; permission quirks below |
| Gemini CLI | `gemini --acp` (registry: `npx @google/gemini-cli@0.68.0 --acp`) | No | n/a | Not stated on the ACP docs page (last updated 2026-04-10) | Docs say the client's MCP server details come in the `initialize` handshake (odd wording, treat as unverified) |
| GitHub Copilot CLI | `copilot --acp` (registry `npx @github/copilot@1.0.113 --acp`) | No | n/a | not read | not read |
| Grok Build | `grok agent stdio` (registry `npx @xai-official/grok@1.0.89 agent stdio`) | No | n/a | advertises `cached_token` and `xai.api_key` auth methods; bb and Orca pick one and call `authenticate` | not read |
| Pi | `pi-acp` 0.0.34 (community, `svkozak/pi-acp`, MIT), registry `npx pi-acp@0.0.34` | Yes | No: it spawns the user's `pi --mode rpc` (needs `pi` 0.81+ on PATH) | `pi` configured separately; `pi-acp --terminal-login` | **accepted but not wired through to pi** (adapter README, fetched 2026-11-17) |
| omp, Hermes, Kimi, Antigravity, Devin | `omp acp`, `hermes acp`, Kimi and Antigravity specs in Orca, `devin` registry binary | No | n/a | each has a login command (`omp login`, `hermes login`) | not read |

Notes on the table:

- Versions and commands come from `agent.json` files in the registry clone and from `known-agents.ts` (bb) and `acp-launch-registry.ts` (Orca). Where two sources disagree the table shows both (Cursor: `cursor-agent` vs `agent`).
- The registry lists `claude-acp` license as `proprietary` while the adapter's `package.json` and `LICENSE` say Apache-2.0. The adapter bundles the Claude CLI in its binary archives; that is the likely reason **[inferred]**. Not resolved.
- Gemini: the docs page carries a notice that Gemini CLI "was replaced by Antigravity CLI on June 18th, 2026" for unpaid-tier and Google One users; the registry has both `gemini` and `antigravity-acp`.

## Claude adapter details (`claude-agent-acp` at `3205f0b`)

- `package.json`: dependencies `@agentclientprotocol/sdk` 2.7.0, `@anthropic-ai/claude-agent-sdk` 0.3.326, `diff`, `zod`; Node >= 22; binary name `claude-agent-acp`.
- `src/claude-cli.ts` `claudeCliPath()` resolves the CLI in this order: `CLAUDE_CODE_EXECUTABLE`, a `claude` placed next to a standalone executable, then the SDK's `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` package. The file comment explains that a Bun-compiled executable cannot run an embedded file, so release archives ship the CLI beside it.
- With the user's CLI (`CLAUDE_CODE_EXECUTABLE`) MCP servers are passed in `--mcp-config` on the command line, so other local users can read their `env` and `headers`; with the bundled CLI they go over stdin (`mcpServersDelivery()`, README "Standalone executables"). A CLI older than the SDK expects can fail at startup (the file names 2.1.323).
- `session/new` accepts `_meta.claudeCode.options` (arbitrary Claude Agent SDK options, merged: cwd, permissionMode, canUseTool and executable are ignored, hooks/mcpServers/disallowedTools merged) and `_meta.claudeCode.emitRawSDKMessages` (raw SDK messages as `_claude/sdkMessage` notifications) (`src/new-session-meta.ts`). This is the escape hatch for anything ACP does not carry.
- Setting sources: the adapter loads `["user", "project", "local"]` (`src/v1/acp-agent.ts:10152`), so the user's `~/.claude` settings, hooks, plugins, MCP servers and CLAUDE.md apply. Clowdy's current engine deliberately restricts this (`settingSources: ['project']`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, no `CLAUDE_CONFIG_DIR`); whether the adapter exposes an equivalent switch beyond `_meta.claudeCode.options` was not checked.
- `--hide-claude-auth` flag: "this integration must never bill a claude.ai subscription, except a Claude Enterprise plan"; it hides the subscription login method and refuses sessions and turns whose account is Free/Pro/Max/Team (`src/hide-claude-auth.ts`, `CHANGELOG.md` entries #1079 and #1641). See `policy.md`.
- Modes are exposed as a `mode` config option backed by SDK permission modes; `Auto` falls back to `acceptEdits` on models that do not support it (`src/session-mode.ts`).

## Codex adapter details (`codex-acp` at `b9503ae`)

- README: "`codex-acp` is a stdio ACP agent server. It starts the Codex App Server, translates ACP requests into Codex operations". Install `npx -y @agentclientprotocol/codex-acp`; "The npm package includes a compatible `@openai/codex` dependency. Set `CODEX_PATH` only when you want the adapter to run a different Codex binary."
- Runtime options: `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_PATH`, `CODEX_CONFIG` (JSON merged into the Codex session config), `MODEL_PROVIDER`, `INITIAL_AGENT_MODE` (`read-only`, `workspace-write`, `agent`, `agent-full-access`, `permission-profile:<id>`), `NO_BROWSER`.
- Subagents: reported as ACP child sessions when the client sets `clientCapabilities.subagents: {}`; otherwise an ordinary tool call.
- MCP-over-ACP: "Check `agentCapabilities.mcpCapabilities.acp: true`". The adapter probes the running Codex binary's feature list and does not advertise the ACP transport when it cannot confirm `mcp_2026_07_28` support, for example with an older `CODEX_PATH` (`docs/mcp-over-acp.md`).
- Steering extension `_session/steering` (`docs/steering.md`); token and quota meta (`src/QuotaMeta.ts`, `src/TokenCount.ts`); rate-limit snapshots read from Codex (`src/RateLimitsMap.ts`). Whether those rate limits reach the ACP client without the JetBrains AIR extension was not verified.

## The ACP registry

- Repo `agentclientprotocol/registry` at `df2ae8a`. Published at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (README), plus JetBrains-flavoured variants. 47 agent directories at this commit; distribution kinds: npx 21, binary 21, binary+npx 3, uvx 2 (my count from the `agent.json` files).
- Manifest (`FORMAT.md`): `id`, `name`, `version`, `description`, `repository`, `website`, `authors`, `license`, `license_url` (required), `icon` (16x16 SVG), `distribution { binary { <platform>: { archive, sha256?, cmd, args?, env? } }, npx { package, args?, env? }, uvx { package, args? } }`, optional `preview { version, distribution }` channel. Platforms: `darwin-aarch64|x86_64`, `linux-aarch64|x86_64` (+ `-musl`), `windows-aarch64|x86_64`.
- Admission rule (`AUTHENTICATION.md`): an agent must support at least one of **Agent Auth** (agent runs its own OAuth, local server + browser) or **Terminal Auth** (client launches the agent program with extra `args`/`env` in an interactive terminal).
- `quarantine.json` lists five agents with a reason each (postinstall script, missing dependency, timeout waiting for initialize...). The registry therefore runs a launch check per agent in CI (the `FORMAT.md` preview section says preview distributions are never launched, implying stable ones are).
- Version pins are exact (`@agentclientprotocol/claude-agent-acp@0.108.0`); the registry updates "hourly" per the `FORMAT.md` preview text.

## What bb and Orca do for Claude and Codex (so "ACP for everything" is not what either does)

| | Claude Code | Codex | Other agents |
| --- | --- | --- | --- |
| **bb** | `plugins/provider-claude-code`: depends on `@anthropic-ai/claude-agent-sdk ^0.3.318` and passes `pathToClaudeCodeExecutable` resolved from `BB_CLAUDE_CODE_EXECUTABLE` or login-shell PATH; error text tells the user to install Claude Code when the native binary is absent (`src/bridge/missing-cli-error.ts`) | `plugins/provider-codex`: `codex app-server` bridge | ACP for Cursor, OpenCode, omp, Grok, Hermes and any custom/registry agent; Pi has its own bridge that runs `pi` in RPC mode |
| **Orca** | `src/main/claude/claude-stream-json-connection.ts` imports `@anthropic-ai/claude-agent-sdk` 0.3.319 as a library and sets `pathToClaudeCodeExecutable` to "Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed" | `src/main/codex/app-server/*` | ACP for grok, opencode, opencode2, omp, antigravity, copilot, kimi, cursor, hermes (`src/main/acp/launch/acp-launch-registry.ts`); `src/shared/agent-launch/catalog/tui-agent-config.ts` configures about 45 terminal agents in all; the rest run only as TUIs |

Both found the same pragmatic answer for Claude Code: keep the SDK as a JS library, never use its bundled binary, always point it at the user's installed `claude`. Clowdy's current engine already supports the pointing half (`CLOWDY_CLAUDE_BIN` in `apps/daemon/src/engine/claude/config.ts`) but pins and ships the SDK's binary by default.

## Constraints

- An adapter fetched with `npx` needs Node and network on first use and trusts a third-party package at run time. The registry's binary archives avoid Node but are per-platform downloads (Claude's archive contains the CLI, which brings back the "ship the agent" question).
- Adapter and CLI versions must be compatible: the Claude adapter warns about older CLIs, the Codex adapter feature-probes the binary.
- Registry entries pin an exact version, so an `npx` launch is not "whatever the user has"; it is "this adapter version, plus whichever agent binary the adapter finds".

## Sources

- https://github.com/agentclientprotocol/registry at `df2ae8a`: `FORMAT.md`, `AUTHENTICATION.md`, `quarantine.json`, `claude-acp/agent.json`, `codex-acp/agent.json`, `cursor/agent.json`, `opencode/agent.json`, `gemini/agent.json`, `pi-acp/agent.json`, `grok-build/agent.json`, `github-copilot-cli/agent.json` (2026-11-17)
- https://github.com/agentclientprotocol/claude-agent-acp at `3205f0b` (2026-11-17): `package.json`, `README.md`, `src/claude-cli.ts`, `src/new-session-meta.ts`, `src/hide-claude-auth.ts`, `docs/subagent-sessions.md`
- https://github.com/agentclientprotocol/codex-acp at `b9503ae` (2026-11-17): `package.json`, `README.md`, `docs/mcp-over-acp.md`, `docs/steering.md`, `src/CodexCli.ts`
- https://github.com/svkozak/pi-acp README (fetched 2026-11-17)
- https://cursor.com/docs/cli/acp (fetched 2026-11-17); https://geminicli.com/docs/cli/acp-mode/ (page says updated 2026-04-10)
- bb at `f1c5304`: `plugins/provider-acp/src/known-agents.ts`; Orca at `cbc8119e`: `src/main/acp/launch/acp-launch-registry.ts`

## Open questions

- Does `codex` itself have a native ACP mode today? No flag appeared in any source I read, and the registry lists only the adapter. Not checked in the `openai/codex` repo.
- MCP behavior of Copilot CLI, Grok, Hermes, omp, Kimi, Antigravity, Devin: not read.
- Whether `claude-agent-acp` can start Claude Code without loading the user's global settings (an isolation switch) without hand-written `_meta.claudeCode.options`.

## Assumptions and limits

- I did not run any adapter or agent, so every "accepts/ignores" statement is from docs and source, not from a live `initialize` reply. A live probe of `mcpCapabilities` per agent would be the first thing to verify.
- bb and Orca facts about Claude and Codex come from their source trees at the cited commits; both projects move fast.
