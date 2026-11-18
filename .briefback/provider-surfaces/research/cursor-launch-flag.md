# Cursor's `--model` launch flag: what it does to the person's default, its spellings, and its limits

Snapshot 2026-11-18. Verification of the Cursor decision in `plan.md` ("A run selects Cursor's model and level at launch, `cursor-agent --model '<family>[<effortKey>=<level>]' acp`; the stage first checks that this leaves the person's own default alone"). Follows `session-verification.md` C1-C3. Facts only, no design.

Tags: **[observed]** printed by a probe I ran, or read in a file the agent wrote for my own throwaway session; **[inferred]** my reading of observed facts or of Cursor's own program code (not run); **[not verified]** not checked.

## Headline

1. **The flag does NOT leave the person's default alone.** The first `session/new` (or `session/load`) of a process started with `--model X` writes X as the model every later `cursor-agent` process starts on. `initialize` alone does not. Restored with ACP `set_config_option model=default` (picker run), as before. [observed]
2. **The bracket form must be the exact canonical string**: every option of the family, in the family's own order, nothing missing. A partial or re-ordered bracket is not defaulted: the process exits with code 1. The help's own example fails on this account. [observed]
3. **The level in the flag takes effect only when the client declares `parameterizedModelPicker`.** Without it the family is honoured and the level falls to the family's default. [observed, two families, one prompt each]
4. **`session/set_config_option model` sent by a client without the picker capability leaves a pin** that overrides the flag in later processes until a picker-mode process has read it. [observed + explained by Cursor's program code]

## Versions and method

| Item | Version |
| --- | --- |
| `cursor-agent` | 2026.11.13-eacade1 (the user's own long-running `cursor-agent` processes are 2026.11.13-eacade1 (pid 67059) and 2026.10.22-27dcf5f (pid 21698); not touched) |
| `@agentclientprotocol/sdk` | 2.7.0 (`/unstable` client), as `session-verification.md` |
| Bun | 1.4.4 |

Harness (all in `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/3d1c8519-767b-480f-8ec2-cf732f8ec938/scratchpad/verify/`, nothing in the repo or in `/tmp`):

- `probe.ts`: `run.ts` of the earlier research plus a timeout, an exit-status report and a raw `cursor/list_available_models` op. Starts the agent with the repo's `AgentRegistry`, `buildAgentEnv`, `spawnInOwnGroup`, as the daemon does. `--prefix --model --prefix '<value>'` puts the flag before `acp`; `--picker` adds client capability `_meta.parameterizedModelPicker: true`.
- `rawrun.ts`: raw JSON-RPC driver (initialize, then session/new) that captures the whole stderr and the exit status.
- `cursor-model.py` (earlier): copies my session's `~/.cursor/acp-sessions/<id>` and reads the copy.
- Plans, shell loops and all raw logs: `q/plans/`, `q/*.sh`, `q/out/*.log`, `q/out/q4-*.json`, `q/out/q4-*.stderr.txt`, `q/models.json` (raw model list), `q/list-models-*.txt`.
- Every session used a throwaway cwd under `scratchpad/verify/cwd/`. The permission handler answered `allow_once` (never asked). No credential store, no `~/.cursor/cli-config.json` and no `~/.cursor/acp-config.json` was read; I only read their mtimes. I did read Cursor's own program code (the `.js` bundle in `~/.local/share/cursor-agent/versions/2026.11.13-eacade1/`) to explain behaviour; those findings are tagged [inferred].
- Evidence of what ran, as in the earlier research: the session's own `store.db` (assistant record `providerOptions.cursor.modelName`, and the model named in the system blob). The prompt response carries no model.

## Prompt cost (real model calls)

6 prompts, all `Reply with the single word OK` (limit was about 8).

| # | Probe | Flag | Mode | Answers |
| --- | --- | --- | --- | --- |
| 1 | new + prompt (session `4d372600-...`) | `gemini-3.8-flash[reasoning_effort=low]` | picker | Q1, Q3 first half: ran `gemini-3.8-flash-low` |
| 2 | `session/load` of that session in a new process + prompt | `gpt-5.4-nano[reasoning=low]` | picker | Q3: ran `gpt-5.4-nano-low` |
| 3 | new + prompt, persisted default was `gpt-5.4-nano` low | `auto` | picker | Q2: ran Auto (`cursor-grok-4.5-high`) |
| 4 | new + prompt, with a pin left by a non-picker set | `gpt-5.4-nano[reasoning=low]` | non-picker | ran `gpt-5.4-nano-medium` |
| 5 | new + prompt, no pin | `gpt-5.4-nano[reasoning=low]` | non-picker | ran `gpt-5.4-nano-medium` |
| 6 | new + prompt, no pin | `gemini-3.8-flash[reasoning_effort=low]` | non-picker | ran `gemini-3.8-flash-high` |

Everything else (about 95 flagged launches, the model-list calls, the restores) cost no prompt: `session/new` and `session/set_config_option` are not model turns.

---

## Q1. Does the flag leave the person's default alone? No

Method [observed]: `cursor-agent --list-models` before and after; a plain `cursor-agent acp` (no flag) `session/new` before and after. Baseline before my first flagged launch:

```
$ cursor-agent --list-models        (row 3)
auto - Auto (current, default)
plain `cursor-agent acp` (picker), session/new: model "default"
```

Probe 1: `cursor-agent --model 'gemini-3.8-flash[reasoning_effort=low]' acp`, `initialize`, `session/new` (reported `gemini-3.8-flash`, `reasoning_effort low`), one prompt, process stopped. Afterwards:

```
$ cursor-agent --list-models        diff against the baseline: only row 3 changed
< auto - Auto (current, default)
> auto - Auto (default)             (no row anywhere carries "(current)")
plain `cursor-agent acp` (picker),     session/new: model "gemini-3.8-flash", reasoning_effort "low"
plain `cursor-agent acp` (no picker),  session/new: model "gemini-3.8-flash[reasoning_effort=high]"
```

So a process started with no flag, later, starts on the flagged model (the picker view even shows the flagged effort; the non-picker view can only show family-default strings).

Which step does it (zero-prompt isolation, from a restored `auto (current, default)` state) [observed]:

| Steps after the flag | `list-models` marker | `cli-config.json` mtime |
| --- | --- | --- |
| `initialize` only, process stopped after 0.4 s | still `auto (current, default)` | unchanged (1795029241) |
| `initialize` + `session/new`, no prompt | no row marked current | moved (1795029257) |

Also `session/load` with a flag persists: `list-models` read `auto (current, default)` just before probe 2 and had no marked row after it.

A failed launch (exit 1, see Q4) writes nothing that I could see; [inferred from code] the error is raised before the config write.

Why [inferred, from the program's `handleInitialModel`]: the flag value is resolved on the first session, and the model manager then writes `{ model, hasChangedDefaultModel: true }` through `updateConfig(...)` into the person's config. It is the same store `session/set_config_option` writes (`setCurrentModelWithParameters`).

Restore, as in the earlier run [observed]: a picker process, `session/new`, `session/set_config_option model=default`. After it `cursor-agent --list-models` is byte-identical to the baseline (`auto - Auto (current, default)`), plain picker `session/new` says `default`, plain non-picker says `default[]`. Done at about 16:15 (right after the isolation probes) and again at the very end (about 16:36), because the later probes moved it again. The person's default was not Auto for most of the period between about 16:13 (probe 1) and about 16:36, with short Auto stretches after `--model auto` runs. Not verified: whether an already-running `cursor-agent` of the person (pids above) re-reads the value.

## Q2. Spelling of Cursor's own default model ("Auto")

Method [observed]: for each spelling, start from a persisted default that is not Auto (set by a picker process; `list-models` showing no marked row), launch with the flag, `initialize`, `session/new`, read the current model option; no prompt.

| Flag | Accepted | `session/new` current, picker on | `session/new` current, picker off | Persisted default afterwards |
| --- | --- | --- | --- | --- |
| no flag | n/a | the persisted default (`default` here) | persisted (`default[]` here) | unchanged |
| `--model auto` | yes | `default` (3 runs) | `default[]` | Auto (`list-models` marks `auto`) |
| `--model default` | yes | `default` (4 clean runs) | `default[]` | Auto |
| `--model 'default[]'` | yes | `default` (3 runs) | `default[]` (2 runs; 1 transient exit 1, see Q4) | Auto |
| `--model ''` (empty) | accepted and ignored | the persisted default | not run | unchanged |

So the three spellings are equivalent in a clean state. In picker mode there is no effort option for Auto (`configOptions: []` in the list, no second option in `session/new`); non-picker shows the bracketed `default[]`.

Does it really run Auto? Probe 3 [observed]: persisted default `gpt-5.4-nano` low (not Auto), `cursor-agent --model auto acp` (picker): `session/new` said `default`; the turn's store: system prompt "You are an AI coding assistant, powered by Composer", system blob model `grok-4.5`, assistant `modelName = "cursor-grok-4.5-high"`. So `--model auto` ran Auto and Auto's own choice that moment was `cursor-grok-4.5-high` (a server-side choice, not a fixed model; [inferred] it can differ per call).

Caveat that changes the picture: **the flag loses while a "pin" exists** (see Q4b). In that state every Auto spelling (7 runs: `auto` 2, `default` 3, `default[]` 2) and the family flag `gpt-5.4-nano[reasoning=low]` (several runs) reported the pinned model instead, in the first picker-mode process and in every non-picker process. The state is reproducible: a non-picker process does `session/set_config_option model=<bracketed value>`, then the next picker-mode process reports that model and ignores the flag.

## Q3. Does the flag survive `session/load` in a new process? Yes, the new flag wins

Method [observed]: session `4d372600-ce73-4379-ab33-796d28d286aa` started in probe 1 on `gemini-3.8-flash[reasoning_effort=low]` (one prompt). Then a NEW process with `--model 'gpt-5.4-nano[reasoning=low]'` (picker): `session/load` of that id, one prompt.

- `session/load` response current values: model `gpt-5.4-nano`, `reasoning` `low` (the new flag, not the session's own Gemini).
- Store of the session (copy in `scratchpad/verify/cursor-store-4d372600/`):

```
('system',    None, 'gemini-3.8-flash',   'You are an AI coding assistant, powered by Gemini ...')   first turn
('assistant', 'gemini-3.8-flash-low', None, 'OK')
('system',    None, 'gpt-5.4-nano-low',   'You are GPT-5.4 Nano. You are running as an inter...')    after the load: the system blob is rewritten
('assistant', None, None, 'OK')                      providerOptions.cursor has modelProviderMessageId and openaiPhase, no modelName
```

So the second turn ran on `gpt-5.4-nano` at effort `low`: the session's own first model is not kept, the new process's flag decides, family and level. Same as the earlier finding that after a load "the process-global last selection wins", with the flag now the strongest input in a clean state. The load also persisted nano as the person's default (Q1).

## Q4. What exactly does the flag take?

### Rule [observed; the mechanism is [inferred] from the program's code]

The value is matched by string equality, after `trim`, against each variant of each family: `variant.legacySlug === value || variant.variantStringRepresentation === value` (`mapInitialModelVariantToParameterizedSelection`). If nothing matches and the value is not a bare family name known to the catalog, it fails. The canonical string `variantStringRepresentation` is `family[key=value,key=value,...]` with **every parameter of the family, in the family's own order**, no spaces. A bare family (`claude-opus-4-8`) gets every parameter at its default. A legacy flat id from `cursor-agent --list-models` (`claude-opus-4-8-thinking-low`) is also accepted. Order: the order of the family's `configOptions` in `cursor/list_available_models`, with one exception below.

Opus 4.8 from the model list: `thinking` (true/false), `context` (300k/1m), `effort` (low, medium, high, xhigh, max), `fast` (false/true); defaults `thinking=true, context=300k, effort=high, fast=false`. All results from `session/new`, picker on, no prompt:

| Flag value | Outcome |
| --- | --- |
| `claude-opus-4-8` | accepted: `thinking true, context 300k, effort high, fast false` |
| `claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]` | accepted, effort `low`, the rest as given |
| `claude-opus-4-8[thinking=false,context=300k,effort=low,fast=false]` | accepted, `thinking false` |
| `claude-opus-4-8[thinking=true,context=1m,effort=max,fast=true]` | accepted, all four as given |
| `claude-opus-4-8-thinking-low` (legacy slug) | accepted: thinking true, context 300k, effort low, fast false |
| `claude-opus-4-8-low` (legacy slug) | accepted: thinking false, effort low |
| `claude-opus-4-8[effort=low]`, `[effort=high]`, `[effort=low,fast=false]`, `[thinking=true,effort=low]`, `[context=300k,effort=low]`, `[context=1m,effort=low]`, `[context=300k,effort=low,fast=false]` | **exit 1** (a key left out) |
| `claude-opus-4-8[context=1m,effort=high,fast=false]` (the help text's example) | **exit 1** (no `thinking`, wrong order) |
| `claude-opus-4-8[effort=low,thinking=true,context=300k,fast=false]`, `[thinking=false,effort=low,context=300k,fast=false]`, `[context=1m,effort=max,fast=true,thinking=false]` | **exit 1** (all four keys, wrong order) |

So **an unspecified key does not fall to the family default: it fails loudly.** Only the bare family name defaults everything.

Other families [observed]:

| Flag | Outcome |
| --- | --- |
| `gemini-3.8-flash[reasoning_effort=low]`, `gpt-5.4-nano[reasoning=low]` | accepted (one option each; key `reasoning_effort` resp. `reasoning`) |
| `gemini-3.8-flash` (bare) | accepted, `reasoning_effort high` (family default) |
| `muse-spark-1.3[context=300k,effort=low]` | accepted |
| `grok-4.7[context=256k,reasoning_effort=low,fast=true]` | accepted |
| `muse-spark-1.3[effort=low]`, `muse-spark-1.3[context=300k]`, `grok-4.7[reasoning_effort=low]`, `claude-sonnet-5[effort=low]`, `claude-haiku-5-5[reasoning_effort=low]` | **exit 1** (partial) |
| `gemini-3.1-pro`, `gemini-3.1-pro[]` (no options) | both accepted |
| `claude-sonnet-4-5` (bare) | accepted: `thinking false` (that family's default; Opus differs) |

### The picker list does not carry the whole canonical string [observed]

Eight of the 48 families have a canonical string that cannot be rebuilt from `cursor/list_available_models`. I rebuilt `family[id=currentValue,...]` from the list (in `configOptions` order) and compared it to the 48 values a non-picker `session/new` offers as the model option (those are the canonical default strings):

- Six families with no options (`gemini-3.1-pro`, `gemini-3-flash`, `gemini-3.5-flash`, `gemini-2.5-flash`, `gpt-5-mini`, `kimi-k2.7-code`): the canonical value is `family[]`; both `family` and `family[]` are accepted as a flag.
- `claude-sonnet-4-5` and `claude-sonnet-4`: the canonical value has a `context=200k` parameter that is not in `configOptions` (`claude-sonnet-4-5[thinking=true,context=200k]`, `claude-sonnet-4[thinking=false,context=200k]`). The string rebuilt from the list, `claude-sonnet-4-5[thinking=true]`, **fails (exit 1)**; the canonical one and the bare family are accepted. [inferred from code] a parameter with fewer than two values is left out of `configOptions` but kept in the string.

The other 40 rebuilt strings equal the non-picker values exactly.

### Unknown family, unknown key, unknown value: loud failure [observed]

All of these: `initialize` is answered normally, then at the first `session/new` the process writes the message to stderr and **exits with code 1** about 2.4-4.5 s after launch. The `session/new` request is never answered (the ACP connection just closes, no JSON-RPC error). With `initialize` only (no `session/new`) the process stays alive (checked 12 s): the value is validated at the first session, not at startup.

```
$ cursor-agent --model 'nope-9' acp          exit 1, stderr (6672 chars):
Cannot use this model: nope-9. Available models: auto, gpt-5.3-codex-low, gpt-5.3-codex-low-fast, gpt-5.3-codex, ... , deepseek-v41-flash-1017-max
$ cursor-agent --model 'gemini-3.8-flash[reasoning_effort=bogus]' acp     exit 1, same shape
Cannot use this model: gemini-3.8-flash[reasoning_effort=bogus]. Available models: auto, gpt-5.3-codex-low, ...
```

Same message and exit code for: unknown key `gemini-3.8-flash[bogus=low]`, an extra key from another family `gemini-3.8-flash[reasoning_effort=low,fast=true]`, a malformed `gemini-3.8-flash[reasoning_effort=low` (no closing bracket), and every partial or re-ordered value above. The "Available models" list is the legacy flat list of `cursor-agent --list-models` (not the family list). Raw captures: `q/out/q4-*.stderr.txt` and `q/out/q4-*.json`.

Not an error: the empty string `--model ''` (ignored, the persisted default is used, one run) and `Gemini-3.8-Flash` (the session reported `gemini-3.8-flash`/`high`, which was also the persisted default then, so case-insensitivity is **not verified**).

### Transient failure of a valid value [observed, twice in about 95 flagged launches]

`--model 'gpt-5.4-nano[reasoning=low]'` (picker) once and `--model 'default[]'` (non-picker) once exited with code 1 and the same "Cannot use this model" stderr tail (its head was not captured) with a value that worked in the runs right before and after. Not reproduced in two retries each. [inferred from code] the bracket and legacy-slug forms are matched against the catalog the process has loaded so far, and the catalog (`parameterizedModelsFetchStatus`) is fetched from the network when the process starts, so a slow fetch can make a valid bracket look unknown. A launch that dies this way is indistinguishable from a bad value by its message.

### Q4b. The pin: a non-picker `set_config_option model` overrides the flag later [observed + code]

Cursor keeps one more value, `selectedModelVariantId`, in `~/.cursor/acp-config.json` (the file whose mtime moved in my non-picker runs: 1795025892 -> 1795030111 -> 1795030350 and so on; content not read). [inferred from code]:

- A client without the picker capability: `set_config_option model=<variant string>` writes the model and also `selectedModelVariantId`. With the picker capability the same call clears it.
- A non-picker process reports `selectedModelVariantId` first as the current model option. A picker-mode process, at its first session, applies it as the current model (over the flag) and then clears it (`maybeMigratePersistedAcpVariantSelection`).

What I saw [observed]: after a non-picker `set model=gemini-3.8-flash[reasoning_effort=high]`:

| Next process | Flag | `session/new` reported |
| --- | --- | --- |
| picker | `gpt-5.4-nano[reasoning=low]` | `gemini-3.8-flash`, `high` (the pin; the flag lost) |
| picker (a second one) | same | `gpt-5.4-nano`, `low` (flag honoured; the pin was consumed) |
| non-picker, twice in a row | same | `gemini-3.8-flash[reasoning_effort=high]` both times (the pin, not consumed) |
| a picker process, then non-picker | same | the picker one reported the pin; the next non-picker one `gpt-5.4-nano[reasoning=medium]` |
| a plain picker read first, then flagged | same | flagged one honoured |
| 20 s wait first | same | still the pin |

Probe 4 (non-picker, pinned, flag `gpt-5.4-nano[reasoning=low]`): the options said `gemini-3.8-flash[reasoning_effort=high]` but the turn ran `gpt-5.4-nano-medium` (system blob `gpt-5.4-nano-medium`, "You are GPT-5.4 Nano"). So in a non-picker process under a pin, **what `session/new` reports can differ from what runs**; the family flag ran, the effort did not (next section).

### Q4c. The level in the flag needs the picker capability [observed]

| Probe | Flag | Mode | Ran |
| --- | --- | --- | --- |
| 1 | `gemini-3.8-flash[reasoning_effort=low]` | picker | `gemini-3.8-flash-low` |
| 2 (after load) | `gpt-5.4-nano[reasoning=low]` | picker | `gpt-5.4-nano-low` |
| 5 | `gpt-5.4-nano[reasoning=low]` | non-picker, no pin | `gpt-5.4-nano-medium` (family default) |
| 6 | `gemini-3.8-flash[reasoning_effort=low]` | non-picker, no pin | `gemini-3.8-flash-high` (family default) |

In the non-picker run `session/new` also reported the family default (`gpt-5.4-nano[reasoning=medium]`, `gemini-3.8-flash[reasoning_effort=high]`): the non-picker model option offers only the 48 default variants, so it cannot show or keep another level. [inferred] reason; the observation is the two probes.

## Q5. `cursor/list_available_models`

Called right after `initialize` (no session) [observed]. Same request in 3 processes.

- Response top level: only `models` (no `_meta`, no cursor/page field). 48 entries.
- Entry keys, over all 48: only `value`, `name`, `configOptions`. No featured/recommended flag, no provider or vendor field, no description, no `_meta`. Inside a `configOptions` entry: `id`, `name`, `description`, `category`, `type` (always `select`), `currentValue`, `options`; each option has only `value` and `name`. Category is `thought_level` for effort-like options (`reasoning_effort`, `reasoning`, `effort`, and `thinking` on Claude families) and `model_config` for `context` and `fast`. The family-level description does not exist; the option-level `description` does.
- The first entry is `{ "value": "default", "name": "Auto", "configOptions": [] }`.
- Order: identical on the two calls in each of three processes; the JSON of the first and the last of them is deep-equal. Order is the server's, not the legacy `--list-models` order. First ten: `default, grok-4.7, grok-4.6, composer-2.5, claude-opus-5-5, claude-opus-5, claude-opus-4-8, gemini-4-carbon, gemini-4-hydrogen, gemini-4-argon`.
- Timing [observed]: first call in a process 2.35 s, 3.6 s, 3.07 s; second call in the same process 0.32-0.36 s. One earlier attempt showed 806 s wall clock for a call with a 60 s timeout, then answered the second call in 5.6 s; it did not reproduce in three later runs, and 806 s is far beyond the timeout, so I read it as the machine being suspended (not verified).
- Raw first four entries (`q/models-first.json`, `default` above; the third and fourth condensed here, full text in the file):

```json
{ "value": "grok-4.7", "name": "Grok 4.7", "configOptions": [
  { "id": "context", "name": "Context", "description": "Context size the model has available.", "category": "model_config", "type": "select", "currentValue": "256k",
    "options": [ { "value": "256k", "name": "256K" }, { "value": "500k", "name": "500K" } ] },
  { "id": "reasoning_effort", "name": "Effort", "description": "Controls how much reasoning effort the model uses before responding.", "category": "thought_level", "type": "select", "currentValue": "high",
    "options": [ { "value": "low", "name": "Low" }, { "value": "medium", "name": "Medium" }, { "value": "high", "name": "High" }, { "value": "xhigh", "name": "Extra High" } ] },
  { "id": "fast", "name": "Fast", "description": "Significantly faster but consumes more usage", "category": "model_config", "type": "select", "currentValue": "true",
    "options": [ { "value": "false", "name": "Off" }, { "value": "true", "name": "Fast​​" } ] } ] }
{ "value": "grok-4.6", "name": "Grok 4.6", "configOptions": [ { "id": "effort", "...": "low, medium, high, xhigh; default high" }, { "id": "fast", "...": "default true" } ] }
{ "value": "composer-2.5", "name": "Composer 2.5", "configOptions": [ { "id": "fast", "...": "false/true; default true" } ] }
```

  The `fast` option's name carries zero-width spaces (`Fast​`, `Fast​​`) on `grok-4.7`, `grok-4.6`, `grok-4.5`.
- One Claude entry (the first, `claude-opus-5-5`; `claude-opus-4-8` has the extra `thinking` option, see Q4):

```json
{ "value": "claude-opus-5-5", "name": "Claude Opus 5.5", "configOptions": [
  { "id": "context", "name": "Context", "description": "Context size the model has available.", "category": "model_config", "type": "select", "currentValue": "300k",
    "options": [ { "value": "300k", "name": "300K" }, { "value": "1m", "name": "1M" } ] },
  { "id": "effort", "name": "Effort", "description": "Effort the model uses to generate its response.", "category": "thought_level", "type": "select", "currentValue": "medium",
    "options": [ { "value": "low", "name": "Low" }, { "value": "medium", "name": "Medium" }, { "value": "high", "name": "High" }, { "value": "xhigh", "name": "Extra High" }, { "value": "max", "name": "Max" } ] },
  { "id": "fast", "name": "Fast", "description": "2x more expensive, but significantly faster speeds.", "category": "model_config", "type": "select", "currentValue": "false",
    "options": [ { "value": "false", "name": "Off" }, { "value": "true", "name": "Fast" } ] } ] }
```

- Shape facts for a client [observed over all 48]: effort-like option ids are `reasoning_effort` (9 families), `reasoning` (14), `effort` (13), `thinking` (13, boolean `false`/`true`, also category `thought_level`); 17 families do not have exactly one `thought_level` option: 8 have none (`default`, `composer-2.5`, `gemini-3.1-pro`, `gemini-3-flash`, `gemini-3.5-flash`, `gemini-2.5-flash`, `gpt-5-mini`, `kimi-k2.7-code`) and 9 have two (`thinking` plus `effort`, or plus `reasoning_effort` on `claude-haiku-5-5`). Defaults differ per family (for example Opus 4.8 `effort` default `high`, `claude-opus-5-5` `medium`, `kimi-k3` `reasoning` default `max`, `gpt-5.4-nano` has `none` as a level).
- Signed out [not verified; I did not sign out]. From the program's code [inferred]: `extMethod("cursor/list_available_models")` calls `listAvailableModels()`, which first runs `ensureSharedServices()`, and that throws an ACP `authRequired` error ("Authentication required. Please run 'cursor-agent login' first, then call authenticate() with methodId 'cursor_login'") when the session is not authenticated. If the signed-in fetch itself fails, `getAcpAvailableModels` logs and returns `[]`, so the call answers `{ "models": [] }`. The list comes from a network fetch (`fetchAvailableModelsForAcp`), which is the likely reason for the 2-3.6 s first call and the 0.3 s second.

---

## What this means for the plan's Cursor decision (facts against it)

- "the stage first checks that this leaves the person's own default alone": it does not (Q1).
- "`--model '<family>[<effortKey>=<level>]' acp`": a bracket with only the effort key works only for a family that has that single option (`gemini-3.8-flash`, `gpt-5.4-nano`). A family with more options (`claude-opus-4-8`, `muse-spark-1.3`, `grok-4.7`, ...) needs every key, in the family's order, and two families have a hidden `context` key that the picker list does not show (Q4).
- The level in the flag works only when the client declares `parameterizedModelPicker`; Clowdy's client does not today (Q4c).
- A `set_config_option model` from a client without the picker capability leaves a pin that makes the flag lose later (Q4b).

## Not verified

- Whether an already-running `cursor-agent` of the person (pids 67059, 21698) or an open Cursor window re-reads the changed default; whether the person's own default being something other than Auto changes any result here (it was `auto` at my start).
- Where exactly the flag persists (I did not read `cli-config.json`); the Q1 mechanism is read from the program's code, the behaviour is observed.
- What a picker-mode process under a pin really runs (only its report was observed, 4 times; the non-picker pinned run was run with a prompt).
- Whether `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR` (names present in the bundle) would keep a flagged launch from touching the person's default; not tried (a separate directory likely also lacks the login).
- Case-insensitivity of the flag value; the exact `session/new`/stderr text of the two transient failures (only the stderr tail was kept); behaviour with the flag when the agent is signed out; whether a failed launch really writes nothing (read from code, list-models unchanged but the persisted value was non-Auto at that time).
- `thinking`, `context` and `fast` values other than the ones listed; `fast=true` ran with Opus only as a `session/new` report, no prompt.
- That `--model auto` always resolves to the same model: Auto picked `cursor-grok-4.5-high` once.

## Side effects (honest list)

- **Cursor's persisted default model was changed several times and restored.** It was `auto (current, default)` at my start. The flag runs, my `set_config_option` runs and the Q2/Q4 probes moved it to Gemini, GPT nano, Claude and others, mostly non-Auto, between about 16:13 and about 16:36 (local time). The final restore (`set_config_option model=default` in a picker process, run `q-restore-final2`) left `cursor-agent --list-models` byte-identical to the baseline and a plain `session/new` on `default` (picker) / `default[]` (non-picker). Any process the person started in that window may have started on one of my models; the person's other `cursor-agent` processes were running throughout.
- **A leftover pin was cleared at the end**: the last non-picker `set_config_option` was followed by picker-mode processes (the restore), which clear `selectedModelVariantId`.
- **mtimes** (seconds since epoch; read with `stat` only, content not read): `~/.cursor/cli-config.json` 1795028004 (my first look, 15:58) -> 1795030692 (end); `~/.cursor/acp-config.json` 1795025892 (my first look) -> 1795030683 (end). The user's own `cursor-agent` processes were running, so not every move of `cli-config.json` is mine. `~/.claude/*` and `~/.codex/*` were not touched this time.
- **Sessions left in `~/.cursor/acp-sessions/`**: 92 folders created by my probes (87 found in my logs, plus 5 more whose `meta.json` names my scratchpad cwd, probably from the raw runs that exited with code 1). 87 were never prompted (only `meta.json`, or an empty store), 5 were prompted (6 prompts): `4d372600-ce73-4379-ab33-796d28d286aa` (2 turns), `0b3ae52f-dcfb-4043-9c22-c8252e2a2df0`, `63fd7153-64d3-4e4f-925a-cecfd4ed4480`, `e56ffc98-f797-49c6-b6a2-28ea610ca6ce`, `65162f03-ce54-4407-92cd-b08ea7803235`. The earlier research's 6 folders are separate. Cursor has no `session/delete`; I did not delete any folder. One more new folder (`1fe39e4c-...`, 15:58:48) is not mine by cwd.
- **Copies** of my prompted sessions' stores in `scratchpad/verify/cursor-store-*` (own per-session data, not a credential; not copied elsewhere).
- Every process I started was stopped; `ps` shows no probe or `cursor-agent acp` of mine. The `cursor-agent` processes 67059 and 21698 are the user's own and were not touched.
- No repo file was edited; this document is the one file I wrote there. Nothing was committed.
