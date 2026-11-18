# Model and reasoning effort per chat: what the code stores today and what the three adapters expose

Snapshot 2026-11-18. Research only: no design, no plan. Facts, with evidence separated from assumptions.

Tags: **[observed]** read in code, or printed by a probe I ran on this machine; **[inferred]** my reading of observed facts; **[not run]** could not or must not be checked here.

## Sources, versions, and what I ran

| Item | Version | Where |
| --- | --- | --- |
| Clowdy | `fe984fe` (main, clean tree at start) | this repo |
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 (Clowdy's pin; source = tag `v0.107.0` / `c5c120d`) | `catalog.ts:58`; source read in `scratchpad/refs/limits/claude-agent-acp` |
| `@agentclientprotocol/codex-acp` | 2.6.0 (pin; tag `v2.6.0` / `f320891`) | source read in `scratchpad/refs/limits/codex-acp` |
| `@agentclientprotocol/sdk` | 2.7.0 | `node_modules/@agentclientprotocol/sdk` |
| `claude` | 2.1.322 | `~/.local/bin/claude` |
| `codex` | codex-cli 0.166.0 | `~/.local/bin/codex` |
| `cursor-agent` | 2026.11.13-eacade1 | `~/.local/bin/cursor-agent` |
| Claude Agent SDK (types) | 0.3.323 | `scratchpad/refs/limits/claude-sdk-0.3.323/x/package/sdk.d.ts` |
| Codex app-server protocol | `ad5dd4a` (main, 2026-11-18) | `scratchpad/refs/limits/codex` |

Earlier notes used: `.briefback/agent-accounts/research/models.md` (where the lists come from), `.briefback/agent-accounts/plan.md` Stage 5.

**What I ran** (all with a temp data dir and a temp cwd, no prompt sent, no login, no credential store read; the agents ran as `AgentRegistry.resolve` starts them for a run, so the adapters are the pinned ones from bun's cache):

- `scratchpad/session-probe/probe.ts` (uses the repo's `AgentRegistry`, `buildAgentEnv`, `spawnInOwnGroup` and the SDK's `client`/`ndJsonStream`): `initialize`, then for Claude `session/options`, for Cursor `cursor/list_available_models`, then `session/new`, printing the raw response. Variants: `mutate` (switch effort and model inside the throwaway session and switch back), `picker` (Cursor: advertise `clientCapabilities._meta.parameterizedModelPicker: true`), env `INITIAL` (initial `configOptions` on `session/new`).
- `scratchpad/session-probe/lists.ts`: the raw `list_models` rows of `claude -p --input-format stream-json` (the daemon's own request), `model/list` of `codex app-server` (paged, `includeHidden` false and true), `cursor-agent --list-models`.
- `cursor-agent --help`, `cursor-agent models --help`.

**Side effects to know about** (honest list):

- Claude and Codex probes ran `session/set_config_option` for model and effort in a throwaway session and then restored them. `~/.claude/settings.json` and `~/.codex/config.toml` mtimes were unchanged afterwards ([observed] `stat`). `~/.claude.json` mtime moved (the `claude` program writes it itself; I did not read it).
- A model switch on Claude changed the session's permission mode from `auto` to `acceptEdits` and made the adapter emit an `agent_message_chunk` notice (see below). That is adapter state of the throwaway session, not a model call.
- Cursor: I made 4 `session/new` calls (2 plain, 2 with the picker capability), which can leave sessions in Cursor's history (Cursor has no `session/close`). By mistake, my first Cursor `mutate` run walked all 48 `model` values with `session/set_config_option` (my generic loop was not meant for Cursor) and restored `default[]` at the end. Afterwards `cursor-agent --list-models` still marks `auto - Auto (current, default)`, so the user's default model did not change. `~/.cursor/cli-config.json` mtime moved during that window; I did not read the file (two other `cursor-agent` processes of the user were running, so I cannot attribute the change to my probe).
- Every process I started was stopped (checked with `ps`). The `cursor-agent` and `codex app-server daemon` processes still listed belong to the user.

**What I did not do:** send any prompt; test a real `session/resume`/`session/load` (a never-prompted session has no transcript or rollout, and loading the user's real sessions would read their conversations), so every "survives resume" statement below comes from source, not from a run; check what an effort change does to a real Cursor turn.

---

## 1. Today: what a chat and a run store, and how they are chosen

### Storage

[observed] There is no engine, model or effort on a chat.

| Where | Engine (provider) | Model | Effort |
| --- | --- | --- | --- |
| `Chat` (`packages/protocol/src/domain.ts:44`), table `chats` (`db/migrations.ts` v1, v3 `archived_at`) | no | no | no |
| `Run` (`domain.ts:143-146`), table `runs` (v1: `engine TEXT NOT NULL`, `model TEXT`, `session_id TEXT`) | `engine: EngineId` | `model?: string` | no field, no column |
| `ProjectSettings` (`domain.ts:29,32`), stored as JSON in `projects.settings` | `engine?` | `model?` | no |
| `RunWork` columns (`next_prompt`, `cwd`, `outcome`, process ids) | - | - | - |

`Chat.orchestratorRunId` points at the chat's orchestrator run; that run is the only place a chat's engine, model and session id live. A chat with no message yet has no run, so a draft chat has no engine at all. Spawned children and native sub-agents are separate runs, each with its own `engine`/`model`.

`upsertRun` (`db/runs.ts:69-79`): the `ON CONFLICT DO UPDATE` list contains `model` and `session_id` but **not** `engine`, so a stored run's engine does not change through `upsertRun`; its `model` could. `RunService.update` (`runs/service.ts:626`) is the private helper that rewrites a run; today it is called for `sessionId`, `usage`, `summary`. No command and no service method changes a run's `model` or `engine` after creation.

### How they are chosen

[observed] When the first message of a chat arrives (`commands/chat.ts` `send`, the `!chat.orchestratorRunId` branch):

```
runs.createRun({ project, role: 'orchestrator', chatId, summary, nextPrompt })   // no engine, no model passed
```

`RunService.createRun` (`runs/service.ts:112-141`):

- `engine = resolveEngine(project, input.engine)` = `input.engine ?? project.settings.engine ?? config.engine` (`:100-108`); `config.engine` is `CLOWDY_ENGINE`, default `fake`. It throws `unavailable` when `engines.has(engine)` is false. The registry's `has` is true for any known agent id, installed or not (`engine/index.ts:50`).
- `model = input.model ?? project.settings.model`, stored when set (`:118,132`). The string is not checked against any list.
- `sessionId` is empty until the engine reports one.

The commands that carry engine or model (`packages/protocol/src/commands.ts`):

| Command | Engine | Model | Effort |
| --- | --- | --- | --- |
| `chat.create` `{projectId, title?, mode?}` | no | no | no |
| `chat.send` `{chatId, text, attachmentIds?}` | no | no | no |
| `chat.setMode` | no | no | no |
| `task.start` `{taskId, engine?, force?}` (opens a chat plus an orchestrator run) | yes | no | no |
| `project.update` `{settings: {engine?, model?, chatMode?, ...}}` | yes (project-wide) | yes (project-wide) | no |
| `run_spawn` tool (`runs/run-tools.ts:52-64`) | `engine?` (not `fake`) | `model?` | no |
| `agent.*` | - | - | - |

The desktop composer (`apps/desktop/src/renderer/features/chats/Composer.tsx:114,129`) sends `chat.create {projectId, mode}` and `chat.send {chatId, text, attachmentIds}`. [observed] No renderer code sends `project.update` or names an engine or model (grep of `apps/desktop/src/renderer` found only the fixture value `model: 'claude-sonnet'`).

Inheritance [observed]:
- `RunDriver.spawn` (`runs/driver.ts:145-146`): child `engine: input.engine ?? parent.engine`, `model: input.model` (so a child with no `model` takes the project's, **not** the parent's).
- `RunService.createNative` (`runs/service.ts:156-181`): copies `engine` and `model` from the parent.

### When a message is sent

[observed] The follow-up path (`commands/chat.ts`, the branch after `requireChat`):

- Orchestrator run live: `driver.deliver(run.id, content)` → `live.session.send(text)` (queued in `AcpSession.inbox`; goes out as the next `session/prompt` of the **same** process and session). Model and effort cannot change here: `EngineSession` has only `send` and `close` (`engine/types.ts:44-47`).
- Run terminal or `waiting_children`: `runs.resume(run.id, content)` → `setStatus(queued)`, then `driver.launch(run.id)`. The next `RunDriver.turn` (`runs/driver.ts:~290-340`) reads the run row again and calls:

```
engine.start({ cwd, prompt, systemPrompt, resumeSessionId: run.sessionId, model: run.model, tools, signal })   // driver.ts:327-336
```

`EngineStartOptions` (`engine/types.ts:25-38`): `cwd, prompt, systemPrompt?, resumeSessionId?, model?, tools, signal`. There is no effort field.

### What `AcpSession` does with them (`engine/acp/session.ts`)

[observed]
- **A new agent process per turn.** `AcpEngine.start` returns a new `AcpSession`; `run()` spawns the agent (`spawnInOwnGroup`), `talk()` ends when the turn ends, `close()`/`proc.stop()` run in `RunDriver.turn`'s `finally`. A later message to a finished chat starts a new process that **resumes** the vendor session.
- `initialize` (`:287-292`) sends `clientCapabilities: { fs: {readTextFile:false, writeTextFile:false}, terminal: false }`. No `session.configOptions.boolean`, no `_meta.parameterizedModelPicker`, no AIR `recommendedValue` capability. `clientInfo`: `clowdy`.
- Session setup (`:307-358`): `shared = { cwd, mcpServers: [bridge], _meta?: agent.sessionMeta, systemPrompt? }`. With `resumeSessionId`: `session/resume` if `sessionCapabilities.resume`, else `session/load` if `loadSession`, and when either throws (other than abort) it logs `could not continue session ...; starting a new one` and calls `session/new`. The `session` event with the final id is emitted after (`:364`) and `RunDriver.consume` stores it with `runs.setSessionId`. So a failed resume silently becomes a new vendor session whose id replaces `run.sessionId`.
- `agent.sessionMeta` today: Claude only, `{ claudeCode: { options: { disallowedTools: [...] } } }` (`catalog.ts:96`, merged with the settings' `disallowedTools` in `registry.ts:433-435`).
- The model (`:366-374`): if `options.model` is set, `modelChoice(configOptions, model)` (`:90-102`) takes the **first** option with `category === 'model' && type === 'select'` and matches the string to a choice `value` or `name`, case-insensitive, groups flattened. A match sends `session/set_config_option { sessionId, configId, value }`; no match logs `offers no model called "..."; it keeps its own choice`. A rejected request lands in the turn's outer catch and ends the turn with a classified error. This runs on every turn, resumed or not, and uses the `configOptions` from the setup response only. Nothing else in `configOptions` is read; nothing is stored or sent to clients.
- Not used: `session/options`, initial `configOptions` on setup requests, the legacy `models` field, `session/set_model`.

### Where per-chat values could live (facts about each place, not a recommendation)

| Place | What already exists there | What is missing |
| --- | --- | --- |
| Chat row / `Chat` | `mode` is the only chat setting; `chat.setMode` refuses while the orchestrator works (`domain/chats.ts:120`) | no engine/model/effort field or column, no command |
| Orchestrator run row | `engine` (fixed at creation), `model` (updatable by `upsertRun`), `sessionId`; the driver reads both on every turn | no effort field/column; no command changes them; `NewRun` has `engine`/`model` but no caller of `chat.send` passes them |
| Per-message option | `chat.send` payload | no field; the message text goes to the live session or to `nextPrompt`, and `RunWork.nextPrompt` is a string only |
| Project settings | `engine`, `model` (`project.update`) | project-wide; no effort; `createRun` reads them only at creation |

---

## 2. ACP side: what the three adapters expose, how it is set, whether it survives

Probe results are from this machine and account on 2026-11-18. The lists follow the account, plan, settings and CLI version; do not read them as fixed.

### 2.1 Common ACP facts

[observed] SDK 2.7.0 unstable schema: `NewSessionRequest`, `LoadSessionRequest`, `ResumeSessionRequest` and `ForkSessionRequest` all have an optional `configOptions: InitialSessionConfigOption[]` (unstable; capability `sessionCapabilities.options`). `SessionConfigOptionCategory` is `mode | model | model_config | thought_level | speed(unstable) | other string`; names without a leading `_` are reserved for the spec; categories are "for UX purposes only" and "MUST NOT be required for correctness". `session/set_config_option` answers with the complete list of options; `config_option_update` carries the complete list. [observed, agentclientprotocol.com `protocol/session-config-options`, fetched 2026-11-18, summarized by the fetch tool] The page does not say whether option values persist across `session/load` or `session/resume`.

### 2.2 Claude (`claude-agent-acp` 0.107.0, `claude` 2.1.322)

`initialize` [observed]: `agentInfo.version` 0.107.0; `sessionCapabilities`: `additionalDirectories, close, delete, fork, list, options, resume, status, systemPrompt, title`; `loadSession: true`; `authMethods: []`.

`session/new` response keys [observed]: `sessionId, modes, configOptions`. No legacy `models`. `session/options` (no session) answers `modes` and `configOptions` in about 0.95 s and returns the same options as `session/new`.

Options in `session/new` (Clowdy's client capabilities; this account) [observed]:

| id | name | category | type | values (value: label) | current at start |
| --- | --- | --- | --- | --- | --- |
| `mode` | Mode | `mode` | select | `default` Manual, `acceptEdits`, `plan`, `auto`, `bypassPermissions` | `auto` |
| `model` | Model | `model` | select | 14 values, table below | `sonnet` |
| `effort` | Effort | `thought_level` | select | `default` Default, `low` Low, `medium` Medium, `high` High, `xhigh` Xhigh, `max` Max (the list follows the current model; absent when it has none) | `xhigh` |
| `fast` | Fast mode | `model_config` | select | `on`, `off` (only on models with fast mode) | `off` |
| `ultracode` | Ultracode | `model_config` | select | `on`, `off` (not on every model) | `off` |

The `default` value of `effort` and the `Default (recommended)` row of `model` exist because Clowdy does not advertise the AIR `recommendedValue` capability (`session-effort.ts:121-135`, `session-model.ts:246-254`); the booleans arrive as `on`/`off` selects because Clowdy does not advertise `session.configOptions.boolean` [observed in output and code].

Start values come from the user's own Claude settings, not from the row marked default [observed + inferred]: `~/.claude/settings.json` has `model: "sonnet"`, top-level `effortLevel: null` and a `modelSettings` object (I printed only those keys). `list_models` marks `default` = `claude-opus-5-5`, yet the new session starts on `sonnet` with `xhigh`. Priority in the adapter (`session-model.ts:680-700`): env `ANTHROPIC_MODEL`, then settings `model`, then (resume only) the transcript's last model.

**Models and effort levels** [observed: the `list_models` control response the daemon already uses, plus the adapter's option after each `session/set_config_option` model switch; both agree]:

| `model` value | Resolved model | Name | `supportedEffortLevels` | fast mode | ultracode option |
| --- | --- | --- | --- | --- | --- |
| `default` | `claude-opus-5-5` | Default (recommended) | low, medium, high, xhigh, max | yes | yes |
| `opus` | `claude-opus-5-5` | Opus 5.5 | low, medium, high, xhigh, max | yes | yes |
| `fable` | `claude-fable-5-2` | Fable 5.2 | low, medium, high, xhigh, max | yes | yes |
| `sonnet` | `claude-sonnet-5-5` | Sonnet 5.5 | low, medium, high, xhigh, max | no | yes |
| `haiku` | `claude-haiku-5-5` | Haiku 5.5 | low, medium, high, xhigh, max | no | yes |
| `claude-fable-5-1` | same | Fable 5.1 | low, medium, high, xhigh, max | no | yes |
| `claude-haiku-4-5-20251001` | same | Haiku 4.5 | none (no effort option at all) | no | no |
| `claude-sonnet-5` | same | Sonnet 5 | low, medium, high, xhigh, max | no | yes |
| `claude-opus-5` | same | Opus 5 | low, medium, high, xhigh, max | yes | yes |
| `claude-fable-5` | same | Fable 5 | low, medium, high, xhigh, max | no | yes |
| `claude-opus-4-8` | same | Opus 4.8 | low, medium, high, xhigh, max | yes | yes |
| `claude-opus-4-7` | same | Opus 4.7 | low, medium, high, xhigh, max | no | yes |
| `claude-opus-4-6` | same | Opus 4.6 | low, medium, high, max (no xhigh) | no | no |
| `claude-sonnet-4-6` | same | Sonnet 4.6 | low, medium, high, max (no xhigh) | no | no |

Raw row fields printed by `list_models` [observed]: `value`, `resolvedModel`, `displayName`, `description`, `supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`, `supportsThinkingOff` (this last one is not in the 0.3.323 `ModelInfo` type). The SDK type of an effort is `'low' | 'medium' | 'high' | 'xhigh' | 'max'` (`sdk.d.ts:742`); `ultracode` is not an effort level here but its own boolean option. No row carries a default effort. Claude's documented per-model defaults are in `.briefback/agent-accounts/research/models.md` (not re-fetched).

**How each is set**

- After setup: `session/set_config_option { configId: "model" | "effort" | "fast" | "ultracode", value }` [observed]. `model` calls `query.setModel` and rebuilds the other options for the new model (`acp-agent.ts:9346-9450`); `effort` calls `query.applyFlagSettings({ effortLevel })` (`:9480-9490`, `session-effort.ts:20-26`). The effort value `default` maps to `effortLevel: null` (clears the flag layer; the CLI then resolves it from its own persisted per-model settings). Each answer is the complete option list (4 to 1000 ms; the model switch with a CLI round trip took up to 1.2 s).
- Initial values on `session/new`, `session/resume` and `session/load`: `configOptions: [{ configId, value }]` in list order [observed in code: `acp-agent.ts:1897-1903, 2071-2096`; observed on `session/new`: `[{model: claude-opus-4-6},{effort: max}]` came back as model `claude-opus-4-6`, effort `max`, options `default, low, medium, high, max`]. A refused entry is skipped; a model entry before an effort entry decides which efforts are valid.
- `_meta.claudeCode.options` is spread into the SDK `Options` (`acp-agent.ts:9988`), so `effort` (type `EffortLevel`) there is read by the adapter as the effort seed (`:10369`) and passed on [observed in code, **[not run]**]. Clowdy already sends `_meta.claudeCode.options.disallowedTools` this way.
- Env `ANTHROPIC_MODEL`, settings `model`, `effortLevel`, `modelSettings.<model>.effortLevel`, env `CLAUDE_CODE_EFFORT_LEVEL` (documented to win) [observed in code and earlier docs note].

**Mid-session** [observed]: yes, both model and effort, live, with no restart.

**Side effect of a model switch** [observed in the probe]: the new model may not support `auto` mode; the adapter then moves the session to `acceptEdits` (my probe ended on `acceptEdits` after walking the models) and emits `current_mode_update` plus an `agent_message_chunk` with the text `> **Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.` [inferred] Clowdy's `session.ts` forwards every `session/update` of the current session to the mapper, so such a notice would appear as assistant text in the chat; Clowdy itself also never sets the mode.

**Survives resume?**
- Model [observed in code, `session-model.ts:680-730`]: a resumed session's model comes from the last assistant record of the transcript (`resumedModelHint`), unless env `ANTHROPIC_MODEL` or settings `model` is set, in which case that wins and the adapter re-asserts it. On this machine settings `model` is `sonnet`, so [inferred] a resume without Clowdy's own `set_config_option` would land on `sonnet`.
- Effort [observed in code]: not restored from the transcript. A resume computes `userProvidedOptions?.effort ?? settingsEffortForModel(...)` (`acp-agent.ts:10369`). The pin set through `applyFlagSettings` lives in the adapter's `effortPinnedLevel` and is re-applied only when the **same adapter process** recreates its query (`restoreSessionChoices`, `:10649-10680`); a new process (Clowdy starts one per turn) loses it. `max` is session-only by SDK design ("never written to settings files", `sdk.d.ts` `applyFlagSettings` comment).
- So Clowdy would have to re-apply effort at the start of every turn (as it re-applies the model now).

### 2.3 Codex (`codex-acp` 2.6.0, `codex` 0.166.0)

`initialize` [observed]: `sessionCapabilities`: `resume, list, close, delete, fork, title, additionalDirectories, subagents, systemPrompt` (**no `options`**); `loadSession: true`; `authMethods`: `api-key`, `chat-gpt`.

`session/new` [observed]: keys `sessionId, models, modes, configOptions`, in about 1.5 s. `models` (legacy) is present in the raw response (58 entries: one per model and effort, id `gpt-6-sol[high]`, `currentModelId: "gpt-6-sol[high]"`). So the legacy field survives Clowdy's SDK client at runtime (I called `conn.agent.request('session/new', ...)`, the same string as `methods.agent.session.new`); only the TypeScript types lack it.

Options [observed]:

| id | name | category | values | current at start |
| --- | --- | --- | --- | --- |
| `mode` | (agent mode) | `mode` | `read-only` Read-only, `workspace-write` Workspace access, `agent` Auto review, `agent-full-access` Full access | `agent` |
| `collaboration_mode` | Collaboration mode | `collaboration_mode` (a category name without `_`, outside the reserved list) | `default`, `plan` | `default` |
| `model` | Model | `model` | 10 ids (below) | `gpt-6-sol` |
| `reasoning_effort` | Reasoning effort | `thought_level` | the current model's `supportedReasoningEfforts`: values `low`..`ultra`; each entry has a `description` ("Fast responses with lighter reasoning", ..., ultra: "Maximum reasoning with automatic task delegation") | `high` |
| `fast-mode` | Fast mode | `model_config` | `off`, `on` | `off` |

Note the id is `fast-mode` (hyphen), not `fast_mode`. The start model and effort (`gpt-6-sol`, `high`) are the user's `~/.codex/config.toml` `model` and `model_reasoning_effort` (I printed those two key lines), not the catalog's `isDefault` row (`gpt-6.2-sol`, default effort `low`) [observed].

**Models and effort levels** [observed: raw `model/list` through `codex app-server`, which the daemon's `ModelCatalog` already calls; `includeHidden: false` gives 10 rows, `true` adds two hidden ones; the adapter's `model` option shows the 10]:

| `Model.id` (= `model`) | `supportedReasoningEfforts` | `defaultReasoningEffort` | `isDefault` |
| --- | --- | --- | --- |
| `gpt-6.2-sol` | low, medium, high, xhigh, max, ultra | low | yes |
| `gpt-6.2-astra` | low, medium, high, xhigh, max, ultra | low | |
| `gpt-6.1-terra` | low, medium, high, xhigh, max, ultra | low | |
| `gpt-6.1-sol` | low, medium, high, xhigh, max, ultra | low | |
| `gpt-6-astra` | low, medium, high, xhigh, max, ultra | low | |
| `gpt-6-sol` | low, medium, high, xhigh, max, ultra | medium | |
| `gpt-6-luna` | low, medium, high, xhigh, max (no ultra) | medium | |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra | low | |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra | medium | |
| `gpt-5.6-luna` | low, medium, high, xhigh, max (no ultra) | medium | |
| `gpt-reserve` (hidden) | low, medium, high, xhigh, max | medium | |
| `codex-auto-review` (hidden) | low, medium, high, xhigh, max | medium | |

Every row has `serviceTiers: [{id: "priority"}]` and `additionalSpeedTiers: ["fast"]` (the fast mode). `Model` row keys [observed]: `id, model, upgrade, upgradeInfo, availabilityNux, displayName, description, modelSpecialty, hidden, supportedReasoningEfforts, defaultReasoningEffort, inputModalities, supportsPersonality, multiAgentVersion, additionalSpeedTiers, serviceTiers, defaultServiceTier, availableAccessPrograms, isDefault`. The effort vocabulary is an open string (`ReasoningEffort = string` in the adapter's generated types).

**How each is set**

- After setup: `session/set_config_option { configId: "model", value: <Model.id> }` keeps the current effort if the new model supports it, else uses the model's `defaultReasoningEffort`; `{ configId: "reasoning_effort", value }` must be one of the current model's efforts, else `invalidParams` (`CodexAcpServer.ts:2833-2960`) [observed]. In the probe every model switch kept `high`; each answer is the complete list and the adapter also pushes `config_option_update` (13 updates seen).
- The legacy ext method `session/set_model { sessionId, modelId: "id[effort]" }` (`unstable_setSessionModel`) answered `{}` [observed with the current value].
- Not at setup: initial `configOptions` on `session/new` was **ignored** (sent `[{reasoning_effort: low}]`, got `high`) [observed]; no `options` capability. No `_meta` route.
- The values live in adapter memory (`sessionState.currentModelId`, `"<model>[<effort>]"`) and go out with every turn as `turn/start { model, effort, serviceTier }` (`CodexAcpClient.ts:1399-1421`); the adapter does not write `config.toml` [observed in code].

**Mid-session** [observed]: yes, the next `turn/start` carries the new values.

**Survives resume?** [observed in code + app-server doc comments, **[not run]**]: `turn/start`'s `model` and `effort` are documented as overrides "for this turn and subsequent turns" (`app-server-protocol/.../turn.rs`), so after at least one turn the thread holds them. `session/resume` calls `thread/resume` and builds the current model from `response.model` and `response.reasoningEffort` (`CodexAcpClient.ts:698-710`). [inferred] A selection made with `set_config_option` and never followed by a turn is lost with the adapter process; one followed by a turn is kept by the thread.

### 2.4 Cursor (`cursor-agent` 2026.11.13-eacade1)

`initialize` [observed]: no `agentInfo`; `sessionCapabilities: { list: {} }` (**no `resume`, no `options`, no `close`/`delete`**); `loadSession: true`; `authMethods: ["cursor_login"]`. Clowdy therefore resumes Cursor with `session/load` (history replay) [inferred from `session.ts:317-338`].

**Effort is not part of an id in ACP; it is a parameter of a model family.** Cursor has three views of the same catalog, all [observed]:

1. `cursor-agent --list-models` (what `ModelCatalog` parses): 280 `id - Name` lines, each a flattened variant (`claude-opus-5-5-high-fast`, `gpt-5.5-extra-high`, `claude-opus-5-thinking-medium`); plain text; header `Available models`, trailing tip. `auto - Auto (current, default)`. The tip line says: "Parameterized models also accept quoted overrides, e.g. `--model 'claude-opus-4-8[context=1m,effort=high,fast=false]'`." (`cursor-agent --help` prints the same bracket form under `--model`; the web docs page `cli/reference/parameters` says only "Model to use".)
2. ACP vendor method `cursor/list_available_models` (no session, after `initialize`, about 3.1 to 3.2 s): `{ models: [{ value, name, configOptions: [...] }] }`, 48 families. Each `configOptions` entry is a normal ACP select with `id`, `category`, `currentValue`, `options`. Full table below.
3. ACP `session/new`: `modes` (`agent`, `plan`, `ask`), legacy `models`, `configOptions`. Two shapes depending on the client capability:
   - **Without `_meta.parameterizedModelPicker`** (what Clowdy sends today) [observed]: `mode` plus `model` (category `model`, 48 values, current `default[]`). Each value is a family with its **default parameters in brackets**: `default[]`, `grok-4.7[context=256k,reasoning_effort=high,fast=true]`, `claude-opus-5-5[context=300k,effort=medium,fast=false]`, `gpt-5.5[context=272k,reasoning=medium,fast=false]`; the option `name` is the bare family slug (`claude-opus-5-5`), `Auto` for the first. No effort option exists at session level. `session/set_config_option model` accepted each of the 48 listed values (about 0.6 to 1 s each) and **rejected** `claude-opus-5-5[context=300k,effort=low,fast=false]` (listed default is `effort=medium`) with `Invalid params`. So in this mode only the 48 listed strings are accepted and effort cannot be chosen through ACP.
   - **With `_meta.parameterizedModelPicker: true`** [observed]: `model` values are the 48 bare family ids (`default`, `grok-4.7`, `claude-opus-5-5`, ...; names `Auto`, `Grok 4.7`, `Claude Opus 5.5`); legacy `models.currentModelId` is `default`. `session/set_config_option model = claude-opus-5-5` returned the full list with new options `context` (model_config, current `300k`), `effort` (thought_level, current `medium`, values low..max), `fast` (model_config, `false`); `set_config_option effort = low` was accepted and echoed `low`. Restoring `default` removed them. **[not run]** whether the runtime honors this (no prompt sent). Forum reports summarized in `.briefback/agent-accounts/research/models.md` say model switching over ACP does not reliably change the backend; I did not reproduce or refute that.

The option **ids and values differ per model**, so "the effort option" cannot be found by id:

| Family (`value`) | Name | Effort-like option (id: values, default) | Other options |
| --- | --- | --- | --- |
| `default` | Auto | (none) | - |
| `grok-4.7` | Grok 4.7 | `reasoning_effort`: low, medium, high, xhigh (default `high`) | `context` (model_config): 256k, 500k (default `256k`); `fast` (model_config): false, true (default `true`) |
| `grok-4.6` | Grok 4.6 | `effort`: low, medium, high, xhigh (default `high`) | `fast` (model_config): false, true (default `true`) |
| `composer-2.5` | Composer 2.5 | (none) | `fast` (model_config): false, true (default `true`) |
| `claude-opus-5-5` | Claude Opus 5.5 | `effort`: low, medium, high, xhigh, max (default `medium`) | `context`: 300k, 1m (default `300k`); `fast`: false, true (default `false`) |
| `claude-opus-5` | Claude Opus 5 | `effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m; `fast`: false, true (default `false`) |
| `claude-opus-4-8` | Claude Opus 4.8 | `effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m; `fast`: false, true (default `false`) |
| `gemini-4-carbon` | Gemini 4 Carbon | `reasoning_effort`: low, medium, high (default `medium`) | - |
| `gemini-4-hydrogen` | Gemini 4 Hydrogen | `reasoning_effort`: low, medium, high, xhigh (default `high`) | - |
| `gemini-4-argon` | Gemini 4 Argon | `reasoning_effort`: low, medium, high (default `medium`) | - |
| `muse-wonder-1.0` | Muse Wonder | `reasoning_effort`: minimal, low, medium, high, xhigh, max (default `high`) | `context`: 300k, 1m |
| `gpt-5.6-sol` | GPT-5.6 Sol | `reasoning`: none, low, medium, high, xhigh, max (default `medium`) | `context`: 272k, 1m; `fast`: false, true (default `false`) |
| `gpt-5.5` | GPT-5.5 | `reasoning`: none, low, medium, high, extra-high (default `medium`) | `context`: 272k, 1m; `fast`: false, true (default `false`) |
| `claude-fable-5-2` | Claude Fable 5.2 | `effort`: low, medium, high, xhigh, max (default `high`) | `context`: 300k, 1m; `fast`: false, true (default `false`) |
| `claude-fable-5-1` | Claude Fable 5.1 | `effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m |
| `claude-fable-5` | Claude Fable 5 | `effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m |
| `grok-4.5` | Grok 4.5 | `effort`: low, medium, high (default `high`) | `fast`: false, true (default `true`) |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `reasoning_effort`: low, medium, high (default `high`) | - |
| `muse-spark-1.3` | Muse Spark 1.3 | `effort`: minimal, low, medium, high, xhigh, max (default `high`) | `context`: 300k, 1m |
| `gpt-5.6-terra` | GPT-5.6 Terra | `reasoning`: none, low, medium, high, xhigh, max (default `medium`) | `context`: 272k, 1m; `fast`: false, true (default `false`) |
| `claude-sonnet-5-5` | Claude Sonnet 5.5 | `reasoning_effort`: low, medium, high, xhigh, max (default `high`) | `context`: 300k, 1m |
| `claude-sonnet-5` | Claude Sonnet 5 | `effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `effort`: low, medium, high, max (default `medium`) | `thinking` (thought_level): false, true (default `true`); `context`: 200k, 1m |
| `gpt-5.3-codex` | Codex 5.3 | `reasoning`: low, medium, high, extra-high (default `medium`) | `fast`: false, true (default `false`) |
| `claude-opus-4-7` | Claude Opus 4.7 | `effort`: low, medium, high, xhigh, max (default `xhigh`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m; `fast`: false, true (default `false`) |
| `gpt-5.4` | GPT-5.4 | `reasoning`: none, low, medium, high, extra-high (default `medium`) | `context`: 272k, 1m; `fast`: false, true (default `false`) |
| `claude-opus-4-6` | Claude Opus 4.6 | `effort`: low, medium, high, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 200k, 1m |
| `claude-opus-4-5` | Claude Opus 4.5 | (none) | `thinking` (thought_level): false, true (default `true`) |
| `gpt-5.2` | GPT-5.2 | `reasoning`: low, medium, high, extra-high (default `medium`) | `fast`: false, true (default `false`) |
| `gpt-5.6-luna` | GPT-5.6 Luna | `reasoning`: none, low, medium, high, xhigh, max (default `medium`) | `context`: 272k, 1m; `fast`: false, true (default `false`) |
| `gemini-3.1-pro` | Gemini 3.1 Pro | (none) | - |
| `gpt-5.4-mini` | GPT-5.4 Mini | `reasoning`: none, low, medium, high, xhigh (default `medium`) | - |
| `gpt-5.4-nano` | GPT-5.4 Nano | `reasoning`: none, low, medium, high, xhigh (default `medium`) | - |
| `claude-haiku-5-5` | Claude Haiku 5.5 | `reasoning_effort`: low, medium, high, xhigh, max (default `high`) | `thinking` (thought_level): false, true (default `true`); `context`: 300k, 1m |
| `claude-haiku-4-5` | Claude Haiku 4.5 | (none) | `thinking` (thought_level): false, true (default `true`) |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | (none) | `thinking` (thought_level): false, true (default `true`) |
| `gpt-5.1` | GPT-5.1 | `reasoning`: low, medium, high (default `medium`) | - |
| `gemini-3-flash` | Gemini 3 Flash | (none) | - |
| `gemini-3.5-flash` | Gemini 3.5 Flash | (none) | - |
| `claude-sonnet-4` | Claude Sonnet 4 | (none) | `thinking` (thought_level): false, true (default `false`) |
| `gpt-5-mini` | GPT-5 Mini | (none) | - |
| `gemini-2.5-flash` | Gemini 2.5 Flash | (none) | - |
| `kimi-k3` | Kimi K3 | `reasoning`: low, high, max (default `max`) | - |
| `kimi-k2.7-code` | Kimi K2.7 Code | (none) | - |
| `glm-5.2` | GLM 5.2 | `reasoning`: high, max (default `high`) | - |
| `glm-5p3` | GLM 5.3 | `reasoning`: low, high, max (default `high`) | - |
| `glm-5p3-flash` | GLM 5.3 Flash | `reasoning`: low, high, max (default `high`) | - |
| `deepseek-v41-flash-1017` | DeepSeek V4.1 Flash 1017 | `reasoning_effort`: none, low, medium, high, max (default `high`) | - |

Observed spellings to note: the top level is `xhigh` in most families but `extra-high` in the GPT-5.5/5.4/5.2/Codex 5.3 families (the flattened `--list-models` ids say `extra-high` for gpt-5.5 and `xhigh` for gpt-5.6, matching); `none` and `minimal` exist as levels; `thinking` is a separate thought-level boolean with string values `"true"`/`"false"`; booleans of `fast` are strings too.

**How each is set**

- Launch: `cursor-agent --model <id|family[param=value,...]>` (help text). Whether `cursor-agent --model ... acp` is honored by the ACP mode is **[not run]** (Clowdy launches `cursor-agent acp` with no model flag, `catalog.ts:107-111`).
- In session: `session/set_config_option` as above, per capability shape. No initial `configOptions` route (no `options` capability).
- Mid-session: the ACP calls are accepted; the runtime effect is **[not run]** (forum reports of silent non-switching, see `models.md`).
- Survives resume: **[not run]**. Clowdy would resume Cursor with `session/load`; the docs page for `--resume` does not say whether the model is kept.

### 2.5 Summary of how each is set

| | Claude 0.107.0 | Codex 2.6.0 | Cursor 2026.11.13 |
| --- | --- | --- | --- |
| Model option id / category | `model` / `model` | `model` / `model` | `model` / `model` (values per capability shape) |
| Effort option id / category | `effort` / `thought_level` (fixed id) | `reasoning_effort` / `thought_level` (fixed id) | varies per model: `effort`, `reasoning_effort`, `reasoning`; plus `thinking`; all `thought_level`; appears only after a model is selected, and only with `parameterizedModelPicker` |
| Other model-related options | `fast`, `ultracode` (`model_config`) | `fast-mode` (`model_config`), `collaboration_mode` | `context`, `fast` (`model_config`), `thinking` |
| Set after setup | `session/set_config_option` | `session/set_config_option`; legacy `session/set_model "id[effort]"` | `session/set_config_option` |
| Set at setup | initial `configOptions` on new/resume/load [observed on new]; `_meta.claudeCode.options.{model,effort}` [code only]; env/settings | none (initial `configOptions` ignored); `config.toml` | none over ACP; `--model` flag at launch |
| Change mid-session | live | applied on next `turn/start` | accepted, effect not verified |
| Kept by the vendor across a new process | model: yes (transcript, unless settings/env override). effort: no | model and effort: yes after a turn ran with them (thread); not before | not verified |
| Value list source before a session | `list_models` control request (already used) | `model/list` (already used) | `cursor/list_available_models` (not used), `--list-models` (used) |

---

## 3. Probe notes (timings and raw shapes)

Times are wall clock on this machine, adapters already in bun's cache.

| Agent | `initialize` | session-free list | `session/new` |
| --- | --- | --- | --- |
| Claude | 0.49 s | `session/options` 0.95 s | 0.38 s |
| Codex | 0.56 s | - | 1.47 s |
| Cursor | 0.36 to 0.40 s | `cursor/list_available_models` 3.1 to 3.2 s | 0.64 to 0.70 s |

Claude `session/new` took 0.38 s here because the `claude` CLI was already warm after `session/options` in the same adapter process.

Codex legacy `models.availableModels` has one entry per model and effort (58), `modelId: "<Model.id>[<effort>]"`, `name: "6.2 Sol (low)"`. Cursor legacy `models` mirrors the `model` option in both shapes.

---

## 4. `AgentModel` today versus what the sources can give

`AgentModel` (`packages/protocol/src/agents.ts`): `id`, `name`, `description?`, `isDefault?`, `resolvedId?`, `efforts?: string[]`, `defaultEffort?`, `supportsFast?`. `AgentModels`: `state: 'ok' | 'unavailable' | 'error'`, `models`, `fetchedAt?`, `detail?`. Route: `GET /v1/agents/:id/models` (`http/routes.ts:204-211`), built by `ModelCatalog` (`providers/models.ts`), cached 10 minutes.

It **does** carry reasoning levels, as bare strings per model, for Claude and Codex, and not for Cursor.

| Agent | What `ModelCatalog` fills | What the source also has | Gap |
| --- | --- | --- | --- |
| Claude (`parseClaudeModels`) | `id` = `value` alias, `name`, `description`, `isDefault` (only the row `default`), `resolvedId`, `efforts` (from `supportedEffortLevels` when `supportsEffort`), `supportsFast` | `supportsAdaptiveThinking`, `supportsAutoMode`, `supportsThinkingOff`; no default effort in the row; the adapter's `ultracode` availability (not in the row); effort labels (adapter: title-cased id, plus `Default`) | no `defaultEffort` for Claude; no thinking/auto/ultracode flags; `isDefault` marks the row `default`, while the session actually starts on the user's settings model (`sonnet` here) and settings effort, which `AgentModels` does not give |
| Codex (`codexModel`) | `id` (= `Model.id`), `name`, `description`, `isDefault`, `efforts` (values only), `defaultEffort`, `supportsFast` (a `priority` tier), hidden rows dropped | per-effort `description` text, `serviceTiers[{id,name,description}]`, `model` slug, `inputModalities`, `upgrade`/`upgradeInfo`, `additionalSpeedTiers` | effort descriptions dropped; `isDefault` is the catalog default (`gpt-6.2-sol`), while the session starts on the user's `config.toml` model and effort (`gpt-6-sol`, `high`) |
| Cursor (`parseCursorModels`) | one row per **variant** from `--list-models` (280 rows): `id` = variant slug, `name`, `isDefault` (`auto`) | `cursor/list_available_models`: 48 families, each with typed `configOptions` (effort-like option id, values, default; `thinking`; `context`; `fast`) | no `efforts`, `defaultEffort`, `supportsFast` for any Cursor row; ids are variant slugs that equal neither an ACP `model` option value (`family[...]` or bare family) nor its `name` except for bare family slugs; no model-family/parameter structure; `thinking` and `context` have no field |

Other facts about the `id` space [observed]:
- Claude `id` = alias (`opus`) = the ACP `model` option value. `resolvedId` is `claude-opus-5-5`; the ACP list also offers the versioned rows (`claude-opus-5`, ...) as separate values.
- Codex `id` = the ACP `model` option value = `turn/start.model`.
- Cursor `id` from `--list-models` (`claude-opus-5-5-high`) ≠ ACP value (`claude-opus-5-5[context=300k,effort=medium,fast=false]` or `claude-opus-5-5`). `modelChoice` matches value or **name**; the name of a non-picker option is the bare family slug, so `claude-opus-5-5` matches and `claude-opus-5-5-high` does not.
- `ModelCatalog` has no per-effort `name`/`description` and no notion of "which effort option id does the adapter use", which the ACP side needs (fixed for Claude and Codex, per model for Cursor).

---

## 5. Gaps in the daemon and protocol for "a chat is bound to provider X; model and effort selectable"

Plain facts, no design.

**Stored fields that do not exist**
- `Chat` and table `chats`: no engine, model, or effort. The orchestrator run row has `engine` and `model`, no effort. `Run` (`domain.ts`), `runs` table (a new migration would be v5; the last is v4), `NewRun`, `SpawnInput`, `EngineStartOptions`, `ProjectSettings`, `run_spawn` input: no effort field anywhere.
- A draft chat (before the first message) has no run, so nowhere to hold a selection except the client or a new chat field.
- No field links a chat to another chat (for a hand-off); `chat_task_links` links chats to tasks only. `chat.create` takes `{projectId, title?, mode?}`.

**Commands that do not exist or lack the argument**
- `chat.create` and `chat.send` carry no engine, model or effort. No command changes a run's `model` or `engine` or a chat's selection after the fact. `project.update` sets project-wide engine and model only. `task.start` takes `engine` but not `model`.
- `GET /v1/agents/:id/models` exists; nothing validates a stored `model` against it (`createRun` takes any string, `modelChoice` only warns when it cannot match).

**Where a value is applied today, and what is missing there**
- `RunDriver.turn` → `engine.start({ ..., model: run.model })` (`runs/driver.ts:327-336`) reads the run row once per turn.
- `AcpSession.talk` applies the model with `modelChoice` after setup, by first `model`-category option; no code applies effort, `fast`, `thinking`, `context`. Effort needs: the option id per agent (Claude `effort`, Codex `reasoning_effort`, Cursor per model and only after selecting the model), applied after the model (options are rebuilt after a model switch; `applyInitialConfigOptions` on Claude documents list-order dependence), and a value the new model supports (Claude and Codex drop or refuse an unsupported one).
- Every turn is a fresh agent process and a resume. Vendor-side persistence differs (section 2.5), so the model and effort would have to be applied at the start of every turn to be sure; a failed resume silently starts a new vendor session (`session.ts:340-347`).
- No way to change either inside a live session: `EngineSession` is `send`/`close`; a message to a running orchestrator goes to `session.send` and becomes the next `session/prompt` of the same process.
- Spawned children: model falls to the project setting, not the parent's (`driver.ts:145-146`); engine is the parent's. Native sub-agents copy both.
- Client capabilities (`session.ts:289`, `probe.ts:65`) lack `session.configOptions.boolean`, AIR `recommendedValue` and `_meta.parameterizedModelPicker`. Their absence is what makes Claude add `default` to `effort` and `Default (recommended)` to `model`, makes `fast`/`ultracode` selects, and makes Cursor show bracketed family values with no effort option.
- `probeAgent` and `bun run probe` print option ids and categories only (`probe.ts:81`), not values.

**Constraints that came out of the probes** (facts, not choices)
- Claude: the session starts on the user's settings `model`/`effortLevel`/`modelSettings`, which win over the transcript on resume. A model switch can move the permission mode from Auto to Accept edits and emits a visible notice. `max` effort is session-only. Effort levels per model differ (Opus 4.6 and Sonnet 4.6 lack `xhigh`; Haiku 4.5 has none).
- Codex: effort levels per model differ (`ultra` on 8 of 10 models, not on `gpt-6-luna` and `gpt-5.6-luna`); switching model keeps the effort if supported, else the model's default; the session starts on `config.toml` values. `fast-mode` is an option of its own.
- Cursor: effort lives in a per-family option whose id and value spelling vary; the ACP `model` list (48 families) and `--list-models` (280 variants) are different shapes; effort can be selected over ACP only with the picker capability and only after a model is selected; whether it takes effect is not verified; resume is `session/load`.
- Provider-side lists depend on account, plan, settings and CLI version (models.md has the per-agent notes), and the `ModelCatalog` cache is 10 minutes.

## 6. Open items I could not settle here

- Whether Claude's `_meta.claudeCode.options.effort` or `.model` at `session/resume` changes a resumed session (code read, not run).
- Real resume behavior of model and effort for all three (no prompt allowed, so no transcript/rollout/chat to resume).
- Whether Cursor honors `session/set_config_option` effort, `thinking` and `context` at runtime, and whether `cursor-agent --model '<family>[...]' acp` is accepted.
- Whether `session/options` support is coming to Codex (2.6.0 and 2.7.x have none) or Cursor (not advertised).
- The meaning of Cursor's boolean-like `thinking` option for models where it defaults to `false` (`claude-sonnet-4`) and how it interacts with `effort`.
