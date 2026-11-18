# Model and effort across a resumed session: real turns on all three ACP agents

Snapshot 2026-11-18. Verification of the open items of `session-model-effort.md` section 6, with real one-word turns on the owner's own subscriptions. Facts only, no design.

Tags: **[observed]** printed by a probe I ran, or read in a file the agent wrote for my own throwaway session; **[inferred]** my reading of observed facts; **[not run]** not checked.

## Versions and method

| Item | Version |
| --- | --- |
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 (Clowdy's pin), driving `claude` 2.1.322 |
| `@agentclientprotocol/codex-acp` | 2.6.0 (Clowdy's pin), driving `codex-cli` 0.166.0 (the rollout's `cli_version`) |
| `cursor-agent` | 2026.11.13-eacade1 |
| `@agentclientprotocol/sdk` | 2.7.0 (`/unstable` client, as the daemon uses it) |

Harness: `scratchpad/verify/run.ts` (`/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/3d1c8519-767b-480f-8ec2-cf732f8ec938/scratchpad/verify/`). It starts the agent with the repo's own `AgentRegistry.resolve`, `buildAgentEnv` and `spawnInOwnGroup`, talks through the SDK client, and runs a JSON plan of steps in one process. **One `bun run.ts` invocation is one agent process**, so "resume in a new process" is a second invocation, as Clowdy starts one process per turn. Plans are in `plans/`, raw outputs in `out/*.log`. Every session used a throwaway cwd under that folder (`cwd/claude`, `cwd/codex`, `cwd/cursor`). The permission handler answered `allow_once` (never asked). No credential store was read. Client capabilities were Clowdy's (`fs` off, `terminal` off) plus, for Cursor, `_meta.parameterizedModelPicker: true` where marked "picker".

Evidence of what actually ran came from files and fields the agent itself wrote, never from the model's own claim:

| Agent | Evidence used |
| --- | --- |
| Claude | the throwaway session's own transcript `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` (only that file; parsed for `api-request.params.model`, `params.output_config.effort`, and the `assistant` record's `message.model`, `requestedModel`, `effort`, `perTurnEffort`); live: `PromptResponse._meta.quota.model_usage[].model` and `usage_update._meta["_claude/model"]` |
| Codex | the throwaway thread's own rollout `~/.codex/sessions/2026/11/18/rollout-...-<threadId>.jsonl` (only that file; `turn_context.model`, `.effort`); live: `PromptResponse._meta.quota.model_usage[].model` |
| Cursor | the session's own `~/.cursor/acp-sessions/<sessionId>/store.db` (SQLite). I copied each of my sessions to `scratchpad/verify/cursor-store-*` and read the copy: assistant record `providerOptions.cursor.modelName`, and the model named in the system-prompt blob. The prompt response and updates carry no model or usage field |

## Prompt cost (real model calls)

14 prompts, all `Reply with the single word OK` except the three `/compact` ones. The owner's first limit was about 12 for sections A-D (11 used); section E (asked later) added 3.

| Agent | Prompts | Which |
| --- | --- | --- |
| Claude | 5 | claude-1 (new, haiku, low), claude-2 (plain resume), claude-3 (resume with `configOptions`), claude-4 (resume with `_meta`), claude-compact |
| Codex | 4 | codex-1 (new, luna, low), codex-2 (plain resume), codex-3 (resume plus `set_config_option`), codex-compact |
| Cursor | 5 | cursor-1 (gemini low), cursor-2 (nano xhigh), cursor-3 (`session/load` plain), cursor-4 (launch flag), cursor-compact |

Everything else (the unprompted Codex case, all "settle" runs, option listings, the restore of Cursor's default) cost no prompt.

---

## A. Claude (`claude-agent-acp` 0.107.0)

`initialize` [observed]: `sessionCapabilities` has `resume` and `options`; `loadSession: true`. So Clowdy resumes with `session/resume`.

The user's own settings start every session on `model: sonnet`, effort `xhigh` (same as the earlier note). I chose `haiku` and `low` so each result differs from the start values.

### A1. Set model and effort, one turn, new process, resume

Process 1 (`claude-1`): `session/new`, then in this order:

```
set_config_option model=haiku   -> current: model haiku, effort "default"   (the effort option was rebuilt for the new model; xhigh did not carry over)
set_config_option effort=low    -> current: model haiku, effort low
session/prompt "Reply with the single word OK" -> "OK", stopReason end_turn, 2.4 s
```

What ran [observed, transcript]: `api-request.params.model = claude-haiku-5-5`, `params.output_config.effort = low`; `assistant` record: `message.model = claude-haiku-5-5`, `requestedModel = claude-haiku-5-5`, `effort = low`, `perTurnEffort = low`. Live: `PromptResponse._meta.quota.model_usage[0].model = "claude-haiku-5-5"`, and both `usage_update` carried `_meta["_claude/model"] = "claude-haiku-5-5"`.

Process 2 (`claude-2`): `session/resume { sessionId, cwd, mcpServers: [], _meta: <Clowdy's sessionMeta> }`, nothing else. Response [observed]:

```
configOptions current values: mode auto, model sonnet, effort xhigh, ultracode off
```

**Neither model nor effort survives a resume.** They come back as the user's settings (`sonnet`, `xhigh`). A prompt sent right after (no re-apply) really ran on them [observed, transcript]: `api-request model = claude-sonnet-5-5`, `output_config.effort = xhigh`; `PromptResponse._meta.quota.model_usage[0].model = "claude-sonnet-5-5"`.

### A2. Initial values on `session/resume`

| Request | Response current values | What the next turn really ran (transcript) |
| --- | --- | --- |
| `configOptions: [{configId:"model",value:"haiku"},{configId:"effort",value:"low"}]` (`claude-3`) | model `haiku`, effort `low` | `claude-haiku-5-5`, effort `low` |
| `_meta.claudeCode.options: { disallowedTools, model: "haiku", effort: "low" }`, no `configOptions` (`claude-4`) | model `sonnet`, effort `low` | `claude-sonnet-5-5`, effort `low` |

- **`configOptions` on resume (capability `options`) applies model and effort**, in list order, and the turn used them. Request shape that worked: `{ configId, value }` entries (raw excerpt in `out/claude-3.log`).
- **`_meta.claudeCode.options.effort` applies at resume; `_meta.claudeCode.options.model` does nothing.** The response said `sonnet`/`low`, and the API request confirmed `claude-sonnet-5-5` with `output_config.effort = low`.

### A3. Which model answered

Answered above: transcript fields and `_meta.quota.model_usage[].model`. Also, after `set_config_option` the live `usage_update._meta["_claude/model"]` names the resolved model (`claude-haiku-5-5`, `claude-sonnet-5-5`).

### Claude timings [observed]

`initialize` 0.2-0.5 s; `session/new` 1.0-1.3 s; `session/resume` 0.6-1.3 s; `session/load` 0.46 s; `set_config_option` 22-27 ms; one-word prompt 1.0-2.4 s.

---

## B. Codex (`codex-acp` 2.6.0)

`initialize` [observed]: `sessionCapabilities` has `resume` and no `options`; `loadSession: true`.

Start values are the user's `config.toml`: `gpt-6-sol`, effort `high`. I chose `gpt-5.6-luna` and `low`.

### B1. Set model and effort, one turn, new process, resume

Process 1 (`codex-1`): `session/new`, then `set_config_option model=gpt-5.6-luna` (effort stayed `high`), `set_config_option reasoning_effort=low`, then the prompt (4.5 s).

What ran [observed]: rollout `turn_context { model: "gpt-5.6-luna", effort: "low" }`; `PromptResponse._meta.quota.model_usage[0].model = "gpt-5.6-luna"`.

Process 2 (`codex-2`): `session/resume { sessionId, cwd, mcpServers: [] }`. Response [observed]:

```
response keys: models, modes, configOptions          (no sessionId)
configOptions current values: mode agent, collaboration_mode default, model gpt-6-sol, reasoning_effort high, fast-mode off
models.currentModelId: "gpt-6-sol[high]"
```

**Neither survives a resume, even though a turn ran with them.** The prompt that followed ran on `gpt-6-sol`/`high` [observed, rollout]: second `turn_context { model: "gpt-6-sol", effort: "high" }`. This **contradicts** the inference in `session-model-effort.md` 2.3 ("one followed by a turn is kept by the thread"): `thread/resume` in this adapter ends on the user's `config.toml` values.

Codex says so itself: after the resume response the adapter sends an `agent_message_chunk` (before any prompt):

```
"Warning: This session was recorded with model `gpt-5.6-luna` but is resuming with `gpt-6-sol`. Consider switching back to `gpt-5.6-luna` as it may affect Codex performance.\n\n"
```

[inferred from `session.ts:243-246`] That update arrives after the resume response, when `current` is set, so Clowdy's mapper would show it as assistant text at the start of the turn (not run through Clowdy).

### B2. Initial `configOptions` on resume, then set after resume

`codex-3`: `session/resume` with `configOptions: [{model: gpt-5.6-luna},{reasoning_effort: low}]` [observed]: **ignored** (response: `gpt-6-sol`/`high`; no `options` capability). Then `set_config_option model=gpt-5.6-luna`, `set_config_option reasoning_effort=low` on the resumed session, prompt: the rollout's third `turn_context` is `gpt-5.6-luna`/`low`; `model_usage` says `gpt-5.6-luna`. So setting after resume works for the next turn, as Clowdy already does for the model.

### B3. Set effort, no prompt, close, resume

`codex-4`: `session/new` (id `01a1efdc-134d-...`), `set_config_option model=gpt-5.6-luna`, `set_config_option reasoning_effort=low` (both accepted), no prompt, process ended. `codex-5`: `session/resume` for that id [observed]:

```
(session/resume FAILED in 499 ms: Internal error {"details":"no rollout found for thread id 01a1efdc-134d-7923-8ec6-282a89f71277"})
```

No rollout file exists for that thread (`find ~/.codex/sessions -name "*<id>*"` is empty). So the unprompted case is not "effort lost": **the whole session is gone**, and `session/resume` of it errors. [inferred] Clowdy would log `could not continue session ...; starting a new one` and start a new thread, which starts on the `config.toml` values.

### Codex timings [observed]

`initialize` 0.2-0.55 s; `session/new` 0.46-1.06 s; `session/resume` 0.5-0.75 s; `session/load` 0.99 s; `set_config_option` 1-10 ms; one-word prompt 4.0-4.8 s.

---

## C. Cursor (`cursor-agent` 2026.11.13-eacade1)

`initialize` [observed]: `sessionCapabilities: { list: {} }`, `loadSession: true`, no `agentInfo`. Resume is `session/load`.

### C1. Does the runtime honour a model and effort set over ACP? Yes (with the picker capability)

| Run | Set over ACP | Family default effort | What ran (session store) |
| --- | --- | --- | --- |
| `cursor-1` | `model=gemini-3.8-flash` (the response added `reasoning_effort`, current `high`), `reasoning_effort=low` | `high` | assistant `providerOptions.cursor.modelName = "gemini-3.8-flash-low"`; system blob model `gemini-3.8-flash` |
| `cursor-2` | `model=gpt-5.4-nano` (option `reasoning`, current `medium`), `reasoning=xhigh` | `medium` | assistant `modelName = "gpt-5.4-nano-xhigh"`; system blob model `gpt-5.4-nano-xhigh`, prompt starts "You are GPT-5.4 Nano" |

**The runtime honours the model and the effort set through `session/set_config_option`; it does not silently keep its own.** Both the family and the effort level reached the turn. The effort option id differs per family (`reasoning_effort`, `reasoning`) and appears only after a model other than `default` is selected; setting the model resets the effort to the family's default.

Nothing else says what ran: `PromptResponse` is `{ "stopReason": "end_turn" }`, no `usage`, no `_meta`; the updates are `session_info_update` (title), `agent_message_chunk`, sometimes `agent_thought_chunk`, `available_commands_update`.

### C2. Resume by `session/load` in a new process: the session's own values do not survive; a process-global last selection wins

**Cursor keeps the last selection across processes, outside the session.**

- `cursor-1` `session/new` started on model `default` (before any of my sets).
- `cursor-2`, a new process, `session/new` **started on `gemini-3.8-flash`/`low`**, i.e. what `cursor-1` had set and not undone.
- `cursor-3` (picker): `session/load` of the `cursor-1` session, no re-apply. Response current values: model `gpt-5.4-nano`, `reasoning` `xhigh` (what `cursor-2` had set last), **not** the session's own `gemini-3.8-flash`/`low`. The prompt that followed ran on `gpt-5.4-nano-xhigh` [observed, store of the first session: second assistant record `modelName = "gpt-5.4-nano-xhigh"`; the system blob changed from the Gemini prompt to "You are GPT-5.4 Nano"].
- `cursor-compact`: `session/load` of the `cursor-4` session (its turn had run on `gemini-3.8-flash-medium`) reported `gemini-3.8-flash`/`high` and the next turn ran `gemini-3.8-flash-high`.

So after `session/load` neither model nor effort of the session is restored; the new process starts from the last model selected by any process. [inferred] Where it is stored: not read. `~/.cursor/acp-config.json` is `{}` (its mtime moved during my runs); `~/.cursor/cli-config.json` mtime moved too (I did not open it, and the user's own `cursor-agent` processes were running). Observable proof of a global effect: `cursor-agent --list-models` lost the `(current)` marker on `auto` after my runs (no line had it), and showed `auto - Auto (current, default)` again after I set `model=default` over ACP (see side effects).

**So `session/set_config_option` over ACP changes the user's own Cursor default model**, not only the session's.

### C3. Launch flag `cursor-agent --model '<family>[effort=low]' acp`: accepted

`cursor-4` started `cursor-agent --model 'gemini-3.8-flash[reasoning_effort=medium]' acp` (picker). [observed] No error. `session/new` reported `model gemini-3.8-flash`, `reasoning_effort medium` without any `set_config_option`, and the turn ran `modelName = "gemini-3.8-flash-medium"`. Note the param key for that family is `reasoning_effort` (the help's `effort=` example is Opus's key). Afterwards the persisted default read `gemini-3.8-flash` with effort `high` (see C2), so the flag also moved the persisted family; [inferred] attribution to the flag run, because the user's own processes were running.

### C4. Non-picker view (what Clowdy sends today)

`cursor-e-new-plain` / `cursor-e-load-plain` (no picker capability) [observed]: `model` current value is a bracketed string, e.g. `gemini-3.8-flash[reasoning_effort=high]`, drawn from the 48 listed defaults; no effort option. The effort of a session is not visible there even when it is not the default.

### Cursor timings [observed]

`initialize` 0.35-0.41 s; `session/new` 3.3-3.9 s; `session/load` 2.9-3.5 s; `set_config_option` 0.67-1.05 s; one-word prompt 2.1-3.7 s (13 s once with a thought chunk).

---

## D. After resume/load: does the adapter report model and effort, and where

| Agent | Method | Response keys | Model path | Effort path | Other |
| --- | --- | --- | --- | --- | --- |
| Claude | `session/resume`, `session/load`, `session/new` | `sessionId, modes, configOptions` | `configOptions[?(@.id=="model")].currentValue` (`"sonnet"`) | `configOptions[?(@.id=="effort")].currentValue` (`"xhigh"`; `"default"` after a model switch) | no legacy `models`; `modes.currentModeId` |
| Codex | `session/resume`, `session/load` | `models, modes, configOptions` (no `sessionId` on resume) | `configOptions[?(@.id=="model")].currentValue` (`"gpt-6-sol"`) | `configOptions[?(@.id=="reasoning_effort")].currentValue` (`"high"`) | legacy `models.currentModelId = "gpt-6-sol[high]"` (`<model>[<effort>]`); values are `config.toml`'s, not the thread's last turn |
| Cursor | `session/load` (picker) | `modes, models, configOptions` (no `sessionId`) | `configOptions[?(@.id=="model")].currentValue` (`"default"`, or the family) | `configOptions[?(@.id=="reasoning_effort"|"reasoning"|"effort")].currentValue`, only when a non-`default` family is current | legacy `models.currentModelId`; non-picker: model value is `family[params]`; values are the process-global last selection |

Raw excerpts (options cut to 2 entries) [observed, `out/claude-raw.log`, `out/codex-raw.log`, `out/cursor-raw.log`]:

```json
{ "id": "model",  "name": "Model",  "description": "AI model to use", "category": "model",
  "type": "select", "currentValue": "sonnet",
  "options": [ { "value": "default", "name": "Default (recommended)", "description": "Opus 5.5" }, { "value": "opus", "name": "Opus 5.5" }, "... 14 entries" ] }
{ "id": "effort", "name": "Effort", "description": "Available effort levels for this model", "category": "thought_level",
  "type": "select", "currentValue": "xhigh", "options": [ { "value": "default", "name": "Default" }, { "value": "low", "name": "Low" }, "... 6 entries" ] }
```
```json
{ "id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select", "currentValue": "high",
  "options": [ { "value": "low", "name": "Low" }, { "value": "medium", "name": "Medium" }, "... 6 entries" ] }
"models": { "currentModelId": "gpt-6-sol[high]", "availableModels": "58 entries" }
```
```json
{ "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "default",
  "options": [ { "value": "default", "name": "Auto" }, { "value": "grok-4.7", "name": "Grok 4.7" }, "... 48 entries" ] }
```

None of the three reports the values of the session's last turn. Claude reports the user's settings (or what `configOptions` on resume set), Codex the `config.toml`, Cursor the process-global last selection.

## Summary table (A-D)

| Question | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Model and effort set with `set_config_option` reach the turn | yes | yes | yes (family and effort level; picker capability) |
| Survive a new process + resume/load | no (settings win) | no (`config.toml` wins), even after a turn | no (process-global last selection wins) |
| Set at resume through the protocol | `configOptions` on `session/resume`: yes. `_meta.claudeCode.options.effort`: yes, `.model`: no | initial `configOptions`: ignored; only `set_config_option` after resume | no initial route; `set_config_option` after load; or launch flag `--model` |
| Evidence of the model that ran | transcript, `_meta.quota.model_usage`, `usage_update._meta["_claude/model"]` | rollout `turn_context`, `_meta.quota.model_usage` | session `store.db` only |
| Set effort, no prompt, close, resume | not run (a never-prompted Claude session has no transcript) | session gone: `no rollout found for thread id` | not run |
| Changes the user's own defaults | no (`settings.json` mtime unchanged) | no (`config.toml` mtime unchanged) | **yes**: Cursor's persisted default model changed (restored) |

---

## E. Context usage ring (`usage_update { used, size }`)

### E1. During and after a one-word turn

**Claude** [observed]: sends `usage_update` several times per turn, with `used` equal to `PromptResponse.usage.totalTokens`:

```json
{ "sessionUpdate": "usage_update", "used": 21269, "size": 1000000,
  "_meta": { "_claude/rateLimit": { "status": "allowed", "resetsAt": 1795032000, "rateLimitType": "five_hour", "overageStatus": "rejected", "overageDisabledReason": "org_level_disabled", "isUsingOverage": false, "unifiedWindows": { "five_hour": { "utilization": 0.36, "resetsAt": 1795032000, "status": "allowed" }, "seven_day": { "utilization": 0.26, "resetsAt": 1795532400, "status": "allowed" } } },
             "_claude/model": "claude-haiku-5-5" } }
{ "sessionUpdate": "usage_update", "used": 21269, "size": 1000000, "cost": { "amount": 0.0043791, "currency": "USD" },
  "_meta": { "_claude/origin": { "kind": "human" }, "_claude/model": "claude-haiku-5-5" } }
```

`_meta` keys seen: `_claude/rateLimit`, `_claude/model`, `_claude/origin`. `size` was 1000000 for haiku and sonnet here (the long-context setting is on by default in Clowdy's catalog, not checked for this account).

**Codex** [observed]: one `usage_update` per turn, no `_meta`, no `cost`:

```json
{ "sessionUpdate": "usage_update", "used": 18948, "size": 258400 }
```

**Cursor** [observed]: **sends no `usage_update` at all**: not in any of the 5 turns, not after `session/new`, not after `session/load` (checked with a 2.5-3.5 s settle window), not after `/compact`.

### E2. Before any prompt (could a ring show when a chat opens)?

Measured with a settle window of 3.5 s after the response (`out/*-e-*.log`), updates that came from the request start until then:

| Agent | `session/new` | `session/resume` | `session/load` |
| --- | --- | --- | --- |
| Claude | none; only `available_commands_update` (65 commands), after the response | none (commands only) | none (replay chunks: 4 user, 4 agent; plus commands) |
| Codex | none (commands only) | **yes**: `session_info_update`, `usage_update { used: 41503, size: 258400 }`, the model warning chunk (B1), commands, all after the response | **yes**: `usage_update { used: 41503, size: 258400 }` among the replayed history (3 user, 4 agent chunks, 2 `session_info_update`) |
| Cursor | none | n/a (no resume) | none (replay: 2 user, 2 agent chunks; commands) |

So only Codex lets a ring show on opening an existing chat. In Clowdy's `session.ts` the `usage_update`s of a `resume` arrive after the response, so they would reach the mapper (for `load`, `replaying` swallows them) [inferred from `session.ts:243-246, 321-349`].

### E3. After resume, is `used` the whole conversation or the new turn?

**The whole context window fill, not the turn.** [observed]

| Agent | Sequence of `used` over turns |
| --- | --- |
| Claude (same session, 4 turns, models alternating haiku/sonnet) | 21269, 21491, 21731, 21953 (each +222..+240 for a one-word turn; the first value is mostly system prompt and tools: `cachedWriteTokens` 21263) |
| Codex (same thread; luna, then sol, then luna) | 18948, 29996, 41503 (the resumed `gpt-6-sol` turn had 29991 input tokens and no cache) |

The one-word turn's own text is about 10 tokens, so `used` cannot be the turn alone. `used` is the last model call's total (input including cache plus output). [inferred] It also follows the model, because each model has its own prompt and tokenizer: Codex's value jumped when the model changed.

### E4. `/compact` as a `session/prompt` (one extra prompt per agent)

| | Claude (`claude-compact`, session of A, resumed on haiku/low) | Codex (`codex-compact`, thread of B, resumed, luna/low) | Cursor (`cursor-compact`, session `cursor-4`) |
| --- | --- | --- | --- |
| Advertised as a command | yes (`compact`) | yes (`compact`) | **no** (40 commands, none about compaction) |
| `session/update` kinds | `tool_call` "Compact conversation" (`kind: think`, `in_progress`, `_meta.claudeCode.toolName: "compact"`), `tool_call_update` completed, `tool_call_update` with `rawOutput`, `available_commands_update`, `usage_update` | `session_info_update` (active), `tool_call` "Compact conversation" (`kind: think`), `usage_update`, `tool_call_update` completed, `session_info_update` (idle) | `agent_thought_chunk`, `agent_message_chunk` (the text went to the model as an ordinary message) |
| `usage_update.used` after | **22062 -> 6111**, `size` 1000000 | **41503 -> 21542**, `size` 258400 | none (no `usage_update` ever) |
| `stopReason` | `end_turn` | `end_turn` | `end_turn` |
| Response `usage` | zeros, `_meta.quota.model_usage: []` | `usage: null`, `_meta.quota.token_count: null`, `model_usage: []` | none |
| Time | 3.7 s | 4.8 s | 5.8 s |

Claude's compaction result [observed, raw]:

```json
{ "sessionUpdate": "tool_call_update", "toolCallId": "b78af222-...", "_meta": { "claudeCode": { "toolName": "compact" } },
  "rawOutput": { "trigger": "manual", "preTokens": 22062, "postTokens": 6111, "durationMs": 3632 } }
{ "sessionUpdate": "usage_update", "used": 6111, "size": 1000000, "_meta": { "_claude/rateLimit": { "...": "..." } } }
```

Nothing refused: both Claude and Codex had a conversation to compact. Neither shows a `compaction_update` or `notice` kind; compaction is a `tool_call`/`tool_call_update` pair. The compaction's own tokens are not in the prompt response of either. Cursor has no compaction command, so `/compact` is just text there.

---

## Corrections to `session-model-effort.md`

- 2.3 and 2.5: Codex "model and effort: yes after a turn ran with them (thread)" is wrong for 2.6.0 / 0.166.0: resume reports and uses the `config.toml` values (B1). A never-prompted thread cannot be resumed at all (B3).
- 2.2: `_meta.claudeCode.options.effort` is applied at resume, `.model` is not; `configOptions` on `session/resume` applies both (A2).
- 2.4 and section 6: Cursor runtime honours model and effort set over ACP (C1); the session does not keep them across `session/load`, and a set persists as Cursor's own default model (C2); the launch flag is accepted (C3).
- 2.2: after `set_config_option model`, Claude's effort becomes `default`, not the previous level (A1). Model first, then effort, as the note already said.

## Not verified

- A Claude `session/load` with a prompt (only `session/resume` turns were run; `load` was run without a prompt: it reports the same settings values).
- Cursor: whether the effort of a persisted selection is stored (the flag run left family `gemini-3.8-flash` with effort `high`, not the `medium` that ran); where the persistence lives (no read of `cli-config.json`); whether the global change also affects an already-running `cursor-agent` of the user.
- Cursor: set effort, no prompt, close, then load (not run; a never-prompted Cursor session does create an `acp-sessions` folder, but a load of it was not tried).
- The `thinking` and `context` options of Cursor families; `fast`/`ultracode` on Claude; `fast-mode` on Codex.
- Whether a Claude or Codex `/compact` appends a record to the transcript or rollout (not read after).
- Behaviour with a daemon-built client (`AcpSession`): I used the same registry, env, spawn and SDK client, but not `AcpSession` itself, so the `session.ts` consequences marked [inferred] are readings of its code.

## Side effects (honest list)

- **Sessions left in the vendors' histories, all titled by the one-word prompt:**
  - Claude: session `8f0b59d6-87ab-4c84-bb25-42482c30a351` (title "Single word reply"), 5 turns, one transcript file in `~/.claude/projects/-private-tmp-claude-501--Users-bionic-WORK-My--kachurun-clowdy-3d1c8519-767b-480f-8ec2-cf732f8ec938-scratchpad-verify-cwd-claude/`. Two never-prompted `session/new` calls (`f1b94fa9-...`, `ed5b949e-...`) left no transcript.
  - Codex: thread `01a1efdb-71ed-7351-b9b8-2728a5c8f976` (title "Reply with the single word OK"), 4 turns, rollout `~/.codex/sessions/2026/11/18/rollout-2026-11-18T15-11-38-01a1efdb-71ed-7351-b9b8-2728a5c8f976.jsonl`. Three never-prompted threads (`01a1efdb-5ecf-...`, `01a1efdc-134d-...`, `01a1efde-faeb-...`) left no rollout.
  - Cursor (no `session/delete`): 6 folders in `~/.cursor/acp-sessions/`: `b21b85fd-...`, `276db671-...`, `ad653ce0-...` (prompted, titled "Single Word OK"), and `b7d1fa60-...`, `54dcf00d-...`, `2a858387-...` (never prompted).
  - Claude and Codex advertise `session/delete`; I did not use it, so the owner can remove them there.
- **Cursor's persisted default model changed and was restored.** My `set_config_option` and launch-flag runs moved the model every new `cursor-agent` process starts on, and `cursor-agent --list-models` stopped marking `auto` as `(current)`. I set `model=default` over ACP (picker run `cursor-restore`); after that `cursor-agent --list-models` shows `auto - Auto (current, default)` again and a fresh session starts on `default` (`cursor-after-restore`). The earlier researcher's original value was also `default`. A user's open Cursor window or `cursor-agent` that read the global value in between would have seen the change (about 7 minutes, from the first `cursor-1` set to `cursor-restore`).
- **mtimes** (seconds since epoch; before is the earlier researcher's baseline file, after is at the end of my runs): `~/.claude/settings.json` 1794886624 unchanged; `~/.codex/config.toml` 1794365566 unchanged; `~/.claude.json` 1795018792 -> 1795025918 (the `claude` program writes it; not read); `~/.cursor/cli-config.json` 1795018609 -> 1795025954 (not read; the user's own cursor-agent processes were running, so not all of it is mine); `~/.cursor/acp-config.json` moved to 1795025892, content `{}` (I read it: two bytes).
- Copies of my own Cursor session stores in `scratchpad/verify/cursor-store-*` (each contains its own per-session key; not a credential of the account; not copied anywhere else).
- Every process I started was stopped (`ps` checked). The `cursor-agent` (pids 21698, 67059), `codex app-server` and Cursor-extension `claude` processes still listed belong to the user.
- No repo file was edited by me. `git status` showed modified daemon files at the end; they are not mine (the working tree was clean at my start per the session snapshot, so another process changed them while I worked). This document is the one file I wrote in the repo.
