# bb (get-bb/bb): how it finds agents, runs sessions, and lets agents talk

Source: shallow clone of https://github.com/get-bb/bb at `f1c5304` (commit 2026-11-17 15:40 -08:00), MIT. Read only; nothing installed or run. File paths are relative to the repo root and cited `path@f1c5304`. Observed = read in source or docs; inferred = my reading. Product-copy and Settings details are in `product-surface.md`; the MCP tool path is in `tools-and-mcp.md`; skills in `skills.md`.

## Summary

- bb is a TypeScript pnpm monorepo (apps: `server`, `host-daemon`, `app`, `desktop`, `cli`, `web`, `mobile`; plugins under `plugins/`). Everything provider-specific is a **plugin** that registers a provider and supplies a **bridge process** speaking a single JSON-RPC contract (`docs/provider-bridge-protocol.md@f1c5304`). Core "never branches on a provider id" (`docs/provider-plugin-api.md`).
- **bb is not ACP-for-everything.** Claude Code runs through the Claude Agent SDK pointed at the user's `claude` CLI, Codex through `codex app-server`, Pi through `pi` in RPC mode. ACP covers **Cursor, OpenCode, omp, Grok Build, Hermes Agent**, any custom agent, and any agent added from the official ACP registry. This corrects the sentence in `.briefback/references.md` that lists all eight as ACP.
- bb finds agents by looking on the **login-shell PATH**, probes versions, and treats missing/outdated/logged-out as ordinary states with guidance text. It never ships an agent.
- Each thread belongs to one provider id; each ACP thread is **one agent process** speaking ACP over stdio. Agents reach other threads through the **`bb` CLI** (taught by a skill and addressed by `BB_THREAD_ID`), not an MCP tool; separately bb injects its own **tools** into ACP agents through a **stdio MCP proxy** that calls back to the bridge over loopback TCP with a token.

## Provider architecture

- A provider is declared with `bb.providers.register({ id, displayName, strings{signInHint, installUrl, ...}, maintenance{health, usage, installation}, capabilities{permissionModes, fork, ...}, env.passthrough, deriveProviderOptions })` (`docs/provider-plugin-api.md` section 1).
- The bridge turns an agent's native traffic into `thread/delta` semantic deltas; core's "delta assembler" owns turn/item ids and ordering (`docs/provider-bridge-protocol.md`, "The timeline lane").
- Bridge handshake is `initialize { protocolVersion: 2, capabilities }`; capabilities (`sessionRestore`, `fork`, `approvalEnforcedBy`, `steerMode`, `skills`...) are session-behaviour facts that gate request methods.
- The ACP plugin: `plugins/provider-acp/` (`known-agents.ts` has the five shipped agents; `agents.ts` the custom-agent schema; `registry.ts`/`registry-service.ts` the registry import; `declaration.ts` one declaration per agent). The reusable kit is `packages/provider-bridge-acp/` (`bridge/bridge.ts` 4,247 lines; `bridge/agent-connection.ts`; `client/capabilities.ts`; `dialect.ts`; `probe.ts`).

## Discovery: "what does the user have installed"

| Mechanism | Where | What it does |
| --- | --- | --- |
| Login-shell PATH | `docs/configuration.md` "Host executable discovery" | Reads the user's login-shell PATH (Windows: registry PATH), adds Node's directory and standard user tool dirs (`~/.local/bin`, mise/asdf shims). Discovery runs in the background, three-second bound per probe; launches use the latest snapshot and never wait. A missing command or exit 127 starts a background refresh; commands are never replayed automatically. |
| Known agent table | `plugins/provider-acp/src/known-agents.ts@f1c5304` | Per agent: `command`, `args`, `signInCommand`, `installUrl`, `visibility: "installed"` for opencode/omp/grok/hermes (hidden unless the CLI is found), `dialect`, native skill roots. Cursor is always listed. |
| Health / installation status | bridge methods `provider/health`, `provider/installation/status`, `provider/installation/run` (`docs/provider-bridge-protocol.md`) | Status carries installed, version, latest version, `versionUnsupported`, `minimumSupportedVersion`, a display-only install command. `checkUpdates: false` does a cheap local probe; full discovery starts several npm/CLI processes. Server caches per machine, serves stale for 30 s and re-probes in the background; `?refresh=true` forces. The host daemon, not the bridge, runs install/update commands and verifies afterwards. |
| Claude Code specifics | `plugins/provider-claude-code/src/bridge/provider-maintenance.ts` | `BB_CLAUDE_CODE_EXECUTABLE` else `resolveExecutablePath("claude")`; version, npm dist-tags (latest/stable), `claude doctor` parse (install method, update channel), account read for plan and usage. |
| ACP reachability probe | `packages/provider-bridge-acp/src/probe.ts@f1c5304` `probeAcpAgent` | Spawns the agent, sends `initialize` (10 s timeout), reports `{ reachable, fork }` or a reason, kills it. |
| Custom agents | `docs/configuration.md` "Custom ACP Agents"; `plugins/provider-acp/src/agents.ts` `customAcpAgentSchema` | JSON array setting: `id` (becomes provider id `acp-<id>`, permanent), `displayName`, `command`, `args`, `env`, `cwd`, optional `modelCli`, `reasoningCli`, `nativeReasoning`, `nativeSkillRoots`, `permissionCli`, `dialect`, `supportsManualCompaction`, `providerUsage`. "A custom agent's command is local code execution and only works with a co-located daemon." Applies without restart. |
| Registry import | `plugins/provider-acp/src/registry.ts` (`ACP_REGISTRY_URL`), `registry-service.ts`, skill `acp-provider` | Reads the official registry JSON (cached six hours); **only `npx` and `uvx` agents can be added**: the entry becomes a custom agent running `npx -y <package>` or `uvx <package>`. A binary-only agent gets the message "Install it yourself, then add it as a custom agent with its command" (`registry.ts` ~264). Registry statuses: available, added, update available, built in, manual install. |

States and what the user sees:

- **Missing**: `visibility: "installed"` providers simply do not appear; others show guidance from `strings.installUrl`/`signInHint`; the Claude bridge converts the SDK's "Native CLI binary ... not found" into "bb could not find the Claude Code CLI on this machine. Install Claude Code ..., or set BB_CLAUDE_CODE_EXECUTABLE ..." (`missing-cli-error.ts`).
- **Outdated**: `versionUnsupported` / `minimumSupportedVersion` in installation status; thread start and rewind can be gated on it; Settings offers an update action. Pi checks its version before each session.
- **Logged out**: the ACP agent answers `session/new` with `auth_required`; `packages/provider-bridge-acp/src/auth-guidance.ts` turns the advertised `authMethods` into text, for a `terminal`-type method the exact command line to run ("run this in a terminal on the machine that hosts the thread, then try again"). bb only calls `authenticate` itself for Grok (`cached_token` or `xai.api_key`, with `_meta: { headless: true }`) (`bridge.ts` `authenticateAcpAgent` ~835). `acpClientCapabilities` advertises `auth: { terminal: true }`.
- **Adapter not installed**: bb has no concept of an adapter for Claude/Codex because they are not ACP there. For an `npx`/`uvx` registry agent, the host needs Node or uv; otherwise the launch fails like any missing command.

## Sessions

- **Process model.** One agent process and one ACP connection per bb thread (`startAgentSession`, `bridge.ts` ~2326-2650; `sessionsByBbThreadId`). Spawn through `spawnManagedProcess` in `packages/process-utils/src/managed-process.ts`: `detached` on POSIX so the child leads its own process group; stop sends SIGTERM to the group, waits `gracePeriodMs` (1 s default) then SIGKILL after another 1 s grace, with a `treeTermination: "confirmed" | "unverified"` verdict; Windows uses a process-tree stop (`windows-process-tree.ts`). The bridge also reaps its agents on SIGTERM, SIGINT and stdin close (`bridge/shutdown.test.ts`). Stderr tail (40 chunks) is attached to exit errors.
- **Resume.** When the agent advertises `sessionCapabilities.resume` bb calls `session/resume`, else `session/load` if `loadSession`; if neither works, or restore fails for a non-auth reason, it starts `session/new` and emits a warning "could not restore the previous session; continuing in a fresh session without in-agent history". Load replays are swallowed (`model.beginReplay()/endReplay()`), not shown twice.
- **Fork.** `session/fork` only when the agent advertises it (`SessionCapabilities.fork`); declared per agent as `fork: "none" | "tip"`.
- **Capabilities advertised to agents.** `fs.readTextFile/writeTextFile: true`, `terminal: false`, `auth.terminal: true`, elicitation form mode, plus `_meta.parameterizedModelPicker` for Cursor (`agent-connection.ts` `acpClientCapabilities`). bb implements `fs/write_text_file` itself (and denies writes outside the workspace roots in `accept-edits`).
- **Permissions, headless and interactive.** Provider-level modes for ACP: `accept-edits` and `full` only (`reconcileExecutionSettings` throws `'ACP does not support permission mode "auto"'`).
  - `full`: every `session/request_permission` is answered `allow_once` immediately (`handlePermissionRequest`, `bridge.ts` ~1988-2075). Some agents also get launch flags (`permissionCli`: Grok `--always-approve`) or environment (OpenCode 1.x `OPENCODE_PERMISSION`, 2.x via an `opencode api PATCH /api/session/<id>` before the first prompt).
  - `accept-edits`: the request becomes an interaction card for the person; "allow for this session" is remembered by bb (key from the call's subject) and answered with the agent's `allow_once` option; bb sends `allow_always` only if no `allow_once` exists, so Cursor does not write grants to its global config (`acp-provider` skill).
  - Requests during cancel, stop, or compaction are answered `cancelled`.
  - The Claude Code provider has its own `auto`, `accept-edits`, `full`, a `fullAccessApprovalsEnabled` switch and a sandbox toggle (`docs/configuration.md` "Claude Code provider").
- **Cancel and idle.** `cancelRequested` and `restartAfterCancelError` session flags exist (their purpose is inferred from the names: a restart after a failed cancel); a 5 s `AGENT_TURN_QUIET_MS` timer closes turns the agent starts on its own (updates outside any prompt). **[inferred]** ACP agents can emit work without a prompt (background tasks), so a client needs a rule for when such output ends.
- **Model and reasoning.** Models come from the agent (`configOptions`/`models` in `session/new`), or from a CLI listing (`cursor-agent --list-models`, `modelCli.listArgs`), or a throwaway discovery session; reasoning via `nativeReasoning.configId` or launch flags; unknown models may be rejected by the agent.
- **Instructions.** bb's user/workspace `AGENTS.md` text is not sent as a system prompt: for ACP it is wrapped in `<system_instructions>...</system_instructions>` and prepended as a text block of the **first prompt** (`buildPromptContentBlocks`, `bridge.ts` ~1820; `pendingInstructions`).

## Per-thread agent, worktrees, concurrency

- A thread stores its provider id; `bb thread spawn --provider acp-opencode --model <id> --option mode=<agent>` (skill `acp-provider`). Providers can be disabled per id (`disabledProviderIds`, Settings → Providers, `bb provider disable`).
- Worktrees: environment plugin `plugins/environment-git-worktree`; a "managed worktree" is `git worktree add` on a fresh branch at `<BB_DATA_DIR>/plugins/environment-git-worktree/host-data/worktrees/<thread-id>/<repo>`; `.worktreeinclude` lists untracked files to copy; setup and teardown scripts; removed when no thread uses it (`docs/worktrees.md`). A follow-up thread can reuse the same environment with `--environment` (`bb-cli` skill).
- Concurrency: `plugins/concurrency-limit` queues new turns; default per host is one running thread per available processor, plus an overall limit, `0` pauses (`PLUGIN_OVERVIEW.md`).

## Cross-agent messaging

- **Mechanism: the `bb` CLI.** Any agent with shell access runs `bb thread spawn|tell|show|log|wait|fork ...`. The skill `plugins/bb-guide/skills/bb-cli/SKILL.md` teaches it (give spawned threads clear prompts; do not poll, use `bb thread wait`; `tell` steers an active turn by default, `--mode queue` for non-urgent), and the agent's own thread is addressed through env vars (`BB_THREAD_ID`, `BB_ENVIRONMENT_ID`, read in `apps/cli/src/context-env.ts`). The documented path is the CLI. bb's MCP proxy (`tool-proxy-mcp.ts`) is a generic carrier for plugin-defined `DynamicTool`s (the ask-user-question plugin's `AskUserQuestion` is one, per the `acp-provider` skill); I found no thread-messaging tool among the ones I read, but I did not enumerate every plugin's tools.
- **Hearing back.** A thread created with a `parentThreadId` and `parentNotifications: auto | stuck | off` queues a message to its parent when a turn ends (`apps/server/src/services/threads/thread-parent.ts`, `turn-end-follow-ups.ts`, `child-thread-notifications.ts`). Depth is capped (`MAX_THREAD_HIERARCHY_DEPTH = 4`). CLI help: "Which turn outcomes wake the parent thread: auto (every outcome), stuck (failed, interrupted, or blocked on an approval or question), or off".
- The receiving thread shows each message with its sender (FAQ copy, `apps/web/src/compare/compare-content.tsx`).

## Usage and limits

- Per-provider `provider/usage` bridge method returns windows with reset times; the Provider usage plugin shows them (`plugins/provider-usage`). Sources differ per agent: Claude Code from the CLI's own account/rate-limit probe; **Cursor from Cursor's dashboard API (`https://api2.cursor.sh/aiserver.v1.DashboardService`) using an access token bb reads from the macOS keychain item `cursor-access-token` or `auth.json`**, and the account email from Cursor's `state.vscdb` (`packages/provider-bridge-acp/src/bridge/provider-maintenance.ts`); OpenCode Go from OpenCode's own database/credentials (`opencode-usage.ts`). **[observed]** These are vendor-specific side channels that read other programs' credential stores.
- `plugins/provider-retry`: on a failed turn, schedules a retry for overloads (doubling delay), server/connection errors, and subscription limits that report a reset time ("a little past the reset" plus random spread); cap four retries per turn; credit/spend limits are not retried; `maximumWait` default 6 hours.
- `plugins/account-pool` ("Account Pooler [Experimental]"): switches among several Claude Code or Codex accounts the user owns. Not read in detail.

## Constraints and quirks worth knowing

- ACP `tool_call` events carry no reliable link to an MCP server and tool; bb matches its injected tools by `title.includes(tool.name)` or by an out-of-band note from its own proxy (`delta-translation.ts` `injectedToolNamedBy`, `noteInjectedToolCall`).
- Vendor "dialects" (`dialect.ts`): Grok puts the tool identity under `_meta["x.ai/tool"]` and exposes sub-agents as a `spawn_subagent` tool call; Cursor adds client request methods such as `cursor/task`; OpenCode needs `OPENCODE_CLIENT=acp` and `OPENCODE_ENABLE_QUESTION_TOOL=false`. A generic dialect works for unknown agents.
- Permission and tool-identity handling is agent-specific enough that bb keeps per-agent code for the five it ships and a generic path for the rest.

## Sources

- `README.md`, `docs/provider-bridge-protocol.md`, `docs/provider-plugin-api.md`, `docs/configuration.md`, `docs/worktrees.md`, `plugins/provider-acp/{README.md,src/*.ts,skills/acp-provider/SKILL.md}`, `plugins/provider-claude-code/{PLUGIN_OVERVIEW.md,src/bridge/*.ts}`, `plugins/provider-pi/PLUGIN_OVERVIEW.md`, `plugins/provider-retry/PLUGIN_OVERVIEW.md`, `plugins/concurrency-limit/PLUGIN_OVERVIEW.md`, `packages/provider-bridge-acp/src/**`, `packages/process-utils/src/{managed-process,process-group}.ts`, `plugins/bb-guide/skills/bb-cli/SKILL.md`, `apps/cli/src/commands/thread/*`, `apps/server/src/services/threads/*` — all at `f1c5304` (read 2026-11-17).

## Open questions

- How bb's Claude and Codex bridges find a **logged-out** state before a turn (not read beyond the account probe).
- Exact semantics of Account Pooler and whether it touches credentials (not read).
- How `parentNotifications` text is worded when delivered to the parent (the message template was not read).

## Assumptions and limits

- Read about a quarter of `bridge.ts` (session start, permission handling, tool proxy, auth, prompt building) and none of the UI code beyond the providers settings section. Behavior was not run; recorded conformance fixtures were not inspected.
- bb moves quickly (commits on the day I read it); treat line numbers as approximate.
