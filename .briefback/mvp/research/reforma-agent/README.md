# Reforma agent: parts catalog for Clowdy

Merged on 2026-11-17 from six inventory notes in this folder. All six exist: `01-tools.md`, `02-agent-loop-and-profiles.md`, `03-subagents-and-background.md`, `04-commands-processes-logging.md`, `05-skills-memory-mcp-plugins.md`, `06-coupling-and-extraction.md`. Nothing is missing.

Source repo: `/Users/bionic/WORK/Reforma/reforma` (read-only). Paths below start from `SB/` = `apps/sandbox/src/` unless they start with `apps/` or `packages/`. Facts marked "verified" were re-checked in code while writing this file; the rest comes from the notes, which read the code but ran nothing.

## 1. What the Reforma agent is

The agent is the chat backend of Reforma's sandbox controller: `SB/chat/` is 200 files and 26,679 lines on `ai@7.0.31` (Vercel AI SDK 7). It runs its own outer loop around `streamText`, keeps conversations as AI SDK `UIMessage` rows, and ships 45 tools plus subagents, background jobs, skills, hooks, MCP, memory and compaction. About 5.2k lines are Reforma-product-only (onboarding, design, preview, publish, plugins, images, LiteLLM) and are deleted, not ported. The rest is tangled: almost any heavy module drags in a 269-file import closure, so the usable unit is a leaf module or a module behind a port, not a mid-tier file copied alone.

```text
SB/chat/
  agent/            181 files, 21.8k lines
    agent.ts          ReformaAgent: outer loop, retries, phases, Stop hook, park/finish
    run/              run-context (lifecycle), usage-ledger, run-scope (billing id)
    helpers/          runtime-context (prepareStep), step-notes, tool-loop-guard, background-thread,
                      provider-error-message, context-limit-error, payer-failure, read-file-state
    compaction/       chat-compaction (triggers, summarizer), microcompact
    profiles/         agent-profile (default), onboarding, instructions/ (system prompt blocks)
    subagents/        run, create, child-profile, workspace-agents, subagent-activity
    tools/            45 tools + shared/ (tool-result spill), mcp-tools/ (dynamic gateway)
    models/           registry, inference-harness (user credentials), prompt-cache, gateway fetch
    skills/  hooks/  memory/
  threads/          thread-session (state, queue, mailbox), continue-thread (wake-ups), persistence
  streaming/        start-thread-run, agent-event-writer, resumable-stream, sse-heartbeat
  mcp-client/       McpConnectionManager and transports
SB/core/{files,process,search}   file edit engine, path guard, process layer, grep/glob
SB/api/chat/chat.ts:chatHandler  HTTP entry for one turn (outside chat/)
```

Key entry points: `agent.ts:ReformaAgent.execute`, `helpers/runtime-context.ts:createRuntimeContext` (tools, system prompt, `prepareStep`), `threads/thread-session.ts:ThreadSession`, `threads/continue-thread.ts`, `tools/agent/Agent.ts`, `tools/bash/Bash.ts`, `api/tools/dispatch.ts:dispatchTool` (runs 18 tools without a run context).

**Which lens applies.** Clowdy's plan (Stage 5) puts an engine in charge of the loop: Claude Agent SDK `query()` and Codex app-server. `ai-sdk-harness.md` in the parent folder concludes that the AI SDK is not worth adopting as a runtime layer. So the **verdicts below are written for that lens**. Where keeping the AI SDK loop would change the verdict, it appears as `(a: ...)`. About the AI SDK plus subscription idea: Reforma has no Claude-subscription path. Its only subscription precedent is ChatGPT-plan OAuth for OpenAI (`SB/chat/agent/models/inference-harness.ts`, `credential.kind === 'oauth'`, verified), and hosted tool search is OpenAI-only (`resolve-provider-tools.ts:familyHasToolSearch`, verified). Note 06 section 5 lists what would break with a subscription-backed `LanguageModel`.

Verdict key: **AS-IS** copy; **CHG** port with changes; **IDEA** rewrite using the idea; **SKIP**.

## 2. Parts catalog

Sorted by value to Clowdy: orchestration, subagents, background results, command running, error handling, logging and skills first, then file policy, hooks, MCP, context and the rest.

| Part | Reforma path (file:symbol) | Does | Verdict | Port notes |
| --- | --- | --- | --- | --- |
| **Orchestration** | | | | |
| Job mailbox | `SB/chat/threads/thread-session.ts`: `registerBackgroundJob`, `enqueueBackgroundResult`, `takeBackgroundResults`, `dropRunningBackgroundJobs`, `setBackgroundAgentWaiting`, `onThreadMailbox` | Per-thread job list. A job is finished when it has `output` or `error`. Finished results are taken exactly once. Listeners fire on enqueue | CHG | Memory-only in Reforma, so a crash loses unread results. Back it with SQLite and a `delivered` flag. Replace `setSync` with an event emitter. An unknown id passed to `enqueueBackgroundResult` creates a finished entry |
| Idle wake-up | `SB/chat/threads/continue-thread.ts`: `serialized`, `wakeupTails`, `wakeForBackgroundResults`, `runWakeup`, `runContinue`, `handleRunSettled` | When a job ends and the parent is idle, starts a follow-up run with no user message. A per-thread promise chain serializes wake-ups. `handleRunSettled` is the table of who wakes when | CHG | Drop `controlLease`, billing and payer scopes. Keep the settle table. Each wake-up is a new paid run (here: subscription quota), so gate it per task. Listeners register on module import |
| Run state, queue, steers | `thread-session.ts`: `startRun`, `setLastRunStatus`, `cancelRun(runId)`, `isCurrentRun`, `onRunChange`, `inFlightRun`, `turnStarting`, `enqueueInput`, `takeSteers`, `settleQueue`, `pauseQueue`, `restoreQueuedInput` | Status `created/running/completed/failed/cancelled` with stale run-id guards. Steer and next-turn queue, Stop pauses it | CHG | The queue is memory-only. Send steers through the engine's streaming input (Claude: confirm in `claude-agent-sdk.md`) or app-server steer (Codex, per `codex-sdk.md`) |
| Step notes | `SB/chat/agent/helpers/step-notes.ts`: `takeStepNotes`, `formatResult`, `TURN_LIMIT_NOTE` | Before each model step, turns finished jobs, steers, loop note and turn-limit note into synthetic user messages. Background text is frozen at delivery | IDEA (a: CHG) | An engine has no `prepareStep`. Deliver through streaming input or the next turn. Keep the text shape: `Background job <id> finished.`, exit and signal, last 100 lines of stdout and stderr, spilled above 24 KiB |
| Park on user | `SB/chat/agent/subagents/run.ts`: `parkUntilNextRun`, `parkWhileNeedsUser`; `SB/chat/threads/helpers.ts`: `childNeedsUser` | The parent's tool call waits until the child has a new run that ends after the approval | CHG (about 35 lines); detector IDEA | Map engine permission requests onto the `needs-user` status. It subscribes before it starts, so it never completes on the run that asked |
| Dangling-parent recovery | `continue-thread.ts`: `continueAfterChildRun`, `completeDanglingParentTool` | If the parent died while parked on a child, closes its pending `Agent` call with the child's text and continues | IDEA | Reforma only recovers if the child later settles. Clowdy needs a boot scan instead (section 5) |
| **Subagents** | | | | |
| Status contract | `packages/types/src/sandbox/ui-message.ts`: `SubagentStatus`, `SubagentStatusUpdateData`; `.../tools/get-background-result.ts`: `BackgroundResult`, `ThreadBackgroundJob` | `starting, running, needs-user, completed, failed, cancelled` and the event `{childThreadId, toolCallId, status, patch}`. Only `starting` is persisted | AS-IS | Add `queued` and `interrupted`. Reforma has neither |
| Executor lifecycle | `SB/chat/agent/subagents/run.ts`: `openSubagent`, `runSubagent`, `loadResumeChild`, `wantsLatestChild` | Create or resume a child thread, run it, park, extract report and usage, map each outcome to a status | IDEA (a: CHG) | Do not port: it needs `ThreadSession`, `AgentProfile` and `ReformaAgent` (about 3.7k lines). Take the resume checklist (still running, wrong parent, wrong name), "resume keeps the stored model", and the rule that a child with no final text has failed |
| Agent tool | `SB/chat/agent/tools/agent/Agent.ts`: `Agent`, `startBackgroundSubagent`, `backgroundReport` | Foreground call blocks until the child ends. Background returns a receipt and delivers the report later | IDEA (a: CHG) | Copy validate-then-detach (open the child before detaching, so a bad name fails synchronously), the receipt wording and the report header. Clowdy's spawn tool belongs in the daemon's in-process MCP server |
| Agent declarations | `SB/chat/agent/subagents/workspace-agents.ts`: `readAgentByName`, `parseDeclaredAgent`, `loadAgentsCatalog`, `loadSubagentsCatalogBlock`, `resolveDeclaredModel`; parser in `packages/lib/src/skills.ts` | `{name}.md` with `name`, `description`, `model`, `tools`, `readonly`, `mcp`, `resume`. Three-layer lookup, mtime+size fingerprint cache | CHG | Close to Claude's `.claude/agents/*.md`, so read both. Replace the hand parser with a YAML library. Body cap 32 KiB. An agent without `description` is hidden from the catalog but still callable |
| Child tool presets | `subagents/child-profile.ts`: `SubagentProfile`, `DeclaredSubagent`, `readonlyTools`, `writeTools`, `DECLARABLE_TOOLS` | Tool set from front matter or a preset, `maxTurns` 60, no `Agent` tool (depth 1) | IDEA | Tool names are Reforma's. Keep the declarable vocabulary and the "unknown tool" error |
| Activity label | `subagents/subagent-activity.ts`: `subagentActivityFromChunk`, `slimSubagentToolInput` | One "what is it doing now" patch per child chunk. Strings cut to 80 chars, arrays to 3 items | CHG | Adapt the chunk type to Clowdy stream items |
| Shipped agents | `packages/reforma-system/agents/{advisor,code,research,review,shell}.md` | Five subagent definitions | IDEA | Copy the shape (verdict first, final message only, stop after two failed passes), not the content |
| **Background results** | | | | |
| Job runner | `SB/chat/agent/helpers/background-thread.ts`: `runBackgroundWork`, `stopBackgroundWork`, `resolveBackgroundThread` | Detached async job with its own `AbortController`. Result or error goes into the mailbox | CHG | Remove the two billing wrappers (`outsideRunScope`, `outsideInference`). Parent Stop does not touch these jobs |
| Stop jobs | `SB/api/chat/chat-stop-background-jobs.ts`: `stopThreadBackgroundJobs` | Aborts in-process work, else kills the command, then drops the job | CHG | Malformed `ids` is a 400, never "stop all" |
| Poll tool | `SB/chat/agent/tools/get-background-result/GetBackgroundResult.ts` | Lets the model take unread results explicitly | SKIP (a: AS-IS) | Redundant once delivery is automatic |
| Spill large output | `SB/chat/agent/tools/shared/tool-result.ts`: `spillIfLarge` | Text over 24 KiB goes to `AGENT_TMP_DIR/tool-output/<uuid>.txt`, the model gets a `Read` pointer | AS-IS | Reforma never cleans that folder |
| **Command running** | | | | |
| Spawn and tree kill | `SB/core/process/spawn.ts`: `spawn`, `BunProcess`, `killProcessTree`, `collectDescendantPids`, `libprocChildPids` | `Bun.spawn`, env build, stream readers. Kills a process and its descendants on Linux, macOS (libproc through `bun:ffi`) and Windows (`taskkill /T /F`) | CHG | Bun-bound, which suits a Bun daemon. Fix the defects in section 5 |
| Runner and registry | `SB/core/process/{command-runner,process-runner,process-registry}.ts`: `CommandRunner`, `ProcessRunner`, `processRegistry` | State machine `QUEUED/RUNNING/EXITED/ERROR/KILLED`, timeout timer, ring buffer plus JSONL log plus events, id-to-runner map with GC | CHG | `config.*` becomes parameters, cwd per run. GC evicts a finished runner about 1 s after exit |
| Output storage | `SB/core/process/{ring-buffer,disk-log-store}.ts`: `RingBuffer`, `CommandLogWriter`, `readCommandLog` | Last 500 chunks in RAM, one JSONL per command, tail read in 64 KiB blocks | AS-IS; log CHG | Add rotation and a size cap; neither exists |
| Shell and env | `SB/core/process/{shell,default-shell,bwrap}.ts`: `getShellCommand`, `findDefaultShell`, `safeBaseEnv`, `BASE_ENV_ALLOWLIST` | Picks the shell (`-c` on desktop, `-lc` hosted, Git Bash on Windows) and builds the env from an allowlist | CHG; env list IDEA; bwrap SKIP | The allowlist has no Windows variables (verified). Using the user's own tools needs a PATH captured from their login shell |
| Bash tool | `SB/chat/agent/tools/bash/Bash.ts`: `Bash`, `pollCommand`, `keepTail`, `attachDeliver` | One tool: run, background, poll by id, kill by id. Tail plus spill. A separate timer, so a timeout still returns the partial output | IDEA (a: CHG) | The engine has its own Bash. Take the result shape (stdout and stderr split, non-zero exit is a normal result, `[truncated: last N of M lines]`) if Clowdy relays command output |
| PTY terminals | `SB/core/process/{terminal-runner,terminal-registry}.ts`, `pty-host.cjs`, `spawn.ts`: `PtyProcess` | Interactive shell on node-pty with a headless xterm mirror for reattach | CHG | Only when the UI needs terminals. node-pty prebuilds must ship |
| Stop ladder and orphan sweep | `apps/desktop/src/controller/supervisor.ts`; `SB/core/process/spawned-pid-registry.ts`: `reconcileOrphanTrustedProcesses` | Close stdin 10 s, SIGTERM 5 s, SIGKILL. Sweeps processes whose env carries the project TMPDIR. Pid file after a restart | IDEA | The pid file has no start-time check, so a recycled pid could be killed. It records only "trusted" spawns |
| **Error handling** | | | | |
| Tool-loop guard | `SB/chat/agent/helpers/tool-loop-guard.ts`: `detectToolLoop` | Window of 10 calls. Warns on repeats, halts tools on a repeated failure (rules in section 5) | AS-IS logic, as a hook (a: AS-IS) | Its input is the AI SDK `StepResult`. Replace it with a plain outcome list `{key, label, result, failed}` fed from tool_use and tool_result events |
| Provider error utils | `SB/chat/agent/helpers/{provider-error-message,context-limit-error}.ts`: `providerErrorMessage`, `isContextLimitExceededError`, `isStaleProviderItemError` | Pull a readable message out of nested provider errors (message, cause, responseBody, error, data, depth about 4). Regex lists for context overflow | AS-IS | Pure. Add Claude Code and Codex error strings |
| Limit and access classifier | `SB/chat/agent/helpers/payer-failure.ts`: `classifyPayerFailure` | Code lists `LIMIT`, `TRANSIENT`, `ACCESS`, Anthropic balance strings, Gemini quota text, `resetAt` parsed from the text `regain access on <date>` | CHG | Billing-shaped. Keep the taxonomy; it feeds the scheduler's "limited until resetsAt" state |
| Self-correcting input errors | `SB/chat/agent/tools/mcp-tools/helpers.ts`: `invalidDirectToolInputMessage` | `Invalid input for X: <path>: <issue>` plus the JSON schema, so the model can fix its call | IDEA | Use it for the daemon's own MCP tools |
| Error convention and report-once | `SB/utils/logger.ts` (`error` vs `critical`); `SB/utils/report-error.ts`: `captureSandboxError`, `wasReportedToSentry` | `error` = expected or user-caused, `critical` = our failure. Rethrow with `{cause}`; the cause chain (5 levels) stops double reports | IDEA | The convention is the value. Keep any Sentry behind an opt-in |
| Run lifecycle events | `SB/chat/agent/run/run-context.ts`: `RunLifecycle` | `onRunStart` through `onRunEnd` (outcome finish, abort or park), `onRunError`, `onStreamClose` | IDEA | Good vocabulary for mapping engine events |
| **Logging** | | | | |
| Logger and redaction | `SB/utils/logger.ts`: `createLogger`, `redact`, `writeToChannel` | Prefix console logger, `sandbox.jsonl` mirror. Masks own secrets (8+ chars), JWT, `Bearer`, `://user:pass@`, GitHub tokens | CHG | Add run, task and tool-call ids to every line (Reforma has none). Run `redact` on command output too (Reforma does not) |
| Log channels | `SB/core/process/session-log.ts`; `SB/api/logs/index.ts` | Four fixed channels (`dev`, `install`, `deploy`, `sandbox`), last 500 entries | IDEA | Make it a durable log per run |
| Sentry, Langfuse | `SB/instrument.ts` | Error reporting and AI SDK tracing | SKIP | Not for the MVP |
| **Skills** | | | | |
| Discovery and parsing | `packages/lib/src/skills.ts`: `findSkillFiles`, `readSkills`, `splitSkillMarkdown`, `parseSkillFrontmatter`, `isValidSkillName` | Pure `node:fs`, about 285 lines. A skill is a folder with `SKILL.md`, no nesting, symlink-loop safe | CHG | Swap the parser for YAML. Accept `user-invocable`, `allowed-tools`, `when_to_use`. Log skills that get dropped |
| Layered catalog | `SB/chat/agent/skills/workspace-skills.ts`: `skillsRoots`, `loadSkillsCatalog`, `mergeSkillCatalogs`, `readSkillByName`, `containedSkillFile` | Roots merge in order (global `.claude`, global `.agents`, system, plugins, project; later wins by name). Fingerprint cache | CHG | Pass roots in and key the cache by project. Drop plugin and system roots. The engines read skills themselves, so this serves Clowdy's catalog and UI |
| Global switch | `SB/core/global-skills.ts`; `apps/desktop/src/skills.ts` | `skills.json` `{enabled, disabled[]}`, a deny list so new skills start on | CHG | Becomes a daemon setting |
| Prompt block and watcher | `skills/skills-info.ts`: `formatAvailableSkills`; `skills/skills-sync.ts`: `watchSkills` | `<available-skills>` list; debounced (300 ms) directory watch | IDEA | Add a size budget (Reforma has none). Watch directories, not files |
| Skill tool, slash chips, plugin rules | `tools/skill/Skill.ts`; `skills/slash-skills.ts`; `skills/workspace-rules.ts` | Load a skill; user-picked skills; always-on rules | SKIP (a: Skill tool AS-IS) | Engines have Skill, `/name` dispatch and `CLAUDE.md`/`AGENTS.md` |
| **File tools and policy** | | | | |
| Edit engine | `SB/core/files/file-edit.ts`: `applyContentEdits` | Batch search/replace with partial apply, fuzzy re-indent, chain-conflict check | CHG | Expose as an optional `EditBatch` MCP tool only if native Edit fails models. Fix CRLF first (section 5) |
| Path guard | `SB/core/files/{path,agent-path-guard}.ts`: `validatePath`, `isPathAllowed`, `validateAgentPath` | Boundary-safe prefix check, realpath, symlink re-validation, case-fold on win32 | CHG | Make it `{root, extraAllowed}` per executor and call it from a PreToolUse or `canUseTool` check to keep each executor in its worktree |
| In-process dispatch | `SB/api/tools/dispatch.ts`: `dispatchTool` | Runs 18 file and shell tools with no run context (`toolCallId: 'mcp'`) | IDEA | Proof that file and shell tools can sit behind an in-process MCP server |
| Read dedup and lint feedback | `SB/chat/agent/helpers/read-file-state.ts`; Write and Edit `lints` field | Returns `{unchanged:true}` for a repeated range at the same mtime. Edit results carry biome diagnostics | IDEA | Lint feedback maps to a PostToolUse hook that returns `additionalContext` |
| Search | `SB/core/search/*` | fast-glob, `rg` spawn, BM25 | SKIP (a: AS-IS) | Engines have Glob and Grep |
| **Hooks, MCP, context, other** | | | | |
| Hook protocol | `SB/chat/agent/hooks/{hook-protocol,hook-runner,hook-sources}.ts` | Claude-shaped command hooks (PreToolUse, PostToolUse, Stop, SessionEnd). 30 s timeout, 10,000 chars of injected context | SKIP for Claude; CHG for Codex parity | Claude has native hooks |
| MCP health and auth | `SB/chat/mcp-client/{mcp-oauth-prm,mcp-configured-tools}.ts`; `readMcpErrorSignal`; `packages/lib/src/mcp.ts`; envelope in `SB/core/workspace/preferences-service.ts` | Detects 401 and `insufficient_scope`, probes RFC 9728 for lazy-auth servers, normalizes tool names, `.mcp.json`-shaped config | AS-IS helpers; manager IDEA | The Claude SDK never opens a browser for OAuth, so Clowdy must own login and pass the token. The manager (1,158 lines) is redundant with an engine |
| Compaction, microcompact | `SB/chat/agent/compaction/{chat-compaction,microcompact}.ts`; `packages/reforma-system/rules/subagents/context-compaction.md` | Thresholds, tiered shrinking of old tool results, summarizer prompt | IDEA (a: CHG); prompt AS-IS | The engine compacts itself. Lift only to rebuild context for a fresh engine session |
| Usage ledger | `SB/chat/agent/run/usage-ledger.ts`: `RunUsageLedger` | Per-phase token accounting, `appendExtraPhase` for child usage | CHG | Quota windows matter, money does not. Depends only on `ai` types and `getRunScope` (verified) |
| Prompt loader | `helpers/injected-doc.ts`: `loadInjectedDoc`; `profiles/instructions/wrap-system.ts`: `wrapSystem` | Markdown from disk, front matter stripped, 10 KiB cap, wrapped in `<tag>` | AS-IS | Also keep two habits: freeze the system prompt per session, put volatile context in the user turn |
| Model spec grammar | `SB/chat/agent/models/model-call.ts`: `parseModelSpec` | `name[effort=high,fast,softCap=200k]` | AS-IS | Handy for an agent file's `model:` field |
| Question schema | `SB/chat/agent/tools/ask-user-question/AskUserQuestion.ts` | 1 to 4 questions, unique ids, at least 2 options unless free text, no "Other" option | IDEA | Reuse the validation rules for the semi-manual card protocol |
| Memory, chat search | `SB/chat/agent/memory/*`; `tools/chats/*`; `SB/core/search/bm25.ts` | Sectioned facts with embeddings; BM25 over chat digests | IDEA, later | The embedder needs Reforma's gateway. Engines have `CLAUDE.md`/`AGENTS.md` |
| Subscription precedent | `SB/chat/agent/models/inference-harness.ts`: `createInferenceModel`, `payerFetch`, `openAIPlanFetch` | OpenAI plan OAuth on the AI SDK loop | IDEA (only if lens a) | See section 1 |

## 3. Do not port

- **Onboarding** (`profiles/onboarding.ts`, ScaffoldProject, ChooseDesignDirection, CommitDesignRead, MarkProjectReady, design-direction prompts): Reforma website scaffolding.
- **Gateway and billing** (`models/{gateway-fetch,llm-providers,model-factories}`, `api/chat/billing.ts`, run-scope billing, credit finalize, heartbeat): LiteLLM and Reforma Cloud.
- **Thread persistence** (`threads/thread-persistence.ts`, `thread-session-store.ts`, `mergeUiMessagesById`): HTTP to Reforma's MySQL. Clowdy stores stream items in SQLite.
- **UI-message layer** (`ReformaUIMessage`, `sanitize-ui-messages.ts`, `agent-event-writer.ts`, `normalize-file-parts.ts`): welded to AI SDK UI chunks; an engine path has none.
- **The outer loop** (`agent.ts`, `helpers/runtime-context.ts`, `profiles/agent-profile.ts`): only useful if Clowdy owns the loop, and tied to commit snapshots, billing and titles.
- **Tools the engines already have**: Read, Write, Glob, Grep, ListDirectory, MoveFile, RemoveFile, CreateDirectory, Fetch, WebSearch (also needs the gateway), TodoWrite, plan tools, Skill.
- **Dynamic tool gateway** (`GetDynamicTools`, `CallDynamicTool`, `tool-groups.ts`, `repair-deferred-tool-call.ts`): a hand-built tool search; engines defer tools natively.
- **MCP connection manager and transports**: the engine owns MCP; keep only the health and auth helpers.
- **Plugin machinery** (`core/integrations/*`, InstallPlugin, McpAuth, `apps/api/.catalog`): Reforma Cloud API, vault and Composio.
- **Web-project tools** (Commit, Build, InstallDeps, DevServer*, CheckPage, PageScreenshot, Navigate, ImageGen, SearchImage, ImportAsset, ProjectEnv, Publish, ListVersions): the Reforma website product.
- **Prompt text** (`agent-identity`, `agent-boundaries`, `project`, `theme`, `plugins`, system skills in `packages/reforma-system`): the designer persona. `agent-scope.md` is an idea source only.
- **`bash/host-policy.ts`**: bans `brew`, `apt`, playwright for the cloud image. **`rtk-rewrite.ts`** is optional and needs a bundled binary.
- **bwrap isolation and `cpu-quota.ts`**: Linux pods only; Windows has no confinement in Reforma either.
- **`core/history` journal** (955 lines; feeds editor undo), **`controlLease`** (browser-tab edit lease), **`core/task`** (dev-server controller).
- **`Preamble` tool**: a transport trick for models that emit no text between tool calls.
- **Resumable SSE buffer and heartbeat** (`streaming/resumable-stream.ts`, `sse-heartbeat.ts`): Clowdy uses cursor events. Port-as-is only under lens (a).
- **`ai` and `@ai-sdk/*` as a runtime**: see `ai-sdk-harness.md`.

## 4. Suggested port order for the Clowdy MVP

Ground rules for every step. Copy into Clowdy modules and stop importing from Reforma. Replace `config.*` and `@reforma/*` with explicit parameters, and leave a one-line provenance comment (`ported from reforma SB/<path>`). `apps/sandbox/package.json` says `UNLICENSED, Reforma, Inc.`; the owner asked for reuse, so a provenance line is enough. Daemon tests run on `bun test` while Reforma's specs use Vitest and `vi.mock`, so copy only mock-free specs as they are and rewrite the mock-heavy ones against fakes.

1. **Leaf utilities** (Stage 2 and 5, small, no dependencies).
   Copy: `SB/chat/agent/helpers/{tool-loop-guard,provider-error-message,context-limit-error,payer-failure}.ts`, `SB/chat/agent/tools/shared/tool-result.ts`, the `redact` part of `SB/utils/logger.ts`.
   Specs: `SB/specs/chat/{tool-loop-guard,provider-error-message,context-limit-error,payer-failure}.test.ts`, `SB/specs/chat/tools/tool-result.test.ts`, `SB/specs/utils/logger.test.ts`.
   Define first: `ToolOutcome {key, label, result, failed}` as the loop guard's input, `ErrorClassifier.classify(err)` returning `{kind: limit, transient, access, context, unknown; resetAt?}`, a `Logger` that stamps run, task and tool-call ids, and `SpillStore(dir)`.

2. **Process layer** (Stage 2 for setup scripts and checks, Stage 6 for worktrees).
   Copy: `SB/core/process/{ring-buffer,process-output,disk-log-store,process-runner,command-runner,process-registry,shell,default-shell,spawn}.ts`, the allowlist from `bwrap.ts`.
   Spec: `SB/specs/core/kill-process-tree.test.ts` (POSIX only).
   Define first: `CommandSpec {cwd, env, timeoutMs, name, logFile}`, `CommandRegistry {create, get, killAll}`, and a log directory and cwd passed per run. Apply the fixes from section 5 while copying (abort kills the tree, SIGKILL escalation, closed stdin, streaming decoder, bounded buffers, Windows env vars, `CI=1`, `GIT_TERMINAL_PROMPT=0`, ANSI stripped from the model copy).

3. **Job mailbox and wake-up** (Stage 6).
   Copy: the mailbox and run-state slice of `SB/chat/threads/thread-session.ts`, `SB/chat/agent/helpers/background-thread.ts`, `SB/chat/threads/continue-thread.ts`, `formatResult` from `step-notes.ts`, `SB/api/chat/chat-stop-background-jobs.ts`.
   Define first: `JobStore` over SQLite (`id, run_id, kind, description, output, error, delivered_at`), `RunLifecycleBus` (`onRunSettled`, `onMailbox`), `Waker.startFollowUpTurn(runId, note)` implemented by each engine adapter, and a per-task flag that allows paid wake-ups.
   Specs to rewrite against fakes: `SB/specs/chat/{step-notes,continue-thread,stop-background-jobs,thread-session-status}.test.ts`, `SB/specs/chat/tools/agent/agent-background.test.ts`.

4. **Run state, queue and steers** (Stage 6, goes with step 3).
   Copy: the `startRun / cancelRun(runId) / onRunChange / takeSteers / settleQueue / pauseQueue / restoreQueuedInput` methods of `ThreadSession`.
   Define first: map them onto `apps/daemon/src/runs/domain.ts`, and a `SteerSink` that each engine adapter implements (Claude streaming input, Codex app-server steer).

5. **Executor and subagent contract** (Stage 6).
   Copy: `SubagentStatus` types, `parkUntilNextRun` / `parkWhileNeedsUser` from `subagents/run.ts`, `loadResumeChild`, `subagent-activity.ts`, `workspace-agents.ts`; take receipt text and validate-then-detach from `Agent.ts`.
   Define first: `ExecutorRunner {start, resume, cancel}`, `AgentCatalog.resolve(name)`, and the daemon's in-process MCP tools (spawn executor bound to task ids, wait, cancel). Build what Reforma lacks: caps and `queued`, worktree per executor, join, restart recovery (section 5).
   Specs: `SB/specs/chat/subagents/{run-subagent,workspace-agents}.test.ts`.

6. **Path policy and optional file tools** (Stage 5 to 6).
   Copy: `SB/core/files/{path,agent-path-guard}.ts`, and `file-edit.ts` only if native Edit proves weak.
   Define first: `PathPolicy {root, extraAllowed}` per executor, called from the engine's pre-tool check. Specs: `SB/specs/chat/tools/files/agent-path-guard.test.ts`, `SB/specs/core/files/file-edit.test.ts`.

7. **Skills** (Stage 8).
   Copy: `packages/lib/src/skills.ts`, `workspace-skills.ts`, `core/global-skills.ts`, the directory-watch idea of `skills-sync.ts`.
   Define first: `SkillRoots {user, project, builtin}`, `SkillCatalog.list(projectId)` served by a daemon route, a mirror of `~/.agents/skills` into a Clowdy-owned `.claude/skills` (the Claude SDK reads only `.claude/skills`, per note 05, to verify). Spec: `SB/specs/chat/tools/skill/workspace-skills.test.ts`.

8. **Later or on demand**: the hook protocol for Codex parity, microcompact plus the summarizer prompt for rebuilding context in a fresh engine session, MCP health and auth helpers, the `AskUserQuestion` schema for semi-manual mode, memory. Revisit lens (a) only if a plain-transport subscription `LanguageModel` passes Reforma's `compaction-flow` and `steer-flow` specs (note 06, section 8).

## 5. Gotchas worth remembering

### Background and subagents

- A foreground child runs inside the parent's step, which has a 600,000 ms timeout (`STREAM_STEP_TIMEOUT_MS`, verified in `SB/config.ts`). Anything longer, or anything waiting on a human, must be background.
- The mailbox is memory-only. A crash between enqueue and take loses the result. A background `Agent` receipt is already `output-available`, so a report that arrives after a restart is lost.
- Order inside one step's notes: background results, then steers (skipped when tools are off), then the tool-loop note, then the turn-limit note. The last two are never stored. Background text is frozen at delivery so replays are byte-identical.
- Wake-up is skipped when the thread is busy, when its last run was `cancelled` (the user pressed Stop), or when nothing is left to take. `handleRunSettled` closes the race where a result arrives after the last `prepareStep`.
- A parked child stays `running`, so `resume` of it fails with "Subagent is still running" until it is answered or cancelled. Parent abort while parked also cancels a child run the answer already started.
- Vocabulary trap: the tool argument is `resume: new` or `resume`, the front matter is `new` or `continue`. Any other tool token silently means `new`.
- A child that used tools but wrote no final text is `failed` ("Subagent finished without a text response"). Foreground failures return as tool output with `error`; background failures become the job's `error`.
- Background usage is not folded into the parent's total. Foreground usage is (`appendExtraPhase`).
- Depth is 1 only because children lack the `Agent` tool. Background Bash and background `Agent` are refused inside a subagent.
- Not in Reforma at all: concurrency caps, a `queued` state, restart recovery (no boot scan, so nothing is marked interrupted), wait-all and wait-any, stall detection and per-child budgets, many-to-many task links (the thread tree cascades on delete), worktree isolation (every child writes the one project folder), steering a running child (`resume` is refused while it runs), structured results (the `data` path is dormant), a durable per-run event log.

### Commands

- Bash: default 120,000 ms, max 600,000 ms (zod rejects more), no timeout for a background command unless passed. Tail 100 lines by default, max 500. Spill above 24 KiB. All verified in `Bash.ts` and `tool-result.ts`.
- The timeout is a separate `setTimeout` that SIGKILLs the tree, so partial output still returns. A non-zero exit is a normal result, never a thrown error.
- Defects, all verified: `Bash.ts` never reads `abortSignal`, so Stop does not stop a foreground command. Kill is SIGTERM then `waitForExit()` with no timeout and no escalation. `stdin` defaults to an open pipe, so an interactive command waits for the timeout. `BunProcess.waitForExit` hard-codes `signal: null` (`spawn.ts:442`), so the KILLED state is never reached in production. The env allowlist lacks `SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`.
- Defects from the notes, not re-run: `BunProcess` keeps every chunk forever; `TextDecoder` is used without `{stream:true}`, so a split multibyte character becomes U+FFFD; `waitForExit` also waits for stream EOF, so `nohup server &` blocks until the timeout; `createCommand(spec, id)` overwrites an entry when the model reuses a `tool_call_id`; `resolveLogBasePath` checks `startsWith` without a separator.
- The registry evicts a finished command about 1 s after exit (`COMMAND_TTL_MS` 0). A poll after that reads the JSONL tail and has no exit code, so the exit code reaches the model only through the delivered result.
- The ring buffer holds 500 chunks, not lines, and `readCommandLog` counts JSONL entries. A fast writer can push the middle of long output out of the foreground result; the full text stays in the log. stdout and stderr come back separately.
- Tree kill takes one snapshot, so processes forked after it escape. Children of `Bun.spawn` share the controller's process group, so a group kill misses them. macOS uses `proc_listchildpids` through `bun:ffi` because the Seatbelt sandbox refuses setuid `ps`. Windows `taskkill /T /F` is always forceful and no CI job runs Windows.
- macOS `/bin/bash` is 3.2, and `-c` does not read the user's profile, so Homebrew's PATH is missing. Reforma uses `-c` on desktop and `-lc` hosted.
- Windows traps: Edit rewrites a CRLF file with LF (see below), `host-policy` bans `brew`, Git Bash is looked up in `default-shell.ts`, paths are case-folded on win32 in the path guard.
- No Bash permission layer exists in Reforma; `needsApproval` is only on `InstallPlugin` and `McpAuth`. Redaction is not applied to command output.
- Logs have no rotation or size cap, despite a doc comment promising "bounded rolling segments", and carry no thread, run or tool-call id.

### Error handling and loop limits

- Loop guard (verified): window 10, polling tools `GetBackgroundResult` and `Waiting` exempt. Two identical successes in a row: note "use that result". Second identical failure: warn. Third identical failure in a row, or a third `Invalid input for` error anywhere in the window: halt (tools off, "tell the user what is blocked"). A failure with other calls between the repeats only warns. Notes apply to that step only.
- Reforma returns errors three ways: thrown (Edit, Write, path validation), `{error}` objects (Read, Fetch, Agent), and `exitCode` style (Bash). Pick one convention for Clowdy's own MCP tools.
- One compaction retry on a provider context-limit error (`MAX_PROVIDER_CONTEXT_LIMIT_RETRIES = 1`, reset after a good phase), one retry for a stale OpenAI item id, at most 3 Stop-hook continues. `maxTurns` is 200 (child 60); the last step is forced to text only (`toolChoice: 'none'`).
- `payerFetch` throws a non-`APICallError` for hard limits so the SDK's two automatic 429 retries do not start. ChatGPT-plan limits arrive as an SSE error after HTTP 200.
- Compaction numbers, if rebuilding context: window 250,000, soft cap 130,000, hard cap 200,000. The summarizer runs with `maxOutputTokens` 5,000 and `temperature` 0.2.

### Skills, files, MCP

- A skill with no `description`, or whose `name` differs from its folder, is dropped silently. No nested skills. `isValidSkillName` rejects `_notes.md`, spaces and non-ASCII, so such files cannot be loaded through the Skill tool.
- The hand parser joins `|` blocks into one line (newlines lost) and treats only `true` and `yes` as true. It ignores `allowed-tools`, `user-invocable`, `when_to_use`.
- `disable-model-invocation` only hides a skill from the prompt list; `readSkillByName` still loads it by name. A skill folder shadows lower layers wholesale. Body cap is 200,000 chars (`MAX_SKILL_BODY_CHARS`, verified); the catalog has no size budget, and every `loadSkillsCatalog()` call walks the whole tree (the cache saves parsing, not traversal).
- Agent lookup order is project, then plugins, then system. Skill roots are global `.claude`, global `.agents`, system, plugins, project, with the later one winning.
- Edit engine: always rewrites the file with LF; sorts edits longest `search` first; throws on a `search` that occurs inside an earlier replacement; throws on multiple matches without `replace_all`; applies partially when only some edits miss; fuzzy match trims whole lines and replaces only the first block, even with `replace_all`; an empty replacement also eats one trailing newline.
- "Read before edit" is prompt text only. There is no guard. `writeFileHelper` supports an `expectedEtag` (`mtime|size`) but agent Write and Edit never pass it. Every write takes one process-wide `withMutex('worktree')`, and tools read the global `config.PROJECT_FOLDER`, so one process is one project. Per-run roots and per-worktree locks are the first change to any copy.
- The path guard allows all of `/tmp`; `.env*` is hidden from Glob and Grep but `Read` can open it; the `MoveFile` destination check is lexical only.
- MCP: the Claude SDK does not run OAuth in a browser. The AI SDK MCP client sends `mcp-protocol-version: 2025-11-25` before negotiation, which some servers reject, so Reforma uses the official `StreamableHTTPClientTransport`. A server that dies mid-session stays `ready` until a call fails.
- The AI SDK here is v7 (`instructions`, `toolsContext`, `timeout.stepMs`, `MockLanguageModelV4`). Snippets from v4 or v5 docs do not match.

## 6. How to use these notes

| Question | Open |
| --- | --- |
| Which Reforma tool does X, what are its limits, what is its output shape, how do errors look? Edit algorithm, path guard, tool order | `01-tools.md` |
| How does the loop, retry, stop condition, steer queue or interruption work? System prompt blocks, compaction thresholds, model binding, the ChatGPT-plan precedent | `02-agent-loop-and-profiles.md` |
| How do subagents spawn, resume, park, stream status and cancel? Mailbox, wake-up, what Reforma lacks for parallel runs | `03-subagents-and-background.md` |
| How is a command run, killed, polled, logged? Windows and macOS traps, the defect list, numbers table, logging and error classification | `04-commands-processes-logging.md` |
| Skill roots and format, memory, MCP config and OAuth, dynamic tools, plugins, what Claude and Codex give natively | `05-skills-memory-mcp-plugins.md` |
| What does a module import, which ports does the daemon need, can the loop run on another model, which tests carry over, three extraction options | `06-coupling-and-extraction.md` |
| Which engine and which loop does Clowdy use | `../claude-agent-sdk.md`, `../codex-sdk.md`, `../ai-sdk-harness.md`, `../orchestration.md` |

### Where the notes disagreed, and what the code says

- Note 01 marks `ListDirectory` as deferred in its tool table (`D`) but lists it as eager in section 1. The code settles it: `ListDirectory.ts` has no `DYNAMIC_TOOL` marker, so it is eager. Section 1 is right.
- Notes 01 and 03 say a read-only declared agent gets the read tools plus `ReadLints`; note 02 lists the read-only set without it. Both are true: `readonlyTools()` has no `ReadLints`, and `DeclaredSubagent.resolveTools` adds it when `readonly: true` and no `tools:` list is given.
- Note 02 calls the run ledger and `run-context` "pure besides `historyJournal` and `ThreadSession`"; note 06 calls `usage-ledger.ts` a leaf. For the ledger, note 06 is right: it imports only `ai` types and `./run-scope`. The `historyJournal` coupling is in `run-context.ts`.
- Note 05 says `.briefback/docs/agent/model-context.md` claims Anthropic gets native tool search, and note 04 says `.briefback/docs/sandbox/shell.md` still describes macOS `ps` for child discovery. The code wins in both cases: tool search is OpenAI-only (verified) and macOS uses libproc (note 04, `spawn.ts`).
- The deferred-tool counts in note 01 (17 eager, 26 deferred) were not recounted exactly; a grep finds the marker on 24 non-MCP builtin tools. Nothing here depends on the exact number.
