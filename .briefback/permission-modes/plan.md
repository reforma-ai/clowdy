# Permission presets and approvals per agent

> Keep this plan current during implementation.
> Check off tasks as their outcomes are completed.
> Check a stage only after done-when, verification, review, and commit.
> Record scope changes before leaving the stage.
> Record landed commits under the stage they implement.

**Goal:** the person picks, in Settings → Providers, one of a few permission presets per agent (Ask for approval, Accept edits, Approve for me, Full access); the agent runs on it, and what it asks for shows in the chat as a card the person decides.

**Approach:** Stage 1 first makes a provider one module: today a vendor is spread over the catalog array (`catalog.ts`), the account and login file (`providers/<id>.ts`), the model routes (`providers/models.ts`) and the list in `service.ts`; afterwards each provider is one object in its own file with a method for each thing the daemon asks of it, and one list names them. Stage 2 gives that object a `permissions` member, so a provider declares its own presets and what each does to its agent, and adds the ask path in the daemon (a classified `approval` item, grants). Stage 3 is the card in the chat; Stage 4 the list in the settings, where the default turns on once there is a card to answer it.

**Research:** `research/index.md` (what Claude, Codex and Cursor offer over ACP, what Clowdy does today, what Reforma and bb have).

**Decisions** (owner, 2026-11-22)

- **A provider is one module with methods, not rows in shared tables.** `Provider` becomes `{ spec, read?, login?, freshMs?, models? }` (later also `permissions?`): `spec` is the `AgentSpec` that `KNOWN_AGENTS` holds today (launch, environment, settings, flags), the rest are what the daemon asks of the vendor. A provider is `providers/<id>.ts`, or `providers/<id>/` with `index.ts` when it has parts (Claude, Codex and Cursor do). One list, `PROVIDERS` in `providers/builtin.ts`, names them; it is the only registration. The six agents that are pure data (OpenCode, Gemini, Copilot, Grok, omp, Hermes) get a file each of a few lines. `KNOWN_AGENTS` and `MODEL_ROUTES` go; the registry and the model catalog read the list (the registry defaults to `PROVIDERS` and takes another in tests). The order of the list is the order of the catalog today. No behaviour changes in this stage.
- **One list of presets, global per agent, in Settings → Providers on the agent's card.** Nothing under the composer; no per-project or per-chat override. The presets are a closed vocabulary of four, `ask` (Ask for approval), `accept-edits` (Accept edits), `auto` (Approve for me), `full` (Full access); a provider offers the subset it can honour and writes its own description of each. A fifth is one line in the protocol.
- **The default is Approve for me (`auto`) wherever the provider has it** (Claude `auto`, Codex `agent`). A provider that cannot do it defaults to Full access, which is what it does today.
- **A provider declares its presets as `Provider.permissions` and applies them itself.** `PermissionSupport` has `presets` (the vocabulary ids it supports, with its own descriptions), `default`, and `apply(preset)`, which returns a plan: the value of the agent's `mode` config option, an environment and session-option effect (the shape `SettingEffect` already has), and the answer Clowdy gives to its requests (`ask` or `allow`). The core never branches on an agent id.
- **An agent with no declaration, including every custom agent, gets the generic pair: `ask` (the client asks the person for every request) and `full` (the client allows every request).** It is bb's pair for ACP agents. A new ACP agent works with a few lines of data; a `permissions` member is written only when the agent has native modes worth using.
- **Claude Code and Codex declare the four presets like this.** Claude: `ask` is `default`, `accept-edits` is `acceptEdits`, `auto` is `auto`, `full` is `bypassPermissions`. Codex: `ask` is `read-only`, `accept-edits` is `workspace-write`, `auto` is `agent`, `full` is `agent-full-access`. The first three answer `ask`, `full` answers `allow`. Claude's `plan` and Codex's permission profiles stay out (a way of working, and the person's config). A mode the session does not offer (Claude's `auto` on a model without it) is logged and left to the agent, as model and effort are.
- **Claude's presets that ask pre-allow Clowdy's own command, always.** Their plan adds `Bash(clowdy:*)` to the session's `allowedTools` (the adapter spreads `_meta.claudeCode.options` into the SDK query), so an agent's `clowdy task` and `clowdy thread` calls never come to the person as cards. Checked on 2026-11-22: in Claude's `default` mode `clowdy task list` does not ask. On Codex it asks in Ask for approval (`read-only`) and does not in Approve for me (`agent`), which is the default, so Codex needs no pre-allow for its default.
- **The preset is applied at every start of a turn, default included**, since each turn is a new agent process and a resumed Claude session otherwise continues in the mode its transcript ended in.
- **No stored choice means today's behaviour until Stage 4.** Until the card and the list exist, an agent whose preset the person never chose runs as now (no mode sent, every request allowed by `CLOWDY_AGENT_PERMISSIONS`), so the running app never waits on an approval nobody can see. Stage 4 makes the provider's default apply to it. `CLOWDY_AGENT_PERMISSIONS` stays for tests, probes and any engine used without a registry.
- **A request is classified by the daemon before it is shown, and the card draws the result:** `command` (the text of the command), `file_change` (the paths), `tool_use` (tool and detail), from the tool call's `kind`, `rawInput`, `locations` and `content`. The classifier is generic over ACP; a provider whose requests classify badly gets a hook when the first one needs it.
- **The decisions are three, by option kind:** `allow_once` (Allow once), `allow_always` (Allow for session), `reject` (Deny, for `reject_once` and `reject_always`). `run.decide` carries the kind and the daemon answers the agent with its first option of that kind (`allow_always` with the one-time allow, see below). Allow for session is offered whenever the agent offers any allow option. The card shows these labels for every agent, so twenty providers do not bring twenty vocabularies.
- **Allow for session is Clowdy's own grant, and the agent is told to allow once.** Clowdy remembers the subject (the command text, the set of paths, the tool) for the run and answers the same subject `allow_once` without asking again; it is kept in memory per run (a thread has its own), not across a daemon restart. Each turn is a new agent process, so what the agent remembers itself would not outlast the turn. The agent's own lasting option is never used: the real check of Stage 2 showed that both adapters turn their `allow_always` into a rule that outlives the run (Claude Code writes the project's `.claude/settings.local.json`; Codex writes `~/.codex/rules/default.rules`, which holds for every project and for Codex outside Clowdy). An agent that offers no one-time allow gets the lasting one, the only way to say yes.
- **Several approvals can wait at once.** The run stays in `waiting_user` while any question or approval is open. Stop answers every waiting request `cancelled` (ACP requires it) and marks the item cancelled; a daemon restart marks open ones expired, since the agent process is gone.
- **Only the person answers an approval.** The thread tools give an agent no way to decide for a child; a child waiting on one reads `asking` to its parent, as for a question. A thread nobody is looking at waits until someone does.
- **The card is in the stream, after the tool call it is about, built like `QuestionCard`** (the owner prefers it to bb's panel above the composer; to be judged live). The body follows bb: `$ command` clipped at four lines with "Show N more lines", a list of paths, a tool's name and detail; Deny on the left, Allow for session, Allow once as the main button; a decision in flight spins on its button. Reforma's `Approval` is not ported (two buttons on AI SDK states, no look for a decided request).

## Out of scope

- A per-project or per-chat override, a picker in the composer.
- Claude's `plan`, Codex permission profiles, reading presets from the agent at run time, and any native permission knob for Cursor, OpenCode, Gemini and other agents (they get the generic pair until their own `permissions` is written).
- Rewriting what the providers do (account reads, usage, login, model listing, launch): Stage 1 moves it and changes none of it.
- Client-side file-write limits as bb enforces for ACP agents, launch flags per agent (`permissionCli`), and a preset that answers `reject` for unattended runs.
- Timeouts on a waiting approval, notifications and the dock badge for one, and checking Windows.
- Claiming `_meta.jetbrains.air` to get the adapters' mode classification.

## Stage 1 — One module per provider

**Depends on:** None.

**This stage:** a behaviour-preserving refactor, so that adding a provider (this feature's presets, and the twenty after it) means writing one module and naming it in one list. Today the daemon's knowledge of one vendor is in four places; afterwards it is one `Provider` object. The existing tests are the proof that nothing changed, apart from the lines that named the old tables.

- [x] Complete
  - [x] `Provider` in `providers/types.ts` is `{ spec, read?, login?, freshMs?, models? }`; `id` is `spec.id`
  - [x] Each built-in agent is a provider module: Claude, Codex and Cursor as folders that hold their spec, account read and model listing (code moved, not rewritten); OpenCode, Gemini, Copilot, Grok, omp and Hermes as small files of data
  - [x] `providers/builtin.ts` holds `PROVIDERS` in the catalog's order; `KNOWN_AGENTS` and `MODEL_ROUTES` are gone; the registry, the providers service and the model catalog read the list and accept another in tests
  - [x] `providers/models.ts` keeps `ModelCatalog` and what is shared, and no vendor's parser
  - [x] A test provider with only a `spec` is a working agent in the registry, and one with a `models` method is listed by the model catalog, with no change to the core
  - [x] Docs: daemon `AGENTS.md` names the new places wherever it named `catalog.ts`'s array, `MODEL_ROUTES` or the providers' files

**Files**

- `apps/daemon/src/providers/types.ts` — `Provider`: `spec`, `models?`, `read?`; the `ProbeContext` and read types stay
- `apps/daemon/src/engine/acp/catalog.ts` — `KNOWN_AGENTS`: removed, its entries move into the provider modules; the types (`AgentSpec`, `Launch`, `SettingEffect`, `AgentOverride`, `CustomAgent`) stay
- `apps/daemon/src/providers/claude.ts`, `codex.ts`, `cursor.ts` — each becomes `providers/<id>/index.ts` with its parts (`account.ts` for the existing read, `models.ts` for the vendor's model code from `providers/models.ts`); moved with `git mv` where whole
- `apps/daemon/src/providers/opencode.ts`, `gemini.ts`, `copilot.ts`, `grok.ts`, `omp.ts`, `hermes.ts` — create: data-only providers, one per agent so the rule "a provider is one file or folder" has no exception
- `apps/daemon/src/providers/builtin.ts` — create: `PROVIDERS`; it cannot stay in `service.ts`, which the registry must not import
- `apps/daemon/src/providers/models.ts` — `MODEL_ROUTES` and the vendor functions out; `ModelCatalog` reads `provider.models`
- `apps/daemon/src/providers/service.ts`, `login.ts` — `provider.id` becomes `provider.spec.id`; a provider with no `read` is skipped; `PROVIDERS` moves out
- `apps/daemon/src/engine/acp/registry.ts` — `AgentRegistryOptions.providers`, `spec(id)`, the entries, the `known` set: from the list
- `apps/daemon/src/daemon.ts`, `apps/daemon/src/commands/context.ts`, `apps/daemon/src/probe.ts` — construction of the registry, the model catalog and the service from one list
- `apps/daemon/test/acp-registry.test.ts`, `agents-api.test.ts`, `acp-layers.test.ts`, `acp-fork.test.ts`, `acp-helpers.ts`, `providers-models.test.ts`, `providers-service.test.ts`, `providers-login.test.ts` — `KNOWN_AGENTS` and `MODEL_ROUTES` become `PROVIDERS`; imports follow the moved code
- `apps/daemon/AGENTS.md`

**Done when:** the daemon's tests pass as before with each provider in one module and `KNOWN_AGENTS` and `MODEL_ROUTES` gone, and a provider added in a test needs no change to the core.
**Verify:** `bun test` in `apps/daemon` (compared with the failures it had before the stage); `bun run lint` in `apps/daemon`
**Commits:**

- `8a4bc0d` refactor(daemon): make each provider one module
- `486c211` docs(daemon): say where each provider's code lives now
- `dc072c6` docs(daemon): fix the names the move left stale (review)
- `79a67f9` test(daemon): cover a spec-only provider in the service, and tidy test helpers (review)

**Implementation notes (deviations, from the worker):** `providers/parse.ts` is one more file than listed: `jsonObject`, `planLabel` and `text` were shared by Claude's account and models and by Codex's account, and lived in `claude.ts`/`models.ts`. The account part of each vendor is exported as an object typed with `satisfies Pick<Provider, ...>` (`claudeAccount`, `codexAccount`, `cursorAccount`) and spread into the provider in `index.ts`, so its code is moved, not rewritten. `chatTitleSetting` is now exported from `catalog.ts` for the Claude and Codex specs. `daemon.ts`, `commands/context.ts` and `probe.ts` are unchanged: the registry, the service and the model catalog default to `PROVIDERS`. `ProvidersService.decorate` adds nothing for a provider with neither `read` nor `login`, so a data-only agent's `AgentInfo` is what it was. Tests build providers with `testSpec(id)` (in `test/helpers.ts`) and their local `SPECS` list. Daemon tests: 1683 pass before, 1685 after (the two new tests), 0 fail, 8 skip; typecheck errors are the same seven pre-existing ones.

**Review (2026-11-22):** no behaviour change found. The nine specs of the old `KNOWN_AGENTS` and the new `PROVIDERS` were compared field by field in one script (the `effect` functions called with true and false, `scrub` by source, key and agent order); the model code is a verbatim move; no import cycle goes through the registry, `builtin.ts` or the providers. Daemon tests after the review: 1686 pass, 8 skip, 0 fail.

## Stage 2 — Presets and approvals in the daemon

**Depends on:** Stage 1.

**This stage:** gives the daemon the whole permission model, checked by commands and real adapters before any screen. A provider declares its presets; the registry stores the person's choice, lists the presets in `AgentInfo`, and hands the plan of the chosen one to the engine, which sends the mode and answers requests; a request that must go to the person becomes a classified `approval` item and parks the run until `run.decide`, with Clowdy's session grants answering repeats. Two assignments are independent behind the protocol types and can run side by side: (a) provider, registry and mode, (b) engine, runs and approvals. Splitting this into two stages would force a temporary refusal of the presets that ask. The protocol's new items are written once at the start and kept out of the shared tree until the daemon and the fixture daemon handle them (a new command or item kind breaks the type checks of everybody until then).

- [x] Complete
  - [x] Protocol: the preset ids and names, `AgentInfo.permissions`, `agent.update.permission` (`null` clears it), the `approval` item (id, classified subject, the decisions the agent's options allow, a closed state `open`, `decided`, `cancelled` or `expired`, the decision), `run.decide { runId, approvalId, decision }`
  - [x] Provider interface: `PermissionSupport` and `PermissionPlan` on `Provider`, the generic pair, the declarations of Claude Code and Codex (Claude's pre-allowing `clowdy`)
  - [x] Registry: stores and validates the choice against the agent's presets, reports it, puts the plan's environment and session options in the agent's start and its `mode` and `answer` in `ResolvedAgent`; no choice keeps today's behaviour
  - [x] Engine: `applyChoices` sets the `mode` option (after model and effort, skipped when unchanged, logged when not offered); the request is answered through an asker the run supplies (`EngineStartOptions.approve`) in both layers according to the plan's answer; Stop and a closed session answer waiting requests `cancelled`
  - [x] Classifier and grants: the request becomes a `command`, `file_change` or `tool_use` subject, with the key that grants use
  - [x] Runs: `askApproval` and `decide` beside `ask` and `answerQuestion`: several open at once, `waiting_user` until none is left, a granted subject answered at once, Stop cancels, a restart expires; a child reads `asking`
  - [x] Fixture daemon: `run.decide` changes an approval item (the scripted approval and the card are Stage 3)
  - [x] A test provider with its own presets and effect appears in `AgentInfo` and reaches the agent's start without a change to the registry, the engine or the protocol
  - [x] Docs: daemon `AGENTS.md` (the provider's `permissions`, the generic pair, the `approval` item, `run.decide`, grants, the Permissions paragraph, the Codex sandbox note, the `CLOWDY_AGENT_PERMISSIONS` row)
  - [x] Real check on the pinned adapters, recorded in `research/real-checks.md`: each preset on Claude and Codex through `agent.update` and `run.decide` (Ask: allow once runs the action, Deny is refused and the agent says so; Allow for session: the same command is not asked twice, in the next turn too; Stop with one waiting ends cleanly), and a `clowdy` command in Approve for me on both (Claude must not prompt; for Codex see Decisions)

**Files**

- `packages/protocol/src/agents.ts` — `AgentInfo`: add `permissions?: AgentPermissions`; the preset ids and names beside `AgentSetting`
- `packages/protocol/src/commands.ts` — `agent.update`: add `permission`; `run.decide`
- `packages/protocol/src/domain.ts` — `StreamItemBody`: the `approval` kind, `ApprovalSubject`, `ApprovalDecision`, `ApprovalState`
- `apps/daemon/src/providers/types.ts` — `Provider`: `permissions?`; the `PermissionSupport` and `PermissionPlan` types
- `apps/daemon/src/providers/permissions.ts` — create: the generic pair as a value; it cannot join `types.ts`, which holds only types
- `apps/daemon/src/providers/claude/index.ts`, `apps/daemon/src/providers/codex/index.ts` — the `permissions` member (Claude's in its own `permissions.ts` if the plan outgrows the object)
- `apps/daemon/src/engine/acp/registry.ts` — `AgentRegistry.update`, `info`, `resolve`, `ResolvedAgent`, the loader of the saved file: the stored choice, the plan, `withDisallowedTools`' neighbour for the allowed tools
- `apps/daemon/src/engine/acp/catalog.ts` — `AgentOverride`: `permission`; `SettingEffect`: `allowedTools`
- `apps/daemon/src/commands/agents.ts` — `'agent.update'`: pass `permission` through
- `apps/daemon/src/engine/acp/conversation.ts` — `applyChoices`, `Choices`: the `mode` choice beside `modelChoice` and `effortChoice`
- `apps/daemon/src/engine/acp/v1.ts`, `apps/daemon/src/engine/acp/v2.ts` — the `applyChoices` calls and the `requestPermission` handlers
- `apps/daemon/src/engine/acp/layer.ts` — `LayerHost.pickPermission`: becomes async and takes the request and the signal
- `apps/daemon/src/engine/acp/session.ts` — `pickPermission`: the plan's answer, `options.approve` for `ask`, cancel and close answer open requests `cancelled`
- `apps/daemon/src/engine/acp/permission.ts` — create: the classifier and the grant key are pure and tested alone; `session.ts` is already large
- `apps/daemon/src/engine/types.ts` — `EngineStartOptions`: `approve` (the asker and its request type)
- `apps/daemon/src/runs/service.ts` — `askApproval`, `decide`, the grants per run, the interrupted-run sweep near `listActiveRuns`
- `apps/daemon/src/runs/driver.ts` — `engine.start({...})`: pass `approve`
- `apps/daemon/src/commands/run.ts` — `'run.decide'`
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts` — `#apply`: `run.decide`
- `apps/daemon/test/acp-registry.test.ts`, `acp-session.test.ts`, `acp-layers.test.ts`, `agents-api.test.ts`, `providers-service.test.ts`, `runs.test.ts`, `orchestration.test.ts`; `fake-acp-agent.ts`, `fake-acp-agent-v2.ts` — a `mode` option and permission requests with several options, two at once, and a cancel
- `apps/daemon/AGENTS.md`; `.briefback/permission-modes/research/real-checks.md` — create: a record of one real run per agent cannot live in `index.md`, which holds facts that were true before the work

**Done when:** an agent set to any of its presets by `agent.update` runs its next turn on that preset, a request that must go to the person shows as a classified `approval` item and the run waits, `run.decide` lets the agent go on as the decision says, a session grant spares the repeat, and a provider added in a test needs no change to the core.
**Verify:** `bun test` in `apps/daemon`; `bun run typecheck` and `bun run lint` in `packages/protocol` and `apps/desktop`; the real checks above
**Commits** (made on the branch `maksim-kachurin/permission-modes`, merged into `next` in `5a3c3af`):

- `4f59c88` feat(daemon): let providers declare permission presets and put requests to the person
- `f2d2520` fix(daemon): end a turn that leaves a request open, and answer a request the agent takes back (review)
- `43ef30b` fix(daemon): answer Allow for session with the agent's one-time allow, so it writes no lasting rule (found by the real check; also `research/real-checks.md`)
- `f802ba1`, `1310b98` merges of `next` into the branch

**Implementation notes:** `providers/permissions.ts` also holds `modePermissions(presets, default)`, the builder for an agent whose presets are modes of its own (Claude and Codex use it); `engine/acp/permission.ts` holds `classify`, `optionFor` and `paramsOfV2` (v2's request has no tool call, only a `subject`); `RunService` counts open questions and approvals together (`waits`), and a run that is not `running` (for example `waiting_background`) keeps its state while a card is open, so the card gates on the item's `state`; recovery marks open approvals of runs it interrupts `expired`.

**Review (2026-11-22):** found and fixed four defects, all behind a preset set by command: a turn that ended with an approval still open failed the run (`waiting_user` can now go on to `waiting_background`, `blocked` and `succeeded`); an agent taking a request back with `$/cancel_request` was ignored (both layers now pass the handler's signal); a request whose options map to no decision hung the run (it is withdrawn at once); and v2 file edits lost their paths (`changes` read). Real checks on Claude Code and Codex (`research/real-checks.md`) passed after the Allow for session fix. Daemon tests on the merged state: 1756 pass, 8 skip, 0 fail. Follow-ups carried to Stage 3: the fixture daemon's `run.answer` must leave a run waiting while an approval is open, as the daemon counts both; expiring every open approval at a restart (not only those of interrupted runs) if the tiny window ever matters.

## Stage 3 — The approval card in the chat

**Depends on:** Stage 2.

**This stage:** draws the `approval` item and sends the person's decision. The card sits in the stream after the tool call it is about and is built like `QuestionCard`: what the agent wants to do by subject kind, three buttons by decision, a decided line afterwards. It stays out of the folded "Worked for" group like a question, and is read-only once the item is no longer `open`. Behaviour is still unchanged for a person who has not chosen a preset, so this stage is checked on the fixture daemon and on a real run with a preset set by command.

- [ ] Complete
  - [x] Card: a body per subject (`$ command` clipped at four lines with "Show N more lines", the paths, the tool and its detail), Deny on the left, Allow for session where the agent offered it, Allow once as the main button, pending state on the pressed button, a decided line with the choice, lines for cancelled and expired, read-only unless the item's own `state` is `open`
  - [x] Stream: the `approval` item rendered and kept out of the fold, wired to `run.decide` for an `open` item (gate on the item's `state`, not on `run.status`: while an approval waits the run can rest in another status, `waiting_background` for one, and the daemon decides in any of them)
  - [x] The reason text of a run that waits on an approval reads `Waiting for your approval`
  - [x] Fixture daemon: data with open and settled approvals (chat `c-8`, added by `withFixtureApprovals` for tests and screenshots, like `withFixtureFork`) and the rules: `run.decide` changes an item, `run.answer` leaves a run waiting while an approval is open, as the daemon counts both. There is no timed script that raises a request and no session grant in the fixture; a script is added when somebody needs the card in `?fixtures` mode
  - [ ] Checked by hand in the running app (left to the owner, after the merge into `next`) with Claude and Codex (a preset set by command): the card appears under the tool call, each button does what it says, Stop with one waiting, a thread's approval shows in its chat and its parent sees it as asking

**Files**

- `apps/desktop/src/renderer/stream/ApprovalCard.tsx`, `ApprovalCard.module.css` — create: cannot join `QuestionCard.tsx`, whose body is a radio group with a free-text field, where this is a subject and a row of decision buttons
- `apps/desktop/src/renderer/stream/StreamView.tsx` — `StreamViewProps` and the `switch` on `body.kind`: the `approval` case and `onDecide`
- `apps/desktop/src/renderer/stream/turns.ts` — `needsAttention`: an open approval is attention; `index.ts`: export
- `apps/desktop/src/renderer/features/chats/ChatView.tsx` — the `onAnswer` neighbour: `onDecide` sends `run.decide` for an item whose `state` is `open`
- `apps/desktop/src/renderer/shared/runStatus.ts`, `apps/daemon/src/runs/service.ts` — the reason text of `waiting_user` for approvals
- `apps/desktop/src/renderer/daemon/fixtureTransport.ts`, `fixtureData.ts`, `fixtureTransport.test.ts` — a scripted approval
- `apps/desktop/src/renderer/stream/ApprovalCard.test.tsx` (create, beside `ToolCard.test.tsx`), `StreamView.test.tsx`, `turns.test.ts`
- `apps/desktop/AGENTS.md` — one bullet beside "Agent cards"

**Done when:** a request that waits shows as a card in the chat, a click on a decision lets the agent continue as it says, and the card keeps the decision afterwards.
**Verify:** `bun run test`, `bun run typecheck`, `bun run lint` in `apps/desktop`; the hand check above with `./clowdy dev`
**Commits** (made on the branch `maksim-kachurin/permission-modes`, merged into `next` with Stage 2 in `5a3c3af`):

- `99c21b2` feat(desktop): show an agent's permission request as a card in the chat
- `23d00c0` review fixes: the card is a labelled group, not a landmark section; the "Show N more lines" toggle takes the text colour and a chevron (the muted colour measured about 4.4:1, under the 4.5:1 a small control needs); the fixture's requests follow their tool call and carry a `toolCallId`; a `RunDetail` test
- `f07bc7a` test(desktop): a decision that arrives from another window while this card is pending

**Review (2026-11-22):** no logic defect found. Checked with concrete inputs: the gate on the item's `state` (a stale open card under a finished run is refused by the daemon and toasts, and stays open), double press, a decision from another window while pending, thread and child views (both `ChatView` and `RunDetail` can decide), the fold in `turns.ts`, and mutations of the open check that fail two and five tests. Desktop: 202 files, 3597 tests pass, typecheck and lint clean. Follow-up (needs the run to say it waits on a card, a protocol and daemon change): a run that rests in `waiting_background` with an open card keeps its green dot and gets no "Waiting for you" row, so the person sees nothing unless they open the chat.

## Stage 4 — The preset list in Settings → Providers, and the default

**Depends on:** Stage 3.

**This stage:** puts the choice where the person looks for it and turns the default on. Each agent's card lists the presets that agent's provider declares (name and description each), the chosen one marked, the default named. From here an agent whose preset the person never chose runs on its provider's default (Approve for me on Claude and Codex, Full access on a provider without native modes), now that a card exists to answer what it asks.

- [x] Complete
  - [x] Settings: a list of the presets the agent offers, built from `AgentInfo.permissions` with no vendor knowledge in the page; pending state while saved; the default marked
  - [x] Registry: no stored choice resolves to the provider's default; a stored choice still wins; `CLOWDY_AGENT_PERMISSIONS` stays the fallback of an engine used without a registry
  - [x] Fixture daemon and tests follow the list
  - [x] Docs: daemon and desktop `AGENTS.md`; the daemon's Permissions paragraph now says the default is the provider's
  - [ ] Checked by hand in the running app (left to the owner, now that it is in `next`): the list on Claude, Codex and an agent with the generic pair; a new chat on the default; switching to Full access takes effect on the next turn

**Files**

- `apps/desktop/src/renderer/features/settings/providers/ProviderSettings.tsx` — a `PermissionPresets` component using `@clowdy/components/Radio`, placed with the settings
- `apps/desktop/src/renderer/features/settings/providers/ProvidersPage.test.tsx`, `apps/desktop/src/renderer/daemon/fixtureTransport.ts` (`#updateAgent`), `fixtureData.ts` — the list in the fixture daemon and its test
- `apps/daemon/src/engine/acp/registry.ts` — `resolve`: the stored preset or the provider's default
- `apps/daemon/test/acp-registry.test.ts`, `acp-runtime.test.ts` — the default applies, a stored choice wins
- `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`

**Done when:** every agent's card lists its presets and the person's choice reaches the agent's next turn, and an untouched agent runs on its provider's default with approvals going to the card.
**Verify:** `bun run test`, `bun run typecheck`, `bun run lint` in `apps/desktop`; `bun test` in `apps/daemon`; the hand check above with `./clowdy dev`
**Commits** (made on the branch, merged into `next` in `72ceb72`):

- `3a3af89` feat(desktop): list an agent's permission presets in the provider settings, and start agents on their default
- `1ebbf34` review fix: the radios stay enabled and the group is read only while a choice is saved, so keyboard focus stays on the radio (a disabled radio drops focus to the page in Electron's Chromium)
- `a790883` test(daemon): the default preset end to end over v1 and v2, a provider's own default, and stale wording fixed (review)
- `1440fcc` docs(briefback): the real check of the default preset

**Review and real check (2026-11-22):** the registry resolves every agent to the person's valid choice, else the provider's default; a stale stored preset falls back; nothing in the core assumes `ResolvedAgent.permission` is absent; the test rig's strip of the registry's preset was checked by removing it (only the two "permission requests are answered by the daemon" tests fail, as intended). Real agents on the default (`research/real-checks.md`): `resolve()` gives `auto`/`auto`/`ask` for Claude Code and `auto`/`agent`/`ask` for Codex, and a file write in the project and `clowdy task list` run with no card. Daemon tests on the merged `next`: 1744 pass, 8 skip, 0 fail; desktop 3618 pass, with two failures in `QuickSearch.test.tsx`, whose files another agent has uncommitted in the shared tree (not this work).

**Decided after the review (2026-11-22, owner):** `CLOWDY_AGENT_PERMISSIONS` was removed (no effect once every agent has a preset; `ResolvedAgent.permission` is now required, and an agent on `ask` run with no `approve` has its requests refused); the notice for a Claude without Auto mode, the radio focus ring and similar polish are dropped as not worth the work.

**Still open:**

- **A resumed Claude session can stay in Full access:** when Claude does not offer `auto` for the account or model, `applyChoices` sends no mode, and a resumed session continues in the mode its transcript ended in, which can be `bypassPermissions`, while Clowdy answers `ask`. Narrow, but it errs toward more access than chosen. The fix is a product rule: the provider declares an ordered fallback per preset (Claude: `auto`, then `acceptEdits`, then `default`) and `applyChoices` takes the first the agent offers.
- **Full access in one keystroke:** the radios select as the arrows move, so Up from Ask for approval saves Full access at once. Kept (it matches native radios, the choice shows, it applies from the next turn, and the warning tone marks it).
- **A run resting in `waiting_background` with an open card shows no sign that it waits** (see Stage 3): the run's status stays `waiting_background`, so the chat keeps its green dot and gets no "Waiting for you" row.
