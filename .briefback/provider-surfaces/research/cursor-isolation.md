# Cursor: can a Clowdy run get its own config location without losing the login?

Snapshot 2026-11-18. Follows `cursor-launch-flag.md` (the flag and `session/set_config_option` both persist the model as the person's default for every later `cursor-agent`). Facts only, no design.

Tags: **[observed]** printed by a command or probe I ran; **[inferred]** my reading of Cursor's own program code (not run); **[not verified]** not checked.

## Answer

**Yes, on macOS: set `CURSOR_CONFIG_DIR=<a directory Clowdy owns>` in the environment of the `cursor-agent` process.** [observed]

- The login survives: `cursor-agent status`, `about`, `--list-models` and a full ACP turn all work against an empty directory. Authentication is not kept under the config directory but in the macOS login keychain (read through `/usr/bin/security`). [observed + inferred]
- The persisted default model, the "pin" (`selectedModelVariantId`), the session history and the config move into that directory. The person's `~/.cursor/cli-config.json` and `acp-config.json` were untouched by every isolated run (mtimes, `--list-models` unchanged). [observed]
- Both ways of choosing the model were run in isolation: the launch flag `--model 'gemini-3.8-flash[reasoning_effort=low]' acp` and ACP `session/set_config_option` (picker and non-picker). All of them landed in the isolated directory only. [observed]
- Do **not** isolate by `HOME`: the process is then "Not logged in" (the keychain lookup goes through `HOME` [inferred]; the result is observed). `XDG_CONFIG_HOME` also keeps the login on macOS but moves more than Cursor reads (see Q1). [observed]
- Not isolated by this variable (still the person's own, and still visible to a Clowdy run): MCP servers, skills and slash commands, hooks, user rules, plugins (all under `~/.cursor` by `os.homedir()`, not by the config directory), plus the per-workspace `~/.cursor/projects/<workspace>` folder. [observed for MCP servers and skills; inferred for the rest]
- Cost of isolation: the person's own `cli-config.json` settings (their permission allow/deny list, approval mode, sandbox, display settings, own default model) are not inherited; the isolated directory starts from Cursor's built-in defaults. [observed for the model default, inferred for the rest from the key names of the fresh file]

## Versions and method

| Item | Version |
| --- | --- |
| `cursor-agent` | 2026.11.13-eacade1 (a newer 2026.11.17-f532c45 is downloaded but not the one `cursor-agent` runs; `about` says an update is available) |
| macOS | 26.4.1 (arm64) |
| Bun | 1.4.4 |
| ACP SDK | `@agentclientprotocol/sdk` 2.7.0, as the earlier research |

Everything is under `/private/tmp/claude-501/-Users-bionic-WORK-My--kachurun-clowdy/3d1c8519-767b-480f-8ec2-cf732f8ec938/scratchpad/verify/` (nothing in `/tmp`, nothing else in the repo):

- `probe.ts`, `q/plans/*.json` (earlier research): starts the agent with the repo's `AgentRegistry`, `buildAgentEnv`, `spawnInOwnGroup`, so an environment variable on the `bun probe.ts` command line reaches the agent exactly as `agent.env`/the daemon's env would. [observed: the isolation took effect through it]
- New in `iso/`: `iso/cfg1..cfg5` (fresh empty config directories), `iso/data5`, `iso/xdg1`, `iso/home1`, `iso/plans/*.json`, `iso/ctx.py` (prints a window around a pattern in Cursor's own program files), `iso/uses.py` (counts which directory function each file name is built from), `iso/iso-model.py` (reads a copy of one of MY isolated sessions' store), and all logs in `iso/out/` (`iso1.log` ... `iso18.log`, `status-*.txt`, `about-*.txt`, `mcp-*.txt`, `list-models-*.txt`, `real-*-before/after*.txt`).
- Every session used a throwaway cwd under `verify/cwd/iso*`. The permission handler answered `allow_once` (never asked). One prompt in total (`iso6`, "Reply with the single word OK").
- What I read: only Cursor's program code (`~/.local/share/cursor-agent/versions/2026.11.13-eacade1/*.js`) and command output. I did not read `~/.cursor/*.json` (mtimes and directory listings only), no keychain entry, no `auth.json` (`~/.cursor/auth.json` does not exist; checked with `ls`). I read the key names (not the values, except `model`/`hasChangedDefaultModel`) of the `cli-config.json` files that the program wrote into MY isolated directories. I also read one `meta.json` (its `cwd`) of a session folder that my own control run had created in `~/.cursor/acp-sessions`, to attribute it. Emails in command output are redacted in the saved logs.

## Q1. Which variables does `cursor-agent` honour for relocating its files?

`cursor-agent --help` lists none (only `--api-key`, `--endpoint`, `--workspace`, `--worktree` ...). `about` and `status` print none. From the program's code [inferred, `index.js`, module `../cursor-config/dist/paths.js`, and the same function copied into `connect-pool-worker.js`]:

```js
function configDir() {            // "WI" in the bundle
  const t = process.env.CURSOR_CONFIG_DIR;  if (t?.trim()) return t;
  const e = process.env.XDG_CONFIG_HOME;    return e?.trim() ? join(e, "cursor") : join(homedir(), ".cursor");
}
function dataDir() {              // "c" in the bundle
  const t = process.env.CURSOR_DATA_DIR;    return t?.trim() ? t : join(homedir(), ".cursor");
}
// cli-config.json = join(configDir(), "cli-config.json")
// projects        = join(dataDir(), "projects", <mangled workspace path>)
```

Order of the config directory: `CURSOR_CONFIG_DIR`, then `$XDG_CONFIG_HOME/cursor`, then `~/.cursor`. A `--data-dir` option also exists in the code (it sets `CURSOR_DATA_DIR`), but it is not in `--help`.

Which files each directory function builds [inferred, counted over all `*.js` of the version by `iso/uses.py`; the file is named at the call site]:

| Built from the config directory (moved by `CURSOR_CONFIG_DIR`) | Built from `os.homedir()/.cursor` (not moved) |
| --- | --- |
| `cli-config.json`, `acp-config.json`, `acp-sessions/`, `statsig-cache.json`, `chats/`, `permissions.json` | `mcp.json`, `hooks.json`, `rules/`, `commands/`, `plugins/`, `sandbox.json`, `agent-helper/`, `ai-tracking/`, `plans/`, `worktrees/`, `skills/` and `skills-cursor/` (together with `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` ... in the skill search list); and, from the data directory, `projects/<workspace>/` |

Observed on disk after isolated runs (a fresh `CURSOR_CONFIG_DIR`): `cli-config.json`, `statsig-cache.json` (about 1.1 MB, fetched fresh), `acp-sessions/<id>/` (`meta.json`, `store.db`) and, after a non-picker `set_config_option`, `acp-config.json` (73 bytes). Nothing named `auth*` or `*token*`. [observed, directory listing]

`CURSOR_DATA_DIR` [observed, `iso18`]: with `CURSOR_CONFIG_DIR=cfg5 CURSOR_DATA_DIR=data5` the per-workspace folder `projects/<mangled cwd>` was created under `data5` and not under the real `~/.cursor/projects`; the new folder contained a file `mcp-auth.json` (I did not read it).

Other variable names in the code that touch authentication [inferred, not tried except where noted]: `AGENT_CLI_CREDENTIAL_STORE` (`file`, `memory`, anything else = default), `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `--api-key`. The launcher script `~/.local/bin/cursor-agent` also reads `AGENT_CLI_CREDENTIAL_STORE=file` (it then skips `--use-system-ca`).

Tested spellings of the isolation, each against a fresh empty directory, `cursor-agent status` [observed]:

| Variable | Result |
| --- | --- |
| `CURSOR_CONFIG_DIR=<empty dir>` | `Logged in as <email>`. A `cli-config.json` (837 bytes, built-in defaults) appears in the directory |
| `XDG_CONFIG_HOME=<empty dir>` | `Logged in as <email>`; the file appears at `<dir>/cursor/cli-config.json`. This variable is shared with everything the agent starts (git, shells, other CLIs) |
| `HOME=<empty dir>` | **`Not logged in`**; the program created `<dir>/.cursor` and `<dir>/Library/Caches/...`. HOME is not usable |
| `AGENT_CLI_CREDENTIAL_STORE=file` (with `CURSOR_CONFIG_DIR=<empty dir>`) | `Not logged in` (there is no `~/.cursor/auth.json`, so the login is not file-based here) |

## Q2. Is the person still signed in under the isolated location? Yes

Commands, each with `CURSOR_CONFIG_DIR=iso/cfg1` (empty directory made just before) [observed, `iso/out/status-*.txt`, `about-*.txt`, `list-models-cfg1-a.txt`]:

```
$ cursor-agent status                 -> ✓ Logged in as <email>      (same as without the variable)
$ cursor-agent about                  -> identical to the run without the variable: Model Auto, Subscription Tier Pro+, User Email <email>
$ cursor-agent --list-models          -> 284 lines, identical to the run without the variable, except row 3:
                                          real:      auto - Auto (current, default)
                                          isolated:  auto - Auto (default)        (a fresh config has no chosen model, so no row is "current")
```

Where authentication is kept [inferred from the code, supported by observation]:

- `cli-credentials` picks the store by `AGENT_CLI_CREDENTIAL_STORE` and the platform: `memory` (process only), `file`, or the default. The default on **darwin is the keychain**, through `/usr/bin/security find-generic-password -a cursor-user -s cursor-access-token|cursor-refresh-token|cursor-api-key -g` (account `cursor-user`). The file store would be `~/.cursor/auth.json` on darwin (homedir based, not the config directory), `$XDG_CONFIG_HOME|~/.config/cursor/auth.json` on Linux, `%APPDATA%\Cursor\auth.json` on Windows.
- Observed consistent with that: `~/.cursor/auth.json` does not exist; the isolated directories hold no token file; forcing the file store makes the agent "Not logged in"; changing `HOME` makes it "Not logged in" (the keychain is located through `HOME`); a changed `CURSOR_CONFIG_DIR` does not.
- So no credential file needs to be copied on macOS. On Linux and Windows the file path is built from `XDG_CONFIG_HOME` / `APPDATA`, not from `CURSOR_CONFIG_DIR`, so `CURSOR_CONFIG_DIR` should also leave the login alone there [inferred from code, **not run**: this machine is macOS].
- The isolated `cli-config.json` that the program writes after a session has an `authInfo` object with the keys `email`, `displayName`, `userId`, `authId` (account display data, no token keys; values not read) and `privacyCache`. [observed, key names only]

## Q3. The previous probe's scenario in the isolated location: the person's default stayed untouched

Start state of the person's own location, before any isolated run [observed]: `cursor-agent --list-models` row 3 `auto - Auto (current, default)`; mtimes `cli-config.json` 1795030692, `acp-config.json` 1795030683; 131 folders in `~/.cursor/acp-sessions`.

### Run `iso1` (fresh `cfg2`): flag, picker capability, initialize, session/new, no prompt

```
$ CURSOR_CONFIG_DIR=iso/cfg2 bun probe.ts cursor q/plans/new-only.json iso1 --picker --prefix --model --prefix 'gemini-3.8-flash[reasoning_effort=low]'
session/new current values: { "mode": "agent", "model": "gemini-3.8-flash", "reasoning_effort": "low" }      (session/new answered in 4900 ms)
```

Afterwards [observed]:

| Check | Person's own location (no variable) | Isolated (`cfg2`) |
| --- | --- | --- |
| `cursor-agent --list-models` row 3 | `auto - Auto (current, default)`, the whole output **byte-identical** to the baseline (`diff` empty) | `auto - Auto (default)`, no row `(current)` (the same view as in the earlier research after a flagged launch) |
| plain picker `session/new` (no flag) | `model: default` (`iso3`) | `model: gemini-3.8-flash`, `reasoning_effort: low` (`iso2`, again `iso4`) |
| `cli-config.json` | mtime 1795030692, unchanged | has `model.modelId = gemini-3.8-flash`, `displayName "Gemini 3.8 Flash Low"`, `hasChangedDefaultModel: true`, `selectedModel`, `modelParameters`, `modelSelectionHistory` (1 entry) |
| `acp-config.json` | mtime 1795030683, unchanged | not created (picker mode) |
| `acp-sessions` | folder count unchanged (131) | 1 new folder |

### Other isolated runs, each followed by a check of the person's location [observed]

| Run | What | Person's `--list-models`, mtimes, session count |
| --- | --- | --- |
| `iso5` (`cfg2`) | flag `gpt-5.4-nano[reasoning=low]` over the Gemini default: reported `gpt-5.4-nano`, `reasoning low` (the flag wins over the isolated persisted value) | unchanged |
| `iso13` (`cfg4`), picker | `set_config_option model=gemini-3.8-flash` (reported `reasoning_effort high`), then `reasoning_effort=low` | unchanged; plain isolated picker read (`iso14`) then reports `gemini-3.8-flash`/`low` |
| `iso15` (`cfg4`), **non-picker** | `set_config_option model='gemini-3.8-flash[reasoning_effort=high]'` | unchanged, in particular real `acp-config.json` mtime still 1795030683; `cfg4/acp-config.json` (73 bytes) was created, which is where the pin now lives |
| `iso16`, `iso17` (fresh `cfg5`) | plain picker and non-picker `session/new` | picker `model: default`; non-picker `model: default[]` (a fresh isolated directory starts on Auto, not on the person's default) |

### One prompt: the isolated run really runs the flagged model (`iso6`, fresh `cfg3`)

`--model 'gemini-3.8-flash[reasoning_effort=low]' acp`, picker, `session/new`, prompt "Reply with the single word OK" (session `b1266302-5208-4c23-944e-995a30b994a6`, stored in `cfg3/acp-sessions`). `session/new` answered in 4576 ms, the prompt in 3946 ms, `stopReason: end_turn`, reply "OK". Session store, read from a copy in `iso/cursor-store-iso-b1266302/` [observed]:

```
('system',    None,                   'gemini-3.8-flash', 'You are an AI coding assistant, powered by Gemini ')
('assistant', 'gemini-3.8-flash-low', None,               'OK')           providerOptions.cursor.modelName
```

After it: person's `--list-models` still `auto - Auto (current, default)`, `cursor-agent status` still logged in, person's `cli-config.json` and `acp-config.json` mtimes unchanged, no new folder in `~/.cursor/acp-sessions`.

### Session history is split in two [observed]

| Process | `session/load` of | Result |
| --- | --- | --- |
| isolated (`cfg3`) | a session of the person's own location, prompted (`4d372600-...`, from the earlier research) | `Invalid params {"message":"Session \"...\" not found"}` (`iso10`) |
| isolated (`cfg3`) | the isolated session `b1266302-...` | answered in 3.1 s; reported `gemini-3.8-flash`/`low` (the isolated persisted default, as the earlier research found for a load: the process-global selection wins) (`iso11`) |
| person's location | the isolated session `b1266302-...` | `not found` (`iso12`) |
| person's location | `4d372600-...` | answered; reported `model: default` (`iso9`) |
| person's location | `e13c0961-...`, a session that had only been created (never prompted) | `not found` (`iso8`): **a never-prompted Cursor session cannot be loaded** (it has only `meta.json`, no `store.db`) |

So a Clowdy run that wants to resume its own Cursor sessions has to keep using the same isolated directory; a fresh directory per run would lose them.

## Q4. What the isolated process still sees of the person's own Cursor setup

| Item | Isolated (`CURSOR_CONFIG_DIR` only) | Evidence |
| --- | --- | --- |
| Account, subscription, model catalogue | same as the person's | `about`, `--list-models`, `cursor/list_available_models`: [observed] |
| MCP servers | **same**: `mcp list` printed the same two servers with the same states in both locations (`iso/out/mcp-real.txt`, `mcp-cfg1.txt`) | [observed]; `mcp.json` is read from `os.homedir()/.cursor/mcp.json` [inferred] |
| Skills and slash commands | **same 40 entries in the same order** in the isolated `session/new` (`iso7`, after 4 s), in a real-location `session/load` (`iso9`) and in the earlier research's logs (`out/cursor-e-new-plain.log`); they include the person's user-level skills | [observed]; skills are searched in `~/.cursor/skills`, `~/.cursor/skills-cursor`, `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` ... under `os.homedir()` [inferred] |
| User rules (`~/.cursor/rules/*.mdc`), hooks (`hooks.json`), commands, plugins | not moved (code builds them from `os.homedir()`); this machine has no `~/.cursor/rules` and the listing shows `hooks.json`, `plugins`, `agents`, so I could not observe a rule | [inferred] only |
| Project rules (`<cwd>/.cursor/rules`, `<cwd>/.cursor/mcp.json`) | independent of the location, they follow the cwd | [inferred from the code's literal `.cursor/rules` paths, not run] |
| The person's own Cursor session history (`~/.cursor/acp-sessions`) | **not visible**: `session/load` of a session that exists there answers "not found"; the history is a separate folder per location | [observed] |
| The person's `cli-config.json` settings: permission allow/deny list, `approvalMode`, `sandbox`, display and notification settings, `exploreSubagentModel`, own default model | **not inherited**; the fresh file has the built-in values (`permissions` has `allow` and `deny` keys, values not read) | [observed key names], effect on tool approvals **not verified** |
| `statsig-cache.json` (feature flags) | a separate, freshly fetched copy (about 1.1 MB) | [observed] |
| `~/.cursor/projects/<mangled cwd>` | **still written in the person's location**, one empty folder per workspace path, by isolated and plain runs alike (`projects/...cwd-iso2`, `iso6`, `iso7`, `iso13` ... `iso16`). `CURSOR_DATA_DIR` moves it (see Q1) | [observed] |
| `~/.cursor/skills-cursor` | its directory mtime moved at the time of my runs; not isolated (homedir based) | [observed mtime], cause not attributed |

## What the check does not cover

Not verified [not verified]:

- Windows and Linux (code reading only: `CURSOR_CONFIG_DIR` is not part of the file-store path there).
- A person whose own default model is not Auto: here it was Auto (`default`) all along. The isolated start state is Auto (`default`) regardless, by `iso16`.
- A first launch in a directory that does not exist yet (I always created it first; the program creates `cli-config.json` etc. itself, whether it also creates the directory was not tried).
- Two Clowdy cursor processes sharing one isolated directory at the same time (concurrent writes to `cli-config.json` / `acp-config.json`; the person's own processes did this against `~/.cursor` all day without an error, but I did not test the concurrent case).
- How the person's `permissions.allow` / `approvalMode` / sandbox settings would have changed a run's tool approvals (Clowdy's ACP handler answers permission requests itself, so probably nothing, not tested).
- Whether the `session/list` capability (`sessionCapabilities.list`, present in `initialize`) lists only the isolated sessions (not called).
- Token refresh over long periods under isolation: the refreshed tokens are written to the keychain (same account), not to the isolated directory [inferred]; not observed over time.
- `CURSOR_DATA_DIR`: what the `mcp-auth.json` it produced holds, and what the person's `~/.cursor/projects/<workspace>` holds for their own workspaces (so what moving it would hide); not read.
- The earlier research's other open items (pinned state, transient failure of a valid value) were not re-run; they now concern the isolated directory only.

## Side effects (honest list)

- **The person's own default model was never changed in this round.** Before and after every isolated run `cursor-agent --list-models` (without the variable) read `auto - Auto (current, default)` on row 3 (checked about 10 times; the whole output was diffed byte for byte against the baseline once, after `iso1`). No restore was needed.
- **In the person's `~/.cursor`**:
  - `cli-config.json` mtime moved once, 1795030692 -> 1795031153 (about 16:45:53). It did not move across `iso1`, nor across `iso4`, `iso5`, `iso6`, `iso7`, `iso9`-`iso18` (mtime checked before and after several of them). The window in which it moved contained the isolated run `iso2`, my control run `iso3` (a plain picker `session/new` in the person's location, no flag) and one real `--list-models`; the first isolated run of the same kind later (`iso4`) did not move it, which points at `iso3` (a plain picker `session/new` in the person's location, no flag), and the person's own two `cursor-agent` processes (pids 21698 and 67059) were running, so the attribution is not certain. I did not read the file; `--list-models` is unchanged, so the default model is not what moved. `acp-config.json` mtime unchanged (1795030683).
  - **One new session folder** in `~/.cursor/acp-sessions`: `e13c0961-ef37-4409-8738-608ec2c978d6` (never prompted, only `meta.json`, cwd `.../verify/cwd/iso3`), from the control run `iso3`. Cursor has no `session/delete`; I did not delete it. The earlier research's folders are still there.
  - **Empty folders in `~/.cursor/projects/`** named after my throwaway cwds (`private-tmp-claude-501-...-verify-cwd-isoN`; 13 of them for `iso2`, `iso3`, `iso6`-`iso16`; none for `iso1`, `iso4`, `iso5`, reason not investigated), created by isolated and control runs alike. Not deleted.
  - `statsig-cache.json` mtime moves with every real-location command I ran (`status`, `about`, `--list-models`, `mcp list`, `iso3`) and with the person's own processes; five isolated commands in a row did not move it. `skills-cursor` directory mtime moved around 16:50 (home based, same reason).
  - `cursor-agent mcp list` was run once in the person's location and once isolated; it printed the status of the person's two configured MCP servers (it probably connected to them; one reports `requires_authentication`). No change made.
- **Real model call**: exactly one prompt, `iso6`, in a fresh isolated directory ("Reply with the single word OK", `gemini-3.8-flash` at effort `low`).
- **Scratch only**: `iso/cfg1..cfg5`, `iso/data5`, `iso/xdg1`, `iso/home1` (each holds Cursor-written files: `cli-config.json` with `authInfo` display data (email, display name, ids; no token), `statsig-cache.json`, session folders, and, under `home1`, `Library/Caches/cursor-compile-cache`), `iso/cursor-store-iso-b1266302/` (a copy of my one prompted isolated session), logs in `iso/out/`, and `q/state-q.json` rewritten by the harness. Nothing was copied out of the scratchpad. The `authInfo` contents are the person's account display data and sit under the scratchpad; they are not in this file.
- Every process I started was stopped by the harness (`ps` shows no `bun probe.ts` or `cursor-agent acp` of mine). The `cursor-agent` processes 21698 and 67059 are the person's own and were not touched.
- No repo file was edited besides this document. Nothing was committed.
