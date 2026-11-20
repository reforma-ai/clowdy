# bb threads: how the parent is notified

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19), read only, not run. Paths are relative to the bb repo root; everything under `apps/server/src/services/threads/` is shortened to `threads/`.

## Summary

- bb sends **one notification per turn end of the child**, to the parent, as a queued **system message**. It does not wait until the child has nothing running. This is the intended design: tests pin it ("does not repeat a previous result for later turns without output", `apps/server/test/threads/child-completion-turn-output.test.ts:160-180`).
- The only de-duplication is a **2-second window per parent**: outcomes of the same child inside the window replace each other (latest wins), outcomes of different children are listed together. Two stops more than 2 s apart are two notifications. That is what the owner saw.
- Nothing marks a notification as read. `wait` and `output` do not consume it. The parent cannot answer "I read it". It can only silence **future** ones (`bb thread update <child> --parent-notifications stuck|off`).
- The card "<thread> finished" in the owner's screenshot is the timeline rendering of that system message (kind `child-completed`).

## The pipeline, step by step

1. **The bridge reports a turn end.** The provider bridge sends `turn/completed` with a status `completed`, `failed` or `interrupted`; the server handles it in `apps/server/src/internal/events.ts:412-474`. The lifecycle machine may *hold* the completion while a steer or new-turn request is unanswered (`threads/lifecycle/machine.ts:379-...`, `releaseHeld`), then releases it.
2. **`planTurnEnd`** (`threads/turn-end-follow-ups.ts:301-362`) decides whether to notify. A parent notification is planned when the thread has a parent, is not a fork, and its `parentNotifications` policy allows the outcome (`threads/thread-parent.ts:12-32`): `auto` all outcomes; `stuck` everything except `completed`; `off` nothing.

   | Skipped when | Why |
   | --- | --- |
   | The turn was aimed by an earlier Stop (`isTurnAimedAtByEarlierStop`) | A stop does not report itself |
   | The interruption reason is `manual-stop` | Same |
   | The turn only compacted the context | Not work |
   | The failure was already reported by a command failure | Avoid a double |
   | `failed` was already reported for this child in the same batch of events | `failedParentNotificationThreadIds` set |

   **Not** skipped: a turn with no text, a turn started by the agent itself (background work finishing), a turn while background commands or agents are open.
3. **`queueChildThreadTurnNotificationBatchItem`** (`threads/child-thread-notifications.ts:427-481`). The parent must be live (not archived or deleted). The item holds the child's `terminalOutput` (for `completed` only: the text of the last **root-level** `agentMessage` of that turn, `threads/thread-data.ts:172-187`, `packages/db/src/data/events.ts:4141-4162`; sub-agent messages are excluded), the number of workflows still running (`listActiveBackgroundTaskCountsByThreadIds`), the status and an interruption cause.
4. **`postCoalescedSystemNotice`** (`threads/coalesced-system-notices.ts:41-117`) writes or updates **one queued row** for the parent with key `child-outcomes`: `waitingOn: time`, `sendAt = now + 2000 ms` (`CHILD_THREAD_TURN_NOTIFICATION_BATCH_DELAY_MS`, `child-thread-notifications.ts:91`), `deliveryMode: "steer"`, a `systemNotice` (kind and subject). If a pending row exists, the new item is merged: the same child and failure context replaces the older entry, a different child is appended (`mergeChildThreadTurnNotificationItem`, lines 402-425), and while the row is still `scheduled` its `sendAt` moves to now + 2 s again (`packages/db/src/data/queued-thread-messages.ts:889-940`, a `CASE` on state `scheduled`). A row that is already being sent is no longer merged, so the next outcome starts a new row.
5. **Dispatch.** A timer fires at `sendAt` (`requestQueuedMessageDispatchAt`, `threads/queued-message-dispatch.ts:215-229`) and the row goes through the normal dispatch checkpoint (`attemptAutomaticQueuedMessage`, mode `auto`; `threads/dispatch-attempt.ts:296-307,497-560`):

   | Parent is | What happens |
   | --- | --- |
   | Idle | A **new turn** starts with the notice as its user message (initiator `system`). Subject to the concurrency limit |
   | Active (mid-turn) | **Steered into the running turn** (`join-turn`). Claude: pushed into the SDK input stream. Codex: `turn/steer` with the turn id. ACP agents: the bridge **cancels the running prompt and re-prompts** (see `bb-protocol-split.md`) |
   | Stopping, awaiting a question or approval, host offline, workspace missing | The row waits with a typed reason and goes when it clears; later outcomes still merge into it (`QUEUED_MESSAGE_AUTOMATICALLY_DRAINABLE_STATES` = queued, scheduled, waiting) |
   | Itself a child | Same. Its own turn end then notifies **its** parent (chain) |
   | Manually stopped by the person | Notices are exempt from the "manual stop pauses the queue" rule (`queued-thread-messages.ts:1380-1391`, inferred: a stopped parent still gets woken) |

   A sweep also retries notices stuck on a busy parent (`listReadySystemNoticesOnBusyThreads`, `packages/db/src/data/queued-thread-messages.ts:1393-1412`).
6. **What the parent reads** (`threads/child-thread-notifications.ts:191-233`, templates `system-message-child-thread-outcome-batch.md`):

   ```text
   [bb system]

   @thread:thr_abc completed:

   <final text, at most 4000 characters, then "[... output truncated ...]">
   ```

   - No text: `No final output was recorded.`
   - With open workflows: ` completed, with 2 workflows still running:` plus "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes." Only **workflows** are counted; open background commands and agents are not mentioned.
   - Failed or interrupted: `@thread:thr_abc failed.` / `was interrupted because its host daemon restarted.` plus "Review the thread before deciding next steps."
   - Several children in the window: `Child thread updates:` and one line each, without the text.
7. **The card.** The queued row carries `systemNotice.kind` (`child-completed`, `child-failed`, `child-interrupted`, `child-outcome-batch`) and a subject (thread id and name, outcomes). The timeline draws the title `<thread name> finished|failed|was interrupted|N threads updated` with an icon, and the body as a collapsible preview (`apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx:222-258,340-360`, kinds in `packages/domain/src/system-message.ts`).

## Other messages to the parent

- **Needs attention** (a child waits on an approval, a question or a plugin form): sent **immediately**, not coalesced (`apps/server/src/services/interactions/pending-interaction-parent-notice.ts:96-130`, `child-thread-notifications.ts:502-528`). Text: "<thread> needs help. Blocked on <label>: <up to 4 lines, 700 chars>. Review the blocker. If you can resolve it from existing context, reply to the thread with guidance. Otherwise, ask the user." Policies `auto` and `stuck` both send it.
- **Ownership change**: when a thread is assigned to or removed from a parent (`threads/thread-ownership.ts`, templates `system-message-thread-ownership-*.md`).
- **Child failed to start**: reported as failed, including a provider that did not start the turn in 5 minutes (`bb-guide-threads.md:100-104`).

## De-duplication, acknowledgement, loops

| Question | Answer |
| --- | --- |
| Dedupe? | Only the 2 s window above, per parent, latest output per child. Nothing across windows. Nothing when the text is unchanged or empty |
| Can the parent say "I read it"? | No. `bb thread wait` returns only a status; `bb thread output` does not consume the notice. A parent that waited and read the output still gets the notice later |
| Can the parent stop the echo? | For later outcomes: `bb thread update <child> --parent-notifications stuck\|off`, or unassign (`--clear-parent-thread`). The UI has a "Notify parent" picker (`apps/app/src/components/secondary-panel/ThreadMetadataContent.tsx:190-210`) |
| Loop protection in code | Depth 4; forks never notify; manual stop and compaction-only are silent; a failure is reported once per batch. Nothing limits notification chains or tell ping-pong |
| Loop protection in text | The introduction says do not spawn or message without being asked, answer the parent in the final response, never send acknowledgements (`plugins/bb-guide/introduction.ts`); the `tell` wrapper `[bb message from thread:<id>]` deliberately has no "reply with" line (`agent-thread-message.md`, editing note) |
| Amplification | Every ancestor that is itself a child notifies its own parent at its turn end (inferred from the same rule); a leaf that stops often can cause a turn at each level. The `thread-list` rolls this up visually but does not limit it |

## Why the owner saw the same card several times

Each child turn end posts a notice. A child that stops, then stops again after a background task finished (an agent-started turn) or after a steer, is two stops. For Claude Code an agent-started turn follows each background task; for ACP agents the bridge opens an agent turn for updates that arrive outside a prompt and closes it after 5 s without updates (`bb-protocol-split.md`). Each closes with `turn/completed` and each notifies. If the text is the same or empty, the cards look identical.

## Tests that pin the behaviour

`apps/server/test/threads/child-completion-turn-output.test.ts` (one notice per turn, empty output notices, compaction silent, root message not nested output), `child-outcome-gaps.test.ts` (policy table `auto`/`stuck`/`off`, manual stop silent, stop around a turn, setup failures), `thread-parent.test.ts` (depth), `apps/server/test/services/interaction-parent-notifications.test.ts`.

## Assumptions and limits

- Not run. Timing (2 s window, trailing reset) is read from SQL and code, not observed.
- The lifecycle "held" completion path was read only for its shape.
- How Claude Code's agent-started turns open a bb turn (the translator) was not read; `activeWorkflowCount` text shows bb expects another report.
