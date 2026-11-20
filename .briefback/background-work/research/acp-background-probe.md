# Live probes: what the Claude and Codex ACP adapters do with background work

Probes of 2026-11-19 against `@agentclientprotocol/claude-agent-acp@0.107.0` (Claude Code 2.1.312, model haiku) and `@agentclientprotocol/codex-acp@2.6.0` (codex-cli 0.166.0). Repeat or extend them with [probe-harness.ts.txt](probe-harness.ts.txt).

## Summary

1. **Claude can tell a client everything, if the client asks.** On ACP v1 the adapter has opt-in extensions that publish every background task, every background sub-agent and every turn Claude starts on its own as explicit start and end events. Without the opt-in the only signal is `_meta.claudeCode.toolResponse.backgroundTaskId` on a `Bash` call and a burst of updates with no prompt behind them.
2. **The SDK Clowdy uses drops those events.** `@agentclientprotocol/sdk` 2.7.0 validates `session/update` against a closed union: an unknown `sessionUpdate` (`async_task_*`, `subagent_*`) answers `Invalid params` and never reaches `onNotification` (checked offline with a pair of in-memory streams). The v1 path needs a tap on the agent's stdout that reads those lines before the SDK does.
3. **A user message can go straight into the live session.** A plain `session/prompt` sent while a background task runs is answered at once on the same process. One sent during a turn the agent started itself waits for that turn to end, then runs. `_session/steering` refuses both cases (`promptRequired`).
4. **Closing needs a handoff guard.** Between the last "done" marker and the start of the agent's report turn there is a gap of 0.1 to 0.9 s (eight samples, v1 and v2) with nothing open. A client that closes the session the moment nothing is open kills the report.
5. **ACP v2 (draft) does the same job with standard events, and Claude's adapter already serves it.** Background shell commands, sub-agents and workflows are all listed in `state_update.background`; Claude's adapter inserts a prompt sent while a turn runs as a steer, so `_session/steering` is not needed there (it does not advertise it on v2). Codex's adapter holds such a prompt, and does take `_session/steering` on v2: see "Codex on v2 through the daemon (2.8.0)" v2 is the spec's recommended direction; v1-only agents answer `protocolVersion: 1` and stay on a v1 layer (see "Handshake").
6. **Codex's `nohup ... &` children are no background work to wait for, on v1 or v2 (corrected on 2026-11-19: a command that outlives its call is).** The probe of this page used `nohup`, which Codex does not track; nothing marks it and nothing starts a later turn. A yielded unified-exec command and a sub-agent are tracked, and `codex-acp` 2.8.0 reports them on v2 (see "Codex on v2 through the daemon (2.8.0)" below and `codex-app-server.md`). Codex never starts a turn to report that they ended. Steering works on both versions, through `_session/steering`.
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
- Caveat: one phrasing of the prompt. A Codex terminal session that outlives its call (unified exec) was not exercised here; it is in `codex-app-server.md` and in "Codex on v2 through the daemon (2.8.0)" below, and it is tracked.

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
| Steer mid-turn (a tool call running; once more during plain text) | A **plain prompt** never lands: Codex holds it, answers after the turn, and the layer's prompt steer returned false (this was the first layer: it steered only with a plain prompt). The runtime sent the message again as the next turn (second answer "FIRST\nSTEERED"). The `done` was **not** delayed: 1 ms after the `idle`. `_session/steering` does land on v2 (`injected`): the layer uses it since Stage 10, see "Codex on v2 through the daemon (2.8.0)" | Steer 2.5 s into the tool call; text-only: 0.6 s after the text began |
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
- Sub-agent traffic and child runs: see "Sub-agents on v2" below (Stage 8).
- Models other than haiku, long contexts, a loaded machine: the report gap probably grows with them, and 20 s is a bound, not a measure.
- A shell command that outlives a hard-killed adapter: here `claude` took its command with it.
- Windows, and the memory a lingering session costs.
- `~/.claude/projects` and `~/.codex/sessions` hold the scratch sessions of this check.

## Sub-agents on v2 (2026-11-19, Stage 8)

Raw captures with the probe client ([probe-harness.ts.txt](probe-harness.ts.txt), scenarios `f1` to `f10`, `c3`; it now logs the session every `session/update` came on and writes `raw-<scenario>.jsonl`), Claude Code 2.1.312 on haiku, `claude-agent-acp@0.107.0` on v2. The excerpt of six of them (138 lines, noise such as `usage_update` and `config_option_update` left out, the prompt text replaced) is [apps/daemon/test/fixtures/subagent-wire-v2.jsonl](../../../apps/daemon/test/fixtures/subagent-wire-v2.jsonl), which the daemon's tests replay. Each line is `{ scenario, t, main, sessionId, update }`.

### What is on the wire

- **The parent is never shown the `Agent` call of a child it announced.** In a foreground run (`f1`, `f3`) and in every background run the session the client talks to had no `tool_call` or `tool_call_update` of the `Agent` call at all (checked by counting the updates of the main session by kind). An `Agent` call that failed before it started a child (`f7`, a sub-agent type that does not exist) is an ordinary `tool_call_update` with `status: failed`, titled `Task`, with no `tool_call` before it, and no child.
- **What carries the child's `sessionId`:** the child's `state_update` (`running`, `idle`), its `config_option_update`s, its `terminal_update`s and `tool_call_update`s (the first update of a call carries `_meta.claudeCode.parentToolUseId`, the later ones do not), its own agent messages when it has any (Codex), and its `session_message`s. The session the engine talks to (the "main" session) gets: `subagent_update`, `state_update` with the background list, `usage_update` (the whole run's, the child's is not separate) and the copies of the `session_message`s.
- **`subagent_update`** is first sent with `sessionId`, `title` (the `description` of the `Agent` call: the parent's name for the task), `description` (the `subagent_type`, `general-purpose`), `capabilities: { cancel: {} }` and `state: { state: 'running', background: [] }`. Later ones carry only `state`, the child's mirror: `idle` with `stopReason` `end_turn` or `cancelled` and `background: []` at the end of a run; `running` with the child's own `background` (a list of `terminal`s) while a child that started a background command of its own waits for it (`f9`, `f10`). It carries no usage and no error; the child's own `state_update idle` says the same thing in the same millisecond.
- **`session_message`** comes twice, once for each session, with the same `messageId`. The prompt: on the main session `senderSessionId` = main, `recipientSessionId` = child and `recipientMessageId` (the outgoing view), on the child's `senderMessageId` (the incoming one). Its `messageId` is the id of the `Agent` call (`toolu_...`), which is also what the child's calls stamp as `parentToolUseId`. The report goes the other way (the id of the child's `SubagentHandback` call), sent just before the child's `idle`; a cancelled child sends none. When Claude Code launched the call asynchronously on its own, the adapter also sends a message `<call id>:reply` from the child to the parent, "Async agent launched successfully ...", at the moment of the launch.
- **Order at the start** (foreground and background alike, within one millisecond): `subagent_update` (main), the child's `state_update running`, the prompt on both sessions, and, for a background child, the main `state_update` whose list names it. The child's first call comes one to three seconds later.
- **In the parent's `state_update.background`:** a background child is listed as `{ type: 'subagent', sessionId }` from the announcement until it has stopped, in every state of the parent, after the parent's `idle` too. A foreground child is never listed: the parent's state stays `running` until the child's `idle`, then the parent goes on and says its own words and `idle`. Two background children are two entries (newest first); the list shrinks as each one stops, and each stop that empties the list is followed by the parent's report turn (`f4`: two report turns).
- **Order at the end** (`f2`, `f4`): the child's last call completes, the report `session_message`, the `subagent_update` with `idle`, the child's own `idle`, the main `state_update idle` with the list that no longer names the child; the parent's report turn (`running`) begins 0.7 to 1.3 s later (`f2`: 1.2 s), when the model's first output arrives. The report arrives 2 to 3 s after the child's last call (the child's own model call).
- **A message to the parent while a background child works** (`f8`): inserted at once (`user_message`, `running` with the list still naming the child), answered 1.5 s later, `idle` with the list unchanged; the child's calls go on in between and after.
- **Cancel** (`f5`, `session/cancel` while a foreground child runs): in the same millisecond the child's call is `cancelled` (its terminal's `exitStatus` is `{}`), the child goes `idle` with `stopReason: cancelled`, mirrored on the parent, and the parent's `idle` has `cancelled` too; no report. **With only a background child running** (`f6`, the parent idle) `session/cancel` does nothing: Claude Code's interrupt spares background work, so the daemon's Stop must end the process, which it does.
- **A background child that has a background command of its own** (`f9`) stops and wakes: its mirror says `running` with `background: [terminal]` while it waits; when the command ends it says `running` with `[]`, then, 19.075 s into the run, `idle` (`end_turn`, with a first report) and the parent's list loses it, and 8 ms later `running` again and the list has it back (the child woke for the notification of its command), until its final `idle` at 24.86 s. The parent woke for the first report (21.44 s) while the child was listed again. This is the flap the first real check saw as `[subagent] -> [] -> [subagent]` and a note written twice; 8 ms is the gap in this capture. A foreground child with its own command (`f10`) waits for it: one `idle`.
- **A foreground call that is not foreground:** an `Agent` call without `run_in_background`, which the first `f1` run made, was launched asynchronously by Claude Code ("Async agent launched successfully", the model then said "the agent launched asynchronously anyway"): on the wire it is a background child, listed, and the parent's turn ended without it. With `run_in_background: false` stated in the call it is foreground. The call's input in the transcript is the only place that says which was asked.
- **Codex on v2** (`c3`; Codex is back on v1 in the integration branch, so only the wire is recorded): `subagent_update` announces `<parent session>:subagent:<id>` with a title and, in later updates, `capabilities`, `state` and `cwd`; the child says its own agent messages and calls on its session; there are no `session_message`s and no call id, the parent shows an ordinary `wait` tool call; the child's `idle` is mirrored; the list `background` is not sent.

### What Clowdy does with it

`V2Layer` reads the sessions a `subagent_update` announced and drops the rest; `Children` (`engine/acp/children.ts`) turns them into a `subagent` event for a child run, the child's `text` and `tool` events with `agentId`, and a synthetic card for the call (a `tool` named `Agent`, since the parent has none: id from the prompt message, input from the announcement and the prompt, running until the child ends or the list loses it, then done with the report). A sub-agent's background item is named by the same call id, which the app uses to list the sub-agent once. A foreground child ends at its `idle`; a background one at the loss of its item from the list, which the runtime settles on the agent's next act, so that the flap above is one item. Details: `apps/daemon/AGENTS.md`, "Sub-agents".

### Real check through the daemon

A scratch daemon from the worktree (own data folder, port 47651, own personal and projects folders), Claude Code on v2, haiku, driven over the HTTP API; the script is in the scratchpad (`bg8/real/scn.ts`). Times in seconds from the first message.

| Scenario | Result | Numbers |
| --- | --- | --- |
| Foreground sub-agent (`fg1`) | A child run appears with the call's id as its `parentToolCallId` as the child starts, its two `Bash` calls are items of its stream while it works, it ends `succeeded` with its report as its result before the parent, the card in the parent's stream is one `Agent` item, running then done | child run at 5.5, calls at 7.2, child done at 12.0, parent done at 13.5 (first run); child 8.6, parent 10.0 (last) |
| Background sub-agent (`bg1`) | The parent waits (`waiting_background`) with the item; the child run works with its calls while it waits, the card is running; the child run ends `succeeded` with its report, one note, the report turn follows, the run succeeds | waiting at 6.0 (7.5 in the last run), child calls at 6.4 (8.0), the work ended and the list emptied at 30.3 and the child run ended at 32.6, when the report turn began (2.3 s after the list), parent done at 35.1 (35.6) |
| Two sub-agents at once (`two1`) | Two items, two child runs with their own calls and cards, each ends when its item leaves the list, each with its note, then the run | waiting at 8.9, first ended 29.8 (list lost it at 27.5), second 38.9 (37.4), run done at 41.3 |
| Stop while a child's command runs (`stop1`) | `cancelled` in 0.02 s, the child run `cancelled`, the card an error `Stopped before it finished`, the child's `python3 -c "import time; time.sleep(47)"` was alive before the Stop and gone 0.3 s after, no process of the run's group | 9.9 s into the run |
| A message while the child works (`steer1`) | The parent went `waiting_background -> queued -> running` in the same millisecond, answered "42" in 1.5 to 1.8 s, back to `waiting_background`; the child run stayed `running`, kept making calls (`Bash`, `ToolSearch`, `Monitor`, `Read`) and ended after its work | message at 14.0, answer 15.8; child done at about 49.5 (the work was 30 s of commands, the child's own model calls came on top) |
| A child with a command of its own (`flap1`) | One child run, one note, one card (done), the woken child's second run (its `Read` and last message) in the same child run, the run's status log shows the flap `[subagent] -> [] -> [subagent]` | waiting at 7.3, flap at 20.1, child done at 26.2, run done at 28.7 |

Defects the real runs found in the first version of this work, fixed with tests: the sub-agent's own card events (the layer says the card is done and running again at the flap) counted as the agent doing something and settled the pending finish, so the first `flap1` run ended the child run and wrote the note at the flap; a child whose run had ended was removed from `NativeAgents`, so its next calls opened a second, nameless run (`Sub-agent`, no card), which the turn's end then cancelled; a child's message stayed open (`done: false`) until the child's end. My first `stop1` was a false pass twice over: the matched `sleep 40` was the text of my own shell command, and Claude Code had blocked the sub-agent's `sleep 40; echo TWO` ("Blocked: sleep 40 followed by") so no sleep ever ran; the final check uses a Python `time.sleep(47)` and a marker that only the scenario file contains.

### Not checked

- A sub-agent of a sub-agent against the real adapter (the mapper handles it, tested with handcrafted updates), a sub-agent that fails (only `cancelled` was seen on the wire; `error` is from the draft's type), a child resumed by `SendMessage` after it ended (its traffic is dropped, a known limit), more than a handful of children, a Stop or a daemon restart with the child mid-call beyond what `stop1` shows, Windows.
- The child's usage: the real adapter reports none for a child (`state_update idle` of a child has no `usage`), so none is mapped.
- Codex and Cursor: Codex's sub-agents were on the wire only at this point (above; Stage 10 ran them through the daemon, "Codex on v2 through the daemon (2.8.0)" below); Cursor is on v1.

## Stopping one sub-agent (2026-11-19)

Claude Code 2.1.312 through `claude-agent-acp` 0.107.0 on ACP v2, haiku, raw wire (a scratch harness, then a scratch daemon on its own data folder). Evidence: the client sends the ordinary notification `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"<the child's session id>"}}` (no id, no answer; the SDK's `methods.agent.session.cancel`), with the id from the child's `subagent_update`. The adapter offers it per child: `subagent_update.capabilities.cancel` is `{}` on every child it announced, and the draft says a child with no such capability permits no client request.

| Case | Result |
| --- | --- |
| Cancel one of two background sub-agents (each running a `python3 -c "import time; time.sleep(61)"`) | Its terminal gets `exitStatus`, its call goes `cancelled`, the parent's `subagent_update` and the child's own `state_update` say `idle` with `stopReason: cancelled`, the parent's `state_update.background` loses it in the same tick; its processes (shell and python) are gone within about a second (0.58 s in the daemon check); the other child, the parent session and the parent's list are untouched |
| The same while the parent runs a foreground tool | Same; the foreground call is not touched and finishes |
| A second cancel of a child that already stopped, and a cancel of one that finished | Nothing happens (no error, no update) |
| `session/cancel` of the parent while only background work runs | Nothing happens: Claude Code spares background work (the Stop of a whole run is the daemon killing the process group) |
| `session/close` of a child, `tool_call/cancel` and `terminal/cancel` of a foreground command | Refused ("not running in the background"); `terminal/cancel` of a background command works but gives its parent no report turn |

The parent hears of a stopped sub-agent from Claude Code itself: a task notification ("stopped by user"), and about 1.1 to 1.5 s later the parent starts a report turn of its own (`running` with no prompt behind it, the answer, `idle end_turn`), so the 20 s report wait covers it and a report turn follows. In the daemon check the orchestrator said "Sub-agent A (the 73-second sleep) was stopped before it reported ... The notification says the user stopped it".

### Sub-agents of a sub-agent

Claude nests sub-agents (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3`, set by the catalog). Raw wire of a middle sub-agent M that starts two of its own, G1 and G2 (`test/fixtures/subagent-wire-v2.jsonl`, scenarios `nested-foreground` and `nested-background`):

- The grandchild's `subagent_update` comes on **M's session**, not the main one's (the first update for an unknown child comes on its immediate parent), with `capabilities.cancel` and `state: running`. M's prompt to it is a `session_message` on both views (`recipientMessageId` on M's, `senderMessageId` on G's), and G's calls carry `_meta.claudeCode.parentToolUseId` = the id of that message, as a top-level child's do.
- The main session's `state_update.background` names **M only**, in both variants; M stays in it while any of its own work is open, also after its own `idle`. M's own `state_update.background`, and the mirror of M's state in the main session's `subagent_update`, name G1 and G2. A foreground tree lists nothing anywhere.
- G ends with the report (`session_message` to M), `subagent_update` on M's session and its own `state_update` `idle end_turn`; M ends after both, then the main list empties.
- `session/cancel` of **M** while G1 and G2 work: M goes `idle` with `cancelled` (mirrored on the main session), and G1 and G2 **keep running** (their processes stayed alive for the whole observation, 10 s, until the harness killed them), still listed by M and by the main session. The adapter's stop does not cascade.
- `session/cancel` of **G1** alone: same as a first-level child (its process goes in under 1.5 s), M goes on with G2 in its list and ends when G2 does.

Clowdy before the fix, found by the first real run: every grandchild's run was a sibling of M's, a turn that ended while they worked cancelled them as "The parent run ended its turn" (the main list does not name them), and their later words created two runs named "Sub-agent". After it: runs below their starter, kept while the starter is listed, late words dropped; the daemon asks for each sub-agent of a stopped one, since the agent does not.

## Codex on v2 through the daemon (2.8.0)

Stage 10, 2026-11-19 and 2026-11-20. A scratch daemon from the worktree (own data folder, port 47811, own personal and projects folders) with Codex put on `protocol: 'v2'` and the wake field on by a launcher in the scratchpad that patched the registry in memory (`codex-acp` 2.8.0 was installed in a scratch folder and run with `node`, since the repository's `minimumReleaseAge` refuses the pin until 2026-11-22; the catalog file was not edited), driven over the HTTP API. The user's own `codex` 0.166.0, model `gpt-6-luna`, low effort, one to four model calls per scenario. Times are seconds from the first message unless said otherwise. The prompts are the ones of `codex-app-server.md` (`exec_command` with `yield_time_ms` 1000 and a `sleep`; `spawn_agent` with no wait).

### The handshake and what the daemon reads from it

| Fact | Evidence |
| --- | --- |
| `initialize` on v2 carries `_meta.steering.supported: true` at the top level of the result (Claude's adapter 0.107.0 says nothing of steering on v2: its `capabilities._meta` has only `claudeCode.promptQueueing`) | raw handshake of both adapters, no model call |
| A terminal that outlived its call is `terminal_update` with `capabilities: { cancel: {} }`, listed in `state_update.background` as `{ type: 'terminal', terminalId }` from the turn's end, with `terminal_update.command` the inner command (`sleep 40; echo BGDONE-s10`, with no shell wrapper); its end is `terminal_output_chunk`, `terminal_update` with `exitStatus` (`{ exitCode: 0, signal: null }`), `tool_call_update completed`, `terminal_update` with `capabilities: null`, and `state_update idle` with `background: []`, in that order within 1 ms | trace of the layer, runs `bg` |
| The call of that command is `in_progress` for as long as the command runs: Codex keeps the `exec_command` call open after the turn ends, so the first version of the layer failed it with the turn ("The turn ended before this finished") and it flipped to done when the command ended. Fixed: the layer tells the runtime which running calls stand for the listed terminals (`background.calls`) and the turn's end leaves them alone | runs `bg` (before and after the fix) |
| A sub-agent is announced by `subagent_update` with the session id `<parent session>:subagent:<thread id>`, a `title` (the model's name for the task) and `capabilities: {}` first, `cancel` later; it has no `session_message`, no `Agent` call card, and the parent's list names it `{ type: 'subagent', sessionId }` | run `sub` |

### Scenarios

| Scenario | Result | Numbers |
| --- | --- | --- |
| Normal turn | `succeeded` at `done`, no process kept | 5.3 to 7.9 s |
| Resume (a second message) | **With a gap of 6 s: the same session, 5.1 s. With no gap: the resume is refused (`Invalid request: This Codex session is in use by another Codex client`) and the daemon starts a new session with the conversation record** (the model still answered correctly). The same happens on v1 with `codex-acp` 2.6.0 (reproduced), so it is not new. Cause found in review, by reading the code (not measured, no real agent was started): the first turn of a chat leaves the process running for the chat's title (`AcpSession.linger`: Codex names a session about 5 s after the turn, the wait is up to 10 s) and `AcpSession.close` returns at once for it, so the next message starts a second process that asks to resume a session the first one still holds. The gap of 6 s is past the title. It is not the exit lag of `e1`. The options (wait for the title, cut it, or leave the fallback to a new session with the record) are the owner's call. Not fixed here | gap 0: 2 of 2 runs new session; gap 6 s: same session |
| Steer mid-turn, seven `sleep 3` calls and a steer 5.0 s after the first call began (the comparison of the first check, now with `_session/steering`) | **Lands in the running turn on v2:** the bubble appeared 0.2 s after the steer, one `running` turn, no second turn, the last answer "DONE STEERED". Identical to v1 (`codex-acp` 2.6.0, the same extension): bubble 0.2 s, one turn, "DONE STEERED" | v2: ends 47.0 s, steer to end 35.1 s; v1: 51.4 s and 38.5 s (model variance) |
| Stop mid-turn (a foreground `python3 -c "import time; time.sleep(47)"`) | `cancelled`, the call "Stopped before it finished", the process gone | 0.02 s to `cancelled`, gone within 0.5 s |
| A command that outlives its call (`sleep 25` and `sleep 40`) | The turn ends with the list naming the command, the run is `waiting_background` with `Run.background = [{ id: 'exec-<uuid>', kind: 'command', title: 'sleep 40; echo BGDONE-s10', canStopAlone: true }]` (the strip's data), the process is in a group of its own below the app-server and stays recorded; the command ends, the stream gets "Background command finished: sleep 40; echo BGDONE-s10" and **the runtime sends the agent one note 1 ms later** ("Background command finished: ...\nCheck how it went and tell the user what came of it, briefly."); the agent answers in a turn of its own ("The command finished successfully and printed `BGDONE-s10`."), the run stays `waiting_background` meanwhile with no slot, and ends `succeeded` right after that turn's `idle` | waiting at 8.1 to 8.5 s; end at 46.6 s (40 s command) and 31.1 s (25 s command); first word of the report 3 to 5 s after the note; `succeeded` at once after the report's `idle` |
| A message while it waits | The run goes `waiting_background -> queued -> running` in the same millisecond, the message is answered ("42") in 1.7 s on the same process, and the run is back in `waiting_background` at once; the command and its report are unaffected | message at +4 s of the wait; command ends 50.9 s, report 53.9 to 55.3 s |
| Stop with the command running | `cancelled`, the command is gone (Codex starts it in a group of its own below the app-server: the process-tree reaping of `engine/process.ts` ends it), the call "Stopped before it finished" | 0.02 s, gone within 0.3 s |
| **Stop one background command alone** (`run.stopBackground`) | Accepted (`terminal/cancel` answered `{}`), the list emptied in the same millisecond, the stream says "Background command stopped: ...", the process was gone within 0.5 s, **the agent was sent one line** ("The user stopped the background command: sleep 90; echo STOP1-s10 ...") and answered it in one sentence ("The command was stopped before it finished, so there's no output to report ..."); no wake note (a stopped command is not announced twice); a second press is the same request (`stopped: true`, no second request, no second line); the run waited 2 s and succeeded | list empty 0.0 s after the stop; answer 3.2 to 3.7 s after |
| Sub-agent (background, a command of its own) | The item is `{ id: '<parent>:subagent:<child>', kind: 'subagent', title: 'Sleep report' }`; the child run (`Sub-agent`, `canStopAlone: true`) appears at the child's first word, 2.7 s after the run began to wait, with only the child's own messages and calls in its stream (no prompt message, no card); it ends with its report as the result, the stream gets "Background sub-agent finished: Sleep report", the runtime sends the note and the parent reports. No `Agent` card in the parent's stream (Codex's parent shows none) | child run at 10.1 s, child done 39.0 s, parent reported at 45.5 s |
| Stop one sub-agent alone (`run.cancel` of its child run) | `session/cancel` of the child is taken: the child run is `cancelled` at once, the child says `idle` with `cancelled` and its `cancel` capability goes away. **The command the child had just started keeps running** (it began 9 ms after the cancel and ran to its end 35 s later: the child's turn is interrupted, its command is not), and the parent's list keeps naming the sub-agent for that time (the strip counts it as a background task). When it left, the stream said "Background sub-agent stopped: ..." and the runtime sent the note ("... stopped by the user: ...") | run at the cancel 0.0 s; list lost it 34.6 s later |
| Stop with a sub-agent working (a `python3 -c "import time; time.sleep(48)"` of the child) | `cancelled` for the run and the child run, the command gone | 0.02 s, gone within 0.3 s |
| `ask_user` (a semi chat) | `waiting_user` at 13.3 s, answered through `run.answer`, the turn continued: "You chose pear" | succeeded 15.7 s |
| Compact | The compact turn ran and succeeded, then a turn after it answered (the run had started a new session because of the resume race above) | 5.5 s |

### Claude Code on v2 (the same stage)

| Scenario | Result | Numbers |
| --- | --- | --- |
| Stop one background command alone (`Bash` with `run_in_background`) | Its terminal advertises `capabilities.cancel` as Codex's does (the item is `{ id: 'toolu_...', kind: 'command', title: 'sleep 90 && echo ...', canStopAlone: true }`: Claude's terminal id is the id of the `Bash` call), `terminal/cancel` is taken, the list empties at once, the process is gone within 0.5 s, the stream says it was stopped, the agent is sent the line and answers in one sentence, and the run ends 2.6 s after the stop: **the 20 s report wait is not spent**, because the layer knows the list emptied by the client's own stop and Claude owes no report of it (a stopped command gives it none, as probed before) | 0.0 s to empty, run `succeeded` 2.6 s after |
| Steer (14 s foreground tool, a steer 2.5 s into it) | Unchanged: a plain prompt, since Claude does not advertise the extension; it lands when the tool ends, one answer ("FIRST\nSTEERED"), one `done`, one turn | bubble at the tool's end, 19.7 s to `succeeded` |
| `tool_call/cancel` of a `Workflow` task (raw, five runs) | **Works.** The adapter advertises `capabilities.cancel` in a `tool_call_update` of the call as the workflow is listed (`background: [{ type: 'tool_call', toolCallId }]`); the request answers `{}`, the call goes `status: cancelled` with `capabilities: null`, and the list empties in the same tick. While the turn still ran it went on and ended normally; after the turn's `idle` no report turn began within 25 s (as for a command, so the agent has to be told). After the workflow ended on its own the request is refused: `-32602`, "Tool call ... is not running in the background, so it cannot be cancelled". Through the daemon (`wfstop`): `{ id: 'toolu_...', kind: 'task', title: 'Workflow', canStopAlone: true }`, `run.stopBackground` answered `stopped: true`, the card ended "Stopped before it finished", the note "Background task stopped: Workflow", the agent was sent the line and answered, the run ended 3.1 s after | 0.0 s to empty |
| `tool_call/cancel` of a `Monitor` | Nothing to cancel: the `Monitor` call completes at once ("Monitor started (task ...)") and is never listed in `background`; each notification of it is a turn of the agent's own | raw |

### What differed from the fakes and from the first reading

- A Codex send answers `running` first and echoes the message after (`user_message_chunk`), where Claude echoes it first: the layer read an idle send echoed after `running` as a message that landed in a turn that ran, held the turn's `done` for a second turn that never came (2 s with the real guard), and, in the fake agent, when the `idle` outran the answer to the prompt, held it for good. Fixed: a send made while no turn runs is answered by the turn it begins, whatever the order (`Turns.add('send', idle)`), with a test for both orders (`FAKE_ACP_ECHO_LATE`).
- The call of a command that outlived its turn stays running in Codex (above).
- Codex reports no turn when background work ends, so the layer's wait for a report that is owed (20 s) would have run to its end for nothing: an agent with `wakesOnBackgroundEnd` is never waited for, and the runtime sends the note.
- A command stopped alone owes no report on either adapter; the layer remembers the stop so it does not wait for one.

### Not checked

- A Codex sub-agent that starts a background command of its own and ends its turn (the flap seen with Claude): not tried; the children of this check ran their command inside their turn.
- A second sub-agent, nested sub-agents, a failing sub-agent, `multi_agent_v2`, images, MCP over ACP, permission requests, other Codex versions than 0.166.0, a daemon stop and a kill while Codex waits (the process-tree reaping is the same as for Claude, checked there).
- That Codex's command output reaches the model after it was idle: the note's answers quoted the output (the model read it itself, once with an extra `echo`), so it is not known whether a note that did not name it would be enough.

## Sources

- The probe runs of 2026-11-19 (this page).
- Adapter source in the bun cache (`claude-agent-acp@0.107.0`): `air-extension.js`, `async-tasks.js`, `v1/acp-agent.js` (`endsTurnsWithLiveSubagents`, `turnAwaitingSubagents`, `startAutonomousCycle`, `steer`), `v1/steering.js`, `v2/tasks.js`, `v2/background.js`.
- `@agentclientprotocol/sdk@2.7.0`: v2 `state_update`, `background`, `PromptResponse` in `dist/v2/unstable/schema/types.gen.d.ts`.
- `.briefback/acp/research/bb-source.md` for how bb drives Claude (Agent SDK, not ACP).
