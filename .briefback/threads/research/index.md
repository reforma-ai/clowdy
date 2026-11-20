# Threads (bb) and how they map onto Clowdy: research index

## Question and scope

How does the open-source app `get-bb/bb` implement **threads** (a nested chat that an agent creates with `bb thread spawn|fork|tell|wait|output|log`, that the person can open and write to, and whose parent is notified every time it stops), and how would the same behaviour map onto Clowdy? The owner also wants to know, for a flaky ACP agent (Cursor), whether the protocol or only Clowdy's code is the problem.

Research only. No source file of either project was changed, run or installed.

## Summary

- A bb **thread is the chat**. One table, one parent column (`parent_thread_id`), opt-in at spawn (`--parent-self`). Nesting is allowed up to 4 levels in total. A fork is a separate relation, is not a child and never notifies.
- Agents use threads through a **shell command** (`bb`), taught by an injected introduction text and a skill. There is no MCP tool and no built-in tool. The introduction tells agents not to spawn or message threads unless the user asks.
- The parent gets **one system message per turn end of the child** (not only when the child has nothing running), through the normal message queue: a new turn if the parent is idle, a steer into the running turn if it is busy (an interrupt for ACP agents). Only a **2 s per-parent window** merges them (latest text per child). Nothing marks them read. This is by design and tested, and explains the duplicate "L1 completed" cards.
- `tell` returns at once (`sent` or `queued`), `wait` is a client poll of `status == idle` (blind to background work), `output` is the last root-level assistant message.
- **The feature is protocol independent**: the server needs only turn boundaries and text. The protocol changes three things: how `steer` works (Claude and Codex inject; ACP cancels and re-prompts), `fork` (Cursor: none; other ACP: tip only) and how many turn ends a thread produces (ACP: a 5 s quiet timer for updates outside a prompt).
- Clowdy has the parts (chat queue, steer, parked parent, `Wakeups`, lingering sessions, a tree) but not the joins. `run_spawn` children cannot grow into threads: the chat features are keyed by `chatId`.
- **Recommendation**: a thread is a child **Chat** (`parentChatId`, own root orchestrator run) with new `thread_*` tools and a `thread_notices` table woken through `Wakeups`, with per-child merge, no notice for empty stops, and `thread_wait`/`thread_output` marking notices read.
- `.briefback/threads/handoff.md` is updated with these findings.

## Pages

| Page | What it answers |
| --- | --- |
| [bb-data-model.md](bb-data-model.md) | Thread vs chat vs session vs run, parent and fork links, fork point and history copy, inheritance of provider, model, cwd, permissions, ids, persistence, archive and delete cascades |
| [bb-cli-surface.md](bb-cli-surface.md) | How an agent invokes threads (CLI, guide, skill), transport, every subcommand with arguments and output, exit codes, limits |
| [bb-parent-notifications.md](bb-parent-notifications.md) | When, what, how: the full pipeline from `turn/completed` to the card, the 2 s window, busy and idle parents, dedupe, loop protection |
| [bb-tell-wait-output.md](bb-tell-wait-output.md) | `tell` delivery and replies, `wait` with background work, stop and questions, `output`, `log` |
| [bb-ui.md](bb-ui.md) | Sidebar tree, collapse, status marks, opening a thread as a chat, parent chat cards, stop, archive, delete |
| [bb-protocol-split.md](bb-protocol-split.md) | What depends on the protocol (Claude SDK, Codex app-server, ACP) and what does not; what a flaky Cursor can do to bb's threads |
| [clowdy-mapping.md](clowdy-mapping.md) | What Clowdy has, what is missing, options A, B, C, the notice rule inside `Wakeups`, the protocol check for Claude, Codex and Cursor |
| [grill-questions.md](grill-questions.md) | 27 open decisions, each with a recommended answer and the evidence |

## Important sources

bb at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19 15:19 -08:00, MIT, shallow clone in the scratchpad, read only):

- `apps/server/src/services/threads/{child-thread-notifications,coalesced-system-notices,turn-end-follow-ups,thread-parent,parent-system-messages,thread-fork,thread-fork-history,thread-create,thread-archive,thread-send,queued-message-dispatch,dispatch-attempt}.ts`, `apps/server/src/internal/events.ts`
- `apps/cli/src/commands/thread/{spawn,fork,actions,wait,show}.ts`, `packages/sdk/src/areas/threads.ts`
- `plugins/bb-guide/{introduction.ts,server.ts,skills/bb-cli/SKILL.md}`, `packages/templates/src/templates/{bb-guide-thread*.md,agent-thread-message.md,system-message-*.md}`
- `packages/provider-bridge-acp/src/bridge/bridge.ts`, `plugins/provider-{claude-code,codex,acp}/`, `plugins/concurrency-limit/server.ts`
- `plugins/thread-list/`, `apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx`, `packages/db/src/schema.ts`, `packages/db/src/data/queued-thread-messages.ts`

Clowdy (worktree `clowdy-background-work`, HEAD `1f23516`): `apps/daemon/AGENTS.md`, `apps/daemon/src/runs/{run-tools,wake,driver,service,queue,reports,tools,transitions}.ts`, `apps/daemon/src/db/{runs,migrations}.ts`, `packages/protocol/src/domain.ts`, `apps/desktop/src/renderer/features/{agents,chats}/`. Earlier bb notes: `.briefback/acp/research/bb-source.md`, `.briefback/references.md`.

## Open questions research could not answer

- What Cursor actually does in bb threads (the owner is testing it). `bb-protocol-split.md` lists what to look for in bb's own `thread log`, `thread show` and `thread queue list`.
- How Claude Code's agent-started turns become bb turns (translator not read) and how Codex reports background work.
- Whether a parent blocked in `bb thread wait` can deadlock bb's concurrency limit (inferred from `plugins/concurrency-limit/server.ts:524-560`, not run).
- Whether `thread_*` tools reach Cursor through Clowdy's tool bridge in practice (`bun run probe cursor` would show it).
- Costs: one quota turn per wake at every level of a thread chain.

## Assumptions and coverage limits

- No bb code was run or installed. All behaviour is read from source; timings and orderings are inferred where marked.
- About a third of bb's ACP bridge was read (turns, steer, agent turns, handshake, fork); the Codex and Claude bridges only for handshake, fork, steer and task translation. The UI was read for tree, status marks, cards and the info panel; drag and drop, mobile and the composer were not.
- Remote hosts, authentication outside loopback, plugins other than `bb-guide`, `thread-list` and `concurrency-limit` were not read.
- Clowdy was read from the background-work worktree, not the owner's checkout. The draft handoff names `stopItem`, `run.stopAgents` and `Run.canStopAlone`; they are not in HEAD `1f23516`.
- Sizes and default numbers (depth 3, counts) are proposals, not measured.
