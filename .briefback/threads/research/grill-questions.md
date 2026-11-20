# Threads: decisions for the grill, with recommended answers

Each answer is a recommendation from the research, with the evidence it rests on. The owner decides. Evidence pages: `bb-parent-notifications.md`, `bb-tell-wait-output.md`, `bb-data-model.md`, `bb-protocol-split.md`, `clowdy-mapping.md`.

## Shape

| # | Question | Recommended answer | Why |
| --- | --- | --- | --- |
| 1 | Is a thread a child chat or an upgraded child run? | **A child chat** (`Chat.parentChatId`, its own root orchestrator run) | Queue, composer, model, title, archive, attachments, context ring and the daemon's chat-only paths are keyed by `chatId`; a child run that gets one is a chat (`clowdy-mapping.md`, options B and C). bb also has one object, the thread, with a parent column (`bb-data-model.md`) |
| 2 | Who may create threads? | Chat orchestrators only (thread orchestrators too, so nesting works). Executors and verifiers stay worker-only | Keeps `MAX_DEPTH = 2` and "workers have no run tools" intact. bb's own text tells agents not to spawn unless asked (`plugins/bb-guide/introduction.ts`); put the same rule in `clowdy:orchestrate` |
| 3 | Do threads need a task? | No. `thread_spawn` takes a prompt, and optional task keys | `run_spawn` requires `taskIds` (min 1) (`run-tools.ts:49-57`); a free conversation needs none |
| 4 | Fork: clone the agent session or copy the transcript? | Copy the transcript into a new thread chat (the idea of `features/chats/handoff.ts`), anchored at a completed turn, later slice | bb clones the provider session and copies events (`bb-data-model.md`), but ACP fork is tip-only and **Cursor is `fork: "none"`**. A transcript fork works for every agent |

## The notice rule

| # | Question | Recommended answer | Why |
| --- | --- | --- | --- |
| 5 | One notice per stop, or coalesce? | One per stop, merged per child while the parent has not yet read it (latest text wins) | bb notifies at every turn end by design (`child-completion-turn-output.test.ts`) and merges only inside a 2 s window. The duplicates the owner saw come from repeated stops more than 2 s apart |
| 6 | Does reading the answer clear the notice? | Yes: `thread_wait` and `thread_output` mark pending notices of that child delivered | `run_wait` already does this (`run-tools.ts:88`). bb has no such rule, which is why a parent that waited still got the card later |
| 7 | Does an empty stop notify? | No (no assistant text and no tool call). Failures, cancels by others and questions follow the policy | bb sends "No final output was recorded" (tested), which is noise from a flaky agent. The owner described a stop as "ends its turn with text" |
| 8 | Do agent-started report turns (background finished) notify? | Yes, with the open background titles in the text, merged with the pending notice | bb says only workflows are open and "will report again" (`child-thread-notifications.ts:102-105`); Clowdy knows the full `Run.background` list |
| 9 | Per-thread policy? | `notifyParent`: `auto` (default), `stuck`, `off`, set by the parent in `thread_spawn` and by the person in the chat header | Same three values as bb (`thread-parent.ts:12-32`); the person needs a way to mute a chatty child |
| 10 | Wake the parent when it is running? | No steer. The turn end reads the notices | `wake.ts:12-13` is the current rule. In bb a notice **interrupts an ACP parent** (cancel and re-prompt, `bridge.ts:4275-4313`); Cursor cannot steer in Clowdy either |
| 11 | Wake the parent when it is at rest (`succeeded`)? | Yes for `auto`, through the same 10 s window; no for `stuck` completed outcomes | bb wakes an idle parent. Today Clowdy leaves a finished parent alone, so threads would otherwise be silent. Cost: one quota turn per window |
| 12 | Wake window | Keep 10 s | It is set on purpose per resume cost (`apps/daemon/AGENTS.md`, `CLOWDY_WAKE_WINDOW_MS`). bb's 2 s trailing debounce is a different design; the per-child merge matters more |
| 13 | Notice for a child that waits for the person (question, approval)? | Yes, immediately, not coalesced | bb does (`pending-interaction-parent-notice.ts`). Maps to `waiting_user` of the thread's run |

## Messages and waiting

| # | Question | Recommended answer | Why |
| --- | --- | --- | --- |
| 14 | `thread_tell` to a running thread | Steer when the agent can, else queue for its next turn (the chat queue), with `mode` `steer\|queue`; the target sees "Message from <thread>" | bb: steer into Claude and Codex, interrupt for ACP (`bb-tell-wait-output.md`). Clowdy has `ChatQueue`, stop-and-send and `canSteer` already |
| 15 | Who may tell whom? | Any thread of the same project, including the parent and siblings | bb checks no relation (`thread-send.ts:303-320`). Prompt rule: answer the parent in the final answer, never send acknowledgements (`bb-parent-notifications.md`) |
| 16 | `thread_wait` | At most 60 s per call, until the thread's next stop; returns state, text and open background; marks seen | Same as `run_wait`; a longer wait would hold a slot (bb waits up to 20 min and a waiting parent counts against its concurrency limit, inferred) |
| 17 | `thread_output` | Last turn's final text, bounded (4,000 characters like bb), plus state and open background | bb returns the last root-level assistant message only |
| 18 | Does a thread stop when its parent is stopped? | No | bb: Stop does not cascade (`docs/system-overview.md`). A thread is a chat the person may be talking to. Differs from `run_cancel`, which cascades |

## Limits and lifecycle

| # | Question | Recommended answer | Why |
| --- | --- | --- | --- |
| 19 | Depth | 3 levels in total (root, L1, L2) to start, as a setting | bb allows 4 (`thread-parent.ts:6`); each level multiplies wake turns. The owner's example mentions L1 and L2 |
| 20 | Counts | `maxThreads` per chat over its life and `maxActiveThreads`; copy the style of `maxChildren` (3000) and `maxActiveChildren` (300) with lower defaults | bb has none, so a spawn loop is unbounded there. Clowdy already guards `run_spawn` (`driver.ts:177-183`) |
| 21 | Sessions that linger | Cap the number of lingering thread sessions | They hold a process and do not count toward `maxProcesses` (`apps/daemon/AGENTS.md`); bb frees idle runtimes after 30 minutes |
| 22 | Archive and delete | Archive cascades to threads; delete cascades after a confirmation that lists them; unarchive does not restore children | bb: `thread-archive.ts`, `child-thread-confirmation.ts` |
| 23 | Detach | `chat.setParent null` ("take over"): the thread becomes a root chat, the parent stops being notified | bb's X on the Parent row (`ThreadDetailView.tsx:1067-1085`) |
| 24 | Inherited settings | Engine, model, effort and mode of the parent unless named; cwd is the project's main folder (no automatic worktree) | bb creates a worktree per child (`thread-default-policy.ts:368-520`); Clowdy has no git machinery (`Run.worktree` "not filled in") |
| 25 | A thread in semi-manual mode asks the person | The question card is in the thread; the parent gets the notice of question 13 | `ask_user` exists only in semi-manual chats (`tools.ts`) |

## Product text

| # | Question | Recommended answer | Why |
| --- | --- | --- | --- |
| 26 | Card wording | Title `<thread> finished` / `failed` / `was interrupted`; body the text, collapsed | The owner's second screenshot is bb's card (`GeneratedConversationMessage.tsx:222-258`). One phrase has no trailing period (`AGENTS.md`) |
| 27 | The flaky-ACP question | Record the owner's bb and Cursor result next to `bb-protocol-split.md`, section 4, before the plan | The code says the model is protocol independent, but a flaky agent adds empty, cancelled and agent-turn notices there |
