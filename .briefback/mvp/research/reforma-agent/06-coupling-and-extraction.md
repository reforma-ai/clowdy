# Reforma agent catalog 06: coupling map and extraction boundary

Scope: what the whole agent (`apps/sandbox/src/chat/**`) imports from the rest of Reforma, the narrowest set of ports Clowdy's daemon would have to supply, how model access is abstracted, what tests carry over, and three extraction options. Source: Reforma repo, read-only, code verified (checkout 2026-11, `ai@7.0.31`); nothing was built or run. Import numbers come from scripts over the source text (value imports; `import type` is excluded from closure and cycle numbers, included in the per-folder tables).

Paths are relative to the Reforma repo root, shortened: `SB/` = `apps/sandbox/src/`, `A/` = `SB/chat/agent/`, `TH/` = `SB/chat/threads/`, `ST/` = `SB/chat/streaming/`, `CO/` = `SB/core/`.
Lenses: **(a)** code stays on the Vercel AI SDK loop, **(b)** an engine (Claude Agent SDK / Codex SDK) owns the loop and only logic, prompts and schemas are reused. Verdicts: PORT-AS-IS, PORT-WITH-CHANGES, REWRITE-USING-IDEA, SKIP. Per-part verdicts live in notes 01 to 05; this note is about the boundary.

## 0. TL;DR

- `SB/chat/` is 200 files, 26,679 lines (`A/` 181 files / 21,843; `TH/` 6 / 2,259; `ST/` 6 / 999; `mcp-client/` 5 / 1,566). It has **no NestJS, no Hono, no middleware, no bus import and no `@reforma/sandbox-sdk` import**. Outbound edges go only to `CO/*`, `SB/api/*`, `SB/config.ts`, `SB/context`, `SB/utils` and three workspace packages.
- Roughly **5.2k lines (57 files) are Reforma-product-only** (onboarding, design, scaffold, preview, publish, plugins, images, LiteLLM, memory embeddings) and are deleted, not ported. What remains is about 21.4k lines.
- The coupling is not wide, it is **tangled**: from almost any heavy module the static import closure is **269 files / 40.0k lines** (55 of them cloud-class). One cycle (tools <-> `helpers/runtime-context.ts`) plus three glue edges cause it (section 2). So the practical unit of extraction is "leaf modules" or "everything behind ports", not file-by-file copying of mid-tier modules.
- Replacement surface is small: **12 ports (8 real, 4 stubs), roughly 1.2k to 1.5k new lines** (ThreadStore, ModelProvider, Config with a per-run workspace root, Sync/stream sink, run context, billing stubs, MCP config, resource roots, FileSystem/Shell root parameterisation). The 2.1k lines of `CO/files` and 2.8k of `CO/process` are copied, not rewritten.
- Model access is **well abstracted**: one registry returns `[LanguageModel, ModelOptions]` (6 call sites in 4 files). Any AI SDK 7 `LanguageModelV4` can run the loop; what breaks is provider-specific replay and error handling (section 5). Reforma already carries a ChatGPT-plan OAuth path as precedent, and no Claude-subscription path.
- Tests: 114 chat specs, 25,139 lines, 1,025 cases. About 44 specs / 396 cases are portable almost as-is, 35 / 391 are valuable after re-pointing mocks, 35 / 238 are product-specific. Two end-to-end specs drive the real loop with `MockLanguageModelV4`.
- **Recommendation**: B first (leaf modules behind ports), C for the Stage 5 engine path, keep A open and decide it only when the AI-SDK-with-subscription research returns a viable provider (section 8).

## 1. Size and shape

| Slice | Files | Lines | Notes |
|---|---|---|---|
| `A/` direct imports only `ai`, zod, node, `@reforma/*` (barrels included) | 103 | 6,500 | Many are 1-line `index.ts`; real pure code is about 5k |
| `A/` leaves via generic core (`CO/files`, `CO/process`, `CO/search`, `config`, `utils`, `CO/history`, `CO/task`) | 25 | 3,368 | Portable once those exist |
| `A/` leaves via chat glue (`TH/`, `ST/`, `mcp-client/`, `@/chat` singleton) | 18 | 4,594 | `run-context`, `Bash`, `Fetch`, `subagents/run`, `compaction`, `hooks/hook-protocol` |
| `A/` leaves via cloud/product (`SB/api/*`, `CO/{deploy,projects,integrations,git,workspace,lint,env-vars,sync,control}`, `request-context`) | 35 | 7,381 | Includes `agent.ts` (only `startHeartbeatLoop`) and `agent-profile.ts` (billing, snapshots) |
| Product-only, delete outright | 57 | 5,234 | `profiles/onboarding.ts`, `instructions/site-hosts.ts`, `helpers/messages/opt-plugins.ts`, tools: design, scaffold, preview/screenshot/CheckPage, dev-server, Build, ReadLints, InstallDeps, InstallPlugin, ProjectEnv, Publish, Commit, ListVersions, Navigate, ImageGen, SearchImage, ImportAsset, `shared/save-asset.ts`, WebSearch; `image-agent.ts`, `models/{gateway-fetch,llm-providers,model-factories,image-model-registry}`, `memory/**`, `tools/remember/**` |

Per subfolder of `A/` (direct-import class, files / lines):

| Folder | Pure | Generic core | Chat glue | Cloud/product | Where it leaks |
|---|---|---|---|---|---|
| `(root)` `agent.ts`, `context-usage`, `image-agent` | 3 / 368 | | | 1 / 919 | `agent.ts`: `startHeartbeatLoop`, Langfuse, `report-error` |
| `compaction/` | 2 / 398 | | 1 / 547 | | `chat-compaction` imports `TH/helpers` and `runtime-context` |
| `helpers/` | 12 / 2,240 | 3 / 1,091 | 3 / 263 | 2 / 475 | `runtime-context` (integration auth, preferences), `opt-plugins`; `normalize-file-parts`, `read-file-state` use `CO/files` |
| `hooks/` | | | 1 / 405 | 2 / 447 | `hook-runner`/`hook-sources`: plugin paths, integration hook env |
| `models/` | 10 / 1,418 | 1 / 80 | | 1 / 155 | `gateway-fetch`: billing, request context |
| `profiles/` | 3 / 45 | 1 / 17 | 1 / 26 | 5 / 1,296 | `agent-profile`: billing, snapshots, versions, sync, request context; `onboarding` |
| `run/` | 3 / 258 | | 1 / 499 | | `run-context`: `TH/thread-session`, `ST/` builder, `CO/history` |
| `skills/` | 3 / 151 | | | 3 / 524 | plugin paths, global skills, `CO/sync` |
| `subagents/` | 3 / 147 | | 2 / 641 | 1 / 383 | `run`: `TH/`, `ST/`; `workspace-agents`: plugin paths |
| `tools/` (63 pure files are mostly 1-line barrels) | 63 / 1,464 | 17 / 1,847 | 9 / 2,213 | 20 / 3,182 | `CO/files`, `CO/process`, billing, projects, deploy, lint, git |
| `memory/` | 1 / 11 | 3 / 333 | | | LiteLLM embeddings, `node:sqlite` |

Counts of agent-level things: 45 tools exported from `A/tools/index.ts`, plus `Preamble` and 4 onboarding-only tools; 20 files read the live `RuntimeContext` from tool options (`runtimeFromToolOptions`); 15 tool files define `toModelOutput`.

### The tangle (matters for extraction cost)

- Static value-import graph reachable from `SB/chat/`: **321 files / 47,473 lines** (includes `CO/*` and `SB/api/*`). Largest strongly connected component: **46 files / 7,032 lines** (35 in `A/tools/`, 6 in `A/helpers/`, 2 in `A/compaction/`, `hooks`, `TH/helpers.ts`, one `CO/integrations` file).
- Closure from `A/agent.ts`, `A/helpers/runtime-context.ts`, `Read`, `Bash`, `TodoWrite`, `Fetch`, `Agent`, `hook-runner`, `chat-compaction`, `sanitize-ui-messages`, `TH/helpers.ts` and even `ST/agent-event-writer.ts`: **269 to 275 files / ~40k lines**.
- Truly leaf modules (closure of 1 to 3 files): `helpers/tool-loop-guard.ts` (172), `provider-error-message.ts` (182), `context-limit-error.ts` (122), `payer-failure.ts` (337), `run/usage-ledger.ts` (210 + 30), `models/inference-harness.ts` (197 + payer-failure), `hooks/hook-protocol.ts` (405 + `mcp-configured-tools.ts` 117), `tools/shared/tool-result.ts` (31 + `config`). Small closures: `TH/thread-session.ts` (587; 9 files: `config`, `request-context`, `core/sync` -> `bus/event-bus`, `run-scope`, logger, `report-error`), `read-file-state.ts` (31 files), `skills/workspace-skills.ts` (29 files), `mcp-client/mcp-connection-manager.ts` (39 files).
- Chokepoints, verified in source: (1) `A/helpers/runtime-context.ts` imports the tools barrel, and 19 of its 21 value importers want only `runtimeFromToolOptions` (a 10-line type guard). Simulated cut: `Read`/`Bash` closure drops from 269 files / 40.0k lines to 54 files / 9.9k. (2) `A/compaction/chat-compaction.ts:9` imports `cloneRuntimeContext, thawFrozenSystem` from runtime-context. (3) `A/helpers/messages/wrap-user-message.ts:13` imports one string constant (`CONTEXT_COMPACTION_SUMMARY_COMMAND`) from `chat-compaction`, which drags message wrapping and `sanitize-ui-messages` into the cluster. (4) `TH/helpers.ts` imports the tools barrel, `memory/recall`, `opt-plugins` and `ChooseDesignDirection`. Cutting these in Clowdy's copy (not in Reforma) is the first refactor of any option.
- `A/tools/agent/Agent.ts:196` already works around one cycle with a dynamic `import('@/chat/agent/subagents')`. `TH/continue-thread.ts` registers module-level listeners on import (`import '@/chat/threads/continue-thread'` in `SB/api/chat/chat.ts` and `A/subagents/run.ts`); without that import background results never wake a thread.

## 2. Outbound dependency map (from `SB/chat/**`)

Counts are importing files in `A/` unless stated.

| Target | Symbols used | By | Verdict / Clowdy action |
|---|---|---|---|
| `SB/config.ts` | 32 files. Keys: `PROJECT_FOLDER` (15 uses), `LLM_API_URL`/`LLM_API_KEY` (8 each), `PROJECT_CONFIG_FOLDER` (7), `REFORMA_SYSTEM_FOLDER` (5), `AGENT_TMP_DIR` (5), `OUTPUT_LINES` (4, default 500), `PLUGINS_FOLDER`, `GLOBAL_SKILLS_SETTINGS` (3 each), `AGENT_MNT_DIR` (3), `WEB_SEARCH_TOOLS`, `NODE_ENV`, `GLOBAL_SKILLS_FOLDERS`, `UNSPLASH_ACCESS_KEY`, `TEMPLATES_DIR`, `PREVIEW_URL`, `STREAM_STEP_TIMEOUT_MS` (600,000), `IMAGE_TOOL_TIMEOUT_MS` (300,000) | tools, skills, memory, profiles, `CO/files/path.ts` | PORT-WITH-CHANGES: Config port with about 10 keys after deletions; `PROJECT_FOLDER` becomes per-run |
| `CO/files` | 23 files, 30 symbols: `validatePath`, `validateAgentPath`, `validatePathForCreation`, `assertAgentPathAllowed`, `isPathAllowed`, `readFileHelper`, `readBinaryFileHelper`, `writeFileHelper`, `writeBinaryFileHelper`, `applyFileEdits`, `applyContentEdits`, `listDirectoryHelper`, `createDirectoryHelper`, `moveFileHelper`, `removeFileHelper`, `pathExists`, `getFileStat`, `readPdfPageWindow*`, `officeDocument*`, `agentScratchDirs`, `workspaceRelativePath` | Read/Write/Edit/Glob/Grep/ListDirectory/MoveFile/RemoveFile/ImportAsset/Bash, skills, memory | PORT-WITH-CHANGES: copy 13 files / 2,124 lines; imports `config`, `withMutex`, `CO/history`, `CO/global-skills`, `CO/workspace/invariants`, `CO/process/bwrap` |
| `CO/process` | `processRegistry`, `CommandRunner`, `spawn`, `getShellCommand`, `textFromEntries`, `safeBaseEnv` | Bash, hooks, search, rtk | PORT-WITH-CHANGES: 17 files / 2,832 lines. Bun-only: `Bun.spawn` (`spawn.ts:501`), `bun:ffi` libproc on macOS (`spawn.ts:133`), `Timer` type. Windows: `taskkill /T /F`, Git Bash lookup (`default-shell.ts`). bwrap only on Linux and off with `SANDBOX_PROCESS_ISOLATION=off`. See note 04 |
| `CO/search` | `filenameSearchHelper` (fast-glob), `grepSearchHelper` (spawns `rg`, aborts above 50 MB output), `Bm25Index`, `foldMentionText`, `tokenizeSearchText` | Glob, Grep, chat search, mentions | PORT-AS-IS (623 lines); needs an `rg` binary |
| `CO/history` | `historyJournal.begin/end` (`run-context.ts:305,468`), `recordWrite/recordRemove`, `markOwnWrite`, `claimExternalPath`, `toJournalRelative` (called from `CO/files/file.ts`, `move-copy.ts`) | run-context, `CO/files` | SKIP the 955-line journal; stub 5 functions (it feeds Reforma's editor undo) |
| `CO/sync.ts` (18 lines) over `SB/bus/event-bus.ts` (517) | `setSync(id,data)`, `getSync(id)`; `chatThreadSyncId`, `RUN_CREDITS_EVENT`, `PLUGINS_UPDATED_EVENT` | `TH/thread-session.ts`, `skills-sync.ts`, `agent-profile.ts` | REWRITE-USING-IDEA: Sync port that emits a Clowdy event |
| `CO/control/control-lease.ts` | `hasPendingTakeover` | `TH/continue-thread.ts` (3 gates), `SB/api/chat/chat.ts` (409) | SKIP (UI edit lease between browser tabs) |
| `CO/task` | `taskControllerRegistry`, `TaskController` | dev-server tools only | SKIP |
| `CO/workspace/*` | `preferencesService.getPreferences()` (MCP servers, `mcp.json`), `McpServersConfig`, `AGENT_FORBIDDEN_PATHS`; product: `project-brief`, `scaffold`, `setup`, `install` | runtime-context, mcp tools, `mcp-client`, Glob, onboarding | Keep preferences (314 lines) as McpConfig; SKIP the rest |
| `CO/integrations/*` | `plugin-paths` (`listPluginPackageDirs`, `pluginDirName`), `mcp-runtime-auth` (`applyIntegrationAuth`, `getMcpAccessToken`, `getIntegrationHookEnv`); catalog/sync | skills, rules, agents, hooks, mcp-client | `plugin-paths` becomes a ResourceRoots list; keep OAuth token lookup as an interface; SKIP catalog/sync |
| `CO/global-skills.ts` (66) | `globalSkills` | `skills/workspace-skills.ts`, `CO/files/path.ts` | PORT-AS-IS if user-level skill roots are wanted |
| `CO/{git,lint,projects,deploy,env-vars}` | `lintChangedFile`, `lintWorkspace`, `commitWorkspace`, `revealInitializedProject`, `startDeploy`, `startHeartbeatLoop`, `reconcileProjectDevEnv` | Write, Edit, Commit, Publish, `agent.ts`, onboarding | SKIP; `lintChangedFile` stub returns `"none"` |
| `SB/api/chat/billing.ts` and friends | `checkBillingEntitlement`, `finalizeRunUsage`, `waitForSettledRunUsage`, `loadProviderCredential`, `OUT_OF_CREDITS_MESSAGE`; `dev-provider-calls`, `run-snapshot` (`commitRunSnapshot`), `api/git/versions`, `api/reforma-client` (`reformaApiFetch`, `ReformaApiError`, `sandboxActorInit`) | `agent-profile`, `Agent`, `WebSearch`, `gateway-fetch`, `continue-thread`, `thread-persistence`, `save-asset`, `ProjectEnv`, `InstallPlugin`, `site-hosts` | SKIP; billing becomes no-ops. `usage-ledger` token accounting stays |
| `SB/context/request-context.ts` (48) | AsyncLocalStorage: `projectId`, `userId`, `userName`, `authHeader` (`getRequestProjectId` keys the `threadsStore`) | 8 files | REWRITE-USING-IDEA: run context |
| `SB/utils/*` | `logger` (162, Sentry redact), `ids` (26), `async.withMutex` (206), `report-error` (121, Sentry), `resolve-dev-fetch-url` (14) | everywhere | `ids`, `async`: PORT-AS-IS; `logger`/`report-error`: replace with Clowdy logger |
| `ST/*`, `TH/*`, `mcp-client/*` | `@/chat` `threadsStore` singleton (module-level `new ThreadSessionStore()`), `AgentEventBuilder`, `createMessageStream`, `startThreadRun`, `McpConnectionManager` | profiles, subagents, tools | Come along with the loop (option A); `threadsStore` is mocked via `vi.mock('@/chat')` in tests |
| `@reforma/types` | 96 distinct symbols, 78 import sites; `ReformaUIMessage` alone in 26 files; `packages/types/src/sandbox/{ui-message (471),ui-parts,ai,usage-metadata,process,skills,todos,plans,hooks}.ts` (900 lines) + 36 files in `sandbox/tools/` (1,161 lines); `ReformaChatUITools` unions 44 `*UITool` types, `ReformaChatDataTypes` has 13 `data-*` parts | everywhere | PORT-WITH-CHANGES: copy a slice (about 2k lines) and prune the tool union |
| `@reforma/constants` | 16 symbols: `CHAT_MODELS`, `chatModelAlias/Effort/ForAlias`, `routeChatModel`, `DEFAULT_CHAT_MODEL`, `CHAT_HISTORY_TAIL`, `chatThreadSyncId`, `RUN_CREDITS_EVENT`, ... (`chat-models.ts` 419 lines) | models, threads | Rewrite the catalog; keep the shape |
| `@reforma/lib` | `logger`, `errors`, `skills` (284 lines), `extensionForMediaType`, `readMcpToolAllowList`, `readTrimmedStringList`, `wait` | 12 files | Copy those slices only; the barrel `@reforma/lib` also exports React/DOM helpers |
| third party | `ai`, zod, `@ai-sdk/{openai,anthropic,google,provider-utils,mcp}`, `@modelcontextprotocol/sdk`, `mdream`, `mime-types`, `@langfuse/tracing` (1 file), `node:sqlite` (memory), `@sentry/bun` | see section 4 | |

## 3. Ports: the narrowest set

"Reforma impl" is what to replace or copy; "size" is a rough estimate of the Clowdy side, not measured.

| # | Port | Surface the agent actually calls | Reforma impl | Clowdy side |
|---|---|---|---|---|
| 1 | ModelProvider | `reformaModelRegistry.getModel(spec, overlay): [LanguageModel, ModelOptions]`, `getModelIfRegistered`, `normalizeModelCall`; credential scope `getInference/runWithInference/outsideInference/bindThreadInference` | `A/models/*` (12 files, 1,653 lines; 521 of them LiteLLM/image specific) | New registry entries for subscription/engine models, about 250 lines. Call sites: `runtime-context.ts:140`, `chat-compaction.ts:208,469`, `Fetch.ts:289,292`, `TH/thread-title.ts:49` |
| 2 | Config + workspace root | about 10 keys (section 2) plus a **per-run workspace root** | `SB/config.ts` (219) | `PROJECT_FOLDER` is read as a process global in 15 chat sites and all of `CO/files/path.ts`. Clowdy runs many worktrees in one daemon, so the root must be run-scoped (ALS or explicit argument) or each executor runs in its own host process. About 100 lines plus edits in `CO/files` |
| 3 | FileSystem | the 30 `CO/files` symbols; path allow-list (`ALLOWED_DIRECTORIES`, agent scratch `AGENT_TMP_DIR`, `AGENT_MNT_DIR`), forbidden paths, `withMutex('worktree')` (global) | `CO/files` | Copy, then make mutex key and root per worktree (note 01, section 5.1) |
| 4 | Shell | `processRegistry.createCommand(spec, id)`, `CommandRunner.{start,kill,waitForExit,once('exit'/'error'),getLogPath,isRunning,exitCode,signal}`, `getCommandOutputEntries(id,n)` | `CO/process` | Copy (note 04). Background delivery goes through the thread mailbox, so it needs ThreadSession (port 6) |
| 5 | Search | fast-glob, `rg` spawn, BM25 | `CO/search` | Copy; ship or require `rg` |
| 6 | ThreadStore | `createThread`, `findLatestChildThread(parent, name)`, `loadDetail(id,{limit,skip})` (default `CHAT_HISTORY_TAIL`), `listMeta(limit)`, `syncSession` (dirty-suffix diff by index + JSON equality against a per-thread `lastSynced`, `truncateAfterMessageId`, meta: title, sessionKey, updatedAt, todos, plan, contextUsage), `deleteThread`, per-thread `withMutex` | `TH/thread-persistence.ts` (330 lines of HTTP to Reforma Cloud `/projects/:id/chat/threads`), `thread-session-store.ts` (217), `thread-session.ts` (587, in-memory: queue, steers, background jobs, frozen system, abort, run status) | About 350 new lines over SQLite. Keep `ThreadSession` and the store, replace only `ThreadPersistence`. Messages are stored as `ReformaUIMessage[]` (UI parts), see section 6 |
| 7 | Sync + stream sink | `setSync/getSync`; `AgentEventWriter` (UIMessage chunk writer), `createMessageStream`, `startThreadRun` (SSE + in-memory resume buffer + 15 s heartbeat) | `CO/sync.ts`, `ST/*` (999 lines) | `ST/` is mostly generic AI SDK UI-stream plumbing. Clowdy needs an adapter from UI chunks to its stream items and cursor events (about 300 to 500 new lines, own design) |
| 8 | RunContext | four AsyncLocalStorage stores: request (`projectId`, `userId`), run scope (`run-scope.ts`, root run id), inference (payer credential), tool-file-model (`models/tool-file-model.ts`) | `SB/context`, `A/run/run-scope.ts`, `A/models/*` | Collapse into one run context; `outsideRunScope`/`outsideInference` exist for wake-ups that run after the request is gone |
| 9 | Billing/Usage stubs | entitlement, finalize, credits stamping, `OUT_OF_CREDITS_MESSAGE`, heartbeat | `SB/api/chat/billing.ts` (174) | No-ops, about 40 lines |
| 10 | McpConfig | `preferencesService.getPreferences().mcpServers` (`mcp.json`), `applyIntegrationAuth`, `getMcpAccessToken` | `CO/workspace/preferences-service.ts` (314), `CO/integrations/mcp-runtime-auth.ts` (304) | Interface plus copy, see note 05 |
| 11 | ResourceRoots | dirs for rules, skills, agents, hooks: `REFORMA_SYSTEM_FOLDER`, `PROJECT_CONFIG_FOLDER`, plugin dirs, global skill folders | `CO/integrations/plugin-paths.ts` (33), `global-skills.ts` (66) | One function returning a list of roots |
| 12 | Observability | `createLogger` (`@reforma/lib/logger`, 69 lines), `captureSandboxError`, Langfuse `propagateAttributes` (only `agent.ts`), AI SDK `telemetry.functionId` | various | Logger adapter, no-op tracing |

Minimum to run the loop plus the generic tools: ports 1 to 8, with 9 to 12 as stubs. The HTTP entry that orchestrates a turn is **outside** `chat/`: `SB/api/chat/chat.ts:chatHandler` (194 lines; resolve payer, load or create thread, merge messages, 409 gates, `createAgentProfile` or `createSubagent`, `tagTurnMessages`, `startThreadRun`). A copy of `chat/` has no entry point; Clowdy writes its equivalent as a daemon command (about 150 lines).

Estimate of copy vs replace for option A: copy about 21.4k lines of `chat/` after deleting product code, plus about 8k of support (`CO/files` 2.1k, `CO/process` 2.8k, `CO/search` 0.6k, utils about 0.7k, types slice about 1.5k, constants/lib slices about 0.5k); write about 1.2k to 1.5k new lines. Optional extra: `CO/history` 1.0k, `McpConnectionManager` already counted in `chat/`.

## 4. Runtime packages the agent needs

| Package | Version in Reforma | Used for | Note |
|---|---|---|---|
| `ai` | 7.0.31 (exact, also in `packages/{components,types,plugin-sdk}`) | loop, UI stream, `convertToModelMessages`, `wrapLanguageModel`, `Output`, `ai/test` mocks | AI SDK 7 only names: `streamText({instructions, toolsContext, runtimeContext, timeout:{stepMs,tools}, reasoning, allowSystemInMessages, onToolExecutionStart/End})`, standalone `toUIMessageStream`, `LanguageModelV4`, `MockLanguageModelV4`. Pin it; do not mix with older `@ai-sdk/*` |
| `@ai-sdk/anthropic` / `openai` / `google` | 4.0.16 / 4.0.16 / 4.0.18 | provider clients | only `models/*` and `image-model-registry` |
| `@ai-sdk/mcp`, `@modelcontextprotocol/sdk` | 2.0.15, ^1.27.1 | `McpConnectionManager` (stdio + streamable HTTP) | skip if the engine owns MCP |
| `zod` | ^4.3.6 (root ^4.6.7) | every tool schema | |
| `mdream` | 1.5.5 | `Fetch` HTML to markdown | native addon, bundled specially in Reforma Desktop |
| `officeparser` 8.2.0, `unpdf` 1.6.2 | | Read of PDF/Office | |
| `fast-glob`, `minimatch`, `diff`, `mime-types` | ^3.3.3, ^10.2.4, undeclared, undeclared | `CO/files`, search, Read | `diff` and `mime-types` are imported in `src` but **not declared** in `apps/sandbox/package.json` (hoisted); declare them on copy |
| `@langfuse/*` 5.9.1, `@sentry/bun` 11.11.0 | | tracing, error reports | drop |
| `node:sqlite` | | `memory/store.ts` | drop with memory |
| `vitest` | ^5.0.1 (Clowdy has the same) | specs | Reforma runs them on Node; Clowdy's plan runs daemon tests with `bun test`, so ported specs need Vitest (root `AGENTS.md`: never bare `bun test`) |

Not needed by the agent: `hono`, `jose`, `node-pty`, `@xterm/*`, `archiver`, `assistant-stream` (declared, not imported in `src`).
Runtime: Bun (same as Clowdy's daemon). Reforma Desktop already runs this exact controller on macOS and Windows as a `bun build --compile` binary with `SANDBOX_PROCESS_ISOLATION=off`, non-login bash, libproc tree walk and `taskkill` (`.briefback/docs/desktop/local-projects.md`). That is real prior art for the file and process layers; the doc's "Not yet verified" section still lists open items, and `ffmpeg`, `yt-dlp`, Python-based tools do not work locally.
`apps/sandbox/package.json` declares `"license": "UNLICENSED"`, author "Reforma, Inc." Confirm rights if Clowdy lives under another entity. A copy is a fork with no upstream sync.

## 5. Model access: can the loop run on a different `LanguageModel`?

**Yes, with one seam.** Everything calls `reformaModelRegistry.getModel(spec, overlay)` (`A/models/model-registry.ts`), which returns `[LanguageModel, ModelOptions]`. `ModelOptions` (`model-options.ts`): `contextWindow` (250,000), `softCap` (130,000, preflight compaction), `hardCap` (200,000, mid-turn), `reasoning`, `providerOptions`, `supportedMimeTypes`, `capabilities.systemPrompt` (`'in-history'` or `'leading-only'`), `supportedUrls`, `extraTools`. `resolveEntry` has two branches: gateway (LiteLLM) and **user credential**: when `getInference()` (AsyncLocalStorage `InferenceCredential {bearer, kind: 'api_key'|'oauth', providerId}`) is set, `createInferenceModel` builds `createOpenAI/createAnthropic/createGoogleGenerativeAI({apiKey: bearer, baseURL, fetch: payerFetch})`. A subscription provider is a new `case` there, or a registry entry built directly.

Precedent in code for a subscription credential on the AI SDK loop (OpenAI only, `kind === 'oauth'`):

| Workaround | Where |
|---|---|
| strip `prompt_cache_options`, `prompt_cache_key`, `prompt_cache_breakpoint` from the request body (plan usage rejects them) | `models/inference-harness.ts:openAIPlanFetch` |
| no hosted `tool_search` (falls back to the dynamic gateway tools) | `models/resolve-provider-tools.ts:familyHasToolSearch` |
| every one-shot must stream: `completeText` uses `streamText` because plan usage rejects non-stream Responses | `helpers/complete-text.ts` |
| limit/access errors become `PayerFailureError` from the provider `fetch`; it is not an `APICallError`, so the SDK default of 2 retries on 429 does not fire. Limit codes listed in `payer-failure.ts` (`subscription_sharing_usage_limit_exceeded`, `insufficient_quota`, ...) | `inference-harness.ts:payerFetch`, `helpers/payer-failure.ts` |

What would break or need work with a subscription-backed `LanguageModel`:

| Area | Behaviour in code | Effect on another provider |
|---|---|---|
| Provider family | `providerFamily(model)` matches `model.provider` prefix `openai.`, `anthropic.`, `google.`; anything else is `undefined` | Falls to the dynamic-gateway path (`GetDynamicTools`/`CallDynamicTool`, no namespaces, no `deferLoading`). Works; costs eager schema tokens |
| Cache markers | `withCachedSystem`, `withCachedLastMessage`, `withCachedLastTool` always stamp `providerOptions.anthropic.cacheControl = {type:'ephemeral'}` on the system block, the last message and the last eager tool; `withPromptCacheKey` always stamps `providerOptions.openai.promptCacheKey = threadId`; `withoutCacheWrites` sets `promptCacheOptions.mode='explicit'` for one-shots | AI SDK `providerOptions` are namespaced, so a provider that reads only its own key ignores them. An Anthropic-wire provider uses them (5 min TTL, 4 breakpoints max per request); wrappers that reject unknown fields must strip them like `openAIPlanFetch` does |
| Tool schemas | zod 4 `inputSchema` converted by the SDK; markers in `tool.providerOptions` (`reforma.dynamic`, `openai.namespace`, `openai/anthropic.deferLoading`); hosted `openai.tools.toolSearch()` only for OpenAI non-oauth; `assertOpenAiStrictObjectSchema` only for profile `output` | Plain function tools work anywhere. 15 tools return media through `toModelOutput` (Read: images, PDF): the provider must accept media in tool results, otherwise `normalizeFileUIParts` (643 lines) expands to text via `supportedMimeTypes` |
| Reasoning replay | top-level `reasoning` (SDK 7); OpenAI-only options `store:false`, `forceReasoning`, `reasoningSummary:'auto'`, `passThroughUnsupportedFiles`; stored UI parts keep `providerMetadata.openai.{itemId, reasoningEncryptedContent}`; `createProviderItemStreamGuard`, `stripProviderItemIdsFromMessages` (on phase-model change and one stale-item retry), `stripReasoningEncryptedContentFromChunk` (writer hides encrypted content from the client) | Anthropic `signature` and Gemini `thought_signature` ride along in `providerMetadata` untouched. Only OpenAI ids are sanitised, so switching provider family inside one thread is unhandled. Keep a thread on one provider, or add a sanitiser |
| System prompt | `capabilities.systemPrompt` drives `allowSystemInMessages`; Gemini is `'leading-only'` | A transport with a single system slot must declare `'leading-only'` |
| Usage | `stepsExceedCompactionThreshold` and the ledger read `LanguageModelUsage` of the last step | If the provider omits input tokens or cache read/write, mid-turn compaction never triggers; only `isContextLimitExceededError` plus one compaction retry (`MAX_PROVIDER_CONTEXT_LIMIT_RETRIES = 1`) protects |
| Errors | regex/status classifiers for OpenAI, Anthropic, Google bodies: `providerErrorMessage`, `isContextLimitExceededError`, `isStaleProviderItemError`, `payerFailureForRun` | Unknown provider errors surface as `Message stream error`; extend the classifiers |
| Agentic wrapper | not verified in code | A provider that wraps Claude Code or Codex runs its own loop and tools inside `doStream`. Nesting that under Reforma's loop (compaction, steering, tool repair) duplicates ownership; (a) only makes sense for a plain model transport |

Validation harness already exists: `steer-flow.test.ts` and `compaction-flow.test.ts` run the real `ReformaAgent.execute` with `MockLanguageModelV4` from `ai/test`, so a candidate provider can be checked against the same fixtures. Outside the main loop, `getModel` is also used by compaction (`lite` fallback), `Fetch` summarizer and thread titles.

## 6. Subtle behaviours that affect extraction

- **Process-global singletons**: `config.PROJECT_FOLDER`, `threadsStore` (`SB/chat/index.ts`), `processRegistry`, `preferencesService` (constructed with `PROJECT_CONFIG_FOLDER`), `historyJournal`, `eventBus`, `controlLease`. One controller process is one project. This is the biggest semantic mismatch with Clowdy's many-worktrees daemon (also flagged in note 01).
- **UIMessage is the source of truth.** Threads persist `ReformaUIMessage[]` (tool parts, reasoning with `providerMetadata`, 13 `data-*` part types such as `context-compaction`, `user-steer`, `background-result`, `subagent-status`, `payer-failure`). Model messages are rebuilt every step by `convertToModelMessages` (`runtime-context.ts:buildModelMessages`, wrapped in `withToolFileModel` because `toModelOutput` has no model argument). Compaction, steering, subagent results and background results all rewrite UI parts, so the loop is welded to the `@reforma/types` UI message type. Under (b) that welding disappears.
- **Subagents are child threads** run in-process by the same profile loop; the child SSE is persisted through `startThreadRun` and tee'd to feed activity into the parent `Agent` tool row (`A/subagents/run.ts:consumeChildStream`). They need ThreadStore (port 6) and `createThread` with `parentThreadId`.
- **Frozen system prompt**: assembled once per thread (`frozenSystem`, `frozenMcp` on `ThreadSession`), reused for cache stability, thawed only by compaction (`thawFrozenSystem`). Prompt text lives in `packages/reforma-system/{rules,agents,skills}` (markdown read at runtime via `REFORMA_SYSTEM_FOLDER`), and much of it is the Reforma designer persona.
- **Tools tolerate a missing RuntimeContext**: `SB/api/tools/dispatch.ts:dispatchTool` calls `execute(input, {toolCallId: 'mcp', messages: []})` for 18 tools (Bash, Edit, Read, Write, Glob, Grep, ListDirectory, MoveFile, RemoveFile, ...). A ready-made boundary for exposing file/shell tools as in-process MCP tools to an engine (option C).
- **Tests run on Node under Vitest** (alias `@` to `SB/`, `.env.test`, `TEST_PROJECT_DIR` default `/sandbox/test-project`), with Bun APIs mocked (`vi.mock('@/core/process/spawn')`).
- **Key numbers kept in this boundary**: `DEFAULT_MAX_TURNS` 200; `STREAM_STEP_TIMEOUT_MS` 600,000; `MAX_STOP_HOOK_CONTINUES` 3; `MAX_PROVIDER_CONTEXT_LIMIT_RETRIES` 1; `MAX_STALE_PROVIDER_ITEM_RETRIES` 1; smoothStream 80 ms; `DEFAULT_HOOK_TIMEOUT_MS` 30,000; Bash default 120,000 ms / max 600,000 ms / tail 100 lines; `TOOL_RESULT_SPILL_BYTES` 24 KiB; event bus queue 100 / replay 500 / TTL 30,000 ms.

## 7. Test coverage to reuse (`SB/specs/chat/**`, 114 specs, 25,139 lines, 1,025 cases)

| Tier | Specs / lines / cases | Which | Needs |
|---|---|---|---|
| A: portable, no Reforma-core mocks | 44 / 7,679 / 396 | `chat-compaction`, `microcompact`, `sanitize-ui-messages`, `wrap-user-message`, `runtime-context-system`, `run-context`, `usage-ledger`, `context-usage`, `step-notes`, `tool-loop-guard`, `steer-flow`, `client-model-options`, `context-limit-error`, `provider-error-message`, `threads/helpers`, `thread-session-status`, `chat-queue`, `hooks/hook-protocol`, `turn-hook-context`, `tools/{dynamic-gateway,tool-order,tool-result,tool-model-output,todo-tools,ask-user-question,plan-tool,get-background-result,waiting,preamble,client-tools,chat-transcript,search-transcript,rtk-rewrite,host-policy}`, `subagent-activity`, `tag-user-message-*`, `structured-output`, `resumable-stream`, `sse-heartbeat`, `start-thread-run`, `interrupted-tool-resume`, `complete-text` | The `@` alias, `.env.test`, config/`CO/sync` stubs. Many pull the whole 269-file closure through the barrel, so under option B only the leaf ones run: `tool-loop-guard`, `provider-error-message`, `context-limit-error`, `usage-ledger`, `hook-protocol` |
| B: valuable after re-pointing mocks | 35 / 11,349 / 391 | `compaction-flow` (real loop with `MockLanguageModelV4`; mocks `reforma-client`), `default-profile` (1,198), `run-subagent` (641), `continue-thread` (728), `thread-persistence` (705, rewrite for the local store), `agent-background`, `stop-background-jobs`, `bash-background`, `filesystem-tools`, `edit-tool`, `read-tool`, `agent-path-guard`, `read-file-state`, `normalize-file-parts` (495), `workspace-skills` (833), `slash-skills`, `workspace-agents`, `declared-subagent`, `hooks/{runner,sources,runtime}`, 8 MCP specs (`mcp-tools` 803, `mcp-connect-status` 643, `mcp-resources`, ...), `fetch-tool` (575), `inference-harness` | Fake FileSystem root, fake ThreadStore, process/spawn mock, MCP SDK mocks |
| C: Reforma product, skip | 35 / 6,111 / 238 | `onboarding-profile` (1,100), gateway/LiteLLM/image/Gemini/OpenRouter registry specs, `payer-failure` (billing-shaped; port the taxonomy cases only), scaffold, design direction, page screenshot, dev-server, publish, project-env, install-plugin, opt-plugins, unsplash, site-hosts | none |

The most valuable regression assets are `compaction-flow` and `steer-flow` (whole loop, deterministic, no network), `sanitize-ui-messages` (293), `chat-compaction` (967), `wrap-user-message` (588) and `read-file-state` (287). Helpers: `SB/specs/helpers/{chat-mocks,system-rules-fixtures}.ts`, `SB/specs/test-setup*.ts`.

## 8. Extraction options

| | A. Copy `chat/` wholesale behind ports | B. Copy selected modules | C. Reimplement ideas on the Claude Agent SDK |
|---|---|---|---|
| What | Whole loop (`agent.ts`, run, helpers, compaction, profiles, subagents, hooks, skills, 30 generic tools, `TH/`, `ST/`, `mcp-client/`) plus `CO/files|process|search`, a types slice and ports 1 to 12 | Leaf tier first: error taxonomy (`provider-error-message`, `context-limit-error`, `payer-failure` taxonomy), `tool-loop-guard`, `usage-ledger`, `hook-protocol/runner/sources` (about 850 lines), skills discovery (`packages/lib/src/skills.ts` 284 + catalog), declared-agent format (`workspace-agents` 383), `CO/files` edit engine and path guard, `spillIfLarge`, `CO/process`, `ThreadSession` queue/steer/background state machine, `read-file-state`, then compaction and MCP client if needed | Engine owns the loop and built-in tools. Port only: prompts/rules/agents markdown, hook JSON protocol, skill folder convention, steer/queue semantics, error taxonomy, tool-output spill, loop guard as a hook, orchestrator tools as an in-process MCP server (the 18 tools behind `dispatchTool` show the shape) |
| Effort (estimate) | 10 to 15 working days: untangle 35 cloud-class files, prune the `ReformaUIMessage` tool union, per-run root, ThreadStore, entry handler, stream adapter, get tiers A and B green | 4 to 7 days for about 6k to 9k lines, starting with the `runtimeFromToolOptions` leaf cut; each extra mid-tier module adds 0.5 to 1.5 days | 3 to 5 days for the adapter (Stage 5), plus 2 to 4 days for the ports above |
| Risk | High. Carries product assumptions (designer persona prompts, single-project globals, UI-message typing), a fork with no upstream sync, `ai@7.0.31` pin, and it is **blocked on a subscription-capable `LanguageModel`** (section 5). Two engines (Codex) would not fit the loop at all | Low to medium. Pieces drift from the original; integrated loop semantics (compaction at 130k/200k, steering between steps, Stop-hook continues, repair, phase handoff) are not obtained | Medium. Behaviour outside our control (SDK compaction, permission model, session resume), parallel adapter per engine, mid-turn steering depends on SDK streaming input. Little Reforma code is reused |
| Payoff | Everything the owner described: error handling, 45 tools, background commands with thread wake-ups, subagents as threads, skills, hooks, MCP, compaction, usage ledger, about 790 reusable test cases | Most of the "excellent error handling, skills, hooks, command execution" value at the lowest coupling, and a foundation for A without committing to it | Fastest path to a real subscription-backed run, which is what Stage 5 of `plan.md` needs |
| Fits (a) / (b) | (a) only | both; leaf tier is loop-independent | (b) only |

**Recommended plan**

1. In Clowdy's copy, never in Reforma, make the first refactor: move `runtimeFromToolOptions` and the `RuntimeContext` types to a leaf module, move the compaction constant out of `chat-compaction.ts`, and drop the tools barrel from `TH/helpers.ts`. Simulated effect: tool closure 269 to 54 files.
2. Land option B's leaf tier in a daemon-internal package behind ports 2, 3, 4, 6, 8 with their Tier A specs (about 400 cases) on Vitest.
3. Build the engine path as option C for Stage 5, exposing the generic file/shell tools as in-process MCP tools only where the engine's built-ins fall short (notes 01 and 04 list the gaps).
4. Revisit option A only if the separate research confirms a plain-transport subscription `LanguageModel` that passes `compaction-flow` and `steer-flow`. Then the incremental cost over B is the loop (`agent.ts`, `run/`, `helpers/`, `compaction/`, `profiles/`, `subagents/`, about 12k lines) and Tier B specs.

## 9. Open questions

- Is one host process per worktree acceptable (as Reforma Desktop does per project), or must `CO/files` and `config.PROJECT_FOLDER` become run-scoped? This decides the size of port 2.
- Which stream format does Clowdy want from the engine adapter: AI SDK UI chunks (reuse `ST/`) or its own stream items (drop `ST/` and `TH/` UI-message persistence)? Under (b) the second is the natural fit.
- Reforma's prompt rules in `packages/reforma-system/rules` are product-specific; Clowdy needs its own identity and boundaries text.
- `apps/sandbox/package.json` license and authorship (section 4).
