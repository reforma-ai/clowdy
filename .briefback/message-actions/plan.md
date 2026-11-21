# Message actions

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** every message in the chat has actions under it (copy, reply, edit a sent message, fork an answer into a new chat), the person can select text and reply with it, and an action is drawn only where the agent behind the chat can really do it.

**Approach:** The renderer gets one action row under user messages and final answers, a quote helper for the composer, and a selection toolbar (Stages 1, 2). The daemon records the provider's own message id at the end of every turn, learns to fork a provider session at such a point through ACP `session/fork` (Stage 3), and builds fork-into-new-chat (Stage 4) and edit-and-resend (Stage 5) on that single primitive. The renderer then wires Fork and an in-place Edit mode to the new commands (Stage 6). A final polish stage adds the quote card, swipe-to-reply and its setting (Stage 7). Research: `research/index.md`; BB (`get-bb/bb`, commit `4e45c9b`) is the behaviour reference, Orca is not.

**Decisions**

- No grill: the requirements are settled. An action is **drawn only when supported**; there is no disabled placeholder for an agent that cannot do it. The daemon marks stream items (`canFork` on an assistant answer, `canEdit` on a person's user message) and the renderer never guesses from the engine name.
- Under a **user** message: Copy message, Edit message, Reply. Under a **final answer** of a turn: Copy, Reply, Fork into new chat. Only the person's own messages (`user` items without `from`) and final answers of finished turns have a row; thread cards, notices, tool rows, notes, errors, anything inside a "Worked for" fold, and the read-only sub-agent run page have none. No `...` menu, no Copy link, no "Reply in side chat", no keyboard shortcuts.
- Row visibility: hidden until hover or focus-within, always visible on the last message that has a row, always visible where the pointer cannot hover (`@media (hover: none)`). The row reserves its height so revealing it never moves the list. The time sits in the row, appears with it, and replaces the permanent time on user bubbles. Format: time only (`22:54`) for today, `19 Nov, 22:54` for another day, `19 Nov 2025, 22:54` for another year; `<time>` carries the full date as `title`. A streaming turn has no answer row until it is done.
- Copy and whole-message Reply use the message's **source Markdown** (`body.text`), not the rendered DOM. A selection quotes the **rendered text** of the selection (`Selection.toString()`), and only when it lies inside one message.
- Quote format is BB's: `> ` before every line, a bare `>` for a blank line, blank lines between two quoted lines dropped, trimmed, appended at the end of the draft and followed by a blank line for the caret (so a reply typed below is not a lazy continuation of the quote), a blank line between stacked quotes, empty text ignored. The composer shows the `>` as plain text; no blockquote node.
- Selection toolbar: one floating **Reply** button next to the selection, nothing else. One set of document listeners for the whole list, reads batched in `requestAnimationFrame`; a press on the toolbar must not collapse the selection; it closes on Escape, scroll, resize or a collapsed selection.
- **Provider support.** Edit and Fork use ACP `session/fork` with the fork point in `_meta.jetbrains.air.fork` (`{ version: 1, messageId }`). It is an unstable method and a vendor extension read by both pinned adapters; the accepted risk is that an adapter bump can break it, so the check below is rerun on every bump and the catalog flag goes off if it fails. Claude Code (`claude-agent-acp@0.107.0`) cuts at an exact assistant message. Codex (`codex-acp@2.8.0`) rounds to the end of a turn, which is where Clowdy only ever forks, so it fits; its flag stays **off until a real check passes** (the pin cannot be launched on this machine before 2026-11-22). Every other agent has the flag off: no Fork, no Edit.
- **Rewind points are turn ends.** At the end of a turn the daemon stores the provider's `messageId` of the turn's final assistant message on that stream item (daemon-only column `stream_items.provider_ref`). Fork uses the clicked answer's point. Edit of the user message that starts turn N forks at the point of turn N-1; for the first message of the chat it starts a fresh session. Items from before this feature have no point, so old chats get no Fork and no Edit past their first message. No transcript-fingerprint fallback.
- A person's user message is editable only when it starts a turn: the first non-note item after a rewind point, or the first item of the chat. A steer inside a running turn is not editable.
- Fork **forks the provider first, then changes Clowdy**: a failed provider call leaves everything as it was. The fork is eager (a short adapter process: initialize, `session/fork`, close), the new session id is stored on the new chat's run, and the next message resumes it like any session.
- **Fork** creates a new chat in the same project with the same engine, model, effort and mode, titled `(n) <source title>` (`(1) foo`, then `(2) foo`), not a thread (`parentChatId` stays empty), no queue, zero usage, no child threads. History through the end of the turn is copied into the new chat's stream. The relation is `Chat.forkedFrom { chatId, atSeq }` (daemon columns `source_chat_id`, `forked_at_seq`), never `parentChatId`. A fork needs the turn to be finished; it does not need the source chat to be idle.
- The fork indicator is **a divider inside the message list** after the last copied item: `Forked from <source title>` with a link that opens the source chat (plain `Forked` when the source is gone). It stays for the life of the chat; there is no banner above the composer.
- **Edit** works only when the chat is at rest. While the run is busy (`running`, `waiting_user`, `waiting_background`) the Edit button is shown disabled with the hint `Stop the agent to edit`; the daemon refuses too. Order: fork the provider at the previous point (or clear the session for the first message), then in one transaction delete the stream items from the edited message on (with the child runs and attachments under them, keeping the attachments the edited message still uses), store the new session id, tell the renderer, and send the edited text as an ordinary new turn. Queued messages stay queued, child threads and tasks stay as they are, usage counters keep what was spent, files the agent changed are not reverted and the agent is not told.
- Edit UI is BB's: in place. The user's bubble is replaced by an `Editing message` frame with an X, holding a composer that is the bottom composer without what sits above it (running agents, the queue). Esc or X cancels, Enter sends. The message list and the bottom composer stay as they are until the edit commits. A failed edit keeps the editor open with its text and shows a toast. The edited text and the message's attachments are kept in an edit session of their own, not in the chat draft.
- Settings: `Chat` gets one row, `Swipe a message to reply` (default on), stored on this computer like `busyEnter`.
- Icons: Reply uses the existing `Revert` (curved arrow) and Fork the existing `Split`, both placeholders; the owner draws `Reply` and `Fork` in Figma later and `./clowdy sync icons` swaps them. Not a blocker.
- Work happens on branch `maksim-kachurin/message-actions` in the worktree `../clowdy-message-actions`; never in the main checkout. Each stage is its own commit; nothing is pushed.

**Reuse:** `CopyButton` and `copyWithFeedback` (`packages/components/src/CopyButton`), `Button` with `iconOnly` and `tooltip`, `Marker variant="separator"` (`packages/components/src/Marker`), `foldFinishedWork` (`stream/turns.ts`), `ComposerHandle` and the per-key `composerDrafts.ts` / `composerFiles.ts`, `clampMenuPosition` idea of `RichInput/RichInputTriggerMenu.tsx`, `busyEnter.ts` pattern for the setting, `conversationRecord`-era session plumbing in `engine/acp/v2.ts`, `ScriptEngine`, `FakeEngine` and `startHarness` (`apps/daemon/test/helpers.ts`), `deleteChatAndRuns` (`db/chats.ts`) for deleting a run's rows, `RunStream` (`stores/StreamStore.ts`), the fixture daemon (`daemon/fixtureTransport.ts`, `fixtureData.ts`).

## Out of scope

- "Reply in side chat", "Copy link", the timestamp inside a menu, any `...` menu, shortcuts for these actions.
- Reverting or warning about the files the agent changed in a dropped part; keeping the old branch of an edited chat; undo of an edit.
- Fork and Edit for agents other than Claude Code (and Codex once verified); fork or edit of chats from before Stage 3; a fingerprint fallback; in-place truncation through `resumeSessionAt` or Codex `thread/revert`; ACP session cursors.
- Editing steers, thread notices, thread messages and anything with `from`; editing while the agent works (stop first); child threads of a dropped part are not stopped or detached.
- Drawing the Reply and Fork icons in Figma; a banner "Forked from" above the composer; touch-device checks and Windows (hover and gesture behaviour is not run there).
- Follow-ups to note, not do: a dedicated daemon event for stream truncation consumers other than the renderer; a quote chip for partial selections.

## Stage 1 — Message action row

**Depends on:** None.

**This stage:** The row under messages and everything it needs to be right, with Copy as its only action. The row appears under the person's own messages and under the final answer of each finished turn, hidden until hover and always visible on the last one, with the hover time that replaces the bubble's permanent time. Later stages only add actions by passing handlers; this stage settles which messages get a row, where it sits and how it behaves. It exists first because every other renderer stage hangs off it.

- [x] Complete
  - [x] `foldFinishedWork` marks the final answer of a finished turn (the same `isAnswer` it already uses), exported for the stream
  - [x] `MessageActions` row: Copy (source Markdown, with the `CopyButton` feedback), the hover time, reserved height, hover and focus-within reveal, always visible on the last row and without hover
  - [x] `UserBubble` and `AssistantMessage` hand it their message; the permanent time on user bubbles is gone; `data-turn` still sits on the user row root
  - [x] Opt-in from `ChatView` through `StreamView`; `RunDetail`, `from` items, folded work and live turns get no row
  - [x] `formatMessageTime` (today, other day, other year) with tests
  - [x] Tests for which messages get a row, the last-row rule and the answer marker; a screenshot check of light and dark

**Files**

- `apps/desktop/src/renderer/stream/turns.ts` — `foldTurn`, `isAnswer`: mark the answer block
- `apps/desktop/src/renderer/stream/MessageActions.tsx` and `MessageActions.module.css` — create: shared by the user bubble and the assistant message, so it cannot live in either
- `apps/desktop/src/renderer/stream/StreamView.tsx` — `renderItem`: opt-in prop, last-row rule, rows under answers
- `apps/desktop/src/renderer/stream/UserBubble.tsx` and `.module.css`, `AssistantMessage.tsx` — drop the time, take the row
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — enable the row
- `apps/desktop/src/renderer/shared/time.ts` — `formatMessageTime`
- tests next to each (`StreamView.test.tsx`, `UserBubble.test.tsx`, `turns.test.ts`, `time` test)

**Done when:** a finished chat shows a hover-only row with Copy and the time under each of the person's messages and each final answer, the last one always visible, and nothing else in the app changed.
**Verify:** `cd apps/desktop && bun run test && bun run lint && bun run typecheck`, then `bun scripts/screenshot.ts` (see `apps/desktop/AGENTS.md`)
**Commits:**

- `160f9ad` feat(desktop): add an action row with copy and a hover time under messages. Review: the reveal uses `:has(:focus-visible)` so a mouse press does not pin the row open; a person's message in a live turn keeps its row (Edit needs it while the run is busy); a user bubble on the read-only run page has no time.


## Stage 2 — Reply and text selection

**Depends on:** Stage 1.

**This stage:** Reply puts a Markdown quote into the composer, from the row (the whole message) and from a floating button next to a selection. It adds the quote helper and a way for `ChatView` to hand text to the composer, the Reply button in the row, and the selection toolbar. The whole-message path is the plain `> text` insertion; Stage 7 may turn it into a card.

- [x] Complete
  - [x] `withQuoteLast` builds and appends a quote exactly as the decision says, with tests copied in spirit from BB's `prompt-draft.test.ts`
  - [x] `ComposerHandle.quote(text)`: appends to this chat's draft, focuses the end of the composer
  - [x] Reply in the row, for user messages and final answers
  - [x] `SelectionReply`: shared listeners, one-message rule, clamped fixed box, Escape/scroll/resize/collapse dismissal, focus and selection kept on press
  - [x] Messages carry the attribute the toolbar looks for; no toolbar in `RunDetail`, the composer or the find bar
  - [x] Tests for the quote helper, the composer handle and the toolbar's open and close rules

**Files**

- `apps/desktop/src/renderer/features/chats/composerDrafts.ts` — `withQuoteLast` next to `withTextFirst`
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — `ComposerHandle`: `quote`
- `apps/desktop/src/renderer/stream/SelectionReply.tsx` and `.module.css` — create: owns document-level selection tracking, which `StreamView` and `MessageActions` should not
- `apps/desktop/src/renderer/stream/MessageActions.tsx`, `StreamView.tsx`, `UserBubble.tsx`, `AssistantMessage.tsx` — Reply button, selection attribute, mount
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — wire `onReply` to the composer ref
- tests next to each

**Done when:** pressing Reply under a message, or on a selection inside one message, leaves `> quote` at the end of the composer draft with the caret below it.
**Verify:** `cd apps/desktop && bun run test && bun run lint && bun run typecheck`, then `bun scripts/screenshot.ts`
**Commits:**

- `b7aa67a` feat(desktop): reply to a message or a selection with a markdown quote. Beyond the plan: `actions` is one object prop (`{ show, onReply }`, later `onEdit`, `onFork`); button order is DOM order (person: time, Copy, Edit, Reply; answer: Copy, Reply, Fork, time). The quote is its own paragraph followed by an empty paragraph for the caret, so a typed reply is sent as `> quote\n\nreply` and is not a lazy continuation of the quote.


## Stage 3 — Rewind points and the engine fork

**Depends on:** None.

**This stage:** The daemon can cut a provider session at a turn end. It remembers the provider's message id at every turn end, knows which agents can fork, can fork a session at such a point, and tells the renderer which items offer Fork and Edit. No command or UI yet. This stage carries the one real risk of the feature (does the vendor `_meta` fork work end to end), so it ends with a check against the real Claude Code adapter.

- [x] Complete
  - [x] Migration 17: `stream_items.provider_ref` (daemon-only)
  - [x] The ACP mapper passes the provider `messageId` of assistant text up; the driver stamps the turn's final assistant item at turn completion and re-emits it
  - [x] Catalog flag `fork` per agent (Claude on, Codex off until verified, others off)
  - [x] `AgentEngine.fork`: `V2Layer` runs initialize, `session/fork` with `_meta.jetbrains.air.fork`, and returns the new session id (system prompt, additional directories and tool bridge as for a resume); `V1Layer` refuses; `FakeEngine`, `ScriptEngine` and the fake v2 ACP agent support it
  - [x] `StreamItem.canFork` and `StreamItem.canEdit` (optional booleans, set only when true) derived by the daemon from the engine flag, the point and the turn rule; protocol type, fixtures and `RunStream` accept them
  - [x] Real check: Claude Code on a scratch daemon (own data dir and port), a few short prompts, fork at a stored point, the fork answers from the cut history; Codex attempted, flag stays off unless it passes; results recorded in `research/real-checks.md`
  - [x] `apps/daemon/AGENTS.md` describes rewind points and the fork flag

**Files**

- `apps/daemon/src/db/migrations.ts` — migration 17; `db/items.ts` and `domain/items.ts` — `provider_ref`, flags in the item mapper
- `apps/daemon/src/engine/acp/mapper-v2.ts`, `mapper-core.ts`, `engine/types.ts` — `messageId` on the assistant event; `fork` on `AgentEngine`
- `apps/daemon/src/engine/acp/v2.ts`, `v1.ts`, `engine.ts`, `catalog.ts` — fork step, refusal, flag
- `apps/daemon/src/engine/fake.ts`, `apps/daemon/test/helpers.ts`, `test/fake-acp-agent-v2.ts` — fork support in test engines
- `apps/daemon/src/runs/driver.ts` — stamp at turn completion
- `packages/protocol/src/domain.ts` — `StreamItem.canFork`, `canEdit`; `apps/desktop/src/renderer/daemon/fixtureData.ts` — sample flags
- daemon tests for the mapper, the stamp, the flags and the v2 fork

**Done when:** a finished turn on a flagged agent has a stored rewind point and its answer reports `canFork`, `AgentEngine.fork` returns a new session id for it, and the real Claude Code check passes.
**Verify:** `cd apps/daemon && bun test && bun run lint && bun run typecheck`; `cd packages/protocol && bun run test`; the real check described in `research/real-checks.md`
**Commits:**

- `8ac5c1e` feat(daemon): record rewind points at turn ends and fork a provider session. Real check passed for Claude Code (`claude-agent-acp@0.107.0`, `claude` 2.1.312): stored points are real `msg_` ids, a fork at turn 1 forgets turn 2, a fork at turn 2 keeps a tool call with its result, a fork takes 0.6 to 1.2 s. Codex could not be launched (`minimumReleaseAge` until 2026-11-22), so its flag stays off: rerun the check on or after that date, then turn the flag on in `catalog.ts`. Flags are derived on read and publish, never stored, so a flag switched off removes Fork and Edit at once. After a compact turn the next user message is not editable. `FakeEngine` is flagged on by default (dev and `?fixtures` reach Fork and Edit); `ScriptEngine` is off by default.


## Stage 4 — Fork into a new chat (daemon)

**Depends on:** Stage 3.

**This stage:** `chat.fork` creates the new chat from an answer's rewind point: provider fork first, then chat row, orchestrator run with the forked session, copied history and the relation. The fixture daemon implements the same command so the renderer can be built and tested against it.

- [x] Complete
  - [x] Migration 18: `chats.source_chat_id`, `chats.forked_at_seq`; `Chat.forkedFrom` in the protocol, upsert and event
  - [x] `chat.fork { chatId, itemId }` → `{ chat }`; refusals for an item without `canFork`, a missing chat, an unflagged agent, a failed provider fork (nothing created)
  - [x] New chat: same project, engine, model, effort and mode, title `(n) <title>`, not a thread, zero usage, at-rest orchestrator run holding the forked session id
  - [x] Stream items through the turn end copied with new ids; attachments of copied items usable in the new chat; the first message of the fork carries no first-message prefix
  - [x] Fixture daemon implements `chat.fork`
  - [x] Daemon tests with `ScriptEngine` for the copy, title numbering, refusals and the first message of a fork
  - [x] Cost baseline of a forked session: the first prompt in a fork reports tokens but no `costUsd` (no baseline for the new session id); log the first-prompt cumulative cost in the real check, and if it equals that prompt's own cost seed 0 where `AcpEngine.fork` returns, otherwise leave it
  - [x] Real check: fork a Claude Code chat on a scratch daemon, send a message in the fork, the answer knows the copied history

**Files**

- `apps/daemon/src/db/migrations.ts` — migration 18; `db/chats.ts`, `domain/chats.ts` — relation, create from a fork; `db/items.ts` — copy
- `apps/daemon/src/db/attachments.ts`, `apps/daemon/src/attachments/` — attachments of copied items
- `apps/daemon/src/commands/chat.ts` — `chat.fork`; `runs/messages.ts` and `runs/prompts.ts` — no first-message prefix for a forked run
- `packages/protocol/src/{domain,commands,events}.ts` — `Chat.forkedFrom`, command and result; `api.ts` route if commands are routed there
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts` — `chat.fork`
- `apps/daemon/AGENTS.md`

**Done when:** `chat.fork` on a flagged answer returns a chat whose stream holds the copied history and whose next message resumes the forked session.
**Verify:** `cd apps/daemon && bun test && bun run lint && bun run typecheck`; `bunx turbo run typecheck --filter=@clowdy/desktop`; the real check
**Commits:**

- `144fd22` feat(daemon): fork a chat at an answer into a new chat. Beyond the plan: commands can be asynchronous (`AsyncHandlers`, `executeCommandAsync`, `keepOpen` on the route; a repeated `requestId` joins the flight in progress); seq numbers are kept in the copy, so `forkedFrom.atSeq` is the answer's seq in both streams and copied items keep `provider_ref` (fork of a fork works, checked with real Claude); attachments are copied to the new chat's own files; running tools in the copied range become stopped; child runs of sub-agents are not copied; the fork's cost baseline is seeded to 0. The fixture daemon implements `chat.fork`; the fork fixture chat `c-7` is opt-in (`withFixtureFork`) because the default seed is used by unrelated tests. Real check passed on Claude Code, including a fork while the source turn runs. Follow-up outside this feature: Claude's cumulative cost can restart at 0 after a resume in a new process, and `usageEvent` in `engine/acp/mapper-core.ts` then clamps the turn's cost to 0 (smallest fix: count `cost` itself when `cost < costBefore`).


## Stage 5 — Edit a sent message (daemon)

**Depends on:** Stage 4.

**This stage:** `chat.edit` rewrites a chat from a person's turn-starting message: refuse unless at rest, fork the provider at the previous point (or clear the session for the first message), delete the suffix of the stream, tell clients, and send the edited text as a new turn. A new event makes the renderer drop the items; the renderer's stream store applies it. The fixture daemon implements the command.

- [ ] Complete
  - [ ] `EventData` gains a stream-truncation event; `RunStream` / `StreamStore` drop items from `fromSeq` on and keep the rest; a feed resync still works
  - [ ] `chat.edit { chatId, itemId, text, attachmentIds? }`; refusals: item not `canEdit`, run busy, queued message currently being sent, failed provider fork (nothing changed)
  - [ ] One transaction: delete stream items from the edited one, child runs and attachments under them (keeping the attachments the new message uses), set `session_id`, emit the event; then `sendMessage` as a normal turn (no first-message prefix, a fresh session for the first message keeps it)
  - [ ] Queue, threads, tasks, usage and files left alone as decided
  - [ ] Fixture daemon implements `chat.edit`
  - [ ] Daemon tests: middle message, first message, busy refusal, failed fork leaves history intact, attachments, queued messages kept
  - [ ] Real check: edit the second message of a Claude Code chat on a scratch daemon, the answer is consistent with the cut history

**Files**

- `packages/protocol/src/{commands,events,domain}.ts` — `chat.edit`, truncation event
- `apps/daemon/src/commands/chat.ts` — `chat.edit`; `runs/messages.ts` — send after edit; `db/items.ts`, `db/chats.ts`, `db/runs.ts`, `db/attachments.ts` — delete suffix and set the session; `runs/service.ts` — at-rest check
- `apps/desktop/src/renderer/stores/StreamStore.ts` and `RootStore.ts` — apply the event
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — `chat.edit`
- `apps/daemon/AGENTS.md`, tests for the daemon and the store

**Done when:** `chat.edit` on a flagged, idle chat removes everything from the edited message on, starts a turn with the new text on the forked session, and the renderer's stream shows the same cut.
**Verify:** `cd apps/daemon && bun test && bun run lint && bun run typecheck`; `cd apps/desktop && bun run test && bun run typecheck`; the real check
**Commits:** None yet.

## Stage 6 — Fork and Edit in the chat

**Depends on:** Stage 1, Stage 2, Stage 5.

**This stage:** The row gets its last two actions and the chat shows a fork's origin. Fork on a final answer with `canFork` runs `chat.fork` and opens the new chat; the list shows the `Forked from` divider. Edit on a user message with `canEdit` swaps the bubble for the in-place `Editing message` frame with a composer of its own (own draft key, no queue or running agents above it), Esc or X cancels, Enter sends `chat.edit`. While the run is busy Edit is disabled with the hint.

- [ ] Complete
  - [ ] Fork action: `chat.fork`, open the new chat, toast on refusal (`Couldn't fork the chat`)
  - [ ] Divider after `forkedFrom.atSeq` with the source title link
  - [ ] `Composer` takes a draft key and an edit mode (no queue, no `ComposerBanner`, Esc and Enter semantics, own placeholder `Edit message`), seeded with the message text and its attachments as ready files
  - [ ] Edit frame in the list replacing the bubble, one edit at a time, other Edit buttons hidden while it is open; the hint while the run is busy; failure keeps the editor open with a toast; a message that disappears closes the editor
  - [ ] Fixture-based tests for both flows; a screenshot check; `apps/desktop/AGENTS.md` updated

**Files**

- `apps/desktop/src/renderer/stream/MessageActions.tsx`, `StreamView.tsx` — Edit and Fork buttons, the divider block
- `apps/desktop/src/renderer/stream/EditMessage.tsx` and `.module.css` — create: the in-place frame has its own state and layout that `UserBubble` should not carry
- `apps/desktop/src/renderer/features/chats/Composer.tsx`, `composerDrafts.ts`, `composerFiles.ts` — draft key, edit mode, seeded files
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — commands, edit session, busy rule, open the fork
- `apps/desktop/src/renderer/features/chats/ChatView.test.tsx`, `Composer.test.tsx`, `stream/StreamView.test.tsx`
- `apps/desktop/AGENTS.md`

**Done when:** in the fixture app a flagged answer forks into a new chat with the divider, and a flagged message can be edited in place and resent, with the later messages disappearing when the edit commits.
**Verify:** `cd apps/desktop && bun run test && bun run lint && bun run typecheck`, then `bun scripts/screenshot.ts`
**Commits:** None yet.

## Stage 7 — Reply card, swipe to reply, setting

**Depends on:** Stage 2, Stage 6.

**This stage:** The optional polish. Reply on a whole message becomes a messenger-style quote card above the composer (per chat key, removable with an X, sent as a `> ` block before the message text); a selection still inserts `> text`. A horizontal trackpad scroll over a message (and a pointer drag where one exists) pulls the message sideways and triggers Reply past a threshold; vertical scrolling is not touched. A Chat setting turns the swipe off.

- [ ] Complete
  - [ ] Reply card: per-key state beside drafts and files, rendered above the field, cleared with the draft on send, restored on a failed send; the sent text is `> quoted` + blank line + the message
  - [ ] Swipe gesture on rows with Reply, resistance and snap-back, threshold, no interference with vertical scroll or text selection
  - [ ] `Swipe a message to reply` row on the Chat page with a `Switch`, preference on this computer, default on, with a reset in tests
  - [ ] Tests for the card lifecycle, the gesture decision logic and the setting

**Files**

- `apps/desktop/src/renderer/features/chats/composerQuotes.ts` — create: per-key reply state cannot join `composerDrafts.ts`, whose data is a document, nor `composerFiles.ts`, whose data is uploads
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — card, send, give-back
- `apps/desktop/src/renderer/stream/swipeReply.ts` — create: gesture logic with no React in it
- `apps/desktop/src/renderer/stream/MessageActions.tsx`, `UserBubble.tsx`, `AssistantMessage.tsx` — attach the gesture
- `apps/desktop/src/renderer/features/chats/swipeReplyPreference.ts` (preference class like `busyEnter.ts`) — create: a second preference does not belong in `busyEnter.ts`
- `apps/desktop/src/renderer/features/settings/ChatPage.tsx` and `ChatPage.test.tsx` — the row

**Done when:** Reply on a whole message shows a card above the composer that is sent as a quote, a sideways scroll on a message does the same unless the setting is off.
**Verify:** `cd apps/desktop && bun run test && bun run lint && bun run typecheck`, then `bun scripts/screenshot.ts`
**Commits:** None yet.

## Order of work

Stage 1 and Stage 3 touch disjoint trees (renderer, daemon) and run together. Then Stage 2 (renderer) runs with Stage 4 (daemon, protocol, fixture). Stage 5 follows Stage 4, Stage 6 follows Stage 5 and Stage 2, Stage 7 closes. Concurrent workers own disjoint files; the coordinator commits each stage separately and stages only that stage's files. When signing fails, stage trees are recorded as in the `git-signing-needs-owner` note and the commit is retried at the end.
