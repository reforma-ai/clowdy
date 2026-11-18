# Provider surfaces

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit
> (or staging per project rules).
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** A chat is bound to a provider, a model and a reasoning level that the person picks in the composer, the window header shows how much of each provider's plan is used, and the chats of a provider that cannot run are read-only with a way to continue elsewhere.

**Approach:** The daemon stores `engine`, `model` and `effort` on the chat, applies them at the start of every turn (each turn is a new agent process that resumes the vendor session), and refuses a message to a switched-off provider. The desktop adds a header usage status (independent of the daemon work), a model and reasoning picker ported from Reforma's "grade" picker and fed by `GET /v1/agents/:id/models`, and a read-only notice with a client-side hand-off. Research and the owner's answers are in `research/`.

**Decisions**

Header
- The usage status sits at the top right of the window header, left of the shortcuts button, one badge per provider that is switched on and installed: the provider's mark, the headline percent and the time to reset of that window (`78% 1h 32m`). The headline is the highest used percent among the primary windows (a window is scoped, and left out, when its id has a `:` that is not its own agent's prefix: Claude's `weekly:fable` and Codex's `spark:secondary` are scoped, `codex:primary` is not). Tone changes at 80 (warning) and 90 (danger). A provider with no reading shows its mark alone, muted.
- One click opens one popover in bb's look: providers sorted by the headline percent, descending; per provider the mark, the account e-mail, a plan badge and a bar per window (label, percent used, time to reset); a refresh action; the states loading, signed out, unavailable and error. No Detailed/Compact switch. The usage rows are one shared component, also used by the Providers page; both use the 80/90 thresholds.
- The header reads the agents again every five minutes and when the window gains focus; the daemon's own freshness (90 s) stays. The status is absent when no provider is usable.

Chat binding
- A chat stores `engine`, `model` and `effort` (migration v5), and the orchestrator run carries the same `model` and a new `effort`. `chat.create` takes the three; the new command `chat.setModel` changes `model` and `effort` at any time (applied from the next turn) and `engine` only while the chat has no orchestrator run. The provider is fixed by the first message.
- The daemon applies the chat's `model`, then `effort`, in every turn: after `session/set_config_option` for the model it reads the returned options and sets the effort on the `thought_level` select option that has a choice of that value (so Cursor's per-model option ids need no special case). A set whose current value already equals the wanted one is skipped. A value the agent does not offer is logged and the agent keeps its own.
- Efforts are the agent's own strings. The desktop labels them: `xhigh` and `extra-high` read "Extra high", `max` "Max", `ultra` "Ultra", `none` "None", `minimal` "Minimal"; any other string is capitalised with `-` and `_` turned into spaces.
- Executors and verifiers a chat starts inherit its model and effort when they run on the same engine as the parent; a different engine takes the project's model. `run_spawn` may still name its own.
- Verified with real turns (`research/session-verification.md`): a resumed session comes back on the person's own agent settings for all three agents (Claude `sonnet`/`xhigh` here, Codex `gpt-6-sol`/`high`, Cursor whatever any process set last), even after a turn that used others, so model and effort are applied at the start of every turn. Clowdy always sends explicit values from the desktop, because a session otherwise starts on the person's own agent settings. Legacy chats take their engine and model from the orchestrator run (migration backfill).
- `chat.send` is refused at once with a clear message when the chat's provider is switched off in Clowdy.

Picker
- Reforma's look: a pill in the composer's `.end` group beside Mode (mark, model title, muted level, chevron); a 320px popover with a face (model button, "Reasoning effort" slider) and a list pane that swaps in with an animated height. All levels the model reports are slider stops: two or more make a slider, one is shown as text, none shows the model's description. No Auto mode of Reforma, no footer, no hover stat card, no search.
- The pane and height animations are CSS only, with both panes mounted and the hidden one `inert`: no new `motion` dependency in `apps/desktop`.
- The list (after the owner saw Stage 4 running, with bb's list as the reference): on the new-chat page a strip of provider marks (Claude, Codex, Cursor; only usable ones, none when only one is usable) switches the provider; under it only five main models of the provider and a "More models ›" row that opens a flyout with all the rest. The five are the first five in the agent's own order, except that the daemon marks Claude's alias rows (`opus`, `fable`, `sonnet`, `haiku`) as `featured`, and then those are the main ones. The selected model is always visible: if it is not among the five it is shown as a sixth row. In an existing chat the strip is absent and only the chat's own provider is listed. Cursor's own "Auto" model stays a normal row.
- A started chat that has no model (a chat from before models were stored: the agent ran on its own default) shows "Default model" on the face's model button with a muted line that it runs on the provider's own default until a model is picked; nothing is padded where a slider or description would be.
- The choice is remembered on this machine (`localStorage`): the last provider, the last model per provider, the last effort per model. A new chat starts from the remembered provider and model; with nothing remembered, the first usable provider's default model (the row marked `isDefault`, else the first) and its `defaultEffort`, else `high` when offered, else the middle level.
- The composer's data comes from `GET /v1/agents/:id/models` (cached by the daemon for ten minutes), loaded when the picker or a chat that needs it first asks.

Read-only and hand-off
- A chat whose provider is switched off, not installed or signed out shows a notice in place of the composer, with "Hand off to a new chat" and "Open Providers". The chat's stream stays readable.
- Hand-off v1 is client-side: it opens the new-chat page with the old chat's messages (the person's and the assistant's text, no tool output) attached as a Markdown file and a draft that says to continue the work. The person picks the provider and presses Send. Nothing changes in the daemon for it.

Context usage
- The composer shows how full the chat's context window is, like Reforma's context ring: a small ring beside the model pill; its popover says "Context usage", the percent full with `~92K / 200K` and a bar, and a Compact button. One total only (no split into instructions, tools and conversation). The numbers come from the agent's own `usage_update { used, size }`, which the Claude and Codex adapters send; the daemon keeps the latest reading on the orchestrator's run, so a finished chat still shows it. A chat with no reading shows no ring.
- Compact sends the agent's own `/compact` command to the orchestrator as a turn (Claude and Codex implement it; each reports a "Compact conversation" tool call and a lower `used`); it is offered while the orchestrator is idle and refused while it works. The stream shows what the agent reports for it.

Cursor
- Cursor joins by its own stage. Verified: a model and effort set over ACP do reach the turn, but `session/set_config_option` also changes the model every new `cursor-agent` process of the person starts on (it is global), so Clowdy does not use it. A run selects Cursor's model and level at launch, `cursor-agent --model '<family>[<effortKey>=<level>]' acp` (accepted, and the turn ran on it); the stage first checks that this leaves the person's own default alone. The catalog comes from `cursor/list_available_models` (48 families with their effort option's key, levels and default). Cursor sends no `usage_update` and does not advertise `/compact`, so it has no context ring.

**Reuse:** `AgentModels`/`AgentModel` (`packages/protocol/src/agents.ts`), `ModelCatalog` (`apps/daemon/src/providers/models.ts`), `useAgents()` and `providerAgents` (`apps/desktop/src/renderer/stores`, `features/settings/providers/providerView.ts`), `ProviderIcon`, `UsageBlock` rows, `formatRemaining` (`shared/time.ts`), `Popover`, `ListBox`, `Scrollable`, `Button` (`@clowdy/components`), `browserStorage`/`readStored`/`writeStored` (`stores/storage.ts`), `composerFiles`/`useComposerFiles` for the hand-off file, `ui.openDraft()` (`stores/UiStore.ts`).

## Out of scope

- Claude `fast`, `ultracode` and `thinking`, Codex `fast-mode`, Cursor `context`, `fast` and `thinking` options; a model search field; Reforma's hover stat card, Auto mode and subscription footer.
- A daemon-side hand-off (a chat that links to its predecessor) and a hand-off summary written by an agent.
- Choosing the executors' provider in the UI; the project settings' `engine` and `model` get no UI.
- A Detailed/Compact switch in the usage popover; a usage status in a bottom status bar.
- A breakdown of the context into instructions, tools and conversation; automatic compaction by Clowdy.

## Stage 1 — A chat's provider, model and effort in the daemon

**Depends on:** None.

**This stage:** A chat has no provider today: only its orchestrator run has an `engine` and a `model`, effort exists nowhere, and every turn starts a new agent process that resumes the vendor session. The stage stores the choice on the chat, carries it to the run, and applies model then effort in `AcpSession` at the start of every turn, so a change made between turns takes effect. It also refuses a message early to a switched-off provider and lets a chat's executors inherit the choice. It fixes the protocol contract the desktop stages build on.

- [x] Complete
  - [x] `Chat` and `Run` carry `engine`/`model`/`effort` (chat) and `effort` (run); migration v5 adds the columns and fills the chats' `engine` and `model` from their orchestrator runs.
  - [x] `chat.create` accepts `engine`, `model`, `effort`; the first `chat.send` creates the orchestrator run with the chat's choice and writes what the run really got (project defaults included) back to the chat; every other path that creates an orchestrator run (`task.start`) does the same.
  - [x] `chat.setModel` changes the chat's `model` and `effort` (`null` clears), updates the orchestrator run's row so the next turn reads it, and changes `engine` only while no orchestrator run exists; unknown engines are refused.
  - [x] `chat.send` answers `unavailable` with "`<Agent>` is switched off in Clowdy" before anything is written, for a chat whose resolved engine is switched off.
  - [x] `RunDriver` passes the run's `effort` in `EngineStartOptions`; `AcpSession` applies the model, then the effort on the matching `thought_level` option, skipping no-op sets and warning on unknown values.
  - [x] Spawned runs inherit `model` and `effort` from the parent on the same engine; native sub-agents copy `effort` too.
  - [x] Codex's warning on resuming a session recorded with another model ("This session was recorded with model ... but is resuming with ...") is not shown as an assistant message: the turn changes the model right after it.

**Files**

- `packages/protocol/src/domain.ts` — `Chat`: `engine?`, `model?`, `effort?`; `Run`: `effort?`.
- `packages/protocol/src/commands.ts` — `chat.create` fields; new `chat.setModel` (`chatId`, `engine?`, `model?: string | null`, `effort?: string | null`).
- `apps/daemon/src/db/migrations.ts` — version 5: `chats` and `runs` columns, backfill of `chats.engine`/`model` from `runs`.
- `apps/daemon/src/db/chats.ts` — `ChatRow`, `toChat`, `upsertChat`: the three columns.
- `apps/daemon/src/db/runs.ts` — run row mapping and `upsertRun`: `effort` (also in the `ON CONFLICT` list).
- `apps/daemon/src/domain/chats.ts` — `createChat` takes the choice; `setChatModel` (new function beside `setChatMode`).
- `apps/daemon/src/commands/chat.ts` — `send` (provider check, run creation with the choice, write-back), handlers `chat.create` and the new `chat.setModel` (added to `chatHandlers`' `Pick`, which `commands/index.ts` already spreads).
- `apps/daemon/src/runs/service.ts` — `NewRun` and `createRun` take `effort`; `createNative` copies it; a method that updates a run's `model` and `effort`.
- `apps/daemon/src/runs/driver.ts` — `spawn` inheritance on the same engine; `turn` passes `effort`.
- `apps/daemon/src/engine/types.ts` — `EngineStartOptions.effort`.
- `apps/daemon/src/engine/acp/session.ts` — the model/effort application after the session is set up; a helper next to `modelChoice`.
- `apps/daemon/src/engine/acp/registry.ts` — a synchronous `isEnabled(id)` for the early refusal (beside `has`).
- `apps/daemon/src/commands/task.ts` — `task.start`: write the run's choice onto its chat.
- `apps/daemon/test/` — extend `commands.test.ts`/`runs.test.ts`/`acp-session.test.ts` and its fake ACP agent: migration backfill, `chat.create`/`chat.setModel` (including the locked engine), the refusal, effort reaching `engine.start`, effort applied after the model on the right option, a skipped no-op, spawn inheritance.
- `apps/daemon/AGENTS.md` — the chat's selection and how it is applied.

**Done when:** a chat created with an engine, model and effort starts its orchestrator on them, a `chat.setModel` between turns changes what the next turn runs on, and a message to a switched-off provider is refused with its name in the message.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`
**Commits:**

- `3e45711` feat(daemon): bind a chat to a provider, a model and a reasoning level (the review also changed: `task.start` is refused for a switched-off agent, the project's model applies only on the project's own agent, `chat.setModel` is not activity)

## Stage 2 — Usage status in the window header

**Depends on:** None.

**This stage:** The usage of the providers is only on the Providers page. The stage puts the badges and the popover in the window header so the person sees the plan's state while working. The usage rows of the Providers page are extracted into a shared component so both screens show the same thing, and the two tone thresholds are made one (80 and 90).

- [x] Complete
  - [x] A shared usage-rows component used by `UsageBlock` and the popover; thresholds 80/90 in one place.
  - [x] `UsageStatus` in `TitleBand`: one badge per usable provider (mark, headline percent, time to reset), muted mark alone with no reading, hidden when no provider is usable; opens the popover.
  - [x] The popover: providers by headline percent descending, account line with plan badge, bars, refresh action, loading / signed-out / unavailable / error states.
  - [x] The header refetches the agents every five minutes (not while the window is hidden) and on focus.
  - [x] Tests for the headline rule, ordering, tones, hidden state and the refetch rhythm.

**Files**

- `apps/desktop/src/renderer/features/settings/providers/UsageBlock.tsx` — `UsageRow` moves to the shared component; thresholds 80/90.
- `apps/desktop/src/renderer/features/settings/providers/UsageRows.tsx` — create: the rows are used by the Providers card and by the header popover, so they cannot stay private to `UsageBlock`.
- `apps/desktop/src/renderer/features/settings/providers/providerView.ts` — a `headlineWindow(agent)` and `usageTone(percent)` next to `providerAgents`; tests in `providerView.test.ts`.
- `apps/desktop/src/renderer/shell/UsageStatus.tsx` and `UsageStatus.module.css` — create: the header status; `TitleBand.tsx` is the band, not a feature, and the status has its own popover and polling.
- `apps/desktop/src/renderer/shell/TitleBand.tsx` and `TitleBand.module.css` — mount the status left of the shortcuts button; the shortcuts button keeps its place at the right edge.
- `apps/desktop/src/renderer/shell/UsageStatus.test.tsx` — create: tests.
- `apps/desktop/AGENTS.md` — the header status.

**Done when:** with the fixture transport the header shows a badge per usable provider and the popover lists them by usage, and the status refetches every five minutes.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:**

- `3bdfe42` feat(desktop): show the usage of the providers in the window header (the review also fixed Codex's window ids: a window is scoped only when its `:` prefix is not its own agent's)

## Stage 3 — Models, remembered choice and level labels in the desktop

**Depends on:** Stage 1.

**This stage:** The picker needs the models of each provider, rules for what is selected and remembered, and labels for reasoning levels. This stage builds that without UI so it can be tested alone: the transport call, a store that loads and caches the model lists, the remembered selection, and the pure functions the picker will call. It encodes the memory and default rules of the grill.

- [x] Complete
  - [x] `getAgentModels(agentId)` on the transport (HTTP and fixtures) and a store that loads a provider's models once, with loading, ready and failed states and a retry.
  - [x] Remembered choice (last provider, last model per provider, last effort per model) in `localStorage`; a function that gives the starting selection for a new chat from the usable providers and the loaded models.
  - [x] A function that makes a stored selection legal for a model (an effort the model no longer offers falls to the model's default, a model that disappeared falls to the provider's default).
  - [x] Level labels and the slider's level list for a model (0, 1 or many levels).
  - [x] Fixtures with Claude, Codex and Cursor models, including a model with no effort and one with a single effort.

**Files**

- `apps/desktop/src/renderer/daemon/transport.ts` — `Transport.getAgentModels`.
- `apps/desktop/src/renderer/daemon/httpTransport.ts` — `getAgentModels` over `endpoints.agentModels`.
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` and `fixtureData.ts` — models per provider.
- `apps/desktop/src/renderer/stores/RootStore.ts` — `models` per agent id (load, cache, `reloadModels`), like `agents`; `stores/hooks.ts` — `useAgentModels(agentId)`.
- `apps/desktop/src/renderer/features/chats/modelSelection.ts` — create: remembered choice, starting selection and legalising, level labels; it is pure logic used by the picker and the composer, so it cannot live in `Composer.tsx`.
- `apps/desktop/src/renderer/features/chats/modelSelection.test.ts` — create: tests.
- `apps/desktop/src/renderer/daemon/httpTransport.test.ts` and `fixtureTransport.test.ts` — the new call.

**Done when:** the unit tests show the starting selection for no memory, a remembered provider, a remembered model with an effort the model dropped, and the label table.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:**

- `d8ab1ea` feat(desktop): read the models of each agent and remember the last choice

## Stage 4 — The model and reasoning picker in the composer

**Depends on:** Stage 3.

**This stage:** The visible part of the choice. A pill in the composer opens Reforma's popover: a model button over the reasoning slider, and a list pane that replaces it. On the new-chat page picking a model chooses the provider too (sections), the first message creates the chat with the choice, and the choice is remembered; in an existing chat the picker changes the model and effort for the next turn with `chat.setModel` and lists only the chat's provider. The reasoning slider shows every level the model reports.

- [x] Complete
  - [x] Trigger pill, popover shell, face with model button and slider (pointer and keyboard, any number of levels, no NaN for one level), list pane in provider sections, CSS-only pane and height transitions, `inert` hidden pane.
  - [x] The new-chat page creates the chat with `engine`, `model` and `effort` and stores the choice; an existing chat changes it through `chat.setModel`.
  - [x] States: models loading (pill shows the stored choice), unavailable or error (list pane shows why, with retry), a stored model missing from the list (shown by its id), no usable provider (composer asks to turn one on in Providers).
  - [x] Tests: opens and closes, picks a model and returns to the face, slider keyboard and drag, sections on the new-chat page and one provider in a chat, `chat.create` and `chat.setModel` payloads.
  - [x] `apps/desktop/AGENTS.md` describes the picker.

**Files**

- `apps/desktop/src/renderer/features/chats/ModelPicker.tsx` and `ModelPicker.module.css` — create: the trigger, popover, face and list (the Composer file is already the card; the picker is its own large piece).
- `apps/desktop/src/renderer/features/chats/ReasoningSlider.tsx` — create: Reforma's slider for a variable level count; separate for its pointer maths and tests.
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — mount the picker in `.end`; `send` creates the chat with the selection; an existing chat calls `chat.setModel`.
- `apps/desktop/src/renderer/features/chats/Composer.module.css` — room for the pill.
- `apps/desktop/src/renderer/features/chats/ModelPicker.test.tsx` and `ReasoningSlider.test.tsx` — create: tests.
- `apps/desktop/src/renderer/features/chats/Composer.test.tsx` — the payloads.
- `apps/desktop/AGENTS.md` — the picker.

**Done when:** on the new-chat page the person picks Claude, a model and its highest level, sends, and the fixture transport receives `chat.create` with that engine, model and effort; the next new chat starts on that choice.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`, then look at it in `./clowdy dev`.
**Commits:**

- `036ad1a` feat(desktop): pick the provider, model and reasoning level in the composer

## Stage 4b — Picker: provider strip, More models, chats with no model

**Depends on:** Stage 4.

**This stage:** The owner ran Stage 4 and found three things: a started chat with no stored model shows a bare provider name and a face with a hole where the slider would be, the list shows every model the agent has (dozens), and bb's list shows only a few main models with a "More models" submenu and a strip of providers. The stage fixes the face's spacing and wording for a chat with no model, replaces the provider sections by the strip, and shows five main models with a flyout for the rest.

- [x] Complete
  - [x] A chat with no model: "Default model" on the face's model button and a muted explanation, the pill reads the provider; no empty padding when there is no slider or description.
  - [x] The provider strip (marks with names as tooltips and `aria` labels, arrow keys) on the new-chat page replaces the sections; one usable provider shows no strip.
  - [x] Five main models per provider (the agent's order; Claude's `featured` rows when the daemon marks them; the selected model is always shown) and the "More models ›" row opening a flyout with the others: opens on press, Enter, Space and ArrowRight, closes on Escape and ArrowLeft with focus back on the row, positions itself on the side that has room, scrolls when long; picking from it works like picking from the list.
  - [x] Tests for each, and the popover's height with a flyout open.

**Files**

- `packages/protocol/src/agents.ts` — `AgentModel.featured?`; `apps/daemon/src/providers/models.ts` — `parseClaudeModels` marks the alias rows; its test in `apps/daemon/test/providers-models.test.ts`.
- `apps/desktop/src/renderer/features/chats/modelSelection.ts` — `mainModels(models, selected)` and its test.
- `apps/desktop/src/renderer/features/chats/ModelPicker.tsx` and `ModelPicker.module.css` — the face, the strip, the list and the flyout.
- `apps/desktop/src/renderer/features/chats/ModelPicker.test.tsx` — tests.
- `apps/desktop/AGENTS.md`.

**Done when:** on the new-chat page with the fixtures the person sees a strip of three marks, five models and "More models ›", the flyout lists the rest; a started chat with no model opens a tidy face.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`; `cd apps/daemon && bun test test/providers-models.test.ts`
**Commits:**
- `ca55a08` feat(desktop): pick the provider from a strip and keep the model list to five rows and a More models flyout
- `cc75819` (daemon half: `featured` on Claude's alias rows)

## Stage 5 — Read-only chats and hand-off

**Depends on:** Stage 1, Stage 3.

**This stage:** A chat whose provider was switched off, is not installed or is signed out cannot run, and today it only fails when the person sends. The stage replaces the composer with a notice in such a chat and offers a way to continue the work elsewhere. The hand-off opens the new-chat page with the old conversation attached as Markdown.

- [x] Complete
  - [x] A function that says whether a chat can be written to, from its `engine` (or its orchestrator run's engine) and the agents' state, with the reason.
  - [x] `ChatView` shows the notice in place of the composer, with "Hand off to a new chat" and "Open Providers"; the stream stays readable.
  - [x] The hand-off builds a Markdown transcript (people's and assistants' text) and opens the new-chat page with it attached and a prefilled draft.
  - [x] Tests for the check, the notice and the hand-off payload.

**Files**

- `apps/desktop/src/renderer/features/chats/chatProvider.ts` — create: the check (pure, tested in `chatProvider.test.ts`); `chatRun.ts` is about run status.
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — the notice in place of `Composer`.
- `apps/desktop/src/renderer/features/chats/ReadOnlyNotice.tsx` and `.module.css` — create: the notice.
- `apps/desktop/src/renderer/features/chats/handoff.ts` — create: the transcript and the opening of the draft; uses `stores/UiStore.ts` `openDraft` and the draft and files of `composerDrafts.ts`/`composerFiles.ts`.
- `apps/desktop/src/renderer/features/agents/DraftChat.tsx` — picks up a pending hand-off (the no-provider state was done with the picker in Stage 4).
- `apps/desktop/AGENTS.md` — read-only chats and hand-off.

**Done when:** with Claude switched off in the fixtures, a chat that ran on Claude shows the notice, and "Hand off to a new chat" opens the new-chat page with a `.md` file attached and the draft filled.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:**

- `8327ecb` feat(desktop): make the chats of a provider that cannot run read-only, with a hand-off (the review added: the transcript is cut to the attachment limit, quoted so a message cannot break the file, a Stop button for a running orchestrator)

## Stage 6 — The context reading and Compact in the daemon

**Depends on:** Stage 1.

**This stage:** The agents already tell Clowdy how full the context is (`usage_update { used, size }`), and the mapper receives it and ignores it. The stage turns it into a reading on the orchestrator's run, so clients can show it, and adds a command that asks the agent to compact. Readings arrive with every message, so they are written when they move by a percent or when the turn ends, not each time.

- [x] Complete
  - [x] `Run.context { used, size }` (migration 6) written from the engine's `context` event, throttled; published with `run.upserted`.
  - [x] `UpdateMapper` turns `usage_update` into a `context` event beside the cost it already reads.
  - [x] `chat.compact { chatId }` starts a turn of the orchestrator with `/compact` as its message and without a user item in the stream; refused (`conflict`) while the orchestrator works and (`invalid`) for a chat that has no orchestrator.
  - [x] Tests with the fake ACP agent (`usage_update`, `/compact`) and the script engine.

**Files**

- `packages/protocol/src/domain.ts` — `Run.context`; `packages/protocol/src/commands.ts` — `chat.compact`.
- `apps/daemon/src/db/migrations.ts` — version 6; `db/runs.ts` — the two columns.
- `apps/daemon/src/engine/types.ts` — `EngineEvent` `context`; `engine/acp/mapper.ts` — `usage`.
- `apps/daemon/src/runs/driver.ts` — `consume` handles `context` (throttled); `runs/service.ts` — `setContext`.
- `apps/daemon/src/commands/chat.ts` — `chat.compact`; `domain/chats.ts` if the check belongs there.
- `apps/daemon/test/` — mapper, session (fake agent `usage_update` and `/compact`), commands.
- `apps/daemon/AGENTS.md`.

**Done when:** a turn of the fake agent leaves its `used` and `size` on the orchestrator's run, and `chat.compact` on an idle chat starts a turn whose prompt is `/compact`.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`
**Commits:**

- `292a905` feat(daemon): keep the context reading of a run and compact a chat on request

## Stage 7 — The context ring in the composer

**Depends on:** Stage 4, Stage 6.

**This stage:** The visible part: a ring beside the model pill that fills with the context and opens a small popover with the total and a Compact button. It uses the run's `context` and sends `chat.compact`.

- [x] Complete
  - [x] A ring (percent drawn as an arc, tone at 80 and 90) shown only in a chat whose orchestrator has a reading; the popover with "Context usage", the percent, `~used / size` in K and a bar.
  - [x] Compact sends `chat.compact`, shows pending while the orchestrator works, and is disabled with a reason while it works.
  - [x] Tests for the arithmetic and formatting, the hidden state and the command.

**Files**

- `apps/desktop/src/renderer/features/chats/ContextRing.tsx` and `ContextRing.module.css` — create: its own popover, state and arithmetic; the composer only mounts it.
- `apps/desktop/src/renderer/features/chats/Composer.tsx` — mount it in `.end` before the picker.
- `apps/desktop/src/renderer/features/chats/ContextRing.test.tsx` — create.
- `apps/desktop/src/renderer/daemon/fixtureData.ts` — a run with a reading.
- `apps/desktop/AGENTS.md`.

**Done when:** a chat whose orchestrator has `context { used: 53000, size: 250000 }` shows a ring, the popover reads "21% full ~53K / 250K", and Compact sends `chat.compact`.
**Verify:** `cd apps/desktop && bun run test && bun run typecheck && bun run lint`
**Commits:**
- `f998025` feat(desktop): show the context of a chat as a ring in the composer, with a Compact button
- `cc75819` (daemon half: `AgentInfo.canCompact`)

## Stage 8 — Cursor's models, levels and its own folder

**Depends on:** Stage 1, Stage 3.

**This stage:** Cursor's catalog was the 280 flattened variants of `cursor-agent --list-models`, so its picker listed hundreds of rows and no reasoning levels; and every way of choosing its model (`session/set_config_option`, the `--model` flag) changes the model every new `cursor-agent` of the person starts on. The stage reads Cursor's 48 model families with their effort options from `cursor/list_available_models` (in Cursor's own order: Auto, Grok 4.7, Grok 4.6, Composer 2.5, ...), starts Cursor with a folder of its own (`CURSOR_CONFIG_DIR`, verified on macOS) so the person's default is never touched, and tells it that the client can show a model's effort (`parameterizedModelPicker`) so the generic model-then-effort setting of Stage 1 works for it. The research is in `research/cursor-launch-flag.md` and `research/cursor-isolation.md`; the launch flag turned out not to help (it changes the default too and wants an exact canonical string).

- [x] Complete
  - [x] `ModelCatalog` reads Cursor over ACP (`initialize`, `cursor/list_available_models`) and gives one `AgentModel` per family in Cursor's order (`default` is Auto), with `efforts` and `defaultEffort` from its level option; the old list is the fallback.
  - [x] Claude's alias rows are `featured` for the picker.
  - [x] A run of Cursor starts with `CURSOR_CONFIG_DIR` in the data folder (macOS only: the login in the keychain is verified there; Windows and Linux keep the person's own folder until somebody checks) and the `parameterizedModelPicker` capability. Models reads, the listing and the sign-in stay on the person's own folder.
  - [x] `AgentInfo.canCompact` for the composer's Compact button (Stage 7).
  - [x] A real one-word turn through `AcpEngine` ran on the chosen model, a resume on another model ran on that one, and the person's default stayed Auto.
  - [x] Tests with a fake Cursor (`cursor/list_available_models`, the folder, the capability).

**Files**

- `packages/protocol/src/agents.ts` — `AgentModel.featured`.
- `apps/daemon/src/providers/models.ts`, `appserver.ts` — the Cursor source over ACP; the featured rows; `apps/daemon/test/providers-models.test.ts`.
- `apps/daemon/src/engine/acp/catalog.ts`, `registry.ts`, `session.ts` — `isolation`, `clientMeta`; tests in `test/acp-registry.test.ts`, `acp-session.test.ts`, `fake-acp-agent.ts`, `acp-helpers.ts`.
- `apps/daemon/AGENTS.md`.

**Done when:** `GET /v1/agents/cursor/models` answers about 48 families with levels, and a Cursor turn ran on the chosen model with the person's own default untouched.
**Verify:** `cd apps/daemon && bun test && bun run typecheck && bun run lint`, and the one real turn.
**Commits:**
- `cc75819` feat(daemon): read Cursor's model families and give its runs a config folder of their own
