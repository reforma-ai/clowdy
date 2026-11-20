# Codex app-server vs codex-acp: what a client sees, and whether to write our own adapter or engine

Snapshot 2026-11-19. Research only. Codex `codex-cli 0.166.0` (the owner's own login, model `gpt-5.6-luna`, low effort, a few tiny prompts per scenario). Adapters: `@agentclientprotocol/codex-acp` 2.6.0 (what Clowdy pins), 2.7.0 and 2.8.0 (fetched into a scratch folder, 2.8.0 released today). Slug `background-work`; this page answers one question of that work.

## Summary

- **Recommendation: neither a new adapter nor a native engine.** Stay on `codex-acp`, move the pin to 2.8.0 (usable from 2026-11-22 under the 3-day gate), put Codex on ACP v2, and steer with `_session/steering` on v2 (the v1 layer already does it). That gives Codex background work, stopping one command, child sessions for sub-agents and stopping one sub-agent, with standard v2 events. See "Recommendation".
- **Two premises of the earlier decision to keep Codex on v1 are wrong.**
  - "Codex has no background work to report on either version." True only for `nohup ... &`, which Codex does not track. A command that outlives its call (a yielded unified-exec process) is tracked by Codex and reported by `codex-acp`: on v1 for AIR clients since at least 2.6.0, on v2 for every client since 2.8.0 (`state_update.background`, `terminal_update` with `capabilities.cancel`, `terminal/cancel`). Verified live.
  - "On v2 the steer becomes a turn of its own." True for a plain `session/prompt` (held until the turn ends). A steer sent with `_session/steering` on a v2 connection is `injected` into the running turn (verified on 2.6.0 and 2.8.0). The adapter says `_meta.steering.supported: true` in the v2 `initialize` answer, as on v1.
- **App-server cannot do some things, so no option can:** nothing wakes the thread when a background command or a sub-agent ends (verified, also with the `wake_on_agent_messages` flag on); there is no "background work" flag on the thread status; there is no protocol version negotiation (only a version string in `userAgent`); the list and stop of background terminals are experimental. "The result reaches the chat" stays a job for Clowdy's runtime in every option (it has to `send` a note).
- **The app-server facts are the same ones `codex-acp` uses.** It polls `thread/backgroundTerminals/list` and watches `item/completed`. An own adapter or engine would read the same facts, with no new capability for background work.
- **Cost of the alternatives (estimates):** own v2 adapter 4.5k to 6.5k lines of source plus 8k to 12k of tests, against 38k lines (and 69k of tests) in `codex-acp`; native engine 2.5k to 3.5k lines plus tests, and it reopens the owner's "one ACP path" decision, made on 2026-11-18.
- **Upstream is the live option.** `codex-acp` shipped 8 minor releases in 7 weeks, and the maintainer wrote the v2 background work and `terminal/cancel` (PR #777) today, 14 minutes from opening to merge. Outside PRs are rarely merged (4 of the last 100; 100 PRs open, the oldest from June), so the contribution that fits is an issue, not a PR.
- **Not checked when this page was written:** the daemon itself with Codex on v2 and 2.8.0 (only raw probes of the adapter and of app-server). **Done afterwards** (Stage 10, 2026-11-19 and 20): the scenarios of the smallest next step pass through the daemon, and the runtime sends the wake note; see `acp-background-probe.md`, "Codex on v2 through the daemon (2.8.0)".

## Corrections to the earlier notes

| Earlier statement | Where | What the probes show |
| --- | --- | --- |
| "Codex has no background-task feature to report on either version"; "Codex gains nothing for background work from v2" | `index.md`, `acp-background-probe.md` (Codex v1 and v2), `catalog.ts` comment, `apps/daemon/AGENTS.md` | The earlier probe used `nohup sh -c '...' &`: the call completes at once and Codex tracks nothing (reconfirmed here, run `b3`). A yielded unified-exec command is tracked (runs `b2`, `k1`, `k3`). `acp-background-probe.md` itself noted "A Codex terminal session that outlives its call (unified exec) was not exercised"; this closes that caveat |
| "Codex stays on v1 because on v2 its adapter holds a prompt that arrives mid-turn" | `catalog.ts`, `apps/daemon/AGENTS.md` | A plain prompt is held (reconfirmed, `k2b`: answered after the turn's `idle`). `_session/steering` works on v2 (`k2`, `k7`: `injected`, the answer ends with the steered word) |
| "A Codex sub-agent on v2 shows as a child session with no `session_message`s" | `acp-background-probe.md`, c3 | As recorded for 2.6.0. From 2.7.0 the delegated prompt is a `session_message` (PR #760); from 2.8.0 the child carries `capabilities.cancel` and is listed in `background` (PR #777); verified on 2.8.0 (`k5`) |

## How it works: what `codex app-server` offers

`codex app-server` is JSON-RPC 2.0 over stdio, one JSON object per line, with the `jsonrpc` field left out. A client sends `initialize` then the `initialized` notification. `initialize.capabilities.experimentalApi: true` unlocks experimental methods and fields. The answer carries `userAgent` (`<client>/0.166.0 ...`), `codexHome` and the platform; that string is the only version signal. There is no protocol version number and no negotiation. `codex app-server generate-ts` and `generate-json-schema` (add `--experimental` for the full set) write types that "match that version exactly" (official docs). Saved in the scratch folder: `schema-ts`, `schema-ts-exp`, `schema-json`, `schema-json-exp`.

### Size of the surface (0.166.0)

| | Stable | With experimental |
| --- | --- | --- |
| Client requests | 109 | 182 |
| Server notifications | 87 | 87 |
| Server requests (approvals, questions) | 10 | 11 |
| Requests `codex-acp` 2.6.0 calls (by reading its bundle) | about 40 | |

### Threads and turns

| Need | Methods and notifications | Notes |
| --- | --- | --- |
| Threads | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`, `thread/read`, `thread/turns/list`, `thread/items/list`, `thread/loaded/list`, `thread/archive`, `thread/delete`, `thread/unsubscribe`, `thread/name/set`, `thread/metadata/update`; notifications `thread/started`, `thread/status/changed`, `thread/name/updated`, `thread/closed` | `ephemeral: true` keeps no rollout file. `thread/status` is `notLoaded`, `idle`, `systemError` or `active` with flags `waitingOnApproval` and `waitingOnUserInput` only. **No flag for background work** |
| Turns | `turn/start`, `turn/steer`, `turn/interrupt`, `turn/settings/update` (experimental); notifications `turn/started`, `turn/completed` (status `completed`, `interrupted`, `failed`), `turn/plan/updated`, `turn/diff/updated` | A turn has `rootTurnId`; in a child thread it is the parent's turn id. `turn/start` carries `parentTurnId`, `rootTurnId`, `outputSchema`, `collaborationMode`, per-turn `model`, `effort`, `approvalPolicy`, `sandboxPolicy`, `permissions`, `cwd` |
| Settings | In `thread/start` and `turn/start`; `thread/settings/update` (experimental); `model/list`; `config/read`, `config/value/write`, `config/batchWrite`; `permissionProfile/list` | The thread's `config` map can set any `config.toml` key for that thread. MCP servers: `config/mcpServer/reload`, `mcpServerStatus/list`, notification `mcpServer/startupStatus/updated` |
| Input | `UserInput`: `text`, `image` (URL or file id), `localImage`, `audio`, `localAudio`, `skill`, `mention` | Images are supported |
| Server-side queue | `thread/queue/add`, `list`, `update`, `delete`, `reorder`, `start` (experimental) | Codex's own queue of user messages. Clowdy has its own; not needed |
| User shell | `thread/shellCommand` (runs unsandboxed), `command/exec*`, `process/*` (experimental) | Not part of an agent turn |
| Goals | `thread/goal/set`, `get`, `clear`, notification `thread/goal/updated` | `codex-acp` exposes it as an AIR extension |

### Items (`item/started`, `item/completed`, plus deltas)

`ThreadItem` has 19 variants: `userMessage`, `hookPrompt`, `agentMessage` (with `phase` `commentary` or `final_answer`, `delivery: "async"`, and `questions`), `functionCallOutput`, `plan`, `reasoning`, `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`, `webSearch`, `imageView`, `sleep`, `imageGeneration`, `enteredReviewMode`, `exitedReviewMode`, `contextCompaction`. Every item carries `startedAtMs` and `completedAtMs`. Deltas: `item/agentMessage/delta`, `item/reasoning/summaryTextDelta` and `textDelta`, `item/plan/delta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta`, `item/mcpToolCall/progress`.

`commandExecution` has `processId`, `source` (`agent`, `userShell`, `unifiedExecStartup`, `unifiedExecInteraction`), `status` (`inProgress`, `completed`, `failed`, `declined`), `exitCode`, `aggregatedOutput`, `durationMs`. `collabAgentToolCall` has `tool` (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`, `followupTask`, `interruptAgent`, `listAgents`), `senderThreadId`, `receiverThreadIds`, `agentsStates` (per child: `pendingInit`, `completed`, with a message).

### Approvals and questions (server requests the client must answer)

| Request | What it is |
| --- | --- |
| `item/commandExecution/requestApproval` | Command approval (`accept`, `acceptForSession`, `decline`, `cancel`, exec-policy amendments); `kind` also covers stdin and managed human checkpoints |
| `item/fileChange/requestApproval` | File change approval |
| `item/permissions/requestApproval` | A permission profile request |
| `item/tool/requestUserInput` (experimental) | The model's questions: `questions[]` with `options`, `isOther`, `isSecret`, `isBlocking` |
| `mcpServer/elicitation/request` | MCP elicitation: `form`, `url`, `openai/form`, `openai/userVerification` |
| `item/tool/call` | A dynamic tool the client registered in `thread/start.dynamicTools` |
| `applyPatchApproval`, `execCommandApproval` | Legacy forms |

Approval policy is `untrusted`, `on-request`, `granular` or `never`; sandbox is `dangerFullAccess`, `readOnly`, `workspaceWrite` or `externalSandbox`. My runs used `never` with `workspaceWrite`, so no approval request was ever raised (not exercised).

### Context, usage, limits, compaction, titles

- `thread/tokenUsage/updated` per thread: `total` and `last` breakdowns and `modelContextWindow` (258,400 for this model). A child thread reports its own usage.
- `account/rateLimits/read` and `account/rateLimits/updated`: primary and secondary windows with `usedPercent`, `windowDurationMins`, `resetsAt`.
- Compaction: `thread/compact/start`, a `contextCompaction` item, `thread/compacted`.
- Titles: `thread/name/set`, `thread/name/updated`.

### Background terminals (experimental) and sub-agents

| Fact | Evidence |
| --- | --- |
| A command that outlives the call that started it keeps running as a "background terminal" of the thread. The model makes this happen by calling `exec_command` with a short `yield_time_ms` | `b1`, `b2` |
| `thread/backgroundTerminals/list` returns `itemId`, `processId`, `command`, `cwd`, and `osPid`, `cpuPercent`, `rssKb` (all `null` on macOS in my runs). Its inventory **also contains commands that still serve a running call**, so "detached" means "still listed after the turn ended" | `d1` (listed while the turn ran), `b2` |
| `thread/backgroundTerminals/terminate {threadId, processId}` answered `{terminated: true}` in 1 ms; the command item completed `failed`, `exitCode: -1`; the list was empty 2 s later. `clean` ends them all (not run) | `e3` |
| When the process ends, **`item/completed` for the original `commandExecution` item arrives with `exitCode`, `aggregatedOutput`, `durationMs`, even though its turn ended long before.** Nothing else is sent: no `turn/started`, no status change. The thread stays `idle` | `b1` (turn ended 11.3 s, process ended 48.3 s), `b2` (7.8 s, 35.9 s) |
| So a client can see a command that outlived its turn without the experimental list: an item still `inProgress` when `turn/completed` arrives, and its `item/completed` later | `b2` raw log |
| A turn interrupt does **not** stop the command. It stays listed as a background terminal and ends when it ends or is terminated | `d1` (still listed 1.5 s after the interrupt), ACP `k8` |
| A sub-agent is its own thread. The parent gets a `collabAgentToolCall` `spawnAgent` that completes in about 100 ms with `receiverThreadIds` and `agentsStates` `pendingInit`. The child's `turn/started` has the parent's turn id as `rootTurnId`. The child's items, `thread/status/changed` and `thread/tokenUsage/updated` arrive on the same connection with the child's `threadId`. **No `thread/started` is sent for the child**, so the child id comes from the parent's item | `c1`, `c2` |
| A sub-agent outlives the parent's turn: parent turn ended 9.6 s, child finished 40.2 s. The parent is not woken, also with `--enable wake_on_agent_messages` (under development in 0.166) | `c2`, `runs-wake/c2` |
| `closeAgent` moves the child to `thread/status notLoaded` | `c1` |
| One sub-agent can be stopped alone with `turn/interrupt {threadId: <child>, turnId: <child's turn>}` (`{}` in about 0.1 s, the child turn becomes `interrupted`). The child's running command survives as a background terminal of the child thread, and the parent's `wait` is not released at once | `c3` |

### Mid-turn input

- `turn/steer {threadId, expectedTurnId, input}` appends to the running turn and answers `{turnId}` of the same turn. With no turn running it answers error `-32600 "no active turn to steer"` (`a4`). A wrong `expectedTurnId` is also refused (documented, not run).
- `turn/start` while a turn runs does the same: it returned the running turn's id and inserted a `userMessage` item (`a3`).
- The steer reaches the thread at once (the `userMessage` item came in the same millisecond, `a2`), but the model reads it after the running tool call returns: the final answer "DONE BANANA" came 2.7 s after the 12 s command ended.

### How stable it is

- The official docs mark the whole method set per capability (`experimentalApi`) and say the websocket transport is "experimental and unsupported". They point automation and CI to the Codex SDK (not evaluated here).
- The stable surface grew only by addition across the versions I could compare. The generated types `codex-acp` commits (stable set) went from 920 files (Codex 0.147, 2026-08-11) to 1,077 (0.170): **0 files removed in any of six steps**, 5 to 63 files changed per step. `ThreadItem`, `Turn`, `TurnStartParams`, `TurnSteerParams`, `ThreadStartParams` and `ThreadStatus` between 0.158 and 0.170 only gained fields. Between 0.166 and 0.170: 3 stable requests and 1 notification added, none removed.
- The experimental surface is not measured. The background-terminal methods are experimental, and the old `codex/event/*` API is deprecated with a removal planned (`codex-acp` `AGENTS.md`).
- Pace: Codex 0.147 to 0.170 in 14 weeks, about one minor version every four days (0.168 and 0.169 on 2026-11-13, 0.170 on 2026-11-18; 0.171.0 is listed with the date 2026-11-20).

## What `codex-acp` maps and drops

`codex-acp` is a JavaScript bundle, not a native binary: `dist/index.js` in the bun cache is 2.1 MB, 55,766 lines, readable. The repository is on GitHub (`agentclientprotocol/codex-acp`, Apache 2.0). Its `src/` is about 146 files and 38k lines, its tests about 193 files and 69k lines (golden JSON snapshots, v1 and v2), and the committed generated types 15k lines. The biggest file, `CodexAcpServer.ts`, is about 7.8k lines. It starts `codex app-server` itself with `experimentalApi: true` and calls about 40 of the 182 client requests.

### Maps

Commands (terminal content and output), file changes (diffs, compact diff patch for AIR), MCP calls and elicitations, permission requests, reasoning, plans (including the checklist), web search, image generation and viewing, token usage and `_meta.quota`, review events, compaction (`compaction_update`), async questions as elicitations, goals (AIR), sessions (new, resume, fork, list, delete, title), config options (model, effort, fast mode, approval, sandbox, permission profiles), images and resource links in prompts, MCP servers (stdio, http, and MCP over ACP since 2.8.0), `thread/name` titles, sub-agents, background terminals, steering.

### Drops, or leaves to the client

| App-server capability | Reaches an ACP client? |
| --- | --- |
| `thread/queue/*` (Codex's own message queue), `thread/shellCommand`, `thread/backgroundTerminals/clean`, `thread/inject_items`, `thread/revert`, `thread/settings/update` | No (not called) |
| `thread/started` of a child | Not sent by Codex; the adapter builds the child session from the parent's collab item |
| The sender of a child's `userMessage` | Codex does not record it; the adapter links the two views by equal text and leaves them unlinked when unsure (PR #760) |
| Per-child token usage | Not as separate usage: an open outside PR since 2026-10-29 (#706, "report subagent token usage in `_meta.quota.model_usage`") |
| Wake when a background command or sub-agent ends | Codex does not do it; no adapter can |
| `session/cancel` on the root | Interrupts the turn and **leaves listed background work running** (documented, and seen in `k6`) |
| Rate-limit windows (`usedPercent`, `resetsAt`) | The adapter reads and keeps them in session state; the `_meta.quota` on the turn's `idle` in my runs carried token counts and `model_usage` only, no windows. How or when they reach a client was not checked |

### What each release added for Clowdy's wishes

| Release | Date | Added |
| --- | --- | --- |
| 2.6.0 (Clowdy's pin) | 2026-11-08 | v1 + AIR `asyncTasks`: private `async_task_spawned` / `async_task_state_update`, stop with `_session/async_task/stop`. On v2 the same payload under `_async_task_*` (read in the code, not run). Steering on v1 and v2 |
| 2.7.0 | 2026-11-16 | Delegated tasks as `session_message` (live and replay), child `description` is the role, structured plans |
| 2.8.0 | 2026-11-19 | **ACP v2 `state_update.background` for terminals and children, `terminal_update.capabilities.cancel`, `terminal/cancel`**, `session/cancel` on a child stops that child (PR #777); MCP over ACP; SDK 2.8 alignment; Codex 0.170.0 |

Why the v2 steer is held: `promptV2` takes a turn-start "reservation" per session. A prompt that arrives while one is open waits on a FIFO and is inserted after the turn's `idle`. It is a deliberate queue, not a missing feature, and `_session/steering` is registered on the v2 router next to it. I found no issue or doc that explains the choice.

## Live probes

### App-server directly (raw JSON-RPC client, `codex-cli 0.166.0`)

Times are seconds from the start of the run.

| Run | What was done | Result |
| --- | --- | --- |
| `a1` | One turn, one command | `turn/started` 0.7; `userMessage`, `reasoning`, `commandExecution` (`source: unifiedExecStartup`, has a `processId` even for `echo`), `agentMessage` `final_answer`; `turn/completed` 8.1 |
| `a2` | `turn/steer` 2 s into a 12 s command | `{turnId}` same turn; `userMessage` item in the same ms (8.2); command ended 18.1; answer "DONE BANANA" 20.8 |
| `a3` | `turn/start` during the turn | Same turn id back; `userMessage` at once; "DONE BANANA" at 19.6 |
| `a4` | `turn/steer` when idle | Error `-32600 "no active turn to steer"` |
| `b1` | "Run `sleep 40; echo BGDONE` in the background and end your turn" | The model ran one `sleep 40; echo BGDONE &` call that yielded; turn ended 11.3; listed after the turn; `item/completed` at 48.3 (`exitCode 0`, output `BGDONE`); no wake; thread `idle` throughout |
| `b2` | `exec_command` with `yield_time_ms: 1000` and `sleep 30` | Turn ended 7.8; listed at 9.0 and 10.0; `item/completed` 35.9 (29.9 s run); no wake |
| `b3` | `nohup sh -c "sleep 20; ..." &` | The call completed at once, exit 0; list empty before and after; nothing reported when it ended. Not tracked by Codex |
| `b4` | yield then `write_stdin` poll | One `commandExecution` item, completed when the model's poll saw the end; the turn followed the process. No separate item for the poll |
| `c1` | spawn, wait, close | `spawnAgent` 8.6 to 8.7; child turn 8.7 to 15.1; `wait` item 10.6 to 15.1; `closeAgent` 17.2; parent turn ended 18.2 |
| `c2` | spawn, do not wait, end the turn | Parent ended 9.6; child's `sleep 25` ended 38.6; child turn ended 40.2; parent never woken |
| `c3` | child's `turn/interrupt` mid-command | `{}`, child `interrupted` at 17.5 (0.1 s); child's `sleep 45` finished anyway at 60.3; parent's `wait` was not released at once (the model waited again) |
| `d1` | `turn/interrupt` with `sleep 60` running in the foreground | `{}`; `turn/completed` `interrupted` 110 ms later; the command still listed 1.5 s later |
| `e1` | Close stdin (EOF) with a background command | The app-server exits in under 3 s and the command is gone |
| `e2` | `SIGKILL` the app-server pid only | The command's shell survives, parent 1, in a process group of its own (pid = pgid), so a signal to the app-server's group would not reach it. Removed by hand (my own process) |
| `e3` | `thread/backgroundTerminals/terminate` | `{terminated: true}` in 1 ms; item `failed`, exit -1 |

### `codex-acp` (raw ACP client, same Codex)

| Run | Adapter, protocol | Result |
| --- | --- | --- |
| `k1` | 2.6.0, v1, AIR `asyncTasks`, yielded `sleep 30` | `async_task_spawned` (`taskType: shell`, `canStop: true`) at 8.1, the moment the turn ended (command started 6.2); `async_task_state_update completed` at 36.1; no new turn |
| `k2` | 2.6.0, v2, `_session/steering` 6 s into the turn, as the 14 s command began | `{outcome: injected}`; `user_message_chunk` at once; answer "DONE BANANA" in the same turn |
| `k3` | 2.8.0, v2, yielded `sleep 30`, then a plain prompt while it runs | `terminal_update` with `capabilities: {cancel: {}}` and `state_update running` with `background: [{type: terminal, terminalId}]` at the turn end (8.4 here, 7.6 to 7.9 in `k4` and `k6`); the second prompt was answered as its own turn (answer "4"); at 36.4 `terminal_update exitStatus`, `tool_call_update completed`, `state_update idle` with `background: []`; nothing woke the model |
| `k2b` | 2.8.0, v2, plain prompt 6 s into the turn (command running) | Held: sent at 7.0, inserted at 22.4 right after the first turn's `idle` (15 s later), then answered as a second turn |
| `k7` | 2.8.0, v2, `_session/steering` at the same point | `injected` at 7.1; "DONE BANANA" in the same turn |
| `k4` | 2.8.0, v2, `terminal/cancel` on the listed terminal | `{}` in 0 ms; `terminal_update exitStatus -1`, `background: []` |
| `k6` | 2.8.0, v2, `session/cancel` while the turn is idle and a terminal runs | Spared: the command ended normally at 35.9 with exit 0 |
| `k8` | 2.8.0, v2, `session/cancel` while a **foreground** command runs | Turn `idle` at once, but the command went on and was **then listed as a background terminal**. It was still alive 6 s later (removed by hand, my own process) |
| `k5` | 2.8.0, v2, background sub-agent, then `session/cancel` on the child | `subagent_update` with child id `<parent>:subagent:<thread id>`, a `session_message` with the delegated prompt, child `state_update`, `capabilities.cancel` once the child ran; at the parent's `idle` the list was `[{type: subagent, sessionId}]`; `session/cancel` on the child: child `idle` with `stopReason: cancelled`, parent's list `[]` and `cancel: null` in the same ms |

## The options

Features Clowdy wants from Codex: background work (open items and their end), steer, sub-agent child runs, stop one sub-agent, stop one background command, queue and stop-and-send (runtime features).

| Feature | App-server itself | A: keep 2.6.0 on v1 (today) | A+: 2.8.0 on v2, steer by `_session/steering` | B: own ACP v2 adapter | C: native engine |
| --- | --- | --- | --- | --- | --- |
| Background items and their end | Yes: item still `inProgress` at turn end, list (experimental), `item/completed` at the end; children's notifications | Not seen. The data exists only as AIR private updates, which the SDK drops (needs a stdout tap) | Yes, standard events (`k3`) | Yes, same facts | Yes, same facts |
| Wake the model when it ends | **No** (`b1`, `b2`, `c2`) | No | No: the runtime must `send` | No: same | No: same |
| Steer | `turn/steer`, also `turn/start` mid-turn | Yes | Yes (`k2`, `k7`) | Yes | Yes |
| Sub-agent child runs | Child threads, separate notifications, own usage | Tool items `Start subagent` / `Complete subagent` | Child sessions with own messages and tools, delegated prompt as `session_message` | Same as A+ | From thread ids directly, plus the child's own usage |
| Stop one sub-agent | `turn/interrupt` on the child (its command survives) | No | `session/cancel` on the child (`k5`) | Yes | Yes |
| Stop one background command | `thread/backgroundTerminals/terminate` | AIR `_session/async_task/stop` only | `terminal/cancel` (`k4`) | Yes | Yes |
| Queue, stop-and-send | Runtime only. Stop is `turn/interrupt` (110 ms) | Same | Same | Same | Same |
| Stop ends the interrupted command | **No** (`d1`, `k8`) | Same | Same | Same | Same |

What none of them can do, because app-server lacks it: wake on the end of a command or a sub-agent; tell that a command will outlive its turn at its start (only at the turn end); a background flag on the thread status; a stable (non-experimental) way to list or stop a terminal; a sender id on a child's incoming message.

### A: keep codex-acp 2.6.0 on v1

Zero work, but Codex keeps no background work, no child runs, no stop-one. Not recommended: the pin is two releases behind, and the reasons in `catalog.ts` no longer hold.

### A+: upgrade, v2, steer by extension (recommended)

- Daemon changes, estimated 100 to 250 lines with tests: the pin and `protocol: 'v2'` in `catalog.ts`; `V2Layer.steer` calls `_session/steering` when the `initialize` answer has `_meta.steering.supported` (the helper `canSteer` and the request type already exist in `v1.ts`, the SDK's `connection.agent.request` takes any method name), and falls back to the plain prompt otherwise; a policy for the end of Codex background work (below); `acp-layers.test.ts` and the catalog comment updated.
- Maintenance sits with the upstream team (see D). Their v2 work follows the draft: each ACP SDK release has been followed by an "align adapter with ACP SDK x.y" commit (2.1, 2.2, 2.4, 2.5, 2.7, 2.8).
- Needs from the user's machine: what it needs today (`codex` on the PATH and logged in; network for `bun x` on first use).
- Decisions it forces:
  1. **What the runtime does when Codex's background work ends.** The model is not told. Left alone, the layer waits `BACKGROUND_REPORT_MS` (20 s) for a report turn that never comes and ends the run `succeeded`, and the user never sees the result. Either the runtime `send`s a short note (command, exit status, tail of output) so the model reports, or it shows the end on the card and does not wake the model.
  2. **Stop.** `session/cancel` leaves the interrupted foreground command running, now as a listed terminal (`k8`). Clowdy's process-tree kill covers it (Codex starts commands in a process group of their own, `e2`); `terminal/cancel` per listed terminal is the polite form.
- Version gate: 2.8.0 is 3 days old on 2026-11-22; 2.7.0 is eligible now but has no background reporting. `bun add <pkg>@<version> --minimum-release-age 0` is possible and would be named in the PR (the project rule).
- Skew: 2.8.0 expects Codex 0.170.0 and runs on the user's own `codex` (0.166.0 here; all `k` runs worked). The floor of Codex versions that have the background-terminal methods is not known.

### B: our own ACP v2 adapter over app-server (`packages/codex-acp-v2`)

- **Size (estimate).** `codex-acp` is 38k lines because it covers more than Clowdy needs (auth and gateways, provider switching, session index and worktrees, goals, hooks, recovery of a crashed app-server, AIR extensions). The subset for Clowdy: JSON-RPC client with restart about 600; thread and session lifecycle, config options, model and effort about 900; turn loop and v2 state machine about 700; mapping of the 19 item types and ~25 relevant notifications about 900; approvals and elicitations about 400; sub-agent sessions with `session_message` about 900; background terminals and cancel about 350; steering, titles, compaction, plans about 450; failures about 200. Total 4.5k to 6.5k lines, tests 8k to 12k. The client side of the same protocol in Clowdy (`v2.ts` 741, `mapper-v2.ts` 378, `children.ts` 308) is 1.4k lines, which shows the weight of one half.
- **Event mappings.** Mapping about 19 item types, 25 notifications and 6 server requests onto ACP v2's `state_update`, message upserts, `tool_call_update`, `terminal_update`, `subagent_update`, `session_message`, `background` and `replay_complete`.
- **Passing the v2 draft's rules.** `session/prompt` answers `{messageId}` after insertion; the turn ends at the `idle` `state_update` with `stopReason` and usage; the first `tool_call_update` creates the call; `session/resume` with `replayFrom` and `replay_complete` per session; children announced by `subagent_update` before any of their updates; `background` is `null` while a resume synchronizes. `codex-acp` needed golden fixtures (hundreds of JSON files) for this and still ships "align with the protocol" fixes every release.
- **Testing.** `apps/daemon/test/fake-acp-agent.ts` is an ACP *agent* that tests the engine as a client. An adapter is also an agent, so it would need the other half: a scripted app-server, recorded fixtures per Codex version, and live runs with a real Codex at every release (one every four days).
- **Who maintains it:** the owner, with the Codex cadence above and an experimental surface for exactly the features that matter (background terminals).
- **What it gains over A+:** nothing for background work (same facts). It could expose what `codex-acp` drops (child usage, queue), at a price.
- **Needs from the machine:** the same `codex` binary. It would no longer need `bun x` to fetch a third-party package on first use.

### C: a native engine class over app-server (`apps/daemon/src/engine/codex/`)

- **Shares** with the ACP engine: `AgentProcess` and the process-tree kill (`engine/process.ts`, 198 lines), the tool bridge and MCP stdio (`bridge.ts`, `mcp-stdio.ts`, 281), the registry, catalog and discovery (about 900 lines, with a new launch kind), failure text, the `EngineSession` contract and everything above it (runtime, run statuses, background snapshots).
- **Duplicates:** a session wrapper for steer, send, close and titles (about 300 in `session.ts`), the turn and background state machine (about 400), a child-run mapper (about 300 in `children.ts`), the item-to-event mapper (about 700), approvals (answered by the daemon, small), models, effort and mode choices built from `model/list` and permission profiles instead of ACP config options, usage and context, rate limits, errors. Estimated 2.5k to 3.5k lines plus 4k to 6k of tests; no ACP rules to obey, so about half the size of B.
- **What it gains over A+ (modest):** the child's own token usage, `phase` of agent messages, millisecond item times, real rate-limit windows as `limit` events, and no `bun x` fetch.
- **The owner's earlier decision.** On 2026-11-18 the owner settled on one ACP engine for every agent "so every agent behaves alike" and deleted the native Claude engine, keeping it in git history only as a fallback "if an adapter falls short". C would be the first native engine back. The fallback condition is not met: `codex-acp` 2.8.0 does what is needed. So C would reverse that decision for a gain that is small.

### D: contribute upstream

- **Activity (GitHub, 2026-11-19):** 585 stars, 212 forks, 657 commits, 186 open issues and PRs (100 PRs open, the oldest from 2026-06-29). 8 minor and 4 patch releases between 2.0.0 (2026-09-28) and 2.8.0 (2026-11-19). In the last 100 merged PRs (2026-10-07 to 2026-11-19): the maintainer `benbrandt` 40; four authors of the AIR extensions (`EugeneTheDev` 19, `nikita-ashihmin` 10, `Rizzen` 4, `tpansino` 3; the docs tie AIR to JetBrains clients, the link to the people is my inference); `slapoguzov` 1; bots 19; the other 4 PRs from 4 other authors, so about 4 percent from outside the core group. Median time from open to merge: same day; the 90th percentile 3 days. PR #777 was opened 08:52 and merged 09:06 on 2026-11-19. An outside PR for the same feature (#774, opened 2026-11-18, "expose native background state through ACP v2") is still open: the maintainer wrote their own the next morning.
- **What would be missing after 2.8.0 for Clowdy:** (1) a plain mid-turn prompt on v2 is queued, not steered; a policy choice, and `_session/steering` already answers it. (2) wake on the end of background work: not possible, Codex lacks it. (3) child usage: an open outside PR. So there is little to build upstream. The fitting contribution is feedback on the v2 behaviour (a short issue), and a bug report if the daemon check finds one.
- **Does it accept PRs:** yes from the maintainer group; an outside PR has a low chance and a long wait, so Clowdy should not depend on one.

### Rejected

- The Codex SDK instead of app-server: the docs recommend it for automation and CI, while app-server is what the VS Code extension and other rich clients use. I did not evaluate what the SDK exposes, so this is rejected for lack of evidence, not for a found defect.

## Recommendation and the smallest next step

1. **Do A+.** Keep the one ACP engine; take `@agentclientprotocol/codex-acp@2.8.0`; move Codex to v2; steer through `_session/steering` on v2.
2. **Smallest next step (no code to merge, about half a day):** run the scratch-daemon real check that the Claude work used (the table in `acp-background-probe.md`, "Real check through the daemon") with Codex on 2.8.0 and v2, by a launcher in the scratchpad, not by editing the catalog: normal turn and resume; steer mid-turn (expect a landed steer, one answer); Stop mid-turn with a command running (expect the command gone); yielded 40 s command (expect `waiting_background`, the item with its real command, the end, and what the runtime does at the end); a message while it waits; a background sub-agent (child run, stop of the child); two sub-agents; daemon stop and kill while waiting. Only after that edit `catalog.ts`.
3. **Decide before the edit:** the wake policy for Codex (the runtime `send`s a note, or only shows the end), and whether Stop calls `terminal/cancel` or relies on the process-tree kill.
4. **Fix the notes** that say Codex has no background work: `index.md`, `acp-background-probe.md`, the `catalog.ts` comment and `apps/daemon/AGENTS.md`.
5. **Do not start B or C.** Revisit only if the real check shows a defect that upstream will not fix and that Clowdy cannot work around in its layer.

## Relevant files and modules

- `apps/daemon/src/engine/types.ts` — `EngineSession` (`canSteer`, `steer`, `send`, `close`) and `EngineEvent` (`background`, `subagent`, `context`, `limit`); the seam an engine implements.
- `apps/daemon/src/engine/acp/catalog.ts` — the Codex entry (line 134 on): pin `@agentclientprotocol/codex-acp@2.6.0`, the v1-on-purpose comment.
- `apps/daemon/src/engine/acp/v1.ts` — `STEER_METHOD`, `canSteer`, the steer retry loop. The same helper would serve v2.
- `apps/daemon/src/engine/acp/v2.ts` — `V2Layer.steer` (plain prompt plus echo check, line 150), the background and report wait handling.
- `apps/daemon/src/engine/acp/layer.ts` — `BACKGROUND_HANDOFF_MS` (2 s), `BACKGROUND_REPORT_MS` (20 s).
- `apps/daemon/src/engine/acp/children.ts` — reads child sessions announced by `subagent_update`.
- `apps/daemon/src/engine/process.ts` — `AgentProcess`, the descendant tracking that also covers Codex's own process groups.
- In the bun cache: `~/.bun/install/cache/@agentclientprotocol/codex-acp@2.6.0@@@1/dist/index.js` — `CodexBackgroundTerminalTasks` (line 50230 on), `promptV2` (54313), `acquireTurnStartReservation` (54144), v2 update conversion (about 32330).

## Constraints and gotchas

- The model decides whether a command becomes a background terminal. Only a call that returns while the process runs (a short `yield_time_ms`, or a command longer than the default yield) does; `nohup`/`&` inside a fast call does not, and then Codex neither tracks nor reports it. The earlier real check through the daemon saw such a command killed with the group at turn end.
- Codex lists foreground commands too; "background" means "outlived its turn". A client that lists at the wrong moment sees false positives (`d1`).
- Interrupting or cancelling does not stop commands. Codex starts each command in its own process group, so a group signal to the agent misses it (`e2`), and EOF on the app-server's stdin kills it (`e1`).
- There is no wake, so a daemon that shows "waiting for background work" for Codex has to decide what ends the wait.
- No protocol negotiation: read the Codex version from `userAgent` if gating by version is needed.
- The probes used `approvalPolicy: never`. Permission flows were not exercised.

## Sources

- `codex app-server generate-ts` and `generate-json-schema`, with and without `--experimental`, from `codex-cli 0.166.0`, 2026-11-19 (scratch folder below).
- openai/codex `codex-rs/app-server/README.md`, and https://learn.chatgpt.com/docs/app-server (redirected from developers.openai.com/codex/app-server), read 2026-11-19 (first 100,000 of 159,447 characters).
- openai/codex releases list (0.166 to 0.171, `gh api`, 2026-11-19).
- `agentclientprotocol/codex-acp`: repository, releases v2.6.0 to v2.8.0, `CHANGELOG.md`, PR #777 and #760, issue #492, `docs/background-work.md`, `docs/subagent-sessions.md`, `docs/steering.md`, `AGENTS.md`, tree and PR statistics (`gh api`, 2026-11-19).
- `@agentclientprotocol/codex-acp@2.6.0` source (bundle) from the bun cache; 2.7.0 and 2.8.0 installed into `scratchpad/codex-research/adapters/`.
- The owner's memory note on the single ACP path (decision of 2026-11-18).

Scratch evidence (may be cleared): `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/cf2576ef-b317-4b0c-a038-7bc9b17ae218/scratchpad/codex-research/`. `harness/client.ts` (raw app-server client), `harness/run.ts` (scenarios `a1` to `e3`), `harness/acp.ts` (raw `codex-acp` client, scenarios `k1` to `k8`, `ADAPTER=2.6.0|2.8.0`), `harness/timeline.py`; per run `runs/<id>/raw.jsonl` and `log.txt`; the schemas; `codex-acp-CHANGELOG.md`, `codex-acp-tree.txt`, `codex-acp-merged.txt`. To repeat: `ROOT=<dir> bun harness/run.ts b2` and `ROOT=<dir> ADAPTER=2.8.0 bun harness/acp.ts k3`.

## Open questions

- Does the daemon, with Codex on v2 and 2.8.0, pass the scenarios the Claude layer passed? **Answered:** yes, with two findings (a resume right after a chat's first turn is refused while the previous process still runs for the chat's title (`AcpSession.linger`, up to 10 s), on v1 too, see the review note in `acp-background-probe.md`; the call of a command that outlived its turn stays running and was failed with the turn, fixed). `acp-background-probe.md`, "Codex on v2 through the daemon (2.8.0)".
- How does Clowdy's `Children` behave with Codex's flavor of child sessions (ids `<parent>:subagent:<id>`, messages from the child, no `Agent` call card)? **Answered:** a child run made at the child's first word, named `Sub-agent`, ended by the loss of its item, stopped alone with `session/cancel` of the child (its running command is not stopped with it). Same page.
- Does the flap (list emptied, then refilled) seen with Claude happen with Codex when a child starts its own command? Not tried.
- Which Codex version first has `thread/backgroundTerminals/*`, and what does 2.8.0 do on an older Codex? Not checked.
- What does the model learn on its next turn about a command that ended while idle? Still not isolated: the runtime sends the note, and the model's answers quoted the output (it read it itself, once with an extra `echo`).
- Does the `codex-acp` v1 AIR path of 2.8.0 still work? Not run (not needed for A+).

## Assumptions and limits

- One model (`gpt-5.6-luna`, low effort), one login, macOS, a handful of runs per scenario. The model chose how to phrase each call; another model may yield or poll differently.
- App-server was driven with ephemeral threads (no rollout files); the ACP runs created persisted Codex sessions in `~/.codex/sessions` (about ten scratch sessions), as the earlier probes did.
- I fetched `codex-acp` 2.7.0 and 2.8.0 with `bun add` into the scratch folder; bun's global cache now holds them too. 2.7.0 was installed and not run.
- Not run: approvals and permission requests, `requestUserInput` and elicitations, images, MCP servers, compaction, goals, resume of a persisted thread, fork, nested sub-agents, a failing sub-agent, `multi_agent_v2`, the server-side queue, Windows, Codex versions other than 0.166.0, crash recovery of the app-server, memory cost.
- The schema churn numbers cover the stable surface that `codex-acp` commits, not the experimental one.
- Sizes of B and C are estimates built from `codex-acp`'s file sizes (bytes divided by 38 per line) and from the size of Clowdy's own `acp/` modules; they are not a plan.
- The owner's ChatGPT app has its own Codex 0.170 background daemon running; I only read the process list and touched none of it. Processes I started were stopped by pid or by their own group; two leftover commands of my own (`e2`, `k8`) were ended by pid.
