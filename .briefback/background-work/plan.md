# Background work that outlives a turn

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** A background command, background sub-agent or `Workflow` that an agent starts keeps running after its turn ends, and its completion reaches the chat as a new turn without a user message, as in bb.

**Approach:** The engine contract learns two things that no protocol owns: a snapshot of the background work the agent has open, and a live session that takes another prompt after a turn ended. The run runtime keeps such a session open in a new status, `waiting_background`, writes the agent-started turns into the stream, and sends the user's next message straight into it. Claude Code and Codex move to the ACP v2 draft, which reports turns and background work as standard events, through a second protocol layer next to the existing v1 one; every other agent stays on v1 and behaves as today. Evidence: `research/index.md`.

**Decisions**

Confirmed by the owner in chat (2026-11-19):

- No background feature of any engine is forbidden, hidden or disabled. The runtime supports them and matches bb: a background task started in a turn finishes after the turn, and the agent reports it in a new turn.
- Nothing guesses that a turn is over from silence. A turn, a task or a sub-agent is over when the agent says so. The only timers are explicit-marker driven: a handoff guard of 2 s that runs before a session is closed because nothing is open (the report turn starts 0.1 to 1.7 s after the last "done" marker), the same length again after a steer that landed (the turn it may get begins or the `done` goes out), and a report wait of 20 s (`BACKGROUND_REPORT_MS`) that runs only while a report is owed, that is from the moment the last background item ended between turns until a turn begins: the real adapter says `running` for an agent-started turn only at the model's first output, so the gap has no upper bound, and one real run lost its report at 2.003 s. Changed after the real check (2026-11-19); the owner is to confirm the 20 s.
- A session that waits for background work has no time limit. It ends when the agent has nothing open, or when the person stops the run, or the daemon stops, or the agent process exits.
- The runtime stays on ACP. The Claude Agent SDK is a fallback only if v2 proves unable to carry this; it is not planned.
- The engine seam is protocol-neutral. Each agent has a `protocol` setting in the catalog: `v2` for Claude Code, which answers `protocolVersion: 2` (an answer of 1, or a refused handshake, restarts that agent once on v1), and `v1` for every other agent. Codex also answers 2 but stays on v1 until Stage 10 moves it: the first real check saw its adapter hold a prompt that comes mid-turn on v2, and no background work; the research of the same day found that `_session/steering` injects on v2 and that `codex-acp` 2.8.0 reports a command that outlives its call on v2 (Stage 10). Only Claude Code, Codex and Cursor are in use; when another agent is taken into use its protocol is chosen then, by checking its answer to a v2 handshake. The v1 layer stays as it is.
- The v1 layer is kept working, not extended. A feature that needs v2, or is not easy on v1 (background work, a prompt into a live session, steering), is not built for v1: an agent on v1 offers what its layer can, and the runtime degrades as it already does (an engine without `steer` or `send` leaves the message in the chat's queue for the next turn). That an agent lacks a feature because of its protocol is accepted.
- The v1 opt-in route for Claude (`_meta.jetbrains.air`, `async_task_*` events, a tap on the agent's stdout) is not built. It is the fallback if the v2 layer falls short for Claude.
- A user message to a run that waits for background work goes to the live session as a normal `session/prompt` on the same process, with no resume. The run goes `waiting_background → queued → running` through the scheduler, so caps hold. An agent-started turn in progress finishes first; the message runs after it.
- `waiting_background` is an active status that holds no scheduler slot. Its session does not count toward `maxProcesses`, and the process stays recorded on the run so that cancel and the startup recovery can kill it. A chat's orchestrator is the only role that waits like this: executors, verifiers and spawned runs still end their session at `done`.
- Stop on a waiting run ends everything, background work included. After a daemon restart the run is `interrupted` like any run with a process; the next message tells the agent that background tasks from before the restart were lost.
- A run that ended has no open background work: `setStatus` clears `Run.background` on every terminal status. Startup recovery therefore reads the list before it interrupts the run and keeps the lost items in the run's work record for the next turn's message. `RunService.setBackground` bounds what it stores (50 items, 200 characters a title).
- One `done` ends the whole activity that an accepted `send` leads to: when the agent is working on a turn of its own, the prompt joins or follows it, and the engine holds back the `done` of that turn until the sent prompt has been answered. The driver counts one `done` per `send`.
- The chat shows what happens: each agent-started turn is an ordinary assistant message with no `user` item, a note names each background item when it finishes, and the strip above the message box gets one row ("2 background tasks running", shimmering, with Stop) in the pattern of Reforma's `ComposerBanner`. A background sub-agent that has a child run is its own row (it opens the run) and the count leaves it out; its item is named by the id of the call that started it, which is the child run's `parentToolCallId`. Its Stop reads "Stop all" and ends the orchestrator's run, since a sub-agent cannot be stopped alone.
- `ask_user` during a turn the agent started by itself (semi-manual chats) answers the agent with an error for now (`waiting_background → waiting_user` is not a transition); Stage 7's real check shows how often it happens.
- The progress of background sub-agents as child runs is its own stage (Stage 8).
- As a fallback for an agent that cannot steer (Cursor), Send now on a queued message becomes stop and send: the orchestrator's running turn is ended on purpose, without cancelling its spawned children and without pausing the queue, and the message is the next turn of the same session, told that the previous turn was stopped for it. The button says so. An ordinary queued message still waits for the turn's end. The last stage, after the rest of the plan.

**Reuse:** `AcpSession.drive`, `linger`, `close` (`apps/daemon/src/engine/acp/session.ts`: the process, the title linger, the cancel ladder); `spawnInOwnGroup`, `AgentProcess.stop` (`engine/process.ts`); `RunService.setStatus`, `setContext`, `resume`, `recover` (`runs/service.ts`) and `TRANSITIONS` (`runs/transitions.ts`); `TurnWriter`, `NativeAgents`, `ChatQueue`, `Wakeups` (`apps/daemon/src/runs/`); `ScriptEngine` (`apps/daemon/test/helpers.ts`); `fake-acp-agent.ts`; `ComposerBanner`, `ComposerBannerStatus`, `RunningAgents` (`apps/desktop/src/renderer/features/chats/`); the SDK's v2 client entry `@agentclientprotocol/sdk/experimental/v2/unstable`; the probe client `research/probe-harness.ts.txt`.

## Out of scope

- Forbidding or limiting background features of any engine.
- The v1 opt-in route for Claude (see Decisions); the Claude Agent SDK engine.
- Background work of agents other than Claude Code. Codex has none to report on either version; Cursor stays on v1 and stops at `done`; an agent added later gets its protocol chosen when it is taken into use.
- Stopping one background task or one sub-agent alone (v2 offers `capabilities.cancel` per item); Stop ends the whole run.
- Stopping a turn on its own, with no message to send (Stop does that), and stop and send while the run is not `running` (queued, blocked, waiting for an answer).
- Surviving a daemon restart; the existing `interrupted` path is the recovery.
- Executors, verifiers and `run_spawn` children waiting for background work.

## Stage 1 — Contract, statuses and storage

**Depends on:** None.

**This stage:** The runtime and the engines need one vocabulary before either changes: what an engine reports about open background work, how a live session takes another prompt, and what a run shows while it waits. This stage adds that vocabulary to the protocol package, the database, the status table and the test engine, and changes no behaviour of an existing run.

- [x] Complete
  - [x] `RunStatus` has `waiting_background`: active, terminal never, not busy (a message to it is delivered, not queued), with a reason text such as "Waiting for background work"
  - [x] `TRANSITIONS` and `NEEDS_REASON` cover it: `running → waiting_background`; `waiting_background → queued | succeeded | failed | cancelled | interrupted`, and a repeat to refresh the reason
  - [x] `Run.background`: the open items as `{ id, kind: 'command' | 'subagent' | 'task', title }`, stored (migration 12), published with the run, written by `RunService.setBackground`
  - [x] `EngineEvent` has `background`: a complete snapshot of the open items, repeated whenever it changes
  - [x] `EngineSession.send(text)`: hands a prompt to the live session after a turn ended and answers whether it took it; its events follow on the same iterator and end with `done`; an engine that cannot leaves it out
  - [x] `ScriptEngine` can script a session that outlives `done`: snapshots, agent-started turns, `send`, and ending the iterator

**Files**

- `packages/protocol/src/domain.ts` — `RunStatus`, `ACTIVE_RUN_STATUSES`, `isBusyRunStatus`, `Run`: the status and `background`; `BackgroundItem` joins the same file
- `apps/daemon/src/runs/transitions.ts` — `TRANSITIONS`, `NEEDS_REASON`
- `apps/daemon/src/db/migrations.ts` — migration 12: `runs.background`; `apps/daemon/src/db/runs.ts` — the row mapping and the upsert
- `apps/daemon/src/runs/service.ts` — `RunService.setBackground` (bounded), `setStatus` (clears `background` on a terminal status), `recover` (interrupts a `waiting_background` run); `isActive` already follows `ACTIVE_RUN_STATUSES`
- `apps/daemon/src/runs/run-tools.ts` — `run_wait`: the literal list of unfinished statuses becomes `isTerminalRunStatus`, so a child in the new status is not reported finished
- `apps/desktop/src/renderer/shared/runStatus.ts` — a minimal entry for the new status, so typecheck stays green until Stage 6
- `apps/daemon/src/engine/types.ts` — `EngineEvent`, `EngineSession`
- `apps/daemon/test/helpers.ts` — `ScriptEngine`: the lingering session
- `apps/daemon/test/runs.test.ts` — status table and `setBackground` tests

**Done when:** a daemon test moves a run `running → waiting_background → queued → running` and `→ succeeded`, refuses the transitions not listed, and reads `Run.background` back from the database and the event log.
**Verify:** `cd apps/daemon && bun test test/runs.test.ts && bun run typecheck && bun run lint`, and `cd packages/protocol && bun run typecheck`
**Commits:** `e2960fe` feat(daemon): add the waiting_background status, a run's open background items and the live-session contract of an engine

## Stage 2 — Driver: a session that outlives its turn

**Depends on:** Stage 1.

**This stage:** `RunDriver.turn` treats `done` as the end of the session: it settles the run and closes the session. With open background work the run must instead wait without a slot, keep reading the same session, write each agent-started turn into the stream, and take the user's next message into the live session. This stage is the lifecycle change; it also decides how a cancel, a daemon stop, a child's wake-up and a restart behave while the session waits. It is tested with `ScriptEngine`, with no ACP in the loop.

- [x] Complete
  - [x] At `done`, a run whose last snapshot has open items goes `running → waiting_background`, releases its slot, leaves `maxProcesses` and keeps its process recorded; with no open items it settles as before
  - [x] Events after `done` are written as an agent-started turn: a new assistant message, tool items, usage and context, no `user` item; the iterator ending settles the run (`succeeded`, or what `settle` decides)
  - [x] A message to a waiting run (`chat.send`, a queued item, a wake-up) goes to `session.send` through `waiting_background → queued → running`, takes a slot, and returns to waiting or settles at its `done`; when the session cannot take it, the existing resume path runs
  - [x] Cancel, a daemon stop and the process exiting close the session and leave the statuses the tests name; `recover` (which already interrupts a `waiting_background` run) keeps the items it had open in the run's work record before `setStatus` clears them, and the next message tells the agent that background tasks from before were lost
  - [x] An orchestrator with both active `run_spawn` children and open background work shows `waiting_children`, keeps its session, and its wake-up goes through the same live-session path; no double close, no lost mailbox rows
  - [x] `NativeAgents.finish` does not cancel sub-agents that are still in the snapshot; each ends when it leaves it or with the run
  - [x] A note per item that left the snapshot ("Background command finished: …" style, no trailing period), and `ChatQueue` treats `waiting_background` as at rest

**Files**

- `apps/daemon/src/runs/driver.ts` — `LiveRun`, `launch`, `drive`, `turn`, `consume`, `settle`: the linger flow and delivery to a live session
- `apps/daemon/src/runs/native.ts` — `NativeAgents.finish`: the exception for open sub-agents
- `apps/daemon/src/runs/queue.ts` — `isAtRest`, `onStatus`: the new status as at rest
- `apps/daemon/src/runs/wake.ts` — `Wakeups`: the wake-up of a run that has a live session
- `apps/daemon/src/runs/service.ts` — `recover`, `resume`, `onOrchestratorStatus`
- `apps/daemon/src/runs/prompts.ts` — the first message after a restart that lost background tasks
- `apps/daemon/test/background.test.ts` — create: run-level tests that no existing file owns (waiting, delivery, cancel, stop, recovery, children plus background)

**Done when:** in a daemon test, a run whose turn ended with open background work shows `waiting_background` with no slot held, an agent-started turn appears as stream items, a user message reaches the same session and runs after it, and cancel, a daemon stop and a restart each end the session with the status the tests name.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`
**Commits:** `0110851` feat(daemon): keep a chat's agent session while it has background work and hand the next message to it

## Stage 3 — ACP protocol layers: the seam and the `protocol` setting

**Depends on:** None.

**This stage:** `AcpSession` is one class that owns the process and also speaks ACP v1: the handshake, the session calls, the prompt loop and the SDK's `client()`. A second protocol cannot share that conversation, because v2's prompt only acknowledges and the turn ends at a `state_update`. This stage moves the v1 conversation behind a small layer interface and leaves in `AcpSession` what every protocol shares: the process, the tool bridge, permissions, titles, model and effort options, cancel and close. Behaviour does not change; every existing test passes untouched. It also adds the `protocol` field and its choosing logic.

- [x] Complete
  - [x] The v1 conversation (`talk`, `steer`, the notification wiring, `session/new`, `resume`, `load`) lives in its own module behind one interface, selected per connection
  - [x] `AgentSpec.protocol` (`v1` default, `v2`) in the catalog, resolved into `ResolvedAgent`; custom agents are `v1`
  - [x] The layer is chosen per connection from `ResolvedAgent.protocol`; only the v1 layer exists in this stage, and `v2` is accepted by the catalog type but starts nothing until Stage 4
  - [x] All existing `acp-*` tests pass with no edits

**Files**

- `apps/daemon/src/engine/acp/session.ts` — `AcpSession`, `drive`, `talk`: what stays, what moves
- `apps/daemon/src/engine/acp/v1.ts` — create: the v1 conversation. It cannot join `session.ts`, which would then hold two protocols' conversations at 750 lines each
- `apps/daemon/src/engine/acp/catalog.ts` — `AgentSpec`, `KNOWN_AGENTS`: `protocol`
- `apps/daemon/src/engine/acp/registry.ts` — `ResolvedAgent`, `build`: carry `protocol`
- `apps/daemon/src/engine/acp/probe.ts` — the handshake it repeats

**Done when:** `bun test test/acp-*.test.ts test/agents-api.test.ts` passes unchanged, and the conversation of an ACP session lives in `v1.ts` behind an interface that a second layer can implement.
**Verify:** `cd apps/daemon && bun test test/acp-session.test.ts test/acp-mapper.test.ts test/acp-runtime.test.ts test/agents-api.test.ts && bun run typecheck && bun run lint`
**Commits:** `9efebbb` refactor(daemon): move the ACP v1 conversation behind a protocol layer and add the agent protocol setting

## Stage 4 — ACP v2 layer: the conversation

**Depends on:** Stage 3.

**This stage:** The v2 layer reaches parity with what the v1 layer does for Claude Code and Codex today: a turn, its text, tools, usage and context, model and effort, titles, additional folders, the system prompt, resume, cancel, steering and the compact command. It does not yet look at background work. In v2 `session/prompt` only acknowledges a message (`{ messageId }`); the turn is `state_update` `running` until `idle` with a `stopReason`, and a prompt sent while a turn runs is inserted and behaves as a steer, so `steer` is a prompt, not `_session/steering`.

- [x] Complete
  - [x] The handshake rule: `v2` asks for version 2; an answer of 1 or a refused `initialize` stops the process and restarts the agent once on v1, remembered for the daemon's life per agent program and version
  - [x] v2 handshake (`info`, `capabilities`; no `fs`, no `terminal`), session creation and `session/resume` with `replayFrom` and `replay_complete`; the existing fallback to a new session with the conversation record when a session cannot be continued
  - [x] The turn loop: prompt acknowledgement by `messageId`, `running` and `idle` with `stopReason` as `done` or `error`, `requires_action` as a pause; a session that never reaches `idle` is ended by cancel and process exit as in v1
  - [x] A v2 update mapper that produces the same `EngineEvent`s as the v1 one: messages by `messageId` (chunks append, whole messages replace), a tool call created by its first `tool_call_update`, terminals, plans dropped, usage on the idle `state_update` and in `usage_update`, the context window
  - [x] Model, effort (config options with the v2 `type` discriminator), title (`session/set_title`, `session_info_update`), `additionalDirectories`, `systemPrompt`, the tool bridge's MCP server, permission requests answered by the daemon, the compact command
  - [x] `steer(text)` is a prompt inserted into the running turn; it answers whether the agent took it
  - [x] Updates that belong to another session than the main one (sub-agent children) are dropped for now
  - [x] `test/fake-acp-agent-v2.ts` speaks v2 and the same directives as the v1 fake agent where they apply, and the session tests run against both layers for the scenarios they share
  - [x] Claude Code is switched to `protocol: 'v2'` after the real-adapter checks (Codex stays on v1, see Decisions); Claude Code and Codex were meant to switch only after the real-adapter checks pass (a handshake, a one-line prompt, a steer, a resume, a cancel in a scratch daemon); those checks and the switch run after Stage 5, because Stage 5 changes how a turn ends and Stage 7 owns the real runs

**Files**

- `apps/daemon/src/engine/acp/v2.ts` — create: the v2 conversation. It cannot join `v1.ts`: the handshake, the turn lifecycle and the update shapes differ
- `apps/daemon/src/engine/acp/mapper.ts` — `UpdateMapper`: reused for the shared event construction; `apps/daemon/src/engine/acp/mapper-v2.ts` — create: the v2 update shapes. It cannot join `mapper.ts`, whose cases are keyed on v1 update kinds
- `apps/daemon/src/engine/acp/session.ts` — `AcpSession`: choose the layer, pass `signal`, `tools`, `title`
- `apps/daemon/src/engine/acp/catalog.ts` — `KNOWN_AGENTS`: `protocol: 'v2'` for `claude` and `codex`, once the real checks pass
- `apps/daemon/test/fake-acp-agent-v2.ts` — create: a v2 scripted agent. It cannot join `fake-acp-agent.ts`, which is built on the v1 SDK entry point
- `apps/daemon/test/acp-session.test.ts`, `apps/daemon/test/acp-mapper.test.ts`, `apps/daemon/test/acp-helpers.ts` — run the shared scenarios on both layers

**Done when:** the shared ACP session tests pass on the v1 and the v2 layer, and a scratch daemon on its own data folder runs one chat turn, a steer, a resume and a cancel through the real Claude Code adapter and the real Codex adapter on v2.
**Verify:** `cd apps/daemon && bun test test/acp-session.test.ts test/acp-mapper.test.ts test/acp-runtime.test.ts test/agents-api.test.ts && bun run typecheck && bun run lint`, plus the scratch-daemon check above
**Commits:** `e956c0a` feat(daemon): add an ACP v2 protocol layer with its own mapper, a restart on v1 for agents that answer 1, and a v2 scripted agent

## Stage 5 — ACP v2 layer: background work

**Depends on:** Stage 1, Stage 4.

**This stage:** The v2 layer turns what the agent reports into the engine contract of Stage 1. `state_update.background` becomes `background` snapshots; a turn the agent starts on its own is a `running` after `idle` with no prompt behind it and becomes the events of an agent-started turn ending in `done`; when nothing is open and nothing runs, the session waits the handoff guard and ends its iterator. It builds on the existing title linger of `AcpSession` (one linger mechanism with two reasons), and unlike the title linger it keeps the process recorded on the run.

- [x] Complete
  - [x] `background` snapshots from `state_update.background`: a terminal is a `command`, a sub-agent a `subagent`, a tool call (`Workflow`, `Monitor`) a `task`, titled from the call
  - [x] After `done` the session stays alive while the last snapshot has items or a turn runs; events that come with no prompt open an agent-started turn that ends at the next `idle`
  - [x] When the snapshot is empty and the session is `idle`, a 2 s handoff guard (a named constant) starts; a `running` or a new item cancels it; at its end the session closes its process and ends the iterator
  - [x] `send(text)`: a prompt on the live session; while an agent-started turn runs, the agent inserts it into that turn (a steer) and the prompt is not lost; one `done` follows an accepted `send`, and the `done` of an agent-started turn that was running is held back until the sent prompt has been answered
  - [x] A steer that lands in Claude's v2 adapter comes back as two turns (an `idle` with zero usage, a `running`, the same answer again as a whole message under a new id, an `idle` with the real usage): the `running` that follows a landed steer is that steer's own turn, its usage folds into the same `done`, and a whole message identical to the one before is not written twice
  - [x] The process stays recorded (`process` event) for the whole wait; cancel, abort and process exit end the wait at once
  - [x] The fake v2 agent has directives that start background work, end the prompt, and later emit a report turn; tests cover the guard, a `running` that arrives inside it, `send` during a report turn, cancel while waiting and the process exiting while waiting
  - [ ] (moved to Stage 7) Probes repeated through the real adapters in a scratch daemon: a background command, a background sub-agent and a workflow each finish after the turn and produce a report turn

**Files**

- `apps/daemon/src/engine/acp/v2.ts` — the snapshot, the agent-started turn, the guard, `send`
- `apps/daemon/src/engine/acp/mapper-v2.ts` — `background` items from `state_update`
- `apps/daemon/src/engine/acp/session.ts` — `linger`, `lingering`, `close`: the second reason to linger, the recorded process
- `apps/daemon/test/fake-acp-agent-v2.ts` — the background directives
- `apps/daemon/test/acp-session.test.ts` — the new scenarios

**Done when:** against the v2 fake agent, a turn that started background work yields `done`, leaves the process alive and recorded, yields the agent's report as a second turn, ends the iterator after the guard once nothing is open, and `send` during the wait reaches the agent; against the real Claude Code adapter in a scratch daemon the same happens for a 60 s background command.
**Verify:** `cd apps/daemon && bun test test/acp-session.test.ts test/acp-mapper.test.ts && bun run typecheck && bun run lint`, plus the scratch-daemon check
**Commits:**

- `2eab0eb` feat(daemon): keep a v2 session alive while background work is open and take messages into it. The report turn, `send`, the guard and the steer accounting (`engine/acp/turns.ts`) are tested against the v2 fake agent; the scratch-daemon check with the real adapters is in Stage 7. Decision: a landed steer holds the turn's `done` until the turn it may get begins or one guard (2 s) passes, so an agent that folds a steer into the same turn pays 2 s per steered turn; refine per adapter (for example skip the wait when the first `idle` carries usage) once Stage 7 shows the real sequences.


## Stage 6 — Desktop surface

**Depends on:** Stage 1.

**This stage:** The new status and `Run.background` must read correctly in the app. The strip above the message box already lists the agents that work (`RunningAgents`, from Reforma's `ChatComposerSubagents`); a chat that waits for background work gets one more row in the same pattern: a shimmering line that counts the open items, with Stop. Read `apps/desktop/AGENTS.md` and `packages/components/AGENTS.md` first; the root `AGENTS.md` UI text rule applies (no trailing period on a phrase).

- [x] Complete
  - [x] `RUN_STATUS_VIEW` has a label and tone for `waiting_background`; every branch on `waiting_children` in the chat, the agent tree and the run detail takes the new status into account
  - [x] One row above the message box while `Run.background` is not empty: "Background task running", "2 background tasks running", shimmering, with Stop (`run.cancel` of the orchestrator); the composer stays usable and a message sent from it reaches the live session
  - [x] The fixture transport shows a chat in the new status for development and tests

**Files**

- `apps/desktop/src/renderer/shared/runStatus.ts` — `RUN_STATUS_VIEW`
- `apps/desktop/src/renderer/features/chats/chatRun.ts` — the branch at `waiting_children`
- `apps/desktop/src/renderer/features/agents/agentTree.ts`, `apps/desktop/src/renderer/features/agents/RunDetail.tsx` — the branches at `waiting_children` (the owner has uncommitted edits in other files of `features/agents/`: stage only these)
- `apps/desktop/src/renderer/features/chats/RunningAgents.tsx`, `apps/desktop/src/renderer/features/chats/runningAgentRows.ts` — the background row
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — a fixture chat that waits
- `apps/desktop/src/renderer/features/chats/chatRun.test.ts`, `apps/desktop/src/renderer/features/chats/Composer.test.tsx` — the new status and the row

**Done when:** the fixture chat shows the status in the run list, the row above the message box with the right count and a working Stop, and the existing renderer tests pass.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:** `2455817` feat(desktop): show a run that waits for background work, with a row above the message box that counts what is open

## Stage 7 — Real check and documents

**Depends on:** Stage 2, Stage 5, Stage 6.

**This stage:** Everything so far was tested against fakes and one-turn probes. This stage runs the whole chain once with real agents, in a daemon on its own data folder and port (never the owner's running app), and brings the daemon guide in line with how a session now lives.

- [ ] Complete
  - [x] Real Claude Code through the HTTP API of a scratch daemon: a 60 s background command ends its turn and the completion arrives as a new turn; a background sub-agent and a workflow likewise; a message sent while they work reaches the agent and is answered; Stop during the wait leaves no process (`ps`); a restart makes the run `interrupted` and the next message mentions the lost tasks
  - [x] Real Codex on v2: a normal turn, a steer, a resume; a command it backgrounds does not keep the run waiting. Result: all pass except the steer, which v2 holds until the turn ends where v1 injects it, so Codex stays on v1
  - [x] An agent on v1 (Cursor) still ends its session at `done`
  - [x] `apps/daemon/AGENTS.md`: "One session is one process, one turn" and "Turns, parking and wake-ups" say how a session may outlive its turn, "Agents" says what `protocol` is and which agents use v2, the status list and "Events" have `waiting_background` and `background`; `research/` records the evidence

**Files**

- `apps/daemon/AGENTS.md` — the sections named above
- `.briefback/background-work/research/acp-background-probe.md` — the evidence of the real check

**Done when:** the real Claude Code chat shows the completion of a 60 s background command as a new turn with the composer row visible during the wait, and the daemon guide describes the new lifecycle.
**Verify:** `bunx turbo run build lint typecheck test --affected` and the real check above
**Commits:**

- `3c7f4a0` fix(daemon): carry the real-adapter findings of the background work into the v2 layer and run Claude Code and Codex on it. Three defects fixed with tests: a repeated answer after a steer (Claude sends it as one chunk), a report turn later than the guard (`BACKGROUND_REPORT_MS`, 20 s), commands below the agent left alive by Stop (`AgentProcess.watch`). The owner still has to look at the composer row and the strip in the app during a wait: the agents drove the API only.
- Regression check of Claude Code and Codex on v2 against v1 (`research/acp-background-probe.md`): the rest passes (`run_spawn` children, `ask_user`, permissions, compact, model and effort, title, attachments, resume, usage). Found: Codex steer (v2 holds it), foreground and background sub-agents invisible on v2 (Stage 8), and a Claude steer that waits for the running tool on v2 where v1 cut it short.

## Stage 8 — Sub-agents as child runs on v2

**Depends on:** Stage 2, Stage 5, Stage 7.

**Scope change after the real check (2026-11-19):** on v2 the parent is not shown the `Agent` call of a child it announces, and the child's traffic is a session of its own that the layer drops, so every sub-agent of Claude Code, foreground and background, lost its tool card and its child run compared with v1. The stage covers both kinds, and Claude Code stays on v2 only if it lands before the branch ships.

**This stage:** In v2 a background sub-agent is a child session: `subagent_update` announces it and carries its state, and its messages and tool calls keep arriving after the parent's turn ended, which Stage 4 drops. This stage routes that traffic into native child runs, so the person can open a working sub-agent from the strip above the message box and read what it does, and so a child run ends when its sub-agent does, not when the call that started it returned.

- [x] Complete
  - [x] `subagent_update` becomes `subagent` events with the call's id as `parentToolCallId`, running while the sub-agent's state is `running` and done or error at its `idle`
  - [x] Updates of a child session reach its native run through `agentId`, in the parent's stream order, while the parent waits and while it works
  - [x] A background sub-agent's row above the message box shows its activity and call count (the existing `AgentRow`), and opens its run
  - [x] The mapper's old rule that drops what a sub-agent reports after its call ended no longer applies to v2, and `apps/daemon/AGENTS.md` ("Sub-agents") says so

**Files**

- `apps/daemon/src/engine/acp/mapper-v2.ts` — `subagent_update`, child session routing
- `apps/daemon/src/runs/native.ts` — `NativeAgents`: a child that outlives the call that started it
- `apps/desktop/src/renderer/features/chats/RunningAgents.tsx` — rows for background children (no change if they already appear)
- `apps/daemon/AGENTS.md` — "Native sub-agents", "Agents → Sub-agents"
- `apps/daemon/test/native.test.ts`, `apps/daemon/test/acp-mapper.test.ts` — child traffic after the parent's `idle`

**Done when:** with a background sub-agent running in a real Claude Code chat, its tool calls appear in its own child run while the parent waits, and the child ends with the sub-agent.
**Verify:** `cd apps/daemon && bun test test/native.test.ts test/acp-mapper.test.ts test/acp-session.test.ts && bun run typecheck && bun run lint`, and the real check
**Commits:**

- `50f72ca` feat(daemon): show the sub-agents of Claude Code on ACP v2 as child runs (merged in `96dbdb8`). New `engine/acp/children.ts`; a synthetic `Agent` card from the prompt message's id; the sub-agent item id is the call id; a foreground child ends at its `idle`, a background one when it leaves the list; an item that leaves and returns is the same item (debounce by identity, no timer); a sub-agent with a child run is its own row in the strip with "Stop all" and is not counted in the background row. Real Claude Code scenarios through a scratch daemon passed (foreground, background, two at once, Stop, a message while the child works, a child with its own command). Open for the owner: the wording of Stop on that row (see the chat).

## Stage 9 — Stop and send for agents that cannot steer

**Depends on:** Stage 2, Stage 4.

**This stage:** Send now on a queued message hands it to the running turn as a steer. An agent that cannot steer (Cursor says nothing about steering in `initialize` and refuses `_session/steering`) leaves the message waiting for the turn's end, however long. For such an agent Send now becomes stop and send: the person asked for it explicitly, the button says what it does, the running turn ends, and the message runs as the next turn of the same session, resumed as any next turn. It ends only the orchestrator's turn: its spawned children keep working and report back as usual, and the chat's queue is not paused, unlike Stop. An ordinary queued message and a message to an agent that can steer behave as before. It waits for Stages 2 and 4 because both change `RunDriver.turn` and the session's steering.

- [x] Complete
  - [x] `EngineSession.canSteer`: whether the session can take a steer at all (the agent said so in its handshake; a v2 session always can), so a refusal because the turn is over is not mistaken for a missing ability
  - [~] `AgentInfo.canSteer` from the catalog: built, then removed at the owner's request (see Commits); the app does not ask which agents can steer
  - [x] `RunDriver.interrupt(runId)`: ends the orchestrator's running turn on purpose: aborts the turn's session, closes open tool calls as stopped, leaves the run at rest with a reason such as "Stopped to send a message", cancels no descendant and pauses no queue
  - [x] `ChatQueue.sendNow` on a `running` orchestrator whose live session cannot steer: the chosen item becomes the head of the queue (a steer), the turn is interrupted, and `settle` sends it; any other status keeps today's behaviour
  - [x] The next turn's message, for the agent only (not the person's bubble), says that the previous turn was stopped so this message could be sent
  - [~] "Send now" reads "Stop and send" for an agent that cannot steer: built, then removed at the owner's request; the button reads as before for every agent, and the daemon still stops the turn for an agent that cannot steer

**Files**

- `apps/daemon/src/engine/types.ts` — `EngineSession`: `canSteer`
- `apps/daemon/src/engine/acp/session.ts` — `AcpSession`: `canSteer` from `steerable`, and true for a v2 session
- `apps/daemon/src/engine/acp/catalog.ts` — `AgentSpec`, `KNOWN_AGENTS`: `steer` for `claude` and `codex`; `apps/daemon/src/engine/acp/registry.ts` — where `canCompact` is built: `canSteer`
- `packages/protocol/src/agents.ts` — `AgentInfo`: `canSteer`
- `apps/daemon/src/runs/driver.ts` — `LiveRun.turn`, `turn`: `RunDriver.interrupt`
- `apps/daemon/src/runs/queue.ts` — `ChatQueue.sendNow`: the stop-and-send branch
- `apps/daemon/src/runs/prompts.ts` — the line about the stopped turn
- `apps/daemon/test/queue.test.ts` — tests with a `ScriptEngine` that cannot steer: the turn ends, the message is the next turn of the same session, spawned children still run, the queue is not paused
- `apps/desktop/src/renderer/features/chats/ComposerQueue.tsx`, `apps/desktop/src/renderer/features/chats/chatProvider.ts` — the label, and `canSteerChat` beside `canCompactChat`; `apps/desktop/src/renderer/daemon/fixtureData.ts` — `canSteer` in the fixture agents; `apps/desktop/src/renderer/features/chats/ComposerQueue.test.tsx` — the label

**Done when:** in a daemon test with an engine that cannot steer, Send now on a queued message ends the running turn, the message runs as the next turn of the same session, the orchestrator's spawned children are still running and the queue is not paused; the app labels the button "Stop and send" for such an agent.
**Verify:** `cd apps/daemon && bun test test/queue.test.ts test/runs.test.ts && bun run typecheck && bun run lint`, and `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:**

- `026fa80` feat(daemon): add stop and send for agents that cannot steer a running turn. Includes the review fixes: a queue emptied between the press and the rest parks a run that still has children (`RunDriver.rest`), and a stop and send does not send the chat's task back to todo.
- `c673803` refactor(desktop): name Send now the same for every agent. The owner does not care about the label: users find out which agent steers well. Removes `AgentInfo.canSteer`, `AgentSpec.steer`, `canSteerChat` and the fixture simulation; `EngineSession.canSteer` stays, it decides what the daemon does.
- Known and accepted: a press in the first seconds of a Cursor turn waits for the turn (the v1 handshake is not answered yet); a custom ACP agent that says it steers is steered, and one that does not is stopped, by the same rule.


## Stage 10 — Codex on ACP v2

**Depends on:** Stage 5, Stage 8, and the stage that stops one sub-agent alone (it adds `stopItem`).

**This stage:** The research of 2026-11-19 (`research/codex-app-server.md`) corrected two earlier findings about Codex. First, Codex does have background work: a command that outlives its call (unified exec, a short `yield_time_ms`) is tracked, and `codex-acp` 2.8.0 reports it on v2 as `state_update.background` with `terminal_update.capabilities.cancel` and `terminal/cancel`, with child sessions for its sub-agents (only `nohup … &` is not tracked). Second, a plain prompt sent mid-turn is held on v2, but `_session/steering` on a v2 connection returns `injected` and lands in the running turn (the v2 `initialize` carries `_meta.steering.supported`). The owner chose (2026-11-19) to keep `codex-acp`, raise the pin to 2.8.0 and move Codex to v2; no own adapter and no native engine. `app-server` cannot wake a thread when a background command or sub-agent ends, so the runtime does it: when a Codex session's last background item ends and the session is idle, the runtime sends it one note ("Background command finished: …") so the agent reports, as Claude does by itself. Confirmed by the owner (2026-11-19): send the note; the policy stays a per-agent catalog field.

- [ ] Complete
  - [ ] The v2 layer steers through `_session/steering` when the agent's `initialize` says `_meta.steering.supported`, and keeps the plain prompt for an agent that does not (Claude Code); `canSteer` follows the same fact
  - [ ] Codex's background items on v2 become `background` snapshots (commands, sub-agents) and its sub-agent child sessions (`<parent>:subagent:<id>`, agent messages and no `session_message`) become child runs through `children.ts`
  - [ ] Stop of one Codex command or sub-agent alone uses `terminal/cancel` and `session/cancel` of the child, through `stopItem`
  - [ ] The wake note: when the last background item of an agent that does not start a report turn by itself ends and nothing runs, the runtime sends the note through `send`; the policy is per agent (a catalog field), on for Codex, off for Claude Code; a note is never sent after Stop or while a turn runs
  - [ ] `codex-acp` is pinned to 2.8.0 (not before 2026-11-22: the repository's `minimumReleaseAge` of three days refuses a newer version, so `bun x` fails the run) and Codex is `protocol: 'v2'` in the catalog after the real check passes in a scratch daemon: normal turn, resume, steer, Stop, a command with `yield_time_ms` that outlives its call (list, end, wake note, report turn), a sub-agent, stop one command, stop one sub-agent, `ask_user`, compact
  - [ ] The notes that say Codex has no background work are corrected: `research/index.md`, `research/acp-background-probe.md`, the comment in `catalog.ts`, `apps/daemon/AGENTS.md`, and the Decisions line above

**Files**

- `apps/daemon/src/engine/acp/v2.ts` — steering over `_session/steering`, the wake note, `stopItem` for a terminal
- `apps/daemon/src/engine/acp/children.ts`, `mapper-v2.ts` — Codex's child sessions
- `apps/daemon/src/engine/acp/catalog.ts` — the pin, `protocol: 'v2'`, the wake-note field
- `apps/daemon/test/fake-acp-agent-v2.ts`, `acp-session.test.ts`, `acp-mapper.test.ts`, `acp-layers.test.ts`, `background.test.ts` — the new directives and scenarios
- `apps/daemon/AGENTS.md` and the research pages above

**Done when:** a real Codex chat on v2 backgrounds a command, the run waits with the row above the composer, the wake note starts a report turn when the command ends, a message sent meanwhile is answered, Stop leaves no process, and a steer lands in the running turn.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`, plus the scratch-daemon check
**Commits:** None yet.
