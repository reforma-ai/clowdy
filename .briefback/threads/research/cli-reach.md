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
- Codex needs `sandbox_workspace_write.network_access=true`. The daemon has to start Codex's adapter with that override (`-c`), or the command fails with a connection error in a sandboxed session. Without it, the model may ask for an escalation; the daemon would answer the permission request with allow, but that is the model's choice, not a guarantee. This is the open item to check with the real adapter (`codex-acp` accepting `-c`), recorded in Stage 4 of `plan.md`.
- The MCP route is not blocked by the sandbox (the MCP server is a child of the adapter, outside the sandbox). That is the fallback if a Codex session cannot be given network access.
- Not checked: the ACP adapters themselves (`@agentclientprotocol/claude-agent-acp`, `codex-acp`), the shell tools of other agents, Windows.
