# Can an agent's shell reach the daemon? A check of Claude Code, Codex and Cursor

Date: 2026-11-20. Method: a loopback HTTP listener and a one-line shell shim on `PATH`, started by hand outside Clowdy; each agent's own CLI was told to run `clowdy thread list` (tiny prompt, cheapest model that works). The agents were started as `claude -p`, `codex exec`, `cursor-agent -p`, not through their ACP adapters, so this shows the agent's shell, not the adapter's session setup.

| Agent | `PATH` entry and env vars reach the shell | Loopback HTTP from the shell | Note |
| --- | --- | --- | --- |
| Claude Code 2.1.312 | yes (`CLOWDY_CLI_AUTH`, `CLOWDY_BRIDGE_TOKEN`, a shim dir on `PATH`) | yes | `--allowedTools Bash` |
| Cursor (`cursor-agent -p --force`) | yes | yes | |
| Codex 0.166.0, `-s workspace-write` | yes: both names, including the one with `TOKEN` in it, pass | **no**: `curl` exits 7 in 0 ms; a Unix socket under `/tmp` is blocked as well | The sandbox forbids all network from a shell command |
| Codex 0.166.0, `-s workspace-write -c sandbox_workspace_write.network_access=true` | yes | **yes** | The one setting that matters |

Consequences for the design:

- A shell command is a fine transport for Claude Code and Cursor. Environment variables and `PATH` come through, so the credential travels in the environment, and `CLOWDY_CLI` (the shim's absolute path) is a fallback when `PATH` is rewritten.
- Codex needs `sandbox_workspace_write.network_access=true` when run as `codex exec`. **Superseded by the section below:** through `codex-acp` that key has no effect, and the way through is an escalation the model asks for.
- The MCP route is not blocked by the sandbox (the MCP server is a child of the adapter, outside the sandbox). That is the fallback if a Codex session cannot reach the daemon.
- Not checked: the ACP adapters themselves (`@agentclientprotocol/claude-agent-acp`, `codex-acp`), the shell tools of other agents, Windows.

## Through the real ACP adapters (2026-11-20, after Stage 4)

Method: a scratch daemon from this branch on its own data folder and port (`CLOWDY_ENGINE=claude`, its own personal and projects folders), driven over its HTTP API: a chat is asked to run `clowdy thread spawn --title Pong --prompt "Reply with exactly the word PONG..."` and to report what the thread answers. Cheapest model of each agent: Claude Code `haiku` through `@agentclientprotocol/claude-agent-acp` 0.107.0, Cursor `composer-2.5`, Codex `gpt-6-luna` through `codex-acp` 2.6.0.

| Agent | Result |
| --- | --- |
| Claude Code | Works. The command ran from the Bash tool, the thread chat was made with its parent link, it answered `PONG`, the parent got a `threadNotice` and answered. About 19 s in all. A second run used `list`, `tell` (the thread took the message and answered `SKIPPED` while its own `sleep` ran as background work) and `wait` (returned), and then, when the thread's background command finished and the agent started a turn by itself, the parent was told **again** and woke: the notice at every stop works, background work included |
| Cursor | Works the same way (spawn, answer, notice, parent's answer, about 22 s) |
| Codex | **The first call fails with `EPERM` (exit 4)**: the sandbox of a shell command refuses the loopback connection. Told only to show the error, it reports it and starts no thread. Told in the prompt to run the command again with escalated permissions when that happens, it asks, the daemon's permission policy allows it, and the whole flow works (spawn, answer, notice, parent's answer, about 60 s). A session setting does not open the sandbox: `codex-acp` 2.6.0 builds each turn's sandbox from fixed mode presets with `networkAccess: false` (`CODEX_CONFIG` `sandbox_workspace_write.network_access` has no effect; tried), and only `agent-full-access` opens it, which Clowdy does not choose for the person |

What follows for the design: the hint to escalate is in the `clowdy` command's own `EPERM` error and in the threads paragraph of the system prompt (Stage 4), so Codex does it on its own. MCP stays the fallback if that turns out unreliable. Not checked: Windows, other agents, a Codex that declines the escalation.
