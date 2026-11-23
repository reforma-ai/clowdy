# Stage 0 spikes: a tool-free Codex run, and signing and SSH from the daemon's environment

Snapshot 2026-11-22, on the owner's machine (macOS, `codex-cli 0.171.0`, Secretive as the SSH agent). Nothing in the repository was changed to run these; the scratch work lives outside it. "Observed" means a command I ran and its output. "Inference" means my reading of what the observation implies.

## Summary

1. **Commit message from Codex:** a separate `codex exec` run with the user's config ignored, the cheapest model (`gpt-6-luna`), low effort, every optional tool and context block switched off, and a tiny instructions file takes about 4.1 s and 6.3K input tokens (against 7.4 s and 21.5K for the defaults, six runs against three). It answers with one clean line. A custom model catalog can go further (about 4.3K tokens) but buys no speed and is fragile, so it is not the recommendation.
2. **No cheap run is lower than about 3.3K input tokens or about 3.6 s:** that is the floor even for "Reply with: ok" with no tools at all. The fixed part is outside the client's control. An ACP session was not measured, since `exec` already reaches that floor.
3. **A signed commit fails from a Finder-launched app:** with launchd's `SSH_AUTH_SOCK`, or none, `git commit` stops with `No private key found for public key ...`. With the Secretive socket it works in 0.2 s.
4. **SSH to `origin` works in every environment** (about 2.1 s for `ls-remote`), because `~/.ssh/config` sets `IdentityAgent` for all hosts. Signing does not read that file.
5. **The daemon must put Secretive's socket into `SSH_AUTH_SOCK` for git writes:** take it from `ssh -G <origin host>` (`identityagent`), else from the login shell as `PATH` is taken, and prefer either over an inherited value. No Touch ID prompt appeared in any run, so its wait could not be timed.

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
- **Claude:** the owner's brief for this spike named Codex only; the Claude side of the plan's "done when" was not run.

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
- **Not run:** Claude's tool-free run, an ACP session, a run on Windows, a version of Codex other than 0.171.0, a commit through the daemon itself (the spikes ran `git` directly), and any push or fetch.

## Suggested changes to the plan

- Stage 0: both checks hold; record the recommended argv above and the 6.3K-token, 4 s result.
- Decisions, commit message: the run is separate and has no tools it can use, but it still sends the code-mode `exec` and `wait` schemas (9.1K characters), because the catalog forces them. The floor is about 3.3K tokens.
- Stage 7 and Stage 8: add "resolve the signing agent's socket for git writes (`ssh -G`, then the login shell)" to the daemon's git environment, and the timeouts above.
