# Live probes: what the Claude and Codex ACP adapters do with background work

Probes of 2026-11-19 against `@agentclientprotocol/claude-agent-acp@0.107.0` (Claude Code 2.1.312, model haiku) and `@agentclientprotocol/codex-acp@2.6.0` (codex-cli 0.166.0). Repeat or extend them with [probe-harness.ts.txt](probe-harness.ts.txt).

## Summary

1. **Claude can tell a client everything, if the client asks.** On ACP v1 the adapter has opt-in extensions that publish every background task, every background sub-agent and every turn Claude starts on its own as explicit start and end events. Without the opt-in the only signal is `_meta.claudeCode.toolResponse.backgroundTaskId` on a `Bash` call and a burst of updates with no prompt behind them.
2. **The SDK Clowdy uses drops those events.** `@agentclientprotocol/sdk` 2.7.0 validates `session/update` against a closed union: an unknown `sessionUpdate` (`async_task_*`, `subagent_*`) answers `Invalid params` and never reaches `onNotification` (checked offline with a pair of in-memory streams). The v1 path needs a tap on the agent's stdout that reads those lines before the SDK does.
3. **A user message can go straight into the live session.** A plain `session/prompt` sent while a background task runs is answered at once on the same process. One sent during a turn the agent started itself waits for that turn to end, then runs. `_session/steering` refuses both cases (`promptRequired`).
4. **Closing needs a handoff guard.** Between the last "done" marker and the start of the agent's report turn there is a gap of 0.1 to 0.9 s (eight samples, v1 and v2) with nothing open. A client that closes the session the moment nothing is open kills the report.
5. **ACP v2 (draft) does the same job with standard events, and Claude's adapter already serves it.** Background shell commands, sub-agents and workflows are all listed in `state_update.background`; a prompt sent while a turn runs behaves as a steer, so `_session/steering` is not needed there. v2 is the spec's recommended direction; v1-only agents answer `protocolVersion: 1` and stay on a v1 layer (see "Handshake").
6. **Codex has no background work to wait for, on v1 or v2.** Its commands that "go to the background" are plain `nohup` children; nothing marks them and nothing starts a later turn. Steering works on both versions.
7. **Cursor is v1 only, cannot steer, and reports no background work.** A second prompt sent mid-turn cancels the running turn and runs instead (an implicit stop and send).

## Setup

- A raw JSON-RPC client (no SDK, so unknown update kinds are visible) starts the adapter the way `AcpSession` does: own process group, `bun x --bun <package>@<pin>`, the program's own login, `npm_config_omit=optional`, Claude Code markers and provider keys scrubbed. Permission requests are allowed.
- Client opt-ins used on v1: `clientCapabilities._meta.jetbrains.air = { version: 1, capabilities: [...] }` with `asyncTasks`, `backgroundSubagents`, `nativeSubagentSessions`; and the standard-track form `clientCapabilities.subagents = {}`. On v2: `initialize` with `protocolVersion: 2`, `info` and `capabilities`.
- Prompts ask for one background command (or sub-agent, or workflow) and an immediate `OK`.

## Results

### Claude v1 with `asyncTasks` and `backgroundSubagents` (scenario s1, s4)

| Time | Event |
| --- | --- |
| 3.4 s | `async_task_spawned` (`taskType: shell`, `canStop`, `toolCallId`), then `async_task_progress` with `outputFilePath` |
| 4.5 s | `session/prompt` returns `end_turn`; process alive |
| 15.4 s | `async_task_state_update` `completed` |
| 15.5 s | `async_task_spawned` with `taskType: turn`, name "Claude is working", description = the notification text (gap **0.1 s**) |
| 16.9 s | the agent's report as `agent_message_chunk` |
| 17.0 s | `async_task_state_update` `completed` for the turn task: the end of the agent-started turn |

### Background sub-agents

| Case | What happened |
| --- | --- |
| Opt-ins `asyncTasks` + `backgroundSubagents` (s2) | `session/prompt` returned at 4.7 s. The sub-agent's own tool calls arrived later with `_meta.claudeCode.parentToolUseId`. **No async task is published for a sub-agent.** Its report started a turn task at 17.9 s |
| Plus `nativeSubagentSessions` or `subagents: {}` (s7, s8) | `subagent_spawned` (id, name, task, prompt) at 3.5 s, `subagent_state_update` `completed` at 16.5 s, the turn task at 17.1 s (gap **0.6 s**). Both forms behave the same |
| `backgroundSubagents` **not** declared (s3) | `session/prompt` was **held** until the sub-agent finished (17.9 s) and all its traffic stayed inside the prompt. `_session/steering` at 8.5 s answered `injected` and the final answer ended with the steered word |

### Messages to a live session (v1)

| Case | What happened |
| --- | --- |
| `session/prompt` while a task runs and no turn runs (s4) | Answered in 1.1 s on the same process, `end_turn` |
| `session/prompt` sent as the agent-started turn began (s4) | Queued: the agent's 40-line report finished at 13.7 s, the prompt's answer started at 14.4 s and returned at 14.6 s |
| `_session/steering` with `promptRequired` while a task runs, and during an agent-started turn (s9) | `promptRequired`, reason `noRunningTurn` both times |

### Workflow (s5)

`async_task_spawned` with `taskType: workflow` and the workflow's name, a progress update and `async_task_state_update` `completed`. The trivial workflow finished in 12 ms, so a report turn after a long workflow was not exercised.

### Claude v2 (s6)

- `initialize` answered `protocolVersion: 2`. `session/prompt` returns `{ messageId }` at once; the work is reported by `state_update`: `running`, `idle` with `stopReason` and `usage`.
- The background `Bash` command appeared in `state_update.background` as `{ type: 'terminal', terminalId }`; its exit emptied the list.
- A second prompt sent while the turn ran was inserted (`user_message`) and the final answer contained the word it asked for: a prompt during a running turn acts as a steer.
- Report turn: `idle` with `background: []` at 17.5 s, `running` at 18.1 s (gap **0.6 s**), `idle` with `stopReason` at 18.9 s.
- **Background sub-agent (s10):** `subagent_update` announces the child (`sessionId`, title, `state`, `capabilities.cancel`) and `state_update` lists `background: [{ type: 'subagent', sessionId }]`. The child's tool calls and `session_message`s (the prompt to it, its report back) keep arriving after the parent's `idle`. The child's own `idle` at 16.7 s empties the list; the report turn starts 0.8 s later.
- **Workflow (s11):** the `Workflow` tool call stays `in_progress` and is listed as `{ type: 'tool_call', toolCallId }`; its progress is the call's content; its end is `completed` plus `idle` with `background: []` at 12.1 s, the report turn at 12.8 s (gap **0.7 s**; the agent read the workflow's output files and answered).
- A prompt sent while only a background task runs (s13) was inserted at once and answered in 2.4 s. The harness did not catch a prompt **during the report turn** on v2; that case is still open.

### Claude v1 with a longer workflow (s12)

`async_task_spawned` (`workflow`) at 6.6 s, progress with usage and duration, `completed` at 20.5 s, the turn task at 21.4 s (gap **0.9 s**), completed at 21.9 s. A workflow's report turn works on v1 with the opt-in.

### Handshake of the agents installed here (no model call)

| Agent | v2-shaped `initialize` (`protocolVersion: 2`, `info`, `capabilities`) |
| --- | --- |
| Claude adapter, Codex adapter | Answer `protocolVersion: 2` |
| `cursor-agent acp` | Answers `protocolVersion: 1` and ignores the v2 shape. A v1 `initialize` on the same process afterwards is accepted. A v1-shaped request with `protocolVersion: 2` also gets 1 |
| opencode, omp (pi), hermes, gemini, copilot, grok | Not installed on this machine: untested |

The spec's migration guide (`agentclientprotocol.com/protocol/v2/migration`) recommends v1 and v2 as thin layers behind shared logic, the client choosing one layer per connection after `initialize`; a v1-only agent "may answer `protocolVersion: 1`" and the client continues only if it supports v1; a legacy agent "may not" accept a repeated `initialize`; v2 as a whole is still labeled draft and should be gated behind negotiation and flags. v2 breaking changes the client layer must absorb: `session/prompt` returns `{ messageId }` and the turn ends at the idle `state_update`; message upserts by `messageId`; no `tool_call` (the first `tool_call_update` creates the call); `session/load` removed (`session/resume` with `replayFrom`); no `fs/*` or `terminal/*`; modes folded into config options; `usage` rides on the idle `state_update`.

### Codex v1 and v2 (c1, c2)

- The model ran `nohup sh -c 'sleep 15; echo ...' &` inside a normal `exec_command`; the tool call completed at once.
- No async task, no `background` list in `state_update`, and no turn when the command finished, on either version.
- Steering: v1 `_session/steering` answered `injected`; on v2 a prompt during the running turn was inserted. Both answers contained the steered word.
- Caveat: one phrasing of the prompt. A Codex terminal session that outlives its call (unified exec) was not exercised.

### Cursor (u1, u2; `cursor-agent acp`, own config folder as Clowdy runs it)

- Protocol: answers `protocolVersion: 1` to a v2 handshake (see "Handshake"); v1 only.
- Steering: `_session/steering` answers `Method not found`; `initialize` carries no `_meta.steering`, so `canSteer` is false and Clowdy never asks.
- A second `session/prompt` sent while a turn runs **cancels the running turn**: the first prompt returned `stopReason: cancelled` at the moment the second was sent, and the second ran to `end_turn` (Cursor's own stop and send). Clowdy sends one prompt per session, so it never triggers this.
- Background work: the command ("in the background") was a terminal call that completed at once with empty output; nothing was reported when it later finished and no turn started on its own in the 55 s after the prompt returned. No markers, no agent-started turns.
- Cursor asked for permission for the command (`allow-once`), which the daemon answers.

## What this proves

- The adapter and Claude Code keep a session alive between prompts and start turns by themselves; the client only has to keep the process and the connection.
- Every start and end the plan needs is available as a marker on Claude: tasks, sub-agents and agent-started turns on v1 with the opt-ins, or `state_update` and `background` on v2. The quiet-window guess of the first research is not needed.
- A held turn (no `backgroundSubagents`) keeps sub-agents working and steering works inside it, which is today's behaviour in Clowdy.

## What it does not prove

- Codex or any other agent with a real background-work feature (only one phrasing was tried).
- A prompt during the report turn on v2; a second background task started inside a report turn; a daemon restart.
- The handshake of any agent that is not installed here (opencode, omp, hermes, gemini, copilot, grok): a strict legacy agent could reject a v2-shaped `initialize` instead of answering 1.
- That the gap stays below 1 s on a loaded machine: eight samples between 0.1 and 0.9 s.

## Sources

- The probe runs of 2026-11-19 (this page).
- Adapter source in the bun cache (`claude-agent-acp@0.107.0`): `air-extension.js`, `async-tasks.js`, `v1/acp-agent.js` (`endsTurnsWithLiveSubagents`, `turnAwaitingSubagents`, `startAutonomousCycle`, `steer`), `v1/steering.js`, `v2/tasks.js`, `v2/background.js`.
- `@agentclientprotocol/sdk@2.7.0`: v2 `state_update`, `background`, `PromptResponse` in `dist/v2/unstable/schema/types.gen.d.ts`.
- `.briefback/acp/research/bb-source.md` for how bb drives Claude (Agent SDK, not ACP).
