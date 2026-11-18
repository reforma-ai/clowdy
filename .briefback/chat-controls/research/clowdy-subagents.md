# Clowdy today: sub-agents

Snapshot 2026-11-18, `main` at `61ea92a`. "Observed" means read in the current source or the
installed packages; "inferred" means read from code but not run. No agent was started for this note.

## Summary

- **Two kinds of nested work, by design** (`../../acp/plan.md`, Decisions): `spawned` is Clowdy's
  own `run_spawn`, a real run with its own process, session and slot, shown in the Agents tree under
  its chat; `native` is an agent's own `Agent`/`Task`/`spawnAgent` call, meant to become a card on
  that tool call in the parent's stream, never a tree node. Plan Stage 6's card items are unchecked.
- **`run_spawn` works end to end** (tool → child run → wake-up with summaries → tree), but the chat
  stream shows it as a generic tool line "Run spawn" plus note lines ("Started Executor 01 on CLW-1",
  "Executor 01 finished: succeeded"). Nothing in the stream links to the child, and nothing nests.
- **Native sub-agents over ACP are not handled.** The runtime has the machinery (`subagent` engine
  events → `NativeAgents` → child runs with `origin: 'native'`), but only the fake engine emits those
  events. Claude's adapter, without the opt-in Clowdy does not send, puts its sub-agents' tool calls
  and text into the parent session tagged with `_meta.claudeCode.parentToolUseId`; Clowdy's mapper
  ignores that tag, so they most likely show as the orchestrator's own items (inferred from the
  adapter's code, not seen live).
- **Delegation guidance** is in the inlined `clowdy:orchestrate` skill, not in the system prompt
  proper: do it yourself, an engine sub-agent for read-only research and small file-disjoint edits,
  or `run_spawn` for coarse task-bound work.

## `run_spawn`, end to end

| Piece | Where | Role |
| --- | --- | --- |
| Tool | `apps/daemon/src/runs/run-tools.ts` `orchestratorRunTools()` | `run_spawn({ taskIds (≥1), prompt, role?: executor \| verifier, engine? (never `fake`), model?, cwd?, idempotencyKey })` returns `{ runId, name, role, status, statusReason, duplicate }` at once. Siblings: `run_inspect`, `run_wait` (≤60 s), `run_cancel`. |
| Who gets it | `runs/tools.ts` `toolsFor()` | Orchestrators only; executors and verifiers get task tools and `report_result`. |
| Transport | `engine/acp/bridge.ts`, `engine/acp/mcp-stdio.ts` | An MCP server per session; the result reaches the model as text (`resultText`: JSON for an object). The bridge never sees the ACP `toolCallId`. |
| Name in the stream | `engine/acp/mapper.ts` `nameOf()` | `mcp__clowdy__run_spawn`, `clowdy/run_spawn` and the like become the bare `run_spawn`. |
| Child creation | `runs/driver.ts` `RunDriver.spawn()` | In one transaction: refuses a terminal parent, dedupes by `idempotencyKey` (`findSpawnedChild`), depth `MAX_DEPTH = 2` (so a child cannot spawn), caps `maxActiveChildren` (300) and `maxChildren` (3000), `cwd` check, one active executor per task; `RunService.createRun({ origin: 'spawned', parent, ... nextPrompt: firstMessage(role, mode, prompt) })`; the child's stream gets `{ kind: 'user', text: prompt }`; the parent's stream gets a note `Started <name> on <keys>` (or `<name> is waiting: <reason>`); `launch`. |
| Model inheritance | `RunDriver.spawn()` | Same engine and no `model`: the child inherits the parent's model and effort; otherwise what it names, else the project's model. |
| Contract | `packages/protocol/src/domain.ts` `Run.parentRunId`, `rootRunId`, `origin?: 'spawned' \| 'native'` | Names come from `RunService.createRun` (`Executor 07`, `Verifier 02`). |
| Parking and wake-up | `RunDriver.settle()`, `runs/wake.ts` `Wakeups`, `runs/reports.ts` `wakeMessage()`, `childReport()` | A turn that ends with spawned children active or results unread parks the orchestrator in `waiting_children`. A finished child writes a `run_mailbox` row; after `wakeWindowMs` the parent's next turn starts with the bounded summaries, and `turn()` adds a note `<child> finished: <state>` per child. |
| Tree | `apps/desktop/src/renderer/stores/runTree.ts` `buildRunTree()`; `features/agents/agentTree.ts` `agentRows()`; `features/agents/AgentList.tsx` | Runs nest by `parentRunId`, any origin. The chat row stands for its orchestrator; children and grandchildren nest below it with folds. The heading's menu toggles subthreads and finished subthreads (`UiStore.showSubthreads`, `showFinished`). |
| Run page | `features/agents/RunDetail.tsx` | A run's stream, read only, with its tasks and an `AgentChip` to the parent. A native run shows "Runs inside <parent>" instead of Stop. Its working line for `waiting_children` says "Waiting for sub-agents…" (the chat says "Waiting for the executors…", `features/chats/chatRun.ts` `liveLine`). |

### What the chat stream shows for `run_spawn`

- `features/chats/ChatView.tsx` draws `useChatStream(chat)`, which is only the orchestrator run's
  stream (`stores/hooks.ts`). Children's items never appear there.
- `stream/StreamView.tsx` `renderItem()`: every `tool` item is a `ToolCard` (`stream/ToolCard.tsx`).
  `stream/toolView.ts` `describeTool('run_spawn', input)` has no case, so the line is the generic
  tool icon, the verb "Run spawn", and as chip the first string of the input of at most 80 characters
  (with `taskIds` an array and `prompt` usually longer, that is `role` or `idempotencyKey`; inferred).
  Opening it shows the input and the output as JSON or text; the child's `runId` is in the output.
- Around it: the note lines above (`NoteLine`), and after the turn ends everything folds under
  "Worked for …" (`stream/turns.ts`).
- `shared/AgentChip.tsx` (opens a run through `openRun`) exists but nothing in the stream uses it.
- Nested display: none. `features/chats/ProgressCard.tsx` after the latest assistant message shows
  the chat's task progress, not runs.

## Native sub-agents

### What the runtime has

- Seam (`apps/daemon/src/engine/types.ts`): `subagent { agentId, parentToolCallId?, name, description?, state: running | done | error | cancelled, summary? }`,
  and `text` / `tool` events with an `agentId`.
- `runs/driver.ts` `consume()`: events with `agentId` go to `NativeAgents.stream()`, `subagent` to
  `NativeAgents.state()`; the rest to the run's own `TurnWriter`.
- `runs/native.ts` `NativeAgents`: one child run per `agentId` through `RunService.createNative()`
  (role `executor`, `origin: 'native'`, starts `running`, no slot, model and effort copied); its own
  `TurnWriter` throttled to 250 ms; writes batched every 30 ms in one transaction; at most 300 listed,
  the rest counted in a note; `finish()` at the end of the parent's turn cancels whatever still runs.
  `parentToolCallId` is ignored and not stored: `Run` has no such field and the `runs` table no such
  column. A native run cannot be cancelled alone (`conflict`).
- Producer today: only `engine/fake.ts` `FakeSession.subagent()`, inside an executor's script
  (`execute()`): an "Explore" sub-agent with one text and one `grep` tool, with no tool call around it
  and no `parentToolCallId`. So the demo shows native children under executors in the tree.

### What the ACP engine does

- `engine/acp/mapper.ts` emits no `subagent` events and never sets `agentId`. It reads
  `_meta.claudeCode.toolName` (for names) and `_meta["_claude/rateLimit"]` and nothing else of `_meta`.
- `engine/acp/session.ts` `talk()` drops every `session/update` whose `sessionId` is not the root's,
  and `clientCapabilities()` advertises no `subagents`.

### What Claude's adapter sends to Clowdy as it is (no opt-in)

Read in `~/.bun/install/cache/@agentclientprotocol/claude-agent-acp@0.107.0@@@1/dist/`:

- `native-subagents.js` `NativeSubagentRuntime`: `enabled = form !== undefined`, and the form comes from
  `acp-subagents.js` `subagentForm()`, which is undefined without `clientCapabilities.subagents`. When
  disabled, routing returns every notification unchanged (`if (!this.enabled) return notification`),
  so a sub-agent's tool calls arrive on the root session.
- `sdk-to-acp.js` `stampParentToolUseId()` puts `_meta.claudeCode.parentToolUseId` on updates that come
  from a sub-agent.
- `v1/acp-agent.js` around 1702: "Every other client gets the streamed subagent text, like upstream."
  So a sub-agent's text also arrives as `agent_message_chunk` on the root session, tagged the same way.
- The `Agent` (or `Task`) call itself is an ordinary `tool_call` with `_meta.claudeCode.toolName`, its
  `rawInput` `{ description, prompt, subagent_type }`, and the final report as its result (inferred,
  matches `../../acp/research/agents-and-adapters.md`).

Consequence in Clowdy (inferred, not observed): the `Agent` call is a `ToolCard` "Agent" with the
description as its chip, and each of the sub-agent's tool calls and messages becomes a top-level item
of the orchestrator's stream (a new `messageId` closes the open message and starts another).

### With the opt-in (`clientCapabilities.subagents: {}`)

- Claude ("RFD form"): children are announced with `subagent_update` and their traffic arrives under
  the child's own `sessionId`. The `Agent`/`Task` tool call is hidden until its final update and then
  replaced by `session_message` updates: the parent's outgoing message (`messageId` = the tool use id,
  `recipientMessageId`) and the child's reply (`launchReply`). See `native-subagents.js` `routeRfdLaunch()`
  (around 1077) and `linkedSessionMessages()` (around 1565). So opting in removes the very tool call the
  plan wants to draw as a card; the link to it survives only as `session_message.messageId`.
- The standard `SubagentUpdate` (SDK 2.7.0, `schema/v1/schema.unstable.json`) has `sessionId`, `title`,
  `description`, `state`, `capabilities`, `cwd`, `additionalDirectories`, `_meta`, and no parent tool
  call field.
- Codex 2.6.0: without the opt-in only its collaboration calls show (`spawnAgent`, `wait`, `sendInput`,
  `closeAgent`), child traffic stays hidden (prior research); with it, `subagent_update` and child
  sessions (`dist/index.js` around 33332 and 33724).

### Switches and limits

- `engine/acp/catalog.ts`, Claude: setting `subagents` (default on; off adds `Agent`, `Task`, `ListAgents`
  to `_meta.claudeCode.options.disallowedTools`), environment `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3`
  and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20`. Codex has no switch in the catalog.
- Background sub-agents: Claude's adapter can hold a turn open for them (`deferredSettle`), while Clowdy
  ends the process with the turn and `NativeAgents.finish()` cancels the children. Open since the ACP
  research.

## Does the prompt tell agents to delegate through `run_spawn`?

- `apps/daemon/src/runs/prompts.ts` `systemPrompt()`: role intro, mode and project facts; nothing on
  delegation. `skillPrompt()` inlines the role's entry skill into the system prompt.
- `packages/system-skills/skills/orchestrate/SKILL.md` step 4 "Fan out": three choices, yourself; an
  engine sub-agent (Claude's Agent tool) "for read-only research and file-disjoint edits whose result
  only you need"; or `run_spawn` for "a coarse piece worth its own task-bound agent". Its section on
  limits: "use sub-agents for small read-only work". `references/fan-out.md` has the table and rules of
  thumb ("research and review are sub-agents; implementation of a task is a `run_spawn`; independent
  verification is a `run_spawn` verifier").
- `skills/executor/SKILL.md` "Sub-agents inside your task": engine sub-agents for read-only exploration
  or file-disjoint edits in its own scope; never `run_spawn`.
- So the plan's Stage 6 item ("delegate real work through `run_spawn`, own sub-agents only for small
  read-only lookups") is mostly met through the skill, which also allows small edits in sub-agents.
  The item is still unchecked.

## Where sub-agent cards hook in

- **Recognising the call.** Tool names: `Agent`, `Task` (Claude), `spawnAgent` (Codex), `spawn_subagent`,
  and `run_spawn` (Clowdy). The card goes into `stream/StreamView.tsx` `renderItem()` beside `ToolCard`,
  with a case in `stream/toolView.ts` or a dedicated component; it should show the name or description,
  the prompt, the state and the final report.
- **`run_spawn` card → child run.** The practical link is the `runId` in the tool's output (a JSON object
  from the fake engine, most likely JSON text from the real adapters; not observed). The run is then in
  `useProjectState().runs` (snapshot plus `run.upserted`), so the card can show its live status
  (`RunStatusPill`) and open it (`ui.openRun` / `AgentChip`). The daemon cannot stamp the ACP tool call
  id on the run, because the MCP call does not carry it.
- **Native child under its card, without the opt-in (Claude).** In `UpdateMapper`, read
  `_meta.claudeCode.parentToolUseId` on `tool_call`, `tool_call_update` and `agent_message_chunk`; tag
  those events with `agentId = parentToolUseId` instead of writing them to the parent; emit
  `subagent { agentId, parentToolCallId: parentToolUseId, state: 'running' }` on first sight and
  `done`/`error` when the `Agent` call completes. `NativeAgents` then builds the child run as it does for
  the fake engine. Store the tool call id on the run (protocol `Run`, a migration, `RunService.createNative`,
  `db/runs.ts`) so the app finds the child of a card and renders `useRunStream(child.id)` inside it.
  This path uses no unstable part of ACP.
- **With the opt-in.** `AcpSession` must accept child session ids (one `UpdateMapper` per child), map
  `subagent_update`, and turn `session_message` back into the card; `NativeAgents` must stop cancelling
  idle children at the end of the turn (plan Stage 6 lists all of this).
- **Tree.** Once cards exist, the plan wants native runs out of the tree: filter `origin === 'native'`
  in `buildRunTree()` or `agentRows()` (desktop `AGENTS.md` already says "listed like other runs until
  they get cards on their tool calls").
- **Demo data.** `apps/desktop/src/renderer/daemon/fixtureData.ts` has spawned children (`r-ex-07`,
  `r-ex-08`, `r-ex-09` under `r-orch-1`, `r-ver-02` under `r-ex-07`) but no native runs and no `Agent`
  or `run_spawn` tool items: the orchestrator streams use `create_task` and notes ("2 executors started").
  A card feature should add a `run_spawn` item whose output names `r-ex-07` and an `Agent` item with a
  native child. The fake engine's sub-agent should get a wrapping `Agent` tool call and a
  `parentToolCallId`.

## Tests to extend

- Daemon: `test/native.test.ts`, `test/orchestration.test.ts`, `test/wake.test.ts`, `test/tools.test.ts`,
  `test/fake-engine.test.ts`, `test/acp-mapper.test.ts`, `test/acp-session.test.ts`; `test/fake-acp-agent.ts`
  (its `tool <name> <json>` directive emits plain tool calls; it has nothing for `parentToolUseId` yet).
- Desktop: `stream/ToolCard.test.tsx`, `stream/toolView.test.ts`, `stream/StreamView.test.tsx`,
  `features/agents/agentTree.test.ts`, `stores/runTree.test.ts`, `features/agents/Screen.test.tsx`.

## Sources

- Source at `61ea92a`: the files named above.
- Pinned adapters in the Bun cache (paths above): read, not run.
- `../../acp/plan.md` Decisions and Stage 6; `../../acp/research/agents-and-adapters.md`, `clowdy-mapping.md`.
