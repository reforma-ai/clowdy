# Threads in Clowdy: what exists, what is missing, design options

Read from the worktree `/Users/bionic/WORK/My/@kachurun/clowdy-background-work` (branch `maksim-kachurin/background-work`, HEAD `1f23516` on 2026-11-19), not from the owner's checkout. The bb side is in the other pages of this folder. Line numbers are of that HEAD.

## Summary

- Clowdy already has most **parts** of bb's threads: a chat with its own agent, a parent that parks and is woken by a mailbox, a chat queue with steers, sessions that outlive a turn, a tree in the sidebar. It lacks the **joins**: a child you can write to, a parent link between chats, a notice at every stop, and agent tools to message a chat.
- `run_spawn` children cannot simply grow into threads. Everything that makes a bb thread "a normal chat" (queue, composer, model, title, archive, context ring, attachments, drafts) is keyed by **`chatId`**, and the daemon's chat-only code paths switch on `run.chatId`. A child run that gets a chat **is** a chat.
- Recommended: **A**, a thread is a child **Chat** with `parentChatId` and its own root orchestrator run, reached through new `thread_*` tools. Reuse `Wakeups` and the mailbox idea for the "notify at every stop" rule, with the changes listed below.
- The feature is protocol independent in Clowdy too. Cursor (ACP v1) gets spawn, tell (queued, or stop-and-send), wait, output, notice and wake. It lacks only live steering and background reports, and has no clone-style fork.

## What Clowdy has that corresponds

| bb | Clowdy today | Where |
| --- | --- | --- |
| Thread (a chat with an agent) | `Chat` plus its orchestrator `Run` (`chat.orchestratorRunId`) | `packages/protocol/src/domain.ts:142-181,278-340` |
| `spawn` | `run_spawn`: needs **at least one task** (`taskIds` min 1), role `executor` or `verifier`, one-shot, ends with `report_result`; own process and session; any installed agent, model, cwd | `apps/daemon/src/runs/run-tools.ts:49-70`, `driver.ts:154-233` |
| Parent link | `Run.parentRunId`, `rootRunId`, `origin: 'spawned' \| 'native'`; chats have **no** parent link | `domain.ts:247-295` |
| Notice to the parent | `run_mailbox` row when a **spawned** child reaches a terminal status; `Wakeups` waits `wakeWindowMs` (10 s, `CLOWDY_WAKE_WINDOW_MS`) after the first one, then resumes the parent | `service.ts:266-270`, `db/runs.ts:283-285`, `wake.ts:18-71`, `config.ts:63` |
| What the parent is told | `wakeMessage`: per child name, state, reason, summary (about 2,000 characters each, 24 KB in all) | `reports.ts:49-80`, `driver.ts:647-662` (`compose`) |
| `wait` | `run_wait`: at most 60 s, session and slot held, marks the reported children as seen | `run-tools.ts:79-92` |
| `output`, `log` | `run_inspect` (summary plus the last 8 stream lines), `childReport` | `run-tools.ts:72-77` |
| `stop` | `run_cancel` (child and everything below it) and `run.cancel` from the UI | `run-tools.ts:94-108`, `commands/run.ts` |
| `tell` to a running chat | `ChatQueue`: a message to a busy orchestrator is a steer (`RunDriver.steer`) or a queued turn; stop-and-send for agents that cannot steer | `queue.ts:77`, `driver.ts:279-340`, `commands/chat.ts` (`send`) |
| Parent that waits | `waiting_children` (no slot, no process unless the session lingers) | `driver.ts:1074-1126` (`settle`), `transitions.ts` |
| Session that outlives a turn | `waiting_background`, `EngineSession.send`, `RunDriver.deliver` | `driver.ts:235-264,684-770` |
| Tree | Agents list: chats at depth 0, runs below the chat's orchestrator, folds per chat and run | `apps/desktop/src/renderer/features/agents/agentTree.ts:23`, `AgentList.tsx` |
| Strip above the composer | `RunningAgents`: running child runs, background count, Stop | `features/chats/RunningAgents.tsx` |
| Fork-ish | `features/chats/handoff.ts`: writes the conversation as a file for a new chat (client side) | `handoff.ts:1-80` |

Depth and caps today: `MAX_DEPTH = 2` (`driver.ts:31`, `depthOf + 2 > MAX_DEPTH` at line 172), `maxActiveChildren` 300, `maxChildren` 3000, `maxProcesses` 24, scheduler caps (8 running, per engine 6 Claude, 4 Codex) (`apps/daemon/AGENTS.md`, "Tools", "Scheduler and limits"). Executors and verifiers get no `run_*` tools (`tools.ts:14-20`).

## What is missing

| Gap | Evidence |
| --- | --- |
| A parent link between chats | `Chat` has no `parentChatId`; `chatOfRun` maps a run to the chat of its **root** run (`agentTree.ts:75`), so a run tree cannot cross chats |
| A child the person can write to | `RunDetail` is read only: "Nothing to type here", footer "Viewing agent work" (`features/agents/RunDetail.tsx:22,32`) |
| Agent-originated messages into a chat | Nothing: no tool, and `chat.send` is the person's path |
| A notice at **every** stop | The mailbox is written when a spawned run goes terminal, and `UNIQUE (run_id, child_run_id)` plus `INSERT OR IGNORE` means a child run that goes terminal a **second** time notifies nobody (`db/migrations.ts:165-172`, `db/runs.ts:283-285`) |
| A notice while the child's session lingers | A lingering child is `waiting_background`, an **active** status, so it never goes terminal between turns |
| Waking a parent that is not `waiting_children` | `wake()` returns unless the parent is `waiting_children` with pending rows (`wake.ts:64`); a `waiting_background` or finished parent is left alone |
| Nesting beyond executors | Settle and park logic is hard-wired to `role === 'orchestrator'` (`driver.ts:969,1101`) |
| A chat without tasks | `run_spawn` demands tasks and a role |
| Cascades and a count of threads | None; `chat.delete` refuses while any run is not terminal |

Not in this HEAD (the handoff draft says they exist on the branch): `stopItem`, `run.stopAgents`, `Run.canStopAlone`. A grep of `packages/protocol`, `apps/daemon/src` and `apps/desktop/src` finds none. Treat them as uncommitted work elsewhere until checked.

## Options

### A. A thread is a child Chat (recommended)

| Part | Change |
| --- | --- |
| Data and protocol | `Chat.parentChatId`, `Chat.notifyParent` (`auto\|stuck\|off`), later `Chat.sourceChatId` and `forkedAfterSeq`. New stream item `thread` (a notice card: chat id, title, outcome, text, open background titles) and an optional `from` on `user` items for a message another thread sent. Commands `chat.setParent` (detach and re-nest, the "take over" action) and `chat.setNotifyParent`. Migration: chat columns plus a `thread_notices` table (see below) |
| Daemon | New `runs/thread-tools.ts`: `thread_spawn`, `thread_tell`, `thread_wait`, `thread_output`, `thread_log`, `thread_list`, later `thread_fork`; registered for chat orchestrators in `toolsFor` (`tools.ts`), not for workers. `thread_spawn` creates the chat and its first message through the same path as `chat.send` (`commands/chat.ts`), inheriting engine, model, effort and mode from the parent unless named. The thread's orchestrator is a **root run** (`rootRunId = own id`), so `depthOf` is 0 and it keeps `run_spawn`; executors stay worker-only. Hook at the `done` of every orchestrator turn of a chat that has a parent (`RunDriver.onDone`/`settle`): write a notice, call `Wakeups.schedule(parentRunId)`. `settle` counts active thread children next to spawned ones. `Wakeups.wake` accepts `waiting_background` and (decision) at-rest parents. Archive and delete cascade over `parentChatId` |
| Desktop | `agentRows` nests child chats under their parent chat (depth, fold, status dot from the orchestrator run); `visibleChats` keeps roots at depth 0; chat header crumb "Thread of <parent>" with detach and notify picker; stream renderer for the `thread` card and the `from` label; `RunningAgents` may list active threads; archive and delete confirmations list the cascade. The chat page, composer, queue, model picker need **no change** |
| Notify at every stop and `Wakeups` | See "The notice rule" below |
| Depth cap | `MAX_DEPTH = 2` is about run nesting and stays: a thread is a root run, so it may start executors. Chat depth is a **new** cap (`maxThreadDepth`). bb allows 4 levels in total |
| Limits | New: `maxThreadDepth`, `maxThreads` (over the life of a chat) and `maxActiveThreads`, modelled on `maxChildren` and `maxActiveChildren`. Existing caps still hold: every thread turn takes a scheduler slot and an engine slot; sessions count toward `maxProcesses`; a parked parent holds nothing, so chains cannot starve the slots as long as `thread_wait` stays at 60 s |
| Risks | Wake cost multiplies up the chain (every ancestor turn is a quota-costing turn); waking a Cursor parent means a resumed session each time; a lingering session per thread is not capped by `maxProcesses`; a semi-manual thread that asks the person a question; migration numbers collide with the open background-work stages |
| Rough size | About 6 stages, similar to one of the background-work plans: contract and storage; spawn, notice and wake; tell, wait, output, log; desktop tree and cards; cascades and caps; fork |

### B. Grow `run_spawn` children into conversations

Make the spawned child run conversational (not ending at `report_result`), give it a composer, let it start children, wake the parent at every terminal.

| Part | Change and problem |
| --- | --- |
| Data | `Run` stays the unit. But a conversation needs a **queue, a model picker, a title, attachments, drafts, a context ring, archive, compact**, all keyed by chat (`Chat.queue`, `ChatQueue`, `composerDrafts`, `attachments.markSent(files, chatId, runId)`) |
| Daemon | `ChatQueue.onStatus` runs only for runs with a `chatId` (`service.ts:277`), titles read the chat (`runs/titles.ts:14`), `driver.ts:969` waits only for `run.chatId`. Giving the child a `chatId` makes it a chat (option A) with a worse name. Without one, those paths must be re-keyed by run |
| Desktop | `RunDetail` needs a composer, queue strip, model and mode pickers: a second chat page |
| Depth | `MAX_DEPTH` has to go up and executors get run tools, which loosens the guard for **all** spawned runs |
| Mailbox | Still `UNIQUE (run_id, child_run_id)`; needs the same change as A |
| Verdict | Smaller on paper (no new table of chats), but it re-implements the chat inside the run, or becomes A. Rejected |

### C. Hybrid: child Chat that is also a child Run

The thread's orchestrator gets `parentRunId` = the parent's orchestrator and `origin: 'thread'`. This reuses `isDescendant`, `run_wait`, `run_cancel`, the mailbox and the existing run rows.

| Problem | Evidence |
| --- | --- |
| `rootRunId` is inherited, so `chatOfRun` maps the thread's run to the **parent's** chat and the UI draws the thread twice (as a run row and as a chat row) | `service.ts:117-140`, `agentTree.ts:75` |
| `depthOf` counts it, so the thread cannot `run_spawn` unless depth is special-cased | `driver.ts:172` |
| `run_cancel` and `run.cancel` of the parent cascade to the subtree, but bb's rule (and the person's expectation of a chat) is that stopping a parent does **not** stop its threads | `run-tools.ts:94-108`, bb `docs/system-overview.md` |
| `countActiveSpawnedChildren` is tied to `origin === 'spawned'` | `db/runs.ts:148` |

Verdict: not worth the coupling. Take its one good idea (reuse of `Wakeups` and the mailbox shape) into A.

## The notice rule inside `Wakeups`

Write a **thread notice** when the orchestrator of a thread ends a turn (its `done`), whatever status it settles into (`succeeded`, `waiting_background`, `waiting_children`). One row per stop is wasteful, so:

- Store rows in a new `thread_notices` table (parent chat, child chat, outcome, final text, open background titles, created and delivered times) with a partial unique index on `(parent_chat_id, child_chat_id) WHERE delivered_at IS NULL`. A stop **replaces** a pending row for the same child (latest text wins), the same merge bb does in its 2 s window (`bb-parent-notifications.md`). Separate table, not a change to `run_mailbox`, so existing `run_spawn` behaviour is untouched.
- `Wakeups.schedule(parentRunId)` is called after each insert. The window is a **leading** 10 s window per parent (bb's is a trailing 2 s debounce), which already merges bursts.
- `Wakeups.wake` today needs `waiting_children` and pending mailbox rows. Needed: also `waiting_background` (the parent is idle in a lingering session; `launch` then hands the message to the live session through `deliver` and `EngineSession.send`), and the notice rows count like mailbox rows. For a parent that is at rest (`succeeded`) the existing rule is "left alone until the person writes" (`wake.ts:12-13`); bb wakes it. Decision for the owner.
- A running parent is not steered. Its turn end reads the pending notices in `settle`/`compose` (the same way it reads the mailbox, `driver.ts:1101-1112`). This avoids bb's behaviour of interrupting an ACP parent mid-prompt.
- `compose` adds a block per thread: "Thread <title> (<chat id>) stopped: <text, up to the cap>", "Still open: <background titles>" when the thread's session lingers, and the instruction not to restart or acknowledge. The `thread` card is written to the parent's stream when the notice is **delivered**, once per batch (as bb draws one card per delivered message), not per stop.
- `thread_wait` and `thread_output` mark pending notices of that child delivered, as `run_wait` does (`run-tools.ts:88`). This is the fix for the duplicate the owner saw: a parent that already read the answer is not told again. bb has no such rule.
- A stop with no assistant text and no tool call is **not** noted (bb notes it as "No final output was recorded"; a flaky agent makes that noise). A stop that failed, was cancelled by the person, or ended in `waiting_user` follows the `notifyParent` policy.

## Protocol check for Clowdy's three agents

| | Claude Code (ACP v2) | Codex (ACP v1, steering extension) | Cursor (ACP v1) |
| --- | --- | --- | --- |
| Tools reach the agent | Tool bridge (MCP) | same | same (the bridge is per agent; confirm with `bun run probe cursor`) |
| Turn end event | `done` after `idle`, also for agent-started turns | `done` at prompt end | `done` at prompt end |
| `thread_tell` to a running thread | Steer | Steer through `_session/steering` | Waits for the turn's end, or stop-and-send (`canSteer === false`) |
| Thread session after a turn | May linger with background work (`waiting_background`) | Ends | Ends |
| Notices per thread | One per turn plus one per agent-started report turn: most prone to duplicates | One per turn | One per turn: least prone |
| Wake of a parked parent | New session that resumes, or `send` into a lingering one | New session that resumes | New session that resumes: depends on the agent's `session/resume` or `load` |

## What I could not verify

- No bb or Clowdy code was run. Nothing was tested against Cursor in either system.
- `thread_*` tools reaching Cursor through the tool bridge is read from `apps/daemon/AGENTS.md` ("opens a session with the tool bridge"), not exercised with a model.
- The Clowdy desktop rows (`AgentList.tsx`, `RunningAgents.tsx`) were read for structure, not for every state.
- `packages/system-skills` (`clowdy:orchestrate`) was not read; it must teach the new tools.
- Sizes are estimates from the shape of the background-work plan, not measured.
