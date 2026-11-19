# Research: agents and additional folders

Stage 1 of `.briefback/projects-workspaces/plan.md`. Snapshot of 2026-11-19.

## Question and scope

A project becomes several folders. The first is the agent's `cwd`. The others go to the agent as ACP `additionalDirectories` when it advertises `sessionCapabilities.additionalDirectories`, and are otherwise listed in the system prompt. For each agent in `KNOWN_AGENTS` (`claude`, `codex`, `cursor`, `opencode`, `gemini`, `copilot`, `grok`, `omp`, `hermes`), this research asks:

- Does the agent honor the ACP field on `session/new`, `session/load` and `session/resume`?
- Does it read instruction files (`AGENTS.md`, `CLAUDE.md`, its own rules) from the extra folders?
- Can it reach a path outside `cwd` without the field?
- What does Clowdy have to send: nothing, an environment variable, a `_meta` field, a launch flag, or the prompt alone?

The last part is a recommendation for agents that get the folders only in the prompt.

## Summary

- **The ACP field works for Claude, Codex and OpenCode 2.x.** Claude's adapter forwards it on all three methods and does not fail on a missing folder (source and observed). Codex's adapter adds the folders to the sandbox's writable roots and skill roots, also on all three methods (source and observed).
- **Codex does not read `AGENTS.md` or `.codex/config.toml` from the extra folders.** It reads them only from the project root down to `cwd`. Claude reads the extra folders' `CLAUDE.md` only with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
- **Gemini, Copilot and omp ignore the field but have their own flag**, and since every turn is a new process, a launch flag carries the folders as well as the field would. Gemini takes `--include-directories`; its file tools refuse paths outside the workspace without it. Copilot takes `--add-dir`, which stops startup on a missing folder, plus `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` for instruction files. omp takes `--add-dir` before `acp` and loads context files from those roots.
- **Cursor, Grok, Hermes and OpenCode 1.x get the prompt only.** Cursor ACP has no field, no `_meta` key, and ignores its own `--add-dir` in ACP mode. All four still reach absolute paths, freely (Hermes) or through permission requests that the daemon allows.
- **Sending the field to an agent that does not advertise it can break things.** Grok's `session/resume` refuses a non-empty list. Keep the capability gate the plan describes.
- **Recommendation:** keep prompt-only agents selectable and show a note in the agent picker of a multi-folder project. Hiding them would remove agents that work and strand their existing chats, because a chat cannot change its agent once its orchestrator exists. Details in [agents.md](agents.md#recommendation-for-agents-that-get-the-folders-only-in-the-prompt).

| Agent | ACP field | Instructions from extra folders | Reach outside `cwd` without the field | Clowdy needs |
| --- | --- | --- | --- | --- |
| `claude` | Yes, new/load/resume; missing folder accepted (source, observed) | Yes with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; skills always (source) | Asks (docs) | ACP field + env var |
| `codex` | Yes, new/load/resume; folders become writable and skill roots; missing folder accepted (source, observed) | No: `AGENTS.md` and project config only from project root down to `cwd`; skills yes (source) | Reads yes, writes refused by the sandbox (observed) | ACP field; prompt line for `AGENTS.md` |
| `cursor` | No; field ignored; `--add-dir` ignored in ACP mode; no `_meta` (source, observed) | No (source, forum) | Reads yes, writes ask (source) | Prompt only |
| `opencode` | 2.x yes, 1.x no (source, docs) | No (docs) | 2.x yes, 1.x asks (docs, source) | ACP field when advertised, else prompt |
| `gemini` | No (source) | No by default: `GEMINI.md` only with a setting that has no flag (source) | No for file tools; shell not confined (source) | Flag `--include-directories` |
| `copilot` | No (docs, binary strings) | Yes with `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` (docs) | Asks (docs, changelog) | Flag `--add-dir` (existing folders only) + env var; verify with a run |
| `grok` | No; resume refuses the field (source, 2026-09-29 snapshot) | Partly: read on access (docs) | Asks: sandbox off, permissions Ask (docs) | Prompt only |
| `omp` | No (source) | Yes for `--add-dir` roots (docs) | Yes; destructive actions ask (docs) | Flag `--add-dir` before `acp` |
| `hermes` | No (source) | No: outside `cwd` skipped (source) | Yes (source) | Prompt only |

"Asks" means a `session/request_permission` that the daemon allows by default (`CLOWDY_AGENT_PERMISSIONS=allow`). Under `reject` those accesses fail.

## Topic pages

- [agents.md](agents.md): one section per agent with the evidence, then the recommendation and the dated sources.

## Clowdy files this bears on

- `apps/daemon/src/engine/acp/session.ts`: the `shared` request (line 464) is spread into `session/new`, `session/load` and `session/resume`, so one capability-gated `additionalDirectories` there covers all three. The process is spawned before `initialize`, so launch flags and environment variables have to come from the catalog, not from the capabilities.
- `apps/daemon/src/engine/acp/catalog.ts`: `KNOWN_AGENTS` gets Claude's environment variable and, for Gemini, Copilot and omp, a way to turn the folder list into arguments (and, for Copilot, an environment variable). `Launch.args` is static today.
- `apps/daemon/src/engine/acp/probe.ts`: `bun run probe` shows an agent's capabilities. Use it on a machine with OpenCode, Gemini, Copilot, Grok, omp or Hermes to confirm the rows above.

## Important sources

- ACP schema in `@agentclientprotocol/sdk` 2.7.0, `dist/v1/schema/types.gen.d.ts`.
- `@agentclientprotocol/claude-agent-acp@0.107.0` `dist/v1/acp-agent.js` and `@agentclientprotocol/codex-acp@2.6.0` `dist/index.js` in the Bun cache.
- Codex `codex-rs/core/src/agents_md.rs` and `codex-rs/config/src/loader/mod.rs` at `rust-v0.166.0`.
- The Cursor CLI bundle `~/.local/share/cursor-agent/versions/2026.11.13-eacade1/`.
- Vendor repositories and docs for the other agents: anomalyco/opencode at v2.3.2 and v1.19.6, google-gemini/gemini-cli at v0.69.0, Copilot CLI docs and changelog, xai-org/grok-build, can1357/oh-my-pi, NousResearch/hermes-agent. Full list in [agents.md](agents.md#sources).

## Open questions

- **Copilot:** does `copilot --acp --add-dir X` really widen ACP sessions, and does `initialize` lack `sessionCapabilities`? Both are inferred from docs and binary strings. One `bun run probe copilot` and one short prompt on a machine with Copilot would settle them.
- **Gemini and omp:** the launch flags reaching ACP sessions is inferred from source, not run.
- **Grok:** the source snapshot is from 2026-09-29, the npm release from November. Newer builds may advertise the field. The capability gate handles that either way.
- **OpenCode:** the picker note (if chosen) needs to know whether the installed OpenCode is 1.x or 2.x. Either the daemon remembers each agent's last `initialize` capabilities, or OpenCode gets no note.
- **Cursor:** is the shell sandbox on in ACP mode by default, and does a blocked command ask to rerun outside it? Not checked. File tools are covered by the source.
- **Decision for the person:** what to do with prompt-only agents. The recommendation is option 2 in [agents.md](agents.md#recommendation-for-agents-that-get-the-folders-only-in-the-prompt).

## Assumptions and limits

- **No prompt was sent to any agent, so no model was called.** Live runs (2026-11-19, throwaway folders in the scratchpad):
  - `initialize` and `session/new` with one existing and one missing extra folder against the Claude adapter, codex-acp and `cursor-agent acp`. Cursor ran with a scratch `CURSOR_CONFIG_DIR`.
  - `codex sandbox` writes and reads outside `cwd`, with and without `writable_roots`.
  - `claude -p "/usage" --add-dir <missing folder>`, a local command.
- **Why Cursor got no prompt:** the scratchpad is under `/private/tmp`, which Cursor treats as freely writable. A run there could not show the approval path a real project folder takes, so the Cursor answer rests on its source.
- **Installed here:** `claude`, `codex` and `cursor-agent` only. The answers for OpenCode, Gemini, Copilot, Grok, omp and Hermes come from their sources and docs, not from runs.
- **Source versions:** Cursor and Copilot were read from minified or compiled builds, by searching names and strings rather than reading whole modules. Grok was read from a public snapshot older than its current release.
- **Shell commands:** not traced for any agent beyond the Codex sandbox. Where file tools refuse a path, a shell command might still reach it.
- **Not read:** the `v2` protocol path of the Claude adapter (Clowdy speaks ACP v1). Windows behavior of any agent.
