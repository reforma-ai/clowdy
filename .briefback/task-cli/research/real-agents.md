# Real agents on `clowdy task`: Claude Code, Cursor, Codex

Date: 2026-11-21. Method: a scratch daemon from `next` at `c30798c` (own data folder, own port, `CLOWDY_AGENT_PERMISSIONS=allow` as by default), started by a driver script that is not kept in the repository. The driver adds a project of one git folder, seeds 100 `To do` and 500 `Done` tasks through `task.create`, opens an autopilot chat on the agent with its cheapest model, and sends one message: list the tasks and report the counts, create a task with a two-line description that depends on the first task, append a note, set it to Review, list what can start now, answer `done`. Afterwards the daemon's own snapshot is read to check the task. Models: Claude Code `haiku`, Cursor `composer-2.5`, Codex `gpt-6-luna` through `codex-acp` 2.6.0 (see "Not checked").

| Agent | Door | Result | Time | Tool calls (failed) | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | shell | task created, appended, in Review, depends on the right task | 34 s | 6 (0) | $0.011, about 207k input tokens. Read the autopilot skill, ran `--help` for `create` and `update`, then the commands |
| Cursor | shell | same | 24 s | 6 (0) | Used `--description-file -` with a heredoc and a `--cursor` value it copied from the answer |
| Codex | shell | same, in both runs | 130 s, 64 s | 15 (1), and 15 (1) | The first `clowdy` call fails with `EPERM` and the command's own message says to run it again with escalated permissions; Codex does, the daemon's policy allows it, and every later call works |
| Codex | MCP (`taskTools: 'mcp'` set by a preload in the scratch daemon) | same, in both runs | 68 s, 72 s | 13 (2), and 15 (2) | The model first tried `clowdy task list` in the shell (the skills and the Tasks line name the command) and got `Unknown command "task"`, then called `task_list` and the rest as MCP tools without trouble |

Tool calls count every tool item of the stream; Codex's include its own `Think` steps, which is why its counts are higher.

What the answers looked like: the first `task list` of Claude Code was 3.7 KB (25 rows, `counts`, the statuses) for a project of 600 tasks. The previous shape (every task, description cut at 400 characters, ids) would have been about 130 KB for the same project, estimated from one row of it (218 characters, 600 rows). Every agent read `total`, `shown` and `counts` correctly and said the 100 open tasks were paged.

## Decision

No built-in agent needs the MCP door, so `AgentSpec.taskTools` stays unset for all of them (the shell door). Codex's shell route costs one failed call per session and, in these runs, no more time than its MCP route (130 s and 64 s against 68 s and 72 s: the spread of one door is wider than the gap between doors). The MCP door still pays for its own mistake the other way round: with one prompt for both doors, an agent on it tries the shell command first and loses a call. If Codex's shell route ever needs a person's approval per call (a stricter `CLOWDY_AGENT_PERMISSIONS`), set `taskTools: 'mcp'` on its spec.

## Not checked

- **Codex adapter 2.8.0.** The catalog pins `@agentclientprotocol/codex-acp@2.8.0`. On this machine `~/.bunfig.toml` has `minimumReleaseAge`, and `bun x` refused that version ("could not be installed, because Bun's minimum release age blocks a version that new": run failed in 2 s with `adapter_unavailable`). The Codex runs above used 2.6.0, set by the scratch daemon's preload. They show the route, not the pinned adapter; run the Codex row again once 2.8.0 has aged past the setting.
- A Codex that declines the escalation, Windows, and the app's own rendering of `Bash` calls for `clowdy task` (they show as `Bash` like `clowdy thread` does).
- A cheaper summary of the first call: the agents ran `clowdy task --help` or `<command> --help` first in most runs; that is 2–3 KB each, not measured separately.
