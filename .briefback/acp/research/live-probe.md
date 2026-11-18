# Live probes on the owner's machine

2026-11-17, macOS, Bun 1.4.4. Agents found by `Discovery` (login-shell `PATH` plus install folders): `claude` 2.1.322, `codex` 0.166.0, `cursor-agent` 2026.11.13-eacade1, all in `~/.local/bin`. Not installed: `opencode`, `gemini`, `copilot`, `grok`, `omp`, `hermes`. No probe sent a prompt, so no model was called and no quota was spent.

## Cursor over ACP: works

`bun run probe cursor` (`apps/daemon/src/probe.ts`): `cursor-agent acp` answered `initialize` in about 370 ms with protocol version 1.

- Capabilities: `loadSession: true`, **no** `sessionCapabilities.resume` (so Clowdy resumes with `session/load` and swallows the replay), `mcpCapabilities: { http: true, sse: true }`, images yes, audio no, `sessionCapabilities.list`. No `systemPrompt` capability, so the engine prefixes the first message.
- `session/new` with Clowdy's stdio MCP server in `mcpServers` was accepted. Modes `agent`, `plan`, `ask`; config options `mode` and `model` (category `model`, so `model` selection has something to set). Auth method `cursor_login`.
- Not checked: that Cursor actually starts the bridge and lists its tool. Cursor's docs say MCP servers need approval on disk (bb writes `~/.cursor/projects/<slug>/mcp-approvals.json`); Clowdy does not, so tools may not reach Cursor until that is built or the user approves the server.

## Claude Code through the Agent SDK: handshake works with an older CLI

The SDK Clowdy pins (0.3.325, built against Claude Code 2.1.325) started the owner's `claude` 2.1.322 as `pathToClaudeCodeExecutable` and answered the control requests `accountInfo()` and `supportedModels()` (models `default`, `opus`, `claude-fable-5-2[1m]`, `sonnet`, `haiku`). So a CLI three patch versions older than the SDK's own works at the protocol level. A full turn was not run.

## Codex through its ACP adapter: not checked

`@agentclientprotocol/codex-acp@2.7.0` is fetched by `npx -y`, which downloads and runs an npm package. The session's permission classifier refused that call, so the adapter was not started. To check on the owner's machine: `cd apps/daemon && bun run probe codex` (needs network once). What it should show: `initialize`, then `session/new` accepted with the bridge, with `CODEX_PATH` set to the owner's `codex` and `npm_config_omit=optional` so no bundled Codex is fetched. If the adapter ignores `npm_config_omit` and fetches the platform package anyway, the download is large and the catalog needs another way to avoid it.

## Also not checked

- A real prompt on any agent, and a tool call from a real agent through the bridge (the fake ACP agent covers that path in tests).
- Whether Claude Code or Codex accept a plain stdio MCP server that answers only `initialize`, `tools/list`, `tools/call` and `ping` (the bridge's tools-only dialect); Cursor's `initialize` answer says nothing about it.
- Codex's MCP tool timeout against a long `run_wait` or `ask_user`.
