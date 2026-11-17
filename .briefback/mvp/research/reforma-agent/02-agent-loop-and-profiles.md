# Reforma agent: loop, profiles, prompts, context management

Area 02 of the Reforma agent catalog. Source: Reforma repo `apps/sandbox` (Vercel AI SDK `ai@7.0.31`, `@ai-sdk/anthropic@4.0.16`, `@ai-sdk/openai@4.0.16`, `@ai-sdk/google@4.0.18`). Everything below was read in code; paths are relative to the Reforma repo root, shortened by these prefixes:

- `A/` = `apps/sandbox/src/chat/agent/`, `T/` = `apps/sandbox/src/chat/threads/`, `S/` = `apps/sandbox/src/chat/streaming/`
- `R/` = `packages/reforma-system/rules/` (prompt text, plain markdown read from disk at runtime)

Verdict columns: **(a)** Clowdy keeps the AI SDK loop, **(b)** an engine (Claude Agent SDK / Codex SDK) owns the loop and we reuse only logic, prompts and schemas.

## 1. Headline

- The loop is a **custom outer loop around `streamText`** (AI SDK 7), not `ToolLoopAgent` and not `generateText`. The outer loop (`A/agent.ts:ReformaAgent.runPhases`) re-calls `streamText` for compaction restarts, steers, Stop-hook continues, retries and multi-phase profiles. `generateText` is used only for one-shots (compaction summary, thread title) through `A/helpers/complete-text.ts`.
- Conversation state is **AI SDK `UIMessage`s** (`ReformaUIMessage`, `packages/types/src/sandbox/ui-message.ts`), converted to model messages on every step. History lives in Reforma Cloud (`/projects/:id/chat/threads`); the sandbox only holds an in-memory `ThreadSession`. Clowdy plans SQLite stream items, so the persistence layer is a rewrite either way.
- The best reusable assets are small and pure: `tool-loop-guard`, `context-limit-error`, `provider-error-message`, `payer-failure`, `usage-ledger`, `microcompact` plus the compaction thresholds and summarizer prompt, step notes (steer / background result injection), the `ThreadSession` run/queue state machine, the stable-prefix prompt discipline.
- Most of the heavy plumbing (billing, gateway, hosted tool search, Reforma Cloud sync, onboarding, project commit snapshots) is not wanted.
- Reforma already ships a **ChatGPT-plan OAuth path** (`kind: 'oauth'`, openai only) and an `AsyncLocalStorage` payer. There is **no Claude-subscription path**: the anthropic client only takes API keys. See section 5.

## 2. Run assembly and execution

| Step | file:symbol | What happens |
|---|---|---|
| HTTP entry | `apps/sandbox/src/api/chat/chat.ts:chatHandler` | Resolves payer (`api/chat/run-inference.ts:resolveRunInference`), loads or creates thread, `mergeUiMessagesById` (client sends history, server restores server-only metadata), 409 `RUN_IN_FLIGHT` unless the run is parked on the user, `tagTurnMessages` (UserPromptSubmit hook, plugin hints, memory recall stamped on the user message), builds profile (`createAgentProfile(runConfig.profile ?? 'default')`, or `createSubagent` for child threads), `startThreadRun`. |
| Stream plumbing | `S/start-thread-run.ts`, `S/agent-event-writer.ts:createMessageStream`, `S/resumable-stream.ts`, `S/sse-heartbeat.ts` | `AgentProfile.stream()` returns an AI SDK `createUIMessageStream`; wrapped by `createUIMessageStreamResponse`; the SSE copy is also buffered in memory per thread so a second client can `GET` resume; 15 s `: ping` heartbeat to the live client only. |
| Run object | `A/agent.ts:ReformaAgent.execute`, `A/run/run-context.ts:RunContext` | One `RunContext` per run: ids, abort signal, writer, `RunUsageLedger`, lifecycle callbacks. `done` promise resolves to `{stopReason, output?, outputError?, error?}`. Wrapped in `runWithRunScope` (billing id), Langfuse `propagateAttributes`, `runWithInference` (payer), and a cloud `startHeartbeatLoop`. |
| Per-phase context | `A/helpers/runtime-context.ts:createRuntimeContext` | Resolves model from the registry, opens MCP (`McpConnectionManager`), merges tools (profile tools + frozen MCP + model `extraTools` + `Preamble` + hosted tool search), applies tool groups, wraps every `execute` with hooks (`wrapToolsWithHooks`), resolves the frozen system prompt, builds `prepareStep`. |
| Model step | `A/agent.ts:runModelPhase` | One `streamText` call (see args below) piped through `toUIMessageStream` into the writer. |
| Per step | `RuntimeContext.prepareStep` (same file) | Detect tool loop, take step notes (steers, background results), rebuild model messages, add cache breakpoints, force text on the last turn. |
| Phase end | `A/agent.ts:finishModelPhase`, `runPhases` tail | Close ledger phase, handle phase handoff, queued steers, Stop hook, `park` vs `finish`, final `finish` chunk. |

**`streamText` arguments (A/agent.ts:682).** `model`, `instructions` (system), `allowSystemInMessages` (true when `capabilities.systemPrompt === 'in-history'`), `messages`, `tools`, `abortSignal`, optional `output` (structured), `timeout: { stepMs: 600_000, tools: { GenerateImageMs: 300_000 } }` (env `STREAM_STEP_TIMEOUT_MS`, `IMAGE_TOOL_TIMEOUT_MS`; deliberately no `chunkMs` because it stays armed during tool execution), `runtimeContext` + `toolsContext` (the live `RuntimeContext` is handed to every tool as `options.context`), `stopWhen`, `prepareStep`, `repairToolCall` (repairs direct calls to deferred/MCP tools), lifecycle callbacks (`onStart`, `onStepStart`, `onStepEnd`, `onToolExecutionStart/End`, `onEnd`, `onChunk`, `onError`), `reasoning`, `providerOptions`, `experimental_download` (attachment fetcher/cache), `experimental_transform: smoothStream({ delayInMs: 80, chunking: /(?:\S+\s+){2,5}/m })`, `include.requestBody: false`, `telemetry`. `maxRetries` is **not** set, so the SDK default applies (2 retries; the `payerFetch` design depends on this, see section 5). `toolOrder` is returned from `prepareStep` for a stable tool prefix.

**Stop conditions (all OR-ed, `A/agent.ts:631`).** (1) `stepCountIs(maxTurns)`, `maxTurns` default **200** (`DEFAULT_MAX_TURNS`), child agents **60**, overridable per request via `runConfig.maxTurns`. (2) Optional per-phase `stopWhen`; if it fires and a next phase exists the run advances to it (handoff). (3) Compaction stop: after a step whose `input+output` tokens reach the hard cap the stream stops, the outer loop compacts and **re-enters the same assistant message** (skipped when `steps.length >= maxTurns` so the wrap-up text step never reopens a loop).

**Last turn is text-only.** `isLastAgentTurn(steps.length, maxTurns)` is true when `steps.length >= maxTurns - 1`; `prepareStep` then returns `toolChoice: 'none'` and appends the ephemeral note `Turn limit reached. Stop calling tools. Finish now in text: ...`. So a run does `maxTurns-1` tool-capable steps plus one text step. The same `toolChoice: 'none'` is applied when the tool-loop guard halts (section 9).

**Outer loop order (A/agent.ts:450).** abort check, optional compaction (`summarizeReason`), `runModelPhase`, then `finishModelPhase`; then (1) phase handoff if `stopWhen` fired, (2) another pass if a steer arrived during the final text step and `!childNeedsUser` and `steps < maxTurns`, (3) `Stop` hook: `decision: 'block'` adds hook context and loops again, at most `MAX_STOP_HOOK_CONTINUES = 3`, (4) `park` when the last assistant row waits on a client tool or approval (`childNeedsUser`), else `finish`. `SessionEnd` hook fires unless `park`.

**Retries inside `runModelPhase`.** Context-limit provider error: one compaction retry (`MAX_PROVIDER_CONTEXT_LIMIT_RETRIES = 1`, counter resets after a successful phase, second failure fails the run with `Context still exceeds model limits after repeated compaction`). Stale OpenAI item reference (`Item with id ... not found`, orphaned reasoning item, invalid `input[n].id`): one retry with all provider `itemId`s stripped (`MAX_STALE_PROVIDER_ITEM_RETRIES = 1`). Both detections live in `A/helpers/context-limit-error.ts` and `provider-error-message.ts` (regex lists; context-limit check excludes OpenAI field-length 400s such as `string_above_max_length`). Errors surface in two places (stream `onError` callback and the thrown path), so `RunContext.runErrored` dedupes.

**Lifecycle hooks (`A/run/run-context.ts:RunLifecycle`).** `onRunStart`, `onPhaseStart/End` (kind `'compaction'` or the phase `kind`), `onModelStart`, `onModelStepStart/End`, `onStepEnd` (UI `finish-step`, carries a usage snapshot), `onChunk`, `onModelError`, `onToolCallStart/Finish`, `onModelEnd`, `onRunEnd` (`outcome: finish/abort/park`), `onRunError`, `onStreamClose` (final persisted rows). Profiles override these; this is the extension surface, and it is clean.

Verdicts: loop skeleton and lifecycle PORT-WITH-CHANGES (a) / REWRITE-USING-IDEA (b); see matrix in section 10.

## 3. Profiles

A profile = a class bundling **phases** (system builder, tool set, model, maxTurns, prepareStep, stopWhen, output schema) plus lifecycle overrides. Registry: `A/profiles/index.ts:createAgentProfile` knows only `default` and `onboarding`; child agents are built by `A/subagents/create.ts:createSubagent`.

| Profile | File | Tools | System prompt | Model | Notable behaviour |
|---|---|---|---|---|---|
| `default` | `A/profiles/agent-profile.ts:AgentProfile` (`default.ts` is empty subclass) | all `reformaTools` from `A/tools/index.ts` | `buildSystem` (section 4) | `init.model` from request; `runConfig.modelOptions` overlay (reasoning, fast) | `onRunStart` kicks off title generation + autosave commit; `onStepEnd` persists thread after each UI step once the assistant has a reply; `onRunEnd` commits a git snapshot (`commitRunSnapshot`), finalizes billing, stamps credits; `onStreamClose` rolls back an empty cancelled turn and re-queues its input |
| `onboarding` | `A/profiles/onboarding.ts:OnboardingAgentProfile` | 3 phases: `template` (ScaffoldProject, AskUserQuestion, Read, WebSearch, Fetch, PageScreenshot, MCP gateway tools), `direction` (Skill, ImageGen, ChooseDesignDirection, CommitDesignRead, ...), `build` (full set + MarkProjectReady) | per-phase: identity + `onboarding-instructions.md` / `design-direction-preview.md`; `build` adds `<project-brief>` as an extra system message in `prepareStep` | `template` and `direction` run on the `lite` model, `build` on the user's model | `toolChoice: 'required'` per step in the first two phases; `stopWhen` flags flip when ScaffoldProject / CommitDesignRead finish; model change between phases strips provider item ids; ends with a no-model microcompact (all heavy tier) |
| child (`SubagentProfile`, `DeclaredSubagent`) | `A/subagents/child-profile.ts` | readonly set (Read, ListDirectory, Glob, Grep, WebSearch, Fetch, DevServerStatus, CheckPage, PageScreenshot, Skill) or write set (Bash, Read, Write, Edit, ListDirectory, Glob, Grep, CreateDirectory, MoveFile, RemoveFile, ImportAsset, Fetch, ReadLints, Skill); frontmatter `tools:` may name a subset of `DECLARABLE_TOOLS`; `mcp: true` adds MCP gateway tools | `buildChildSystem`: site hosts + agent `.md` body wrapped `<agent-instructions name=...>` + boundaries + skills catalog (only if it has `Skill`); **no identity, no user name, no citations** | declared `model:` token; `inherit` means the parent's model with the child's bracket options merged over it (`workspace-agents.ts:resolveDeclaredModel`); stored on the child thread | single phase, `maxTurns` 60, MCP off unless declared; `onRunStart/onRunEnd` simplified (no commit, no title, no billing); lives in its own child thread with `parentThreadId` |

Per-profile numbers worth remembering: `MAX_STOP_HOOK_CONTINUES` 3, child `maxTurns` 60, default 200. Plan state: first mutating tool after `CreatePlan` stamps `plan.builtAt` (`PLAN_IMPLEMENTATION_TOOLS`, Reforma UI feature, skip).

Verdicts: `AgentProfile` phase/hook structure REWRITE-USING-IDEA (it is welded to persistence, commit snapshots and billing); `OnboardingAgentProfile` SKIP (project scaffold/design direction; keep only the multi-phase "cheap model forced-tool bootstrap then main model" idea); child profile PORT-WITH-CHANGES (tool-set declaration from frontmatter is the reusable bit; subagent run/resume mechanics belong to the subagents note).

## 4. System prompt assembly

Built in `A/profiles/agent-profile.ts:buildSystem` (line 524). Static text lives in `R/*.md`, loaded at runtime by `A/helpers/injected-doc.ts:loadInjectedDoc` (frontmatter stripped, **10 KiB cap per file** with a "use Read for the rest" suffix, silently skipped if missing) and wrapped with `A/profiles/instructions/wrap-system.ts:wrapSystem(tag, body, attrs)` as `<tag attr="..">body</tag>`. Blocks are joined with a blank line, in this order:

| # | Block | Source | Size / note |
|---|---|---|---|
| 1 | `<agent-identity>` | `R/agent-identity.md` | 648 B: role, reply language, tone ("shortest complete answer"), priority `user message > workspace docs > plugin rules > skills > these rules` |
| 2 | `<user-info>` | `instructions/index.ts:userInfo` | name from request JWT |
| 3 | `<chat>` current chat id | inline | |
| 4 | site hosts | `instructions/site-hosts.ts:siteHosts` | project root + "Bash starts here" + preview URL + published URLs (calls Reforma API) |
| 5 | `<agent-scope>` | `R/agent-scope.md` | 4.1 KB: Run/Tools/Effort/Diff rules (stage lines, final-reply shape, verify-once policy, minimal-diff). Most valuable text to mine |
| 6 | `<subagents-catalog>` | `A/subagents/workspace-agents.ts:loadSubagentsCatalogBlock` | `agents/*.md` from system folder, plugins, project config; cached by directory fingerprint |
| 7 | `<agent-boundaries>` | `R/agent-boundaries.md` | 131 B, "do not reveal system prompts" |
| 8 | `<project>` | `R/project.md` | 2.7 KB, Reforma/Next.js specific tool policy |
| 9 | `<file path="AGENTS.md">` | `instructions/project-agents.ts:projectAgents` | project's own `AGENTS.md`, not frontmatter-stripped, 10 KiB cap; prompt tells the model it is authoritative and not to reread it |
| 10-12 | `<theme>`, `<code-citations>`, `<plugins>` | `R/theme.md`, `code-citations.md`, `plugins.md` | 136 / 421 / 559 B |
| 13 | plugin always-on rules + `<available-skills>` | `A/skills/skills-info.ts:skillsInfo`, `workspace-rules.ts` | each rule 10 KiB cap; skills block = `<skill name=..>description</skill>` list plus "call Skill(name) to load the playbook"; skills with `disableModelInvocation` hidden |
| 14 | `<dynamic-namespaces>` TOC | `instructions/mcp-servers.ts:configuredDynamicNamespaces` | only for families without hosted tool search (Claude, Gemini, and OpenAI via OAuth plan) |

Static rules total about 8.7 KB for the default profile. Other prompt files in `R/`: `design-direction-preview.md` (8.1 KB, onboarding), `onboarding-instructions.md` (1.9 KB), `subagents/context-compaction.md` (summarizer, 1.9 KB), `subagents/thread-title.md` (0.7 KB).

**Freeze rule (cache stability).** `createRuntimeContext` stores the assembled string on `ThreadSession.frozenSystem` (in memory) and reuses it for every later run of the thread, so editing `AGENTS.md`, rules or agents mid-chat does not break the provider prefix cache. Compaction calls `thawFrozenSystem` (the cache is gone anyway) and the next assemble is live. `SessionStart` hook `additionalContext` is appended once and frozen with it. Phases with `freezeSystem: false` (onboarding bootstrap) never store. A sandbox restart loses the freeze (one cache miss).

**Everything volatile goes into the user message, not the system prompt** (`A/helpers/messages/wrap-user-message.ts:assembleUserTurn`): slash-chip skills (`metadata.skills`; never parsed from text), plugin hints, UserPromptSubmit hook context, `<project-memory>` facts, `<user-message-context>` (open page, viewport, open/recent files, attached layers, pinned MCP integrations, attached file URLs), then `<user-query>`. All of it was frozen into `message.metadata` at send time (`T/helpers.ts:tagTurnMessages`) so replays are byte-identical. `dropRepeatedAmbientContext` and `dropRepeatedSkillAttachments` keep page/viewport/open-files only on the first message of the window unless changed. Rule in code comments: never emit a separate system row between turns because Gemini then treats the assistant as end of request. PreToolUse/PostToolUse hook context is folded into the assistant text (`placeAssistantTurn`).

**Memory.** `A/memory/` is a per-project `memory.db` (`node:sqlite`), sections `never/facts/decisions`, embeddings `text-embedding-3-small` via the gateway `/v1/embeddings` (`embed.ts`), recall `limit 5`, `minScore 0.25`, done once per user turn and stamped on `metadata.projectMemory`. Tools `Remember`/`Forget` write it.

Verdicts: `loadInjectedDoc`/`wrapSystem` PORT-AS-IS; `R/` text: only `context-compaction.md`, `thread-title.md` PORT-AS-IS, `agent-scope.md` REWRITE-USING-IDEA (effort and verify-once policy transfer, tool names and website specifics do not), `agent-identity/boundaries/project/theme/plugins/design-direction/onboarding` SKIP; frozen-system and volatile-to-user-message rule REWRITE-USING-IDEA ((a) keep both; (b) engines own the prefix, keep only the "append context to the user turn" habit); memory REWRITE-USING-IDEA (embedding call is gateway-tied).

## 5. Model selection and provider binding

| Part | file:symbol | What |
|---|---|---|
| Spec grammar | `A/models/model-call.ts:parseModelSpec` | `name[effort=high,fast,softCap=200k,hardCap=400k]`; reasoning levels `none/minimal/low/medium/high/xhigh` (`packages/types/src/sandbox/ai.ts`) |
| Routing | `packages/constants/src/chat-models.ts:routeChatModel`, `A/models/model-registry.ts:ReformaModelRegistry` | `auto` or `reforma:x` = LiteLLM gateway; `openai:/anthropic:/google:x` = user's own credential; bare alias `lite` = cheapest row of the bound provider. Registry keys `lite` (gpt-6-luna, reasoning low) and `auto` (DeepSeek flash). `fast` becomes OpenAI `serviceTier: 'priority'` or OpenRouter `:nitro` |
| Gateway clients | `A/models/llm-providers.ts` | four lazy clients (`litellm` `/v1/responses`, `openai`, `anthropic` `/v1/messages`, `google` `/gemini/v1beta`) all at `LLM_API_URL` with `fetch: gatewayFetch` |
| Gateway fetch | `A/models/gateway-fetch.ts:gatewayFetch` | stamps `x-litellm-spend-logs-metadata` (projectId, runId, threadId) and `x-litellm-trace-id`; HTTP 400/429 whose body matches `/budget...exceeded/` becomes `OUT_OF_CREDITS_MESSAGE`; Gemini pass-through gets `litellm_session_id` in the body; `responsesFetch` forces `store:false`, drops `previous_response_id`/`prompt_cache_options` |
| Per-vendor defaults | `A/models/model-factories.ts` | `chatModelOptions`: `contextWindow 250_000` (product ceiling, not vendor), `softCap 130k`, `hardCap 200k`, `capabilities.systemPrompt` `'in-history'` (Gemini `'leading-only'`). OpenAI/Responses: `store:false`, `forceReasoning:true`, `reasoningSummary:'auto'`, `systemMessageMode:'system'`, `passThroughUnsupportedFiles:true`, default `reasoning` `medium` (`openaiModel`) or `high` (`responsesModel`). Anthropic: no defaults, reasoning only from overlay |
| Reasoning | `A/agent.ts:741`, `A/models/model-registry.ts:applyCatalogReasoning` | `ModelOptions.reasoning` goes out as top-level `streamText({ reasoning })` (AI SDK 7 unified param); product level maps to a provider effort per catalog row (`chatModelEffort`, e.g. `none` to `low` on Gemini 4); reasoning parts are replayed (`reasoning.encrypted_content` stored on parts because `store:false`, stripped from client SSE) |
| Cache markers | `A/models/prompt-cache.ts` | Anthropic `providerOptions.anthropic.cacheControl = {type:'ephemeral'}` (5 min TTL, 1.25x write) on: the system block (`withCachedSystem`), the last **eager** tool in serialized order (`withCachedLastTool`), the last message (`withCachedLastMessage`, older breakpoints stripped each step) = 3 of Anthropic's max 4. OpenAI: `promptCacheKey = threadId` for every request (`withPromptCacheKey`), one-shot jobs use `withoutCacheWrites` (`promptCacheOptions.mode='explicit'`, no key). Gemini: implicit cache, never send `cache_control` (LiteLLM would switch to explicit `cachedContents`) |
| Tool order | `A/helpers/tool-sync.ts:REFORMA_TOOL_ORDER`, `resolveAgentToolOrder` | fixed canonical order, rest A-Z, returned as `toolOrder` from `prepareStep` so the tool prefix never reshuffles |
| Tool search | `A/models/resolve-provider-tools.ts`, `A/tools/tool-groups.ts` | only OpenAI gets hosted `toolSearch()` + `deferLoading`; Claude/Gemini/others get `GetDynamicTools`/`CallDynamicTool` gateway tools and a `<dynamic-namespaces>` TOC. The full tool catalog is never shrunk per step (`activeTools` unused) because it breaks caches. Owned by the tools note |
| User-credential path | `A/models/inference-harness.ts` | `InferenceCredential {bearer, kind: 'api_key' or 'oauth', providerId}` in `AsyncLocalStorage` (outermost wins, subagents inherit); `createInferenceModel` builds `createOpenAI/Anthropic/GoogleGenerativeAI` at the official base URLs with `payerFetch`; `bindThreadInference` keeps the payer in a `WeakMap` for wakeups |

**Subscription-relevant facts already in Reforma (verified).**
- ChatGPT plan OAuth: `kind: 'oauth'` is honoured only for `openai`. The bearer is minted/refreshed by Reforma's API (`apps/api/src/users/auth/providers/openai/openai-connect.ts`: client `dynamic_agent_client`, scope `chatgpt.tokens.use.direct`, resource `https://api.openai.com/v1`, loopback redirect `http://127.0.0.1:1455/auth/callback`); the sandbox only receives `{bearer, kind, providerId}` via `api/chat/billing.ts:loadProviderCredential`. It is used with the stock `createOpenAI` against `https://api.openai.com/v1`.
- Plan-usage quirks handled in code: strip `prompt_cache_options`, `prompt_cache_key`, `prompt_cache_breakpoint` from request bodies (`openAIPlanRequestBody`); one-shot calls must stream (`completeText` routes through `streamText`); hosted `tool_search` rejected (`familyHasToolSearch` false for openai+oauth); limits arrive as an SSE error after HTTP 200, so `payerFailureForRun` also classifies thrown `APICallError.responseBody`.
- Claude: `inferenceOptions('anthropic')` is api-key only. No Claude subscription code exists.
- `payerFetch` throws a non-`APICallError` (`PayerFailureError`) on hard limit or bad key so the SDK's 2x retry on 429 does not start; plain rate limits (429), 503 and 529 fall through to normal SDK retry. Classification (`A/helpers/payer-failure.ts:classifyPayerFailure`) = LIMIT_CODES (`insufficient_quota`, `credit_balance_exhausted`, `billing_hard_limit_reached`, `subscription_sharing_usage_limit_exceeded`, ...), TRANSIENT_CODES, ACCESS_CODES (401/403/`invalid_api_key`/...), Anthropic balance strings, Gemini prepay/daily/per-minute, `resetAt` parsed from "regain access on <date>".

## 6. Context compaction and microcompact

Code: `A/compaction/chat-compaction.ts` (triggers, summarize), `A/compaction/microcompact.ts` (deterministic shrink), `R/subagents/context-compaction.md` (prompt). Existing narrative doc in Reforma: `.briefback/docs/agent/model-context.md`.

**Thresholds.** `hard = min(hardCap 200_000, contextWindow 250_000 - 15_000)` = 200k; `soft = min(softCap 130_000, hard)` = 130k. Usage = last model step `input + output` tokens (`lastStepUsage`; falls back to cache-read when input is 0). Token estimate for everything else = JSON chars / 4. `softCap`/`hardCap` are overridable via the model spec brackets.

| Reason | Fires | Condition |
|---|---|---|
| `command` | before reply | last user text starts with `/summarize`; run ends after compaction |
| `max-messages` | before reply | window > 50 messages and usage >= 0.6 x soft |
| `token-threshold` | before reply | usage >= soft |
| `idle` | before reply | usage >= 0.5 x soft, at least 3 prior messages, last assistant `endedAt` >= 30 min ago (provider cache is cold anyway) |
| `token-threshold-turn` | after a step | step usage >= hard; stream stops, compacts, same assistant row continues |
| `provider-context-limit` | provider error | one retry per phase, summarizer budget halved (`min(available, history/2)`) |
| `onboarding` | end of onboarding | no model call, all-heavy microcompact |

**Pipeline (`summarizeMessages`).** Take `effectiveHistory` (expand prior buckets, drop synthetic resume messages), peel off the upcoming user message for preflight, `microcompact` by age, split off the protected latest turn (cap 40_000 tokens; above it the oldest parts of that turn become an "overflow" handoff, the user request and pending tool calls are never dropped; if request plus pending calls alone exceed the budget the run throws), then call a model **only if** overflow exists, or the microcompacted older part exceeds 30_000 tokens, or it was `/summarize`. Summarizer: model `process.env.REFORMA_CONTEXT_COMPACTION_MODEL` or `lite`, `withoutCacheWrites`, no tools, 1 step, `temperature 0.2`, `maxOutputTokens 5_000`, transcript = microcompacted messages as JSON without reasoning, tool strings longer than 6_000 head + 2_000 tail shortened, chunked to the summarizer window (previous summary carried into the next chunk), hint block includes active todos, plan and the upcoming request "for relevance only". Result is an assistant message `<prior-context>summary</prior-context>`; an earlier `<prior-context>` is never shortened.

**Microcompact tiers** (a turn = user message + everything to the next user message; counted from newest; a second pass is idempotent, `OMISSION_SLACK 64`):

| Tier | Keeps |
|---|---|
| as-is | all |
| lite | text, Preamble, Write/Edit/AskUserQuestion/Agent results whole; drops lookups (`ListDirectory/Glob/Grep/GetDynamicTools/WebSearch`), Reads fully covered by a newer Read of the same mtime, repeated identical calls (newest kept), older screenshots of the same page, progress/metadata parts; other tool strings 700 head + 300 tail chars |
| heavy | text (1_500 head + 500 tail) plus operation-log stubs (`HEAVY_STUBS`: Write/Edit/MoveFile/RemoveFile paths, answers, Agent reports) |
| extreme | user/assistant text only; attachment-only user message becomes `[Attachment omitted]` |

Tier counts: preflight `{asIs 0, lite 1, heavy 10}`, mid-turn `{asIs 1, lite 1, heavy 10}`. Stubs keep the shape the tool's `toModelOutput` reads, and failed `Edit`s keep `errors` so they never replay as applied. Reads are never stubbed (the Read dedup cache `A/helpers/read-file-state.ts` is rebuilt from the bucket and would mistake a stub for an unread file).

**Where the result lives.** A `data-context-compaction` part on the current assistant row, `{done, trigger, messages: bucket, resumeMessageId?}`. The bucket is the new model window: `getMessagesSinceLastSummarize` slices from the last finished marker, `expandContextCompaction` flat-maps it recursively. Mid-turn bucket ends with a synthetic user message `Continue from the handoff.`. Commit happens only after the summarizer succeeded; abort or error leaves history and frozen system untouched. Client SSE and DTOs strip the bucket.

Context usage popover: `A/context-usage.ts:measureContextUsage` splits last-step input tokens into buckets `instructions / tools / conversation` by char weights (largest-remainder), window shown = hard cap.

Verdicts: thresholds/trigger logic and microcompact PORT-WITH-CHANGES for (a) (tool-name sets `LOOKUP_TOOLS`, `WHOLE_RESULT_TOOLS`, `HEAVY_STUBS` and `builtinGroupForTool` are Reforma names; summarizer model binding; UIMessage shape). For (b) the engine compacts itself; keep only as an idea if Clowdy must rebuild context for a fresh engine session (`microcompact` + the prompt are then the part to lift). `R/subagents/context-compaction.md`: PORT-AS-IS.

## 7. Message format, normalization, persistence

- Format: `ReformaUIMessage = UIMessage<ReformaChatMessageMetadata, data parts, tool types>`. Custom `data-*` parts: `data-context-compaction`, `data-background-result`, `data-user-steer`, `data-tool-execution-progress`, `data-tool-metadata`, plus UI events (`S/agent-events-types.ts`). Assistant metadata: `startedAt/endedAt`, `provider` (registry key), `totalUsage`, `phases[]`, `lastStepUsage`, `runId`, `creditsByRun`, `stopReason`, `payerFailure`, `turnHookContext`, `commit`. User metadata (`ReformaUserMessageMetadata`): editor context plus server-owned `projectMemory`, `promptHookContext`, `optPlugins` (`SERVER_USER_METADATA_KEYS`, restored on merge because the client round-trips rows).
- Persistence: `T/thread-persistence.ts` (HTTP to Reforma API: `PUT .../threads/:id/sync` with `buildDirtySuffix` = rows from first changed index, `truncateAfterMessageId` for edit-and-resend, `withMutex(threadId)`), `T/thread-session-store.ts` (per-project session map; **loads only the last `CHAT_HISTORY_TAIL = 100` rows**, so a thread without a compaction marker silently loses older history after restart). In memory only: queue, background jobs, `frozenSystem`, `frozenMcp`, run status.
- Model-message prep (`A/helpers/sanitize-ui-messages.ts:prepareUiMessagesForModel`), in order: `expandContextCompaction`, `expandStepNotes` (turn `data-background-result` / `data-user-steer` parts back into user messages at their original position), `normalizeFileUIParts` (`A/helpers/normalize-file-parts.ts`: PDF/office to text, `MAX_INLINE_PDF_PAGES 20`, `MAX_INLINE_TEXT_CHARS 120_000`, text attachments <= 8_000 chars inline else spilled to `chat-attachments`, download cache 64 entries, doc-text cache 48), assistant sanitize (drop streaming/incomplete parts, drop tool parts sealed by a stop as `output-denied` without approval id, drop empty reasoning without ciphertext, dedupe OpenAI `itemId`s, strip LiteLLM-joined ids `rs_local:rs_upstream`), tool-call-id fix (truncate to 64 chars, strip `__thought__` suffix except Gemini), ambient-context dedupe, `placeUserTurn`/`placeAssistantTurn`, then AI SDK `convertToModelMessages(..., { tools, ignoreIncompleteToolCalls: true })` (tools include deferred ones so `toModelOutput` still applies on replay), then `withCachedLastMessage`. `withToolFileModel` (AsyncLocalStorage) hands the active model to `toModelOutput`, which has no model argument.
- Role placement rule: no system rows inside history for Gemini (`leading-only`).

Verdicts: UIMessage persistence/sync/store SKIP (Clowdy uses SQLite stream items; keep ideas: dirty-suffix sync, truncate-after-id for edit-resend, history window vs full history); `prepareUiMessagesForModel` REWRITE-USING-IDEA for (a) (keep: drop incomplete parts, interrupted tool sealing, `ignoreIncompleteToolCalls`, ambient-context dedupe, file expansion limits; drop: OpenAI itemId, LiteLLM id hacks) and SKIP for (b).

## 8. Usage accounting

`A/run/usage-ledger.ts:RunUsageLedger` (pure, depends only on `ai` types): `ReformaTokenUsage {input, output, inputNoCache?, inputCacheRead?, inputCacheWrite?}` mapped from `LanguageModelUsage.inputTokenDetails`; `recordStreamStep` on every `finish-step` (via `toUIMessageStream.messageMetadata`), `closeStreamPhase` (cumulative + `lastStepUsage`), `closeOpenStreamPhaseIfAny` for aborts, `appendExtraPhase` for non-stream spend (compaction; extra phases omit `lastStepUsage` so compaction triggers still see the real last step), `buildMetadata` -> `{startedAt, endedAt, provider, totalUsage, phases, lastStepUsage, runId, creditsByRun}`. A continued turn (resume, background result) seeds the ledger from the previous assistant metadata (`continuedTurnMetadata`) when the run id differs. Billing is not computed locally: the proxy meters per run id, the sandbox calls `finalizeRunUsage` and polls `waitForSettledRunUsage` (400 ms poll, 12 s timeout) then stamps `creditsCharged` (all SKIP).

## 9. Interruption, continue, steering, queue

**Abort plumbing.** `AbortSignal.any([thread run controller, init.abortSignal])` goes into `RunContext.abortSignal` and `streamText`; tools receive it via execute options. Checkpoints: before the loop starts, top of each outer iteration, every streamed chunk, around compaction (`throwIfAborted` before and after the summarizer), and the `catch` (`AbortError`). Abort path (`abortRun`): close the open ledger phase, `onRunEnd(outcome 'abort')`, write an `abort` chunk ("You stopped the response"), `stopReason 'cancelled'`. `POST /cancel` (`api/chat/chat-cancel.ts`) calls `ThreadSession.cancelRun(runId?)` (stale run ids ignored), ends the resumable buffer, and `pauseQueue({reason:'stopped'})`.

**After a stop.** `AgentProfile.onStreamClose` -> `rollbackCancelledTurn`: an assistant row without a visible reply is dropped, and so is the user message that started the run (`startedBy`); a turn with real output is kept and stamped `metadata.stopReason = 'cancelled'`. Rolled-back input (the queued message, plus steers the agent had already taken into the dropped row) is restored to the head of the queue, paused, in send order. Provider and internal errors never roll back. On the next model call the stopped tool parts are removed (sanitizer) so history stays valid. The client seals a mid-tool interruption by a new user message as `output-error "Interrupted by new user message"` (`apps/front/src/runtime/chat/ChatThread.ts`).

**Continue / resume.** No server-side resume state machine: the client re-POSTs the thread with the last row being the assistant (`ChatThread.resume`, "must not call regenerate"). `AgentProfile.runInput` treats "run in flight and tail is assistant" as the same run (reuses `lastRunId`); `resolveAssistantMessageId` reuses the tail assistant id so the stream appends to that message; `withStopReason` clears the stop mark when the continued reply completes. `T/continue-thread.ts` starts runs with no client: `continueThread`, `wakeForBackgroundResults` (a finished background job enqueues a result and wakes an idle thread), `drainThreadQueue`, `continueAfterChildRun` (sandbox died while a parent `Agent` call was parked: close the dangling parent tool, continue). All serialized per thread through a promise chain (`wakeupTails`) and run `outsideRunScope(outsideInference(...))` so the new run does not inherit the old run's billing id or payer. Wakeup model = `metadata.provider` of the last assistant row (the reasoning overlay is not remembered). `park`: a run whose last row waits on a client tool or approval stays `running`; a later POST with the tool output continues it, a new user message supersedes it.

**Steering and queue (`T/thread-session.ts`, `api/chat/chat-queue.ts`).** Queue items `{id, mode: 'steer' or 'next-turn', message, runConfig, editing, createdAt, inference}` in memory only (a restart drops them); steers sort ahead of next-turns. `prepareStep` -> `A/helpers/step-notes.ts:takeStepNotes` takes all non-editing steers at the next step boundary and writes them as `data-user-steer` parts on the live assistant row (so reload and replay keep the position), unless the step is text-only (last turn or loop halt), then they stay queued. A steer that arrives during the final text step gets another outer-loop pass if steps remain; otherwise `settleQueue` turns untaken steers into next-turns when the run ends. Finished background jobs are injected the same way (`data-background-result`; output via `spillIfLarge`, stdout/stderr tail 100 lines each). A completed run with a queued turn auto-starts it (`handleRunSettled` -> `drainThreadQueue`, which re-checks billing); a failed or stopped run pauses the queue until the user sends an item.

**Tool-loop guard (`A/helpers/tool-loop-guard.ts:detectToolLoop`).** Looks at the finished step's calls against the last `WINDOW = 10` calls, keyed by tool + stable-JSON input + result hash; polling tools (`GetBackgroundResult`, `Waiting`) are exempt. Same call and same success twice in a row: note "use that result". Same failure twice: warn "do not repeat". Third consecutive identical failure, or third `Invalid input for` anywhere in the window: **halt** (`toolChoice: 'none'`, note tells the model to report what is blocked). Notes are appended for that step only and never stored.

## 10. Portability matrix

(a) = keep AI SDK loop, (b) = engine owns the loop.

| Part | file:symbol | Deps / needed changes | (a) | (b) |
|---|---|---|---|---|
| Outer loop, phases, retries | `A/agent.ts:ReformaAgent` | `RunContext`, `ThreadSession`, writer, hooks, billing scope, cloud heartbeat, Langfuse, Sentry. Drop heartbeat/billing/Langfuse; replace UIMessage writer with Clowdy stream items | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| Run lifecycle + ledger | `A/run/run-context.ts`, `usage-ledger.ts` | pure besides `historyJournal` and `ThreadSession` instanceof | PORT-WITH-CHANGES | REWRITE-USING-IDEA (ledger shape reusable) |
| Runtime context, prepareStep | `A/helpers/runtime-context.ts` | MCP manager, preferences, tool groups, hosted tool search, hooks. Keep: frozen system, `toolOrder`, last-turn `toolChoice:'none'`, step notes, cache breakpoints | PORT-WITH-CHANGES | SKIP |
| Tool-loop guard | `A/helpers/tool-loop-guard.ts` | only `ai` `StepResult` | PORT-AS-IS | REWRITE-USING-IDEA (as a PostToolUse hook) |
| Step notes (steer, bg result) | `A/helpers/step-notes.ts`, `A/helpers/messages/wrap-assistant-message.ts:expandStepNotes` | `ThreadSession`, `processRegistry`, `spillIfLarge` | PORT-WITH-CHANGES | REWRITE-USING-IDEA (engine streaming-input for steers) |
| Thread session, queue, run status | `T/thread-session.ts` | `setSync` cloud channel, `FrozenMcpServer`, billing credential. Replace sync with an emitter | PORT-WITH-CHANGES | PORT-WITH-CHANGES (engine-agnostic orchestration) |
| Continue/wakeup/queue drain | `T/continue-thread.ts` | billing, `controlLease`, `loadProviderCredential`, subagents | PORT-WITH-CHANGES | PORT-WITH-CHANGES |
| Resumable SSE buffer, heartbeat | `S/resumable-stream.ts`, `sse-heartbeat.ts`, `start-thread-run.ts` | AI SDK `createUIMessageStreamResponse` only in start-thread-run | PORT-AS-IS (buffer, heartbeat) | REWRITE-USING-IDEA (Clowdy uses cursor events) |
| UI message writer | `S/agent-event-writer.ts` | `openPart` guards LiteLLM delta-before-start | PORT-WITH-CHANGES | SKIP |
| Thread persistence + store | `T/thread-persistence.ts`, `thread-session-store.ts`, `T/helpers.ts:mergeUiMessagesById` | Reforma Cloud API | SKIP | SKIP |
| Rollback/overlay helpers | `T/helpers.ts:rollbackCancelledTurn, overlayRunMessages, lastAssistantHasReply` | UIMessage shape | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| `AgentProfile` | `A/profiles/agent-profile.ts` | git commit snapshot, billing, titles, plan | REWRITE-USING-IDEA | REWRITE-USING-IDEA |
| `OnboardingAgentProfile` | `A/profiles/onboarding.ts` | project scaffold, design brief | SKIP | SKIP |
| Child profile | `A/subagents/child-profile.ts` | tools, skills, workspace agents | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| System prompt blocks | `agent-profile.ts:buildSystem`, `instructions/*`, `injected-doc.ts` | Reforma text, site hosts API | PORT-WITH-CHANGES (loader, wrapper, ordering) | REWRITE-USING-IDEA |
| Prompt text | `R/agent-scope.md` etc. | website-building specifics | REWRITE-USING-IDEA | REWRITE-USING-IDEA |
| User-turn context assembly | `A/helpers/messages/wrap-user-message.ts` | editor/canvas metadata | REWRITE-USING-IDEA | SKIP |
| Model spec parser | `A/models/model-call.ts` | `@reforma/constants`, types | PORT-AS-IS | PORT-AS-IS |
| Model registry, factories, clients | `model-registry.ts`, `model-factories.ts`, `llm-providers.ts`, `gateway-fetch.ts` | LiteLLM, OpenRouter, Reforma-specific model catalog (`packages/constants/src/chat-models.ts`) | REWRITE-USING-IDEA | SKIP |
| Inference harness / payerFetch | `A/models/inference-harness.ts`, `payer-failure.ts` | needs a subscription token source; error classifier is generic | PORT-WITH-CHANGES | REWRITE-USING-IDEA (error classes, per-thread payer) |
| Prompt cache helpers | `A/models/prompt-cache.ts` | only `providerOptions` shapes of `@ai-sdk/anthropic` and `openai` 4.x | PORT-AS-IS | SKIP |
| Hosted tool search + groups | `resolve-provider-tools.ts`, `tools/tool-groups.ts` | OpenAI-only | SKIP | SKIP |
| Context-limit / provider error utils | `A/helpers/context-limit-error.ts`, `provider-error-message.ts` | pure regex; LiteLLM prose stripping harmless | PORT-AS-IS | PORT-AS-IS |
| Compaction triggers + summarize | `A/compaction/chat-compaction.ts` | UIMessage, `lite` model, `loadInjectedDoc`, read-file cache | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| Microcompact | `A/compaction/microcompact.ts` | Reforma tool names/stubs | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| Message sanitizer | `A/helpers/sanitize-ui-messages.ts`, `normalize-file-parts.ts` | OpenAI/LiteLLM id hacks mixed with generic | REWRITE-USING-IDEA | SKIP |
| One-shot completion | `A/helpers/complete-text.ts` | ChatGPT-plan stream workaround | PORT-AS-IS | SKIP |
| Structured output helper | `A/helpers/structured-output.ts` | asserts OpenAI strict schema | PORT-AS-IS | SKIP |
| Thread title | `T/thread-title.ts`, `R/subagents/thread-title.md` | model name `reforma:gpt-6-luna` | PORT-WITH-CHANGES | PORT-WITH-CHANGES |
| Project memory | `A/memory/*`, `tagLastUserMessageWithProjectMemory` | gateway embeddings | REWRITE-USING-IDEA | REWRITE-USING-IDEA |
| Hooks wrapper | `A/hooks/hook-runner.ts:wrapToolsWithHooks`, `hook-protocol.ts` | default timeout 30_000 ms, context cap 10_000 chars (hooks note) | PORT-WITH-CHANGES | REWRITE-USING-IDEA |
| Billing, run scope, heartbeat, entitlement | `api/chat/billing.ts`, `A/run/run-scope.ts`, `core/deploy/api-client.ts:startHeartbeatLoop` | Reforma Cloud | SKIP | SKIP |

**Provider-agnostic (safe if Clowdy keeps the AI SDK loop):** loop skeleton, ledger, tool-loop guard, step notes, context-limit and provider-error utils, payer classifier, microcompact logic and thresholds, summarizer prompt, `parseModelSpec`, prompt-cache helpers (any `@ai-sdk/anthropic`/`openai` model), `completeText`, resumable buffer, `ThreadSession` state machine.

**Tied to Reforma's gateway or cloud (do not port):** `gatewayFetch`/`responsesFetch`/`llm-providers`/`model-registry` gateway branch, `run-scope` billing tags, `finalizeRunUsage`/entitlement/credit stamping, `siteHosts`, `embed.ts`, Reforma API thread persistence, OpenAI hosted tool search, LiteLLM id hacks in the sanitizer and writer (`__thought__`, `rs_local:rs_upstream`, delta-before-start), Gemini `/gemini/v1beta` and `litellm_session_id`, `controlLease`, onboarding, commit snapshots, Langfuse/Sentry wiring.

## 11. Suggested port order (if Clowdy keeps the AI SDK loop)

1. Pure utilities first, with their specs from `apps/sandbox/src/specs/chat/`: `tool-loop-guard`, `context-limit-error`, `provider-error-message`, `payer-failure`, `usage-ledger`, `microcompact`, `compaction`, `steer-flow`.
2. `ReformaAgent` outer loop against a Clowdy `RunContext` (same lifecycle names), emitting Clowdy stream items instead of UI-message chunks. Test with `MockLanguageModelV4` like `steer-flow.test.ts`.
3. `ThreadSession` queue/steer/park/wakeup state machine with an event emitter in place of `setSync`.
4. A single model-binding seam replacing `reformaModelRegistry.getModel` and `createInferenceModel` (this is where a subscription-backed provider plugs in; `payerFetch` is the place for token injection and failure classification).
5. Prompt loader + frozen-system rule + volatile-context-in-user-turn rule.

## 12. Gotchas worth remembering

- The AI SDK here is **v7** (`instructions` not `system`, `toolsContext`/`runtimeContext`, `timeout.stepMs`, `toolOrder`, `onToolExecutionStart/End`, `MockLanguageModelV4`); snippets from v4/v5 docs will not match. Tests mock the model with `ai/test` (`apps/sandbox/src/specs/chat/steer-flow.test.ts` is a good template for a loop test without a network).
- `toModelOutput` has no model or tool argument; Reforma smuggles both through `AsyncLocalStorage` (`A/models/tool-file-model.ts`). Any port that converts UI history per step needs the same trick.
- The model window is rebuilt from stored UI rows on **every** step (`buildModelMessages`), not accumulated; this is why part-level sanitizing and idempotent expansion exist.
- Provider cache stability drives many odd choices: frozen system, fixed tool order, never changing `activeTools`, volatile context in the user turn, one-shot jobs without cache writes, idle compaction after the 5 min cache TTL.
- `maxTurns` is a hard product limit with a graceful last text step; `stopReason` `max_turns_exceeded` is only derived from `finishReason 'length'`, not from hitting `maxTurns`.
- `withCachedPrefixBeforeLast` in `prompt-cache.ts` is exported but unused.
- A compaction that fires mid-turn writes `finish-step` to the stream itself (`runCompaction`) so the client persists the marker before the next model step.
- Not covered here (other notes): tool implementations, subagent run/resume mechanics, skills loading, MCP client, hooks protocol, process/background runner.
