# Orca (stablyai/orca): how it finds agents, runs sessions, and orchestrates

Source: shallow clone of https://github.com/stablyai/orca at `cbc8119e` (commit 2026-11-17 19:48 -05:00), MIT. Read only; nothing installed or run. Paths relative to the repo root, cited `path@cbc8119e`. Observed = read in source or docs; inferred = my reading.

## Summary

- Orca is an Electron app (about 34,000 files in the tree, pnpm). Its agents come in two surfaces: **TUI** (the agent's own CLI in a PTY terminal) and **Chat** (a structured UI over a machine-readable connection). `src/shared/agent-launch/catalog/tui-agent-config.ts@cbc8119e` configures about 45 terminal agents (`claude`, `codex`, `opencode`, `gemini`, `cursor`, `pi`, `goose`, `amp`, `kiro`, `aider`, ...) each with a `detectCmd` used to see whether it is installed.
- **Chat does not use ACP for Claude Code or Codex.** Claude Code runs through the Claude Agent SDK used as a library against the user's own `claude`; Codex through `codex app-server`. Orca has its **own ACP client** (no `@agentclientprotocol/sdk`, generated zod types from the schema JSON) used for nine agents: grok, opencode, opencode2, omp, antigravity, copilot, kimi, cursor, hermes (`src/main/acp/launch/acp-launch-registry.ts@cbc8119e`, `ACP_LAUNCH_SPECS`).
- **Cross-agent work is done through the `orca` CLI plus a skill**, with a durable mailbox, tasks, dispatches and "wake" delivery. Orca passes `mcpServers: []` to every ACP session, i.e. it injects no MCP tools into ACP agents (`src/main/acp/session/start/acp-structured-handshake.ts`, `acp-session-runtime.ts`, `acp-text-task.ts`).
- Orca invests heavily in **process ownership and crash recovery** (an on-disk ownership journal of provider process groups, an orphan guard, retirement proofs) and in **per-agent versioned launch specs**.

## ACP client

- Own implementation under `src/main/acp/`: `transport/` (JSON-RPC peer, write queue, oversized-line and size limits), `protocol/` (initialize, session setup, permission requests, runtime options), `process/acp-agent-connection.ts` (spawn and lifecycle), `launch/` (per-agent specs), `acp-dialects/` (cursor, grok, omp, opencode, copilot, antigravity, kimi, hermes), `discovery/` (session and model discovery), `session/`, `turns/`, `history/`, `timeline/`, `generated/acp-protocol.generated.ts` (from `config/scripts/acp/generate-protocol.mjs`, pinned to `schema-v1.21.0` and a legacy model API `v0.11.6`, with input digests, and a `--check-online` mode).
- `initialize` capabilities: `fs: { readTextFile: false, writeTextFile: false }`, `terminal: false`, plus per-dialect extras (`elicitation: { form: {} }` for omp and antigravity; `_meta.parameterizedModelPicker` for Cursor) (`protocol/acp-session-runtime.ts` ~93-96, dialect files). It rejects an agent that answers another protocol version.
- Session setup (`protocol/acp-session-setup.ts` `setupAcpSession`): `session/new` without a saved id; with a saved id uses `session/load` when the agent advertises it, else `session/resume`; a spec flag `resumePreference: 'resume'` prefers resume. A reopened chat can "catch up" on turns made outside it, using the agent's own turn identity (`historyCatchUp: 'prompt-id' | 'user-message-id'`).
- Orca implements neither fs nor terminal for agents; capability flags `rewind: false` and `threadGoal: false` are set because "ACP has no stable rewind or goal methods" (`session/acp-structured-agent-definitions.ts`). `steering: 'queue'`: mid-turn messages are queued, not injected.
- Permissions: `approvalEnforcement: 'orca'` for ACP agents. Modes are agent-enforced where the agent has them (`permissionModeConfig`), else Orca answers permission requests itself under full access (`acp-launch-permission-modes.ts`, `acpAnswersRequests`). A handler failure, malformed reply or unoffered option answers `cancelled` (`protocol/acp-permission-requests.ts` `answerAcpPermission`). A request that is malformed but routable is repaired field by field rather than dropped.

## Discovery: what is installed

| Mechanism | Where | Notes |
| --- | --- | --- |
| Per-agent detection command | `shared/agent-launch/catalog/tui-agent-config.ts`, `main/preflight/{agent-detection,installed-agent-detection,agent-command-detection}.ts` | `detectCmd` (plus aliases and required commands, for example `claude-agent-teams` also needs `claude`). Detection hydrates the login-shell PATH first (`hydrateShellPath`, Windows persisted PATH, WSL guests). |
| Command resolution for chat | `main/acp/launch/acp-launch-command.ts` `resolveAcpLaunchCommand` | Order: an explicit Command setting for the agent, then a managed release Orca installed on request (`managedRuntime`), then PATH plus the spec's `installDirectories` (`~/.opencode/bin`, `$GROK_HOME/bin`). "Prefer explicit commands, then managed releases, then complete pinned copies on PATH." |
| Managed release (opt-in download) | `AcpLaunchSpec.managedRuntime`, `main/node-runtime/managed-runtime-release.ts`, the only launch spec I found that sets it is Antigravity's (`main/antigravity/antigravity-acp-launch-spec.ts`) | A pinned download (`url`, `archiveSha256`, per-member sha256 and size) that Orca installs into its data directory only on request, validated by a start check that uses no user credentials (`ManagedRuntimeStartFailure`: timeout, exit, version). When present it outranks PATH. This is the one place I found where Orca fetches an agent itself, and only when the user asks. |
| Version gates | `AcpLaunchSpec.minimumVersions`, `versionArgs` (`launch/acp-launch-contract.ts`, `acp-launch-version.ts`) | "Ascending release-line minimums, checked before creation and at every launch." Example: OpenCode verified lines 1.18.31 and 2.0.14; omp first ACP release 17.0.5. |
| Missing executable | `main/provider-process/provider-executable-missing.ts` | Spawn absence is proven separately from an exit; worker start for a missing CLI "fails as an `agent_readiness` timeout" (`skill-guides/orchestration.md`). |
| Login | spec `loginCommand` from `agentSessionSetupFor(agent)`, `authMethod(...)` picker, `signIn` watcher | Grok: prefers `XAI_API_KEY` if advertised `xai.api_key`, else `cached_token`, never prompts interactively. A line in agent output that is a valid sign-in link keeps the chat open signed-out and surfaces the link (`AcpSignInWatch`). Claude: Orca runs `claude auth login` itself (see "Accounts"). |
| Account binding | `launch/acp-account-binding.ts` | Several agents get a per-account home directory env (for example `GROK_HOME`, `PI_CODING_AGENT_DIR`) so a chat can be pinned to one account. |
| Health | `main/environment-doctor/*` | Checks for git, repo tools; not agent-specific. |

## Processes

- `AgentConnection` (`acp/process/acp-agent-connection.ts`) extends the session runtime and wraps `spawnManagedProviderProcess` (`main/provider-process/managed-provider-process.ts`, `@orca/process-host`).
- Teardown: brief SIGTERM grace `PROVIDER_BRIEF_SIGTERM_GRACE_MS = 1_000`, a supervisor maximum stop time, group termination with descendant verification (`provider-process-teardown.ts`, `provider-process-close.ts`). Close results report `root: 'exited'` and `killDelivered`.
- Crash recovery: `provider-ownership-journal.ts` persists, per provider group, `{ pid, ppid, pgid, startedAt, startResolution, bootId, hostname, statePath, owner, leader, watcher }`; `provider-group-orphan-guard.ts` sweeps an orphaned group only when the recorded identities still match (`absent | killed | refused`), and "second-resolution identities are admissible only after a matching reread beyond their start second". This is the same idea as Clowdy's `runs/processes.ts` start-time check.
- Output handling: stderr tail 8,192 chars (`STDERR_TAIL_MAX_CHARS`), per-line caps, secret redaction (`observability/redactor`), exit-output drain delay so the last lines are read after exit.
- Environment: children get the user's shell environment with Orca plumbing scrubbed (`STRUCTURED_CHILD_ENV_TO_DELETE`, `processEnvWithoutAgentSession`, per-spec `scrubEnvironment`; the Claude connection says "Always supply scrubbed env to prevent ambient auth leaks; only launch.env may pin CLAUDE_CONFIG_DIR").

## Claude Code and Codex in Chat (not ACP)

- `main/claude/claude-stream-json-connection.ts`: `loadClaudeAgentSdk()` dynamic-imports `@anthropic-ai/claude-agent-sdk` (`package.json` pins 0.3.319) and calls `query({ prompt, options: { pathToClaudeCodeExecutable: <user's CLI>, spawnClaudeCodeProcess, canUseTool, ... } })`. The launch type documents `pathToClaudeCodeExecutable` as "Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed".
- Orca also reads Claude's frames directly (`native-chat/agent-session-wire/providers/claude-stream-json-frame-schema.ts` lists every SDK message kind it classifies, pinned to "SDK 0.3.251 / Claude Code 2.1.258"), keeps hooks (`main/claude/hooks`), and reads transcripts for history and usage (`main/claude-usage/scanner.ts`).
- Codex: `main/codex/app-server/*` (handshake, record dispatch, exit proofs), shared-server probes, accounts.

## Cross-agent orchestration

- Documented in `docs/site/content/docs/cli/orchestration.mdx` and `skill-guides/orchestration.md` (shipped as the `orchestration` skill). Concepts: **Run** (durable namespace and coordinator inbox), **Task** (spec + dependencies: pending, ready, dispatched, completed, failed, blocked), **Dispatch** (one attempt of a task on a terminal), **Message** (`status`, `dispatch`, `worker_done`, `escalation`, `question`, `heartbeat`...), **decision gate**. It is marked Experimental in Settings.
- Agents act through shell commands: `orca orchestration worker-start --task ... --worktree current|new-child|new-top-level --agent codex [--model --effort]`, `send`, `check`, `reply`, `worker-stop`, `worker-release`, `deny`/`approve`. Any agent id enabled on the worker server can be a worker; "Have Codex (or Claude) review this and report back" means an Orca worker of that agent.
- Delivery: the coordinator is told to **end its turn**; Orca wakes it when a worker reports, asks or stops. In Chat each message arrives whole as its own message; for terminals or very large messages the wake names a `check` command. Mail is consumed FIFO by `check`; group addresses `@all`, `@idle`, `@claude`, `@codex`, `@worktree:<id>`.
- Workers learn the IDs through an injected preamble ("Task and Dispatch IDs") and a launch token env `ORCA_AGENT_LAUNCH_TOKEN` (`agent-launch/agent-launch-token.ts`).
- Permission prompts held by a worker escalate to the coordinator, which may `deny` with a reason; `approve` only if the user enabled "Let coordinators approve worker permission prompts".
- Orca also has `orca worktree create --agent <id> --prompt ...` for fire-and-forget handoff (no report back), terminal control and many other commands through the `orca-cli` skill.

## Worktrees and "per agent"

- Worktree-native: every task is a `git worktree` with its own branch and agent terminals; creation runs in the background; start-from ref picker; setup scripts (`docs/site/content/docs/model/worktrees.mdx`). Agent choice is per terminal or chat, per worktree.
- Remote: a paired Remote Orca Server, SSH hosts and WSL, per-workspace cloud VMs; mobile app (README).

## Usage and accounts

- **Orca reads the subscription credentials of Claude and Codex and calls vendor usage endpoints with them.** For Claude, `main/rate-limits/providers/claude/claude-oauth-credentials.ts` reads the OAuth `accessToken` from the Claude keychain items (`scoped-keychain`, `legacy-keychain`) or `.credentials.json`, and `claude-oauth-usage-request.ts` sends it as `Authorization: Bearer ...` to `https://api.anthropic.com/api/oauth/usage` (windows `five_hour`, `seven_day`, extra spend). For Codex, `rate-limits/providers/codex/*` calls `https://chatgpt.com/backend-api/wham/usage` and `.../wham/rate-limit-reset-credits` (plus a "consume" call). It also computes token and cost from transcript files (`main/claude-usage/*`, `codex-usage/*`). **[observed]** These are usage reads, not model requests, but they use the subscription token outside the vendor CLI; see `policy.md`.
- **Managed accounts**: `main/claude-accounts/*` runs the Claude login itself (`sign-in/claude-login-session.ts`, `claude-pasted-code-login.ts`, `service.ts` `runClaudeCommandProcess`), keeps several Claude accounts in profile directories with a runtime-auth layer (`runtime-auth/keychain`, `profiles/`) and has an account `selection/` module that takes a rate-limit source (choosing by remaining limit is **[inferred]** from the constructor and type names). `codex-accounts`, `cursor-accounts`, `grok-accounts` directories exist; I did not read them. This goes beyond "use what is already logged in".
- Per-turn failures: `acp-turn-failure-evidence.ts`, `acp-prompt-failure.ts` classify failures from the process and the wire.

## Constraints and quirks

- Each ACP agent has a named spec with a verified version list, model discovery policy (`initialize`, `command`, or a disposable `session`), compaction support, transcript import and session-history readers. Orca's code treats "ACP agents" as nine hand-integrated agents, not a plug-in point for arbitrary agents.
- OpenCode 1.x cannot answer ACP questions, so Orca sets `OPENCODE_ENABLE_QUESTION_TOOL=false`; omp needs `PI_NO_PTY=1` once forms are answerable (`acp-launch-registry.ts` comments).
- Some agents write sessions the client cannot delete, so Orca runs no naming side-tasks for them (`keepsEverySession`).

## Sources

- `README.md`, `AGENTS.md`, `src/main/acp/**`, `src/main/provider-process/**`, `src/main/claude/claude-stream-json-connection.ts`, `src/main/claude-accounts/**`, `src/main/rate-limits/providers/**`, `src/main/preflight/**`, `src/shared/agent-launch/catalog/**`, `skill-guides/orchestration.md`, `docs/site/content/docs/cli/orchestration.mdx`, `docs/site/content/docs/model/worktrees.mdx` at `cbc8119e` (read 2026-11-17)

## Open questions

- Which of Orca's ACP agents honor `mcpServers` (Orca never sends any, so this repo cannot tell).
- How Orca delivers a "wake" into a Chat session technically (hook, injected user message, or PTY write). I read only the docs side.
- Whether Orca's Claude Chat can run without the SDK's bundled binary on a fresh install (the comment says the binary "is not installed"; the packaging path was not read).

## Assumptions and limits

- Read about 25 files in `src/main/acp`, `provider-process`, `claude`, `rate-limits` and the two docs pages. I did not read the mobile app, cloud, remote runtime, plugin system or renderer. Behavior was not run.
