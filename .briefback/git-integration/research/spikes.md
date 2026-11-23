# Stage 0 spikes: tool-free Codex and Claude runs, and signing and SSH from the daemon's environment

Snapshot 2026-11-22, on the owner's machine (macOS, `codex-cli 0.171.0`, `claude` 2.1.312, Secretive as the SSH agent). Nothing in the repository was changed to run these; the scratch work lives outside it. "Observed" means a command I ran and its output. "Inference" means my reading of what the observation implies.

## Summary

1. **Commit message from Codex:** a separate `codex exec` run with the user's config ignored, the cheapest model (`gpt-6-luna`), low effort, every optional tool and context block switched off, and a tiny instructions file takes about 4.1 s and 6.3K input tokens (against 7.4 s and 21.5K for the defaults, six runs against three). It answers with one clean line. A custom model catalog can go further (about 4.3K tokens) but buys no speed and is fragile, so it is not the recommendation.
2. **No cheap run is lower than about 3.3K input tokens or about 3.6 s:** that is the floor even for "Reply with: ok" with no tools at all. The fixed part is outside the client's control. An ACP session was not measured, since `exec` already reaches that floor.
3. **A signed commit fails from a Finder-launched app:** with launchd's `SSH_AUTH_SOCK`, or none, `git commit` stops with `No private key found for public key ...`. With the Secretive socket it works in 0.2 s.
4. **SSH to `origin` works in every environment** (about 2.1 s for `ls-remote`), because `~/.ssh/config` sets `IdentityAgent` for all hosts. Signing does not read that file.
5. **The daemon must put Secretive's socket into `SSH_AUTH_SOCK` for git writes:** take it from `ssh -G <origin host>` (`identityagent`), else from the login shell as `PATH` is taken, and prefer either over an inherited value. No Touch ID prompt appeared in any run, so its wait could not be timed.
6. **Commit message from Claude:** a separate `claude -p` run on Haiku (`--model haiku --effort low`) with every tool, MCP server, skill, hook, memory block and `CLAUDE.md` switched off and a one-line `--system-prompt` takes 2.1K input tokens and 2.9 s on average (2.1 to 4.1 s, fifteen runs), against 23.9K and 2.5 s for the defaults. It answers with one clean line. Claude can drop every tool, so its floor is 0.6K tokens (Codex's is 3.3K); the saving is tokens and cost, not time. `--bare` cannot use the subscription login, and the argv is plain flags and a settings JSON, with no file to write.

## Spike A: the cheapest Codex run that writes a commit message

### Method

- **Prompt (fixed, on stdin):** about 3.4K characters, about 930 tokens: the instruction (one conventional-commit subject, at most 72 characters, no other text), the `--name-status` list of three files, and 43 lines of the diff of commit `58207d0` of this repository (a chevron change in `AgentList.tsx`, its CSS and `apps/desktop/AGENTS.md`).
- **Working directory:** an empty scratch folder, not a repository, so no project `AGENTS.md` is read.
- **Numbers:** `codex exec --json` ends with a `turn.completed` event that carries `usage` (input, cached input, output and reasoning tokens). Wall-clock is the whole process, start to exit. Each variant was run three times; the custom-catalog tries before variant 5 once each.
- **Weight of the request:** I pointed `codex exec` at a local stand-in provider (`-c model_provider=...` with a `base_url` on 127.0.0.1) that records the request body and answers with an error. That shows exactly what the client sends: instructions, tools, context blocks. `codex debug prompt-input` shows the same list without a request. The stand-in changes the provider, so the tool list may differ slightly from the real one; the token counts below come from real runs.
- **Credentials:** never read, copied or recorded. `--ignore-user-config` skips `config.toml` only, and login still comes from the normal `CODEX_HOME`. A throwaway empty `CODEX_HOME` was used only for `debug prompt-input` and is deleted.
- **Cost to the subscription:** 37 real runs in all, about 0.4M input tokens, a large share of them the default-config variants.

### Results

Input is the `input_tokens` of the run (it includes the cached part). Wall is in seconds.

| # | Variant | Exact change from the row above | Input tokens (cached) | Output tokens | Wall (s), three runs | Clean single line |
|---|---|---|---|---|---|---|
| 1 | Defaults | `codex exec --ephemeral --skip-git-repo-check -s read-only` | 21,459 to 21,531 (13,056) | 42 to 98 | 7.62, 6.88, 7.75 (mean 7.4) | yes, 3 of 3 |
| 2 | No MCP servers, plugins or hooks | add `--ignore-user-config -m gpt-6-sol -c model_reasoning_effort=high` (the owner's own model and effort, pinned back) | 20,105 (11,776) | 119 to 166 | 7.18, 6.76, 7.35 (mean 7.1) | yes, 3 of 3 |
| 3 | Cheapest model, low effort | `-m gpt-6-luna -c model_reasoning_effort=low` instead | 19,926 (11,648) | 15 to 18 | 4.48, 4.25, 4.35 (mean 4.4) | yes, 3 of 3 |
| 4a | Built-in tools and context blocks off | add the drop list below, without the instructions file | 10,344 (0) | 16 to 17 | 3.88, 3.93, 3.58 (mean 3.8) | yes, 3 of 3 (2 with a trailing newline) |
| 4b | And the built-in instructions replaced | add `-c model_instructions_file="<82-character file>"` | 6,909 (0) | 17 to 18 | 3.80, 4.06, 4.43 (mean 4.1) | yes, 3 of 3 (1 with a trailing newline) |
| 6 | **4b with `goals` and exec rules off (recommended)** | add `--disable goals --ignore-rules`; run again as `-c features.<name>=false` for every `--disable` (the form in the recommended argv): same request, same tokens | **6,293** (0, one run 6,144) | 16 to 17 | `--disable` form 4.81, 3.91, 3.70; `-c` form 4.35, 3.93, 3.96 (mean of six 4.1) | yes, 6 of 6 (4 with a trailing newline) |
| 5 | 6 with a custom model catalog, no tools at all | `-c model_catalog_json=<one-model file>` with `tool_mode` null and `shell_type` disabled | 4,257 (2,304) | 17 to 19 | 4.50, 3.89, 3.71 (mean 4.0) | yes, 3 of 3 (1 with a trailing newline) |

Every answer was one line of 44 to 66 characters, so within 72. The type and scope vary from run to run (`fix` or `feat`, `agents` or `desktop`); the real commit was `feat(desktop): ...`. Trim the trailing newline.

The drop list used from variant 4a on (all on top of variant 3; written with `--disable` in the runs of 4a to 6, and as `-c features.<name>=false` in the repeat of variant 6):

```
-c agents.enabled=false
--disable shell_tool --disable sleep_tool --disable view_image
-c tools.experimental_request_user_input.enabled=false
-c tools.update_plan.enabled=false
-c skills.include_instructions=false
-c include_environment_context=false
-c include_permissions_instructions=false
-c include_collaboration_mode_instructions=false
-c include_apps_instructions=false
--disable plugins --disable apps
-c project_doc_max_bytes=0
```

### What each part weighs

Floors, measured with the trivial prompt "Reply with: ok" (about 15 characters): variant 1 20,604 input tokens; variant 4b 5,982; variant 5 3,330 (2,304 cached). So my prompt is about 930 tokens, and the rest of every number is the setup.

Request weight, recorded from the stand-in (characters, so tokens are roughly a quarter):

| Variant | Request body | Instruction and context text | Tool schemas | Tools sent |
|---|---|---|---|---|
| 1 | 87.8 KB | 48.1K chars: built-in instructions 18.7K, skills list 26.6K, multi-agent roles 2.7K | 32.2K chars | `exec`, `wait`, two `request_user_input`, `sleep`, six multi-agent tools, two MCP tools from a plugin |
| 2 | 65.5 KB | 31.4K chars (skills list 10.0K) | 26.5K chars | the same without the MCP tools |
| 3 | 64.6 KB | 30.5K chars | 26.5K chars | the same |
| 4a | 36.5 KB | 17.8K chars (the built-in instructions) | 12.1K chars | `exec`, `wait` |
| 4b | 18.6 KB | 82 chars | 12.1K chars | `exec`, `wait` |
| 6 | 15.5 KB | 82 chars | 9.1K chars (`exec` 7.6K, `wait` 1.4K) | `exec`, `wait` |
| 5 | 6.6 KB | 164 chars | none | none |

Where the tokens went, from the differences between rows:

| Step | Input tokens | Wall |
|---|---|---|
| The owner's MCP servers, plugin skills and hooks (1 to 2) | about -1.4K | about -0.3 s |
| `gpt-6-sol` at high effort to `gpt-6-luna` at low (2 to 3) | about -0.2K | about -2.7 s (the big model spent 100 to 150 reasoning tokens; Luna spent none) |
| Built-in tools and context blocks (3 to 4a) | about -9.6K | about -0.6 s |
| The built-in instructions replaced by one line (4a to 4b) | about -3.4K | about +0.3 s (noise) |
| `goals` and the rules (4b to 6) | about -0.6K | none |
| The custom catalog, which removes `exec` and `wait` (6 to 5) | about -2.0K | none |

### Observations that explain the table

- **The user's MCP servers are a small cost.** The owner's config enables four MCP servers; a plugin adds a fifth set of tools. Together they cost about 1.4K tokens and no measurable time. `-c mcp_servers={}` does not clear them (checked: the rendered prompt did not change); `-c mcp_servers.<name>.enabled=false` works only by name. `--ignore-user-config` is the generic switch. It also drops the plugins, hooks and the owner's model, effort and verbosity, so the run must set its own model and effort.
- **`exec` and `wait` cannot be switched off by a flag.** Every model in this account's catalog (`codex debug models`) says `tool_mode: code_mode_only`, and the catalog value wins over the `code_mode` features. In that mode Codex sends `exec` (a JavaScript runner, 7.6K characters of description even with every nested tool off) and `wait`. Only a custom model catalog removes them (variant 5): the file is a copy of the `gpt-6-luna` entry from `codex debug models` with `tool_mode` null, `shell_type` disabled, no apply-patch tool, no experimental tools and no `model_messages`. Setting `use_responses_lite` to false in that file raised the input to 6.7K tokens on a first try; inference: Codex then sent its hosted web search and image generation tools (that request was not recorded), so keep it true.
- **Answers come from the visible text, not from tools.** None of the 37 runs called a tool or wrote a file.
- **`project_doc_max_bytes=0` does not remove the global `~/.codex/AGENTS.md`.** About 930 characters of it were still sent, with `--ignore-user-config` too. It is small, so I left it.
- **The fixed floor is not removable.** Variant 5 sends about 1.5K tokens of visible text for "Reply with: ok", yet the run reports 3,330 input tokens with 2,304 of them cached. Inference: about 2.3K tokens are a server-side prefix of the "responses lite" path.
- **Latency floor, about 3.6 s.** A 5-token answer on the leanest variant took 3.6 s. About 3.6 s is therefore process start, auth and the round trip, and the model's own part is small.
- **A wrong model fails cleanly.** With `-m gpt-nope` the process exits with code 1, prints a `turn.failed` event with the message, and writes nothing to stderr.
- **Models.** The account offers `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra`, `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`. The catalog describes `gpt-6-luna` as "Fast and affordable model for easier tasks", and its lowest effort is `low`. No price is in the catalog, so "cheapest" is the vendor's own description (inference). `gpt-5.6-luna` took 4.7 and 5.6 s with 29 to 41 reasoning tokens (two runs, variant 6), so `gpt-6-luna` is also the faster one. `gpt-6-sol` at low effort took 4.7 s on one run.
- **ACP comparison:** not measured. `codex exec` reached the floor above, and `codex-acp` drives `codex app-server` with the full tool set (`.briefback/acp/research/agents-and-adapters.md`).

### Recommended command

Run it in an empty temporary folder as the working directory, prompt on stdin, with a timeout of about 30 s (the run takes 4 s). `commit-message-instructions.md` is a file the daemon writes once into its data folder, holding the 82-character line used here: "You write git commit messages. Reply with the single line asked for, nothing else."

```json
["codex", "exec",
 "--ephemeral", "--skip-git-repo-check", "-s", "read-only",
 "--ignore-user-config", "--ignore-rules",
 "-m", "gpt-6-luna", "-c", "model_reasoning_effort=low",
 "-c", "agents.enabled=false",
 "-c", "tools.experimental_request_user_input.enabled=false",
 "-c", "tools.update_plan.enabled=false",
 "-c", "skills.include_instructions=false",
 "-c", "include_environment_context=false",
 "-c", "include_permissions_instructions=false",
 "-c", "include_collaboration_mode_instructions=false",
 "-c", "include_apps_instructions=false",
 "-c", "project_doc_max_bytes=0",
 "-c", "model_instructions_file=\"<absolute path>/commit-message-instructions.md\"",
 "-c", "features.shell_tool=false", "-c", "features.sleep_tool=false", "-c", "features.view_image=false",
 "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "features.goals=false",
 "--json", "-"]
```

Measured (six runs): **6,293 input tokens, 16 to 17 output tokens, 3.7 to 4.8 s (mean 4.1 s)**, against 21.5K tokens and 7.4 s for the defaults (three runs): 71 percent fewer input tokens and 44 percent less time. Read the last `item.completed` event whose `item.type` is `agent_message`, trim it, and treat a `turn.failed` event or a non-zero exit as `Couldn't write the message`.

Limits of this recommendation:

- The flags, config keys and feature names are those of `codex-cli 0.171.0`. `-c model_instructions_file` is the least stable (Codex's own schema says users are "strongly discouraged" from it). Feature switches are written as `-c features.<name>=false` on purpose: observed, `--disable <unknown name>` stops with `Error: Unknown feature flag`, while `-c features.<unknown name>=false` is accepted, so a feature that a later Codex removes does not break the run. A removed config key was not tested. A test that fails when the request grows would catch a drift in what is sent.
- `--ignore-user-config` also drops a custom provider or gateway the person set in their `config.toml`. A person on such a setup would get `Couldn't write the message`. Not tested.
- `gpt-6-luna` is on this account. Another plan may not list it; with a missing model the run fails (observed for a wrong name). Falling back to no `-m` flag is an option (inference, not run).
- The optional variant 5 saves another 2.0K tokens and no time, at the price of a generated catalog file. Not recommended.

## Spike A2: the cheapest Claude run that writes a commit message

### Method

- **Prompt:** the same file as Spike A (3,422 characters, on stdin). I checked that all 43 diff lines come from `git show -U1 58207d0` (each cut at 160 characters) and then reused the file, because a fresh `git show` excerpt cuts the files differently. By Claude's count it is 1,458 tokens (the full runs minus the floors: 23,856 minus 22,398, and 2,081 minus 623). The floor prompt is "Reply with: ok".
- **Working directory:** an empty scratch folder, not a repository.
- **Numbers:** `claude -p --output-format json` returns `usage` (input, cache creation, cache read, output tokens), `total_cost_usd` and the durations. The cost is the CLI's list-price figure (`costBasis: list`), not what the subscription is charged. **Input tokens in the tables are input plus cache creation plus cache read**, because the split only tells what ran just before: the prompt was the same every time, so the first run of a variant wrote the cache and the next ones read it. Wall-clock is the whole process, start to exit. Each variant ran three times; the alternates and floors three times; the timing comparisons six pairs, interleaved.
- **Environment of the runs:** the child process got a clean environment: every `CLAUDE*` and `ANTHROPIC*` variable of the parent session and `MAX_THINKING_TOKENS` removed (Observations say why), then only what a row names. Login is the owner's normal one (keychain), never read. The owner's real `~/.claude` was in play: hooks, plugins, user memory, 33 skills, one MCP server (`codegraph`).
- **Weight of the request:** a stand-in on 127.0.0.1 that records the request body and answers with a 400. It ran with `CLAUDE_CONFIG_DIR` pointing at an empty folder and a dummy `ANTHROPIC_AUTH_TOKEN`, so no real credential existed in that process, and the recorder never stores headers. It shows the built-in text and tools only; the owner's skills, MCP server and memory are absent, so it understates rows 1 to 3.
- **Cost to the subscription:** about 130 real runs, about 1.3M input tokens in all (nearly all of it cache reads of the default variants), about $0.7 at list price.

### Results

Wall is in seconds; cost is the CLI's figure for the run.

| # | Variant | Exact change from the row above | Input tokens (cache read) | Output tokens | Wall (s), three runs | Cost per run | Clean single line |
|---|---|---|---|---|---|---|---|
| 1 | Defaults | `claude -p --output-format json` (model: the owner's `sonnet`, which is `claude-sonnet-5-5`) | 23,856 (23,854; the first run wrote it) | 22 to 23 | 2.61, 2.29, 2.30 (mean 2.4) | $0.096 when it wrote the cache, $0.0026 after | yes, 3 of 3 |
| 2 | No session file | add `--no-session-persistence` | 23,856 (all read) | 21 to 22 | 2.52, 2.40, 2.64 (mean 2.5) | $0.0026 | yes, 3 of 3 |
| 3 | Cheapest model, lowest effort | add `--model haiku --effort low` (`claude-haiku-5-5`) | 24,680 (24,678; the first run wrote it) | 21 to 25 | 3.59, 2.93, 2.75 (mean 3.1) | $0.0049 when it wrote the cache, $0.00026 after | yes, 3 of 3 |
| 4 | Tools, MCP, skills, memory, hooks and CLAUDE.md off | add the list below, and `MAX_THINKING_TOKENS=0` in the environment | 4,375 (4,373) | 23 to 27 | 3.91, 3.67, 3.10 (mean 3.6) | $0.00006 | yes, 3 of 3 |
| 5 | **One-line system prompt (recommended)** | add `--system-prompt "<82 characters>"` | **2,081** (2,079) | 25 | 4.06, 2.30, 2.93 (mean 3.1) | **$0.00003** | yes, 3 of 3 |

Row 4 adds these arguments (all three groups together; the ablation below splits them):

```
--tools "" --strict-mcp-config --disable-slash-commands
--setting-sources user
--settings '{"autoMemoryEnabled":false,"disableAllHooks":true,"claudeMdExcludes":["**/CLAUDE.md"]}'
```

Every answer of rows 1 to 5 and of the alternates below was one line of 53 to 70 characters, so within 72, with no trailing newline in the `result` field (trim anyway).

Equivalent ways to reach rows 4 and 5, three runs each, same tokens (4,375 and 2,081):

| Form | Row 4 wall (s) | Row 5 wall (s) |
|---|---|---|
| `--setting-sources ""` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` in place of `--setting-sources user` and `claudeMdExcludes` | 3.25, 2.64, 2.63 | 3.82, 2.61, 2.49 |
| `--safe-mode --tools ""` (one flag instead of the list: no CLAUDE.md, skills, plugins, hooks, MCP, memory) | 3.27, 2.61, 2.61 | 2.63, 4.18, 2.60 |
| `--bare` (with `--model haiku`, tiny prompt) | **fails**: exit 1, `Not logged in · Please run /login`, 1.0 s, no tokens | |

Timing comparisons, interleaved so both see the same load: **default (row 1) against the recommended run, six pairs: mean 2.6 s (median 2.5) against 2.9 s (median 3.0)**. The recommended run with `--model sonnet` instead of Haiku, six pairs against Haiku: median 2.3 s against 2.6 s, 2,060 tokens, $0.0004 a run after the first (list price, about 14 times Haiku's). Over all 15 runs of the recommended argv: 2.1 to 4.1 s, mean 2.9 s.

### What each part weighs

Floors, measured with the trivial prompt "Reply with: ok": defaults 22,398 input tokens (3.01, 2.36, 2.42 s); row 4 2,917 (2.58, 2.15, 2.26 s); row 5 **623** (2.08, 2.08, 3.44 s; $0.00001). The run uses 4 output tokens.

Where the tokens went, from single runs of "Reply with: ok" on Haiku at low effort, each row adding one thing to the row above:

| Step | Input tokens | Change |
|---|---|---|
| Defaults (the owner's tools, skills, MCP server, memory, hooks) | 23,222 | |
| `--tools ""`, `--strict-mcp-config`, `--disable-slash-commands` | 4,038 | about -19.2K (tool schemas, the skills and agents lists, the MCP server) |
| `autoMemoryEnabled` false (the same with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) | 3,294 | about -0.74K |
| `--setting-sources user` plus `claudeMdExcludes`, or `--setting-sources ""` (user `CLAUDE.md` gone) | 2,917 | about -0.38K |
| `disableAllHooks` | 2,917 | none |
| `--system-prompt` of one line | 623 | about -2.3K |

Request weight, recorded from the stand-in with an empty config (characters; the tools of row 1 are the built-in ones):

| Variant | Request body | System text | Tool schemas | Tools sent | Message text |
|---|---|---|---|---|---|
| 1 (the stand-in's default model was `claude-opus-5-5`: no `model` setting) | 49.9 KB | 5,972 | 30,350 | 12: `Agent`, `Bash`, `Edit`, `ListAgents`, `Read`, `ReportFindings`, `ScheduleWakeup`, `Skill`, `ToolSearch`, `Workflow`, `Write` and a placeholder for deferred tools | 13.6K (the prompt 3.4K, the rest reminder blocks) |
| 3 | 52.7 KB | 8,764 | 30,350 | the same | 13.6K |
| 4 | 11.6 KB | 6,327 | none | none | 4.6K (the prompt, and an environment block of about 1.0K) |
| 5 | 5.5 KB | 218 (a billing header 80, the SDK line 62, mine 82) | none | none | 4.6K |

### Observations that explain the table

- **Claude can drop every tool, Codex cannot.** The `system/init` message of row 4 says `tools: 0`, `mcp_servers: 0`, `skills: 0`, and the run took one turn (`num_turns` 1). The request of row 5 carries no tool schema at all. The Codex floor of about 3.3K tokens comes from `exec` and `wait`; Claude's floor is 623.
- **The saving is tokens and cost, not seconds.** Every row took 2.1 to 4.1 s, and the interleaved pairs put the default at 2.5 s and the recommended run at 2.9 s. `claude --version` starts in 0.01 s, and the API part of a run was about 1.0 to 1.6 s. Inference: the wall time is a fixed process init plus one round trip, and neither the model nor 20K fewer tokens moves it. The floor is about 2.1 s.
- **Who starts `claude` changes the defaults a lot.** Run from inside a Claude Code session (the first batch of this spike, before I cleaned the environment): rows 1 and 2 were 39.0K tokens and 3.1 to 9.2 s (six runs; one run with 139 output tokens took 9.2 s), and row 3 was 39.9K tokens, 4.6 to 5.9 s, with 157 to 218 thinking tokens at `--effort low` (three runs); a clean environment gave 23.9K, 2.3 to 2.6 s and 0 thinking tokens. I bisected it: `CLAUDE_CODE_ENTRYPOINT=claude-vscode` alone loads the claude.ai connectors (Claude Docs, Google Drive) and the Artifact tools (36 tools against 25). `CLAUDECODE`, `CLAUDE_EFFORT=xhigh` and the others changed nothing. With the recommended argv the same entrypoint costs about 300 more tokens (2,388 against 2,081, two runs each form), so the argv absorbs it. The daemon should still start the child without the parent's `CLAUDECODE` and `CLAUDE_CODE_*` markers, in case it was launched from a Claude Code terminal.
- **Thinking.** Haiku 5.5 always reasons adaptively (the docs say so): the request carries `thinking: adaptive` whatever `MAX_THINKING_TOKENS=0` or `alwaysThinkingEnabled: false` say (observed on the stand-in); `CLAUDE_CODE_DISABLE_THINKING=1` drops the parameter. In a clean environment all of about 40 runs on Haiku had 0 thinking tokens, with `--effort low` and without it (two runs), so `--effort low` is a guard, not a measured saving. On the older `claude` 2.1.83 on this machine (`haiku` is `claude-haiku-4-5` there) the same argv without the variable took 24.2 s and 2,900 output tokens, and with `MAX_THINKING_TOKENS=0` 1.9 s and 15 output tokens (one run each). The variable costs nothing on 5.5, so the recommendation sets it.
- **Memory and CLAUDE.md.** `autoMemoryEnabled: false` removes the auto-memory block (about 0.74K tokens); either `--setting-sources ""` or `--setting-sources user` with `claudeMdExcludes` removes the user `~/.claude/CLAUDE.md` (about 0.38K). No project CLAUDE.md was involved: the folder is empty. `disableAllHooks` changes no token count; it is in the argv so that the person's hooks do not run for a background call (their effect on time was not isolated).
- **`--setting-sources user` against `""`.** Both give the same request. `user` keeps the person's own `env`, `apiKeyHelper` or gateway from `~/.claude/settings.json`; `""` would drop them. Inference, not run: a person on an API key, Bedrock or Vertex set in `settings.json` needs `user`.
- **`--safe-mode` is a shortcut that older versions lack.** It gave the same tokens as the list, but `claude` 2.1.83 prints `error: unknown option '--safe-mode'` and exits 1 in 0.4 s, while the explicit list ran on it. Two `claude` binaries are on this machine's PATH (2.1.312 in `~/.local/bin` first, 2.1.83 in `/opt/homebrew/bin`); the daemon takes the first one.
- **`--bare` cannot use the subscription.** `--help` says OAuth and keychain are never read and only an API key counts; the run confirms it (exit 1, JSON with `is_error: true`).
- **Failures are clean.** A wrong model (`--model claude-nope-9`) exits 1 in 2.0 s with JSON on stdout (`is_error: true`, `api_error_status: 404`, `result` "There's an issue with the selected model ..."), and a line with `[claude-code:unrecognized_model]` on stderr. The login failure has the same shape. So: exit code non-zero or `is_error` true is `Couldn't write the message`.
- **The cache is shared across processes.** Run 2 read what run 1 wrote, and the first run of a following variant already read part of the previous one. The entries are one-hour ones (`ephemeral_1h` in `usage`). In use the diff changes every time, so only the stable part of row 5 (about 0.6K tokens) is read and the diff (about 1.5K) is written: that is the $0.0004 figure (the first run of the `--setting-sources ""` form of row 5, which wrote 2,079 tokens, cost $0.00043), not the $0.00003 of an exact repeat.
- **Answers.** The type and scope vary (`fix(agents)`, `fix(desktop)`, `feat(agents)`, `refactor(agents)`); the real commit was `feat(desktop): ...`. Three runs of the recommended argv returned the same string. In the first batch (inherited environment) one answer in nine was 75 characters, so the daemon needs a rule for a line over 72 (cut at a word, or show it, since the person edits the box).
- **Models.** On this account `haiku` resolves to `claude-haiku-5-5` and `sonnet` to `claude-sonnet-5-5`; `modelSettings` in the owner's settings also names `claude-opus-5-5`. `--help` offers the aliases `fable`, `opus` and `sonnet`, and `haiku` worked. "Cheapest" is by class (inference); the list-price figures of the runs agree (Haiku about 14 times cheaper than Sonnet per run). `--effort low` is accepted by Haiku 5.5: the request carries `output_config.effort: "low"` and the API took it.
- **ACP comparison:** not measured. `claude -p` got cheap, which was the condition for running it.

### Recommended command

Run it in an empty temporary folder as the working directory, with `MAX_THINKING_TOKENS=0` in the environment, the prompt on stdin, and a limit of about 30 s (the run takes 2 to 4 s). The system prompt is the Codex instruction, passed inline, so no file is needed.

```json
["claude", "-p", "--output-format", "json", "--no-session-persistence",
 "--model", "haiku", "--effort", "low",
 "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
 "--setting-sources", "user",
 "--settings", "{\"autoMemoryEnabled\":false,\"disableAllHooks\":true,\"claudeMdExcludes\":[\"**/CLAUDE.md\"]}",
 "--system-prompt", "You write git commit messages. Reply with the single line asked for, nothing else."]
```

Measured (fifteen runs): **2,081 input tokens (about 0.6K fixed, the prompt 1.5K), 22 to 27 output tokens, 2.1 to 4.1 s (mean 2.9 s), $0.00003 to $0.0004 a run**, against 23.9K tokens, 2.5 s (mean of nine) and $0.0026 to $0.096 for the defaults: 91 percent fewer input tokens and no gain in time. Parse stdout as JSON, read `result` and trim it, and treat a non-zero exit or `is_error: true` as `Couldn't write the message`. The floor is 623 tokens and about 2.1 s.

How it compares with Codex (Spike A; the two tokenizers differ, so counts are indicative):

| | Codex (`gpt-6-luna`, low) | Claude (`haiku`, low) |
|---|---|---|
| Recommended run | 6.3K input tokens, 4.1 s (3.7 to 4.8) | 2.1K input tokens, 2.9 s (2.1 to 4.1) |
| Defaults | 21.5K, 7.4 s | 23.9K, 2.5 s |
| Floor | 3.3K tokens, 3.6 s (needs a custom model catalog) | 0.6K tokens, 2.1 s |
| Tools in the request | `exec` and `wait` stay (9.1K characters) | none |
| Setup | an instructions file the daemon writes | none: everything is in the argv |
| Cost reported by the CLI | no | yes (list price) |

Limits of this recommendation:

- The flags and settings keys are those of `claude` 2.1.312. A flag that a later version removes fails the run (`unknown option`, exit 1, as `--safe-mode` does on 2.1.83). The explicit list, with `MAX_THINKING_TOKENS=0`, ran on 2.1.83 too (one run); the `haiku` alias there is `claude-haiku-4-5`. A test that runs the argv against the installed `claude` would catch drift. An unknown settings key is skipped, by the docs (not tested).
- `--setting-sources user` keeps the person's user settings, so a hook or an `env` they set there still applies, except the hooks `disableAllHooks` turns off. Not run with a gateway, API key, Bedrock or Vertex login.
- Haiku may not be on another plan; a missing model fails cleanly (observed for a wrong name). Falling back to the same argv without `--model` is an option (inference, not run).
- The cost figures are the CLI's list prices, not the subscription's accounting; how the subscription counts cache reads is not known. The cached share comes from repeating one prompt.
- The numbers are of one subscription, one afternoon and three runs per variant (spread 2.1 to 4.1 s). Rows 1 to 3 depend on the owner's `~/.claude`; rows 4 and 5 do not.
- The request recording used an empty config and a dummy token, so it shows built-in text only.

## Spike B: commit and SSH from a process started the way the daemon starts

### Facts of the machine (read only)

- `commit.gpgsign=true`, `gpg.format=ssh`, `user.signingkey` is a public key file inside Secretive's container, `gpg.ssh.allowedsignersfile` is set, and `url.git@github.com:.insteadof=https://github.com/`. `origin` is `git@github.com:kachurun/clowdy.git`.
- `~/.ssh/config` has `Host github.com` (`User git`, `IdentitiesOnly yes`) and `Host *` with `IdentityAgent` set to Secretive's socket.
- The current shell's `SSH_AUTH_SOCK` is Secretive's socket. `launchctl getenv SSH_AUTH_SOCK` is launchd's own listener socket (`/var/run/com.apple.launchd.<id>/Listeners`), which is what an app opened from Finder inherits.
- `$SHELL -ilc 'printf %s "$PATH"'` (what `apps/desktop/src/main/loginShell.ts` runs) gave the owner's PATH, with Homebrew's `git` first and `/usr/bin/ssh-keygen` and `/usr/bin/ssh` from the system.

### Runs

The environments follow the brief: (1) the current shell; (2) `env -i HOME=$HOME PATH=<login PATH> SSH_AUTH_SOCK=<launchd's>`, the Finder case; (3) the same with no `SSH_AUTH_SOCK`. Each commit was made in a throwaway repository with no `-c` override, and each read was `git ls-remote origin HEAD` in the Clowdy repository (no fetch, no push). Both repeated with `GIT_TERMINAL_PROMPT=0`, which the daemon sets; it changed nothing in any row. All throwaway repositories are deleted.

| Environment | Signed `git commit` | `git ls-remote origin HEAD` |
|---|---|---|
| 1. Current shell (Secretive socket) | success in 0.2 s; `git log --show-signature` says `Good "git" signature for <the owner's email> with ECDSA key SHA256:<fingerprint>`; with `GIT_TERMINAL_PROMPT=0` 0.24 s | success, 2.2 s; with `GIT_TERMINAL_PROMPT=0` 2.0 s |
| 2. `env -i`, login PATH, launchd's `SSH_AUTH_SOCK` | **fails** in 0.1 s: `error: No private key found for public key "<Secretive PublicKeys/....pub>"?` then `fatal: failed to write commit object`; no commit exists. The same failure with `USER`, `LOGNAME`, `SHELL` and `TMPDIR` added. | success, 2.05 s, with and without `GIT_TERMINAL_PROMPT=0` |
| 3. `env -i`, login PATH, no `SSH_AUTH_SOCK` | **fails**, the same two lines, 0.1 s | success, 2.1 s, with and without `GIT_TERMINAL_PROMPT=0` |

Two ways of finding the socket, tried inside a stripped Finder-like environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`, launchd's socket or none):

| Source | Result | Signed commit with it (login PATH, `GIT_TERMINAL_PROMPT=0`) |
|---|---|---|
| `$SHELL -ilc 'printf %s "$SSH_AUTH_SOCK"'` | printed Secretive's socket, not launchd's, in 0.38 s, whether or not launchd's socket was in the environment | success, 0.19 s |
| `ssh -G github.com`, the `identityagent` line | printed Secretive's socket (the same for an unrelated host, because of `Host *`) | success, 0.19 s |

### Touch ID

No Touch ID prompt appeared in any run, and none of the signing or SSH calls waited: signing took 0.2 s and the `ls-remote` time (2.0 to 2.2 s) is the network. A search of Secretive's system log around the first signed commit for LocalAuthentication, biometric, Touch ID and authentication entries found none (its log does show its connection checks and notification handling). Inference: this key is not set to require authentication, or an earlier authentication was still valid. The wait for a person's fingerprint could therefore not be timed here.

### What the daemon must do

- **Signing needs the agent's socket in the child's environment.** Observed: the same failure with launchd's socket and with none. Inference, from OpenSSH's behaviour: `ssh-keygen -Y sign` (what git runs for `gpg.format=ssh`) reads only `SSH_AUTH_SOCK`, while `ssh` also reads `IdentityAgent` from `~/.ssh/config`, which is why SSH works everywhere and signing does not.
- **Find the socket, in this order:**
  1. `ssh -G <origin host>` and its `identityagent` line, when it is an absolute path (not `none`, not the literal `SSH_AUTH_SOCK`). It is fast, needs no shell startup, and follows the setting that already makes SSH work.
  2. Else the login shell's `SSH_AUTH_SOCK`, taken the way `PATH` is taken (the same `-ilc` shell, 3 s timeout, cached). Both ways worked on this machine; the second covers people who export the socket from their shell and set no `IdentityAgent`.
  3. Else keep the inherited value.
  Do not apply "set it only when unset": the Finder case is set, to launchd's socket, which has no key. Setting it for every `commit` and for `fetch`, `push` and `pull`, which would also pick up a hook that signs, costs nothing.
- **Where:** in the daemon, on the environment of its git write calls (`GIT_TERMINAL_PROMPT=0` goes with it), not by changing the app's environment, because the daemon outlives the app and may have been started from a terminal. The first resolution is cached and redone after a git failure that names the signing key.
- **When it still fails, show git's own line** (`No private key found for public key ...`) with a hint such as "The signing agent was not reachable", so the error is not a bare `fatal`.
- **Timeouts for Stage 7 and 8:** a commit takes 0.2 s, a read of `origin` 2.1 s. A Touch ID wait is the person's own time, which was not observed. I suggest 120 s for `commit` (long enough for a person to reach the sensor; a hung agent still ends) and 60 to 120 s for `fetch`, `pull` and `push` (the network, plus a possible Touch ID wait if the key requires one for SSH authentication too). These are suggestions, not measurements.

## Assumptions and limits

- **One machine, one agent.** Everything about signing and SSH was run with Secretive and this `~/.ssh/config`. Another agent (1Password, `ssh-agent` from the shell) or a key with a passphrase was not run. A key file protected by a passphrase would ask on a terminal, which the daemon does not have (inference, not run).
- **No Touch ID wait and no push.** No prompt appeared, so the wait was not timed. Nothing was fetched or pushed; `ls-remote` is the only network call.
- **The Finder environment was imitated, not captured.** I used `env -i` with the PATH the app would build and launchd's socket. A real Finder launch also sets other variables; adding `USER`, `LOGNAME`, `SHELL` and `TMPDIR` changed nothing.
- **The login-shell run for the socket used `/bin/zsh -ilc` with no terminal.** The result may differ on a shell whose startup files print or prompt.
- **Codex numbers are of one subscription and one afternoon.** The prompt is one three-file diff. The fixed floor, the cached share and the latency can move with load; three runs per variant is a small sample (the spread was 0.2 to 1.1 s).
- **The request recordings used a stand-in provider.** The tool list for the real provider may include a hosted tool the stand-in did not offer; the real-run token counts do not depend on it.
- **Whether `codex exec` attaches to the owner's long-running `codex app-server` was not checked.** Such processes were running; if exec uses them, a machine without one may start slower.
- **Claude numbers are of one subscription and one afternoon too.** Three runs per variant (the spread was 2.1 to 4.1 s), repeating one prompt, so the cached share is that of an exact repeat. What `claude -p` loads by default depends on who starts it (Spike A2, Observations); the numbers are for a clean environment.
- **Not run:** an ACP session (for either agent), a run on Windows, a version of Codex other than 0.171.0 or of Claude Code other than 2.1.312 (2.1.83 only for the explicit flag list, one run), a Claude login through an API key, Bedrock or Vertex, a commit through the daemon itself (the spikes ran `git` directly), and any push or fetch.

## Suggested changes to the plan

- Stage 0: both checks hold; record the recommended argv above and the 6.3K-token, 4 s result, and the Claude argv of Spike A2 with its 2.1K-token, 2.9 s result.
- Decisions, commit message: the run is separate and has no tools it can use, but it still sends the code-mode `exec` and `wait` schemas (9.1K characters), because the catalog forces them. The floor is about 3.3K tokens. Claude's run sends no tool at all (floor 0.6K tokens); it is offered as a second provider with the same `Commit messages` switch, with the argv of Spike A2, `MAX_THINKING_TOKENS=0`, and the parent's `CLAUDECODE` and `CLAUDE_CODE_*` variables left out of its environment.
- Stage 7 and Stage 8: add "resolve the signing agent's socket for git writes (`ssh -G`, then the login shell)" to the daemon's git environment, and the timeouts above.
