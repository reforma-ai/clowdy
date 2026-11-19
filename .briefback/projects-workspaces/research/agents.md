# Agents and folders outside the working directory

Snapshot taken 2026-11-19. One section per `id` in `KNOWN_AGENTS` (`apps/daemon/src/engine/acp/catalog.ts`). Each section answers four questions:

- **ACP field**: does the agent advertise `sessionCapabilities.additionalDirectories` and honor `additionalDirectories` on `session/new`, `session/load` and `session/resume`?
- **Instructions**: does it read `AGENTS.md`, `CLAUDE.md` or its own rules file from the extra folders?
- **Reach without the field**: can it read and write a path outside `cwd` when it gets only the absolute path in the prompt?
- **Clowdy needs**: what Stage 3 has to wire.

"Observed" means a run on this machine (2026-11-19). "Source" means code read at the version named. "Docs" means the vendor's documentation. Anything else is marked as inferred.

Background for every section: the daemon answers every `session/request_permission` with the one-time allow option (`CLOWDY_AGENT_PERMISSIONS=allow`, the default). So "asks" below means "works in Clowdy, with one permission round trip per access", and fails under `CLOWDY_AGENT_PERMISSIONS=reject`. Each run is a new agent process (`apps/daemon/AGENTS.md`, "One session is one process, one turn"), so a launch flag or an environment variable can carry a different folder list on every turn, the same as the ACP field.

## Claude Code (`claude`)

Launched as `@agentclientprotocol/claude-agent-acp@0.107.0` with the person's `claude` (2.1.322 here).

**ACP field: yes, on all three methods** (source, observed).

- `initialize` advertises `additionalDirectories: {}` (`dist/v1/acp-agent.js`, the `sessionCapabilities` block near line 526). The probe here printed it, next to `resume`, `list`, `systemPrompt` and others.
- `session/new` goes to `createSession(request)` with the whole request. `session/resume` goes to `getOrCreateSession(params)`. `session/load` goes to `createSessionWhileReplaying(params)` or to `getOrCreateSession(params)` when the connection already holds the session. All three paths pass `params.additionalDirectories` into `createSession`.
- `createSession` builds the list as `_meta.claudeCode.options.additionalDirectories` (if any) followed by the ACP list. When the ACP field is absent it falls back to the legacy `_meta.additionalRoots`. The result goes to the Claude Agent SDK as `options.additionalDirectories` (around line 7379 and 7635). The SDK (0.3.323) turns each entry into a `--add-dir` argument for the CLI.
- Validation (`validateCwd`, around line 7252): every entry must be absolute, otherwise `invalid_params`. Existence is not checked: the code comment says "a missing extra root does not fail a session".
- Observed: `initialize` plus `session/new` with one existing and one missing folder returned a session id. `claude -p "/usage" --add-dir <missing folder>` (a local command, no model call) started and ran normally, so the CLI also tolerates a missing `--add-dir`.
- A live session whose directory list changes on `load` or `resume` is torn down and recreated (`additionalDirectories` is in `OPTION_REBUILDS_SESSION`, `dist/v1/session-fingerprint.js`). That does not affect Clowdy, which starts a fresh process every turn.
- Do not also send the list in `_meta.claudeCode.options.additionalDirectories`. The adapter concatenates both sources, so the folders would be passed twice.

**Instructions: yes, with `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.** The variable is read in the shipped binary: the list of folders whose `CLAUDE.md` is loaded is the additional directories only when it is set (source, binary strings of 2.1.322). Skills in the added folders load without it (already established in the plan).

**Reach without the field: asks.** Claude Code reads outside its working directories only after approval and asks before edits (docs: permissions, "Working directories"). Not relevant once the field is sent.

**Clowdy needs:** the ACP field, behind the capability, and `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` in the catalog's `env`. Nothing else. A folder that vanished between the check and the launch does not break the session.

## Codex (`codex`)

Launched as `@agentclientprotocol/codex-acp@2.6.0` with the person's `codex` (0.166.0 here).

**ACP field: yes, on all three methods** (source, observed).

- `initialize` advertises `additionalDirectories: {}` (`dist/index.js`, near line 51068). Observed in the probe.
- `newSession`, `loadSession` and `resumeSession` each call `readAdditionalDirectories` (near line 43843), which accepts `additionalDirectories` or the legacy `_meta.additionalRoots`. It refuses non-strings, empty strings and relative paths with `invalid_params`, drops duplicates and an entry equal to `cwd`, and does not check that a folder exists.
- `createSessionConfig` (near line 43392) marks `cwd` and every extra folder as a trusted project and adds the extra folders to `sandbox_workspace_write.writable_roots`. Each turn (`sendPrompt`, near line 43580) adds them again to the turn's sandbox policy, or passes `[cwd, ...dirs]` as `runtimeWorkspaceRoots` when a permission profile is active.
- `refreshSkills` (near line 43481) points Codex's extra skill roots at `<folder>/.agents/skills` for every extra folder.
- Observed: `session/new` with one existing and one missing folder returned a session id.
- Observed with `codex sandbox` (no model call; `/tmp` excluded from the default writable set so the scratch folders count as outside): writing into a folder outside `cwd` failed with "Operation not permitted", reading it worked, and the same write succeeded once that folder was in `writable_roots`. A missing folder in the same `writable_roots` list did not break the sandbox.

**Instructions: no.** Codex reads `AGENTS.md` (and `AGENTS.override.md`, plus `project_doc_fallback_filenames`) only on the path from the project root down to the turn's `cwd`. The project root is the nearest ancestor with a `project_root_markers` entry, `.git` by default. It never walks past it (source: `codex-rs/core/src/agents_md.rs` at `rust-v0.166.0`, `agents_md_paths`). Discovery runs once per turn environment, using only that environment's `cwd`. Writable roots and the environment's `workspace_roots` are not searched. Project config layers (`.codex/config.toml`) follow the same rule: ancestors of `cwd` up to the project root (`codex-rs/config/src/loader/mod.rs`, `load_project_layers` and `discover_project_layers`). The codex-acp adapter has no `AGENTS.md` handling of its own. Only skills come from the extra folders.

**Reach without the field:** reads yes (the default sandbox reads anywhere, observed). Writes are refused by the sandbox. Whether Codex then asks to escalate depends on the approval policy of the mode. Not checked, because the field is sent anyway.

**Clowdy needs:** the ACP field. The other folders' `AGENTS.md` reach Codex only through the system prompt line the plan already has ("each folder may have its own `AGENTS.md`... read it before changing files there").

## Cursor (`cursor`)

Launched as `cursor-agent acp` (2026.11.13-eacade1 here). The source is the minified bundle in `~/.local/share/cursor-agent/versions/2026.11.13-eacade1/`.

**ACP field: no** (source, observed).

- `initialize` answers `sessionCapabilities: { list: {} }`, plus `subagents` when the client negotiates them (`8104.index.js`). Observed: `{ list: {} }`, `loadSession: true`.
- `newSession` and `loadSession` read only `cwd`, `mcpServers` and the session id. The session's workspace is `[cwd]` (`workspacePaths: [cwd]` in the session resources). Observed: `session/new` with `additionalDirectories` succeeded and the field was ignored. The probe ran with a scratch `CURSOR_CONFIG_DIR`, so the person's own Cursor history stayed untouched.
- **No `_meta` key and no working flag either.** The CLI has a repeatable `--add-dir <path>` ("Add an additional workspace root directory") and `--workspace <path-or-name>`, which can name a saved workspace of several folders. The `acp` command computes those workspace directories (only to trust them during worktree setup) but hands the ACP server the raw options, and nothing in the ACP module reads `addDir` or the workspace directories (source: the `acp` action in `index.js`, and no match for `addDir` or `additionalDirectories` in `8104.index.js`). So `cursor-agent --add-dir X acp` has no effect on ACP sessions. Inferred from source, not run with a prompt.
- `sandbox.json` (`~/.cursor/sandbox.json` or `<workspace>/.cursor/sandbox.json`) has `additionalReadwritePaths` for the shell sandbox (docs: sandbox reference). Writing it would mean editing the person's file, or the shared run folder `CURSOR_CONFIG_DIR=<data>/agents/cursor`, which all concurrent runs share. Not a per-run lever.

**Instructions: no.** Rules, `AGENTS.md` and skills load from workspace roots, which in ACP is only `cwd`. With `--add-dir` in the terminal UI, "rules and skills load only from the roots you pass" (forum answer, 2026-09-02). That does not help in ACP.

**Reach without the field: reads yes, writes ask** (source).

- File writes: `shouldBlockWrite` returns `needsApproval` (approval type `fileEdit`) for a path outside the workspace, unless the path is "freely writable": on macOS that is anything under `/private/tmp/` or `/private/var/folders/`, plus Cursor's own data folders and `.md`/`.mdc` rule files under `~/.cursor/`. The approval goes to the ACP client as `session/request_permission`, which Clowdy allows.
- File reads: refused or asked only when the read boundary is `workspace`. The documented default `readBoundary` is `system`, so reads outside are allowed (source: `shouldBlockReadForBoundary`; docs: sandbox reference).
- Shell commands run in Cursor's sandbox, whose default type is `workspace_readwrite`. Whether that sandbox is on in ACP mode by default, and whether a blocked command asks to rerun outside it, was not checked.
- Docs: "Absolute paths can target files outside the project" (CLI permissions reference).
- No live prompt was sent. The scratch folders live under `/private/tmp`, which Cursor treats as freely writable, so a run there could not show the approval path that a real project folder takes. The source answers the question more reliably than that run would.

**Clowdy needs:** prompt only. Never send the field (it is ignored today, and the plan sends it only when advertised).

## OpenCode (`opencode`)

`opencode acp` from github.com/anomalyco/opencode (formerly sst/opencode). Two release lines ship a binary named `opencode`: 1.x (`opencode-ai`, latest v1.19.6, 2026-11-17) and 2.x (`@opencode/cli`, latest v2.3.2, 2026-11-18, which also installs `opencode2`). They behave differently. Not installed here.

**ACP field: 2.x yes, 1.x no** (source, docs).

- 2.x: the ACP docs list `additionalDirectories: {}` among the advertised capabilities and say the client "can pass `additionalDirectories` on `session/new`, `session/load`, `session/resume`, and `session/fork`". Entries must be absolute and free of `*` and `?`. Each request's list replaces the previous one, and the list is stored on the session (`packages/cli/src/acp/directories.ts`). The feature landed in commit 7bb3fbf0 on 2026-10-01 ("feat(acp): support additional workspace directories (#52524)").
- What the field does in 2.x: it adds `external_directory` allow rules for `<folder>/*` (and the folder's real path) in front of the session's other permission rules. It grants access only. Instructions and skills are untouched. Existence is not checked in `parse` (inferred: missing folders are probably harmless).
- 1.x: `initialize` advertises `close`, `fork`, `list` and `resume` only (`packages/opencode/src/acp/service.ts` at v1.19.6).

**Instructions: no.** `AGENTS.md` (or `CLAUDE.md` where no `AGENTS.md` exists) is read from the workspace directory and its parents up to the project root. "Reading a file or listing a directory loads any `AGENTS.md` files between that target and the workspace", but only inside the workspace. The docs say nothing about extra directories (docs: rules).

**Reach without the field: 2.x yes, 1.x asks.**

- 2.x: "The default policy allows `external_directory`, so external paths are not prompted unless you add a rule" (docs: permissions).
- 1.x: the default agent permissions set `external_directory: { "*": "ask" }` (`packages/opencode/src/agent/agent.ts` at v1.19.6). Clowdy allows each ask.

**Clowdy needs:** the ACP field when advertised, which covers 2.x automatically, and prompt only for 1.x. Nothing per version in the catalog, because the capability decides at run time.

## Gemini CLI (`gemini`)

`gemini --acp` from github.com/google-gemini/gemini-cli (latest v0.69.0, 2026-11-19). Not installed here.

**ACP field: no** (source). `initialize` advertises `loadSession`, `promptCapabilities` and `mcpCapabilities`, with no `sessionCapabilities` (`packages/cli/src/acp/acpRpcDispatcher.ts`). `newSession` reads only `cwd` and `mcpServers` (`acpSessionManager.ts`).

**Own equivalent: `--include-directories`, and it reaches ACP sessions** (source). Every session's config is built by `loadCliConfig(settings, sessionId, this.argv, { cwd })`, with the process's own parsed arguments. The `include-directories` option is an array, comma-separated or repeated. It is merged with `context.includeDirectories` from settings, and with `GEMINI_CLI_IDE_WORKSPACE_PATH`, which the IDE companion sets (`packages/cli/src/config/config.ts`). A missing or non-directory entry is skipped with a warning, not an error (`WorkspaceContext.addDirectories`, `packages/core/src/utils/workspaceContext.ts`). Inferred: `gemini --acp --include-directories /a,/b` works, because the ACP manager reuses the parsed `argv`. Not run.

**Instructions: no by default.** `GEMINI.md` from included directories is loaded only when the setting `context.loadMemoryFromIncludeDirectories` is `true`. It defaults to `false` and has no command-line flag (`config.ts`).

**Reach without the flag: no for the file tools.** `validatePathAccess` refuses any path outside the workspace directories and the project temp folder: "Path not in workspace: Attempted path ... resolves outside the allowed workspace directories" (`packages/core/src/config/config.ts`, used by `write-file.ts`, `read-file.ts` and others). Shell commands are not confined unless Gemini's sandbox is enabled, so the agent could still fall back to `cat` or `sed`, clumsily. Prompt-only would leave Gemini half-working.

**Clowdy needs:** a launch flag: `--include-directories <folder>` for each existing extra folder, appended to the run's arguments. The prompt line covers `GEMINI.md`. If Gemini later advertises the ACP field, prefer the field and drop the flag.

## GitHub Copilot CLI (`copilot`)

`copilot --acp` (latest 1.0.114, 2026-11-18; read at 1.0.113). The CLI is closed source. Evidence: docs, the public changelog (github.com/github/copilot-cli), and strings in the `@github/copilot-darwin-arm64@1.0.113` package (read, not run). Not installed here.

**ACP field: no** (docs, binary strings; not run).

- The ACP server page says `session/new` "only lets a client set a few session parameters, such as the working directory", and that startup options are "fixed when the server starts" and apply to every session it creates or loads (docs: ACP server).
- In the native runtime that implements ACP, the `initialize` answer's field names appear in order as `agentCapabilities`, `loadSession`, `mcpCapabilities`, `promptCapabilities`, `embeddedContext`, `agentInfo`, `authMethods`, with no `sessionCapabilities` among them. Inferred from strings, so treat it as likely rather than certain. A `bun run probe copilot` on a machine that has it would settle it.
- Copilot does have `additionalDirectories` inside its own SDK's session options (`filesystem.additionalDirectories`). The docs mention "the SDK's `additionalDirectories`" next to `--add-dir`. That is the Copilot SDK, not ACP.

**Own equivalent: `--add-dir=PATH`, repeatable.** "Allow file access to a directory and load its skills (`.github/`, `.agents/`, `.claude/`) and agents (`.github/`, `.claude/`) as trusted configurations." Warning: "a missing path or a regular file fails startup immediately with a flag-specific error, the same way in every mode" (docs: CLI command reference). The docs do not list `--add-dir` among the options the ACP page names, so whether it applies to ACP sessions is inferred from "values are fixed when the server starts", not confirmed.

**Instructions: yes, through an environment variable.** By default Copilot reads `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.github/instructions/**/*.instructions.md` and `.claude/rules/**/*.md` "in Git root and cwd". `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` is a "comma-separated list of additional directories for custom instructions", read for "Additional `AGENTS.md` and `*.instructions.md` files" (docs: CLI command reference; docs: custom instructions).

**Reach without the flag: asks.** Paths outside the allowed directories prompt for path access. `--allow-all-paths` turns the check off. Changelog entries: "Prompt for path access when long-option values like --name=/path reference files outside allowed directories" and "Approving a command that uses a path outside the allowed directories also approves that path". In ACP the prompt becomes a permission request, which Clowdy allows (inferred from the ACP permission flow, not run).

**Clowdy needs:** a launch flag and an environment variable: `--add-dir <folder>` per existing folder (a missing one would stop the agent from starting), and `COPILOT_CUSTOM_INSTRUCTIONS_DIRS=<folders, comma-separated>`. Check both with a real run before relying on them.

## Grok Build (`grok`)

`grok agent stdio`, xAI's Grok Build CLI (npm `@xai-official/grok`, 1.0.89). Source read from github.com/xai-org/grok-build at `2bdd1d6a` (2026-09-29). That snapshot is about seven weeks older than the npm release, so newer behavior may differ. Not installed here.

**ACP field: no, and resume refuses it** (source).

- `initialize` advertises `close`, plus `list` and `resume` outside chat mode (`crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`).
- `session/resume` with a non-empty `additionalDirectories` fails with `invalid_params` and "session/resume does not support additionalDirectories" (`session_setup.rs`, `RESUME_REFUSES_EXTRA_DIRS`). `session/new` ignores the field.
- `permissions.additionalDirectories` in settings "is parsed but not supported" (user guide: permissions and safety).
- The docs list no `--add-dir`-style flag. `--cwd` sets the single working directory (docs: headless scripting).

Sending the field to an agent that does not advertise it is not always harmless: with Grok it would make every resume fail and fall back to a new session.

**Instructions: partly, on access.** At session start Grok loads `AGENTS.md` (and `CLAUDE.md`-style files and `.grok/rules`) from the repository root down to `cwd`. "When Grok reads, lists, or edits files in directories outside that initial set, it detects any project instruction files there, notes their paths, and reads them when they apply to the task" (user guide: project rules). Startup loading requires folder trust.

**Reach without the field: asks.** The sandbox is "Off by default" (docs: sandbox). The default permission mode is Ask (docs: permissions), which in ACP becomes a permission request that Clowdy allows. Under the opt-in `workspace` profile, writes are limited to the current directory, `~/.grok/` and temp, with no documented way to add writable directories.

**Clowdy needs:** prompt only. Never send the field (the capability check already prevents it).

## omp (`omp`)

`omp acp`, oh-my-pi by Can Bölük (github.com/can1357/oh-my-pi, main as of 2026-11-19, latest release v19.0.0). Not installed here.

**ACP field: no** (source). `initialize` advertises `list`, `fork`, `resume` and `close` (`packages/coding-agent/src/modes/acp/acp-agent.ts`). A multi-root workspace exists internally (`src/session/session-workspace.ts`, added 2026-07-22 in "Add dynamic multi-root workspace context (#2569)"). Its comment says the extra directories come "from the platform (ACP/editor), CLI, or config", but the ACP agent neither advertises nor reads the field yet.

**Own equivalent: `--add-dir <dir>`, repeatable, and it reaches ACP sessions** (source, docs). The CLI builds `additionalDirectories` from `--add-dir` plus the `workspace.additionalDirectories` setting (`src/main.ts`, `buildSessionOptions`). The ACP session factory (`createAcpSessionFactory`) spreads those base options into every session it creates. The CLI reference says leading launch flags "are forwarded to `launch` and `acp`", so `omp --add-dir /a --add-dir /b acp` is the form. Inferred end to end, not run. Whether a missing folder is tolerated is unknown: `normalizeSessionWorkspace` does not check existence.

**Instructions: yes for `--add-dir` roots.** `--no-context-files` disables context files (`AGENTS.md`, `CLAUDE.md`, ...) "for the working directory and every `--add-dir` root", and the context-files doc talks about files "discovered for an additional workspace root" (docs: CLI reference, context files). The system prompt also lists the extra roots under `<workspace-roots>`.

**Reach without the flag: yes, destructive actions ask.** The default approval mode is `yolo` with no path confinement. In ACP, without an explicit opt-in, "unmatched bash commands and destructive file operations still require an ACP client grant" (docs: approval mode), which Clowdy gives.

**Clowdy needs:** a launch flag: `--add-dir <folder>` per existing folder, placed before `acp`.

## Hermes Agent (`hermes`)

`hermes acp`, NousResearch Hermes Agent (github.com/NousResearch/hermes-agent, main as of 2026-11-19, latest release v0.23.2). Not installed here.

**ACP field: no** (source). `initialize` advertises `fork`, `list` and `resume` (`acp_adapter/server.py`). `new_session`, `load_session` and `resume_session` take `cwd` and `mcp_servers` and swallow the rest in `**kwargs`. No flag or setting adds roots.

**Instructions: no.** Hermes loads context files from `cwd` at startup, and later from subdirectories the agent touches through tool calls (`agent/subdirectory_hints.py`). A hint directory outside the working directory tree is skipped ("Skipping hint files in ... outside working_dir"), and a hint file must resolve inside the working directory.

**Reach without the field: yes.** The file tools have no working-directory confinement. They deny protected system and credential paths, and gate `~/.ssh/config` and shell rc files behind approval. The module itself says the guards are "defense-in-depth, NOT a security boundary: the terminal tool runs as the same OS user and can read/write anything" (`agent/file_safety.py`). An optional `HERMES_WRITE_SAFE_ROOT` restricts writes to listed roots. It is unset by default.

**Clowdy needs:** prompt only.

## Recommendation for agents that get the folders only in the prompt

After Stage 3 wires what each agent offers, the agents left with the prompt alone are Cursor, Grok, Hermes and OpenCode 1.x. None of them is locked out. Each one reaches an absolute path: Hermes freely, the others through a permission request that Clowdy allows. What they lose is softer. The other folders' instruction files, rules and skills are not loaded (Grok reads them on access), and writes go through permission round trips instead of granted roots. Under `CLOWDY_AGENT_PERMISSIONS=reject` those writes would fail.

The options:

1. **Keep them selectable, folders only in the prompt.** Simplest, and the work gets done. The person cannot tell why Cursor ignores a rule in the second folder's `AGENTS.md` that Claude follows.
2. **Keep them selectable, with a note in the agent picker of a multi-folder project.** Same behavior plus one line of expectation, for example `Sees the other folders through the prompt only`.
3. **Hide or disable them in multi-folder projects.** Removes agents that work. It also strands existing chats: a chat's agent cannot change once its orchestrator exists (`chat.setModel` refuses `engine` with `conflict`), so adding a second folder would leave every Cursor chat in that project unable to continue.

**Recommended: option 2.** Hiding removes agents that work and strands their chats, so option 3 costs more than it saves. Between the other two, the note is cheap and tells the person what they give up when they pick one of these agents: the other folders' rules and instruction files are not loaded, and access goes through permission requests. The note should be keyed on how the agent gets folders, not on the agent name: an agent that advertises the ACP field, or has a launch flag in the catalog, gets no note. OpenCode shows why. 2.x needs no note, 1.x does, and only the `initialize` answer tells them apart (see the open questions in `index.md`).

## Sources

All fetched or read on 2026-11-19 unless noted.

- ACP schema, `@agentclientprotocol/sdk` 2.7.0: `node_modules/@agentclientprotocol/sdk/dist/v1/schema/types.gen.d.ts` (`NewSessionRequest`, `LoadSessionRequest`, `ResumeSessionRequest`, `SessionAdditionalDirectoriesCapabilities`).
- Claude adapter 0.107.0: `~/.bun/install/cache/@agentclientprotocol/claude-agent-acp@0.107.0@@@1/dist/v1/acp-agent.js` and `dist/v1/session-fingerprint.js`. Claude Agent SDK 0.3.323: `sdk.mjs` (`--add-dir` per entry). Claude Code 2.1.322 binary strings.
- Claude Code docs, permissions, "Working directories": https://code.claude.com/docs/en/permissions
- codex-acp 2.6.0: `~/.bun/install/cache/@agentclientprotocol/codex-acp@2.6.0@@@1/dist/index.js`.
- Codex source at tag `rust-v0.166.0`: https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/agents_md.rs, https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/core/src/environment_selection.rs, https://github.com/openai/codex/blob/rust-v0.166.0/codex-rs/config/src/loader/mod.rs
- Cursor CLI 2026.11.13-eacade1 bundle: `~/.local/share/cursor-agent/versions/2026.11.13-eacade1/index.js`, `8104.index.js`, `cursor-agent --help`.
- Cursor docs: https://cursor.com/docs/cli/acp, https://cursor.com/docs/cli/reference/permissions, https://cursor.com/docs/reference/sandbox. Forum thread (2026-09-02): https://forum.cursor.com/t/support-multiple-workspace-paths-in-cursor-agent-cli/170291
- OpenCode 2.x: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/acp/directories.ts, ACP docs source `services/site/src/docs/content/cli/acp.mdx` (branch `dev`). OpenCode 1.x: https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/acp/service.ts, https://github.com/anomalyco/opencode/blob/v1.19.6/packages/opencode/src/agent/agent.ts. Docs: https://opencode.ai/docs/permissions/, https://opencode.ai/docs/rules/
- Gemini CLI at v0.69.0: https://github.com/google-gemini/gemini-cli/tree/v0.69.0/packages/cli/src/acp, https://github.com/google-gemini/gemini-cli/blob/v0.69.0/packages/cli/src/config/config.ts, https://github.com/google-gemini/gemini-cli/blob/v0.69.0/packages/core/src/utils/workspaceContext.ts, https://github.com/google-gemini/gemini-cli/blob/v0.69.0/packages/core/src/config/config.ts
- Copilot CLI docs: https://docs.github.com/en/copilot/reference/acp-server, https://docs.github.com/en/copilot/reference/cli-command-reference, https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions. Changelog: https://github.com/github/copilot-cli/blob/main/changelog.md. Package `@github/copilot-darwin-arm64@1.0.113` (strings of `prebuilds/darwin-arm64/runtime.node` and `cli-main.js`).
- Grok Build at `2bdd1d6a` (2026-09-29): https://github.com/xai-org/grok-build (`crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs`, `session_setup.rs`, `crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md`, `22-permissions-and-safety.md`). Docs: https://docs.x.ai/build/features/sandbox, https://docs.x.ai/build/features/permissions, https://docs.x.ai/build/cli/headless-scripting
- omp (main): https://github.com/can1357/oh-my-pi (`packages/coding-agent/src/modes/acp/acp-agent.ts`, `src/main.ts`, `src/session/session-workspace.ts`, `docs/cli-reference.md`, `docs/context-files.md`, `docs/approval-mode.md`, `docs/settings.md`).
- Hermes Agent (main): https://github.com/NousResearch/hermes-agent (`acp_adapter/server.py`, `agent/subdirectory_hints.py`, `agent/file_safety.py`).
