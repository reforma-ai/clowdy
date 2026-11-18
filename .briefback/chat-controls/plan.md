# Chat controls: queue and steer, sub-agent cards, compaction

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record landed commits under the stage they implement.

**Goal:** a message typed while the agent works waits in a visible queue or steers the running turn, chosen by a setting; nested work (Clowdy's `run_spawn` children and an agent's own sub-agents) shows as cards in the chat; compaction reads as its own line and can be asked for while the agent works.

**Research:** `research/index.md` (Clowdy today and the Reforma reference).

**Decisions** (owner: "decide everything yourself, I review on top of a working result")

- **The queue belongs to the daemon and is stored on the chat.** `Chat.queue: QueuedMessage[]` (steers first, then next turns) and `Chat.queuePaused?: 'stopped' | 'failed'`, a JSON column on `chats` (new migration), published with the chat like every other field. Reforma keeps it in memory; Clowdy has SQLite, so it survives a restart.
- **`chat.send` gains `mode?: 'steer' | 'queue'`.** A chat at rest (no orchestrator, terminal, or `waiting_children`) sends at once as today, whatever the mode. A busy orchestrator (any other status) puts the message in the queue with its mode. The person's bubble is written to the stream only when the agent gets the message, so it no longer lands in the middle of the answer it did not cause.
- **Draining.** When the orchestrator comes to rest, the head of the queue becomes the next turn (one item per turn, steers first), unless the queue is paused. Stop pauses it (`stopped`), a failed turn pauses it (`failed`); a paused queue waits until the person presses Send now on an item. A message sent to a chat at rest while the queue is paused goes out at once and leaves the pause.
- **Steering.** An engine session may implement `steer(text)`, answering whether the agent took it. The ACP engine steers through `_session/steering` (`idleBehavior: 'promptRequired'`) when `initialize` advertised `_meta.steering.supported` (both pinned adapters do) and a prompt is in flight. A taken steer leaves the queue and its bubble is written at that moment, closing the open assistant message so the rest of the answer follows the bubble. A steer the agent could not take stays in the queue as a steer and becomes the next turn ahead of the queued ones (Reforma's `settleQueue`).
- **The joined-inbox path goes.** `EngineSession.send`, `RunDriver.deliver` and `LiveRun.pending` existed only for messages to a busy run; the queue replaces them. This also ends the bug where a message sent while a compact turn starts was joined into the `/compact` prompt.
- **Setting:** a preference on this computer, "Enter while the agent works": steer the current turn (default) or queue for the next turn. Cmd/Ctrl+Enter does the other. Stored like the other desktop preferences (`stores/storage.ts`), on a new Settings page "Chat" under General. The composer sends `mode` with every message, so the daemon needs no default.
- **Queue UI is Reforma's** (`ChatComposerQueue`): rows inside the composer above the input, two-line preview, `Steering…` status, actions Send now (steer while busy, send while idle), Edit (the text goes back into the composer and the item leaves the queue), Remove; head row shows actions at rest, others on hover; drag reorder inside a section; the paused note. Placeholder `Queue another message…` while busy. Reforma's edit lock is not ported: Edit takes the item out instead.
- **Sub-agents, two kinds, as the ACP plan decided.** `run_spawn` children are cards that link to their child run (live status, latest activity, open on press). An agent's own sub-agent (`Agent`, `Task`, `spawnAgent`, `spawn_subagent`) is a card on its tool call in Reforma's look (loader and verb while it runs, one live activity line, `Ran <name> agent` after), opening the native child run when there is one. Native runs leave the Agents tree.
- **Native children over ACP without the unstable opt-in.** Claude's adapter tags a sub-agent's updates with `_meta.claudeCode.parentToolUseId`; the mapper routes those to `agentId = parentToolUseId`, announces the child with `parentToolCallId`, and ends it when the parent's call completes. `Run.parentToolCallId` is stored (migration) so a card finds its child. Agents that report nothing keep the plain card.
- **Running children strip.** Above the composer, one row per running child of the chat (spawned or native) with its activity and Stop where the run can be stopped, as Reforma's `ChatComposerSubagents`.
- **Compaction line.** The mapper names an agent's compaction call `compact` (Claude's `toolName`, or the title `Compact conversation` that Codex uses), and the stream draws it as one line: a shimmer `Compacting context` while it runs, then `Context compacted` with `22K → 6K` when the agent reports the counts. Compact pressed while the agent works joins the queue as a compact item instead of being refused. A run that failed because the context overflowed keeps that reason so the chat offers Compact.
- **No new dependency.** `SortableList`, `Shimmer`, `Scrollable`, icons are already in the repo.

## Out of scope

Auto-compaction by Clowdy (the agents compact themselves), Reforma's edit lock, ACP's unstable `subagents` opt-in and child sessions, background sub-agents, steering a child run, cross-window preference sync.

## Stage 1 — Queue and steer

**Depends on:** None.

- [ ] Complete
  - [ ] Protocol: `QueuedMessage`, `Chat.queue`, `Chat.queuePaused`, `chat.send.mode`, queue commands (remove, move, send now)
  - [ ] Daemon: queue on the chat (migration), enqueue for a busy orchestrator, drain at rest, pause on Stop and failure, send now
  - [ ] Engine: `steer` on the session; ACP over `_session/steering`; the joined inbox, `deliver` and `pending` removed; the fake ACP agent and the fake engine learn steering
  - [ ] Desktop: queue rows in the composer, Send now / Edit / Remove / drag, paused note, busy placeholder, Enter and Cmd+Enter by the setting, Settings page "Chat", fixture daemon queues
  - [ ] Tests: daemon queue, drain, pause, steer and fallback; desktop composer routing and queue rows

**Done when:** a message sent while the agent works shows in the queue, goes out as the next turn when the agent finishes, or steers the running turn and shows its bubble where the agent took it.
**Verify:** `bun test` in `apps/daemon`; `bun run test`, `bun run typecheck`, `bun run lint` in `apps/desktop` and `packages/protocol`
**Commits:** None yet.

## Stage 2 — Sub-agent cards

**Depends on:** None (parallel with Stage 1).

- [ ] Complete
  - [ ] Daemon: `Run.parentToolCallId` (migration); the ACP mapper routes Claude's `parentToolUseId` traffic to native children; the fake engine wraps its sub-agent in an `Agent` call
  - [ ] Desktop: the sub-agent card for native calls and the `run_spawn` card for spawned children, both opening the child run; native runs out of the Agents tree; the running children strip above the composer; fixture data with both kinds
  - [ ] Tests: mapper routing, native child with its tool call id, card states and activity copy, tree filter

**Done when:** a `run_spawn` call and a native sub-agent call each read as a card with live status and open their child run, and native children are not tree nodes.
**Verify:** as Stage 1
**Commits:** None yet.

## Stage 3 — Compaction

**Depends on:** Stage 1 (compact joins the queue).

- [ ] Complete
  - [ ] The mapper names compaction calls `compact`; the stream draws the compaction line with counts
  - [ ] Compact while busy queues a compact item; the queue row reads `Compact the conversation`
  - [ ] A context overflow keeps its reason and the failed chat offers Compact
  - [ ] Tests

**Done when:** a compaction reads as one line with its result, and Compact works while the agent is busy.
**Verify:** as Stage 1
**Commits:** None yet.
