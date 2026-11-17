# 03. Subagents and background work (Reforma agent)

Source: Reforma repo, `S = apps/sandbox/src`. `ai` = Vercel AI SDK 7.0.31. All claims verified in code; items marked *(derived)* follow from reading code but have no test. Read-only research, nothing in Reforma was changed.

## 0. TL;DR

- A subagent is **a persisted child chat thread** (`parentThreadId` + `subagent` metadata) run by a normal `ReformaAgent` loop with a restricted profile. Parent calls it through one tool, `Agent`.
- Two modes: **foreground** (the `Agent` tool call blocks until the child ends, report = tool output) and **background** (`background: true`: receipt now, report arrives later through an in-memory **mailbox** on the root thread).
- The mailbox is the reusable core: `registerBackgroundJob` / `enqueueBackgroundResult` / `takeBackgroundResults`, drained **between model steps** (`takeStepNotes` in `prepareStep`) or by **waking an idle thread** (`continue-thread.ts`). Bash background commands and InstallDeps/DevServerRestart use the same mailbox.
- Depth is 1 by construction (children simply do not get the `Agent` tool). There is **no concurrency cap, no restart recovery, no worktree isolation, no per-child budget**. All run state is in memory; only chat messages are persisted, and in Reforma's cloud API (MySQL), not locally.
- Very little of this code is tied to the sandbox/Docker; the coupling is to `ThreadSession`, `AgentProfile`, `ReformaAgent`, AI SDK UI messages, billing (ALS run scope + payer) and the cloud persistence API.

## 1. Part catalog

| Part | file:symbol (under `S/`) | What it does | Deps | Verdict |
|---|---|---|---|---|
| Agent tool | `chat/agent/tools/agent/Agent.ts`: `Agent`, `startBackgroundSubagent`, `backgroundReport`, `recordSubagentUsage`, `emitSubagentStatus` | Delegation tool. Input `{name, message, resume?: 'new'\|'resume', background?}`; output `{name, childThreadId, content, data?, error?, jobId?}` | AI SDK `tool()`, `runtimeFromToolOptions`, billing check, `runBackgroundWork` | (a) PORT-WITH-CHANGES (drop billing/inference); (b) REWRITE-USING-IDEA (engine-native Task/subagent) |
| Run orchestration | `chat/agent/subagents/run.ts`: `openSubagent`, `runSubagent`, `wantsLatestChild`, `loadResumeChild` | Create/resume child thread, run it, park on user input, extract report + usage, map every outcome to `SubagentStatus` | `ThreadSession`, `threadsStore`, `startThreadRun`, `createThread`, `findLatestChildThread` | (a) PORT-WITH-CHANGES; (b) REWRITE-USING-IDEA |
| Park on user | `run.ts`: `parkUntilNextRun`, `parkWhileNeedsUser` | Child waits for approval; parent tool stays pending until the child has a *new* run that ends | only `ThreadSession.onRunChange` | PORT-WITH-CHANGES (engine-agnostic, ~35 lines) |
| Stream tee | `run.ts`: `consumeChildStream`, `drainStream` | Tee child UI stream: one branch persisted via resumable SSE, one mined for activity | `startThreadRun`, `subagent-activity.ts` | REWRITE-USING-IDEA |
| Child profile | `chat/agent/subagents/child-profile.ts`: `SubagentProfile`, `DeclaredSubagent`, `readonlyTools`, `writeTools`, `DECLARABLE_TOOLS` | Minimal run lifecycle, child system prompt, tool presets, `maxTurns ?? 60` | `AgentProfile`, Reforma tool barrel | REWRITE-USING-IDEA (tool vocabulary is Reforma's) |
| Resolve | `subagents/create.ts`: `resolveSubagent`, `createSubagent`, `modelForSubagentRun` | Read agent file, pick model, build profile | workspace-agents | REWRITE (trivial) |
| Declarations | `subagents/workspace-agents.ts`: `readAgentByName`, `parseDeclaredAgent`, `loadAgentsCatalog`, `loadSubagentsCatalogBlock`, `resolveDeclaredModel` | `{name}.md` front matter, 3-layer lookup, mtime-fingerprint catalog cache, `<subagents-catalog>` prompt block | `@reforma/lib/skills` frontmatter helpers, `config.*_FOLDER`, plugins | PORT-WITH-CHANGES (see 2) |
| Activity labels | `subagents/subagent-activity.ts`: `subagentActivityFromChunk`, `slimSubagentToolInput` | Child chunk -> `{type:'text'\|'reasoning'\|'tool', toolName, title, input}` patch | `ReformaUIMessageChunk` | PORT-WITH-CHANGES (adapt chunk type) |
| Status types | `packages/types/src/sandbox/ui-message.ts`: `SubagentStatus`, `SubagentStatusUpdateData`; `.../api/chat/index.ts`: `SubagentThreadMetadata`; `.../tools/get-background-result.ts`: `BackgroundResult`, `ThreadBackgroundJob` | Wire schema | none | PORT-AS-IS |
| Job runner | `chat/agent/helpers/background-thread.ts`: `runBackgroundWork`, `stopBackgroundWork`, `resolveBackgroundThread`, `workAborts` | Detached async job with own `AbortController`, result into mailbox | `outsideRunScope`, `outsideInference` (billing ALS) | PORT-WITH-CHANGES (remove the 2 ALS wrappers) |
| Mailbox | `chat/threads/thread-session.ts`: `registerBackgroundJob`, `enqueueBackgroundResult`, `takeBackgroundResults`, `dropRunningBackgroundJobs`, `setBackgroundAgentWaiting`, `onThreadMailbox` | In-memory job list, finished = has `output` or `error`, exactly-once take | `setSync` (UI sync channel) | PORT-WITH-CHANGES (persist it) |
| Run state machine | `thread-session.ts`: `startRun`, `setLastRunStatus`, `cancelRun(runId?)`, `isCurrentRun`, `onRunChange`, `inFlightRun`, `turnStarting` | `created/running/completed/failed/cancelled`, stale-run guards, listeners | none heavy | PORT-WITH-CHANGES |
| Wake-up | `chat/threads/continue-thread.ts`: `serialized`, `wakeForBackgroundResults`, `runWakeup`, `runContinue`, `handleRunSettled`, `wakeupTails` | Per-thread serialized "start a run with no user message when results are waiting" | profile factory, `startThreadRun`, `controlLease`, billing | PORT-WITH-CHANGES (drop lease/billing/payer) |
| Queue / steers | `thread-session.ts`: `enqueueInput`, `takeSteers`, `settleQueue`, `pauseQueue`, `restoreQueuedInput`; `continue-thread.ts`: `drainThreadQueue`, `runQueuedInput` | Input typed while a run is going: injected between steps or started as next turn | `ChatQueueItem` types, billing check | REWRITE-USING-IDEA |
| Dangling parent | `continue-thread.ts`: `continueAfterChildRun`, `completeDanglingParentTool`, `childToolOutput` | If the parent died while parked on a child, close its pending `Agent` tool with the child's text and continue | `threadsStore` | REWRITE-USING-IDEA (restart recovery) |
| Step notes | `chat/agent/helpers/step-notes.ts`: `takeStepNotes`, `formatResult`, `TURN_LIMIT_NOTE`; called from `helpers/runtime-context.ts` `prepareStep` | Injects finished jobs, steers, loop and turn-limit notes before each model step | `spillIfLarge`, `processRegistry`, `AgentEventBuilder` | (a) PORT-WITH-CHANGES; (b) REWRITE-USING-IDEA |
| Poll tool | `chat/agent/tools/get-background-result/GetBackgroundResult.ts` | Explicit `takeBackgroundResults()` for the model | `thread` from run context | PORT-AS-IS under (a) |
| Stop jobs | `api/chat/chat-stop-background-jobs.ts`: `stopThreadBackgroundJobs` | Abort in-process jobs, else kill registry command, drop from list | `processRegistry` | PORT-WITH-CHANGES |
| Park detector | `chat/threads/helpers.ts`: `childNeedsUser` | Last assistant has a tool part in `approval-requested`, or a client tool without `execute` | AI SDK UI parts | REWRITE-USING-IDEA (engine permission events) |
| Usage fold | `Agent.ts` `recordSubagentUsage` -> `chat/agent/run/usage-ledger.ts` `RunUsageLedger.appendExtraPhase`; `threads/helpers.ts` `getLastAssistantTotalUsage` | Child `totalUsage` added to parent ledger as an extra phase | ledger | PORT-WITH-CHANGES |
| Persistence | `chat/threads/thread-persistence.ts`, `thread-session-store.ts` | HTTP to Reforma API (`/projects/:id/chat/threads...`), MySQL `p_chat_threads` | Reforma Cloud API | SKIP (replace with local DB) |
| Billing/payer | `models/inference-harness.ts` (`runWithInference`, `bindThreadInference`), `run/run-scope.ts`, `api/chat/billing.ts` | Root-run billing scope, payer credential | LiteLLM gateway | SKIP |
| Shipped agents | `packages/reforma-system/agents/{advisor,code,research,review,shell}.md` | Prompts + tool lists | web-project tools (CheckPage, PageScreenshot, DevServerStatus) | REWRITE-USING-IDEA (copy shape, not content) |

## 2. Declaring subagents

File `{name}.md`, hand-rolled front matter. The parser is ~60 lines in `packages/lib/src/skills.ts` (`splitSkillMarkdown`, `parseFrontmatterField`, `parseBooleanField`): a `^field:` line match, quotes stripped, `>` / `>-` / `|` / `|-` blocks folded into one space-joined line (newlines lost), **no YAML lists or nesting**, booleans are `true|yes`. Safe to swap for a real YAML parser. The format is "Cursor-style" (file docstring) and close to Claude Code's `.claude/agents/*.md` (`name`, `description`, `tools`, `model`), so Clowdy can read both.

| Field | Meaning | Detail |
|---|---|---|
| `name` | must equal file stem | `isValidSkillName(stem)` required; mismatch is an error |
| `description` | catalog text shown to the parent | agent without a description is **omitted from the catalog** (still callable by name) |
| `model` | `inherit`/empty = parent model; `auto[effort=high]`, `lite[effort=low]` = registry spec; `inherit[effort=low]` = parent model + overridden options | `resolveDeclaredModel`; `reasoning` and `effort` are the same option key; throws if inheriting with no parent model |
| `tools` | comma/space separated names | validated lazily in `resolveTools` against `DECLARABLE_TOOLS`; unknown name throws `Agent X declares unknown tool` |
| `readonly` | bool; used only when `tools` absent | `true` = readonlyTools + ReadLints, else writeTools |
| `mcp` | bool | adds `GetDynamicTools, McpAuth, GetMcpResources, CallDynamicTool` (+`InstallPlugin` for non-readonly presets without `tools`) |
| `resume` | `new` (default) or `continue` | anything else is an error. Value used when the tool call omits `resume` |
| body | the system prompt | wrapped `<agent-instructions name=...>`; truncated at **32 KiB** (`MAX_AGENT_BODY_CHARS`) with a note; empty body = error |

- Lookup precedence for one name (`readAgentByName`): project `./.reforma/agents` > plugin packages (reverse order) > system `/etc/reforma/agents`. Catalog merge is the same order, later layer overwrites by name; result sorted by name. Cache key = joined `stem:mtimeMs:size` of every layer (`agentsCatalogFingerprint`), so edits show up without restart.
- Vocabulary mismatch to remember: tool arg is `resume: 'new' | 'resume'`; front matter is `resume: new | continue`. Any other tool-arg token (placeholder like `latest`) silently means `new` (`wantsLatestChild`; tested).
- Shipped examples worth copying as *shapes*: `advisor` (`model: auto[effort=high]`, read-only tools, `resume: continue` so it remembers earlier advice), `research` (`model: lite[effort=low]`, `mcp: true`, final message = answer first, then loci), `review` (verdict first, severity bullets), `code` (minimal diffs, stops after two failed passes, `InstallDeps` is parent-only), `shell`. All end with "final message only, no tool narration".
- Parent system prompt block `<subagents-catalog>`: one `<subagent name resume>` per agent plus "child has no parent history, pass a complete brief" and "questions for the user go to AskUserQuestion, never to a subagent".

## 3. Spawn path (`runSubagent`, `subagents/run.ts`), in order

1. `Agent.execute` guards: no runtime ctx -> error output; `abortSignal` already aborted -> `Subagent cancelled`; `background` + (no thread or caller is itself a subagent) -> error. Reads agent file for `defaultResume`. `parentThreadId = ctx.run.threadId`, `parentToolCallId = options.toolCallId`, `parentAssistantMessageId = last assistant message id (fallback toolCallId)`, `parentModel = ctx.run.model`.
2. `openSubagent`: if resume wanted -> `findLatestChildThread(parent, name)` (API: newest `thread.id` with that `metadata.subagent.name`) -> `loadResumeChild` rejects: unknown thread (falls back to a new child with a warn), `inFlightRun` ("Subagent is still running"), not a subagent, other parent, name mismatch. Model = explicit `input.model` > stored child model (resume) > agent file resolved against `parentModel`. New child: `createThread({parentThreadId, subagent:{name, model, parentToolCallId, parentAssistantMessageId}})` then `threadsStore.adoptNewThread`.
3. `emit('starting')` (the only status persisted into the parent message; the rest are transient).
4. Append user message (brief) to child, `saveThread` immediately.
5. `resolveSubagent` (re-reads the agent file; a change between open and resolve is picked up) -> `DeclaredSubagent` with `{thread, model, abortSignal, inference}`.
6. `consumeChildStream(session, await profile.stream(), patch => emit('running', patch))`.
7. abort check -> `cancelled()`; `parkWhileNeedsUser`; abort check.
8. Result from the turn slice starting at the new user message: usage = `totalUsage` of last assistant in slice; `profile.lastOutputError` -> failed; `lastOutput !== undefined` -> completed with `data`; else last assistant **text**; empty text -> failed `Subagent finished without a text response` (a child that only used tools and said nothing is a failure).
9. `catch`: aborted -> cancelled; else `providerErrorMessage(error) ?? String(error)`, `logger.critical` (Sentry), failed.

Quirks: `lastOutputError` is also the run-error channel (`done.outputError ?? done.error`), so a provider failure inside the child arrives as `failed` with the provider message. `data`/structured output is **dormant**: no shipped profile sets `AgentPhaseConfig.output`. A cancelled child with no reply loses its brief (`rollbackCancelledTurn` in `onStreamClose`). Foreground failures are returned as normal tool output with `error` set (never thrown), so the parent model decides; background failures are thrown into the job and surface as the job `error`.

## 4. What a child gets

| Aspect | Value |
|---|---|
| Loop | same `ReformaAgent.execute` (`agent.ts`): single phase `{kind: <agent name>, maxTurns: init.maxTurns ?? 60, enableMcp: agent.mcp}`; run continues/compacts like a root run |
| Tools | `tools:` list or preset (see 2). **No `Agent`, no `AskUserQuestion`, no `GetBackgroundResult`, no TodoWrite/Commit/plan tools**. `Bash background:true` inside a subagent returns an error (`resolveBackgroundThread` refuses when `thread.subagent`) |
| System prompt | `buildChildSystem`: site hosts + `<agent-instructions>` body + `agent-boundaries.md` (anti-jailbreak line) + skills catalog only if `Skill` in tools + MCP namespaces for non-tool-search model families. **No** identity, user name, project docs, AGENTS.md, theme, citations, parent history |
| Model | see 3.2; shipped: research/review pinned `lite`, advisor `auto[effort=high]`, code/shell inherit |
| Lifecycle overrides (`SubagentProfile`) | no autosave commit, no title generation, no credit finalize, no version-status event; `onRunStart` sets `running` + `thread-update`; `onRunEnd` stamps `stopReason:'cancelled'` on abort, sets `completed` unless `park`/`cancelled`/`failed` |
| Persistence | `onStepEnd` saves the child after every step that has a reply (dirty-suffix PUT), `onStreamClose` saves again |
| Hooks | PreToolUse/PostToolUse/Stop/SessionEnd still fire (shared `wrapToolsWithHooks`/`dispatchHookEvent`) |

## 5. Child stream -> UI

- Child output is an AI SDK UI message stream. `startThreadRun(child, {stream})` registers an in-memory **resumable SSE buffer keyed by child thread id** (`createResumableStream`), so the front can open the child thread and tail it live; the response body is drained server-side (heartbeats via `withSseHeartbeat`).
- Parent UI link: parent `data-subagent-status {childThreadId, toolCallId (= parent Agent call id), status, patch}` written to the **parent run writer** (foreground only). Front (`apps/front/src/runtime/chat/ChatThread.ts` `onData`) merges it into tool metadata by `toolCallId` as `{...patch, childThreadId, needsUser}` and opens the child thread on `needs-user`.
- `SubagentStatus = starting | running | needs-user | completed | failed | cancelled`. `running` is emitted on every activity patch (text/reasoning start, each `tool-input-available`). Skipped tools: `SetPhase, TodoWrite, ReadTodo`. Slim input keys: `path, paths, glob, pattern, command, url, query, name, content`; strings cut to **80 chars**, arrays to **3 items**.
- Background jobs do not stream status into the parent run (it may be gone). They publish through the thread sync channel `chat-thread:<id>` (`snapshot.backgroundJobs` = running jobs only, with `agent:{name, childThreadId, waitingForUser}`); `onStatus` only maps `needs-user`/`running` to `setBackgroundAgentWaiting`.

## 6. Foreground vs background

| | Foreground (default) | Background (`background:true`) |
|---|---|---|
| Parent blocked | yes, the tool call is the child | no, receipt in the same step |
| Allowed callers | root thread and anyone with `Agent` (only root has it) | root thread only (`resolveBackgroundThread`) |
| Validation | inside `runSubagent` (errors become output `error`) | `openSubagent` runs **before** detaching, so unknown agent / still-running resume fail synchronously; receipt carries `childThreadId` |
| Abort source | parent tool `abortSignal` (`options.abortSignal ?? ctx.abortSignal`) | its own `AbortController` in `workAborts[jobId]`; parent Stop and run end do **not** touch it |
| Billing scope | nested in parent root run (one charge) | `outsideRunScope` + `outsideInference`, payer captured explicitly; entitlement checked first (Reforma-only) |
| Usage | folded into parent ledger via `appendExtraPhase(agentName, model, usage)` | **not folded** (lives only on the child thread) *(verified: no call on that path)* |
| Result | tool output `{content,data?,error?}` | `backgroundReport()`: `"Subagent X (child thread Y) finished. Report:\n\n..."` as job `output`, or throws `"... failed: <error>"` -> job `error` |
| Job id | none | `agent:` + 6 chars (`createIdGenerator`); `description` = first line of brief, max 200 chars |
| Receipt text | n/a | `Running in the background as job <id>. Its report arrives as a notification when it finishes; do not wait or poll for it.` |

```text
Foreground: parent step N: Agent(call) -> openSubagent -> child run (own thread + stream) ... -> tool output -> step N+1
Background: parent step N: Agent(bg)   -> openSubagent -> runBackgroundWork(job) -> receipt, parent carries on
            job ends -> enqueueBackgroundResult -> publishState + onThreadMailbox
              parent running: next prepareStep -> takeStepNotes -> synthetic user note before step N+k
              parent idle:    serialized wakeup -> runContinue (no user msg) -> step 0 takeStepNotes
              parent cancelled: nothing; results wait for the next run
```

Foreground children run concurrently when the model emits several `Agent` calls in one step (AI SDK `executeToolsFromStream` starts each call as it is parsed; nothing in Reforma serializes them). A foreground child lives inside the parent's current step, so it is bounded by `STREAM_STEP_TIMEOUT_MS` = **600 000 ms** (`config.ts`, passed as `timeout.stepMs`; the comment says it covers in-step tool execution) *(derived)*. Anything that may exceed 10 minutes, including waiting for a human, must not be foreground.

## 7. Mailbox, notifications, how a parent learns and waits

Data: `ThreadBackgroundJob {id, description, output?, error?, agent?}`. "Finished" = `output !== undefined || error !== undefined`. `BackgroundResult {id, output?, error?}`.

- Producers: `Agent` bg (`runBackgroundWork` -> `.then(enqueue output, enqueue error)`), `Bash background` (`attachDeliver` on `exit`/`error`, `delivered` guard), `InstallDeps`, `DevServerRestart`. `enqueueBackgroundResult` for an unknown id **creates** a finished entry with empty description.
- Consumers (exactly once, `takeBackgroundResults` removes finished entries): (1) `takeStepNotes` in `prepareStep` on **every** step including step 0; (2) the `GetBackgroundResult` tool; both share the source so nothing is delivered twice. Not persisted: a crash between enqueue and take loses the result.
- Step note: writes a persisted `data-background-result {id:'bg:<ids|joined>', results, text}` part on the live assistant message and appends the same `text` as a synthetic **user-role** message to this step's model input. `text` is frozen at delivery so replays are byte-identical (prompt cache). Per result: `Background job <id> finished.` + output (non-command output is `JSON.stringify`, command output = `exit N` / `signal S`) + error + last **100** lines of stdout/stderr from the process registry; each block passes `spillIfLarge` (> **24 KiB** -> file under `AGENT_TMP_DIR/tool-output/<uuid>.txt`, model gets a `Read` pointer). Order inside one step's notes: background, then steers (skipped when tools are off), then tool-loop note, then turn-limit note (the last two are never stored).
- Idle parent: `enqueueBackgroundResult` fires `onThreadMailbox` -> `wakeForBackgroundResults` -> `serialized(thread, runWakeup)` -> `runContinue` starts a run with **no new user message**; step 0 `prepareStep` takes the result as above.
  - `serialized` chains on a per-thread promise (`wakeupTails`), so two deliveries produce one wakeup and a wakeup queued behind the run that took the results starts nothing. Runs inside `outsideRunScope(outsideInference(...))` so the new run is not billed to the old one.
  - Skipped when: thread not idle (`inFlightRun` or `turnStarting`), `lastRunStatus === 'cancelled'` (user pressed Stop; results wait for the next run), nothing left to take, pending control takeover (Reforma-specific).
  - `handleRunSettled` (every settle): child thread -> `continueAfterChildRun`; root + completed + queued input -> drain queue (the queued turn picks results up in its first step); root + cancelled -> nothing; otherwise (completed without queue, failed) -> wake for results. This closes the race "result arrived after the last `prepareStep`".
  - Wake model = last assistant `metadata.provider`, else `DEFAULT_CHAT_MODEL`; profile = `createSubagent` if the thread is a subagent else `default`.
- Steers share the delivery point. `ThreadSession.queued` holds `QueuedInput` items in two sections, `steer` first then `next-turn` (`placeQueuedInput`). `takeSteers()` (called from `takeStepNotes`) removes steers not open in an editor and appends each as `data-user-steer` + a user message; skipped on the last turn or when the loop guard halts tools. A steer that lands during the final text step gets another phase of the same run if `steps < maxTurns` (`agent.ts`). On run end leftover steers become `next-turn` (`settleQueue`); Stop or a failed run pauses the queue (`pauseQueue`), a rolled-back turn is put back at the head (`restoreQueuedInput`). In memory only. This is how a human talks to a running agent; Clowdy needs the same for running executors.
- "Waiting": no join primitive. The parent either blocks (foreground), ends its turn and is woken, or polls with `GetBackgroundResult` / `Waiting` (`seconds` int, max **300**). The tool-loop guard exempts exactly these two (`POLLING_TOOLS`), so polling never trips it. The receipt tells the model not to poll.
- Stop jobs: `POST /threads/:id/background-jobs/stop` (optional `ids`; malformed `ids` -> 400, never "stop all") -> `stopThreadBackgroundJobs`: `stopBackgroundWork(id)` else `processRegistry.getCommand(id).kill()`, then `dropRunningBackgroundJobs`. *(derived)* the aborted child still returns `Subagent cancelled`, `backgroundReport` throws, and `enqueueBackgroundResult` re-adds the id as a finished error entry, so the parent is woken with a cancelled notice after a manual stop.

## 8. needs-user and `waitingForUser`

- A child cannot call AskUserQuestion; it parks on **tool approvals** (`needsApproval` in `InstallPlugin`, `McpAuth`, MCP tools) or any client tool without `execute`. `childNeedsUser(messages)`: last message is assistant with a tool part in `approval-requested`, or a non-terminal part whose tool has no `execute` (or is the design-direction picker).
- `agent.ts` ends such a run with `outcome: 'park'`: stream closes, `lastRunStatus` **stays `running`**, `onRunEnd` skips completion. Consequences: the child shows as in-flight, so `resume` of a parked child fails with "Subagent is still running"; a new user turn on that thread is allowed (`chat.ts`: `inFlightRun && !childNeedsUser`), and the answer is posted to the **child thread id**, restarting the same run id (`continueRun` reuses `lastRunId`).
- `parkWhileNeedsUser`: `while (childNeedsUser && !aborted) { await parkUntilNextRun(session, abort, () => emit('needs-user')); emit('running') }`. `parkUntilNextRun` subscribes to `onRunChange` **before** calling `onReady` and resolves only after it saw a start (`inFlightRun` true) and then idle, so it never completes on the run that asked. Tested.
- Parent abort while parked: loop exits; if the user's answer already started a child run, `session.cancelRun()` + `endResumableStream(childId)` end it too.
- Background: `onStatus` toggles `job.agent.waitingForUser` and publishes the snapshot (only on change). A background child that parks is invisible to the model; the human must answer in the child thread.
- If the parent run is gone (e.g. sandbox restart) when a parked child finally settles: `continueAfterChildRun` loads the parent, and only if the parent is idle and its `Agent` tool part has no output yet it patches `output-available` with `{name, childThreadId, content: <child last text>, error?}`, saves and `continueThread(parent)`. A background receipt is already `output-available`, so that path is a no-op and the late report is lost.

## 9. Cancellation matrix

| Trigger | Foreground child | Background child |
|---|---|---|
| Parent Stop (`POST cancel` -> `cancelRun`) | tool `abortSignal` -> `AbortSignal.any([childRunAbort, abortSignal])` in `AgentProfile.runInput` -> child `abortRun` -> `cancelled`; `Agent` returns `error: 'Subagent cancelled'`. Child settle later closes a dangling tool via `continueAfterChildRun` but `runContinue` refuses `cancelled` parents | unaffected (tested) |
| Stop background jobs endpoint | n/a | abort job signal, see 7 |
| Control handoff to another user (`core/control/connect-control.ts`) | `stopRuns()` cancels every in-memory session, children included | `stopThreadBackgroundJobs` for all sessions |
| Delete parent thread | `dispose()` cancels only that session; DB FK `ON DELETE CASCADE` removes child rows; in-memory child sessions are not disposed | same |
| Process shutdown | nothing child-specific in `gracefulShutdown` | nothing |

## 10. Usage and errors

- Usage shape `ReformaTokenUsage {input, output, inputNoCache?, inputCacheRead?, inputCacheWrite?}`; child total = `metadata.totalUsage` of its last assistant message in the turn slice (resume counts only the new turn). Foreground: `ledger.appendExtraPhase(kind=agentName, provider=childModel, usage)` + a `message-metadata` chunk so the parent UI total moves live. Background: not folded (sum child threads by link if a total is needed).
- Billing roots (`runWithRunScope` outermost wins, gateway headers per root run id) are Reforma-only and not needed for a subscription.
- Failure matrix: unknown agent / bad `tools` / missing parent model -> thrown in open/resolve -> `failed`. Provider error in child -> `failRun` -> `lastOutputError` -> `failed`. Context limit -> one compaction retry (`MAX_PROVIDER_CONTEXT_LIMIT_RETRIES = 1`), stale provider item id -> one retry, Stop hook may force up to `MAX_STOP_HOOK_CONTINUES = 3` extra loops. Payer failures (hard 429 / broken key) are not retried by the SDK (`payerFetch`; SDK otherwise retries 429 twice). Turn limit: last step forced text-only (`toolChoice:'none'` + `TURN_LIMIT_NOTE`). Tool-loop guard (`tool-loop-guard.ts`, window **10**): identical failing call twice -> warning note, third in a row (or third invalid-input anywhere in window) -> tools off for next step; two identical successes in a row -> warning. **No child retry, no child timeout, no heartbeat/stall detection** beyond the 600 s step timeout and `maxTurns`.

## 11. Persistence, resume, restart

| State | Where | Survives restart |
|---|---|---|
| Child messages, todos, plan, contextUsage, `subagent` metadata, `parentThreadId` | Reforma API `p_chat_threads` (MySQL, `metadata` JSON, FK cascade, index on parent); PUT `/sync` sends dirty suffix compared to `lastSynced`; per-thread mutex; load tail = `CHAT_HISTORY_TAIL` **100** messages | yes (cloud) |
| `lastRunStatus`, `inFlightRun`, abort controllers | `ThreadSession` | **no** (loaded sessions start idle) |
| Background jobs and mailbox, `workAborts` | memory | **no** |
| Queue (steer/next-turn), frozen system prompt, payer credential, resumable SSE buffer | memory | **no** |
| Running OS processes of background Bash | `processRegistry`; `COMMAND_TTL_MS` default 0 -> GC tick 1 s, finished runners are evicted fast and output falls back to the disk log; non-desktop boots run `reconcileOrphanTrustedProcesses` | partly |

`threadsStore` keeps sessions in a per-project `Map` forever (no eviction). Resume = same parent chat + same name + newest id + not in flight; it is by name, not by job. No boot-time scan marks interrupted children.

## 12. Both ways: what changes for Clowdy

| Concern | (a) keep AI SDK loop (subscription-backed provider) | (b) engine owns the loop (Claude Agent SDK / Codex SDK) |
|---|---|---|
| Child execution | `runSubagent` ports almost verbatim once `ThreadSession`, `AgentProfile`, `ReformaAgent` and persistence are ported (~3.7k lines of thread machinery) | Do **not** port `runSubagent`. Use the engine's own subagent/Task facility for in-session helpers (to be confirmed in the engine note); Clowdy executors are separate engine sessions |
| Mailbox/wake-up | PORT-WITH-CHANGES | Keep as logic: results go into Clowdy's DB; delivery = start a follow-up turn or push a message into a streaming-input session (engine capability to confirm) |
| Step notes | `prepareStep` hook works as is | no `prepareStep`; inject via streaming input or next turn |
| needs-user park | part parts + `approval-requested` | map engine permission/approval requests to the same `needs-user` status and keep `parkUntilNextRun` semantics |
| Declarations | PORT | Read the same `.md` files and map `tools`/`model` onto engine options; keep `resume` default |

## 13. What Clowdy's orchestrator can lift directly

1. **Status contract**: `SubagentStatus` enum + `{childId, toolCallId, status, patch}` event, `starting` persisted, rest transient. Map executor status onto it (add `queued`, `interrupted`).
2. **Job registry + mailbox** (about 70 lines across `runBackgroundWork`, `stopBackgroundWork`, `registerBackgroundJob`, `enqueueBackgroundResult`, `takeBackgroundResults`, `dropRunningBackgroundJobs`): detached job with its own `AbortController`, result/error into a mailbox, exactly-once take. Back it with SQLite and a `delivered` flag.
3. **Wake-up serializer** (`serialized` + `wakeupTails`, `isIdle`, `turnStarting` window) and the settle table in `handleRunSettled` (when to wake, when not: user-cancelled threads stay quiet). This is the correct answer to "orchestrator idle, executor finished".
4. **Step-note delivery** idea: finished jobs become one frozen text note per delivery, large reports spill to a file (24 KiB) with a Read pointer, command logs tail 100 lines.
5. **Validate-then-detach** for background start (`openSubagent` before `runBackgroundWork`) and the receipt wording.
6. **Run state machine** with run-id stale guards (`cancelRun(runId)`, `isCurrentRun`, `setLastRunStatus` ignoring other run ids) and `onRunChange` listeners; `parkUntilNextRun` for human-in-the-loop waits.
7. **Resume checklist** (`loadResumeChild`: still running / wrong parent / wrong name) and "resume keeps the stored model".
8. **Declaration format** and catalog cache (mtime+size fingerprint); `resume: new|continue` per agent kind.
9. **Activity labeler** (`subagentActivityFromChunk` slimming) for a "what is it doing now" line per executor card.
10. **Usage fold** (`appendExtraPhase`) for per-task token totals (quota windows matter for subscriptions, money does not).
11. **Tests to port first**: `specs/chat/subagents/run-subagent.test.ts`, `specs/chat/tools/agent/agent-background.test.ts`, `specs/chat/continue-thread.test.ts`, `specs/chat/stop-background-jobs.test.ts`, `specs/chat/step-notes.test.ts`, `specs/chat/subagents/workspace-agents.test.ts`.

## 14. What is missing for our needs

| Need | Reforma today | Gap |
|---|---|---|
| Parallel limits | none; no semaphore, no queue; foreground fan-out = however many `Agent` calls the model emits, background unbounded; every child holds a live `ThreadSession` + stream + resumable buffer | global and per-project/per-engine cap, `queued` status, backoff on subscription rate limits |
| Depth / recursion | children lack the `Agent` tool (structural, no counter) | fine for 1 level; engine-native nesting must be handled by the engine |
| Many-to-many task links | strict tree: one `parentThreadId` + `parentToolCallId`, "newest child of (parent, name)"; deleting the parent cascades | link table task <-> session with roles and no cascade; one executor serving several tasks and one task having several executors |
| Worktree isolation | all children write the single `PROJECT_FOLDER`; only the `worktree` and `git` in-process mutexes serialize file ops and commits; git worktrees exist only for deploy | git worktree + branch per executor, cwd per run, merge/conflict step, path allowlist per worktree |
| Restart recovery | all run state in memory; no boot scan; background result lost; foreground dangling tool closed only if the child later settles | persist jobs/mailbox/run status, on boot mark `running` -> `interrupted`, re-deliver undelivered results, resume by engine session id |
| Join / wait semantics | poll or be woken | wait-all / wait-any with timeout on a set of executors |
| Child supervision | no timeout, no stall detection, no token/time budget (only `maxTurns` 60 and 600 s per step) | per-executor wall clock, idle watchdog, budget |
| Talk to a running child | only answer an approval; `resume` refused while in flight | send/steer message into a running executor (engine streaming input) |
| Structured results | text report; `data` path dormant | schema'd result (status, branch, files, summary) per task |
| Observability | `logger.critical` to Sentry, status events | durable event log per executor run |

## 15. Gotchas worth remembering

- Foreground child = inside the parent's 600 s step; use background for long work.
- `resume` token mismatch (`resume` vs `continue`) and silent fallback to `new`.
- A parked child stays `running`; resume is refused until it is answered or cancelled.
- Background usage is not in the parent total; billing roots differ between modes.
- Reports can be huge: always spill before putting them in model input.
- AI SDK 7 specifics used: `toolsContext`/`runtimeContext` (`runtimeFromToolOptions` accepts `context`, `runtimeContext`, `experimental_context`), `timeout.stepMs`, `prepareStep`, `toolChoice:'none'` on the last step. Pin the version if code is reused.
