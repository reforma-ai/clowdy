# Clowdy today: queue and steer

Snapshot 2026-11-18, `main` at `61ea92a`. "Observed" means read in the current source or the
installed packages; "inferred" means read from code but not run. No agent was started for this note.

## Summary

- **Every message to a working orchestrator is queued today, never steered.** It reaches the agent
  after the current `session/prompt` ends, as the next prompt of the same agent process; several
  queued messages are joined into one prompt. The ACP plan's Stage 7 ("Steer or queue a message")
  is unchecked.
- **The composer has no queue.** Send stays enabled while the orchestrator works (it turns into Stop
  only when the field is empty), and the person's bubble appears in the stream at once, before the
  agent has read it. There is no queue strip, no edit or remove, no "queued" state.
- **Both pinned adapters can steer.** Claude Code's adapter 0.107.0 and Codex's adapter 2.6.0 both
  advertise `_meta.steering.supported: true` at the top level of the `initialize` answer and implement
  `_session/steering`, with an opt-in fallback that hands an idle steer back to the client. The SDK
  has no types for it, but its generic `request(method: string, params)` sends it.
- **No setting exists** for a default behaviour; the candidate places are listed at the end.

## The path of a message today

| Step | Where | What happens |
| --- | --- | --- |
| Composer | `apps/desktop/src/renderer/features/chats/Composer.tsx` `send()` | Always `perform(root, { type: 'chat.send', chatId, text, attachmentIds? })`. The comment says it plainly: "The daemon decides what a message to a working orchestrator means". The field is emptied at once and given back on refusal. |
| Send button | `features/chats/ComposerSend.tsx` | `running && !canSend` shows Stop (`run.cancel`); otherwise Send, disabled only without text or while files upload or no provider is usable. `running` is `isRunActive(run)` (`chatRun.ts`: any non-terminal status). |
| Keys | `packages/components/src/RichInput/composerKeymap.ts`, `RichInput.tsx` | `submitOnEnter`: Enter calls `onSubmit(doc, { mod: false })`, Cmd/Ctrl+Enter calls it with `{ mod: true }`. `Composer` ignores the second argument, so the hook for "send the other way" is already there. |
| Command | `packages/protocol/src/commands.ts` `chat.send { chatId, text, attachmentIds? }` | No `mode` field. |
| Daemon | `apps/daemon/src/commands/chat.ts` `send()` | Appends the `user` item and touches `updatedAt` first, then: no orchestrator → create the run and launch; terminal or `waiting_children` → `runs.resume(run.id, content)` and `driver.launch` (a new turn, which also carries unread child results); anything else (`queued`, `running`, `waiting_user`, `blocked`) → `driver.deliver(run.id, content)`. |
| Driver | `apps/daemon/src/runs/driver.ts` `RunDriver.deliver()` | After commit: a live session gets `session.send(text)`; a live run without a session (queued, blocked, between retries) keeps it in `LiveRun.pending`, which `turn()` passes with `session.send` right after `engine.start` (so it joins the first prompt); no live run logs a warning and the text stays in the stream only. |
| Seam | `apps/daemon/src/engine/types.ts` `EngineSession.send(text: string): void` | No mode, no way to say what the engine supports. |
| ACP engine | `apps/daemon/src/engine/acp/session.ts` `AcpSession` | `send()` pushes to `inbox`. `talk()` sends `preface + inbox.splice(0).join('\n\n')` as one `session/prompt`; when it stops and `inbox` is not empty it loops and sends the next prompt on the same session; `done` comes only when nothing is left. A new `UpdateMapper` per prompt. Test: `apps/daemon/test/acp-session.test.ts` "a message sent while the turn runs waits, then goes out as the next prompt of the same session". |
| Fake engine | `apps/daemon/src/engine/fake.ts` `FakeSession` | `send()` pushes to `inbox`; `checkpoint()` answers "Noted: ..." at one fixed point of each of `orchestrate()`, `orchestrateBound()`, `collect()` and `execute()`, so the demo behaves like steering. `followUp()` has no checkpoint, and nothing reads the inbox after a script's checkpoint: such a message is never acknowledged and is gone when the session closes (inferred). |
| Test engines | `apps/daemon/test/helpers.ts` | `ScriptEngine.sent` records what the runtime sent into live sessions; `GateEngine.send` does nothing. |
| Fixture daemon | `apps/desktop/src/renderer/daemon/fixtureTransport.ts` `#sendMessage` (around line 820) | Sets the run `running`, appends the user item, streams a canned reply after 400 ms; it never ends the turn and knows no queue. |

## What the person sees (inferred from the code)

- The bubble is appended when the message is sent, so it lands between the agent's earlier and later
  output of the prompt that is still running. `stream/turns.ts` `foldFinishedWork()` starts a new turn
  at every `user` item, so the rest of the running prompt reads as the answer to the queued message.
- In `waiting_user` the message waits in the session until the question is answered, because
  `ask_user` holds the prompt open.
- The agent gets queued messages as one prompt joined by blank lines, with nothing saying they were
  written while it worked.
- A message sent while a `chat.compact` turn is starting is joined into the `/compact` prompt (see
  `clowdy-compaction.md`, "Gaps" item 1). Any future "command" turn has the same problem.

## Steering in the agents

### Claude Code adapter 0.107.0

Read in `~/.bun/install/cache/@agentclientprotocol/claude-agent-acp@0.107.0@@@1/dist/`:

- `v1/steering.d.ts`: `STEER_METHOD = "_session/steering"`. Request `{ sessionId, prompt: ContentBlock[], _meta?: { steering?: { idleBehavior?: 'promptRequired' } } }`.
  Answer `{ outcome: 'injected' } | { outcome: 'startedNewTurn' } | { outcome: 'promptRequired', reason: 'noRunningTurn' }`.
- `v1/acp-agent.js` around 583-597: the `initialize` answer carries `_meta.steering.supported: true`
  as a sibling of `agentCapabilities`, not inside it. Around 8403: the request handler.
- `steer()` around 1494-1580:
  - A turn in flight: the message goes onto the SDK's streaming input at priority `now` (or `later`
    while a permission or elicitation waits). It pre-empts the current generation: the interrupted
    cycle ends and the steer runs as a second one; during a foreground tool call (Bash, Agent, MCP)
    the CLI moves that tool to the background instead. The open `session/prompt` settles only once a
    result answers the steer, and the steer's output streams in that same prompt.
  - No turn in flight, with the opt-in: `promptRequired`, nothing is touched, and the client sends a
    normal `session/prompt`. Without the opt-in: a detached `prompt()` starts (`startedNewTurn`),
    whose lifecycle no client request owns.
- A second `session/prompt` while a turn runs is accepted and queued as its own turn (`turnQueue`,
  around 1180-1215). Clowdy never sends one; `AcpSession` holds the text itself.

### Codex adapter 2.6.0

Read in `~/.bun/install/cache/@agentclientprotocol/codex-acp@2.6.0@@@1/dist/index.js` (one bundle):

- `SESSION_STEERING_METHOD = "_session/steering"` (around 47629); `initializeExtensionsMeta()`
  returns `steering: { supported: true }`, placed on the top-level `_meta` of the `initialize` answer
  (around 51102 and 51183).
- `performSteeringRequest()` (around 53025): injects into the active turn when there is one it can
  steer; otherwise `promptRequired` with the same opt-in, or a new turn without it. Steering requests
  of one session are serialised (`steeringQueues`). Image blocks are refused on a text-only model.

### SDK and the rest

- `@agentclientprotocol/sdk` 2.7.0 (root `node_modules`; the Bun cache also holds 2.4.0 and 2.6.0):
  the word "steer" is in neither `dist` nor any schema. `ClientContext.request<Response, Params>(method: string, params)`
  (`dist/v1/acp.d.ts` around 233) sends a custom method; `AcpSession` already holds the connection and
  the session id, and reads `init.agentCapabilities` but not `init._meta`.
- Cursor, OpenCode, Gemini and the other catalog agents were not checked.

## Where a steer/queue feature hooks in

- **Contract.** `chat.send` gains an optional `mode: 'steer' | 'queue'` (`packages/protocol/src/commands.ts`).
  Whether an agent can steer is only certain after `initialize` of each process; since both pinned
  adapters advertise it, a static catalog flag like `AgentSpec.compact` (`engine/acp/catalog.ts`) and
  an `AgentInfo.canSteer` (`packages/protocol/src/agents.ts`) would let the composer know beforehand.
- **Daemon.** `commands/chat.ts` `send()` passes the mode to `RunDriver.deliver()`; `LiveRun.pending`
  keeps it; `EngineSession.send(text, mode)` in `engine/types.ts`.
- **ACP engine.** In `AcpSession`, keep `init._meta?.steering?.supported`. Steer: while a prompt is in
  flight, `connection.agent.request('_session/steering', { sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } })`;
  on `promptRequired`, before the first prompt was sent, after a failed request, or for an agent that
  does not advertise it, fall back to the inbox (queue) and, as the plan says, leave a note in the run.
  Queue: the inbox as today, but never joined into a command prompt.
- **Fake engines.** `FakeSession` needs a queue path (hold until the script ends, then another round)
  besides the steer-like `checkpoint()`. `apps/daemon/test/fake-acp-agent.ts` learns `_session/steering`
  and advertises `_meta.steering.supported` (an env switch, like its other `FAKE_ACP_*` options).
- **Stream.** To show a queued message as queued (and move it after the running prompt's output),
  the `user` item needs a delivery state, for example `{ kind: 'user', text, delivery?: 'queued' | 'steered' }`,
  updated in place when the agent takes it (`StreamItemBody` in `packages/protocol/src/domain.ts`,
  `domain/items.ts`), or the daemon appends the item only when the message is delivered and keeps the
  queue elsewhere. Reforma keeps a server-owned queue with its own UI strip (see `reforma-queue-steer.md`).
- **Composer.** A per-message choice through `onSubmit`'s `origin.mod`, or a control near Send; the
  default from a setting. `ComposerSend` decides Send versus Stop and would show the queue's state.

## Where a default "steer vs queue" setting could live

| Place | Files | Fit |
| --- | --- | --- |
| App preference on this computer | `apps/desktop/src/renderer/stores/storage.ts` (`readStored`, `writeStored`); precedents `theme.ts`, `clowdy:model-choice` in `features/chats/useModelChoice.ts`, `clowdy:sidebar-width:*`; Settings pages in `features/settings/Screen.tsx` `GROUPS` (General has only Appearance), built from `features/settings/ui/` blocks | Simplest. The composer sends `mode` with every message, so the daemon needs no default. Per machine, not per project. |
| Project setting | `ProjectSettings` in `packages/protocol/src/domain.ts`; `project.update` `settings` schema in `commands.ts` (nullable to clear); `apps/daemon/src/domain/projects.ts`; `features/settings/projects/ProjectDefaults.tsx` "New chats" (Agent, Mode) | The daemon would apply it when `chat.send` names no mode; it also covers chats the daemon opens itself (`task.start`). |
| Per chat | like `Chat.mode` and `chat.setMode` | Needs a protocol field and a migration; probably more than needed. |
| Not suitable | `AgentSpec.settings` in `catalog.ts` (each setting only maps to environment variables and withheld tools, stored in `agents.json`) | The daemon has no global preference store besides `agents.json` and `skills.json`. |

## Tests to extend

- Daemon: `test/acp-session.test.ts` (the queue test), `test/fake-acp-agent.ts`, `test/attachments.test.ts`
  ("a message to a live session carries the same text and list"), `test/fake-engine.test.ts`
  (a second message to a finished chat), `test/helpers.ts` `ScriptEngine.sent`.
- Desktop: `features/chats/Composer.test.tsx`, `ComposerDraft.test.tsx`, `stream/turns.test.ts`,
  `daemon/fixtureTransport.test.ts`.

## Sources

- Source at `61ea92a`: the files named above.
- Pinned adapters in the Bun cache (paths above): read, not run.
- `../../acp/plan.md` Stage 7; `../../acp/research/acp-protocol.md` and `clowdy-mapping.md` (steering
  options, written before the adapters were cached here).
