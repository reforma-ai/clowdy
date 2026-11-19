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
- That the gap stays below 1 s on a loaded machine: eight samples between 0.1 and 0.9 s (it did not through the real daemon: see "Real check through the daemon").

## Real check through the daemon (2026-11-19)

Stage 7. A scratch daemon from the worktree (own data folder, port, personal folder; the catalog switched to v2 by a launcher in the scratchpad, not by editing it) driven over its HTTP API, with the user's own `claude` 2.1.312 (haiku), `codex` 0.166.0 and `cursor-agent` 2026.11.13. A few model calls per scenario. Times are seconds from the first message unless said otherwise. Every scenario passed after the fixes below; the catalog now has `protocol: 'v2'` for `claude` and `codex`.

### Claude Code on v2

| Scenario | Result | Numbers |
| --- | --- | --- |
| Normal turn | `succeeded` at `done`, no process kept | 4.2 s; the group still had 3 processes at the moment of `succeeded` and none 3 s later |
| Resume (second message) | Same session, `succeeded` | 2.4 s |
| Steer mid-turn | Lands after the running tool call ends (Claude takes it at the next boundary); one answer, one `done`, one usage | Sent 2.5 s after the tool began; the adapter echoes it (`user_message`) 0.1 s after the tool ended, then `idle` (zero usage), `running` 2 ms later, the answer as one chunk, `idle` with the usage. Before the fix the stream had the answer twice |
| Stop mid-turn (foreground tool) | `cancelled`, the tool item is "Stopped before it finished", the group is gone | 0.0 s to `cancelled`, gone within 0.5 s |
| 60 s background command | Turn ends, `waiting_background`, `Run.background` lists the command with its real text (`terminal_update.command`, so no naming fix was needed), the process stays recorded; at the end a note, then the report as a new turn with no `user` item (a `Read` of the output file, then the text), then `succeeded` | `waiting_background` at 4.4 s (the list appears 1.1 s earlier, while the turn still runs); command ends at 63.3 s; `succeeded` 2.0 s after the report's `done` (the short guard); process gone 3 s later. The command runs as a child of `claude` in a process group of its own |
| Message while it waits | Goes to the live session: `waiting_background -> queued -> running` in 0.00 s, answered ("42") in 1.8 s, back to `waiting_background`, the same pid, the command and its report unaffected | Message at +8 s after the wait began |
| Background sub-agent | Item `subagent` titled by `subagent_update.title`; report turn arrives; `succeeded`. The stream shows only the parent's text: no sub-agent tool calls, no child run (Stage 8). The list flapped `[subagent] -> [] -> [subagent]` within 6 ms when the sub-agent woke for its own report, which wrote the note "Background sub-agent finished" twice | Waiting at 5.0 s; report turn 43.2 s |
| Workflow | Item `task` titled "Workflow", then "Workflow: Run: sleep-echo"; the `Workflow` call stayed `running` while the run waited and ended `done`, never `error`; report turn follows | Waiting at 6.0 s; call done at 18.6 s |
| Stop during the wait | `cancelled`, the command is gone. Before the fix the command survived (see below) | 0.04 s to `cancelled`; no `sleep 60` 0.3 s later |
| Daemon stopped (SIGTERM) while it waits | The daemon stops, no agent process and no command left; after the start the run is `interrupted` ("Daemon restarted"), `Run.background` cleared, the items kept in the work record; the next message carries "The background work you had running was lost ..." with the command, and the agent says so | Stop took under 8 s |
| Daemon killed (SIGKILL) while it waits | The adapter leaves with the daemon, `claude` stays 1 to 2 s and takes its shell command with it; startup finds nothing alive; same `interrupted` and the same message | Back up 1.9 s after the kill |
| `ask_user` in an agent-started turn (semi chat) | The tool answers with `Illegal run transition waiting_background -> waiting_user`. The agent retried twice, then told the person in its text that it could not ask. The failed call is not in the stream (`ask_user` calls never show as tools) | Seen once |
| A permission request | Not a case: the daemon answers every request itself | |

### Gap between the last "background empty" snapshot and the report turn

Measured from the layer's trace: the `background` snapshot that empties the list, to the `running` that begins the report turn.

| Run | Gap |
| --- | --- |
| 60 s command, 2 s guard | 1.659 s |
| 60 s command with a question sent while it waited, 2 s guard | **No `running` within 2.003 s: the guard closed the session and the report was lost.** Claude Code had already begun the call (transcript: notification at +0.07 s, API request at +0.24 s) |
| 60 s command, three runs with a 30 s guard | 1.159, 0.938, 0.760 s |
| Same with a question, 30 s guard | 0.976 s |
| After the fix (20 s report wait): three 60 s runs, one with a question, one on the shipped catalog | 0.791, 0.831, 0.860, 0.812, 1.115 s |
| Sub-agent, workflow, a 20 s command | 0.859, 0.745, 1.012 s |

So the gap is 0.75 to 1.7 s, not the 0.1 to 0.9 s of the first probes, and once more than 2 s. The cause is in the adapter: for a turn Claude Code starts by itself the adapter says `running` only when the main conversation's first output arrives (`outputStarts` in `v2/session.js`), so the gap is the model's time to first output and has no upper bound. There is no earlier marker on v2 (v1 with the AIR opt-in announced such a turn 0.1 s after the end). Codex and Cursor are not affected (they report nothing).

### Codex on v2

| Scenario | Result | Numbers |
| --- | --- | --- |
| Normal turn, resume | `succeeded` at `done`, same session, no process left | 7.5 s, resume 5.6 s |
| Steer mid-turn (a tool call running; once more during plain text) | Never lands: Codex holds the prompt, answers after the turn, and `steer` returns false. The runtime sends the message again as the next turn (second answer "FIRST\nSTEERED"). The `done` was **not** delayed: 1 ms after the `idle`. The 2 s hold of a landed steer did not come up on Codex or on Claude; it stays for an agent that echoes a steer and then folds it | Steer 2.5 s into the tool call; text-only: 0.6 s after the text began |
| Stop mid-turn | `cancelled`, tool item stopped, group gone | 0.0 s, gone within 2 s |
| `nohup ... &` | `succeeded` at `done`, never `waiting_background`; the command was killed with the group | 15.4 s |

### Cursor on v1

A normal turn and a resume end at `done` (9.4 s, 6.7 s); no `waiting_background`. A "run in background" command (`nohup sh -c ... &`) ended the run at `done` in 12.8 s. The command itself was left running: Cursor starts it in a group of its own and it is already orphaned (parent 1) when the session stops, so nothing finds it. That is how v1 behaved before this work; it was killed by hand.

### What differed from the fakes

- A landed steer in Claude's adapter says the repeated answer as one `agent_message_chunk` under a new id, not as a whole `agent_message`, so the repeat check did not see it.
- The report turn begins at the model's first output, not at the end of the work: a 2 s guard loses it now and then.
- Claude Code starts each shell command, background or not, in a process group of its own. A signal to the adapter's group never reaches it, and it outlives the adapter: Stop on a waiting run left the command running, and Stop on a foreground tool left its shell.
- Claude Code refuses a standalone `sleep 60` in the foreground ("Blocked: standalone sleep"); a long foreground test needs another program.
- The background item shows up while the turn is still running, before its `done`.

### What was fixed

| Defect | Fix | Test |
| --- | --- | --- |
| The answer appeared twice after a landed steer | `UpdateMapperV2` holds the start of a message that may repeat the last one (after a landed steer) until it ends: `mapper-v2.ts`, `mapper-core.ts` | `acp-mapper.test.ts`, `acp-session.test.ts` (the fake v2 agent's `twice` now repeats as a chunk, `twice whole` as a message) |
| A report turn later than 2 s was lost | A second wait, `BACKGROUND_REPORT_MS` (20 s), for the report of work that just ended while no turn ran; the 2 s `BACKGROUND_HANDOFF_MS` stays for the turn after a turn: `layer.ts`, `v2.ts`, knob `backgroundReportMs` | `acp-session.test.ts`, "the handoff guard" |
| Stop, a daemon stop and startup recovery left the commands an agent started in groups of their own | `AgentProcess.watch` and `stop` remember the processes below the agent and signal them too; `killSurvivor` does the same for a survivor: `engine/process.ts`, `engine/acp/session.ts`, `runs/processes.ts` | `processes.test.ts` |
| `ask_user` in an agent-started turn answered with the internal `Illegal run transition waiting_background -> waiting_user` | `RunService.ask` refuses it first (this wait and the wait for children) with "Can't ask a question while the run waits for background work or child runs" (an error for now, as decided) | `background.test.ts`, `runs.test.ts` |

### Not checked

- A message sent during a report turn, and a second background task started in a report turn, against the real adapter (fakes only).
- Sub-agent traffic and child runs (Stage 8). A foreground sub-agent was not run either; by the adapter's own description (`v2/tasks.js`) the parent is not shown the `Agent` call of a child it announced and the child's traffic is a session of its own, so on v2 a foreground sub-agent leaves no tool card and no child run, where v1 gave a child run.
- Models other than haiku, long contexts, a loaded machine: the report gap probably grows with them, and 20 s is a bound, not a measure.
- A shell command that outlives a hard-killed adapter: here `claude` took its command with it.
- Windows, and the memory a lingering session costs.
- `~/.claude/projects` and `~/.codex/sessions` hold the scratch sessions of this check.

## Sources

- The probe runs of 2026-11-19 (this page).
- Adapter source in the bun cache (`claude-agent-acp@0.107.0`): `air-extension.js`, `async-tasks.js`, `v1/acp-agent.js` (`endsTurnsWithLiveSubagents`, `turnAwaitingSubagents`, `startAutonomousCycle`, `steer`), `v1/steering.js`, `v2/tasks.js`, `v2/background.js`.
- `@agentclientprotocol/sdk@2.7.0`: v2 `state_update`, `background`, `PromptResponse` in `dist/v2/unstable/schema/types.gen.d.ts`.
- `.briefback/acp/research/bb-source.md` for how bb drives Claude (Agent SDK, not ACP).
