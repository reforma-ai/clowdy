# bb threads: tell, wait, output, log

Source: `get-bb/bb` at `9f4c15646d3d7d9320191d4a2cd76199471a1ddc` (2026-11-19), read only, not run. Paths are relative to the bb repo root; `threads/` means `apps/server/src/services/threads/`.

## Summary

- `tell` is one HTTP call that returns at once with `sent` or `queued`. It never waits for the target to answer. A reply exists only if the target runs `tell` back; a child's final answer comes to its parent as the notification (`bb-parent-notifications.md`).
- `wait` is a client loop that polls `thread.status` until it is `idle`. It knows nothing about background work, children of the thread, or whether the thread was stopped.
- `output` is a read of the last finished root-level assistant message of the latest turn. It does not wait.

## `tell`

Path: `apps/cli/src/commands/thread/actions.ts:547-612,732-775` builds `sdk.threads.send({ input, mode, senderThreadId })`.

| CLI `--mode` | Sent as | Idle target | Running target |
| --- | --- | --- | --- |
| `steer` (default) | `steer-if-active` | New turn | **Steered into the running turn** |
| `queue` | `queue-if-active` | New turn | A queued row waiting on `thread-busy`; sent when the turn ends |
| `auto` | `auto` | New turn | Steer |

- `senderThreadId` is `BB_THREAD_ID`, dropped when it equals the target (a self-tell is a plain message). The server checks only that the sender exists and is not deleted (`threads/thread-send.ts:303-320`). **No relation is required**: a child can tell its parent, a thread can tell a sibling or a nested thread, in any project.
- The target sees the text wrapped as `[bb message from thread:<sender id>]` and a blank line (`packages/templates/src/templates/agent-thread-message.md`, `thread-send.ts:322-359`). The template keeps only the sender; its editing note says reply instructions made agents acknowledge messages that needed no answer.
- Resolution on the server (`thread-send.ts:234-278`, `resolveSendMode`): idle goes to `start`, active goes to `steer`, `queue-if-active` on an active thread is refused here and becomes a queued row instead (`dispatch-attempt.ts:586-607`).
- Things that queue instead of sending (typed `waitingOn`): `thread-busy`, `turn-starting` (the message joins when `turn/started` arrives), `provisioning`, `host-offline`, `interaction` (the target is awaiting a question or approval: "tell then adds the message to the thread's queue and dispatches it once the interaction settles"), `stopping`, `time` (`--send-at`), a plugin hold. For a new turn on an idle thread the concurrency limit may hold it (`plugins/concurrency-limit/server.ts:524-560`); steers are never held.
- **What the sender gets back**: `delivery: "sent"` with `messageSequence` (the event sequence of the message in the target), or `delivery: "queued"` with the queued row (`id`, `waitingOn`, `sendAt`). Text: `Thread X steered` / `updated` / `message queued (<reason>); it dispatches when that clears`. The guide says a queued result is not a failure and must not be resent (`bb-guide-thread-messaging.md:28-42`).
- In the UI the sender's timeline shows a "Sent to <thread>" card and the target a "Message from <thread>" card (`apps/app/src/components/thread/timeline/GeneratedConversationMessage.tsx:276-330`).

How "steer" is carried out depends on the provider (details in `bb-protocol-split.md`): Claude pushes the text into the live SDK input stream; Codex calls `turn/steer` with the expected turn id; **ACP agents are interrupted**: the bridge queues the text, sends `session/cancel` and then a new `session/prompt` inside the same bb turn (`packages/provider-bridge-acp/src/bridge/bridge.ts:4275-4313,3142-3153,3274-3410`).

## `wait`

`apps/cli/src/commands/thread/wait.ts` and `packages/sdk/src/areas/threads.ts:1741-1810`.

- Default target: `--status idle`. The loop reads the thread every 250 ms (`DEFAULT_THREAD_WAIT_POLL_INTERVAL_MS`) until the status matches or 20 min pass (`DEFAULT_THREAD_WAIT_TIMEOUT_MS`).
- `--event <type>` instead long-polls the event log in 30 s slices.
- Exit codes: 2 timeout, 3 bad arguments, 4 "unreachable" (waiting for `idle` on a thread in `error` with no retry queued; a thread whose automatic retry is queued is still waited on). The timeout message says when a retry is pending.
- Output: `Thread X reached status idle.` Nothing about what the thread said.

| Situation | What `wait` does |
| --- | --- |
| The thread has open background commands, agents or workflows | Returns at the first `idle`. Background work is not part of `status` (`packages/domain/src/thread-status.ts`); counts are separate `activity` fields |
| The thread is stopped (by the person or by the parent's `stop`) | A stop settles to `idle` (`thread-lifecycle.ts:55-65`), so `wait` **succeeds**. The parent gets no notification for a manual stop |
| The thread asks the user a question or an approval | It stays `active`, so `wait` keeps waiting. The parent separately gets a "needs help" message and can answer with `bb thread interactions answer` |
| The thread fails | Status `error`: exit 4, unless a retry is queued |
| The thread has not started (`pending`, a scheduled first message) | Waits |
| The thread is itself running children | No link: `wait` returns when the thread itself is idle |

## `output`

`GET /threads/:id/output` (`apps/server/src/routes/threads/data.ts:333`) returns `getLatestTurnFinalOutput` (`threads/thread-data.ts:172-197`): the **text of the last `item/completed` of kind `agentMessage` with no parent tool call** (so no sub-agent text) in the **latest started root turn** (`packages/db/src/data/events.ts:4141-4162`). No text gives `null`, and the CLI prints `(no output)`.

- It does not wait and does not check that the turn finished. While a turn runs it returns the latest completed message of that turn (inferred from the query).
- It is the same text the notification carries, without the 4000-character cut.
- Nothing is marked read.

## `log`

`bb thread log` pages the event log (`--format json` events oldest first, default 100; `minimal` and `verbose` print user-message turns newest first, default 20, max 100; `--all`; `--message <seq>` with `--context`). The skill tells agents to search `bb thread log <id> --all` to see whether a thread ever received a message, since the default page may miss it (`bb-cli/SKILL.md:83-84`).

## Assumptions and limits

- The server route for send and the host command `turn.submit` were read only for their shape. Behaviour of a `steer` whose turn ended meanwhile is in `machine.ts` (`STEER_UNCONFIRMED_ERROR_CODE`, the steer is rejected with "The turn ended before the agent confirmed this steer") and was not traced further.
- Nothing was run against Cursor.
