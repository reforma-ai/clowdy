# Reforma reference: queue and steer

Reference repo: `/Users/bionic/WORK/Reforma/reforma` (read-only). All paths below are relative to it.

## Summary

Reforma keeps one ordered input list per thread on the server (the sandbox `ThreadSession`), in memory
only. Each item is either a `steer` (handed to the running agent before its next model step) or a
`next-turn` (starts the next run when the current one completes). The front renders that list inside
the composer, sends add/patch/delete commands, and never decides by itself whether a run is busy: run
state and the queue both arrive in one per-thread snapshot. A steer the agent took is stored as a
`data-user-steer` part inside the live assistant message and rendered as an ordinary user bubble
between the reply before it and the reply after it.

There is **no setting** for the default behaviour. Enter while a run works always queues a next turn;
Cmd/Ctrl+Enter always queues a steer. The only `submitHotkey` switch (`'enter' | 'mod+enter'`) belongs
to the create-project prompt, not to chat.

The design decisions are written down in the original plan, still in git history:
`git show 56f9c0bd3:.briefback/composer-queue/plan.md` (and `research/index.md` next to it). Read its
"Decisions" list before porting; it is the product spec for this feature.

## What the user sees

### Composer while the agent works

- Placeholder switches to `Queue another message…` (`ChatComposerSession.tsx`, `FOLLOW_UP_WHILE_BUSY`).
  Idle placeholders: `Tell Reforma what you want…` (new chat), `What do you want to do next?` (follow-up).
- Send button (`ChatComposerSendButton` in `ChatComposerInput.tsx`):
  - busy and the input is empty: Stop button (spinner ring around `StopBold`, tooltip `Stop`);
  - busy and the input has text: Send button (`SendBold`), tooltip `Add to queue` + Enter hotkey;
  - editing a queued item: tooltip `Save`;
  - waiting for uploads before an auto-send: spinner button, tooltip `Cancel send`.
- Keys (`RichInput` `onSubmit(doc, origin)`; `origin.mod` means Cmd/Ctrl):
  - Enter: busy → add a `next-turn` item; idle → send a new turn.
  - Cmd/Ctrl+Enter: busy → add a `steer` item; idle → send a new turn.
  - While a queued item is open for editing, both only save it.
  - Escape while editing cancels the edit.
- The input clears at once on enqueue. If the server refuses, the draft comes back unless the user
  already typed something new (`ChatThreadComposer.stage()` / `restore()` / `discardStage()`).
- A send that has to wait for attachment uploads is remembered (`sendWhenReady`) and fires when the
  uploads finish, keeping its Enter vs Cmd+Enter choice.

### The queue list (`ChatComposerQueue`)

Placement: inside the composer surface, above the attachments and the input, below the composer
banners (credits, resume/retry, background jobs, running sub-agents). Order in `ChatComposer.tsx`:
banners → `ChatComposerSubagents` → surface { `ChatComposerQueue`, `ChatComposerQueueEditBar`,
`ChatComposerAttachments`, `ChatComposerInput` }. When an Ask/picker tool is pending, the whole surface
is replaced by that tool UI, so the queue is hidden.

- Container: `Scrollable vertical edgeFade`, max height 200px.
- Paused note above the list (`role="status"`, xs secondary text):
  - `Queue paused after Stop. Use Steer on a message to resume.`
  - `Queue paused: the reply failed. <error> Use Steer on a message to resume.`
- `SortableList` (`aria-label="Queued messages"`, `handle={false}` so the whole row drags, `gap="sm"`).
  Order is steers first, then next turns. `canDrop` keeps a drag inside its own mode section and
  forbids moving or targeting unconfirmed rows. The dropped order is held locally until the next server
  snapshot lands, so the list does not jump back.
- Row (`QueuedItemRow`), `--color-secondary-light` rounded squircle background:
  - Preview, clickable to edit: up to two lines of inline text with mention chips (`Chip` for
    files/layers/links, `Badge color="success"` for slash commands), a `Plan mode` badge, an `Editing`
    badge (tooltip `Open for editing. The queue waits for Save or Cancel.`) when another tab or a stale
    session holds the edit lock, and a files line (`Clip` icon + `1 file` / `N files`).
  - Fallback labels when there is no text: `N files`, `Attached files`, `Plan mode`, `Queued message`.
  - Status text `Steering…` while the item is a steer (waiting for the agent's next step) or while
    its "Send now" request is in flight.
  - Actions, `xs` `filling` `secondary` buttons: `Steer` (tooltip `Submit without interrupting the
    model`; hidden while the status shows), Edit (`EditPen` icon), Remove (`Trash` icon).
  - Only the head row shows its actions at rest; other rows reveal them on hover or focus-within, and
    always on touch (`@media (hover: none)`).
  - An add the server has not listed yet shows dimmed (opacity 0.55), with no actions and a
    `progress` cursor.
- The list hides completely while the user edits an item (`editingId` set).

### Editing a queued item

Clicking a row (or Edit) calls `thread.beginQueueEdit(id)`: the item opens in its own draft in the
composer and is locked on the server (`editing: true`), so the agent does not take it. A locked steer is
skipped; a locked head stops the queue. `ChatComposerQueueEditBar` replaces the list: `Editing queued
message` with `Cancel` (ghost) and `Save` (filled primary). Save sends the rebuilt message and
`editing: false`; saving an empty draft deletes the item. Cancel drops local changes and releases the
lock. Opening another item first saves the current one.

### A steer in the transcript

The agent stores a taken steer as a `data-user-steer` part on the live assistant message
(`UserSteerData = { message: ReformaUserUIMessage; takenAt?: number }`). The front splits that message
before rendering (`splitUserSteers` in `apps/front/src/runtime/chat/helpers/normalizeMessages.ts`):
reply segment before → the steer as a user row → reply segment after. Earlier segments get ids
`<messageId>~<n>` and only timing metadata (for the "Worked for" fold, each segment runs from the
previous steer's `takenAt` to the next one); the last segment keeps the real id and metadata, so the
live loader stays on it. `useChatThreadScroll` pins a newly landed steer row once, while the reader
follows the stream (`shouldPinSteer`).

## State model

### Types (`packages/types/src/sandbox/ai.ts`)

```ts
type ChatQueueItemMode = 'steer' | 'next-turn';

type ChatQueueItem = {
    id: string;                 // client-chosen; adding the same id twice is a no-op
    mode: ChatQueueItemMode;
    message: ReformaUserUIMessage; // ready-to-send user message
    runConfig?: ChatRunConfig;  // model, options, profile captured at queue time
    draft?: unknown;            // opaque composer state to reopen the item for editing
    editing: boolean;           // edit lock
    createdAt: number;
};
type ChatQueuePause = { reason: 'stopped' | 'failed'; error?: string };
type ChatQueueState = { items: ChatQueueItem[]; paused?: ChatQueuePause }; // steers first, then next turns
```

Commands: `POST /ai/threads/:id/queue` (add), `PATCH …/queue/:itemId` (`mode`, `message`, `draft`,
`editing`, `index` inside the mode section), `DELETE …/queue/:itemId`. Every change publishes the
thread snapshot `chat-thread:<threadId>` (`ChatThreadStateSnapshot`: `runId`, `queue`, title, todos,
plan, background jobs, `contextUsage`) over the WebSocket last-value sync channel. The front takes the
queue only from that snapshot, never from command responses (they can be older).

### Server lifecycle (`apps/sandbox/src/chat/threads/thread-session.ts`)

- `enqueueInput` puts the item at the end of its section (`placeQueuedInput`). The message is tagged at
  queue time like a sent one (prompt hooks, memory), and the payer is resolved then, so a refusal is
  answered when the user submits.
- `patchQueuedInput`: becoming a steer moves to the end of the steers; becoming a next turn moves to the
  head of the next turns; `index` places inside the section.
- `nextQueuedInput`: the head, unless the queue is paused or the head is locked.
- Steer delivery: `takeSteers()` removes every unlocked steer. It is called from `takeStepNotes`
  (`apps/sandbox/src/chat/agent/helpers/step-notes.ts`) before each model step. Each steer becomes a
  `data-user-steer` part plus a user message in that step's history. On the last allowed turn, or when
  a tool loop halts, tools are off and steers stay queued. Steers reach only the root agent; during a
  long tool call or a sub-agent run they wait for the step to end.
- A steer that arrives during the final text step gets one more phase of the same run
  (`apps/sandbox/src/chat/agent/agent.ts`, the `hasSteers` check before the Stop hook).
- Run end (`setLastRunStatus` → `settleQueue`): steers the run did not take become next turns, ahead
  of the rest. A failed run pauses the queue (`failed`); Stop pauses it (`stopped`, from
  `api/chat/chat-cancel.ts`). A paused queue never resumes on its own.
- Drain (`apps/sandbox/src/chat/threads/continue-thread.ts`, `drainThreadQueue` → `runQueuedInput`): on
  a completed run, and after every queue command, if the thread is idle, start the head as a new run.
  Out of credits pauses with an error. A turn that fails to start goes back to the head of a paused
  queue (`restoreQueuedInput`).
- While a run waits on an Ask or a tool approval, the queue waits too.
- Sub-agent threads have no queue (`Sub-agent threads have no queue`).

### Client runtime (`apps/front/src/runtime/chat/ChatThread.ts`)

- Observables: `queue` (from the snapshot), `pendingQueueItems` (optimistic adds, dimmed until the
  snapshot lists them or 3 s pass), `sendingQueueIds` (rows whose "Send now" is in flight), `runId`.
- Routing: `queuesInput = !awaitsUser && (isActive || hasLocalRequest)`. True → `enqueueDraft(draft,
  mode)`; false (idle, paused, waiting on an Ask or approval) → `sendFromDraft` as a normal turn. Text
  sent while the queue is paused goes out at once and does not clear the pause.
- `409 RUN_IN_FLIGHT` on a direct send (a run started meanwhile) turns the send into a queue add with
  the mode the user chose (`#queueRefusedSend`).
- `sendQueueItemNow(id)` ("Steer" button): while a server run works, patch the item to `steer`;
  otherwise send it at once as a new turn with `queueItemId`, which also clears a pause. If a local
  stream is still closing after Stop, wait up to 5 s, then refuse with `The last reply hasn't closed
  yet. Press Stop, then try Steer again.`
- `moveQueueItem`, `removeQueueItem`, `beginQueueEdit`, `saveQueueEdit`, `cancelQueueEdit` wrap the
  PATCH/DELETE commands. Edit state lives in `ChatThreadComposer.editingDraft` (`editingId`,
  `openEdit`, `closeEdit`); `queuedComposerDraft(item)` rebuilds a draft from `item.draft` or the message.
- Composer hook: `apps/front/src/editor/chat/composer/useComposerSend.ts` maps Enter/Cmd+Enter to
  `next-turn`/`steer`, handles the upload wait, the "replace reverted messages" confirm, and
  `sendOutOfBand(text)` (used by `/summarize`; queued as `next-turn` when busy).

Refusal copy shown as toasts: `This message is no longer in the queue.`, `The chat is still starting.
Send again in a moment.`, `Wait for attachments to finish uploading, then save.`, `The message could
not be queued. Try again.`, `An attachment did not upload. Remove it and try again.`

## Components, styles, dependencies

| Piece | Source | Notes |
| --- | --- | --- |
| `ChatComposerQueue`, `QueuedItemRow`, `QueuedMentionChip`, `ChatComposerQueueEditBar` | `apps/front/src/editor/chat/composer/ChatComposerQueue.tsx` | Reads `useOptionalThread()`; hidden for ephemeral (comment) composers. |
| Queue styles | `ChatComposer.module.css` (`.queue*`, `.queueEditBar`) | CSS modules + tokens: `--color-secondary-light`, `--color-secondary-muted-text`, `--spacing-*`, `--radius-sm` × `--squircle-radius-factor`, `corner-shape: superellipse(var(--squircle-value))`, `@ruleset typography-text-md/sm`, `--reforma-sortable-list-gap`. |
| UI kit | `@reforma/components` | `SortableList`, `Scrollable`, `Pressable`, `Badge`, `Chip`, `Button`, `Box`, `Text`, `Show`, `For`, `docToPlainText`, `mentionAttrsFromNode`. |
| Icons | `@reforma/icons/14`, `@reforma/icons/16` | Rows: `Clip`, `EditPen`, `Trash` (14). Send button: `SendBold`, `StopBold` (16). |
| Stories | `apps/front/src/editor/chat/composer/ChatComposer.stories.tsx` | `Queued`, `EditingQueued`. |

Clowdy already has `SortableList` (same props: `handle`, `canDrop`, `getTextValue`, `gap`,
`isFirst`/`isDragging` render args), `Scrollable`, `Pressable`, `Badge` (`Tag/Badge.tsx`), and icons
`14/clip.svg`, `14/edit-pen.svg`, `14/trash.svg`, `16/send-bold.svg`, `16/stop-bold.svg`.

## Tests worth porting as behaviour specs

- `apps/sandbox/src/specs/chat/chat-queue.test.ts`: ordering, repeated id, section moves, settle turns
  untaken steers into next turns, a failed run pauses while a plain cancel does not (Stop pauses
  explicitly in the cancel handler), locked head holds the queue,
  taking an item resumes a paused queue, restore at the head.
- `apps/sandbox/src/specs/chat/steer-flow.test.ts`: steer during the final text step continues the
  run; steer after a tool call goes to the next step; a taken steer replays the same way later.
- `apps/front/src/specs/runtime/chat-thread-queue.test.ts`: routing (idle / busy / paused / Ask),
  optimistic add and refusal restore, 409 fallback, Send now in each state, edit lock, Stop, one
  request at a time.
- `apps/front/src/editor/chat/composer/useComposerSend.test.tsx`: Enter queues a next turn, every
  Cmd+Enter queues a steer, input clears each time; Cmd+Enter only saves an open item.

## Agent-specific vs portable to an ACP client

Portable as is (pure client or orchestrator logic):

- The whole queue UI and its copy, the row actions, drag rules, optimistic rows, edit lock, paused
  note, and the Enter / Cmd+Enter split.
- The state model: one list per chat owned by the process that talks to the agent (in Clowdy, the
  daemon), steers ahead of next turns, `settleQueue` (untaken steers become the next turn), pause on
  Stop or failure, resume only through an explicit send of an item, drain on run completion.
- Routing by run state, the 409-style race fallback (a send that lost the race becomes a queue add),
  and the snapshot-only rule for queue state.

Reforma-agent-specific (needs an equivalent or a fallback in Clowdy):

- Real steer: Reforma injects steers in its own `prepareStep`, knows the exact step, records
  `takenAt`, and can add an extra phase. Over ACP, Clowdy only controls what it sends. Clowdy's ACP
  plan (`.briefback/acp/plan.md`, Stage 7) already says: steer through `_session/steering` when the
  adapter advertises `_meta.steering.supported`, otherwise queue as the next `session/prompt`, with a
  note when a steer falls back.
- Steer placement in the transcript: Reforma places the user bubble where the agent took it. Over ACP
  without a "taken" signal, the honest options are to show the steer bubble at the moment Clowdy hands
  it to the agent, or to keep it in the queue strip as `Steering…` until the agent's next output
  arrives. `splitUserSteers` itself is reusable if Clowdy records a steer marker in its own message
  model.
- Steer timing rules (last turn holds steers, root agent only, waits for a long tool call) come from
  Reforma's loop. With ACP they are whatever the adapter does.
- Tagging queued messages at queue time (hooks, memory) and payer checks are Reforma backend concerns.
