# Clowdy today: compaction

Snapshot 2026-11-18, `main` at `61ea92a`. "Observed" means read in the current source, in the
installed packages, or in the logged probe of `../../provider-surfaces/research/session-verification.md`.
"Inferred" means read from code but not run. No agent was started for this note.

## Summary

- Manual compaction works end to end: the agent's context reading becomes `Run.context`, the
  composer draws a ring, and its Compact button sends `chat.compact`, which runs the agent's own
  `/compact` as the next turn of the orchestrator. Built in `292a905` (daemon), `f998025` (ring),
  `cc75819` (`AgentInfo.canCompact`), `09960f2` (retry sends the command again, demo engine reports
  a reading).
- There is no compaction marker of its own. The stream shows a note "Compacting the conversation",
  then the agent's compaction as a generic tool line ("Compact" for Claude, most likely "Think" for
  Codex, target chip "Compact conversation"), and the ring drops. Nothing says "Context compacted"
  or the token counts.
- Clowdy never compacts by itself. The agents' own automatic compaction (inside a turn) shows as
  the same generic tool line. A context overflow fails the run with "Start a new chat".
- One likely bug: a message sent while the compact turn is still queued or starting is joined into
  the `/compact` prompt (details under "Gaps").

## How it fits together

| Step | Where | What happens |
| --- | --- | --- |
| 1. Reading | `apps/daemon/src/engine/acp/mapper.ts` `UpdateMapper.usage()` / `context()` | `usage_update { used, size }` becomes an engine `context` event when it differs from the last one of the prompt. Claude and Codex send it, Cursor never does (observed in the probe). |
| 2. Keep it | `apps/daemon/src/runs/driver.ts` `RunDriver.consume()` case `context`; `runs/service.ts` `RunService.setContext()` | Written when it moved by 1% of the window or the window changed; the last reading of a turn is written in `consume`'s `finally` with `settled = true`, however the turn ended. |
| 3. Contract | `packages/protocol/src/domain.ts` `Run.context`, `RunContext { used, size }`; migration 6 in `apps/daemon/src/db/migrations.ts`, row mapping in `db/runs.ts` | Published with `run.upserted`. A child run has its own reading; the ring uses the orchestrator's. |
| 4. Ring | `apps/desktop/src/renderer/features/chats/ContextRing.tsx` (mounted in `Composer.tsx`, `.end`, before the model pill), `contextUsage.ts` `contextFill()`, `formatTokens()` | Drawn only when the chat has an orchestrator with a reading. Tone from `usageTone` (80% warning, 90% danger). Popover: "Context usage", percent, `~92.3K / 200K`, one bar. |
| 5. Button | `ContextRing.tsx` `ContextPanel` | Shown when `AgentInfo.canCompact` is true for `chat.engine ?? run.engine`. Disabled with "Wait until the agent has finished" while `isRunActive(run)` (any non-terminal status, `chatRun.ts`). Press: `perform(root, { type: 'chat.compact', chatId })`, pending while in flight, popover closes; a refusal is the usual toast. |
| 6. Capability | `apps/daemon/src/engine/acp/catalog.ts` `AgentSpec.compact` (`'/compact'` for `claude` and `codex`); `registry.ts` `compactCommand()`, `canCompact: true` in the listing; `packages/protocol/src/agents.ts` `AgentInfo.canCompact` | Cursor and custom agents have none. The `fake` engine has none and is not in `useAgents()`. |
| 7. Command | `packages/protocol/src/commands.ts` `chat.compact { chatId }`; `apps/daemon/src/commands/chat.ts` `'chat.compact'` | `invalid` without a session or a command, `unavailable` for a switched-off agent, `conflict` for any non-terminal status (parked `waiting_children` included) and while child results are unread (`RunService.hasUnseenResults`). Then a `note` item "Compacting the conversation", `runs.resume(run.id, '/compact')`, `driver.launch`. No `user` item. Not activity (`updatedAt` stays). Answers `{ chatId, runId }`. |
| 8. Turn | `RunDriver.turn()` → `AcpSession` (`engine/acp/session.ts`) | The prompt is `next_prompt`, i.e. exactly `/compact` (later turns get no `Follow clowdy:...` prefix). It is sent after resume and the model and effort changes. A passing failure retries with the command, not `CONTINUE_MESSAGE` (`RunDriver.waitToRetry`, the `compacting` check). |
| 9. Agent's report | adapters | Claude 0.107.0: `tool_call` "Compact conversation", `kind: think`, `_meta.claudeCode.toolName: 'compact'`, completed with `rawOutput { trigger, preTokens, postTokens, durationMs }`, then a `usage_update` with the smaller `used` (observed 22062 → 6111). Codex 2.6.0: `tool_call` "Compact conversation", `kind: think`, `usage_update` (observed 41503 → 21542), `session_info_update`s. |
| 10. Stream | `mapper.ts` `nameOf()`, `tool()`; `apps/desktop/src/renderer/stream/toolView.ts` `describeTool()`; `ToolCard.tsx` | Claude's call is named `compact`; Codex sets no `_meta.claudeCode.toolName`, so the kind fallback names it `Think` (inferred). Input is `{ title: 'Compact conversation' }` (no `rawInput`); Claude's output is the `rawOutput` as JSON text. `describeTool` has no case for either, so the line reads the humanized name with the title as its chip, shimmering while it runs. The composer shows Stop and the "Working…" line meanwhile. |
| 11. Folding | `stream/turns.ts` `foldFinishedWork()` | A turn starts at a `user` item, and the compact turn has none, so its note and tool line belong to the previous turn. They sit after that turn's answer and stay outside the "Worked for" fold (inferred from `foldTurn`). |

## What ACP and the adapters offer that Clowdy does not use

- **Structured compaction updates.** Stable ACP v1 in SDK 2.7.0 (`node_modules/@agentclientprotocol/sdk/schema/v1/schema.json`)
  has `compaction_update { compactionId, status: in_progress | completed | failed | cancelled, summary?, error?, _meta? }`
  and `compaction_summary_chunk { compactionId, content }`, sent only to a client that advertises
  `clientCapabilities.session.compaction: {}`. The Claude adapter switches from the synthetic tool
  call to these updates when the client advertises it (`claude-agent-acp@0.107.0` `dist/context-compaction.js`
  `clientSupportsCompactionUpdates`, `dist/v1/acp-agent.js` around line 1765). Codex 2.6.0 has the
  types and a conversion (`dist/index.js` around 32526); whether it sends them live was not checked.
  Clowdy's `clientCapabilities()` in `session.ts` advertises only `fs` (off) and `terminal` (off),
  plus the agent's `clientMeta`.
- **Trigger and counts.** Claude's report carries `trigger` (`manual`, `auto`, `idle`), `preTokens`,
  `postTokens`, `durationMs` (`contextCompactionMetadataFromBoundary`). A "Context compacted 22K → 6K"
  line could be built from it for Claude only; Codex reports no counts in the tool call.
- **Summary text.** The adapter can extract the compaction summary (`compactionSummaryText`) and send it
  as `compaction_summary_chunk`; with the tool-call presentation it is not shown.

## Automatic compaction

- **Clowdy: none.** The provider-surfaces plan lists "automatic compaction by Clowdy" as out of scope.
- **The agents' own:** Claude Code compacts by itself near its threshold, and the adapter reports it
  with the same "Compact conversation" tool call (`trigger: 'auto'`, inferred from the adapter's
  mapping, not seen live). Codex's own auto compaction goes through the same `contextCompaction` item
  (inferred). Both appear mid-turn as the generic tool line and a drop of the ring.
- **Claude's idle compaction** (`dist/idle-compaction.js`, about 54 minutes after the last request, to
  save the prompt cache) cannot fire in Clowdy: every turn is a new adapter process that exits when
  the turn ends (inferred).
- **Overflow:** `engine/acp/failure.ts` classifies it as `context_too_long` with the message "The
  conversation no longer fits the model's context window. Start a new chat." `RunDriver.consume`
  throws `new EngineFailure(event.message, event.retryable)` and drops `code`, so neither the run nor
  the app can tell this failure from another one and offer Compact instead.

## Gaps and likely bugs

1. **A message joins the `/compact` prompt (likely bug, inferred).** After Compact the run is `queued`.
   A `chat.send` now goes to `driver.deliver` (status is not terminal): into `live.pending` before
   the session exists, or into `AcpSession.inbox` while the agent starts, resumes and sets its model.
   `AcpSession.talk()` builds the first prompt from `this.inbox.splice(0).join('\n\n')`, so the agent
   gets `/compact\n\n<message>`. Claude most likely reads the rest as custom compaction instructions,
   and the message is never answered as a message. The window lasts from the press until the first
   `session/prompt` (slot wait, spawn, `bun x` adapter start). No test covers it (`apps/daemon/test/context.test.ts`).
   A message sent after the prompt started is queued correctly as the next prompt.
2. **No marker of its own.** The note says it started; nothing says it ended or what it saved, except
   the generic tool line and the ring. Reforma's equivalent is a one-line notice pair (see
   `reforma-compaction.md`).
3. **Codex's line reads "Think".** The kind fallback in `nameOf()` names it after `kind: think`
   (inferred); a reader cannot tell it is a compaction without opening it.
4. **No reading after a Claude resume until the first prompt** (observed in the probe: only Codex sends
   `usage_update` on `session/resume`). Not a problem today because the reading is kept on the run.
5. **A typed `/compact`** is not a command on the first message (the `Follow clowdy:orchestrate` prefix)
   and is one on later messages only when nothing else joins the prompt (child results, other queued
   text) (inferred). The composer's `/` trigger lists skills, not agent commands (`useMentionTriggers.ts`).
6. **Demo data does not show the turn.** `apps/desktop/src/renderer/daemon/fixtureTransport.ts`
   `chat.compact` (around line 608) appends the note, halves `used` at once and never runs a turn or a
   tool item. Against a real daemon with `CLOWDY_ENGINE=fake`, the ring shows (the fake engine reports
   a growing reading) but there is no Compact button, because `fake` has no compact command and is not
   in `useAgents()`.
7. **Refusal while busy.** Compact is refused for every non-terminal state, `waiting_user` and `blocked`
   included. That is the design (`chat.setMode` behaves the same); a queued compact would need the
   queue work from `clowdy-queue-steer.md`.

## Where to hook in

- **A marker line.** Either recognise compaction in the daemon (the mapper sees `_meta.claudeCode.toolName === 'compact'`
  or title "Compact conversation") and write a dedicated item, or advertise `session.compaction: {}`
  and map `compaction_update` in `UpdateMapper` to a new engine event. Both need a stream item the app
  can draw: `StreamItemBody` in `packages/protocol/src/domain.ts`, `runs/writer.ts` `TurnWriter`,
  `stream/StreamView.tsx` `renderItem`, and a line component next to `stream/NoteLine.tsx`.
  The cheapest version is desktop only: a case in `toolView.ts` for `compact` and for `Think` with the
  title "Compact conversation", drawn as a note-like line.
- **Auto-compaction by Clowdy.** After a turn settles (`RunDriver.settle`, where the final
  `setContext(..., true)` has run), compare `Run.context` with a threshold and start the same turn as
  `chat.compact` (`runs.resume(runId, command)` plus `driver.launch`), subject to the same checks
  (terminal, no unread child results). Or recover from `context_too_long`: keep `code` on
  `EngineFailure`, compact, then resend the message.
- **Messages during a compact turn.** Keep a command prompt alone: in `AcpSession`, send the first
  inbox entry by itself when it is the compact command and queue the rest as the next prompt, or have
  `chat.send` hold messages for a run whose `next_prompt` is the compact command.
- **Tests:** `apps/daemon/test/context.test.ts` (reading and compact suites), `test/fake-acp-agent.ts`
  directives `usage`, `context`, `/compact`; `apps/desktop/src/renderer/features/chats/ContextRing.test.tsx`,
  `contextUsage.test.ts`; fixture `chat.compact` in `daemon/fixtureTransport.ts`.

## Sources

- Source at `61ea92a`: the files named above.
- `~/.bun/install/cache/@agentclientprotocol/claude-agent-acp@0.107.0@@@1/dist/` (`context-compaction.js`,
  `idle-compaction.js`, `tool-calls/reporters/compaction.js`, `v1/acp-agent.js`) and
  `codex-acp@2.6.0@@@1/dist/index.js`: the pinned adapters, read, not run.
- `../../provider-surfaces/research/session-verification.md` section E4: the logged `/compact` probe.
- `../../provider-surfaces/plan.md` Stages 6 and 7.
